import { useEffect, useMemo, useState } from 'react';
import { Activity, Check, CircleAlert, Cloud, Code2, Cpu, LoaderCircle, RefreshCw, Wrench } from 'lucide-react';
import type { AppState } from '../shared/types';
import type { ModelReliabilitySummary, ReliabilityOutcome, ReliabilitySnapshot, ReliabilityToolName, ReliabilityToolSummary, ReliabilityVisit } from '../shared/reliability';
import './reliability.css';

const outcomeLabels: Record<ReliabilityOutcome, string> = {
  success: 'Successful', invalid_arguments: 'Invalid arguments', unknown_tool: 'Unknown tool',
  execution_error: 'Tool or service error', code_error: 'Code error', blocked: 'Blocked',
  cancelled: 'Cancelled', interrupted: 'Interrupted', truncated: 'Output limit reached',
};
const toolLabels: Record<ReliabilityToolName, string> = {
  project_read: 'Read project file', project_ls: 'List project files', project_find: 'Find project files',
  project_grep: 'Search project text', list_staff: 'Read team directory', capture_ui: 'Capture UI',
  codemode: 'Code Mode', connection_check: 'Connection check', '[unknown tool]': 'Unknown tool',
};
const visitLabels = { success: 'Completed', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted' };
const failureLabels = { transient: 'Provider error', report: 'Invalid report', configuration: 'Configuration error', timeout: 'Time limit reached' };
const percent = (successful: number, finished: number) => finished ? `${(successful / finished * 100).toFixed(1)}%` : 'No sample';
const dateTime = (value: string) => new Date(value).toLocaleString();
const elapsed = (milliseconds: number) => milliseconds < 1000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
const shortId = (value: string) => value.length > 15 ? `${value.slice(0, 12)}...` : value;

function Rate({ title, summary }: { title: string; summary: ReliabilityToolSummary }) {
  return <div className="reliability-rate"><span>{title}</span><strong>{percent(summary.outcomes.success, summary.completed)}</strong><small>{summary.completed ? `${summary.outcomes.success} successful / ${summary.completed} finished calls` : `${summary.total} observed calls; none finished`}</small></div>;
}

function ToolBreakdown({ group }: { group: ModelReliabilitySummary }) {
  const rows = Object.entries(group.byTool) as [ReliabilityToolName, ReliabilityToolSummary][];
  return <details className="reliability-breakdown"><summary>Tool outcomes <span>{rows.length} {rows.length === 1 ? 'tool' : 'tools'}</span></summary>
    {rows.length ? <div className="reliability-tool-list">{rows.map(([tool, summary]) => <article className="reliability-tool" key={tool}>
      <header><strong>{toolLabels[tool]}</strong><span>{summary.total} observed · {summary.completed} finished</span><b>{percent(summary.outcomes.success, summary.completed)}</b></header>
      <dl>{Object.entries(summary.outcomes).filter(([, count]) => count > 0).map(([outcome, count]) => <div key={outcome} className={`outcome-${outcome}`}><dt>{outcomeLabels[outcome as ReliabilityOutcome]}</dt><dd>{count}</dd></div>)}</dl>
      {summary.averageDurationMs !== null && <p>Average recorded call time: {elapsed(summary.averageDurationMs)}</p>}
    </article>)}</div> : <p className="reliability-help">No tool calls were observed for these visits.</p>}
  </details>;
}

function ModelCard({ group }: { group: ModelReliabilitySummary }) {
  const model = group.model;
  return <article className="reliability-model" aria-label={`${model.name}, configuration ${model.fingerprint.slice(0, 8)}, Code Mode ${group.codeMode ? 'on' : 'off'}`}>
    <header className="reliability-model-heading"><span className={`reliability-model-icon ${model.kind}`}>{model.kind === 'local' ? <Cpu size={20} /> : <Cloud size={20} />}</span><div><h3>{model.name}</h3><p>{model.modelId}</p></div><span className="reliability-location">{model.kind === 'local' ? 'Local' : 'Cloud'}</span></header>
    <div className="reliability-config"><span><Code2 size={12} />Code Mode {group.codeMode ? 'on' : 'off'}</span><code>Config {model.fingerprint.slice(0, 12)}</code><span>{group.visits} measured {group.visits === 1 ? 'visit' : 'visits'}</span></div>
    <p className="reliability-endpoint"><span>Endpoint</span><code>{model.endpoint}</code></p>
    <div className="reliability-model-rates"><Rate title="Tool success" summary={group.tools} /><Rate title="Code Mode success" summary={group.codeModeCalls} /></div>
    <dl className="reliability-visit-counts">{Object.entries(group.statuses).map(([status, count]) => <div key={status}><dt>{visitLabels[status as keyof typeof visitLabels]}</dt><dd>{count}</dd></div>)}</dl>
    <dl className="reliability-operation-counts"><div><dt>Model requests</dt><dd>{group.requests}</dd></div><div><dt>Retries</dt><dd>{group.retryAttempts}</dd></div><div><dt>Provider errors</dt><dd>{group.providerFailures}</dd></div><div><dt>Rejected reports</dt><dd>{group.reportRejections}</dd></div><div><dt>Report repair attempts</dt><dd>{group.reportRepairs}</dd></div></dl>
    <details className="reliability-settings"><summary>Execution settings and visit failures</summary><dl><div><dt>Reasoning</dt><dd>{model.reasoningEffort}</dd></div><div><dt>Context window</dt><dd>{model.contextWindow.toLocaleString()}</dd></div><div><dt>Output limit</dt><dd>{model.maxOutputTokens.toLocaleString()}</dd></div><div><dt>Visit time limit</dt><dd>{model.timeoutSeconds} s</dd></div><div><dt>Parallel requests</dt><dd>{model.maxConcurrentRequests}</dd></div><div><dt>Image input</dt><dd>{model.supportsImages ? 'Supported' : 'Unavailable'}</dd></div><div><dt>Authentication</dt><dd>{model.authMethod === 'chatgpt' ? 'ChatGPT connection' : 'Standard endpoint'}</dd></div>{Object.entries(group.failures).map(([failure, count]) => <div key={failure}><dt>{failureLabels[failure as keyof typeof failureLabels]}</dt><dd>{count} visits</dd></div>)}</dl></details>
    <ToolBreakdown group={group} />
    {group.omittedCalls > 0 && <p className="reliability-omitted">{group.omittedCalls} additional calls exceeded the per-visit recording limit and are excluded from call rates.</p>}
    <footer>Last observed {dateTime(group.lastSeenAt)}</footer>
  </article>;
}

export function ReliabilityPanel({ state }: { state: AppState }) {
  const [snapshot, setSnapshot] = useState<ReliabilitySnapshot>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshedAt, setRefreshedAt] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [selectedKey, setSelectedKey] = useState('all');

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;
    const load = async () => {
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 15_000);
      setLoading(true);
      try {
        const response = await fetch('/api/reliability', { signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `History request failed (${response.status})`);
        if (stopped) return;
        setSnapshot(data as ReliabilitySnapshot); setRefreshedAt(new Date().toISOString()); setError('');
      } catch (failure) {
        if (!stopped) setError(controller.signal.aborted ? 'The history refresh timed out.' : (failure as Error).message);
      } finally {
        clearTimeout(timeout);
        if (!stopped) { setLoading(false); timer = setTimeout(() => void load(), 5000); }
      }
    };
    void load();
    return () => { stopped = true; clearTimeout(timer); controller?.abort(); };
  }, [refresh]);

  useEffect(() => {
    if (snapshot && selectedKey !== 'all' && !snapshot.models.some(group => group.key === selectedKey)) setSelectedKey('all');
  }, [snapshot, selectedKey]);

  const selectedGroup = snapshot?.models.find(group => group.key === selectedKey);
  const groups = selectedGroup ? [selectedGroup] : snapshot?.models ?? [];
  const totals = useMemo(() => groups.reduce((total, group) => ({
    visits: total.visits + group.visits, retries: total.retries + group.retryAttempts,
    successfulTools: total.successfulTools + group.tools.outcomes.success, finishedTools: total.finishedTools + group.tools.completed,
    successfulCode: total.successfulCode + group.codeModeCalls.outcomes.success, finishedCode: total.finishedCode + group.codeModeCalls.completed,
  }), { visits: 0, retries: 0, successfulTools: 0, finishedTools: 0, successfulCode: 0, finishedCode: 0 }), [groups]);
  const recentVisits = (snapshot?.recentVisits ?? []).filter(visit => !selectedGroup || (visit.model.fingerprint === selectedGroup.model.fingerprint && visit.codeMode === selectedGroup.codeMode));
  const agentName = (visit: ReliabilityVisit) => visit.source === 'probe' ? 'Connection check' : state.workflow.nodes.find(node => node.id === visit.nodeId)?.data.label || shortId(visit.nodeId);

  return <section className="panel reliability-panel">
    <div className="page-header"><div><div className="page-kicker">OBSERVE YOUR TEAM</div><h1>Tool reliability</h1><p>See how each model uses tools and Code Mode in this workspace. Real Pi workflow visits appear after they finish or stop. Demo runs and connection checks are excluded.</p></div><button type="button" className="btn btn-secondary" disabled={loading} onClick={() => setRefresh(value => value + 1)}>{loading ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}Refresh history</button></div>
    {error && <div className="reliability-error" role="alert"><CircleAlert size={16} /><div><strong>Could not refresh reliability history.</strong><p>{error}</p>{snapshot && <p>Showing the last successful snapshot from {refreshedAt ? dateTime(refreshedAt) : 'an earlier refresh'}.</p>}</div></div>}
    {snapshot && !snapshot.storage.healthy && <div className="reliability-error" role="alert"><CircleAlert size={16} /><div><strong>History storage needs attention.</strong><p>{snapshot.storage.message || 'Some observations could not be saved. Counts may be incomplete.'}</p></div></div>}
    {!snapshot ? <div className="reliability-empty">{loading ? <><LoaderCircle size={29} className="spin" /><h2>Loading measured history</h2></> : <><CircleAlert size={29} /><h2>History is unavailable</h2><p>Use Refresh history to try again.</p></>}</div> : <>
      <div className="reliability-retention"><Activity size={14} /><span>{snapshot.retention.retainedVisits} of up to {snapshot.retention.maxVisits.toLocaleString()} retained visits{snapshot.retention.oldestAt ? ` · Since ${dateTime(snapshot.retention.oldestAt)}` : ''}</span><small>{refreshedAt ? `Refreshed ${new Date(refreshedAt).toLocaleTimeString()}` : ''}</small></div>
      {snapshot.models.length === 0 ? <div className="reliability-empty"><Wrench size={31} /><h2>No measured visits yet</h2><p>Run a Pi workflow to collect observations. Completed or stopped visits are recorded after pending work ends. Rates appear only after calls are recorded.</p><span>Metadata only. Tool inputs, outputs and source text are not saved in this history.</span></div> : <>
        <div className="reliability-filter"><label htmlFor="reliability-model-filter">Model configuration</label><select id="reliability-model-filter" value={selectedKey} onChange={event => setSelectedKey(event.target.value)}><option value="all">All model configurations</option>{snapshot.models.map(group => <option key={group.key} value={group.key}>{group.model.name} · {group.model.fingerprint.slice(0, 8)} · Code Mode {group.codeMode ? 'on' : 'off'}</option>)}</select></div>
        <div className="reliability-overview" aria-label="Observed totals"><article><Activity size={16} /><span>Measured visits</span><strong>{totals.visits}</strong><small>{groups.length} {groups.length === 1 ? 'configuration' : 'configurations'}</small></article><article><Wrench size={16} /><span>Tool success</span><strong>{percent(totals.successfulTools, totals.finishedTools)}</strong><small>{totals.successfulTools} / {totals.finishedTools} finished calls</small></article><article><Code2 size={16} /><span>Code Mode success</span><strong>{percent(totals.successfulCode, totals.finishedCode)}</strong><small>{totals.successfulCode} / {totals.finishedCode} finished calls</small></article><article><RefreshCw size={16} /><span>Retries</span><strong>{totals.retries}</strong><small>Additional model attempts</small></article></div>
        <div className="reliability-method"><p>Rates show successful calls divided by finished calls. Tool calls and Code Mode have separate counts.</p><details><summary>How rates are calculated</summary><p>Invalid arguments, unknown tools, tool/service errors, code errors and output limits count as finished. Blocked, cancelled and interrupted calls are shown separately and excluded from the rate.</p></details></div>
        <div className="reliability-section-heading"><h2>Models and execution settings</h2><p>Each endpoint and configuration keeps its own observations. Sample counts and task mix matter when comparing results.</p></div>
        <div className="reliability-models">{groups.map(group => <ModelCard key={group.key} group={group} />)}</div>
        <section className="reliability-recent"><div className="reliability-section-heading"><h2>Recent visits</h2><p>Newest {recentVisits.length} matching visits from the last 50 retained visits.</p></div>{recentVisits.length ? <div className="reliability-visits">{recentVisits.map(visit => <article key={visit.id} className="reliability-visit"><header><span className={`reliability-visit-status visit-${visit.status}`}>{visit.status === 'success' && <Check size={12} />}{visitLabels[visit.status]}</span><strong>{agentName(visit)}</strong><time dateTime={visit.finishedAt}>{dateTime(visit.finishedAt)}</time></header><p><span>{visit.model.name}</span><span>{visit.model.kind === 'local' ? 'Local' : 'Cloud'}</span><span>Code Mode {visit.codeMode ? 'on' : 'off'}</span><code>Config {visit.model.fingerprint.slice(0, 12)}</code></p><dl><div><dt>{visit.source === 'probe' ? 'Check' : 'Run'}</dt><dd title={visit.runId}>{shortId(visit.runId)}</dd></div><div><dt>Cycle</dt><dd>{visit.cycle}</dd></div><div><dt>Duration</dt><dd>{elapsed(visit.durationMs)}</dd></div><div><dt>Retries</dt><dd>{visit.retryAttempts}</dd></div><div><dt>Provider errors</dt><dd>{visit.providerFailures}</dd></div><div><dt>Repair attempts</dt><dd>{visit.reportRepairs}</dd></div></dl>{visit.failure && <p className="reliability-visit-failure">Visit failure: {failureLabels[visit.failure]}</p>}<div className="reliability-call-tags">{visit.calls.length ? visit.calls.map((call, index) => <span className={`outcome-${call.outcome}`} key={index}>{toolLabels[call.tool]} · {outcomeLabels[call.outcome]}</span>) : <span>No tool calls recorded</span>}{visit.omittedCalls > 0 && <span>{visit.omittedCalls} additional calls omitted</span>}</div></article>)}</div> : <p className="reliability-help">No visits for this configuration occur in the most recent 50 records.</p>}</section>
      </>}
      <p className="reliability-privacy">History contains identifiers, settings, counts and outcomes. Tool arguments, results, prompts and report text are not stored. Observations do not change model routing or workflow settings.</p>
    </>}
  </section>;
}
