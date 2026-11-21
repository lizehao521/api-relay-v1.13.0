import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { esc } from "../ui";

/**
 * 租户与角色（批次1 · 多租户/RBAC）。
 *
 * 只做两件事：① 租户总览（列表 + 新建）；② RBAC 角色-权限矩阵（只读展示）。
 * 数据来自 `/admin/api/tenants` 与 `/admin/api/roles`。
 * 风格与既有视图一致：零 CDN、内联 Preact、class 复用全局样式。
 */

interface TenantMeta {
  id: string;
  name: string;
  status: string;
  tier?: string;
  quotaCapCny?: number | null;
}

/** 权限点顺序（与后端 ALL_PERMISSIONS 一致，保证列顺序稳定） */
const ALL_PERMS = [
  "keys.read",
  "keys.write",
  "providers.read",
  "providers.write",
  "billing.read",
  "billing.write",
  "tenants.admin",
  "audit.read",
  "agent.write",
];

const ROLE_LABEL: Record<string, string> = {
  owner: "owner（全权）",
  operator: "operator（业务读写）",
  viewer: "viewer（只读）",
};

export function Tenants() {
  const [tenants, setTenants] = useState<TenantMeta[] | null>(null);
  const [roles, setRoles] = useState<Record<string, string[]> | null>(null);
  const [fail, setFail] = useState("");
  const [msg, setMsg] = useState("");
  const [newId, setNewId] = useState("");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      setFail("");
      try {
        const [t, r] = await Promise.all([
          api<{ tenants: TenantMeta[] }>("tenants"),
          api<{ roles: Record<string, string[]> }>("roles"),
        ]);
        if (alive) {
          setTenants(t.tenants || []);
          setRoles(r.roles || {});
        }
      } catch (e: any) {
        // 取数失败不静默（与 Trust 页同款）：不把失败伪装成空态
        if (alive) {
          setFail(e && e.message ? e.message : "网络错误");
          setTenants([]);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [tick]);

  const create = async () => {
    if (busy) return;
    const id = newId.trim();
    if (!id) {
      setMsg("请填写租户 ID");
      return;
    }
    setBusy(true);
    setMsg("");
    try {
      await api("tenants/create", {
        method: "POST",
        body: JSON.stringify({ id, name: newName.trim() || id }),
      });
      setNewId("");
      setNewName("");
      setMsg("租户已创建：" + id);
      setTick((x) => x + 1);
    } catch (e: any) {
      setMsg(e && e.message ? e.message : "创建失败");
    } finally {
      setBusy(false);
    }
  };

  const rolesOrder = ["owner", "operator", "viewer"];

  return (
    <div>
      <div class="note">
        <b>租户与角色（批次1）。</b>
        租户是多租户强隔离的实体；<span class="mono">tenantId</span> 此前只是 Key 上的一个字符串，
        现在提升为一等公民。RBAC 矩阵决定每个角色能访问哪些管理端点（写操作在 <span class="mono">handle()</span>{" "}
        的权限门单点判定）。
      </div>

      {fail ? (
        <div class="note warn" style="margin:0 0 var(--s3)">
          <b>取数失败：</b>
          {esc(fail)}
          ——下方表格是空占位，不是真实数据。稍后点右上角 ↻ 重试。
        </div>
      ) : null}
      {msg ? (
        <div class="note" style="margin:0 0 var(--s3)">
          {esc(msg)}
        </div>
      ) : null}

      <section class="block">
        <h2>
          租户 <span class="spacer" />{" "}
          <button class="bare" onClick={() => setTick((t) => t + 1)} title="刷新">
            ↻
          </button>
        </h2>
        <table>
          <thead>
            <tr>
              <th>租户 ID</th>
              <th>名称</th>
              <th>状态</th>
              <th>额度帽(¥)</th>
            </tr>
          </thead>
          <tbody>
            {tenants && tenants.length ? (
              tenants.map((t) => (
                <tr key={t.id}>
                  <td class="mono">{esc(t.id)}</td>
                  <td>{esc(t.name)}</td>
                  <td>
                    {t.status === "active" ? (
                      <span class="chip g">启用</span>
                    ) : (
                      <span class="chip">停用</span>
                    )}
                  </td>
                  <td class="mono">{t.quotaCapCny == null ? "不限" : t.quotaCapCny}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colspan={4} class="dim">
                  {fail ? "取数失败，未加载" : "暂无租户（至少应有一个 default）"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div style="margin-top:var(--s3);display:flex;gap:var(--s2);align-items:center;flex-wrap:wrap">
          <input
            type="text"
            placeholder="租户 ID（字母数字_-，≤64）"
            value={newId}
            onInput={(e) => setNewId((e.target as HTMLInputElement).value)}
          />
          <input
            type="text"
            placeholder="名称（可空）"
            value={newName}
            onInput={(e) => setNewName((e.target as HTMLInputElement).value)}
          />
          <button class="pri" disabled={busy} onClick={create}>
            {busy ? "创建中…" : "新建租户"}
          </button>
        </div>
        <div class="muted-xs stack-sm">
          新增/停用/改额度帽等写操作需要 <span class="mono">tenants.admin</span> 权限（owner 默认持有）。
          <span class="mono">default</span> 租户是存量 Key 的兜底归属，不可停用。
        </div>
      </section>

      <section class="block">
        <h2>角色与权限</h2>
        <div class="note" style="margin:0 0 var(--s3)">
          <b>owner 恒为全权、不可修改</b>（防运营把自己锁在门外）。
          operator 可管业务但<b>不含</b> <span class="mono">tenants.admin</span> /{" "}
          <span class="mono">billing.write</span>（职责分离）；viewer 只读。
        </div>
        <table>
          <thead>
            <tr>
              <th>角色</th>
              {ALL_PERMS.map((p) => (
                <th key={p} class="mono">
                  {p}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {roles
              ? rolesOrder.map((r) => {
                  const set = roles[r] || [];
                  return (
                    <tr key={r}>
                      <td>{ROLE_LABEL[r] || r}</td>
                      {ALL_PERMS.map((p) => (
                        <td key={p} class="mono">
                          {set.indexOf(p) >= 0 ? "✓" : "—"}
                        </td>
                      ))}
                    </tr>
                  );
                })
              : (
                  <tr>
                    <td colspan={ALL_PERMS.length + 1} class="dim">
                      未加载
                    </td>
                  </tr>
                )}
          </tbody>
        </table>
        <div class="muted-xs stack-sm">
          改动矩阵走 <span class="mono">POST /admin/api/roles/update</span>（需 owner）；改动进审计事件{" "}
          <span class="mono">rbac.role.update</span>。
        </div>
      </section>
    </div>
  );
}