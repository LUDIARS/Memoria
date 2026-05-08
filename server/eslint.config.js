// ESLint flat config for the local Memoria server.
//
// 方針:
// - any 禁止 (`@typescript-eslint/no-explicit-any: error`) はプロジェクト
//   固有の強制ルール。 これ以外は typescript-eslint の recommended ルール
//   をそのまま採用。
// - JS ファイルは段階移行中なので lint 対象外 (TS のみ)。 JS → TS 移行が
//   完了したらこの除外も外せる。

import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'multi/node_modules/**',
      'public/**',
      'data/**',
      // 段階移行中の JS は lint 対象外
      '**/*.js',
      '**/*.mjs',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // any 禁止 (プロジェクト固有)
      '@typescript-eslint/no-explicit-any': 'error',
      // 段階移行中に too-strict だと邪魔なもの
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
);
