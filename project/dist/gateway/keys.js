/**
 * 客户端 key 鉴权、限流、额度、并发闸门。
 *
 * 设计原则（对齐评估文档 §6 分层商业模式）：
 * - key 以 **sha256 哈希**存储并索引，明文只在配置里出现一次，进程内不保留明文映射。
 * - 分层策略（free/standard/pro）决定降损层开关、rpm、并发、额度、计费模式。
 * - 限流/额度检查失败一律 fail-open（除"确实超限"这一确定性结论外），
 *   即：存储故障不能让整个网关拒绝服务。
 */
import { ConcurrencyLimiter } from '../upstream/pool.js';
import { randomBytes } from 'node:crypto';
import { ownLookup, sha256Hex, monotonicMs, shortId } from '../util/index.js';
/** 额度周期（30 天）。导出供管理面展示引用（审查修复·缺点#7：消除第二处硬编码镜像）。 */
export const QUOTA_PERIOD_MS = 30 * 86_400_000;
/**
 * 额度周期起点（G3·审查修复·短板3/6）。
 *   · `rolling30d`（默认）：滚动 30 天（now − 30d）；
 *   · `calendarMonth`：自然月（UTC 当月 1 日 00:00），与客户"月度账单"心智对齐。
 * 两种模式下，"额度重置"时刻都优先（取较晚者）——运营重置后立刻恢复可用。
 * 用 UTC 是刻意的：与服务器时区无关，行为确定、可复现。导出供单测复用。
 */
