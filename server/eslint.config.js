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
      // public/app.js は public/src/app.ts のビルド成果物 (esbuild バンドル)。
      // public/sw.js は service worker (TS 化対象外)。
      'public/app.js',
      'public/sw.js',
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
      // varsIgnorePattern も追加 — 旧 JS から TS 化した frontend で、 後段で
      // 使うつもりの helper / 動的に呼ばれる関数などを `_foo` で示せるように。
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },
  {
    // Frontend (public/src/**) は DOM 多用 + 旧 JS 移植のため non-null
    // assertion (`$('#foo')!.value` 系) を許容する。
    files: ['public/src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
