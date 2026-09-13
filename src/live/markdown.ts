import { Lexer, type Token, type Tokens } from 'marked';
import wrapAnsi from 'wrap-ansi';
import stringWidth from 'string-width';
import { stripVTControlCharacters } from 'node:util';

// Only this renderer creates terminal control sequences. Remote Markdown and
// URLs never become HTML, OSC hyperlinks, commands or fetched resources.
const clean = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');

export function renderMarkdown(source: string, color: boolean, columns = 80): string {
  const width = Math.max(10, columns - 2);
  const ink = (code: string, text: string) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
  function inline(tokens: Token[] = []): string {
    return tokens.map(t => {
      switch (t.type) {
        case 'strong': return ink('1', inline(t.tokens));
        case 'em': return ink('3', inline(t.tokens));
        case 'del': return ink('9', inline(t.tokens));
        case 'codespan': return ink('33', t.text);
        case 'link': {
          const label = inline(t.tokens);
          return ink('4;36', label) + (clean(label) === t.href ? '' : ` (${t.href})`);
        }
        case 'image': return `[image: ${t.text}] (${t.href})`;
        case 'br': return '\n';
        case 'escape': return t.text;
        default: return 'tokens' in t && t.tokens ? inline(t.tokens) : ('text' in t ? t.text : t.raw);
      }
    }).join('');
  }
  function blocks(tokens: Token[] = [], depth = 0): string {
    return tokens.map(t => {
      switch (t.type) {
        case 'space': case 'checkbox': return '';
        case 'heading': return ink('1;36', inline(t.tokens)) + '\n\n';
        case 'paragraph': case 'text': return (t.tokens ? inline(t.tokens) : t.text) + '\n\n';
        case 'code': return ink('2', `┌─ ${t.lang || 'code'}`) + '\n' +
          t.text.split('\n').map((line: string) => `${ink('2', '│')} ${ink('33', line)}`).join('\n') + '\n' + ink('2', '└─') + '\n\n';
        case 'blockquote': return blocks(t.tokens, depth).trimEnd().split('\n').map(line => `${ink('2', '│')} ${line}`).join('\n') + '\n\n';
        case 'list': return t.items.map((item: Tokens.ListItem, index: number) => {
          const marker = item.task ? (item.checked ? '☑' : '☐') : t.ordered ? `${Number(t.start) + index}.` : '•';
          const body = blocks(item.tokens, depth + 1).trimEnd();
          return `${marker} ${body.replace(/\n/g, '\n  ')}`;
        }).join('\n') + '\n\n';
        case 'hr': return ink('2', '─'.repeat(Math.min(width, 40))) + '\n\n';
        case 'table': {
          // Vertical records keep wide tables readable in narrow terminals.
          const headers = t.header.map((cell: Tokens.TableCell) => inline(cell.tokens));
          return t.rows.map((row: Tokens.TableCell[], i: number) =>
            `${ink('2', `─ ${i + 1} ─`)}\n` + row.map((cell, j) => `${ink('1', headers[j])}: ${inline(cell.tokens)}`).join('\n')
          ).join('\n\n') + '\n\n';
        }
        case 'def': return '';
        default: return ('text' in t ? t.text : t.raw) + '\n\n';
      }
    }).join('');
  }
  return wrapAnsi(blocks(Lexer.lex(clean(source).replace(/\t/g, '    '), { gfm: true })).trimEnd(), width, { hard: true, trim: false }).replace(/\t/g, '    ');
}

/** Commit complete blocks; redraw only a bounded preview of the unfinished one.
 * Keeping the last lexer token handles split fences, emphasis, tables and lists
 * without rewriting scrollback. Pipes use the original append-only Markdown.
 */
export class MarkdownStream {
  private source = '';
  private committed = 0;
  private preview = '';
  constructor(private write: (text: string) => void, private color: boolean,
    private columns: () => number, private rows: () => number) {}
  private clear(): void {
    if (!this.preview) return;
    const lines = this.preview.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(stringWidth(line) / Math.max(1, this.columns()))), 0);
    const up = Math.min(lines - 1, Math.max(0, this.rows() - 1));
    this.write(`\r${up ? `\x1b[${up}A` : ''}\x1b[J`);
    this.preview = '';
  }
  update(source: string): void {
    this.clear(); this.source = source;
    const pending = source.slice(this.committed);
    const tokens = Lexer.lex(pending, { gfm: true });
    let last = tokens.length - 1;
    while (last >= 0 && tokens[last].type === 'space') last--;
    const stable = tokens.slice(0, Math.max(0, last)).map(t => t.raw).join('');
    if (stable) {
      this.write(renderMarkdown(stable, this.color, this.columns()) + '\n\n');
      this.committed += stable.length;
    }
    const rendered = renderMarkdown(source.slice(this.committed), this.color, this.columns());
    if (!rendered) return;
    const lines = rendered.split('\n');
    const budget = Math.max(1, Math.min(6, this.rows() - 3));
    const visible = lines.slice(-budget);
    this.preview = visible.join('\n'); this.write(this.preview);
  }
  finish(): void {
    this.clear();
    const rest = renderMarkdown(this.source.slice(this.committed), this.color, this.columns());
    if (rest) this.write(rest);
    this.committed = this.source.length;
  }
}
