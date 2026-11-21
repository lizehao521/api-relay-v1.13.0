/**
 * 管理面鉴权（AdminApi 拆分的第二层）。
 *
 * 从 AdminApi.authorize 抽出。它读 this.deps.config 与两个实例字段
 * （authRateLimits / lastAuthCleanup），按本轮确立的抽层判据属于
 * 「② 读 this.* 但只读一个明确依赖 → 抽成依赖注入的类」。
 *
 * 自持状态的好处：速率限制表与清理计时器跟着鉴权逻辑走，
 * 不再与 2300 行的业务 handler 混在一个类里——以后要调阈值/换存储
 * （比如多实例共享）只动这一个文件。
 *
 * 批次1 增补：会话携带 `role`（owner/operator/viewer）与可选 `tenantId`（绑定租户）。
 * - owner（adminToken / adminLogin / 本机体验模式）＝全权，语义与旧版一致（零回归）。
 * - viewer＝只读（沿用 readonly 布尔，仅 GET/HEAD）。
 * - operator＝业务读写、无租户管理与计费写（默认不启用，需 server.operatorLogin 显式配置）。
 * 授权结果里的 role/tenantId 供 AdminApi 的权限门与租户作用域使用。
 */

import type { IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AuthRole } from '../core/types.js';
import { timeSafeEqual } from '../util/index.js';

/**
 * 从 Authorization 头取令牌。
 * 与 gateway/keys.ts 的 extractBearer 语义**刻意不同**：那里无 Bearer 前缀时
 * 仅在「不含空格」时兜底，这里无条件回落 header.trim()——管理面历史上一直如此，
 * 改动会让某些客户端的鉴权方式静默失效，故原样搬来而不是「统一」。
 */
function extractBearerToken(header?: string): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]!.trim() : header.trim();
}

/** 连续失败上限：达到即锁定 */
const LOCK_THRESHOLD = 20;
/** 锁定时长 5 分钟 */
const LOCK_MS = 5 * 60 * 1000;
/** 速率限制表清理周期 10 分钟（Q001/F3/SEC-002/PERF-006：防内存泄漏） */
const CLEANUP_MS = 10 * 60 * 1000;
/**
 * 失败表硬上限（C-01 修复）。
 *
 * 管理面鉴权不要求已认证即可到达，分布式爆破会用大量不同源 IP 往这张表里塞条目。
 * 只靠 CLEANUP_MS 周期的清理不够（而且要跨越一个清理周期），所以再加一道结构上限：
 * 一旦超过就按插入顺序丢弃最旧的，保证内存占用有界。
 */
const MAX_TRACKED_IPS = 50_000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_SESSIONS = 10_000;


interface RateEntry {
  fails: number;
  lockedUntil: number;
}

export interface AuthResult {
  ok: boolean;
  reason?: string;
  /** 会话来自只读账号（评委）：仅允许 GET/HEAD，写操作一律拒绝 */
  readonly?: boolean;
  /** 会话角色（批次1）。owner＝全权；operator/viewer 受 RBAC 权限矩阵约束。 */
  role?: AuthRole;
  /** 会话绑定的租户（批次1）。非空 = 只能访问本租户数据；缺省 = 平台视角。 */
  tenantId?: string;
}

/** 面板登录账号（用户名 + 密码）。批次1 起可声明角色与绑定租户。 */
export interface LoginCredential {
  username?: string;
  password?: string;
  /** 角色：缺省时按账号类型推导（adminLogin→owner、viewerLogin→viewer、operatorLogin→operator） */
  role?: AuthRole;
  /** 绑定租户：非空 = 该账号只能看到本租户数据 */
  tenantId?: string;
}

/** 会话条目：过期时间 + 是否只读 + 角色/租户（批次1） */
interface SessionEntry {
  expiresAt: number;
  readonly: boolean;
  role: AuthRole;
  tenantId?: string;
}

