/**
 * FailurePresenter：把「失败 → 归因卡片 → 错误体 / 响应头」这一段从 Engine 里抽出来。
 *
 * M-05 修复（巨型文件拆分·第一期）：`engine.ts` 此前 1800+ 行，其中约 200 行是**纯呈现逻辑**
 * （错误码映射、错误体拼装、归因附加、响应头构造、内容完整性 HMAC 回显）——它们与"选路/重试/度量"
 * 这些真正的管道编排混在一起，既难读也难单测。
 *
 * 抽层判据沿用 `admin/response.ts` 头注确立的三条：
 *   ① 不读 this.* → 直接抽成模块级函数（`headerSafe`、`errorCodeFor`、`precheckCard`…）；
 *   ② 只读一个明确依赖 → 抽成「依赖注入的类」（本类）：
 *      它只依赖两样东西 —— `LossReductionConfig`（归因/度量开关）与 `hideUpstream`（隐私回显）。
 *      二者都以**取值函数**注入而非快照，因此运行期若刷新配置也即时生效，行为与留在 Engine 内一致。
 *
 * 收益：Engine 只保留管道编排；本模块是纯函数集合，可独立单测（见 `src/test/presenter.test.ts`）。
 */
import type { AttributionCard, FailureReason, LossReductionConfig, RelayRequestContext, TierPolicy } from '../core/types.js';
import type { QuotaInfo } from './keys.js';
import { hmacHex } from '../util/index.js';
import { violationReason } from '../loss/precheck.js';
import type { EngineErrorCode, EngineJson } from './protocol.js';

/**
 * 额度响应头策略（G2/G5·审查修复）。
 * NEAR_LIMIT_RATIO：用量占比 ≥ 该值即附 `x-relay-quota-warning: near_limit`（阈值可调）。
 */
export const QuotaHeaderPolicy = {
  NEAR_LIMIT_RATIO: 0.9,
} as const;

/** 依赖（取值函数注入：允许运行期配置刷新即时生效，避免快照漂移） */
export interface FailurePresenterDeps {
  /** 降损配置（归因开关 / 是否附带证据） */
  lr: () => LossReductionConfig;
  /** 是否隐藏上游身份（隐私：不回显 provider id / 上游真实模型名） */
  hideUpstream: () => boolean;
}

/**
 * 响应头值必须是**可见 ASCII**。
 *
 * Node 遇到中文会直接抛 `Invalid character in header content`，把一次完全正常的请求
 * 变成 500 —— 2026-09-14 把档位名改成中文（旗舰/平衡/极速）后当场踩到：
 * `x-relay-model-requested: 旗舰` 让每个中文档位名的请求都 500。
 *
 * 这里把非 ASCII 按 UTF-8 **百分号编码**（`旗舰` → `%E6%97%97%E8%88%B0`）。
 */
export function headerSafe(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, (ch) =>
    [...Buffer.from(ch, 'utf8')].map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join(''),
  );
}

export class FailurePresenter {
  constructor(private readonly deps: FailurePresenterDeps) {}

  /** 失败原因 → 对外的 OpenAI 兼容错误码 */
  errorCodeFor(card: AttributionCard): EngineErrorCode {
    switch (card.failure_reason) {
      case 'rate_limited':
      case 'model_overloaded':
        return 'rate_limit_error';
      case 'quota_exhausted':
        return 'insufficient_quota';
      case 'auth_invalid':
      case 'permission_denied':
        return 'upstream_error';
      case 'model_not_found':
        return 'model_not_found';
      case 'upstream_timeout':
      case 'network_error':
        return 'upstream_timeout';
      case 'context_length_exceeded':
      case 'content_filtered':
      case 'invalid_request':
      case 'tool_call_invalid':
        return 'invalid_request_error';
      case 'relay_internal_error':
      case 'stream_interrupted':
        return 'relay_internal_error';
      default:
        return 'upstream_error';
    }
  }

  errorBody(
    code: EngineErrorCode,
    message: string,
    extra: { param?: string; code?: string; type?: string },
    card: AttributionCard | undefined,
    policy: TierPolicy,
    payload?: Record<string, unknown>,
  ): string {
    const body: Record<string, unknown> = {
      error: {
        message,
        type: extra.type ?? code,
        param: extra.param ?? null,
        code: extra.code ?? code,
        ...(payload ? { relay_details: payload } : {}),
      },
    };
    const withCard = this.applyAttribution(body, card, policy);
    return JSON.stringify(withCard);
  }

