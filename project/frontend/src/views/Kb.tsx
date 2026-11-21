import { useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";
import { api } from "../api";
import type { KbDoc, KbFull, KbSearchHit, KbStateFull } from "../types";
import { copyText, downloadText, esc, formatNumber, rowA11y, toast, TS, writeErr } from "../ui";
import { closeDrawer, openDrawer } from "../drawer";

/* ---------------- 批量灌入解析（manual#95）：'# 标题' 开头、'---' 分段，预览先于灌入 ---------------- */

interface BatchParse {
  docs: { title: string; content: string }[];
  errors: string[];
  truncated: number;
}

function parseBatch(text: string): BatchParse {
  const sections: string[][] = [];
  let cur: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "---") {
      sections.push(cur);
      cur = [];
    } else cur.push(line);
  }
  sections.push(cur);
  const docs: { title: string; content: string }[] = [];
  const errors: string[] = [];
  for (const sec of sections) {
    const nonEmpty = sec.filter((l) => l.trim());
    if (!nonEmpty.length) continue;
    const first = nonEmpty[0].trim();
    if (first.indexOf("# ") === 0) {
      const idx = sec.indexOf(nonEmpty[0]);
      docs.push({ title: first.slice(2).trim(), content: sec.slice(idx + 1).join("\n").trim() });
    } else {
      errors.push(first.slice(0, 24));
    }
  }
  // 50 篇上限（manual#150）：预览阶段就截断并明示，与服务端「单次上限 50 篇」对上
  const truncated = docs.length > 50 ? docs.length - 50 : 0;
  return { docs: docs.slice(0, 50), errors, truncated };
}

/* ---------------- ask 调用命令（manual#106）：key 与模型都用占位符（#402 白名单按原名校验） ---------------- */

function askCmd(kbId: string): string {
  return (
    "curl -s " +
    location.origin +
    "/v1/kb/" +
    encodeURIComponent(kbId) +
    "/ask" +
    ' -H "authorization: Bearer <你的key>" -H "content-type: application/json" -d ' +
    "'" +
    '{"model":"<这把key可用的模型>","question":"你的问题","topK":5}' +
    "'"
  );
}

/* ---------------- 批量灌入抽屉（实时解析预览：篇数+标题+缺标题报错+超 50 截断） ---------------- */

function BatchForm(props: { kbId: string; onDone: () => void }) {
  const [text, setText] = useState("");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const r = parseBatch(text);

  const parts: JSX.Element[] = [];
  if (r.docs.length)
    parts.push(
      <>
        将灌入 <b>{r.docs.length}</b> 篇：{r.docs.map((d) => d.title).join(" / ")}
      </>,
    );
  if (r.errors.length)
    parts.push(
      <span class="err">
        {r.errors.length} 段缺少 # 标题行：{r.errors.join(" / ")}
      </span>,
    );
  if (r.truncated)
    parts.push(
      <span class="warn">
        解析到 {r.docs.length + r.truncated} 篇，超出单次 50 篇上限，仅灌入前 50 篇（其余 {r.truncated} 篇请分批）
      </span>,
    );
  if (!parts.length) parts.push(<>粘贴后这里显示解析预览</>);

  const go = async () => {
    if (!r.docs.length || busy) return;
    setBusy(true);
    try {
      // 失败明细直达（manual#181）：当场列出前三条失败+余量，修复再灌的成本从「翻日志」降到「读 toast」
      const resp = await api<any>("kb/" + encodeURIComponent(props.kbId) + "/docs/batch", {
        method: "POST",
        body: JSON.stringify({
          docs: r.docs.map((d) => ({ title: d.title, content: d.content, source: source.trim() || "batch" })),
        }),
      });
      closeDrawer();
      let failTail = "";
      if (resp.failCount) {
        const fails = (resp.results || []).filter((x: any) => !x.ok);
        const shown = fails.slice(0, 3).map((x: any) => "「" + esc(x.title || "?") + "」" + esc(x.error || ""));
        failTail =
          "，失败 <b>" +
          resp.failCount +
          "</b> 篇：" +
          shown.join("；") +
          (fails.length > 3 ? "；等 " + fails.length + " 条（完整记录见事件日志）" : "");
      }
      toast("批量灌入完成：成功 <b>" + resp.okCount + "</b> 篇" + failTail, resp.failCount ? "y" : "g");
      props.onDone();
    } catch (e: any) {
      const w = writeErr("批量灌入", e);
      toast(w.text, w.tone);
      setBusy(false);
    }
  };

  return (
    <>
      <div class="note">
        格式：每篇以 <span class="mono"># 标题</span> 开头，篇与篇之间用<b>单独一行</b> <span class="mono">---</span>{" "}
        分隔；单次上限 50 篇。逐篇灌入，单篇失败不影响其余。
      </div>
      <div class="f">
        <label>粘贴区</label>
        <textarea rows={12} value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
      </div>
      <div class="muted-sm">
        {parts.map((p, i) => (
          <>
            {i > 0 ? <br /> : null}
            {p}
          </>
        ))}
      </div>
      <div class="f">
        <label>来源标注（可选）</label>
        <input placeholder="batch" value={source} onInput={(e) => setSource((e.target as HTMLInputElement).value)} />
      </div>
      <div class="hstack-end">
        <button class="bare" onClick={closeDrawer}>
          取消
        </button>
        <button class="pri" disabled={busy || !r.docs.length} onClick={go}>
          {busy ? "处理中…" : "确认灌入"}
        </button>
      </div>
    </>
  );
}

