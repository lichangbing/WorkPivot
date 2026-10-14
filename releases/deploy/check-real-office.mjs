// Server-side opt-in runner. Model/worker settings stay in the existing web container.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
const name='workpivot-office-check-'+Date.now(),label='workpivot.office-check',web='workpivot-database-server34';
const docker=(args)=>execFileSync('docker',args,{encoding:'utf8',timeout:60000,stdio:['ignore','pipe','pipe']});
const secret=randomBytes(32).toString('hex');let created=false;
try {
  const image=JSON.parse(docker(['inspect','workpivot-database34']))[0].Config.Image;
  docker(['run','-d','--name',name,'--label',label+'=true','--network','workpivot-preview34-database','--tmpfs','/var/lib/postgresql/data:rw,nosuid,size=512m','-e','POSTGRES_DB=workpivot_office_test','-e','POSTGRES_PASSWORD='+secret,image]);created=true;
  let ready=false;for(let i=0;i<30;i++){try{docker(['exec',name,'pg_isready','-U','postgres','-d','workpivot_office_test']);ready=true;break;}catch{await new Promise(r=>setTimeout(r,500));}}
  if(!ready)throw Error('Temporary DB unavailable');
  docker(['cp',resolve(process.argv[2]??'real-office-flow.mts'),web+':/app/eval/real-office-flow.mts']);
  execFileSync('docker',['exec','-e','WORKPIVOT_OFFICE_TEST_DISPOSABLE=1','-e',`WORKPIVOT_OFFICE_TEST_URL=postgresql://postgres:${secret}@${name}:5432/workpivot_office_test`,web,'./node_modules/.bin/tsx','eval/real-office-flow.mts'],{stdio:['ignore','inherit','inherit'],timeout:600000});
} finally {
  if(created){const info=JSON.parse(docker(['inspect',name]))[0];if(info.Config.Labels[label]!=='true')throw Error('Cleanup label mismatch');docker(['rm','-f',name]);console.log('Temporary office database removed; production data unchanged.');}
}
