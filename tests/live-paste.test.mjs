import test from 'node:test';
import assert from 'node:assert/strict';
import {PasteStore, imageAtPath} from '../dist/live/paste.js';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test('paste chips preserve exact Unicode, whitespace, duplicate-sized blocks and atomic deletion',()=>{
 const store=new PasteStore();const a='🌞'.repeat(1001)+'\n  indented\t';const b='B'.repeat(Array.from(a).length);
 const first=store.text(a),second=store.text(b);
 assert.equal(first.length,1);assert.equal(second.length,1);
 assert.notEqual(first[0],second[0]);
 const draft=['P',...first,' ',...second];
 assert.equal(store.expand(draft).message,'P'+a+' '+b);
 assert.match(store.expand(draft).display,/\[Pasted 1013 characters\]/);
 draft.splice(1,1);assert.equal(store.expand(draft).message,'P '+b);
 assert.equal(store.expand(store.text('one\ntwo')).message,'one\ntwo');
 assert.deepEqual(store.text('short'),Array.from('short'));
});
test('image chips retain independent attachments and literal placeholders never become attachments',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'devic-paste-'));
 try{
  const path=join(dir,'image name.png');await writeFile(path,Buffer.from([137,80,78,71]));
  const img=await imageAtPath('"'+path+'"');assert.equal(img.mime,'image/png');
  const store=new PasteStore();const a=store.image(img),b=store.image({...img,name:'second.png'});
  assert.equal(store.expand([a,' ',b]).display,'[Image#1] [Image#2]');
  assert.equal(store.expand([a,b]).images.length,2);
  assert.equal(store.expand([a]).images.length,1);
  assert.equal(store.expand(Array.from('[Image#1]')).images.length,0);
  assert.equal(await imageAtPath('not a real image.png'),undefined);
 }finally{await rm(dir,{recursive:true,force:true});}
});
