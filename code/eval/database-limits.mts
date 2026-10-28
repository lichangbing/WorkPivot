import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelClient } from '@workpivot/core';
import { AccountRepository } from '../packages/server/src/database/accounts.js';
import { installSchema, pool, RepositoryError } from '../packages/server/src/database/connection.js';
import { DailyLimits } from '../packages/server/src/database/daily-limits.js';
import { FileRepository } from '../packages/server/src/database/files.js';
import { RunRepository } from '../packages/server/src/database/runs.js';
import { UsageRepository } from '../packages/server/src/database/usage.js';
import { WorkspaceRepository } from '../packages/server/src/database/workspace.js';

const url = process.env['WORKPIVOT_TEST_PG_URL'];
if (!url || process.env['WORKPIVOT_TEST_PG_DISPOSABLE'] !== '1') throw Error('Requires an explicitly disposable PostgreSQL instance');
const admin = pool(url);
const appPassword = randomBytes(24).toString('hex'), authPassword = randomBytes(24).toString('hex');
await admin.query(`CREATE ROLE limits_app LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  CREATE ROLE limits_auth LOGIN PASSWORD '${authPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  CREATE ROLE workpivot_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  CREATE ROLE workpivot_auth NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
const appUrl = new URL(url); appUrl.username = 'limits_app'; appUrl.password = appPassword;
const authUrl = new URL(url); authUrl.username = 'limits_auth'; authUrl.password = authPassword;
const app = pool(appUrl.toString(), { max: 4 }), auth = pool(authUrl.toString(), { max: 4 });
let checks = 0;
const check = (value: unknown, label: string) => { assert.ok(value, label); checks++; console.log('✅ ' + label); };
const rejectStatus = async (action: () => Promise<unknown>, status: number, label: string) => {
  await assert.rejects(action, error => error instanceof RepositoryError && error.status === status);
  check(true, label);
};
const root = await mkdtemp(join(tmpdir(), 'workpivot-limits-'));
try {
  await installSchema(admin, 'limits_app', 'limits_auth');
  check((await admin.query('SELECT count(*)::int AS n FROM workpivot_meta.schema_versions')).rows[0].n === 64, 'schema v64 installed');
  const privileges = (await app.query(`SELECT
    has_column_privilege(current_user,'identity.users','platform_admin','SELECT') AS platform,
    has_column_privilege(current_user,'identity.users','token_quota','SELECT') AS token,
    has_column_privilege(current_user,'identity.users','tokens_used','SELECT,UPDATE') AS used,
    has_column_privilege(current_user,'identity.users','usage_period_started_at','SELECT,UPDATE') AS period`)).rows[0];
  check(privileges.platform && privileges.token && privileges.used && privileges.period, `runtime role can read and update limit counters only ${JSON.stringify(privileges)}`);
  const accounts = new AccountRepository(auth);
  const owner = await accounts.registerFirst('owner', 'owner-password');
  const member = await accounts.createUser(owner.token, 'managed', 'member-password', 'member');
  check(member.messageQuota === 0 && member.tokenQuota === 0 && member.uploadQuotaBytes === 0 && member.concurrentTaskLimit === 0, 'administrator-created user has no limits by default');

  const policy = await accounts.adminAccessPolicy(owner.token);
  await accounts.updateAccessPolicy(owner.token, {
    registrationMode: 'open',
    defaultMessageQuota: 7,
    defaultTokenQuota: 8000,
    defaultUploadQuotaBytes: 1048576,
    defaultConcurrentTaskLimit: 2,
    revision: policy.revision,
  });
  const self = await accounts.register('self-user', 'self-password');
  check(self.user.messageQuota === 7 && self.user.tokenQuota === 8000 && self.user.uploadQuotaBytes === 1048576 && self.user.concurrentTaskLimit === 2, 'self-register uses configured default limits');

  const limits = new DailyLimits(auth, app);
  const initial = await limits.overview(owner.token);
  check(initial.users.find(row => row.username === 'managed')?.provisioningSource === 'admin', 'limit overview identifies administrator-created accounts');
  const managed = initial.users.find(row => row.id === member.id)!;
  await limits.updateUser(owner.token, member.id, {
    messageQuota: 5,
    tokenQuota: 100,
    uploadQuotaBytes: 6,
    concurrentTaskLimit: 1,
    revision: managed.revision,
  });
  await rejectStatus(() => limits.updateUser(owner.token, member.id, {
    messageQuota: 0, tokenQuota: 0, uploadQuotaBytes: 0, concurrentTaskLimit: 0, revision: managed.revision,
  }), 409, 'stale limit revision rejected');

  const usage = new UsageRepository(app);
  const actual: ModelClient = {
    providerId: randomUUID(),
    model: 'synthetic-limit',
    async *streamChat() { yield { type: 'usage', inputTokens: 100, outputTokens: 20 }; },
  };
  for await (const event of usage.wrap(member.id, actual, { inputPrice: null, outputPrice: null, currency: 'CNY' }).streamChat([{ role: 'user', content: 'limit' }], [])) { void event; }
  check((await limits.overview(owner.token)).users.find(row => row.id === member.id)?.usage.tokens === 120, 'token usage charges provider totals');
  await rejectStatus(async () => {
    for await (const event of usage.wrap(member.id, actual, { inputPrice: null, outputPrice: null, currency: 'CNY' }).streamChat([{ role: 'user', content: 'again' }], [])) { void event; }
  }, 429, 'daily token limit blocks another model request');
  const streamLimited = await accounts.createUser(owner.token, 'stream-limit', 'stream-password', 'member');
  const streamRevision = (await limits.overview(owner.token)).users.find(row => row.id === streamLimited.id)!.revision;
  await limits.updateUser(owner.token, streamLimited.id, {
    messageQuota: 0, tokenQuota: 100, uploadQuotaBytes: 0, concurrentTaskLimit: 0, revision: streamRevision,
  });
  const runaway: ModelClient = {
    providerId: randomUUID(),
    model: 'synthetic-runaway',
    async *streamChat() { yield { type: 'delta', text: '长'.repeat(4000) }; },
  };
  await rejectStatus(async () => {
    for await (const event of usage.wrap(streamLimited.id, runaway, { inputPrice: null, outputPrice: null, currency: 'CNY' }).streamChat([{ role: 'user', content: 'run' }], [])) { void event; }
  }, 429, 'token limit stops an overlong stream before completion');

  const workspace = new WorkspaceRepository(app), files = new FileRepository(app, root);
  const uploadTask = await workspace.createTask(member.id, 'upload limit');
  await files.upload(member.id, uploadTask.id, 'a.txt', Buffer.from('1234'), randomUUID());
  await rejectStatus(() => files.upload(member.id, uploadTask.id, 'b.txt', Buffer.from('1234'), randomUUID()), 429, 'daily upload limit blocks excess bytes');

  await accounts.resetUserQuota(owner.token, member.id);
  const firstTask = await workspace.createTask(member.id, 'concurrency one');
  const secondTask = await workspace.createTask(member.id, 'concurrency two');
  const runs = new RunRepository(app);
  const firstRun = await runs.start(member.id, firstTask.id, randomUUID(), 'first');
  await rejectStatus(() => runs.start(member.id, secondTask.id, randomUUID(), 'second'), 429, 'concurrent task limit blocks a second run');
  await runs.finish(member.id, firstRun, 'completed', []);
  const secondRun = await runs.start(member.id, secondTask.id, randomUUID(), 'second retry');
  check(Boolean(secondRun.id), 'second task starts after the first run finishes');
  await runs.finish(member.id, secondRun, 'completed', []);

  const ownerRevision = (await limits.overview(owner.token)).users.find(row => row.id === owner.user.id)!.revision;
  await rejectStatus(() => limits.updateUser(owner.token, owner.user.id, {
    messageQuota: 0, tokenQuota: 0, uploadQuotaBytes: 0, concurrentTaskLimit: 0,
    revision: ownerRevision,
  }), 400, 'platform administrator limits remain protected');
  console.log(`限额专项通过：${checks} 项。`);
} finally {
  await Promise.all([app.end(), auth.end(), admin.end()]);
  await rm(root, { recursive: true, force: true });
}
