import { Code2, ListChecks } from 'lucide-react';
import type { NodeResult } from '../shared/types';

export function ExecutionEvidence({ result }: { result: NodeResult }) {
  const tests = result.tests ?? [];
  const changes = result.changes ?? [];
  if (!tests.length && !changes.length) return null;
  return <section className="execution-evidence" aria-label={`Execution evidence for ${result.nodeName}`}>
    {changes.length > 0 && <><h4><Code2 size={15}/>Project file changes</h4><p>Written directly to the selected project during this visit.</p><ul>{changes.map((change, index) => <li key={`${change.path}-${index}`}><span className="badge badge-muted">{change.action === 'created' ? 'Created' : 'Edited'}</span> <code>{change.path}</code></li>)}</ul></>}
    {tests.length > 0 && <><h4><ListChecks size={15}/>Recorded test executions</h4><p>Results captured by Crawlspace from configured commands.</p>{tests.map((test, index) => <article key={`${test.commandId}-${index}`}><div><strong>{test.name}</strong><span className={`badge ${test.passed ? 'badge-green' : 'badge-muted'}`}>{test.timedOut ? 'Timed out' : test.passed ? 'Passed' : 'Failed'}</span></div><small>Exit code {test.exitCode === null ? 'unavailable' : test.exitCode} · {Math.round(test.durationMs / 100) / 10}s</small><details><summary>Command output</summary><pre>{test.output || 'The command produced no output.'}</pre></details></article>)}</>}
  </section>;
}
