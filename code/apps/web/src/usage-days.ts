interface UsageDay {day?:string;requests:number;inputTokens:string;outputTokens:string;estimated:number;unfinished:number}
/** 用量不分币种，合并同日统计；用 bigint 保留累计 Token 精度，空白日补零。 */
export function dailyUsage(month:string,rows:UsageDay[],today:string):Required<UsageDay>[] {
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))return [];
 const result:Required<UsageDay>[]=[];
 const length=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).getUTCDate();
 for(let date=length;date>=1;date--){
  const day=month+'-'+String(date).padStart(2,'0');if(day>today)continue;
  const item={day,requests:0,inputTokens:'0',outputTokens:'0',estimated:0,unfinished:0};
  for(const row of rows.filter(value=>value.day===day)){
   item.requests+=row.requests;item.estimated+=row.estimated;item.unfinished+=row.unfinished;
   item.inputTokens=String(BigInt(item.inputTokens)+BigInt(row.inputTokens));item.outputTokens=String(BigInt(item.outputTokens)+BigInt(row.outputTokens));
  }
  result.push(item);
 }
 return result;
}
