import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as tick} from 'node:timers/promises';
import {GithubCounter,FILE_CONCURRENCY} from '../web/live-data.mjs';

const revision='a'.repeat(40);
const file=(index,sha=(index+1).toString(16).padStart(40,'0'))=>({path:`src/file-${index}.txt`,type:'blob',sha});
function fixture(entries){
  const calls=[],events=[];
  let active=0,peak=0;
  const counter=new GithubCounter({repository:'acme/repo',mode:'repo',directory:'',onProgress:(_message,detail)=>events.push(detail),fetchImpl:async(url,{signal})=>{
    if(url.includes('/git/trees/'))return Response.json({tree:entries,truncated:false});
    active++;peak=Math.max(peak,active);
    return new Promise((resolve,reject)=>{
      let settled=false;
      const finish=callback=>{if(settled)return;settled=true;active--;signal.removeEventListener('abort',abort);callback();};
      const abort=()=>finish(()=>reject(new DOMException('Cancelled','AbortError')));
      signal.addEventListener('abort',abort,{once:true});
      calls.push({url,signal,resolve:response=>finish(()=>resolve(response))});
    });
  }});
  return {counter,calls,events,get active(){return active;},get peak(){return peak;}};
}

test('file downloads overlap up to twelve at a time and refill without waiting for a whole batch',async()=>{
  const entries=Array.from({length:29},(_,i)=>file(i)),f=fixture(entries);
  const pending=f.counter.countRevision(revision);await tick();
  assert.equal(FILE_CONCURRENCY,12);assert.equal(f.active,12);assert.equal(f.calls.length,12);
  f.calls[11].resolve(new Response('one\ntwo'));await tick();
  assert.equal(f.calls.length,13,'one completed file starts the next immediately');assert.equal(f.active,12);
  let released=0;
  while(released<entries.length){
    const batch=f.calls.slice(released);assert.ok(batch.length);
    released=f.calls.length;
    for(const call of batch)call.resolve(new Response('one\ntwo'));
    await tick();
  }
  const result=await pending;
  assert.equal(f.peak,12);assert.equal(f.active,0);
  assert.deepEqual(result.map(x=>x.path),entries.map(x=>x.path),'out-of-order completion preserves tree order');
  assert.equal(result.reduce((n,x)=>n+x.lines,0),58);
  const progress=f.events.filter(x=>x.phase==='counting');
  assert.deepEqual(progress.map(x=>x.completed),Array.from({length:30},(_,i)=>i));
  assert.equal(progress.at(-1).lines,58);assert.equal(progress.at(-1).textFiles,29);
});

test('identical in-flight blobs download once but count separately at each file path',async()=>{
  const entries=Array.from({length:20},(_,i)=>file(i,i%2?'c'.repeat(40):'b'.repeat(40))),f=fixture(entries);
  const pending=f.counter.countRevision(revision);await tick();
  assert.equal(f.calls.length,2);
  f.calls[0].resolve(new Response('one\ntwo\n'));f.calls[1].resolve(new Response(new Uint8Array([0,1])));
  const result=await pending;
  assert.equal(f.calls.length,2);assert.equal(result.length,10);assert.equal(result.reduce((n,x)=>n+x.lines,0),20);
  assert.equal(f.counter.stats.get(f.counter.key(revision)).excluded,10);
  assert.equal(f.events.at(-1).completed,20);assert.equal(f.events.at(-1).cached,18);
});

test('cancelling parallel work aborts every active download and never starts queued files',async()=>{
  const f=fixture(Array.from({length:30},(_,i)=>file(i))),pending=f.counter.countRevision(revision);
  const rejected=assert.rejects(pending,{name:'AbortError'});await tick();
  assert.equal(f.active,12);f.counter.abort();await rejected;
  assert.equal(f.active,0);assert.equal(f.calls.length,12);assert.ok(f.calls.every(x=>x.signal.aborted));
  assert.equal(f.counter.revisions.size,0);assert.equal(f.counter.stats.size,0);
  assert.equal(f.events.at(-1).completed,0);
});

test('a rate limit stops all parallel work, keeps its retry time, and allows a clean retry',async()=>{
  const f=fixture(Array.from({length:15},(_,i)=>file(i))),pending=f.counter.countRevision(revision);
  const rejected=assert.rejects(pending,error=>error.status===429&&error.retryAt>=Date.now()+50_000);
  await tick();f.calls[5].resolve(new Response('',{status:429,headers:{'retry-after':'60'}}));await rejected;
  assert.equal(f.active,0);assert.equal(f.calls.length,12);assert.equal(f.counter.revisions.size,0);
  assert.equal(f.counter.cancelled,false,'a failed attempt can be retried after the cooldown');
  assert.ok(f.calls.every((call,i)=>i===5||call.signal.aborted));
  let released=f.calls.length;
  const retry=f.counter.countRevision(revision);await tick();
  while(f.active){const batch=f.calls.slice(released);released=f.calls.length;for(const call of batch)call.resolve(new Response('retry\n'));await tick();}
  assert.equal((await retry).length,15);assert.equal(f.peak,12);
});
