import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const BASIS = Object.freeze({ measured: 1, relayed: 2, estimated: 3, model_says: 4, absent: 5 });
export const BASIS_LABEL = Object.freeze({ 1: 'measured', 2: 'relayed', 3: 'estimated', 4: 'model_says', 5: 'absent' });

export const STATE = Object.freeze({
  improved: 'improved',
  notImproved: 'not_improved',
  refused: 'refused',
  undecidable: 'undecidable'
});

export const EXIT_CODE = Object.freeze({ improved: 0, not_improved: 1, refused: 2, undecidable: 3 });

export const CRITERIA = Object.freeze(['R1', 'R2', 'R3', 'R4', 'R5', 'R6']);
export const CLAIM_MAX = 500;
export const IGNORED_DIRS = Object.freeze(['.git', 'node_modules', '.artifacts']);

const criterionImpl = {
  R1: checkStructure,
  R2: checkArtifacts,
  R3: checkCriteria,
  R4: checkBasis,
  R5: checkImprovement,
  R6: checkAnchor
};

export function implementedCriteria() {
  return Object.keys(criterionImpl).sort();
}

export function judge(prev, next, options = {}) {
  const structure = checkStructure(prev, next);
  if (structure.length) return makeVerdict(STATE.refused, structure, []);

  const improvement = checkImprovement(prev, next);
  const basis = checkBasis(prev, next);
  const refuse = [...checkArtifacts(prev, next), ...checkCriteria(prev, next), ...basis.refuse];
  if (improvement.state === STATE.refused) refuse.push(...improvement.reasons);
  if (refuse.length) return makeVerdict(STATE.refused, refuse, improvement.metrics);

  const undecidable = [...basis.undecidable];
  if (improvement.state === STATE.undecidable) undecidable.push(...improvement.reasons);
  if (undecidable.length) return makeVerdict(STATE.undecidable, undecidable, improvement.metrics);

  if (options.ledger) {
    const anchorReasons = checkAnchor(prev, next, options.ledger, improvement);
    if (anchorReasons.length) return makeVerdict(STATE.refused, anchorReasons, improvement.metrics);
  }
  return improvement;
}

function makeVerdict(state, reasons, metrics) {
  return { state, reasons: [...reasons], metrics: [...metrics] };
}

function isBlank(v) {
  return typeof v !== 'string' || v.trim() === '';
}

function isSha256(v) {
  return typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v);
}

