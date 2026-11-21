/**
 * Agent 长期记忆（v2 主题 4）。
 *
 * v1 的历史是进程内环（cap 50，重启即丢），且不回喂 prompt；
 * v2 用持久事件流 + 发现项（finding）状态机补齐：
 *
 *   - 每轮 run 落一条 agent.run 事件（含决策全文）→ 重启后可重建历史；
 *   - kind != none 的决策提炼成 finding（open → acknowledged / resolved / ignored）；
 *   - 下一轮把 open 项回喂 prompt，Agent 做"这轮是否已改善"的增量判断：
 *       · 改善 → 建议输出 resolved；
 *       · 持续 → seenCount+1（面板显示"已连续 N 轮出现"）；
 *   - 同一 category+summary 前缀去重，防同一问题刷屏。
 *
 * 存储载体：store.logEvent（复用既有事件表，零新表——保持零运行时依赖与
 * prune 语义一致）。内存态在进程内聚合，重启后从事件流懒重建（同
 * handlers/agent.ts 的 lastFromEvent 模式）。
 */
const FINDING_CAP = 200;
const REBUILD_EVENT_WINDOW = 800;
export class AgentMemory {
    store;
    findings = new Map();
    rebuilt = false;
    constructor(store) {
        this.store = store;
    }
    /** 懒重建：首次访问时从事件流恢复（重启回退，同 #183/#255 模式） */
    ensureRebuilt() {
        if (this.rebuilt || !this.store) {
            this.rebuilt = true;
            return;
        }
        this.rebuilt = true;
        try {
            const evs = this.store.listEvents(REBUILD_EVENT_WINDOW);
            for (const ev of evs) {
                if (ev.kind !== 'agent.finding')
                    continue;
                const d = ev.detail ?? {};
                const id = String(d['id'] ?? '');
                if (!id)
                    continue;
                const prev = this.findings.get(id);
                const item = {
                    id,
                    category: String(d['category'] ?? 'other'),
                    summary: String(d['summary'] ?? ''),
                    severity: (['info', 'warn', 'critical'].includes(String(d['severity'])) ? String(d['severity']) : 'info'),
                    status: (['open', 'acknowledged', 'resolved', 'ignored'].includes(String(d['status'])) ? String(d['status']) : 'open'),
                    firstSeenAt: Number(d['firstSeenAt'] ?? ev.ts ?? Date.now()),
                    lastSeenAt: Number(d['lastSeenAt'] ?? ev.ts ?? Date.now()),
                    seenCount: Math.max(1, Number(d['seenCount'] ?? 1)),
                    ...(d['recommendation'] !== undefined ? { recommendation: String(d['recommendation']) } : {}),
                };
                // 事件按时间序回放，后来的覆盖前面的（含状态迁移）
                if (prev) {
                    this.findings.set(id, { ...prev, ...item });
                }
                else if (this.findings.size < FINDING_CAP) {
                    this.findings.set(id, item);
                }
            }
        }
        catch {
            // 重建失败 → 空记忆起步，不影响本轮
        }
    }
    /** 记录/刷新一个发现项（run 后调用）。返回刷新后的项。 */
    observe(category, summary, severity, recommendation, at) {
        this.ensureRebuilt();
        const key = category + '|' + summary.slice(0, 40);
        const prev = this.findings.get(key);
        const item = prev
            ? { ...prev, lastSeenAt: at, seenCount: prev.seenCount + 1, severity, ...(recommendation !== undefined ? { recommendation } : {}) }
            : {
                id: key,
                category, summary, severity,
                status: 'open',
                firstSeenAt: at, lastSeenAt: at, seenCount: 1,
                ...(recommendation !== undefined ? { recommendation } : {}),
            };
        this.findings.set(key, item);
        this.persist(item);
        if (this.findings.size > FINDING_CAP) {
            // 淘汰最旧的已闭环项；全是 open 则淘汰最久未见的
            const candidates = [...this.findings.values()].filter((f) => isClosed(f.status));
            const pool = candidates.length ? candidates : [...this.findings.values()];
            const victim = pool.sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0];
            if (victim)
                this.findings.delete(victim.id);
        }
        return item;
    }
    /** 运维打标（面板反馈回路：采纳/驳回/销号） */
    mark(id, status) {
        this.ensureRebuilt();
        const f = this.findings.get(id);
        if (!f)
            return undefined;
        f.status = status;
        this.persist(f);
        return f;
    }
    openFindings() {
        this.ensureRebuilt();
        return [...this.findings.values()]
            .filter((f) => f.status === 'open')
            .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    }
    /** 面板/接口：全部发现项（含已闭环，供复盘） */
    all() {
        this.ensureRebuilt();
        return [...this.findings.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    }
    /** 从决策输出里推断销号：decision.kind==='none' 或 severity 降为 info 且 summary 命中 */
    reconcileFromDecision(at, resolvedHints) {
        this.ensureRebuilt();
        for (const f of this.findings.values()) {
            if (f.status !== 'open')
                continue;
            if (resolvedHints.some((h) => h && f.summary.slice(0, 20).includes(h.slice(0, 20)))) {
                f.status = 'resolved';
                f.lastSeenAt = at;
                this.persist(f);
            }
        }
    }
    persist(f) {
        try {
            this.store?.logEvent(f.status === 'open' ? 'warn' : 'info', 'agent.finding', {
                id: f.id, category: f.category, summary: f.summary, severity: f.severity,
                status: f.status, firstSeenAt: f.firstSeenAt, lastSeenAt: f.lastSeenAt,
                seenCount: f.seenCount, ...(f.recommendation !== undefined ? { recommendation: f.recommendation } : {}),
            });
        }
        catch {
            // 事件写入失败不影响 Agent 主流程
        }
    }
}
function isClosed(s) {
    return s === 'resolved' || s === 'ignored';
}
//# sourceMappingURL=memory.js.map