import { resolve } from 'node:path';
import { pool } from '../packages/server/src/database/connection.js';
import { createDatabaseRuntime } from '../packages/server/src/database/runtime.js';

const db = pool(process.env.WORKPIVOT_DATABASE_URL ?? ''), auth = pool(process.env.WORKPIVOT_AUTH_DATABASE_URL ?? '');
try {
  const initToken = process.env.WORKPIVOT_ADMIN_INIT_TOKEN ?? '', secretKey = process.env.WORKPIVOT_SECRET_KEY ?? '';
  const filesRoot = process.env.WORKPIVOT_DATABASE_FILES_ROOT;
  if (initToken.length < 24 || secretKey.length < 32 || !filesRoot) throw Error('Missing runtime configuration');
  const workerUrl = process.env.WORKPIVOT_WORKER_URL, workerToken = process.env.WORKPIVOT_WORKER_TOKEN;
  if (!!workerUrl !== !!workerToken) throw Error('Incomplete worker configuration');
  const app = await createDatabaseRuntime(auth,db,{initToken,secretKey,filesRoot,webDist:resolve(import.meta.dirname,'../apps/web/dist'),worker:workerUrl && workerToken ? {url:workerUrl,token:workerToken}:undefined});
  const server = app.listen(39800,'0.0.0.0');
  await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
  console.log('WorkPivot PostgreSQL server ready');
  let closing = false;
  const close = async () => { if(closing)return;closing=true;app.locals['stopMemoryWorker']?.();server.closeIdleConnections();const timer=setTimeout(()=>server.closeAllConnections(),5000);timer.unref();await new Promise<void>(r=>server.close(()=>r()));clearTimeout(timer);await Promise.all([db.end(),auth.end()]); };
  process.on('SIGTERM',()=>{void close();});process.on('SIGINT',()=>{void close();});
} catch { console.error('Database server startup failed; verify protected runtime configuration.');await Promise.all([db.end(),auth.end()]);process.exitCode=1; }
