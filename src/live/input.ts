import { EventEmitter } from 'node:events';
import { emitKeypressEvents, type Key } from 'node:readline';
import { safe } from './render.js';

export interface MenuOption { value: string; label: string; description?: string }
export function commandOptions(agent = false): MenuOption[] {
  const commands = [
    ['/assistants', 'Choose an assistant'], ['/assistant', 'Switch by identifier'],
    ...(!agent ? [['/compact', 'Compact conversation context']] : []),
    ['/new', 'Start a new conversation'], ['/follow', 'Follow the current execution'],
    ['/stop', 'Stop or pause cloud execution'], ['/status', 'Show session details'],
    ...(!agent ? [['/memories', 'Inspect recalled memories'], ['/conversations', 'Resume a recent conversation'], ['/resume', 'Resume by chat UID']] : []),
    ['/help', 'Show available commands'], ['/exit', 'Leave the terminal'],
    ...(agent ? [['/approve', 'Approve execution'], ['/reject', 'Reject execution'], ['/pause', 'Pause execution'], ['/resume', 'Resume execution']] : []),
  ];
  return commands.map(([value, description]) => ({ value, label: value, description }));
}

function cellWidth(char: string): number {
  if (/\p{Mark}/u.test(char) || char === '\u200d' || char === '\ufe0f') return 0;
  return /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe6f\uff00-\uff60\uffe0-\uffe6]|\p{Extended_Pictographic}/u.test(char) ? 2 : 1;
}
function width(text: string): number { return Array.from(safe(text)).reduce((n, c) => n + cellWidth(c), 0); }
function clip(text: string, cells: number): string {
  let result = '', used = 0;
  for (const char of Array.from(safe(text))) { used += cellWidth(char); if (used > cells) break; result += char; }
  return result;
}

