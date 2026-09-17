const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export function normalizeTarget(input) {
  const repository=String(input.repository || '').replace(/\.git$/,'');
  if (!REPO.test(repository) || repository.split('/').some(part=>part==='.'||part==='..')) throw new Error('Enter a repository as owner/repo.');
  const directory=String(input.directory || '').trim().replace(/^\/+|\/+$/g,'');
  if (directory.split('/').some(part=>part==='.'||part==='..') || /[\0\\]/.test(directory)) throw new Error('Enter a folder path relative to the repository.');
  const mode=input.mode==='pr'?'pr':'repo';
  const pull=mode==='pr'?Number(input.pull):null;
  if (mode==='pr' && (!Number.isSafeInteger(pull)||pull<1)) throw new Error('Enter a valid pull request number.');
  return {repository, mode, pull, directory, ref:mode==='repo'?String(input.ref || '').trim():''};
}
export function parseTarget(value) {
  let text=value.trim(), parts;
  if (/^(https?:\/\/|github\.com\/)/i.test(text)) {
    const url=new URL(/^https?:/i.test(text)?text:'https://'+text);
    if (url.hostname!=='github.com' || url.username || url.password) throw new Error('Use a public github.com repository or pull request URL.');
    parts=url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } else if (/^[^\s/]+\/[^\s/]+(?:\/pull\/\d+)?\/?$/.test(text)) parts=text.split('/').filter(Boolean);
  else return null;
  if (parts.length<2) throw new Error('Include both the repository owner and name.');
  const target={repository:parts[0]+'/'+parts[1],mode:parts[2]==='pull'?'pr':'repo',pull:parts[3]};
  if (parts[2]==='tree') {
    if (!parts[3]) throw new Error('The folder URL is missing a branch or commit.');
    return {...normalizeTarget(target),treeTail:parts.slice(3).join('/')};
  }
  if (parts.length>2 && !['pull',''].includes(parts[2])) throw new Error('Use a repository, /tree/ folder, or /pull/ URL.');
  return normalizeTarget(target);
}
export function targetURL(target, scope='all', {hideRemoved=false}={}) {
  const t=normalizeTarget(target), p=new URLSearchParams({repo:t.repository,mode:t.mode});
  if(t.pull)p.set('pr',t.pull);if(t.ref)p.set('ref',t.ref);if(t.directory)p.set('path',t.directory);if(scope!=='all')p.set('scope',scope);
  if(t.mode==='pr'&&hideRemoved)p.set('hideRemoved','1');
  return '?'+p.toString();
}
export function readTarget(search) {
  const p=new URLSearchParams(search);
  if(!p.has('repo'))return null;
  return normalizeTarget({repository:p.get('repo'),mode:p.get('mode'),pull:p.get('pr'),ref:p.get('ref'),directory:p.get('path')});
}
export function extension(path) {const name=path.split('/').pop();return name.lastIndexOf('.')>0?'.'+name.split('.').pop().toLowerCase():'';}
export function folderTotals(files, directory='') {
  const groups=new Map(),prefix=directory?directory+'/':'';
  for(const file of files) {
    const relative=file.path.slice(prefix.length), slash=relative.indexOf('/');
    if(slash<0)continue;
    const name=relative.slice(0,slash),row=groups.get(name)||{name,path:prefix+name,before:0,after:0,files:0};
    row.before+=file.before;row.after+=file.after;row.files++;groups.set(name,row);
  }
  return [...groups.values()].sort((a,b)=>b.after-a.after||a.name.localeCompare(b.name));
}
