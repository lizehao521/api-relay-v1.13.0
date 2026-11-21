/** 全部权限点（owner 的权限集 = 它） */
export const ALL_PERMISSIONS = [
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
];
/**
 * 内置角色矩阵。
 * - owner：全部。
 * - operator：业务读写（keys/providers/agent 写 + 各类读），但**不含** `tenants.admin` 与 `billing.write`
 *   （SOD：能管业务、不能改账户与账目）。
 * - viewer：只读（含 tenant/计费/审计的读，但无写）。
 */
export const DEFAULT_ROLE_MATRIX = {
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
const VALID_PERMISSIONS = new Set(ALL_PERMISSIONS);
/**
 * 角色权限策略。
 * 构造时把配置覆盖合并到默认矩阵上（只允许 operator/viewer 被覆盖；owner 始终全权）。
 */
export class RbacPolicy {
    matrix = new Map();
    constructor(cfg) {
        for (const role of ['operator', 'viewer']) {
            const override = cfg?.roles?.[role];
            const list = (override ?? DEFAULT_ROLE_MATRIX[role]).filter((p) => VALID_PERMISSIONS.has(p));
            this.matrix.set(role, new Set(list));
        }
        // owner 恒全权：即便配置里给了 owner，也忽略并强制为 ALL_PERMISSIONS（防自锁）。
        this.matrix.set('owner', new Set(ALL_PERMISSIONS));
    }
    /** 角色是否拥有某权限。未知角色一律 false（fail-closed 到权限层；鉴权层的 fail-open 不受影响）。 */
    allowed(role, permission) {
        return this.matrix.get(role)?.has(permission) ?? false;
    }
    /** 角色的权限清单（面板展示用） */
    permissionsFor(role) {
        return [...(this.matrix.get(role) ?? [])];
    }
    /**
     * 运行时更新角色权限（面板"角色与权限"页）。
     * owner 不可被修改（防自锁）；未知权限点被过滤，保证矩阵始终是合法子集。
     */
    setRole(role, permissions) {
        if (role === 'owner')
            return;
        const next = ALL_PERMISSIONS.filter((p) => permissions.includes(p));
        this.matrix.set(role, new Set(next));
    }
    /** 全部角色 → 权限清单快照（面板"角色与权限"页用） */
    snapshot() {
        const out = {};
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
export function requiredPermission(action, isWrite) {
    if (action === 'tenants' || action.startsWith('tenants/') || action === 'roles' || action.startsWith('roles/')) {
        return 'tenants.admin';
    }
    if (action.startsWith('providers'))
        return isWrite ? 'providers.write' : 'providers.read';
    if (action === 'keys' || action.startsWith('keys/'))
        return isWrite ? 'keys.write' : 'keys.read';
    if (action === 'agent' || action.startsWith('agent/'))
        return isWrite ? 'agent.write' : undefined;
    if (action === 'merchant' || action.startsWith('merchant/'))
        return isWrite ? 'merchant.write' : 'merchant.read';
    if (action === 'plans' || action.startsWith('plans/') ||
        action === 'bills' || action.startsWith('bills/') ||
        action === 'recon' || action.startsWith('recon/')) {
        return isWrite ? 'billing.write' : 'billing.read';
    }
    if (action === 'state' || action.startsWith('state/'))
        return isWrite ? 'providers.write' : 'providers.read';
    return undefined;
}
//# sourceMappingURL=rbac.js.map