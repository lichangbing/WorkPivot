import type {LoginState} from './browser-engine.js';
/** 禁止将storageState字符串当作服务器文件路径；只接受有界的浏览器状态对象。 */
export function loginState(value:unknown):LoginState|undefined{
 if(value===undefined)return undefined;
 if(!value||typeof value!=='object'||Array.isArray(value)||Buffer.byteLength(JSON.stringify(value))>256*1024)throw Error('登录状态格式或大小无效');
 const state=value as LoginState;
 if(!Array.isArray(state.cookies)||state.cookies.length>3000||!Array.isArray(state.origins)||state.origins.length>100)throw Error('登录状态范围无效');
 for(const cookie of state.cookies)if(!cookie||typeof cookie.name!=='string'||typeof cookie.value!=='string'||typeof cookie.domain!=='string'||typeof cookie.path!=='string'||!cookie.path.startsWith('/')||!Number.isFinite(cookie.expires)||typeof cookie.httpOnly!=='boolean'||typeof cookie.secure!=='boolean'||!['Strict','Lax','None'].includes(cookie.sameSite))throw Error('登录Cookie格式无效');
 for(const origin of state.origins){if(!origin||typeof origin.origin!=='string'||!Array.isArray(origin.localStorage)||origin.localStorage.length>1000||origin.localStorage.some(item=>!item||typeof item.name!=='string'||typeof item.value!=='string'))throw Error('登录站点状态无效');const url=new URL(origin.origin);if(!['https:','http:'].includes(url.protocol)||url.origin!==origin.origin)throw Error('登录站点来源无效');}
 return state;
}
