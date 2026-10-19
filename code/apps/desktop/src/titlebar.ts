/// <reference lib="dom" />
import { ipcRenderer } from 'electron';

/** 客户端统一提供窗口操作，连接页和服务端页面共用，避免离线时丢失窗口按钮。 */
export function installTitlebar(): void {
  window.addEventListener('DOMContentLoaded', () => {
    if (window.top !== window) return;
    document.documentElement.classList.add('workpivot-desktop');
    const layout = document.createElement('style');
    // 为网页划定独立视口，固定定位的提示、侧栏和弹窗也必须避开窗口标题栏。
    layout.textContent = ':root{--desktop-titlebar-height:36px}body{padding-top:var(--desktop-titlebar-height)!important;box-sizing:border-box}body:has(> #root){height:100vh;overflow:hidden}body > #root{position:fixed;inset:var(--desktop-titlebar-height) 0 0;overflow:auto;contain:layout}';
    document.head.append(layout);
    const host = document.createElement('div');
    host.id = 'workpivot-titlebar';
    host.style.cssText = 'position:fixed;inset:0 0 auto;height:36px;z-index:2147483647';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host{font:12px system-ui,sans-serif;color:var(--color-neutral-300,#d4d4d4)}
      header{height:36px;display:flex;align-items:center;background:var(--color-neutral-900,#171717);border-bottom:1px solid var(--color-neutral-800,#262626);box-sizing:border-box;user-select:none;-webkit-app-region:drag}
      .brand{padding:0 16px;flex:1;font-weight:600;letter-spacing:.02em}
      button{width:44px;height:35px;border:0;background:transparent;color:inherit;display:grid;place-items:center;-webkit-app-region:no-drag;cursor:default}
      button:hover{background:var(--color-neutral-700,#404040)}button:focus-visible{outline:2px solid #3b82f6;outline-offset:-3px}button.close:hover{background:#c42b1c;color:white}
      svg{width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:1.2}
    </style><header><span class="brand">WorkPivot</span><button aria-label="最小化" title="最小化" data-action="minimize"><svg viewBox="0 0 12 12"><path d="M1 6h10"/></svg></button><button aria-label="最大化" title="最大化" data-action="maximize"><svg viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9"/></svg></button><button class="close" aria-label="关闭窗口" title="关闭到托盘" data-action="close"><svg viewBox="0 0 12 12"><path d="m1 1 10 10M11 1 1 11"/></svg></button></header>`;
    const maximize = root.querySelector<HTMLButtonElement>('[data-action="maximize"]')!;
    const update = (maximized: boolean) => {
      maximize.setAttribute('aria-label', maximized ? '还原窗口' : '最大化');
      maximize.title = maximized ? '还原窗口' : '最大化';
      maximize.querySelector('svg')!.innerHTML = maximized ? '<path d="M4 3V1h7v7H9"/><rect x="1" y="4" width="7" height="7"/>' : '<rect x="1.5" y="1.5" width="9" height="9"/>';
    };
    for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('button'))) {
      button.addEventListener('click', () => { void ipcRenderer.invoke('window:control', button.dataset['action']).then(update).catch(() => { button.title = '窗口操作失败，请重试'; }); });
    }
    ipcRenderer.on('window:state', (_event, maximized: boolean) => update(maximized));
    void ipcRenderer.invoke('window:control', 'state').then(update).catch(() => { /* 导航期间旧页面的状态请求可以失效。 */ });
    document.body.append(host);
  }, { once: true });
}
