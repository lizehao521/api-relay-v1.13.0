# api-relay 修复清单（按等级编号）

> 来源：`代码检视报告-api-relay.html`（第一轮静态 16 项 + 第二轮实测/通读/安全深挖 16 项，合计 32 项）。
> 本清单只给**修复动作 + Before/After 补丁**，**未改动仓库源码**。要落盘请指定编号并授权。
> 编号含义：C=严重 · M=一般 · L=建议 · I=信息。

## 修复批次（建议执行顺序）

| 批次 | 范围 | 内容 | 完成判据 |
|---|---|---|---|
| **0 · 上线阻断** | C-04 → C-05 → C-06 → C-07 → C-01 | 对外暴露、1.2s 全站阻塞、OOM、key 池误废、鉴权表 DoS | 5 条全部修复 + 各自回归测试通过 |
| **1 · 本迭代** | C-02 → C-03 → M-01 → M-02 → M-08 | 不变量绕过、契约矛盾、静默失效、资源不销毁 | 修复 + 新增“多入口一致性”测试 |
| **2 · 计划修复** | M-03 → M-09 → M-10 → M-12 → M-13 → M-11 → M-04 → M-05 → M-06 → M-07 | 健壮性 / 资源上限 / 一致性 / 巨型文件 / 类型护栏 | 逐条 PR，含测试 |
| **3 · 质量与文档** | L-01 ~ L-10 → I-01 / I-02 | 时序、死代码、生成物校验、性能基线、文档更正 | 择机，可与功能迭代同行 |

---

# 一、严重（7）

## C-01 鉴权失败表清理条件写错 → 内存无界增长（DoS）

- **位置**：`src/admin/auth.ts:66-71`（新增常量在 :29 附近）
- **维度**：安全 / 资源耗尽
- **根因**：清理条件要求 `rl.fails === 0`，而 `fails` 只在“用正确令牌通过一次”时清零 → 失败过 1 次的 IP 记录**永久驻留**、锁定过期的记录（`fails=20`）也永不回收。

```diff
--- a/src/admin/auth.ts
+++ b/src/admin/auth.ts
@@
 /** 速率限制表清理周期 10 分钟（Q001/F3/SEC-002/PERF-006：防内存泄漏） */
 const CLEANUP_MS = 10 * 60 * 1000;
+/** 失败表硬上限：即便清理周期未到，也绝不允许无界增长（分布式爆破会打进来） */
+const MAX_TRACKED_IPS = 50_000;
@@ authorize(req, headers) {
     const now = Date.now();
     if (now - this.lastCleanup > CLEANUP_MS) {
       this.lastCleanup = now;
       for (const [ip, rl] of this.rateLimits) {
-        if (rl.lockedUntil < now && rl.fails === 0) this.rateLimits.delete(ip);
+        // 解锁即回收：旧条件 `rl.fails === 0` 让“失败过但不该锁”的条目永远留下
+        if (rl.lockedUntil < now) this.rateLimits.delete(ip);
       }
     }
+    // 硬上限兜底（FIFO 丢弃最旧）
+    if (this.rateLimits.size > MAX_TRACKED_IPS) {
+      let drop = this.rateLimits.size - MAX_TRACKED_IPS;
+      for (const ip of this.rateLimits.keys()) {
+        this.rateLimits.delete(ip);
+        if (--drop <= 0) break;
+      }
+    }
```

- **回归测试**：推进假时钟跨越 `CLEANUP_MS`，断言 `rateLimits.size` 回落；再灌入 `MAX_TRACKED_IPS + 1` 个不同 IP，断言尺寸被截断。

---

## C-02 label 唯一性只在 create 校验，update 可绕过

- **位置**：`src/gateway/keys.ts:362`
- **维度**：安全 / 数据不变量

```diff
--- a/src/gateway/keys.ts
+++ b/src/gateway/keys.ts
@@ update(keyId, patch, actor) {
-    if (patch.label !== undefined) rec.label = patch.label.trim() || rec.label;
+    if (patch.label !== undefined) {
+      const next = patch.label.trim();
+      if (next) {
+        // 与 create() 同一去重口径（SEC-006）：不变量必须在所有入口等价
+        const dup = [...this.byHash.values(), ...this.dynamic.values()]
+          .some((r) => r.id !== rec.id && r.label === next);
+        if (dup) throw new Error(`label "${next}" 已存在`);
+        rec.label = next;
+      }
+    }
```

- **连带**：`src/admin/handlers/keys.ts:208-212` 已校验长度，无需改；建议把 label 去重抽成 `KeyRegistry.hasLabel(label, exceptId?)` 供 create/update 共用（同时解决 M-07）。

---

