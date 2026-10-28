import {NetworkTargets} from './NetworkTargets';
import {RequestAudits} from './RequestAudits';
import {DatabaseOperations} from './DatabaseOperations';
import {DatabaseEmbeddings} from '../DatabaseEmbeddings';
import {DatabaseExperts} from '../DatabaseExperts';
import { DatabaseMemoryTemplates } from '../DatabaseMemoryControls';
import { SkillPackagesPanel } from './SkillPackagesPanel';
import { DatabaseUsers } from './DatabaseUsers';
import { LimitsPanel } from './LimitsPanel';
import { useEffect, useState } from 'react';
import { Registry } from '../DatabaseSettings';

/** 沿用已有管理界面框架，只挂载已具备数据库接口的面板。 */
export function DatabaseAdminContent({ menu, onDirty }: { menu: string; onDirty: (dirty: boolean) => void }) {
  const [capabilities, setCapabilities] = useState<{ providersEnabled?: boolean; mcpEnabled?: boolean } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { const c = new AbortController(); void fetch('/api/health', { signal: c.signal }).then(r => { if (!r.ok) throw Error('读取服务状态失败'); return r.json(); }).then(setCapabilities).catch(e => { if (!c.signal.aborted) setError(String(e)); }); return () => c.abort(); }, []);
  if (menu === 'experts') return <DatabaseExperts admin/>;
  if (menu === 'memory') return <DatabaseMemoryTemplates />;
  if (menu === 'skills') return <SkillPackagesPanel onDirty={onDirty} />;
  if (menu === 'network-targets') return <NetworkTargets />;
  if (menu === 'request-audit') return <RequestAudits />;
  if (menu === 'ops') return <DatabaseOperations />;
  if (menu === 'users') return <DatabaseUsers />;
  if (menu === 'limits') return <LimitsPanel />;
  if (error) return <p role="alert">{error}</p>;
  if (!capabilities) return <p>正在读取服务状态…</p>;
  if (menu === 'models' || menu === 'mcp' || menu === 'projects') {
    const section = menu === 'models' ? 'providers' : menu;
    const enabled = menu === 'models' ? capabilities.providersEnabled : menu === 'mcp' ? capabilities.mcpEnabled : true;
    return <section><h1 className="mb-4 text-lg font-medium">{menu === 'models' ? '模型管理' : menu === 'mcp' ? 'MCP 管理' : '我的项目'}</h1>{enabled ? <><Registry key={section} section={section} onChanged={async () => {}} />{menu==='models'&&<DatabaseEmbeddings />}</> : <p className="text-sm text-neutral-400">当前联调服务未启用{menu === 'models' ? '模型配置' : 'MCP'}模块。</p>}</section>;
  }
  const titles: Record<string, string> = { skills: 'Skill 管理', memory: '默认记忆', templates: '我的模板', schedules: '定时任务', ops: '审计与回收站', permissions: '路径授权' };
  return <section><h1 className="mb-4 text-lg font-medium">{titles[menu]}</h1><p className="text-sm text-neutral-400">此功能的原管理页面仍保留在工程中，数据库接口尚未接入，暂不可操作。</p></section>;
}
