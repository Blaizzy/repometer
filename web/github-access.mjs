import {siteConfig} from './site-config.mjs?v=3';
const CONNECTION_KEY='repometer.github.pat.v1',COOLDOWN_KEY='repometer.github.cooldowns.v1',OAUTH_KEY='repometer.github.session.v2',PENDING_KEY='repometer.github.pending.v2';
const validSession=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value);
const base64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const random=()=>base64(crypto.getRandomValues(new Uint8Array(32)));
const digest=async value=>base64(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
function sessionStore(){try{return globalThis.sessionStorage;}catch{return null;}}
function read(storage,key){try{return JSON.parse(storage?.getItem(key)||'null');}catch{return null;}}
function validToken(value){return typeof value==='string'&&value.length>=10&&value.length<=512&&!/[\s\x00-\x1f\x7f]/.test(value);}
function apiURL(value){try{const url=new URL(value);return url.origin==='https://api.github.com'&&!url.username&&!url.password?url:null;}catch{return null;}}
function headerNumber(response,name){const value=response.headers.get(name);return value===null?null:Number(value);}

export class GitHubAccess {
  constructor({storage=sessionStore(),fetchImpl=(...args)=>globalThis.fetch(...args),now=Date.now,authOrigin=siteConfig.authOrigin}={}) {
    this.storage=storage;this.authOrigin=authOrigin;this.fetch=fetchImpl;this.now=now;this.listeners=new Set();this.rate=null;
    const saved=read(storage,CONNECTION_KEY);
    const oauth=read(storage,OAUTH_KEY);
    this.connection=validToken(saved?.token)&&typeof saved.login==='string'?saved:authOrigin&&validSession(oauth?.sessionToken)&&typeof oauth.login==='string'?oauth:null;
    this.cooldowns=read(storage,COOLDOWN_KEY)||{};
    this.persisted=!!this.connection;this.oauth={available:!!authOrigin,configured:!!authOrigin};this.authError='';
  }
  state(){return {connected:!!this.connection,login:this.connection?.login||'',invalid:!!this.connection?.invalid,rate:this.rate,persisted:this.persisted,mode:this.connection?.mode||(this.connection?'pat':null),expiresAt:this.connection?.expiresAt||0,oauth:{...this.oauth},authError:this.authError};}
  backendURL(path){return new URL(path,this.authOrigin).href;}
  sessionHeaders(){return this.connection?.mode==='oauth'&&validSession(this.connection.sessionToken)?{Authorization:'Bearer '+this.connection.sessionToken}:{};}
  async beginSignIn(pageURL){
    if(!this.authOrigin)throw new Error('GitHub sign-in is not configured for this site. You can use a personal access token.');
    const verifier=random(),state=random();
    if(!this.save(PENDING_KEY,{verifier,state,createdAt:this.now()}))throw new Error('Allow tab storage to sign in with GitHub. You can also use a personal access token.');
    const returnTo=new URL(pageURL);returnTo.hash='';
    return this.backendURL('/auth/github/start')+'?'+new URLSearchParams({returnTo:returnTo.href,challenge:await digest(verifier),client_state:state});
  }
  async initialize({pageURL=globalThis.location?.href,replaceURL=url=>globalThis.history?.replaceState(globalThis.history.state,'',url)}={}){
    this.authError='';
    if(!this.authOrigin)return this.state();
    try{
      const page=pageURL?new URL(pageURL):null,params=new URLSearchParams(page?.hash.slice(1));
      if(params.has('oauth_code')){
        const pending=read(this.storage,PENDING_KEY);this.save(PENDING_KEY,null);page.hash='';replaceURL(page.href);
        if(!pending||!validSession(pending.verifier)||pending.state!==params.get('oauth_state')||this.now()-pending.createdAt>600000)throw new Error('GitHub sign-in did not match this tab or expired. Please sign in again.');
        const response=await this.fetch(this.backendURL('/api/github/exchange'),{method:'POST',credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json'},body:JSON.stringify({code:params.get('oauth_code'),verifier:pending.verifier})});
        if(!response.ok)throw new Error('GitHub sign-in could not finish. Please sign in again.');
        const result=await response.json();
        if(!validSession(result.sessionToken)||typeof result.login!=='string'||!result.login||!Number.isFinite(result.expiresAt)||result.expiresAt<=this.now())throw new Error('GitHub sign-in returned an invalid session. Please try again.');
        this.connection={mode:'oauth',sessionToken:result.sessionToken,login:result.login,expiresAt:result.expiresAt,invalid:false};this.persisted=this.save(OAUTH_KEY,this.connection);this.save(CONNECTION_KEY,null);this.emit('initialized');return this.state();
      }
      if(page?.searchParams.get('github_auth')==='cancelled'){this.save(PENDING_KEY,null);page.searchParams.delete('github_auth');replaceURL(page.href);this.authError='GitHub sign-in was cancelled. You can try again whenever you’re ready.';}
      const response=await this.fetch(this.backendURL('/api/github/session'),{credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(10000),headers:this.sessionHeaders()});
      if(!response.ok)return this.state();const status=await response.json();this.oauth={available:status.available===true,configured:status.configured===true};
      if(this.connection?.mode==='oauth'){
        if(status.connected&&typeof status.login==='string'&&status.login){Object.assign(this.connection,{login:status.login,expiresAt:status.expiresAt,invalid:false});this.persisted=this.save(OAUTH_KEY,this.connection);}
        else {this.connection=null;this.persisted=false;this.save(OAUTH_KEY,null);this.authError='Your GitHub session expired. Sign in again to reconnect.';}
      }
      this.emit('initialized');
    }catch(error){this.authError=error instanceof TypeError?'Could not reach the sign-in service. Please try again.':error.message;}
    return this.state();
  }
  subscribe(listener){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
  emit(reason){for(const listener of this.listeners)listener(this.state(),reason);}
  save(key,value){try{if(value===null)this.storage?.removeItem(key);else this.storage?.setItem(key,JSON.stringify(value));return !!this.storage;}catch{return false;}}
  headers(url){return apiURL(url)&&this.connection?.token&&!this.connection.invalid?{Authorization:'Bearer '+this.connection.token}:{};}
  transport(url,options,fetchImpl=this.fetch){
    const parsed=apiURL(url);
    if(parsed&&this.connection?.mode==='oauth'){
      const headers=new Headers(options.headers);headers.delete('Authorization');
      for(const [key,value] of Object.entries(this.sessionHeaders()))headers.set(key,value);
      return fetchImpl(this.backendURL('/api/github')+'?'+new URLSearchParams({path:parsed.pathname+parsed.search}),{...options,headers,credentials:'omit',redirect:'error'});
    }
    return fetchImpl(url,options);
  }
  bucket(url){const parsed=apiURL(url);return parsed?(this.connection?.login||'anonymous')+':'+(parsed.pathname.startsWith('/search/')?'search':'core'):null;}
  retryAt(url){const key=this.bucket(url);if(!key)return 0;const at=Number(this.cooldowns[key]);return at>this.now()?at:0;}
  observe(url,response){
    const key=this.bucket(url);if(!key)return;
    const remaining=headerNumber(response,'x-ratelimit-remaining'),limit=headerNumber(response,'x-ratelimit-limit'),reset=headerNumber(response,'x-ratelimit-reset');
    if(Number.isFinite(limit)&&Number.isFinite(remaining)&&key.endsWith(':core'))this.rate={limit,remaining,resetAt:reset?reset*1000:0};
    const retry=response.headers.get('retry-after');
    const limited=response.status===429||response.status===403&&(remaining===0||retry!==null);
    if(limited||remaining===0){
      const after=retry===null?0:Number.isFinite(Number(retry))?this.now()+Number(retry)*1000:Date.parse(retry);
      this.cooldowns[key]=Math.max(this.now()+60_000,remaining===0&&reset?reset*1000:0,after||0)+1000;
      this.save(COOLDOWN_KEY,this.cooldowns);
    }
    if(response.status===401&&this.connection){this.connection.invalid=true;if(this.connection.mode!=='oauth')this.save(CONNECTION_KEY,this.connection);this.emit('invalidated');}
    else this.emit('usage');
  }
  async connect(value,{signal}={}){
    const token=String(value||'').trim();
    if(!validToken(token))throw new Error('Paste a valid GitHub personal access token.');
    const response=await this.fetch('https://api.github.com/user',{signal,credentials:'omit',redirect:'error',cache:'no-store',headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+token}});
    if(signal?.aborted)throw new DOMException('Connection cancelled.','AbortError');
    if(response.status===401)throw new Error('GitHub rejected this token. Check that it is correct and has not expired.');
    if(response.status===403||response.status===429)throw new Error('GitHub could not validate this token right now. Check its permissions, expiration, and account request limit.');
    if(!response.ok)throw new Error('GitHub could not validate the token (HTTP '+response.status+').');
    const user=await response.json();
    if(signal?.aborted)throw new DOMException('Connection cancelled.','AbortError');
    if(typeof user.login!=='string'||!user.login)throw new Error('GitHub did not return an account for this token.');
    if(this.connection?.mode==='oauth')await this.logoutServer();
    if(signal?.aborted)throw new DOMException('Connection cancelled.','AbortError');
    this.save(OAUTH_KEY,null);this.connection={token,login:user.login,invalid:false,mode:'pat'};this.persisted=this.save(CONNECTION_KEY,this.connection);
    this.rate=null;this.observe('https://api.github.com/user',response);this.emit('connected');
    return this.state();
  }
  async logoutServer(){const response=await this.fetch(this.backendURL('/api/github/logout'),{method:'POST',credentials:'omit',redirect:'error',cache:'no-store',headers:this.sessionHeaders(),signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error('Could not disconnect GitHub. Please try again.');}
  async disconnect(){if(this.connection?.mode==='oauth')await this.logoutServer();this.connection=null;this.rate=null;this.persisted=false;this.save(CONNECTION_KEY,null);this.save(OAUTH_KEY,null);this.emit('disconnected');}
}

export const githubAccess=new GitHubAccess();
