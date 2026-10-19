/** Retry-After 支持秒数和HTTP日期；过长等待不能被截短后提前请求。 */
export function retryAfter(value:string|undefined,now=Date.now()):number|undefined{
 if(value===undefined)return undefined;
 const input=value.trim();
 if(/^\d+$/.test(input)){const milliseconds=Number(input)*1000;return Number.isFinite(milliseconds)?milliseconds:Number.MAX_SAFE_INTEGER;}
 // 不把负数、浮点秒数等错误值当作宽松的JavaScript日期。
 if(!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),/i.test(input)&&!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s/i.test(input))return undefined;
 const date=Date.parse(input);return Number.isFinite(date)?Math.max(0,date-now):undefined;
}