## C-03 预检 finish() 把“内部异常”计入阻断，与 fail-open 契约矛盾

- **位置**：`src/loss/precheck.ts:503`
- **维度**：Bug / 契约

```diff
--- a/src/loss/precheck.ts
+++ b/src/loss/precheck.ts
@@ function finish(violations, t0, degraded) {
-  const hasBlock = violations.some((v) => v.severity === 'block') || violations.some((v) => v.severity === 'info' && v.code === 'precheck_internal_error');
+  // ok 只由 block 决定；内部异常走 degraded 表达（文件头契约：预检自身异常必须放行）
+  const hasBlock = violations.some((v) => v.severity === 'block');
   return { ok: !hasBlock, violations, durationUs: monotonicUs() - t0, ...(degraded ? { degraded: true } : {}) };
```

- **二选一提示**：若团队认为“预检内部异常必须拦”，则应改文件头契约与注释为 fail-closed，并同步 engine；两种语义不能并存。

---

## C-04 同机隧道/反代使“本机”信任边界失效（对外暴露）

- **位置**：`src/gateway/server.ts:179-195`、`src/admin/auth.ts:59-63`、`src/core/config.ts:134`、`docs/DEPLOYMENT.md:164`
- **维度**：安全 / 信息泄露 / 信任边界
- **根因**：判据是 `remoteAddress`，而项目主推的对外方式是**同机**隧道（cloudflared / Tailscale Funnel → `127.0.0.1:8787`），公网流量在网关视角就是本机。

**修复（分三步，最小改动优先）**

第 1 步：默认关闭公开端点（改默认值即可挡住最大暴露面）

```diff
--- a/src/core/config.ts
+++ b/src/core/config.ts
@@
-      publicQuota: true,
+      // 默认关闭：同机隧道下 remoteAddress 无法区分公网与本机
+      publicQuota: false,
```

第 2 步：不再用 `remoteAddress` 单独作为“可信本机”依据，改为**要求显式声明是否被边缘前置**

```diff
--- a/src/gateway/server.ts
+++ b/src/gateway/server.ts
@@
     if (req.method === 'GET' && (path === '/v1/quota' || path === '/v1/panel')) {
       if (this.deps.config.server.publicQuota === false) { /* …404… */ }
-      const remote = req.socket.remoteAddress ?? '';
-      const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
-      if (!isLocal && this.deps.config.server.publicQuotaRemote !== true) { /* …403… */ }
+      // 注意：网关若被同机隧道/反代前置，公网请求的 remoteAddress 也会是回环地址，
+      // 因此“本机”不足以构成授权。只有部署者显式声明才放行。
+      if (this.deps.config.server.publicQuotaRemote !== true) { /* …403… */ }
```

第 3 步：启动校验——`adminToken` 缺失且监听非回环地址时**拒绝启动**（而非 warn）

```diff
--- a/src/core/config.ts
+++ b/src/core/config.ts
@@
-  if (config.server.adminToken === undefined) {
-    push('warn', '未设置 server.adminToken：管理接口仅接受来自 127.0.0.1 的请求');
+  if (config.server.adminToken === undefined || config.server.adminToken === '') {
+    // 体验模式仅对“确定不会被前置”的回环绑定成立
+    const boundLoopback = config.server.host === '127.0.0.1' || config.server.host === '::1' || config.server.host === 'localhost';
+    push(boundLoopback ? 'warn' : 'error',
+      '未设置 server.adminToken：管理接口将对同机隧道/反代后的公网开放。请设置 RELAY_ADMIN_TOKEN，或确认未被前置');
```

- **文档**：`docs/DEPLOYMENT.md:164` 改为“**同机隧道下这两个端点等于对公网开放**；必须设 adminToken，不要依赖 remoteAddress 判本机”（同 L-10）。
- **可选增强**：隧道侧注入共享密钥头（如 `x-relay-edge-secret`），网关校验后才认可“边缘来源”。

---

## C-05 dimensionStats 每桶一条 p95 子查询 → 实测 1.2s 同步阻塞

- **位置**：`src/store/index.ts:1128`（桶表达式）、`1147-1153`（N+1 p95）
- **维度**：性能 / 可用性（node:sqlite 同步，阻塞事件循环）
- **实测**：20 桶 1199 ms；5 桶 414 ms；**1 桶也 193 ms**（地板值来自全窗口 COUNT）。

**修复（方案 A：一次扫描替代 N 次全扫，最小改动）**

