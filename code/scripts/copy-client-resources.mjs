import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../apps/desktop/', import.meta.url);
mkdirSync(fileURLToPath(new URL('dist/', root)), { recursive: true });
for (const name of ['connection.html', 'connection.js']) copyFileSync(new URL(`src/${name}`, root), new URL(`dist/${name}`, root));