  /** 归因只做"附加"：绝不删除/改写 error.message 原文 */
  applyAttribution(body: Record<string, unknown>, card: AttributionCard | undefined, policy: TierPolicy): Record<string, unknown> {
    const lr = this.deps.lr();
    if (!card || !lr.attribution.enabled) return body;
    if (policy.attribution === 'off') return body;
    const attribution = {
      failure_reason: card.failure_reason,
      suggested_next: card.suggested_next,
      recoverable: card.recoverable,
      upstream: this.deps.hideUpstream() ? 'relay' : card.upstream,
      confidence: card.confidence,
      ...(lr.attribution.includeEvidence && card.evidence ? { evidence: card.evidence } : {}),
    };
    if (policy.attribution === 'header') {
      // header 模式：错误体保持完全原样，归因只进响应头
      return body;
    }
    const error = body['error'] as Record<string, unknown>;
    error['relay_attribution'] = attribution;
    return body;
  }

  attributionHeaders(card: AttributionCard | undefined, policy: TierPolicy): Record<string, string> {
    if (!card) return {};
    const headers: Record<string, string> = {};
    /* Retry-After 是标准信号，客户端/网关/负载均衡都认。
     * 熔断或限流导致的"暂时没有可用上游"必须给出它，否则客户端只能瞎等或猛重试。 */
    if (card.recoverable && card.suggested_next.retryAfterMs !== undefined) {
      headers['retry-after'] = String(Math.max(1, Math.ceil(card.suggested_next.retryAfterMs / 1000)));
    }
    const lr = this.deps.lr();
    if (!lr.attribution.enabled || policy.attribution === 'off') return headers;
    const compact = `${card.failure_reason};next=${card.suggested_next.action}${
      card.suggested_next.retryAfterMs !== undefined ? `;retry_after_ms=${card.suggested_next.retryAfterMs}` : ''
    };recoverable=${card.recoverable};upstream=${this.deps.hideUpstream() ? 'relay' : card.upstream}`;
    headers['x-relay-attribution'] = headerSafe(compact);
    return headers;
  }

  attributionHeadersForSuccess(policy: TierPolicy): Record<string, string> {
    if (!this.deps.lr().attribution.enabled || policy.attribution === 'off') return {};
    return { 'x-relay-loss-reduction': `precheck=${policy.precheck};attribution=${policy.attribution}` };
  }

  /**
   * 额度余量响应头（G2/G5·审查修复·短板1+2）。
   *
   * 只在**该 key 确实配了帽**时返回（无帽 = 不限，不该暗示有上限）。客户端据此：
   *   · 预判还能跑多少（`x-relay-quota-tokens` / `-cny` = `used/limit`）
   *   · 对账（token 口径与 ¥ 口径分开给，避免"折成 token"的换算谎言）
   *   · 接近上限时收到 `x-relay-quota-warning: near_limit`（G5，阈值 90%）
   * 仅进响应头、不改响应体，与"成功响应零改写"一致。
   */
  quotaHeaders(quota: QuotaInfo | undefined): Record<string, string> {
    if (!quota) return {};
    const headers: Record<string, string> = { 'x-relay-quota-period-start': String(quota.periodStart) };
    const pcts: number[] = [];
    if (quota.tokens) {
      headers['x-relay-quota-tokens'] = `${quota.tokens.used}/${quota.tokens.limit}`;
      pcts.push(quota.tokens.limit > 0 ? quota.tokens.used / quota.tokens.limit : 0);
    }
    if (quota.cny) {
      headers['x-relay-quota-cny'] = `${quota.cny.used}/${quota.cny.limit}`;
      pcts.push(quota.cny.limit > 0 ? quota.cny.used / quota.cny.limit : 0);
    }
    if (pcts.length > 0) {
      const maxPct = Math.max(...pcts);
      headers['x-relay-quota-used-pct'] = maxPct.toFixed(3);
      // G5：近限告警（≥90% 但未超）。超限会走 402，不会到这里。
      if (maxPct >= QuotaHeaderPolicy.NEAR_LIMIT_RATIO) headers['x-relay-quota-warning'] = 'near_limit';
    }
    return headers;
  }

