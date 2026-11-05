import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  parseClientUpdateEnvelope,
  parseClientUpdateManifest,
  type ClientUpdateManifest,
} from '../packages/shared/src/client-update.js';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) throw new Error('用法：pnpm update:manifest <输入JSON> <输出JSON>');
const source = JSON.parse(await readFile(resolve(inputPath), 'utf8')) as {
  generatedAt?: string;
  updates?: Array<Omit<ClientUpdateManifest, 'sha256'> & { artifact: string }>;
};
if (!Array.isArray(source.updates) || !source.updates.length) throw new Error('更新配置没有 updates');
const updates: ClientUpdateManifest[] = [];
for (const item of source.updates) {
  if (!item || typeof item.artifact !== 'string') throw new Error('更新项缺少 artifact');
  const artifact = resolve(item.artifact);
  const data = await readFile(artifact);
  const metadata = { ...item };
  delete (metadata as Partial<typeof item>).artifact;
  updates.push(parseClientUpdateManifest({
    ...metadata,
    sha256: createHash('sha256').update(data).digest('hex'),
  }));
}
const envelope = parseClientUpdateEnvelope({ generatedAt: source.generatedAt ?? new Date().toISOString(), updates });
await writeFile(resolve(outputPath), JSON.stringify(envelope, null, 2) + '\n');
console.log(`客户端更新清单已写入 ${resolve(outputPath)}`);
