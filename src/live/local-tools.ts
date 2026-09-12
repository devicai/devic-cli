import { open, readdir, realpath } from 'node:fs/promises';
import { relative, resolve, isAbsolute } from 'node:path';
import type { ProcessMessageDto, ToolCall } from '../types.js';

export const localTools: ProcessMessageDto['tools'] = ['read_file', 'list_files'].map(name => ({
  type: 'function', function: {
    name, description: `${name === 'read_file' ? 'Read a UTF-8 file (up to 64 KiB)' : 'List a directory'} inside the user-approved local workspace. Requires local confirmation.`,
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  },
}));

export async function runLocalTool(root: string, call: ToolCall,
  approve: (description: string) => Promise<boolean>): Promise<unknown> {
  if (!localTools!.some(t => t.function.name === call.function.name)) throw new Error('Unknown local tool');
  const args = JSON.parse(call.function.arguments);
  if (!args || typeof args.path !== 'string') throw new Error('path must be a string');
  const base = await realpath(root);
  const target = await realpath(resolve(base, args.path));
  const rel = relative(base, target);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Path is outside the workspace');
  if (!await approve(`${call.function.name} ${target}`)) return { error: 'User denied local access' };
  if (call.function.name === 'list_files') return (await readdir(target)).slice(0, 500);
  const file = await open(target, 'r');
  try {
    if (!(await file.stat()).isFile()) throw new Error('Not a regular file');
    const buffer = Buffer.alloc(65537);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return { text: buffer.subarray(0, Math.min(bytesRead, 65536)).toString('utf8'), truncated: bytesRead > 65536 };
  } finally { await file.close(); }
}
