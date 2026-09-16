import test from 'node:test';
import assert from 'node:assert/strict';
import {GithubCounter, GithubError, RefreshLoop, REFRESH_INTERVAL, physicalLines} from '../web/live-data.mjs';

const sha = letter => letter.repeat(40);
const bytes = text => new TextEncoder().encode(text);
const entry = (path, id) => ({type:'blob', path:'mlx_vlm/tests/' + path, sha:sha(id)});

test('default browser APIs retain the global receiver for requests and automatic retry timers', async () => {
  const originals = {fetch:globalThis.fetch, setTimeout:globalThis.setTimeout, clearTimeout:globalThis.clearTimeout};
  let requests=0, scheduled=0, cleared=0, timer;
  try {
    globalThis.fetch = function () {
      assert.equal(this, globalThis, 'browser fetch rejects a GithubCounter receiver');
      requests++;
      return Promise.resolve(Response.json({ok:true}));
    };
    globalThis.setTimeout = function (callback) {
      assert.equal(this, globalThis, 'browser setTimeout rejects a RefreshLoop receiver');
      scheduled++; timer=callback; return 1;
    };
    globalThis.clearTimeout = function () {
      assert.equal(this, globalThis, 'browser clearTimeout rejects a RefreshLoop receiver');
      cleared++;
    };
    assert.deepEqual(await new GithubCounter().api('/pulls/2276'), {ok:true});
    const loop=new RefreshLoop({refresh:async()=>({ok:true})});
    await loop.run(true);
    assert.equal(requests,1);
    assert.ok(scheduled>=2, 'request timeout and refresh timer were scheduled');
    assert.ok(cleared>=2);
    assert.equal(typeof timer,'function');
    loop.stop();
  } finally { Object.assign(globalThis, originals); }
});

test('physical lines include blanks, comments, CRLF, and final unterminated lines; binary files are skipped', () => {
  for (const [text, count] of [['',0],['one',1],['one\n',1],['# note\n\nlast',3],['one\r\ntwo\r\n',2],['\0binary',null]]) {
    assert.equal(physicalLines(bytes(text)), count);
  }
});

function fixture(options={}) {
  let head = sha('b'), base = sha('a'), failRaw = false;
  const calls = [];
  const trees = {
    [sha('a')]: [entry('test_old.py','1'),entry('empty.py','0')],
    [sha('b')]: [entry('test_old.py','2'),entry('model_cases.json','3'),entry('empty.py','0')],
    [sha('c')]: [entry('test_renamed.py','2'),entry('model_cases.json','4')],
    [sha('d')]: [entry('test_old.py','5')],
  };
  const raw = {'1':'# old\n\na\nb\n','2':'x\n','3':'[\n1\n]\n','4':'[]','5':'base\nnow\n','0':''};
  const fetchImpl = async url => {
    calls.push(url);
    if (url.endsWith('/pulls/'+(options.pull||2276))) return Response.json({head:{sha:head,ref:'feature'},base:{sha:base,ref:'main'},title:'Current title',html_url:'https://github.com/Blaizzy/mlx-vlm/pull/2276',user:{login:'Blaizzy'},state:'open',additions:2,deletions:3,changed_files:3,commits:2});
    if (url.includes('/compare/')) return Response.json({merge_base_commit:{sha:base}});
    if (url.includes('/git/trees/')) return Response.json({tree:trees[url.split('/git/trees/')[1].split('?')[0]],truncated:false});
    if (failRaw) return new Response('Unavailable',{status:503});
    const parts=url.split('/'); const revision=parts[5],path=parts.slice(6).join('/');
    const file=trees[revision].find(file=>file.path===path);
    return new Response(raw[file.sha[0]]);
  };
  return {counter:new GithubCounter({...options,fetchImpl}),calls,setHead:value=>head=sha(value),setBase:value=>base=sha(value),setFail:value=>failRaw=value};
}