export function checkStructure(prev, next) {
  const reasons = [];
  for (const m of [prev, next]) {
    const side = `第 ${m?.generation} 代`;
    if (!m || typeof m !== 'object') {
      reasons.push('R1: manifest 不是对象');
      continue;
    }
    if (isBlank(m.producer)) reasons.push(`R1: ${side} 缺 producer`);
    if (!Number.isInteger(m.generation) || m.generation < 1) reasons.push(`R1: generation=${m.generation}，必须从 1 起`);
    if (isBlank(m.claim)) reasons.push(`R1: ${side} 缺 claim`);
    if (typeof m.claim === 'string' && m.claim.length > CLAIM_MAX) {
      reasons.push(`R1: ${side} claim 有 ${m.claim.length} 字符，超上限 ${CLAIM_MAX}`);
    }
    if (isBlank(m.criteria_sha256)) reasons.push(`R1: ${side} 缺 criteria_sha256`);
    if (!Array.isArray(m.artifacts) || m.artifacts.length === 0) reasons.push(`R1: ${side} 产物清单为空`);

    const seenPath = new Set();
    for (const a of Array.isArray(m.artifacts) ? m.artifacts : []) {
      if (!a || isBlank(a.path) || !Number.isInteger(a.bytes) || a.bytes < 0 || !isSha256(a.sha256)) {
        reasons.push(`R1: ${side} 产物 ${JSON.stringify(a?.path)} 形状坏（path/sha256/bytes）`);
      }
      if (a && seenPath.has(a.path)) reasons.push(`R1: ${side} 产物路径 ${JSON.stringify(a.path)} 重复`);
      if (a) seenPath.add(a.path);
    }

    const seenMetric = new Set();
    for (const r of Array.isArray(m.readings) ? m.readings : []) {
      if (!r || isBlank(r.metric)) reasons.push(`R1: ${side} 有读数缺 metric 名`);
      if (r && seenMetric.has(r.metric)) reasons.push(`R1: ${side} 指标 ${JSON.stringify(r.metric)} 重复`);
      if (r) seenMetric.add(r.metric);
      if (!r || (r.direction !== 'up' && r.direction !== 'down')) {
        reasons.push(`R1: ${side} 指标 ${JSON.stringify(r?.metric)} 方向 ${JSON.stringify(r?.direction)} 不认（只收 up/down）`);
      }
      if (!r || !Number.isInteger(r.basis) || r.basis < BASIS.measured || r.basis > BASIS.absent) {
        reasons.push(`R1: ${side} 指标 ${JSON.stringify(r?.metric)} basis=${r?.basis} 不在内核枚举档内`);
      }
      if (r && r.basis === BASIS.absent && isBlank(r.why_absent)) {
        reasons.push(`R1: ${side} 指标 ${JSON.stringify(r.metric)} 缺席却没带理由`);
      }
      if (r && r.basis === BASIS.relayed && isBlank(r.source)) {
        reasons.push(`R1: ${side} 指标 ${JSON.stringify(r.metric)} 是转述却没带 source`);
      }
      if (r && r.denominator != null && !(Number.isFinite(r.denominator) && r.denominator > 0)) {
        reasons.push(`R1: ${side} 指标 ${JSON.stringify(r.metric)} 分母 ${r.denominator} 不是正数`);
      }
    }
  }

  if (prev?.producer && next?.producer && prev.producer !== next.producer) {
    reasons.push(`R1: 两代生产者不同（${prev.producer} vs ${next.producer}），无从谈改进`);
  }
  if (prev?.generation != null && next?.generation != null && next.generation <= prev.generation) {
    reasons.push(`R1: 这一代（${next.generation}）不比上一代（${prev.generation}）新`);
  }

  const pm = readingsOf(prev);
  const nm = readingsOf(next);
  for (const [name, p] of Object.entries(pm)) {
    const n = nm[name];
    if (n && p.direction !== n.direction) {
      reasons.push(`R1: 指标 ${JSON.stringify(name)} 两代方向不一致（${p.direction} vs ${n.direction}）`);
    }
  }
  return reasons;
}

export function checkArtifacts(prev, next) {
  if (artifactFingerprint(prev) === artifactFingerprint(next)) {
    return ['R2: 两代产物指纹集完全相同 —— 同字节换标签不算改进'];
  }
  return [];
}

export function checkCriteria(prev, next) {
  if (prev.criteria_sha256 === next.criteria_sha256) {
    return Array.isArray(next.criteria_diff) && next.criteria_diff.length
      ? ['R3: 判据指纹没变却报了 criteria_diff']
      : [];
  }
  const diff = Array.isArray(next.criteria_diff) ? next.criteria_diff : [];
  if (!diff.length) return ['R3: 判据指纹变了却没交 criteria_diff'];

  const reasons = [];
  for (const d of diff) {
    if (!d || isBlank(d.id)) reasons.push('R3: criteria_diff 有条目缺 id');
    const change = d?.change;
    if (change === 'tightened' || change === 'added') continue;
    if (change === 'loosened' || change === 'removed') {
      reasons.push(`R3: 判据 ${JSON.stringify(d.id)} 被 ${change} —— 判据放水，改进不算数`);
    } else {
      reasons.push(`R3: 判据 ${JSON.stringify(d?.id)} 的 change=${JSON.stringify(change)} 不认`);
    }
  }
  return reasons;
}

export function checkBasis(prev, next) {
  const refuse = [];
  const undecidable = [];
  for (const m of [prev, next]) {
    for (const r of Array.isArray(m?.readings) ? m.readings : []) {
      if (r.basis === BASIS.measured || r.basis === BASIS.relayed) continue;
      if (r.basis === BASIS.absent) {
        undecidable.push(`R4: 指标 ${JSON.stringify(r.metric)} 第 ${m.generation} 代缺席（${r.why_absent}）—— 量不到，不判`);
      } else {
        refuse.push(`R4: 指标 ${JSON.stringify(r.metric)} 第 ${m.generation} 代 basis=${BASIS_LABEL[r.basis] ?? r.basis} 不可判定，不许当证据`);
      }
    }
  }
  return { refuse, undecidable };
}

