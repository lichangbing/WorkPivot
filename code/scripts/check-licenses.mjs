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
      // Scoped packages live one level below @scope, not at @scope/package.json.
      const packages = pkg.startsWith('@')
        ? readdirSync(join(nm, pkg)).map(name => join(nm, pkg, name))
        : [join(nm, pkg)];
      for (const dir of packages) {
        const pj = join(dir, 'package.json');
        if (existsSync(pj)) yield pj;
      }
    }
  }
}

const rootDir = process.cwd();
const seen = new Set();
const violations = [];
const unreadable = [];
const unknown = [];
let scanned = 0;

for (const pjPath of packageJsonPaths(rootDir)) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pjPath, 'utf8'));
  } catch {
    unreadable.push(pjPath);
    continue;
  }
  const key = `${pkg.name}@${pkg.version}`;
  if (!pkg.name || seen.has(key)) continue;
  seen.add(key);
  scanned += 1;

  const licenses = [...normalizeLicense(pkg.license), ...normalizeLicense(pkg.licenses)];
  if (licenses.length === 0) unknown.push(key);
  for (const license of licenses) {
    if (DENY_PATTERNS.some((pattern) => pattern.test(license))) {
      violations.push({ name: pkg.name ?? '?', version: pkg.version ?? '?', license });
    }
  }
}

console.log(`[K05] 已扫描依赖 ${scanned} 个（黑名单：AGPL / PolyForm）`);
if (scanned === 0 || unreadable.length > 0) {
  console.error(`[K05] 检查未完成：有效依赖 ${scanned} 个，无法解析的清单 ${unreadable.length} 个。请检查依赖安装及运行目录。`);
  process.exit(1);
}
if (unknown.length) console.warn(`[K05] ${unknown.length} 个依赖未声明许可，需人工核对：${unknown.join(', ')}`);
if (violations.length > 0) {
  for (const v of violations) console.error(`[K05] ⛔ 违规：${v.name}@${v.version} license=${v.license}`);
  process.exit(1);
}
console.log('[K05] ✅ 已声明许可中未命中黑名单（不替代完整许可证审查）');
