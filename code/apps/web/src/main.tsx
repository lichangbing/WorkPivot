import './theme';
/** React 入口：挂载 App（T1-01 脚手架）。 */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ConnectionStatus } from './ConnectionStatus';
import './index.css';
import { DatabaseWorkspace } from './DatabaseWorkspace';

function WorkspaceRoot() {
  const [storage, setStorage] = useState<'loading' | 'postgresql' | 'legacy'>('loading');
  const [chatEnabled, setChatEnabled] = useState(false);
  const [filesEnabled, setFilesEnabled] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/health', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) }).then(r => { if (!r.ok) throw Error(); return r.json(); }).then((v: { storage?: string; chatEnabled?: boolean; filesEnabled?: boolean }) => { if (!controller.signal.aborted) { setChatEnabled(v.chatEnabled === true); setFilesEnabled(v.filesEnabled === true); setStorage(v.storage === 'postgresql' ? 'postgresql' : 'legacy'); } }).catch(() => { if (!controller.signal.aborted) setStorage('legacy'); });
    return () => controller.abort();
  }, []);
  return storage === 'loading' ? <div className="p-6">正在连接后台…</div> : storage === 'postgresql' ? <DatabaseWorkspace chatEnabled={chatEnabled} filesEnabled={filesEnabled} /> : <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConnectionStatus />
    <WorkspaceRoot />
  </StrictMode>,
);
