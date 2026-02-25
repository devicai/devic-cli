import type { OutputFormat } from './types.js';

let globalFormat: OutputFormat | undefined;

export function setOutputFormat(format: OutputFormat): void {
  globalFormat = format;
}

export function getOutputFormat(): OutputFormat {
  if (globalFormat) return globalFormat;
  return process.stdout.isTTY ? 'human' : 'json';
}

export function outputJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

export function outputNdjson(data: unknown): void {
  process.stdout.write(JSON.stringify(data) + '\n');
}

export function outputError(error: { error: string; code: string; statusCode?: number }): void {
  if (getOutputFormat() === 'human') {
    process.stderr.write(`\n**Error:** ${error.error}\n`);
    if (error.code) process.stderr.write(`Code: \`${error.code}\`\n`);
    if (error.statusCode) process.stderr.write(`Status: ${error.statusCode}\n`);
  } else {
    process.stderr.write(JSON.stringify(error) + '\n');
  }
}

export function outputHuman(text: string): void {
  process.stdout.write(text + '\n');
}

/** Output data in the active format. `humanFn` renders the human-readable version. */
export function output(data: unknown, humanFn?: (d: unknown) => string): void {
  if (getOutputFormat() === 'json') {
    outputJson(data);
  } else {
    outputHuman(humanFn ? humanFn(data) : formatDefault(data));
  }
}

// ── Markdown formatting helpers ──

function formatDefault(data: unknown): string {
  if (data === null || data === undefined) return '_empty_';
  if (Array.isArray(data)) return formatArrayAuto(data);
  if (typeof data === 'object') return formatObjectAuto(data as Record<string, unknown>);
  return String(data);
}

function formatArrayAuto(rows: unknown[]): string {
  if (rows.length === 0) return '_No results._';
  if (typeof rows[0] !== 'object' || rows[0] === null) {
    return rows.map(r => `- ${String(r)}`).join('\n');
  }
  return md.table(rows as Record<string, unknown>[]);
}

function formatObjectAuto(obj: Record<string, unknown>): string {
  return md.props(obj);
}

/** Format a status update line for NDJSON streaming */
export function statusLine(type: string, data: Record<string, unknown>): void {
  if (getOutputFormat() === 'human') {
    if (type === 'chat_status') {
      const status = data.status as string;
      process.stderr.write(`${md.status(status)} Chat \`${data.chatUid}\` — **${status}**\n`);
    } else if (type === 'thread_status') {
      const state = data.state as string;
      const tasks = data.tasks as Array<{ title?: string; completed: boolean }> | undefined;
      let line = `${md.status(state)} Thread \`${data.threadId}\` — **${state}**`;
      if (tasks && tasks.length > 0) {
        const done = tasks.filter(t => t.completed).length;
        line += ` (tasks: ${done}/${tasks.length})`;
      }
      process.stderr.write(line + '\n');
    } else {
      process.stderr.write(`[${type}] ${JSON.stringify(data)}\n`);
    }
  } else {
    outputNdjson({ type, ...data, timestamp: Date.now() });
  }
}

// ── Markdown building blocks ──