```diff
--- a/src/store/index.ts
+++ b/src/store/index.ts
@@
       const out = new Map<string, DimStats>();
+      // 一次按 (桶, duration) 排序取回，替代“每桶一条全扫 + OFFSET 子查询”
+      const p95Rows = this.db
+        .prepare(`SELECT ${bucket} AS k, duration_ms FROM meter
+                   WHERE ts >= ? AND duration_ms IS NOT NULL
+                   ORDER BY k, duration_ms`)
+        .all(sinceMs) as { k: string; duration_ms: number }[];
+      const byBucket = new Map<string, number[]>();
+      for (const r of p95Rows) {
+        const arr = byBucket.get(String(r.k));
+        if (arr) arr.push(r.duration_ms); else byBucket.set(String(r.k), [r.duration_ms]);
+      }
       for (const r of rows) {
         const key = String(r['k'] ?? '');
-        const p95row = this.db.prepare(`SELECT duration_ms FROM meter WHERE ts >= ? AND ${bucket} = ? ORDER BY duration_ms LIMIT 1 OFFSET ( …COUNT(*)·0.95… )`).get(sinceMs, key, sinceMs, key);
+        const samples = byBucket.get(key) ?? [];
+        const p95 = samples.length ? samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)]! : 0;
```

- **治本（方案 C）**：给 `meter` 增 `model`/`provider_id` 列的常规索引，消除 `CASE … END` 造成的非 SARGable；或将管理端重查询移出主循环（异步）。
- **防回归**：加“5 万行下每个管理读查询 < 50 ms”的预算断言（同 L-08）。

---

## C-06 SQLite 降级为内存时 buffer 不清空 → 无界增长（实测 +166 MB）

- **位置**：`src/store/index.ts:781-790`（flush 早退）vs `767-773`（record 无条件 push）
- **维度**：Bug / 可用性 / 内存泄漏

```diff
--- a/src/store/index.ts
+++ b/src/store/index.ts
@@ record(rec) {
     super.record(rec);
+    // 已降级为内存（init 失败）时不再进落盘缓冲：否则 flush() 在 !db 分支早退，
+    // 这个 buffer 永远不被 splice —— 实测 30 万条常驻、堆 +166 MB
+    if (!this.db) return;
     this.buffer.push(rec);
     if (this.records.length > 50_000) this.records.splice(0, this.records.length - 50_000);
+    // 双保险上限（正常路径不会触发）
+    if (this.buffer.length > 100_000) {
+      const over = this.buffer.length - 100_000;
+      this.buffer.splice(0, over);
+      this.opts.logger?.error('store.buffer_overflow', { droppedOldest: over });
+    }
     if (this.buffer.length >= this.opts.batchSize) void this.flush().catch(() => undefined);
 }
```

- **回归测试**：构造未 `init()` 的 `SqliteStore`（db=undefined），`record()` 20 万次，断言 `buffer.length === 0`。

---

## C-07 5xx/429 响应体含 quota/额度 字样即把 key 永久报废

- **位置**：`src/upstream/client.ts:649-652`（判据）+ `730-736`（shouldRotateKey / isQuotaBody）
- **维度**：Bug / 可用性 / 逻辑错误

```diff
--- a/src/upstream/client.ts
+++ b/src/upstream/client.ts
@@
-            const permanent = res.status === 401 || res.status === 403 || isQuotaBody(bodyText);
+            // 只有“鉴权语义”与“付费语义”状态才判永久；5xx 一律瞬态。
+            // 旧写法对 shouldRotateKey 的全部状态（含 500/502/503）都看正文，
+            // 一次含 "quota exceeded" 的网关错误页就会把 key 永久摘除（dead 无自动复活）。
+            const permanent =
+              res.status === 401 || res.status === 403 ||
+              (res.status === 402 && isQuotaBody(bodyText)) ||
+              (res.status === 429 && /insufficient_quota/i.test(bodyText));
```

- **更稳妥（推荐）**：把 `notePermanentFailure` 改为“**长冷却 + 半开探测**”（如 30 min 后允许一次试探），避免任何单次误判不可自愈。
- **连带**：同文件 `659-662` 的二次记账（见 M-12）一并修，否则判据收紧后仍会因重复 note 放大冷却。

---

# 二、一般（13）

## M-01 主鉴权入口用原型链可达的索引取档位策略

- **位置**：`src/gateway/keys.ts:520`（对照 `477 policyFor`）
- **动作**：统一走已确立的防御 `policyFor()`。

```diff
--- a/src/gateway/keys.ts
+++ b/src/gateway/keys.ts
@@ authenticate() {
-      const policy = this.config.tiers[rec.tier];
+      // ownLookup 口径：'constructor'/'toString' 会命中 Object.prototype，不能用直接索引
+      const policy = ownLookup(this.config.tiers, rec.tier);
       const identity: ClientIdentity = { … };
```

## M-02 过短 secret 被静默替换为随机值

