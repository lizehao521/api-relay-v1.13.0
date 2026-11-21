import { render } from "preact";
import type { ComponentType } from "preact";
import { useEffect, useState } from "preact/hooks";
import { useSignal } from "@preact/signals";
import "./styles.css";
import { api, unauthorized, setToken, getToken } from "./api";
import { TABS, NAV_GROUPS, view, navOpen, windowValue, autoRefresh, refreshIntervalValue, versionValue, lastFresh, goto, setWindow, theme, toggleTheme } from "./state";
import { ToastHost, toast } from "./ui";
import { escAction } from "./ui-logic";
import { DrawerHost, closeDrawer, drawerOpen } from "./drawer";
import { Overview } from "./views/Overview";
import { Metrics } from "./views/Metrics";
import { Keys } from "./views/Keys";
import { Providers } from "./views/Providers";
import { Kb } from "./views/Kb";
import { Agent } from "./views/Agent";
import { AgentMatrix } from "./views/AgentMatrix";
import { AgentChat } from "./views/AgentChat";
import { Ledger } from "./views/Ledger";
import { Diag } from "./views/Diag";
import { Ops } from "./views/Ops";
import { Trust } from "./views/Trust";
import { Tenants } from "./views/Tenants";
import { Billing } from "./views/Billing";

/* ---------------- 全局前端错误采集（P2-2） ----------------
 * 背景：2026-10-23 的 TDZ 事故只在组件内 `catch` 被接住 —— 没有 window.onerror、
 * 也没有任何地方能拿到完整堆栈，定位只能靠逆向压缩产物里的两字符变量名。
 * 这里把「未捕获错误」与「未处理的 Promise 拒绝」收进环形缓冲，
 * 并挂到 window.__relayUiErrors，便于现场排查与自动化断言（smoke 测试可读）。
 */
export interface UiErrorRecord {
  ts: number;
  msg: string;
  stack?: string;
  source?: string;
}
const UI_ERROR_RING: UiErrorRecord[] = [];

/** 读取最近的前端错误（最多 50 条，最新在末尾） */
export function recentUiErrors(): UiErrorRecord[] {
  return UI_ERROR_RING.slice();
}

function recordUiError(msg: string, stack?: string, source?: string): void {
  UI_ERROR_RING.push({
    ts: Date.now(),
    msg: msg.slice(0, 500),
    stack: stack ? stack.slice(0, 2000) : undefined,
    source,
  });
  if (UI_ERROR_RING.length > 50) UI_ERROR_RING.shift();
  try {
    (window as unknown as Record<string, unknown>)["__relayUiErrors"] = UI_ERROR_RING;
  } catch {
    /* 忽略：极端环境下 window 不可写 */
  }
  // 同时打控制台：CI / puppeteer 可直接捕获，不依赖面板 UI
  console.error("[ui-error]", msg, stack || "");
}

if (typeof window !== "undefined") {
  window.addEventListener("error", (e) => {
    const ev = e as ErrorEvent;
    recordUiError(String(ev.message || ev.error || "error"), ev.error && ev.error.stack, ev.filename);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = (e as PromiseRejectionEvent).reason as { message?: string; stack?: string } | undefined;
    recordUiError("unhandledrejection: " + String((reason && reason.message) || reason), reason && reason.stack);
  });
}

/* ---------------- 登录门 ---------------- */

