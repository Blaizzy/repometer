import {GithubCounter, GithubError} from './live-data.mjs?v=14';
import {parseTarget, normalizeTarget} from './targets.mjs';

export function parseSelection(value, ref='', directory='') {
  const parsed=parseTarget(value.trim());
  if(!parsed)throw new Error('Enter owner/repo or a GitHub repository URL.');
  if(parsed.mode==='pr')throw new Error('Choose a repository or folder URL. Pull requests have their own count view.');
  const target=normalizeTarget({...parsed,ref:ref.trim()||parsed.ref,directory:directory.trim()||parsed.directory});
  return {...target,...(parsed.treeTail?{treeTail:parsed.treeTail}: {})};
}

export function comparisonQuery(selections,scope='all') {
  const params=new URLSearchParams();
  selections.forEach((target,index)=>{
    const side=index===0?'left':'right';
    params.set(side,target.repository);
    if(target.ref)params.set(side+'Ref',target.ref);
    if(target.directory)params.set(side+'Path',target.directory);
  });
  if(scope!=='all')params.set('scope',scope);
  return '?'+params.toString();
}

export function summarizeComparison(snapshots,{scope='all',fileType=''}={}) {
  const totals=snapshots.map(snapshot=>{
    const files=snapshot.files.filter(file=>(scope==='all'||file.extension==='.py'||scope==='source'&&file.extension==='.json')&&(!fileType||file.extension===(fileType==='__none'?'':fileType)));
    const types=new Map();
    for(const file of files)types.set(file.extension,(types.get(file.extension)||0)+file.after);
    return {lines:files.reduce((n,file)=>n+file.after,0),files:files.length,types};
  });
  const delta=totals[1].lines-totals[0].lines;
  const percent=totals[0].lines?delta/totals[0].lines*100:null;
  const types=[...new Set(totals.flatMap(total=>[...total.types.keys()]))].map(extension=>({extension,left:totals[0].types.get(extension)||0,right:totals[1].types.get(extension)||0}));
  types.sort((a,b)=>(b.left+b.right)-(a.left+a.right)||a.extension.localeCompare(b.extension));
  return {totals,delta,percent,types};
}

export class ComparisonCounter {
  constructor(selections,{cache=new Map(),onProgress=()=>{},fetchImpl}={}) {
    if(selections.length!==2)throw new Error('Choose two repositories to compare.');
    this.selections=selections;this.cache=cache;this.onProgress=onProgress;this.fetchImpl=fetchImpl;
    this.counters=[];this.resolved=[];this.cancelled=false;
  }
  abort(){this.cancelled=true;this.counters.forEach(counter=>counter.abort());}
  async refresh() {
    if(this.cancelled)throw new DOMException('Comparison cancelled.','AbortError');
    let failure;
    this.counters=this.selections.map((selection,index)=>{
      const key=selection.repository.toLowerCase();
      if(!this.cache.has(key))this.cache.set(key,{blobs:new Map(),trees:new Map(),revisions:new Map(),stats:new Map()});
      return new GithubCounter({...selection,...this.resolved[index],mode:'repo',cache:this.cache.get(key),fetchImpl:this.fetchImpl,onProgress:(message,detail)=>this.onProgress(index,message,detail)});
    });
    const results=await Promise.allSettled(this.counters.map(async(counter,index)=>{
      try {
        const selection=this.selections[index];
        if(selection.treeTail&&!this.resolved[index]) {
          const resolved=await counter.resolveTreeTail(selection.treeTail);
          this.resolved[index]=normalizeTarget({...selection,ref:selection.ref||resolved.ref,directory:selection.directory||resolved.directory});
          Object.assign(counter,this.resolved[index]);
        }
        const snapshot=await counter.refresh();
        this.onProgress(index,'Count complete',{phase:'complete',repository:snapshot.repository,directory:snapshot.directory,ref:snapshot.ref,completed:snapshot.files.length+snapshot.excluded,total:snapshot.files.length+snapshot.excluded,textFiles:snapshot.files.length,excluded:snapshot.excluded,lines:snapshot.after});
        return snapshot;
      } catch(error) {
        if(!failure) {
          failure=error.name==='AbortError'?error:new GithubError('Repository '+(index===0?'A':'B')+' ('+counter.repository+'): '+error.message,error.retryAt||0,error.status||0);
          this.counters.forEach(other=>other.abort());
        }
        throw error;
      }
    }));
    if(this.cancelled)throw new DOMException('Comparison cancelled.','AbortError');
    if(failure)throw failure;
    return results.map(result=>result.value);
  }
}