/* ---------------- 编辑文档抽屉（manual#94）：PUT 替换，分块重算，ID 会变 ---------------- */

function EditDocForm(props: { kbId: string; docId: string | number; doc: KbDoc; onDone: () => void }) {
  const d = props.doc;
  const [title, setTitle] = useState(d.title || "");
  const [source, setSource] = useState(d.source || "");
  const [content, setContent] = useState(d.content || "");

  const save = async () => {
    if (!title.trim() || !content.trim()) return toast("标题与正文必填", "r");
    try {
      const r = await api<any>("kb/" + encodeURIComponent(props.kbId) + "/docs/" + props.docId, {
        method: "PUT",
        body: JSON.stringify({ title: title.trim(), content, source: source.trim() || "api" }),
      });
      closeDrawer();
      toast(
        "已替换文档：新 ID " + (r.doc && r.doc.id) + " · " + formatNumber(r.doc && r.doc.chunkCount) + " 分块",
        "g",
      );
      props.onDone();
    } catch (e: any) {
      const w = writeErr("保存文档", e);
      toast(w.text, w.tone);
    }
  };

  return (
    <>
      <div class="note">
        保存 = <b>替换</b>：删除旧文档并重新灌入，分块立即重算，<b>文档 ID 会变</b>（内部替换，审计事件
        kb.doc_replace）。
      </div>
      <div class="f">
        <label>标题</label>
        <input maxlength={128} value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} />
      </div>
      <div class="f">
        <label>来源</label>
        <input value={source} onInput={(e) => setSource((e.target as HTMLInputElement).value)} />
      </div>
      <div class="f">
        <label>
          正文（当前 {formatNumber((d.content || "").length)} 字 · {formatNumber(d.chunkCount)} 分块）
        </label>
        <textarea rows={10} value={content} onInput={(e) => setContent((e.target as HTMLTextAreaElement).value)} />
      </div>
      <div class="hstack-end">
        <button class="bare" onClick={closeDrawer}>
          取消
        </button>
        <button class="pri" onClick={save}>
          保存替换
        </button>
      </div>
    </>
  );
}

/* ---------------- KB 元数据编辑抽屉（manual#97）：名称不可改，可改描述/允许 key/owner ---------------- */

function KbMetaForm(props: { k: KbFull; onDone: () => void }) {
  const [desc, setDesc] = useState(props.k.description || "");
  const [keys, setKeys] = useState(props.k.allowedKeys || "*");
  const [owner, setOwner] = useState(props.k.owner || "");

  const save = async () => {
    try {
      await api("kb/" + encodeURIComponent(props.k.id), {
        method: "PUT",
        body: JSON.stringify({ description: desc.trim(), allowedKeys: keys.trim() || "*", owner: owner.trim() }),
      });
      closeDrawer();
      toast("已更新知识库 <b>" + esc(props.k.name) + "</b>", "g");
      props.onDone();
    } catch (e: any) {
      const r = writeErr("保存知识库", e);
      toast(r.text, r.tone);
    }
  };

  return (
    <>
      <div class="note">
        名称 <b>{props.k.name}</b> 不可修改（id 与名称是检索/调用的锚点）。可改：描述、允许调用的 key、归属。
      </div>
      <div class="f">
        <label>描述（≤256 字；留空=清除）</label>
        <input maxlength={256} value={desc} onInput={(e) => setDesc((e.target as HTMLInputElement).value)} />
      </div>
      <div class="f">
        <label>允许 key（* = 全部；多个用逗号分隔）</label>
        <input value={keys} onInput={(e) => setKeys((e.target as HTMLInputElement).value)} />
      </div>
      <div class="f">
        <label>归属（owner，≤64 字；留空=清除）</label>
        <input maxlength={64} value={owner} onInput={(e) => setOwner((e.target as HTMLInputElement).value)} />
      </div>
      <div class="hstack-end">
        <button class="bare" onClick={closeDrawer}>
          取消
        </button>
        <button class="pri" onClick={save}>
          保存
        </button>
      </div>
    </>
  );
}

