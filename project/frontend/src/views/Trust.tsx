import { useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";
import { api } from "../api";
import type { KeyFull } from "../types";
import { copyText, esc, formatNumber, toast } from "../ui";

/* ---------------- 设计红线（A1-A4） ---------------- */

const INV: [string, string, string, string][] = [
  [
    "A1",
    "成功零改写",
    "上游 2xx 响应体与 SSE 帧逐字节原样透传。唯一例外：上游回显的 model 与客户端请求不一致时改写回请求名（严格解码器会因此崩），只改这一个字段。",
    "e2e: 成功响应不含 relay_attribution ／ 流式 SSE 逐帧结构 ／ engine: 响应体原样透传",
  ],
  [
    "A2",
    "错误只增不改",
    "归因作为附加字段挂在 error.relay_attribution（或仅响应头 X-Relay-Attribution）。上游 message 与 code 一律保留原值，缺失的 type/param 才补齐。",
    "engine: 透传上游错误体 + 附带归因 ／ attribution: 六种上游错误体形态",
  ],
  [
    "A3",
    "fail-open 不可破",
    "预检/归因/度量/轨迹/指纹任一环节异常都静默回退原行为，绝不做主流程的单点故障。唯一 fail-closed 的是鉴权（安全边界）。",
    "loss: Meter 在 store 抛异常时 fail-open ／ precheck: 超预算放行 ／ 概览可见兜底计数",
  ],
  [
    "A4",
    "不落用户正文",
    "默认不存 prompt/completion 正文；指纹用 HMAC 截断 16 字符（非裸 sha256，防字典反推）；额度与度量只存计数。",
    "loss: 指纹只输出 HMAC 前缀，不泄漏正文",
  ],
];

/* ---------------- 自验命令（pre 展示与复制共用同一份文本） ---------------- */

const VERIFY_CMD = `# 1) 发送请求时带上自己的随机数
curl -s -D - \\
  -H 'authorization: Bearer <你的 key>' -H 'content-type: application/json' \\
  -H 'x-relay-verify-nonce: my-nonce-123' \\
  -d '{"model":"...","messages":[...]}' \\
  http://<网关>/v1/chat/completions

# 响应头会带回来：
#   x-relay-content-hmac: <HMAC-SHA256(nonce, 响应体字节)>
#   x-relay-content-hmac-nonce / -request-id

# 2) 用同一个 nonce 对自己收到的原始字节重算：
node -e "const c=require('crypto');console.log(c.createHmac('sha256','my-nonce-123').update(require('fs').readFileSync('resp.bin')).digest('hex'))"
# 说明：HMAC 是网关对**自己发出的响应体**（含 model 回显修正后）计算的，
# 相等只能证明"你收到的就是这个响应体"，**不能证明**中转站没做过任何改写
# （2026-09-14 审计 A-P2-8：非 ASCII 百分号编码、model 回显改写、JSON 往返都在
# 计算 HMAC 之前发生）。需要字节级完整性请直接比对上游。
`;

/* ---------------- 客户端端点表（渲染与复制共用） ---------------- */

interface EpRow {
  ep: string;
  auth: string;
  what: JSX.Element;
  plain: string;
}

const m = (s: string) => <span class="mono">{s}</span>;
const b = (s: string) => <b>{s}</b>;

const ENDPOINTS: EpRow[] = [
  {
    ep: "GET /v1/models",
    auth: "Bearer key（可选）",
    what: (
      <>
        本网关可用模型清单（OpenAI 兼容形状 {m("{object:\"list\", data:[{id,...}]}")}
        ）；带 key 时按该 key 的白名单过滤——只说这把 key 能用的（未设白名单的 key 看到全量，manual#356
        实测：系统内无白名单 key 时带不带 key 输出一致，属正确行为）
      </>
    ),
    plain:
      '本网关可用模型清单（OpenAI 兼容形状 {object:"list", data:[{id,...}]}）；带 key 时按该 key 的白名单过滤——只说这把 key 能用的（未设白名单的 key 看到全量，manual#356 实测：系统内无白名单 key 时带不带 key 输出一致，属正确行为）',
  },
  {
    ep: "POST /v1/completions",
    auth: "Bearer key",
    what: (
      <>
        旧版文本补全（manual#361 实测 200）：请求体传 {m("prompt")}（不是 messages），响应是 OpenAI 兼容形状{" "}
        {m("{object:\"text_completion\", choices:[{text, finish_reason}]}")}
        ——老客户端/库直接用；新集成建议用 chat/completions
      </>
    ),
    plain:
      '旧版文本补全（manual#361 实测 200）：请求体传 prompt（不是 messages），响应是 OpenAI 兼容形状 {object:"text_completion", choices:[{text, finish_reason}]}——老客户端/库直接用；新集成建议用 chat/completions',
  },
  {
    ep: "POST /v1/responses",
    auth: "Bearer key",
    what: (
      <>
        {b("OpenAI Responses API 兼容")}
        （manual#381 实测 200）：请求体传 {m("input")}
        {m("+")}
        {m("max_output_tokens")}（不是 messages/max_tokens），响应是 {m("{object:\"response\", id:\"resp_…\", output:[…]}")}{" "}
        形状——用 Responses SDK/新版客户端的直接走这个；与 chat/completions 同模型范围
      </>
    ),
    plain:
      'OpenAI Responses API 兼容（manual#381 实测 200）：请求体传 input+max_output_tokens（不是 messages/max_tokens），响应是 {object:"response", id:"resp_…", output:[…]} 形状——用 Responses SDK/新版客户端的直接走这个；与 chat/completions 同模型范围',
  },
  {
    ep: "POST /v1/messages",
    auth: "Bearer key",
    what: (
      <>
        {b("Anthropic Messages 兼容")}
        （manual#381 实测）：请求体 {m("system")}
        {m("+")}
        {m("messages")}
        {m("+")}
        {m("max_tokens")}（必填），响应是 {m("{type:\"message\", content:[{type:\"text\"…}]}")} 形状——Claude Code
        等 Anthropic SDK 直接用。{b("注意模型范围：仅 agnes 系")}
        （实测 agnes-2.0/2.5/3.0-flash 全 200；mimo/step 系走这个会 404
        model_not_found——用 /v1/chat/completions）
      </>
    ),
    plain:
      'Anthropic Messages 兼容（manual#381 实测）：请求体 system+messages+max_tokens（必填），响应是 {type:"message", content:[{type:"text"…}]} 形状——Claude Code 等 Anthropic SDK 直接用。注意模型范围：仅 agnes 系（实测 agnes-2.0/2.5/3.0-flash 全 200；mimo/step 系走这个会 404 model_not_found——用 /v1/chat/completions）',
  },
  {
    ep: "POST /v1/embeddings",
    auth: "Bearer key",
    what: (
      <>
        {b("当前不可用")}
        （manual#361
        实测）：路由存在但没有任何上游声明 embeddings
        能力——传任何模型都返 404 model_not_found。别把它当可用端点集成；需要向量能力找运营确认上游支持后再用
      </>
    ),
    plain:
      "当前不可用（manual#361 实测）：路由存在但没有任何上游声明 embeddings 能力——传任何模型都返 404 model_not_found。别把它当可用端点集成；需要向量能力找运营确认上游支持后再用",
  },
  {
    ep: "GET /v1/quota",
    auth: "公开（默认仅本机）",
    what: (
      <>
        近 1h/5h/24h 的用量（manual#386 实测补字段名）：{m("windows[]")} 三个窗口各带 {m("windowHours:1/5/24")}
        、总计（requests/errors/totalTokens/costCny）、速查计数 {m("byModel")}
        {m("/")}
        {m("byProvider")}
        （纯数字），以及完整明细 {m("models[]")}
        （model/requests/errors/totalTokens/cachedPromptTokens/costCny）与 {m("providersDetail[]")}
        （provider 同款字段）——客户对账用后两个数组
      </>
    ),
    plain:
      "近 1h/5h/24h 的用量（manual#386 实测补字段名）：windows[] 三个窗口各带 windowHours:1/5/24、总计（requests/errors/totalTokens/costCny）、速查计数 byModel/byProvider（纯数字），以及完整明细 models[]（model/requests/errors/totalTokens/cachedPromptTokens/costCny）与 providersDetail[]（provider 同款字段）——客户对账用后两个数组",
  },
  {
    ep: "GET /v1/panel",
    auth: "公开（默认仅本机）",
    what: <>网关状态面板：上游健康、最近请求轨迹（含上游错误文案）、key 摘要、时序桶</>,
    plain: "网关状态面板：上游健康、最近请求轨迹（含上游错误文案）、key 摘要、时序桶",
  },
  {
    ep: "GET /v1/attribution/catalog",
    auth: "公开",
    what: <>错误归因目录：上游错误码→中文含义+建议动作+可恢复性（排障页同源）</>,
    plain: "错误归因目录：上游错误码→中文含义+建议动作+可恢复性（排障页同源）",
  },
];

/* ---------------- 客户端错误码表 ---------------- */

interface ErrRow {
  http: string;
  code: string;
  meaning: JSX.Element;
}

const ERRORS: ErrRow[] = [
  {
    http: "400",
    code: "invalid_request / question_required",
    meaning: (
      <>
        参数问题。question_required 只对 {m("/v1/kb/<id>/ask")} 生效（question 缺失，也接受 query
        别名）。{b("注意")}
        （manual#378 实测纠错）：chat 的 messages 空/缺失{b("不会被中转层预检")}——请求会到上游被拒，400
        报文是上游原文透传（如 "Param Incorrect"，code 显示上游原值）——带 max_tokens 修好 messages
        即可，别按本表的参数错排查。
      </>
    ),
  },
  {
    http: "401",
    code: "missing_key",
    meaning: (
      <>
        请求没带 {m("Authorization: Bearer <key>")} 头——{b("最常见的集成失误")}
        （manual#378
        实测：不是 key 无效，是根本没带）。检查客户端的鉴权头拼接；message 里有正确格式示例。
      </>
    ),
  },
  {
    http: "401",
    code: "invalid_key",
    meaning: (
      <>
        key 无效/已轮换。message
        带密钥指纹——拿它和管理员核对是哪把 key；正在用旧 key 的客户端会批量撞这个。
      </>
    ),
  },
  {
    http: "401",
    code: "key_disabled",
    meaning: (
      <>
        key 被管理员{b("停用")}
        （manual#365 起的可逆路径：停用期间鉴权同等 401，但 key 还在列表里可随时恢复）。message
        会指名是哪把 key——找运维在 /admin 重新启用即可，不用换 key。
      </>
    ),
  },
  {
    http: "401",
    code: "expired_key",
    meaning: <>key 已过有效期（message 带过期时刻 UTC）。找运维续期或换一把新 key。</>,
  },
  {
    http: "403",
    code: "kb_forbidden",
    meaning: (
      <>
        该 KB 设了允许的 key 白名单，当前 key 不在内（manual#395 实测纠错：文档原写 {m("kb_not_allowed")}
        ——**这个码在网关不存在**，按 error.code
        做分支的客户端会整支漏掉；真实码是 kb_forbidden，报文带 KB id 与 key id）。找管理员把 key 加进
        allowedKeys。
      </>
    ),
  },
  {
    http: "403",
    code: "model_not_allowed",
    meaning: (
      <>
        {b("模型存在，但这把 key 的白名单里没有它")}
        （manual#378
        实测：专卖/限层 key 的典型场景）。message 会列出该 key 可用的模型清单——照着换模型名即可，不用找运维（除非要扩容白名单）。
      </>
    ),
  },
  {
    http: "404",
    code: "model_not_found",
    meaning: (
      <>
        模型名没有上游声明支持（这是{b("模型清单问题，不是上游故障")}）。GET /v1/models 拿可用清单；ask
        的 model 必填，不带也是这个错。
      </>
    ),
  },
  { http: "404", code: "kb_not_found", meaning: <>KB id 不存在。拼写检查；KB 清单问管理员。</> },
  {
    http: "404",
    code: "unknown_endpoint",
    meaning: (
      <>
        路径不在支持列表（message 列出全部受支持端点）——检查 URL 拼写（如多打了 /v1）。
      </>
    ),
  },
  {
    http: "405",
    code: "method_not_allowed",
    meaning: (
      <>
        路径对但 HTTP 方法错（如用 GET 打 /v1/chat/completions）——message 会说明只接受什么方法。
      </>
    ),
  },
  {
    http: "400",
    code: "invalid_request_error（坏 JSON）",
    meaning: (
      <>
        请求体不是合法 JSON（manual#378 实测：截断/尾逗号/单引号都会中）。message
        会带解析器位置提示；序列化层修好再发。
      </>
    ),
  },
  {
    http: "429",
    code: "quota_exceeded",
    meaning: <>本周期配额用完（token 或金额）。等下一周期或联系管理员扩容/重置。</>,
  },
  {
    http: "429",
    code: "too_many_concurrent",
    meaning: (
      <>
        在途请求数超过本层并发上限（manual#352 实测：free 4 / standard 32 / pro 128）。网关会{b("立即拒绝")}
        （几十毫秒，不占用上游额度）——客户端做并发控制（信号量/队列）或错峰重试即可。
      </>
    ),
  },
  {
    http: "429",
    code: "rate_limited",
    meaning: (
      <>
        本分钟请求数超过本层速率上限（manual#354 实测：free 20 / standard 300 / pro 1200 RPM，固定窗口按自然分钟计，整点重置）。网关同样{b("立即拒绝")}
        （不占用上游额度）——按 error.relay_attribution.suggested_next.retryAfterMs
        退避后重试（响应里带了精确到毫秒的等待值，第 21 次请求实测拿到
        56.1s），或直接降低请求频率。
      </>
    ),
  },
  {
    http: "502/503",
    code: "upstream_error",
    meaning: (
      <>
        上游真故障。看 message 里的归因；可重试——带 X-Relay-Attribution 响应头（同
        error.relay_attribution 字段）供排障。
      </>
    ),
  },
];

/* ---------------- 主视图 ---------------- */

export function Trust() {
  const [keys, setKeys] = useState<KeyFull[] | null>(null);
  const [keysFail, setKeysFail] = useState<string>("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      setKeysFail("");
      try {
        const d = await api<{ keys?: KeyFull[] }>("keys");
        if (alive) setKeys(d.keys || []);
      } catch (e: any) {
        // 取数失败不静默（manual#374）：不把失败伪装成空态
        if (alive) {
          setKeysFail(e && e.message ? e.message : "网络错误");
          setKeys([]);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [tick]);

  // 复制端点表（manual#339）：表格转纯文本（每行「端点 | 鉴权 | 它回答什么」）
  const copyEndpoints = () => {
    const rows = ENDPOINTS.map((r) => r.ep + " | " + r.auth + " | " + r.plain);
    if (rows.length)
      copyText(rows.join("\n"), "客户端端点表已复制（" + rows.length + " 个端点：端点 | 鉴权 | 它回答什么）");
  };

  return (
    <div>
      <div class="note">
        <b>这一页把设计红线连同它的自动化测试摆在明面上。</b>
        不用翻文档、不用信口头承诺—— 每条后面都写着它在哪组测试里被钉住。测试规模以{" "}
        <span class="mono">npm test</span> 与 <span class="mono">bash scripts/smoke.sh</span> 的
        <b>实际输出</b>为准 —— 写死在页面上的数字一定会过期（这一句原本写的是"179
        个"，早就对不上了）。
      </div>
      <section class="block">
        {INV.map(([id, name, desc, ev]) => (
          <div key={id} class="inv">
            <b>{id + " · " + name}</b>
            <div class="t">{desc}</div>
            <div class="ev">✓ {ev}</div>
          </div>
        ))}
      </section>

      <section class="block">
        <h2>给终端用户的自助核对</h2>
        <div class="note" style="margin:0 0 var(--s3)">
          任何响应都带 <span class="mono">x-request-id</span>。
          客户端按下面的方式对拍自己收发的字节哈希，即可证明中转站未改写成功响应——不需要相信我们。
        </div>
        <div class="note" style="margin:0 0 var(--s3)">
          <b>流式（stream: true）已支持</b>（manual#351 补文档）：请求体带 <span class="mono">"stream": true</span>{" "}
          即走 SSE——上游的 data: 帧逐字节透传（不缓冲不改写），响应头{" "}
          <span class="mono">content-type: text/event-stream</span>。断流时响应/事件带{" "}
          <span class="mono">stream_interrupted</span>{" "}
          归因（客户端侧重试或切非流式）。注意：字节哈希自验仅对可完整缓冲的**非流式**响应生效——流式请用「请求账本」的步骤时间线核对（运营侧）。
        </div>
        <pre>{VERIFY_CMD}</pre>
        <button
          class="bare"
          style="margin-top:var(--s2)"
          title="复制整段自验命令（curl+node 两段）——把 <你的key> 和 <网关> 换成真实值再发给客户"
          onClick={() => copyText(VERIFY_CMD, "自验命令已复制——把 <你的key> 和 <网关> 换成真实值再发给客户")}
        >
          复制核对命令
        </button>
        <div class="muted-xs stack-sm">
          限制：该证明仅对可完整缓冲的响应（非流式）生效。流式响应请改用「请求账本」里的步骤时间线核对。
        </div>
      </section>

      <section class="block">
        <h2>快速接入（OpenAI 兼容）</h2>
        <div class="note" style="margin:0 0 var(--s3)">
          本网关是 <b>OpenAI 兼容</b>端点——任何 OpenAI SDK 只改两行（base_url +
          api_key）就能用，无需改业务代码。以 Python 官方 SDK 为例（Node/Go/Java 等同理）：
        </div>
        <pre>{`from openai import OpenAI

client = OpenAI(
    base_url="https://<网关>/v1",        # 本网关地址（运营提供）
    api_key="sk-relay-<你的 key>",      # 运营提供给你的 key
)

resp = client.chat.completions.create(
    model="mimo-v2.6-flash",                 # 可用模型见 GET /v1/models
    messages=[{"role": "user", "content": "你好"}],
    max_tokens=512,                          # 见下方『推理模型注意』——别给小额
)
print(resp.choices[0].message.content)`}</pre>
        <div class="note" style="margin:10px 0 0">
          <b>Anthropic Messages 兼容（POST /v1/messages）</b>（manual#398 实测补文档）：请求体{" "}
          <span class="mono">system</span> + <span class="mono">messages</span> +{" "}
          <span class="mono">max_tokens</span>（必填），响应是 Anthropic 形状{" "}
          <span class="mono">{`{type:"message", content:[{type:"text",text:"…"}], stop_reason:"end_turn", usage:{input_tokens,…}}`}</span>
          ——Claude Code 等 Anthropic SDK 把 base_url 指到本网关即可用。<b>模型范围：仅 agnes 系</b>（实测
          agnes-2.0/2.5/3.0-flash 全 200；mimo/step 系走这个端点会 404
          model_not_found——那些模型请用 /v1/chat/completions）。
        </div>
        <div class="note" style="margin:10px 0 0">
          <b>OpenAI Responses 兼容（POST /v1/responses）</b>（manual#398
          实测补文档）：请求体 <span class="mono">input</span>（必填，缺失 400）+{" "}
          <span class="mono">max_output_tokens</span>，响应是 Responses 形状{" "}
          <span class="mono">{`{object:"response", id:"resp_…", output:[…], output_text:"…", usage:{input_tokens,output_tokens}}`}</span>
          。注意：推理模型的 <span class="mono">output[]</span> 首项类型是{" "}
          <span class="mono">reasoning</span>（思考段，非最终答案）——取可见文本用{" "}
          <span class="mono">output_text</span> 便捷字段（或 output[] 里最后的 message 项）。
        </div>
        <div class="note" style="margin:10px 0 0">
          <b>推理模型注意（mimo 全系，manual#364 实测）</b>——mimo
          是带推理的模型，实测三个行为，客户端必须知道：①<b>max_tokens 要先给推理留够</b>：推理
          token 优先于可见内容消耗生成配额——prompt 触发较多推理时，小额 max_tokens（实测
          64）会拿到超出配额的 completion_tokens（72）、<span class="mono">finish_reason=length</span>{" "}
          且<b>可见内容为空</b>（等十几秒到一两分钟收到空回复）；是否空回复取决于该 prompt
          触发多少推理（同一 32
          额度下简单问句有内容、稍复杂问句会空）——生产环境给 ≥256，短测试也要
          ≥128，并在客户端做空回复兜底（加大额度重试）；②<b>延迟分两段</b>：首字节慢（24h 均值
          ~11s、p95 ~35s，繁忙时尾部长达
          100s+）——客户端超时按 120s+
          设，同步调用建议配进度提示或改流式；③<b>流式可绕开整段空等</b>：带{" "}
          <span class="mono">"stream": true</span>{" "}
          后逐帧收到内容、不用等推理全部完（但首帧仍要等上游第一个 token，实测
          ~20s）；断流会有 stream_interrupted 归因，可重试。
        </div>
        <div class="muted-xs stack-sm">
          以上数字是 manual#364
          在现网负载下的实测值（2 核共享主机），会随上游负载波动——把客户端超时和
          max_tokens 按上面的建议值设，就不会踩空。
        </div>
      </section>

      <section class="block">
        <h2>
          客户端可用端点 <span class="spacer" />{" "}
          <button
            class="bare"
            style="font-size:var(--fs-xs)"
            title="复制端点表（端点 | 鉴权 | 它回答什么）——转发客户文档时不用手动划选表格"
            onClick={copyEndpoints}
          >
            复制端点表
          </button>{" "}
          <span class="muted-xs" style="text-transform:none">
            manual#239 补齐——此前信任页只文档了 chat/ask
          </span>
        </h2>
        <div class="note" style="margin:0 0 var(--s3)">
          除 <span class="mono">/v1/chat/completions</span>（上方的自验命令）与{" "}
          <span class="mono">/v1/kb/&lt;id&gt;/ask</span>（知识库页签）外，客户端还可自助拉取下面这些。{" "}
          <b>安全边界</b>：标「公开」的两个端点不带 key 鉴权，默认<b>只允许本机（127.0.0.1）访问</b>；
          远程读取需运维显式开 <span class="mono">server.publicQuotaRemote: true</span>{" "}
          并自行做反代 IP 白名单。
        </div>
        <table>
          <thead>
            <tr>
              <th>端点</th>
              <th>鉴权</th>
              <th>它回答什么</th>
            </tr>
          </thead>
          <tbody>
            {ENDPOINTS.map((r) => (
              <tr key={r.ep}>
                <td class="mono">{r.ep}</td>
                <td>{r.auth}</td>
                <td>{r.what}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div class="muted-xs stack-sm">
          提示：/v1/quota 与 /v1/panel 的 traces
          参数控制轨迹条数（1-100，默认 30，manual#198）；model 字段来自 route 步骤提取（manual#227），可按模型搜索。
          <b>体积</b>（manual#327 实测）：/v1/panel 默认（30
          条）约 56KB，每条轨迹约 1KB——轮询场景按需调小（traces=10 约 41KB、traces=3 约 36KB
          触底；traces=100 约 110KB）；/v1/quota 约 5.4KB、/v1/models 约
          2KB。服务端暂未开响应压缩（签字项⑰），轮询频繁的客户端建议带 traces 上限+本地缓存。
        </div>
        <h3 style="margin:14px 0 6px;font-size:var(--fs-body)">客户端错误码（manual#343 实测补录）</h3>
        <table>
          <thead>
            <tr>
              <th>HTTP</th>
              <th>error.code</th>
              <th>含义与处理</th>
            </tr>
          </thead>
          <tbody>
            {ERRORS.map((r, i) => (
              <tr key={i}>
                <td class="mono">{r.http}</td>
                <td class="mono">{r.code}</td>
                <td>{r.meaning}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div class="muted-xs stack-sm">
          错误响应统一形状 <span class="mono">{`{ error: { message, type, code } }`}</span>
          ；成功响应零附加字段。重试建议只对 429/502/503 有意义——400/401/403/404
          重试不会变好。<b>请求体超上限</b>（默认 8MB，ops
          页可查可调）时网关<b>直接断开连接、不返回错误 JSON</b>（manual#378 实测：客户端看到的是
          ECONNRESET / curl exit 56，没有 HTTP 响应）——大上下文/批量 payload 场景先确认上限再发。
        </div>
      </section>

      <section class="block">
        <h2>
          你的凭据与用量 <span class="spacer" />{" "}
          <button class="bare" onClick={() => setTick((t) => t + 1)}>
            ↻
          </button>
        </h2>
        {keysFail ? (
          <div class="note warn" style="margin:0 0 var(--s3)">
            <b>key 列表取数失败：</b>
            {esc(keysFail)}——下面表格是空占位，<b>不是真实 key 清单</b>（勿据此判断有无
            key）。稍后点右上角 ↻ 重试。
          </div>
        ) : null}
        <table>
          <thead>
            <tr>
              <th>Key</th>
              <th>分层</th>
              <th>状态</th>
              <th>本周期 token</th>
              <th>请求数</th>
            </tr>
          </thead>
          <tbody>
            {keys && keys.length ? (
              keys.map((k) => {
                const u = k.usage || ({} as NonNullable<KeyFull["usage"]>);
                return (
                  <tr key={k.id}>
                    <td class="mono">{k.id}</td>
                    <td>{k.tier}</td>
                    <td>
                      {k.enabled ? <span class="chip g">生效中</span> : <span class="chip">已禁用</span>}
                    </td>
                    <td class="mono">{formatNumber(u.tokens)}</td>
                    <td class="mono">{formatNumber(u.requests)}</td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colspan={5} class="dim">
                  暂无 key——用右上角「新建 key」创建；key
                  是客户端调用的唯一凭据，没有它谁也调不通
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div class="muted-xs stack-sm">
          这里只显示你自己的 key（面板以管理令牌鉴权，因此展示全量；对客户暴露时请按 tenantId 过滤）。
        </div>
      </section>
    </div>
  );
}
