/**
 * K05 开源合规：依赖许可黑名单检查。
 * 命中 AGPL / PolyForm（传染性或非商业）即退出码 1，阻塞合并/发布。
 * 运行：pnpm check:licenses（扫描 node_modules/.pnpm 下全部依赖包）
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DENY_PATTERNS = [/AGPL/i, /PolyForm/i];

function normalizeLicense(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(normalizeLicense);
  if (value && typeof value === 'object' && 'type' in value) return normalizeLicense(value.type);
  return [];
}

function* packageJsonPaths(rootDir) {
  const storeDir = join(rootDir, 'node_modules', '.pnpm');
  if (!existsSync(storeDir)) return;
  for (const entry of readdirSync(storeDir)) {
    const nm = join(storeDir, entry, 'node_modules');
    if (!existsSync(nm)) continue;
    for (const pkg of readdirSync(nm)) {
      if (pkg.startsWith('.')) continue;
      const pj = join(nm, pkg, 'package.json');
      if (existsSync(pj)) yield pj;
    }
  }
}

const rootDir = process.cwd();
const seen = new Set();
const violations = [];
let scanned = 0;

for (const pjPath of packageJsonPaths(rootDir)) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pjPath, 'utf8'));
  } catch {
    continue;
  }
  const key = `${pkg.name}@${pkg.version}`;
  if (!pkg.name || seen.has(key)) continue;
  seen.add(key);
  scanned += 1;

  const licenses = [...normalizeLicense(pkg.license), ...normalizeLicense(pkg.licenses)];
  for (const license of licenses) {
    if (DENY_PATTERNS.some((pattern) => pattern.test(license))) {
      violations.push({ name: pkg.name ?? '?', version: pkg.version ?? '?', license });
    }
  }
}

console.log(`[K05] 已扫描依赖 ${scanned} 个（黑名单：AGPL / PolyForm）`);
if (violations.length > 0) {
  for (const v of violations) console.error(`[K05] ⛔ 违规：${v.name}@${v.version} license=${v.license}`);
  process.exit(1);
}
console.log('[K05] ✅ 无黑名单许可');
