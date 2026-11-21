/**
 * 协议适配 · 纯转换层（批次4 · REQ-05/06）。
 *
 * 只做**语法互译**：Anthropic Messages / Gemini generateContent ⇄ OpenAI Chat。
 * 不含路由、预检、归因、计量——那些在 engine 的统一链路里保持口径一致（ADR-011）。
 * 本层是纯函数：无副作用、无 IO，便于单测直接驱动。
 *
 * 边界（ADR-030）：只承诺**子集**；遇到不支持字段**显式抛 `UnsupportedFieldError`**，
 * 绝不静默丢语义（静默降级比报错更危险——客户端以为成功、实际语义已丢）。
 */
/** 不支持字段错误（ADR-030：显式报错，不静默丢弃） */
export class UnsupportedFieldError extends Error {
    field;
    protocol;
    constructor(field, protocol) {
        super(`协议 ${protocol} 的字段 ${field} 不受支持（显式报错，不静默丢弃）`);
        this.field = field;
        this.protocol = protocol;
        this.name = 'UnsupportedFieldError';
    }
}
/** Anthropic content（string 或 text blocks）→ 纯文本；非 text 块显式报错。 */
export function anthropicContentToText(content, field = 'content') {
    if (typeof content === 'string')
        return content;
    if (Array.isArray(content)) {
        let out = '';
        for (const b of content) {
            if (!b || typeof b !== 'object')
                continue;
            const t = b.type;
            if (t === 'text') {
                out += String(b.text ?? '');
                continue;
            }
            throw new UnsupportedFieldError(`${field}[].${String(t)}`, 'anthropic');
        }
        return out;
    }
    throw new UnsupportedFieldError(field, 'anthropic');
}
/** Anthropic Messages 请求 → OpenAI Chat 请求 */
export function anthropicToOpenAI(req) {
    if (!req || typeof req.model !== 'string' || !req.model)
        throw new Error('缺少 model');
    if (typeof req.max_tokens !== 'number')
        throw new Error('Anthropic 请求必须带 max_tokens');
    const messages = [];
    if (req.system !== undefined) {
        messages.push({ role: 'system', content: anthropicContentToText(req.system, 'system') });
    }
    for (const m of req.messages ?? []) {
        if (m.role !== 'user' && m.role !== 'assistant') {
            throw new UnsupportedFieldError(`messages[].role=${String(m.role)}`, 'anthropic');
        }
        messages.push({ role: m.role, content: anthropicContentToText(m.content, 'messages[].content') });
    }
    return {
        model: req.model,
        messages,
        max_tokens: req.max_tokens,
        ...(req.stream !== undefined ? { stream: req.stream } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    };
}
/** OpenAI Chat 响应 → Anthropic Message 响应 */
export function openAIToAnthropicMessage(resp) {
    const choice = resp.choices?.[0];
    return {
        id: resp.id ?? 'msg_relay',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: choice?.message?.content ?? '' }],
        model: resp.model ?? '',
        stop_reason: mapFinishReasonToAnthropic(choice?.finish_reason ?? null),
        usage: {
            input_tokens: Number(resp.usage?.prompt_tokens ?? 0),
            output_tokens: Number(resp.usage?.completion_tokens ?? 0),
        },
    };
}
export function mapFinishReasonToAnthropic(fr) {
    if (fr === 'length')
        return 'max_tokens';
    if (fr === 'stop' || fr === null)
        return fr === null ? null : 'end_turn';
    if (fr === 'tool_calls')
        return 'tool_use';
    if (fr === 'content_filter')
        return 'stop_sequence';
    return fr;
}
/** Gemini parts → 纯文本；非 text part 显式报错。 */
export function geminiPartsToText(parts, field = 'parts') {
    let out = '';
    for (const p of parts ?? []) {
        if (p && typeof p.text === 'string') {
            out += p.text;
            continue;
        }
        throw new UnsupportedFieldError(`${field}[]（非 text part，如 inlineData/functionCall）`, 'gemini');
    }
    return out;
}
/** Gemini generateContent 请求 → OpenAI Chat 请求 */
export function geminiToOpenAI(req, model) {
    if (!model)
        throw new Error('缺少 model');
    const messages = [];
    if (req.systemInstruction) {
        messages.push({ role: 'system', content: geminiPartsToText(req.systemInstruction.parts, 'systemInstruction.parts') });
    }
    for (const c of req.contents ?? []) {
        const role = c.role === 'model' ? 'assistant' : 'user';
        messages.push({ role, content: geminiPartsToText(c.parts, 'contents[].parts') });
    }
    return {
        model,
        messages,
        ...(req.generationConfig?.maxOutputTokens !== undefined ? { max_tokens: req.generationConfig.maxOutputTokens } : {}),
        ...(req.generationConfig?.temperature !== undefined ? { temperature: req.generationConfig.temperature } : {}),
    };
}
/** OpenAI Chat 响应 → Gemini generateContent 响应 */
export function openAIToGemini(resp) {
    const choice = resp.choices?.[0];
    return {
        candidates: [
            {
                content: { role: 'model', parts: [{ text: choice?.message?.content ?? '' }] },
                finishReason: mapFinishReasonToGemini(choice?.finish_reason ?? 'stop'),
            },
        ],
        usageMetadata: {
            promptTokenCount: Number(resp.usage?.prompt_tokens ?? 0),
            candidatesTokenCount: Number(resp.usage?.completion_tokens ?? 0),
        },
    };
}
export function mapFinishReasonToGemini(fr) {
    if (fr === 'length')
        return 'MAX_TOKENS';
    if (fr === 'tool_calls')
        return 'STOP';
    if (fr === 'content_filter')
        return 'SAFETY';
    return 'STOP';
}
/**
 * 构造 SSE `error` 帧（ADR-028）。
 *
 * 语义：HTTP 200 已提交、无法回退状态码，故用「body 内 error + `finish_reason:"error"`」
 * 表达中途失败（对齐 OpenRouter 已定的行业口径）。**free 层不注入**由调用方（engine）把关。
 *
 * 纯函数：可单测；补齐 OpenAI schema 必填字段（type/param/code）。
 */
export function buildStreamErrorFrame(opts) {
    const payload = {
        error: {
            message: opts.message,
            type: 'upstream_error',
            param: null,
            code: opts.reason,
            relay_attribution: {
                failure_reason: opts.reason,
                suggested_next: {
                    action: opts.suggestedAction ?? 'retry_same',
                    ...(opts.retryAfterMs !== undefined ? { retryAfterMs: opts.retryAfterMs } : {}),
                },
                recoverable: opts.recoverable ?? true,
                upstream: opts.upstream ?? 'unknown',
                confidence: 1,
            },
        },
        choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }],
    };
    return 'data: ' + JSON.stringify(payload) + '\n\n';
}
//# sourceMappingURL=adapters.js.map