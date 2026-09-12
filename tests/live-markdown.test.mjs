import test from 'node:test';
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import xterm from '@xterm/headless';
import { renderMarkdown } from '../dist/live/markdown.js';
import { LiveRenderer } from '../dist/live/render.js';

async function screen(output, cols = 60, rows = 14) {
  const terminal = new xterm.Terminal({ cols, rows, scrollback: 5000, convertEol: true, allowProposedApi: true });
  await new Promise(resolve => terminal.write(output, resolve));
  const lines = Array.from({length: terminal.buffer.active.length}, (_, i) => terminal.buffer.active.getLine(i).translateToString(true));
  terminal.dispose(); return lines.join('\n');
}
const msg = (uid, text, role = 'assistant') => ({uid, role, content: {message: text}});

test('Markdown formats inline syntax, blocks and narrow tables while preserving code and URLs', () => {
  const source = '# Title\n\n**bold** *italic* ~~old~~ `x*y` [site](https://example.com)\n\n- [x] Done\n- Next\n\n> Quote\n\n```js\nconst x = "**literal**";\n```\n\n| Name | Qty |\n| --- | --- |\n| Panel | 2 |';
  const output = renderMarkdown(source, true, 60);
  assert.match(output, /\x1b\[1;36mTitle/);
  assert.match(output, /\x1b\[1mbold/);
  const plain = stripVTControlCharacters(output);
  assert.match(plain, /site \(https:\/\/example.com\)/);
  assert.match(plain, /☑ Done/); assert.match(plain, /• Next/);
  assert.match(plain, /│ Quote/); assert.match(plain, /const x = "\*\*literal\*\*";/);
  assert.match(plain, /Name: Panel\nQty: 2/);
  assert.doesNotMatch(plain, /```|# Title|\[site\]/);
  assert.equal(renderMarkdown(source, false, 60), plain);
});

test('untrusted Markdown cannot inject terminal controls; wide code wraps', () => {
  const output = renderMarkdown('\x1b[2J**hello** [link](https://example.com)\n\n```\n\t' + 'a'.repeat(100) + '\n```', false, 24);
  assert.doesNotMatch(output, /\x1b|\t/);
  assert.ok(output.split('\n').every(line => line.length <= 22));
});

test('TTY incremental Markdown settles once across provisional IDs and preserves earlier scrollback', async () => {
  let output = 'EARLIER\n';
  const renderer = new LiveRenderer(text => {output += text;}, {tty:true, color:true, columns:()=>60, rows:()=>14});
  const source = '# Result\n\n**Hello** from [site](https://example.com).\n\n```js\n' + Array.from({length:35}, (_, i) => `const item${i} = ${i};`).join('\n') + '\n```\n\n- Finished\n- Verified';
  for (let i = 1; i <= source.length; i += 7) renderer.snapshot({status:'processing', chatHistory:[], streamingMessage:msg('temporary', source.slice(0,i))});
  renderer.snapshot({status:'processing', chatHistory:[], streamingMessage:msg('temporary',source)});
  renderer.snapshot({status:'completed',chatHistory:[msg('persisted',source)]});
  renderer.finish();
  const result = await screen(output);
  assert.match(result, /EARLIER/);
  assert.equal(result.match(/Assistant ›/g)?.length, 1);
  assert.equal(result.match(/Hello from site/g)?.length, 1);
  for (let i=0;i<35;i++) assert.equal(result.split(`const item${i} = ${i};`).length - 1, 1);
  assert.match(result, /• Finished\n• Verified/);
  assert.doesNotMatch(result, /```|\*\*Hello/);
});

test('user Markdown renders once and pipes retain the original Markdown', async () => {
  let output = '';
  const renderer = new LiveRenderer(text => {output += text;}, {tty:true,color:false,columns:()=>60});
  renderer.user('**User message**');
  renderer.snapshot({status:'completed',chatHistory:[msg('u','**User message**','user'),msg('a','**Assistant reply**')]});
  renderer.finish();
  const result = await screen(output);
  assert.equal(result.match(/User message/g)?.length, 1);
  assert.match(result, /Assistant reply/); assert.doesNotMatch(result, /\*\*/);
  let pipe = '';
  const plain = new LiveRenderer(text => {pipe += text;}, {tty:false});
  plain.messages([msg('a','**bold**')]); plain.finish();
  assert.match(pipe, /\*\*bold\*\*/); assert.doesNotMatch(pipe, /\x1b/);
});

test('preview handles Unicode and a terminal resize without erasing the previous message', async () => {
  let cols = 60;
  const terminal = new xterm.Terminal({cols, rows:20, scrollback:1000, convertEol:true, allowProposedApi:true});
  const pending = [];
  const renderer = new LiveRenderer(text => pending.push(text), {tty:true,color:true,columns:()=>cols,rows:()=>20});
  const flush = async () => { await new Promise(resolve => terminal.write(pending.splice(0).join(''), resolve)); };
  pending.push('PREVIOUS MESSAGE\n');
  renderer.snapshot({status:'processing',chatHistory:[],streamingMessage:msg('temp','**Solar 🌞 日本語** ' + 'words '.repeat(10))});
  await flush();
  cols = 32; terminal.resize(cols,20);
  const final = '**Solar 🌞 日本語** ' + 'words '.repeat(10) + 'done';
  renderer.snapshot({status:'completed',chatHistory:[msg('final',final)]}); renderer.finish();
  await flush();
  const result = Array.from({length:terminal.buffer.active.length}, (_, i) => terminal.buffer.active.getLine(i).translateToString(true)).join('\n');
  terminal.dispose();
  assert.match(result,/PREVIOUS MESSAGE/); assert.match(result,/Solar 🌞 日本語/); assert.match(result,/done/);
  assert.equal(result.match(/Solar/g)?.length,1);
});
