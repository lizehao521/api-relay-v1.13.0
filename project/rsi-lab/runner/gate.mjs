import fs from 'node:fs/promises';
import {
  judge, STATE,
  anchorGeneration as anchorInChain,
  anchorBaseline as anchorBaselineInChain,
  buildGeneration, diffCriteria, collectFiles,
  readingsFromEval,
  payloadHashOf, stableStringify,
  verifyChain as verifyChainCore,
} from './verdict.mjs';

export const PRODUCER = 'rsi-lab';
export { payloadHashOf, stableStringify, judge, STATE, readingsFromEval, buildGeneration, diffCriteria, collectFiles };

function nowIso() {
  return new Date().toISOString();
}

export function nextGeneration(state, manifest) {
  if (state && state.generation) return state.generation + 1;
  if (manifest && manifest.generation) return manifest.generation + 1;
  return 1;
}

export function buildManifest({ dir, generation, claim, readings = [], prevManifest, producer = PRODUCER }) {
  const next = buildGeneration({ dir, producer, generation, claim, readings });
  next.createdAt = nowIso();
  if (prevManifest) {
    next.criteria_diff = diffCriteria(prevManifest, next.meta.criteria_files);
  }
  return next;
}

export function scoreOf(evalResult) {
  if (!evalResult || evalResult.failure) return 0;
  return evalResult.score ?? 0;
}

export function decideAcceptance(prevManifest, nextManifest, options = {}) {
  const verdict = judge(prevManifest, nextManifest, { ledger: options.ledger });
  return { ...verdict, accept: verdict.state === STATE.improved };
}

export function baselineManifest(ledger, manifest) {
  return anchorBaselineInChain(ledger, manifest);
}

export function anchorGeneration(ledger, prev, next, verdict) {
  return anchorInChain(ledger, prev, next, verdict);
}

export function verifyChain(ledger) {
  return verifyChainCore(ledger);
}

export async function saveLedger(ledgerPath, entries) {
  await fs.writeFile(ledgerPath, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''), 'utf8');
  return entries;
}

export async function loadLedger(ledgerPath) {
  try {
    const text = await fs.readFile(ledgerPath, 'utf8');
    return text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}