import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Activity, ArrowUpRight, Bot, Check, CheckCircle2, Clock3, Code2, Cpu, FileCode2, Image, Inbox, ListFilter, MessageSquare, Monitor, Pencil, Play, Plus, Search, Send, Settings2, ShieldCheck, Sparkles, Trash2, Users, X } from 'lucide-react';
import type { AppState, Finding, Message, ModelConfig, Workflow } from '../shared/types';

type StateProps = { state: AppState };

const severityLabel: Record<Finding['severity'], string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
const findingStatusLabel: Record<Finding['status'], string> = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved' };

function dateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown time' : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function relativeTime(value: string) {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed)) return 'Unknown time';
  if (elapsed < 60_000) return 'Just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return dateTime(value);
}

function agentName(state: AppState, id: string) {
  if (id === 'all') return 'Everyone';
  if (id === 'user' || id === 'you') return 'You';
  if (id === 'system') return 'System';
  return state.workflow.nodes.find(node => node.id === id)?.data.label ?? id;
}

function EmptyState({ icon: Icon = Inbox, title, children }: { icon?: typeof Inbox; title: string; children: ReactNode }) {
  return <div className="empty-state"><span className="empty-state-icon"><Icon size={25} /></span><h3>{title}</h3><p>{children}</p></div>;
}

function useDialogFocus(active: boolean) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement;
    const focusable = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex="0"]') ?? []);
    focusable()[0]?.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const elements = focusable();
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', trapFocus);
    return () => { document.removeEventListener('keydown', trapFocus); if (previous instanceof HTMLElement) previous.focus(); };
  }, [active]);
  return ref;
}