/** 内部：解析后的登录账号三元组（用户名/密码/角色/租户） */
interface ResolvedCredential {
  username: string;
  password: string;
  role: AuthRole;
  tenantId?: string;
}

export class AdminAuth {
  /** 按 remote IP 跟踪失败次数（challenge#1·S1） */
  private readonly rateLimits = new Map<string, RateEntry>();
  private readonly sessions = new Map<string, SessionEntry>();
  private lastCleanup = 0;

  constructor(
    private readonly adminToken: string | undefined,
    private readonly opts: {
      adminLogin?: LoginCredential;
      viewerLogin?: LoginCredential;
      /** 批次1：业务运营账号（默认未启用） */
      operatorLogin?: LoginCredential;
    } = {},
  ) {}

  /**
   * 生效的管理账号（owner 全权）。
   *
   * **未显式配置 `server.adminLogin` 时一律不签发 owner 会话**（fail-closed）。
   * 早期版本在这里缺省回落 `admin/admin`，结果是：即便配了高强度的
   * `server.adminToken`，攻击者仍能用 `admin/admin` 走到 `login()` 拿到 8 小时
   * owner 会话，从而绕过令牌直接读写管理面。默认凭据属于"可预测凭据"，
   * 不能作为兜底；需要账号密码登录的场景必须显式配置用户名与密码。
   *
   * 与 viewer/operator 一致，要求用户名与密码**都**配置才启用，避免只配一半
   * 时出现"用户名固定但密码为空"的弱口令入口。
   */
  private adminCred(): ResolvedCredential | undefined {
    const u = this.opts.adminLogin?.username;
    const p = this.opts.adminLogin?.password;
    if (!u || !p) return undefined;
    return {
      username: u,
      password: p,
      role: 'owner',
      ...(this.opts.adminLogin?.tenantId ? { tenantId: this.opts.adminLogin.tenantId } : {}),
    };
  }

  /** 只读账号：仅当用户名与密码**都**配置时才启用（否则一律不签发只读会话） */
  private viewerCred(): ResolvedCredential | undefined {
    const u = this.opts.viewerLogin?.username;
    const p = this.opts.viewerLogin?.password;
    if (!u || !p) return undefined;
    return { username: u, password: p, role: 'viewer', ...(this.opts.viewerLogin?.tenantId ? { tenantId: this.opts.viewerLogin.tenantId } : {}) };
  }

  /** 运营账号：仅当用户名与密码**都**配置时才启用（缺省不启用，零回归） */
  private operatorCred(): ResolvedCredential | undefined {
    const u = this.opts.operatorLogin?.username;
    const p = this.opts.operatorLogin?.password;
    if (!u || !p) return undefined;
    return { username: u, password: p, role: 'operator', ...(this.opts.operatorLogin?.tenantId ? { tenantId: this.opts.operatorLogin.tenantId } : {}) };
  }

