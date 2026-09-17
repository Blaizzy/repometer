import test from 'node:test';
import assert from 'node:assert/strict';
import {matchesFile,filterFileRows} from '../web/file-filters.mjs';
import {targetURL,readTarget,folderTotals} from '../web/targets.mjs';

const files=[
  {path:'src/deleted.py',extension:'.py',status:'removed',before:20,after:0},
  {path:'src/emptied.py',extension:'.py',status:'modified',before:10,after:0},
  {path:'src/new-empty.py',extension:'.py',status:'added',before:0,after:0},
  {path:'src/kept.py',extension:'.py',status:'same',before:5,after:5},
  {path:'data/cases.json',extension:'.json',status:'modified',before:8,after:12},
  {path:'docs/README.md',extension:'.md',status:'removed',before:4,after:0}
];

test('hide removed paths keeps existing empty files and composes with the other file filters',()=>{
 const select=options=>filterFileRows(files.filter(file=>matchesFile(file,options)),{mode:'pr',...options});
 assert.equal(select({}).length,6);
 assert.deepEqual(select({hideRemoved:true}).map(file=>file.path),['src/emptied.py','src/new-empty.py','src/kept.py','data/cases.json']);
 assert.deepEqual(select({hideRemoved:true,scope:'python'}).map(file=>file.path),['src/emptied.py','src/new-empty.py','src/kept.py']);
 assert.deepEqual(select({hideRemoved:true,scope:'source',fileType:'.json'}).map(file=>file.path),['data/cases.json']);
 assert.deepEqual(select({hideRemoved:true,query:'KEPT'}).map(file=>file.path),['src/kept.py']);
 assert.equal(select({hideRemoved:true,query:'deleted'}).length,0);
 assert.equal(select({hideRemoved:false,query:'deleted'}).length,1);
 assert.equal(filterFileRows(files,{mode:'repo',hideRemoved:true}).length,6);
});

test('hiding removed rows preserves the scoped files used by totals and folder summaries',()=>{
 const original=JSON.stringify(files),scoped=files.filter(file=>matchesFile(file,{scope:'source'}));
 const listed=filterFileRows(scoped,{mode:'pr',hideRemoved:true});
 assert.equal(listed.length,4);assert.equal(scoped.length,5);
 assert.deepEqual(scoped.reduce((sum,file)=>[sum[0]+file.before,sum[1]+file.after],[0,0]),[43,17]);
 assert.deepEqual(folderTotals(scoped).map(folder=>[folder.name,folder.before,folder.after,folder.files]),[['data',8,12,1],['src',35,5,4]]);
 assert.equal(filterFileRows(scoped,{mode:'pr',hideRemoved:false}),scoped);
 assert.equal(filterFileRows([files[0]],{mode:'pr',hideRemoved:true}).length,0);
 assert.equal(JSON.stringify(files),original);
});

test('shared PR and folder links preserve the removed-path filter without affecting repository URLs',()=>{
 const target={repository:'Blaizzy/mlx-vlm',mode:'pr',pull:2276,directory:'mlx_vlm/tests'},url=targetURL(target,'python',{hideRemoved:true}),params=new URLSearchParams(url);
 assert.equal(params.get('hideRemoved'),'1');assert.equal(params.get('scope'),'python');assert.equal(readTarget(url).directory,target.directory);
 assert.equal(new URLSearchParams(targetURL({...target,directory:'mlx_vlm'},'python',{hideRemoved:true})).get('hideRemoved'),'1');
 assert.equal(new URLSearchParams(targetURL(target,'all',{hideRemoved:false})).has('hideRemoved'),false);
 assert.equal(new URLSearchParams(targetURL({...target,mode:'repo'},'all',{hideRemoved:true})).has('hideRemoved'),false);
});
