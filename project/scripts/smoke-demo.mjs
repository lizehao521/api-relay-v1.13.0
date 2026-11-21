#!/usr/bin/env node
/**
 * 零凭据渲染门：`npm run smoke:demo`
 *
 * 为什么需要它：`frontend/scripts/smoke-render.mjs` 断言的是"11 个页签能否真实渲染"，
 * 但要求外部先有一个已启动的实例 + RELAY_ADMIN_TOKEN。干净检出/验收机上通常两样都没有，
 * 于是这条**唯一的渲染回归门**默认跑不起来（2026-10-23 TDZ 事故的防线形同虚设）。
 *
 * 本脚本把"起实例"和"跑断言"合成一条命令：
 *   ① `startDemo()` 在进程内装配 mock 上游 + 网关 + 看板（随机端口，零凭据）；
 *   ② 以该实例地址为 RELAY_BASE 拉起 smoke-render.mjs（渲染断言仍是同一份代码）；
 *   ③ 无论成功失败都 shutdown，退出码透传。
 *
 * 依赖：`npm run build` 生成的 `dist/` + `dist-admin/`（与 bench 同样的前置约定）。
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDemo } from '../dist/demo.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let demo;
try {
  demo = await startDemo({ port: 0, mockPort: 0, host: '127.0.0.1', interactive: false });
} catch (err) {
  console.error(`[smoke:demo] demo 装配失败（先执行 npm run build）: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

console.log(`[smoke:demo] 实例 ${demo.info.url}（mock 上游 ${demo.info.mockUrl}），开始 11 页签渲染断言`);

const child = spawn(process.execPath, [resolve(root, 'frontend/scripts/smoke-render.mjs')], {
  cwd: root,
  env: {
    ...process.env,
    RELAY_BASE: demo.info.url,
    // demo 仅监听 127.0.0.1 且管理面免令牌；这里给个占位值只为满足脚本的前置校验，
    // 不代表任何真实凭据（真实凭据仍需 RELAY_ADMIN_TOKEN 或登录账号）。
    RELAY_ADMIN_TOKEN: process.env.RELAY_ADMIN_TOKEN || 'smoke-demo-local',
  },
  stdio: 'inherit',
});

const exitCode = await new Promise((res) => child.on('exit', (code, signal) => res(code ?? (signal ? 1 : 0))));
await demo.shutdown();
process.exit(exitCode);