import { stripVTControlCharacters } from 'node:util';
import type { ChatMessage } from '../types.js';

export function safe(value: string): string {
  return stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

/** Stable message IDs bridge partial replies and final snapshots without replaying text. */
export class LiveRenderer {
  private texts = new Map<string, string>();
  private tools = new Set<string>();
  private active = '';
  constructor(private write: (text: string) => void = text => { process.stdout.write(text); }) {}
  messages(messages: ChatMessage[]): void {
    messages.forEach((message, index) => {
      const id = message.uid || `${index}:${message.role}`;
      const content = message.content as unknown;
      const text = safe(typeof content === 'string' ? content : message.content?.message || '');
      const previous = this.texts.get(id) || '';
      if (text && text !== previous) {
        if (this.active !== id || !text.startsWith(previous)) {
          this.write(`\n${safe(message.role)} › `);
          this.active = id;
        }
        this.write(text.startsWith(previous) ? text.slice(previous.length) : text);
      }
      this.texts.set(id, text);
      for (const tool of message.tool_calls || []) {
        if (this.tools.has(tool.id)) continue;
        this.tools.add(tool.id);
        this.write(`\n  ↳ ${safe(tool.function.name)}\n`);
        this.active = '';
      }
    });
  }
}
