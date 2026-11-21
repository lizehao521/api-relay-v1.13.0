import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const JUDGMENT_LABEL = {
  accept: '对账通过（accept）',
  revert: '对账拒绝（revert）',
  timeout: '轮次超时（timeout）',
  milestone_failure: '里程碑失败（milestone_failure）',
};
export const JUDGMENT_TAG = {
  accept: 'tag-accept',
  revert: 'tag-revert',
  timeout: 'tag-timeout',
  milestone_failure: 'tag-milestone',
};

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function payloadHashOf(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export async function readRoundDir(roundsRoot) {
  let entries;
  try {
    entries = await fs.readdir(roundsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && /^round-\d+$/.test(e.name))
    .map((e) => ({ name: e.name, round: Number(e.name.split('-')[1]), dir: path.join(roundsRoot, e.name) }))
    .sort((a, b) => a.round - b.round);
}

export async function listRoundDirs(roundsRoot) {
  return (await readRoundDir(roundsRoot)).map((d) => d.round);
}

export async function readJson(p) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    return null;
  }
}

async function readText(p) {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

export function roundSummary(raw) {
  if (!raw) return null;
  return {
    round: raw.round,
    generatedAt: raw.generatedAt ?? null,
    verdict: raw.verdict ?? null,
    generation: raw.generation ?? null,
    targets: raw.targets ?? [],
    dirty: raw.dirty ?? false,
    score: raw.score ?? null,
    failure: raw.failure ?? null,
    decision: raw.decision ?? null,
  };
}

export function ledgerSummary(entries) {
  const list = (entries || []).map((e) => ({
    round: e.round ?? null,
    generation: e.generation ?? null,
    verdict: e.verdict ?? e.state ?? 'unknown',
    score: e.score ?? null,
    reason: (e.blockers && e.blockers.join(',')) || e.reason || '',
    ts: e.ts ?? e.createdAt ?? null,
  }));
  return { list, verify: { ok: true, count: list.length }, count: list.length };
}

export async function getRoundDetail(roundsRoot, round) {
  const rdir = path.join(roundsRoot, `round-${round}`);
  const [report, sse, evalLog] = await Promise.all([
    readJson(path.join(rdir, 'run-report.json')),
    readText(path.join(rdir, 'sse.log')),
    readText(path.join(rdir, 'eval.log')),
  ]);
  return { round, report, sse, eval: evalLog };
}

export async function getSummary(roundsRoot, ledgerPath, statePath) {
  const dirs = await readRoundDir(roundsRoot);
  const rounds = [];
  let lastVerdict = null;
  let lastGeneration = 0;
  let lastDirty = false;
  for (const d of dirs) {
    const raw = await readJson(path.join(d.dir, 'run-report.json'));
    const s = roundSummary(raw);
    if (s) {
      rounds.push(s);
      if (s.verdict) lastVerdict = s.verdict;
      if (s.generation) lastGeneration = s.generation;
      lastDirty = s.dirty;
    }
  }
  let ledger = { list: [], verify: { ok: true, count: 0 }, count: 0 };
  try {
    const text = await fs.readFile(ledgerPath, 'utf8');
    ledger = ledgerSummary(text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
  } catch {}
  let state = {};
  try {
    state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  } catch {}
  return {
    generatedAt: new Date().toISOString(),
    rounds,
    lastRound: rounds.length ? rounds[rounds.length - 1].round : 0,
    lastVerdict,
    lastGeneration,
    lastDirty,
    ledger,
    state: {
      bestScore: state.bestScore,
      bestCommit: state.bestCommit,
      generation: state.generation,
      milestones: state.milestones,
      totalTokens: state.totalTokens,
    },
  };
}