export function FindingsPanel({ state, onStatus }: StateProps & { onStatus: (id: string, status: Finding['status']) => void }) {
  const [query, setQuery] = useState('');
  const [severity, setSeverity] = useState('all');
  const [status, setStatus] = useState('all');
  const [preview, setPreview] = useState<Finding | null>(null);
  const dialogRef = useDialogFocus(!!preview);
  const findings = useMemo(() => state.findings.filter(finding =>
    (severity === 'all' || finding.severity === severity) &&
    (status === 'all' || finding.status === status) &&
    `${finding.title} ${finding.description} ${finding.file ?? ''} ${agentName(state, finding.nodeId)}`.toLowerCase().includes(query.toLowerCase())
  ), [state, query, severity, status]);
  const openCount = state.findings.filter(f => f.status !== 'resolved').length;

  useEffect(() => {
    if (!preview) return;
    const handleKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setPreview(null); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [preview]);

  return <section className="panel findings-panel">
    <div className="page-header"><div><div className="page-kicker">THE OBSERVATION DESK</div><h1>Findings <span className="heading-count">{state.findings.length}</span></h1><p>Small details. Better software. Everything your agents discover, in one place.</p></div><span className="badge badge-green"><span className="status-dot" />{openCount} need attention</span></div>
    <div className="panel-toolbar">
      <label className="search-field"><Search size={17} /><input aria-label="Search findings" placeholder="Search findings or files…" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="toolbar-filters"><ListFilter size={16} /><select aria-label="Filter by severity" value={severity} onChange={event => setSeverity(event.target.value)}><option value="all">All severities</option>{Object.entries(severityLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select aria-label="Filter by status" value={status} onChange={event => setStatus(event.target.value)}><option value="all">All statuses</option>{Object.entries(findingStatusLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
    </div>
    {findings.length === 0 ? <EmptyState icon={ShieldCheck} title={state.findings.length ? 'No matching findings' : 'A fresh pair of eyes, ready to work'}>{state.findings.length ? 'Try another search or clear the filters to see more findings.' : 'Run your workflow to collect file reviews and UI observations. Findings will appear here with their source and severity.'}</EmptyState> : <div className="findings-grid">{findings.map(finding => <article className={`finding-card card severity-${finding.severity}`} key={finding.id}>
      <div className="card-topline"><div className="badge-group"><span className={`badge severity-badge severity-${finding.severity}`}><span className="status-dot" />{severityLabel[finding.severity]}</span>{finding.demo && <span className="badge badge-muted">Demo</span>}</div><time title={dateTime(finding.createdAt)} dateTime={finding.createdAt}>{relativeTime(finding.createdAt)}</time></div>
      <h3>{finding.title}</h3><p className="finding-description">{finding.description}</p>
      {finding.file && <div className="finding-file"><FileCode2 size={14} /><code>{finding.file}{finding.line ? `:${finding.line}` : ''}</code></div>}
      {finding.screenshot && <button type="button" className="screenshot-thumbnail" onClick={() => setPreview(finding)} aria-label={`View screenshot for ${finding.title}`}><img src={finding.screenshot} alt={`Screenshot evidence for ${finding.title}`} /><span><Image size={15} />View screenshot</span></button>}
      <div className="finding-footer"><span className="finding-author"><Bot size={15} />{agentName(state, finding.nodeId)}</span><select className={`status-select status-${finding.status}`} aria-label={`Status of ${finding.title}`} value={finding.status} onChange={event => onStatus(finding.id, event.target.value as Finding['status'])}>{Object.entries(findingStatusLabel).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div>
    </article>)}</div>}
    {preview && <div className="modal-overlay" onClick={() => setPreview(null)}><section ref={dialogRef} className="modal screenshot-modal" role="dialog" aria-modal="true" aria-labelledby="screenshot-title" onClick={event => event.stopPropagation()}><div className="modal-header"><div><div className="page-kicker">SCREENSHOT EVIDENCE</div><h2 id="screenshot-title">{preview.title}</h2></div><button type="button" className="btn-icon" onClick={() => setPreview(null)} aria-label="Close screenshot"><X size={20} /></button></div><img className="screenshot-full" src={preview.screenshot} alt={`Screenshot evidence for ${preview.title}`} /><p>{preview.description}</p></section></div>}
  </section>;
}

export function MessagesPanel({ state, onSend }: StateProps & { onSend: (text: string, to: string, type: Message['type']) => Promise<void> | void }) {
  const [text, setText] = useState('');
  const [to, setTo] = useState('all');
  const [type, setType] = useState<Message['type']>('message');
  const [filter, setFilter] = useState('all');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const messages = state.messages.filter(message => filter === 'all' || message.from === filter || message.to === filter);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sending) return;
    if (!text.trim()) { setError('Write a message before sending.'); return; }
    if (type === 'assignment' && to === 'all') { setError('Choose an agent to receive this assignment.'); return; }
    if (to !== 'all' && !state.workflow.nodes.some(node => node.id === to)) { setError('Choose an available agent.'); return; }
    setSending(true);
    try { await onSend(text.trim(), to, type); setText(''); setError(''); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not send your message. Try again.'); }
    finally { setSending(false); }
  }
  return <section className="panel messages-panel">
    <div className="page-header"><div><div className="page-kicker">SHARED CONTEXT, BETTER WORK</div><h1>Team inbox <span className="heading-count">{state.messages.length}</span></h1><p>Keep discoveries, handoffs, and the next assignment in the same conversation.</p></div><span className="badge badge-muted"><Users size={14} />{state.workflow.nodes.length} agents connected</span></div>
    <div className="panel-toolbar"><div className="section-label"><MessageSquare size={16} /> Shared conversation</div><select aria-label="Filter conversation by agent" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All agents</option>{state.workflow.nodes.map(node => <option key={node.id} value={node.id}>{node.data.label}</option>)}</select></div>
    <div className="message-thread" aria-live="polite">{messages.length === 0 ? <EmptyState icon={MessageSquare} title="The conversation starts here">Send a note to the team or assign an agent a task. Agents share their handoffs here as the workflow runs.</EmptyState> : messages.map(message => <article className={`message-card ${message.type === 'system' ? 'system-message' : ''}`} key={message.id}>
      <div className="message-avatar">{message.from === 'user' || message.from === 'you' ? <Users size={18} /> : message.from === 'system' ? <Activity size={18} /> : <Bot size={18} />}</div>
      <div className="message-content"><div className="message-topline"><strong>{agentName(state, message.from)}</strong><span className="message-destination"><ArrowUpRight size={12} />{agentName(state, message.to)}</span>{message.type === 'assignment' && <span className="badge badge-green">Assignment</span>}{message.type === 'system' && <span className="badge badge-muted">System</span>}<time dateTime={message.createdAt} title={dateTime(message.createdAt)}>{relativeTime(message.createdAt)}</time></div><p>{message.text}</p></div>
    </article>)}</div>
    <form className="composer card" onSubmit={submit}><label className="sr-only" htmlFor="message-text">Your message</label><textarea id="message-text" disabled={sending} placeholder={type === 'assignment' ? 'Describe the task, the expected outcome, and any useful context…' : 'Share an observation, ask a question, or leave the team a note…'} value={text} onChange={event => { setText(event.target.value); setError(''); }} rows={3} maxLength={20_000} /><div className="composer-footer"><div className="composer-controls"><label><span>To</span><select aria-label="Message recipient" disabled={sending} value={to} onChange={event => { setTo(event.target.value); setError(''); }}><option value="all">Everyone</option>{state.workflow.nodes.map(node => <option key={node.id} value={node.id}>{node.data.label}</option>)}</select></label><select aria-label="Message type" disabled={sending} value={type} onChange={event => { setType(event.target.value as Message['type']); setError(''); }}><option value="message">Message</option><option value="assignment">Assignment</option></select></div><button className="btn btn-primary" type="submit" disabled={sending || !text.trim()}><Send size={15} />{sending ? 'Sending…' : `Send ${type === 'assignment' ? 'assignment' : 'message'}`}</button></div>{error && <p className="form-error" role="alert">{error}</p>}</form>
  </section>;
}

export function StaffPanel({ state, onSelect }: StateProps & { onSelect: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const nodes = state.workflow.nodes.filter(node => `${node.data.label} ${node.data.role} ${node.data.description} ${node.data.responsibilities.join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="panel staff-panel"><div className="page-header"><div><div className="page-kicker">A PLACE FOR EVERY SPECIALIST</div><h1>Your staff <span className="heading-count">{state.workflow.nodes.length}</span></h1><p>Know who is working on what, and where the next task belongs.</p></div><span className="badge badge-green"><span className="status-dot" />{state.workflow.nodes.filter(node => node.data.status === 'running').length} working now</span></div>
    <div className="panel-toolbar"><label className="search-field"><Search size={17} /><input aria-label="Search staff" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find an agent or responsibility…" /></label><span className="toolbar-hint">Each agent is a node in your workflow.</span></div>
    {nodes.length === 0 ? <EmptyState icon={Users} title={state.workflow.nodes.length ? 'No agents match your search' : 'Build your team'}>{state.workflow.nodes.length ? 'Try a different name, role, or responsibility.' : 'Add a node in the workflow builder to create your first specialist.'}</EmptyState> : <div className="staff-grid">{nodes.map(node => { const model = state.models.find(item => item.id === node.data.modelId); const lastAssignment = [...state.messages].reverse().find(message => message.to === node.id && message.type === 'assignment'); return <article key={node.id} className="staff-card card"><div className="card-topline"><span className="agent-avatar" style={{ background: `${node.data.color}18`, color: node.data.color }}><Bot size={24} /></span><span className={`badge agent-status status-${node.data.status}`}><span className="status-dot" />{node.data.status === 'done' ? 'Finished' : node.data.status === 'running' ? 'Working' : node.data.status === 'error' ? 'Needs attention' : 'Ready'}</span></div><div className="staff-identity"><h3>{node.data.label}</h3><span className="role-label">{node.data.role}</span></div><p>{node.data.description || 'A specialist in your workflow.'}</p><div className="staff-responsibilities"><span className="field-label">RESPONSIBILITIES</span><div className="tag-list">{node.data.responsibilities.length ? node.data.responsibilities.map((responsibility, index) => <span className="tag" key={`${responsibility}-${index}`}>{responsibility}</span>) : <span className="muted">No responsibilities set yet.</span>}</div></div>{lastAssignment && <div className="staff-assignment"><span className="field-label">LATEST ASSIGNMENT</span><p>{lastAssignment.text}</p></div>}<div className="staff-footer"><span><Cpu size={14} />{model?.name ?? 'No model assigned'}</span><button type="button" className="btn btn-secondary btn-small" onClick={() => onSelect(node.id)}>Edit agent <ArrowUpRight size={14} /></button></div></article>; })}</div>}
  </section>;
}

const newModel = (): ModelConfig => ({ id: `model-${crypto.randomUUID()}`, name: '', provider: 'ollama', modelId: '', kind: 'local', baseUrl: 'http://localhost:11434/v1', apiKeyEnv: '', enabled: true, contextWindow: 32768, supportsImages: false });

export function ModelsPanel({ state, onSave }: StateProps & { onSave: (models: ModelConfig[]) => Promise<void> | void }) {
  const [draft, setDraft] = useState<ModelConfig | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [error, setError] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  function edit(model: ModelConfig) { setDraft({ ...model }); setIsNew(false); setError(''); setDeleteId(null); }
  function update(changes: Partial<ModelConfig>) { setDraft(current => current ? { ...current, ...changes } : current); setError(''); }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!draft) return;
    if (saving) return;
    if (!draft.name.trim() || !draft.modelId.trim()) { setError('Give this model a display name and a model ID.'); return; }
    if (draft.contextWindow !== undefined && (!Number.isInteger(draft.contextWindow) || draft.contextWindow < 1024 || draft.contextWindow > 10000000)) { setError('Context window must be a whole number from 1,024 to 10,000,000 tokens.'); return; }
    if (draft.baseUrl.trim()) { try { const url = new URL(draft.baseUrl); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); } catch { setError('Base URL must be a complete http:// or https:// address.'); return; } }
    if ((draft.provider === 'ollama' || draft.provider === 'custom') && !draft.baseUrl.trim()) { setError('Add the base URL for this model endpoint.'); return; }
    if (draft.apiKeyEnv.trim() && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(draft.apiKeyEnv.trim())) { setError('Use an environment variable name, such as OPENAI_API_KEY.'); return; }
    const saved = { ...draft, name: draft.name.trim(), modelId: draft.modelId.trim(), baseUrl: draft.baseUrl.trim(), apiKeyEnv: draft.apiKeyEnv.trim() };
    setSaving(true);
    try { await onSave(isNew ? [...state.models, saved] : state.models.map(model => model.id === saved.id ? saved : model)); setDraft(null); setError(''); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save this model. Try again.'); }
    finally { setSaving(false); }
  }
  async function removeModel(id: string) {
    if (saving) return;
    setSaving(true); setError('');
    try { await onSave(state.models.filter(model => model.id !== id)); setDeleteId(null); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not remove this model. Try again.'); }
    finally { setSaving(false); }
  }
  function providerChange(provider: ModelConfig['provider']) {
    const defaults = { ollama: { kind: 'local' as const, baseUrl: 'http://localhost:11434/v1', apiKeyEnv: '', supportsImages: false }, anthropic: { kind: 'cloud' as const, baseUrl: '', apiKeyEnv: 'ANTHROPIC_API_KEY', supportsImages: true }, openai: { kind: 'cloud' as const, baseUrl: '', apiKeyEnv: 'OPENAI_API_KEY', supportsImages: true }, custom: { kind: 'cloud' as const, baseUrl: '', apiKeyEnv: '', supportsImages: false } };
    update({ provider, ...defaults[provider] });
  }
  return <section className="panel models-panel"><div className="page-header"><div><div className="page-kicker">THE RIGHT MIND FOR THE JOB</div><h1>Model library <span className="heading-count">{state.models.length}</span></h1><p>Connect local or cloud models, then assign the right one to each agent.</p></div><button className="btn btn-primary" type="button" disabled={saving} onClick={() => { setDraft(newModel()); setIsNew(true); setError(''); setDeleteId(null); }}><Plus size={16} />Add model</button></div>
    <div className="model-info-strip"><ShieldCheck size={18} /><p>Credentials stay on your machine. Reference an environment variable; your API key is never stored in the workflow.</p></div>
    {draft && <form className="model-editor card" onSubmit={save}><fieldset disabled={saving} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}><div className="section-heading"><div><div className="page-kicker">MODEL CONNECTION</div><h2>{isNew ? 'Add a model' : 'Edit model'}</h2></div><button className="btn-icon" type="button" aria-label="Close model editor" onClick={() => setDraft(null)}><X size={18} /></button></div><div className="form-grid">
      <label className="field"><span>Display name</span><input autoFocus value={draft.name} onChange={event => update({ name: event.target.value })} placeholder="e.g. Local code reviewer" required maxLength={100} /></label>
      <label className="field"><span>Provider</span><select value={draft.provider} onChange={event => providerChange(event.target.value as ModelConfig['provider'])}><option value="ollama">Ollama</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="custom">OpenAI-compatible endpoint</option></select></label>
      <label className="field"><span>Model ID</span><input value={draft.modelId} onChange={event => update({ modelId: event.target.value })} placeholder="Provider's exact model identifier" required maxLength={200} /><small>Must match a model available at your provider.</small></label>
      <label className="field"><span>Runs on</span><select value={draft.kind} onChange={event => update({ kind: event.target.value as ModelConfig['kind'] })}><option value="local">Local machine</option><option value="cloud">Cloud</option></select></label>
      <label className="field"><span>Base URL {draft.provider === 'ollama' || draft.provider === 'custom' ? '' : '(optional)'}</span><input type="url" value={draft.baseUrl} onChange={event => update({ baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /><small>Leave blank to use the provider's default endpoint.</small></label>
      <label className="field"><span>API key environment variable</span><input value={draft.apiKeyEnv} onChange={event => update({ apiKeyEnv: event.target.value })} placeholder={draft.kind === 'local' ? 'Optional for local endpoints' : 'e.g. OPENAI_API_KEY'} autoComplete="off" spellCheck={false} /><small>Enter the variable name, never the API key itself.</small></label>
      <label className="field"><span>Context window (tokens)</span><input type="number" min={1024} max={10000000} step={1} value={draft.contextWindow ?? ''} onChange={event => update({ contextWindow: event.target.value ? Number(event.target.value) : undefined })} placeholder="Optional" /></label>
      <label className="checkbox-field"><input type="checkbox" checked={draft.enabled} onChange={event => update({ enabled: event.target.checked })} /><span>Available to agents<small>Enabled models appear in the node's model chooser.</small></span></label>
      <label className="checkbox-field"><input type="checkbox" checked={draft.supportsImages ?? false} onChange={event => update({ supportsImages: event.target.checked })} /><span>Image input supported<small>Required for agents that inspect UI screenshots. Enable only for a vision model.</small></span></label>
    </div>{error && <p role="alert" className="form-error">{error}</p>}<div className="form-actions"><button type="button" className="btn btn-secondary" onClick={() => setDraft(null)}>Cancel</button><button className="btn btn-primary" type="submit"><Check size={16} />{saving ? 'Saving…' : 'Save model'}</button></div></fieldset></form>}
    {error && !draft && <p role="alert" className="form-error">{error}</p>}{!state.models.length ? <EmptyState icon={Cpu} title="Give your agents a model">Add a local endpoint or cloud provider to start building your model library.</EmptyState> : <div className="model-grid">{state.models.map(model => { const assigned = state.workflow.nodes.filter(node => node.data.modelId === model.id); return <article className={`model-card card ${!model.enabled ? 'model-disabled' : ''}`} key={model.id}><div className="card-topline"><span className={`model-avatar ${model.kind === 'local' ? 'local-model' : 'cloud-model'}`}>{model.kind === 'local' ? <Monitor size={23} /> : <Sparkles size={23} />}</span><span className={`badge ${model.enabled ? 'badge-green' : 'badge-muted'}`}><span className="status-dot" />{model.enabled ? 'Enabled' : 'Disabled'}</span></div><h3>{model.name}</h3><code className="model-identifier">{model.modelId}</code><div className="tag-list"><span className="tag">{model.provider === 'custom' ? 'Custom endpoint' : model.provider}</span><span className="tag">{model.kind === 'local' ? 'Local' : 'Cloud'}</span>{model.supportsImages && <span className="tag"><Image size={12} />Image input</span>}{model.contextWindow && <span className="tag">{new Intl.NumberFormat().format(model.contextWindow)} context</span>}</div><div className="model-details">{model.baseUrl && <p><span>Endpoint</span><code>{model.baseUrl}</code></p>}<p><span>Credential</span><code>{model.apiKeyEnv || 'No key required'}</code></p></div><div className="model-card-footer"><span><Users size={14} />{assigned.length} {assigned.length === 1 ? 'agent' : 'agents'}</span><div className="card-actions"><button type="button" className="btn-icon" aria-label={`Edit ${model.name}`} disabled={saving} onClick={() => edit(model)}><Pencil size={16} /></button><button type="button" className="btn-icon" aria-label={`Remove ${model.name}`} disabled={saving} onClick={() => { setDeleteId(model.id); setDraft(null); }}><Trash2 size={16} /></button></div></div>{deleteId === model.id && <div className="inline-confirm"><p>{assigned.length ? `This model is assigned to ${assigned.length} ${assigned.length === 1 ? 'agent' : 'agents'}. Reassign them before removing it.` : `Remove ${model.name} from your library?`}</p><div className="form-actions"><button className="btn btn-secondary btn-small" type="button" disabled={saving} onClick={() => setDeleteId(null)}>Cancel</button>{!assigned.length && <button className="btn btn-danger btn-small" type="button" disabled={saving} onClick={() => void removeModel(model.id)}>Remove model</button>}</div></div>}</article>; })}</div>}
  </section>;
}

export function RunsPanel({ state }: StateProps) {
  const completeCount = state.runs.filter(run => run.status === 'completed').length;
  return <section className="panel runs-panel"><div className="page-header"><div><div className="page-kicker">A RECORD OF THE WORK</div><h1>Run history <span className="heading-count">{state.runs.length}</span></h1><p>Follow every cycle, handoff, and completed pass through your workflow.</p></div><span className="badge badge-green"><CheckCircle2 size={14} />{completeCount} completed</span></div>
    {!state.runs.length ? <EmptyState icon={Activity} title="Your first run is ahead">Start the workflow from the builder. Each run will appear here with its progress and any errors.</EmptyState> : <div className="runs-list">{[...state.runs].reverse().map((run, index) => { const started = new Date(run.startedAt).getTime(); const finished = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now(); const seconds = Math.max(0, Math.round((finished - started) / 1000)); const duration = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`; return <article className={`run-card card run-${run.status}`} key={run.id}><div className="run-icon">{run.status === 'completed' ? <CheckCircle2 size={22} /> : run.status === 'running' ? <Activity size={22} /> : run.status === 'failed' ? <X size={22} /> : <Clock3 size={22} />}</div><div className="run-body"><div className="run-topline"><h3>Run {state.runs.length - index}</h3><span className={`badge run-status status-${run.status}`}>{run.status.charAt(0).toUpperCase() + run.status.slice(1)}</span><span className="tag">{run.mode === 'demo' ? 'Demo' : 'Pi harness'}</span></div><div className="run-meta"><time dateTime={run.startedAt}>{dateTime(run.startedAt)}</time><span><Clock3 size={13} />{Number.isFinite(seconds) ? duration : 'Unknown duration'}</span><span>{run.cycle} {run.cycle === 1 ? 'cycle' : 'cycles'}</span><span>{run.steps} {run.steps === 1 ? 'step' : 'steps'}</span></div>{run.status === 'running' && run.activeNodeId && <p className="run-active"><span className="status-dot" />{agentName(state, run.activeNodeId)} is working</p>}{run.error && <div className="run-error" role="alert"><strong>Run stopped with an error</strong><p>{run.error}</p></div>}<code className="run-id">{run.id}</code></div></article>; })}</div>}
  </section>;
}

export function SettingsModal({ workflow, onSave, onClose }: { workflow: Workflow; onSave: (workflow: Workflow) => Promise<void> | void; onClose: () => void }) {
  const dialogRef = useDialogFocus(true);
  const [draft, setDraft] = useState<Workflow>(() => structuredClone(workflow));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  function settings(changes: Partial<Workflow['settings']>) { setDraft(current => ({ ...current, settings: { ...current.settings, ...changes } })); setError(''); }
  useEffect(() => { const handleKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); }; window.addEventListener('keydown', handleKey); return () => window.removeEventListener('keydown', handleKey); }, [onClose]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    if (!draft.name.trim()) { setError('Give your workflow a name.'); return; }
    if (draft.settings.executionMode === 'pi' && !draft.settings.projectPath.trim()) { setError('Set a project path to run Pi against a codebase.'); return; }
    if (!draft.nodes.some(node => node.id === draft.settings.entryNodeId)) { setError('Choose an entry agent before saving.'); return; }
    if (!Number.isInteger(draft.settings.maxCycles) || draft.settings.maxCycles < 1 || draft.settings.maxCycles > 1000) { setError('Maximum cycles must be a whole number from 1 to 1,000.'); return; }
    if (!Number.isFinite(draft.settings.intervalSeconds) || draft.settings.intervalSeconds < 0 || draft.settings.intervalSeconds > 86400) { setError('Cycle interval must be between 0 and 86,400 seconds.'); return; }
    if (draft.settings.previewUrl.trim()) { try { const url = new URL(draft.settings.previewUrl); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); } catch { setError('Preview URL must be a complete http:// or https:// address.'); return; } }
    setSaving(true);
    try { await onSave({ ...draft, name: draft.name.trim(), description: draft.description.trim(), settings: { ...draft.settings, projectPath: draft.settings.projectPath.trim(), previewUrl: draft.settings.previewUrl.trim() } }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save workflow settings. Try again.'); }
    finally { setSaving(false); }
  }
  return <div className="modal-overlay" onClick={onClose}><section ref={dialogRef} className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={event => event.stopPropagation()}><div className="modal-header"><div><div className="page-kicker">MAKE IT YOUR OWN</div><h2 id="settings-title">Workflow settings</h2><p>Set the workspace and choose how the team works.</p></div><button type="button" className="btn-icon" aria-label="Close workflow settings" onClick={onClose}><X size={20} /></button></div><form onSubmit={save}><fieldset disabled={saving} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}><div className="settings-section"><h3><Settings2 size={16} />The basics</h3><div className="form-grid"><label className="field"><span>Workflow name</span><input autoFocus required maxLength={100} value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} /></label><label className="field"><span>Entry agent</span><select required value={draft.settings.entryNodeId} onChange={event => settings({ entryNodeId: event.target.value })}><option value="" disabled>Choose the first agent</option>{draft.nodes.map(node => <option key={node.id} value={node.id}>{node.data.label}</option>)}</select></label><label className="field full-width"><span>Description</span><textarea rows={2} maxLength={2000} value={draft.description} onChange={event => setDraft(current => ({ ...current, description: event.target.value }))} placeholder="What should this team achieve?" /></label></div></div>
      <div className="settings-section"><h3><Code2 size={16} />Workspace</h3><div className="form-grid"><label className="field full-width"><span>Project path</span><input value={draft.settings.projectPath} onChange={event => settings({ projectPath: event.target.value })} placeholder="C:\projects\your-app" spellCheck={false} /><small>Absolute path to the codebase on the machine running the server.</small></label><label className="field full-width"><span>UI preview URL</span><input type="url" value={draft.settings.previewUrl} onChange={event => settings({ previewUrl: event.target.value })} placeholder="http://localhost:3000" /><small>Start your app separately. Agents use this address to inspect the UI.</small></label></div></div>
      <div className="settings-section"><h3><Play size={16} />Execution</h3><div className="form-grid"><label className="field"><span>Runtime</span><select value={draft.settings.executionMode} onChange={event => settings({ executionMode: event.target.value as Workflow['settings']['executionMode'] })}><option value="demo">Demo — simulated run</option><option value="pi">Pi harness — real agents</option></select><small>{draft.settings.executionMode === 'demo' ? 'Explore the workflow with clearly labeled sample activity.' : 'Uses the configured models and local Pi installation.'}</small></label><label className="field"><span>Run mode</span><select value={draft.settings.mode} onChange={event => settings({ mode: event.target.value as Workflow['settings']['mode'], continuous: event.target.value === 'loop' && !!draft.settings.continuous })}><option value="once">Single pass</option><option value="loop">Repeat in a loop</option></select><small>Each pass begins with your entry agent.</small></label><label className="checkbox-field full-width"><input type="checkbox" disabled={draft.settings.mode !== 'loop'} checked={draft.settings.continuous ?? false} onChange={event => settings({ continuous: event.target.checked, maxCycles: Number.isInteger(draft.settings.maxCycles) && draft.settings.maxCycles >= 1 && draft.settings.maxCycles <= 1000 ? draft.settings.maxCycles : 1 })} /><span>Keep running until stopped<small>{draft.settings.continuous && draft.settings.mode === 'loop' ? 'The workflow repeats until you press Stop.' : 'Enable for continuous looping, or use a maximum cycle count.'}</small></span></label><label className="field"><span>Maximum cycles</span><input type="number" min={1} max={1000} step={1} disabled={draft.settings.mode === 'once' || !!draft.settings.continuous} value={draft.settings.maxCycles} onChange={event => settings({ maxCycles: Number(event.target.value) })} /><small>{draft.settings.mode === 'once' ? 'Single pass runs one cycle.' : draft.settings.continuous ? 'No cycle limit while continuous looping is enabled.' : 'The workflow stops after this many cycles.'}</small></label><label className="field"><span>Pause between cycles (seconds)</span><input type="number" min={0} max={86400} step={1} disabled={draft.settings.mode === 'once'} value={draft.settings.intervalSeconds} onChange={event => settings({ intervalSeconds: Number(event.target.value) })} /></label></div></div>
      {error && <p className="form-error" role="alert">{error}</p>}<div className="modal-footer"><button className="btn btn-secondary" type="button" onClick={onClose}>Cancel</button><button className="btn btn-primary" type="submit"><Check size={16} />{saving ? 'Saving…' : 'Save settings'}</button></div></fieldset>
    </form></section></div>;
}



