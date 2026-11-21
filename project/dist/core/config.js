/**
 * 配置加载、默认值与校验。
 *
 * 优先级：内置默认 < YAML 文件 < 环境变量（RELAY_*）< CLI 参数。
 * 所有密钥一律走 {ENV:NAME} 插值，配置文件中不允许出现明文 key。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseYaml, interpolateTree } from './yaml.js';
// 单向依赖：core → agent/matrix（matrix.ts 运行期不 import 任何模块，不构成循环依赖）。
// 决策矩阵的默认值与校验口径只有一处真相，避免 config 与 runner 各写一套阈值。
import { normalizeMatrixConfig, validateMatrixConfig } from '../agent/matrix.js';
import { ownLookup, sha256Hex } from '../util/index.js';
export const DEFAULT_CONFIG_PATH = 'config/relay.yaml';
export const DEFAULT_TIERS = {
    free: {
        id: 'free',
        label: '免费引流层',
        precheck: 'off',
        attribution: 'off',
        meterDetail: false,
        smartRouting: false,
        rpm: 20,
        maxConcurrency: 4,
        billing: 'none',
        periodQuotaTokens: 200_000,
        priority: 0,
    },
    standard: {
        id: 'standard',
        label: '标准层（按 token）',
        precheck: 'observe',
        attribution: 'header',
        meterDetail: true,
        smartRouting: false,
        rpm: 300,
        maxConcurrency: 32,
        billing: 'token',
        periodQuotaTokens: null,
        priority: 10,
    },
    pro: {
        id: 'pro',
        label: 'Pro 层（订阅 + 降损全开）',
        precheck: 'enforce',
        attribution: 'full',
        meterDetail: true,
        smartRouting: true,
        rpm: 1200,
        maxConcurrency: 128,
        billing: 'subscription',
        periodQuotaTokens: 5_000_000,
        priority: 20,
    },
};
export function defaultLossReduction() {
    return {
        precheck: {
            enabled: true,
            onBlock: 'reject',
            budgetUs: 3_000,
            maxMessages: 512,
            maxTools: 128,
            // max_tokens 绝对天花板：模型没声明 modelMaxTokens 时的兜底（那道检查此前是死代码，
            // max_tokens=1e308 能穿过预检）。运营可调。
            maxTokensCeiling: 1_000_000,
            dangerousCommandPatterns: [
                'rm\\s+-rf\\s+/(?!\\w)',
                'mkfs(\\.|\\s)',
                'dd\\s+if=.*of=/dev/',
                ':(){:\\|:&};:',
                'chmod\\s+-R\\s+777\\s+/',
                '>\\s*/dev/sd[a-z]',
                'curl[^\\n]*\\|\\s*(ba)?sh',
                'wget[^\\n]*\\|\\s*(ba)?sh',
            ],
        },
        attribution: {
            enabled: true,
            includeEvidence: false,
            autoRetry: 1,
            // 精确模型名请求时用同档后继模型补齐阶梯：横向换供应商耗尽后，仍能沿运营
            // 声明过的等价档竖向换模型，而不是把 429 丢回客户端。置 false 退回单阶。
            siblingModelFallback: true,
            backoffBaseMs: 400,
            backoffMaxMs: 8_000,
            retryableReasons: [
                'rate_limited',
                'upstream_timeout',
                'upstream_unavailable',
                'network_error',
                'model_overloaded',
                'stream_interrupted',
            ],
            breakerThreshold: 5,
            breakerCooldownMs: 30_000,
        },
        meter: {
            enabled: true,
            batchSize: 200,
            flushIntervalMs: 2_000,
            retentionDays: 30,
            hashPayloads: true,
            hashSalt: '',
        },
        trace: {
            enabled: true,
            ringSize: 500,
            persist: true,
            maxSteps: 64,
        },
        fingerprint: {
            enabled: true,
            agentThreshold: 0.6,
        },
    };
}
export function defaultConfig() {
    return {
        server: {
            host: '127.0.0.1',
            port: 8787,
            trustProxy: false,
            // C-04：是否被同机隧道/反代前置；true 时公开端点不再信任 remoteAddress
            behindProxy: false,
            // 防上游探测：默认关，对外服务时由配置显式开启
            hideUpstream: false,
            publicQuota: true,
            maxBodyBytes: 8 * 1024 * 1024,
            upstreamTimeoutMs: 600_000,
            upstreamTtfbTimeoutMs: 120_000,
            // 默认关闭：提前提交会牺牲 passthrough 头，按部署显式开启（relay-net.yaml 已开）。
            streamCommitGraceMs: 0,
            streamHeartbeatMs: 5_000,
            // 默认关闭：对冲会翻倍上游调用，按部署显式开启（relay-net.yaml 已开）。
            hedgeDelayMs: 0,
            shutdownGraceMs: 8_000,
        },
        storage: { driver: 'sqlite', path: 'data/relay.db' },
        // REQ-01：共享状态默认走内存实现（单机），存量配置零改动
        state: { backend: 'local', failOpenOnRedisDown: true },
        lossReduction: defaultLossReduction(),
        tiers: structuredClone(DEFAULT_TIERS),
        providers: [],
        clients: [],
        modelAliases: {},
        logLevel: 'info',
    };
}
/** 深合并：数组与标量整体替换，对象递归合并 */
export function deepMerge(base, patch) {
    if (patch === undefined || patch === null)
        return base;
    if (Array.isArray(patch))
        return patch;
    if (typeof patch !== 'object')
        return patch;
    if (typeof base !== 'object' || base === null || Array.isArray(base)) {
        return patch;
    }
    const out = { ...base };
    for (const [k, v] of Object.entries(patch)) {
        out[k] = k in out ? deepMerge(out[k], v) : v;
    }
    return out;
}
export function loadConfigDetailed(options = {}) {
    const env = options.env ?? process.env;
    const path = options.path ?? env['RELAY_CONFIG'] ?? DEFAULT_CONFIG_PATH;
    const abs = resolve(path);
    const missingEnv = [];
    let config = defaultConfig();
    config.sourcePath = abs;
    if (existsSync(abs)) {
        const text = readFileSync(abs, 'utf8');
        const parsed = parseYaml(text);
        if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) {
            throw new Error(`配置文件顶层必须是映射对象: ${abs}`);
        }
        const onMissing = options.lenientEnv
            ? (name) => {
                if (!missingEnv.includes(name))
                    missingEnv.push(name);
            }
            : undefined;
        const interpolated = interpolateTree(parsed ?? {}, env, onMissing);
        config = deepMerge(config, interpolated);
        // 占位符还原为空串，避免把 __MISSING_ENV_X__ 当成真 key 用于校验
        if (options.lenientEnv)
            config = blankPlaceholders(config);
    }
    else if (options.requireFile !== false) {
        throw new Error(`配置文件不存在: ${abs}（可用 RELAY_CONFIG 指定，或从 config/relay.example.yaml 复制）`);
    }
    config = applyEnvOverrides(config, env, options.override);
    if (!options.lenientEnv)
        validateConfig(config);
    // 校验**之后**才补默认值：先让非法值在 validateConfig 里以中文错误抛出，
    // 而不是被归一化（钳制）静默纠错——"配置写错了却跑起来"比启动失败更难查。
    config = normalizeAgentMatrixDefaults(config);
    if (!config.lossReduction.meter.hashSalt) {
        config.lossReduction.meter.hashSalt = env['RELAY_HASH_SALT'] ?? sha256Hex(`salt:${abs}`).slice(0, 32);
    }
    return { config, missingEnv };
}
/** 便捷版：只要配置对象（默认严格校验） */
export function loadConfig(options = {}) {
    return loadConfigDetailed(options).config;
}
/**
 * 补齐 Agent 决策矩阵默认值（agent 段的"规范化"）。
 *
 * 语义：
 *   - 没有 agent 段 → 原样返回，不新增任何字段（未使用 Agent 的部署零行为变化）；
 *   - 有 agent 段但没写 decisionMatrix → 写入完整默认值，其中 **enabled=false**，
 *     即"存在但关闭"：runner 不会调用矩阵、不会写 matrix 事件，行为与引入该能力前一致；
 *   - 已配置 → 归一化成完整的 ResolvedMatrixConfig（补权重/阈值/历史深度），
 *     供 runner 与未来的管理面直接读取，不用到处判 undefined。
 *
 * 注意：这里只补默认值，**不做纠错**——越界/拼错在 inspectConfig 里报中文错误，
 * 且本函数必须在校验之后调用，否则非法值会被钳制后"看起来合法"。
 */
