export function matchesFile(file,{mode='repo',scope='all',fileType='',query='',hideRemoved=false}={}){
  if(mode==='pr'&&hideRemoved&&file.status==='removed')return false;
  return (scope==='all'||file.extension==='.py'||(scope==='source'&&file.extension==='.json'))
    &&(!fileType||file.extension===(fileType==='__none'?'':fileType))
    &&file.path.toLowerCase().includes(query.toLowerCase());
}
