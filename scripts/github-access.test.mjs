import test from 'node:test';
import assert from 'node:assert/strict';
import {GitHubAccess} from '../web/github-access.mjs';
import {GithubCounter,RefreshLoop,REFRESH_INTERVAL} from '../web/live-data.mjs';

const token='fake_token_for_unit_tests_only';
const account=()=>Response.json({login:'test-user',private_gists:99},{headers:{'x-ratelimit-limit':'5000','x-ratelimit-remaining':'4999','x-ratelimit-reset':'900'}});
function session(){const values=new Map();return {values,getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};}

test('a validated token is saved only in supplied tab storage, restored, and removed on disconnect',async()=>{
  const storage=session(),calls=[],changes=[];
  const access=new GitHubAccess({storage,fetchImpl:async(url,options)=>{calls.push({url,options});return account();}});
  access.subscribe((state,reason)=>changes.push({state,reason}));
  const state=await access.connect(token);
  assert.equal(state.login,'test-user');assert.equal(state.connected,true);assert.equal(state.rate.limit,5000);
  assert.equal(calls[0].url,'https://api.github.com/user');assert.equal(calls[0].options.headers.Authorization,'Bearer '+token);
  assert.equal(calls[0].options.credentials,'omit');assert.equal(calls[0].options.redirect,'error');
  assert.ok(!JSON.stringify(state).includes(token));assert.ok(!JSON.stringify(changes).includes(token));
  assert.ok(![...storage.values.values()].join('').includes('private_gists'));
  const restored=new GitHubAccess({storage});assert.equal(restored.headers('https://api.github.com/repos/acme/repo').Authorization,'Bearer '+token);
  restored.disconnect();assert.deepEqual(restored.headers('https://api.github.com/user'),{});assert.ok(![...storage.values.values()].join('').includes(token));
});

test('tokens never enter headers for raw files, the Site, lookalike hosts, HTTP, or URL credentials',async()=>{
  const access=new GitHubAccess({storage:session(),fetchImpl:async()=>account()});await access.connect(token);
  for(const url of ['https://raw.githubusercontent.com/acme/repo/main/a.py','https://example.chatgpt.site/','https://api.github.com.evil.test/repos','http://api.github.com/user','https://api.github.com:444/user','https://person@api.github.com/user'])assert.deepEqual(access.headers(url),{});
  const calls=[];
  const counter=new GithubCounter({apiAccess:access,fetchImpl:async(url,options)=>{calls.push({url,options});return url.includes('raw.githubusercontent.com')?new Response('line\n'):Response.json({ok:true});}});
  await counter.api('');await counter.request('https://raw.githubusercontent.com/acme/repo/main/a.py','lines');
  assert.equal(calls[0].options.headers.Authorization,'Bearer '+token);assert.equal(calls[1].options.headers.Authorization,undefined);
});

test('invalid replacement tokens do not overwrite a working connection or echo token text',async()=>{
  let fail=false;const access=new GitHubAccess({storage:session(),fetchImpl:async()=>fail?new Response('secret echoed by upstream',{status:401}):account()});
  await access.connect(token);fail=true;
  await assert.rejects(access.connect('invalid_replacement_token'),error=>/rejected/.test(error.message)&&!error.message.includes('invalid_replacement_token')&&!error.message.includes('secret'));
  assert.equal(access.headers('https://api.github.com/user').Authorization,'Bearer '+token);
  await assert.rejects(access.connect('contains\nnewline'),/valid GitHub/);
});

test('closing authentication before validation completes never stores a late token',async()=>{
  let finish;const storage=session(),controller=new AbortController(),access=new GitHubAccess({storage,fetchImpl:()=>new Promise(resolve=>{finish=resolve;})});
  const pending=access.connect(token,{signal:controller.signal});controller.abort();finish(account());
  await assert.rejects(pending,{name:'AbortError'});assert.equal(access.state().connected,false);assert.equal(storage.values.size,0);
});

