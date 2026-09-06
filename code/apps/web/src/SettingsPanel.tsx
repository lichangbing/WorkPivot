/**
 * U2/E01/J01：设置面板（左栏底部 ⚙ 弹出）。
 * 权限档位切换、记忆开关（+M1-11 记忆管理入口）、模型状态只读（+后台入口 for admin）、退出登录。
 */
import { useState } from 'react';
import type { PublicUser, Tier } from './api';
import { MemoryModal } from './MemoryModal';

interface Props {
  user: PublicUser;
  tier: Tier;
  tierLabels: Record<string, string>;
  memoryOn: boolean;
  activeModel: string | null;
  activeTaskId?: string;
  onTierChange: (tier: Tier) => void;
  onMemoryToggle: (enabled: boolean) => void;
  onLogout: () => void;
  onClose: () => void;
}

export function SettingsPanel(props: Props): React.JSX.Element {
  const { user, tier, tierLabels, memoryOn, activeModel, activeTaskId, onTierChange, onMemoryToggle, onLogout, onClose } = props;
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [memoryModalOpen, setMemoryModalOpen] = useState(false);

  return (
    <div className="fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-neutral-700 bg-neutral-900 shadow-2xl">
      <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
        <span className="text-sm font-semibold">设置</span>
        <button className="text-neutral-500 hover:text-neutral-200" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4 text-sm">
        {/* 用户 */}
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-700 text-lg font-semibold">
            {user.username.slice(0, 1).toUpperCase()}
          </div>
          <div>
            <p className="font-medium">{user.username}</p>
            <p className="text-xs text-neutral-500">{user.role === 'admin' ? '管理员' : '成员'}</p>
          </div>
        </div>

        {/* 权限档位 */}
        <div>
          <p className="mb-1 text-xs text-neutral-500">权限档位</p>
          <select
            className="w-full rounded border border-neutral-700 bg-neutral-800 px-2 py-1.5 outline-none focus:border-neutral-500"
            value={tier}
            onChange={(e) => onTierChange(e.target.value as Tier)}
          >
            {Object.entries(tierLabels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </div>

        {/* 记忆开关 + 管理入口（M1-11） */}
        <div>
          <div className="flex items-center justify-between">
            <span className="text-neutral-300">记忆功能</span>
            <button
              className={`rounded px-2 py-1 text-xs ${memoryOn ? 'bg-emerald-700' : 'bg-neutral-700'}`}
              disabled={memoryBusy}
              onClick={() => {
                setMemoryBusy(true);
                onMemoryToggle(!memoryOn);
                setTimeout(() => setMemoryBusy(false), 300);
              }}
            >
              {memoryOn ? '已开启' : '已关闭'}
            </button>
          </div>
          <button
            className="mt-1.5 text-xs text-blue-400 hover:text-blue-300"
            onClick={() => setMemoryModalOpen(true)}
          >
            查看与编辑记忆 →
          </button>
        </div>

        {/* 模型状态（只读） */}
        <div>
          <p className="mb-1 text-xs text-neutral-500">模型</p>
          <p className="text-xs text-neutral-300">{activeModel ?? '未配置'}</p>
          {user.role === 'admin' && (
            <a className="text-xs text-blue-400 hover:text-blue-300" href="/admin" target="_blank" rel="noreferrer">
              前往后台配置 →
            </a>
          )}
        </div>
      </div>

      <div className="border-t border-neutral-800 p-4">
        <button
          className="w-full rounded bg-neutral-800 py-2 text-sm hover:bg-neutral-700"
          onClick={() => {
            onLogout();
            onClose();
          }}
        >
          退出登录
        </button>
      </div>

      {memoryModalOpen && <MemoryModal taskId={activeTaskId} onClose={() => setMemoryModalOpen(false)} />}
    </div>
  );
}
