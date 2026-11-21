/**
 * 批次4 · 协议适配纯转换层测试。
 *
 * 覆盖 Anthropic / Gemini ⇄ OpenAI 的语法互译，以及 ADR-030 的「不支持字段显式报错」。
 *
 * 运行：npm run build 后 `node --test "dist/test/adapters.test.js"`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicToOpenAI, anthropicContentToText, openAIToAnthropicMessage, mapFinishReasonToAnthropic, geminiToOpenAI, geminiPartsToText, openAIToGemini, mapFinishReasonToGemini, buildStreamErrorFrame, UnsupportedFieldError, } from '../gateway/adapters.js';
/* ---------------- Anthropic → OpenAI ---------------- */
test('anthropicToOpenAI：system(string) + user/assistant 文本', () => {
    const out = anthropicToOpenAI({
        model: 'claude-x',
        system: '你是助手',
        messages: [
            { role: 'user', content: '你好' },
            { role: 'assistant', content: '在的' },
        ],
        max_tokens: 128,
    });
    assert.equal(out.model, 'claude-x');
    assert.equal(out.max_tokens, 128);
    assert.deepEqual(out.messages, [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '在的' },
    ]);
});
test('anthropicToOpenAI：system/blocks 拼接 text 块', () => {
    const out = anthropicToOpenAI({
        model: 'm',
        system: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        max_tokens: 8,
    });
    assert.equal(out.messages[0].content, 'AB');
    assert.equal(out.messages[1].content, 'hi');
});
test('anthropicToOpenAI：缺 max_tokens 抛错（Anthropic 必填）', () => {
    assert.throws(() => anthropicToOpenAI({ model: 'm', messages: [], max_tokens: undefined }), /max_tokens/);
});
test('anthropicContentToText：非 text 块（image/tool_use）显式报错，不静默丢', () => {
    assert.throws(() => anthropicContentToText([{ type: 'image' }]), UnsupportedFieldError);
    assert.throws(() => anthropicContentToText(123), UnsupportedFieldError);
});
test('openAIToAnthropicMessage：响应结构与 stop_reason 映射', () => {
    const msg = openAIToAnthropicMessage({
        id: 'chatcmpl-1',
        model: 'gpt-x',
        choices: [{ message: { content: '答案' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
    });
    assert.equal(msg.type, 'message');
    assert.equal(msg.role, 'assistant');
    assert.deepEqual(msg.content, [{ type: 'text', text: '答案' }]);
    assert.equal(msg.stop_reason, 'end_turn');
    assert.deepEqual(msg.usage, { input_tokens: 10, output_tokens: 3 });
});
test('mapFinishReasonToAnthropic：length→max_tokens、tool_calls→tool_use', () => {
    assert.equal(mapFinishReasonToAnthropic('length'), 'max_tokens');
    assert.equal(mapFinishReasonToAnthropic('tool_calls'), 'tool_use');
    assert.equal(mapFinishReasonToAnthropic('stop'), 'end_turn');
    assert.equal(mapFinishReasonToAnthropic(null), null);
});
/* ---------------- Gemini → OpenAI ---------------- */
test('geminiToOpenAI：systemInstruction + contents(user/model)', () => {
    const out = geminiToOpenAI({
        systemInstruction: { parts: [{ text: 'sys' }] },
        contents: [
            { role: 'user', parts: [{ text: 'q' }] },
            { role: 'model', parts: [{ text: 'a' }] },
        ],
        generationConfig: { maxOutputTokens: 64, temperature: 0.5 },
    }, 'gemini-x');
    assert.deepEqual(out.messages, [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
    ]);
    assert.equal(out.max_tokens, 64);
    assert.equal(out.temperature, 0.5);
});
test('geminiPartsToText：非 text part（inlineData/functionCall）显式报错', () => {
    assert.throws(() => geminiPartsToText([{ text: 'ok' }, {}]), UnsupportedFieldError);
});
test('openAIToGemini：响应结构与 finishReason 映射', () => {
    const g = openAIToGemini({
        choices: [{ message: { content: 'hi' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
    });
    assert.deepEqual(g.candidates[0].content.parts, [{ text: 'hi' }]);
    assert.equal(g.candidates[0].finishReason, 'MAX_TOKENS');
    assert.equal(g.usageMetadata.promptTokenCount, 5);
    assert.equal(g.usageMetadata.candidatesTokenCount, 2);
});
test('mapFinishReasonToGemini：length→MAX_TOKENS、content_filter→SAFETY', () => {
    assert.equal(mapFinishReasonToGemini('length'), 'MAX_TOKENS');
    assert.equal(mapFinishReasonToGemini('content_filter'), 'SAFETY');
    assert.equal(mapFinishReasonToGemini('stop'), 'STOP');
});
/* ---------------- 流式中途失败帧（REQ-03/ADR-028） ---------------- */
test('buildStreamErrorFrame：SSE error 帧（body 内 error + finish_reason:"error"）', () => {
    const frame = buildStreamErrorFrame({
        reason: 'stream_interrupted',
        message: '上游中途中断',
        upstream: 'agnes',
        recoverable: true,
    });
    assert.ok(frame.startsWith('data: '), 'SSE data: 前缀');
    assert.ok(frame.endsWith('\n\n'), 'SSE 空行分隔');
    const body = JSON.parse(frame.slice('data: '.length));
    assert.equal(body.error.type, 'upstream_error');
    assert.equal(body.error.param, null, 'param 补齐为 null（schema 必填）');
    assert.equal(body.error.code, 'stream_interrupted');
    assert.equal(body.error.relay_attribution.failure_reason, 'stream_interrupted');
    assert.equal(body.error.relay_attribution.upstream, 'agnes');
    assert.equal(body.choices[0].finish_reason, 'error');
    assert.equal(body.choices[0].delta.content, '');
});
test('buildStreamErrorFrame：缺省 upstream=unknown、suggested_next.action 回退', () => {
    const frame = buildStreamErrorFrame({ reason: 'upstream_timeout', message: 'x' });
    const body = JSON.parse(frame.slice('data: '.length));
    assert.equal(body.error.relay_attribution.upstream, 'unknown');
    assert.equal(body.error.relay_attribution.suggested_next.action, 'retry_same');
});
//# sourceMappingURL=adapters.test.js.map