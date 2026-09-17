import test from 'node:test';
import assert from 'node:assert/strict';
import {ComparisonCounter,parseSelection,comparisonQuery,summarizeComparison} from '../web/compare-data.mjs';

const sha=value=>value.repeat(40);
const selections=[parseSelection('acme/one'),parseSelection('acme/two')];
function fixture(){
  const state={fail:false},calls=[];
  const fetchImpl=async(url)=>{
    calls.push(url);
    const u=new URL(url),second=u.pathname.includes('/acme/two'),repo=second?'acme/two':'acme/one';
    if(u.pathname==='/repos/'+repo)return Response.json({default_branch:'main'});
    if(u.pathname.endsWith('/commits/main'))return state.fail&&second?new Response('',{status:404}):Response.json({sha:sha(second?'b':'a')});
    if(u.pathname.includes('/git/trees/'))return Response.json({tree:[{path:'src',type:'tree',sha:sha('c')},{path:'src/code.py',type:'blob',sha:sha(second?'2':'1')},{path:'data.json',type:'blob',sha:sha(second?'4':'3')}],truncated:false});
    if(u.hostname==='raw.githubusercontent.com')return new Response(u.pathname.endsWith('.py')?(second?'1\n2\n3\n':'1\n'):second?'{}\n':'{\n}\n');
    throw new Error('Unexpected URL '+url);
  };
  return {state,calls,fetchImpl};
}
test('comparison accepts repositories and folder links and preserves explicit branch and folder choices',()=>{
  assert.equal(parseSelection('https://github.com/acme/one.git').repository,'acme/one');
  const folder=parseSelection('https://github.com/acme/one/tree/main/src','release','tests');
  assert.equal(folder.treeTail,'main/src');assert.equal(folder.ref,'release');assert.equal(folder.directory,'tests');
  assert.throws(()=>parseSelection('search terms'));assert.throws(()=>parseSelection('https://github.com/acme/one/pull/4'));
  assert.throws(()=>parseSelection('https://example.org/acme/one'));assert.throws(()=>parseSelection('acme/one','','../private'));
  const p=new URLSearchParams(comparisonQuery([folder,selections[1]],'python'));
  assert.equal(p.get('left'),'acme/one');assert.equal(p.get('leftRef'),'release');assert.equal(p.get('leftPath'),'tests');assert.equal(p.get('scope'),'python');assert.equal(p.get('right'),'acme/two');
});
test('both repositories use identical filters and differences are B minus A',async()=>{
  const f=fixture(),counter=new ComparisonCounter(selections,{fetchImpl:f.fetchImpl}),result=await counter.refresh();
  const all=summarizeComparison(result);assert.deepEqual(all.totals.map(t=>[t.lines,t.files]),[[3,2],[4,2]]);assert.equal(all.delta,1);assert.ok(Math.abs(all.percent-100/3)<1e-8);
  const python=summarizeComparison(result,{scope:'python'});assert.deepEqual(python.totals.map(t=>t.lines),[1,3]);assert.equal(python.delta,2);assert.equal(python.percent,200);
  const json=summarizeComparison(result,{fileType:'.json'});assert.equal(json.delta,-1);assert.equal(json.percent,-50);
  const missing=summarizeComparison(result,{fileType:'.rs'});assert.equal(missing.delta,0);assert.equal(missing.percent,null);assert.equal(missing.types.length,0);
  assert.deepEqual(all.types.map(t=>t.extension),['.py','.json']);
});
test('zero-line baselines have no fabricated percentage and missing file types count as zero',()=>{
  const result=summarizeComparison([{files:[]},{files:[{extension:'.py',after:5}]}]);
  assert.equal(result.delta,5);assert.equal(result.percent,null);assert.deepEqual(result.types,[{extension:'.py',left:0,right:5}]);
});
test('folder links resolve before counting and repository caches remain isolated',async()=>{
  const f=fixture(),targets=[parseSelection('https://github.com/acme/one/tree/main/src'),selections[1]],counter=new ComparisonCounter(targets,{fetchImpl:f.fetchImpl});
  const result=await counter.refresh();assert.equal(result[0].directory,'src');assert.equal(result[0].ref,'main');assert.equal(result[0].after,1);assert.equal(result[1].after,4);
  const rawCalls=f.calls.filter(url=>url.includes('raw.githubusercontent.com')).length;await counter.refresh();assert.equal(f.calls.filter(url=>url.includes('raw.githubusercontent.com')).length,rawCalls);
});
test('a failed side rejects the entire comparison and a later retry can recover',async()=>{
  const f=fixture(),counter=new ComparisonCounter(selections,{fetchImpl:f.fetchImpl});
  const first=await counter.refresh();f.state.fail=true;
  await assert.rejects(counter.refresh(),error=>error.status===404&&error.message.includes('Repository B (acme/two)'));
  assert.deepEqual(first.map(snapshot=>snapshot.after),[3,4]);f.state.fail=false;assert.deepEqual((await counter.refresh()).map(snapshot=>snapshot.after),[3,4]);
});
test('cancellation aborts both in-flight repositories without publishing partial counts',async()=>{
  let aborted=0;const events=[];
  const counter=new ComparisonCounter(selections,{onProgress:(index,message,detail)=>events.push({index,...detail}),fetchImpl:(_,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>{aborted++;reject(new DOMException('cancelled','AbortError'));}))});
  const pending=counter.refresh();counter.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(aborted,2);
  assert.ok(events.every(event=>event.phase!=='complete'));
});

test('each side reports real progress and completion while the comparison waits for the slower repository',{timeout:5000},async()=>{
  const f=fixture(),events=[];
  let releaseRight,finishLeft,published=false;
  const rightGate=new Promise(resolve=>{releaseRight=resolve;});
  const leftComplete=new Promise(resolve=>{finishLeft=resolve;});
  const counter=new ComparisonCounter(selections,{fetchImpl:async(url,options)=>{
    if(url.startsWith('https://raw.githubusercontent.com/acme/two/'))await rightGate;
    return f.fetchImpl(url,options);
  },onProgress(index,message,detail){events.push({index,message,...detail});if(index===0&&detail.phase==='complete')finishLeft();}});
  const pending=counter.refresh().then(result=>{published=true;return result;});
  try{
    await leftComplete;
    assert.equal(published,false,'Do not publish a mixed or partial comparison');
    const left=events.find(event=>event.index===0&&event.phase==='complete');
    assert.equal(left.repository,'acme/one');assert.equal(left.ref,'main');assert.equal(left.completed,2);assert.equal(left.total,2);assert.equal(left.textFiles,2);assert.equal(left.lines,3);
    assert.ok(events.some(event=>event.index===1&&event.phase==='counting'&&event.completed===0&&event.total===2));
    assert.ok(!events.some(event=>event.index===1&&event.phase==='complete'));
    assert.ok(events.some(event=>event.index===0&&event.phase==='counting'&&event.completed===1&&event.path));
  }finally{releaseRight();}
  await pending;
  assert.deepEqual(events.filter(event=>event.phase==='complete').map(event=>[event.index,event.lines]),[[0,3],[1,4]]);
  const rawCalls=f.calls.filter(url=>url.includes('raw.githubusercontent.com')).length;
  events.length=0;await counter.refresh();
  assert.equal(f.calls.filter(url=>url.includes('raw.githubusercontent.com')).length,rawCalls);
  assert.equal(events.filter(event=>event.phase==='complete').length,2,'Cached refreshes must also complete both progress cards');
});