export function quotaPeriodStart(policy, now, resetAt = 0) {
    const period = policy?.quotaPeriod ?? 'rolling30d';
    const base = period === 'calendarMonth'
        ? Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1)
        : now - QUOTA_PERIOD_MS;
    return Math.max(base, resetAt);
}
export class KeyRegistry {
    byHash = new Map();
    limiters = new Map();
    dynamic = new Map();
    config;
    store;
    logger;
    /** 共享状态后端（REQ-01）；未注入时走 store.*（单机） */
    state;
    /**
     * key 的真实创建时间（B1·审查修复·能力层根因）。
     * 真源是 store.listKeyMeta() 的 created_at；此前 register() 一律写 Date.now()（启动时刻），
     * 导致每次重启后所有 key 都显示"刚创建"（呈现层只好用 metaAt 纠正）。现在构造期读一次，
     * register/create 都据此维护，呈现层不再纠正。
     */
    storedCreatedAt = new Map();
    /** 被拒鉴权的环形台账（只留指纹），用于面板自证"到底是谁的 key 不对" */
    rejects = [];
    rejectCounts = new Map();
    rejectTotal = 0;
    static REJECT_RING = 200;
    constructor(opts) {
        this.config = opts.config;
        this.store = opts.store;
        this.logger = opts.logger;
        this.state = opts.state;
        // B1：先载入真实创建时间，再注册任何 key —— register 与 restored 都用它，
        // 避免「重启即把 createdAt 覆盖成启动时刻」（呈现层从此不必再纠正）。
        try {
            for (const m of this.store.listKeyMeta())
                this.storedCreatedAt.set(m.keyId, m.createdAt);
        }
        catch {
            /* fail-open：读不到元数据就退回"启动时刻"（与改造前一致） */
        }
        for (const c of opts.config.clients)
            this.register(c);
        // 从库里恢复面板创建的 key（只有哈希，明文不可恢复）
        for (const r of opts.restoredKeys ?? []) {
            const rec = {
                id: r.keyId,
                label: r.label,
                hash: r.keyHash,
                tier: r.tier,
                tenantId: r.tenantId,
                enabled: r.enabled,
                origin: r.origin ?? 'panel',
                // B1：恢复面板 key 时同样保留库里的真实创建时间。
                createdAt: this.storedCreatedAt.get(r.keyId) ?? Date.now(),
                ...(r.allowedModels && r.allowedModels.length > 0 ? { allowedModels: r.allowedModels } : {}),
                ...(r.expiresAt !== undefined ? { expiresAt: r.expiresAt } : {}),
                ...(r.quotaOverride !== undefined ? { quotaOverride: r.quotaOverride } : {}),
                ...(r.costQuotaOverride !== undefined ? { quotaCnyOverride: r.costQuotaOverride } : {}),
            };
            if (!rec.hash)
                continue;
            this.byHash.set(rec.hash, rec);
            this.dynamic.set(rec.id, rec);
            this.limiters.set(rec.id, this.mkLimiter(rec.id, this.config.tiers[rec.tier]?.maxConcurrency ?? 32));
        }
        for (const c of opts.dynamicKeys ?? [])
            this.register(c, true);
    }
    /** 注册/更新一个 key（配置装载或管理接口调用），并写入持久层 */
    register(config, isDynamic = false) {
        // L-05 修复：label 唯一性此前只覆盖 create/update（管理面变更入口），**配置装载入口
        // register 可绕过** —— 同一份配置里两把 key 同名，会让「label 是人工唯一标识」的审计
        // 不变量整体失效（C-02 已确立「不变量必须所有入口等价」的原则，此处补齐最后一口）。
        // 同一 id 重复注册（配置热重载 / 幂等重放）不算冲突。
        const regLabel = config.label?.trim();
        if (regLabel && this.hasLabel(regLabel, config.id)) {
            throw new Error(`label "${regLabel}" 已存在`);
        }
        const hash = hashKey(config.key);
        const rec = {
            id: config.id,
            label: config.label,
            hash,
            tier: config.tier,
            tenantId: config.tenantId,
            enabled: config.enabled,
            origin: isDynamic ? 'panel' : 'config',
            // B1：保留库里的真实创建时间（无记录时才用当下时刻）。
            createdAt: this.storedCreatedAt.get(config.id) ?? Date.now(),
            ...(config.allowedModels && config.allowedModels.length > 0 ? { allowedModels: config.allowedModels } : {}),
            ...(config.expiresAt !== undefined ? { expiresAt: config.expiresAt } : {}),
            ...(config.quotaOverride !== undefined ? { quotaOverride: config.quotaOverride } : {}),
            ...(config.quotaCny !== undefined ? { quotaCnyOverride: config.quotaCny } : {}),
        };
        this.byHash.set(rec.hash, rec);
        if (isDynamic)
            this.dynamic.set(rec.id, rec);
        // M-01 修复：ownLookup 规避原型链（tier 名异常时不应命中 Object.prototype）
        const policy = ownLookup(this.config.tiers, rec.tier);
        this.limiters.set(rec.id, this.mkLimiter(rec.id, policy?.maxConcurrency ?? 32));
        this.persistMeta(rec);
    }
    persistMeta(rec) {
        try {
            const store = this.store;
            store.upsertKeyMeta?.({
                keyId: rec.id,
                label: rec.label,
                tier: rec.tier,
                tenantId: rec.tenantId,
                enabled: rec.enabled,
                ...(rec.allowedModels ? { allowedModels: rec.allowedModels } : {}),
                ...(rec.expiresAt !== undefined ? { expiresAt: rec.expiresAt } : {}),
                ...(rec.quotaOverride !== undefined ? { quotaOverride: rec.quotaOverride } : {}),
                ...(rec.quotaCnyOverride !== undefined ? { costQuotaOverride: rec.quotaCnyOverride } : {}),
                keyHash: rec.hash,
                origin: rec.origin,
            });
        }
        catch {
            // fail-open：元数据落库失败不影响鉴权
        }
    }
    remove(keyId) {
        const rec = this.dynamic.get(keyId);
        if (!rec)
            return false;
        this.byHash.delete(rec.hash);
        this.dynamic.delete(keyId);
        this.limiters.delete(keyId);
        this.storedCreatedAt.delete(keyId);
        // B2（审查修复·能力层根因）：一并硬删持久层的 key_meta —— 此前只删内存映射，
        // 重启后会从 key_meta 复活（呈现层只好用"墓碑"绕过）。审计信息仍在 key.delete 事件里。
        this.store.deleteKeyMeta?.(keyId);
        return true;
    }
    listKeys() {
        const out = [];
        const seen = new Set();
        // byHash ∪ dynamic 并集（manual#392·签字授权）：revoke 只摘 byHash（鉴权索引），
        // dynamic 里的管理记录必须在管理面可见——只走 byHash 会让已撤销 key 从列表消失，
        // 连带 keys/delete 的前查 404（#365/#392 实证：删除/重启用都够不着）。
        const all = [...this.byHash.values(), ...this.dynamic.values()];
        for (const rec of all) {
            if (seen.has(rec.id))
                continue;
            seen.add(rec.id);
            out.push(this.toView(rec));
        }
        return out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    }
    toView(rec) {
        return {
            id: rec.id,
            label: rec.label,
            tier: rec.tier,
            tenantId: rec.tenantId,
            enabled: rec.enabled,
            ...(rec.allowedModels ? { allowedModels: rec.allowedModels } : {}),
            ...(rec.expiresAt !== undefined ? { expiresAt: rec.expiresAt } : {}),
            ...(rec.quotaOverride !== undefined ? { quotaOverride: rec.quotaOverride } : {}),
            ...(rec.quotaCnyOverride !== undefined ? { quotaCnyOverride: rec.quotaCnyOverride } : {}),
            origin: rec.origin,
            createdAt: rec.createdAt,
            hashPrefix: rec.hash.slice(0, 8),
        };
    }
    /**
     * label 是否已被占用（M-07）。
     *
     * 与 create/update 共用同一口径：直接遍历 byHash/dynamic 的 KeyRecord，
     * 不做排序、不构造全量视图 —— 替代管理面此前的 `listKeys().find(...)`（O(n) 且带 sort）。
     */
    hasLabel(label, exceptId) {
        for (const r of this.byHash.values())
            if (r.id !== exceptId && r.label === label)
                return true;
        for (const r of this.dynamic.values())
            if (r.id !== exceptId && r.label === label)
                return true;
        return false;
    }
    /** 按 keyId 取视图（M-07：替代 listKeys().find(...)，避免全量排序与视图构造） */
    findView(keyId) {
        const rec = this.findRecord(keyId);
        return rec ? this.toView(rec) : undefined;
    }
    /** 面板创建 key：明文只返回一次，库里只有哈希 */
    create(input) {
        const policy = this.config.tiers[input.tier];
        if (!policy)
            throw new Error(`未知分层: ${input.tier}`);
        // M-02 修复：调用方显式传了 secret 就必须校验；原写法在长度 <8 时静默改用随机值，
        // 调用方以为设了自己的 key、实际拿到另一个 —— 与 #145/#146 的强校验风格冲突。
        if (input.secret !== undefined && input.secret.length < 8) {
            throw new Error('自定义 secret 至少 8 个字符');
        }
        const secret = input.secret ?? generateKey();
        const hash = hashKey(secret);
        if (this.byHash.has(hash))
            throw new Error('该 key 已存在（哈希冲突或重复创建）');
        // label 唯一性约束（Q003/F1/SEC-006 修复）：在 create() 内部加约束，防止 TOCTOU 竞态。
        // Node.js 单线程模型下，同步 check-then-create 是原子的，但加此检查作为 defense in depth。
        const trimmedLabel = input.label?.trim();
        if (trimmedLabel && this.hasLabel(trimmedLabel)) {
            throw new Error(`label "${trimmedLabel}" 已存在`);
        }
        let id = `k_${shortId(8)}`;
        while ([...this.byHash.values()].some((r) => r.id === id))
            id = `k_${shortId(8)}`;
        const now = Date.now();
        const rec = {
            id,
            label: input.label?.trim() || `未命名 key（${input.tier}）`,
            hash,
            tier: input.tier,
            tenantId: input.tenantId || 'default',
            enabled: true,
            origin: input.origin ?? 'panel',
            createdAt: now,
            ...(input.allowedModels && input.allowedModels.length > 0 ? { allowedModels: input.allowedModels } : {}),
            ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
            ...(input.quotaOverride !== undefined ? { quotaOverride: input.quotaOverride } : {}),
            ...(input.quotaCny !== undefined ? { quotaCnyOverride: input.quotaCny } : {}),
        };
        this.byHash.set(hash, rec);
        this.dynamic.set(id, rec);
        this.storedCreatedAt.set(id, now);
        this.limiters.set(id, this.mkLimiter(id, policy.maxConcurrency ?? 32));
        this.persistMeta(rec);
        this.store.logEvent('warn', 'key.create', { keyId: id, tier: rec.tier, tenantId: rec.tenantId, label: rec.label, ...(input.actor ? { actor: input.actor } : {}) });
        this.logger.info('admin.key_create', { keyId: id, tier: rec.tier });
        return { secret, record: this.toView(rec) };
    }
    /** 修改元数据（不含明文 key；换 key 请用 rotate） */
    update(keyId, patch, actor) {
        const rec = this.findRecord(keyId);
        if (!rec)
            throw new Error(`key 不存在: ${keyId}`);
        if (patch.tier !== undefined) {
            const policy = this.config.tiers[patch.tier];
            if (!policy)
                throw new Error(`未知分层: ${patch.tier}`);
            rec.tier = patch.tier;
            this.limiters.get(rec.id)?.setLimit(policy.maxConcurrency ?? 32);
        }
        if (patch.label !== undefined) {
            const next = patch.label.trim();
            if (next) {
                // C-02 修复：唯一性不变量必须在**所有入口**等价 —— 此前只有 create 校验，
                // update 可把两把 key 改成同名，破坏“label 是人工唯一标识”的审计不变量。
                if (this.hasLabel(next, rec.id))
                    throw new Error(`label "${next}" 已存在`);
                rec.label = next;
            }
        }
        if (patch.enabled !== undefined)
            rec.enabled = patch.enabled;
        // 重启用补回鉴权索引（manual#392）：revoke 摘了 byHash，只置 enabled=true 的话
        // auth 仍查不到 this.byHash——『重新启用』必须同时让 key 恢复可用（#392 实证：
        // #365 修复只治好一半，update 成功但 auth 仍 401）。origin=config 的记录本就在
        // byHash，此重植是幂等的。
        if (rec.enabled && this.byHash.get(rec.hash) !== rec) {
            this.byHash.set(rec.hash, rec);
        }
        if (patch.allowedModels !== undefined) {
            if (patch.allowedModels === null || patch.allowedModels.length === 0)
                delete rec.allowedModels;
            else
                rec.allowedModels = patch.allowedModels;
        }
        if (patch.expiresAt !== undefined) {
            if (patch.expiresAt === null)
                delete rec.expiresAt;
            else
                rec.expiresAt = patch.expiresAt;
        }
        if (patch.quotaOverride !== undefined) {
            if (patch.quotaOverride === null)
                delete rec.quotaOverride;
            else
                rec.quotaOverride = patch.quotaOverride;
        }
        if (patch.quotaCny !== undefined) {
            if (patch.quotaCny === null)
                delete rec.quotaCnyOverride;
            else
                rec.quotaCnyOverride = patch.quotaCny;
        }
        this.persistMeta(rec);
        this.store.logEvent('warn', 'key.update', { keyId, patch: { ...patch }, ...(actor ? { actor } : {}) });
        this.logger.info('admin.key_update', { keyId, patch: { ...patch } });
        return this.toView(rec);
    }
    /** 吊销：软删除（保留历史度量，只让 key 失效） */
    revoke(keyId, actor) {
        const rec = this.findRecord(keyId);
        if (!rec)
            throw new Error(`key 不存在: ${keyId}`);
        rec.enabled = false;
        this.persistMeta(rec);
        // 面板创建的 key 从**鉴权索引**摘掉（byHash）即 auth 失效；dynamic 里的管理记录
        // 保留（manual#392·签字授权，#365 根因修复）：摘 dynamic 会让管理面在重启前认不得
        // 这把 key（列表消失/无法重启用/无法删除），与重启后 restore 的停用态语义割裂。
        if (rec.origin === 'panel') {
            this.byHash.delete(rec.hash);
        }
        this.store.logEvent('warn', 'key.revoke', { keyId, origin: rec.origin, label: rec.label, ...(actor ? { actor } : {}) });
        this.logger.warn('admin.key_revoke', { keyId, origin: rec.origin });
        return this.toView(rec);
    }
    /** 轮换：生成新 key 替换旧的（旧 key 立即失效），返回新的明文 */
    rotate(keyId, actor) {
        const rec = this.findRecord(keyId);
        if (!rec)
            throw new Error(`key 不存在: ${keyId}`);
        // 券 key 不允许轮换：券与 key 是「一券一 key」的核销凭证，
        // 轮换等于凭空再发一把新 key（旧券面额被重复兑现），绕过发券额度约束。
        if (rec.origin === 'voucher') {
            throw new Error(`券兑换的 key 不支持轮换: ${keyId}`);
        }
        const secret = generateKey();
        const hash = hashKey(secret);
        this.byHash.delete(rec.hash);
        rec.hash = hash;
        rec.enabled = true;
        this.byHash.set(hash, rec);
        this.persistMeta(rec);
        this.store.logEvent('warn', 'key.rotate', { keyId, label: rec.label, ...(actor ? { actor } : {}) });
        this.logger.warn('admin.key_rotate', { keyId });
        return { secret, record: this.toView(rec) };
    }
    /** 额度重置：不影响历史度量，只把本周期已用量清零 */
    resetQuota(keyId) {
        const rec = this.findRecord(keyId);
        if (!rec)
            throw new Error(`key 不存在: ${keyId}`);
        const before = this.usageForKey(keyId).tokens;
        this.store.logEvent('warn', 'quota.reset', { keyId, before, at: Date.now() });
        this.logger.warn('admin.quota_reset', { keyId, before });
        return { keyId, before, quota: this.quotaFor(rec) };
    }
    findRecord(keyId) {
        for (const rec of this.byHash.values())
            if (rec.id === keyId)
                return rec;
        // dynamic 兜底（manual#392·签字授权）：revoke 对 panel key 摘 byHash 后记录只剩
        // dynamic 一份——只搜 byHash 会让已撤销 key 在管理面全 404（#365 实证：列表消失/
        // 无法重启用/无法删除，直到重启才以停用态复活）。remove() 本就按 dynamic 取记录，
        // 这里把 findRecord 对齐成同一地图口径。
        const dyn = this.dynamic.get(keyId);
        return dyn;
    }
    quotaFor(rec) {
        return rec.quotaOverride ?? this.config.tiers[rec.tier]?.periodQuotaTokens ?? null;
    }
    /**
     * 限流计数（REQ-01）：优先走共享状态（多实例共享同一窗口计数），共享层异常则
     * fail-open 回落本地 store。**未注入 state 时行为与改造前逐字一致**（零回归）。
     */
    async incrRate(keyId, windowStartMs) {
        if (!this.state)
            return this.store.incrRate(keyId, windowStartMs);
        try {
            return await this.state.incrRate(keyId, windowStartMs);
        }
        catch (err) {
            // 状态层异常绝不 fail-close（红线 3）：记日志后回落本地镜像，请求照常放行
            this.logger.warn('state.incr_rate_degraded', { keyId, error: err instanceof Error ? err.message : String(err) });
            return this.store.incrRate(keyId, windowStartMs);
        }
    }
    /** 配额快照（REQ-01）：共享优先；异常 fail-open 回落本地 store。 */
    async quotaSnapshot(keyId, sinceMs) {
        if (!this.state)
            return this.store.quotaSnapshot(keyId, sinceMs);
        try {
            return await this.state.quotaSnapshot(keyId, sinceMs);
        }
        catch (err) {
            this.logger.warn('state.quota_snapshot_degraded', { keyId, error: err instanceof Error ? err.message : String(err) });
            return this.store.quotaSnapshot(keyId, sinceMs);
        }
    }
    /**
     * 本网关"认识"的全部模型名：各上游声明的 + 阶梯名 + 别名（含别名指向的真名）。
     * 用来把"模型名写错了"和"模型存在但没开通"分开。
     */
    knownModels() {
        const out = new Set();
        for (const p of this.config.providers)
            for (const m of p.models ?? [])
                out.add(m);
        for (const [name, steps] of Object.entries(this.config.modelLadders ?? {})) {
            out.add(name);
            for (const st of steps)
                out.add(st);
        }
        for (const [alias, target] of Object.entries(this.config.modelAliases ?? {})) {
            out.add(alias);
            out.add(target);
        }
        return out;
    }
    /** 按钱计的额度（人民币元）；未设则返回 null（= 不限） */
    quotaCnyFor(rec) {
        return rec.quotaCnyOverride ?? this.config.tiers[rec.tier]?.periodQuotaCny ?? null;
    }
    policyFor(tier) {
        // ownLookup：`this.config.tiers[tier]` 在 tier 为 'constructor'/'toString' 等时会命中
        // Object.prototype 而返回一个函数，下游把它当 TierPolicy 读就整条链路失调。
        // tier 来自 key 配置（运营可控），但一个拼错的档位名不该静默拿到"策略"。
        const policy = ownLookup(this.config.tiers, tier);
        if (policy === undefined) {
            throw new Error(`档位策略未定义：${tier}（tiers 配置里缺少该档位）`);
        }
        return policy;
    }
    /** 主鉴权入口 */
    async authenticate(opts) {
        const t0 = monotonicMs();
        const now = opts.now ?? Date.now();
        const duration = () => Math.round((monotonicMs() - t0) * 1000);
        try {
            const token = extractBearer(opts.authorization);
            if (!token) {
                const error = { code: 'missing_key', message: '缺少 Authorization 头。请使用: Authorization: Bearer <你的 relay key>' };
                this.recordReject(error.code, opts.authorization, opts.path);
                return { ok: false, error, durationUs: duration() };
            }
            const rec = this.byHash.get(hashKey(token));
            if (!rec) {
                const fingerprint = fingerprintOf(token);
                const error = {
                    code: 'invalid_key',
                    message: `无效的 relay key（指纹 ${fingerprint}）。它不是本网关当前签发的 key——` +
                        '常见原因有三个：① 还在用旧 key（轮换或删除后立即作废）；' +
                        '② **这份配置读的存储里没有这个 key**：面板创建的 key 只落在它当时那份配置的数据库里，' +
                        '换一份配置（或换一个 storage.path）启动，同一台机器上也会认不出它；' +
                        '③ 把上游厂商的 key 当成了 relay key。' +
                        '到 /admin →「客户 Key」页可以核对已签发 key 的指纹，或直接粘贴你手上的 key 做自检。',
                };
                this.recordReject(error.code, opts.authorization, opts.path);
                return { ok: false, error, durationUs: duration() };
            }
            // M-01 修复：与同文件 policyFor() 同一口径 —— ownLookup 规避原型链。
            // 直接索引在 tier='constructor'/'toString' 时会命中 Object.prototype 上的函数，
            // 被当成“策略”继续读 rpm/maxConcurrency 全为 undefined，限流与并发闸门静默失效。
            const policy = ownLookup(this.config.tiers, rec.tier);
            const identity = { keyId: rec.id, keyLabel: rec.label, tier: rec.tier, tenantId: rec.tenantId };
            if (!rec.enabled) {
                const error = { code: 'key_disabled', message: `key ${rec.label}（${rec.id}）已被禁用；如果这是你正在用的 key，请让运维在 /admin 里重新启用` };
                this.recordReject(error.code, opts.authorization, opts.path);
                return { ok: false, error, identity, durationUs: duration() };
            }
            if (rec.expiresAt !== undefined && now > rec.expiresAt) {
                const error = {
                    code: 'expired_key',
                    message: `key ${rec.label}（${rec.id}）已于 ${new Date(rec.expiresAt).toISOString()} 过期，请换一个新 key`,
                };
                this.recordReject(error.code, opts.authorization, opts.path);
                return { ok: false, error, identity, durationUs: duration() };
            }
            if (!policy) {
                return { ok: false, error: { code: 'internal', message: `key ${rec.id} 引用了未定义的分层 ${rec.tier}` }, identity, durationUs: duration() };
            }
            if (opts.model && rec.allowedModels && rec.allowedModels.length > 0 && !rec.allowedModels.includes(opts.model)) {
                const allowed = rec.allowedModels;
                // 先分清"这个模型名在本网关里存不存在"：不存在就是改名字的事，不是开通的事。
                const known = this.knownModels();
                if (!known.has(opts.model)) {
                    const near = nearestModel(opts.model, [...allowed]);
                    return {
                        ok: false,
                        error: {
                            code: 'model_not_found',
                            message: `模型 ${opts.model} 不在本网关的模型清单里。` +
                                (near ? `是不是想写 ${near}？` : '') +
                                ` 你这把 key（${policy.label}）可用的模型：${allowed.join(' / ')}`,
                            allowed,
                            ...(near ? { suggestion: near } : {}),
                        },
                        identity,
                        durationUs: duration(),
                    };
                }
                return {
                    ok: false,
                    error: {
                        code: 'model_not_allowed',
                        message: `当前 key（${policy.label}）未开通模型 ${opts.model}（该模型存在，但这把 key 的白名单里没有它；可用的：${allowed.join(' / ')}）`,
                        allowed,
                    },
                    identity,
                    durationUs: duration(),
                };
            }
            /* ---------- 限流（固定窗口，无状态取向） ---------- */
            if (policy.rpm !== null && policy.rpm > 0) {
                const windowStart = Math.floor(now / 60_000) * 60_000;
                // REQ-01：走共享状态（多实例共享同一窗口计数）；未注入 state 时回落 store.incrRate。
                const count = await this.incrRate(rec.id, windowStart);
                if (count > policy.rpm) {
                    const retryAfterMs = windowStart + 60_000 - now;
                    return {
                        ok: false,
                        error: {
                            code: 'rate_limited',
                            message: `超过本层速率上限 ${policy.rpm} RPM，请退避 ${Math.ceil(retryAfterMs / 1000)} 秒后重试`,
                            retryAfterMs,
                            limit: policy.rpm,
                        },
                        identity,
                        durationUs: duration(),
                    };
                }
            }
            /* ---------- 额度（按 30 天滑动周期，从度量库读取） ----------
             * 两种口径各自独立判断，任一超了都拒：
             *   · token 额度 —— 适合"给多少量"
             *   · 按钱的额度（quotaCny）—— 适合"给多少预算"，因为它对输入/输出比例不敏感。
             * 钱必须按钱算：¥3/M 输入、¥6/M 输出，同样 ¥10 折成 token 数取决于两者比例，
             * 用 token 额度冒充只能猜，客户对不上账。
             */
            const quota = rec.quotaOverride ?? policy.periodQuotaTokens;
            const quotaCny = rec.quotaCnyOverride ?? policy.periodQuotaCny ?? null;
            // G2/G5：放行时把余量带给响应层（有帽才算；无帽 = 不限）。
            let quotaInfo;
            if ((quota !== null && quota !== undefined) || (quotaCny !== null && quotaCny > 0)) {
                // 周期起点考虑"额度重置"：运营重置后用户应立刻恢复可用
                const resetAt = this.store.lastQuotaResetAt(rec.id);
                const periodStart = quotaPeriodStart(policy, now, resetAt);
                // REQ-01：走共享状态读取（多实例一致）；未注入 state 时回落 store.quotaSnapshot。
                const used = await this.quotaSnapshot(rec.id, periodStart);
                if (quota !== null && quota !== undefined && used.tokens >= quota) {
                    return {
                        ok: false,
                        error: {
                            code: 'quota_exhausted',
                            message: `本周期额度已用尽（${used.tokens}/${quota} token）。升级到更高层或等待下个周期重置`,
                            limit: quota,
                            used: used.tokens,
                        },
                        identity,
                        durationUs: duration(),
                    };
                }
                if (quotaCny !== null && quotaCny > 0 && used.costCny >= quotaCny) {
                    return {
                        ok: false,
                        error: {
                            code: 'quota_exhausted',
                            message: `本周期预算已用尽（${fmtCny(used.costCny)} / ${fmtCny(quotaCny)}）。` +
                                '充值或提额后可在管理面板「重置额度」立刻恢复，不必等下个周期',
                            limit: quotaCny,
                            used: used.costCny,
                        },
                        identity,
                        durationUs: duration(),
                    };
                }
                // 未超限 → 余量快照交给响应层（客户端据 x-relay-quota-* 预判/对账）。
                quotaInfo = {
                    tokens: quota !== null && quota !== undefined && quota > 0 ? { used: used.tokens, limit: quota } : null,
                    cny: quotaCny !== null && quotaCny > 0 ? { used: used.costCny, limit: quotaCny } : null,
                    periodStart,
                };
            }
            /* ---------- 并发闸门 ---------- */
            // L-03 修复：仅缺失时创建一次。原写法 `?? new ConcurrencyLimiter(...)` 后立刻 set，
            // 若某 key 因故不在表里，每个请求都会 new 一个覆盖旧的，把等待中的并发计数丢掉。
            let limiter = this.limiters.get(rec.id);
            if (!limiter) {
                limiter = this.mkLimiter(rec.id, policy.maxConcurrency ?? 32);
                this.limiters.set(rec.id, limiter);
            }
            if (policy.maxConcurrency !== null && policy.maxConcurrency > 0 && limiter.active >= policy.maxConcurrency) {
                return {
                    ok: false,
                    error: {
                        code: 'too_many_concurrent',
                        message: `并发数超过本层上限 ${policy.maxConcurrency}，请降低并发或等待在途请求完成`,
                        limit: policy.maxConcurrency,
                    },
                    identity,
                    durationUs: duration(),
                };
            }
            const release = await limiter.acquire(opts.signal);
            return { ok: true, identity, policy, release, durationUs: duration(), ...(quotaInfo ? { quota: quotaInfo } : {}) };
        }
        catch (err) {
            // fail-open 的边界：鉴权层自身异常必须放行？不行——鉴权是安全边界。
            // 正确做法是：异常时拒绝（fail-closed），但明确归因为 relay_internal_error 并计入度量。
            this.logger.error('auth.internal_error', { error: err instanceof Error ? err.message : String(err) });
            return {
                ok: false,
                error: { code: 'internal', message: '中转站鉴权层内部错误，请稍后重试（已在日志中标记）' },
                durationUs: duration(),
            };
        }
    }
    /** 本周期用量（用于管理看板与升级提示）。周期起点 = 最近一次额度重置，或 30 天前。 */
    usageForKey(keyId, now = Date.now()) {
        const rec = this.findRecord(keyId);
        const resetAt = this.store.lastQuotaResetAt(keyId);
        // G3：周期起点按该 key 的档位（rolling30d / calendarMonth）计算
        const windowStart = quotaPeriodStart(rec ? ownLookup(this.config.tiers, rec.tier) : undefined, now, resetAt);
        const snap = this.store.quotaSnapshot(keyId, windowStart);
        const quota = rec ? this.quotaFor(rec) : null;
        const quotaCny = rec ? this.quotaCnyFor(rec) : null;
        return {
            ...snap,
            quota,
            quotaCny,
            windowStart,
            quotaUsedPct: quota && quota > 0 ? Math.min(1, snap.tokens / quota) : null,
            quotaCnyUsedPct: quotaCny && quotaCny > 0 ? Math.min(1, snap.costCny / quotaCny) : null,
        };
    }
    /** 批次3（REQ-01，排队语义）：按 key 建并发闸门；**仅在共享后端（Redis）注入时**走跨实例排队，
     *  否则保持本地排队（零回归）——内存 state 是进程内实现，走它等于把本地队列换成轮询，无收益反有开销。 */
    mkLimiter(keyId, limit) {
        const shared = this.state && this.state.health().backend === 'shared'
            ? { store: this.state, key: `key:${keyId}`, ttlMs: (this.config.server.upstreamTimeoutMs ?? 120_000) + 60_000 }
            : undefined;
        return new ConcurrencyLimiter(limit, shared);
    }
    concurrencySnapshot() {
        return [...this.limiters.entries()].map(([keyId, l]) => ({ keyId, ...l.stats() }));
    }
    /**
     * P2 修复：批量获取所有 key 的 usage（消除 N+1 查询）
     * 一次 DB 查询获取所有 key 的聚合数据，而非逐个查询
     */
    usageForAll(keyIds, now = Date.now()) {
        const result = new Map();
        if (keyIds.length === 0)
            return result;
        // P2-N1 修复：为每个 key 使用各自的 windowStart（与 usageForKey 同口径）
        // v410 修复：重置时间改为**一次批量取回**。此前循环里逐 key 调 lastQuotaResetAt，
        // 每个 key 跑一条 `SELECT ... WHERE kind='quota.reset' ... LIMIT 500` 并把最多 500 行
        // 解析一遍——332 key 实测 72ms/请求，是 /keys 吞吐被锁在 ~46 req/s 的真凶
        // （额度聚合本身只要 7ms）。语义不变，查询次数 N→1。
        const resetMap = this.store.lastQuotaResetForAll(keyIds);
        // G3：周期起点按各 key 的档位（rolling30d / calendarMonth）计算
        const tierByKey = new Map();
        for (const r of [...this.byHash.values(), ...this.dynamic.values()])
            tierByKey.set(r.id, r.tier);
        const windowStarts = new Map();
        for (const keyId of keyIds) {
            const resetAt = resetMap.get(keyId) ?? 0;
            const tier = tierByKey.get(keyId);
            const policy = tier ? ownLookup(this.config.tiers, tier) : undefined;
            windowStarts.set(keyId, quotaPeriodStart(policy, now, resetAt));
        }
        const snapshots = this.store.quotaSnapshotForAll(keyIds, windowStarts);
        // P2-N2 修复：构建 keyId → record 索引，将 findRecord 降为 O(1)
        const recordMap = new Map();
        for (const rec of this.byHash.values()) {
            recordMap.set(rec.id, { tokens: 0, costCny: 0, requests: 0, quota: this.quotaFor(rec), quotaCny: this.quotaCnyFor(rec) });
        }
        for (const keyId of keyIds) {
            const snap = snapshots.get(keyId) ?? { tokens: 0, costCny: 0, requests: 0 };
            const rec = recordMap.get(keyId);
            const quota = rec?.quota ?? null;
            const quotaCny = rec?.quotaCny ?? null;
            const windowStart = windowStarts.get(keyId) ?? now;
            result.set(keyId, {
                ...snap,
                quota,
                quotaCny,
                windowStart,
                quotaUsedPct: quota && quota > 0 ? Math.min(1, snap.tokens / quota) : null,
                quotaCnyUsedPct: quotaCny && quotaCny > 0 ? Math.min(1, snap.costCny / quotaCny) : null,
            });
        }
        return result;
    }
    /* ---------------- 鉴权失败台账 ---------------- */
    /**
     * 记一次被拒的鉴权尝试。
     * 只保存指纹与头形态；不保存明文，也不因为"记台账"而让鉴权变慢或变成 fail-closed。
     */
    recordReject(code, authorization, path) {
        try {
            const raw = (authorization ?? '').trim();
            const token = extractBearer(authorization);
            const headerForm = raw === '' ? 'none' : /^Bearer\s+/i.test(raw) ? 'bearer' : 'bare';
            const rec = {
                at: Date.now(),
                code,
                fingerprint: token ? fingerprintOf(token) : '',
                keyLength: token?.length ?? 0,
                headerForm,
                path: path ?? '',
            };
            this.rejects.push(rec);
            if (this.rejects.length > KeyRegistry.REJECT_RING)
                this.rejects.splice(0, this.rejects.length - KeyRegistry.REJECT_RING);
            this.rejectTotal++;
            const ck = `${code}:${rec.fingerprint}`;
            const cur = this.rejectCounts.get(ck);
            if (cur) {
                cur.count++;
                cur.lastAt = rec.at;
            }
            else {
                this.rejectCounts.set(ck, { count: 1, firstAt: rec.at, lastAt: rec.at, keyLength: rec.keyLength, headerForm });
                // 每种新的错 key 各记一条：这是排查"用户到底拿的哪个 key"的第一现场
                this.logger.warn('auth.rejected', {
                    code,
                    fingerprint: rec.fingerprint || '(无 key)',
                    keyLength: rec.keyLength,
                    headerForm,
                    path: rec.path,
                    hint: '拿这个指纹去 /admin 的「客户 Key」页比对已签发 key 的指纹',
                });
            }
            // 同一种错 key 刷屏时按 100 次折一条日志，避免把日志写爆
            if (!cur && this.rejectTotal % 100 === 0) {
                this.logger.warn('auth.rejected_rollup', { total: this.rejectTotal, distinct: this.rejectCounts.size });
            }
        }
        catch {
            /* fail-open：台账坏了也不能影响鉴权结论 */
        }
    }
    authRejections(limit = 50) {
        const issued = new Set([...this.byHash.values()].map((r) => r.hash.slice(0, 8)));
        const groups = [...this.rejectCounts.entries()]
            .map(([ck, v]) => {
            const idx = ck.indexOf(':');
            const code = ck.slice(0, idx);
            const fp = ck.slice(idx + 1);
            return { code, fingerprint: fp, ...v, matchesIssuedKey: fp !== '' && issued.has(fp) };
        })
            .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
        const byCodeMap = new Map();
        for (const g of groups)
            byCodeMap.set(g.code, (byCodeMap.get(g.code) ?? 0) + g.count);
        return {
            total: this.rejectTotal,
            distinct: groups.length,
            byCode: [...byCodeMap.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count),
            groups,
            recent: this.rejects.slice(-limit).reverse(),
        };
    }
    /**
     * 自检：把"用户手上那个 key"换算成指纹并回答"它是不是这里签发的"。
     * 明文只在这一次调用里出现，不落盘、不进日志、不进台账。
     */
    resolveSecret(secret) {
        const fp = fingerprintOf(secret);
        const rec = this.byHash.get(hashKey(secret));
        if (!rec)
            return { found: false, fingerprint: fp, status: 'not_issued' };
        const expired = rec.expiresAt !== undefined && Date.now() > rec.expiresAt;
        return {
            found: true,
            fingerprint: fp,
            status: !rec.enabled ? 'key_disabled' : expired ? 'expired_key' : 'ok',
            key: this.toView(rec),
        };
    }
}
/**
 * 从候选里挑一个"最像"的模型名，用于拼写建议。
 * 用编辑距离；差距太大（超过名字长度的一半）就不猜，免得给出更误导的建议。
 */
