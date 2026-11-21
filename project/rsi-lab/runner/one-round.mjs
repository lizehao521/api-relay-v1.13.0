import path from 'node:path';
import { pendingTargets, renderTaskPrompt } from './lib.mjs';
import {
  PRODUCER, judge, STATE,
  buildManifest, nextGeneration,
  anchorGeneration, loadLedger, saveLedger, verifyChain,
} from './gate.mjs';

function verdictStateOf(verdict) {
  if (verdict.state === STATE.improved) return 'improved';
  return 'reverted';
}

export async function finishAborted({ dir, evaluate, dirtyCheck, reset, persistLedger, state, round }) {
  const wasDirty = await dirtyCheck();
  if (!wasDirty) {
    return { aborted: true, reason: 'never_persisted', evaluated: false, verdict: state.verdict ?? null };
  }
  const evalResult = await evaluate();
  const generation = nextGeneration(state, state.anchorBaseline);
  const next = buildManifest({
    dir,
    generation,
    claim: `第 ${round} 轮中止留痕：模型未完成但沙箱已落盘，超时也不许抹账`,
    readings: [
      { metric: 'pass_rate', n: evalResult.score ?? 0, basis: 1, direction: 'up' },
      { metric: 'fail_count', n: evalResult.fail ?? 0, basis: 1, direction: 'down' },
    ],
    prevManifest: null,
  });
  const prev = state.anchorBaseline ?? null;
  const verdict = prev ? judge(prev, next) : { state: STATE.refused, reasons: ['无基线锚点，无法两代对账'], metrics: [] };
  const entry = {
    round,
    producer: PRODUCER,
    generation,
    verdict: verdictStateOf(verdict),
    score: evalResult.score ?? 0,
    blockers: verdict.reasons,
    aborted: true,
    createdAt: new Date().toISOString(),
  };
  const ledger = await loadLedger(path.join(dir, 'ledger.jsonl'));
  ledger.push(entry);
  await persistLedger(ledger);
  state.verdict = { ...verdict, generation, state: verdictStateOf(verdict), aborted: true };
  state.generation = generation;
  await reset();
  return { aborted: true, reason: 'timeout_or_crash', evaluated: true, verdict: entry, generation };
}

export async function runOneRound({ round, state, dir = 'sandbox', evaluate, dirtyCheck, reset, persistLedger, saveState, commit, agentRun, hintLookup }) {
  const report = { round, targets: [], verdict: null, gate: null, ledger: [], bootstrapped: false, commitError: null };
  await reset();
  const targets = pendingTargets(dir);
  report.targets = targets;
  if (targets.length === 0) {
    report.bootstrapped = true;
    return report;
  }
  if (agentRun) {
    const hint = hintLookup ? hintLookup(targets[0]) : null;
    const message = renderTaskPrompt(targets, () => hint);
    await agentRun({ message, targets });
  }
  const evalResult = await evaluate();
  const prev = state.anchorBaseline ?? null;
  const generation = nextGeneration(state, prev);
  const next = buildManifest({
    dir,
    generation,
    claim: `第 ${round} 轮：模型实现 ${targets.join(', ')}`,
    readings: [
      { metric: 'pass_rate', n: evalResult.score ?? 0, basis: 1, direction: 'up' },
      { metric: 'fail_count', n: evalResult.fail ?? 0, basis: 1, direction: 'down' },
    ],
    prevManifest: prev,
  });
  let ledger = await loadLedger(path.join(dir, 'ledger.jsonl'));
  const verdict = judge(prev, next, { ledger });
  const accept = verdict.state === STATE.improved;
  report.gate = { state: verdict.state, reasons: verdict.reasons, metrics: verdict.metrics, accept, generation };
  const entry = {
    round,
    producer: PRODUCER,
    generation,
    verdict: verdictStateOf(verdict),
    score: evalResult.score ?? 0,
    baselineScore: prev ? (prev.readings?.find((r) => r.metric === 'pass_rate')?.n ?? null) : null,
    blockers: verdict.reasons,
    createdAt: new Date().toISOString(),
  };
  if (prev && verdict.state !== STATE.refused) {
    const anchored = anchorGeneration(ledger, prev, next, verdict);
    if (anchored.ok) ledger = anchored.ledger;
  } else {
    ledger.push(entry);
  }
  await saveLedger(path.join(dir, 'ledger.jsonl'), ledger);
  report.ledger = ledger;
  if (accept) {
    state.verdict = { ...verdict, generation, state: 'improved', score: evalResult.score ?? 0 };
    try { await commit(); } catch (e) { report.commitError = String(e); }
  } else {
    state.verdict = { ...verdict, generation, state: verdictStateOf(verdict), aborted: !accept };
    await reset();
  }
  state.generation = generation;
  if (saveState) await saveState(state);
  return report;
}