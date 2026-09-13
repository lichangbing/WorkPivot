import { Icon } from './Icon';
/** C02/C03：模型供应商配置弹窗（验活/保存/切换；key 经 I04 加密落盘）。 */
import { useState } from 'react';
import { api, type PublicProvider } from './api';

interface Props {
  providers: PublicProvider[];
  onClose: () => void;
  onSaved: () => void;
}

/** C02/C03：模型供应商配置（管理员=本机用户；key 密文落盘，界面打码）。 */
export function ProviderModal({ providers, onClose, onSaved }: Props): React.JSX.Element {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:11434/v1');
  const [modelId, setModelId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const nameReady = name.trim() !== '';
  const formReady = nameReady && baseUrl.trim() !== '' && modelId.trim() !== '';

  const save = async (verify: boolean): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      await api.saveProvider({ name, baseUrl, modelId, apiKey: apiKey || undefined, verify });
      setMessage({ ok: true, text: verify ? '已保存（验活通过）' : '已保存' });
      onSaved();
      // 成功即关闭：主界面 header 会立即显示新模型，避免"看起来没反应"
      setTimeout(onClose, 400);
    } catch (err) {
      setMessage({ ok: false, text: `保存失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[520px] rounded-xl border border-neutral-700 bg-neutral-900 p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">模型设置</h2>
          <button className="text-neutral-500 hover:text-neutral-200" aria-label="关闭窗口" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>

        {/* 已有供应商列表 */}
        {providers.length > 0 && (
          <div className="mb-4">
            <p className="mb-1 text-xs text-neutral-500">已配置</p>
            {providers.map((p) => (
              <div key={p.id} className="mb-1 flex items-center justify-between rounded bg-neutral-800 px-3 py-1.5 text-xs">
                <span>
                  {p.active && <span aria-label="当前启用" className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />}
                  {p.name} —— {p.baseUrl} / {p.modelId}
                  {!p.hasApiKey && <span className="ml-1 text-neutral-500">（无 key）</span>}
                </span>
                {!p.active && (
                  <button
                    className="text-blue-400 hover:text-blue-300"
                    onClick={() => {
                      void api.setActiveProvider(p.id).then(onSaved);
                    }}
                  >
                    设为当前
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="space-y-3 text-sm">
          <div className="grid grid-cols-[110px_1fr] items-center gap-2">
            <label className="text-neutral-400">
              <span className="text-red-400">*</span> 名称
            </label>
            <input
              className={`rounded border bg-neutral-800 px-2 py-1.5 outline-none focus:border-neutral-500 ${
                nameReady ? 'border-neutral-700' : 'border-red-500/60'
              }`}
              placeholder="如：DeepSeek（必填）"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <label className="text-neutral-400">
              <span className="text-red-400">*</span> Base URL
            </label>
            <input
              className="rounded border border-neutral-700 bg-neutral-800 px-2 py-1.5 outline-none focus:border-neutral-500"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
            <label className="text-neutral-400">
              <span className="text-red-400">*</span> 模型 ID
            </label>
            <input
              className={`rounded border bg-neutral-800 px-2 py-1.5 outline-none focus:border-neutral-500 ${
                modelId.trim() !== '' ? 'border-neutral-700' : 'border-red-500/60'
              }`}
              placeholder="如：deepseek-v4-flash（必填）"
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
            />
            <label className="text-neutral-400">API Key</label>
            <input
              className="rounded border border-neutral-700 bg-neutral-800 px-2 py-1.5 outline-none focus:border-neutral-500"
              type="password"
              placeholder="本地模型可留空；sk-… 将加密存储"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>

          {message && (
            <p className={`text-sm font-medium ${message.ok ? 'text-emerald-400' : 'text-red-400'}`}>{message.text}</p>
          )}
          {!formReady && (
            <p className="text-xs text-neutral-500">带 * 为必填；按钮在必填项未填满时不可点。</p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              className="rounded bg-neutral-800 px-3 py-1.5 text-xs hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={busy || !formReady}
              onClick={() => void save(true)}
            >
              验活并保存
            </button>
            <button
              className="rounded bg-blue-600 px-3 py-1.5 text-xs hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={busy || !formReady}
              onClick={() => void save(false)}
            >
              直接保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
