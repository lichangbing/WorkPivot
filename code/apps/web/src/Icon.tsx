import type { CSSProperties } from 'react';

const paths = {
  fileExcel: 'M14 2H4v20h16V8l-6-6Zm0 0v6h6M7 11h10v8H7v-8Zm5 0v8m-5-4h10',
  fileWord: 'M14 2H4v20h16V8l-6-6Zm0 0v6h6M7 12l2 7 3-5 3 5 2-7',
  filePpt: 'M14 2H4v20h16V8l-6-6Zm0 0v6h6M8 19v-8h4a3 3 0 0 1 0 6H8',
  filePdf: 'M14 2H4v20h16V8l-6-6Zm0 0v6h6M8 18c4-4 6-9 4-9-2 0 0 7 5 8-1-3-8-3-9 1Z',
  fileImage: 'M14 2H4v20h16V8l-6-6Zm0 0v6h6M7 18l4-5 3 3 3-2M8 10h.01',
  filePlus: 'M14 2H5v20h14V7l-5-5Zm0 0v6h5M8 14h8m-4-4v8',
  folderPlus: 'M3 7V5h6l3 3h9v12H3V7Zm5 7h8m-4-4v8',
  archive: 'M3 3h18v5H3V3Zm2 5v13h14V8M9 12h6',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
  upload: 'M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5',
  plus: 'M12 5v14M5 12h14', search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  bolt: 'M13 2 4 14h7l-1 8 10-12h-7l1-8Z',
  skill: 'M9 3H4v6H2v6h2v6h6v-2h4v2h6v-6h2V9h-2V3h-5v2H9V3Z',
  folder: 'M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM10 2h4l1 3 3 1 3 3-2 3 2 3-3 3-3 1-1 3h-4l-1-3-3-1-3-3 2-3-2-3 3-3 3-1 1-3Z',
  file: 'M14 2H5v20h14V7l-5-5Zm0 0v6h5M8 12h8M8 16h6',
  memory: 'M9 3H6v4H3v10h3v4h3M15 3h3v4h3v10h-3v4h-3M9 8v8m6-8v8M9 12h6',
  shield: 'M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6l-9-4Zm-5 10 3 3 7-7',
  warning: 'm12 3 10 18H2L12 3Zm0 6v5m0 3v1',
  lock: 'M6 10V7a6 6 0 0 1 12 0v3M4 10h16v12H4V10Zm8 5v3',
  bot: 'M12 2v3M5 5h14v15H5V5ZM2 10v6m20-6v6M9 10v1m6-1v1m-6 5h6',
  close: 'm6 6 12 12M6 18 18 6', check: 'm5 12 4 4L19 6',
  right: 'm9 5 7 7-7 7', down: 'm5 9 7 7 7-7', up: 'M12 20V4m-7 7 7-7 7 7',
  play: 'm7 4 14 8-14 8V4Z', stop: 'M5 5h14v14H5z',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1',
  moon: 'M20 15A9 9 0 0 1 9 3a9 9 0 1 0 11 12Z',
  arrow: 'M4 12h16m-6-6 6 6-6 6',
  panelClose: 'M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm11 0v18M7 9l3 3-3 3',
  panelOpen: 'M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm11 0v18M10 9l-3 3 3 3',
} as const;
export type IconName = keyof typeof paths;

/** 统一矢量图标风格；currentColor 跟随周围主题和状态。 */
export function Icon({ name, size = 16, style }: { name: IconName; size?: number; style?: CSSProperties }): React.JSX.Element {
  return <svg aria-hidden="true" focusable="false" className="wp-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={style}><path d={paths[name]} /></svg>;
}