- **位置**：`src/gateway/keys.ts:301`（配合 `handlers/keys.ts:111-113`）

```diff
--- a/src/gateway/keys.ts
+++ b/src/gateway/keys.ts
@@ create(input) {
-    const secret = input.secret && input.secret.length >= 8 ? input.secret : generateKey();
+    // 「给了但不合法」必须报错，不能静默丢弃（与 #145/#146 的强校验风格一致）
+    if (input.secret !== undefined && input.secret.length < 8) {
+      throw new Error('自定义 secret 至少 8 个字符');
+    }
+    const secret = input.secret ?? generateKey();
```

## M-03 两处 decodeURIComponent 未捕获，畸形编码把 4xx 变 500

- **位置**：`src/gateway/server.ts:222`、`src/admin/api.ts:716`

```diff
--- a/src/gateway/server.ts
+++ b/src/gateway/server.ts
@@
-      const kbId = decodeURIComponent(kbAskMatch[1]!);
+      let kbId: string;
+      try { kbId = decodeURIComponent(kbAskMatch[1]!); }
+      catch { return this.writeJson(res, 400, JSON.stringify({
+        error: { message: 'kbId 编码非法', type: 'invalid_request_error', code: 'invalid_kb_id' } })); }
```

```diff
--- a/src/admin/api.ts
+++ b/src/admin/api.ts
@@
-      const traceId = decodeURIComponent(action.slice('traces/'.length));
+      let traceId: string;
+      try { traceId = decodeURIComponent(action.slice('traces/'.length)); }
+      catch { return json(res, 400, { error: { message: 'traceId 编码非法', type: 'invalid_request_error', code: 'invalid_trace_id' } }); }
```

## M-04 maskSecret 重复实现（口径漂移风险）

- **位置**：`src/util/index.ts:286-290` · `src/admin/params.ts:116-118`
- **动作**：只保留 `util/index.ts` 一处，`params.ts` 改为转发导出。

```diff
--- a/src/admin/params.ts
+++ b/src/admin/params.ts
@@
-export function maskSecret(v: string): string {
-  return v.length > 10 ? `${v.slice(0, 6)}...${v.slice(-4)}` : '***';
-}
+export { maskSecret } from '../../util/index.js';
```

## M-05 巨型文件 / 上帝类（engine.ts 1948 · dashboard.ts 3263 · store 1564 · api 1384）

- **动作**：沿用项目既有抽层判据（见 `admin/response.ts` 头注）继续下钻：
  1. `Engine.handle` 的“阶梯选路 + 对冲重试” → 抽 `AttemptRunner`（依赖 router/pool/client/lr）；
  2. “失败 → 归因卡片 → 错误体/头” → 抽 `FailurePresenter`；
  3. `dashboard.ts` 的 `renderKeyRows/renderLedgerRows/renderRun` → 抽 `render/*.ts` 纯函数，转义集中在少量 `esc` 消费点。
- **验收**：`Engine.handle` 行数下降且纯函数模块可单测；行为不变（现有 287 测试保持全绿）。

## M-06 as never / as unknown as 削弱类型护栏

- **位置**：`src/admin/handlers/keys.ts:116,236`、`src/gateway/keys.ts:222-224`、`src/store/index.ts:731`
- **动作**：在 `gateway/keys.ts` 导出 `KeyCreateInput` / `KeyUpdatePatch` 接口，handler 构造该类型对象（tier 用校验函数收窄），删除 `as never`；`node:sqlite` 用 d.ts 声明模块而非断言。

## M-07 管理面 create/del/查重走全量 listKeys()（O(n)+排序）

- **位置**：`src/admin/handlers/keys.ts:85、272`
- **动作**：在 `KeyRegistry` 加 `hasLabel(label, exceptId?)` 与 `findView(keyId)`，内部直接遍历 `byHash/dynamic` 的 `KeyRecord`（不排序、不构造全量视图）；与 C-02 的 label 去重共用同一实现。

## M-08 流包装器未实现 cancel → 上游流不被销毁（实测确认）

- **位置**：`src/upstream/client.ts:971-1017`（`dropUsageOnlyFrames`）、`898-949`（`rewriteSseModel`）

```diff
--- a/src/upstream/client.ts
+++ b/src/upstream/client.ts
@@ dropUsageOnlyFrames(stream) {
   let buffer = ''; let dropNextBlank = false;
+  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
   return new ReadableStream<Uint8Array>({
     async start(controller) {
-      const reader = stream.getReader();
+      reader = stream.getReader();
       …
     },
+    // tee 的源流要“两支都取消”才销毁；不传导 cancel 就白留一条上游流（继续付费）
+    cancel(reason) { void Promise.resolve(reader?.cancel(reason)).catch(() => undefined); },
   });
 }
```

