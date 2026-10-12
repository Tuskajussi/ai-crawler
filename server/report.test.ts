import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { initialState } from '../shared/defaults';
import { ProjectReader } from './project';
import { parseAgentReport } from './report';

test('reports can request bounded stronger review without choosing destinations or overriding tools', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'crawlspace-report-escalation-'));
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
