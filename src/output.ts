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
  process.stderr.write(JSON.stringify(error) + '\n');
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

// ── Human formatting helpers ──

function formatDefault(data: unknown): string {
  if (Array.isArray(data)) return formatTable(data);
  if (data && typeof data === 'object') return formatObject(data as Record<string, unknown>);
  return String(data);
}

function formatTable(rows: unknown[]): string {
  if (rows.length === 0) return '(no results)';
  const first = rows[0] as Record<string, unknown>;
  const keys = Object.keys(first).slice(0, 6); // limit columns
  const widths = keys.map(k =>
    Math.max(k.length, ...rows.map(r => String((r as Record<string, unknown>)[k] ?? '').slice(0, 40).length)),
  );

  const header = keys.map((k, i) => k.padEnd(widths[i]!)).join('  ');
  const sep = widths.map(w => '-'.repeat(w)).join('  ');
  const body = rows.map(r =>
    keys.map((k, i) => String((r as Record<string, unknown>)[k] ?? '').slice(0, 40).padEnd(widths[i]!)).join('  '),
  );

  return [header, sep, ...body].join('\n');
}

function formatObject(obj: Record<string, unknown>): string {
  const maxKey = Math.max(...Object.keys(obj).map(k => k.length));
  return Object.entries(obj)
    .map(([k, v]) => {
      const val = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '');
      return `${k.padEnd(maxKey)}  ${val}`;
    })
    .join('\n');
}

/** Format a status update line for NDJSON streaming */
export function statusLine(type: string, data: Record<string, unknown>): void {
  outputNdjson({ type, ...data, timestamp: Date.now() });
}
