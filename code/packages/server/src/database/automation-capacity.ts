import type {PoolClient} from 'pg';
export async function lockAutomationCapacity(c:PoolClient,actor:string){
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['automation-capacity:'+actor]);
}
export async function automationCapacity(c:PoolClient){
 const limits=(await c.query('SELECT enabled_limit AS "enabledLimit",queued_limit AS "queuedLimit",revision FROM workpivot.automation_capacity')).rows[0]??{enabledLimit:20,queuedLimit:10,revision:0};
 const enabled=(await c.query("SELECT count(*)::int AS n FROM workpivot.automations WHERE state='enabled'")).rows[0].n as number;
 const queued=(await c.query("SELECT count(*)::int AS n FROM workpivot.automation_runs WHERE status IN ('queued','waiting_login')")).rows[0].n as number;
 return {...limits,enabled,queued};
}