- `rewriteSseModel` 同款处理。
- **回归测试**：对包装流 `cancel()` 后断言底层源流的 `cancel` 被调用（第一轮实测脚本可直接沉淀为用例）。

## M-09 MemoryStore.records 无上限

- **位置**：`src/store/index.ts:210-213`（对比 `SqliteStore.record` 的 5 万上限，`771`）

```diff
--- a/src/store/index.ts
+++ b/src/store/index.ts
@@ record(rec) {
     this.records.push(rec);
+    if (this.records.length > MAX_MEMORY_RECORDS) this.records.splice(0, this.records.length - MAX_MEMORY_RECORDS);
     this.pending++;
 }
```

- 把 `MAX_MEMORY_RECORDS = 50_000` 提为共享常量，两个实现复用，避免再次分叉。

## M-10 relay_event 无留存清理

- **位置**：`src/store/index.ts:1102-1113`（`prune`）、`1429`（落库）

```diff
--- a/src/store/index.ts
+++ b/src/store/index.ts
@@ prune(retentionDays) {
       const r1 = this.db.prepare('DELETE FROM meter WHERE ts < ?').run(cutoff);
       const r2 = this.db.prepare('DELETE FROM trace WHERE ts < ?').run(cutoff);
+      // 事件表此前不清理：每次写操作都 INSERT，磁盘单调增长
+      const r3 = this.db.prepare('DELETE FROM relay_event WHERE ts < ?').run(cutoff);
       return Number(r1.changes) + Number(r2.changes);
 }
```

- 建议同时给 `relay_event(ts)` 或 `(kind, id)` 建索引。

## M-11 dimensionStats 拼接 SQL 标识符（纵深防御）

- **位置**：`src/store/index.ts:1128`、`1149`

```diff
--- a/src/store/index.ts
+++ b/src/store/index.ts
@@
-    const col = dimension;
+    // 运行期白名单：类型系统只是编译期约束，这里再挡一道
+    const COLS = { model: 'model', provider_id: 'provider_id', tier: 'tier', client_kind: 'client_kind' } as const;
+    const col = COLS[dimension];
```

## M-12 key 轮换失败后同一 key 记两次失败（冷却翻倍）+ 循环内重复序列化

- **位置**：`src/upstream/client.ts:649-662`、`556`

```diff
--- a/src/upstream/client.ts
+++ b/src/upstream/client.ts
@@ send(req, signal) {
     const maxKeyAttempts = this.rotator ? Math.min(this.rotator.size, 3) : 1;
+    const serializedBody = JSON.stringify(req.body);   // 轮换之间不变，提到循环外
     for (let keyAttempt = 0; keyAttempt < maxKeyAttempts; keyAttempt++) {
@@
-        const res = await this.performRequest(url, headers, JSON.stringify(req.body), controller.signal);
+        const res = await this.performRequest(url, headers, serializedBody, controller.signal);
@@
             const rotated = this.rotator.next();
             if (rotated !== undefined) { apiKey = rotated; continue; }
+            else { continue; }   // 无可用 key：不再落到下面的分支重复记账
           }
```

## M-13 upsertKeyMeta 的内存镜像 createdAt 每次被重置

- **位置**：`src/store/index.ts:1360`（`writeKeyMeta`）

```diff
--- a/src/store/index.ts
+++ b/src/store/index.ts
@@ upsertKeyMeta(meta) {
     this.writeKeyMeta({
       keyId: meta.keyId,
       …
-      createdAt: Date.now(),
+      // 与 DB 的 ON CONFLICT（不更新 created_at）保持一致
+      createdAt: this.keyMeta.get(meta.keyId)?.createdAt ?? Date.now(),
     });
```

---

# 三、建议（10）

