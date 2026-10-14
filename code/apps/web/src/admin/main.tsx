import '../theme';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import AdminApp from './AdminApp';
import { ConnectionStatus } from '../ConnectionStatus';
import '../index.css';

function AdminRoot() {
  const [database, setDatabase] = useState<boolean | null>(null);
  useEffect(() => { void fetch('/api/health').then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(v => setDatabase(v.storage === 'postgresql')).catch(() => setDatabase(null)); }, []);
  if (database === null) return <p className="p-6">正在连接管理后台，请稍候；连接失败时请刷新重试。</p>;
  return <AdminApp database={database} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConnectionStatus />
    <AdminRoot />
  </StrictMode>,
);
