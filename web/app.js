import {githubAccess} from './github-access.mjs?v=13';
import {mountGitHubAccess} from './auth-ui.mjs?v=13';
import {mountRepositoryLink} from './repository-link.mjs?v=13';
import {GithubCounter, RefreshLoop} from './live-data.mjs?v=13';
import {matchesFile} from './file-filters.mjs?v=1';
import {CountProgress} from './count-progress.mjs?v=1';
import {normalizeTarget, parseTarget, targetURL, readTarget, folderTotals} from './targets.mjs?v=2';
const $=id=>document.getElementById(id),set=(id,text)=>{$(id).textContent=text;},num=n=>new Intl.NumberFormat('en-US').format(n),signed=n=>n<0?'−'+num(-n):n>0?'+'+num(n):'0';
const caches=new Map(),progress=new CountProgress($('count-progress'));
const accessReady=githubAccess.initialize();
let target=null,snapshot=null,counter=null,loop=null,searchCounter=null,generation=0,scope='all',fileType='',sort='after',fileQuery='',hideRemoved=false;
const typeNames={'.py':'Python','.json':'JSON','.md':'Markdown','.js':'JavaScript','.mjs':'JavaScript modules','.cjs':'CommonJS','.ts':'TypeScript','.tsx':'TSX','.jsx':'JSX','.rs':'Rust','.go':'Go','.c':'C','.cpp':'C++','.h':'C headers','.html':'HTML','.css':'CSS','.scss':'SCSS','.yaml':'YAML','.yml':'YAML','.toml':'TOML','.sh':'Shell','.txt':'Text','.swift':'Swift','.java':'Java','.rb':'Ruby','.ipynb':'Notebooks','.svg':'SVG'};
const typeName=ext=>typeNames[ext]||ext||'No extension';
function cacheFor(repository){const key=repository.toLowerCase();if(!caches.has(key))caches.set(key,{blobs:new Map(),trees:new Map(),revisions:new Map(),stats:new Map()});return caches.get(key);}
function element(tag,cls,text){const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;}
function link(text,href,cls){const a=element('a',cls,text);a.href=href;return a;}
function external(el,url){el.href=url;el.target='_blank';el.rel='noopener noreferrer';}
function notice(error){return error instanceof TypeError&&/fetch|network|load failed/i.test(error.message)?'Could not reach GitHub. Check your connection and try again.':error.message;}
function include(file){return matchesFile(file,{mode:target.mode,scope,fileType,query:fileQuery,hideRemoved});}
function sum(files){return files.reduce((n,f)=>({before:n.before+f.before,after:n.after+f.after}),{before:0,after:0});}
function setBusy(busy){$('comparison').setAttribute('aria-busy',String(busy));$('count-results').setAttribute('aria-busy',String(busy));$('refresh').disabled=busy;$('retry').disabled=busy;$('cancel').hidden=!busy;$('count-form').querySelector('button[type=submit]').disabled=busy;for(const id of ['file-type','file-search','sort'])$(id).disabled=busy&&!snapshot;}
function stop(){generation++;loop?.stop();counter?.abort();searchCounter?.abort();loop=null;progress.finish();setBusy(false);}
function updateMode(){const pr=$('mode').value==='pr';$('ref-field').hidden=pr;$('pr-field').hidden=!pr;$('pr-number').required=pr;}
function routeURL(t,replace=false){history[replace?'replaceState':'pushState']({},'',targetURL(t,scope,{hideRemoved}));}
function breadcrumbs(){
  const node=$('folder-crumbs');node.replaceChildren(link(target.repository,targetURL({...target,directory:''},scope,{hideRemoved})));
  let directory='';for(const part of target.directory.split('/').filter(Boolean)){directory+=(directory?'/':'')+part;node.append(element('span','','/'),link(part,targetURL({...target,directory},scope,{hideRemoved})));}
}
function prepare(){
  $('home').hidden=true;$('workspace').hidden=false;$('load-error').hidden=true;$('count-results').hidden=true;
  $('compare-nav').href='./compare.html?'+new URLSearchParams({left:target.repository,leftRef:target.mode==='repo'?target.ref:'',leftPath:target.directory,scope});
  $('mode').value=target.mode;$('ref').value=target.ref;$('folder').value=target.directory;$('pr-number').value=target.pull||'';updateMode();breadcrumbs();
  const pr=target.mode==='pr';$('workspace').classList.toggle('is-repo',!pr);$('removed-paths-filter').hidden=!pr;$('hide-removed').checked=hideRemoved;
  $('pr-bars').hidden=!pr;$('language-bars').hidden=pr;$('diff-section').hidden=!pr;$('pr-method').hidden=!pr;$('base-revision').hidden=!pr;$('pr-state').hidden=true;
  set('view-label',pr?'PULL REQUEST COMPARISON':target.directory?'FOLDER COUNTS':'REPOSITORY COUNTS');
  set('page-title',pr?'Pull request #'+target.pull:target.directory?target.directory.split('/').pop():target.repository.split('/')[1]);
  set('description',pr?target.repository:(target.directory?target.repository+' / '+target.directory:'Entire repository · default branch'));
  set('repo-link',target.repository);external($('repo-link'),'https://github.com/'+target.repository);
  set('chart-title',pr?'Before & after':'By file type');set('metric-label',pr?'Net lines removed':'Total lines');set('metric-symbol',pr?'−':'≡');
  set('after-heading',pr?'After':'Lines');set('files-heading',pr?'Where the lines changed':'File breakdown');set('table-path',target.directory||'/');
  for(const id of ['removed','reduction','before','after','total-before','total-after','total-delta','head-sha','added','deleted','changed-files','modules-before','modules-after'])set(id,'—');
  set('file-count','');set('snapshot-date','');set('reduction-description',pr?'change in this scope':'text files');set('main-scope','Counting tracked text files');set('excluded-note','');set('breakdown','');set('language-bars','');
  $('head-link').removeAttribute('href');$('folders-section').hidden=true;$('file-rows').replaceChildren();
  const tr=element('tr'),td=element('td','load-message','Loading file counts from GitHub…');td.colSpan=5;tr.append(td);$('file-rows').append(tr);
  $('file-type').replaceChildren(new Option('All types',''));$('file-search').value='';$('sort').value=sort;
  document.querySelectorAll('input[name="scope"]').forEach(x=>x.checked=x.value===scope);
  document.title=(pr?'PR #'+target.pull:target.directory||target.repository)+' · Repometer';
}
function setTypes(){
  const choices=[...new Set(snapshot.files.map(f=>f.extension))].sort((a,b)=>typeName(a).localeCompare(typeName(b)));
  $('file-type').replaceChildren(new Option('All types',''),...choices.map(ext=>new Option(typeName(ext)+(ext?' ('+ext+')':''),ext||'__none')));
  if(fileType&&!choices.includes(fileType==='__none'?'':fileType))fileType='';$('file-type').value=fileType;
}
function applySnapshot(next){
  snapshot=next;$('count-results').hidden=false;const pr=snapshot.mode==='pr';
  set('description',pr?snapshot.title:(snapshot.ref+' · '+(target.directory||'Entire repository')));
  $('ref').placeholder=snapshot.ref||'Default branch';set('head-sha',snapshot.head.slice(0,7));external($('head-link'),'https://github.com/'+snapshot.repository+'/commit/'+snapshot.head);
  set('snapshot-date',new Date(snapshot.capturedAt).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}));
  if(pr){$('pr-state').hidden=false;set('pr-state',snapshot.state[0].toUpperCase()+snapshot.state.slice(1));set('base-sha',snapshot.base.slice(0,7));set('after-sha',snapshot.head.slice(0,7));set('added','+'+num(snapshot.additions));set('deleted','−'+num(snapshot.deletions));set('changed-files',num(snapshot.changedFiles));external($('method-base'),'https://github.com/'+snapshot.repository+'/commit/'+snapshot.base);set('method-base',snapshot.base);}
  external($('method-head'),'https://github.com/'+snapshot.repository+'/commit/'+snapshot.head);set('method-head',snapshot.head);
  set('excluded-note',num(snapshot.excluded||0)+' binary / non-UTF-8 files, symlinks, or submodules excluded'+(pr?' across both revisions.':'.')+' Generated files and vendored text are included.');
  set('capture-note','Checks GitHub on load, every two minutes when connected to GitHub (five minutes otherwise) while visible, and when you return to an overdue tab. Counts are pinned to the revisions above. A new count replaces the previous result only after every included file succeeds.');
  setTypes();render();
}
function render(){
  if(!snapshot)return;
  const pr=snapshot.mode==='pr',files=snapshot.files.filter(include),{before,after}=sum(files),removed=before-after;
  set('removed',num(pr?Math.abs(removed):after));set('metric-label',pr?(removed<0?'Net lines added':removed===0?'Net line change':'Net lines removed'):'Total lines');
  set('metric-symbol',pr?(removed<0?'+':'−'):'≡');
  const afterFiles=files.filter(f=>f.status!=='removed').length,beforeFiles=files.filter(f=>f.status!=='added').length;
  set('reduction',pr?(before?(removed>0?'−':removed<0?'+':'')+(Math.abs(removed)/before*100).toFixed(1)+'%':after?'New content':'0%'):num(afterFiles));
  set('reduction-description',pr?(removed>0?'fewer lines in this scope':removed<0?'more lines in this scope':'no net change'):'text files in this scope');
  set('main-scope',(scope==='source'?'Python + JSON':scope==='python'?'Python files':'All text files')+(fileType?' · '+typeName(fileType==='__none'?'':fileType):'')+(fileQuery?' · matching “'+fileQuery+'”':'')+(pr&&hideRemoved?' · Removed paths hidden':''));
  set('before',num(before));set('after',num(after));set('modules-before',num(beforeFiles));set('modules-after',num(afterFiles));
  $('before-bar').style.width=before/Math.max(before,after,1)*100+'%';$('after-bar').style.width=after/Math.max(before,after,1)*100+'%';
  const types=new Map();for(const f of files)types.set(f.extension,(types.get(f.extension)||0)+f.after);
  const sortedTypes=[...types.entries()].sort((a,b)=>b[1]-a[1]);
  $('breakdown').replaceChildren();$('language-bars').replaceChildren();
  if(pr){for(const [ext,count] of sortedTypes.slice(0,4)){const item=element('span');item.append(element('strong','',num(count)),' '+typeName(ext));$('breakdown').append(item);}}
  else{
    const chart=sortedTypes.slice(0,5);if(sortedTypes.length>5)chart.push(['Other',sortedTypes.slice(5).reduce((n,x)=>n+x[1],0)]);
    for(const [ext,count] of chart){const row=element('div','language-row'),track=element('div','track'),bar=element('div','bar');bar.style.width=count/Math.max(after,1)*100+'%';track.append(bar);row.append(element('span','',ext==='Other'?'Other':typeName(ext)),track,element('strong','',num(count)));$('language-bars').append(row);}
    if(!chart.length)$('language-bars').append(element('p','table-note','No text files match this scope.'));
  }
  const folders=folderTotals(files,target.directory);$('folders-section').hidden=!folders.length;$('folder-list').replaceChildren();
  for(const folder of folders){const a=link('',targetURL({...target,directory:folder.path},scope,{hideRemoved}),'folder-card');a.append(element('span','','▱ '+folder.name),element('span','',num(folder.after)+' lines'));$('folder-list').append(a);}
  files.sort((a,b)=>sort==='name'?a.path.localeCompare(b.path):sort==='change'?Math.abs(b.delta)-Math.abs(a.delta)||a.path.localeCompare(b.path):b.after-a.after||a.path.localeCompare(b.path));
  const rows=document.createDocumentFragment(),maximum=files.reduce((max,f)=>Math.max(max,pr?Math.abs(f.delta):f.after),1);
  for(const f of files){
    const tr=element('tr'),name=element('td'),a=link(f.path.slice(target.directory?target.directory.length+1:0),'','file-name');
    external(a,'https://github.com/'+snapshot.repository+'/blob/'+(f.status==='removed'?snapshot.base:snapshot.head)+'/'+f.path.split('/').map(encodeURIComponent).join('/'));name.append(a);
    if(pr&&['added','removed'].includes(f.status))name.append(element('span','file-status',f.status==='added'?'new path':'removed path'));tr.append(name);
    tr.append(element('td','number pr-column',num(f.before)),element('td','number',num(f.after)),element('td','number pr-column '+(f.delta<0?'delta-down':f.delta>0?'delta-up':'zero'),signed(f.delta)));
    const visual=element('td','visual-column'),track=element('div','delta-track'),line=element('div','delta-line'+(pr&&f.delta>0?' increase':'')),value=pr?Math.abs(f.delta):f.after;line.style.width=(value?Math.max(3,value/maximum*58):0)+'px';line.style.minWidth='0';track.append(line);visual.setAttribute('aria-hidden','true');visual.append(track);tr.append(visual);rows.append(tr);
  }
  if(!files.length){const tr=element('tr'),td=element('td','load-message','No text files match the selected scope.');td.colSpan=5;tr.append(td);rows.append(tr);}
  $('file-rows').replaceChildren(rows);set('total-before',num(before));set('total-after',num(after));set('total-delta',signed(after-before));set('total-label',fileQuery?'Total matching paths':'Total in selected scope');
  set('file-count','· '+num(afterFiles)+' files'+(pr?' after · '+num(files.length)+' paths compared':''));
  set('table-note',pr?(hideRemoved?'Removed paths are hidden. Displayed totals cover the remaining paths. ':'')+'Counts follow file paths. Renamed or consolidated files may appear as a removed path and an added path.':'Includes every tracked text file below this path. Counts include nested folders.');
  set('count-announcement',pr?`${num(before)} lines before, ${num(after)} after. Net change ${signed(after-before)}.`:`${num(after)} lines across ${num(afterFiles)} text files.`);
  return {repository:target.repository,mode:target.mode,directory:target.directory,scope,hideRemoved:pr&&hideRemoved,before:pr?before:null,after,files:afterFiles,head:snapshot.head};
}
async function openTarget(input,{replace=false,writeURL=true}={}){
  let next;try{next=normalizeTarget(input);}catch(error){showFormError(error);return;}
  stop();target=next;if(target.mode!=='pr')hideRemoved=false;snapshot=null;fileType='';fileQuery='';sort=target.mode==='pr'?'change':'after';const id=generation;
  if(writeURL)routeURL(target,replace);prepare();setBusy(true);progress.begin();set('sync-status','Connecting to GitHub…');
  await accessReady;if(id!==generation)return;
  let progressStage='';
  counter=new GithubCounter({...target,cache:cacheFor(target.repository),onProgress:(message,detail)=>{
    if(id!==generation)return;progress.update(detail);
    const stage=detail.phase+':'+(detail.label||'');
    if(stage!==progressStage){progressStage=stage;set('sync-status',message.split(' · ')[0]+(snapshot?' · Showing last complete results':''));}
  }});const active=counter;
  if(target.repository.toLowerCase()==='blaizzy/mlx-vlm'&&target.mode==='pr'&&target.pull===2276&&target.directory==='mlx_vlm/tests'){
    try{const response=await fetch('./data.json');if(response.ok){const saved=await response.json();if(id!==generation)return;active.seed(saved);applySnapshot({...saved,mode:'pr',repository:target.repository,directory:target.directory});}}catch{}
  }
  if(id!==generation)return;
  loop=new RefreshLoop({refresh:()=>active.refresh(snapshot),visible:()=>document.visibilityState==='visible',onStart(){if(id!==generation)return;setBusy(true);progress.begin({hasSnapshot:!!snapshot});progressStage='';$('load-error').hidden=true;set('sync-status','Checking GitHub…');},onSuccess(next){if(id!==generation)return;applySnapshot(next);setBusy(false);progress.finish();set('sync-status','Up to date · Last checked '+new Date(next.checkedAt).toLocaleTimeString('en-GB')+' · Checks every '+(githubAccess.state().connected?'2':'5')+' min');},onError(error,retryAt){if(id!==generation)return;setBusy(false);progress.stop(error.name==='AbortError'?'cancelled':'error');if(error.name==='AbortError'){set('sync-status','Count cancelled. Change the folder or refresh to resume.');return;}$('load-error').hidden=false;set('sync-status',snapshot?'Update failed · Previous counts remain visible':'Counts unavailable');const permanent=[400,401,404,409].includes(error.status);if(permanent)loop.stop();if(error.retryAt>Date.now()){$('retry').disabled=true;$('refresh').disabled=true;setTimeout(()=>{if(id===generation){$('retry').disabled=false;$('refresh').disabled=false;loop?.run();}},error.retryAt-Date.now()+100);}
set('error-message',notice(error)+(permanent?'':' Retrying at '+new Date(retryAt).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})+'.'));if(!snapshot){const tr=element('tr'),td=element('td','load-message','No counts loaded. Check the repository, branch, or folder and try again.');td.colSpan=5;tr.append(td);$('file-rows').replaceChildren(tr);}}});
  await loop.run(true);
}
function showFormError(error){$('load-error').hidden=false;set('error-message',notice(error));}
function home({writeURL=true}={}){$('compare-nav').href='./compare.html';stop();target=null;snapshot=null;hideRemoved=false;$('home').hidden=false;$('workspace').hidden=true;document.title='Repometer · GitHub repositories, folders & pull requests';if(writeURL)history.pushState({},'','./');}
async function search(value,{writeURL=true}={}){
  home({writeURL:false});const id=generation;
  if(writeURL)history.pushState({},'','?'+new URLSearchParams({q:value}));
  $('query').value=value;$('search-feedback').hidden=false;set('search-feedback','Searching GitHub…');$('search-results').hidden=true;$('search-button').disabled=true;
  searchCounter=new GithubCounter({mode:'repo',directory:''});
  try{
    await accessReady;if(id!==generation)return;
    let direct=parseTarget(value);
    if(direct){if(direct.treeTail){searchCounter=new GithubCounter({...direct,directory:''});const resolved=await searchCounter.resolveTreeTail(direct.treeTail);direct={...direct,...resolved};}if(id!==generation)return;scope='all';await openTarget(direct,{replace:true});return;}
    const results=await searchCounter.searchRepositories(value);if(id!==generation)return;
    set('search-feedback',results.length?'Select a repository to count its files.':'No public repositories found. Try owner/repo or a different name.');$('search-results').hidden=false;$('search-results').replaceChildren();
    for(const repo of results){const row=element('article','repo-result'),body=element('div');body.append(element('h2','',repo.full_name),element('p','',repo.description||'No description'),element('small','',(repo.language||'Mixed file types')+' · '+num(repo.stargazers_count)+' stars'));row.append(body,link('Count repo ↗',targetURL({repository:repo.full_name,mode:'repo'})));$('search-results').append(row);}
  }catch(error){if(id===generation)set('search-feedback',notice(error));}finally{$('search-button').disabled=false;}
}
$('search-form').addEventListener('submit',event=>{event.preventDefault();const value=$('query').value.trim();if(value)search(value);});
$('mode').addEventListener('change',updateMode);
$('count-form').addEventListener('submit',event=>{event.preventDefault();openTarget({repository:target.repository,mode:$('mode').value,pull:$('pr-number').value,ref:$('ref').value,directory:$('folder').value});});
$('refresh').addEventListener('click',()=>{if(!loop||loop.stopped||counter.cancelled)openTarget(target,{replace:true});else loop.run(true);});
$('retry').addEventListener('click',()=>{if(!loop||loop.stopped||counter.cancelled)openTarget(target,{replace:true});else loop.run(true);});
$('cancel').addEventListener('click',()=>{generation++;loop?.stop();counter?.abort();progress.stop('cancelled');setBusy(false);set('sync-status','Count cancelled. Change the folder or refresh to resume.');});
document.querySelectorAll('input[name="scope"]').forEach(input=>input.addEventListener('change',()=>{scope=input.value;render();if(target)routeURL(target,true);}));
$('hide-removed').addEventListener('change',()=>{hideRemoved=$('hide-removed').checked;render();if(target){routeURL(target,true);breadcrumbs();}});
$('file-type').addEventListener('change',()=>{fileType=$('file-type').value;render();});$('sort').addEventListener('change',()=>{sort=$('sort').value;render();});$('file-search').addEventListener('input',()=>{fileQuery=$('file-search').value;render();});
document.addEventListener('click',event=>{const a=event.target.closest('a');if(!a||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;const href=a.getAttribute('href');if(href==='./'){event.preventDefault();home();}else if(href?.startsWith('?repo=')){event.preventDefault();const p=new URLSearchParams(href);scope=p.get('scope')||'all';hideRemoved=p.get('hideRemoved')==='1';try{openTarget(readTarget(href));}catch(error){showFormError(error);}}});
function restore(){const p=new URLSearchParams(location.search);scope=['all','source','python'].includes(p.get('scope'))?p.get('scope'):'all';hideRemoved=p.get('hideRemoved')==='1';try{const t=readTarget(location.search);if(t)openTarget(t,{writeURL:false});else if(p.get('q'))search(p.get('q'),{writeURL:false});else home({writeURL:false});}catch(error){home({writeURL:false});$('search-feedback').hidden=false;set('search-feedback',notice(error));}}
window.addEventListener('popstate',restore);document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')loop?.run();});window.addEventListener('focus',()=>loop?.run());window.addEventListener('online',()=>loop?.run(true));window.addEventListener('pagehide',event=>{if(!event.persisted)stop();});
restore();
await accessReady;
mountGitHubAccess();
mountRepositoryLink();
window.addEventListener('github-auth-change',()=>{if(target)openTarget(target,{replace:true});else if(new URLSearchParams(location.search).get('q'))search($('query').value,{writeURL:false});});
if(document.modelContext?.registerTool){const lifecycle=new AbortController();for(const tool of [{name:'open_github_counts',title:'Open repository or PR counts',description:'Open line counts for a public GitHub repository, optional folder, or pull request using the visible workspace.',inputSchema:{type:'object',properties:{repository:{type:'string'},mode:{type:'string',enum:['repo','pr']},pull:{type:'integer'},directory:{type:'string'},ref:{type:'string'}},required:['repository','mode'],additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:true},async execute(input){const normalized=normalizeTarget(input);await openTarget(normalized);if(!snapshot)throw new Error($('error-message').textContent||'Count did not finish.');return render();}},{name:'set_line_count_scope',title:'Filter line counts',description:'Choose all text files, Python and JSON, or Python only in the visible count.',inputSchema:{type:'object',properties:{scope:{type:'string',enum:['all','source','python']}},required:['scope'],additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute(input){if(!input||!['all','source','python'].includes(input.scope)||Object.keys(input).length!==1)throw new Error('Scope must be all, source, or python.');if(!snapshot)throw new Error('Open a repository or pull request first.');scope=input.scope;document.querySelectorAll('input[name="scope"]').forEach(x=>x.checked=x.value===scope);routeURL(target,true);return render();}}]){try{Promise.resolve(document.modelContext.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});}catch{}}window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});}