test('anonymous cooldown survives reload; connecting uses a separate allowance; disconnect restores cooldown',async()=>{
  const storage=session();let now=1000,requests=0;
  const access=new GitHubAccess({storage,now:()=>now,fetchImpl:async()=>account()});
  const limited=()=>new Response('',{status:403,headers:{'x-ratelimit-remaining':'0','x-ratelimit-reset':'600'}});
  const counter=new GithubCounter({apiAccess:access,now:()=>now,fetchImpl:async()=>{requests++;return limited();}});
  await assert.rejects(counter.api(''),error=>error.retryAt===601000);
  const restored=new GitHubAccess({storage,now:()=>now,fetchImpl:async()=>account()});
  const retry=new GithubCounter({apiAccess:restored,now:()=>now,fetchImpl:async()=>{requests++;return Response.json({ok:true});}});
  await assert.rejects(retry.api(''),error=>error.retryAt===601000);assert.equal(requests,1);
  await restored.connect(token);assert.deepEqual(await retry.api(''),{ok:true});assert.equal(requests,2);
  restored.disconnect();await assert.rejects(retry.api(''),error=>error.retryAt===601000);assert.equal(requests,2);
  now=601001;assert.deepEqual(await retry.api(''),{ok:true});assert.equal(requests,3);
});

test('a revoked token stops further authenticated attempts and can be replaced',async()=>{
  const access=new GitHubAccess({storage:session(),fetchImpl:async()=>account()});await access.connect(token);let calls=0;
  const counter=new GithubCounter({apiAccess:access,fetchImpl:async()=>{calls++;return new Response('',{status:401});}});
  await assert.rejects(counter.api(''),error=>error.status===401);assert.equal(access.state().invalid,true);
  await assert.rejects(counter.api(''),error=>error.status===401);assert.equal(calls,1);
  await access.connect('replacement_token_for_tests');assert.equal(access.state().invalid,false);
});

test('storage failures keep authentication usable in memory and make its lifetime explicit',async()=>{
  const access=new GitHubAccess({storage:{getItem(){throw Error('blocked');},setItem(){throw Error('blocked');},removeItem(){throw Error('blocked');}},fetchImpl:async()=>account()});
  const state=await access.connect(token);assert.equal(state.connected,true);assert.equal(state.persisted,false);access.disconnect();assert.equal(access.state().connected,false);
});

test('polling defaults to five minutes and supports the faster authenticated interval',async()=>{
  assert.equal(REFRESH_INTERVAL,300000);let connected=false,now=0,delay;
  const loop=new RefreshLoop({refresh:async()=>null,interval:()=>connected?120000:REFRESH_INTERVAL,now:()=>now,setTimer:(_,value)=>(delay=value,1),clearTimer:()=>{}});
  await loop.run(true);assert.equal(delay,300000);connected=true;now=300000;await loop.run(true);assert.equal(delay,120000);loop.stop();
});


