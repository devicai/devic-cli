import { MarkdownStream, renderMarkdown } from './markdown.js';
import { stripVTControlCharacters } from 'node:util';
import type { ChatMessage, RealtimeChatHistory, RecalledMemoryRecord } from '../types.js';

export function safe(value: string): string {
  return stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

interface DisplayOptions { tty?: boolean; color?: boolean; columns?: () => number; rows?: () => number }

/** A scrollback-first conversation; only the transient activity line is redrawn. */
export class LiveRenderer {
  private texts = new Map<string, string>();
  private tools = new Set<string>();
  private memories = new Map<string, RecalledMemoryRecord>();
  private memorySignatures = new Map<string, string>();
  private assistantName = 'Assistant';
  private settledPartials = new Set<string>();
  private partial?: { id: string; text: string; baseline: Set<string> };
  private active = '';
  private markdown?: MarkdownStream;
  private markdownSource = '';
  private echoed?: string;
  private timer?: ReturnType<typeof setInterval>;
  private spinnerVisible = false;
  private label = 'Thinking';
  private frame = 0;
  private readonly tty: boolean;
  private readonly color: boolean;
  constructor(private write: (text: string) => void = text => { process.stdout.write(text); },
    private options: DisplayOptions = {}) {
    this.tty = options.tty ?? (!!process.stdout.isTTY && process.env.TERM !== 'dumb');
    this.color = options.color ?? (this.tty && process.env.NO_COLOR === undefined);
  }
  private ink(code: string, text: string): string { return this.color ? `\x1b[${code}m${text}\x1b[0m` : text; }
  setAssistantName(name: string): void { this.assistantName = safe(name).replace(/\s+/g, ' ').trim() || 'Assistant'; }
  banner(): void { this.write(`\n  ${this.ink('36;1', '◆ devic')}  ${this.ink('2', '/help for commands')}\n`); }
  prompt(): string { this.finish(); return `\n${this.ink('36;1', 'you ›')} `; }
  user(text: string, alreadyVisible = false, display = text): void {
    this.finish();
    this.echoed = safe(text);
    if (!alreadyVisible) this.write(`\n${this.ink('36;1', 'you ›')} ${this.tty ? renderMarkdown(safe(display), this.color, this.options.columns?.() || process.stdout.columns || 80) : safe(display)}\n`);
  }
  note(text: string): void {
    this.finish(); this.write(`\n  ${this.ink('2', safe(text))}\n`);
  }
  busy(label = 'Thinking'): void {
    this.label = safe(label);
    if (!this.tty || this.timer || this.active) return;
    const tick = () => {
      const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      const width = Math.max(8, (this.options.columns?.() || process.stdout.columns || 80) - 6);
      this.write(`\r\x1b[2K  ${this.ink('36', frames[this.frame++ % frames.length])} ${this.ink('2', this.label.slice(0, width))}`);
      this.spinnerVisible = true;
    };
    tick(); this.timer = setInterval(tick, 90); this.timer.unref();
  }
  private clearActivity(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.spinnerVisible) this.write('\r\x1b[2K');
    this.spinnerVisible = false;
  }
  finish(): void {
    this.clearActivity();
    this.markdown?.finish(); this.markdown = undefined; this.markdownSource = '';
    if (this.active) this.write('\n');
    this.active = '';
  }
  reset(): void { this.finish(); this.texts.clear(); this.tools.clear(); this.memories.clear(); this.memorySignatures.clear(); this.echoed = undefined; this.partial = undefined; this.settledPartials.clear(); }
  snapshot(snapshot: RealtimeChatHistory): void {
    this.recalled(snapshot.recalledMemories || []);
    const history = snapshot.chatHistory || [];
    if (this.partial) {
      const partial = this.partial;
      const final = history.find((message, index) => message.role === 'assistant' &&
        !partial.baseline.has(message.uid || `${index}:${message.role}`) &&
        safe(this.text(message)).startsWith(partial.text) && partial.text.length > 0);
      if (final) {
        const id = final.uid || `${history.indexOf(final)}:${final.role}`;
        this.texts.set(id, partial.text);
        this.settledPartials.add(partial.id);
        if (this.active === partial.id) this.active = id;
        this.partial = undefined;
      }
    }
    this.messages(history);
    const streaming = snapshot.status === 'processing' ? snapshot.streamingMessage : undefined;
    if (streaming && !this.settledPartials.has(streaming.uid || `${history.length}:assistant`) && !history.some(message => message.uid === streaming.uid)) {
      const id = streaming.uid || `${history.length}:assistant`;
      this.partial = { id, text: safe(this.text(streaming)), baseline: this.partial?.baseline || new Set(history.map((m, i) => m.uid || `${i}:${m.role}`)) };
      this.messages([...history, streaming]);
    } else if (['completed', 'error', 'limit_exceeded'].includes(snapshot.status)) this.partial = undefined;
  }
  messages(messages: ChatMessage[]): void {
    // Readline has already displayed the submitted prompt. Match its latest
    // occurrence, so repeated prompts in the history are not accidentally hidden.
    let echoedIndex = -1;
    if (this.echoed !== undefined) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user' && safe(this.text(messages[i])) === this.echoed) { echoedIndex = i; break; }
      }
    }
    messages.forEach((message, index) => {
      const id = message.uid || `${index}:${message.role}`;
      if (index === echoedIndex) { this.texts.set(id, safe(this.text(message))); this.echoed = undefined; }
      // Raw tool results and system/developer context do not belong in the conversation UI.
      if (message.role === 'user' || message.role === 'assistant') {
        const text = safe(this.text(message));
        const previous = this.texts.get(id) || '';
        if (text && text !== previous) {
          this.clearActivity();
          if (this.active !== id || !text.startsWith(previous)) {
            this.finish();
            this.write(`\n${this.ink(message.role === 'user' ? '36;1' : '35;1', message.role === 'user' ? 'you ›' : `${this.assistantName} ›`)} `);
            this.active = id;
            if (this.tty) {
              this.write('\n');
              this.markdown = new MarkdownStream(text => this.write(text), this.color,
                () => this.options.columns?.() || process.stdout.columns || 80,
                () => this.options.rows?.() || process.stdout.rows || 24);
            }
          }
          const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
          if (this.markdown) { this.markdownSource += delta; this.markdown.update(this.markdownSource); }
          else this.write(delta);
        }
        this.texts.set(id, text);
      }
      for (const tool of message.tool_calls || []) {
        this.tool(tool.id, message.summary || tool.function.name.replace(/_/g, ' '));
      }
      if (message.role === 'tool' && message.summary) this.tool(message.tool_call_id || id, message.summary);
    });
  }
  recalled(records: RecalledMemoryRecord[], announce = true): void {
    for (const record of records) {
      const prior = this.memories.get(record.uid);
      const merged = { ...prior, ...record };
      const facts = [...new Set((merged.facts || []).map(f => f.fact.trim().toLowerCase()).filter(Boolean))];
      const entities = [...new Set((merged.entities || []).map(e => e.name.trim().toLowerCase()).filter(Boolean))];
      const turns = merged.turns?.length || 0;
      if (!facts.length && !entities.length && !turns) continue;
      this.memories.set(record.uid, merged);
      const signature = JSON.stringify([merged.source, merged.query, merged.facts, merged.entities, merged.turns]);
      if (this.memorySignatures.get(record.uid) === signature) continue;
      this.memorySignatures.set(record.uid, signature);
      if (announce) {
        this.finish();
        this.write(`  ${this.ink('35', '◇')} ${this.ink('35', 'Recalled memories')} · ${facts.length} facts · ${entities.length} entities · ${turns} turns · ${safe(this.memorySource(merged.source))}  ${this.ink('2', '/memories for details')}\n`);
      }
    }
  }
  showMemories(): void {
    if (!this.memories.size) { this.note('No recalled memories in this conversation.'); return; }
    this.finish();
    for (const record of this.memories.values()) {
      this.write(`\n  ${this.ink('35;1', '◇ Recalled memories')} · ${safe(this.memorySource(record.source))}\n`);
      if (record.query) this.write(`    Query: ${safe(record.query)}\n`);
      const facts = new Set<string>(), entities = new Set<string>();
      for (const fact of record.facts || []) {
        const key = fact.fact.trim().toLowerCase();
        if (!key || facts.has(key)) continue;
        facts.add(key);
        const relation = [fact.source, fact.relation, fact.target].filter(Boolean).join(' → ');
        this.write(`    • ${safe(fact.fact)}${relation ? `\n      ${this.ink('2', safe(relation))}` : ''}\n`);
      }
      for (const entity of record.entities || []) {
        const key = entity.name.trim().toLowerCase();
        if (!key || entities.has(key)) continue;
        entities.add(key);
        this.write(`    ◇ ${safe(entity.name)} · ${safe(entity.type)}${entity.summary ? `\n      ${safe(entity.summary)}` : ''}\n`);
      }
      for (const turn of record.turns || []) this.write(`    ${safe(turn.role)} › ${safe(turn.content)}\n`);
    }
  }
  private memorySource(source: string): string {
    return ({ conversation_start: 'Automatic recall', search_memory: 'Memory search',
      search_memory_nodes: 'Graph node search', explore_memory_graph: 'Graph exploration' } as Record<string, string>)[source] || source;
  }
  private text(message: ChatMessage): string {
    return typeof message.content === 'string' ? message.content : message.content?.message || '';
  }
  private tool(id: string, summary: string): void {
    const text = safe(summary).replace(/\s+/g, ' ').trim().slice(0, 240);
    const key = `${id}:${text}`;
    if (!text || this.tools.has(key)) return;
    this.tools.add(key);
    this.finish();
    this.write(`  ${this.ink('36', '↳')} ${this.ink('2', text)}\n`);
  }
}
