/**
 * 商户 token 券管理（M0 概念验证）。
 *
 * 核心语义：券只能被领取一次（靠 UPDATE ... WHERE status='unused' 原子占位），
 * 而 key 按面额耗尽失效，不是"只能调用 N 次"。
 *
 * 设计约束：
 * - 零运行时依赖：只用 node:crypto 和 node:sqlite
 * - fail-open：券服务异常返回业务错误，不影响已签发 key 的正常调用
 * - 不改 14 页签口径：门店功能嵌入现有「租户」或「运维」页签
 */
import { randomBytes } from 'node:crypto';
/** 券管理错误 */
export class VoucherError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = 'VoucherError';
    }
}
/** 生成券码：12 位 base32（60 bit）+ 2 位校验位 */
function generateCode(prefix) {
    const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    const random = randomBytes(8);
    let code = '';
    for (let i = 0; i < 8; i++) {
        code += alphabet[random[i] % alphabet.length];
    }
    const check = code.slice(0, 6).split('').reduce((sum, c) => sum + c.charCodeAt(0), 0) % alphabet.length;
    const check2 = code.slice(6, 12).split('').reduce((sum, c) => sum + c.charCodeAt(0), 0) % alphabet.length;
    return (prefix ? prefix + '-' : '') + code + alphabet[check] + alphabet[check2];
}
/** 生成短 ID */
function shortId(len) {
    const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    const random = randomBytes(len);
    let id = '';
    for (let i = 0; i < len; i++) {
        id += alphabet[random[i] % alphabet.length];
    }
    return id;
}
/** 券管理器 */
export class VoucherManager {
    config;
    store;
    logger;
    keys;
    constructor(config, store, logger, keys) {
        this.config = config;
        this.store = store;
        this.logger = logger;
        this.keys = keys;
    }
    /**
     * 发券：创建一张券，状态为 unused。
     */
    async issue(input) {
        const quota = await this.getMerchantQuota(input.tenantId);
        if (!quota || quota.status !== 'active') {
            throw new VoucherError('quota_insufficient', '商户额度池不存在或已停用', { tenantId: input.tenantId });
        }
        // 防超发：余量 = 已采购 − 已核销 − 尚未核销的券面额。
        // 只看 issued_tokens 会漏掉「已发券但顾客还没兑换」的部分，等于没有上限。
        const outstandingRows = (await this.store.query("SELECT COALESCE(SUM(token_amount), 0) AS outstanding FROM store_voucher WHERE tenant_id = ? AND status IN ('unused','claimed')", [input.tenantId]));
        const outstanding = Number(outstandingRows[0]?.['outstanding'] ?? 0);
        const remaining = quota.purchasedTokens - quota.issuedTokens - outstanding;
        if (remaining < input.tokenAmount) {
            throw new VoucherError('quota_insufficient', '商户额度池余量不足', {
                tenantId: input.tenantId,
                remaining,
                outstanding,
                requested: input.tokenAmount,
            });
        }
        const code = generateCode(input.codePrefix);
        const now = Date.now();
        const voucher = {
            id: 'v_' + shortId(12),
            code,
            campaignId: input.campaignId,
            storeId: input.storeId,
            tenantId: input.tenantId,
            tokenAmount: input.tokenAmount,
            status: 'unused',
            expiresAt: input.expiresAt,
            createdAt: now,
        };
        try {
            await this.store.execute('INSERT INTO store_voucher (id, code, campaign_id, store_id, tenant_id, token_amount, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [voucher.id, voucher.code, voucher.campaignId, voucher.storeId, voucher.tenantId, voucher.tokenAmount, voucher.status, voucher.expiresAt, voucher.createdAt]);
        }
        catch (err) {
            this.logger.error('voucher.issue_failed', { error: err instanceof Error ? err.message : String(err) });
            throw new VoucherError('internal', '发券失败', { error: err instanceof Error ? err.message : String(err) });
        }
        this.store.logEvent('info', 'voucher.issue', {
            voucherId: voucher.id,
            code: voucher.code,
            tenantId: voucher.tenantId,
            tokenAmount: voucher.tokenAmount,
        });
        this.logger.info('voucher.issued', { voucherId: voucher.id, code: voucher.code, tokenAmount: voucher.tokenAmount });
        return voucher;
    }
    /**
     * 查券：查询券的状态。
      */
    async getVoucher(code) {
        try {
            const rows = await this.store.query('SELECT * FROM store_voucher WHERE code = ?', [code]);
            if (rows.length === 0)
                return null;
            const r = rows[0];
            return {
                id: String(r['id']),
                code: String(r['code']),
                campaignId: String(r['campaign_id']),
                storeId: String(r['store_id']),
                tenantId: String(r['tenant_id']),
                tokenAmount: Number(r['token_amount']),
                status: String(r['status']),
                expiresAt: Number(r['expires_at']),
                claimAt: r['claim_at'] !== null && r['claim_at'] !== undefined ? Number(r['claim_at']) : undefined,
                keyId: r['key_id'] !== null && r['key_id'] !== undefined ? String(r['key_id']) : undefined,
                createdAt: Number(r['created_at']),
            };
        }
        catch (err) {
            this.logger.error('voucher.get_failed', { error: err instanceof Error ? err.message : String(err) });
            return null;
        }
    }
    /**
     * 换 key：用券换取一把受限 API Key（原子占位）。
      */
    async claim(input) {
        const now = Date.now();
        // 1. 原子占位
        const changes = await this.store.execute('UPDATE store_voucher SET status = ?, claim_at = ? WHERE code = ? AND status = ? AND expires_at > ?', ['claimed', now, input.code, 'unused', now]);
        if (changes === 0) {
            const voucher = await this.getVoucher(input.code);
            if (!voucher) {
                throw new VoucherError('voucher_invalid', '券码不存在', { code: input.code });
            }
            if (voucher.expiresAt <= now) {
                throw new VoucherError('voucher_expired', '券已过期', { code: input.code, expiresAt: voucher.expiresAt });
            }
            throw new VoucherError('voucher_unavailable', '券已被领取', { code: input.code, status: voucher.status });
        }
        // 2. 查询券详情
        const voucher = await this.getVoucher(input.code);
        if (!voucher) {
            throw new VoucherError('internal', '券锁定后查询失败', { code: input.code });
        }
        // 3. 校验租户
        if (voucher.tenantId !== input.tenantId) {
            await this.store.execute('UPDATE store_voucher SET status = ?, claim_at = NULL WHERE id = ?', ['unused', voucher.id]);
            throw new VoucherError('voucher_unavailable', '券不属于当前租户', {
                code: input.code,
                expectedTenant: voucher.tenantId,
                actualTenant: input.tenantId,
            });
        }
        // 4. 校验额度池状态并扣减（停用的池不允许继续兑付）
        const quota = await this.getMerchantQuota(input.tenantId);
        if (!quota || quota.status !== 'active') {
            await this.store.execute('UPDATE store_voucher SET status = ?, claim_at = NULL WHERE id = ?', ['unused', voucher.id]);
            throw new VoucherError('quota_insufficient', '商户额度池已停用', { tenantId: input.tenantId });
        }
        try {
            await this.store.execute('UPDATE merchant_quota SET issued_tokens = issued_tokens + ? WHERE tenant_id = ?', [voucher.tokenAmount, input.tenantId]);
        }
        catch (err) {
            await this.store.execute('UPDATE store_voucher SET status = ?, claim_at = NULL WHERE id = ?', ['unused', voucher.id]);
            this.logger.error('voucher.quota_deduct_failed', { error: err instanceof Error ? err.message : String(err) });
            throw new VoucherError('internal', '额度池扣减失败', { error: err instanceof Error ? err.message : String(err) });
        }
        // 5. 签发 key
        let keySecret;
        let keyId;
        // hashPrefix 必须是**哈希前缀**（与 KeyView 同口径），不是明文前缀：
        // 管理面按 hashPrefix 人工核对密钥，若这里存明文头，两边永远对不上。
        let keyHashPrefix;
        try {
            const created = this.keys.create({
                label: 'store:' + voucher.storeId + ':' + voucher.id,
                tier: input.tier,
                tenantId: input.tenantId,
                allowedModels: input.allowedModels,
                expiresAt: now + 7 * 24 * 60 * 60 * 1000,
                quotaOverride: voucher.tokenAmount,
                actor: input.actor,
                origin: 'voucher',
            });
            keySecret = created.secret;
            keyId = created.record.id;
            keyHashPrefix = created.record.hashPrefix;
        }
        catch (err) {
            await this.store.execute('UPDATE store_voucher SET status = ?, claim_at = NULL WHERE id = ?', ['unused', voucher.id]);
            await this.store.execute('UPDATE merchant_quota SET issued_tokens = issued_tokens - ? WHERE tenant_id = ?', [voucher.tokenAmount, input.tenantId]);
            this.logger.error('voucher.key_create_failed', { error: err instanceof Error ? err.message : String(err) });
            throw new VoucherError('key_create_failed', '签发 key 失败', { error: err instanceof Error ? err.message : String(err) });
        }
        // 6. 更新券状态为 used，写 redemption
        try {
            await this.store.execute('UPDATE store_voucher SET status = ?, key_id = ? WHERE id = ?', ['used', keyId, voucher.id]);
            const redemption = {
                id: 'r_' + shortId(12),
                voucherId: voucher.id,
                keyId,
                hashPrefix: keyHashPrefix,
                ts: now,
                status: 'success',
            };
            await this.store.execute('INSERT INTO store_redemption (id, voucher_id, key_id, hash_prefix, ts, status) VALUES (?, ?, ?, ?, ?, ?)', [redemption.id, redemption.voucherId, redemption.keyId, redemption.hashPrefix, redemption.ts, redemption.status]);
        }
        catch (err) {
            this.logger.error('voucher.redemption_write_failed', {
                error: err instanceof Error ? err.message : String(err),
                voucherId: voucher.id,
                keyId,
            });
            try {
                await this.store.execute('INSERT INTO store_redemption (id, voucher_id, key_id, ts, status) VALUES (?, ?, ?, ?, ?)', ['r_' + shortId(12), voucher.id, keyId, now, 'orphan']);
            }
            catch {
                // 忽略
            }
            throw new VoucherError('internal', '写入核销记录失败，key 已签发', {
                error: err instanceof Error ? err.message : String(err),
                keyId,
            });
        }
        // 7. 写审计事件
        this.store.logEvent('info', 'voucher.claim', {
            voucherId: voucher.id,
            keyId,
            tenantId: input.tenantId,
            tokenAmount: voucher.tokenAmount,
        });
        this.logger.info('voucher.claimed', { voucherId: voucher.id, keyId, tokenAmount: voucher.tokenAmount });
        return {
            key: keySecret,
            hashPrefix: keyHashPrefix,
            quotaTokens: voucher.tokenAmount,
            expiresAt: now + 7 * 24 * 60 * 60 * 1000,
            voucherId: voucher.id,
        };
    }
    /**
     * 查询商户额度池。
      */
    async getMerchantQuota(tenantId) {
        try {
            const rows = await this.store.query('SELECT * FROM merchant_quota WHERE tenant_id = ?', [tenantId]);
            if (rows.length === 0)
                return null;
            const r = rows[0];
            return {
                tenantId: String(r['tenant_id']),
                periodStart: Number(r['period_start']),
                purchasedTokens: Number(r['purchased_tokens']),
                issuedTokens: Number(r['issued_tokens']),
                consumedTokens: Number(r['consumed_tokens']),
                status: String(r['status']),
            };
        }
        catch (err) {
            this.logger.error('voucher.quota_get_failed', { error: err instanceof Error ? err.message : String(err) });
            return null;
        }
    }
    /**
     * 初始化商户额度池（首次采购）。
      */
    async initMerchantQuota(tenantId, purchasedTokens, periodStart) {
        const now = periodStart ?? Date.now();
        try {
            await this.store.execute('INSERT INTO merchant_quota (tenant_id, period_start, purchased_tokens, issued_tokens, consumed_tokens, status) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id) DO UPDATE SET purchased_tokens = purchased_tokens + excluded.purchased_tokens, period_start = excluded.period_start, status = excluded.status', [tenantId, now, purchasedTokens, 0, 0, 'active']);
        }
        catch (err) {
            this.logger.error('voucher.quota_init_failed', { error: err instanceof Error ? err.message : String(err) });
            throw new VoucherError('internal', '初始化额度池失败', { error: err instanceof Error ? err.message : String(err) });
        }
    }
}
//# sourceMappingURL=voucher.js.map