/**
 * Agent 对话视图（v3 主题 7）。
 *
 * 与「Agent」页（巡检）互补：这里是人跟 Agent 的多轮对话，Agent 会先调只读工具
 * 取证（get_metrics / list_events / get_provider / search_kb …）再回答。
 *
 * 注意：此处**不走** api() 封装——它的 AbortController 固定 30s，而一轮对话含工具
 * 循环可能跑到 1~2 分钟，会被误判超时。故用自定义 fetch（默认 180s）。
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { getToken } from "../api";

type Msg = {
  role: "user" | "assistant";
  content: string;
  toolCalls?: string[];
  model?: string;
  tokens?: string;
  durationMs?: number;
};

const LINE = "1px solid var(--border)";
const BUBBLE_USER = "color-mix(in srgb, var(--accent) 20%, transparent)";
const BUBBLE_BOT = "color-mix(in srgb, var(--panel2) 60%, transparent)";

async function chatCall(messages: { role: string; content: string }[], timeoutMs = 180000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const token = getToken();
  try {
    const res = await fetch("/admin/api/agent/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { "X-Admin-Token": token } : {}),
      },
      body: JSON.stringify({ messages }),
      signal: ac.signal,
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error?.message || "HTTP " + res.status);
    return body;
  } catch (e: any) {
    if (e && e.name === "AbortError") throw new Error("对话超时（" + Math.round(timeoutMs / 1000) + "s）——模型较慢，可稍后重试");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export function AgentChat() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs.length, busy]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setErr(null);
    const next: Msg[] = [...msgs, { role: "user", content: text }];
    setMsgs(next);
    setInput("");
    setBusy(true);
    try {
      const r = await chatCall(next.map((m) => ({ role: m.role, content: m.content })));
      setMsgs([
        ...next,
        {
          role: "assistant",
          content: r.reply || "(空回复)",
          toolCalls: Array.isArray(r.toolCalls) ? r.toolCalls : [],
          model: r.model,
          tokens: (r.promptTokens ?? 0) + "/" + (r.completionTokens ?? 0),
          durationMs: r.durationMs,
        },
      ]);
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const ke = e as KeyboardEvent & { shiftKey: boolean };
    if (e.key === "Enter" && !ke.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div>
      <div class="page-head" style={{ marginBottom: "var(--s3)" }}>
        <h2 style={{ margin: 0 }}>Agent 对话</h2>
        <span class="dim" style={{ marginLeft: "var(--s3)" }}>
          多轮对话 · Agent 先调只读工具取证再回答（get_metrics / list_events / get_provider / search_kb …）
        </span>
      </div>

      <div style={{ maxWidth: "920px", display: "flex", flexDirection: "column", gap: "var(--s3)" }}>
        <div
          ref={listRef}
          style={{
            minHeight: "320px",
            maxHeight: "58vh",
            overflowY: "auto",
            border: LINE,
            borderRadius: "var(--r2)",
            padding: "var(--s3)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--s3)",
          }}
        >
          {msgs.length === 0 && (
            <div class="dim">
              输入问题开始对话。例如：「现在网关健康吗？用工具查一下」/「最近 1 小时有哪些失败归因？」/「知识库里关于限流的沉淀是什么？」
            </div>
          )}

          {msgs.map((m, i) => (
            <div
              key={i}
              style={{
                alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                maxWidth: "88%",
                background: m.role === "user" ? BUBBLE_USER : BUBBLE_BOT,
                border: LINE,
                borderRadius: "var(--r2)",
                padding: "var(--s2) var(--s3)",
              }}
            >
              <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.content}</div>
              {m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0 && (
                <div class="dim" style={{ marginTop: "var(--s2)", fontSize: "var(--fs-sm)" }}>
                  工具：{m.toolCalls.join(" → ")}
                  {m.model ? " · " + m.model : ""}
                  {m.tokens ? " · " + m.tokens + " tok" : ""}
                  {typeof m.durationMs === "number" ? " · " + m.durationMs + "ms" : ""}
                </div>
              )}
            </div>
          ))}

          {busy && <div class="dim">Agent 思考中…（含工具取证，最长约 2 分钟）</div>}
        </div>

        {err && <div style={{ color: "var(--err)" }}>对话失败：{err}</div>}

        <div class="hstack" style={{ alignItems: "flex-start" }}>
          <textarea
            value={input}
            rows={3}
            placeholder="输入问题；Enter 发送，Shift+Enter 换行"
            onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
            onKeyDown={onKeyDown as any}
            style={{
              flex: 1,
              resize: "vertical",
              border: LINE,
              borderRadius: "var(--r1)",
              padding: "var(--s2)",
              background: "transparent",
              color: "inherit",
              font: "inherit",
            }}
          />
          <button onClick={send} disabled={busy} style={{ padding: "var(--s2) var(--s4)", cursor: busy ? "default" : "pointer" }}>
            {busy ? "…" : "发送"}
          </button>
        </div>

        <div class="hstack">
          <button onClick={() => { setMsgs([]); setErr(null); }} disabled={busy}>
            清空对话
          </button>
          <span class="dim" style={{ alignSelf: "center", fontSize: "var(--fs-sm)" }}>
            对话记录仅存于本页内存；每轮会写入审计事件 agent.chat。
          </span>
        </div>
      </div>
    </div>
  );
}