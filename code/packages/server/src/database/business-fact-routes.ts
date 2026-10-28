import { Router, type Response } from 'express';
import type { Pool } from 'pg';
import { RepositoryError } from './connection.js';
import {
  BusinessFactsRepository,
  type BusinessFactInput,
  type BusinessFactValueInput,
  type BusinessModelKey,
  type BusinessObjectInput,
  type TableImportMapping,
} from './business-facts.js';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RepositoryError(400, '请求内容无效');
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new RepositoryError(400, `${field}无效`);
  return value;
}

function actor(res: Response): string {
  return (res.locals['user'] as { id: string }).id;
}

function objectInput(value: unknown): BusinessObjectInput {
  const body = record(value);
  return {
    ...(body.id === undefined ? {} : { id: text(body.id, '对象 ID') }),
    name: text(body.name, '对象名称'),
    type: text(body.type ?? body.objectType, '对象类型'),
    ...(body.aliases === undefined ? {} : { aliases: body.aliases as string[] }),
    ...(body.identifiers === undefined ? {} : { identifiers: body.identifiers as BusinessObjectInput['identifiers'] }),
  };
}

function valueInput(value: Record<string, unknown>): BusinessFactValueInput {
  return {
    valueType: value.valueType as BusinessFactValueInput['valueType'],
    value: value.value,
    ...(value.valueObjectId === undefined ? {} : { valueObjectId: text(value.valueObjectId, '对象值') }),
    ...(value.unit === undefined ? {} : { unit: text(value.unit, '单位') }),
    ...(value.currency === undefined ? {} : { currency: text(value.currency, '币种') }),
    ...(value.dimensions === undefined ? {} : { dimensions: record(value.dimensions) as Record<string, string | number | boolean> }),
  };
}

