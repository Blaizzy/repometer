import {mkdir,readdir,copyFile,rm,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url),source=new URL('web/',root),output=new URL('dist/',root);
export async function build({authOrigin=process.env.AUTH_ORIGIN||'',requireAuthOrigin=false}={}){
  authOrigin=authOrigin.trim();
  if(!authOrigin&&requireAuthOrigin)throw Error('AUTH_ORIGIN is required for deployment. Configure the GitHub Actions repository secret.');
  if(authOrigin){
    let url;try{url=new URL(authOrigin);}catch{throw Error('AUTH_ORIGIN must be an HTTPS origin.');}
    if(url.protocol!=='https:'||!url.hostname||url.username||url.password||!['/',''].includes(url.pathname)||url.search||url.hash)throw Error('AUTH_ORIGIN must be an HTTPS origin without credentials, a path, query, or fragment.');
    authOrigin=url.origin;
  }
  await rm(output,{recursive:true,force:true});await mkdir(output,{recursive:true});
  let count=0;
  for(const entry of await readdir(source,{withFileTypes:true})){
    if(!entry.isFile()||!/^[-a-z0-9]+\.(html|css|js|mjs|json)$/.test(entry.name))throw Error('Unexpected public asset: '+entry.name);
    await copyFile(new URL(entry.name,source),new URL(entry.name,output));count++;
  }
  await writeFile(new URL('site-config.mjs',output),'export const siteConfig=Object.freeze('+JSON.stringify({authOrigin})+');\n');
  await writeFile(new URL('.nojekyll',output),'');
  await mkdir(new URL('compare/',output));
  await writeFile(new URL('compare/index.html',output),'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Compare repositories · Repometer</title><script type="module" src="../route-redirect.mjs"></script><a href="../compare.html">Open repository comparison</a></html>');
  return count;
}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log('Built '+await build({requireAuthOrigin:process.argv.includes('--require-auth-origin')})+' public files for GitHub Pages.');
