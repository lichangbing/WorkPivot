#!/usr/bin/env node
// Run on the Linux Docker host. Restore always creates new volumes.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, createReadStream } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 300000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const inspect = (name) => JSON.parse(docker(['inspect', name]))[0];
const sha = async (file) => { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); };
function volume(name) { if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(name)) throw Error('Invalid volume name'); return name; }
function mountDir(dir, target, readonly = false) { if (dir.includes(',')) throw Error('Directory cannot contain comma'); return `type=bind,src=${dir},dst=${target}${readonly ? ',readonly' : ''}`; }
export async function backup(container, destination) {
  const dir = resolve(destination);
  if (existsSync(dir)) throw Error('Backup destination must be a new directory');
  const info = inspect(container);
  const mounts = ['/data/workpivot', '/data/workspace'].map((target) => {
    const mount = info.Mounts.find((m) => m.Destination === target && m.Type === 'volume');
    if (!mount) throw Error(`Expected named volume at ${target}`);
    return volume(mount.Name);
  });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const running = info.State.Running;
  try {
    if (running) docker(['stop', '--time', '30', container]);
    docker(['run', '--rm', '--user', '0', '--network', 'none', '--read-only',
      '--mount', `type=volume,src=${mounts[0]},dst=/source-home,readonly`,
      '--mount', `type=volume,src=${mounts[1]},dst=/source-workspace,readonly`,
      '--mount', mountDir(dir, '/backup'), '--entrypoint', '/bin/sh', info.Image, '-c',
      'tar -cf /backup/home.tar -C /source-home . && tar -cf /backup/workspace.tar -C /source-workspace .']);
    const manifest = { version: 1, date: new Date().toISOString(), imageId: info.Image, imageTag: info.Config.Image, mounts,
      sha256: { 'home.tar': await sha(join(dir, 'home.tar')), 'workspace.tar': await sha(join(dir, 'workspace.tar')) } };
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    return manifest;
  } finally { if (running) docker(['start', container]); }
}
export async function restore(source, dataVolume, workspaceVolume) {
  const dir = resolve(source); const names = [volume(dataVolume), volume(workspaceVolume)];
  if (names[0] === names[1]) throw Error('Restore volumes must differ');
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || !/^sha256:[a-f0-9]{64}$/.test(manifest.imageId)) throw Error('Invalid snapshot manifest');
  for (const file of ['home.tar', 'workspace.tar']) if (await sha(join(dir, file)) !== manifest.sha256[file]) throw Error(`Checksum mismatch: ${file}`);
  docker(['image', 'inspect', manifest.imageId]);
  const existing = new Set(docker(['volume', 'ls', '--format', '{{.Name}}']).split('\n'));
  if (names.some((name) => existing.has(name))) throw Error('Restore refuses to overwrite existing volumes');
  for (const name of names) docker(['volume', 'create', name]);
  docker(['run', '--rm', '--user', '0', '--network', 'none', '--read-only',
    '--mount', `type=volume,src=${names[0]},dst=/restored-home`, '--mount', `type=volume,src=${names[1]},dst=/restored-workspace`,
    '--mount', mountDir(dir, '/backup', true), '--entrypoint', '/bin/sh', manifest.imageId, '-c',
    'tar -xf /backup/home.tar -C /restored-home && tar -xf /backup/workspace.tar -C /restored-workspace && chown -R 1000:1000 /restored-home /restored-workspace']);
  docker(['run', '--rm', '--user', '1000:1000', '--network', 'none', '--read-only', '--mount', `type=volume,src=${names[0]},dst=/restored-home`, '--entrypoint', 'node', manifest.imageId, '-e',
    "const fs=require('fs');fs.mkdirSync('/restored-home/data',{recursive:true});fs.writeFileSync('/restored-home/data/sessions.json',JSON.stringify({version:1,tokens:[]}));fs.rmSync('/restored-home/data/sessions.json.bak',{force:true});"]);
  return { imageId: manifest.imageId, dataVolume: names[0], workspaceVolume: names[1] };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'backup' && args.length === 2) console.log(JSON.stringify(await backup(...args), null, 2));
    else if (command === 'restore' && args.length === 3) console.log(JSON.stringify(await restore(...args), null, 2));
    else throw Error('Usage: node snapshot.mjs backup CONTAINER NEW_DIRECTORY | restore DIRECTORY NEW_DATA_VOLUME NEW_WORKSPACE_VOLUME');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
