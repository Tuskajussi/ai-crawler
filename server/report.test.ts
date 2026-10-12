import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initialState } from '../shared/defaults';
import type { NodeResult } from '../shared/types';
import { ProjectReader } from './project';
import { parseAgentReport } from './report';

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'crawlspace-report-'));
  const root = path.join(directory, 'project');
  await mkdir(root);
  const project = await ProjectReader.open(root);
  return { project, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

const candidates: NodeResult[] = ['alpha', 'beta', 'gamma'].map((nodeId, index) => ({
  nodeId, nodeName: `Candidate ${nodeId}`, modelId: `model-${index}`, cycle: 1,
  output: `Complete candidate answer ${nodeId}`, findings: [], completedAt: '2026-10-09T00:00:00.000Z',
}));
const validJudgment = {
  winnerNodeId: 'beta', reasoning: 'Beta supports the solution with complete evidence.',
  scores: [{ nodeId: 'alpha', score: 70, reasoning: 'Incomplete evidence.' }, { nodeId: 'beta', score: 95, reasoning: 'Complete and correct.' }, { nodeId: 'gamma', score: 60, reasoning: 'Unsupported assumptions.' }],
};
const reportJson = (overrides: Record<string, unknown> = {}) => JSON.stringify({ output: 'Complete answer preserved for downstream agents.', findings: [], messages: [], assignments: [], ...overrides });

test('agent output is preserved and older reviewer reports get a meaningful handoff', async () => {
  const { project, cleanup } = await fixture();
  try {
    const parsed = await parseAgentReport(reportJson(), initialState.workflow, project);
    assert.equal(parsed.output, 'Complete answer preserved for downstream agents.');
    const legacy = await parseAgentReport(JSON.stringify({ findings: [], messages: [{ to: 'all', text: 'No issue verified; inspect empty-list behavior next.' }], assignments: [] }), initialState.workflow, project);
    assert.equal(legacy.output, 'No issue verified; inspect empty-list behavior next.');
    const empty = await parseAgentReport(JSON.stringify({ findings: [], messages: [], assignments: [] }), initialState.workflow, project);
    assert.match(empty.output ?? '', /no verified findings/);
    await assert.rejects(() => parseAgentReport(reportJson({ output: 'x'.repeat(30_001) }), initialState.workflow, project), /30,000/);
    await assert.rejects(() => parseAgentReport(reportJson({ output: ' ' }), initialState.workflow, project), /nonempty/);
  } finally { await cleanup(); }
});

test('judge reports preserve all candidate scores and require a real highest-scoring winner', async () => {
  const { project, cleanup } = await fixture();
  try {
    const parse = (judgment: unknown) => parseAgentReport(reportJson({ judgment }), initialState.workflow, project, undefined, { upstreamResults: candidates, isJudge: true });
    const result = await parse(validJudgment);
    assert.deepEqual(result.judgment, validJudgment);
    const tie = { ...validJudgment, winnerNodeId: null, scores: validJudgment.scores.map(score => ({ ...score, score: 80 })) };
    assert.equal((await parse(tie)).judgment?.winnerNodeId, null);
    await assert.rejects(() => parse({ ...validJudgment, winnerNodeId: 'alpha' }), /highest score/);
    await assert.rejects(() => parse({ ...validJudgment, winnerNodeId: null }), /highest score/);
    await assert.rejects(() => parse({ ...tie, winnerNodeId: 'beta' }), /tied highest/);
    await assert.rejects(() => parse({ ...validJudgment, winnerNodeId: 'source' }), /direct predecessor/);
  } finally { await cleanup(); }
});

test('judge reports reject absent, duplicate, unrelated, malformed, and unbounded scores', async () => {
  const { project, cleanup } = await fixture();
  try {
    const parse = (judgment: unknown, upstreamResults = candidates) => parseAgentReport(reportJson({ judgment }), initialState.workflow, project, undefined, { upstreamResults, isJudge: true });
    await assert.rejects(() => parse(undefined), /judgment object/);
    await assert.rejects(() => parse(validJudgment, candidates.slice(0, 1)), /at least two/);
    await assert.rejects(() => parse({ ...validJudgment, scores: validJudgment.scores.slice(0, 2) }), /every direct predecessor/);
    await assert.rejects(() => parse({ ...validJudgment, scores: [validJudgment.scores[0], validJudgment.scores[0], validJudgment.scores[2]] }), /each direct predecessor once/);
    for (const change of [{ nodeId: 'source' }, { score: 101 }, { score: -1 }, { score: '95' }, { reasoning: '' }]) {
      await assert.rejects(() => parse({ ...validJudgment, scores: validJudgment.scores.map((score, index) => index === 1 ? { ...score, ...change } : score) }), /each direct predecessor once/);
    }
    await assert.rejects(() => parseAgentReport(reportJson({ judgment: validJudgment }), initialState.workflow, project), /Only a judge/);
    await assert.rejects(() => parseAgentReport(JSON.stringify({ findings: [], messages: [], assignments: [], judgment: validJudgment }), initialState.workflow, project, undefined, { upstreamResults: candidates, isJudge: true }), /complete evaluation in output/);
  } finally { await cleanup(); }
});

test('reports can request bounded stronger review without choosing destinations or overriding tools', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'crawlspace-report-escalation-'));
  try {
    const project = await ProjectReader.open(directory);
    const report = { findings: [], messages: [], assignments: [] };
    const parse = (escalation?: unknown) => parseAgentReport(JSON.stringify({ ...report, ...(escalation === undefined ? {} : { escalation }) }), initialState.workflow, project);
    assert.equal((await parse()).escalation, undefined);
    assert.equal((await parseAgentReport(JSON.stringify({ ...report, execution: { modelId: 'fabricated', inputTokens: 0 } }), initialState.workflow, project)).execution, undefined, 'Only the trusted executor may attach execution metrics.');
    assert.deepEqual((await parse({ reason: '  Need a second opinion on concurrent updates.  ' })).escalation, { reason: 'Need a second opinion on concurrent updates.' });
    for (const invalid of [null, [], 'escalate', { reason: '' }, { reason: ' '.repeat(3) }, { reason: 'a'.repeat(2001) }, { reason: 'Need help', modelId: 'unconfigured-cloud' }, { reason: 'Need help', tools: ['bash'] }]) {
      await assert.rejects(parse(invalid), /escalation must contain only a reason/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
