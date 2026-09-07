import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // build/=打包产物（server-deploy 是 pnpm deploy 的源码副本）；release/=electron-builder 产物
    ignores: ['**/node_modules/**', '**/dist/**', '**/out/**', '**/build/**', '**/release/**', 'releases/**'],
  },
  ...tseslint.configs.recommended,
);