  login(req: IncomingMessage, username: string, password: string): AuthResult & { token?: string } {
    const remote = req.socket.remoteAddress ?? '';
    const now = Date.now();
    this.cleanup(now);
    const rl = this.rateLimits.get(remote);
    if (rl && rl.lockedUntil > now) {
      return { ok: false, reason: '登录失败次数过多，请稍后重试' };
    }

    const admin = this.adminCred();
    const viewer = this.viewerCred();
    const operator = this.operatorCred();
    // 判定顺序：admin（owner）→ operator → viewer。
    // 相邻角色若同名同密码，按更**高**权限处理（不因多配了低权账号而降权）。
    const matched =
      (admin && timeSafeEqual(username, admin.username) && timeSafeEqual(password, admin.password) ? admin : undefined)
      ?? (operator && timeSafeEqual(username, operator.username) && timeSafeEqual(password, operator.password) ? operator : undefined)
      ?? (viewer && timeSafeEqual(username, viewer.username) && timeSafeEqual(password, viewer.password) ? viewer : undefined);
    if (!matched) {
      return this.reject(remote, now, rl);
    }

    this.rateLimits.delete(remote);
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, {
      expiresAt: now + SESSION_TTL_MS,
      readonly: matched.role === 'viewer',
      role: matched.role,
      ...(matched.tenantId ? { tenantId: matched.tenantId } : {}),
    });
    if (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest) this.sessions.delete(oldest);
    }
    return {
      ok: true,
      token,
      readonly: matched.role === 'viewer',
      role: matched.role,
      ...(matched.tenantId ? { tenantId: matched.tenantId } : {}),
    };
  }

  /**
   * 校验管理令牌。
   * - 接受本类签发的短期会话令牌，以及兼容原有 adminToken
   * - 支持 X-Admin-Token 头与 Authorization: Bearer 两种携带方式
   * - 连续失败 20 次锁定 5 分钟；第 5 次起在消息里带退避提示
   */
  authorize(req: IncomingMessage, headers: Record<string, string>): AuthResult {
    const remote = req.socket.remoteAddress ?? '';
    const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    // 本机体验模式：无 adminToken 时直连＝owner（与旧版一致，零回归）
    if (!this.adminToken && isLocal) return { ok: true, role: 'owner' };
    const now = Date.now();
    this.cleanup(now);

    // 锁定期间直接拒绝
    const rl = this.rateLimits.get(remote);
    if (rl && rl.lockedUntil > now) {
      return { ok: false, reason: '管理令牌无效（已锁定，请稍后重试）' };
    }

    const provided = headers['x-admin-token'] ?? extractBearerToken(headers['authorization']);
    const session = provided ? this.sessions.get(provided) : undefined;
    if (provided && session && session.expiresAt > now) {
      this.rateLimits.delete(remote);
      return { ok: true, readonly: session.readonly, role: session.role, ...(session.tenantId ? { tenantId: session.tenantId } : {}) };
    }
    if (provided && this.adminToken && timeSafeEqual(provided, this.adminToken)) {
      if (rl && rl.fails > 0) this.rateLimits.set(remote, { fails: 0, lockedUntil: 0 });
      // adminToken 为全权令牌：按 owner 处理（保持既有"全权"语义）
      return { ok: true, role: 'owner' };
    }

    return this.reject(remote, now, rl);
  }

  private cleanup(now: number): void {
    if (now - this.lastCleanup > CLEANUP_MS) {
      this.lastCleanup = now;
      for (const [ip, rl] of this.rateLimits) {
        if (rl.lockedUntil < now) this.rateLimits.delete(ip);
      }
    }
    for (const [token, s] of this.sessions) {
      if (s.expiresAt <= now) this.sessions.delete(token);
    }
  }

  private reject(remote: string, now: number, previous?: RateEntry): AuthResult {
    const rl = previous ?? this.rateLimits.get(remote);
    const fails = (rl?.fails ?? 0) + 1;
    const lockedUntil = fails >= LOCK_THRESHOLD ? now + LOCK_MS : 0;
    this.rateLimits.set(remote, { fails, lockedUntil });
    // C-01 修复：硬上限兜底（清理周期未到时也不能无界增长）。放在**写入之后**，
    // 保证任何一次调用返回时表尺寸都不超过上限（放前面会停在 MAX+1 抖）。
    if (this.rateLimits.size > MAX_TRACKED_IPS) {
      let drop = this.rateLimits.size - MAX_TRACKED_IPS;
      for (const ip of this.rateLimits.keys()) {
        this.rateLimits.delete(ip);
        if (--drop <= 0) break;
      }
    }
    // SEC-003/SEC-004：不泄露具体锁定时长和内部头名
    const backoff = fails >= 5 ? `（第 ${fails} 次失败${fails >= LOCK_THRESHOLD ? '，已锁定' : ''}）` : '';
    return { ok: false, reason: `账号或密码错误${backoff}` };
  }
}