function Login(props: { onLogin: () => void }) {
  const username = useSignal("");
  const password = useSignal("");
  const lerr = useSignal("");
  const lver = useSignal("");
  const busy = useSignal(false);
  // A5（审查修复）：panel-info 的"体验模式"标记（未配置 adminToken 时本机直连可直接用）
  const panel = useSignal<{ tokenNotRequired?: boolean } | null>(null);

  useEffect(() => {
    fetch("/healthz").then((h) => h.json()).then((d) => {
      if (d && d.version) lver.value = "网关版本 v" + d.version;
    }).catch(() => { /* 取不到就不显示 */ });
    // A5（审查修复）：读 panel-info 识别"体验模式"（未配置 adminToken，本机直连可直接用）。
    fetch("/admin/api/panel-info").then((h) => h.json()).then((d) => {
      if (d && typeof d.tokenNotRequired === "boolean") panel.value = d;
    }).catch(() => { /* 取不到就按"需要登录"处理 */ });
  }, []);

  const doLogin = async () => {
    if (busy.value) return;
    busy.value = true;
    lerr.value = "";
    try {
      const result = await api<{ token: string }>("login", {
        method: "POST",
        body: JSON.stringify({ username: username.value.trim(), password: password.value }),
      });
      setToken(result.token);
      await api("overview?window=5m");
      props.onLogin();
    } catch (e: any) {
      setToken("");
      lerr.value = e && e.status === 401 ? (e.message || "账号或密码错误") : "无法连接管理接口：" + (e && e.message ? e.message : e);
    } finally {
      busy.value = false;
    }
  };

  return (
    <div id="login" class={getToken() ? "" : ""}>
      <div class="box">
        <h1>⚡ api-relay <em>管理面板</em></h1>
        <p>请输入管理员账号和密码</p>
        <input type="text" placeholder="账号" autocomplete="username"
          value={username.value} onInput={(e) => (username.value = (e.target as HTMLInputElement).value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); doLogin(); } }} />
        <input type="password" placeholder="密码" autocomplete="current-password"
          value={password.value} onInput={(e) => (password.value = (e.target as HTMLInputElement).value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); doLogin(); } }} />
        <button class="pri" disabled={busy.value} onClick={doLogin}>{busy.value ? "登录中…" : "登录"}</button>
        <div id="lerr">{lerr.value}</div>
        {panel.value && panel.value.tokenNotRequired ? (
          <div class="note" style="margin-top:var(--s3)">
            <b>体验模式：</b>当前网关未配置 adminToken，本机直连可直接使用（远程访问将被拒）。
            <div style="margin-top:6px">
              <button class="pri" onClick={() => props.onLogin()}>直接进入面板（无需登录）</button>
            </div>
          </div>
        ) : null}
        <div class="dim" style="font-size:var(--fs-xs);margin-top:var(--s3)">{lver.value}</div>
      </div>
    </div>
  );
}

/* ---------------- 壳层布局：顶栏（全局状态） + 侧栏（分组导航） + 主内容 ---------------- */

function TopBar(props: { onRefresh: () => void; onLogout: () => void }) {
  const clock = useSignal(new Date().toLocaleTimeString("zh-CN"));
  useEffect(() => {
    const iv = setInterval(() => { clock.value = new Date().toLocaleTimeString("zh-CN"); }, 1000);
    return () => clearInterval(iv);
  }, []);

  const fresh = lastFresh.value;
  const freshAge = fresh ? Date.now() - fresh : null;
  const freshTxt = fresh
    ? "数据 " + new Date(fresh).toLocaleTimeString("zh-CN") + "（" + freshAgeText(freshAge || 0) + "）"
    : "—";
  const freshColor = freshAge != null && freshAge > 60000 ? "var(--err)" : "";

  return (
    <header id="topbar">
      <button id="nav-toggle" class="bare" title="导航" aria-label="打开导航"
        onClick={() => { navOpen.value = !navOpen.value; }}>☰</button>
      <span class="logo">⚡ api-relay <em>管理面板</em></span>
      <span class="spacer" />
      <span class="sub ver" title="网关版本">{versionValue.value ? "v" + versionValue.value : "—"}</span>
      <span class="sub clk" title="当前时间">{clock.value}</span>
      <span class="sub fresh" title="最后一次成功加载数据的时间；超过 60 秒未更新会变红" style={freshColor ? "color:" + freshColor : ""}>{freshTxt}</span>
      <button class="bare" title="切换暗/亮主题" aria-label={theme.value === "dark" ? "切换到亮色主题" : "切换到暗色主题"}
        onClick={toggleTheme}>{theme.value === "dark" ? "☀" : "☾"}</button>
      <button class="bare" title="刷新" aria-label="手动刷新" onClick={props.onRefresh}>↻</button>
      <button class="bare" onClick={props.onLogout}>退出</button>
    </header>
  );
}

/* 页签图标（纯文本符号，零依赖；语义装饰，aria-hidden） */
const NAV_ICONS: Record<string, string> = {
  ov: "◈", met: "◫", ledger: "▤", diag: "◎",
  users: "🔑", ch: "⇄", kb: "▣", agent: "✦", "agent-matrix": "⊞",
  ops: "⚙", trust: "⛨", tenants: "▦", billing: "¥",
};

