import type { IconName } from './Icon';
export function fileIcon(name: string): IconName {
  const ext = name.split('.').at(-1)?.toLowerCase();
  if (['xls', 'xlsx', 'xlsm', 'csv', 'ods'].includes(ext ?? '')) return 'fileExcel';
  if (['doc', 'docx', 'docm', 'odt', 'rtf'].includes(ext ?? '')) return 'fileWord';
  if (['ppt', 'pptx', 'pptm', 'odp'].includes(ext ?? '')) return 'filePpt';
  if (ext === 'pdf') return 'filePdf';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext ?? '')) return 'fileImage';
  if (['zip', '7z', 'rar', 'gz'].includes(ext ?? '')) return 'archive';
  return 'file';
}
