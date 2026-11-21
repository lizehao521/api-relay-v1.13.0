/**
 * 多租户 / RBAC 管理面（批次1）。
 *
 * 三件事：
 *  1. `TenantHandlers` —— 租户元数据（TenantMeta）与 RBAC 角色的读写；写操作一律落审计事件。
 *  2. `filterByTenant` —— **客户面租户谓词的唯一入口**（MOD-T3）。所有按租户过滤的查询都经它，
 *     避免"各处手写 tenantId 过滤"造成漏加谓词的越权风险（一次漏加=跨租户泄漏）。
 *  3. 越权一律 403 `access_denied`，且响应体**不含目标租户信息**（防存在性泄漏，AC4-T01）。
 *
 * 边界（不做）：不做物理隔离（不引入独立进程/独立库）；不触碰数据面与成功响应路径。
 */
import type { ServerResponse } from 'node:http';
import type { Permission, RelayConfig, TenantMeta } from '../../core/types.js';
import type { Store } from '../../store/index.js';
import type { RbacPolicy } from '../rbac.js';
import { ALL_PERMISSIONS } from '../rbac.js';
import { json, badRequest } from '../response.js';

/** 隐式租户：存量 Key 的缺省归属（ADR-029） */
export const DEFAULT_TENANT_ID = 'default';
/** 租户 ID 格式：与 gateway/keys.ts 的 tenantId 校验同口径，防注入 */
const TENANT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** 取行归属租户（缺省归 default，等价于 ADR-029） */
export function tenantOf(row: { tenantId?: string }): string {
  const t = row.tenantId;
  return t && t.length > 0 ? t : DEFAULT_TENANT_ID;
}

/**
 * 按租户过滤（客户面租户谓词）。`tenantId` 为 null/undefined 表示"平台视角"（全量）。
 * 这是唯一过滤入口，调用方不得自行手写 `row.tenantId === x`。
 */
export function filterByTenant<T extends { tenantId?: string }>(rows: T[], tenantId?: string | null): T[] {
  if (!tenantId) return rows;
  return rows.filter((r) => tenantOf(r) === tenantId);
}

export interface TenantScope {
  /** 生效的过滤租户；undefined = 平台视角（全量） */
  tenantId?: string;
  /** true = 请求的租户与会话绑定租户不一致 → 应返回 403 */
  forbidden: boolean;
}

/**
 * 解析生效的租户作用域。
 * - 会话绑定租户（boundTenant 非空）：只能访问本租户；请求别的租户 → forbidden。
 * - 平台视角（boundTenant 空）：`?tenantId=` 指定则按该租户看，否则全量。
 */
export function resolveTenantScope(boundTenant: string | undefined, requested: string | null): TenantScope {
  if (boundTenant) {
    if (requested && requested !== boundTenant) return { forbidden: true };
    return { forbidden: false, tenantId: boundTenant };
  }
  return requested ? { forbidden: false, tenantId: requested } : { forbidden: false };
}

/**
 * 越权统一响应：403 `access_denied`，且响应体**不含目标租户信息**（防存在性泄漏，AC4-T01/CWE-200）。
 */
export function tenantForbidden(res: ServerResponse): boolean {
  return json(res, 403, {
    error: { message: '越权访问：只能访问所属租户的数据', type: 'access_denied', code: 'access_denied' },
  });
}

export interface TenantHandlersDeps {
  config: RelayConfig;
  store: Store;
  rbac: RbacPolicy;
}

export class TenantHandlers {
  /** 运行时租户表：以隐式 default + 配置声明的租户初始化；支持运行时增改（审计留痕） */
  private readonly tenants = new Map<string, TenantMeta>();

  constructor(private readonly deps: TenantHandlersDeps) {
    this.tenants.set(DEFAULT_TENANT_ID, {
      id: DEFAULT_TENANT_ID,
      name: '默认租户',
      status: 'active',
      quotaCapCny: null,
    });
    for (const t of deps.config.tenants ?? []) {
      if (!t || typeof t.id !== 'string' || !TENANT_ID_RE.test(t.id)) continue;
      this.tenants.set(t.id, {
        id: t.id,
        name: typeof t.name === 'string' && t.name ? t.name : t.id,
        status: t.status === 'disabled' ? 'disabled' : 'active',
        ...(t.tier !== undefined ? { tier: t.tier } : {}),
        ...(t.quotaCapCny !== undefined ? { quotaCapCny: t.quotaCapCny } : {}),
        ...(t.createdAt !== undefined ? { createdAt: t.createdAt } : {}),
      });
    }
    // 批次3：优先恢复持久化文档（运行时增改的租户 / 角色矩阵跨重启保留）。
    // 失败 fail-open：loadControlDoc 内部已吞异常并回落 undefined。
    const persisted = deps.store.loadControlDoc('tenants');
    if (Array.isArray(persisted)) {
      for (const t of persisted as TenantMeta[]) {
        if (!t || typeof t.id !== 'string' || !TENANT_ID_RE.test(t.id)) continue;
        this.tenants.set(t.id, {
          id: t.id,
          name: typeof t.name === 'string' && t.name ? t.name : t.id,
          status: t.status === 'disabled' ? 'disabled' : 'active',
          ...(t.tier !== undefined ? { tier: t.tier } : {}),
          ...(t.quotaCapCny !== undefined ? { quotaCapCny: t.quotaCapCny } : {}),
          ...(t.createdAt !== undefined ? { createdAt: t.createdAt } : {}),
        });
      }
    }
    const persistedRoles = deps.store.loadControlDoc('rbac_roles');
    if (persistedRoles && typeof persistedRoles === 'object') {
      for (const [role, perms] of Object.entries(persistedRoles as Record<string, unknown>)) {
        if (Array.isArray(perms)) deps.rbac.setRole(role, perms as Permission[]);
      }
    }
  }