/* ---------------- 文档面板（点 KB 行展开：灌入/过滤/编辑/删/导出/检索） ---------------- */

function DocsPanel(props: { kbId: string }) {
  const [docs, setDocs] = useState<KbDoc[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const [title, setTitle] = useState("");
  const [source, setSource] = useState("");
  const [content, setContent] = useState("");
  const [fq, setFq] = useState("");

  const [sq, setSq] = useState("");
  const [topk, setTopk] = useState("5");
  const [rag, setRag] = useState(false);
  const [res, setRes] = useState<{ results: KbSearchHit[]; chunks: boolean } | null>(null);

  const reload = () => setTick((t) => t + 1);

  useEffect(() => {
    let alive = true;
    (async () => {
      setErr(null);
      try {
        const d = await api<any>("kb/" + encodeURIComponent(props.kbId) + "/docs");
        if (alive) setDocs(d.docs || []);
      } catch (e: any) {
        if (alive) setErr(e && e.message ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [tick]);

  if (err) return <div class="note bad">文档加载失败：{err}——稍后重试或重新点开该库</div>;
  if (!docs) return <div class="skel" style="height:180px;margin-top:var(--s4)" />;

  const enterAdd = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addDoc();
    }
  };

  async function addDoc() {
    const t = title.trim();
    const c = content.trim();
    if (!t || !c) return toast("标题与正文必填", "r");
    try {
      await api("kb/" + encodeURIComponent(props.kbId) + "/docs", {
        method: "POST",
        body: JSON.stringify({ title: t, content: c, source: source.trim() }),
      });
      toast("已加文档");
      reload();
    } catch (e: any) {
      const r = writeErr("加文档", e);
      toast(r.text, r.tone);
    }
  }

  const exportJson = () => {
    const payload = {
      kbId: props.kbId,
      exportedAt: new Date().toISOString(),
      count: docs!.length,
      docs: docs!.map((d) => ({
        id: d.id,
        title: d.title,
        source: d.source || "",
        content: d.content || "",
        chunkCount: d.chunkCount,
        createdAt: d.createdAt,
      })),
    };
    downloadText(
      "api-relay-kb-" + props.kbId + "-" + new Date().toISOString().slice(0, 10) + ".json",
      JSON.stringify(payload, null, 2),
      "application/json",
    );
    toast("已导出 <b>" + docs!.length + "</b> 篇文档（JSON，含正文）", "g");
  };

  const delDoc = async (doc: KbDoc) => {
    if (
      !confirm(
        "删除文档 #" +
          doc.id +
          "「" +
          doc.title +
          "」？它的 " +
          formatNumber(doc.chunkCount) +
          " 个分块将一并删除，不可恢复。",
      )
    )
      return;
    try {
      await api("kb/" + encodeURIComponent(props.kbId) + "/docs/" + doc.id, { method: "DELETE" });
      toast("已删文档");
      reload();
    } catch (e: any) {
      const r = writeErr("删文档", e);
      toast(r.text, r.tone);
    }
  };

  const editDoc = async (docId: string | number) => {
    let d: any;
    try {
      d = await api("kb/" + encodeURIComponent(props.kbId) + "/docs/" + docId);
    } catch (e: any) {
      toast("加载文档失败：" + esc(e.message), "r");
      return;
    }
    openDrawer({
      title: "编辑文档 #" + docId,
      body: <EditDocForm kbId={props.kbId} docId={docId} doc={d.doc || {}} onDone={reload} />,
    });
  };

  const search = async () => {
    const q = sq.trim();
    if (!q) return toast("查询不能为空", "r");
    try {
      const r = await api<any>("kb/" + encodeURIComponent(props.kbId) + "/search", {
        method: "POST",
        body: JSON.stringify({ query: q, topK: Number(topk || 5), chunks: rag }),
      });
      setRes({ results: r.results || [], chunks: !!r.chunks });
    } catch (e: any) {
      setRes(null);
      const w = writeErr("检索", e);
      toast(w.text, w.tone);
    }
  };

  const hitDrawer = (h: KbSearchHit) => {
    openDrawer({
      title: (
        <>
          分块 #{h.seq} · {h.docTitle}
        </>
      ),
      body: (
        <>
          <div class="note">
            得分 <span class="mono">{h.score}</span> · 来自文档 <span class="mono">#{String(h.docId)}</span>（
            {h.docTitle}）· 全文 {formatNumber(h.text.length)} 字
          </div>
          <pre>{h.text}</pre>
        </>
      ),
      foot: (
        <>
          <button class="bare" onClick={() => copyText(h.text, "分块全文已复制")}>
            复制全文
          </button>
          <button class="pri" onClick={closeDrawer}>
            关闭
          </button>
        </>
      ),
    });
  };

  const q = fq.trim().toLowerCase();
  const shown = q
    ? docs!.filter(
        (d) =>
          String(d.title).toLowerCase().includes(q) ||
          String(d.id).includes(q) ||
          String(d.source || "").toLowerCase().includes(q),
      )
    : docs!;

  return (
    <div style="margin-top:var(--s4)">
      <h3>文档 · {props.kbId}</h3>
      <div style="display:flex;gap:var(--s2);align-items:center;margin-bottom:8px;flex-wrap:wrap">
        <button
          title="导出本库全部文档为 JSON（备份/审阅/清理前留底用——含 id/标题/来源/正文/分块数，可直接送人）"
          onClick={exportJson}
        >
          导出 JSON
        </button>
        <span class="muted-xs">
          docs 接口本就返回正文，导出零额外请求；篇数多时文件较大属正常
        </span>
      </div>
      <div class="note" style="margin:0 0 8px">
        灌入文档：
        <div style="display:flex;gap:var(--s2);flex-wrap:wrap">
          <input
            maxlength={128}
            placeholder="标题（≤128 字）"
            style="min-width:180px"
            value={title}
            onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
            onKeyDown={enterAdd}
          />
          <input
            placeholder="来源（可选）"
            style="min-width:160px"
            value={source}
            onInput={(e) => setSource((e.target as HTMLInputElement).value)}
            onKeyDown={enterAdd}
          />
          <textarea
            rows={3}
            placeholder="正文"
            style="min-width:300px;flex:1"
            value={content}
            onInput={(e) => setContent((e.target as HTMLTextAreaElement).value)}
          />
          <button onClick={addDoc}>加文档</button>
          <button
            title="一次灌入多篇（# 标题 开头，--- 分隔）"
            onClick={() =>
              openDrawer({ title: "批量灌入 · " + props.kbId, body: <BatchForm kbId={props.kbId} onDone={reload} /> })
            }
          >
            批量…
          </button>
        </div>
      </div>
      <input
        placeholder="🔍 过滤文档（标题 / id / 来源）"
        style="width:100%;margin-bottom:8px"
        value={fq}
        onInput={(e) => setFq((e.target as HTMLInputElement).value)}
      />
      <table>
        <thead>
          <tr>
            <th>id</th>
            <th>标题</th>
            <th>来源</th>
            <th>分块</th>
            <th class="act">操作</th>
          </tr>
        </thead>
        <tbody>
          {shown.length ? (
            shown.map((doc) => (
              <tr key={String(doc.id)}>
                <td class="mono">{String(doc.id)}</td>
                <td
                  style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
                  title={doc.title}
                >
                  {doc.title}
                </td>
                <td>{doc.source || ""}</td>
                <td class="mono">{formatNumber(doc.chunkCount)}</td>
                <td class="act">
                  <button onClick={() => editDoc(doc.id)}>编辑</button> {" "}
                  <button class="danger" onClick={() => delDoc(doc)}>
                    删
                  </button>
                </td>
              </tr>
            ))
          ) : (
            <tr>
              <td colspan={5} class="dim">
                {q ? "没有匹配「" + q + "」的文档" : "尚无文档"}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div class="note" style="margin:14px 0 8px">
        检索（中文任意词；英文<b>整词</b>匹配——<span class="mono">k.tier</span>/<span class="mono">TIER_LABEL</span>{" "}
        算一个词，搜 <span class="mono">tier</span> 不中；无词干化，搜不到时换个写法）：
        <div style="display:flex;gap:var(--s2);flex-wrap:wrap">
          <input
            placeholder="查询，如：失败归因"
            style="min-width:260px"
            value={sq}
            onInput={(e) => setSq((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                search();
              }
            }}
          />
          <input
            type="number"
            min="1"
            max="20"
            placeholder="topK"
            value={topk}
            style="width:70px"
            title="取前几篇相关文档（1-20；按文档去重，同一篇不重复出现）"
            onInput={(e) => setTopk((e.target as HTMLInputElement).value)}
          />
          <label
            class="sub"
            style="align-self:center"
            title="勾选后不去重、直接回 topK 个原始分块——即客户端 ask 的检索口径（同一篇可占多席）；默认按文档去重（每篇取其最高分块）"
          >
            <input type="checkbox" checked={rag} onChange={(e) => setRag((e.target as HTMLInputElement).checked)} /> RAG
            视角
          </label>
          <button onClick={search}>检索</button>
        </div>
      </div>
      <div style="margin-top:var(--s2)">
        {res ? (
          <>
            <div class="dim" style="font-size:var(--fs-sm);margin-bottom:4px">
              {res.chunks ? (
                <>
                  RAG 视角：{formatNumber(res.results.length)} 块来自{" "}
                  {formatNumber(new Set(res.results.map((h) => h.docId)).size)} 篇（客户端 ask
                  的检索口径，同一篇可占多席）
                </>
              ) : (
                <>
                  文档视角：{formatNumber(res.results.length)} 篇（每篇取其最高分块；勾选『RAG
                  视角』看引擎实际引用的块）
                </>
              )}
            </div>
            {res.results.length ? (
              <table>
                <thead>
                  <tr>
                    <th>分块</th>
                    <th>文档</th>
                    <th>得分</th>
                    <th>内容</th>
                  </tr>
                </thead>
                <tbody>
                  {res.results.map((h) => (
                    <tr key={h.seq} {...rowA11y("点击看全文")}>
                      <td class="mono fit">
                        <button class="row-act" onClick={() => hitDrawer(h)} aria-label="点击看全文" />
                        #{h.seq}
                      </td>
                      <td>
                        {h.docTitle} <span class="dim mono" style="font-size:var(--fs-xs)">#{String(h.docId)}</span>
                      </td>
                      <td class="mono">{h.score}</td>
                      <td style="max-width:520px;white-space:pre-wrap">
                        {h.text.slice(0, 400)}
                        {h.text.length > 400 ? <span class="dim"> …（点击展开全文）</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div class="dim">未检索到相关内容。</div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

/* ---------------- 主视图 ---------------- */

export function Kb() {
  const [state, setState] = useState<KbStateFull | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [docsKb, setDocsKb] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [allowed, setAllowed] = useState("");
  const [kid, setKid] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      setErr(null);
      try {
        const s = await api<KbStateFull>("kb");
        if (alive) setState(s);
      } catch (e: any) {
        if (e && e.status === 404) {
          if (alive) setState({ enabled: false });
          return;
        }
        if (alive) setErr(e && e.message ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [tick]);

  if (err) {
    return (
      <section class="block">
        <h2>知识库</h2>
        <div class="note bad">加载失败：{err}——稍后点右上角 ↻ 重试</div>
      </section>
    );
  }
  if (!state) {
    return (
      <section class="block">
        <h2>知识库</h2>
        <div class="skel" style="height:220px" />
      </section>
    );
  }

  const refresh = () => setTick((t) => t + 1);

  if (!state.enabled) {
    return (
      <div>
        <div class="note">
          <b>知识库能力未启用。</b>在配置里加一段 <span class="mono">kb.path</span>（例如{" "}
          <span class="mono">data/kb.db</span>）后重启网关即可创建知识库。 启用后本页可：创建 KB → 灌入文档 → 检索
          → 通过 <span class="mono">POST /v1/kb/{"{id}"}/ask</span> 让模型带上你的知识作答。
        </div>
        <div class="muted-sm">
          当前健康：{state.health ? esc(JSON.stringify(state.health)) : "（未配置）"}
        </div>
        <div class="note" style="margin-top:var(--s4)">
          客户端问答端点（带 Bearer key）：
          <pre>{`POST /v1/kb/<id>/ask
Content-Type: application/json
Authorization: Bearer <key>

{ "model": "<这把 key 可用的模型>", "question": "...", "topK": 5 }`}</pre>
          <div class="dim" style="font-size:var(--fs-sm);margin-top:6px">
            <b>model 必填</b>（ask 把检索结果注入后走 chat 链路，没有默认模型——不带会 404
            model_not_found）；可用模型见 GET /v1/models 或本页模型别名。
            <b>别名/档位阶梯名（如「极速-any」）对白名单 key 不可用</b>（manual#402
            实测）：白名单按**请求原名**校验——白名单 key 用 ladder 名会 403
            model_not_allowed（报文带你这把 key 的可用清单），不带白名单的 key
            才能用别名；白名单 key 请填白名单内的真实模型名。topK 取值 1-20（缺省 5，检索块数，超上限自动钳制；边界值
            0/超限不会报错）；question 也接受 query 别名。该 KB 若设了允许的 key 白名单，其他 key 会收到
            403。<b>响应是 OpenAI 兼容的 chat.completion</b>（choices/usage
            等标准字段）——检索到的内容已注入进 prompt；模型的回答<b>通常</b>会用 [1][2] 标注引用了第几块（manual#387
            实测纠偏：这是<b>模型行为不是保证</b>——同一问题复测出现过零标注的 196B
            回答，客户端解析勿依赖引用标注存在，按纯 Markdown 读 content）；没有独立的 hits
            数组（那是管理面检索的形状，两边别混）。注意：管理面检索按文档去重（同一篇不重复出现），客户端 ask
            是分块级 top-K（RAG 喂料用）。<b>实测响应示例</b>（manual#337，#326 e2e
            实录，问『网关迭代优化的运维注意事项』topK=3）：
            <pre>{`{
  "object": "chat.completion",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "# 网关迭代优化运维注意事项[1]\\n\\n## 一、迭代方法纪律[1]\\n1. 先读错题本……"
    },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 1229, "completion_tokens": 1594, "total_tokens": 2823 }
}`}</pre>
            content 是Markdown 文本，[1] 对应检索注入的第 1 块（块数=topK，本次 3 块全部命中和运维基线相关文档）；usage
            的 prompt_tokens 含注入的检索内容。解析时只读 choices[0].message.content 与 finish_reason 即可。
          </div>
        </div>
      </div>
    );
  }

  const kbs = state.kbs || [];

  const create = async () => {
    if (!name.trim()) return toast("名称必填", "r");
    try {
      await api("kb", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          description: desc.trim(),
          allowedKeys: allowed.trim() || "*",
          ...(kid.trim() ? { id: kid.trim() } : {}),
        }),
      });
      toast("已创建知识库");
      refresh();
    } catch (e: any) {
      const r = writeErr("创建知识库", e);
      toast(r.text, r.tone);
    }
  };

  const enterCreate = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      create();
    }
  };

  const deleteKb = async (k: KbFull) => {
    if (!confirm("删除知识库「" + k.name + "」（" + k.id + "）？该库的全部文档与分块将一并删除，不可恢复。"))
      return;
    try {
      await api("kb/delete", { method: "POST", body: JSON.stringify({ id: k.id }) });
      toast("已删除知识库 <b>" + esc(k.name) + "</b>", "y");
      if (docsKb === k.id) setDocsKb(null);
      refresh();
    } catch (e: any) {
      toast("删除失败：" + esc(e.message), "r");
    }
  };

  return (
    <div>
      <div class="note">
        <b>垂直 Agent 知识库。</b>每个知识库可独立灌入文档、按关键词检索（中英文 bigram + TF 加权），再通过{" "}
        <span class="mono">/v1/kb/{"{id}"}/ask</span> 让模型基于你的知识作答。零依赖、可离线。
      </div>
      <section class="block">
        <h2>创建知识库</h2>
        <div class="note" style="margin:0 0 8px">
          必填：名称（唯一）；可选：描述 / 允许访问的 key（逗号分隔，* = 全部 key）/ 显式 id（小写字母数字与 -）
        </div>
        <div style="display:flex;gap:var(--s2);flex-wrap:wrap;margin-bottom:8px">
          <input
            maxlength={64}
            placeholder="名称（唯一，≤64 字）"
            style="min-width:220px"
            value={name}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
            onKeyDown={enterCreate}
          />
          <input
            maxlength={256}
            placeholder="描述（可选，≤256 字）"
            style="min-width:200px"
            value={desc}
            onInput={(e) => setDesc((e.target as HTMLInputElement).value)}
            onKeyDown={enterCreate}
          />
          <input
            maxlength={256}
            placeholder="allowedKeys（* = 全部）"
            style="min-width:180px"
            value={allowed}
            onInput={(e) => setAllowed((e.target as HTMLInputElement).value)}
            onKeyDown={enterCreate}
          />
          <input
            placeholder="显式 id（可选）"
            style="min-width:160px"
            value={kid}
            onInput={(e) => setKid((e.target as HTMLInputElement).value)}
            onKeyDown={enterCreate}
          />
          <button onClick={create}>创建</button>
        </div>
      </section>
      <section class="block">
        <h2>
          知识库列表 <span class="spacer" />{" "}
          <span class="muted-xs" style="text-transform:none">
            点行看文档；编辑改描述/允许 key（manual#97）
          </span>
        </h2>
        <div>
          <table>
            <thead>
              <tr>
                <th>id</th>
                <th>名称</th>
                <th>描述</th>
                <th>允许 key</th>
                <th>文档</th>
                <th>分块</th>
                <th>字节</th>
                <th>创建时间</th>
                <th class="act">操作</th>
              </tr>
            </thead>
            <tbody>
              {kbs.length ? (
                kbs.map((k) => (
                  <tr
                    key={k.id}
                    {...rowA11y("查看该知识库的文档列表")}
                  >
                    <td class="mono fit">
                      <button class="row-act" onClick={() => setDocsKb(k.id)} aria-label="查看该知识库的文档列表" />
                      {k.id}
                    </td>
                    <td>{k.name}</td>
                    <td>{k.description || ""}</td>
                    <td>{k.allowedKeys || "*"}</td>
                    <td class="mono">{formatNumber(k.stats && k.stats.docs)}</td>
                    <td class="mono">{formatNumber(k.stats && k.stats.chunks)}</td>
                    <td class="mono">{formatNumber(k.stats && k.stats.bytes)}</td>
                    <td class="mono dim" style="font-size:var(--fs-xs)">
                      {k.createdAt ? TS(k.createdAt) : "-"}
                    </td>
                    <td class="act">
                      <button
                        title="重新拉取该库的规模统计（后端 GET kb/{id}/stats，独立于列表内联统计）"
                        onClick={async () => {
                          try {
                            const r = await api<any>(`kb/${encodeURIComponent(k.id)}/stats`);
                            const s = (r && r.stats) || {};
                            toast(
                              "「" + esc(k.name) + "」统计：文档 " + formatNumber(s.docs) + " · 分块 " + formatNumber(s.chunks) + " · 字节 " + formatNumber(s.bytes),
                              "g",
                            );
                          } catch (e: any) {
                            toast("拉取统计失败：" + esc(e.message), "r");
                          }
                        }}
                      >
                        统计
                      </button>{" "}
                      <button
                        title="复制该库的 ask 调用命令（垂直 Agent 的问答入口）"
                        onClick={() =>
                          copyText(
                            askCmd(k.id),
                            "ask 命令已复制——把 <你的key> 和 <模型> 换成真实值（模型必须在这把 key 的白名单内；GET /v1/models 可列出你这把 key 能用的）",
                          )
                        }
                      >
                        ask 命令
                      </button>{" "}
                      <button
                        onClick={() =>
                          openDrawer({
                            title: "编辑知识库 · " + k.name,
                            body: <KbMetaForm k={k} onDone={refresh} />,
                          })
                        }
                      >
                        编辑
                      </button>{" "}
                      <button class="danger" onClick={() => deleteKb(k)}>
                        删除
                      </button>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colspan={9} class="dim">
                    尚无知识库，先创建一个
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {docsKb ? <DocsPanel key={docsKb} kbId={docsKb} /> : null}
      </section>
    </div>
  );
}
