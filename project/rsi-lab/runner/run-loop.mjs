import fs from 'node:fs/promises';
import path from 'node:path';
import {
  PRODUCER, judge, STATE,
  buildManifest, nextGeneration,
  baselineManifest, anchorGeneration, loadLedger, saveLedger, verifyChain,
  readingsFromEval, buildGeneration,
} from './gate.mjs';
import { expandIfSaturated, applyMilestone, nextMilestone } from './milestone.mjs';
import { runOneRound, finishAborted } from './one-round.mjs';

export { nextMilestone, finishAborted };

async function stopRequested() {
  try { await fs.access('STOP'); return true; } catch { return false; }
}

export async function ensureBaseline({ dir, state, evaluate, persistLedger, generation = 1 }) {
  if (state.anchorBaseline) return state.anchorBaseline;
  const evalResult = await evaluate();
  const manifest = buildManifest({
    dir,
    generation,
    claim: '基线锚定：扩靶子/对账前的原点',
    readings: readingsFromEval(evalResult),
    prevManifest: null,
  });
  const ledger = await loadLedger(path.join(dir, 'ledger.jsonl'));
  const anchored = baselineManifest(ledger, manifest);
  if (anchored.ok) await persistLedger(anchored.ledger);
  state.anchorBaseline = manifest;
  state.verdict = { state: evalResult.score >= 1 ? 'improved' : 'not_improved', generation, score: evalResult.score ?? 0, reasons: [], createdAt: new Date().toISOString() };
  state.generation = generation;
  return manifest;
}

export async function expandTarget(state, milestone, opts = {}) {
  const { dir, evaluate, commit, persistLedger } = opts;
  const applied = await applyMilestone(state, milestone, { dir, evaluate, commit, rollback: async () => {} });
  const evalResult = applied.eval;
  const prev = state.anchorBaseline ?? null;
  const generation = nextGeneration(state, prev);
  const next = buildManifest({
    dir,
    generation,
    claim: `扩靶子 ${milestone.id}：新判据入沙，基线重锚`,
    readings: readingsFromEval(evalResult),
    prevManifest: prev,
  });
  let ledger = await loadLedger(path.join(dir, 'ledger.jsonl'));
  const verdict = judge(prev, next, { ledger });
  const anchored = anchorGeneration(ledger, prev, next, verdict);
  if (anchored.ok) await persistLedger(anchored.ledger);
  return { applied, verdict, generation };
}

export async function runLoop({ rounds, state, dir = 'sandbox', roundTimeoutMs = 420000, evaluate, dirtyCheck, reset, persistLedger, saveState, commit, agentRun, hintLookup, persistRoundReport }) {
  const results = [];
  const start = (state && state.lastRound ? state.lastRound : 0) + 1;
  for (let round = start; round <= rounds; round++) {
    if (await stopRequested()) break;
    if (!state.anchorBaseline) {
      await ensureBaseline({ dir, state, evaluate, persistLedger });
      if (saveState) await saveState(state);
    }
    let roundResult;
    try {
      roundResult = await runOneRound({ round, state, dir, evaluate, dirtyCheck, reset, persistLedger, saveState, commit, agentRun, hintLookup });
    } catch (e) {
      const aborted = await finishAborted({ dir, evaluate, dirtyCheck, reset, persistLedger, state, round }).catch(() => null);
      results.push({ round, failure: String(e), aborted: aborted ? aborted.reason : 'abort_handler_failed' });
      if (persistRoundReport) await persistRoundReport(round, { round, failure: String(e), aborted });
      break;
    }
    results.push(roundResult);
    state.lastRound = round;
    if (saveState) await saveState(state);
    if (persistRoundReport) await persistRoundReport(round, roundResult);
    if (roundResult.bootstrapped) continue;
    const m = expandIfSaturated(state);
    if (m) {
      try {
        await expandTarget(state, m, { dir, evaluate, commit, persistLedger });
        if (saveState) await saveState(state);
      } catch (e) {
        results.push({ round, failure: 'milestone_failure:' + String(e), aborted: true });
        if (persistRoundReport) await persistRoundReport(round, { round, failure: 'milestone_failure:' + String(e) });
        break;
      }
    }
  }
  const ledger = await loadLedger(path.join(dir, 'ledger.jsonl'));
  return { results, state, ledger, chain: verifyChain(ledger) };
}