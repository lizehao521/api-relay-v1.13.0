/**
 * RBAC（角色 → 权限）与租户作用域（批次1 · 多租户/RBAC）。
 *
 * 设计原则：
 * - **owner 恒为全权**：配置不可削减 owner 的权限，避免运营把自己锁在门外（自锁）。
 * - **默认矩阵 = 零回归**：既有部署只有 admin（owner）与 viewer 两种会话，operator 默认不启用；
 *   新增权限门对 owner 全通过、对 viewer 与既有 readonly 语义叠加（更严，不会放宽）。
 * - **权限判定集中**：`requiredPermission(action, isWrite)` 是唯一映射表，可单测，
 *   避免"权限判断散落在各 handler 里"的漂移。
 * - **职责分离（SOD）**：`billing.write` 与 `keys.write` 默认不共授予同一角色（operator 无计费写）。
 */
import type { AuthRole, Permission, RbacConfig } from '../core/types.js';

/** 全部权限点（owner 的权限集 = 它） */
export const ALL_PERMISSIONS: readonly Permission[] = [
  'keys.read',
  'keys.write',
  'providers.read',
  'providers.write',
  'billing.read',
  'billing.write',
  'tenants.admin',
  'audit.read',
  'agent.write',
  'merchant.read',
  'merchant.write',
] as const;

/**
 * 内置角色矩阵。
 * - owner：全部。
 * - operator：业务读写（keys/providers/agent 写 + 各类读），但**不含** `tenants.admin` 与 `billing.write`
 *   （SOD：能管业务、不能改账户与账目）。
 * - viewer：只读（含 tenant/计费/审计的读，但无写）。
 */
export const DEFAULT_ROLE_MATRIX: Record<AuthRole, readonly Permission[]> = {
  owner: ALL_PERMISSIONS,
  operator: [
    'keys.read',
    'keys.write',
    'providers.read',
    'providers.write',
    'billing.read',
    'audit.read',
    'agent.write',
    'merchant.read',
    'merchant.write',
  ],
  viewer: ['keys.read', 'providers.read', 'billing.read', 'audit.read', 'merchant.read'],
};

const VALID_PERMISSIONS = new Set<string>(ALL_PERMISSIONS);

/**
 * 角色权限策略。
 * 构造时把配置覆盖合并到默认矩阵上（只允许 operator/viewer 被覆盖；owner 始终全权）。
 */
export class RbacPolicy {
  private readonly matrix: Map<string, Set<Permission>> = new Map();

  constructor(cfg?: RbacConfig) {
    for (const role of ['operator', 'viewer'] as const) {
      const override = cfg?.roles?.[role];
      const list = (override ?? DEFAULT_ROLE_MATRIX[role]).filter((p) => VALID_PERMISSIONS.has(p));
      this.matrix.set(role, new Set(list));
    }
    // owner 恒全权：即便配置里给了 owner，也忽略并强制为 ALL_PERMISSIONS（防自锁）。
    this.matrix.set('owner', new Set(ALL_PERMISSIONS));
  }

  /** 角色是否拥有某权限。未知角色一律 false（fail-closed 到权限层；鉴权层的 fail-open 不受影响）。 */
  allowed(role: string, permission: Permission): boolean {
    return this.matrix.get(role)?.has(permission) ?? false;
  }

  /** 角色的权限清单（面板展示用） */
  permissionsFor(role: string): Permission[] {
    return [...(this.matrix.get(role) ?? [])];
  }

  /**
   * 运行时更新角色权限（面板"角色与权限"页）。
   * owner 不可被修改（防自锁）；未知权限点被过滤，保证矩阵始终是合法子集。
   */
  setRole(role: string, permissions: Permission[]): void {
    if (role === 'owner') return;
    const next = ALL_PERMISSIONS.filter((p) => permissions.includes(p));
    this.matrix.set(role, new Set(next));
  }

  /** 全部角色 → 权限清单快照（面板"角色与权限"页用） */
  snapshot(): Record<string, Permission[]> {
    const out: Record<string, Permission[]> = {};
    for (const [role, set] of this.matrix) {
      // 按 ALL_PERMISSIONS 顺序输出，保证面板列顺序稳定（与矩阵表列头一致）
      out[role] = ALL_PERMISSIONS.filter((p) => set.has(p));
    }
    return out;
  }
}

/**
 * 把 `METHOD action` 映射到所需权限点。返回 `undefined` = 无需额外权限（普通读端点）。
 *
 * 说明：这里只覆盖**有权限语义**的端点。health/overview/series/metrics/events 等
 * 运营读端点沿用既有只读保护（owner 全通过、viewer 允许读），不在此处加门——保持零回归。
 */
export function requiredPermission(action: string, isWrite: boolean): Permission | undefined {
  if (action === 'tenants' || action.startsWith('tenants/') || action === 'roles' || action.startsWith('roles/')) {
    return 'tenants.admin';
  }
  if (action.startsWith('providers')) return isWrite ? 'providers.write' : 'providers.read';
  if (action === 'keys' || action.startsWith('keys/')) return isWrite ? 'keys.write' : 'keys.read';
  if (action === 'agent' || action.startsWith('agent/')) return isWrite ? 'agent.write' : undefined;
  if (action === 'merchant' || action.startsWith('merchant/')) return isWrite ? 'merchant.write' : 'merchant.read';
  if (
    action === 'plans' || action.startsWith('plans/') ||
    action === 'bills' || action.startsWith('bills/') ||
    action === 'recon' || action.startsWith('recon/')
  ) {
    return isWrite ? 'billing.write' : 'billing.read';
  }
  if (action === 'state' || action.startsWith('state/')) return isWrite ? 'providers.write' : 'providers.read';
  return undefined;
}