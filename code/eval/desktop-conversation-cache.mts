import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,writeFileSync,readFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConversationCache,type CachedConversation} from '../apps/desktop/src/conversation-cache.js';
const root=mkdtempSync(join(tmpdir(),'wp-chat-cache-'));
const snapshot:CachedConversation={events:[{id:'e1',sequence:'1',turnId:'turn1',runId:'run1',kind:'user',content:'合成会话',truncated:false,attachments:[{id:'version1',name:'报告.docx'}]}],older:null,details:{},sequence:'1',savedAt:''};
try{
 const cache=new ConversationCache(root),one=cache.bind('http://server-a','token-a','account-a',['task-a']),two=cache.bind('http://server-a','token-b','account-b',['task-a']),three=cache.bind('http://server-b','token-c','account-a',['task-a']);
 const lease=cache.read(one,'task-a');assert.equal(lease.snapshot,null);cache.write(one,'task-a',lease.epoch,snapshot);
 assert.equal(cache.read(one,'task-a').snapshot?.events[0]?.content,'合成会话');
 assert.equal(cache.read(two,'task-a').snapshot,null);assert.equal(cache.read(three,'task-a').snapshot,null);
 assert.throws(()=>cache.read(one,'../escape'));assert.throws(()=>cache.read(one,'task-not-owned'));assert.throws(()=>cache.check(one,'http://server-b'));assert.throws(()=>cache.check(one,'http://server-a','wrong-token'));
 const folder=readdirSync(root).find(name=>readdirSync(join(root,name)).some(file=>file.endsWith('.json')))!;
 const file=join(root,folder,readdirSync(join(root,folder)).find(name=>name.endsWith('.json'))!);
 assert.equal(statSync(file).mode&0o777,0o600);assert.equal(readFileSync(file,'utf8').includes('token-a'),false);
 const reopened=new ConversationCache(root),next=reopened.bind('http://server-a','new-token','account-a',['task-a']);assert.equal(reopened.read(next,'task-a').snapshot?.events.length,1);
 assert.throws(()=>cache.write(one,'task-a',lease.epoch,{...snapshot,events:[{...snapshot.events[0]!,content:'x'.repeat(200001)}]}));
 const same=cache.bind('http://server-a','token-another','account-a',['task-a']),sameLease=cache.read(same,'task-a');
 cache.reconcile(one,[]);assert.throws(()=>cache.write(same,'task-a',sameLease.epoch,snapshot));assert.equal(cache.status(one).tasks,0);assert.throws(()=>cache.write(one,'task-a',lease.epoch,snapshot));
 cache.reconcile(one,['task-a']);const nextLease=cache.read(one,'task-a');cache.write(one,'task-a',nextLease.epoch,snapshot);
 cache.clear(one);assert.equal(cache.status(one).tasks,0);assert.throws(()=>cache.write(one,'task-a',nextLease.epoch,snapshot));assert.ok(cache.status(one).audit.some((row:{action:string})=>row.action==='用户清空本地副本'));
 const fresh=cache.read(one,'task-a');cache.write(one,'task-a',fresh.epoch,snapshot);writeFileSync(file,'broken');assert.throws(()=>cache.read(one,'task-a'),/损坏/);assert.equal(cache.read(one,'task-a').snapshot,null);
 const rollbackLease=cache.read(one,'task-a');cache.write(one,'task-a',rollbackLease.epoch,{...snapshot,sequence:'2'});cache.discard(one,'task-a');const reset=cache.read(one,'task-a');cache.write(one,'task-a',reset.epoch,snapshot);assert.equal(cache.read(one,'task-a').snapshot?.sequence,'1');
 cache.lock();assert.throws(()=>cache.read(one,'task-a'));assert.equal(cache.find('http://server-a','token-a'),undefined);
 console.log('本地会话存储通过：持久化、账号/服务器隔离、权限、格式/大小、损坏恢复、删除、清理租约、注销与审计');
}finally{rmSync(root,{recursive:true,force:true});}
