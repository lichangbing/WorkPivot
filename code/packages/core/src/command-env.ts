/** 任务命令只接收运行必需信息；应用凭据和运行时注入标志留在宿主。 */
export function commandEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SYSTEMDRIVE']);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (allowed.has(key.toUpperCase()) && value !== undefined) env[key] = value;
  // NODE_PATH 由宿主指定以提供内置文档库，不继承外部值。
  if (extra['NODE_PATH']) env['NODE_PATH'] = extra['NODE_PATH'];
  return env;
}
