const FLOW_COOKIE='__Host-repometer-flow';
const encoder=new TextEncoder(),decoder=new TextDecoder();
const safeHeaders={'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'};
const b64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const unb64=value=>Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),char=>char.charCodeAt(0));
const random=()=>b64(crypto.getRandomValues(new Uint8Array(32)));
const hash=async value=>b64(await crypto.subtle.digest('SHA-256',encoder.encode(value)));
const json=(value,status=200,headers={})=>Response.json(value,{status,headers:{...safeHeaders,...headers}});
const redirect=(location,cookies=[])=>{const headers=new Headers({...safeHeaders,location});for(const cookie of cookies)headers.append('set-cookie',cookie);return new Response(null,{status:303,headers});};
const cookie=(name,value,seconds)=>`${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`;
const clearCookie=name=>cookie(name,'',0);
const cookies=request=>Object.fromEntries((request.headers.get('cookie')||'').split(';').map(part=>part.trim().split('=')));
const esc=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

export function safeReturnTo(value,env){
  const base=new URL(env.FRONTEND_URL),url=new URL(value||base.href,base);
  if(url.origin!==base.origin||![base.pathname,base.pathname+'index.html',base.pathname+'compare.html',base.pathname+'compare/'].includes(url.pathname)||url.username||url.password)return base.href;
  const allowed=new Set(['repo','mode','pr','ref','path','scope','q','left','leftRef','leftPath','right','rightRef','rightPath']);
  for(const key of [...url.searchParams.keys()])if(!allowed.has(key))url.searchParams.delete(key);
  url.hash='';return url.href;
}
export function allowedGitHubPath(value){
  if(!value||value.length>4096||!value.startsWith('/')||value.startsWith('//')||/[\\\x00-\x1f]/.test(value))return null;
  const url=new URL(value,'https://api.github.com');if(url.origin!=='https://api.github.com')return null;
  if(url.pathname==='/search/repositories'){
    const q=url.searchParams.get('q');if(!q||q.length>500)return null;
    return '/search/repositories?'+new URLSearchParams({q:q+' is:public',per_page:'12'});
  }
  const match=url.pathname.match(/^\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(.*)$/);if(!match)return null;
  if(['.','..'].includes(match[1])||['.','..'].includes(match[2]))return null;
  const tail=match[3];
  if(!(/^$/.test(tail)||/^\/pulls\/[1-9][0-9]*$/.test(tail)||/^\/commits\/[^?#]+$/.test(tail)||/^\/git\/trees\/[a-f0-9]{40}$/.test(tail)||/^\/git\/matching-refs\/(heads|tags)\/[^?#]+$/.test(tail)||/^\/compare\/[a-f0-9]{40}\.\.\.[a-f0-9]{40}$/.test(tail)))return null;
  const params=new URLSearchParams();if(url.searchParams.get('recursive')==='1')params.set('recursive','1');if(url.searchParams.has('per_page'))params.set('per_page',String(Math.min(100,Math.max(1,Number(url.searchParams.get('per_page'))||1))));
  return url.pathname+(params.size?'?'+params:'');
}

export async function seal(value,secret,context){
  const key=await crypto.subtle.importKey('raw',unb64(secret),{name:'AES-GCM'},false,['encrypt']);
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(context)},key,encoder.encode(JSON.stringify(value)));
  return b64(iv)+'.'+b64(encrypted);
}
export async function unseal(value,secret,context){
  const [iv,data]=value.split('.');const key=await crypto.subtle.importKey('raw',unb64(secret),{name:'AES-GCM'},false,['decrypt']);
  const decrypted=await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(iv),additionalData:encoder.encode(context)},key,unb64(data));return JSON.parse(decoder.decode(decrypted));
}
function bearer(request){const value=request.headers.get('authorization')||'';return /^Bearer [A-Za-z0-9_-]{43}$/.test(value)?value.slice(7):null;}
function origin(env){const url=new URL(env.SITE_ORIGIN);if(url.protocol!=='https:')throw Error('Invalid site origin');return url.origin;}
function sameOrigin(request,env){return request.headers.get('origin')===new URL(env.FRONTEND_URL).origin;}
function errorPage(message,status=400){return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>GitHub connection · Repometer</title><link rel="stylesheet" href="/style.css"><main><h1>GitHub connection</h1><p>${esc(message)}</p><p><a href="/">Return to Repometer</a></p></main></html>`,{status,headers:{...safeHeaders,'content-type':'text/html; charset=utf-8'}});}
async function configuration(env){
  return env.GITHUB_CLIENT_ID&&env.GITHUB_CLIENT_SECRET?{clientId:env.GITHUB_CLIENT_ID,clientSecret:env.GITHUB_CLIENT_SECRET}:null;
}
async function transaction(request,env,kind,returnTo){
  const state=random(),browser=random(),verifier=random(),stateHash=await hash(state),payload=await seal({returnTo:safeReturnTo(returnTo,env),verifier,clientChallenge:new URL(request.url).searchParams.get('challenge'),clientState:new URL(request.url).searchParams.get('client_state')},env.GITHUB_SESSION_KEY,'flow:'+stateHash);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_transactions WHERE expires_at < ?').bind(Date.now()),
    env.DB.prepare('DELETE FROM github_sessions WHERE expires_at < ?').bind(Date.now()),
    env.DB.prepare('INSERT INTO oauth_transactions (state_hash, user_id, browser_hash, kind, payload, expires_at) VALUES (?, ?, ?, ?, ?, ?)').bind(stateHash,'pages',await hash(browser),kind,payload,Date.now()+600_000)
  ]);
  return {state,verifier,cookie:cookie(FLOW_COOKIE,browser,600)};
}
async function consume(request,env,kind){
  const url=new URL(request.url),state=url.searchParams.get('state'),browser=cookies(request)[FLOW_COOKIE];
  if(!/^[A-Za-z0-9_-]{43}$/.test(state||'')||!/^[A-Za-z0-9_-]{43}$/.test(browser||''))return null;
  const stateHash=await hash(state);
  const row=await env.DB.prepare('DELETE FROM oauth_transactions WHERE state_hash = ? AND user_id = ? AND browser_hash = ? AND kind = ? AND expires_at > ? RETURNING payload').bind(stateHash,'pages',await hash(browser),kind,Date.now()).first();
  return row?unseal(row.payload,env.GITHUB_SESSION_KEY,'flow:'+stateHash):null;
}
async function session(request,env){
  const value=bearer(request);if(!/^[A-Za-z0-9_-]{43}$/.test(value||''))return null;
  const sessionHash=await hash(value),row=await env.DB.prepare('SELECT session_hash, user_id, login, token, expires_at FROM github_sessions WHERE session_hash = ? AND user_id = ? AND expires_at > ?').bind(sessionHash,'pages',Date.now()).first();
  if(!row)return null;
  return {...row,accessToken:await unseal(row.token,env.GITHUB_SESSION_KEY,'session:'+row.user_id+':'+sessionHash)};
}
function githubOptions(headers={}){return {redirect:'manual',signal:AbortSignal.timeout(20000),headers:{Accept:'application/vnd.github+json','User-Agent':'Repometer',...headers}};}

async function route(request,env,{fetchImpl=(...args)=>globalThis.fetch(...args)}={}){
  const url=new URL(request.url),path=url.pathname;
  if(!path.startsWith('/auth/github/')&&!path.startsWith('/api/github'))return null;
  if(!env.DB||!env.GITHUB_SESSION_KEY||!env.SITE_ORIGIN||!env.FRONTEND_URL)return json({error:'GitHub sign-in is not configured yet.'},503);
  try {
    if(path==='/api/github/session'&&request.method==='GET'){
      const config=await configuration(env),active=await session(request,env);
      return json({available:true,configured:!!config,canSetup:false,connected:!!active,login:active?.login||'',expiresAt:active?.expires_at||0,mode:active?'oauth':null});
    }
    if(path==='/auth/github/start'&&request.method==='GET'){
      const config=await configuration(env);if(!config)return errorPage('GitHub sign-in is being configured. Please try again soon.',503);
      if(!/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('challenge')||'')||!/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('client_state')||''))return errorPage('Start GitHub sign-in from Repometer.',400);
      const flow=await transaction(request,env,'login',url.searchParams.get('returnTo'));
      const params=new URLSearchParams({client_id:config.clientId,redirect_uri:origin(env)+'/auth/github/callback',state:flow.state,code_challenge:await hash(flow.verifier),code_challenge_method:'S256',allow_signup:'false'});
      return redirect('https://github.com/login/oauth/authorize?'+params,[flow.cookie]);
    }
    if(path==='/auth/github/callback'&&request.method==='GET'){
      const flow=await consume(request,env,'login');if(!flow)return errorPage('The sign-in request expired or did not match this browser. Start sign-in again.');
      const code=url.searchParams.get('code');
      if(url.searchParams.has('error')||!code)return redirect(flow.returnTo+(flow.returnTo.includes('?')?'&':'?')+'github_auth=cancelled',[clearCookie(FLOW_COOKIE)]);
      if(!/^[A-Za-z0-9_-]{5,256}$/.test(code))return errorPage('GitHub returned an invalid authorization code.');
      const config=await configuration(env);if(!config)return errorPage('GitHub sign-in needs to be set up again.',503);
      const response=await fetchImpl('https://github.com/login/oauth/access_token',{...githubOptions({'Content-Type':'application/json'}),method:'POST',body:JSON.stringify({client_id:config.clientId,client_secret:config.clientSecret,code,redirect_uri:origin(env)+'/auth/github/callback',code_verifier:flow.verifier})});
      if(!response.ok)return errorPage('GitHub could not complete sign-in. Please try again.',502);
      const result=await response.json();if(typeof result.access_token!=='string'||result.error)return errorPage('GitHub authorization expired or was declined. Please sign in again.');
      const identity=await fetchImpl('https://api.github.com/user',githubOptions({Authorization:'Bearer '+result.access_token}));
      if(!identity.ok)return errorPage('GitHub could not verify your account. Please sign in again.',502);
      const profile=await identity.json();if(typeof profile.login!=='string'||!profile.login)return errorPage('GitHub did not return an account name.',502);
      const sessionValue=random(),sessionHash=await hash(sessionValue),duration=Math.min(28800,Math.max(60,Number(result.expires_in)||28800));
      const encrypted=await seal(result.access_token,env.GITHUB_SESSION_KEY,'session:pages:'+sessionHash);
      await env.DB.prepare('INSERT INTO github_sessions (session_hash, user_id, login, token, expires_at) VALUES (?, ?, ?, ?, ?)').bind(sessionHash,'pages',profile.login,encrypted,Date.now()+duration*1000).run();
      const ticket=random(),ticketHash=await hash(ticket),payload=await seal({sessionValue},env.GITHUB_SESSION_KEY,'flow:'+ticketHash);
      await env.DB.prepare('INSERT INTO oauth_transactions (state_hash, user_id, browser_hash, kind, payload, expires_at) VALUES (?, ?, ?, ?, ?, ?)').bind(ticketHash,'pages',flow.clientChallenge,'exchange',payload,Date.now()+120000).run();
      const destination=new URL(flow.returnTo);destination.hash=new URLSearchParams({oauth_code:ticket,oauth_state:flow.clientState}).toString();
      return redirect(destination.href,[clearCookie(FLOW_COOKIE)]);
    }
    if(path==='/api/github/exchange'&&request.method==='POST'){
      if(!sameOrigin(request,env))return json({error:'Start sign-in from Repometer.'},403);
      if(Number(request.headers.get('content-length'))>4096)return json({error:'Invalid sign-in exchange.'},400);
      const body=await request.text();if(body.length>4096)return json({error:'Invalid sign-in exchange.'},400);
      let input;try{input=JSON.parse(body);}catch{return json({error:'Invalid sign-in exchange.'},400);}
      if(!input||!/^[A-Za-z0-9_-]{43}$/.test(input.code||'')||!/^[A-Za-z0-9_-]{43}$/.test(input.verifier||''))return json({error:'Invalid sign-in exchange.'},400);
      const ticketHash=await hash(input.code),row=await env.DB.prepare('DELETE FROM oauth_transactions WHERE state_hash = ? AND user_id = ? AND browser_hash = ? AND kind = ? AND expires_at > ? RETURNING payload').bind(ticketHash,'pages',await hash(input.verifier),'exchange',Date.now()).first();
      if(!row)return json({error:'Sign-in expired or did not match this browser. Please sign in again.'},401);
      const {sessionValue}=await unseal(row.payload,env.GITHUB_SESSION_KEY,'flow:'+ticketHash),headers=new Headers(request.headers);headers.set('authorization','Bearer '+sessionValue);
      const active=await session(new Request(request.url,{headers}),env);if(!active)return json({error:'Sign-in expired. Please sign in again.'},401);
      return json({sessionToken:sessionValue,login:active.login,expiresAt:active.expires_at,mode:'oauth'});
    }
    if(path==='/api/github/logout'&&request.method==='POST'){
      if(!sameOrigin(request,env))return json({error:'Disconnect must come from Repometer.'},403);
      const value=bearer(request);if(value)await env.DB.prepare('DELETE FROM github_sessions WHERE session_hash = ? AND user_id = ?').bind(await hash(value),'pages').run();
      return json({connected:false});
    }
    if(path==='/api/github'&&request.method==='GET'){
      const active=await session(request,env);if(!active)return json({error:'GitHub sign-in expired. Connect GitHub again.'},401);
      const apiPath=allowedGitHubPath(url.searchParams.get('path'));if(!apiPath)return json({error:'This GitHub request is not supported.'},400);
      const upstream=await fetchImpl('https://api.github.com'+apiPath,githubOptions({Authorization:'Bearer '+active.accessToken}));
      if(upstream.status>=300&&upstream.status<400)return json({error:'GitHub redirected this repository request. Check the repository’s current name.'},502);
      if(upstream.status===401)await env.DB.prepare('DELETE FROM github_sessions WHERE session_hash = ? AND user_id = ?').bind(active.session_hash,'pages').run();
      const headers=new Headers(safeHeaders);headers.set('content-type','application/json; charset=utf-8');
      for(const name of ['x-ratelimit-limit','x-ratelimit-remaining','x-ratelimit-reset','x-ratelimit-resource','retry-after'])if(upstream.headers.has(name))headers.set(name,upstream.headers.get(name));
      return new Response(upstream.body,{status:upstream.status,headers});
    }
    return json({error:'Not found.'},404);
  }catch(error){
    // Do not log request URLs, OAuth codes, token bodies, or encrypted records.
    console.error('GitHub connection request failed:',error?.name||'Error');
    return path.startsWith('/auth/')?errorPage('GitHub sign-in is temporarily unavailable. Please return to the counter and try again.',503):json({error:'GitHub sign-in is temporarily unavailable. Please try again.'},503);
  }
}

export async function handleGitHub(request,env,options){
  const url=new URL(request.url),api=url.pathname.startsWith('/api/github'),allowed=env.FRONTEND_URL&&request.headers.get('origin')===new URL(env.FRONTEND_URL).origin;
  if(api&&request.headers.has('origin')&&!allowed)return json({error:'This origin is not allowed.'},403);
  let response;
  if(api&&request.method==='OPTIONS')response=new Response(null,{status:204});else response=await route(request,env,options);
  if(!response)return null;
  const headers=new Headers(response.headers);
  if(api&&allowed){headers.set('access-control-allow-origin',new URL(env.FRONTEND_URL).origin);headers.set('access-control-allow-methods','GET, POST, OPTIONS');headers.set('access-control-allow-headers','Authorization, Content-Type');headers.set('access-control-expose-headers','x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset, x-ratelimit-resource, retry-after');headers.set('vary','Origin');}
  return new Response(response.body,{status:response.status,headers});
}
