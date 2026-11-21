/**
 * 额度机制改进（G1~G5·审查修复·短板 1/2/3/4/5/6）的针对性回归测试。
 *
 * 钉住这批不变量，防止日后再回到"同一把 key 两种启动行为不同""客户撞墙才知额度"的状态。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, memoryConfig } from '../app.js';
import { Logger } from '../core/logger.js';
import { DEFAULT_TIERS } from '../core/config.js';
import { quotaPeriodStart, QUOTA_PERIOD_MS } from '../gateway/keys.js';
import { FailurePresenter } from '../gateway/presenter.js';
const silent = new Logger('error', () => undefined);
test('G1: memoryConfig 档位从 DEFAULT_TIERS 派生（键一致、帽为空、速率放宽）', () => {
    const tiers = memoryConfig().tiers;
    assert.deepEqual(Object.keys(tiers).sort(), Object.keys(DEFAULT_TIERS).sort(), '内存档位必须与生产默认档位同键集（单一真源）');
    for (const k of Object.keys(DEFAULT_TIERS)) {
        assert.equal(tiers[k].periodQuotaTokens, null, `${k} 的 token 帽应为 null（测试友好）`);
        assert.equal(tiers[k].rpm, 1000, `${k} 的 rpm 应为测试友好值 1000`);
    }
    // 结构字段（billing/precheck 等）来自 DEFAULT_TIERS，不再自行硬编码
    assert.equal(tiers.free.billing, DEFAULT_TIERS.free.billing);
    assert.equal(tiers.pro.precheck, DEFAULT_TIERS.pro.precheck);
});
test('G3: quotaPeriodStart —— rolling30d / calendarMonth / 重置优先', () => {
    const now = Date.UTC(2026, 9, 26, 12, 0, 0); // 2026-10-26T12:00Z
    assert.equal(quotaPeriodStart({ ...DEFAULT_TIERS.free }, now), now - QUOTA_PERIOD_MS, '默认 rolling30d');
    const cal = quotaPeriodStart({ ...DEFAULT_TIERS.free, quotaPeriod: 'calendarMonth' }, now);
    assert.equal(cal, Date.UTC(2026, 9, 1, 0, 0, 0), '自然月起 = UTC 当月 1 日 00:00');
    // 重置晚于周期起点 → 取重置（立刻恢复可用）
    const resetAt = now - 1_000;
    assert.equal(quotaPeriodStart({ ...DEFAULT_TIERS.free }, now, resetAt), resetAt);
    // 重置早于周期起点 → 取周期起点
    assert.equal(quotaPeriodStart({ ...DEFAULT_TIERS.free, quotaPeriod: 'calendarMonth' }, now, Date.UTC(2020, 0, 1)), cal);
    // 未定义档位 → 回落 rolling30d（fail-safe）
    assert.equal(quotaPeriodStart(undefined, now), now - QUOTA_PERIOD_MS);
});
test('G2/G5: quotaHeaders 仅在有帽时输出；≥90% 附近限告警', () => {
    const cfg = memoryConfig();
    const p = new FailurePresenter({ lr: () => cfg.lossReduction, hideUpstream: () => false });
    assert.deepEqual(p.quotaHeaders(undefined), {}, '无帽 → 不输出任何额度头');
    const normal = p.quotaHeaders({ tokens: { used: 10, limit: 100 }, cny: null, periodStart: 123 });
    assert.equal(normal['x-relay-quota-tokens'], '10/100');
    assert.equal(normal['x-relay-quota-used-pct'], '0.100');
    assert.equal(normal['x-relay-quota-cny'], undefined);
    assert.equal(normal['x-relay-quota-warning'], undefined, '10% 不该告警');
    const near = p.quotaHeaders({ tokens: { used: 95, limit: 100 }, cny: { used: 1, limit: 100 }, periodStart: 1 });
    assert.equal(near['x-relay-quota-warning'], 'near_limit', '≥90% 必须告警');
    assert.equal(near['x-relay-quota-cny'], '1/100');
    assert.equal(near['x-relay-quota-used-pct'], '0.950', '取两种口径的较大者（token 95%）');
});
test('G4: health.limits 标注单实例口径 + 启动告警事件', async () => {
    const base = memoryConfig();
    const app = await createApp(memoryConfig({ server: { ...base.server, behindProxy: true } }), silent);
    try {
        const h = app.admin.health();
        assert.equal(h.limits.scope, 'single-instance');
        assert.match(String(h.limits.note), /N 倍/);
        const events = app.store.listEvents(50);
        assert.ok(events.some((e) => e.kind === 'deploy.single_instance_limits'), '应记启动告警事件');
    }
    finally {
        await app.shutdown();
    }
});
//# sourceMappingURL=quota-improvements.test.js.map