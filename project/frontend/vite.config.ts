import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [preact(), tailwindcss()],
  base: "/admin/",
  build: {
    outDir: "../dist-admin",
    emptyOutDir: true,
    // P1-2：产出 sourcemap。本次线上 TDZ 事故的定位成本极高——只能靠逆向压缩产物里
    // 的两字符变量名 'ge' 反推（`kb&&kb.enabled`）。有 map 后可直接定位到源码行列。
    // 本作品为公开/开源交付，暴露源码无额外风险。
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/admin/api": "http://127.0.0.1:8787",
      "/healthz": "http://127.0.0.1:8787",
    },
  },
});