test('Pages sign-in uses proof keys, removes the callback ticket from the URL, and stores only an opaque session',async()=>{
  const storage=session(),calls=[],opaque='a'.repeat(43),now=100000;
  const access=new GitHubAccess({storage,now:()=>now,authOrigin:'https://auth.example',fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json({sessionToken:opaque,login:'Blaizzy',expiresAt:now+28800000});}});
  const original='https://blaizzy.github.io/repometer/compare.html?left=Blaizzy%2Fmlx-vlm&right=Blaizzy%2Fmlx-audio&scope=python',start=new URL(await access.beginSignIn(original));
  assert.equal(start.origin,'https://auth.example');assert.equal(start.searchParams.get('returnTo'),original);assert.match(start.searchParams.get('challenge'),/^[A-Za-z0-9_-]{43}$/);
  const pending=JSON.parse(storage.getItem('repometer.github.pending.v2'));assert.notEqual(pending.verifier,start.searchParams.get('challenge'));
  let cleaned;await access.initialize({pageURL:original+'#oauth_code='+'b'.repeat(43)+'&oauth_state='+start.searchParams.get('client_state'),replaceURL:url=>{cleaned=url;}});
  assert.equal(cleaned,original);assert.equal(storage.getItem('repometer.github.pending.v2'),null);assert.equal(access.state().mode,'oauth');assert.equal(access.state().login,'Blaizzy');assert.ok(!JSON.stringify(access.state()).includes(opaque));
  assert.equal(calls[0].url,'https://auth.example/api/github/exchange');assert.equal(calls[0].options.credentials,'omit');assert.equal(JSON.parse(calls[0].options.body).verifier,pending.verifier);
  assert.deepEqual(access.headers('https://api.github.com/user'),{});
  const requests=[],counter=new GithubCounter({apiAccess:access,fetchImpl:async(url,options)=>{requests.push({url,options});return url.includes('raw.githubusercontent.com')?new Response('line\n'):Response.json({ok:true});}});
  await counter.api('');await counter.request('https://raw.githubusercontent.com/Blaizzy/mlx-vlm/main/a.py','lines');
  assert.equal(requests[0].url,'https://auth.example/api/github?path=%2Frepos%2FBlaizzy%2Fmlx-vlm');assert.equal(requests[0].options.headers.get('Authorization'),'Bearer '+opaque);assert.equal(requests[1].options.headers.Authorization,undefined);
});
test('mismatched callback state never sends the ticket to the server',async()=>{
  let calls=0;const storage=session(),access=new GitHubAccess({storage,authOrigin:'https://auth.example',fetchImpl:async()=>{calls++;throw Error('must not call');}});await access.beginSignIn('https://blaizzy.github.io/repometer/');await access.initialize({pageURL:'https://blaizzy.github.io/repometer/#oauth_code='+'b'.repeat(43)+'&oauth_state=wrong',replaceURL:()=>{}});assert.equal(calls,0);assert.equal(access.state().connected,false);assert.match(access.state().authError,/did not match/);assert.equal(storage.getItem('repometer.github.pending.v2'),null);
});
test('OAuth session restoration and disconnect use the backend without browser cookies',async()=>{
 const storage=session(),opaque='c'.repeat(43),calls=[];storage.setItem('repometer.github.session.v2',JSON.stringify({mode:'oauth',sessionToken:opaque,login:'Blaizzy',expiresAt:200000}));
 const access=new GitHubAccess({storage,authOrigin:'https://auth.example',fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json(url.endsWith('/logout')?{connected:false}:{available:true,configured:true,connected:true,login:'Blaizzy',expiresAt:200000});}});
 await access.initialize();assert.equal(access.state().connected,true);assert.equal(calls[0].options.headers.Authorization,'Bearer '+opaque);assert.equal(calls[0].options.credentials,'omit');await access.disconnect();assert.equal(calls.at(-1).url,'https://auth.example/api/github/logout');assert.equal(calls.at(-1).options.headers.Authorization,'Bearer '+opaque);assert.equal(access.state().connected,false);assert.equal(storage.getItem('repometer.github.session.v2'),null);
});
test('GitHub sign-in requires tab storage, while a personal token still works without it',async()=>{
 const access=new GitHubAccess({storage:null,authOrigin:'https://auth.example',fetchImpl:async()=>account()});await assert.rejects(access.beginSignIn('https://blaizzy.github.io/repometer/'),/Allow tab storage/);await access.connect(token);assert.equal(access.state().connected,true);
});

test('an unconfigured preview skips OAuth requests and saved sessions while public and personal-token access still work',async()=>{
 const storage=session(),calls=[];
 storage.setItem('repometer.github.session.v2',JSON.stringify({mode:'oauth',sessionToken:'c'.repeat(43),login:'Blaizzy'}));
 const access=new GitHubAccess({storage,authOrigin:'',fetchImpl:async(url,options)=>{calls.push({url,options});return account();}});
 const state=await access.initialize();
 assert.deepEqual(state.oauth,{available:false,configured:false});assert.equal(state.connected,false);assert.equal(state.authError,'');assert.equal(calls.length,0);
 await assert.rejects(access.beginSignIn('https://example.test/'),/not configured/);
 assert.equal(storage.getItem('repometer.github.pending.v2'),null);
 await access.transport('https://api.github.com/repos/acme/repo',{});
 assert.equal(calls[0].url,'https://api.github.com/repos/acme/repo');assert.equal(calls[0].options.headers,undefined);
 await access.connect(token);assert.equal(access.state().connected,true);assert.equal(access.state().mode,'pat');
 assert.equal(calls[1].url,'https://api.github.com/user');assert.equal(calls[1].options.headers.Authorization,'Bearer '+token);
});

test('moving the backend starts a clean session without forwarding legacy credentials',async()=>{
 const storage=session(),calls=[];
 storage.setItem('repometer.github.session.v1',JSON.stringify({mode:'oauth',sessionToken:'z'.repeat(43),login:'Blaizzy'}));
 const access=new GitHubAccess({storage,authOrigin:'https://new-auth.example',fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json({available:true,configured:true,connected:false});}});
 await access.initialize();
 assert.equal(access.state().connected,false);
 assert.equal(access.state().authError,'');
 assert.equal(calls.length,1);
 assert.equal(calls[0].url,'https://new-auth.example/api/github/session');
 assert.equal(calls[0].options.headers.Authorization,undefined);
});
