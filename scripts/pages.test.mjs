import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {build} from './build.mjs';

test('the Pages artifact supports a project subpath and contains only static public assets',async()=>{
 await build();const entries=await readdir(new URL('../dist/',import.meta.url));assert.ok(entries.includes('index.html'));assert.ok(entries.includes('compare.html'));assert.ok(entries.includes('.nojekyll'));assert.ok(!entries.some(name=>['server','worker','.openai','.env'].includes(name)));
 for(const name of ['index.html','compare.html']){const html=await readFile(new URL('../dist/'+name,import.meta.url),'utf8');assert.match(html,/Repometer/);for(const match of html.matchAll(/(?:src|href)="([^"#][^"]*)"/g)){const ref=match[1];if(ref.startsWith('data:')||ref.startsWith('http')||ref.startsWith('?'))continue;assert.ok(!ref.startsWith('/'),'root-relative URL breaks Pages: '+ref);const pathname=ref.split('?')[0];if(pathname==='./')continue;await readFile(new URL('../dist/'+pathname,import.meta.url));}}
 const alias=await readFile(new URL('../dist/compare/index.html',import.meta.url),'utf8');assert.match(alias,/\.\.\/route-redirect.mjs/);
});
