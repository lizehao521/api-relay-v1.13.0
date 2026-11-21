/**
 * 评委展示页（自包含 HTML，零外部依赖）。
 *
 * 对外公开（GET /judge），内容为作品介绍 + 核心能力 + 架构图 + 演示视频 + 在线看板入口。
 * 页内不出现任何凭据：看板入口只说明"用只读账号登录"，不写账号密码。
 */
export function renderJudgePage(o) {
    const adminUrl = o.adminUrl ?? '/admin';
    const svg = o.architectureSvg
        ? `<div class="arch">${o.architectureSvg}</div>`
        : `<p class="muted">架构图见提交包 <code>project/architecture.svg</code>。</p>`;
    const video = o.hasVideo
        ? `<video controls preload="metadata" playsinline poster="">
         <source src="/judge/video.mp4" type="video/mp4" />
         你的浏览器不支持内嵌视频，请直接访问 <a href="/judge/video.mp4">/judge/video.mp4</a>。
       </video>
       <p class="muted small">也可直接下载：<a href="/judge/video.mp4">/judge/video.mp4</a></p>`
        : `<div class="placeholder">
         <div class="ph-ic">▶</div>
         <div><b>演示视频待上传</b></div>
         <div class="muted small">把 3 分钟演示视频放到服务器 <code>data/judge-video.mp4</code> 后，本区会自动变为在线播放器。</div>
       </div>`;
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>api-relay · 作品展示（评委）</title>
<style>
  :root{
    --bg:#0b0f17; --panel:#131a26; --fg:#e8eef7; --muted:#93a1b5; --line:#243044;
    --accent:#4c8dff; --ok:#39c07d; --warn:#e0a23c;
  }
  @media (prefers-color-scheme: light){
    :root{ --bg:#f6f8fc; --panel:#ffffff; --fg:#16202e; --muted:#5b6b80; --line:#e2e8f0; --accent:#2563eb; }
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
    font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;}
  .wrap{max-width:1000px;margin:0 auto;padding:28px 20px 64px}
  header.hero{border:1px solid var(--line);border-radius:14px;padding:24px;background:
    linear-gradient(135deg,rgba(76,141,255,.14),transparent 60%),var(--panel)}
  .kicker{color:var(--accent);font-weight:700;letter-spacing:.06em;font-size:12px;text-transform:uppercase}
  h1{margin:8px 0 6px;font-size:28px;line-height:1.25}
  .tagline{color:var(--muted);margin:0 0 14px}
  .meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
  .chip{border:1px solid var(--line);border-radius:999px;padding:3px 11px;font-size:12px;color:var(--muted)}
  section{margin-top:22px;border:1px solid var(--line);border-radius:14px;padding:20px;background:var(--panel)}
  h2{font-size:17px;margin:0 0 12px;display:flex;align-items:center;gap:8px}
  h2 .n{width:22px;height:22px;border-radius:6px;background:var(--accent);color:#fff;font-size:12px;
    display:inline-flex;align-items:center;justify-content:center;font-weight:700}
  p{margin:0 0 10px}
  ul{margin:0 0 10px;padding-left:20px}
  li{margin:4px 0}
  .muted{color:var(--muted)}
  .small{font-size:13px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
  .card{border:1px solid var(--line);border-radius:11px;padding:14px;background:var(--bg)}
  .card b{display:block;margin-bottom:5px}
  code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}
  code{background:rgba(127,127,127,.14);padding:1px 5px;border-radius:5px}
  pre{background:var(--bg);border:1px solid var(--line);border-radius:9px;padding:12px;overflow:auto}
  video{width:100%;border-radius:11px;border:1px solid var(--line);background:#000}
  .placeholder{border:1px dashed var(--line);border-radius:11px;padding:26px;text-align:center;color:var(--muted)}
  .ph-ic{font-size:26px;color:var(--accent);margin-bottom:6px}
  .arch{overflow:auto;border:1px solid var(--line);border-radius:11px;padding:8px;background:var(--bg)}
  .arch svg{max-width:100%;height:auto;display:block}
  .actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:12px}
  a.btn{display:inline-block;padding:9px 16px;border-radius:9px;background:var(--accent);color:#fff;
    text-decoration:none;font-weight:600}
  a.btn.ghost{background:transparent;color:var(--accent);border:1px solid var(--accent)}
  a{color:var(--accent)}
  footer{margin-top:26px;color:var(--muted);font-size:13px;text-align:center}
  .kv{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:14px}
  .kv div:nth-child(odd){color:var(--muted)}

  /* ---- 移动端（≤640px）：单列布局、收紧内边距 ---- */
  @media (max-width: 640px){
    .wrap{padding:16px 12px 48px}
    header.hero{padding:18px 16px;border-radius:12px}
    h1{font-size:22px;line-height:1.3}
    .tagline{font-size:14px}
    section{padding:16px;margin-top:14px;border-radius:12px}
    .grid{grid-template-columns:1fr}
    .kv{grid-template-columns:1fr;gap:2px 0}
    .kv div:nth-child(odd){margin-top:8px}
    .actions{flex-direction:column}
    a.btn{width:100%;text-align:center;padding:12px 16px}
    pre{font-size:12px}
    .placeholder{padding:18px}
    footer{font-size:12px}
  }

  /* ---- 触控设备：可点元素 ≥44px，视频限制高度避免霸屏 ---- */
  @media (pointer: coarse){
    a.btn{min-height:44px;display:inline-flex;align-items:center;justify-content:center}
    video{max-height:56vh;object-fit:contain}
    /* 行内文本链接（看板地址、视频直链）也要有足够大的点击区：纵向内边距抬高命中矩形，
       不改变视觉排版（.kv 是 grid 单元格、footer 是居中文本） */
    .kv a{display:inline-block;padding:8px 0;min-height:36px;line-height:1.4}
    /* 正文/说明区的行内链接（如「也可直接下载」的视频直链）同口径抬高命中矩形 */
    p a{display:inline-block;padding:8px 0;min-height:36px;line-height:1.4}
    footer a{display:inline-block;padding:8px 0;min-height:36px;line-height:1.4}
  }

  /* ---- 刘海屏安全区（配合 viewport-fit=cover） ---- */
  @supports (padding: env(safe-area-inset-bottom)){
    .wrap{padding-bottom:calc(48px + env(safe-area-inset-bottom))}
    .wrap{padding-left:max(12px, env(safe-area-inset-left));padding-right:max(12px, env(safe-area-inset-right))}
  }
</style>
</head>
<body>
<div class="wrap">

  <header class="hero">
    <div class="kicker">华为开发者大赛 · 智能体创新赛 · 参赛作品</div>
    <h1>api-relay — 智能体基础设施层</h1>
    <p class="tagline">没有再造一个 Agent，而是做<b>所有 Agent 都要站的那层地基</b>：把多家、不稳定的模型上游统一成一条可运营的 OpenAI 兼容通道——<b>错误可执行 · 数据可信 · 损耗可度量</b>。</p>
    <div class="meta">
      <span class="chip">版本 ${o.version}</span>
      <span class="chip">队伍：落幕</span>
      <span class="chip">OpenAI 兼容</span>
      <span class="chip">可执行 · 可信 · 可度量</span>
      <span class="chip">降损层 P2 / P3 / P8</span>
      <span class="chip">内置 Agent</span>
      <span class="chip">思考档位</span>
    </div>
  </header>

  <section>
    <h2><span class="n">1</span>作品要解决的问题</h2>
    <p>多模型接入的难点从来不是"能不能连上"，而是<b>连上之后的损失由谁承担</b>：上游限流、超时、静默降级、错误不可归因、上游身份被动暴露。<b>而这正是 Agent 落地最贵的一课</b>——失败若不可执行，Agent 只能盲目重试。</p>
    <ul>
      <li><b>协议碎片化</b>：每家 SDK 不同，业务侧被迫写多套适配。</li>
      <li><b>故障不可控</b>：一次上游抖动，客户端只看到"超时"，不知道为什么、下一步该做什么。</li>
      <li><b>成本与质量不可见</b>：token、思考量、延迟、失败原因散落在各处，无法运营。</li>
    </ul>
  </header></section>

  <section>
    <h2><span class="n">2</span>核心能力</h2>
    <div class="grid">
      <div class="card"><b>OpenAI 兼容网关</b><span class="muted small">一套 SDK 对接所有上游；<code>GET /v1/models</code> 只列出"此刻真的能服务"的模型。</span></div>
      <div class="card"><b>P2 调用前预检</b><span class="muted small">畸形 <code>tool_calls</code>、超长上下文等在到达上游之前就拦下，省一次往返与一次配额。</span></div>
      <div class="card"><b>P3 失败归因</b><span class="muted small">任何非 2xx 都附 <code>relay_attribution</code>：失败原因 + 建议动作 + 可恢复性，客户端不必解析上游原文。</span></div>
      <div class="card"><b>P8 损耗量化</b><span class="muted small">token（含推理 token 单列）、成本、p95 延迟、降损层自身开销（千分之一量级）。</span></div>
      <div class="card"><b>多上游负载均衡 + 故障转移</b><span class="muted small">同权重多线并行、熔断摘除、阶梯下退，目标是把任务跑完而不是把错误抛回去。</span></div>
      <div class="card"><b>内置 Agent（自证闭环）</b><span class="muted small">读运营快照 → 调本网关自身 LLM → 工具取证 → 出运维建议 → 沉淀知识库 → 写审计事件。</span></div>
      <div class="card"><b>思考档位</b><span class="muted small">下游用模型名选思考深度（如 <code>思考-深</code> / <code>thinking-deep</code>），档内自动阶梯故障转移。</span></div>
      <div class="card"><b>上游身份防护</b><span class="muted small"><code>server.hideUpstream</code>：下游看不到上游 provider、真实模型名与阶梯，防被反向探测。</span></div>
    </div>
  </section>

  <section>
    <h2><span class="n">3</span>系统架构</h2>
    ${svg}
  </section>

  <section>
    <h2><span class="n">4</span>演示视频</h2>
    ${video}
  </section>

  <section>
    <h2><span class="n">5</span>在线看板（可现场查看真实运行数据）</h2>
    <p>看板展示本作品部署实例的<b>实时运行数据</b>：请求量、错误率、失败归因分布、降损层收益、上游健康、请求账本与 Agent 巡检记录。</p>
    <div class="kv">
      <div>地址</div><div><a href="${adminUrl}">${adminUrl}</a></div>
      <div>账号</div><div>只读账号（由部署方提供）—— 仅可查看，任何写操作返回 403</div>
      <div>说明</div><div>面板不展示任何明文密钥，只显示 key 指纹</div>
    </div>
    <div class="actions">
      <a class="btn" href="${adminUrl}">进入在线看板</a>
      <a class="btn ghost" href="/v1/models">查看可用模型清单</a>
    </div>
  </section>

  <section>
    <h2><span class="n">6</span>快速体验（OpenAI 兼容）</h2>
    <pre>curl -X POST http://&lt;本网关&gt;/v1/chat/completions \\
  -H "authorization: Bearer &lt;你的 relay key&gt;" \\
  -H "content-type: application/json" \\
  -d '{"model":"思考-轻","messages":[{"role":"user","content":"你好"}]}'</pre>
    <p class="muted small">换 <code>"model":"思考-中"</code> / <code>"思考-深"</code> 即可切换思考深度；也可直接用底层模型名（如 <code>deepseek-v4-flash</code>）。</p>
  </section>

  <footer>
    api-relay · 队伍「落幕」 · 联系方式 li1119489753@outlook.com<br />
    本页为作品对外展示页；页面不含任何凭据信息。
  </footer>

</div>
</body>
</html>`;
}
//# sourceMappingURL=judge-page.js.map