export function checkImprovement(prev, next) {
  const pm = readingsOf(prev);
  const nm = readingsOf(next);
  const refuse = [];
  const undecidable = [];
  const metrics = [];

  const common = [];
  for (const name of Object.keys(pm)) {
    if (Object.hasOwn(nm, name)) common.push(name);
    else undecidable.push(`R5: 指标 ${JSON.stringify(name)} 只有上一代有，量不到改进`);
  }
  for (const name of Object.keys(nm)) {
    if (!Object.hasOwn(pm, name)) undecidable.push(`R5: 指标 ${JSON.stringify(name)} 只有这一代有，量不到改进`);
  }
  common.sort();
  if (Object.keys(pm).length === 0 && Object.keys(nm).length === 0) {
    undecidable.push('R5: 两侧都没有读数 —— 没量过不算改进');
  }

  for (const name of common) {
    const p = pm[name];
    const n = nm[name];
    if (p.basis === BASIS.absent || n.basis === BASIS.absent) continue;
    if ((p.denominator == null) !== (n.denominator == null)) {
      refuse.push(`R5: 指标 ${JSON.stringify(name)} 一侧带分母另一侧没交 —— 无分母比率不判`);
      continue;
    }
    const before = readingValue(p);
    const after = readingValue(n);
    const better = p.direction === 'down' ? after < before : after > before;
    metrics.push({ metric: name, before, after, better });
  }

  if (refuse.length) return makeVerdict(STATE.refused, refuse, metrics);
  if (undecidable.length) return makeVerdict(STATE.undecidable, undecidable, metrics);

  const reasons = [];
  for (const m of metrics) {
    if (!m.better) reasons.push(`R5: 指标 ${JSON.stringify(m.metric)} 没变好（${m.before} → ${m.after}）`);
  }
  return makeVerdict(reasons.length ? STATE.notImproved : STATE.improved, reasons, metrics);
}

export function checkAnchor(prev, next, ledger = [], verdict = null) {
  const reasons = [];
  const chain = verifyChain(ledger);
  if (!chain.ok) reasons.push(`R6: 链 Verify 不过（${chain.reason}）`);

  for (const m of [prev, next]) {
    if (!m) continue;
    const existing = ledger.find(
      (e) => e.type === 'manifest' && e.producer === m.producer && e.generation === m.generation
    );
    if (existing && existing.payloadHash !== payloadHashOf(m)) {
      reasons.push(`R6: ${m.producer} 第 ${m.generation} 代已有一份不同的 manifest 在链上，重记被拒`);
    }
  }

  if (verdict && next) {
    const prior = ledger.find(
      (e) => e.type === 'verdict' && e.producer === next.producer && e.generation === next.generation
    );
    if (prior && prior.state !== verdict.state) {
      reasons.push(`R6: ${next.producer} 第 ${next.generation} 代已有判定 ${prior.state}，重判为 ${verdict.state} 被拒`);
    }
  }
  return reasons;
}

export function anchorGeneration(ledger, prev, next, verdict) {
  const reasons = checkAnchor(prev, next, ledger, verdict);
  if (reasons.length) return { ok: false, reasons, ledger };

  const out = [...ledger];
  const append = (type, payload) => {
    const payloadHash = payloadHashOf(payload);
    const duplicate = out.some((e) => {
      if (e.type !== type || e.producer !== payload.producer || e.generation !== payload.generation) return false;
      return type !== 'manifest' || e.payloadHash === payloadHash;
    });
    if (duplicate) return;
    const prevHash = out.length ? out[out.length - 1].h : 'genesis';
    out.push({
      type,
      ...payload,
      prevHash,
      payloadHash,
      h: sha256(`${prevHash}|${type}|${payloadHash}`)
    });
  };

  append('manifest', prev);
  append('manifest', next);
  append('verdict', {
    producer: next.producer,
    generation: next.generation,
    state: verdict.state,
    reasons: verdict.reasons,
    metrics: verdict.metrics
  });
  return { ok: true, reasons: [], ledger: out };
}

export function anchorBaseline(ledger, manifest) {
  const chain = verifyChain(ledger);
  if (!chain.ok) return { ok: false, reasons: [`R6: 链 Verify 不过（${chain.reason}）`], ledger };

  const existing = ledger.find(
    (e) => e.type === 'manifest' && e.producer === manifest.producer && e.generation === manifest.generation
  );
  if (existing) {
    if (existing.payloadHash !== payloadHashOf(manifest)) {
      return { ok: false, reasons: [`R6: ${manifest.producer} 第 ${manifest.generation} 代已有一份不同的 manifest 在链上，重记被拒`], ledger };
    }
    return { ok: true, reasons: [], ledger };
  }

  const out = [...ledger];
  const payloadHash = payloadHashOf(manifest);
  const prevHash = out.length ? out[out.length - 1].h : 'genesis';
  out.push({ type: 'manifest', ...manifest, prevHash, payloadHash, h: sha256(`${prevHash}|manifest|${payloadHash}`) });
  return { ok: true, reasons: [], ledger: out };
}

