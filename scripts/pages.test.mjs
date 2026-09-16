import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {build} from './build.mjs';

test('the Pages artifact supports a project subpath and contains only static public assets',async()=>{
 await build({authOrigin:''});const entries=await readdir(new URL('../dist/',import.meta.url));assert.ok(entries.includes('index.html'));assert.ok(entries.includes('compare.html'));assert.ok(entries.includes('.nojekyll'));assert.ok(!entries.some(name=>['server','worker','.openai','.env'].includes(name)));
 for(const name of ['index.html','compare.html']){const html=await readFile(new URL('../dist/'+name,import.meta.url),'utf8');assert.match(html,/Repometer/);for(const match of html.matchAll(/(?:src|href)="([^"#][^"]*)"/g)){const ref=match[1];if(ref.startsWith('data:')||ref.startsWith('http')||ref.startsWith('?'))continue;assert.ok(!ref.startsWith('/'),'root-relative URL breaks Pages: '+ref);const pathname=ref.split('?')[0];if(pathname==='./')continue;await readFile(new URL('../dist/'+pathname,import.meta.url));}}
 const alias=await readFile(new URL('../dist/compare/index.html',import.meta.url),'utf8');assert.match(alias,/\.\.\/route-redirect.mjs/);
});

async function builtConfig(){
 const source=await readFile(new URL('../dist/site-config.mjs',import.meta.url),'utf8');
 return (await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))).siteConfig;
}

test('deployment injects the configured origin only into the generated site',async()=>{
 const sourceURL=new URL('../web/site-config.mjs',import.meta.url),before=await readFile(sourceURL,'utf8');
 await build({authOrigin:'https://auth.example/',requireAuthOrigin:true});
 assert.deepEqual(await builtConfig(),{authOrigin:'https://auth.example'});
 assert.equal(await readFile(sourceURL,'utf8'),before);
 await build({authOrigin:''});
 assert.deepEqual(await builtConfig(),{authOrigin:''});
});

test('deployment rejects missing or invalid endpoint configuration before replacing the artifact',async()=>{
 await build({authOrigin:'https://auth.example',requireAuthOrigin:true});
 await assert.rejects(build({authOrigin:' ',requireAuthOrigin:true}),/AUTH_ORIGIN is required/);
 for(const authOrigin of ['not a URL','http://auth.example','https://user:password@auth.example','https://auth.example/api','https://auth.example/?token=example','https://auth.example/#fragment',"https://auth.example/';alert(1)//"]){
  await assert.rejects(build({authOrigin,requireAuthOrigin:true}),/AUTH_ORIGIN must be an HTTPS origin/);
 }
 assert.deepEqual(await builtConfig(),{authOrigin:'https://auth.example'});
});