export function businessFactRoutes(db: Pool): Router {
  const router = Router();
  const facts = new BusinessFactsRepository(db);

  router.get('/business-facts/settings', async (_req, res) => {
    res.json(await facts.settings(actor(res)));
  });
  router.put('/business-facts/settings', async (req, res) => {
    const body = record(req.body);
    if (typeof body.enabled !== 'boolean') throw new RepositoryError(400, '自动提取开关无效');
    res.json(await facts.setAutoExtraction(actor(res), body.enabled, Number(body.revision)));
  });
  router.get('/projects/:projectId/business-facts', async (req, res) => {
    res.json(await facts.list(actor(res), text(req.params['projectId'], '项目 ID'), req.query['q'] === undefined ? '' : text(req.query['q'], '查询词')));
  });
  router.put('/projects/:projectId/business-profile', async (req, res) => {
    const modelKey = text(record(req.body).modelKey, '领域模型') as BusinessModelKey;
    const profile = await facts.updateProfile(actor(res), text(req.params['projectId'], '项目 ID'), modelKey);
    res.json({ profile, modelKey });
  });
  router.post('/projects/:projectId/business-facts', async (req, res) => {
    const body = record(req.body);
    const input: BusinessFactInput = {
      object: objectInput(body.object),
      predicate: text(body.predicate, '事实属性'),
      ...valueInput(body),
      ...(body.validFrom === undefined ? {} : { validFrom: text(body.validFrom, '生效时间') }),
    };
    res.json(await facts.createFact(actor(res), text(req.params['projectId'], '项目 ID'), input));
  });
  router.put('/projects/:projectId/business-facts/:factId', async (req, res) => {
    const body = record(req.body);
    res.json(await facts.updateFact(
      actor(res),
      text(req.params['projectId'], '项目 ID'),
      text(req.params['factId'], '事实 ID'),
      Number(body.revision),
      valueInput(body),
      body.validFrom === undefined ? undefined : text(body.validFrom, '生效时间'),
    ));
  });
  router.delete('/projects/:projectId/business-facts/:factId', async (req, res) => {
    await facts.forgetFact(actor(res), text(req.params['projectId'], '项目 ID'), text(req.params['factId'], '事实 ID'), Number(record(req.body).revision));
    res.json({ ok: true });
  });
  router.get('/projects/:projectId/business-facts/:factId/history', async (req, res) => {
    res.json(await facts.history(actor(res), text(req.params['projectId'], '项目 ID'), text(req.params['factId'], '事实 ID')));
  });
  router.post('/projects/:projectId/business-fact-imports/preview', async (req, res) => {
    const body = record(req.body);
    const dimensions = body.dimensions === undefined ? undefined : Object.fromEntries(Object.entries(record(body.dimensions)).map(([key, value]) => [key, text(value, `维度列 ${key}`)]));
    const mapping: TableImportMapping = {
      taskId: text(body.taskId, '任务 ID'),
      versionId: text(body.versionId, '文件版本 ID'),
      subjectColumn: text(body.subjectColumn, '主体列'),
      valueColumn: text(body.valueColumn, '值列'),
      ...(body.identifierColumn === undefined ? {} : { identifierColumn: text(body.identifierColumn, '标识列') }),
      objectType: text(body.objectType, '对象类型'),
      predicate: text(body.predicate, '事实属性'),
      ...(body.sheet === undefined ? {} : { sheet: text(body.sheet, '工作表') }),
      ...(body.headerRow === undefined ? {} : { headerRow: Number(body.headerRow) }),
      ...(body.unit === undefined ? {} : { unit: text(body.unit, '单位') }),
      ...(body.currency === undefined ? {} : { currency: text(body.currency, '币种') }),
      ...(dimensions === undefined ? {} : { dimensions }),
    };
    res.json(await facts.previewTableImport(actor(res), text(req.params['projectId'], '项目 ID'), mapping));
  });
  router.post('/projects/:projectId/business-fact-imports/:importId/confirm', async (req, res) => {
    const body = record(req.body);
    if (!Array.isArray(body.selectedOrdinals)) throw new RepositoryError(400, '候选选择无效');
    res.json(await facts.confirmTableImport(
      actor(res), text(req.params['projectId'], '项目 ID'), text(req.params['importId'], '导入预览 ID'),
      Number(body.revision), body.selectedOrdinals.map(value => Number(value)),
    ));
  });
  router.post('/projects/:projectId/business-fact-imports/:importId/reject', async (req, res) => {
    const body = record(req.body);
    res.json(await facts.rejectTableImport(
      actor(res), text(req.params['projectId'], '项目 ID'), text(req.params['importId'], '导入预览 ID'), Number(body.revision),
    ));
  });
  router.post('/projects/:projectId/business-entities/:sourceId/merge', async (req, res) => {
    const body = record(req.body);
    res.json(await facts.mergeObjects(
      actor(res),
      text(req.params['projectId'], '项目 ID'),
      text(req.params['sourceId'], '来源对象 ID'),
      text(body.targetId, '目标对象 ID'),
      Number(body.sourceRevision),
      Number(body.targetRevision),
    ));
  });
  router.post('/projects/:projectId/business-object-merges/:mergeId/revert', async (req, res) => {
    const body = record(req.body);
    res.json(await facts.revertObjectMerge(
      actor(res),
      text(req.params['projectId'], '项目 ID'),
      text(req.params['mergeId'], '合并记录 ID'),
      Number(body.revision),
      Number(body.sourceRevision),
      Number(body.targetRevision),
    ));
  });
  router.post('/projects/:projectId/business-fact-conflicts/:conflictId/decision', async (req, res) => {
    const body = record(req.body);
    if (typeof body.accept !== 'boolean') throw new RepositoryError(400, '需要明确确认或拒绝');
    res.json(await facts.decideConflict(actor(res), text(req.params['projectId'], '项目 ID'), text(req.params['conflictId'], '冲突 ID'), Number(body.revision), body.accept));
  });
  router.post('/projects/:projectId/business-relations', async (req, res) => {
    const body = record(req.body);
    res.json(await facts.createRelation(actor(res), text(req.params['projectId'], '项目 ID'), {
      subject: objectInput(body.subject),
      relationType: text(body.relationType, '关系类型'),
      object: objectInput(body.object),
      ...(body.validFrom === undefined ? {} : { validFrom: text(body.validFrom, '生效时间') }),
    }));
  });
  router.delete('/projects/:projectId/business-relations/:relationId', async (req, res) => {
    await facts.forgetRelation(actor(res), text(req.params['projectId'], '项目 ID'), text(req.params['relationId'], '关系 ID'), Number(record(req.body).revision));
    res.json({ ok: true });
  });
  router.get('/tasks/:taskId/business-facts', async (req, res) => {
    res.json(await facts.searchForTask(actor(res), text(req.params['taskId'], '任务 ID'), req.query['q'] === undefined ? '' : text(req.query['q'], '查询词'), {
      ...(req.query['objectType'] === undefined ? {} : { objectType: text(req.query['objectType'], '对象类型') }),
      ...(req.query['asOf'] === undefined ? {} : { asOf: text(req.query['asOf'], '查询时间') }),
      ...(req.query['knownAt'] === undefined ? {} : { knownAt: text(req.query['knownAt'], '记录时间') }),
      ...(req.query['history'] === undefined ? {} : { includeHistory: req.query['history'] === '1' }),
    }));
  });
  return router;
}
