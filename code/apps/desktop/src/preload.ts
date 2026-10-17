import { contextBridge, ipcRenderer } from 'electron';

// 仅向本地连接页面开放，主进程每次调用都校验发送方。
contextBridge.exposeInMainWorld('workpivotConnection', {
  settings: () => ipcRenderer.invoke('connection:settings'),
  connect: (serverUrl: string) => ipcRenderer.invoke('connection:connect', serverUrl),
});

contextBridge.exposeInMainWorld('workpivotDesktop', {
  artifactActionsVersion: 2,
  changeServer: () => ipcRenderer.invoke('connection:show'),
  syncStatus: (token: string) => ipcRenderer.invoke('workspace:sync-status', token),
  configureSync: (token: string, enabled = true) => ipcRenderer.invoke('workspace:sync-configure', token, enabled),
  syncArtifacts: (token: string) => ipcRenderer.invoke('workspace:sync-sync', token),
  showSyncFolder: (token: string) => ipcRenderer.invoke('workspace:sync-folder', token),
  stopSync: () => ipcRenderer.invoke('workspace:sync-stop'),
  openArtifact: (taskId: string, name: string, token: string, version?: string) => ipcRenderer.invoke('workspace:open-artifact', taskId, name, token, version),
  showArtifact: (taskId: string, name: string, token: string, version?: string) => ipcRenderer.invoke('workspace:show-artifact', taskId, name, token, version),
  selectDirectory: () => ipcRenderer.invoke('workspace:select-directory'),
});
