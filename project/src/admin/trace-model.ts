/**
 * 请求账本的模型名提取（C2·审查修复·模块归档）。
 *
 * 从 `admin/api.ts` 抽出：纯函数、不读 this，符合本层抽层判据①。
 * 导出供单测与其它视图复用（此前是 api.ts 的私有函数）。
 */
import type { TraceRecord } from '../core/types.js';

/**
 * 从 trace 的 route step 提取模型名（manual#261 扩展 #227）。
 *
 * 两种形态：
 *  ① 正常路由：`→ provider（reason）model=X`（#227 已覆盖）
 *  ② 无路由失败：`档位阶梯全部不可达：没有任何上游声明支持模型 X（这是模型清单问题…）`
 *     ——#227 只认 ①，未声明模型的请求（unknown 上游）在账本里 model 只显「—」，
 *     运营看不到是哪个模型名（如 step-1-8k）。补 ② 让这些请求也能按模型搜/显。
 * 注意 ② 的模型名后紧跟全角括号，[^\s（] 防止把括号吃进名字。
 */
export function traceModel(steps: TraceRecord['steps'] | undefined): string | null {
  // ① summary 形态（#227 正常 model=X / #261 noRoute『支持模型 X』）。
  // 注意 find 要按摘要特征筛：阶梯别名请求有**两个** route step——第一个是阶梯计划
  // （『档位阶梯共 5 阶：…』无 model=），第二个才是实际路由（带 model=）。直接取第一个
  // 会拿到计划步（#272 回归实测：35 个阶梯请求的模型名全丢）。
  const rsSummary = (steps || []).find((s) => s.stage === 'route' && (/model=/.test(s.summary || '') || /支持模型\s/.test(s.summary || '')));
  if (rsSummary) {
    const m = String(rsSummary.summary).match(/model=(\S+)/) ?? String(rsSummary.summary).match(/支持模型\s+([^\s（]+)/);
    if (m && m[1]) return m[1];
  }
  // ② detail.ladder 形态（manual#272）：熔断冷却类失败（『上游 X 正处于熔断冷却中……
  // 与请求的模型名无关』）的模型名不在 summary 里——只在 route step 的 detail.ladder。
  // 此前账本对这类只显『—』（13 个熔断失败全无模型名，排查时看不到请求的是哪个模型）。
  // 只收单模型形态（不含 |）：阶梯别名请求的 detail.ladder 是整条链，客户真正请求的
  // 别名不在 trace 里（根修复在能力层 #227），显示整链会污染模型列——那种保持 null。
  const rsLadder = (steps || []).find((s) => {
    if (s.stage !== 'route') return false;
    const lad = s.detail && typeof s.detail === 'object' ? (s.detail as { ladder?: unknown }).ladder : undefined;
    return typeof lad === 'string' && lad.length > 0 && !lad.includes('|');
  });
  if (rsLadder) {
    return (rsLadder.detail as { ladder: string }).ladder;
  }
  return null;
}