| 编号 | 位置 | 修复动作 |
|---|---|---|
| **L-01** | `src/util/index.ts:53-58` | `timeSafeEqual` 长度不等即提前返回会泄露长度：比较前对两侧做定长 SHA-256 再 `timingSafeEqual`；或就地修正注释，明确“仅适用于高熵定长密钥”。 |
| **L-02** | `src/loss/precheck.ts:515,539,667` | 删除 `lastRole` 与未使用的 `PRECHECK_CODES.ROLE_SEQUENCE`；或补真正的角色序列校验（`role==='tool'` 且前一条非 `assistant` → `warn`）。 |
| **L-03** | `src/gateway/keys.ts:636-637` | `this.limiters.get(id) ?? new …` 改为一进一：缺失时创建并 `set` 一次后复用，避免覆盖丢弃等待中的计数。 |
| **L-04** | `src/admin/dashboard-app-min.ts` · `gen-app-min.mjs` · `dist-admin/` | 在 `npm run check` 里重新生成 min 版并比对哈希（不一致即失败）；`dist-admin` 移出源码树或加忽略 + 构建校验。 |
| **L-05** | `admin/auth · gateway/keys` | 为“唯一性 / 上限 / 幂等”类不变量补**参数化**测试，枚举所有入口（create/update/rotate/revoke/del + 直接 register）；label 唯一性用例当前会暴露 C-02。 |
| **L-06** | `package-lock.json` | `npm i -D tsx@latest`（其依赖 esbuild 已 ≥0.25）；frontend audit 0 漏洞无需处理。 |
| **L-07** | `src/store/index.ts:894-948` | `quotaSnapshot` 缓存未命中时仍 filter 最多 5 万条内存镜像：DB 可用且窗口足够时跳过内存聚合（或复用 `quotaSnapshotForAll` 的单遍思路）。 |
| **L-08** | `scripts/` · CI | 新增 `scripts/bench.mjs`（造 5 万条 → 跑 6 个读路径 → 打印毫秒），并在 `npm run check` 对关键项设上限（如管理读查询 ≤ 50 ms）；把本轮数值写进 `docs/MAINTENANCE.md` 作为基线。 |
| **L-09** | `src/store/index.ts:1319` · `src/cli.ts:700` | 给 `SqliteStore.override findTrace()`（先内存再 DB，内部复用 `sqlFindTrace`），删除 CLI 的 `as unknown as` 双重断言。 |
| **L-10** | `docs/DEPLOYMENT.md:164,380` · `server.ts:167-177` 注释 | 把“默认只允许本机读”改为条件式表述（同机隧道/反代下不成立，必须设 adminToken）；顺带复核全部安全类文档断言。 |

---

# 四、信息（2）

| 编号 | 位置 | 处理 |
|---|---|---|
| **I-01** | `src/gateway/server.ts:261-288` | KB→system 提示注入纵深：文档明确“KB 内容按不可信输入对待”；检索块已带 `[序号]` 来源标注，必要时对命中文本做注入特征提示。 |
| **I-02** | 环境（非代码） | `NODE_TLS_REJECT_UNAUTHORIZED=0` 非项目代码（全仓 580 文件零命中）；建议加入部署检查项“确认未设置该变量”，以免削弱到上游的 HTTPS 校验。 |

---

# 七、落盘执行记录（2026-10-20 执行）

> 本清单已按「批次 0 → 1 → 2 → 3」落盘。**未做 git commit / push。**

## 已修复（27 项）

