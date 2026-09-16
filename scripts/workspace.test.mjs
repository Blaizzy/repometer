import test from 'node:test';
import assert from 'node:assert/strict';
import {GithubCounter} from '../web/live-data.mjs';
import {parseTarget,normalizeTarget,readTarget,targetURL,folderTotals,extension} from '../web/targets.mjs';
const sha=x=>x.repeat(40),enc=new TextEncoder();
test('repository, PR, and folder URLs parse safely and workspace URLs preserve branch/folder state',()=>{
 assert.equal(parseTarget('mlx-vlm'),null);
 assert.deepEqual(parseTarget('Blaizzy/mlx-vlm'),{repository:'Blaizzy/mlx-vlm',mode:'repo',pull:null,directory:'',ref:''});
 const pr=parseTarget('https://github.com/acme/example/pull/42/files');assert.equal(pr.pull,42);assert.equal(pr.mode,'pr');
 assert.equal(parseTarget('https://github.com/acme/example/tree/feature%2Fdemo/src').treeTail,'feature/demo/src');
 const t=normalizeTarget({repository:'acme/example',mode:'repo',directory:'src/nested',ref:'feature/demo'});assert.deepEqual(readTarget(targetURL(t)),t);
 for(const input of ['https://evil.example/acme/repo','https://person:secret@github.com/acme/repo','https://github.com/acme/repo/pull/zero'])assert.throws(()=>parseTarget(input));
 assert.throws(()=>normalizeTarget({repository:'acme/repo',directory:'../other'}));assert.equal(extension('.eslintrc.js'),'.js');
});
function fixture({directory='',truncated=false,repository='acme/one'}={}){
 const calls=[],entries=[{path:'src',type:'tree',sha:sha('c')},{path:'src/a.py',type:'blob',sha:sha('1')},{path:'src/nested/b.js',type:'blob',sha:sha('2')},{path:'src-other/out.txt',type:'blob',sha:sha('3')},{path:'README.md',type:'blob',sha:sha('4')},{path:'empty.txt',type:'blob',sha:sha('0')},{path:'image.png',type:'blob',sha:sha('5')},{path:'src/link',type:'blob',mode:'120000',sha:sha('8')},{path:'vendor',type:'commit',mode:'160000',sha:sha('9')},{path:'data.dat',type:'blob',sha:sha('6')},{path:'src/nonutf.txt',type:'blob',sha:sha('7')}];
 const bodies={'1':'# comment\n\nx\n','2':'one\ntwo','3':'outside\n','4':'hello\nworld\n','0':'','6':new Uint8Array([0,1,2]),'7':new Uint8Array([255,255])};
 const fetchImpl=async(url)=>{
  calls.push(url);const path=new URL(url).pathname;
  if(path==='/repos/'+repository)return Response.json({default_branch:'main',description:'A repo',html_url:'https://github.com/'+repository});
  if(path.endsWith('/commits/main'))return Response.json({sha:sha('b')});
  if(path.includes('/git/trees/')){
   if(!truncated||url.includes('?'))return Response.json({tree:entries,truncated});
   if(path.endsWith(sha('b')))return Response.json({tree:[entries[0]],truncated:false});
   if(path.endsWith(sha('c')))return Response.json({tree:[{path:'a.py',type:'blob',sha:sha('1')}],truncated:false});
  }
  if(url.startsWith('https://raw.githubusercontent.com/')){
   const file=entries.find(e=>path.endsWith('/'+e.path));assert.ok(file,'unexpected raw URL '+url);return new Response(bodies[file.sha[0]]);
  }
  throw new Error('Unexpected URL '+url);
 };
 return {counter:new GithubCounter({repository,mode:'repo',directory,fetchImpl}),calls};
}
test('whole-repository totals include nested and empty text files and report excluded entries',async()=>{
 const f=fixture(),result=await f.counter.refresh();assert.equal(result.after,8);assert.equal(result.files.length,5);assert.equal(result.excluded,5);assert.equal(result.repository,'acme/one');
 assert.ok(result.files.some(x=>x.path==='empty.txt'&&x.after===0));assert.ok(f.calls.every(url=>url.includes('acme/one')));
 const before=f.calls.length;await f.counter.refresh(result);assert.equal(f.calls.length,before+1,'unchanged repository only checks the branch commit');
});
test('repository progress reports real completed files and partial lines, including exclusions and cached refreshes',async()=>{
 const f=fixture(),events=[];f.counter.onProgress=(message,detail)=>events.push({message,...detail});
 const result=await f.counter.refresh(),counting=events.filter(event=>event.phase==='counting');
 assert.deepEqual(events.slice(0,2).map(event=>event.phase),['checking','listing']);
 assert.equal(counting[0].completed,0);assert.equal(counting[0].lines,0);
 assert.equal(counting.at(-1).completed,10);assert.equal(counting.at(-1).total,10);
 for(let i=1;i<counting.length;i++){
  assert.equal(counting[i].completed,counting[i-1].completed+1);
  assert.equal(counting[i].completed,counting[i].textFiles+counting[i].excluded);
  assert.ok(counting[i].lines>=counting[i-1].lines);assert.ok(counting[i].path);
 }
 assert.equal(counting.at(-1).lines,result.after);assert.equal(counting.at(-1).textFiles,result.files.length);assert.equal(counting.at(-1).excluded,result.excluded);
 events.length=0;await f.counter.refresh(result);
 const cached=events.at(-1);assert.equal(cached.completed,cached.total);assert.equal(cached.lines,result.after);assert.equal(cached.cached,result.files.length);
});
test('cancelling a count stops progress and does not publish a partial revision',async()=>{
 const f=fixture(),events=[];
 f.counter.onProgress=(_message,detail)=>{events.push(detail);if(detail.phase==='counting'&&detail.completed===2)f.counter.abort();};
 await assert.rejects(f.counter.refresh(),{name:'AbortError'});
 assert.equal(events.at(-1).completed,2);assert.equal(f.counter.revisions.size,0);
});
test('folder totals include descendants without including similarly prefixed siblings',async()=>{
 const {counter}=fixture({directory:'src'}),result=await counter.refresh();assert.equal(result.after,5);assert.equal(result.files.length,2);assert.equal(result.excluded,2);
 assert.deepEqual(folderTotals(result.files,'src'),[{name:'nested',path:'src/nested',before:0,after:2,files:1}]);
 await assert.rejects(fixture({directory:'missing'}).counter.refresh(),error=>error.status===404);
});
test('truncated root trees are traversed and never treated as complete counts',async()=>{
 const {counter}=fixture({directory:'src',truncated:true}),result=await counter.refresh();assert.equal(result.after,3);assert.equal(result.files.length,1);
});
test('branch names containing slashes in GitHub folder URLs resolve against the default branch',async()=>{
 const counter=new GithubCounter({repository:'acme/repo',mode:'repo',directory:'',fetchImpl:async()=>Response.json({default_branch:'feature/demo'})});
 assert.deepEqual(await counter.resolveTreeTail('feature/demo/src/nested'),{ref:'feature/demo',directory:'src/nested'});
});
test('a count can be cancelled while waiting for GitHub',async()=>{
 const counter=new GithubCounter({mode:'repo',directory:'',fetchImpl:(_,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError'))))});
 const pending=counter.refresh();counter.abort();await assert.rejects(pending,{name:'AbortError'});
});
test('streamed counts handle Unicode split across chunks without buffering the whole file',async()=>{
 const value=enc.encode('雪\nlast');
 const counter=new GithubCounter({fetchImpl:async()=>new Response(new ReadableStream({start(c){c.enqueue(value.slice(0,1));c.enqueue(value.slice(1,4));c.enqueue(value.slice(4));c.close();}}))});
 assert.equal(await counter.request('https://raw.githubusercontent.com/acme/one/a/text','lines'),2);
});
