import { VoucherManager, VoucherError } from '../../merchant/voucher.js';
import { QuotaManager } from '../../merchant/quota.js';
import { json, badRequest } from '../response.js';
import { resolveTenantScope, tenantForbidden } from './tenants.js';
/** VoucherError → HTTP 状态码（与设计文档 7.4 的错误码表一致） */
function statusForVoucherError(code) {
    switch (code) {
        case 'voucher_invalid':
            return 404;
        case 'voucher_unavailable':
            return 409;
        case 'voucher_expired':
            return 410;
        case 'quota_insufficient':
            return 400;
        case 'key_create_failed':
        case 'internal':
        default:
            return 500;
    }
}
function fail(res, err) {
    if (err instanceof VoucherError) {
        return json(res, statusForVoucherError(err.code), {
            error: {
                message: err.message,
                type: err.code === 'quota_insufficient' ? 'insufficient_quota' : 'invalid_request_error',
                code: err.code,
            },
        });
    }
    return json(res, 500, {
        error: {
            message: err instanceof Error ? err.message : String(err),
            type: 'internal_error',
            code: 'internal',
        },
    });
}
function positiveInt(value) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(n) || n <= 0)
        return undefined;
    return n;
}
function optionalString(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
export class MerchantHandlers {
    deps;
    vouchers;
    quotas;
    constructor(deps) {
        this.deps = deps;
        this.vouchers = new VoucherManager(deps.config, deps.store, deps.logger, deps.keys);
        this.quotas = new QuotaManager(deps.store, deps.logger);
    }
    /** 采购/累加额度池 */
    async quotaUpdate(res, body, actor) {
        const tenantId = optionalString(body?.['tenantId']);
        const purchasedTokens = positiveInt(body?.['purchasedTokens']);
        if (!tenantId || purchasedTokens === undefined) {
            return badRequest(res, 'tenantId 与 purchasedTokens（正整数）必填');
        }
        try {
            await this.quotas.update({ tenantId, purchasedTokens });
            this.deps.store.logEvent('warn', 'merchant.quota_update', { tenantId, purchasedTokens, actor });
            return json(res, 200, { ok: true, balance: await this.quotas.getBalance(tenantId) });
        }
        catch (err) {
            return fail(res, err);
        }
    }
    /** 查询额度池余量（受租户作用域约束） */
    async quotaView(res, url, boundTenant) {
        const scope = resolveTenantScope(boundTenant, url.searchParams.get('tenantId'));
        if (scope.forbidden || !scope.tenantId)
            return tenantForbidden(res);
        const balance = await this.quotas.getBalance(scope.tenantId);
        return json(res, 200, { tenantId: scope.tenantId, balance });
    }
    /** 发券 */
    async issue(res, body, actor) {
        const tenantId = optionalString(body?.['tenantId']);
        const storeId = optionalString(body?.['storeId']);
        const campaignId = optionalString(body?.['campaignId']);
        const tokenAmount = positiveInt(body?.['tokenAmount']);
        const expiresAt = positiveInt(body?.['expiresAt']);
        if (!tenantId || !storeId || !campaignId || tokenAmount === undefined || expiresAt === undefined) {
            return badRequest(res, 'tenantId / storeId / campaignId / tokenAmount / expiresAt 必填');
        }
        if (expiresAt <= Date.now())
            return badRequest(res, 'expiresAt 必须晚于当前时间');
        try {
            const voucher = await this.vouchers.issue({
                tenantId,
                storeId,
                campaignId,
                tokenAmount,
                expiresAt,
                ...(optionalString(body?.['codePrefix']) ? { codePrefix: optionalString(body?.['codePrefix']) } : {}),
            });
            this.deps.store.logEvent('warn', 'merchant.voucher_issue', { voucherId: voucher.id, tenantId, tokenAmount, actor });
            return json(res, 201, { voucher });
        }
        catch (err) {
            return fail(res, err);
        }
    }
    /** 换 key：用券换取一把受限客户端 key（明文仅返回一次） */
    async claim(res, body, actor) {
        const code = optionalString(body?.['code']);
        const tenantId = optionalString(body?.['tenantId']);
        const tier = optionalString(body?.['tier']);
        if (!code || !tenantId || !tier)
            return badRequest(res, 'code / tenantId / tier 必填');
        const allowed = body?.['allowedModels'];
        const allowedModels = Array.isArray(allowed) ? allowed.filter((m) => typeof m === 'string') : undefined;
        try {
            const out = await this.vouchers.claim({
                code,
                tenantId,
                tier: tier,
                ...(allowedModels && allowedModels.length > 0 ? { allowedModels } : {}),
                actor,
            });
            this.deps.store.logEvent('warn', 'merchant.voucher_claim', {
                voucherId: out.voucherId,
                hashPrefix: out.hashPrefix,
                tenantId,
                actor,
            });
            return json(res, 201, {
                ok: true,
                key: out.key,
                hash_prefix: out.hashPrefix,
                quota_tokens: out.quotaTokens,
                expires_at: out.expiresAt,
                notice: '密钥仅显示一次，请立即保存',
            });
        }
        catch (err) {
            return fail(res, err);
        }
    }
    /** 券列表（受租户作用域约束） */
    async vouchersView(res, url, boundTenant) {
        const scope = resolveTenantScope(boundTenant, url.searchParams.get('tenantId'));
        if (scope.forbidden || !scope.tenantId)
            return tenantForbidden(res);
        const limit = Math.min(positiveInt(url.searchParams.get('limit')) ?? 50, 200);
        try {
            const rows = (await this.deps.store.query('SELECT id, code, campaign_id, store_id, tenant_id, token_amount, status, expires_at, claim_at, key_id, created_at FROM store_voucher WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?', [scope.tenantId, limit]));
            return json(res, 200, { vouchers: rows.map((r) => ({
                    id: String(r['id']),
                    code: String(r['code']),
                    campaignId: String(r['campaign_id']),
                    storeId: String(r['store_id']),
                    tenantId: String(r['tenant_id']),
                    tokenAmount: Number(r['token_amount']),
                    status: String(r['status']),
                    expiresAt: Number(r['expires_at']),
                    claimAt: r['claim_at'] === null || r['claim_at'] === undefined ? null : Number(r['claim_at']),
                    keyId: r['key_id'] === null || r['key_id'] === undefined ? null : String(r['key_id']),
                    createdAt: Number(r['created_at']),
                })) });
        }
        catch (err) {
            return fail(res, err);
        }
    }
    /** 核销流水（受租户作用域约束；通过券表反查租户） */
    async redemptionsView(res, url, boundTenant) {
        const scope = resolveTenantScope(boundTenant, url.searchParams.get('tenantId'));
        if (scope.forbidden || !scope.tenantId)
            return tenantForbidden(res);
        const limit = Math.min(positiveInt(url.searchParams.get('limit')) ?? 50, 200);
        try {
            const rows = (await this.deps.store.query(`SELECT r.id, r.voucher_id, r.key_id, r.hash_prefix, r.ts, r.status
           FROM store_redemption r
           JOIN store_voucher v ON v.id = r.voucher_id
          WHERE v.tenant_id = ?
          ORDER BY r.ts DESC LIMIT ?`, [scope.tenantId, limit]));
            return json(res, 200, { redemptions: rows.map((r) => ({
                    id: String(r['id']),
                    voucherId: String(r['voucher_id']),
                    keyId: r['key_id'] === null || r['key_id'] === undefined ? null : String(r['key_id']),
                    hashPrefix: r['hash_prefix'] === null || r['hash_prefix'] === undefined ? null : String(r['hash_prefix']),
                    ts: Number(r['ts']),
                    status: String(r['status']),
                })) });
        }
        catch (err) {
            return fail(res, err);
        }
    }
}
//# sourceMappingURL=merchant.js.map