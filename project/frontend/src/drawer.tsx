import { signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";

/* ---------------- 右侧抽屉（signal 驱动，替代旧版 #drawer DOM 直插） ---------------- */

export interface DrawerOpts {
  title: ComponentChildren;
  body: ComponentChildren;
  foot?: ComponentChildren;
}

const drawerState = signal<DrawerOpts | null>(null);

/* 焦点归还：打开前记住触发元素，关闭后还回去（键盘用户不丢位置） */
let lastActive: HTMLElement | null = null;

export const openDrawer = (o: DrawerOpts) => {
  lastActive = document.activeElement as HTMLElement | null;
  drawerState.value = o;
};

export const closeDrawer = () => {
  drawerState.value = null;
  if (lastActive && document.contains(lastActive)) {
    lastActive.focus();
    lastActive = null;
  }
};

/* 抽屉是否打开——全局 Esc 逃生门需要先关抽屉再关侧栏，两处状态分属不同模块，由此查询 */
export const drawerOpen = () => drawerState.value != null;

export function DrawerHost() {
  const o = drawerState.value;
  const ref = useRef<HTMLElement | null>(null);

  /* 挂载后焦点移进抽屉：容器 tabIndex=-1 可获焦，屏幕阅读器立即进入对话框上下文 */
  useEffect(() => {
    if (o) ref.current?.focus();
  }, [o]);

  /* focus-trap：Tab / Shift+Tab 在抽屉内首尾可聚焦元素间循环，出不去了才叫模态 */
  const trap = (e: KeyboardEvent) => {
    if (e.key !== "Tab" || !ref.current) return;
    const f = ref.current.querySelectorAll<HTMLElement>(
      'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])',
    );
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  if (!o) return null;
  return (
    <>
      <div id="scrim" class="on" onClick={closeDrawer} />
      <aside id="drawer" class="on" ref={ref} tabIndex={-1} role="dialog" aria-modal="true"
        aria-label={typeof o.title === "string" ? o.title : "详情"}
        onKeyDown={trap}>
        <div class="dh">
          <b>{o.title}</b>
          <button class="bare" onClick={closeDrawer}>关闭</button>
        </div>
        <div class="db">{o.body}</div>
        {o.foot ? <div class="df">{o.foot}</div> : null}
      </aside>
    </>
  );
}
