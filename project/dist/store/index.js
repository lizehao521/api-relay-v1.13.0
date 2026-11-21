/**
 * 存储层：SQLite（默认，node:sqlite）与内存实现，二者共用同一接口。
 *
 * 设计约束（来自评估文档 §3.2 / §8）：
 * - 网关主路径（鉴权、预检、路由、透传）**不依赖数据库**；数据库只承担度量、轨迹、
 *   key/额度/限流的持久化。数据库故障必须能降级为内存，绝不拖垮转发。
 * - 不落盘 prompt / completion 正文，只落哈希、计数、字节数与 token 数。
 * - 写入走批量缓冲，读取只服务管理看板。
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { percentile, round, safeJsonParse } from '../util/index.js';
/** 未通过鉴权的请求在度量里使用的占位 keyId（不是真的存在这个 key） */
export const UNATTRIBUTED_KEY_ID = 'anonymous';
/**
 * 看板/报表中给"没归属"的请求统一使用的桶名。
 * 曾经它们被记成 model="" / provider="" / tier=free，读起来像"免费层全挂了"，
 * 实际是"根本没人通过鉴权"。口径必须说人话（ADR-016）。
 */
export const UNATTRIBUTED = '(未鉴权)';
/** 额度快照缓存的桶宽（毫秒）。额度是 30 天量级的账，5 秒滞后无关紧要。 */
const QUOTA_BUCKET_MS = 5_000;
/**
 * 内存镜像保留的最大明细条数（M-09 修复）。
 *
 * 两个实现必须共用同一常量：此前 SqliteStore 裁到 5 万，而 MemoryStore **完全不裁**，
 * 于是 `storage.driver: memory`（或 SQLite 不可用回退到内存）时 records 无界增长
 * —— 实测记 30 万条即 30 万条常驻、堆 +166 MB，且所有 `slice()` 读路径随之线性变慢。
 */
const MAX_MEMORY_RECORDS = 50_000;
/**
 * 落盘缓冲的硬上限（C-06 修复，条数）。
 * 正常路径由 batchSize 触发 flush，不会到这；它是「DB 长期不可用」时的最后一道闸。
 */
const BUF_CAP = 100_000;
/* ------------------------------------------------------------------ *
 * 内存实现
 * ------------------------------------------------------------------ */
