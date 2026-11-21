/**
 * key 生命周期 handler（P2 拆分第四层，第三刀 —— 最大的一组）。
 *
 * 从 AdminApi 切出：创建 / whoami / 更新 / 停用 / 删除 / 轮换 / 重置配额，
 * 外加两个内部辅助（keyIdOf 三态解析、unknownModels 白名单体检）。
 *
 * ⚠️ budgetWatch 是**共享可变状态**：AdminApi 的 5 分钟预算巡检与这里的 del()
 * 操作同一个 Map。与 g-v429 那个 agent 坑的区别在于——这里传的是 Map 的**引用**，
 * 且该引用从不被重新赋值（只有 get/set/delete），所以共享是安全的。
 * 若将来改成「每次调用传一个新 Map」或「整体替换 budgetWatch」，就会静默失效。
 */
import { json, badRequest, notFoundOrBad } from '../response.js';
export class KeyHandlers {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    /**
     * allowedModels 里未被任何上游声明的模型（manual#263，advisory 不断绝）。
     *
     * 场景：key 白名单是自由文本数组（GUI 有 datalist 防打错 #262，但 API 调用方/
     * 粘贴旧配置仍可能带入拼错的模型名）——拼错的模型名静默入库后，客户调它全部
     * 404，而排查时要翻到网关层才发现『模型不存在』。这里在创建/更新响应里带回
     * unknownModels 警告字段（不阻断：运营可能先配白名单再接上游）。
     */
    unknownModels(models) {
        if (!models || models.length === 0)
            return [];
        const declared = new Set(this.deps.router.reachability().map((r) => r.model));
        return models.filter((m) => !declared.has(m));
    }
    create(res, body, actor) {
        if (!body)
            return badRequest(res, '缺少请求体');
        const tiers = Object.keys(this.deps.config.tiers);
        // 严格类型验证（manual#145，续 #144 的强转族修复）：tier/配额/有效期/标签这些字段，
        // 「给了但类型不对」必须 400，不能静默默认/丢弃——tier:null 静默落 standard、
        // quotaOverride:-100 照收，都是把调用方的 bug 洗成数据错误。
        const validateString = (field, v, dflt) => {
            if (v === undefined || v === null)
                return dflt;
            if (typeof v !== 'string') {
                badRequest(res, `${field} 必须为字符串`);
                return undefined;
            }
            return v.trim();
        };
        const validateNumber = (field, v, min) => {
            if (v === undefined || v === null)
                return undefined;
            if (typeof v !== 'number' || !Number.isFinite(v) || v < min) {
                badRequest(res, `${field} 必须为 ≥${min} 的数字`);
                return undefined;
            }
            return v;
        };
        // tier:null 也拒绝（manual#145）：静默默认 standard 会把「本想建 pro」的调用方
        // 洗成一个标准层 key——分层是计费/路由语义，错了比报错更糟。
        const tierRaw = body['tier'];
        if (tierRaw !== undefined && typeof tierRaw !== 'string')
            return badRequest(res, 'tier 必须为字符串（缺省 standard）');
        const tier = typeof tierRaw === 'string' && tierRaw.trim() ? tierRaw.trim() : 'standard';
        if (!tiers.includes(tier))
            return badRequest(res, `未知分层 ${tier}，可选: ${tiers.join(' / ')}`);
        const label = validateString('label', body['label']);
        if (res.writableEnded)
            return true;
        // label 长度上限（manual#151）：KB name 早有 ≤64，key label 却裸奔——5000 字 label
        // 会被存库、撑爆 keys 表格单元格、进 toast。与 KB name 同口径。
        if (label && label.length > 64)
            return badRequest(res, 'label ≤64 字（可选）');
        // label 非空校验（challenge#1·R1）：纯空格 label 不接受——空 label 会让 keys 表格
        // 出现无意义空行，排障时无法区分。label 可选但给了就必须非空。
        // 注意：空字符串等价于未提供（label 可选），只有纯空格才拒绝。
        if (typeof body['label'] === 'string' && body['label'].length > 0 && (!label || label.length === 0)) {
            return badRequest(res, 'label 不能为纯空格');
        }
        // label 唯一性约束（challenge#1·R2）：同名 label 不允许——并发 create 同名 key
        // 全部 201 会导致 keys 表格出现无法区分的重复行，排障/删除/更新都够不着。
        // M-07 修复：hasLabel 直接遍历 KeyRecord（O(n)、无排序、无视图构造），
        // 替代 listKeys().find(...)（全量排序 + toView 拷贝）。口径与 create/update 共用。
        if (label && this.deps.keys.hasLabel(label)) {
            return badRequest(res, `label "${label}" 已存在`);
        }
        const tenantId = validateString('tenantId', body['tenantId'], 'default');
        if (res.writableEnded)
            return true;
        // tenantId 格式校验（SEC-008）：只允许字母数字下划线连字符，≤64 字——
        // 如果 tenantId 在下游被用于 SQL 查询或文件路径，无格式校验可能导致注入。
        if (tenantId && !/^[a-zA-Z0-9_-]{1,64}$/.test(tenantId)) {
            return badRequest(res, 'tenantId 只允许字母数字下划线连字符，≤64 字');
        }
        const allowedModelsRaw = body['allowedModels'];
        let allowedModels;
        if (allowedModelsRaw !== undefined && allowedModelsRaw !== null) {
            if (!Array.isArray(allowedModelsRaw) || allowedModelsRaw.some((m) => typeof m !== 'string' || m.length === 0)) {
                return badRequest(res, 'allowedModels 必须为字符串数组');
            }
            allowedModels = allowedModelsRaw.filter((m) => m.length > 0);
        }
        const expiresInDays = validateNumber('expiresInDays', body['expiresInDays'], 0);
        if (res.writableEnded)
            return true;
        const expiresAt = validateNumber('expiresAt', body['expiresAt'], 0);
        if (res.writableEnded)
            return true;
        const quotaOverride = validateNumber('quotaOverride', body['quotaOverride'], 0);
        if (res.writableEnded)
            return true;
        const quotaCny = validateNumber('quotaCny', body['quotaCny'], 0);
        if (res.writableEnded)
            return true;
        const secret = typeof body['secret'] === 'string' && body['secret'].length > 0 ? body['secret'] : undefined;
        // secret 长度限制（SEC-007）：≤256 字符——超长 secret 增加存储和哈希计算负担。
        if (secret && secret.length > 256)
            return badRequest(res, 'secret ≤256 字符');
        try {
            const created = this.deps.keys.create({
                // M-06 修复：导出类型后不再需要 `as never`（tier 已在上方用 tiers 白名单校验过）
                tier: tier,
                tenantId: tenantId ?? 'default',
                ...(label ? { label } : {}),
                ...(allowedModels && allowedModels.length > 0 ? { allowedModels } : {}),
                ...(expiresAt !== undefined ? { expiresAt } : expiresInDays !== undefined ? { expiresAt: Date.now() + expiresInDays * 86_400_000 } : {}),
                ...(quotaOverride !== undefined ? { quotaOverride } : {}),
                ...(quotaCny !== undefined ? { quotaCny } : {}),
                ...(secret ? { secret } : {}),
                ...(actor ? { actor } : {}),
            });
            // 明文只在这里出现一次；前端必须立刻展示并提示"只显示一次"
            const unknown = this.unknownModels(allowedModels);
            return json(res, 201, {
                ok: true,
                secret: created.secret,
                secretNotice: '这是唯一一次显示明文 key。服务端只保存 sha256 哈希，无法再次查看，请立即保存。',
                key: created.record,
                ...(unknown.length ? { unknownModels: unknown } : {}),
            });
        }
        catch (err) {
            // P2 修复：区分客户端错误（400）和服务端错误（500）
            const msg = err instanceof Error ? err.message : String(err);
            // 客户端错误：label 已存在、参数校验失败等
            if (msg.includes('已存在') || msg.includes('label') || msg.includes('duplicate')) {
                return badRequest(res, msg);
            }
            // 服务端错误：数据库错误、内部错误等
            this.deps.logger.error('admin.key_create_failed', { error: msg, actor });
            return json(res, 500, { error: { message: '创建 key 失败，请稍后重试', type: 'internal_error', code: 'key_create_failed' } });
        }
    }
    /**
     * key 自检：把"我手上这个 key"交给服务端换算指纹，回答"它是不是这里签发的、还能不能用"。
     *
     * 这是"API 全 401 但不知道错在哪"最短的排查路径：用户不用懂哈希，也不用把 key 发到别处。
     * 明文只参与本次计算，不写日志、不落盘、不进台账。
     */
    whoami(res, body) {
        const secret = typeof body?.['secret'] === 'string' ? body['secret'].trim() : '';
        if (!secret)
            return badRequest(res, '缺少 secret（把你正在使用的 key 贴进来）');
        const r = this.deps.keys.resolveSecret(secret);
        const explain = {
            ok: '这个 key 有效，可以直接用。如果仍然 401，请确认发的是 Authorization: Bearer <key>（少了 Bearer 或多了空格都会对不上）。',
            key_disabled: '这个 key 是本网关签发的，但已被禁用。到本页把它重新启用即可。',
            expired_key: '这个 key 是本网关签发的，但已过期。请轮换出一个新 key。',
            not_issued: '这个 key 不是本网关当前签发的任何一个。最常见的原因是还在用旧 key（轮换或删除后立即作废），' +
                '或者误把上游厂商的 key 当成了 relay key。请用本页顶部的已签发 key 指纹核对。',
        };
        // key 富化（manual#254）：resolveSecret 回的是裸 toView（无 policy）——GUI whoami 的
        // 档位策略行（#216 加的）读 r.key.policy 永远是 undefined，那一行从来没渲染过。
        // 与 keysView 同构补上 policy（policyFor(tier) 全量，含 periodQuotaCny）。
        const enriched = r.key
            ? {
                ...r,
                key: {
                    ...r.key,
                    policy: (() => {
                        const p = this.deps.keys.policyFor(r.key.tier);
                        return {
                            precheck: p.precheck, attribution: p.attribution, rpm: p.rpm,
                            maxConcurrency: p.maxConcurrency, billing: p.billing, smartRouting: p.smartRouting,
                            periodQuotaTokens: p.periodQuotaTokens, periodQuotaCny: p.periodQuotaCny,
                        };
                    })(),
                },
            }
            : r;
        return json(res, 200, {
            ...enriched,
            explanation: explain[r.status] ?? '',
        });
    }
    /**
     * keyId 解析（manual#367 写侧审计）：区分「没给」与「给错类型」——此前两种都回
     * 『缺少 keyId』，API 消费者收到误导报文（keyId:123 明明给了却说缺）。三态：
     * ok=可用 / missing=未提供 / type=提供了但类型或内容不对。
     */
    keyIdOf(body) {
        const v = body?.['keyId'];
        if (v === undefined || v === null)
            return { ok: false, err: '缺少 keyId' };
        if (typeof v !== 'string' || !v.trim())
            return { ok: false, err: 'keyId 必须为非空字符串' };
        return { ok: true, id: v.trim() };
    }
    update(res, body, actor) {
        const kid = this.keyIdOf(body);
        if (!kid.ok)
            return badRequest(res, kid.err);
        const keyId = kid.id;
        // M-06 修复：用导出的 KeyUpdatePatch 类型构造补丁，替代 `Record<string, unknown>`
        // + 末尾 `patch as never` 的双重弱化。
        const patch = {};
        if (typeof body['label'] === 'string') {
            const lbl = body['label'].trim();
            if (lbl.length > 64)
                return badRequest(res, 'label ≤64 字');
            patch.label = lbl;
        }
        if (typeof body['tier'] === 'string')
            patch.tier = body['tier'];
        if (typeof body['enabled'] === 'boolean')
            patch.enabled = body['enabled'];
        if (body['allowedModels'] === null)
            patch.allowedModels = null;
        else if (Array.isArray(body['allowedModels']))
            patch.allowedModels = body['allowedModels'].filter((m) => typeof m === 'string' && m.length > 0);
        // 数值字段下限校验（manual#146，与 #145 keyCreate 对齐）：update 与 create 同一族——
        // 负配额/负余额上限/过去方向的 NaN 都会被 typeof number 洗进来，导致额度逻辑错乱。
        const updNum = (field, v, min) => {
            if (v === null)
                return null;
            if (v === undefined)
                return undefined;
            if (typeof v !== 'number' || !Number.isFinite(v) || v < min) {
                badRequest(res, `${field} 必须为 ≥${min} 的数字`);
                return undefined;
            }
            return v;
        };
        const updExpiresAt = updNum('expiresAt', body['expiresAt'], 0);
        if (res.writableEnded)
            return true;
        if (updExpiresAt !== undefined)
            patch.expiresAt = updExpiresAt;
        const updQuota = updNum('quotaOverride', body['quotaOverride'], 0);
        if (res.writableEnded)
            return true;
        if (updQuota !== undefined)
            patch.quotaOverride = updQuota;
        const updQuotaCny = updNum('quotaCny', body['quotaCny'], 0);
        if (res.writableEnded)
            return true;
        if (updQuotaCny !== undefined)
            patch.quotaCny = updQuotaCny;
        if (Object.keys(patch).length === 0)
            return badRequest(res, '没有可更新的字段');
        try {
            const view = this.deps.keys.update(keyId, patch, actor);
            // unknownModels 警告（manual#263）：与 create 同款——本次若更新了 allowedModels，
            // 把其中未声明的模型名带回（advisory 不阻断）。
            const unknown = Array.isArray(patch.allowedModels)
                ? this.unknownModels(patch.allowedModels)
                : [];
            return json(res, 200, { ok: true, key: view, ...(unknown.length ? { unknownModels: unknown } : {}) });
        }
        catch (err) {
            return notFoundOrBad(res, err);
        }
    }
    revoke(res, body, actor) {
        const kid = this.keyIdOf(body);
        if (!kid.ok)
            return badRequest(res, kid.err);
        const keyId = kid.id;
        try {
            const view = this.deps.keys.revoke(keyId, actor);
            return json(res, 200, {
                ok: true,
                key: view,
                note: view.origin === 'config' ? '该 key 来自配置文件，已禁用；如需彻底移除请改配置并重启' : '该 key 已吊销（历史度量保留）',
            });
        }
        catch (err) {
            return notFoundOrBad(res, err);
        }
    }
    // 删除面板 key（manual#306）：能力层 remove() 一直存在、keysView 也一直暴露 deletable
    // 字段（『配置里的 key 删了重启还会回来，所以只能禁用』），但 admin 层从未注册删除端点——
    // deletable 的设计意图半途而废，历轮测试残留（19 个 disabled+0 请求的 panel key）只能躺列。
    // 删除只限 panel 来源（config key 拒了并指引改配置），审计事件留痕（key.delete）。
    del(res, body, actor) {
        const kid = this.keyIdOf(body);
        if (!kid.ok)
            return badRequest(res, kid.err);
        const keyId = kid.id;
        // M-07 修复：findView 定位目标（不排序、不构造全量视图）
        const target = this.deps.keys.findView(keyId);
        if (!target)
            return json(res, 404, { error: { message: 'key 不存在', type: 'not_found_error', code: 'not_found' } });
        if (target.origin === 'voucher') {
            return badRequest(res, '券兑换的 key 是核销凭证，不支持删除；如需停用请用 revoke');
        }
        if (target.origin !== 'panel') {
            return badRequest(res, '该 key 来自配置文件，删了重启还会回来——请停用（revoke）或改配置后重启');
        }
        const ok = this.deps.keys.remove(keyId);
        if (!ok)
            return json(res, 404, { error: { message: 'key 不存在或已删除', type: 'not_found_error', code: 'not_found' } });
        // B2（审查修复·能力层根因）：remove() 现在会硬删持久层的 key_meta（store.deleteKeyMeta），
        // 面板 key 删除后重启不再复活——此前的"墓碑（清空 keyHash）"绕过已不再需要，一并移除。
        // 删除留痕由下方 key.delete 事件承担审计（含 label/tier/tenantId/actor）。
        // F6 修复：key 删除时同步清理 budgetWatch
        this.deps.budgetWatch.delete(keyId);
        this.deps.store.logEvent('warn', 'key.delete', {
            keyId,
            tier: target.tier,
            tenantId: target.tenantId,
            label: target.label,
            ...(actor ? { actor } : {}),
        });
        return json(res, 200, {
            ok: true,
            deleted: keyId,
            note: '该 key 已彻底删除（度量与审计事件保留）',
        });
    }
    rotate(res, body, actor) {
        const kid = this.keyIdOf(body);
        if (!kid.ok)
            return badRequest(res, kid.err);
        const keyId = kid.id;
        try {
            const created = this.deps.keys.rotate(keyId, actor);
            return json(res, 200, {
                ok: true,
                secret: created.secret,
                secretNotice: '新 key 只显示这一次；旧 key 已立即失效，请及时更新客户端配置。',
                key: created.record,
            });
        }
        catch (err) {
            return notFoundOrBad(res, err);
        }
    }
    resetQuota(res, body) {
        const kid = this.keyIdOf(body);
        if (!kid.ok)
            return badRequest(res, kid.err);
        const keyId = kid.id;
        try {
            const result = this.deps.keys.resetQuota(keyId);
            return json(res, 200, {
                ok: true,
                ...result,
                note: '额度周期已从此刻重新起算；历史度量不受影响（可审计）',
            });
        }
        catch (err) {
            return notFoundOrBad(res, err);
        }
    }
}
//# sourceMappingURL=keys.js.map