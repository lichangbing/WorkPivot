import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { AccountRepository } from '../packages/server/src/database/accounts.js';
import { BusinessFactsRepository } from '../packages/server/src/database/business-facts.js';
import { BusinessFactWorker } from '../packages/server/src/database/business-fact-worker.js';
import { createDatabaseApp } from '../packages/server/src/database/app.js';
import { installSchema, pool, transaction } from '../packages/server/src/database/connection.js';
import { WorkspaceRepository } from '../packages/server/src/database/workspace.js';
import { RunRepository } from '../packages/server/src/database/runs.js';
import { parserFingerprint } from '../packages/server/src/database/document-parser.js';

const url = process.env['WORKPIVOT_TEST_PG_URL'];
if (!url || process.env['WORKPIVOT_TEST_PG_DISPOSABLE'] !== '1') throw Error('Requires an explicitly disposable PostgreSQL instance');
const password = randomBytes(24).toString('hex');
const admin = pool(url);
await admin.query(`DO $$
  BEGIN
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='business_fact_app') THEN
      CREATE ROLE business_fact_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='business_fact_auth') THEN
      CREATE ROLE business_fact_auth LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='workpivot_app') THEN
      CREATE ROLE workpivot_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='workpivot_auth') THEN
      CREATE ROLE workpivot_auth NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
  END $$;
  ALTER ROLE business_fact_app PASSWORD '${password}';
  ALTER ROLE business_fact_auth PASSWORD '${password}';`);
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

  const duplicateFact = await facts.createFact(owner.user.id, projectA.id, {
    object: { name: '合同 HT-001（旧称）', type: 'contract', aliases: ['星海合同'], identifiers: [{ type: 'contract_no', value: 'HT-001-OLD' }] },
    predicate: 'contract.status',
    valueType: 'text',
    value: '待签',
  });
  const targetSeries = await facts.createFact(owner.user.id, projectA.id, {
    object: { id: objectA.id, name: '合同 HT-001', type: 'contract' },
    predicate: 'contract.valid_from',
    valueType: 'date',
    value: '2026-10-01',
  });
  let entityList = await facts.list(owner.user.id, projectA.id);
  const duplicateObject = entityList.objects.find((item: { name: string }) => item.name === '合同 HT-001（旧称）');
  const canonicalObject = entityList.objects.find((item: { id: string }) => item.id === objectA.id);
  assert(duplicateObject && canonicalObject, 'duplicate and canonical objects exist');
  assert(entityList.mergeCandidates.some((candidate: { sourceId: string; targetId: string }) =>
    new Set([candidate.sourceId, candidate.targetId]).has(duplicateObject.id) &&
    new Set([candidate.sourceId, candidate.targetId]).has(canonicalObject.id)), 'similar entities produce a merge candidate');

  const mergedEntity = await facts.mergeObjects(
    owner.user.id, projectA.id, duplicateObject.id, canonicalObject.id, duplicateObject.revision, canonicalObject.revision,
  );
  assert.equal(mergedEntity.factsMoved, 1);
  entityList = await facts.list(owner.user.id, projectA.id);
  assert.equal(entityList.objects.some((item: { id: string }) => item.id === duplicateObject.id), false, 'merged source leaves active object list');
  assert(entityList.facts.filter((fact: { id: string }) => [duplicateFact.factId, targetSeries.factId].includes(fact.id))
    .every((fact: { objectId: string }) => fact.objectId === canonicalObject.id), 'merged facts point to canonical object');
  assert(entityList.merges.some((item: { id: string; status: string }) => item.id === mergedEntity.mergeId && item.status === 'active'), 'merge history is visible');
  assert.equal((await facts.searchForTask(owner.user.id, taskA.id, '星海合同')).facts.some((fact: { objectId: string }) => fact.objectId === canonicalObject.id), true, 'moved alias remains searchable');

  const mergedSourceRevision = Number((await transaction(business, c =>
    c.query('SELECT revision FROM workpivot.business_object WHERE project_id=$1 AND id=$2', [projectA.id, duplicateObject.id]), owner.user.id)).rows[0]?.revision);
  const mergedTargetRevision = Number((await transaction(business, c =>
    c.query('SELECT revision FROM workpivot.business_object WHERE project_id=$1 AND id=$2', [projectA.id, canonicalObject.id]), owner.user.id)).rows[0]?.revision);
  await facts.revertObjectMerge(owner.user.id, projectA.id, mergedEntity.mergeId, 1, mergedSourceRevision, mergedTargetRevision);
  entityList = await facts.list(owner.user.id, projectA.id);
  assert.equal(entityList.objects.some((item: { id: string }) => item.id === duplicateObject.id), true, 'split restores source object');
  assert.equal(entityList.facts.find((fact: { id: string }) => fact.id === duplicateFact.factId)?.objectId, duplicateObject.id, 'split restores moved fact ownership');

  const collisionA = await facts.createFact(owner.user.id, projectA.id, {
    object: { name: '供应商 星海', type: 'supplier' },
    predicate: 'contract.status',
    valueType: 'text',
    value: '候选甲',
  });
  const collisionB = await facts.createFact(owner.user.id, projectA.id, {
    object: { name: '供应商星海公司', type: 'supplier' },
    predicate: 'contract.status',
    valueType: 'text',
    value: '候选乙',
  });
  const collisionList = await facts.list(owner.user.id, projectA.id);
  const collisionSource = collisionList.objects.find((item: { id: string }) => item.id ===
    collisionList.facts.find((fact: { id: string }) => fact.id === collisionA.factId)?.objectId);
  const collisionTarget = collisionList.objects.find((item: { id: string }) => item.id ===
    collisionList.facts.find((fact: { id: string }) => fact.id === collisionB.factId)?.objectId);
  assert(collisionSource && collisionTarget);
  await assert.rejects(() => facts.mergeObjects(
    owner.user.id, projectA.id, collisionSource.id, collisionTarget.id, collisionSource.revision, collisionTarget.revision,
  ), /事实.*冲突/, 'merge rejects fact-key collisions instead of mixing values');

  const importVersion = randomUUID(), importDocument = randomUUID(), importRequest = randomUUID();
  const importParts = [
    { location: 'sheet:客户', text: '', object: { kind: 'sheet', sheet: '客户', state: 'visible', dateSystem: '1900' } },
    { location: 'sheet:客户!A1', text: '客户名称', object: { kind: 'cell', parent: 'sheet:客户', sheet: '客户', address: 'A1', row: 1, column: 1, headerRow: 'true', valueType: 's', rawValue: '客户名称', dateSystem: '1900' } },
    { location: 'sheet:客户!B1', text: '合同金额', object: { kind: 'cell', parent: 'sheet:客户', sheet: '客户', address: 'B1', row: 1, column: 2, headerRow: 'true', valueType: 's', rawValue: '合同金额', dateSystem: '1900' } },
    { location: 'sheet:客户!C1', text: '合同编号', object: { kind: 'cell', parent: 'sheet:客户', sheet: '客户', address: 'C1', row: 1, column: 3, headerRow: 'true', valueType: 's', rawValue: '合同编号', dateSystem: '1900' } },
    { location: 'sheet:客户!A2', text: '客户星河', object: { kind: 'cell', parent: 'sheet:客户', sheet: '客户', address: 'A2', row: 2, column: 1, headerRow: 'false', valueType: 's', rawValue: '客户星河', dateSystem: '1900' } },
    { location: 'sheet:客户!B2', text: '1250.50', object: { kind: 'cell', parent: 'sheet:客户', sheet: '客户', address: 'B2', row: 2, column: 2, headerRow: 'false', valueType: 'n', rawValue: '1250.50', dateSystem: '1900' } },
    { location: 'sheet:客户!C2', text: 'KH-XH-01', object: { kind: 'cell', parent: 'sheet:客户', sheet: '客户', address: 'C2', row: 2, column: 3, headerRow: 'false', valueType: 's', rawValue: 'KH-XH-01', dateSystem: '1900' } },
  ];
  await transaction(business, async c => {
    await c.query(`INSERT INTO workpivot.documents(id,owner_user_id,task_id,revision,purpose)
      VALUES($1,$2,$3,1,'upload')`, [importDocument, owner.user.id, taskA.id]);
    await c.query(`INSERT INTO workpivot.document_versions(id,owner_user_id,document_id,revision,request_id,name,size,sha256)
      VALUES($1,$2,$3,1,$4,'客户合同.xlsx',1024,$5)`,
    [importVersion, owner.user.id, importDocument, importRequest, 'a'.repeat(64)]);
    await c.query(`INSERT INTO workpivot.document_processing(version_id,owner_user_id,status,parts,parser_fingerprint,coverage)
      VALUES($1,$2,'completed',$3::jsonb,$4,'text-only')`, [importVersion, owner.user.id, JSON.stringify(importParts), parserFingerprint]);
  }, owner.user.id);
  const preview = await facts.previewTableImport(owner.user.id, projectA.id, {
    taskId: taskA.id,
    versionId: importVersion,
    subjectColumn: '客户名称',
    valueColumn: '合同金额',
    identifierColumn: '合同编号',
    objectType: 'customer',
    predicate: 'contract.amount.total',
    sheet: '客户',
    currency: 'CNY',
  });
  assert.equal(preview.candidates.length, 1);
  assert.equal(preview.candidates[0]?.valueType, 'number');
  assert.match(preview.candidates[0]?.evidence ?? '', /客户星河.*1250\.50/);
  const imported = await facts.confirmTableImport(owner.user.id, projectA.id, preview.id, preview.revision, [0]);
  assert.equal(imported.imported, 1);
  const importedFact = (await facts.list(owner.user.id, projectA.id)).facts.find((item: { objectName: string }) => item.objectName === '客户星河');
  assert.equal(importedFact?.valueNumber, '1250.50');
  assert.equal(importedFact?.currency, 'CNY');
  const importedHistory = await facts.history(owner.user.id, projectA.id, importedFact!.id);
  assert.match(importedHistory.revisions[0]?.evidence[0]?.quote ?? '', /客户名称.*合同金额/);
  await assert.rejects(() => facts.previewTableImport(owner.user.id, projectA.id, {
    taskId: taskA.id,
    versionId: importVersion,
    subjectColumn: '客户名称',
    valueColumn: '合同金额',
    objectType: 'customer',
    predicate: 'contract.amount.total',
  }), /已经确认导入/);

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
  await workspace.addProjectMember(owner.user.id, projectA.id, member.id, 'reader');
  assert.equal((await facts.list(member.id, projectA.id)).facts.length > 0, true, 'project reader can access shared business facts');
  await assert.rejects(() => facts.createFact(member.id, projectA.id, {
    object: { name: '只读成员合同', type: 'contract' },
    predicate: 'contract.status',
    valueType: 'text',
    value: '不应写入',
  }), /权限|拒绝|策略|policy/);
  await workspace.addProjectMember(owner.user.id, projectA.id, member.id, 'editor');
  const editorFact = await facts.createFact(member.id, projectA.id, {
    object: { name: '编辑成员合同', type: 'contract' },
    predicate: 'contract.status',
    valueType: 'text',
    value: '允许写入',
  });
  assert.equal(editorFact.status, 'active');
  assert.equal((await facts.list(owner.user.id, projectA.id)).facts.some((fact: { objectName: string }) => fact.objectName === '编辑成员合同'), true, 'project owner sees editor-shared fact');
  await workspace.removeProjectMember(owner.user.id, projectA.id, member.id);
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
  assert.equal(forgotten.facts.some((fact: { id: string }) => fact.id === change.factId), false, 'forgotten fact must disappear');
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
  console.log('Business facts DB/API/worker with reversible entity governance: passed');
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server!.close(() => resolve()));
  }
  await Promise.all([business.end(), identity.end(), admin.end()]);
}