function SideNav() {
  return (
    <aside id="sidenav" class={navOpen.value ? "on" : ""}>
      <nav>
        {NAV_GROUPS.map((g) => (
          <div class="nav-group" key={g.label}>
            <div class="nav-glabel">{g.label}</div>
            {g.items.map(([id, label]) => (
              <button key={id} class={view.value === id ? "on" : ""} onClick={() => goto(id)}>
                <span class="nv-ic" aria-hidden="true">{NAV_ICONS[id] || "·"}</span>{label}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div class="nav-foot">
        <label class="sub">
          窗口
          <select value={windowValue.value} onChange={(e) => { setWindow((e.target as HTMLSelectElement).value); }}>
            <option value="5m">5 分钟</option><option value="1h">1 小时</option>
            <option value="24h">24 小时</option><option value="7d">7 天</option><option value="30d">30 天</option>
          </select>
        </label>
        <label class="sub"><input type="checkbox" checked={autoRefresh.value} onChange={(e) => (autoRefresh.value = (e.target as HTMLInputElement).checked)} /> 自动刷新</label>
        <label class="sub">
          刷新间隔
          <select value={String(refreshIntervalValue.value)} onChange={(e) => (refreshIntervalValue.value = Number((e.target as HTMLSelectElement).value))}>
            <option value="5">5 秒</option><option value="15">15 秒</option>
            <option value="30">30 秒</option><option value="60">60 秒</option>
          </select>
        </label>
      </div>
    </aside>
  );
}

function freshAgeText(msNum: number): string {
  const s = Math.floor(msNum / 1000);
  if (s < 60) return s + " 秒前";
  const m = Math.floor(s / 60);
  if (m < 60) return m + " 分钟前";
  return Math.floor(m / 60) + " 小时前";
}

/* ---------------- App ---------------- */

function App() {
  const [loggedIn, setLoggedIn] = useState(!!getToken());
  const [refreshTick, setRefreshTick] = useState(0);
  const auth401 = useSignal(unauthorized.value);

  useEffect(() => {
    const iv = setInterval(() => (auth401.value = unauthorized.value), 500);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    if (auth401.value > 0) setLoggedIn(false);
  }, [auth401.value]);

  useEffect(() => {
    if (!loggedIn) return;
    api<any>("overview?window=5m&slim=1").then((d) => {
      if (d && d.providers && d.providers.length != null) {
        versionValue.value = versionValue.value;
      }
      lastFresh.value = Date.now();
    }).catch(() => { /* 401 已由 api 层 funnel 到登录门 */ });
  }, [loggedIn]);

  const onRefresh = () => setRefreshTick((t) => t + 1);
  const onLogout = () => { setToken(""); setLoggedIn(false); location.hash = ""; location.reload(); };

  if (!loggedIn) return <Login onLogin={() => setLoggedIn(true)} />;

  const cur = TABS.find(([id]) => id === view.value);
  document.title = (cur ? cur[1] + " · " : "") + "api-relay 管理面板";

  const views: Record<string, ComponentType> = {
    ov: Overview, met: Metrics, users: Keys, ch: Providers, tenants: Tenants, billing: Billing,
    kb: Kb, agent: Agent, "agent-matrix": AgentMatrix, agentchat: AgentChat, ledger: Ledger, diag: Diag,
    ops: Ops, trust: Trust,
  };
  const View = views[view.value] || Overview;

  return (
    <div key={refreshTick} id="shell">
      <div id="navscrim" class={navOpen.value ? "on" : ""} onClick={() => (navOpen.value = false)} />
      <TopBar onRefresh={onRefresh} onLogout={onLogout} />
      <SideNav />
      <main>
        <View key={refreshTick} />
      </main>
      <ToastHost />
      <DrawerHost />
    </div>
  );
}

render(<App />, document.getElementById("app")!);

/* Esc 全局逃生门（设计方案 §5 #3 用户控制与自由）：先关详情抽屉，再关移动端侧栏抽屉 */
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const a = escAction({ drawer: drawerOpen(), nav: navOpen.value });
  if (a === "close-drawer") closeDrawer();
  else if (a === "close-nav") navOpen.value = false;
});

/* toast 引用保留：api 层 401 funnel 后各视图 catch 里会用到 */
void toast;
