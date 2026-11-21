/**
 * 前端 ESLint 配置（flat config）。
 *
 * 目的很聚焦：把「线上 TDZ」这类事故**守则化**——
 * 2026-10-23 的事故是 `Promise.all([...])` 的参数数组里引用了同一条
 * `const [.., kb, ..] = ...` 解构声明的 `kb`，数组求值早于解构初始化 → 
 * `ReferenceError: Cannot access 'kb' before initialization`（压缩后即 `ge`）。
 *
 * 因此启用 `no-use-before-define`（variables: true）：
 *   · 允许函数/类提升（functions/classes: false）—— 这是 JS 语义允许的惯例
 *   · 允许类型引用（ignoreTypeReferences）—— TS 类型可后置声明
 *   · **禁止变量先用后声明**，这正是本次事故的形态
 *
 * 只启用这一条规则（本仓此前未接入 lint，一次性全量推荐规则会产生大量历史告警，
 * 反而淹没真正要拦的问题）。后续可按模块逐步收紧。
 */
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['../dist-admin/**', 'dist/**', 'node_modules/**'],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    // flat config 不做隐式插件解析：只写 `@typescript-eslint/xxx` 规则而不注册 plugins 会直接报错
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      'no-use-before-define': 'off',
      '@typescript-eslint/no-use-before-define': [
        'error',
        {
          functions: false,
          classes: false,
          variables: true,
          enums: false,
          typedefs: false,
          ignoreTypeReferences: true,
          allowNamedExports: true,
        },
      ],
    },
  },
);