export function verifyChain(ledger) {
  let prevHash = 'genesis';
  for (let i = 0; i < ledger.length; i++) {
    const e = ledger[i];
    if (e.prevHash !== prevHash) {
      return { ok: false, at: i, reason: `第 ${i + 1} 条 prevHash 断链` };
    }
    const expect = sha256(`${prevHash}|${e.type}|${e.payloadHash}`);
    if (expect !== e.h) return { ok: false, at: i, reason: `第 ${i + 1} 条哈希对不上` };
    prevHash = e.h;
  }
  return { ok: true, length: ledger.length };
}

export function buildGeneration({ dir, producer, generation, claim, readings = [], criteriaDir = 'test', include = ['src'], exclude = IGNORED_DIRS }) {
  const artifacts = collectFiles(dir, include, exclude).map((file) => {
    const content = fs.readFileSync(path.join(dir, file));
    return { path: file, sha256: sha256(content), bytes: content.length };
  });
  const criteriaFiles = collectFiles(dir, [criteriaDir], exclude).map((file) => {
    const content = fs.readFileSync(path.join(dir, file));
    return { path: file, sha256: sha256(content) };
  });

  return {
    producer,
    generation,
    claim,
    artifacts,
    criteria_sha256: fingerprint(criteriaFiles),
    criteria_diff: [],
    readings,
    meta: { criteria_files: criteriaFiles }
  };
}

export function diffCriteria(prevManifest, nextFiles) {
  const prevFiles = new Map(
    (prevManifest?.meta?.criteria_files || prevManifest?.criteria_files || []).map((f) => [f.path, f.sha256])
  );
  const diff = [];
  for (const f of nextFiles) {
    const before = prevFiles.get(f.path);
    if (!before) diff.push({ id: f.path, change: 'added', note: '新增判据文件' });
    else if (before !== f.sha256) diff.push({ id: f.path, change: 'loosened', note: '判据文件被改写' });
  }
  for (const p of prevFiles.keys()) {
    if (!nextFiles.some((f) => f.path === p)) diff.push({ id: p, change: 'removed', note: '判据文件被删除' });
  }
  return diff;
}

export function readingsFromEval(evalResult, extra = []) {
  const readings = [
    { metric: 'pass_rate', n: evalResult.score, basis: BASIS.measured, direction: 'up' },
    { metric: 'fail_count', n: evalResult.fail, basis: BASIS.measured, direction: 'down' }
  ];
  return readings.concat(extra);
}

export function exitCodeOf(state) {
  return EXIT_CODE[state] ?? 3;
}

export function readingsOf(m) {
  const out = {};
  for (const r of Array.isArray(m?.readings) ? m.readings : []) out[r.metric] = r;
  return out;
}

function readingValue(r) {
  return r.denominator != null ? r.n / r.denominator : r.n;
}

function artifactFingerprint(m) {
  const pairs = (Array.isArray(m?.artifacts) ? m.artifacts : [])
    .map((a) => `${a.path}:${a.sha256}`)
    .sort();
  return sha256(pairs.join('\n'));
}

export function payloadHashOf(value) {
  return sha256(stableStringify(value));
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function fingerprint(files) {
  const normalized = [...files].sort((a, b) => a.path.localeCompare(b.path));
  return sha256(normalized.map((f) => `${f.path}\0${f.sha256}`).join('\n'));
}

export function collectFiles(root, include = [], exclude = IGNORED_DIRS, base = '') {
  const out = [];
  const absRoot = path.join(root, base);
  if (!fs.existsSync(absRoot)) return out;

  for (const entry of fs.readdirSync(absRoot, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (exclude.includes(entry.name)) continue;
    if (entry.isDirectory()) {
      if (include.length && !include.some((dir) => rel === dir || rel.startsWith(dir + '/'))) continue;
      out.push(...collectFiles(root, include, exclude, rel));
    } else if (entry.isFile()) {
      if (!include.length || include.some((dir) => rel === dir || rel.startsWith(dir + '/'))) {
        out.push(rel.split(path.sep).join('/'));
      }
    }
  }
  return out.sort();
}