export class MemoryStore {
    records = [];
    traces = [];
    rate = new Map();
    pending = 0;
    lastFlushAt = null;
    lastError;
    degraded = 0;
    // 商户券闭环内存表
    storeVoucher = new Map();
    storeRedemption = new Map();
    merchantQuota = new Map();
    async init() { }
    record(rec) {
        this.records.push(rec);
        // M-09 修复：加上限（与 SqliteStore 同口径），避免 driver=memory 时无界增长
        if (this.records.length > MAX_MEMORY_RECORDS) {
            this.records.splice(0, this.records.length - MAX_MEMORY_RECORDS);
        }
        this.pending++;
    }
    recordTrace(trace) {
        this.traces.push(trace);
        if (this.traces.length > 2000)
            this.traces.splice(0, this.traces.length - 2000);
    }
    async flush() {
        this.pending = 0;
        this.lastFlushAt = Date.now();
    }
    async close() {
        await this.flush();
    }
    /** 执行 SQL 查询（用于商户券闭环等自定义表） */
    async query(sql, params = []) {
        const upper = sql.toUpperCase().trim();
        if (upper.startsWith('SELECT * FROM STORE_VOUCHER WHERE CODE =')) {
            const code = String(params[0]);
            for (const row of this.storeVoucher.values()) {
                if (row['code'] === code) {
                    return [row];
                }
            }
            return [];
        }
        else if (upper.startsWith('SELECT * FROM MERCHANT_QUOTA WHERE TENANT_ID =')) {
            const tenantId = String(params[0]);
            const row = this.merchantQuota.get(tenantId);
            if (row) {
                return [row];
            }
            return [];
        }
        // MemoryStore 不持久化数据，返回空数组
        return [];
    }
    /** 执行 SQL 语句（INSERT/UPDATE/DELETE） */
    async execute(sql, params = []) {
        const upper = sql.toUpperCase().trim();
        let changes = 0;
        if (upper.startsWith('INSERT INTO store_voucher')) {
            const id = String(params[0]);
            this.storeVoucher.set(id, {
                id: params[0],
                code: params[1],
                campaign_id: params[2],
                store_id: params[3],
                tenant_id: params[4],
                token_amount: params[5],
                status: params[6],
                expires_at: params[7],
                created_at: params[8],
            });
            changes = 1;
        }
        else if (upper.startsWith('INSERT INTO store_redemption')) {
            const id = String(params[0]);
            this.storeRedemption.set(id, {
                id: params[0],
                voucher_id: params[1],
                key_id: params[2],
                hash_prefix: params[3],
                ts: params[4],
                status: params[5],
            });
            changes = 1;
        }
        else if (upper.startsWith('INSERT INTO merchant_quota')) {
            const tenantId = String(params[0]);
            const existing = this.merchantQuota.get(tenantId);
            if (existing) {
                // ON CONFLICT: 累加 purchased_tokens，更新 period_start，更新 status
                existing['purchased_tokens'] = (Number(existing['purchased_tokens']) || 0) + Number(params[2]);
                existing['period_start'] = params[1];
                existing['status'] = params[5];
            }
            else {
                this.merchantQuota.set(tenantId, {
                    tenant_id: params[0],
                    period_start: params[1],
                    purchased_tokens: params[2],
                    issued_tokens: params[3],
                    consumed_tokens: params[4],
                    status: params[5],
                });
            }
            changes = 1;
        }
        else if (upper.startsWith('UPDATE store_voucher')) {
            if (upper.includes('WHERE CODE =')) {
                const code = String(params[2]);
                const expiresAt = Number(params[4]);
                for (const [id, row] of this.storeVoucher) {
                    if (String(row['code']) === code && String(row['status']) === 'unused' && Number(row['expires_at']) > expiresAt) {
                        row['status'] = params[0];
                        row['claim_at'] = params[1];
                        changes = 1;
                        break;
                    }
                }
            }
            else if (upper.includes('WHERE ID =')) {
                const id = String(params[2]);
                const row = this.storeVoucher.get(id);
                if (row) {
                    if (upper.includes('SET STATUS =')) {
                        row['status'] = params[0];
                    }
                    if (upper.includes('KEY_ID')) {
                        row['key_id'] = params[1];
                    }
                    if (upper.includes('CLAIM_AT = NULL')) {
                        row['claim_at'] = null;
                    }
                    changes = 1;
                }
            }
        }
        else if (upper.startsWith('UPDATE merchant_quota')) {
            const tenantId = String(params[1]);
            const row = this.merchantQuota.get(tenantId);
            if (row) {
                if (upper.includes('ISSUED_TOKENS = ISSUED_TOKENS +')) {
                    row['issued_tokens'] = (Number(row['issued_tokens']) || 0) + Number(params[0]);
                }
                else if (upper.includes('ISSUED_TOKENS = ISSUED_TOKENS -')) {
                    row['issued_tokens'] = (Number(row['issued_tokens']) || 0) - Number(params[0]);
                }
                else if (upper.includes('SET STATUS =')) {
                    row['status'] = params[0];
                }
                changes = 1;
            }
        }
        return changes;
    }
    slice(sinceMs) {
        return this.records.filter((r) => r.ts >= sinceMs);
    }
    recordsSince(sinceMs) {
        return this.slice(sinceMs);
    }
    oldestInWindow(sinceMs) {
        let oldest = 0;
        for (const r of this.records) {
            if (r.ts < sinceMs)
                continue;
            if (oldest === 0 || r.ts < oldest)
                oldest = r.ts;
        }
        return oldest;
    }
    windowStatsPreferPersistent(sinceMs) {
        return this.windowStats(sinceMs);
    }
    windowStats(sinceMs) {
        const rows = this.slice(sinceMs);
        const durations = rows.map((r) => r.durationMs).sort((a, b) => a - b);
        return {
            requests: rows.length,
            errors: rows.filter((r) => r.outcome !== 'success').length,
            tokens: rows.reduce((s, r) => s + r.totalTokens, 0),
            costCny: round(rows.reduce((s, r) => s + r.costCny, 0), 6),
            listCostCny: round(rows.reduce((s, r) => s + (r.listCostCny ?? 0), 0), 6),
            avgDurationMs: rows.length ? Math.round(durations.reduce((a, b) => a + b, 0) / rows.length) : 0,
            p95DurationMs: Math.round(percentile(durations, 95)),
        };
    }
    series(sinceMs, bucketMs) {
        const rows = this.slice(sinceMs);
        const buckets = new Map();
        for (const r of rows) {
            const b = Math.floor(r.ts / bucketMs) * bucketMs;
            const arr = buckets.get(b);
            if (arr)
                arr.push(r);
            else
                buckets.set(b, [r]);
        }
        return [...buckets.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([ts, arr]) => ({
            ts,
            requests: arr.length,
            errors: arr.filter((r) => r.outcome !== 'success').length,
            tokens: arr.reduce((s, r) => s + r.totalTokens, 0),
            costCny: round(arr.reduce((s, r) => s + r.costCny, 0), 6),
            avgDurationMs: Math.round(arr.reduce((s, r) => s + r.durationMs, 0) / arr.length),
        }));
    }
    keyUsage(keyId, sinceMs) {
        const rows = this.slice(sinceMs).filter((r) => r.keyId === keyId);
        const first = rows[0];
        return {
            keyId,
            tenantId: first?.tenantId ?? '',
            tier: first?.tier ?? 'free',
            totalTokens: rows.reduce((s, r) => s + r.totalTokens, 0),
            costCny: round(rows.reduce((s, r) => s + r.costCny, 0), 6),
            requests: rows.length,
        };
    }
    usageByTier(sinceMs) {
        const rows = this.slice(sinceMs);
        const map = new Map();
        for (const r of rows) {
            const cur = map.get(r.tier) ?? { tokens: 0, costCny: 0, requests: 0 };
            cur.tokens += r.totalTokens;
            cur.costCny += r.costCny;
            cur.requests++;
            map.set(r.tier, cur);
        }
        return [...map.entries()].map(([tier, v]) => ({ tier, ...v, costCny: round(v.costCny, 6) }));
    }
    attributionStats(sinceMs) {
        // 单趟聚合（manual#393·性能第一位）：原实现对窗口做 14 趟 filter/reduce
        // （errors→clientAuth→upstream→delivered→durationSum→overheadUs→autoRecovered→
        // duplicates→violations→blocked→degraded→两个 UsAvg→lastAt），内存镜像越大越亏。
        // 输出字段与取值与原版等价（同一批谓词同一批聚合），已用真实数据双跑比对。
        // 「客户端 key 不对」（网关 401，无上游参与）与「上游拒绝密钥」是两件事——
        // 前者只进 clientAuth，绝不混进 byReason 冒充上游故障（总览横幅指错方向）。
        const rows = this.slice(sinceMs);
        const byReason = new Map();
        const byAction = new Map();
        let errors = 0, clientAuth = 0, clientAuthLastAt = 0, delivered = 0;
        let durationSum = 0, overheadUs = 0, precheckUsSum = 0, classifyUsSum = 0;
        let autoRecovered = 0, duplicates = 0, violations = 0, blocked = 0, degraded = 0;
        for (const r of rows) {
            durationSum += r.durationMs;
            precheckUsSum += r.precheckUs;
            classifyUsSum += r.classifyUs;
            overheadUs += r.precheckUs + r.classifyUs;
            if (r.outcome === 'success') {
                if (r.attemptCount > 1)
                    autoRecovered++;
            }
            else {
                errors++;
                if (r.attributionDelivered)
                    delivered++;
                if (r.failureReason === 'auth_invalid' && !r.providerId) {
                    clientAuth++;
                    if (r.ts > clientAuthLastAt)
                        clientAuthLastAt = r.ts;
                }
                else {
                    if (r.failureReason) {
                        const cur = byReason.get(r.failureReason) ?? { count: 0, recoverable: 0 };
                        cur.count++;
                        if (r.recoverable)
                            cur.recoverable++;
                        byReason.set(r.failureReason, cur);
                    }
                    if (r.quickAction)
                        byAction.set(r.quickAction, (byAction.get(r.quickAction) ?? 0) + 1);
                }
            }
            if (r.duplicateInWindow > 1)
                duplicates++;
            violations += r.precheckViolations;
            if (r.precheckBlocked)
                blocked++;
            if (r.precheckDegraded)
                degraded++;
        }
        return {
            byReason: [...byReason.entries()]
                .map(([reason, v]) => ({ reason, ...v }))
                .sort((a, b) => b.count - a.count),
            byAction: [...byAction.entries()].map(([action, count]) => ({ action, count })).sort((a, b) => b.count - a.count),
            coverage: { total: errors, delivered, autoRecovered },
            duplicates,
            precheck: { violations, blocked, degraded },
            overhead: {
                precheckUsAvg: rows.length ? round(precheckUsSum / rows.length, 2) : 0,
                classifyUsAvg: rows.length ? round(classifyUsSum / rows.length, 2) : 0,
                overheadRatioAvg: durationSum ? round(overheadUs / 1000 / durationSum, 6) : 0,
            },
            clientAuth: { count: clientAuth, lastAt: clientAuthLastAt },
        };
    }
    topErrors(sinceMs, limit) {
        const rows = this.slice(sinceMs).filter((r) => r.failureReason);
        const map = new Map();
        for (const r of rows) {
            const key = r.failureReason;
            const cur = map.get(key);
            if (cur)
                cur.count++;
            else
                map.set(key, { count: 1, example: `${r.model}@${r.providerId} HTTP ${r.httpStatus}` });
        }
        return [...map.entries()]
            .map(([reason, v]) => ({ reason, ...v }))
            .sort((a, b) => b.count - a.count)
            .slice(0, limit);
    }
    recentTraces(limit) {
        return this.traces.slice(-limit).reverse();
    }
    /** 内存实现：直接由内存镜像聚合（等价于 dimensionStats 的默认语义） */
    recentPersistedTraces(limit) {
        return this.recentTraces(limit);
    }
    dimensionStats(sinceMs, dimension) {
        const rows = this.slice(sinceMs);
        if (rows.length === 0)
            return undefined;
        const out = new Map();
        for (const r of rows) {
            const key = dimensionKey(r, dimension);
            const cur = out.get(key) ?? { requests: 0, errors: 0, tokens: 0, cost: 0, listCost: 0, cachedTokens: 0, durationSum: 0, durationCount: 0, p95: 0, durations: [] };
            cur.requests++;
            if (r.outcome !== 'success')
                cur.errors++;
            cur.tokens += r.totalTokens;
            cur.cost += r.costCny;
            cur.listCost += r.listCostCny ?? 0;
            cur.cachedTokens += r.cachedPromptTokens;
            cur.durationSum += r.durationMs;
            cur.durationCount++;
            cur.durations.push(r.durationMs);
            out.set(key, cur);
        }
        const result = new Map();
        for (const [k, v] of out) {
            v.durations.sort((a, b) => a - b);
            result.set(k, {
                requests: v.requests,
                errors: v.errors,
                tokens: v.tokens,
                cost: v.cost,
                listCost: v.listCost,
                cachedTokens: v.cachedTokens,
                durationSum: v.durationSum,
                durationCount: v.durationCount,
                p95: v.durations.length ? v.durations[Math.min(v.durations.length - 1, Math.floor(v.durations.length * 0.95))] : 0,
            });
        }
        return result;
    }
    findTrace(traceId) {
        return this.traces.find((t) => t.traceId === traceId);
    }
    health() {
        return {
            driver: 'memory',
            ok: true,
            pendingWrites: this.pending,
            lastFlushAt: this.lastFlushAt,
            degradedEvents: this.degraded,
            ...(this.lastError ? { lastError: this.lastError } : {}),
        };
    }
    quotaSnapshot(keyId, sinceMs) {
        const u = this.keyUsage(keyId, sinceMs);
        return { tokens: u.totalTokens, costCny: u.costCny, requests: u.requests };
    }
    /**
     * 批量额度快照（内存实现，每个 key 使用各自的 windowStart）。
     *
     * v410 优化：改为**单次遍历** records 聚合。此前是逐 key 调 `quotaSnapshot` →
     * `keyUsage` → `slice()`（`records.filter` 每次都新建数组）+ 再一次 `filter`，
     * 复杂度 O(N_key × M_records) 且伴随 N 次大数组分配。332 key × ~1 万条实测 6.5ms，
     * 是 /keys 修掉重置 N+1 之后的下一个瓶颈（吞吐仍被压在 ~100 req/s）。
     * 单遍后同口径、无分配。
     */
    quotaSnapshotForAll(keyIds, windowStarts) {
        const result = new Map();
        if (keyIds.length === 0)
            return result;
        const need = new Set(keyIds);
        // 注意：内存镜像用**原始 sinceMs**，不做 5 秒取整——`MemoryStore.quotaSnapshot`
        // 走 `keyUsage` → `slice(sinceMs)`，用的就是原始值。取整只发生在 SQLite 的 DB 侧。
        // （口径必须与逐 key 版逐字一致，否则"批量=逐key"的等价性断言会红。）
        const since = new Map();
        for (const keyId of keyIds)
            since.set(keyId, windowStarts.get(keyId) ?? 0);
        const agg = new Map();
        for (const r of this.records) {
            if (!need.has(r.keyId))
                continue;
            if (r.ts < (since.get(r.keyId) ?? 0))
                continue;
            let a = agg.get(r.keyId);
            if (!a) {
                a = { tokens: 0, costCny: 0, requests: 0 };
                agg.set(r.keyId, a);
            }
            a.tokens += r.totalTokens;
            a.costCny += r.costCny;
            a.requests += 1;
        }
        for (const keyId of keyIds) {
            const a = agg.get(keyId);
            // 与 keyUsage 同口径：costCny 累加后 round(…, 6)
            result.set(keyId, a ? { tokens: a.tokens, costCny: round(a.costCny, 6), requests: a.requests } : { tokens: 0, costCny: 0, requests: 0 });
        }
        return result;
    }
    rateCount(keyId, windowStartMs) {
        return this.rate.get(`${keyId}:${windowStartMs}`) ?? 0;
    }
    incrRate(keyId, windowStartMs) {
        const k = `${keyId}:${windowStartMs}`;
        const next = (this.rate.get(k) ?? 0) + 1;
        this.rate.set(k, next);
        if (this.rate.size > 20_000) {
            // 清掉过期窗口
            for (const key of this.rate.keys()) {
                const ts = Number(key.slice(key.lastIndexOf(':') + 1));
                if (ts < windowStartMs - 120_000)
                    this.rate.delete(key);
            }
        }
        return next;
    }
    async prune(_retentionDays) {
        return 0;
    }
    /* ---------------- 事件与元数据（内存实现） ---------------- */
    events = [];
    // M-13 修复：改 protected —— SqliteStore.upsertKeyMeta 需要读既有 createdAt 才不会重置它
    keyMeta = new Map();
    /** 控制面文档（批次3）：内存实现为进程内；SqliteStore 覆写为落盘 */
    controlDocs = new Map();
    /** 供子类（SqliteStore）写入内存镜像：类字段不能通过 super 访问，所以包一层 */
    writeKeyMeta(meta) {
        this.keyMeta.set(meta.keyId, meta);
    }
    logEvent(level, kind, detail) {
        this.events.push({ ts: Date.now(), level, kind, detail: JSON.stringify(detail) });
        if (this.events.length > 5000)
            this.events.splice(0, this.events.length - 5000);
    }
    listEvents(limit) {
        // 与 SQLite 实现保持一致：`detail` 一律返回**对象**（内存实现内部存的是 JSON 字符串）。
        // 两个实现返回不同形态，会让面板不得不在前端写两套解析 —— 2026-09-14 统一掉。
        return this.events
            .slice(-limit)
            .reverse()
            .map((e) => ({
            ts: e.ts,
            level: e.level,
            kind: e.kind,
            detail: safeJsonParse(String(e.detail)) ?? {},
        }));
    }
    loadControlDoc(key) {
        return this.controlDocs.get(key);
    }
    saveControlDoc(key, doc) {
        this.controlDocs.set(key, doc);
    }
    listKeyMeta() {
        return [...this.keyMeta.values()].sort((a, b) => a.createdAt - b.createdAt);
    }
    setKeyMetaEnabled(keyId, enabled) {
        const meta = this.keyMeta.get(keyId);
        if (meta)
            meta.enabled = enabled;
    }
    /** 硬删除 key 元数据（B2·审查修复）：内存实现直接摘掉该行。 */
    deleteKeyMeta(keyId) {
        this.keyMeta.delete(keyId);
    }
    lastQuotaResetAt(keyId) {
        for (let i = this.events.length - 1; i >= 0; i--) {
            const e = this.events[i];
            if (e.kind !== 'quota.reset')
                continue;
            try {
                const detail = JSON.parse(e.detail);
                if (detail['keyId'] === keyId)
                    return e.ts;
            }
            catch {
                /* ignore */
            }
        }
        return 0;
    }
    /**
     * 批量版（v410）：倒序扫一遍事件环，每个 key 只记**首次**遇到（= 最新一条）。
     * 与逐 key 版同语义：都是从最新往回找第一条匹配。
     */
    lastQuotaResetForAll(keyIds) {
        const want = new Set(keyIds);
        const out = new Map();
        for (let i = this.events.length - 1; i >= 0; i--) {
            const e = this.events[i];
            if (e.kind !== 'quota.reset')
                continue;
            try {
                const detail = JSON.parse(e.detail);
                const kid = detail['keyId'];
                if (typeof kid === 'string' && want.has(kid) && !out.has(kid))
                    out.set(kid, e.ts);
            }
            catch {
                /* ignore */
            }
        }
        return out;
    }
}
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meter (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  trace_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  client_kind TEXT NOT NULL,
  agent_score REAL NOT NULL DEFAULT 0,
  model TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  stream INTEGER NOT NULL DEFAULT 0,
  tool_calling INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL,
  http_status INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  ttfb_ms INTEGER,
  bytes_in INTEGER NOT NULL DEFAULT 0,
  bytes_out INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cached_prompt_tokens INTEGER NOT NULL DEFAULT 0,
  cost_cny REAL NOT NULL DEFAULT 0,
  list_cost_cny REAL NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  failure_reason TEXT,
  quick_action TEXT,
  recoverable INTEGER,
  precheck_violations INTEGER NOT NULL DEFAULT 0,
  precheck_blocked INTEGER NOT NULL DEFAULT 0,
  precheck_degraded INTEGER NOT NULL DEFAULT 0,
  precheck_us REAL NOT NULL DEFAULT 0,
  classify_us REAL NOT NULL DEFAULT 0,
  attribution_delivered INTEGER NOT NULL DEFAULT 0,
  duplicate_in_window INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_meter_ts ON meter(ts);
-- B5（审查修复·能力层根因）：以下两条索引服务**不同**查询，需并存——
--   · (ts, duration_ms)：窗口聚合与维度 p95 的 ts 范围扫描；
--   · (duration_ms)：windowStats 的 p95 排序键（ORDER BY duration_ms LIMIT 1 OFFSET k）。
-- SQLite 一次查询只用一条索引，故单列索引不可省。
CREATE INDEX IF NOT EXISTS idx_meter_ts_duration ON meter(ts, duration_ms);
CREATE INDEX IF NOT EXISTS idx_meter_duration ON meter(duration_ms);
CREATE INDEX IF NOT EXISTS idx_meter_key_ts ON meter(key_id, ts);
CREATE INDEX IF NOT EXISTS idx_meter_reason ON meter(failure_reason, ts);
CREATE INDEX IF NOT EXISTS idx_meter_provider ON meter(provider_id, ts);

CREATE TABLE IF NOT EXISTS trace (
  trace_id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trace_ts ON trace(ts);

CREATE TABLE IF NOT EXISTS key_meta (
  key_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  tier TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  allowed_models TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  monthly_quota_override INTEGER,
  cost_quota_override REAL,
  key_hash TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT 'config'
);
CREATE INDEX IF NOT EXISTS idx_key_meta_hash ON key_meta(key_hash);

CREATE TABLE IF NOT EXISTS key_day_usage (
  -- 历史兼容：**本实现已不再写入/读取**（额度快照走 meter 明细的精确聚合，见 quotaSnapshot）。
  -- 留在 schema 里是为了旧库能打开；不要再照它写"按天分桶"的额度判定（那套已被删除）。
  key_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  cost_cny REAL NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, day)
);

CREATE TABLE IF NOT EXISTS breaker_state (
  provider_id TEXT PRIMARY KEY,
  open_until INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_reason TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS relay_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL
);
-- M-10 修复：prune 现在也清理事件表，给它一个 ts 索引（否则 DELETE ... WHERE ts < ? 全表扫）
CREATE INDEX IF NOT EXISTS idx_relay_event_ts ON relay_event(ts);

-- 商户 token 券闭环（M0 概念验证）：券、核销流水、额度池
-- 与租户/套餐/账单同为控制面实体，但放独立表（不放 control_doc），
-- 因券是高频写入且需要唯一约束与条件更新。
CREATE TABLE IF NOT EXISTS store_voucher (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  campaign_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  token_amount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unused',
  expires_at INTEGER NOT NULL,
  claim_at INTEGER,
  key_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_store_voucher_code ON store_voucher(code);
CREATE INDEX IF NOT EXISTS idx_store_voucher_tenant ON store_voucher(tenant_id);
CREATE INDEX IF NOT EXISTS idx_store_voucher_status ON store_voucher(status);

CREATE TABLE IF NOT EXISTS store_redemption (
  id TEXT PRIMARY KEY,
  voucher_id TEXT NOT NULL,
  key_id TEXT,
  hash_prefix TEXT,
  device_fp TEXT,
  ip TEXT,
  ua TEXT,
  ts INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'success'
);
CREATE INDEX IF NOT EXISTS idx_store_redemption_voucher ON store_redemption(voucher_id);
CREATE INDEX IF NOT EXISTS idx_store_redemption_key ON store_redemption(key_id);

CREATE TABLE IF NOT EXISTS merchant_quota (
  tenant_id TEXT PRIMARY KEY,
  period_start INTEGER NOT NULL,
  purchased_tokens INTEGER NOT NULL DEFAULT 0,
  issued_tokens INTEGER NOT NULL DEFAULT 0,
  consumed_tokens INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'
);

-- 控制面文档存储（批次3）：租户 / 套餐 / 账单状态 / 角色矩阵等以 JSON 文档整存整取。
-- 与 meter（明细）/key_meta（结构化行）不同——这些是可变的"配置态对象"，整文档读写更简单可靠。
CREATE TABLE IF NOT EXISTS control_doc (
  key TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;
const INSERT_METER = `
INSERT INTO meter (
  ts, trace_id, request_id, key_id, tenant_id, tier, client_kind, agent_score, model, provider_id,
  stream, tool_calling, outcome, http_status, duration_ms, ttfb_ms, bytes_in, bytes_out,
  prompt_tokens, completion_tokens, total_tokens, cached_prompt_tokens, cost_cny, list_cost_cny, attempt_count,
  failure_reason, quick_action, recoverable, precheck_violations, precheck_blocked, precheck_degraded,
  precheck_us, classify_us, attribution_delivered, duplicate_in_window
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
export class SqliteStore extends MemoryStore {
    opts;
    db;
    buffer = [];
    traceBuffer = [];
    timer;
    flushing = false;
    logger;
    // （已删除：key_day_usage 曾是"按 UTC 天分桶"的额度依据，2026-09-14 改为 meter 明细
    //  精确聚合后它只剩历史意义，写入路径一并删除，见 CREATE TABLE 的注释）
    /** 额度快照的 5 秒桶缓存（见 quotaSnapshot 的说明） */
    quotaCache = new Map();
    /*
     * （S1-1 修复：已删除 pendingRate 桥接层）
     *
     * 原实现：incrRate 时把计数同步写进 pendingRate，flush 时快照（但**从未落库**——
     * INSERT 只有 meter/trace 两类），失败时回填。这造成三套计数并存且互不感知：
     *   ① MemoryStore.rate（内存 Map，真实计数）
     *   ② pendingRate（伪持久化镜像，从未进 DB）
     *   ③ Redis SharedStateStore（注入后的真实共享计数）
     * rateCount 的 `pendingRate.get(...) ?? super.rateCount(...)` 读序意味着：
     * flush 成功清空 pendingRate 后回落内存值——单实例数值恰好一致（掩盖了问题），
     * 但"限流计数持久化"这个表面意图从未成立，重启即清零；与 Redis 路径并存时
     * 三源分裂，RPM 限流在多实例/重启场景可被绕过。
     *
     * 现口径（与 MemoryStore 的注释「限流用：固定窗口计数（内存实现，重启即重置，
     * 符合"限流无状态"取向）」对齐）：**限流计数是进程内状态，不持久化**。
     * 多实例一致性由 SharedStateStore（Redis）承担——注入 state 后 KeyRegistry
     * 走 state.incrRate，根本不经过本类。
     */
    constructor(opts) {
        super();
        this.opts = opts;
        this.logger = opts.logger;
    }
    async init() {
        try {
            const mod = (await import('node:sqlite'));
            mkdirSync(dirname(this.opts.path), { recursive: true });
            const db = new mod.DatabaseSync(this.opts.path);
            db.exec('PRAGMA journal_mode = WAL;');
            db.exec('PRAGMA synchronous = NORMAL;');
            db.exec('PRAGMA busy_timeout = 3000;');
            db.exec(SCHEMA);
            // 轻量迁移：老库的 key_meta 没有 cost_quota_override（按钱计的额度），补上。
            // SQLite 重复 ADD COLUMN 会报错，所以吞掉异常即可（列已存在就是成功）。
            try {
                db.exec('ALTER TABLE key_meta ADD COLUMN cost_quota_override REAL');
            }
            catch {
                /* 列已存在 */
            }
            // 轻量迁移 2：meter 增加 list_cost_cny（按刊例价折算的第二口径，2026-09-14 加）。
            // 老行的默认 0 = "当时没记牌面价"，不假装有值。
            try {
                db.exec('ALTER TABLE meter ADD COLUMN list_cost_cny REAL NOT NULL DEFAULT 0');
            }
            catch {
                /* 列已存在 */
            }
            this.db = db;
            this.timer = setInterval(() => {
                void this.flush().catch(() => undefined);
            }, this.opts.flushIntervalMs);
            this.timer.unref();
            this.opts.logger?.info('store.sqlite.ready', { path: this.opts.path });
        }
        catch (err) {
            // fail-open：数据库不可用则退回纯内存，网关必须继续服务
            this.db = undefined;
            this.degraded++;
            this.lastError = err instanceof Error ? err.message : String(err);
            this.opts.logger?.error('store.sqlite.init_failed_fallback_memory', { error: this.lastError });
        }
    }
    record(rec) {
        super.record(rec);
        // C-06 修复：已降级为内存（init 失败 → this.db === undefined）时**不再进落盘缓冲**。
        // flush() 在 `!this.db` 分支直接 return、从不 splice 这个 buffer，于是它会无界增长
        // （实测 30 万条常驻、堆 +166 MB）直到 OOM —— “fail-open 降级为内存”以崩溃收场。
        // 内存镜像仍由 super.record 更新，看板数据不受影响。
        if (!this.db)
            return;
        this.buffer.push(rec);
        if (this.buffer.length > BUF_CAP) {
            // 双保险：DB 写入持续失败时（flush catch 会重新入队）也不允许无界堆积
            const over = this.buffer.length - BUF_CAP;
            this.buffer.splice(0, over);
            this.opts.logger?.error('store.buffer_overflow', { droppedOldest: over });
        }
        if (this.buffer.length >= this.opts.batchSize)
            void this.flush().catch(() => undefined);
    }
    recordTrace(trace) {
        super.recordTrace(trace);
        this.traceBuffer.push(trace);
        if (this.traceBuffer.length > 1000)
            this.traceBuffer.splice(0, this.traceBuffer.length - 1000);
    }
    async flush() {
        if (!this.db || this.flushing) {
            this.pending = this.buffer.length;
            return;
        }
        if (this.buffer.length === 0 && this.traceBuffer.length === 0) {
            this.lastFlushAt = Date.now();
            this.pending = 0;
            return;
        }
        this.flushing = true;
        const meters = this.buffer.splice(0, this.buffer.length);
        const traces = this.traceBuffer.splice(0, this.traceBuffer.length);
        try {
            const ins = this.db.prepare(INSERT_METER);
            this.db.exec('BEGIN');
            for (const r of meters) {
                ins.run(r.ts, r.traceId, r.requestId, r.keyId, r.tenantId, r.tier, r.clientKind, r.agentScore, r.model, r.providerId, r.stream ? 1 : 0, r.toolCalling ? 1 : 0, r.outcome, r.httpStatus, r.durationMs, r.ttfbMs === null ? null : Math.round(r.ttfbMs), r.bytesIn, r.bytesOut, r.promptTokens, r.completionTokens, r.totalTokens, r.cachedPromptTokens, r.costCny, r.listCostCny ?? 0, r.attemptCount, r.failureReason, r.quickAction, r.recoverable === null ? null : r.recoverable ? 1 : 0, r.precheckViolations, r.precheckBlocked ? 1 : 0, r.precheckDegraded ? 1 : 0, r.precheckUs, r.classifyUs, r.attributionDelivered ? 1 : 0, r.duplicateInWindow);
            }
            const insTrace = this.db.prepare('INSERT OR REPLACE INTO trace (trace_id, ts, request_id, outcome, duration_ms, payload) VALUES (?,?,?,?,?,?)');
            for (const t of traces) {
                insTrace.run(t.traceId, t.startedAt, t.requestId, t.outcome, t.durationMs, JSON.stringify(t));
            }
            this.db.exec('COMMIT');
            this.lastFlushAt = Date.now();
            this.lastError = undefined;
        }
        catch (err) {
            try {
                this.db.exec('ROLLBACK');
            }
            catch {
                /* ignore */
            }
            this.lastError = err instanceof Error ? err.message : String(err);
            this.degraded++;
            this.opts.logger?.error('store.sqlite.flush_failed', { error: this.lastError, dropped: meters.length });
            /*
             * **重新入队，不能丢账**（2026-09-14 审计 C-4）。
             *
             * 老代码 catch 里 ROLLBACK 完就结束了 —— 本批记账（含额度）**永久消失**，
             * 面板当场看不出（内存镜像还在），重启后连面板也没了；额度没加上 = 客户白用。
             * 现在把本批拼回**队首**，下一次 flush 自动重试。
             *
             * 代价：DB 长期不可用时缓冲会堆积 —— 这是"宁可占内存也不丢账"的取舍，
             * degraded/lastError 已经立了证据。堆过上限就丢最旧的并**大声**记一笔，
             * 不能无声无息涨到 OOM。
             */
            this.buffer = meters.concat(this.buffer);
            this.traceBuffer = traces.concat(this.traceBuffer);
            const FLUSH_REQUEUE_CAP = 100_000;
            if (this.buffer.length > FLUSH_REQUEUE_CAP) {
                const over = this.buffer.length - FLUSH_REQUEUE_CAP;
                this.buffer.splice(FLUSH_REQUEUE_CAP, over);
                this.opts.logger?.error('store.sqlite.flush_buffer_overflow', { droppedOldest: over, kept: FLUSH_REQUEUE_CAP });
            }
        }
        finally {
            this.flushing = false;
            this.pending = this.buffer.length;
        }
    }
    async close() {
        if (this.timer)
            clearInterval(this.timer);
        await this.flush().catch(() => undefined);
        try {
            this.db?.exec('PRAGMA wal_checkpoint(TRUNCATE);');
            this.db?.close();
        }
        catch {
            /* ignore */
        }
    }
    health() {
        return {
            driver: 'sqlite',
            ok: !!this.db,
            path: this.opts.path,
            pendingWrites: this.buffer.length,
            lastFlushAt: this.lastFlushAt,
            degradedEvents: this.degraded,
            ...(this.lastError ? { lastError: this.lastError } : {}),
        };
    }
    /**
     * 额度快照：**按精确时间**从 `meter` 明细聚合（2026-09-14 交叉审计后重写）。
     *
     * 老实现按 UTC **天**分桶（`day >= floor(sinceMs/86400000)`），有两个错：
     *  ① **月中「重置额度」不生效** —— 窗口起点落在当天，但"当天已用的量"照样被算进来，
     *     客户仍然被 402 拦到次日；而 402 的文案承诺"重置后可在面板立刻恢复"。
     *     运营唯一的补救动作静默失效（内存实现按精确 ts，等于同一套代码两条口径）。
     *  ② **30 天滑动窗口多算最旧那天**（整天算进来，最多多 24 小时）→ 提前拦人。
     *
     * `meter` 上有 `(key_id, ts)` 索引，按 ts 范围聚合是索引扫描；再加一层 5 秒桶缓存，
     * 既够准，又不会让降损层成为瓶颈（"治理层不该成为瓶颈"是本项目的红线之一）。
     *
     * **口径要说实话**（2026-09-14 复核纠正）：窗口边界会被**向下取整到 5 秒桶**，
     * 所以重置后仍可能算上重置前最多 5 秒的用量。方向是保守（多算，不会漏拦），
     * 量级也小；但"按精确 ts 聚合""重置后立即生效"这种说法是夸大的，不要再这么写。
     * 桶缓存键带上 sinceMs：重置后 sinceMs 变成本刻 → 换键 → 重新计算，不需要额外失效。
     */
    quotaSnapshot(keyId, sinceMs) {
        if (!this.db)
            return super.quotaSnapshot(keyId, sinceMs);
        // 窗口边界按 5 秒取整：额度是"30 天量级"的账，5 秒的滞后无关紧要
        const bucket = Math.floor(sinceMs / QUOTA_BUCKET_MS) * QUOTA_BUCKET_MS;
        const cacheKey = `${keyId}:${bucket}`;
        const now = Date.now();
        const hit = this.quotaCache.get(cacheKey);
        if (hit && now - hit.at < QUOTA_BUCKET_MS)
            return hit.value;
        try {
            const row = this.db
                .prepare(`SELECT COALESCE(SUM(total_tokens), 0) AS tokens,
                  COALESCE(SUM(cost_cny), 0)     AS cost,
                  COUNT(*)                       AS requests
             FROM meter WHERE key_id = ? AND ts >= ?`)
                .get(keyId, bucket);
            const dbValue = {
                tokens: Number(row?.tokens ?? 0),
                costCny: Number(row?.cost ?? 0),
                requests: Number(row?.requests ?? 0),
            };
            /*
             * ⚠️ **必须缓存"解析后"的值，而且必须与内存镜像取最大**（2026-09-14 复核抓到的回归）。
             *
             * 第一版这里是「库里有行就用库，否则用内存」—— **但拿库值去写缓存**。后果很严重：
             * 批量落盘之前库里是空的，那一次算出的 **0 被写进缓存并复用满一个 5 秒桶**，
             * 额度闸门因此失明 5~10 秒。实测（生产参数 batchSize=200/flush=2s、20 req/s、10 万额度）：
             * **放行 13.3 万 token 才第一次拦住（超额 33%）**；48 req/s 时超 3.3 倍。
             * 也就是说"修额度"的补丁自己把额度弄瞎了。
             *
             * 现在的口径：
             *   · 内存镜像是"已记录的每一行"，只受 50k 上限约束 —— 它既**最新**（库是批量落盘的），
             *     通常也是**超集**；库更全的唯一情形是重启后内存为空、或窗口内行数超过内存上限。
             *   · 所以**逐项取最大**：两个方向都不会少算。少算 = 闸门失明；多算只是保守。
             *   · 缓存里存的就是这个解析后的值，命中时直接返回它是安全的。
             */
            // L-07 修复：只有当**没有未落盘记录**时，内存镜像才必然 ⊆ DB —— 此时可跳过内存聚合。
            // 一旦有未落盘记录（buffer 非空）就绝不能跳过：那会漏算本窗口用量，
            // 正是「额度闸门失明、放行 13.3 万 token」那个已修回归的成因（见下方长注释）。
            const memValue = this.buffer.length === 0
                ? { tokens: 0, costCny: 0, requests: 0 }
                : super.quotaSnapshot(keyId, sinceMs);
            const resolved = {
                tokens: Math.max(dbValue.tokens, memValue.tokens),
                costCny: Math.max(dbValue.costCny, memValue.costCny),
                requests: Math.max(dbValue.requests, memValue.requests),
            };
            this.quotaCache.set(cacheKey, { value: resolved, at: now });
            if (this.quotaCache.size > 512) {
                // 简单淘汰：把最旧的一半扔掉（键是 5 秒桶，活着的基本只有最近几个）
                const entries = [...this.quotaCache.entries()].sort((a, b) => a[1].at - b[1].at);
                for (const [k] of entries.slice(0, entries.length >> 1))
                    this.quotaCache.delete(k);
            }
            return resolved;
        }
        catch (err) {
            this.lastError = err instanceof Error ? err.message : String(err);
            return super.quotaSnapshot(keyId, sinceMs);
        }
    }
    rateCount(keyId, windowStartMs) {
        // S1-1：限流计数是进程内状态（见类头注释）——SQLite 实现与内存实现同口径。
        return super.rateCount(keyId, windowStartMs);
    }
    incrRate(keyId, windowStartMs) {
        // S1-1：同上，无持久化桥接；多实例一致性由 SharedStateStore 承担。
        return super.incrRate(keyId, windowStartMs);
    }
    /**
     * 批量额度快照（SQLite 实现，每个 key 使用各自的 windowStart）。
     *
     * ⚠️ **v410 修一个我自己引入的正确性回归**：第一版 SQL 只写了
     * `WHERE key_id IN (...) GROUP BY key_id`——**没有 ts 过滤**，上面算好的 `buckets`
     * 变量根本没进 SQL（算了没用，是死变量）。后果：批量版返回的是**全时聚合**，
     * 而逐 key 的 `quotaSnapshot` 返回窗口内聚合，两者口径不一致。
     *
     * 为什么危险：`windowStart = max(now - 30d, 最近一次额度重置)`。DB 目前只积了 20 天，
     * 30 天窗口恰好等于全时，所以**看起来是对的**；但运营点一次「重置额度」后
     * windowStart 变成本刻，批量版仍把全部历史算进来 → 面板上这个 key 依旧显示「已用完」，
     * **运营唯一的补救动作静默失效**（这正是 `quotaSnapshot` 注释里记着的老坑，被我在
     * 换批量实现时又踩了一遍）。实测（1 小时窗口）：逐 key = 0 token，批量 = 98,716,917 token。
     *
     * 修法：按 windowStart 的 5 秒桶**分组**，每组一条带 `AND ts >= ?` 的查询。
     * 常见情形（无重置）只有 1 个桶 = 仍然 1 条 SQL；有重置的 key 各占一组，组数=重置过的 key 数，
     * 远小于 N。这样既保住"不做 N+1"，也保住与逐 key 版**逐字一致的口径**。
     */
    quotaSnapshotForAll(keyIds, windowStarts) {
        const result = new Map();
        if (keyIds.length === 0)
            return result;
        if (!this.db) {
            // 无 DB：回退到逐个查询
            for (const keyId of keyIds) {
                const sinceMs = windowStarts.get(keyId) ?? 0;
                result.set(keyId, this.quotaSnapshot(keyId, sinceMs));
            }
            return result;
        }
        const bucketOf = (keyId) => {
            const sinceMs = windowStarts.get(keyId) ?? 0;
            return Math.floor(sinceMs / QUOTA_BUCKET_MS) * QUOTA_BUCKET_MS;
        };
        try {
            // 按 5 秒桶分组：同桶的 key 共用一条 SQL（桶边界即 quotaSnapshot 里的 bucket，口径一致）
            const groups = new Map();
            for (const keyId of keyIds) {
                const b = bucketOf(keyId);
                const arr = groups.get(b);
                if (arr)
                    arr.push(keyId);
                else
                    groups.set(b, [keyId]);
            }
            const dbMap = new Map();
            // 单条 SQL 的占位符上限保护：组内 key 数按 500 切块（SQLite 变量上限 999，留足余量）
            const CHUNK = 500;
            for (const [bucket, ids] of groups) {
                for (let i = 0; i < ids.length; i += CHUNK) {
                    const slice = ids.slice(i, i + CHUNK);
                    const placeholders = slice.map(() => '?').join(',');
                    const rows = this.db
                        .prepare(`SELECT key_id,
                      COALESCE(SUM(total_tokens), 0) AS tokens,
                      COALESCE(SUM(cost_cny), 0)     AS cost,
                      COUNT(*)                       AS requests
                 FROM meter WHERE key_id IN (${placeholders}) AND ts >= ?
                GROUP BY key_id`)
                        .all(...slice, bucket);
                    for (const row of rows) {
                        dbMap.set(row.key_id, {
                            tokens: Number(row.tokens ?? 0),
                            costCny: Number(row.cost ?? 0),
                            requests: Number(row.requests ?? 0),
                        });
                    }
                }
            }
            // 逐项取最大（与 quotaSnapshot 同口径：内存镜像是超集）
            // v410 优化：内存侧也走批量单遍（此前逐 key 调 super.quotaSnapshot → 每次都
            // filter 整个 records 数组，O(N×M) + N 次大数组分配，是 /keys 的第二个瓶颈）
            const memAll = super.quotaSnapshotForAll(keyIds, windowStarts);
            for (const keyId of keyIds) {
                const dbValue = dbMap.get(keyId) ?? { tokens: 0, costCny: 0, requests: 0 };
                const memValue = memAll.get(keyId) ?? { tokens: 0, costCny: 0, requests: 0 };
                result.set(keyId, {
                    tokens: Math.max(dbValue.tokens, memValue.tokens),
                    costCny: Math.max(dbValue.costCny, memValue.costCny),
                    requests: Math.max(dbValue.requests, memValue.requests),
                });
            }
            return result;
        }
        catch (err) {
            this.lastError = err instanceof Error ? err.message : String(err);
            // 回退到逐个查询
            for (const keyId of keyIds) {
                const sinceMs = windowStarts.get(keyId) ?? 0;
                result.set(keyId, this.quotaSnapshot(keyId, sinceMs));
            }
            return result;
        }
    }
    /**
     * 时序桶：走 SQL 分组（内存镜像在重启后是空的，直接用它会让柱状图空白）。
     * 这是同一类问题的第三处：额度计数、轨迹、时序，都必须读持久层。
     */
    series(sinceMs, bucketMs) {
        if (!this.db)
            return super.series(sinceMs, bucketMs);
        try {
            const rows = this.db
                .prepare(
            // 必须显式整数化：node:sqlite 把 JS 数字按 REAL 绑定，`(ts / ?) * ?` 于是变成
            // 浮点除法再乘回去 —— 结果≈原 ts，GROUP BY 就退化成了"每条记录一个桶"。
            // 表现是 24h 窗口返回 85 个桶、柱状图实际是"每请求一根柱"（对外完全看不出来）。
            `SELECT CAST(ts / CAST(? AS INTEGER) AS INTEGER) * CAST(? AS INTEGER) AS bucket,
                  COUNT(*) AS requests,
                  SUM(CASE WHEN outcome != 'success' THEN 1 ELSE 0 END) AS errors,
                  SUM(total_tokens) AS tokens,
                  SUM(cost_cny) AS cost,
                  AVG(duration_ms) AS avg_ms
             FROM meter WHERE ts >= ?
            GROUP BY bucket ORDER BY bucket`)
                .all(bucketMs, bucketMs, sinceMs);
            if (rows.length === 0)
                return super.series(sinceMs, bucketMs);
            return rows.map((r) => ({
                ts: Number(r['bucket'] ?? 0),
                requests: Number(r['requests'] ?? 0),
                errors: Number(r['errors'] ?? 0),
                tokens: Number(r['tokens'] ?? 0),
                costCny: round(Number(r['cost'] ?? 0), 6),
                avgDurationMs: Math.round(Number(r['avg_ms'] ?? 0)),
            }));
        }
        catch (err) {
            this.lastError = err instanceof Error ? err.message : String(err);
            return super.series(sinceMs, bucketMs);
        }
    }
    /** 从库里取窗口内最早一条记录的时间（重启后依然正确） */
    oldestInWindow(sinceMs) {
        if (!this.db)
            return super.oldestInWindow(sinceMs);
        try {
            const row = this.db.prepare('SELECT MIN(ts) AS t FROM meter WHERE ts >= ?').get(sinceMs);
            return Number(row?.t ?? 0);
        }
        catch (err) {
            this.lastError = err instanceof Error ? err.message : String(err);
            return super.oldestInWindow(sinceMs);
        }
    }
    async prune(retentionDays) {
        if (!this.db)
            return 0;
        const cutoff = Date.now() - retentionDays * 86_400_000;
        try {
            const r1 = this.db.prepare('DELETE FROM meter WHERE ts < ?').run(cutoff);
            const r2 = this.db.prepare('DELETE FROM trace WHERE ts < ?').run(cutoff);
            // M-10 修复：事件表此前**不在留存清理范围内**（每次写操作都 INSERT），磁盘单调增长
            const r3 = this.db.prepare('DELETE FROM relay_event WHERE ts < ?').run(cutoff);
            return Number(r1.changes) + Number(r2.changes) + Number(r3.changes);
        }
        catch (err) {
            this.lastError = err instanceof Error ? err.message : String(err);
            return 0;
        }
    }
    /* ---------------- 离线/跨重启聚合（直接读 SQL） ---------------- */
    /**
     * 从库里做维度聚合。重启后内存镜像为空，看板必须仍能回答"历史用量是多少"。
     * 存储层没有完整延迟样本，因此 p95 用 duration 排序取位（SQLite 上代价可控，
     * 因为窗口通常 ≤ 30 天且有 ts 索引）。
     */
    dimensionStats(sinceMs, dimension) {
        if (!this.db)
            return super.dimensionStats(sinceMs, dimension);
        // M-11 修复：列名走**运行期白名单**（MeterDimension 只是编译期约束）。
        // 这里是把标识符拼进 SQL 的全库唯一例外；一旦将来有调用方从 URL 传 dimension，
        // 直接拼接就会变成注入点（本项目历史已有 “window=constructor 打穿面板” 同族问题）。
        // 用 Map 而不是对象字面量：`COLS['constructor']` 会命中 Object.prototype 拿到函数，
        // 白名单本身反而成了新的原型链缺口（params.ts 的 windowFrom 就是这么中招的）。
        const cols = new Map([
            ['model', 'model'],
            ['provider_id', 'provider_id'],
            ['tier', 'tier'],
            ['client_kind', 'client_kind'],
        ]);
        const col = cols.get(dimension) ?? 'model';
        // 与内存实现 dimensionKey() 保持**逐字一致**的桶名。
        // 曾经这里直接取列值，内存路径取 'unknown'，于是同一天的数据在两条路径下
        // 是 "" 和 "unknown" 两个桶，看板上看起来像两拨不同的流量。
        const bucket = `CASE WHEN key_id = '${UNATTRIBUTED_KEY_ID}' THEN '${UNATTRIBUTED}' ELSE COALESCE(NULLIF(${col}, ''), 'unknown') END`;
        try {
            const rows = this.db
                .prepare(`SELECT ${bucket} AS k,
                  COUNT(*) AS requests,
                  SUM(CASE WHEN outcome != 'success' THEN 1 ELSE 0 END) AS errors,
                  SUM(total_tokens) AS tokens,
                  SUM(cost_cny) AS cost,
                  SUM(list_cost_cny) AS list_cost,
                  SUM(cached_prompt_tokens) AS cached_tokens,
                  SUM(duration_ms) AS duration_sum
             FROM meter WHERE ts >= ? GROUP BY k`)
                .all(sinceMs);
            if (rows.length === 0)
                return super.dimensionStats(sinceMs, dimension);
            const out = new Map();
            // C-05 修复：p95 改为**一次扫描**。原实现对每个桶再跑一条
            //   `ORDER BY duration_ms LIMIT 1 OFFSET (SELECT COUNT(*)*0.95 ...)`
            // 而桶表达式是 CASE（非 SARGable、无索引），每条都要全窗口扫描 + 排序：
            // 实测 5 万行/24h 下 20 桶 = 1199 ms、5 桶 = 414 ms、**1 桶也要 193 ms**。
            // node:sqlite 是同步 API —— 这段耗时就是事件循环被冻结的时长（/admin/api/overview
            // 连调 model+provider 两次，合计约 1.6 s 全站停摆）。
            const p95Rows = this.db
                .prepare(`SELECT ${bucket} AS k, duration_ms FROM meter
            WHERE ts >= ? AND duration_ms IS NOT NULL
            ORDER BY k, duration_ms`)
                .all(sinceMs);
            const samples = new Map();
            for (const r of p95Rows) {
                const arr = samples.get(String(r.k));
                if (arr)
                    arr.push(r.duration_ms);
                else
                    samples.set(String(r.k), [r.duration_ms]);
            }
            for (const r of rows) {
                const key = String(r['k'] ?? '');
                const dur = samples.get(key) ?? [];
                // 与内存实现同口径：升序取 floor(n*0.95)，越界则取最后一个
                const p95 = dur.length ? dur[Math.min(dur.length - 1, Math.floor(dur.length * 0.95))] : 0;
                out.set(key, {
                    requests: Number(r['requests'] ?? 0),
                    errors: Number(r['errors'] ?? 0),
                    tokens: Number(r['tokens'] ?? 0),
                    cost: Number(r['cost'] ?? 0),
                    listCost: Number(r['list_cost'] ?? 0),
                    cachedTokens: Number(r['cached_tokens'] ?? 0),
                    durationSum: Number(r['duration_sum'] ?? 0),
                    durationCount: Number(r['requests'] ?? 0),
                    p95,
                });
            }
            return out;
        }
        catch (err) {
            this.lastError = err instanceof Error ? err.message : String(err);
            return super.dimensionStats(sinceMs, dimension);
        }
    }
    /**
     * 从库里做失败归因聚合。
     *
     * 这一条曾经漏改持久化读，后果很具体：`byModel/byTier/byProvider` 走 SQL（重启后仍答得出
     * "202 次鉴权失败"），`byFailureReason/byQuickAction/lossReduction` 走内存（重启后只剩 1 条），
     * 同一个看板自己跟自己矛盾；总览页那条"上游拒绝了你配置的密钥"横幅也因为它永远不触发。
     * 从用户视角看就是"评测时 API 全天 401，面板却说一切正常"（ADR-016）。
     */
    attributionStats(sinceMs) {
        if (!this.db)
            return super.attributionStats(sinceMs);
        try {
            const rows = this.db.prepare('SELECT COUNT(*) AS n FROM meter WHERE ts >= ?').get(sinceMs);
            if (!rows || Number(rows.n ?? 0) === 0)
                return super.attributionStats(sinceMs);
            const byReason = this.db
                .prepare(`SELECT failure_reason AS reason, COUNT(*) AS c, SUM(recoverable) AS rec
             FROM meter
            WHERE ts >= ? AND outcome != 'success' AND failure_reason IS NOT NULL
              AND NOT (failure_reason = 'auth_invalid' AND COALESCE(provider_id, '') = '')
            GROUP BY failure_reason`)
                .all(sinceMs);
            const byAction = this.db
                .prepare(`SELECT quick_action AS action, COUNT(*) AS c
             FROM meter
            WHERE ts >= ? AND quick_action IS NOT NULL
              AND NOT (failure_reason = 'auth_invalid' AND COALESCE(provider_id, '') = '')
            GROUP BY quick_action`)
                .all(sinceMs);
            const agg = this.db
                .prepare(`SELECT COUNT(*) AS n,
                  SUM(CASE WHEN outcome != 'success' THEN 1 ELSE 0 END) AS errors,
                  SUM(CASE WHEN outcome != 'success' AND attribution_delivered = 1 THEN 1 ELSE 0 END) AS delivered,
                  SUM(CASE WHEN outcome = 'success' AND attempt_count > 1 THEN 1 ELSE 0 END) AS auto_recovered,
                  SUM(CASE WHEN duplicate_in_window > 1 THEN 1 ELSE 0 END) AS duplicates,
                  SUM(precheck_violations) AS pv,
                  SUM(precheck_blocked) AS pb,
                  SUM(precheck_degraded) AS pd,
                  SUM(precheck_us) AS pus,
                  SUM(classify_us) AS cus,
                  SUM(duration_ms) AS dur,
                  SUM(CASE WHEN failure_reason = 'auth_invalid' AND COALESCE(provider_id, '') = '' THEN 1 ELSE 0 END) AS client_auth,
                  MAX(CASE WHEN failure_reason = 'auth_invalid' AND COALESCE(provider_id, '') = '' THEN ts ELSE 0 END) AS client_auth_last
             FROM meter WHERE ts >= ?`)
                .get(sinceMs);
            const n = Number(agg['n'] ?? 0);
            const durSum = Number(agg['dur'] ?? 0);
            const overheadUs = Number(agg['pus'] ?? 0) + Number(agg['cus'] ?? 0);
            return {
                byReason: byReason
                    .map((r) => ({ reason: r.reason, count: Number(r.c), recoverable: Number(r.rec ?? 0) }))
                    .sort((a, b) => b.count - a.count),
                byAction: byAction.map((r) => ({ action: r.action, count: Number(r.c) })).sort((a, b) => b.count - a.count),
                coverage: {
                    total: Number(agg['errors'] ?? 0),
                    delivered: Number(agg['delivered'] ?? 0),
                    autoRecovered: Number(agg['auto_recovered'] ?? 0),
                },
                duplicates: Number(agg['duplicates'] ?? 0),
                precheck: { violations: Number(agg['pv'] ?? 0), blocked: Number(agg['pb'] ?? 0), degraded: Number(agg['pd'] ?? 0) },
                overhead: {
                    precheckUsAvg: n ? round(Number(agg['pus'] ?? 0) / n, 2) : 0,
                    classifyUsAvg: n ? round(Number(agg['cus'] ?? 0) / n, 2) : 0,
                    overheadRatioAvg: durSum ? round(overheadUs / 1000 / durSum, 6) : 0,
                },
                clientAuth: { count: Number(agg['client_auth'] ?? 0), lastAt: Number(agg['client_auth_last'] ?? 0) },
            };
        }
        catch (err) {
            this.lastError = err instanceof Error ? err.message : String(err);
            return super.attributionStats(sinceMs);
        }
    }
    /** 从库里读最近轨迹（重启后仍可复盘） */
    recentPersistedTraces(limit) {
        const memory = this.recentTraces(limit);
        if (memory.length >= limit || !this.db)
            return memory;
        try {
            const rows = this.db.prepare('SELECT payload FROM trace ORDER BY ts DESC LIMIT ?').all(limit);
            const persisted = rows.map((r) => safeJsonParse(r.payload)).filter((t) => !!t);
            // 内存优先（更新），用库补齐重启前的历史
            const seen = new Set(memory.map((t) => t.traceId));
            return [...memory, ...persisted.filter((t) => !seen.has(t.traceId))].slice(0, limit);
        }
        catch (err) {
            this.lastError = err instanceof Error ? err.message : String(err);
            return memory;
        }
    }
    /**
     * 窗口总量统计：优先读持久层。
     * 这样进程重启后（内存镜像为空）看板依然能给出正确的历史数字，
     * 而正常运行时也避免"内存镜像被 5 万条上限截断"导致的低估。
     */
    windowStatsPreferPersistent(sinceMs) {
        if (!this.db)
            return super.windowStats(sinceMs);
        const persistent = this.sqlWindowStats(sinceMs);
        // 持久有数直接用（manual#393·性能第一位）：原实现无条件再算一遍内存镜像
        // （filter+sort 全窗口），只在持久为零（刚写入未 flush）时才需要它兜底——
        // SQL 有索引且窗口聚合实测 ~0.9ms，内存那份在常走路径纯属白算。
        if (persistent.requests > 0)
            return persistent;
        return super.windowStats(sinceMs);
    }
    /** 从库里做真实聚合，用于长时间窗看板（内存镜像只有最近 5 万条） */
    sqlWindowStats(sinceMs) {
        if (!this.db)
            return super.windowStats(sinceMs);
        try {
            const rows = this.db
                .prepare(`SELECT COUNT(*) AS requests,
                  SUM(CASE WHEN outcome != 'success' THEN 1 ELSE 0 END) AS errors,
                  SUM(total_tokens) AS tokens,
                  SUM(cost_cny) AS cost,
                  SUM(list_cost_cny) AS list_cost,
                  AVG(duration_ms) AS avg_ms
             FROM meter WHERE ts >= ?`)
                .get(sinceMs);
            const p95row = this.db
                .prepare('SELECT duration_ms FROM meter WHERE ts >= ? ORDER BY duration_ms LIMIT 1 OFFSET (SELECT CAST(COUNT(*)*0.95 AS INT) FROM meter WHERE ts >= ?)')
                .get(sinceMs, sinceMs);
            return {
                requests: Number(rows?.['requests'] ?? 0),
                errors: Number(rows?.['errors'] ?? 0),
                tokens: Number(rows?.['tokens'] ?? 0),
                costCny: round(Number(rows?.['cost'] ?? 0), 6),
                listCostCny: round(Number(rows?.['list_cost'] ?? 0), 6),
                avgDurationMs: Math.round(Number(rows?.['avg_ms'] ?? 0)),
                p95DurationMs: Number(p95row?.duration_ms ?? 0),
            };
        }
        catch (err) {
            this.lastError = err instanceof Error ? err.message : String(err);
            return super.windowStats(sinceMs);
        }
    }
    /** 从库里读轨迹（重启后仍可复盘） */
    sqlFindTrace(traceId) {
        const memory = this.findTrace(traceId);
        if (memory)
            return memory;
        if (!this.db)
            return undefined;
        try {
            const row = this.db.prepare('SELECT payload FROM trace WHERE trace_id = ?').get(traceId);
            if (!row)
                return undefined;
            return safeJsonParse(row.payload);
        }
        catch {
            return undefined;
        }
    }
    /**
     * L-09 修复：`findTrace` 正式覆写（Store 接口方法）。
     *
     * 此前它没被覆写 —— 走的是基类“只搜内存”的实现，重启后返回 undefined；
     * 而持久层查找 `sqlFindTrace` 又不在接口上，CLI 只能用
     * `store as unknown as { sqlFindTrace?: … }` 双重断言去够它。
     */
    findTrace(traceId) {
        return this.sqlFindTrace(traceId);
    }
    /* ---------------- key 元数据持久化 ---------------- */
    upsertKeyMeta(meta) {
        // 内存镜像始终更新（面板读取走它，避免每次都要碰磁盘）
        this.writeKeyMeta({
            keyId: meta.keyId,
            label: meta.label,
            tier: meta.tier,
            tenantId: meta.tenantId,
            enabled: meta.enabled,
            ...(meta.allowedModels ? { allowedModels: meta.allowedModels } : {}),
            ...(meta.expiresAt !== undefined ? { expiresAt: meta.expiresAt } : {}),
            ...(meta.quotaOverride !== undefined ? { quotaOverride: meta.quotaOverride } : {}),
            ...(meta.costQuotaOverride !== undefined ? { costQuotaOverride: meta.costQuotaOverride } : {}),
            keyHash: meta.keyHash,
            origin: meta.origin,
            // M-13 修复：保留首次创建时间。DB 侧 ON CONFLICT 并不更新 created_at，
            // 而这里此前每次 upsert 都写 Date.now() → 两个口径分叉、面板排序“越改越新”。
            createdAt: this.keyMeta.get(meta.keyId)?.createdAt ?? Date.now(),
        });
        if (!this.db)
            return;
        try {
            this.db
                .prepare(`INSERT INTO key_meta (key_id, label, tier, tenant_id, enabled, allowed_models, expires_at, created_at, monthly_quota_override, cost_quota_override, key_hash, origin)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(key_id) DO UPDATE SET
             label = excluded.label, tier = excluded.tier, tenant_id = excluded.tenant_id,
             enabled = excluded.enabled, allowed_models = excluded.allowed_models,
             expires_at = excluded.expires_at, monthly_quota_override = excluded.monthly_quota_override,
             cost_quota_override = excluded.cost_quota_override,
             key_hash = excluded.key_hash, origin = excluded.origin`)
                .run(meta.keyId, meta.label, meta.tier, meta.tenantId, meta.enabled ? 1 : 0, meta.allowedModels ? JSON.stringify(meta.allowedModels) : null, meta.expiresAt ?? null, Date.now(), meta.quotaOverride ?? null, meta.costQuotaOverride ?? null, meta.keyHash, meta.origin);
        }
        catch (err) {
            this.lastError = err instanceof Error ? err.message : String(err);
        }
    }
    /** 熔断状态持久化：进程重启后上游不该马上被重新打爆 */
    saveBreaker(providerId, state) {
        if (!this.db)
            return;
        try {
            this.db
                .prepare(`INSERT INTO breaker_state (provider_id, open_until, consecutive_failures, last_reason, updated_at)
           VALUES (?,?,?,?,?)
           ON CONFLICT(provider_id) DO UPDATE SET
             open_until = excluded.open_until,
             consecutive_failures = excluded.consecutive_failures,
             last_reason = excluded.last_reason,
             updated_at = excluded.updated_at`)
                .run(providerId, state.openUntil, state.consecutiveFailures, state.lastReason ?? null, Date.now());
        }
        catch {
            /* fail-open */
        }
    }
    loadBreakers() {
        const out = new Map();
        if (!this.db)
            return out;
        try {
            const rows = this.db.prepare('SELECT * FROM breaker_state').all();
            for (const r of rows) {
                out.set(String(r['provider_id']), {
                    openUntil: Number(r['open_until']),
                    consecutiveFailures: Number(r['consecutive_failures']),
                    lastReason: r['last_reason'] === null ? undefined : String(r['last_reason']),
                });
            }
        }
        catch {
            /* fail-open */
        }
        return out;
    }
    loadControlDoc(key) {
        if (!this.db)
            return super.loadControlDoc(key);
        try {
            const rows = this.db.prepare('SELECT json FROM control_doc WHERE key = ?').all(key);
            const row = rows[0];
            if (!row)
                return super.loadControlDoc(key);
            return safeJsonParse(String(row['json']));
        }
        catch (err) {
            // fail-open：读失败回落内存镜像/undefined，绝不阻断主流程
            this.lastError = err instanceof Error ? err.message : String(err);
            return super.loadControlDoc(key);
        }
    }
    saveControlDoc(key, doc) {
        super.saveControlDoc(key, doc);
        if (!this.db)
            return;
        try {
            this.db
                .prepare('INSERT INTO control_doc (key, json, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
                .run(key, JSON.stringify(doc), Date.now());
        }
        catch {
            /* fail-open：写失败不影响主流程 */
        }
    }
    /** 执行 SQL 查询（用于商户券闭环等自定义表） */
    async query(sql, params = []) {
        if (!this.db)
            return [];
        try {
            const stmt = this.db.prepare(sql);
            const rows = stmt.all(...params);
            return rows;
        }
        catch (err) {
            this.logger?.error('store.query_failed', { error: err instanceof Error ? err.message : String(err), sql });
            return [];
        }
    }
    /** 执行 SQL 语句（INSERT/UPDATE/DELETE） */
    async execute(sql, params = []) {
        if (!this.db)
            return 0;
        try {
            const stmt = this.db.prepare(sql);
            const result = stmt.run(...params);
            return typeof result.changes === 'bigint' ? Number(result.changes) : result.changes;
        }
        catch (err) {
            this.logger?.error('store.execute_failed', { error: err instanceof Error ? err.message : String(err), sql });
            return 0;
        }
    }
    logEvent(level, kind, detail) {
        super.logEvent(level, kind, detail);
        if (!this.db)
            return;
        try {
            this.db.prepare('INSERT INTO relay_event (ts, level, kind, detail) VALUES (?,?,?,?)').run(Date.now(), level, kind, JSON.stringify(detail));
        }
        catch {
            /* fail-open */
        }
    }
    listEvents(limit) {
        if (!this.db)
            return super.listEvents(limit);
        try {
            const rows = this.db.prepare('SELECT ts, level, kind, detail FROM relay_event ORDER BY id DESC LIMIT ?').all(limit);
            return rows.map((r) => ({
                ts: Number(r['ts']),
                level: String(r['level']),
                kind: String(r['kind']),
                detail: safeJsonParse(String(r['detail'])) ?? {},
            }));
        }
        catch (err) {
            this.lastError = err instanceof Error ? err.message : String(err);
            return super.listEvents(limit);
        }
    }
    /** 面板创建的 key 落库；配置文件里的 key 每次启动都会重新写入（origin=config） */
    listKeyMeta() {
        if (!this.db)
            return super.listKeyMeta();
        try {
            const rows = this.db.prepare('SELECT * FROM key_meta ORDER BY created_at ASC').all();
            return rows.map((r) => {
                const allowed = r['allowed_models'] === null ? undefined : safeJsonParse(String(r['allowed_models']));
                const override = r['monthly_quota_override'] === null || r['monthly_quota_override'] === undefined ? undefined : Number(r['monthly_quota_override']);
                return {
                    keyId: String(r['key_id']),
                    label: String(r['label']),
                    tier: String(r['tier']),
                    tenantId: String(r['tenant_id']),
                    enabled: Number(r['enabled']) === 1,
                    ...(allowed ? { allowedModels: allowed } : {}),
                    ...(r['expires_at'] === null || r['expires_at'] === undefined ? {} : { expiresAt: Number(r['expires_at']) }),
                    ...(override === undefined ? {} : { quotaOverride: override }),
                    ...(r['cost_quota_override'] === null || r['cost_quota_override'] === undefined
                        ? {}
                        : { costQuotaOverride: Number(r['cost_quota_override']) }),
                    keyHash: String(r['key_hash'] ?? ''),
                    origin: (String(r['origin'] ?? 'config') === 'panel' || String(r['origin'] ?? 'config') === 'voucher')
                        ? String(r['origin'])
                        : 'config',
                    createdAt: Number(r['created_at'] ?? 0),
                };
            });
        }
        catch (err) {
            this.lastError = err instanceof Error ? err.message : String(err);
            return super.listKeyMeta();
        }
    }
    setKeyMetaEnabled(keyId, enabled) {
        super.setKeyMetaEnabled(keyId, enabled);
        if (!this.db)
            return;
        try {
            this.db.prepare('UPDATE key_meta SET enabled = ? WHERE key_id = ?').run(enabled ? 1 : 0, keyId);
        }
        catch (err) {
            this.lastError = err instanceof Error ? err.message : String(err);
        }
    }
    /**
     * 硬删除 key 元数据（B2·审查修复·能力层根因）：DELETE 掉该行。
     * 此前只有"墓碑"（清空 keyHash）绕过——行还留在库里，语义上属于"已删除"却仍占一行。
     * 现在能力层提供真正的删除，面板 key 删除后重启不再复活。
     */
    deleteKeyMeta(keyId) {
        super.deleteKeyMeta(keyId);
        if (!this.db)
            return;
        try {
            this.db.prepare('DELETE FROM key_meta WHERE key_id = ?').run(keyId);
        }
        catch (err) {
            this.lastError = err instanceof Error ? err.message : String(err);
        }
    }
    lastQuotaResetAt(keyId) {
        if (!this.db)
            return super.lastQuotaResetAt(keyId);
        try {
            const rows = this.db.prepare("SELECT ts, detail FROM relay_event WHERE kind = 'quota.reset' ORDER BY id DESC LIMIT 500").all();
            for (const r of rows) {
                const detail = safeJsonParse(String(r['detail']));
                if (detail?.['keyId'] === keyId)
                    return Number(r['ts']);
            }
            return 0;
        }
        catch {
            return super.lastQuotaResetAt(keyId);
        }
    }
    /**
     * 批量版（v410）：同一条 SQL 只跑一次，行也只解析一次。
     * 逐 key 版跑 N 次同样的 SQL、把同样的 500 行解析 N 遍——332 key 实测 72ms/请求，
     * 这才是 /keys 的吞吐瓶颈（额度聚合本身只要 7ms）。语义与逐 key 版完全一致。
     */
    lastQuotaResetForAll(keyIds) {
        const out = new Map();
        if (keyIds.length === 0)
            return out;
        if (!this.db)
            return super.lastQuotaResetForAll(keyIds);
        const want = new Set(keyIds);
        try {
            const rows = this.db.prepare("SELECT ts, detail FROM relay_event WHERE kind = 'quota.reset' ORDER BY id DESC LIMIT 500").all();
            for (const r of rows) {
                const detail = safeJsonParse(String(r['detail']));
                const kid = detail?.['keyId'];
                // 倒序扫描：首次遇到即该 key 的最新一次重置
                if (typeof kid === 'string' && want.has(kid) && !out.has(kid))
                    out.set(kid, Number(r['ts']));
            }
            return out;
        }
        catch {
            return super.lastQuotaResetForAll(keyIds);
        }
    }
}
function dimensionKey(r, dimension) {
    // 没通过鉴权的请求不属于任何 key/分层，也谈不上用了哪个模型。
    // 混进 free 层和空模型名下，只会让人误判成"免费层全挂了"。
    if (r.keyId === UNATTRIBUTED_KEY_ID)
        return UNATTRIBUTED;
    switch (dimension) {
        case 'model':
            return r.model || 'unknown';
        case 'provider_id':
            return r.providerId || 'unknown';
        case 'tier':
            return r.tier;
        case 'client_kind':
            return r.clientKind;
        default:
            return 'unknown';
    }
}
export async function createStore(opts) {
    if (opts.driver === 'memory') {
        const s = new MemoryStore();
        await s.init();
        return s;
    }
    const s = new SqliteStore({ path: opts.path, batchSize: opts.batchSize, flushIntervalMs: opts.flushIntervalMs, ...(opts.logger ? { logger: opts.logger } : {}) });
    await s.init();
    return s;
}
//# sourceMappingURL=index.js.map