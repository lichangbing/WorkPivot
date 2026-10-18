import {cp,mkdir,readFile,writeFile,access} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
const root=resolve(import.meta.dirname,'../..'),code=join(root,'code');
const [image,output]=process.argv.slice(2);
if(!image||!/^workpivot-server:[a-z0-9][a-z0-9.-]+$/.test(image)||!output)throw Error('用法：node code/scripts/build-local-release.mjs workpivot-server:<版本> <新构建目录>');
const target=resolve(output);
try{await access(target);throw Error('构建目录已存在，请提供新目录');}catch(e){if(e.code!=='ENOENT')throw e;}
execFileSync('pnpm',['--filter','@workpivot/web','build'],{cwd:code,stdio:'inherit'});
await mkdir(target,{recursive:true});
// 保留pnpm相对链接，仅复制固定运行目录，绝不复制仓库根目录或本地凭据。
for(const path of ['node_modules','scripts','package.json','apps/web/dist'])await cp(join(code,path),join(target,path),{recursive:true,verbatimSymlinks:true});
for(const pkg of ['server','core','shared'])for(const path of ['src','node_modules','package.json']){const source=join(code,'packages',pkg,path);try{await access(source);}catch(e){if(path==='node_modules'&&e.code==='ENOENT')continue;throw e;}await cp(source,join(target,'packages',pkg,path),{recursive:true,verbatimSymlinks:true});}
await cp(join(code,'packages/server/skills'),join(target,'packages/server/skills'),{recursive:true});
const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
await writeFile(join(target,'release.json'),JSON.stringify({commit,image,builtAt:new Date().toISOString(),source:'working-tree'},null,2));
const dockerfile=(await readFile(join(root,'releases/deploy/Dockerfile.local-current'),'utf8')).replace('USER node\nCMD','COPY release.json /app/release.json\nUSER node\nCMD');
await writeFile(join(target,'Dockerfile'),dockerfile);
execFileSync('docker',['build','-t',image,target],{stdio:'inherit'});
console.log('发布镜像已构建：'+image);
