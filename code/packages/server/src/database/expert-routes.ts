import type {Express,Request,Response} from 'express';
import type {Pool} from 'pg';
import {Experts} from './experts.js';
import {RepositoryError} from './connection.js';
export function expertRoutes(app:Express,db:Pool){
 const experts=new Experts(db),actor=(res:Response)=>res.locals['user'] as {id:string;role:string};
 const admin=(res:Response)=>{if(actor(res).role!=='admin')throw new RepositoryError(403,'需要管理员权限');return actor(res).id;};
 const id=(req:Request)=>String(req.params['id']);
 app.get('/api/experts',async(_req,res)=>res.json({experts:await experts.list(actor(res).id)}));
 app.get('/api/expert-templates',async(_req,res)=>{const rows=await experts.list(actor(res).id,true);res.json({experts:actor(res).role==='admin'?rows:rows.filter(r=>r.published&&!r.disabled).map(r=>({...r,settings:r.versions.find((v:{revision:number})=>v.revision===r.published)?.settings,versions:r.versions.filter((v:{revision:number})=>v.revision===r.published)}))});});
 app.post('/api/experts',async(req,res)=>res.json({expert:await experts.create(actor(res).id,req.body.name,req.body.settings,false,req.body.templateId)}));
 app.post('/api/expert-templates',async(req,res)=>res.json({expert:await experts.create(admin(res),req.body.name,req.body.settings,true)}));
 app.put('/api/experts/:id',async(req,res)=>res.json({expert:await experts.save(actor(res).id,id(req),req.body.revision,req.body,actor(res).role==='admin')}));
 app.post('/api/expert-templates/:id/publish',async(req,res)=>{await experts.publish(admin(res),id(req),req.body.revision);res.json({ok:true});});
 app.delete('/api/experts/:id',async(req,res)=>{await experts.remove(actor(res).id,id(req),req.body.revision);res.json({ok:true});});
 app.post('/api/experts/:id/adopt-template',async(req,res)=>{await experts.adopt(actor(res).id,id(req),req.body.revision,req.body.templateRevision);res.json({ok:true});});
 for(const target of ['tasks','projects'] as const)app.put(`/api/${target}/:id/expert`,async(req,res)=>{await experts.bind(actor(res).id,target,id(req),req.body.expertId,req.body.revision);res.json({ok:true});});
 app.get('/api/experts/:id/experiences',async(req,res)=>res.json({experiences:await experts.experiences(actor(res).id,id(req))}));
 app.get('/api/experts/:id/jobs',async(req,res)=>res.json({jobs:await experts.jobs(actor(res).id,id(req))}));
 app.post('/api/experts/:id/jobs/:run/retry',async(req,res)=>{await experts.retry(actor(res).id,id(req),String(req.params['run']));res.json({ok:true});});
 app.post('/api/experts/:id/experiences',async(req,res)=>{await experts.editExperience(actor(res).id,id(req),req.body);res.json({ok:true});});
 app.get('/api/expert-suggestions',async(req,res)=>res.json({suggestions:await experts.suggestions(actor(res).id,typeof req.query['task']==='string'?req.query['task']:undefined)}));
 app.post('/api/expert-suggestions/:id/decision',async(req,res)=>{await experts.decide(actor(res).id,id(req),req.body.revision,req.body.accept,req.body.content);res.json({ok:true});});
}
