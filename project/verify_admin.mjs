// 复现 /admin 外壳选择（e2e 失败根因定位）——在 project/ 下运行
const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
const { join } = await import('node:path');
const { tmpdir } = await import('node:os');

const { MockUpstream } = await import('./dist/mock/upstream.js');
const { loadConfig } = await import('./dist/core/config.js');
const { createApp } = await import('./dist/app.js');

const mock = new MockUpstream({ port: 0 });
const mb = await mock.listen();
const dir = mkdtempSync(join(tmpdir(), 'verify-'));
const yaml = [
  'server:', '  host: 127.0.0.1', '  port: 0',
  'storage:', '  driver: memory', 'logLevel: error',
  'providers:', '  - id: m', '    label: m', '    protocol: openai',
  '    baseUrl: ' + JSON.stringify(mb.url), '    apiKey: k', '    models: [mock-small]',
  'clients:', '  - id: c', '    label: c', '    key: skv', '    tier: free', '    tenantId: t', '    enabled: true',
].join('\n');
writeFileSync(join(dir, 'relay.yaml'), yaml, 'utf8');
const cfg = loadConfig({ path: join(dir, 'relay.yaml'), env: {} });
const app = await createApp(cfg);
const bound = await app.start();
const res = await fetch(bound.url + '/admin');
const html = await res.text();
const Q = String.fromCharCode(39);
console.log('html 长度:', html.length);
console.log('含 [ov]:', html.includes(Q + 'ov' + Q));
console.log('含 Vite挂载点:', html.includes('<div id="app">'));
console.log('含 管理面板:', html.includes('管理面板'));
console.log('含 id="login":', html.includes('id="login"'));
await app.shutdown();
await mock.close();
rmSync(dir, { recursive: true, force: true });
process.exit(0);