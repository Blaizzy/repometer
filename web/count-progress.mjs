const number=value=>new Intl.NumberFormat('en-US').format(value);

export function progressView(progress={},elapsed=0){
  const complete=progress.phase==='complete',counting=progress.phase==='counting'||complete,total=progress.total||0,completed=progress.completed||0;
  const percent=complete?100:counting&&total>0?Math.min(100,Math.floor(completed/total*100)):null;
  const seconds=Math.max(0,Math.floor(elapsed/1000)),minutes=Math.floor(seconds/60);
  return {
    title:complete?'Count complete':progress.phase==='listing'?'Finding files':counting?(progress.label==='base'?'Counting the base revision':progress.label==='head'?'Counting the PR head':'Counting your files'):'Connecting to GitHub',
    description:complete?'All tracked files in this selection have been checked.':progress.phase==='listing'?'Finding every tracked file in this folder and its subfolders.':counting?'Reading file contents and counting physical lines.':'Checking the repository and resolving the selected revision.',
    stage:complete?3:counting?2:progress.phase==='listing'?1:0,
    percent,percentLabel:percent===null?'Preparing…':percent+'%',
    files:counting?number(completed)+' / '+number(total):'—',
    lines:counting?number(progress.lines||0):'—',
    elapsed:minutes?minutes+'m '+String(seconds%60).padStart(2,'0')+'s':seconds+'s',
    detail:counting?number(progress.textFiles||0)+' text files · '+number(progress.excluded||0)+' excluded':'File totals appear as soon as the scan finishes.',
    path:progress.path||'',
    progressLabel:counting?number(completed)+' of '+number(total)+' files checked':'Finding the file count'
  };
}

export class CountProgress {
  constructor(root){
    this.root=root;this.active=false;this.frame=null;this.timer=null;
    this.fields=Object.fromEntries([...root.querySelectorAll('[data-count]')].map(node=>[node.dataset.count,node]));
    this.steps=[...root.querySelectorAll('[data-step]')];
  }
  begin({hasSnapshot=false}={}){
    const started=this.active?this.started:Date.now();
    this.finish();this.active=true;this.hasSnapshot=hasSnapshot;this.started=started;this.value={phase:'checking'};
    this.root.hidden=false;this.root.dataset.state='running';this.root.classList.toggle('is-refresh',hasSnapshot);
    this.fields.note.textContent=hasSnapshot?'Your last complete results stay visible until this update finishes.':'Large repositories can take a few minutes. File filters apply to the completed results.';
    this.render();this.timer=setInterval(()=>this.render(),1000);
  }
  update(value){
    if(!this.active||!value)return;
    this.value=value;
    if(this.frame===null)this.frame=requestAnimationFrame(()=>{this.frame=null;this.render();});
  }
  complete(value,{note='This count is complete.'}={}){
    if(!this.active)return;
    this.value={...value,phase:'complete',path:''};this.render();this.clear();
    this.root.dataset.state='complete';this.fields.note.textContent=note;
  }
  render(){
    if(!this.active)return;
    const view=progressView(this.value,Date.now()-this.started);
    for(const key of ['title','description','files','lines','elapsed','detail','path'])this.fields[key].textContent=view[key];
    this.fields.percent.textContent=view.percentLabel;
    this.fields.path.title=view.path;this.fields.current.hidden=!view.path;
    this.fields.bar.hidden=false;
    if(view.percent===null)this.fields.bar.removeAttribute('value');else this.fields.bar.value=view.percent;
    this.fields.bar.setAttribute('aria-valuetext',view.progressLabel);
    for(const [index,step] of this.steps.entries()){
      step.classList.toggle('is-active',index===view.stage);step.classList.toggle('is-done',index<view.stage);
      if(index===view.stage)step.setAttribute('aria-current','step');else step.removeAttribute('aria-current');
    }
  }
  stop(state='cancelled'){
    if(!this.active)return;
    this.render();this.clear();
    if(this.hasSnapshot){this.root.hidden=true;return;}
    this.root.dataset.state=state;
    this.fields.title.textContent=state==='cancelled'?'Count cancelled':'Count paused';
    this.fields.description.textContent=state==='cancelled'?'Refresh to start again, or choose a smaller folder.':'The count could not finish. Check the message above before trying again.';
    this.fields.percent.textContent=state==='cancelled'?'Cancelled':'Paused';
    this.fields.bar.hidden=true;
    this.fields.note.textContent='These partial counts are not a completed result.';
  }
  clear(){this.active=false;clearInterval(this.timer);cancelAnimationFrame(this.frame);this.timer=null;this.frame=null;}
  finish(){this.clear();this.root.hidden=true;}
}
