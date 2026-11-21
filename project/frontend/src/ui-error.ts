/**
 * 前端错误分类（P1-1）。
 *
 * 由来：2026-10-23 线上事故中，`Overview` 的 `catch` 把 `ReferenceError`（TDZ）
 * 与网络失败共用同一文案「网络或网关可能临时不可达」，导致**真实 bug 被伪装成环境问题**，
 * 且对不可自愈的编程错误持续自动重试。
 *
 * 本模块把「错误 → 种类 → 展示文案 → 是否可重试」这条判断收敛为唯一实现，
 * 各视图直接复用，避免每个视图各写一套正则（历史上正是这样长出了不一致的文案）。
 */

export type UiErrorKind = 'network' | 'auth' | 'server' | 'program';

export interface UiErrorInfo {
  kind: UiErrorKind;
  /** 原始错误文本 */
  raw: string;
  /** 展示图标 */
  icon: string;
  /** 展示标题 */
  title: string;
  /** 展示提示（含处置建议） */
  hint: string;
  /** 是否值得自动重试：编程错误不可自愈 → false */
  retriable: boolean;
}

/** 编程/运行时错误特征（这些**不会**因重试而自愈） */
const PROGRAM_RE =
  /^(ReferenceError|TypeError|SyntaxError|RangeError|InternalError)\b|Cannot access|before initialization|is not a function|is not defined|undefined is not an object/i;

/** 鉴权/会话失效特征 */
const AUTH_RE = /未授权|Unauthorized|令牌已失效|令牌无效|无效的 relay key|账号或密码错误|登录已过期/;

/** 网络层特征（fetch 失败、超时、连接被拒） */
const NETWORK_RE = /超时|timeout|Failed to fetch|NetworkError|ERR_CONNECTION|Load failed|临时不可达/i;

/**
 * 把任意异常归类。
 * 判定优先级：编程错误 > 鉴权 > 服务端 5xx > 网络 > 兜底（按服务端错误处理）。
 */
export function classifyUiError(e: unknown): UiErrorInfo {
  const raw = e && (e as { message?: unknown }).message !== undefined
    ? String((e as { message?: unknown }).message)
    : String(e ?? '');
  const status = Number((e as { status?: unknown } | null)?.status) || 0;

  if (PROGRAM_RE.test(raw)) {
    return {
      kind: 'program',
      raw,
      icon: '🐞',
      title: '面板脚本错误（非网络问题）',
      hint: raw + ' —— 这是面板自身的问题，不是网络/网关故障；已停止自动重试，请把错误全文上报。',
      retriable: false,
    };
  }

  if (status === 401 || AUTH_RE.test(raw)) {
    return {
      kind: 'auth',
      raw,
      icon: '🔒',
      title: '登录状态失效',
      hint: raw + ' —— 请重新登录（会话 8 小时到期，或令牌已被轮换）。',
      retriable: true,
    };
  }

  if (status >= 500 || /\bHTTP 5\d\d\b/.test(raw)) {
    return {
      kind: 'server',
      raw,
      icon: '🛠',
      title: '网关内部错误',
      hint: raw + ' —— 网关侧异常（已记入服务端日志），稍后自动重试。',
      retriable: true,
    };
  }

  if (status === 0 || NETWORK_RE.test(raw)) {
    return {
      kind: 'network',
      raw,
      icon: '📡',
      title: '数据加载失败',
      hint: raw + ' —— 网络或网关可能临时不可达，稍后自动重试。',
      retriable: true,
    };
  }

  return {
    kind: 'server',
    raw,
    icon: '⚠',
    title: '数据加载失败',
    hint: raw + ' —— 未识别的失败（按服务端错误处理），稍后自动重试。',
    retriable: true,
  };
}

/** 是否为编程错误（自动重试开关用） */
export function isProgramError(e: unknown): boolean {
  return classifyUiError(e).kind === 'program';
}

/** 是否可重试（自动刷新降频/停用用） */
export function isRetriable(e: unknown): boolean {
  return classifyUiError(e).retriable;
}