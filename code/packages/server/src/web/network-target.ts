import ipaddr from 'ipaddr.js';
export interface NetworkTarget {url:string;address:string}
/** 内网例外仅限RFC1918/ULA；环回、链路本地和元数据地址不能由规则放开。 */
export function privateTargetAddress(value:string){try{const ip=ipaddr.process(value);return ip.kind()==='ipv4'?ip.range()==='private':ip.range()==='uniqueLocal';}catch{return false;}}
export function networkTarget(value:unknown):NetworkTarget{
 if(!value||typeof value!=='object')throw Error('内网地址规则无效');
 const row=value as Record<string,unknown>;
 if(typeof row.url!=='string'||typeof row.address!=='string'||row.url.length>4096||!privateTargetAddress(row.address))throw Error('内网规则需要完整URL及RFC1918或ULA地址');
 let url:URL;try{url=new URL(row.url);}catch{throw Error('内网地址无效');}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash||!['','8080','8443'].includes(url.port))throw Error('内网规则仅允许HTTP/HTTPS的80、443、8080、8443端口，不能包含凭据或片段');
 const host=url.hostname.replace(/^\[|\]$/g,'');
 if(['localhost','host.docker.internal','gateway.docker.internal','kubernetes.default.svc','api','browser','worker','postgres','redis'].includes(host)||/\.(localhost|invalid|onion)\.?$/i.test(host))throw Error('不能批准本机或保留域名');
 if(ipaddr.isValid(host)&&ipaddr.process(host).toNormalizedString()!==ipaddr.process(row.address).toNormalizedString())throw Error('URL地址与批准IP不一致');
 return {url:url.href,address:ipaddr.process(row.address).toString()};
}
export function networkTargets(value:unknown):NetworkTarget[]{if(value===undefined)return [];if(!Array.isArray(value)||value.length>20)throw Error('内网地址规则数量无效');return value.map(networkTarget);}
