/* 纯交互判定（零依赖，node --experimental-strip-types 可直测）。
   ui.tsx/state.ts/main.tsx 从这里取逻辑，行为变更先在这里锁死再改 UI。 */

export type Theme = "dark" | "light";
export const nextTheme = (cur: Theme): Theme => (cur === "dark" ? "light" : "dark");

/* 键盘激活：Enter 立即激活；Space 需拦截默认滚动（keydown 拦、keyup 激活，对齐原生 button）。
   返回值：activate=触发动作；block=只拦滚动不触发；null=无关键放行 */
export function keyActivation(key: string): "activate" | "block" | null {
  if (key === "Enter") return "activate";
  if (key === " ") return "block";
  return null;
}

/* Esc 层级：抽屉开着先关抽屉；否则侧栏开着关侧栏；都没开不动 */
export function escAction(state: { drawer: boolean; nav: boolean }): "close-drawer" | "close-nav" | null {
  if (state.drawer) return "close-drawer";
  if (state.nav) return "close-nav";
  return null;
}
