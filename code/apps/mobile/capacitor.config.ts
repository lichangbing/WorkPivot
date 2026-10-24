import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.workpivot.mobile',
  appName: 'WorkPivot',
  webDir: 'dist',
  loggingBehavior: 'debug',
  // 页面随安装包分发；用户填写的地址只作为 API 目标。
  server: { androidScheme: 'https', hostname: 'localhost' },
};
export default config;