export function normalizeAgentMatrixDefaults(config) {
    if (!config.agent)
        return config;
    config.agent.decisionMatrix = normalizeMatrixConfig(config.agent.decisionMatrix);
    return config;
}
/** 把 __MISSING_ENV_X__ 占位符替换回空串 */
function blankPlaceholders(value) {
    if (typeof value === 'string')
        return value.replace(/__MISSING_ENV_[A-Za-z0-9_]+__/g, '');
    if (Array.isArray(value))
        return value.map(blankPlaceholders);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value))
            out[k] = blankPlaceholders(v);
        return out;
    }
    return value;
}
function envInt(env, key) {
    const v = env[key];
    if (v === undefined || v === '')
        return undefined;
    const n = Number(v);
    if (!Number.isFinite(n))
        throw new Error(`环境变量 ${key} 必须是数字，当前值: ${v}`);
    return n;
}
function envBool(env, key) {
    const v = env[key];
    if (v === undefined || v === '')
        return undefined;
    return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}
export function applyEnvOverrides(config, env = process.env, override) {
    const patch = {};
    const port = envInt(env, 'RELAY_PORT');
    const host = env['RELAY_HOST'];
    const logLevel = env['RELAY_LOG_LEVEL'];
    const adminToken = env['RELAY_ADMIN_TOKEN'];
    const dbPath = env['RELAY_DB_PATH'];
    const storageDriver = env['RELAY_STORAGE_DRIVER'];
    const trustProxy = envBool(env, 'RELAY_TRUST_PROXY');
    const behindProxy = envBool(env, 'RELAY_BEHIND_PROXY');
    const precheckEnabled = envBool(env, 'RELAY_PRECHECK_ENABLED');
    const attributionEnabled = envBool(env, 'RELAY_ATTRIBUTION_ENABLED');
    const meterEnabled = envBool(env, 'RELAY_METER_ENABLED');
    const traceEnabled = envBool(env, 'RELAY_TRACE_ENABLED');
    patch.server = {};
    if (port !== undefined)
        patch.server.port = port;
    if (host !== undefined)
        patch.server.host = host;
    if (adminToken !== undefined)
        patch.server.adminToken = adminToken;
    // 面板登录账号（v1.4.0）：ADMIN 全权、VIEWER 只读
    const adminUser = env['RELAY_ADMIN_USER'];
    const adminPass = env['RELAY_ADMIN_PASSWORD'];
    if (adminUser !== undefined || adminPass !== undefined) {
        patch.server.adminLogin = {
            ...(adminUser !== undefined ? { username: adminUser } : {}),
            ...(adminPass !== undefined ? { password: adminPass } : {}),
        };
    }
    const viewerUser = env['RELAY_VIEWER_USER'];
    const viewerPass = env['RELAY_VIEWER_PASSWORD'];
    if (viewerUser !== undefined || viewerPass !== undefined) {
        patch.server.viewerLogin = {
            ...(viewerUser !== undefined ? { username: viewerUser } : {}),
            ...(viewerPass !== undefined ? { password: viewerPass } : {}),
        };
    }
    // 业务运营账号（批次1·多租户/RBAC）：operator 角色，缺省不启用
    const operatorUser = env['RELAY_OPERATOR_USER'];
    const operatorPass = env['RELAY_OPERATOR_PASSWORD'];
    if (operatorUser !== undefined || operatorPass !== undefined) {
        patch.server.operatorLogin = {
            ...(operatorUser !== undefined ? { username: operatorUser } : {}),
            ...(operatorPass !== undefined ? { password: operatorPass } : {}),
        };
    }
    if (trustProxy !== undefined)
        patch.server.trustProxy = trustProxy;
    if (behindProxy !== undefined)
        patch.server.behindProxy = behindProxy;
    if (dbPath !== undefined || storageDriver !== undefined) {
        patch.storage = {};
        if (dbPath !== undefined)
            patch.storage.path = dbPath;
        if (storageDriver === 'sqlite' || storageDriver === 'memory')
            patch.storage.driver = storageDriver;
    }
    // 共享状态后端（REQ-01）：RELAY_STATE_BACKEND / RELAY_STATE_FAIL_OPEN / RELAY_STATE_KEY_PREFIX
    const stateBackend = env['RELAY_STATE_BACKEND'];
    const stateFailOpen = envBool(env, 'RELAY_STATE_FAIL_OPEN');
    const stateKeyPrefix = env['RELAY_STATE_KEY_PREFIX'];
    if (stateBackend !== undefined || stateFailOpen !== undefined || stateKeyPrefix !== undefined) {
        const prefix = stateKeyPrefix ?? config.state?.keyPrefix;
        patch.state = {
            // 只接受已知取值，避免拼错时静默变内存
            backend: stateBackend === 'local' || stateBackend === 'redis' ? stateBackend : (config.state?.backend ?? 'local'),
            failOpenOnRedisDown: stateFailOpen ?? config.state?.failOpenOnRedisDown ?? true,
            ...(prefix !== undefined ? { keyPrefix: prefix } : {}),
        };
    }
    // 知识库（垂直 Agent 能力）：环境变量 RELAY_KB_PATH / RELAY_KB_CHUNK_SIZE / RELAY_KB_CHUNK_OVERLAP
    const kbPath = env['RELAY_KB_PATH'];
    const kbChunkSize = envInt(env, 'RELAY_KB_CHUNK_SIZE');
    const kbChunkOverlap = envInt(env, 'RELAY_KB_CHUNK_OVERLAP');
    if (kbPath !== undefined || kbChunkSize !== undefined || kbChunkOverlap !== undefined) {
        patch.kb = {};
        if (kbPath !== undefined)
            patch.kb.path = kbPath;
        if (kbChunkSize !== undefined)
            patch.kb.chunkSize = kbChunkSize;
        if (kbChunkOverlap !== undefined)
            patch.kb.chunkOverlap = kbChunkOverlap;
    }
    patch.lossReduction = {};
    if (precheckEnabled !== undefined || attributionEnabled !== undefined || meterEnabled !== undefined || traceEnabled !== undefined) {
        patch.lossReduction.precheck = {};
        patch.lossReduction.attribution = {};
        patch.lossReduction.meter = {};
        patch.lossReduction.trace = {};
        if (precheckEnabled !== undefined)
            patch.lossReduction.precheck.enabled = precheckEnabled;
        if (attributionEnabled !== undefined)
            patch.lossReduction.attribution.enabled = attributionEnabled;
        if (meterEnabled !== undefined)
            patch.lossReduction.meter.enabled = meterEnabled;
        if (traceEnabled !== undefined)
            patch.lossReduction.trace.enabled = traceEnabled;
    }
    if (logLevel !== undefined)
        patch.logLevel = logLevel;
    let merged = deepMerge(config, patch);
    if (override)
        merged = deepMerge(merged, override);
    return merged;
}
/** 缺失环境变量在宽松模式下会留下空串；这里只用于"友好报错"判断 */
function isMissingEnvPlaceholder(value) {
    return value !== undefined && value.trim() === '';
}
export function inspectConfig(config) {
    const issues = [];
    const push = (level, message) => {
        issues.push({ level, message });
    };
    if (config.providers.length === 0)
        push('error', '未配置任何上游（providers 为空）');
    const seenProvider = new Set();
    for (const p of config.providers) {
        if (seenProvider.has(p.id))
            push('error', `上游 id 重复: ${p.id}`);
        seenProvider.add(p.id);
        if (!/^https?:\/\//.test(p.baseUrl))
            push('error', `上游 ${p.id} 的 baseUrl 必须是 http(s) 绝对地址: ${p.baseUrl}`);
        const hasKey = !!p.apiKey || (p.apiKeys?.some((k) => !!k) ?? false);
        const keyIsMissingEnv = isMissingEnvPlaceholder(p.apiKey) || (p.apiKeys?.some(isMissingEnvPlaceholder) ?? false);
        if (!hasKey && !keyIsMissingEnv) {
            push('error', `上游 ${p.id} 缺少 apiKey / apiKeys（应使用 {ENV:NAME} 插值）`);
        }
        if (p.models.length === 0)
            push('error', `上游 ${p.id} 未声明任何模型`);
        if ((p.weight ?? 0) < 0)
            push('error', `上游 ${p.id} 的 weight 不能为负`);
        if (p.timeoutMs !== undefined && p.timeoutMs <= 0)
            push('error', `上游 ${p.id} 的 timeoutMs 必须为正`);
    }
    const seenKey = new Set();
    for (const c of config.clients) {
        if (seenKey.has(c.id))
            push('error', `客户端 key id 重复: ${c.id}`);
        seenKey.add(c.id);
        if (!c.key && !isMissingEnvPlaceholder(c.key))
            push('error', `客户端 key ${c.id} 缺少 key`);
        // 空串是"注册了一个永远用不了的 key"：网关要求非空 Authorization，空 key 连哈希都进不去。
        // 它是 {ENV:X:-} 没解析出值、或手写了 key: "" 的结果。以前这里静默通过，等于给了一个死 key 还不说。
        if (c.key !== undefined && c.key.trim() === '') {
            push('warn', `客户端 key ${c.id} 是空串：它永远无法通过鉴权（若来自 {ENV:...}，请检查该环境变量是否真的设了值）`);
        }
        // 缺 tier 和引用未定义分层是两种错：前者是配置漏写了，后者是分层名打错了。
        // 混成一句话会让"检查器先崩掉"（渲染时对 undefined 调 padEnd），而崩了还不算错误。
        if (c.tier === undefined || c.tier === null) {
            push('error', `客户端 key ${c.id} 缺少 tier（必须从 ${Object.keys(config.tiers).join(' / ')} 里选一个）`);
        }
        else if (!(c.tier in config.tiers)) {
            push('error', `客户端 key ${c.id} 引用了未定义的分层: ${c.tier}（可用: ${Object.keys(config.tiers).join(' / ')}）`);
        }
        if (c.expiresAt !== undefined && c.expiresAt < Date.now())
            push('warn', `客户端 key ${c.id} 已过期`);
    }
    if (config.clients.length === 0)
        push('warn', '未配置任何客户端 key，网关将拒绝所有请求（可用管理接口创建）');
    if (config.server.adminToken === undefined || config.server.adminToken === '') {
        // C-04 修复：体验模式（本机直连免令牌）只在「确定不会被前置」的前提下成立。
        // 同机隧道/反代会让公网请求看起来来自本机 —— 声明了 behindProxy 却又不设令牌，
        // 等于把整个管理面（建/撤销 key、读配置、看全部度量）交给公网。
        if (config.server.behindProxy === true) {
            push('error', 'server.behindProxy=true 但未设置 server.adminToken：同机隧道/反代下这会把 /admin/api/* 与 /v1/quota 暴露给公网。请设置 RELAY_ADMIN_TOKEN');
        }
        else {
            push('warn', '未设置 server.adminToken：管理接口仅接受来自 127.0.0.1 的请求（若部署在同机隧道/反代之后，请设 server.behindProxy: true 并配置令牌）');
        }
    }
    else if (config.server.adminToken.length < 16) {
        push('warn', 'server.adminToken 长度小于 16，建议加强');
    }
    if (config.lossReduction.precheck.onBlock === 'reject' && config.lossReduction.precheck.budgetUs > 50_000) {
        push('warn', `precheck.budgetUs=${config.lossReduction.precheck.budgetUs} 偏大，可能成为主流程瓶颈`);
    }
    const proEnabled = config.tiers.pro;
    if (proEnabled.smartRouting && !config.providers.some((p) => p.cost)) {
        push('warn', 'pro 层开启了 smartRouting 但没有任何上游配置 cost，路由将退化为 priority');
    }
    // 模型可达性：请求某个模型必须至少有一个上游声明支持
    const known = new Set();
    for (const p of config.providers)
        for (const m of p.models)
            known.add(m);
    for (const m of Object.keys(config.modelAliases)) {
        // ownLookup：模型名若叫 'constructor'/'toString'，`config.modelAliases[m]` 会命中
        // Object.prototype 而拿到一个函数，「目标模型」校验随之失效（把一个无效别名当有效）。
        const target = ownLookup(config.modelAliases, m);
        if (target === undefined)
            continue;
        if (!known.has(target))
            push('warn', `模型别名 ${m} → ${target} 没有任何上游声明支持该目标模型`);
    }
    /* 档位阶梯：每一阶都该有上游声明支持，否则那一阶永远走不通（等于白写） */
    const allModels = new Set();
    for (const p of config.providers)
        for (const m of p.models)
            allModels.add(m);
    for (const [alias, ladder] of Object.entries(config.modelLadders ?? {})) {
        if (!Array.isArray(ladder) || ladder.length === 0) {
            push('error', `档位阶梯 ${alias} 为空`);
            continue;
        }
        // ownLookup：阶梯里的模型名若叫 'constructor' 等，`config.modelAliases[m]` 会命中
        // Object.prototype 而拿到函数，`?? m` 回落被跳过 —— 可达性校验于是拿一个函数去
        // allModels.has() 比对，永远 false，把本来可达的阶误报成"将被跳过"。
        const unreachable = ladder.filter((m) => !allModels.has(ownLookup(config.modelAliases, m) ?? m));
        if (unreachable.length === ladder.length) {
            push('error', `档位阶梯 ${alias} 的所有模型都没有上游声明支持：${ladder.join(', ')}`);
        }
        else if (unreachable.length > 0) {
            push('warn', `档位阶梯 ${alias} 中这些模型当前不可达（会被自动跳过）：${unreachable.join(', ')}`);
        }
        // 能力表缺失时的提醒：带工具的请求可能被切到不支持工具的模型。
        // ownLookup：`config.modelCapabilities?.[m]` 在 m 为 'constructor' 等时会命中原型链，
        // 把「没声明能力」误判成「声明了」，这条提醒就静默漏掉（正是它要防的那种失败）。
        const noCap = ladder.filter((m) => ownLookup(config.modelCapabilities, m) === undefined);
        if (noCap.length > 0) {
            push('warn', `档位阶梯 ${alias} 里 ${noCap.join(', ')} 没有声明能力（tools/contextWindow）；带工具调用的请求切过去可能直接失败，建议在 modelCapabilities 里补上`);
        }
    }
    if (config.storage.driver === 'sqlite' && config.storage.path === ':memory:') {
        push('warn', 'storage.path=:memory: 时度量数据不会持久化');
    }
    // REQ-01：共享后端只在装配层注入了 RedisCommandRunner 时才真正生效；
    // 这里提前提示“你声明了 redis，但代码层仍会强制回退内存”，避免运维以为多实例已开启。
    if (config.state?.backend === 'redis') {
        push('warn', 'state.backend=redis：需在装配层注入 RedisCommandRunner，否则自动回退内存实现（多实例一致性不生效）');
    }
    /* ---- 内部 Agent 系统（v2·D6 修复：enabled 时做存在性校验，杜绝静默 401） ---- */
    if (config.agent?.enabled) {
        const a = config.agent;
        if (!a.clientId) {
            // v1 缺陷 D6：clientId 缺失时 agentKey='' → 每轮 LLM 调用 401，而启动/check 不报错
            push('error', 'agent.enabled=true 但未设置 agent.clientId（应在 clients 里声明一条 agent 专用 key）');
        }
        else if (!config.clients.some((c) => c.id === a.clientId)) {
            push('error', `agent.clientId="${a.clientId}" 在 clients 里找不到（拼写错误会导致 Agent 每轮 401，v1 曾静默失败）`);
        }
        if (!a.model) {
            push('error', 'agent.enabled=true 但未设置 agent.model（Agent 调 LLM 需要显式模型名）');
        }
        if (a.intervalMs !== undefined && a.intervalMs < 60_000 && a.intervalMs > 0) {
            push('warn', `agent.intervalMs=${a.intervalMs} 小于 1 分钟——巡检过于频繁，token 花费可观；建议 ≥ 30 分钟`);
        }
        if (a.intervalMs && (a.dailyTokenLimit === undefined) && (a.dailyCostCnyLimit === undefined)) {
            push('warn', 'agent 开了周期巡检但未设 dailyTokenLimit / dailyCostCnyLimit——Agent 成本无护栏（v2 建议至少设一个）');
        }
        if (a.llmTimeoutMs !== undefined && a.llmTimeoutMs < 5_000) {
            push('warn', `agent.llmTimeoutMs=${a.llmTimeoutMs} 偏小——工具循环单轮 LLM 低于 5s 容易超时`);
        }
        if (a.autoWriteKb === true && !a.kbId) {
            push('warn', 'agent.autoWriteKb=true 但未设 agent.kbId——回写将落到缺省 kb_demo，请确认该库存在');
        }
    }
    /* ---- Agent 决策矩阵（可选能力）：**写了才校验**，包括 agent.enabled=false 的情况 ---- */
    // 为什么不受 enabled 守卫：矩阵配置写错属于配置层错误，静默忽略会让运营以为"开了但没生效"。
    // 未配置（undefined）则完全不进错误通道，保证存量配置零变化。
    const matrixCfg = config.agent?.decisionMatrix;
    if (matrixCfg !== undefined) {
        const mv = validateMatrixConfig(matrixCfg);
        for (const e of mv.errors)
            push('error', `agent.decisionMatrix 配置非法：${e}`);
    }
    return issues;
}
export function validateConfig(config) {
    const issues = inspectConfig(config);
    const errors = issues.filter((i) => i.level === 'error');
    if (errors.length > 0) {
        throw new Error(`配置校验失败:\n${errors.map((e) => `  - ${e.message}`).join('\n')}`);
    }
    if (!config.tiers.free || !config.tiers.standard || !config.tiers.pro) {
        throw new Error('必须定义 free/standard/pro 三层策略');
    }
}
/** 生成一份可直接运行的示例配置（用于首启动自举与文档） */
export function exampleConfigYaml() {
    return `# 智能体基础设施层 · api-relay — 示例配置
# 复制为 config/relay.yaml 后按需修改；所有密钥请用 {ENV:NAME} 插值，禁止明文写入。

server:
  host: 127.0.0.1
  port: 8787
  adminToken: "{ENV:RELAY_ADMIN_TOKEN:-demo-admin-token-please-change}"
  trustProxy: false
  # C-04：若网关被同机隧道/反代前置（cloudflared / Tailscale Funnel 等），必须置 true
  # 并同时设置 RELAY_ADMIN_TOKEN —— 否则 remoteAddress 全是回环，闸门形同虚设
  behindProxy: false

storage:
  driver: sqlite
  path: data/relay.db

logLevel: info

providers:
  - id: deepseek
    label: DeepSeek 官方
    protocol: openai
    baseUrl: https://api.deepseek.com/v1
    apiKey: "{ENV:DEEPSEEK_API_KEY}"
    models: [deepseek-chat, deepseek-reasoner]
    weight: 1
    priority: 10
    tags: [cn, official]
    cost: { inputPerMTok: 2, outputPerMTok: 8, cachedInputPerMTok: 0.5 }
  - id: siliconflow
    label: 硅基流动（便宜上游，用于 smart routing）
    protocol: openai
    baseUrl: https://api.siliconflow.cn/v1
    apiKey: "{ENV:SILICONFLOW_API_KEY:-}"
    models: [Qwen/Qwen2.5-7B-Instruct]
    weight: 1
    priority: 5
    tags: [cn, cheap]
    cost: { inputPerMTok: 0.5, outputPerMTok: 1.5 }
  - id: mock
    label: 本地 mock 上游（离线自测，勿用于生产）
    protocol: openai
    baseUrl: http://127.0.0.1:8899/v1
    apiKey: "mock-key"
    models: [mock-small, mock-large, mock-429, mock-500, mock-401, mock-404, mock-400, mock-502, mock-503, mock-filter, mock-context, mock-balance]
    weight: 1
    priority: 1
    tags: [local, cheap, unstable]
    # 说明：mock-429 / mock-500 / mock-401 等是 mock 上游的故障注入模型名。
    # 真实上游不需要这些；这里声明它们只是为了让 P2 预检放行请求，
    # 从而端到端演示 P3 失败归因与自动故障转移。
    cost: { inputPerMTok: 0.2, outputPerMTok: 0.6 }

modelAliases:
  gpt-4o-mini: mock-small
  default: deepseek-chat

defaultProvider: deepseek

clients:
  - id: demo-free
    label: 演示-免费层
    key: "{ENV:RELAY_KEY_FREE:-sk-relay-free-demo}"
    tier: free
    tenantId: demo
    enabled: true
  - id: demo-standard
    label: 演示-标准层
    key: "{ENV:RELAY_KEY_STANDARD:-sk-relay-standard-demo}"
    tier: standard
    tenantId: demo
    enabled: true
  - id: demo-pro
    label: 演示-Pro 层
    key: "{ENV:RELAY_KEY_PRO:-sk-relay-pro-demo}"
    tier: pro
    tenantId: demo
    enabled: true

lossReduction:
  precheck:
    enabled: true
    onBlock: reject
    budgetUs: 3000
    # max_tokens 绝对天花板（模型没声明 modelMaxTokens 时的兜底）
    maxTokensCeiling: 1000000
  attribution:
    enabled: true
    includeEvidence: false
    autoRetry: 1
    # 精确模型名请求时用同档后继模型补齐阶梯（横向兜底耗尽后才竖向换模型）。
    # 置 false 则退回单阶：点名 agnes-2.0-flash 遇免费档限流时 429 直接丢回客户端。
    siblingModelFallback: true
    backoffBaseMs: 400
    backoffMaxMs: 8000
  meter:
    enabled: true
    retentionDays: 30
  trace:
    enabled: true
    ringSize: 500
    persist: true
`;
}
//# sourceMappingURL=config.js.map