/**
 * 商户额度池管理（M0 概念验证）。
 * 
 * 核心语义：额度池按周期滚动，采购 token 数决定可发放上限，
 * 已发放 + 已消耗 用于审计与结算。
 * 
 * 设计约束：
 * - 零运行时依赖：只用 node:sqlite
 * - 不改 14 页签口径：门店功能嵌入现有「租户」或「运维」页签
 */

import { Logger } from '../core/logger.js';
import type { MerchantQuota } from '../core/types.js';
import type { Store } from '../store/index.js';

/** 额度池更新入参 */
export interface UpdateQuotaInput {
  tenantId: string;
  purchasedTokens: number;
  /** 可选：周期起始时间（毫秒），缺省 = 当前时间 */
  periodStart?: number;
}

/** 额度池余量 */
export interface QuotaBalance {
  purchased: number;
  issued: number;
  consumed: number;
  remaining: number;
}

/** 额度池管理器 */
export class QuotaManager {
  private readonly store: Store;
  private readonly logger: Logger;

  constructor(store: Store, logger: Logger) {
    this.store = store;
    this.logger = logger;
  }

  /**
   * 初始化或更新商户额度池。
   * 首次采购：创建记录，状态为 active。
   * 后续采购：累加 purchasedTokens，更新 periodStart。
   */
  async update(input: UpdateQuotaInput): Promise<void> {
    const now = input.periodStart ?? Date.now();
    try {
      await this.store.execute(
        'INSERT INTO merchant_quota (tenant_id, period_start, purchased_tokens, issued_tokens, consumed_tokens, status) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id) DO UPDATE SET purchased_tokens = purchased_tokens + excluded.purchased_tokens, period_start = excluded.period_start, status = excluded.status',
        [input.tenantId, now, input.purchasedTokens, 0, 0, 'active']
      );
      this.logger.info('quota.updated', { tenantId: input.tenantId, purchasedTokens: input.purchasedTokens });
    } catch (err) {
      this.logger.error('quota.update_failed', { error: err instanceof Error ? err.message : String(err) });
      throw new Error('更新额度池失败: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  /**
   * 查询商户额度池。
   */
  async get(tenantId: string): Promise<MerchantQuota | null> {
    try {
      const rows = await this.store.query(
        'SELECT * FROM merchant_quota WHERE tenant_id = ?',
        [tenantId]
      ) as Record<string, unknown>[];
      if (rows.length === 0) return null;
      const r = rows[0]!;
      return {
        tenantId: String(r['tenant_id']),
        periodStart: Number(r['period_start']),
        purchasedTokens: Number(r['purchased_tokens']),
        issuedTokens: Number(r['issued_tokens']),
        consumedTokens: Number(r['consumed_tokens']),
        status: String(r['status']) as 'active' | 'disabled',
      };
    } catch (err) {
      this.logger.error('quota.get_failed', { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  /**
   * 查询额度池余量。
   */
  async getBalance(tenantId: string): Promise<QuotaBalance | null> {
    const quota = await this.get(tenantId);
    if (!quota) return null;
    return {
      purchased: quota.purchasedTokens,
      issued: quota.issuedTokens,
      consumed: quota.consumedTokens,
      remaining: quota.purchasedTokens - quota.issuedTokens,
    };
  }

  /**
   * 停用商户额度池。
   */
  async disable(tenantId: string): Promise<void> {
    try {
      await this.store.execute(
        'UPDATE merchant_quota SET status = ? WHERE tenant_id = ?',
        ['disabled', tenantId]
      );
      this.logger.info('quota.disabled', { tenantId });
    } catch (err) {
      this.logger.error('quota.disable_failed', { error: err instanceof Error ? err.message : String(err) });
      throw new Error('停用额度池失败: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  /**
   * 启用商户额度池。
   */
  async enable(tenantId: string): Promise<void> {
    try {
      await this.store.execute(
        'UPDATE merchant_quota SET status = ? WHERE tenant_id = ?',
        ['active', tenantId]
      );
      this.logger.info('quota.enabled', { tenantId });
    } catch (err) {
      this.logger.error('quota.enable_failed', { error: err instanceof Error ? err.message : String(err) });
      throw new Error('启用额度池失败: ' + (err instanceof Error ? err.message : String(err)));
    }
  }
}
