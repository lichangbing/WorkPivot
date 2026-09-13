/** Only runtime necessities reach task commands. Application credentials and runtime injection flags stay in the host. */
export function commandEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SYSTEMDRIVE']);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (allowed.has(key.toUpperCase()) && value !== undefined) env[key] = value;
  // NODE_PATH is supplied by the host to expose bundled document libraries; it is never inherited.
  if (extra['NODE_PATH']) env['NODE_PATH'] = extra['NODE_PATH'];
  return env;
}