export const md = {
  /** Heading */
  h(level: number, text: string): string {
    return `${'#'.repeat(level)} ${text}`;
  },

  /** Bold */
  b(text: string): string {
    return `**${text}**`;
  },

  /** Inline code */
  code(text: string): string {
    return `\`${text}\``;
  },

  /** Code block */
  codeBlock(content: string, lang = ''): string {
    return `\`\`\`${lang}\n${content}\n\`\`\``;
  },

  /** Status indicator */
  status(state: string): string {
    const s = state.toLowerCase();
    if (['completed', 'active', 'success'].includes(s)) return '[OK]';
    if (['processing', 'queued', 'handed_off'].includes(s)) return '[..]';
    if (['paused', 'paused_for_approval', 'paused_for_resume', 'waiting_for_tool_response', 'waiting_for_response'].includes(s)) return '[!!]';
    if (['failed', 'error', 'terminated', 'cancelled', 'approval_rejected', 'guardrail_trigger'].includes(s)) return '[XX]';
    return '[--]';
  },

  /** Key-value property list */
  props(obj: Record<string, unknown>, opts?: { title?: string; pick?: string[]; omit?: string[] }): string {
    const lines: string[] = [];
    if (opts?.title) lines.push(md.h(2, opts.title), '');

    let entries = Object.entries(obj);
    if (opts?.pick) {
      const pickSet = new Set(opts.pick);
      entries = entries.filter(([k]) => pickSet.has(k));
    }
    if (opts?.omit) {
      const omitSet = new Set(opts.omit);
      entries = entries.filter(([k]) => !omitSet.has(k));
    }

    for (const [key, val] of entries) {
      if (val === undefined || val === null) continue;
      const label = md.b(humanizeKey(key));
      if (typeof val === 'object' && !Array.isArray(val)) {
        lines.push(`${label}:`, md.codeBlock(JSON.stringify(val, null, 2), 'json'), '');
      } else if (Array.isArray(val)) {
        if (val.length === 0) {
          lines.push(`${label}: _none_`);
        } else if (typeof val[0] === 'object') {
          lines.push(`${label}:`, '', md.table(val as Record<string, unknown>[]), '');
        } else {
          lines.push(`${label}: ${val.map(v => md.code(String(v))).join(', ')}`);
        }
      } else {
        lines.push(`${label}: ${formatValue(key, val)}`);
      }
    }
    return lines.join('\n');
  },

  /** Markdown table from array of objects */
  table(rows: Record<string, unknown>[], opts?: { columns?: string[]; maxColWidth?: number }): string {
    if (rows.length === 0) return '_No results._';
    const maxW = opts?.maxColWidth ?? 50;
    const keys = opts?.columns ?? selectTableColumns(rows[0]!);
    if (keys.length === 0) return '_No displayable columns._';

    const headers = keys.map(humanizeKey);
    const cells = rows.map(row =>
      keys.map(k => truncate(formatCellValue(k, row[k]), maxW)),
    );

    const widths = keys.map((_, i) =>
      Math.max(headers[i]!.length, ...cells.map(r => stripAnsi(r[i]!).length)),
    );

    const headerRow = '| ' + headers.map((h, i) => h.padEnd(widths[i]!)).join(' | ') + ' |';
    const sepRow = '| ' + widths.map(w => '-'.repeat(w)).join(' | ') + ' |';
    const bodyRows = cells.map(
      row => '| ' + row.map((c, i) => c.padEnd(widths[i]! + (c.length - stripAnsi(c).length))).join(' | ') + ' |',
    );

    return [headerRow, sepRow, ...bodyRows].join('\n');
  },

  /** Bulleted list */
  list(items: string[]): string {
    return items.map(i => `- ${i}`).join('\n');
  },

  /** Success message */
  success(text: string): string {
    return `[OK] ${text}`;
  },

  /** Warning message */
  warn(text: string): string {
    return `[!!] ${text}`;
  },

  /** Info line */
  info(text: string): string {
    return `> ${text}`;
  },

  /** Horizontal rule */
  hr(): string {
    return '---';
  },

  /** Format a chat conversation */
  conversation(messages: Array<{ role: string; content: unknown }>): string {
    if (!messages || messages.length === 0) return '_No messages._';
    return messages.map(msg => {
      const role = msg.role.toUpperCase();
      const content = extractMessageText(msg.content);
      return `**${role}:**\n${content}`;
    }).join('\n\n');
  },

  /** Pagination footer */
  pagination(data: { total?: number; offset?: number; limit?: number; hasMore?: boolean }): string {
    const parts: string[] = [];
    if (data.total != null) parts.push(`**Total:** ${data.total}`);
    if (data.offset != null) parts.push(`**Offset:** ${data.offset}`);
    if (data.limit != null) parts.push(`**Limit:** ${data.limit}`);
    if (data.hasMore) parts.push('_More results available._');
    return parts.length > 0 ? '\n' + parts.join(' | ') : '';
  },
};

// ── Internal helpers ──

function humanizeKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/\bUid\b/gi, 'UID')
    .replace(/\bId\b/g, 'ID')
    .replace(/\bUrl\b/gi, 'URL')
    .replace(/\bLlm\b/gi, 'LLM')
    .replace(/\bMs\b$/, '(ms)');
  }

function formatValue(key: string, val: unknown): string {
  if (val === true) return 'Yes';
  if (val === false) return 'No';
  const s = String(val);
  if (key.toLowerCase().includes('timestamp') && typeof val === 'number') {
    return formatTimestamp(val);
  }
  if (key.toLowerCase().includes('date') || key.toLowerCase().includes('timestamp')) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toLocaleString();
  }
  return s;
}

function formatCellValue(key: string, val: unknown): string {
  if (val === undefined || val === null) return '-';
  if (val === true) return 'Yes';
  if (val === false) return 'No';
  if (typeof val === 'object') {
    if (Array.isArray(val)) return `[${val.length}]`;
    return '{...}';
  }
  if (key.toLowerCase().includes('timestamp') && typeof val === 'number') {
    return formatTimestamp(val);
  }
  return String(val);
}

function formatTimestamp(ms: number): string {
  if (ms === 0) return '-';
  const d = new Date(ms);
  return d.toLocaleString();
}

function truncate(s: string, max: number): string {
  const plain = stripAnsi(s);
  if (plain.length <= max) return s;
  return s.slice(0, max - 1) + '~';
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function selectTableColumns(sample: Record<string, unknown>): string[] {
  const skip = new Set(['__v', 'threadContent', 'chatContent', 'chatHistory', 'presets', 'assistantSpecialization', 'toolServerDefinition', 'previousConversation', 'memoryDocuments']);
  return Object.keys(sample).filter(k => !skip.has(k) && typeof sample[k] !== 'object' || sample[k] === null).slice(0, 8);
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    const c = content as Record<string, unknown>;
    if (typeof c.message === 'string') return c.message;
    if (c.data) return md.codeBlock(JSON.stringify(c.data, null, 2), 'json');
    return JSON.stringify(content, null, 2);
  }
  return String(content ?? '');
}