  /**
   * 透明性回显：客户端随时能知道本次请求被哪一层策略、哪一套降损开关处理，
   * **以及实际服务它的是哪个模型**。
   *
   * 后面这条是档位阶梯的必要配套：阶梯会换模型，如果不声明，客户就在被静默换模型
   * ——那正是"宁可报错也不要静默降级"要防的事。客户可以据此在需要时强制指定模型。
   */
  modeHeader(ctx: RelayRequestContext, policy: TierPolicy): Record<string, string> {
    const headers: Record<string, string> = {
      'x-relay-mode': `tier=${ctx.client.tier};precheck=${policy.precheck};attribution=${policy.attribution};meter=${
        this.deps.lr().meter.enabled ? 'on' : 'off'
      };client=${ctx.fingerprint.kind}`,
      'x-relay-model-requested': headerSafe(ctx.requestedModel),
    };
    const last = ctx.routes.at(-1);
    // hideUpstream：不回显上游 provider id / 上游真实模型名 / 阶梯位置
    if (last && !this.deps.hideUpstream()) {
      headers['x-relay-model-served'] = headerSafe(last.upstreamModel);
      headers['x-relay-upstream'] = last.providerId;
      if (last.ladderStep) {
        headers['x-relay-ladder'] = `${last.ladderStep.index + 1}/${last.ladderStep.total}`;
        if (last.upstreamModel !== ctx.requestedModel) {
          headers['x-relay-switched'] = headerSafe(`${ctx.requestedModel}->${last.upstreamModel}`);
        }
      }
    }
    return headers;
  }

  /**
   * 「我没动你的数据」的可验证证明。
   *
   * 客户端带 `X-Relay-Verify-Nonce: <随机串>` 时，中转站对响应体做 HMAC-SHA256 并回传，
   * 客户端用同一 nonce 与自己的副本重算即可证明字节未被篡改。
   * 这把"信任假设"从口头承诺变成可审计事实——普通中转站给不出这个。
   *
   * 限制：仅对可完整缓冲的响应生效（非流式）。流式响应请用 `X-Relay-Stream-Digest`（见契约文档）。
   */
  verificationHeaders(req: { headers: Record<string, string> }, bodyText: string, requestId: string): Record<string, string> {
    const nonce = req.headers['x-relay-verify-nonce'];
    if (!nonce) return {};
    const digest = hmacHex(nonce, bodyText);
    return {
      'x-relay-content-hmac-alg': 'hmac-sha256',
      'x-relay-content-hmac': digest,
      'x-relay-content-hmac-nonce': nonce,
      'x-relay-content-hmac-request-id': requestId,
    };
  }

  precheckCard(code: string, details: string[], model: string): AttributionCard {
    return {
      failure_reason: violationReason(code),
      message: '中转站预检拦截：请求在到达上游之前就已被判定必然失败，因此没有消耗任何上游额度',
      suggested_next: { action: code.startsWith('model_') ? 'switch_model' : 'fix_request' },
      recoverable: true,
      upstream: 'relay',
      confidence: 1,
      evidence: details,
    };
  }

  abortedCard(providerId: string): AttributionCard {
    return {
      // 客户端断开不是"流被中断"，更不是上游故障：它是客户端侧的决定。
      // stream_interrupted 另有其用（流已经开始、中途真断了）。
      failure_reason: 'client_aborted',
      message: '客户端已断开连接，上游调用随之中止',
      suggested_next: { action: 'abort' },
      recoverable: false,
      upstream: providerId,
      confidence: 1,
    };
  }

  simpleError(code: EngineErrorCode, message: string, evidence: string[], status: number): EngineJson {
    const card: AttributionCard = {
      failure_reason: 'invalid_request' as FailureReason,
      message,
      suggested_next: { action: 'fix_request' },
      recoverable: true,
      upstream: 'relay',
      confidence: 1,
      evidence,
    };
    return {
      kind: 'json',
      status,
      body: JSON.stringify({ error: { message, type: code, param: null, code, relay_attribution: {
        failure_reason: card.failure_reason,
        suggested_next: card.suggested_next,
        recoverable: card.recoverable,
        upstream: 'relay',
        confidence: 1,
      } } }),
      headers: { 'x-relay-attribution': `invalid_request;next=fix_request;recoverable=true;upstream=relay` },
    };
  }
}

/**
 * 非流式响应的 model 回显修正：解析 → 只替换 model 字段 → 重新序列化。
 * 失败则原样返回（fail-open）。
 *
 * C1（审查修复·模块归档）：随 headerSafe 一并迁入呈现层——它同样只改"对外回显"，
 * 不参与管道编排。engine.ts 保留转发导出，既有 import 路径（含测试）不受影响。
 */
export function rewriteJsonModel(bodyText: string, targetModel: string): string {
  try {
    const obj = JSON.parse(bodyText) as Record<string, unknown>;
    if (typeof obj !== 'object' || obj === null) return bodyText;
    if (obj['model'] === targetModel) return bodyText;
    obj['model'] = targetModel;
    return JSON.stringify(obj);
  } catch {
    return bodyText;
  }
}