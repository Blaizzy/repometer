import test from 'node:test';
import assert from 'node:assert/strict';
import {progressView} from '../web/count-progress.mjs';

test('progress stays indeterminate until the file total is known and never invents an ETA',()=>{
 for(const phase of ['checking','listing']){
  const view=progressView({phase},65000);assert.equal(view.percent,null);assert.equal(view.files,'—');assert.equal(view.lines,'—');assert.equal(view.elapsed,'1m 05s');
 }
 const empty=progressView({phase:'counting',total:0,completed:0,lines:0});
 assert.equal(empty.percent,null);assert.equal(empty.files,'0 / 0');assert.equal(empty.lines,'0');
});

test('displayed progress tracks actual files, partial lines, and PR revision labels',()=>{
 const view=progressView({phase:'counting',completed:1499,total:1500,lines:123456,textFiles:1400,excluded:99,path:'src/model.py'},21000);
 assert.equal(view.percent,99);assert.equal(view.percentLabel,'99%');assert.equal(view.files,'1,499 / 1,500');assert.equal(view.lines,'123,456');assert.equal(view.elapsed,'21s');assert.equal(view.detail,'1,400 text files · 99 excluded');assert.equal(view.path,'src/model.py');
 assert.equal(progressView({phase:'counting',completed:1500,total:1500}).percent,100);
 assert.match(progressView({phase:'counting',label:'base'}).title,/base revision/);
 assert.match(progressView({phase:'counting',label:'head'}).title,/PR head/);
});
