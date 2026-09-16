import {githubAccess} from './github-access.mjs?v=12';
import {normalizeTarget, extension} from './targets.mjs';
const SHA=/^[a-f0-9]{40}$/;
const BINARY=/\.(?:png|jpe?g|gif|webp|ico|avif|heic|pdf|zip|gz|bz2|xz|7z|tar|woff2?|ttf|otf|eot|mp[34]|mov|wav|ogg|flac|npy|npz|safetensors|gguf|pt|pth|onnx|bin|exe|dll|so|dylib|pyc|class|jar|wasm)$/i;
export const REFRESH_INTERVAL=300_000;
export const refreshInterval=()=>githubAccess.state().connected&&!githubAccess.state().invalid?120_000:REFRESH_INTERVAL;
export function physicalLines(bytes) {
  let count=0;for(const byte of bytes){if(byte===0)return null;if(byte===10)count++;}
  return count+Number(bytes.length>0&&bytes[bytes.length-1]!==10);
}
async function streamLines(response) {
  if(!response.body)return 0;
  const reader=response.body.getReader();let lines=0,last=10,size=0;
  const decoder=new TextDecoder('utf-8',{fatal:true});
  try {
    while(true){const {done,value}=await reader.read();if(done)break;
      if(value.includes(0)){await reader.cancel();return null;}
      try{decoder.decode(value,{stream:true});}catch{await reader.cancel();return null;}
      for(const byte of value)if(byte===10)lines++;
      size+=value.length;if(value.length)last=value[value.length-1];
    }
    try{decoder.decode();}catch{return null;}
    return lines+Number(size>0&&last!==10);
  }finally{reader.releaseLock();}
}
export class GithubError extends Error {
  constructor(message,retryAt=0,status=0){super(message);this.retryAt=retryAt;this.status=status;}
}
export class GithubCounter {
  constructor({repository='Blaizzy/mlx-vlm',directory='mlx_vlm/tests',pull=2276,mode='pr',ref='',fetchImpl=(...args)=>globalThis.fetch(...args),now=Date.now,onProgress=()=>{},cache={},apiAccess=typeof document!=='undefined'?githubAccess:null}={}) {
    Object.assign(this,normalizeTarget({repository,directory,pull,mode,ref}));
    this.fetch=fetchImpl;this.now=now;this.onProgress=onProgress;this.cache=cache;this.apiAccess=apiAccess;
    this.blobs=cache.blobs??new Map();this.revisions=cache.revisions??new Map();this.trees=cache.trees??new Map();this.stats=cache.stats??new Map();
    this.controllers=new Set();this.cancelled=false;
  }
  key(revision){return this.repository+'@'+revision+':'+this.directory;}
  abort(){this.cancelled=true;for(const c of this.controllers)c.abort();}
  check(){if(this.cancelled)throw new DOMException('Count cancelled.','AbortError');}
  seed(snapshot){
    if((snapshot.repository??'Blaizzy/mlx-vlm').toLowerCase()!==this.repository.toLowerCase()||(snapshot.directory??'mlx_vlm/tests')!==this.directory)return;
    for(const side of ['before','after']){
      const revision=side==='before'?snapshot.base:snapshot.head,entries=[];
      for(const file of snapshot.files){const sha=file[side+'Blob'];if(!SHA.test(sha||'')||!Number.isSafeInteger(file[side])||file[side]<0)continue;this.blobs.set(sha,file[side]);entries.push({path:file.path,sha,lines:file[side]});}
      if(entries.length){this.revisions.set(this.key(revision),entries);this.stats.set(this.key(revision),{excluded:0,found:true});}
    }
  }
  async request(url,raw=false,fresh=false){
    this.check();const headers={...(raw?{}:{Accept:'application/vnd.github+json'}),...this.apiAccess?.headers(url)};
    if(new URL(url).origin==='https://api.github.com'){
      if(this.apiAccess?.state().invalid)throw new GithubError('Your GitHub connection expired or was revoked. Open GitHub access to reconnect.',0,401);
      const retryAt=this.apiAccess?.retryAt(url);if(retryAt)throw new GithubError('GitHub’s request limit was reached. Connect GitHub or wait for the reset.',retryAt,429);
    }
    const controller=new AbortController();this.controllers.add(controller);
    const timeout=globalThis.setTimeout(()=>controller.abort(),60_000);
    try{
      const options={signal:controller.signal,credentials:'omit',cache:fresh?'no-store':'default',headers};
      const response=await (this.apiAccess?this.apiAccess.transport(url,options,this.fetch):this.fetch(url,options));
      if(headers.Authorization===this.apiAccess?.headers(url).Authorization)this.apiAccess?.observe(url,response);
      if(!response.ok){
        if(response.status===401)throw new GithubError('Your GitHub connection expired or was revoked. Open GitHub access to reconnect.',0,401);
        if(response.status===429||(response.status===403&&(response.headers.get('x-ratelimit-remaining')==='0'||response.headers.has('retry-after')))){
          const reset=Number(response.headers.get('x-ratelimit-reset'))*1000,retry=Number(response.headers.get('retry-after'))*1000;
          throw new GithubError('GitHub’s request limit was reached. Open GitHub access to connect an account, or wait for the reset.',Math.max(this.apiAccess?.retryAt(url)||0,reset||0,this.now()+(retry||60_000)),response.status);
        }
        if(response.status===404)throw new GithubError('Repository, branch, folder, or PR not found. Only public repositories are supported.',0,404);
        if(response.status===409)throw new GithubError('This repository has no commits to count yet.',0,409);
        throw new GithubError(`GitHub could not provide the data (HTTP ${response.status}).`,0,response.status);
      }
      return raw==='lines'?await streamLines(response):raw?new Uint8Array(await response.arrayBuffer()):await response.json();
    }catch(error){if(error.name==='AbortError'&&!this.cancelled)throw new GithubError('GitHub took too long to respond.');throw error;}
    finally{globalThis.clearTimeout(timeout);this.controllers.delete(controller);}
  }
  api(path,fresh=false){return this.request('https://api.github.com/repos/'+this.repository+path,false,fresh);}
  async searchRepositories(query){
    const result=await this.request('https://api.github.com/search/repositories?q='+encodeURIComponent(query+' is:public')+'&per_page=12',false,true);
    return result.items||[];
  }
  async metadata(){
    const saved=this.cache.metadata;
    if(saved?.repository===this.repository&&saved.expiresAt>this.now())this.repoInfo=saved.value;
    if(!this.repoInfo){this.repoInfo=await this.api('');this.cache.metadata={repository:this.repository,value:this.repoInfo,expiresAt:this.now()+1800_000};}
    if(this.repoInfo.private)throw new GithubError('Only public repositories are supported by this counter.',0,400);
    return this.repoInfo;
  }
  async resolveTreeTail(tail){
    const info=await this.metadata(),branch=info.default_branch;
    if(tail===branch||tail.startsWith(branch+'/'))return {ref:branch,directory:tail.slice(branch.length).replace(/^\//,'')};
    const first=tail.split('/')[0];
    if(SHA.test(first))return {ref:first,directory:tail.slice(first.length).replace(/^\//,'')};
    for(const type of ['heads','tags']){
      const matches=await this.api('/git/matching-refs/'+type+'/'+encodeURIComponent(first));
      const ref=(Array.isArray(matches)?matches:[]).map(x=>x.ref.replace('refs/'+type+'/','')).filter(x=>tail===x||tail.startsWith(x+'/')).sort((a,b)=>b.length-a.length)[0];
      if(ref)return {ref,directory:tail.slice(ref.length).replace(/^\//,'')};
    }
    throw new GithubError('The folder URL’s branch or tag could not be found. Open the repository and enter the branch and folder separately.');
  }
  async tree(revision){
    const rootKey=this.repository+'@'+revision;
    let result=this.trees.get(rootKey);
    if(!result){result=await this.api('/git/trees/'+revision+'?recursive=1');if(!Array.isArray(result.tree))throw new GithubError('GitHub returned an incomplete file list.');if(!result.truncated)this.trees.set(rootKey,result);}
    const prefix=this.directory?this.directory+'/':'';
    if(!result.truncated){
      const found=!this.directory||result.tree.some(e=>e.path===this.directory&&e.type==='tree')||result.tree.some(e=>e.path.startsWith(prefix));
      return {found,entries:result.tree.filter(e=>e.type!=='tree'&&e.path.startsWith(prefix))};
    }
    let treeSha=revision;
    for(const segment of this.directory.split('/').filter(Boolean)){
      const parent=await this.api('/git/trees/'+treeSha);
      const child=parent.tree?.find(e=>e.path===segment&&e.type==='tree');
      if(!child)return {found:false,entries:[]};treeSha=child.sha;
    }
    const entries=[];
    const walk=async(sha,base)=>{
      const tree=await this.api('/git/trees/'+sha);if(tree.truncated||!Array.isArray(tree.tree))throw new GithubError('GitHub returned an incomplete directory.');
      for(const e of tree.tree){this.check();if(e.type==='tree')await walk(e.sha,base+e.path+'/');else entries.push({...e,path:base+e.path});}
    };
    await walk(treeSha,prefix);return {found:true,entries};
  }
  async countRevision(revision){
    this.check();if(!SHA.test(revision))throw new GithubError('GitHub returned an invalid revision.');
    const key=this.key(revision);if(this.revisions.has(key))return this.revisions.get(key);
    const {entries:tree,found}=await this.tree(revision),result=new Array(tree.length);
    let cursor=0,completed=0,excluded=0,failed=false;
    const worker=async()=>{
      try{while(cursor<tree.length&&!failed){this.check();const index=cursor++,file=tree[index];
        if(file.type!=='blob'||file.mode==='120000'||BINARY.test(file.path)){excluded++;}
        else{
          if(!this.blobs.has(file.sha)){
            const path=file.path.split('/').map(encodeURIComponent).join('/');
            const lines=await this.request(`https://raw.githubusercontent.com/${this.repository}/${revision}/${path}`,'lines');this.blobs.set(file.sha,lines);
          }
          const lines=this.blobs.get(file.sha);if(lines===null)excluded++;else result[index]={path:file.path,sha:file.sha,lines};
        }
        this.onProgress(`Counting files · ${++completed}/${tree.length}`);
      }}catch(error){failed=true;throw error;}
    };
    const workers=await Promise.allSettled(Array.from({length:Math.min(6,tree.length)},worker));
    const failure=workers.find(w=>w.status==='rejected');if(failure)throw failure.reason;
    const files=result.filter(Boolean);this.revisions.set(key,files);this.stats.set(key,{found,excluded});return files;
  }
  async refresh(previous){return this.mode==='repo'?this.refreshRepository(previous):this.refreshPR(previous);}
  async refreshRepository(previous){
    this.onProgress('Checking GitHub…');const info=await this.metadata(),ref=this.ref||info.default_branch;
    const commit=await this.api('/commits/'+encodeURIComponent(ref),true),head=commit.sha;
    if(!SHA.test(head||''))throw new GithubError('GitHub returned an invalid commit.');
    const entries=await this.countRevision(head),stats=this.stats.get(this.key(head));
    if(!stats?.found)throw new GithubError('Folder not found at this revision. Check the path and branch.',0,404);
    const files=entries.map(f=>({path:f.path,extension:extension(f.path),before:0,after:f.lines,delta:0,afterBlob:f.sha,status:'same'}));
    return {mode:'repo',repository:this.repository,directory:this.directory,ref,head,files,title:info.description||'',url:info.html_url||'https://github.com/'+this.repository,after:files.reduce((n,f)=>n+f.after,0),before:0,excluded:stats.excluded,capturedAt:new Date(this.now()).toISOString(),checkedAt:new Date(this.now()).toISOString()};
  }
  async refreshPR(previous){
    this.onProgress('Checking GitHub…');const pr=await this.api('/pulls/'+this.pull,true),head=pr.head?.sha,baseTip=pr.base?.sha;
    if(pr.base?.repo?.private||pr.head?.repo?.private)throw new GithubError('Only public repositories are supported by this counter.',0,400);
    if(!SHA.test(head||'')||!SHA.test(baseTip||''))throw new GithubError('GitHub returned incomplete pull request data.');
    let base,files,excluded=0;
    if(previous?.head===head&&previous?.baseTip===baseTip&&(previous.repository??this.repository)===this.repository&&(previous.directory??'mlx_vlm/tests')===this.directory){base=previous.base;files=previous.files;excluded=previous.excluded||0;}
    else{
      const comparison=await this.api(`/compare/${baseTip}...${head}?per_page=1`);base=comparison.merge_base_commit?.sha;
      if(!SHA.test(base||''))throw new GithubError('Could not determine the PR comparison base.');
      const before=new Map((await this.countRevision(base)).map(f=>[f.path,f])),after=new Map((await this.countRevision(head)).map(f=>[f.path,f]));
      const bStats=this.stats.get(this.key(base)),aStats=this.stats.get(this.key(head));
      if(!bStats?.found&&!aStats?.found)throw new GithubError('Folder not found in either PR revision.',0,404);
      excluded=(bStats?.excluded||0)+(aStats?.excluded||0);
      files=[...new Set([...before.keys(),...after.keys()])].sort().map(path=>{
        const b=before.get(path),a=after.get(path),name=path.split('/').pop();
        return {path,before:b?.lines??0,after:a?.lines??0,delta:(a?.lines??0)-(b?.lines??0),beforeBlob:b?.sha??null,afterBlob:a?.sha??null,extension:extension(path),category:name.startsWith('test_')?'tests':'helpers',status:!b?'added':!a?'removed':b.sha===a.sha?'same':'modified'};
      });
    }
    const testModule=f=>f.extension==='.py'&&f.path.split('/').pop().startsWith('test_');
    return {mode:'pr',repository:this.repository,directory:this.directory,number:this.pull,title:pr.title,url:pr.html_url,state:pr.merged?'merged':pr.state,author:pr.user.login,head,base,baseTip,headRef:pr.head.ref,baseRef:pr.base.ref,capturedAt:new Date(this.now()).toISOString(),checkedAt:new Date(this.now()).toISOString(),updatedAt:pr.updated_at,additions:pr.additions,deletions:pr.deletions,changedFiles:pr.changed_files,commits:pr.commits,files,excluded,before:files.reduce((n,f)=>n+f.before,0),after:files.reduce((n,f)=>n+f.after,0),testFilesBefore:files.filter(f=>testModule(f)&&f.status!=='added').length,testFilesAfter:files.filter(f=>testModule(f)&&f.status!=='removed').length};
  }
}
export class RefreshLoop {
  constructor({refresh, visible = () => true, now = Date.now, setTimer = (...args) => globalThis.setTimeout(...args), clearTimer = handle => globalThis.clearTimeout(handle), interval = refreshInterval, onStart = () => {}, onSuccess = () => {}, onError = () => {}}) {
    Object.assign(this, {refresh, visible, now, setTimer, clearTimer, interval, onStart, onSuccess, onError});
    this.nextAt = 0; this.failures = 0; this.pending = null; this.timer = null; this.stopped = false;
  }
  schedule() {
    this.clearTimer(this.timer);
    if (!this.stopped) this.timer = this.setTimer(() => this.run(), this.nextAt > this.now() ? this.nextAt - this.now() : this.interval());
  }
  run(manual = false) {
    if (this.pending) return this.pending;
    if (this.stopped) return Promise.resolve();
    const blocked = this.now() < (manual ? this.retryAt || 0 : this.nextAt);
    if (blocked || (!manual && !this.visible())) { this.schedule(); return Promise.resolve(); }
    this.onStart();
    this.pending = Promise.resolve().then(this.refresh).then(result => {
      this.failures = 0; this.retryAt = 0; this.nextAt = this.now() + this.interval();
      this.onSuccess(result);
    }).catch(error => {
      this.nextAt = Math.max(error.retryAt || 0, this.now() + Math.min(900_000, this.interval() * 2 ** this.failures++));
      this.retryAt = error.retryAt || 0;
      this.onError(error, this.nextAt);
    }).finally(() => { this.pending = null; this.schedule(); });
    return this.pending;
  }
  stop() { this.stopped = true; this.clearTimer(this.timer); }
}
