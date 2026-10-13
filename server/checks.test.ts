import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAgent } from '../shared/defaults';
import type { CheckSettings, NodeResult, WorkflowNode } from '../shared/types';
import { evaluateCheck } from './checks';
import { validateCheckOutcome } from './validation';

const settings: CheckSettings = { requireOutput: true, requireFindingEvidence: true, requireJudgment: false, blockedSeverities: [] };
function check(patch: Partial<CheckSettings> = {}): WorkflowNode {
  return { id: 'check', type: 'check', position: { x: 0, y: 0 }, data: { ...makeAgent('custom'), check: { ...settings, ...patch } } };
}
function report(nodeId = 'worker', patch: Partial<NodeResult> = {}): NodeResult {
  return { nodeId, nodeName: nodeId, modelId: 'qwen', cycle: 1, output: 'Inspected the assigned files.', findings: [], completedAt: new Date().toISOString(), ...patch };
}

test('checks fail closed without inputs and accept a completed report with no findings', () => {
  assert.deepEqual(evaluateCheck(check(), []), { passed: false, units: [] });
  const outcome = evaluateCheck(check(), [report()]);
  assert.deepEqual(outcome, { passed: true, units: [{ nodeId: 'worker', passed: true, retryable: false, reasons: [] }] });
  assert.doesNotThrow(() => validateCheckOutcome(outcome));
});

test('a check isolates failed assignments and asks only for missing report evidence', () => {
  const outcome = evaluateCheck(check(), [report('accepted'), report('repair', { output: ' ', findings: [
    { title: 'Bug', description: 'Needs a source line.', severity: 'medium', file: 'server/auth.ts' },
  ] })]);
  assert.equal(outcome.passed, false);
  assert.deepEqual(outcome.units[0], { nodeId: 'accepted', passed: true, retryable: false, reasons: [] });
  assert.equal(outcome.units[1].retryable, true);
  assert.equal(outcome.units[1].reasons.length, 2);
  assert.match(outcome.units[1].reasons[0], /non-empty output/);
  assert.match(outcome.units[1].reasons[1], /positive line number/);
  assert.doesNotThrow(() => validateCheckOutcome(outcome));
});

test('evidence needs a source line or screenshot and demo evidence never satisfies a real check', () => {
  for (const evidence of [{ file: 'src/app.ts', line: 3 }, { screenshot: '/screenshots/verified.png' }]) {
    const finding = { title: 'Issue', description: 'Observed issue.', severity: 'low' as const, ...evidence };
    assert.equal(evaluateCheck(check(), [report('worker', { findings: [finding] })]).passed, true);
    const demo = evaluateCheck(check(), [report('worker', { findings: [{ ...finding, demo: true }] })]);
    assert.equal(demo.passed, false);
    assert.match(demo.units[0].reasons[0], /demo evidence/);
  }
  for (const evidence of [{ file: 'src/app.ts', line: 0 }, { file: 'src/app.ts', line: 0.5 }, { line: 3 }, { screenshot: ' ' }]) {
    assert.equal(evaluateCheck(check(), [report('worker', { findings: [{ title: 'Issue', description: 'Observed issue.', severity: 'low', ...evidence }] })]).passed, false);
  }
});

test('blocked severity fails without inviting the model to erase the issue', () => {
  const outcome = evaluateCheck(check({ blockedSeverities: ['high', 'critical'] }), [report('worker', { findings: [
    { title: 'Security issue', description: 'Requires review.', severity: 'high', file: 'server/auth.ts', line: 4 },
  ] })]);
  assert.equal(outcome.passed, false);
  assert.equal(outcome.units[0].retryable, false);
  assert.match(outcome.units[0].reasons[0], /do not hide/);
  assert.doesNotThrow(() => validateCheckOutcome(outcome));
});

test('judgment checks require a complete score-consistent comparison', () => {
  const node = check({ requireJudgment: true });
  const judgment = { reasoning: 'Compared both candidates.', winnerNodeId: 'a', scores: [{ nodeId: 'a', score: 90, reasoning: 'More complete.' }, { nodeId: 'b', score: 80, reasoning: 'Missing evidence.' }] };
  assert.equal(evaluateCheck(node, [report('judge', { judgment })]).passed, true);
  for (const invalid of [undefined, { ...judgment, winnerNodeId: 'b' }, { ...judgment, scores: [judgment.scores[0]] }, { ...judgment, scores: [judgment.scores[0], judgment.scores[0]] }]) {
    const result = evaluateCheck(node, [report('judge', { judgment: invalid })]);
    assert.equal(result.passed, false);
    assert.equal(result.units[0].retryable, true);
  }
});

test('non-agent reports and duplicate inputs cannot pass and explanations stay bounded', () => {
  const deterministic = report('check', { check: { passed: false, units: [] } });
  assert.equal(evaluateCheck(check(), [deterministic]).units[0].retryable, false);
  const duplicate = evaluateCheck(check(), [report(), report()]);
  assert.equal(duplicate.passed, false);
  assert.equal(duplicate.units.length, 1);
  assert.equal(duplicate.units[0].retryable, false);
  assert.doesNotThrow(() => validateCheckOutcome(duplicate));
  const many = evaluateCheck(check({ blockedSeverities: ['critical'] }), [report('worker', { findings: Array.from({ length: 100 }, (_, i) => ({ title: `Issue ${i}`, description: 'Missing evidence.', severity: i === 99 ? 'critical' : 'low' })) })]);
  assert.equal(many.units[0].reasons.length, 30);
  assert.equal(many.units[0].retryable, false, 'A blocked issue remains non-retryable even after the explanation cap');
  assert.ok(many.units[0].reasons.some(reason => reason.includes('blocked severity critical')), 'The explanation cap must preserve the reason corrections are forbidden');
});
