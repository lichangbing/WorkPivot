import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { AccountRepository } from '../packages/server/src/database/accounts.js';
import { BusinessFactsRepository } from '../packages/server/src/database/business-facts.js';
import { BusinessFactWorker } from '../packages/server/src/database/business-fact-worker.js';
import { createDatabaseApp } from '../packages/server/src/database/app.js';
import { installSchema, pool, transaction } from '../packages/server/src/database/connection.js';
import { WorkspaceRepository } from '../packages/server/src/database/workspace.js';
import { RunRepository } from '../packages/server/src/database/runs.js';

const url = process.env['WORKPIVOT_TEST_PG_URL'];
if (!url || process.env['WORKPIVOT_TEST_PG_DISPOSABLE'] !== '1') throw Error('Requires an explicitly disposable PostgreSQL instance');
const password = randomBytes(24).toString('hex');
const admin = pool(url);
await admin.query(`CREATE ROLE business_fact_app LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  CREATE ROLE business_fact_auth LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  CREATE ROLE workpivot_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  CREATE ROLE workpivot_auth NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
const appUrl = new URL(url); appUrl.username = 'business_fact_app'; appUrl.password = password;
const authUrl = new URL(url); authUrl.username = 'business_fact_auth'; authUrl.password = password;
const business = pool(appUrl.toString(), { max: 2 }), identity = pool(authUrl.toString(), { max: 2 });
let server: ReturnType<Awaited<ReturnType<typeof createDatabaseApp>>['listen']> | undefined;
try {
  await installSchema(admin, 'business_fact_app', 'business_fact_auth');
  const accounts = new AccountRepository(identity);
  const owner = await accounts.registerFirst('business-fact-owner', password);
  const member = await accounts.createUser(owner.token, 'business-fact-member', password, 'member', undefined, 10);
  const workspace = new WorkspaceRepository(business);
  const projectA = await workspace.createProject(owner.user.id, '合同项目 A');
  const projectB = await workspace.createProject(owner.user.id, '合同项目 B');
  const taskA = await workspace.createTask(owner.user.id, '合同金额核对', projectA.id);
  const taskB = await workspace.createTask(owner.user.id, '另一个合同', projectB.id);
  const temporary = await workspace.createTask(owner.user.id, '临时咨询');
  const facts = new BusinessFactsRepository(business);
  const app = await createDatabaseApp(identity, business, password);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server!.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No server port');
  const base = `http://127.0.0.1:${address.port}/api`;
  const headers = { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' };

  const first = await facts.createFact(owner.user.id, projectA.id, {
    object: { name: '合同 HT-001', type: 'contract', identifiers: [{ type: 'contract_no', value: 'HT-001' }] },
    predicate: 'contract.amount.total',
    valueType: 'number',
    value: '1000000',
    currency: 'CNY',
  });
  assert.equal(first.status, 'active');
  const listA = await facts.list(owner.user.id, projectA.id);
  const objectA = listA.objects.find((item: { name: string }) => item.name === '合同 HT-001');
  assert(objectA, 'project object created');
  assert.equal(listA.facts[0]?.valueNumber, '1000000');

  await facts.createFact(owner.user.id, projectB.id, {
    object: { name: '合同 HT-001', type: 'contract', identifiers: [{ type: 'contract_no', value: 'HT-001' }] },
    predicate: 'contract.amount.total',
    valueType: 'number',
    value: '2000000',
    currency: 'CNY',
  });
  const listB = await facts.list(owner.user.id, projectB.id);
  assert.notEqual(listA.facts[0]?.objectId, listB.facts[0]?.objectId, 'same identifier in two projects must not share object');
  assert.equal(listB.facts[0]?.valueNumber, '2000000');

  const change = await facts.createFact(owner.user.id, projectA.id, {
    object: { id: objectA.id, name: '合同 HT-001', type: 'contract' },
    predicate: 'contract.amount.total',
    valueType: 'number',
    value: '2000000',
    currency: 'CNY',
  });
  assert.equal(change.status, 'conflicted');
  const hidden = await facts.searchForTask(owner.user.id, taskA.id, 'HT-001');
  assert.equal(hidden.facts.length, 0, 'unconfirmed conflict must hide both values');
  assert.equal(hidden.conflicts.length, 1);

  await facts.decideConflict(owner.user.id, projectA.id, change.conflictId!, 1, true);
  const current = await facts.searchForTask(owner.user.id, taskA.id, 'HT-001');
  assert.equal(current.facts.length, 1);
  assert.equal(current.facts[0]?.valueNumber, '2000000');
  const history = await facts.history(owner.user.id, projectA.id, change.factId);
  assert.deepEqual(history.revisions.map((item: { status: string }) => item.status), ['superseded', 'active']);
  assert.equal(history.revisions[0]?.valueNumber, '1000000');
  const knownBeforeChange = new Date(new Date(history.revisions[1]!.recordedAt).getTime() - 1).toISOString();
  const validBeforeChange = new Date(new Date(history.revisions[1]!.validFrom).getTime() - 1).toISOString();
  const beforeChange = await facts.searchForTask(owner.user.id, taskA.id, 'HT-001', { asOf: validBeforeChange, knownAt: knownBeforeChange, includeHistory: true });
  assert.equal(beforeChange.facts[0]?.valueNumber, '1000000');
  const automatic = await facts.automaticContext(owner.user.id, taskA.id, '合同 HT-001 当前金额是多少');
  assert.equal(automatic.facts.some((fact: { valueNumber: string }) => fact.valueNumber === '2000000'), true);

  await assert.rejects(() => facts.updateFact(owner.user.id, projectA.id, change.factId, 1, { valueType: 'number', value: '3000000', currency: 'CNY' }), /已更新/);
  await assert.rejects(() => facts.createFact(owner.user.id, projectA.id, {
    object: { id: objectA.id, name: '合同 HT-001', type: 'contract' },
    predicate: 'contract.amount.total',
    valueType: 'number',
    value: '不是金额',
    currency: 'CNY',
  }), /数值无效/);
  const related = await facts.createRelation(owner.user.id, projectA.id, {
    subject: { name: '合同 HT-001', type: 'contract' },
    relationType: 'covers',
    object: { name: '产品北辰', type: 'product' },
  });
  assert.equal(related.created, true);
  const traced = await facts.traceRelations(owner.user.id, taskA.id, objectA.id, 1);
  assert(traced.relations.some((item: { objectName: string }) => item.objectName === '产品北辰'));
  await facts.forgetRelation(owner.user.id, projectA.id, related.relationId, 1);
  assert.equal((await facts.traceRelations(owner.user.id, taskA.id, objectA.id, 1)).relations.length, 0);
  const recreated = await facts.createRelation(owner.user.id, projectA.id, {
    subject: { name: '合同 HT-001', type: 'contract' },
    relationType: 'covers',
    object: { name: '产品北辰', type: 'product' },
  });
  assert.equal(recreated.revision, 2);

  const temporaryList = await facts.searchForTask(owner.user.id, temporary.id, '合同');
  assert.equal(temporaryList.projectId, null);
  await assert.rejects(() => facts.createFact(owner.user.id, temporary.id, {
    object: { name: '临时合同', type: 'contract' },
    predicate: 'contract.status',
    valueType: 'text',
    value: '待定',
  }), /项目不存在/);

  assert.equal((await fetch(`${base}/projects/${projectA.id}/business-facts`)).status, 401, 'route requires authentication');
  const routeCreate = await fetch(`${base}/projects/${projectB.id}/business-facts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      object: { name: '合同 HT-001', type: 'contract', identifiers: [{ type: 'contract_no', value: 'HT-001' }] },
      predicate: 'contract.status',
      valueType: 'text',
      value: '执行中',
    }),
  });
  assert.equal(routeCreate.status, 200);
  assert.equal((await routeCreate.json() as { status: string }).status, 'active');
  const routeList = await fetch(`${base}/projects/${projectB.id}/business-facts`, { headers });
  assert.equal(routeList.status, 200);
  assert.equal((await routeList.json() as { facts: Array<{ predicate: string }> }).facts.some(fact => fact.predicate === 'contract.status'), true);
  const temporaryRoute = await fetch(`${base}/tasks/${temporary.id}/business-facts?q=合同`, { headers });
  assert.equal((await temporaryRoute.json() as { projectId: string | null }).projectId, null);
  await assert.rejects(() => facts.list(member.id, projectA.id), /项目不存在/);

  const runs = new RunRepository(business);
  const sourceText = '合同 HT-001 当前金额为 2000000 元，币种为 CNY。合同覆盖产品北辰。';
  const run = await runs.start(owner.user.id, taskB.id, randomUUID(), sourceText);
  await runs.finish(owner.user.id, run, 'completed', [{ role: 'assistant', content: '已记录。' }]);
  const worker = new BusinessFactWorker(business, async () => ({
    providerId: 'fixture',
    model: 'fixture',
    async *streamChat() {
      yield {
        type: 'delta' as const,
        text: JSON.stringify({
          facts: [{
            objectName: '合同 HT-001',
            objectType: 'contract',
            identifierType: 'contract_no',
            identifierValue: 'HT-001',
            predicate: 'contract.amount.total',
            valueType: 'number',
            value: '2000000',
            currency: 'CNY',
            confidence: 0.98,
            evidence: '合同 HT-001 当前金额为 2000000 元，币种为 CNY。',
          }],
          relations: [{
            subjectName: '合同 HT-001',
            subjectType: 'contract',
            relationType: 'covers',
            objectName: '产品北辰',
            objectType: 'product',
            confidence: 0.96,
            evidence: '合同覆盖产品北辰。',
          }],
        }),
      };
    },
  }));
  await worker.enqueue(owner.user.id, taskB.id, run.id);
  assert.equal(await worker.process(owner.user.id), true);
  const job = (await transaction(business, c => c.query('SELECT status,error FROM workpivot.business_fact_job WHERE run_id=$1', [run.id]), owner.user.id)).rows[0];
  assert.equal(job?.status, 'completed', JSON.stringify(job));
  const autoList = await facts.list(owner.user.id, projectB.id);
  const amountFact = autoList.facts.find((fact: { predicate: string }) => fact.predicate === 'contract.amount.total');
  const amountHistory = await facts.history(owner.user.id, projectB.id, amountFact.id);
  assert.equal(amountHistory.revisions.some((revision: { evidence: Array<{ sourceKind: string }> }) => revision.evidence.some(evidence => evidence.sourceKind === 'conversation')), true);
  assert.equal(autoList.relations.some((relation: { relationType: string }) => relation.relationType === 'covers'), true);

  await facts.forgetFact(owner.user.id, projectA.id, change.factId, 2);
  const forgotten = await facts.searchForTask(owner.user.id, taskA.id, 'HT-001');
  assert.equal(forgotten.facts.length, 0, 'forgotten fact must disappear');
  const resurrected = await facts.createFact(owner.user.id, projectA.id, {
    object: { id: objectA.id, name: '合同 HT-001', type: 'contract' },
    predicate: 'contract.amount.total',
    valueType: 'number',
    value: '2500000',
    currency: 'CNY',
  });
  assert.equal(resurrected.revision, 3);
  await facts.forgetFact(owner.user.id, projectA.id, change.factId, 3);
  const currentTaskB = (await workspace.listTasks(owner.user.id)).find(task => task.id === taskB.id)!;
  await workspace.deleteTask(owner.user.id, taskB.id, currentTaskB.revision);
  const sourceSeries = (await transaction(business, c => c.query('SELECT status FROM workpivot.business_fact_series WHERE id=$1', [amountFact.id]), owner.user.id)).rows[0];
  assert.equal(sourceSeries.status, 'forgotten');
  await workspace.deleteProject(owner.user.id, projectA.id, projectA.revision);
  await assert.rejects(() => facts.list(owner.user.id, projectA.id), /项目不存在/);
  console.log('Business facts DB/API/worker: 29/29 passed');
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server!.close(() => resolve()));
  }
  await Promise.all([business.end(), identity.end(), admin.end()]);
}
