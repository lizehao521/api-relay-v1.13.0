#!/usr/bin/env node
/*
 * build-config.mjs —— 把「主配置源」与「模型链源」合并为网关可加载的单文件产物。
 *
 * 为什么需要它：api-relay 的 loadConfig 只吃【单个】--config 文件
 * （src/core/config.ts:198-231），不支持多文件合并。为满足「主配置 / 阶梯分离」
 * 的运维诉求，这里在【构建期】把两份源合并成一份产物。
 *
 * 源：
 *   config/relay.base.yaml    —— 主配置（server/storage/tiers/providers/clients/别名…）
 *   config/relay-ladders.yaml —— 模型链（modelLadders + modelCapabilities）
 *
 * 产物（两份等价、内容完全一致）：
 *   relay-net.yaml            —— scripts/start-net.sh / keepalive.sh / ops-check.sh 绑定
 *   config/relay.yaml         —— DEFAULT_CONFIG_PATH（src/core/config.ts:21）
 *
 * 合并方式：两份源都是合法的 YAML 顶层映射，且键互不重叠（base 不含 ladder 段），
 * 因此【直接文本拼接】即得到合法 YAML —— 既不丢注释，也便于 git diff。
 *
 * 用法：node scripts/build-config.mjs
 * 注：脚本 stdout 一律用 ASCII，避免终端编码差异导致的日志乱码。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const basePath = resolve(root, 'config/relay.base.yaml');
const laddersPath = resolve(root, 'config/relay-ladders.yaml');
const outputs = [resolve(root, 'relay-net.yaml'), resolve(root, 'config/relay.yaml')];

for (const p of [basePath, laddersPath]) {
  if (!existsSync(p)) {
    console.error(`[build-config] missing source file: ${p}`);
    process.exit(1);
  }
}

const base = readFileSync(basePath, 'utf8').replace(/\s*$/, '') + '\n';
const ladders = readFileSync(laddersPath, 'utf8').replace(/^\s*/, '');

const banner =
  '\n# ============================================================\n' +
  '# 以下 modelLadders / modelCapabilities 由\n' +
  '#   config/relay-ladders.yaml\n' +
  '# 合并而来（本文件是【产物】，请勿直接编辑）。\n' +
  '# 改源文件后执行：npm run config:build\n' +
  '# ============================================================\n\n';

const merged = base + banner + ladders;

// 合并后先校验、再落盘：用网关自身的 YAML 解析器确认产物合法（需先 npm run build）。
const yamlMod = resolve(root, 'dist/core/yaml.js');
if (existsSync(yamlMod)) {
  const { parseYaml } = await import(new URL('../dist/core/yaml.js', import.meta.url).href);
  const parsed = parseYaml(merged);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error('[build-config] merged output is not a valid YAML top-level mapping; aborted (nothing written)');
    process.exit(1);
  }
  const nL = Object.keys(parsed.modelLadders ?? {}).length;
  const nC = Object.keys(parsed.modelCapabilities ?? {}).length;
  if (nL === 0) {
    console.error('[build-config] merged output lacks modelLadders; check config/relay-ladders.yaml');
    process.exit(1);
  }
  console.log(`[build-config] validated: modelLadders=${nL}, modelCapabilities=${nC}`);
} else {
  console.warn('[build-config] dist/core/yaml.js not found (run npm run build first); skipping output validation');
}

for (const out of outputs) {
  writeFileSync(out, merged, 'utf8');
  console.log(`[build-config] wrote ${out}`);
}