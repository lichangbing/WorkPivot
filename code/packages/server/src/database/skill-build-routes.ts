import { Router } from 'express';
import { RepositoryError } from './connection.js';
import { SkillBuilds } from './skill-builds.js';

export function skillBuildRoutes(builds:SkillBuilds) {
  const router=Router();
  const str=(value:unknown)=>{if(typeof value!=='string')throw new RepositoryError(400,'缺少文本参数');return value;};
  router.get('/',async(req,res)=>res.json({builds:await builds.list(res.locals['user'].id,req.query['taskId']===undefined?undefined:str(req.query['taskId']))}));
  router.get('/:id/export',async(req,res)=>{const bytes=await builds.export(res.locals['user'].id,str(req.params['id']),req.query['version']===undefined?undefined:str(req.query['version']));res.attachment('skill.zip').type('application/zip').send(bytes);});
  router.get('/:id',async(req,res)=>res.json(await builds.detail(res.locals['user'].id,str(req.params['id']))));
  router.post('/:id/revise',async(req,res)=>res.json(await builds.revise(res.locals['user'].id,str(req.params['id']),req.body?.revision,req.body??{})));
  router.post('/:id/validate',async(req,res)=>res.json(await builds.validate(res.locals['user'].id,str(req.params['id']),req.body?.revision)));
  router.post('/:id/trial',async(req,res)=>{
    const controller=new AbortController();res.on('close',()=>{if(!res.writableEnded)controller.abort();});
    res.json(await builds.trial(res.locals['user'].id,str(req.params['id']),req.body?.revision,req.body??{},controller.signal));
  });
  // 此确认路由不注册为模型工具；一般聊天和自动执行档位不会调用它。
  router.post('/:id/decision',async(req,res)=>res.json(await builds.decide(res.locals['user'].id,str(req.params['id']),req.body?.revision,req.body?.decision,req.body?.hash)));
  router.post('/:id/lifecycle',async(req,res)=>res.json(await builds.lifecycle(res.locals['user'].id,str(req.params['id']),req.body?.revision,req.body?.action)));
  router.post('/:id/from-release',async(req,res)=>res.json(await builds.fromRelease(res.locals['user'].id,str(req.params['id']),req.body?.revision,req.body?.releaseId)));
  router.use((error:Error & {code?:string;constraint?:string},_req:import('express').Request,_res:import('express').Response,next:import('express').NextFunction)=>{
    if(error.code==='40P01'||error.code==='23505')return next(new RepositoryError(error.constraint==='skill_trial_running'?429:409,'并发操作发生冲突，请刷新草稿后重试'));
    next(error);
  });
  return router;
}
