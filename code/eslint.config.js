import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // build/=打包产物（server-deploy 是 pnpm deploy 的源码副本）；release/=electron-builder 产物
    // Capacitor 会把 vite 构建产物同步进原生工程目录，这些是生成物而非源码，不能参与 lint，
    // 否则移动端的 minified bundle 会产生数千条与业务代码无关的错误。
    ignores: [
      '**/node_modules/**', '**/dist/**', '**/out/**', '**/build/**', '**/release/**', 'releases/**',
      '**/android/app/src/main/assets/public/**',
      '**/ios/App/App/public/**',
      '**/.gradle/**', '**/Pods/**',
    ],
  },
  ...tseslint.configs.recommended,
);
