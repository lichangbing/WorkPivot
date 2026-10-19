import assert from 'node:assert/strict';
import {responseContent} from '../packages/server/src/web/content.js';
import {validatedFeed} from '../packages/server/src/web/feed.js';
let checks=0;function check(name:string,run:()=>void){run();checks++;console.log('PASS',name);}
const parse=(body:string,type='application/rss+xml')=>responseContent({url:'https://fixture.example/feed',status:200,headers:{'content-type':type},body:Buffer.from(body)});
const rss=(items:string)=>`<?xml version="1.0"?><rss version="2.0"><channel><title>合成订阅</title>${items}</channel></rss>`;
check('RSS标题标识日期HTML摘要和相对链接按条目关联',()=>{const result=parse(rss('<item><guid isPermaLink="false">id-1</guid><title>公告</title><pubDate>原始日期</pubDate><link>/article</link><description><![CDATA[<p>正文 &amp; 信息</p><script>不能执行</script>]]></description></item>'));assert.deepEqual(result.feed?.entries[0],{id:'id-1',title:'公告',published:'原始日期',url:'https://fixture.example/article',summary:'正文 & 信息'});assert(!result.text.includes('不能执行'));assert.equal(result.feed?.totalEntries,1);validatedFeed(result.feed);});
check('Atom命名空间、xml:base、备用链接、文本与XHTML',()=>{const result=parse('<a:feed xmlns:a="http://www.w3.org/2005/Atom" xml:base="https://fixture.example/news/"><a:title>Atom</a:title><a:entry><a:id>urn:1</a:id><a:title type="text">保留 &lt;文字&gt;</a:title><a:updated>2026-10-18T00:00:00Z</a:updated><a:link rel="self" href="skip"/><a:link href="one"/><a:content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>正文</p><script>脚本</script></div></a:content></a:entry></a:feed>','application/atom+xml');assert.equal(result.feed?.entries[0]?.title,'保留 <文字>');assert.equal(result.feed?.entries[0]?.url,'https://fixture.example/news/one');assert.equal(result.feed?.entries[0]?.summary,'正文');});
check('错误XML、外部实体、DTD和超深结构拒绝且不回显原文',()=>{for(const xml of ['<rss><secret></rss>','<!DOCTYPE rss SYSTEM "https://private.example"><rss/>','<x>'.repeat(65)+'</x>'.repeat(65)])assert.throws(()=>parse(xml),e=>e instanceof Error&&!e.message.includes('private.example'));});
check('条目数和总文本受限并显式标记截断',()=>{const result=parse(rss('<item><title>条目</title><description>'+('文'.repeat(4000))+'</description></item>'.repeat(1)));assert(result.truncated);const many=parse(rss('<item><title>条目</title></item>'.repeat(45)));assert.equal(many.feed?.entries.length,40);assert.equal(many.feed?.totalEntries,45);assert(many.truncated);assert(many.text.length<=24000);validatedFeed(many.feed);});
check('恶意协议和凭据链接不保留，条目不去外网补正文',()=>{const result=parse(rss('<item><link>javascript:alert(1)</link></item><item><link>https://user:password@fixture.example/</link></item>'));assert(result.feed?.entries.every(e=>e.url===''));const remote=parse('<feed xmlns="http://www.w3.org/2005/Atom"><entry><content src="https://fixture.example/private"/></entry></feed>','application/atom+xml');assert.equal(remote.feed?.entries[0]?.summary,'[外部正文未读取]');});
check('空订阅保留零条，普通JSON和HTML保持原行为',()=>{assert.equal(parse(rss('')).feed?.entries.length,0);assert.equal(parse('{"ok":true}','application/json').text,'{"ok":true}');assert(parse('<html><body>正文</body></html>','text/html').text.includes('正文'));assert.throws(()=>parse('<rss version="0.91"><channel/></rss>'),/仅支持/);});
check('边界校验拒绝伪造超量条目和链接',()=>{assert.throws(()=>validatedFeed({format:'rss',entries:[{id:'',title:'',published:'',url:'file:///secret',summary:''}],totalEntries:1}));assert.throws(()=>validatedFeed({format:'rss',entries:[],totalEntries:-1}));});
check('命名空间隔离、非法多根、内容扩展和声明编码',()=>{
 assert.throws(()=>parse('<rss/><rss/>'));
 const result=parse(rss('<item xmlns:x="urn:fake" xmlns:c="http://purl.org/rss/1.0/modules/content/"><x:title>不能充当标题</x:title><description>摘要</description><c:encoded><![CDATA[<p>扩展正文</p>]]></c:encoded></item>'));
 assert.equal(result.feed?.entries[0]?.title,'');assert.equal(result.feed?.entries[0]?.summary,'扩展正文');
 const encoded=responseContent({url:'https://fixture.example/feed',status:200,headers:{'content-type':'application/xml'},body:Buffer.from('<?xml version="1.0" encoding="iso-8859-1"?><rss version="2.0"><channel><title>Café</title></channel></rss>','latin1')});assert.equal(encoded.title,'Café');
});
check('大条目组合保持总量限制，未知字段和重复ID不被擅自合并',()=>{
 const result=parse(rss(('<item><guid>重复标识</guid><title>'+('题'.repeat(500))+'</title><link>https://fixture.example/'+('a'.repeat(980))+'</link><description>'+('文'.repeat(3000))+'</description></item>').repeat(20)));
 assert(result.truncated);assert(result.text.length<=24000);validatedFeed(result.feed);assert(result.feed!.entries.length>1);
});
console.log(`订阅解析 ${checks} 项通过`);