  /** 全部租户（按 id 排序，default 优先展示） */
  list(): TenantMeta[] {
    return [...this.tenants.values()].sort(
      (a, b) => (a.id === DEFAULT_TENANT_ID ? -1 : b.id === DEFAULT_TENANT_ID ? 1 : a.id.localeCompare(b.id)),
    );
  }

  find(id: string): TenantMeta | undefined {
    return this.tenants.get(id);
  }

  /** 创建租户。重复 id → 409；格式非法 → 400。 */
  create(res: ServerResponse, body: Record<string, unknown> | undefined, actor?: string): boolean {
    const id = typeof body?.['id'] === 'string' ? (body['id'] as string).trim() : '';
    if (!TENANT_ID_RE.test(id)) {
      return badRequest(res, 'tenantId 只允许字母数字下划线连字符，≤64 字');
    }
    if (this.tenants.has(id)) {
      return json(res, 409, { error: { message: `租户已存在: ${id}`, type: 'conflict_error', code: 'tenant_exists' } });
    }
    const name = typeof body?.['name'] === 'string' && (body['name'] as string).trim()
      ? (body['name'] as string).trim()
      : id;
    const meta: TenantMeta = {
      id,
      name,
      status: 'active',
      quotaCapCny: quotaCapFrom(body),
      createdAt: Date.now(),
    };
    this.tenants.set(id, meta);
    this.deps.store.logEvent('info', 'tenants.create', { tenantId: id, name, actor: actor ?? 'panel' });
    this.persist();
    return json(res, 200, { ok: true, tenant: meta });
  }

  /** 更新租户（名称 / 状态 / 额度帽）。不存在 → 404。 */
  update(res: ServerResponse, body: Record<string, unknown> | undefined, actor?: string): boolean {
    const id = typeof body?.['id'] === 'string' ? (body['id'] as string).trim() : '';
    const cur = this.tenants.get(id);
    if (!cur) {
      return json(res, 404, { error: { message: `租户不存在: ${id}`, type: 'not_found_error', code: 'tenant_not_found' } });
    }
    if (id === DEFAULT_TENANT_ID && body?.['status'] === 'disabled') {
      return badRequest(res, 'default 租户不可停用（存量 Key 的兜底归属）');
    }
    const next: TenantMeta = {
      ...cur,
      ...(typeof body?.['name'] === 'string' && (body['name'] as string).trim() ? { name: (body['name'] as string).trim() } : {}),
      ...(body?.['status'] === 'active' || body?.['status'] === 'disabled' ? { status: body['status'] } : {}),
      ...(Object.prototype.hasOwnProperty.call(body ?? {}, 'quotaCapCny') ? { quotaCapCny: quotaCapFrom(body) } : {}),
    };
    this.tenants.set(id, next);
    this.deps.store.logEvent('info', 'tenants.update', { tenantId: id, changed: Object.keys(body ?? {}), actor: actor ?? 'panel' });
    this.persist();
    return json(res, 200, { ok: true, tenant: next });
  }

  /** 批次3：把租户表落盘（整文档；fail-open） */
  private persist(): void {
    this.deps.store.saveControlDoc('tenants', [...this.tenants.values()]);
  }

  /** 角色 → 权限矩阵（面板"角色与权限"页） */
  rolesView(): { roles: Record<string, Permission[]>; allPermissions: Readonly<Permission[]> } {
    return { roles: this.deps.rbac.snapshot(), allPermissions: ALL_PERMISSIONS };
  }

  /** 更新角色权限（owner 不可改；未授予的写操作由 AdminApi 的权限门把关）。 */
  rolesUpdate(res: ServerResponse, body: Record<string, unknown> | undefined, actor?: string): boolean {
    const role = typeof body?.['role'] === 'string' ? (body['role'] as string) : '';
    if (!role) return badRequest(res, '缺少 role');
    if (role === 'owner') return badRequest(res, 'owner 为内置全权角色，不可修改');
    const perms = Array.isArray(body?.['permissions']) ? (body['permissions'] as unknown[]).filter((p): p is Permission => typeof p === 'string') : undefined;
    if (!perms) return badRequest(res, 'permissions 必须为字符串数组');
    this.deps.rbac.setRole(role, perms);
    this.deps.store.logEvent('warn', 'rbac.role.update', { role, permissions: perms, actor: actor ?? 'panel' });
    this.deps.store.saveControlDoc('rbac_roles', this.deps.rbac.snapshot());
    return json(res, 200, { ok: true, roles: this.deps.rbac.snapshot() });
  }
}

/** 从请求体解析额度帽：数字→值；null/''→null（不限）；非法→null */
function quotaCapFrom(body: Record<string, unknown> | undefined): number | null {
  const raw = body?.['quotaCapCny'];
  if (raw === null || raw === '' || raw === undefined) return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}