test('new heads, JSON edits, removed/renamed paths, and changed merge bases replace the complete counts', async () => {
  const f=fixture();
  const first=await f.counter.refresh();
  assert.deepEqual([first.before,first.after,first.testFilesBefore,first.testFilesAfter],[4,4,1,1]);
  assert.ok(first.files.find(file=>file.path.endsWith('empty.py')));
  f.setHead('c');
  const second=await f.counter.refresh(first);
  assert.deepEqual([second.before,second.after],[4,2]);
  assert.equal(second.files.find(file=>file.path.endsWith('test_old.py')).status,'removed');
  assert.equal(second.files.find(file=>file.path.endsWith('test_renamed.py')).status,'added');
  assert.equal(f.calls.filter(url=>url.includes('raw.githubusercontent.com')&&url.includes(sha('c'))).length,1,'renamed unchanged blob is reused');
  f.setBase('d');
  const third=await f.counter.refresh(second);
  assert.equal(third.before,2);
  assert.equal(third.base,sha('d'));
});

test('an unchanged head/base checks PR metadata without downloading or recounting files', async () => {
  const f=fixture(); const previous=await f.counter.refresh(); f.calls.length=0;
  const current=await f.counter.refresh(previous);
  assert.equal(current.files,previous.files);
  assert.equal(f.calls.length,1);
  assert.ok(f.calls[0].endsWith('/pulls/2276'));
});

test('PR progress identifies each revision so separate file totals are not confused',async()=>{
 const f=fixture(),events=[];f.counter.onProgress=(_message,detail)=>events.push(detail);
 const result=await f.counter.refresh();
 for(const [label,expected] of [['base',result.before],['head',result.after]]){
  const revision=events.filter(event=>event.phase==='counting'&&event.label===label);
  assert.equal(revision[0].completed,0);assert.equal(revision.at(-1).completed,revision.at(-1).total);assert.equal(revision.at(-1).lines,expected);
 }
});

test('failed downloads do not mutate prior counts and retries produce a complete revision', async () => {
  const f=fixture(); const previous=await f.counter.refresh(); const saved=JSON.stringify(previous);
  f.setHead('c'); f.setFail(true);
  await assert.rejects(f.counter.refresh(previous), /HTTP 503/);
  assert.equal(JSON.stringify(previous),saved);
  assert.equal(f.counter.revisions.has(f.counter.key(sha('c'))),false);
  f.setFail(false); assert.equal((await f.counter.refresh(previous)).after,2);
});

test('GitHub rate limits retain the reset time for backoff', async () => {
  const counter=new GithubCounter({now:()=>1000,fetchImpl:async()=>new Response('',{status:403,headers:{'x-ratelimit-remaining':'0','x-ratelimit-reset':'600'}})});
  await assert.rejects(counter.refresh(),error=>error instanceof GithubError&&error.retryAt===600000);
});

test('polling, overdue focus, manual refresh and overlapping requests use one refresh loop', async () => {
  let now=0,visible=true,calls=0,nextTimer;
  const loop=new RefreshLoop({refresh:async()=>++calls,now:()=>now,visible:()=>visible,setTimer:fn=>(nextTimer=fn,1),clearTimer:()=>{}});
  await loop.run(); assert.equal(calls,1);
  await loop.run(); assert.equal(calls,1);
  now=REFRESH_INTERVAL; await nextTimer(); assert.equal(calls,2);
  now+=REFRESH_INTERVAL;visible=false;await nextTimer();assert.equal(calls,2);
  visible=true;await loop.run();assert.equal(calls,3);
  const a=loop.run(true),b=loop.run(true);assert.equal(a,b);await a;assert.equal(calls,4);
  loop.stop();await loop.run(true);assert.equal(calls,4);
});

test('a failed refresh preserves the last successful result and rate limits prevent immediate retries', async () => {
  let now=0,calls=0,value='saved',errorAt;
  const loop=new RefreshLoop({refresh:async()=>{calls++;throw new GithubError('limited',600000);},now:()=>now,setTimer:()=>1,clearTimer:()=>{},onSuccess:x=>value=x,onError:(_,at)=>errorAt=at});
  await loop.run(true);assert.equal(value,'saved');assert.equal(errorAt,600000);
  now=120000;await loop.run(true);assert.equal(calls,1);
  now=600000;await loop.run();assert.equal(calls,2);loop.stop();
});


test('PR counts use the selected repository and PR number', async () => {
  const f=fixture({repository:'acme/another-repo',pull:42,directory:''});
  const result=await f.counter.refresh();
  assert.equal(result.repository,'acme/another-repo');
  assert.equal(result.number,42);
  assert.equal(result.after,4);
  assert.ok(f.calls.every(url=>url.includes('/acme/another-repo/')));
  assert.ok(f.calls[0].endsWith('/pulls/42'));
});