| 编号 | 文件 | 落盘内容 |
|---|---|---|
| C-01 | `admin/auth.ts` | 清理条件去掉 `fails === 0`；`MAX_TRACKED_IPS = 50_000` 硬上限（写在**写入之后**，避免停在 MAX+1） |
| C-02 | `gateway/keys.ts` | `update()` 增加 label 唯一性校验（与 create 同口径） |
| C-03 | `loss/precheck.ts` | `finish()` 的 `hasBlock` 只认 block（degraded 单独表达） |
| C-04 | `core/types.ts`·`config.ts`·`gateway/server.ts`·`starter.ts`·`docs/DEPLOYMENT.md` | 新增 `server.behindProxy`（env `RELAY_BEHIND_PROXY`）：置 true 后公开端点不再信任 `remoteAddress`；adminToken 为空且 `behindProxy=true` → **error 拒绝启动**；示例配置与文档同步 |
| C-05 | `store/index.ts` | `dimensionStats` p95 改**一次扫描**（`ORDER BY k, duration_ms` + JS 取分位） |
| C-06 | `store/index.ts` | `record()` 在 `!this.db` 时直接返回；`BUF_CAP = 100_000` 上限与告警 |
| C-07 | `upstream/client.ts` | 永久失败判据收敛（401/403，或 402/429 且命中付费语义）；5xx 一律瞬态 |
| M-01 | `gateway/keys.ts` | 两处 `tiers[...]` 直接索引 → `ownLookup`（register + authenticate） |
| M-02 | `gateway/keys.ts` | 自定义 secret < 8 字符 → 抛错（不再静默替换） |
| M-03 | `gateway/server.ts`·`admin/api.ts` | 两处 `decodeURIComponent` 包 try/catch，失败回 400 |
| M-04 | `admin/params.ts` | `maskSecret` 改为从 `util/index.js` 转发导出 |
| M-06 | `gateway/keys.ts`·`admin/handlers/keys.ts` | 导出 `KeyCreateInput` / `KeyUpdatePatch`；删除 `as never` |
| M-07 | `gateway/keys.ts`·`admin/handlers/keys.ts` | 新增 `hasLabel()` / `findView()`；create 查重与 del 定位改用它（不再全量 `listKeys()`） |
| M-08 | `upstream/client.ts` | `dropUsageOnlyFrames` / `rewriteSseModel` 补 `cancel(reason)` 传导（不 await） |
| M-09 | `store/index.ts` | 提取 `MAX_MEMORY_RECORDS = 50_000`；`MemoryStore.record` 加裁剪 |
| M-10 | `store/index.ts` | `prune` 增加清理 `relay_event`；schema 加 `idx_relay_event_ts` |
| M-11 | `store/index.ts` | 列名走 **Map 白名单**（用 Map 而非对象字面量——后者 `COLS['constructor']` 会命中原型链） |
| M-12 | `upstream/client.ts` | `JSON.stringify` 提到轮换循环外；`noted` 标志消除同一 key 重复记账 |
| M-13 | `store/index.ts` | `writeKeyMeta` 保留既有 `createdAt`（`keyMeta` 改 `protected`） |
| L-01 | `util/index.ts` | `timeSafeEqual` 先各自 SHA-256 定长化再比较 |
| L-02 | `loss/precheck.ts` | 删除 `lastRole` 与未使用的 `PRECHECK_CODES.ROLE_SEQUENCE` |
| L-03 | `gateway/keys.ts` | limiter 缺失时只创建一次并复用 |
| L-06 | `package.json` + lock | `tsx` 4.19.2 → 4.23.15（esbuild 0.23.1 → 0.28.2）；**`npm audit` 归零** |
| L-07 | `store/index.ts` | `quotaSnapshot` 未命中缓存时，仅在 `buffer` 非空才聚合内存镜像 |
| L-08 | `scripts/bench.mjs` + `package.json` | 新增读路径基线脚本与 `npm run bench`（带预算断言，超预算退出码 1） |
| L-09 | `store/index.ts`·`cli.ts` | `SqliteStore.override findTrace()`；删除 CLI 的 `as unknown as` 断言 |
| L-10 | `docs/DEPLOYMENT.md` | 安全表述改条件式 + 新增 behindProxy 行 + 补 `/v1/quota`·`/v1/panel` 验证命令 |
| I-01 | `docs/MAINTENANCE.md` | 补「KB 内容按不可信输入对待」边界 |
| I-02 | `docs/MAINTENANCE.md` | 补「不要设 `NODE_TLS_REJECT_UNAUTHORIZED=0`」检查项 |

## 后续批次落盘（2026-10-25 · 批次 C）

> 承接上表保留的 3 项，本轮已全部落盘；并修复 1 项**既有** e2e 失败。

| 编号 | 文件 | 落盘内容 |
|---|---|---|
| **M-05** | `src/gateway/presenter.ts`（新增）· `src/gateway/engine.ts` · `src/test/presenter.test.ts`（新增） | 抽出 `FailurePresenter`（错误码映射 / 错误体拼装 / 归因附加 / 归因头 / 内容 HMAC 回显）与 `headerSafe`；两个依赖（`LossReductionConfig`、`hideUpstream`）以**取值函数**注入（配置刷新即时生效，非快照）。`engine.ts` **1856 → 1665 行**；新增 8 项纯函数单测。 |
| **L-04** | `scripts/check-generated.mjs`（新增）· `package.json` · `.gitignore`（新增） | `npm run check` 追加生成物门禁：① min 新鲜度（`APP_SRC` sha256 == 产物记录）；② min 可复现（esbuild 重算须与产物逐字节一致）；③ `dist-admin/index.html` 引用的 `/admin/assets/*` 必须存在。另补 `.gitignore`（`dist/`、`dist-admin/`、`node_modules/`、`data/` 不入源码树）。 |
| **L-05** | `src/gateway/keys.ts` · `src/test/key-invariants.test.ts`（新增） | 新增**全入口**参数化不变量测试（唯一性 / 幂等 / 上限与校验三类）；并补齐最后一口：`register()`（配置装载入口）此前可绕过 label 唯一性，现与 create/update **等价 fail-fast**（同一 id 重复注册不算冲突）。 |
| **既有 e2e** | `src/test/e2e.test.ts` | 修复长期失败项「管理接口…（本机无令牌时放行）」，真实成因是断言按**源码形态**（`'ov'`、函数名 `statusBanner`）书写，而面板命中新鲜哈希时服务**压缩版**（键去引号 / 标识符混淆）。断言改为压缩版同样保留的字面量，语义不变且对两种产物形态都成立。 |

### 验证（2026-10-25）