export function nearestModel(input, candidates) {
    const dist = (a, b) => {
        const m = a.length, n = b.length;
        if (Math.abs(m - n) > 24)
            return 99;
        let prev = Array.from({ length: n + 1 }, (_, j) => j);
        for (let i = 1; i <= m; i++) {
            const cur = [i];
            for (let j = 1; j <= n; j++) {
                cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            }
            prev = cur;
        }
        return prev[n];
    };
    let best;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const c of candidates) {
        // 除了整名比较，还要比"候选的前缀"：手误常发生在型号族名上
        // （用户写 `agens`，真名是 `agnes-3.0-flash`，整名距离 10 会直接被长度守卫挡掉）。
        const prefix = c.slice(0, Math.max(input.length, 1));
        const score = Math.min(dist(input, c), dist(input, prefix));
        if (score < bestScore) {
            bestScore = score;
            best = c;
        }
    }
    if (!best)
        return undefined;
    const limit = Math.max(2, Math.floor(input.length / 2));
    return bestScore <= limit ? best : undefined;
}
/**
 * 金额格式化：小额预算（如 ¥0.0001）用 toFixed(2) 会被抹成 "¥0.00"，
 * 看起来像"没设额度"。按量级自适应小数位。
 */
export function fmtCny(v) {
    if (!Number.isFinite(v))
        return '¥?';
    const abs = Math.abs(v);
    const digits = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
    return `¥${v.toFixed(digits)}`;
}
/** 生成一个形如 sk-relay-xxxx 的客户端 key（32 字节随机，base64url） */
export function generateKey(prefix = 'sk-relay') {
    const bytes = randomBytes(24);
    return `${prefix}-${bytes.toString('base64url')}`;
}
export function hashKey(key) {
    return sha256Hex(`relay-key:${key}`);
}
/**
 * key 指纹 = 哈希前 8 位十六进制（与 KeyView.hashPrefix 完全同口径）。
 * 8 位十六进制对高熵随机 key 不可逆，但足够让"用户手上的 key"和"网关签发的 key"对上号。
 */
export function fingerprintOf(key) {
    return hashKey(key).slice(0, 8);
}
export function extractBearer(header) {
    if (!header)
        return undefined;
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (m)
        return m[1].trim();
    // 兼容部分客户端直接把 key 放在 Authorization 里
    if (!header.includes(' '))
        return header.trim();
    return undefined;
}
/** 把鉴权失败翻译成给客户端的可执行建议 */
export function authFailureSuggestion(error) {
    switch (error.code) {
        case 'rate_limited':
            return { action: 'retry_with_backoff', retryAfterMs: error.retryAfterMs };
        case 'too_many_concurrent':
            return { action: 'retry_with_backoff', retryAfterMs: 500 };
        case 'quota_exhausted':
            return { action: 'top_up_balance' };
        case 'expired_key':
        case 'invalid_key':
        case 'missing_key':
        case 'key_disabled':
            return { action: 'fix_credentials' };
        case 'model_not_allowed':
        case 'model_not_found':
            // 两者的动作都是"换个模型名"，但原因不同（没开通 vs 写错了），
            // 所以文案由 message 说清，动作保持一致。
            return { action: 'switch_model' };
        default:
            return { action: 'retry_same' };
    }
}
//# sourceMappingURL=keys.js.map