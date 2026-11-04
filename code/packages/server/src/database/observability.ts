import {randomUUID} from 'node:crypto';
import type {Request,RequestHandler,Response} from 'express';

interface RequestMetric {
  method:string;
  route:string;
  statusClass:string;
  count:number;
  durationSeconds:number;
}

const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function routeLabel(req:Request):string{
  const route=req.route?.path;
  if(typeof route==='string')return `${req.baseUrl}${route}`||req.path;
  if(Array.isArray(route)&&typeof route[0]==='string')return route[0];
  return req.path
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi,':id')
    .replace(/\/\d+(?=\/|$)/g,'/:number');
}

function statusClass(status:number):string{
  if(status>=200&&status<300)return '2xx';
  if(status>=300&&status<400)return '3xx';
  if(status>=400&&status<500)return '4xx';
  return '5xx';
}

/** 进程内指标只保存聚合值，不保存 URL 查询、用户、任务、文件名或业务正文。 */
export class MetricsRegistry {
  private readonly requests=new Map<string,RequestMetric>();
  private readonly startedAt=Date.now();
  observe(method:string,route:string,status:number,durationMs:number):void{
    const normalizedMethod=method.toUpperCase(), klass=statusClass(status);
    const key=`${normalizedMethod}\u0000${route}\u0000${klass}`;
    const current=this.requests.get(key)??{method:normalizedMethod,route,statusClass:klass,count:0,durationSeconds:0};
    current.count++;
    current.durationSeconds+=Math.max(0,durationMs)/1000;
    this.requests.set(key,current);
  }
  render(extra:readonly string[]=[]):string{
    const lines=[
      '# HELP workpivot_process_uptime_seconds 当前进程已运行时间。',
      '# TYPE workpivot_process_uptime_seconds gauge',
      `workpivot_process_uptime_seconds ${((Date.now()-this.startedAt)/1000).toFixed(3)}`,
      '# HELP workpivot_process_resident_memory_bytes 当前进程常驻内存。',
      '# TYPE workpivot_process_resident_memory_bytes gauge',
      `workpivot_process_resident_memory_bytes ${process.memoryUsage().rss}`,
      '# HELP workpivot_http_requests_total 已完成的 HTTP 请求聚合数。',
      '# TYPE workpivot_http_requests_total counter',
    ];
    for(const metric of this.requests.values()){
      const labels=`method="${metric.method}",route=${JSON.stringify(metric.route)},status_class="${metric.statusClass}"`;
      lines.push(`workpivot_http_requests_total{${labels}} ${metric.count}`);
    }
    lines.push('# HELP workpivot_http_request_duration_seconds_sum HTTP 请求累计耗时。','# TYPE workpivot_http_request_duration_seconds_sum counter');
    for(const metric of this.requests.values()){
      const labels=`method="${metric.method}",route=${JSON.stringify(metric.route)},status_class="${metric.statusClass}"`;
      lines.push(`workpivot_http_request_duration_seconds_sum{${labels}} ${metric.durationSeconds.toFixed(6)}`);
    }
    lines.push('# HELP workpivot_http_request_duration_seconds_count HTTP 请求计时样本数。','# TYPE workpivot_http_request_duration_seconds_count counter');
    for(const metric of this.requests.values()){
      const labels=`method="${metric.method}",route=${JSON.stringify(metric.route)},status_class="${metric.statusClass}"`;
      lines.push(`workpivot_http_request_duration_seconds_count{${labels}} ${metric.count}`);
    }
    lines.push(...extra);
    return lines.join('\n')+'\n';
  }
}

function accessLogEnabled(path:string):boolean{
  if(['/api/health','/api/ready','/api/metrics'].includes(path))return false;
  return (process.env['WORKPIVOT_ACCESS_LOG']??'1')!=='0';
}

/** 为每个请求分配可信关联 ID，并只记录路由模板、状态和耗时。 */
export function requestObservability(metrics:MetricsRegistry):RequestHandler{
  return (req,res,next)=>{
    const supplied=req.headers['x-request-id'];
    const requestId=typeof supplied==='string'&&uuidPattern.test(supplied)?supplied.toLowerCase():randomUUID();
    res.locals['requestId']=requestId;
    res.setHeader('X-Request-ID',requestId);
    const started=process.hrtime.bigint();
    res.once('finish',()=>{
      if(!req.path.startsWith('/api/'))return;
      const route=routeLabel(req),durationMs=Number(process.hrtime.bigint()-started)/1e6;
      metrics.observe(req.method,route,res.statusCode,durationMs);
      if(!accessLogEnabled(req.path))return;
      const user=res.locals['user'] as {id?:unknown}|undefined;
      console.log(JSON.stringify({
        level:res.statusCode>=500?'error':res.statusCode>=400?'warn':'info',
        event:'http_request',
        requestId,
        method:req.method,
        route,
        status:res.statusCode,
        durationMs:Math.round(durationMs*10)/10,
        ...(typeof user?.id==='string'?{userId:user.id}:{}),
      }));
    });
    next();
  };
}

export function requestId(res:Response):string{
  const value=res.locals['requestId'];
  return typeof value==='string'?value:randomUUID();
}
