export function matchesFile(file,{scope='all',fileType='',query=''}={}){
  return (scope==='all'||file.extension==='.py'||(scope==='source'&&file.extension==='.json'))
    &&(!fileType||file.extension===(fileType==='__none'?'':fileType))
    &&file.path.toLowerCase().includes(query.toLowerCase());
}

export function filterFileRows(files,{mode='repo',hideRemoved=false}={}){
  return mode==='pr'&&hideRemoved?files.filter(file=>file.status!=='removed'):files;
}
