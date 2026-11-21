import { test } from "node:test";
import assert from "node:assert/strict";
import { escAction, keyActivation, nextTheme } from "../frontend/src/ui-logic.ts";

test("nextTheme 双向切换", () => {
  assert.equal(nextTheme("dark"), "light");
  assert.equal(nextTheme("light"), "dark");
});

test("keyActivation：Enter 激活 / Space 拦滚动 / 其他放行", () => {
  assert.equal(keyActivation("Enter"), "activate");
  assert.equal(keyActivation(" "), "block");
  assert.equal(keyActivation("a"), null);
  assert.equal(keyActivation("Escape"), null);
});

test("escAction 层级：抽屉优先于侧栏", () => {
  assert.equal(escAction({ drawer: true, nav: true }), "close-drawer");
  assert.equal(escAction({ drawer: true, nav: false }), "close-drawer");
  assert.equal(escAction({ drawer: false, nav: true }), "close-nav");
  assert.equal(escAction({ drawer: false, nav: false }), null);
});
