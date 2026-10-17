import {Router} from 'express';
import {Automations} from './automations.js';
import {automationConfig,automationPreview} from './automation-time.js';
import {RepositoryError} from './connection.js';
export function automationRoutes(plans:Automations){const router=Router();const owner=(res:import('express').Response)=>res.locals['user'].id as string;
 router.get('/',async(_req,res)=>res.json({plans:await plans.list(owner(res))}));
 router.get('/options',async(_req,res)=>res.json(await plans.options(owner(res))));
 router.post('/preview',async(req,res)=>res.json({times:automationPreview(automationConfig(req.body.config))}));
 router.get('/notices',async(_req,res)=>res.json({notices:await plans.notices(owner(res))}));
 router.post('/notices/:id/read',async(req,res)=>{await plans.readNotice(owner(res),String(req.params.id));res.json({ok:true});});
 router.post('/',async(req,res)=>res.json(await plans.draft(owner(res),req.body.config,req.body.requestId)));
 router.get('/:id',async(req,res)=>res.json(await plans.detail(owner(res),String(req.params.id))));
 router.post('/:id/draft',async(req,res)=>res.json(await plans.draft(owner(res),req.body.config,req.body.requestId,String(req.params.id),req.body.revision)));
 router.post('/:id/confirm',async(req,res)=>{if(typeof req.body.enable!=='boolean')throw new RepositoryError(400,'需要明确启用决定');res.json(await plans.confirm(owner(res),String(req.params.id),req.body.revision,req.body.enable));});
 router.post('/:id/action',async(req,res)=>{if(!['pause','delete','discard'].includes(req.body.action))throw new RepositoryError(400,'操作无效');res.json(await plans.action(owner(res),String(req.params.id),req.body.revision,req.body.action,req.body.stopCurrent===true));});
 router.post('/:id/run',async(req,res)=>res.json(await plans.manual(owner(res),String(req.params.id),req.body.revision,req.body.requestId)));
 router.post('/:id/runs/:runId/stop',async(req,res)=>{await plans.stopRun(owner(res),String(req.params.id),String(req.params.runId));res.json({ok:true});});
 return router;
}