| 项目 | 结果 |
|---|---|
| `npm run typecheck` | **0 error** |
| `npm test` | **364/364 通过**（352 基线 + L-05 4 例 + M-05 8 例；e2e 既有失败项已修） |
| `npm run check` | PASS（配置检查 + 生成物一致性门禁） |
| L-04 门禁负向测试 | 人为扰动 min 记录哈希 → 按预期 FAIL（GEN-A2）并退出码 1；恢复后 PASS |
| M-05 等价性 | `engine.ts`/`store/index.ts` 等 4 个恢复文件重建产物与原始 post-S1 产物**逐字节一致** |

> 仍未闭环（非本清单范围，建议单列）：① `dist/test/s1-fixes.test.js` 无同名源码（`src/test/s1-fixes.test.ts` 缺失，属历史产物残留，清库重建会丢失该回归）；② M-05 原方案中「`dashboard.ts` 的 render* 抽成 `render/*.ts`」—— `APP_SRC` 是整块模板字符串，其函数不是真实 TS 模块，需改构建期架构方可拆分，故本轮只落 engine 侧。

## 新增回归测试（`src/test/review-fixes.test.ts`，10 例）

| 用例 | 对应编号 |
|---|---|
| 失败表解锁后必须被回收（fails>0 也不例外） | C-01 |
| 失败表硬上限（5 万条后不再增长） | C-01 |
| label 唯一性在 create 与 update 两个入口等价 | C-02 |
| 自定义 secret 过短必须报错 | M-02 |
| SQLite 降级为内存时 buffer 保持为空 | C-06 |
| MemoryStore 明细上限 5 万 | M-09 |
| `dropUsageOnlyFrames` 传导 cancel | M-08 |
| `rewriteSseModel` 传导 cancel | M-08 |
| `dimensionStats` 维度白名单对 `constructor` 安全 | M-11 |
| `timeSafeEqual` 行为不变 | L-01 |

## 验证结果（2026-10-20）

| 项目 | 结果 |
|---|---|
| `npm run typecheck` | **0 error** |
| `npm test` | **297/297 通过**（原 287 + 新增 10） |
| `npm audit` | **0 vulnerabilities**（原 2 moderate） |
| `node scripts/bench.mjs`（5 万条 / 24h） | 全部 PASS |

`dimensionStats` 改善实测（5 万条）：`'model'` **1199 ms → 169.6 ms**（≈7×）、`'provider_id'` **414 ms → 159.4 ms**；
其余：`windowStats` 70 ms、`attributionStats` 56 ms、`series` 50 ms、`quotaSnapshotForAll(332)` 32 ms。
（剩余成本来自“一次全窗口扫描 + 排序”，已是单次扫描下限；若要再降需给 `meter` 加表达式列索引或异步化，见 C-05 方案 C。）

## ⚠️ 行为变更提示（需你确认）

1. **C-04 新增 `server.behindProxy`（默认 `false`）。**
   - 默认 `false` 时行为**与改动前一致**（本机 Hermes 插件读 `/v1/quota` 照旧可用）。
   - **同机隧道/反代部署必须显式置 `true`**，否则 C-04 的暴露面仍在（这是刻意的：不牺牲本机可用性，而要求部署者声明拓扑）。置 `true` 且未设 `RELAY_ADMIN_TOKEN` 会**拒绝启动**。
2. **L-02 移除了 `PRECHECK_CODES.ROLE_SEQUENCE`** —— 若有外部代码引用该常量名，会编译/运行失败（仓库内零引用）。
3. **`npm install` 生成物**：仓库无 `.gitignore`，当前目录下已有 `node_modules/`、`dist/`。打包竞赛作品前请确认取舍。

---

# 八、验收清单（执行后状态）

- [x] `npm run typecheck` → 0 error
- [x] `npm test` → 297/297 通过（含新增 10 例）
- [x] 新增：C-01 / C-02 / C-06 / M-08 / M-09 / M-11 回归用例
- [x] 新增：`scripts/bench.mjs` + `npm run bench`，5 万行下全部指标在预算内（L-08）
- [ ] 手工验证（同机隧道拓扑）：`curl <隧道地址>/v1/quota` → 403/404（需你在真实隧道环境执行）
- [x] 复核安全类文档断言与实现一致（L-10 / I-01 / I-02）

---

# 六、上下文备注（影响个别定级）

- M-07 定级依据来自注释“332 把 key”的侧证，非生产实测。
- L-05 需确认 `test/authdiag.test.ts` 是否已覆盖 `rateLimits` 锁定/清理路径。
- L-04 取决于是否有 CI；仓库内**无 `.gitignore`**，请确认 `dist/`、`node_modules/`、`dist-admin/` 的打包取舍。
- 未逐行通读：`upstream/pool.ts`(809)、`admin/api.ts` handler 细节、`kb/store.ts` 检索算法。