/** Owns terminal input while menus are open; arrow keys never reach a pending prompt. */
export class LiveInput extends EventEmitter {
  private pending?: { resolve: (value: string) => void; prefix: string; options: MenuOption[]; picker: boolean };
  private text: string[] = [];
  private cursor = 0;
  private selected = 0;
  private dismissed = false;
  private painted = false;
  private history: string[] = [];
  private historyIndex = 0;
  private draft = '';
  private closed = false;
  private readonly raw = !!process.stdin.isRaw;
  private readonly color = process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';
  constructor() {
    super();
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on('keypress', this.onKey);
    process.stdout.on('resize', this.draw);
    process.stdin.on('end', this.close);
    process.stdin.resume();
  }
  question(prefix: string, options: MenuOption[] = []): Promise<string> { return this.begin(prefix, options, false); }
  select(options: MenuOption[], current?: string, title = 'Assistants'): Promise<string> {
    return this.begin(`${safe(title)} › `, options, true, current);
  }
  private begin(prefix: string, options: MenuOption[], picker: boolean, current?: string): Promise<string> {
    if (this.closed) return Promise.resolve('');
    if (this.pending) throw new Error('Another terminal prompt is already open');
    // Approval descriptions can be much longer than the terminal. Keep the full
    // description visible above the editor instead of silently clipping a path.
    prefix = prefix.replace(/^\n+/, '');
    process.stdout.write('\n');
    if (width(prefix) > Math.max(20, (process.stdout.columns || 80) / 2)) {
      process.stdout.write(`${prefix}\n`); prefix = '› ';
    }
    this.text = []; this.cursor = 0; this.dismissed = false;
    this.selected = Math.max(0, options.findIndex(o => o.value === current));
    this.historyIndex = this.history.length; this.draft = '';
    return new Promise(resolve => {
      this.pending = { resolve, prefix, options, picker }; this.draw();
    });
  }
  private matches(): MenuOption[] {
    if (!this.pending || this.dismissed) return [];
    const line = this.text.join('');
    if (this.pending.picker) return this.pending.options.filter(o =>
      `${o.label} ${o.description || ''}`.toLowerCase().includes(line.toLowerCase()));
    if (!/^\/\S*$/.test(line)) return [];
    return this.pending.options.filter(o => o.value.startsWith(line));
  }
  private clear(): void {
    if (this.painted) process.stdout.write('\r\x1b[J');
    this.painted = false;
  }
  private style(code: string, text: string): string { return this.color ? `\x1b[${code}m${text}\x1b[0m` : text; }
  private draw = (): void => {
    if (!this.pending) return;
    this.clear();
    const cols = Math.max(12, process.stdout.columns || 80);
    const prefix = width(this.pending.prefix) < cols - 4 ? this.pending.prefix : '› ';
    const available = Math.max(3, cols - width(prefix) - 1);
    let start = this.cursor;
    let before = 0;
    while (start > 0 && before + cellWidth(this.text[start - 1]) < available - 1) {
      before += cellWidth(this.text[--start]);
    }
    const visible = clip(this.text.slice(start).join(''), available);
    process.stdout.write(prefix + visible);
    const matches = this.matches();
    this.selected = Math.min(this.selected, Math.max(0, matches.length - 1));
    let rows = 0;
    if (matches.length || this.pending.picker) {
      const count = Math.max(1, Math.min(6, (process.stdout.rows || 24) - 4));
      const offset = Math.max(0, Math.min(this.selected - count + 1, matches.length - count));
      const visibleOptions = matches.slice(offset, offset + count);
      for (let i = 0; i < visibleOptions.length; i++) {
        const option = visibleOptions[i], chosen = offset + i === this.selected;
        const line = clip(`  ${chosen ? '❯' : ' '} ${option.label}${option.description ? `  ${option.description}` : ''}`, cols - 1);
        process.stdout.write(`\r\n${this.style(chosen ? '36;1' : '2', line)}`); rows++;
      }
      if (!matches.length) { process.stdout.write('\r\n  No matching assistants'); rows++; }
      const hint = this.pending.picker ? '↑/↓ select · Enter switch · Esc cancel · type to filter' : '↑/↓ select · Tab complete · Enter run · Esc dismiss';
      process.stdout.write(`\r\n${this.style('2', clip(`  ${hint}`, cols - 1))}`); rows++;
    }
    if (rows) process.stdout.write(`\x1b[${rows}A`);
    process.stdout.write(`\r\x1b[${width(prefix) + before + 1}G`);
    this.painted = true;
  };
  private finish(value: string, echo: boolean): void {
    const pending = this.pending;
    if (!pending) return;
    this.clear(); this.pending = undefined;
    if (echo) process.stdout.write(`${pending.prefix}${safe(value)}\n`);
    pending.resolve(value);
  }
  private onKey = (text: string | undefined, key: Key): void => {
    if (key.ctrl && key.name === 'c') {
      if (this.pending?.picker) { this.finish('', false); return; }
      this.emit('SIGINT'); return;
    }
    if (!this.pending) return;
    if (key.ctrl && key.name === 'd' && !this.text.length) { this.close(); return; }
    if (key.name === 'escape') {
      if (this.pending.picker) this.finish('', false);
      else { this.dismissed = true; this.draw(); }
      return;
    }
    const matches = this.matches();
    if ((key.name === 'up' || key.name === 'down') && matches.length) {
      this.selected = (this.selected + (key.name === 'down' ? 1 : -1) + matches.length) % matches.length;
    } else if (key.name === 'tab') {
      if (matches.length && !this.pending.picker) {
        this.text = Array.from(matches[this.selected].value); this.cursor = this.text.length;
        this.dismissed = true;
      }
    } else if (key.name === 'return' || key.name === 'enter') {
      if (this.pending.picker) { if (matches.length) this.finish(matches[this.selected].value, false); return; }
      const value = matches.length ? matches[this.selected].value : this.text.join('');
      if (value.trim() && this.pending.options.length) this.history.push(value);
      this.finish(value, true); return;
    } else if (key.name === 'left' || (key.ctrl && key.name === 'b')) this.cursor = Math.max(0, this.cursor - 1);
    else if (key.name === 'right' || (key.ctrl && key.name === 'f')) this.cursor = Math.min(this.text.length, this.cursor + 1);
    else if (key.name === 'home' || (key.ctrl && key.name === 'a')) this.cursor = 0;
    else if (key.name === 'end' || (key.ctrl && key.name === 'e')) this.cursor = this.text.length;
    else if (key.name === 'backspace') { if (this.cursor) this.text.splice(--this.cursor, 1); this.dismissed = false; this.selected = 0; }
    else if (key.name === 'delete') this.text.splice(this.cursor, 1);
    else if (key.ctrl && key.name === 'u') { this.text.splice(0, this.cursor); this.cursor = 0; this.dismissed = false; }
    else if (key.ctrl && key.name === 'k') this.text.splice(this.cursor);
    else if (!this.pending.picker && (key.name === 'up' || key.name === 'down')) {
      if (this.historyIndex === this.history.length) this.draft = this.text.join('');
      this.historyIndex = Math.min(this.history.length, Math.max(0, this.historyIndex + (key.name === 'up' ? -1 : 1)));
      this.text = Array.from(this.historyIndex === this.history.length ? this.draft : this.history[this.historyIndex]);
      this.cursor = this.text.length;
    } else if (text && !key.ctrl && !key.meta) {
      const chars = Array.from(safe(text).replace(/[\r\n\t]/g, ' '));
      this.text.splice(this.cursor, 0, ...chars); this.cursor += chars.length;
      this.dismissed = false; this.selected = 0;
    }
    this.draw();
  };
  close = (): void => {
    if (this.closed) return;
    this.closed = true; this.finish('', false);
    process.stdin.removeListener('keypress', this.onKey);
    process.stdin.removeListener('end', this.close);
    process.stdout.removeListener('resize', this.draw);
    process.stdin.setRawMode(this.raw); process.stdin.pause(); this.emit('close');
  };
}
