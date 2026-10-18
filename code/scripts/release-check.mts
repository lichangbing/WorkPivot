import {readdir,lstat,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {inspectDatabase} from './backup-database.mjs';
import type {BackupEntry} from './backup-lib.mjs';
/** 切换前只读校验：迁移校验和、受限角色、RLS及全部在线/回收站原件。 */
try{
 const root='/data/files',files:BackupEntry[]=[];
 async function walk(dir:string){for(const n of await readdir(dir)){const path=join(dir,n),stat=await lstat(path);if(stat.isSymbolicLink())throw Error('不允许链接');if(stat.isDirectory())await walk(path);else if(stat.isFile()){const data=await readFile(path);files.push({path:path.slice(root.length+1),bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});}else throw Error('不支持特殊文件');}}
 await walk(root);const state=await inspectDatabase(process.env.WORKPIVOT_DATABASE_ADMIN_URL!,files);console.log(JSON.stringify({schema:state.schemaVersion,verifiedFiles:files.length}));
}catch{console.error('发布校验失败：请核对schema、数据库权限或文件原件，底层信息未回显');process.exitCode=1;}
