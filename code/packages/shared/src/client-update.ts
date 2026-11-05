export type ClientUpdatePlatform = 'android' | 'windows' | 'web';

export interface ClientUpdateManifest {
  channel: string;
  platform: ClientUpdatePlatform;
  version: string;
  build: number;
  minimumBuild: number;
  downloadUrl: string;
  sha256: string;
  packageName?: string;
  signerSha256?: string;
  minimumApiProtocol: number;
  maximumApiProtocol: number;
  releaseNotesUrl?: string;
  mandatory?: boolean;
  publishedAt: string;
}

export interface ClientUpdateEnvelope {
  generatedAt: string;
  updates: ClientUpdateManifest[];
}

/** 客户端与发布脚本共用严格清单校验，避免不安全 URL、降级或错平台制品进入安装链路。 */
export function parseClientUpdateManifest(value: unknown): ClientUpdateManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('更新清单格式无效');
  const row = value as Record<string, unknown>;
  const platform = row['platform'];
  if (platform !== 'android' && platform !== 'windows' && platform !== 'web') throw new Error('更新平台无效');
  const channel = text(row['channel'], '更新渠道', 40);
  const version = text(row['version'], '版本号', 80);
  const build = positiveInteger(row['build'], '构建号');
  const minimumBuild = positiveInteger(row['minimumBuild'], '最低版本');
  if (minimumBuild > build) throw new Error('最低版本不能高于当前版本');
  const minimumApiProtocol = positiveInteger(row['minimumApiProtocol'], '最低协议');
  const maximumApiProtocol = positiveInteger(row['maximumApiProtocol'], '最高协议');
  if (minimumApiProtocol > maximumApiProtocol) throw new Error('协议范围无效');
  const downloadUrl = text(row['downloadUrl'], '下载地址', 2048);
  let parsed: URL;
  try { parsed = new URL(downloadUrl); } catch { throw new Error('下载地址无效'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('下载地址必须是无凭据 HTTPS 地址');
  const sha256 = text(row['sha256'], '文件摘要', 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('文件摘要必须是 SHA-256');
  const publishedAt = text(row['publishedAt'], '发布时间', 80);
  if (Number.isNaN(Date.parse(publishedAt))) throw new Error('发布时间无效');
  const packageName = optionalText(row['packageName'], 200);
  const signerSha256 = optionalText(row['signerSha256'], 64)?.toLowerCase();
  if (signerSha256 !== undefined && !/^[a-f0-9]{64}$/.test(signerSha256)) throw new Error('签名摘要必须是 SHA-256');
  const releaseNotesUrl = optionalText(row['releaseNotesUrl'], 2048);
  if (releaseNotesUrl) {
    let url: URL;
    try { url = new URL(releaseNotesUrl); } catch { throw new Error('发布说明地址无效'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('发布说明必须是 HTTPS 地址');
  }
  const mandatory = row['mandatory'];
  if (mandatory !== undefined && typeof mandatory !== 'boolean') throw new Error('强制更新标记无效');
  if (platform === 'android' && (!packageName || !signerSha256)) throw new Error('Android 更新缺少包名或签名摘要');
  return {
    channel, platform, version, build, minimumBuild, downloadUrl, sha256,
    ...(packageName ? { packageName } : {}),
    ...(signerSha256 ? { signerSha256 } : {}),
    minimumApiProtocol, maximumApiProtocol,
    ...(releaseNotesUrl ? { releaseNotesUrl } : {}),
    ...(mandatory ? { mandatory } : {}),
    publishedAt,
  };
}

export function parseClientUpdateEnvelope(value: unknown): ClientUpdateEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('更新清单格式无效');
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row['updates'])) throw new Error('更新列表无效');
  const updates = row['updates'].map(parseClientUpdateManifest);
  const generatedAt = typeof row['generatedAt'] === 'string' && !Number.isNaN(Date.parse(row['generatedAt'])) ? row['generatedAt'] : new Date().toISOString();
  return { generatedAt, updates };
}

export function selectClientUpdate(
  envelope: ClientUpdateEnvelope,
  input: { platform: ClientUpdatePlatform; channel: string; build: number; apiProtocol: number },
): ClientUpdateManifest | null {
  const candidates = envelope.updates.filter(update =>
    update.platform === input.platform
    && update.channel === input.channel
    && update.build > input.build
    && input.build >= update.minimumBuild
    && input.apiProtocol >= update.minimumApiProtocol
    && input.apiProtocol <= update.maximumApiProtocol,
  ).sort((left, right) => right.build - left.build);
  return candidates[0] ?? null;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label}无效`);
  return value.trim();
}
function optionalText(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return text(value, '清单字段', max);
}
function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label}必须是正整数`);
  return value as number;
}
