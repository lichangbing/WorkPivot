import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
const docker = (args, input) => execFileSync('wsl', ['-d', 'Ubuntu-24.04', '--', 'docker', ...args], { input, encoding: 'utf8', timeout: 300000, maxBuffer: 1024 * 1024 }).trim();
const pg = 'workpivot-attachment-e2e-db', web = 'workpivot-attachment-e2e-web', network = 'workpivot-attachment-e2e';
if (docker(['ps', '-a', '--filter', 'name=workpivot-attachment-e2e', '--format', '{{.Names}}'])) throw Error('Existing attachment fixture found; inspect instead of overwriting');
if (docker(['volume', 'ls', '--filter', 'name=workpivot-attachment-e2e', '--format', '{{.Name}}'])) throw Error('Existing fixture data volumes found; restore existing environment instead of reinitializing');
const password = randomBytes(24).toString('hex'), app = randomBytes(24).toString('hex'), auth = randomBytes(24).toString('hex');
docker(['network', 'create', '--internal', '--label', 'workpivot.test=attachment-e2e', network]);
docker(['run', '-d', '--name', pg, '--network', network, '--label', 'workpivot.test=attachment-e2e', '-v', 'workpivot-attachment-e2e-db:/var/lib/postgresql/data', '-e', 'POSTGRES_DB=workpivot', '-e', 'POSTGRES_PASSWORD=' + password, 'pgvector/pgvector:pg15']);
let ready = false;
for (let i = 0; i < 30; i++) { try { docker(['exec', pg, 'pg_isready', '-U', 'postgres', '-d', 'workpivot']); ready = true; break; } catch { await new Promise(r => setTimeout(r, 500)); } }
if (!ready) throw Error('Database not ready');
docker(['exec', '-i', pg, 'psql', '-U', 'postgres', '-d', 'workpivot', '-v', 'ON_ERROR_STOP=1'], `CREATE ROLE workpivot_app LOGIN PASSWORD '${app}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; CREATE ROLE workpivot_auth LOGIN PASSWORD '${auth}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;`);
docker(['run', '-d', '--name', web, '--network', network, '--label', 'workpivot.test=attachment-e2e', '-p', '127.0.0.1:39986:39800', '-v', 'workpivot-attachment-e2e-files:/data/workpivot', '-e', 'WORKPIVOT_ATTACHMENT_FIXTURE=1', '-e', `WORKPIVOT_DATABASE_ADMIN_URL=postgresql://postgres:${password}@${pg}/workpivot`, '-e', `WORKPIVOT_DATABASE_URL=postgresql://workpivot_app:${app}@${pg}/workpivot`, '-e', `WORKPIVOT_AUTH_DATABASE_URL=postgresql://workpivot_auth:${auth}@${pg}/workpivot`, 'workpivot-server:attachment-e2e']);
docker(['network', 'connect', 'bridge', web]);
console.log('WSL fixture started at http://127.0.0.1:39986; credentials documented in fixture source; no real model configured.');
