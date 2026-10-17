/** 来源标记由模型提出，服务器只验证归属，内容是否支持结论仍需用户核对。 */
export function summaryFacts(content:string,allowed:string[]){
 const ids=new Set(allowed);
 return content.split('\n').map(line=>line.trim()).filter(Boolean).map((line,index)=>{
  const markers=[...line.matchAll(/\[来源:([^\]]*)\]/g)];
  const references=[...new Set(markers.flatMap(m=>m[1]!.split(',').map(s=>s.trim())))];
  const valid=references.length>0&&references.every(id=>ids.has(id));
  return {index,text:line.replace(/\[来源:[^\]]*\]/g,'').trim(),sourceIds:valid?references:[],status:references.length?(valid?'linked':'invalid'):'unattributed'};
 });
}
