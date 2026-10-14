import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
const root = '/home/lichb/workpivot-database-preview34';
const image = 'workpivot-server:0.3.0-db-preview.34';
const pgImage = 'postgres@sha256:3d0f7584ed7d04e27fa050d6683a74746608faf21f202be78460d679cc56461f';
const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 300000 });
if (existsSync(root)) throw Error('Deployment directory already exists; inspect before retrying');
mkdirSync(root, { mode: 0o700 });
const secret = () => randomBytes(32).toString('hex');
const admin = secret(), app = secret(), auth = secret(), init = secret(), key = secret();
const save = (name, text) => writeFileSync(resolve(root, name), text, { mode: 0o600 });
save('database.env', `POSTGRES_DB=workpivot\nPOSTGRES_USER=workpivot_schema\nPOSTGRES_PASSWORD=${admin}\n`);
save('schema.env', `WORKPIVOT_DATABASE_ADMIN_URL=postgresql://workpivot_schema:${admin}@database:5432/workpivot\n`);
save('runtime.env', `WORKPIVOT_DATABASE_URL=postgresql://workpivot_app:${app}@database:5432/workpivot\nWORKPIVOT_AUTH_DATABASE_URL=postgresql://workpivot_auth:${auth}@database:5432/workpivot\nWORKPIVOT_ADMIN_INIT_TOKEN=${init}\nWORKPIVOT_SECRET_KEY=${key}\nWORKPIVOT_DATABASE_PREVIEW=1\nWORKPIVOT_DATABASE_CHAT_PREVIEW=1\nWORKPIVOT_DATABASE_PREVIEW_HOST=0.0.0.0\nWORKPIVOT_DATABASE_PREVIEW_PORT=39800\n`);
save('first-login.txt', `WorkPivot database preview\nURL: https://workpivot.lichb.cc.cd/\nInitialization token: ${init}\nCreate the first administrator using this token.\n`);
const compose = port => `services:
  database:
    image: ${pgImage}
    container_name: workpivot-database34
    env_file: [database.env]
    volumes: [postgres-data:/var/lib/postgresql/data]
    networks: [database]
    restart: unless-stopped
    healthcheck:
      test: [CMD-SHELL, "pg_isready -U workpivot_schema -d workpivot"]
      interval: 3s
      timeout: 3s
      retries: 20
  server:
    image: ${image}
    container_name: workpivot-database-server34
    env_file: [runtime.env]
    ports: ["127.0.0.1:${port}:39800", "192.168.1.158:${port}:39800"]
    networks: [database, default]
    depends_on:
      database: {condition: service_healthy}
    restart: unless-stopped
    security_opt: [no-new-privileges:true]
    cap_drop: [ALL]
volumes:
  postgres-data:
networks:
  database:
    name: workpivot-preview34-database
    internal: true
`;
const args = ['compose', '-p', 'workpivot-database34', '-f', resolve(root, 'compose.yml')];
let switched = false;
try {
  save('compose.yml', compose(39985));
  docker([...args, 'up', '-d', 'database', '--wait']);
  docker(['exec', '-i', 'workpivot-database34', 'psql', '-U', 'workpivot_schema', '-d', 'workpivot', '-v', 'ON_ERROR_STOP=1'], `CREATE ROLE workpivot_app LOGIN PASSWORD '${app}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; CREATE ROLE workpivot_auth LOGIN PASSWORD '${auth}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;`);
  console.log(docker(['run', '--rm', '--network', 'workpivot-preview34-database', '--env-file', resolve(root, 'schema.env'), image, './node_modules/.bin/tsx', 'scripts/postgres-schema.mts']).trim());
  docker([...args, 'up', '-d', '--wait', '--wait-timeout', '90']);
  const check = async port => {
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    if (health.storage !== 'postgresql' || !health.chatEnabled) throw Error('Unexpected health');
    if (!(await fetch(`http://127.0.0.1:${port}/`)).ok) throw Error('Missing UI');
    if ((await fetch(`http://127.0.0.1:${port}/api/tasks`)).status !== 401) throw Error('Authentication guard failed');
    return health;
  };
  await check(39985);
  const oldState = await (await fetch('http://127.0.0.1:39800/api/auth/state')).json();
  if (!oldState.needsSetup) throw Error('Legacy accounts appeared; stop before replacing active system');
  docker(['update', '--restart=no', 'workpivot-server']);
  docker(['stop', 'workpivot-server']); switched = true;
  save('compose.yml', compose(39800));
  docker([...args, 'up', '-d', '--wait', '--wait-timeout', '90']);
  console.log(JSON.stringify(await check(39800)));
  console.log('Deployed. Old container retained stopped. Initialization credential: ' + root + '/first-login.txt');
} catch (error) {
  if (switched) { docker([...args, 'stop', 'server']); docker(['update', '--restart=unless-stopped', 'workpivot-server']); docker(['start', 'workpivot-server']); }
  console.error('Deployment failed; credentials suppressed; inspect service status.'); process.exitCode = 1;
}
