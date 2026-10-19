import type {BrowserEngine,LoginState} from './browser-engine.js';
import {webUrl,type WebPolicy} from './safe-http.js';
type Session={managed:Awaited<ReturnType<BrowserEngine['openPage']>>;urls:string[];policy:WebPolicy;expires:number;verifiedUntil:number;busy:boolean;controller:AbortController};
/** 登录接管只提供用户画面与坐标操作，不提供模型读取、DOM或脚本执行接口。 */
export class BrowserLogin {
 private sessions=new Map<string,Session>();
 private creating=new Set<string>();
 private timer:ReturnType<typeof setInterval>;
 constructor(private readonly engine:BrowserEngine){this.timer=setInterval(()=>{for(const [id,session] of this.sessions)if((session.expires<=Date.now()||session.verifiedUntil<=Date.now()))void this.close(id);},5000);this.timer.unref();}
 private key(id:string){if(!/^[a-f0-9]{64}$/.test(id))throw Error('登录会话标识无效');}
 async start(id:string,url:string,policy:WebPolicy,state?:LoginState){
  this.key(id);if(this.sessions.has(id)||this.creating.has(id))throw Error('登录会话已打开');
  if(this.sessions.size+this.creating.size>=2)throw Error('人工登录槽已满，请关闭其他登录窗口');
  this.creating.add(id);const controller=new AbortController();
  try{const urls=[...(policy.urls??[])];webUrl(url,undefined,urls,policy.targets);
   const effective={...policy,urls},managed=await this.engine.openPage(effective,controller.signal,undefined,{state,manual:true});
   const session:Session={managed,urls,policy:effective,expires:Date.now()+20*60000,verifiedUntil:Date.now()+45000,busy:true,controller};this.sessions.set(id,session);
   try{await managed.page.goto(url,{waitUntil:'domcontentloaded',timeout:20000});}catch{/* 被阻止的跳转仍保留窗口，用户可核对并添加完整地址。 */}finally{session.busy=false;}
   return await this.frame(id);
  }catch(error){await this.close(id);throw error;}finally{this.creating.delete(id);}
 }
 private get(id:string){this.key(id);const session=this.sessions.get(id);if(!session||(session.expires<=Date.now()||session.verifiedUntil<=Date.now())||session.managed.page.isClosed())throw Error('登录窗口已关闭或超过20分钟，请重新打开');return session;}
 async heartbeat(id:string){const session=this.get(id);session.verifiedUntil=Date.now()+30000;return {ok:true};}
 async close(id?:string){if(id)this.key(id);else clearInterval(this.timer);for(const [key,session] of this.sessions)if(!id||key===id){this.sessions.delete(key);session.controller.abort();await session.managed.context.close().catch(()=>undefined);}}
 async frame(id:string){const session=this.get(id);if(session.busy)throw Error('登录窗口正在处理操作');const page=session.managed.page;
  // 表单跳转可能短暂更换渲染表面；只重取画面，绝不重放提交或输入。
  let image:Buffer|undefined;
  for(let attempt=0;attempt<3;attempt++){
   this.get(id);
   try{image=await page.screenshot({type:'jpeg',quality:65,timeout:5000});break;}
   catch(error){if(attempt===2||!(error instanceof Error)||(!error.message.includes('Unable to capture screenshot')&&error.name!=='TimeoutError'))throw error;await new Promise(resolve=>setTimeout(resolve,100));}
  }
  if(!image)throw Error('登录画面暂不可用，请刷新画面');
  return {image:image.toString('base64'),url:page.url(),width:1280,height:800,expiresAt:new Date(session.expires).toISOString(),blockedUrls:session.managed.blockedUrls().filter(url=>!session.urls.includes(url))};}
 async command(id:string,input:Record<string,unknown>){const session=this.get(id);if(session.busy)throw Error('登录窗口正在处理操作');session.busy=true;session.managed.reset();
  try{const page=session.managed.page;
   switch(input.kind){
    case 'allow': {const url=webUrl(input.url,undefined,undefined,session.policy.targets).href;if(!session.urls.includes(url)){if(session.urls.length>=20)throw Error('登录地址最多20项');session.urls.push(url);}break;}
    case 'navigate':await page.goto(webUrl(input.url,undefined,session.urls,session.policy.targets).href,{waitUntil:'domcontentloaded',timeout:20000});break;
    case 'reload':await page.reload({waitUntil:'domcontentloaded',timeout:20000});break;
    case 'click':if(typeof input.x!=='number'||typeof input.y!=='number'||!Number.isFinite(input.x)||!Number.isFinite(input.y)||input.x<0||input.x>=1280||input.y<0||input.y>=800)throw Error('点击坐标无效');await page.mouse.click(input.x,input.y);break;
    case 'text':if(typeof input.text!=='string'||input.text.length>4000)throw Error('输入文本过长');await page.keyboard.insertText(input.text);break;
    case 'key':if(typeof input.key!=='string'||!['Enter','Tab','Backspace','Delete','Escape','Control+A','Meta+A','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(input.key))throw Error('按键不受支持');await page.keyboard.press(input.key);break;
    case 'scroll':if(!Number.isInteger(input.pixels)||Math.abs(Number(input.pixels))>5000)throw Error('滚动范围无效');await page.mouse.wheel(0,Number(input.pixels));break;
    default:throw Error('登录操作无效');
   }
  }finally{session.busy=false;}
  return this.frame(id);
 }
 async state(id:string){const session=this.get(id);if(session.busy)throw Error('请等待当前操作完成');session.busy=true;try{const state=await session.managed.context.storageState();if(Buffer.byteLength(JSON.stringify(state))>256*1024)throw Error('登录状态超过256KiB，未保存');return state;}finally{session.busy=false;}}
}
