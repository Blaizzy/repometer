import {githubAccess} from './github-access.mjs?v=12';
import {mountGitHubAccess} from './auth-ui.mjs?v=12';
import {mountRepositoryLink} from './repository-link.mjs?v=12';
import {RefreshLoop} from './live-data.mjs?v=12';
import {ComparisonCounter,parseSelection,comparisonQuery,summarizeComparison} from './compare-data.mjs?v=12';
import {targetURL} from './targets.mjs';

const $=id=>document.getElementById(id),set=(id,value)=>{$(id).textContent=value;};
const number=value=>new Intl.NumberFormat('en-US').format(value),signed=value=>value>0?'+'+number(value):value<0?'−'+number(-value):'0';
const sides=['left','right'],cache=new Map();
let loader=null,loop=null,generation=0,snapshots=null,selections=null,scope='all',fileType='',dirty=false;
const names={'.py':'Python','.json':'JSON','.md':'Markdown','.js':'JavaScript','.ts':'TypeScript','.tsx':'TSX','.jsx':'JSX','.rs':'Rust','.go':'Go','.c':'C','.cpp':'C++','.h':'C headers','.html':'HTML','.css':'CSS','.swift':'Swift','.java':'Java','.rb':'Ruby','.txt':'Text','.sh':'Shell','.ipynb':'Notebooks'};
const typeName=extension=>names[extension]?(names[extension]+' ('+extension+')'):extension||'No extension';
function node(tag,className,text){const item=document.createElement(tag);if(className)item.className=className;if(text!==undefined)item.textContent=text;return item;}
function anchor(text,url,className,external=false){const a=node('a',className,text);a.href=url;if(external){a.target='_blank';a.rel='noopener noreferrer';}return a;}
function stop(){generation++;loop?.stop();loader?.abort();loop=null;}
function busy(value){$('compare-submit').disabled=value;sides.forEach(side=>$(side+'-fields').disabled=value);$('compare-cancel').hidden=!value;$('compare-refresh').disabled=value||!selections||dirty;$('compare-retry').disabled=value;$('compare-results').setAttribute('aria-busy',String(value));}
function hideError(){$('compare-error').hidden=true;}
function errorMessage(error){return /fetch|network|load failed/i.test(error.message)?'Could not reach GitHub. Check your connection and try again.':error.message;}
function showError(error,retry=false){$('compare-error').hidden=false;set('compare-error-message',errorMessage(error));$('compare-retry').hidden=!retry;}
function syncURL(replace=false){if(!selections)return;const params=comparisonQuery(snapshots||selections,scope);history[replace?'replaceState':'pushState']({},'',params);}
function scopeLabel(){return(scope==='python'?'Python only':scope==='source'?'Python + JSON':'All text files')+(fileType?' · '+typeName(fileType==='__none'?'':fileType):'');}
function render(){
  if(!snapshots)return;
  const {totals,delta,percent,types}=summarizeComparison(snapshots,{scope,fileType});
  $('compare-empty').hidden=true;$('compare-results').hidden=false;$('repo-totals').replaceChildren();
  const maximum=Math.max(...totals.map(total=>total.lines),1);
  snapshots.forEach((snapshot,index)=>{
    const total=totals[index],card=node('article','repo-total'),heading=node('h2');
    heading.append(node('span','side-mark'+(index?' side-b':''),index?'B':'A'),anchor(snapshot.repository,'https://github.com/'+snapshot.repository,'',true));
    card.append(heading,node('p','repo-context',snapshot.ref+' · '+(snapshot.directory||'Entire repository')),node('p','repo-lines',number(total.lines)),node('p','repo-lines-label','lines · '+number(total.files)+' text files · '+scopeLabel()));
    const track=node('div','track'),bar=node('div','bar');bar.style.width=total.lines/maximum*100+'%';track.setAttribute('aria-hidden','true');track.append(bar);card.append(track);
    const revision=node('div','repo-revision');revision.append(node('span','','Counted revision'),anchor(snapshot.head.slice(0,7),'https://github.com/'+snapshot.repository+'/commit/'+snapshot.head,'number',true));card.append(revision);
    card.append(anchor('Explore files and folders →','./'+targetURL({...snapshot,ref:snapshot.head,mode:'repo'},scope),'repo-detail-link'));$('repo-totals').append(card);
  });
  set('compare-difference',signed(delta)+' lines');
  set('compare-percent',percent===null?(totals[1].lines?'Percentage unavailable: A has 0 lines.':'Both repositories have 0 lines in this scope.'):delta===0?'Same number of lines in this scope.':Math.abs(percent).toFixed(1)+'% '+(delta>0?'more':'fewer')+' lines in B than A.');
  set('compare-exclusions','Excluded before filtering: A · '+number(snapshots[0].excluded||0)+' entries; B · '+number(snapshots[1].excluded||0)+' entries. Binary / non-UTF-8 files, symlinks, and submodules.');
  set('compare-updated','Last completed comparison: '+new Date(Math.max(...snapshots.map(snapshot=>Date.parse(snapshot.checkedAt)))).toLocaleString('en-GB')+'.');
  const rows=document.createDocumentFragment();
  for(const type of types){const row=node('tr'),label=node('th','type-name',typeName(type.extension));label.scope='row';row.append(label,node('td','number',number(type.left)),node('td','number',number(type.right)),node('td','number',signed(type.right-type.left)));rows.append(row);}
  if(!types.length){const row=node('tr'),cell=node('td','load-message','No text files match this scope in either repository.');cell.colSpan=4;row.append(cell);rows.append(row);}
  $('compare-types').replaceChildren(rows);set('compare-total-a',number(totals[0].lines));set('compare-total-b',number(totals[1].lines));set('compare-total-delta',signed(delta));
  set('compare-announcement','Repository A: '+number(totals[0].lines)+' lines. Repository B: '+number(totals[1].lines)+' lines. Difference: '+signed(delta)+' lines.');
}
function setTypes(){const extensions=[...new Set(snapshots.flatMap(snapshot=>snapshot.files.map(file=>file.extension)))].sort();if(fileType&&!extensions.includes(fileType==='__none'?'':fileType))fileType='';$('compare-type').replaceChildren(new Option('All types',''),...extensions.map(extension=>new Option(typeName(extension),extension||'__none')));$('compare-type').value=fileType;}
async function start(next,{keep=false,writeURL=true}={}){
  stop();selections=next;dirty=false;hideError();const current=generation;
  if(!keep){snapshots=null;fileType='';$('compare-results').hidden=true;$('compare-empty').hidden=false;set('compare-empty','Counting both repositories. Large repositories can take a few minutes.');$('compare-type').replaceChildren(new Option('All types',''));}
  if(writeURL&&!next.some(selection=>selection.treeTail))syncURL();
  loader=new ComparisonCounter(next,{cache,onProgress(index,message){if(current===generation)set(sides[index]+'-progress',message);}});const active=loader;
  loop=new RefreshLoop({refresh:()=>active.refresh(),visible:()=>document.visibilityState==='visible',onStart(){if(current!==generation)return;hideError();busy(true);set('compare-status',snapshots?'Checking both repositories · showing the last complete comparison.':'Counting both repositories…');},onSuccess(result){if(current!==generation)return;snapshots=result;selections=result.map(snapshot=>({repository:snapshot.repository,mode:'repo',ref:snapshot.ref,directory:snapshot.directory}));sides.forEach((side,index)=>{set(side+'-progress','Count complete');$(side+'-repo').value=selections[index].repository;$(side+'-ref').value=selections[index].ref;$(side+'-path').value=selections[index].directory;});setTypes();render();busy(false);syncURL(true);set('compare-status','Up to date · checks both repositories every '+(githubAccess.state().connected?'2':'5')+' min');},onError(error,retryAt){if(current!==generation)return;busy(false);sides.forEach(side=>set(side+'-progress',''));const permanent=[400,401,404,409].includes(error.status);if(permanent)loop.stop();showError(error,true);if(error.retryAt>Date.now()){$('compare-retry').disabled=true;$('compare-refresh').disabled=true;setTimeout(()=>{if(current===generation){$('compare-retry').disabled=false;$('compare-refresh').disabled=dirty;loop?.run();}},error.retryAt-Date.now()+100);}
set('compare-status',(snapshots?'Previous comparison remains visible. ':'')+(permanent?'Edit the selection or try again.':'Retrying at '+new Date(retryAt).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})+'.'));if(!snapshots)set('compare-empty','The comparison could not finish. Check the selections above or try again.');}});
  await loop.run(true);
}
function submit(){try{const next=sides.map(side=>parseSelection($(side+'-repo').value,$(side+'-ref').value,$(side+'-path').value));start(next);}catch(error){stop();busy(false);showError(error);}}
$('compare-form').addEventListener('submit',event=>{event.preventDefault();submit();});
$('compare-form').addEventListener('input',()=>{if(!selections)return;dirty=true;stop();busy(false);hideError();sides.forEach(side=>set(side+'-progress',''));set('compare-status','Selection changed. Compare repositories to update the results.');});
$('compare-cancel').addEventListener('click',()=>{stop();busy(false);sides.forEach(side=>set(side+'-progress','Cancelled'));set('compare-status','Comparison cancelled. Refresh or compare again to resume.');if(!snapshots)set('compare-empty','Comparison cancelled. You can narrow the folders and try again.');});
function refresh(){if(dirty)return;if(!loop||loop.stopped||loader.cancelled)start(selections,{keep:true,writeURL:false});else loop.run(true);}
$('compare-refresh').addEventListener('click',refresh);$('compare-retry').addEventListener('click',refresh);
document.querySelectorAll('input[name="compare-scope"]').forEach(input=>input.addEventListener('change',()=>{scope=input.value;render();if(snapshots&&!dirty)syncURL(true);}));
$('compare-type').addEventListener('change',()=>{fileType=$('compare-type').value;render();});
function restore(){stop();snapshots=null;selections=null;fileType='';dirty=false;$('compare-type').replaceChildren(new Option('All types',''));set('compare-status','The same file filter applies to both repositories.');$('compare-results').hidden=true;$('compare-empty').hidden=false;set('compare-empty','Choose two repositories above to see their line counts side by side.');hideError();busy(false);const p=new URLSearchParams(location.search);scope=['source','python'].includes(p.get('scope'))?p.get('scope'):'all';document.querySelectorAll('input[name="compare-scope"]').forEach(input=>input.checked=input.value===scope);sides.forEach(side=>{$(side+'-repo').value=p.get(side)||'';$(side+'-ref').value=p.get(side+'Ref')||'';$(side+'-path').value=p.get(side+'Path')||'';set(side+'-progress','');});if(p.get('left')&&p.get('right')){try{start(sides.map(side=>parseSelection(p.get(side),p.get(side+'Ref')||'',p.get(side+'Path')||'')),{writeURL:false});}catch(error){showError(error);}}}
window.addEventListener('popstate',restore);document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')loop?.run();});window.addEventListener('focus',()=>loop?.run());window.addEventListener('online',()=>loop?.run(true));window.addEventListener('pagehide',event=>{if(!event.persisted)stop();});
await githubAccess.initialize();
mountGitHubAccess();
mountRepositoryLink();
window.addEventListener('github-auth-change',()=>{if(selections&&!dirty)start(selections,{keep:true,writeURL:false});});
restore();
