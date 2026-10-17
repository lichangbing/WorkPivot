// 仅在 WSL 运行：临时数据库中使用合成数据，只读访问真实模型配置。
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
const docker=args=>execFileSync('docker',args,{encoding:'utf8',timeout:60000,stdio:['ignore','pipe','pipe']});
const name='workpivot-office-review-'+Date.now(),secret=randomBytes(24).toString('hex');
const image='workpivot-server:0.3.0-rc.1-memory-policy',root='/mnt/e/project/WorkPivot/code';
const live=JSON.parse(docker(['inspect','workpivot-attachment-e2e-web']))[0];
let created=false;
try{
 docker(['run','-d','--name',name,'--label','workpivot.office-review=true','--network','workpivot-attachment-e2e','--tmpfs','/var/lib/postgresql/data:rw,nosuid,size=512m','-e','POSTGRES_DB=workpivot_office_test','-e','POSTGRES_PASSWORD='+secret,'pgvector/pgvector:pg15']);created=true;
 for(let i=0;i<30;i++){try{docker(['exec',name,'pg_isready','-U','postgres']);break;}catch{await new Promise(r=>setTimeout(r,500));}}
 const data=live.Mounts.find(m=>m.Destination==='/data/workpivot');if(data?.Type!=='volume')throw Error('Unexpected live mount');
 const args=['create','--name',name+'-runner','--label','workpivot.office-review=true','--network','workpivot-attachment-e2e',...live.Config.Env.flatMap(e=>['-e',e]),'-e','WORKPIVOT_OFFICE_TEST_DISPOSABLE=1','-e','WORKPIVOT_OFFICE_TEST_URL=postgresql://postgres:'+secret+'@'+name+':5432/workpivot_office_test','-v',data.Name+':/data/workpivot:ro','-v',root+'/packages/server/src:/app/packages/server/src:ro','-v',root+'/eval/real-office-flow.mts:/app/eval/real-office-flow.mts:ro',image,'./node_modules/.bin/tsx','eval/real-office-flow.mts'];
 docker(args);docker(['network','connect','bridge',name+'-runner']);
 try{execFileSync('docker',['start','-a',name+'-runner'],{stdio:['ignore','inherit','inherit'],timeout:600000});if(JSON.parse(docker(['inspect',name+'-runner']))[0].State.ExitCode!==0)throw Error('Test process failed');}catch{throw Error('Real-model office review failed; credentials suppressed');}
}finally{
 try{const info=JSON.parse(docker(['inspect',name+'-runner']))[0];if(info.Config.Labels['workpivot.office-review']==='true')docker(['rm','-f',name+'-runner']);}catch{}
 if(created){const info=JSON.parse(docker(['inspect',name]))[0];if(info.Config.Labels['workpivot.office-review']!=='true')throw Error('Cleanup target mismatch');docker(['rm','-f',name]);console.log('Disposable office database removed');}
}
