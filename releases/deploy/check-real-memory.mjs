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
  docker(['cp', '/mnt/e/project/WorkPivot/code/eval/real-memory-flow.mts', web + ':/app/eval/real-memory-flow.mts']);
  try { execFileSync('docker', ['exec', '-e', 'WORKPIVOT_MEMORY_TEST_DISPOSABLE=1', '-e', 'WORKPIVOT_SUMMARY_ONLY='+(process.argv.includes('--summary-only')?'1':'0'), '-e', `WORKPIVOT_MEMORY_TEST_URL=postgresql://postgres:${secret}@${name}:5432/workpivot_memory_test`, web, '/app/node_modules/.bin/tsx', '/app/eval/real-memory-flow.mts'], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 600000 }); }
  catch { throw Error('Memory acceptance failed; see assertion output above'); }
} finally {
  if (created) { const info = JSON.parse(docker(['inspect', name]))[0]; if (info.Config.Labels[label] !== 'true') throw Error('Cleanup label mismatch'); docker(['rm', '-f', name]); console.log('Temporary memory database removed.'); }
}
