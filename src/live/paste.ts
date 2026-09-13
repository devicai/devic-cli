import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PastedImage { name: string; mime: string; data: Buffer }
export interface Submission { message: string; display: string; images: PastedImage[]; pasted: boolean }
const run = promisify(execFile);
const MAX_IMAGE = 25 * 1024 * 1024;

export class PasteStore {
  private parts = new Map<string, { label: string; text?: string; image?: PastedImage }>();
  private imageCount = 0;
  text(value: string): string[] {
    // Even short multiline pastes stay atomic: the editor is a single line.
    if (Array.from(value).length <= 1000 && !/[\r\n\t]/.test(value)) return Array.from(value);
    return [this.add({ label: `[Pasted ${Array.from(value).length} characters]`, text: value })];
  }
  image(value: PastedImage): string { return this.add({ label: `[Image#${++this.imageCount}]`, image: value }); }
  private add(part: {label:string; text?:string; image?:PastedImage}): string {
    const key = randomUUID(); this.parts.set(key, part); return key;
  }
  label(part: string): string { return this.parts.get(part)?.label ?? part; }
  expand(parts: string[]): Submission {
    return { message: parts.map(p => this.parts.get(p)?.text ?? (this.parts.get(p)?.image ? this.parts.get(p)!.label : p)).join(''),
      display: parts.map(p => this.label(p)).join(''),
      images: parts.flatMap(p => this.parts.get(p)?.image ? [this.parts.get(p)!.image!] : []),
      pasted: parts.some(p => this.parts.has(p)),
    };
  }
  clear(): void { this.parts.clear(); }
}

export async function imageAtPath(value: string): Promise<PastedImage | undefined> {
  let path = value.trim();
  if ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'"))) path = path.slice(1,-1);
  if (path.startsWith('file://')) path = fileURLToPath(path);
  path = path.replace(/\\ /g, ' ');
  const mime = ({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'} as Record<string,string>)[extname(path).toLowerCase()];
  if (!mime || /[\r\n]/.test(path)) return;
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) return;
  if (info.size > MAX_IMAGE) throw new Error('Image exceeds the 25 MB upload limit.');
  return {name:basename(path),mime,data:await readFile(path)};
}

/** Clipboard is read only on the explicit Ctrl+V gesture. Never via a shell. */
export async function readClipboard(): Promise<{ image?: PastedImage; text?: string }> {
  if (process.platform === 'darwin') {
    const script = `ObjC.import('AppKit'); const p=$.NSPasteboard.generalPasteboard; const valid=d=>d && typeof d.base64EncodedStringWithOptions==='function'; let d=p.dataForType($.NSPasteboardTypePNG); if(!valid(d)){const t=p.dataForType($.NSPasteboardTypeTIFF); if(valid(t)){const r=$.NSBitmapImageRep.imageRepWithData(t); d=r.representationUsingTypeProperties(4,$.NSDictionary.dictionary);}} valid(d) ? ObjC.unwrap(d.base64EncodedStringWithOptions(0)) : '';`;
    const result = await run('osascript',['-l','JavaScript','-e',script],{maxBuffer:36*1024*1024,timeout:5000});
    if (result.stdout.trim()) {
      const data=Buffer.from(result.stdout.trim(),'base64');
      if(data.length>MAX_IMAGE) throw new Error('Image exceeds the 25 MB upload limit.');
      return {image:{name:'clipboard.png',mime:'image/png',data}};
    }
    return {text:(await run('pbpaste',[],{maxBuffer:4*1024*1024,timeout:5000})).stdout};
  }
  if (process.platform === 'linux') {
    const wayland = !!process.env.WAYLAND_DISPLAY;
    const command = wayland ? 'wl-paste' : 'xclip';
    try {
      const image = await run(command,wayland?['--type','image/png']:['-selection','clipboard','-t','image/png','-o'],{encoding:'buffer',maxBuffer:MAX_IMAGE,timeout:5000});
      if(image.stdout.length) return {image:{name:'clipboard.png',mime:'image/png',data:image.stdout}};
    } catch { /* Clipboard may contain text instead of an image. */ }
    return {text:(await run(command,wayland?['--no-newline']:['-selection','clipboard','-o'],{maxBuffer:4*1024*1024,timeout:5000})).stdout};
  }
  throw new Error('Clipboard images are supported on macOS/Linux. Paste an image file path instead.');
}
