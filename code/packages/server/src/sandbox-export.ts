/** 在执行器内部运行；输出仍不可信，须由宿主再次校验。 */
export const EXPORT_WORKSPACE = String.raw`
const fs = require('node:fs');
const path = require('node:path');
let bytes = 0, entries = 0;
const output = [];
function walk(relative) {
  for (const name of fs.readdirSync(path.join('/workspace', relative))) {
    if (++entries > 10000) throw Error('too many entries');
    const rel = path.join(relative, name), file = path.join('/workspace', rel);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || stat.isFile() && stat.nlink !== 1) throw Error('links and special files are forbidden');
    if (stat.isDirectory()) { walk(rel); continue; }
    bytes += stat.size;
    if (bytes > 128 * 1024 * 1024) throw Error('output exceeds limit');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) throw Error('file changed during export');
      const data = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < data.length) { const n = fs.readSync(fd, data, offset, data.length - offset, offset); if (!n) throw Error('file truncated'); offset += n; }
      output.push([rel, data.toString('base64')]);
    } finally { fs.closeSync(fd); }
  }
}
walk(''); process.stdout.write(JSON.stringify(output));
`;
