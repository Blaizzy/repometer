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

test('shared links expose a complete preview image in HTML without running JavaScript',async()=>{
 await build({authOrigin:''});
 for(const file of ['index.html','compare.html','compare/index.html']){
  const html=await readFile(new URL('../dist/'+file,import.meta.url),'utf8');
  const head=html.match(/<head>([\s\S]*?)<\/head>/)[1];
  const metadata=new Map([...head.matchAll(/<meta (?:property|name)="([^"]+)" content="([^"]*)">/g)].map(match=>[match[1],match[2]]));
  for(const key of ['og:title','og:description','og:image:alt','twitter:image:alt'])assert.ok(metadata.get(key),file+' is missing '+key);
  assert.equal(metadata.get('og:type'),'website');
  assert.equal(metadata.get('twitter:card'),'summary_large_image');
  assert.equal(metadata.get('twitter:title'),metadata.get('og:title'));
  assert.equal(metadata.get('twitter:image'),metadata.get('og:image'));
  const imageURL=new URL(metadata.get('og:image'));
  assert.equal(imageURL.origin,'https://blaizzy.github.io');
  assert.equal(imageURL.pathname,'/repometer/social-preview.png');
  const png=await readFile(new URL('../dist/social-preview.png',import.meta.url));
  assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.equal(png.toString('ascii',12,16),'IHDR');
  assert.equal(metadata.get('og:image:type'),'image/png');
  assert.equal(png.readUInt32BE(16),Number(metadata.get('og:image:width')));
  assert.equal(png.readUInt32BE(20),Number(metadata.get('og:image:height')));
  assert.ok(png.length<1_000_000,'Preview image should stay small enough for sharing apps');
 }
});
