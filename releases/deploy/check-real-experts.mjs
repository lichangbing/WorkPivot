import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
const name = 'workpivot-memory-check-' + Date.now(), label = 'workpivot.memory-check';
const web = 'workpivot-attachment-e2e-web';
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
const secret = randomBytes(32).toString('hex');
let created = false;
try {
  docker(['run', '-d', '--name', name, '--label', label + '=true', '--network', 'workpivot-attachment-e2e', '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,size=512m', '-e', 'POSTGRES_DB=workpivot_memory_test', '-e', 'POSTGRES_PASSWORD=' + secret, 'pgvector/pgvector:pg15']);
  created = true;
  let ready = false;
  for (let i = 0; i < 30; i++) { try { docker(['exec', name, 'pg_isready', '-U', 'postgres']); ready = true; break; } catch { await new Promise(r => setTimeout(r, 500)); } }
  if (!ready) throw Error('Temporary DB unavailable');
  docker(['cp', '/mnt/e/project/WorkPivot/code/eval/real-expert-flow.mts', web + ':/app/eval/real-expert-flow.mts']);
  try { execFileSync('docker', ['exec', '-e', 'WORKPIVOT_RC_FILES_ROOT=/tmp/'+name, '-e', 'WORKPIVOT_MEMORY_TEST_DISPOSABLE=1', '-e', `WORKPIVOT_MEMORY_TEST_URL=postgresql://postgres:${secret}@${name}:5432/workpivot_memory_test`, web, '/app/node_modules/.bin/tsx', '/app/eval/real-expert-flow.mts'], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 600000 }); }
  catch { throw Error('Memory acceptance failed; see assertion output above'); }
  docker(['exec',name,'pg_dump','-U','postgres','-d','workpivot_memory_test','-Fc','-f','/tmp/expert-restore.dump']);
  docker(['exec',name,'createdb','-U','postgres','workpivot_restore_test']);
  docker(['exec',name,'pg_restore','-U','postgres','-d','workpivot_restore_test','/tmp/expert-restore.dump']);
  const query="SELECT count(*) FROM workpivot.experts; SELECT count(*) FROM workpivot.expert_experiences WHERE content<>''; SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='workpivot' AND c.relkind='r' AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity);";
  const original=docker(['exec',name,'psql','-U','postgres','-d','workpivot_memory_test','-Atc',query]);
  const restored=docker(['exec',name,'psql','-U','postgres','-d','workpivot_restore_test','-Atc',query]);
  if(original!==restored||restored.trim()!=='1\n0\n0')throw Error('Restore or deletion invariants failed');
  console.log('PASS independent pg_dump/pg_restore: expert retained, forgotten text absent, forced RLS retained');
  docker(['exec',web,'cp','-a','/tmp/'+name,'/tmp/'+name+'-restore']);
  docker(['cp','/mnt/e/project/WorkPivot/code/eval/rc-restore-files.mts',web+':/app/eval/rc-restore-files.mts']);
  console.log(docker(['exec','-e','WORKPIVOT_RC_FILES_ROOT=/tmp/'+name+'-restore','-e',`WORKPIVOT_MEMORY_TEST_URL=postgresql://postgres:${secret}@${name}:5432/workpivot_restore_test`,web,'/app/node_modules/.bin/tsx','/app/eval/rc-restore-files.mts']).trim());
  for(const [from,to] of [['code/packages/server/src/database/restore-retention.ts','packages/server/src/database/restore-retention.ts'],['code/scripts/restore-retention.mts','scripts/restore-retention.mts'],['code/eval/rc-restore-scenario.mts','eval/rc-restore-scenario.mts']])docker(['cp','/mnt/e/project/WorkPivot/'+from,web+':/app/'+to]);
  docker(['exec',name,'psql','-U','postgres','-d','workpivot_memory_test','-c',`ALTER ROLE memory_app PASSWORD '${secret}'`]);
  const sourceUrl=`postgresql://memory_app:${secret}@${name}:5432/workpivot_memory_test`;
  const phase=(mode,dbUrl=sourceUrl,root='/tmp/'+name)=>docker(['exec','-e','WORKPIVOT_DATABASE_URL='+dbUrl,'-e','WORKPIVOT_RC_FILES_ROOT='+root,web,'/app/node_modules/.bin/tsx','/app/eval/rc-restore-scenario.mts',mode]);
  phase('prepare');
  docker(['exec',name,'pg_dump','-U','postgres','-d','workpivot_memory_test','-Fc','-f','/tmp/older.dump']);
  docker(['exec',web,'cp','-a','/tmp/'+name,'/tmp/'+name+'-forget-restored']);
  phase('forget');
  docker(['exec','-e','WORKPIVOT_DATABASE_URL='+sourceUrl,'-e',`WORKPIVOT_DATABASE_ADMIN_URL=postgresql://postgres:${secret}@${name}:5432/workpivot_memory_test`,web,'/app/node_modules/.bin/tsx','/app/scripts/restore-retention.mts','export','/tmp/'+name+'/retention.json']);
  docker(['exec',name,'createdb','-U','postgres','workpivot_forget_restored']);
  docker(['exec',name,'pg_restore','-U','postgres','-d','workpivot_forget_restored','/tmp/older.dump']);
  const targetUrl=sourceUrl.replace('/workpivot_memory_test','/workpivot_forget_restored');
  docker(['exec','-e','WORKPIVOT_OFFLINE_RESTORE=1','-e','WORKPIVOT_DATABASE_FILES_ROOT=/tmp/'+name+'-forget-restored','-e','WORKPIVOT_DATABASE_URL='+targetUrl,'-e',`WORKPIVOT_DATABASE_ADMIN_URL=postgresql://postgres:${secret}@${name}:5432/workpivot_forget_restored`,web,'/app/node_modules/.bin/tsx','/app/scripts/restore-retention.mts','apply','/tmp/'+name+'/retention.json']);
  console.log(phase('verify',targetUrl,'/tmp/'+name+'-forget-restored').trim());
} finally {
  if(/^workpivot-memory-check-\d+$/.test(name))docker(['exec',web,'rm','-rf','--','/tmp/'+name,'/tmp/'+name+'-restore','/tmp/'+name+'-forget-restored']);
  if (created) { const info = JSON.parse(docker(['inspect', name]))[0]; if (info.Config.Labels[label] !== 'true') throw Error('Cleanup label mismatch'); docker(['rm', '-f', name]); console.log('Temporary memory database removed.'); }
}
