import { apiFetch } from './api';
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Activity, ArrowUpRight, Bot, Check, CheckCircle2, ChevronDown, Clock3, Code2, Cpu, FileCode2, GitFork, Image, Inbox, ListFilter, MessageSquare, Monitor, Pencil, Play, Plus, Scale, Search, Send, Settings2, ShieldCheck, Sparkles, Trash2, Trophy, Users, X } from 'lucide-react';
import type { AppState, Finding, Message, ModelConfig, NodeResult, ProjectSettings, WorkspaceInfo, RoutingAnswer, RoutingChoice, RoutingSettings, Run, RuntimeStatus, Workflow } from '../shared/types';
import { defaultRoutingSettings } from '../shared/defaults';
import { ApprovalCard, ControlResult, LessonsEditor, OutcomeHistory } from './Acceptance';
import { ExecutionEvidence } from './ExecutionEvidence';

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
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [href], [tabindex="0"]') ?? []).filter(element => element.getClientRects().length > 0 && !element.closest('[inert]'));
    focusable()[0]?.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const elements = focusable();
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!first) { event.preventDefault(); ref.current?.focus(); return; }
      if (!ref.current?.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', trapFocus);
    return () => { document.removeEventListener('keydown', trapFocus); document.body.style.overflow = previousOverflow; if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
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
  const filtersActive = !!query || severity !== 'all' || status !== 'all';

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
    <div className="panel-results"><span role="status">Showing {findings.length} of {state.findings.length} findings</span>{filtersActive && <button type="button" className="text-button" onClick={() => { setQuery(''); setSeverity('all'); setStatus('all'); }}>Clear filters</button>}</div>
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
  const threadRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const messages = state.messages.filter(message => filter === 'all' || message.from === filter || message.to === filter);
  const latestMessageId = messages.at(-1)?.id;
  useEffect(() => {
    if (followLatest.current && threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [latestMessageId, filter]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sending) return;
    if (!text.trim()) { setError('Write a message before sending.'); return; }
    if (type === 'assignment' && to === 'all') { setError('Choose an agent to receive this assignment.'); return; }
    if (to !== 'all' && !state.workflow.nodes.some(node => node.id === to)) { setError('Choose an available agent.'); return; }
    setSending(true); followLatest.current = true;
    try { await onSend(text.trim(), to, type); setText(''); setError(''); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not send your message. Try again.'); }
    finally { setSending(false); }
  }
  return <section className="panel messages-panel">
    <div className="page-header"><div><div className="page-kicker">SHARED CONTEXT, BETTER WORK</div><h1>Team inbox <span className="heading-count">{state.messages.length}</span></h1><p>Keep discoveries, handoffs, and the next assignment in the same conversation.</p></div><span className="badge badge-muted"><Users size={14} />{state.workflow.nodes.filter(node => node.type === 'agent').length} agents connected</span></div>
    <div className="panel-toolbar"><div className="section-label"><MessageSquare size={16} /> Shared conversation</div><select aria-label="Filter conversation by agent" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All agents</option>{state.workflow.nodes.map(node => <option key={node.id} value={node.id}>{node.data.label}</option>)}</select></div>
    <div className="message-thread" ref={threadRef} tabIndex={0} aria-label="Shared conversation" aria-live="polite" onScroll={() => { const thread = threadRef.current; if (thread) followLatest.current = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80; }}>{messages.length === 0 ? <EmptyState icon={MessageSquare} title="The conversation starts here">Send a note to the team or assign an agent a task. Agents share their handoffs here as the workflow runs.</EmptyState> : messages.map(message => <article className={`message-card ${message.type === 'system' ? 'system-message' : ''}`} key={message.id}>
      <div className="message-avatar">{message.from === 'user' || message.from === 'you' ? <Users size={18} /> : message.from === 'system' ? <Activity size={18} /> : <Bot size={18} />}</div>
      <div className="message-content"><div className="message-topline"><strong>{agentName(state, message.from)}</strong><span className="message-destination"><ArrowUpRight size={12} />{agentName(state, message.to)}</span>{message.type === 'assignment' && <span className="badge badge-green">Assignment</span>}{message.type === 'system' && <span className="badge badge-muted">System</span>}<time dateTime={message.createdAt} title={dateTime(message.createdAt)}>{relativeTime(message.createdAt)}</time></div><p>{message.text}</p></div>
    </article>)}</div>
    <form className="composer card" onSubmit={submit}><label className="sr-only" htmlFor="message-text">Your message</label><textarea id="message-text" disabled={sending} placeholder={type === 'assignment' ? 'Describe the task, the expected outcome, and any useful context…' : 'Share an observation, ask a question, or leave the team a note…'} value={text} onChange={event => { setText(event.target.value); setError(''); }} rows={3} maxLength={20_000} /><div className="composer-footer"><div className="composer-controls"><label><span>To</span><select aria-label="Message recipient" disabled={sending} value={to} onChange={event => { setTo(event.target.value); setError(''); }}>{!to && <option value="" disabled>Choose an agent</option>}<option value="all" disabled={type === 'assignment'}>Everyone</option>{state.workflow.nodes.filter(node => node.type === 'agent').map(node => <option key={node.id} value={node.id}>{node.data.label}</option>)}</select></label><select aria-label="Message type" disabled={sending} value={type} onChange={event => { const nextType = event.target.value as Message['type']; setType(nextType); if (nextType === 'assignment' && to === 'all') setTo(''); if (nextType === 'message' && !to) setTo('all'); setError(''); }}><option value="message">Message</option><option value="assignment">Assignment</option></select></div><button className="btn btn-primary" type="submit" disabled={sending || !text.trim() || !to}><Send size={15} />{sending ? 'Sending…' : `Send ${type === 'assignment' ? 'assignment' : 'message'}`}</button></div>{type === 'assignment' && !to && <p className="composer-hint">Choose the agent who should receive this assignment.</p>}{error && <p className="form-error" role="alert">{error}</p>}</form>
  </section>;
}

export function StaffPanel({ state, onSelect }: StateProps & { onSelect: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const nodes = state.workflow.nodes.filter(node => node.type === 'agent').filter(node => `${node.data.label} ${node.data.role} ${node.data.description} ${node.data.responsibilities.join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="panel staff-panel"><div className="page-header"><div><div className="page-kicker">A PLACE FOR EVERY SPECIALIST</div><h1>Your staff <span className="heading-count">{state.workflow.nodes.filter(node => node.type === 'agent').length}</span></h1><p>Know who is working on what, and where the next task belongs.</p></div><span className="badge badge-green"><span className="status-dot" />{state.workflow.nodes.filter(node => node.type === 'agent' && node.data.status === 'running').length} working now</span></div>
    <div className="panel-toolbar"><label className="search-field"><Search size={17} /><input aria-label="Search staff" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find an agent or responsibility…" /></label><span className="toolbar-hint">Each agent is a node in your workflow.</span></div>
    {nodes.length === 0 ? <EmptyState icon={Users} title={state.workflow.nodes.length ? 'No agents match your search' : 'Build your team'}>{state.workflow.nodes.length ? 'Try a different name, role, or responsibility.' : 'Add a node in the workflow builder to create your first specialist.'}</EmptyState> : <div className="staff-grid">{nodes.map(node => { const model = state.models.find(item => item.id === node.data.modelId); const lastAssignment = [...state.messages].reverse().find(message => message.to === node.id && message.type === 'assignment'); return <article key={node.id} className="staff-card card"><div className="card-topline"><span className="agent-avatar" style={{ background: `${node.data.color}18`, color: node.data.color }}>{node.data.role === 'judge' ? <Scale size={24} /> : <Bot size={24} />}</span><span className={`badge agent-status status-${node.data.status}`}><span className="status-dot" />{node.data.status === 'done' ? 'Finished' : node.data.status === 'running' ? 'Working' : node.data.status === 'error' ? 'Needs attention' : 'Ready'}</span></div><div className="staff-identity"><h3>{node.data.label}</h3><span className="role-label">{node.data.role === 'judge' ? 'Comparison judge' : node.data.role}</span></div><p>{node.data.description || 'A specialist in your workflow.'}</p><div className="staff-responsibilities"><span className="field-label">RESPONSIBILITIES</span><div className="tag-list">{node.data.responsibilities.length ? node.data.responsibilities.map((responsibility, index) => <span className="tag" key={`${responsibility}-${index}`}>{responsibility}</span>) : <span className="muted">No responsibilities set yet.</span>}</div></div>{lastAssignment && <details className="staff-assignment"><summary>Latest assignment<span>View details</span></summary><p>{lastAssignment.text}</p></details>}<div className="staff-footer"><span><Cpu size={14} />{model?.name ?? 'No model assigned'}</span><button type="button" className="btn btn-secondary btn-small" onClick={() => onSelect(node.id)}>Edit agent <ArrowUpRight size={14} /></button></div></article>; })}</div>}
  </section>;
}

const newModel = (): ModelConfig => ({ id: `model-${crypto.randomUUID()}`, name: '', provider: 'ollama', modelId: '', kind: 'local', baseUrl: 'http://localhost:11434/v1', apiKeyEnv: '', enabled: true, contextWindow: 32768, supportsImages: false, maxConcurrentRequests: 1 });

type ChatGPTProfile = { id: string; label: string; email?: string; connected: boolean; sharing: boolean };
type ChatGPTStatus = { profiles: ChatGPTProfile[]; activeProfileId?: string; pending?: { id: string; url: string; expiresAt: number; profileId?: string }; error?: string };
type ChatGPTModel = { id: string; name: string; contextWindow?: number; supportsImages?: boolean };
type ConnectionProbe = { ready: boolean; message: string; checkedAt: string; modelId: string };

async function modelRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await apiFetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The local server could not complete this request.');
  return result as T;
}

function safeLoginUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com' || url.username || url.password) throw new Error('The server returned an unexpected sign-in address.');
  return url.href;
}

function PiRuntimeStatus({ runtime }: { runtime: RuntimeStatus | null }) {
  return <span className={`badge ${runtime?.piAvailable ? 'badge-green' : 'badge-muted'}`}><span className="status-dot" />{runtime ? runtime.piAvailable ? 'Pi runtime available' : 'Pi runtime unavailable' : 'Runtime status unavailable'}</span>;
}

export function ModelsPanel({ state, runtime, onSave }: StateProps & { runtime: RuntimeStatus | null; onSave: (models: ModelConfig[]) => Promise<void> | void }) {
  const [draft, setDraft] = useState<ModelConfig | null>(null);
  const [query, setQuery] = useState('');
  const [location, setLocation] = useState('all');
  const [isNew, setIsNew] = useState(false);
  const [error, setError] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [chatgpt, setChatgpt] = useState<ChatGPTStatus | null>(null);
  const [accountError, setAccountError] = useState('');
  const [accountBusy, setAccountBusy] = useState(false);
  const [catalog, setCatalog] = useState<ChatGPTModel[]>([]);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [probeId, setProbeId] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, ConnectionProbe>>({});
  const visibleModels = state.models.filter(model => (location === 'all' || model.kind === location)
    && `${model.name} ${model.modelId} ${model.provider} ${model.baseUrl}`.toLowerCase().includes(query.toLowerCase()));
  const modelShelves = (['local', 'cloud'] as const).map(kind => ({ kind, models: visibleModels.filter(model => model.kind === kind) })).filter(shelf => shelf.models.length > 0);
  const modelsConfiguration = JSON.stringify(state.models);
  const currentModelsConfiguration = useRef(modelsConfiguration);
  currentModelsConfiguration.current = modelsConfiguration;
  useEffect(() => { setProbes({}); }, [modelsConfiguration]);
  async function refreshAccounts() {
    try { setChatgpt(await modelRequest<ChatGPTStatus>('/chatgpt/status')); setAccountError(''); }
    catch (failure) { setAccountError(failure instanceof Error ? failure.message : 'Could not read ChatGPT connections.'); }
  }
  useEffect(() => { void refreshAccounts(); }, []);
  useEffect(() => {
    if (!chatgpt?.pending) return;
    const timer = window.setInterval(() => void refreshAccounts(), 2000);
    return () => window.clearInterval(timer);
  }, [chatgpt?.pending?.id]);
  async function login(profileId?: string) {
    if (accountBusy || state.workspace?.hosted) return;
    const signInWindow = window.open('about:blank', '_blank');
    if (signInWindow) signInWindow.opener = null;
    setAccountBusy(true); setAccountError('');
    try {
      const result = await modelRequest<{ url: string }>('/chatgpt/login', profileId ? { profileId } : {});
      const url = safeLoginUrl(result.url);
      if (signInWindow) signInWindow.location.href = url;
      await refreshAccounts();
    } catch (failure) {
      signInWindow?.close();
      setAccountError(failure instanceof Error ? failure.message : 'Could not start ChatGPT sign-in.');
    } finally { setAccountBusy(false); }
  }
  async function accountAction(action: 'select' | 'logout', profileId: string) {
    if (accountBusy) return;
    setAccountBusy(true); setAccountError('');
    try { await modelRequest(`/chatgpt/${action}`, { profileId }); await refreshAccounts(); setCatalog([]); setProbes({}); }
    catch (failure) { setAccountError(failure instanceof Error ? failure.message : 'Could not update this connection.'); }
    finally { setAccountBusy(false); }
  }
  async function loadCatalog() {
    if (catalogBusy) return;
    setCatalogBusy(true); setCatalogError('');
    try {
      const profileId = draft?.chatgptProfileId || chatgpt?.activeProfileId;
      const result = await modelRequest<{ models: ChatGPTModel[] }>(`/chatgpt/models${profileId ? `?profileId=${encodeURIComponent(profileId)}` : ''}`);
      setCatalog(result.models);
      if (!result.models.length) setCatalogError('This connection did not return any available models.');
    } catch (failure) { setCatalogError(failure instanceof Error ? failure.message : 'Could not load available models.'); }
    finally { setCatalogBusy(false); }
  }
  async function testConnection(model: ModelConfig) {
    if (probeId) return;
    const testedConfiguration = modelsConfiguration;
    setProbeId(model.id);
    try { const result = await modelRequest<ConnectionProbe>(`/models/${encodeURIComponent(model.id)}/probe`, {}); if (currentModelsConfiguration.current === testedConfiguration) setProbes(current => ({ ...current, [model.id]: result })); }
    catch (failure) { if (currentModelsConfiguration.current === testedConfiguration) setProbes(current => ({ ...current, [model.id]: { ready: false, message: failure instanceof Error ? failure.message : 'Connection test failed.', checkedAt: new Date().toISOString(), modelId: model.modelId } })); }
    finally { setProbeId(null); }
  }
  function edit(model: ModelConfig) { setDraft({ ...model }); setIsNew(false); setError(''); setDeleteId(null); setCatalog([]); setCatalogError(''); }
  function update(changes: Partial<ModelConfig>) { setDraft(current => current ? { ...current, ...changes } : current); setError(''); }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!draft) return;
    if (saving) return;
    if (!draft.name.trim() || !draft.modelId.trim()) { setError('Give this model a display name and a model ID.'); return; }
    if (draft.contextWindow !== undefined && (!Number.isInteger(draft.contextWindow) || draft.contextWindow < 1024 || draft.contextWindow > 10000000)) { setError('Context window must be a whole number from 1,024 to 10,000,000 tokens.'); return; }
    if (draft.maxOutputTokens !== undefined && (!Number.isInteger(draft.maxOutputTokens) || draft.maxOutputTokens < 256 || draft.maxOutputTokens > Math.min(32768, (draft.contextWindow ?? 32768) - 256))) { setError('Maximum output must be 256–32,768 tokens and leave at least 256 tokens within the context window.'); return; }
    if (draft.timeoutSeconds !== undefined && (!Number.isInteger(draft.timeoutSeconds) || draft.timeoutSeconds < 15 || draft.timeoutSeconds > 1800)) { setError('Visit timeout must be a whole number from 15 to 1,800 seconds.'); return; }
    if (draft.maxConcurrentRequests !== undefined && (!Number.isInteger(draft.maxConcurrentRequests) || draft.maxConcurrentRequests < 1 || draft.maxConcurrentRequests > 8)) { setError('Endpoint request slots must be a whole number from 1 to 8.'); return; }
    if (draft.baseUrl.trim()) { try { const url = new URL(draft.baseUrl); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); } catch { setError('Base URL must be a complete http:// or https:// address.'); return; } }
    if ((draft.provider === 'ollama' || draft.provider === 'custom') && !draft.baseUrl.trim()) { setError('Add the base URL for this model endpoint.'); return; }
    if (draft.apiKeyEnv.trim() && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(draft.apiKeyEnv.trim())) { setError('Use an environment variable name, such as OPENAI_API_KEY.'); return; }
    const saved = { ...draft, name: draft.name.trim(), modelId: draft.modelId.trim(), baseUrl: draft.authMethod === 'chatgpt' ? '' : draft.baseUrl.trim(), apiKeyEnv: draft.authMethod === 'chatgpt' ? '' : draft.apiKeyEnv.trim() };
    setSaving(true);
    try { await onSave(isNew ? [...state.models, saved] : state.models.map(model => model.id === saved.id ? saved : model)); setDraft(null); setError(''); setProbes({}); }
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
    update({ provider, ...defaults[provider], authMethod: undefined, chatgptProfileId: undefined, reasoningEffort: undefined });
    setCatalog([]); setCatalogError('');
  }
  return <section className="panel models-panel"><div className="page-header"><div><div className="page-kicker">THE RIGHT MIND FOR THE JOB</div><h1>Model library <span className="heading-count">{state.models.length}</span></h1><p>Connect local or cloud models, then assign the right one to each agent.</p></div><button className="btn btn-primary" type="button" disabled={saving} onClick={() => { setDraft(newModel()); setIsNew(true); setError(''); setDeleteId(null); setCatalog([]); setCatalogError(''); }}><Plus size={16} />Add model</button></div>
    {state.workspace && <div className="workspace-policy-note"><strong>{state.workspace.hosted ? 'Hosted model connections' : 'Connection settings'}</strong><p>Approved custom endpoints: {state.workspace.modelEndpointOrigins.join(', ') || 'None configured'}. Standard Anthropic and OpenAI endpoints are also available.</p><p>Approved credential names: {state.workspace.modelKeyNames.join(', ') || 'None configured'}.</p><p>{state.workspace.hosted ? 'Ask your host to provision credentials and endpoints.' : <>To connect LAN models, decision servers or embeddings, set <code>CRAWLSPACE_MODEL_ENDPOINT_ORIGINS</code> and <code>CRAWLSPACE_MODEL_KEY_ALLOWLIST</code> before starting Crawlspace, then restart. See the local setup guide for examples.</>}</p></div>}<div className="model-info-strip"><ShieldCheck size={18} /><div><p>Each person's local copy can use their own models. Add the provider's exact model ID and endpoint, then assign it to an agent. No shared account is required.</p><p>For credentials, enter an environment variable name and set its value before starting or restarting the server. Your API key is never stored in the workflow.</p></div></div>
    <div className="runtime-readiness"><PiRuntimeStatus runtime={runtime} /><p>Model readiness checks configuration only. It does not test the endpoint or authenticate with the provider.</p></div>
    <section className="chatgpt-connections card" aria-label="ChatGPT connections"><div className="section-heading"><div><h2>ChatGPT connections</h2><p>{state.workspace?.hosted ? 'New ChatGPT sign-ins require a local copy of Crawlspace. This server can keep using profiles already connected to your workspace.' : 'Connect an eligible ChatGPT plan or keep using API keys and your own endpoints.'}</p></div><button type="button" className="btn btn-secondary" disabled={!!state.workspace?.hosted || accountBusy || !!chatgpt?.pending} onClick={() => void login()}>{accountBusy ? 'Connecting…' : 'Continue with ChatGPT'}</button></div>
      {chatgpt?.profiles.length ? <div className="chatgpt-profile-list">{chatgpt.profiles.map(profile => <div className="chatgpt-profile" key={profile.id}><div><strong>{profile.label}</strong><p>{profile.connected ? profile.sharing ? 'Connected · Plan access granted' : 'Connected · Plan access not granted' : 'Signed out'}{chatgpt.activeProfileId === profile.id ? ' · Active profile' : ''}</p></div><div className="card-actions">{profile.connected ? <>{!profile.sharing && <button type="button" className="btn btn-secondary btn-small" aria-label={`Enable plan access for ${profile.label}`} disabled={!!state.workspace?.hosted || accountBusy || !!chatgpt.pending} onClick={() => void login(profile.id)}>Enable plan access</button>}{chatgpt.activeProfileId !== profile.id && <button type="button" className="btn btn-secondary btn-small" aria-label={`Use ${profile.label}`} disabled={accountBusy} onClick={() => void accountAction('select', profile.id)}>Use profile</button>}<button type="button" className="btn btn-secondary btn-small" aria-label={`Sign out ${profile.label}`} disabled={accountBusy} onClick={() => void accountAction('logout', profile.id)}>Sign out</button></> : <button type="button" className="btn btn-secondary btn-small" aria-label={`Reconnect ${profile.label}`} disabled={!!state.workspace?.hosted || accountBusy || !!chatgpt.pending} onClick={() => void login(profile.id)}>Reconnect</button>}</div></div>)}</div> : <p className="muted">No ChatGPT profile connected.</p>}
      {chatgpt?.pending && <p className="account-pending" role="status">Waiting for you to finish signing in. {(() => { try { return <a href={safeLoginUrl(chatgpt.pending.url)} target="_blank" rel="noopener noreferrer">Open sign-in page</a>; } catch { return null; } })()}</p>}
      {(accountError || chatgpt?.error) && <p className="form-error" role="alert">{accountError || chatgpt?.error}</p>}
    </section>
    {draft && <form className="model-editor card" onSubmit={save}><fieldset disabled={saving} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}><div className="section-heading"><div><div className="page-kicker">MODEL CONNECTION</div><h2>{isNew ? 'Add a model' : 'Edit model'}</h2><p className="section-intro">Connect a provider, then set the limits this model can handle.</p></div><button className="btn-icon" type="button" aria-label="Close model editor" onClick={() => setDraft(null)}><X size={18} /></button></div><section className="model-form-section" aria-labelledby="model-connection-heading"><h3 id="model-connection-heading">Connection</h3><div className="form-grid">
      <label className="field"><span>Display name</span><input autoFocus value={draft.name} onChange={event => update({ name: event.target.value })} placeholder="e.g. Local code reviewer" required maxLength={100} /></label>
      <label className="field"><span>Provider</span><select value={draft.provider} onChange={event => providerChange(event.target.value as ModelConfig['provider'])}><option value="ollama">Ollama</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="custom">OpenAI-compatible endpoint</option></select></label>
      {draft.provider === 'openai' && <label className="field full-width"><span>Authentication</span><select value={draft.authMethod ?? 'apiKey'} onChange={event => { const authMethod = event.target.value as 'apiKey' | 'chatgpt'; update({ authMethod, chatgptProfileId: undefined, ...(authMethod === 'chatgpt' ? { baseUrl: '', apiKeyEnv: '', kind: 'cloud' } : { apiKeyEnv: 'OPENAI_API_KEY' }) }); setCatalog([]); setCatalogError(''); }}><option value="apiKey">API key</option><option value="chatgpt">ChatGPT plan</option></select><small>ChatGPT plan access depends on your account and the models it makes available.</small></label>}
      {draft.authMethod === 'chatgpt' && <div className="full-width chatgpt-model-controls"><label className="field"><span>ChatGPT profile</span><select value={draft.chatgptProfileId ?? ''} onChange={event => { update({ chatgptProfileId: event.target.value || undefined }); setCatalog([]); setCatalogError(''); }}><option value="">Active profile{chatgpt?.activeProfileId ? ` (${chatgpt.profiles.find(profile => profile.id === chatgpt.activeProfileId)?.label ?? 'selected'})` : ' (connect above)'}</option>{chatgpt?.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.label}{profile.connected ? '' : ' — signed out'}</option>)}</select></label><button type="button" className="btn btn-secondary" disabled={catalogBusy} onClick={() => void loadCatalog()}>{catalogBusy ? 'Loading models…' : 'Load available models'}</button>{catalogError && <p className="form-error" role="alert">{catalogError}</p>}</div>}
      <label className="field"><span>Model ID</span>{draft.authMethod === 'chatgpt' ? <select value={draft.modelId} required onChange={event => { const model = catalog.find(item => item.id === event.target.value); update({ modelId: event.target.value, ...(model?.contextWindow ? { contextWindow: model.contextWindow } : {}), ...(model?.supportsImages !== undefined ? { supportsImages: model.supportsImages } : {}) }); }}><option value="">Load and choose an available model</option>{draft.modelId && !catalog.some(model => model.id === draft.modelId) && <option value={draft.modelId}>{draft.modelId}</option>}{catalog.map(model => <option key={model.id} value={model.id}>{model.name} ({model.id})</option>)}</select> : <input value={draft.modelId} onChange={event => update({ modelId: event.target.value })} placeholder="Provider's exact model identifier" required maxLength={200} />}<small>Must match a model available at your provider.</small></label>
      <label className="field"><span>Runs on</span><select disabled={draft.authMethod === 'chatgpt'} value={draft.kind} onChange={event => update({ kind: event.target.value as ModelConfig['kind'] })}><option value="local">{state.workspace?.hosted ? 'Server / local model' : 'Local machine'}</option><option value="cloud">Cloud</option></select></label>
      {draft.authMethod !== 'chatgpt' && <><label className="field"><span>Base URL {draft.provider === 'ollama' || draft.provider === 'custom' ? '' : '(optional)'}</span><input type="url" value={draft.baseUrl} onChange={event => update({ baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /><small>{draft.provider === 'ollama' || draft.provider === 'custom' ? 'Use your OpenAI-compatible endpoint, including its API base path (often /v1).' : "Leave blank to use the provider's default endpoint."}</small></label>
      <label className="field"><span>API key environment variable</span><input value={draft.apiKeyEnv} onChange={event => update({ apiKeyEnv: event.target.value })} placeholder={draft.kind === 'local' ? 'Optional for local endpoints' : 'e.g. OPENAI_API_KEY'} autoComplete="off" spellCheck={false} /><small>Enter the variable name, never the API key. Leave blank for endpoints that do not require authentication.</small></label></>}
    </div></section><section className="model-form-section" aria-labelledby="model-capacity-heading"><h3 id="model-capacity-heading">Capacity and reasoning</h3><p className="section-intro">Start with your model server's supported limits. You can adjust these later.</p><div className="form-grid">
      <label className="field"><span>Context window (tokens)</span><input type="number" min={1024} max={10000000} step={1} value={draft.contextWindow ?? ''} onChange={event => update({ contextWindow: event.target.value ? Number(event.target.value) : undefined })} placeholder="Optional" /></label>
      <label className="field"><span>Maximum output (tokens)</span><input type="number" min={256} max={Math.min(32768, (draft.contextWindow ?? 32768) - 256)} step={1} value={draft.maxOutputTokens ?? ''} onChange={event => update({ maxOutputTokens: event.target.value ? Number(event.target.value) : undefined })} placeholder="Use default" /><small>{draft.authMethod === 'chatgpt' ? 'ChatGPT plan requests do not enforce this output cap. It reserves context room; the visit timeout and supervisor allowances still apply.' : 'Leave blank for the default. Allow enough room for reasoning and the final review.'}</small></label>
      <label className="field"><span>Visit timeout (seconds)</span><input type="number" min={15} max={1800} step={1} value={draft.timeoutSeconds ?? ''} onChange={event => update({ timeoutSeconds: event.target.value ? Number(event.target.value) : undefined })} placeholder="180" /><small>Includes model loading, waiting, review tools, and the response.</small></label>
      <label className="field"><span>Endpoint request slots</span><input type="number" min={1} max={8} step={1} value={draft.maxConcurrentRequests ?? 1} onChange={event => update({ maxConcurrentRequests: Number(event.target.value) })} /><small>Keep 1 for a local GPU unless its server can handle more. Models sharing this endpoint use the lowest configured limit.</small></label>
      {(draft.provider === 'custom' || draft.provider === 'ollama') && <label className="field"><span>Reasoning effort</span><select value={draft.reasoningEffort ?? ''} onChange={event => update({ reasoningEffort: event.target.value ? event.target.value as ModelConfig['reasoningEffort'] : undefined })}><option value="">Use default</option><option value="off">Off</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select><small>Use a level your model server supports. Higher levels may need more time and output.</small></label>}
    </div></section><section className="model-form-section" aria-labelledby="model-capabilities-heading"><h3 id="model-capabilities-heading">Agent access and capabilities</h3><div className="form-grid">
      <label className="checkbox-field"><input type="checkbox" checked={draft.enabled} onChange={event => update({ enabled: event.target.checked })} /><span>Available to agents<small>Enabled models appear in the node's model chooser.</small></span></label>
      <label className="checkbox-field"><input type="checkbox" checked={draft.supportsImages ?? false} onChange={event => update({ supportsImages: event.target.checked })} /><span>Image input supported<small>Required for agents that inspect UI screenshots. Enable only for a vision model.</small></span></label>
    </div></section>{error && <p role="alert" className="form-error">{error}</p>}<div className="form-actions"><button type="button" className="btn btn-secondary" onClick={() => setDraft(null)}>Cancel</button><button className="btn btn-primary" type="submit"><Check size={16} />{saving ? 'Saving…' : 'Save model'}</button></div></fieldset></form>}
    {error && !draft && <p role="alert" className="form-error">{error}</p>}{!state.models.length ? <EmptyState icon={Cpu} title="Give your agents a model">Add a local endpoint or cloud provider to start building your model library.</EmptyState> : <><div className="panel-toolbar model-library-toolbar"><label className="search-field"><Search size={17} /><input aria-label="Search models" placeholder="Find a model, provider, or machine…" value={query} onChange={event => setQuery(event.target.value)} /></label><select aria-label="Filter models by location" value={location} onChange={event => setLocation(event.target.value)}><option value="all">Local and cloud</option><option value="local">Local models</option><option value="cloud">Cloud models</option></select><span className="model-result-count" role="status">{visibleModels.length} of {state.models.length} models</span>{(query || location !== 'all') && <button type="button" className="text-button" onClick={() => { setQuery(''); setLocation('all'); }}>Clear filters</button>}</div>{!visibleModels.length && <EmptyState icon={Search} title="No matching models">Try another name, provider, or location.</EmptyState>}<div className="model-shelves">{modelShelves.map(shelf => <section className="model-shelf" key={shelf.kind} aria-label={shelf.kind === 'local' ? 'Local models' : 'Cloud models'}><div className="model-shelf-heading"><div><h2>{shelf.kind === 'local' ? 'Local models' : 'Cloud models'}</h2><p>{shelf.kind === 'local' ? 'Models hosted on your own machines.' : 'Connected providers and ChatGPT plan models.'}</p></div><span className="heading-count">{shelf.models.length}</span></div><div className="model-grid">{shelf.models.map(model => {
      const assigned = state.workflow.nodes.filter(node => node.data.modelId === model.id);
      const readiness = runtime?.models.find(item => item.id === model.id);
      const supervisor = state.workflow.settings.supervisorModelId === model.id;
      const probe = probes[model.id];
      return <article className={`model-card card ${!model.enabled ? 'model-disabled' : ''}`} key={model.id}>
        <div className="card-topline"><span className={`model-avatar ${model.kind === 'local' ? 'local-model' : 'cloud-model'}`}>{model.kind === 'local' ? <Monitor size={23} /> : <Sparkles size={23} />}</span><span className={`badge ${model.enabled ? 'badge-green' : 'badge-muted'}`}><span className="status-dot" />{model.enabled ? 'Enabled' : 'Disabled'}</span></div>
        <h3>{model.name}</h3><code className="model-identifier">{model.modelId}</code><div className="tag-list"><span className="tag">{model.provider === 'custom' ? 'Custom endpoint' : model.provider}</span><span className="tag">{model.kind === 'local' ? 'Local' : 'Cloud'}</span>{model.supportsImages && <span className="tag"><Image size={12} />Image input</span>}{model.contextWindow && <span className="tag">{new Intl.NumberFormat().format(model.contextWindow)} context</span>}</div>
        <div className="model-readiness"><span className={`badge ${readiness?.ready ? 'badge-green' : 'badge-muted'}`}><span className="status-dot" />{readiness ? readiness.ready ? 'Configuration ready' : 'Setup needed' : 'Readiness unavailable'}</span>{readiness && <p>{readiness.message}</p>}</div>
        <div className="model-details">{model.baseUrl && <p><span>Endpoint</span><code>{model.baseUrl}</code></p>}<p><span>Credential</span><code>{model.authMethod === 'chatgpt' ? `ChatGPT · ${chatgpt?.profiles.find(profile => profile.id === model.chatgptProfileId)?.label ?? (model.chatgptProfileId ? 'Selected profile' : 'Active profile')}` : model.apiKeyEnv || 'No key configured'}</code></p><p><span>Endpoint request slots</span><code>{model.maxConcurrentRequests ?? 1}</code></p>{model.maxOutputTokens && <p><span>Maximum output</span><code>{new Intl.NumberFormat().format(model.maxOutputTokens)} tokens</code></p>}{model.timeoutSeconds && <p><span>Visit timeout</span><code>{model.timeoutSeconds} seconds</code></p>}{model.reasoningEffort && <p><span>Reasoning effort</span><code>{model.reasoningEffort}</code></p>}{supervisor && <p><span>Workflow role</span><code>Supervisor</code></p>}</div>
        <div className="model-probe"><button type="button" className="btn btn-secondary btn-small" disabled={!!probeId || saving || !model.enabled} onClick={() => void testConnection(model)}>{probeId === model.id ? 'Testing connection…' : 'Test connection'}</button>{probe && <p role="status" className={probe.ready ? 'probe-success' : 'form-error'}>{probe.message}<small>Checked {dateTime(probe.checkedAt)}. Code Mode is tested during a workflow run.</small></p>}</div>
        <div className="model-card-footer"><span><Users size={14} />{assigned.length} {assigned.length === 1 ? 'agent' : 'agents'}</span><div className="card-actions"><button type="button" className="btn-icon" aria-label={`Edit ${model.name}`} disabled={saving} onClick={() => edit(model)}><Pencil size={16} /></button><button type="button" className="btn-icon" aria-label={`Remove ${model.name}`} disabled={saving} onClick={() => { setDeleteId(model.id); setDraft(null); }}><Trash2 size={16} /></button></div></div>
        {deleteId === model.id && <div className="inline-confirm"><p>{assigned.length ? `This model is assigned to ${assigned.length} ${assigned.length === 1 ? 'agent' : 'agents'}. Reassign them before removing it.` : supervisor ? 'Choose another supervisor or turn it off in workflow settings before removing this model.' : `Remove ${model.name} from your library?`}</p><div className="form-actions"><button className="btn btn-secondary btn-small" type="button" disabled={saving} onClick={() => setDeleteId(null)}>Cancel</button>{!assigned.length && !supervisor && <button className="btn btn-danger btn-small" type="button" disabled={saving} onClick={() => void removeModel(model.id)}>Remove model</button>}</div></div>}
      </article>;
    })}</div></section>)}</div></>}
  </section>;
}

const routingChoiceLabel: Record<RoutingChoice, string> = { assigned: 'Assigned model', supervisor: 'Supervisor', review: 'Human review' };
const decisionStatusLabel = { pending: 'Pending', completed: 'Completed', error: 'Failed', cancelled: 'Cancelled', budget: 'Limit reached' };
const percent = (value: number) => new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 2 }).format(value);

function downloadDecisions(run: Run) {
  const decisions = (run.decisions ?? []).slice(-500);
  const contents = JSON.stringify({ runId: run.id, decisionCount: run.decisionCount ?? decisions.length, retainedDecisions: decisions.length, decisions }, null, 2);
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = `crawlspace-decisions-${run.id}.json`; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function RoutingTraces({ state, run }: StateProps & { run: Run }) {
  const decisions = (run.decisions ?? []).slice(-20).reverse();
  if (!decisions.length) return null;
  return <details className="routing-traces"><summary>Routing decisions <span>{run.decisionCount ?? run.decisions?.length ?? 0}</span></summary>
    <div className="routing-trace-toolbar"><p>Latest {decisions.length} saved decisions. Scores come from the decision server and do not establish accuracy. The download includes up to 500 retained decisions.</p><button type="button" className="btn btn-secondary btn-small" aria-label={`Download routing decisions for ${run.id}`} onClick={() => downloadDecisions(run)}>Download JSON</button></div>
    <div className="routing-trace-list">{decisions.map(decision => <details className="routing-trace" key={decision.id}><summary><span>{agentName(state, decision.nodeId)} · cycle {decision.cycle}</span><span className={`badge decision-${decision.status}`}>{decisionStatusLabel[decision.status]}</span></summary>
      <dl><div><dt>Mode</dt><dd>{decision.mode === 'shadow' ? 'Shadow' : 'Active'}</dd></div><div><dt>Created</dt><dd>{dateTime(decision.createdAt)}</dd></div><div><dt>Choice</dt><dd>{decision.choice ? routingChoiceLabel[decision.choice] : decision.status === 'pending' ? 'Awaiting decision' : 'No choice returned'}</dd></div><div><dt>Recommendation</dt><dd>{decision.recommendation ? routingChoiceLabel[decision.recommendation] : 'Not available'}</dd></div><div><dt>Confidence</dt><dd>{decision.confidence === undefined ? 'Not available' : percent(decision.confidence)}</dd></div><div><dt>Required confidence</dt><dd>{percent(decision.threshold)}</dd></div><div><dt>Selected model</dt><dd>{decision.selectedModelId ? `${state.models.find(model => model.id === decision.selectedModelId)?.name ?? decision.selectedModelId} (${decision.selectedModelId})` : 'No model selected'}</dd></div><div><dt>Backend</dt><dd>{decision.backend === 'system-one' ? 'Native decision API' : 'llama.cpp classifier'}</dd></div><div><dt>Configured decision model</dt><dd>{decision.configuredModelId || 'Server default'}</dd></div><div><dt>Reported decision model</dt><dd>{decision.modelId || 'Not available'}</dd></div><div><dt>Question version</dt><dd>{decision.questionVersion}</dd></div>{decision.durationMs !== undefined && <div><dt>Decision time</dt><dd>{decision.durationMs} ms</dd></div>}</dl>
      {decision.probabilities && <div className="routing-distribution" aria-label="Decision score distribution">{(['assigned', 'supervisor', 'review'] as const).map(choice => <span key={choice}>{routingChoiceLabel[choice]} <strong>{percent(decision.probabilities![choice])}</strong></span>)}</div>}
      {decision.reason && <p className={`routing-reason ${decision.status === 'error' || decision.status === 'budget' ? 'decision-error' : ''}`}>{decision.reason}</p>}
    </details>)}</div>
  </details>;
}

function RunResults({ state, results }: StateProps & { results: NodeResult[] }) {
  const cycles = [...new Set(results.map(result => result.cycle))].sort((a, b) => b - a);
  return <div className="run-results">{cycles.map(cycle => {
    const cycleResults = results.filter(result => result.cycle === cycle);
    const findingCount = cycleResults.reduce((count, result) => count + result.findings.length, 0);
    const resultName = (id: string) => cycleResults.find(result => result.nodeId === id)?.nodeName ?? agentName(state, id);
    const modelName = (modelId: string) => state.models.find(model => model.id === modelId)?.name ?? modelId;
    return <details className="run-cycle" key={cycle}>
      <summary className="run-cycle-summary"><span><GitFork size={14} />Cycle {cycle}</span><span>{cycleResults.length} {cycleResults.length === 1 ? 'output' : 'outputs'} · {findingCount} {findingCount === 1 ? 'finding' : 'findings'}</span><ChevronDown size={15} /></summary>
      <div className="run-cycle-body">{cycleResults.map(result => <details className={`run-result ${result.judgment ? 'run-result-judge' : ''} ${result.check || result.gate ? 'run-result-control' : ''}`} key={`${result.nodeId}-${result.completedAt}`}>
        <summary className="run-result-summary"><span className="run-result-identity">{result.check || result.gate ? <ShieldCheck size={16} /> : result.judgment ? <Scale size={16} /> : <Bot size={16} />}<strong>{result.nodeName}</strong><span className="tag">{result.check || result.gate ? <><Code2 size={12} />Runs with code</> : <><Cpu size={12} />{modelName(result.modelId)}</>}</span>{result.attempt && result.attempt > 1 && <span className="tag">Attempt {result.attempt}</span>}{result.judgment && <span className="badge badge-green">Judgment</span>}</span><ChevronDown size={14} /></summary>
        <div className="run-result-body"><ControlResult result={result} nodes={state.workflow.nodes}/><ExecutionEvidence result={result}/>
          {result.judgment && <section className="run-judgment" aria-label={`Judgment by ${result.nodeName}`}>
            <div className="run-judgment-heading"><Trophy size={19} /><div><span className="field-label">{result.judgment.winnerNodeId ? 'SELECTED WINNER' : 'NO WINNER SELECTED'}</span><strong>{result.judgment.winnerNodeId ? resultName(result.judgment.winnerNodeId) : 'No candidate was selected'}</strong></div></div>
            <p>{result.judgment.reasoning}</p>
            <ol className="judgment-ranking">{[...result.judgment.scores].sort((a, b) => b.score - a.score).map(score => {
              const candidate = cycleResults.find(item => item.nodeId === score.nodeId);
              const winner = score.nodeId === result.judgment?.winnerNodeId;
              return <li className={winner ? 'judgment-winner' : ''} key={score.nodeId}><div className="judgment-candidate"><strong>{resultName(score.nodeId)}{winner && <Trophy size={13} />}</strong>{candidate && <span>{modelName(candidate.modelId)}</span>}<p>{score.reasoning}</p></div><span className="judgment-score">{score.score}<small>/100</small></span></li>;
            })}</ol>
          </section>}
          <div className="section-label">{result.check || result.gate ? 'Control output' : result.judgment ? 'Judge output' : 'Agent output'}</div>
          <pre className="run-result-output">{result.output || 'This agent returned no text output.'}</pre>
          {result.findings.length > 0 && <div className="run-result-findings"><span className="field-label">REPORTED FINDINGS</span>{result.findings.map((finding, index) => <article className="run-result-finding" key={index}><div className="badge-group"><span className={`badge severity-badge severity-${finding.severity}`}>{severityLabel[finding.severity]}</span>{finding.demo && <span className="badge badge-muted">Demo</span>}</div><h4>{finding.title}</h4><p>{finding.description}</p>{finding.file && <code>{finding.file}{finding.line ? `:${finding.line}` : ''}</code>}{finding.screenshot && <details className="run-result-evidence"><summary><Image size={13} />Screenshot evidence</summary><img src={finding.screenshot} alt={`Screenshot evidence for ${finding.title}`} loading="lazy" /></details>}</article>)}</div>}
          <time className="run-result-time" dateTime={result.completedAt}>Completed {dateTime(result.completedAt)}</time>
        </div>
      </details>)}</div>
    </details>;
  })}</div>;
}

export function RunsPanel({ state, onDecision }: StateProps & { onDecision: (runId: string, gateNodeId: string, decision: 'approve' | 'reject', cycle: number, requestedAt: string) => Promise<void> }) {
  const completeCount = state.runs.filter(run => run.status === 'completed').length;
  return <section className="panel runs-panel"><div className="page-header"><div><div className="page-kicker">A RECORD OF THE WORK</div><h1>Run history <span className="heading-count">{state.runs.length}</span></h1><p>Follow every cycle, handoff, and completed pass through your workflow.</p></div><span className="badge badge-green"><CheckCircle2 size={14} />{completeCount} completed</span></div>
    {!state.runs.length ? <EmptyState icon={Activity} title="Your first run is ahead">Start the workflow from the builder. Each run will appear here with its progress and any errors.</EmptyState> : <div className="runs-list">{[...state.runs].sort((a,b)=>new Date(b.startedAt).getTime()-new Date(a.startedAt).getTime()).map((run, index) => {
      const started = new Date(run.startedAt).getTime();
      const finished = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
      const seconds = Math.max(0, Math.round((finished - started) / 1000));
      const duration = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
      const activeIds = run.activeNodeIds ?? (run.activeNodeId ? [run.activeNodeId] : []);
      return <article className={`run-card card run-${run.status}`} key={run.id}><div className="run-icon">{run.status === 'completed' ? <CheckCircle2 size={22} /> : run.status === 'running' ? <Activity size={22} /> : run.status === 'failed' ? <X size={22} /> : <Clock3 size={22} />}</div><div className="run-body"><div className="run-topline"><h3>Run {state.runs.length - index}</h3><span className={`badge run-status status-${run.status}`}>{run.status.charAt(0).toUpperCase() + run.status.slice(1)}</span><span className="tag">{run.mode === 'demo' ? 'Demo' : 'Pi harness'}</span></div><div className="run-meta"><time dateTime={run.startedAt}>{dateTime(run.startedAt)}</time><span><Clock3 size={13} />{Number.isFinite(seconds) ? duration : 'Unknown duration'}</span><span>{run.cycle} {run.cycle === 1 ? 'cycle' : 'cycles'}</span><span>{run.steps} {run.steps === 1 ? 'step' : 'steps'}</span>{(run.decisionCount !== undefined || !!run.decisions?.length) && <span>{run.decisionCount ?? run.decisions?.length ?? 0} routing decisions</span>}</div><ApprovalCard state={state} run={run} onDecision={onDecision}/>{run.status === 'running' && run.approval?.status !== 'pending' && activeIds.length > 0 && <p className="run-active"><span className="status-dot" />{activeIds.map(id => agentName(state, id)).join(', ')} {activeIds.length === 1 ? 'is' : 'are'} working</p>}{run.error && <div className="run-error" role="alert"><strong>Run stopped with an error</strong><p>{run.error}</p></div>}{run.results && run.results.length > 0 && <RunResults state={state} results={run.results} />}<OutcomeHistory state={state} run={run}/><RoutingTraces state={state} run={run} /><code className="run-id">{run.id}</code></div></article>;
    })}</div>}
  </section>;
}

export function SettingsModal({ workflow, models, runtime, project, onProjectSettings, projectsRoot, workspace, onSave, onClose }: { project?: ProjectSettings; onProjectSettings?: () => void; projectsRoot?: string; workspace?: WorkspaceInfo; workflow: Workflow; models: ModelConfig[]; runtime: RuntimeStatus | null; onSave: (workflow: Workflow) => Promise<void> | void; onClose: () => void }) {
  const dialogRef = useDialogFocus(true);
  const [draft, setDraft] = useState<Workflow>(() => structuredClone(project ? { ...workflow, settings: { ...workflow.settings, projectPath: project.path, previewUrl: project.previewUrl } } : workflow));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [routingProbe, setRoutingProbe] = useState<{ ready: boolean; message: string; answer?: RoutingAnswer } | null>(null);
  const [probingRouting, setProbingRouting] = useState(false);
  const routingProbeController = useRef<AbortController | null>(null);
  function settings(changes: Partial<Workflow['settings']>) { setDraft(current => ({ ...current, settings: { ...current.settings, ...changes } })); setError(''); }
  const routing = draft.settings.routing ?? defaultRoutingSettings;
  function routingSettings(changes: Partial<RoutingSettings>) {
    routingProbeController.current?.abort(); routingProbeController.current = null;
    setProbingRouting(false); setRoutingProbe(null);
    settings({ routing: { ...defaultRoutingSettings, ...draft.settings.routing, ...changes } });
  }
  useEffect(() => () => { routingProbeController.current?.abort(); }, []);
  async function testRoutingConnection() {
    if (probingRouting) return;
    const controller = new AbortController(); routingProbeController.current = controller;
    setProbingRouting(true); setRoutingProbe(null);
    try {
      const response = await apiFetch('/routing/probe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(routing), signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Decision connection check failed.');
      if (routingProbeController.current === controller) setRoutingProbe(result);
    } catch (failure) {
      if (routingProbeController.current === controller && !controller.signal.aborted) setRoutingProbe({ ready: false, message: failure instanceof Error ? failure.message : 'Decision connection check failed.' });
    } finally {
      if (routingProbeController.current === controller) { routingProbeController.current = null; setProbingRouting(false); }
    }
  }
  useEffect(() => { const handleKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); }; window.addEventListener('keydown', handleKey); return () => window.removeEventListener('keydown', handleKey); }, [onClose]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    if (!draft.name.trim()) { setError('Give your workflow a name.'); return; }
    if (draft.settings.executionMode === 'pi' && !draft.settings.projectPath.trim()) { setError('Set a project path to run Pi against a codebase.'); return; }
    if (!draft.nodes.some(node => node.id === draft.settings.entryNodeId && node.type === 'agent')) { setError('Choose an entry agent before saving.'); return; }
    if (!Number.isInteger(draft.settings.maxCycles) || draft.settings.maxCycles < 1 || draft.settings.maxCycles > 1000) { setError('Maximum cycles must be a whole number from 1 to 1,000.'); return; }
    if (!Number.isFinite(draft.settings.intervalSeconds) || draft.settings.intervalSeconds < 0 || draft.settings.intervalSeconds > 86400) { setError('Cycle interval must be between 0 and 86,400 seconds.'); return; }
    if (draft.settings.maxParallelAgents !== undefined && (!Number.isInteger(draft.settings.maxParallelAgents) || draft.settings.maxParallelAgents < 1 || draft.settings.maxParallelAgents > 8)) { setError('Maximum parallel agents must be a whole number from 1 to 8.'); return; }
    if (draft.settings.supervisorModelId && !models.some(model => model.id === draft.settings.supervisorModelId && model.enabled)) { setError('Choose an enabled supervisor model or turn the supervisor off.'); return; }
    if (draft.settings.maxEscalationsPerCycle !== undefined && (!Number.isInteger(draft.settings.maxEscalationsPerCycle) || draft.settings.maxEscalationsPerCycle < 1 || draft.settings.maxEscalationsPerCycle > 10)) { setError('Maximum supervisor visits must be a whole number from 1 to 10 per cycle.'); return; }
    if (draft.settings.maxEscalationsPerRun !== undefined && (!Number.isInteger(draft.settings.maxEscalationsPerRun) || draft.settings.maxEscalationsPerRun < 1 || draft.settings.maxEscalationsPerRun > 100)) { setError('Maximum supervisor visits must be a whole number from 1 to 100 per run.'); return; }
    if ((draft.settings.lessons ?? []).some(lesson => !lesson.text.trim())) { setError('Write a constraint for each lesson, or delete the empty lesson.'); return; }
    if (routing.mode !== 'off') {
      if (!routing.modelId.trim()) { setError('Set a decision model ID before enabling routing.'); return; }
      try { const url = new URL(routing.baseUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(); }
      catch { setError('Decision endpoint must be an HTTP(S) address without credentials, query strings, or fragments.'); return; }
      if (routing.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(routing.apiKeyEnv)) { setError('Decision credentials must use an environment variable name, never the API key itself.'); return; }
      if (!Number.isFinite(routing.confidenceThreshold) || routing.confidenceThreshold < 0.5 || routing.confidenceThreshold > 1) { setError('Decision confidence threshold must be from 0.5 to 1.'); return; }
      if (!Number.isInteger(routing.timeoutSeconds) || routing.timeoutSeconds < 1 || routing.timeoutSeconds > 120) { setError('Decision timeout must be a whole number from 1 to 120 seconds.'); return; }
      if (!Number.isInteger(routing.maxDecisionsPerCycle) || routing.maxDecisionsPerCycle < 1 || routing.maxDecisionsPerCycle > 100) { setError('Maximum decisions per cycle must be a whole number from 1 to 100.'); return; }
      if (!Number.isInteger(routing.maxDecisionsPerRun) || routing.maxDecisionsPerRun < 1 || routing.maxDecisionsPerRun > 1000) { setError('Maximum decisions per run must be a whole number from 1 to 1,000.'); return; }
      if (!Number.isInteger(routing.maxConcurrentRequests) || routing.maxConcurrentRequests < 1 || routing.maxConcurrentRequests > 8) { setError('Decision endpoint slots must be a whole number from 1 to 8.'); return; }
      if (!Number.isInteger(routing.contextWindow) || routing.contextWindow < 4096 || routing.contextWindow > 64000) { setError('Decision context window must be a whole number from 4,096 to 64,000 tokens.'); return; }
      if (!Number.isFinite(routing.temperature) || routing.temperature < 0.1 || routing.temperature > 10) { setError('Decision temperature must be from 0.1 to 10.'); return; }
    }
    if (draft.settings.previewUrl.trim()) { try { const url = new URL(draft.settings.previewUrl); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); } catch { setError('Preview URL must be a complete http:// or https:// address.'); return; } }
    setSaving(true);
    try { await onSave({ ...draft, name: draft.name.trim(), description: draft.description.trim(), settings: { ...draft.settings, projectPath: draft.settings.projectPath.trim(), previewUrl: draft.settings.previewUrl.trim(), ...(draft.settings.routing ? { routing: { ...routing, baseUrl: routing.baseUrl.trim(), modelId: routing.modelId.trim(), apiKeyEnv: routing.apiKeyEnv.trim() } } : {}) } }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save workflow settings. Try again.'); }
    finally { setSaving(false); }
  }
  return <div className="modal-overlay" onClick={onClose}><section ref={dialogRef} className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={event => event.stopPropagation()}><div className="modal-header"><div><div className="page-kicker">MAKE IT YOUR OWN</div><h2 id="settings-title">Workflow settings</h2><p>Set the workspace and choose how the team works.</p></div><button type="button" className="btn-icon" aria-label="Close workflow settings" onClick={onClose}><X size={20} /></button></div><form onSubmit={save}><fieldset disabled={saving} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}><div className="settings-section"><h3><Settings2 size={16} />The basics</h3><div className="form-grid"><label className="field"><span>Workflow name</span><input autoFocus required maxLength={100} value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} /></label><label className="field"><span>Entry agent</span><select required value={draft.settings.entryNodeId} onChange={event => settings({ entryNodeId: event.target.value })}><option value="" disabled>Choose the first agent</option>{draft.nodes.filter(node => node.type === 'agent').map(node => <option key={node.id} value={node.id}>{node.data.label}</option>)}</select></label><label className="field full-width"><span>Description</span><textarea rows={2} maxLength={2000} value={draft.description} onChange={event => setDraft(current => ({ ...current, description: event.target.value }))} placeholder="What should this team achieve?" /></label></div></div>
      <div className="settings-section"><h3><Code2 size={16} />Project</h3><div className="shared-project-summary"><p>{project ? 'The folder and preview are shared by all agents. Change them in Project settings.' : 'Choose a shared project in Project settings. Existing workflow paths continue to work.'}</p>{onProjectSettings&&<button type="button" className="btn btn-secondary btn-small" onClick={onProjectSettings}>Open Project settings<ArrowUpRight size={13}/></button>}</div><div className="form-grid"><label className="field full-width"><span>Project path</span><input aria-label="Project path" readOnly={!!project} value={draft.settings.projectPath} onChange={event => settings({ projectPath: event.target.value })} placeholder={projectsRoot ? `${projectsRoot}/your-app` : 'C:\\projects\\your-app'} spellCheck={false} /><small>{workspace?.hosted && projectsRoot ? <>Ask the host to provision your codebase inside <code>{projectsRoot}</code>, then enter its absolute path.</> : 'Absolute path to an existing codebase on the machine running Crawlspace.'}</small></label><label className="field full-width"><span>UI preview URL</span><input aria-label="UI preview URL" type="url" readOnly={!!project} value={draft.settings.previewUrl} onChange={event => settings({ previewUrl: event.target.value })} placeholder="http://localhost:3000" /><small>Start your app separately. Agents use this address to inspect the UI.</small></label></div></div>
      {workspace && <div className="workspace-policy-note"><strong>{workspace.hosted ? 'Hosted workspace rules' : 'Connection settings'}</strong><p>Approved custom model and decision endpoints: {workspace.modelEndpointOrigins.join(', ') || 'None configured'}. Approved credential names: {workspace.modelKeyNames.join(', ') || 'None configured'}.</p><p>{workspace.hosted ? `Approved preview origins: ${workspace.previewOrigins.join(', ') || 'None configured'}. Ask your host to enable any missing connection.` : <>Preview URLs must use a loopback address. Add LAN or cloud decision servers through <code>CRAWLSPACE_MODEL_ENDPOINT_ORIGINS</code>, and credential names through <code>CRAWLSPACE_MODEL_KEY_ALLOWLIST</code>, then restart Crawlspace.</>}</p></div>}<div className="settings-section"><h3><Play size={16} />Execution</h3><div className="runtime-readiness"><PiRuntimeStatus runtime={runtime} /><p>The included Pi coding runtime uses your model library and the tools enabled for each agent. Code Mode is enabled by default for Pi runs.</p></div><div className="form-grid"><label className="field"><span>Runtime</span><select value={draft.settings.executionMode} onChange={event => settings({ executionMode: event.target.value as Workflow['settings']['executionMode'] })}><option value="demo">Demo — simulated run</option><option value="pi">Pi harness — real agents</option></select><small>{draft.settings.executionMode === 'demo' ? 'Explore the workflow with clearly labeled sample activity.' : 'Configure models in Models, then set the project path above.'}</small></label><label className="field"><span>Run mode</span><select value={draft.settings.mode} onChange={event => settings({ mode: event.target.value as Workflow['settings']['mode'], continuous: event.target.value === 'loop' && !!draft.settings.continuous })}><option value="once">Single pass</option><option value="loop">Repeat in a loop</option></select><small>Each pass begins with your entry agent.</small></label>
        <div className="settings-subheading full-width"><h4>Capacity and review tools</h4></div>
        <label className="field full-width"><span>Maximum parallel agents</span><input type="number" min={1} max={8} step={1} value={draft.settings.maxParallelAgents ?? 1} onChange={event => settings({ maxParallelAgents: Number(event.target.value) })} /><small>1 keeps agents in sequence. Higher limits let independent branches work together, while joins wait for incoming branches. Loop connections and returns to the entry agent belong to the next cycle. Each model's endpoint request slots also apply.</small></label>
        <label className="checkbox-field full-width"><input type="checkbox" aria-label="Code Mode" disabled={draft.settings.executionMode === 'demo'} checked={draft.settings.codeMode !== false} onChange={event => settings({ codeMode: event.target.checked })} /><span>Code Mode<small>For Pi runs. Batch and repeat review tool calls in a sandbox using the same model. Direct tools remain available for model compatibility.</small></span></label>
        <div className="settings-subheading full-width"><h4>When an agent needs help</h4></div>
        <label className="field"><span>Supervisor model</span><select disabled={draft.settings.executionMode === 'demo'} value={draft.settings.supervisorModelId ?? ''} onChange={event => settings({ supervisorModelId: event.target.value || undefined })}><option value="">Off — use assigned models only</option>{models.filter(model => model.enabled).map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select><small>Optional second review when an agent needs help. No supervisor calls while this is off.</small></label>
        <label className="field"><span>Maximum supervisor visits per cycle</span><input type="number" min={1} max={10} step={1} disabled={draft.settings.executionMode === 'demo' || !draft.settings.supervisorModelId} value={draft.settings.maxEscalationsPerCycle ?? 1} onChange={event => settings({ maxEscalationsPerCycle: Number(event.target.value) })} /><small>Each visit can include review tools and retries.</small></label>
        <label className="field"><span>Maximum supervisor visits per run</span><input type="number" min={1} max={100} step={1} disabled={draft.settings.executionMode === 'demo' || !draft.settings.supervisorModelId} value={draft.settings.maxEscalationsPerRun ?? 10} onChange={event => settings({ maxEscalationsPerRun: Number(event.target.value) })} /><small>The run stops for review when this allowance is exhausted. Visits are not an exact token or spending quota.</small></label>
        <div className="settings-subheading full-width"><h4>Repeat schedule</h4></div>
        <label className="checkbox-field full-width"><input type="checkbox" disabled={draft.settings.mode !== 'loop'} checked={draft.settings.continuous ?? false} onChange={event => settings({ continuous: event.target.checked, maxCycles: Number.isInteger(draft.settings.maxCycles) && draft.settings.maxCycles >= 1 && draft.settings.maxCycles <= 1000 ? draft.settings.maxCycles : 1 })} /><span>Keep running until stopped<small>{draft.settings.continuous && draft.settings.mode === 'loop' ? 'The workflow repeats until you press Stop.' : 'Enable for continuous looping, or use a maximum cycle count.'}</small></span></label><label className="field"><span>Maximum cycles</span><input type="number" min={1} max={1000} step={1} disabled={draft.settings.mode === 'once' || !!draft.settings.continuous} value={draft.settings.maxCycles} onChange={event => settings({ maxCycles: Number(event.target.value) })} /><small>{draft.settings.mode === 'once' ? 'Single pass runs one cycle.' : draft.settings.continuous ? 'No cycle limit while continuous looping is enabled.' : 'The workflow stops after this many cycles.'}</small></label><label className="field"><span>Pause between cycles (seconds)</span><input type="number" min={0} max={86400} step={1} disabled={draft.settings.mode === 'once'} value={draft.settings.intervalSeconds} onChange={event => settings({ intervalSeconds: Number(event.target.value) })} /></label></div></div>
      <LessonsEditor workflow={draft} onChange={setDraft}/>
      <div className="settings-section routing-settings"><h3><Cpu size={16} />Decision routing</h3><fieldset className="form-grid routing-controls" disabled={draft.settings.executionMode === 'demo'}>
        <label className="field full-width"><span>Decision routing mode</span><select value={routing.mode} onChange={event => routingSettings({ mode: event.target.value as RoutingSettings['mode'] })}><option value="off">Off — use assigned models</option><option value="shadow">Shadow — record decisions, keep assigned models</option><option value="active">Active — use decisions to choose the review model</option></select><small>{draft.settings.executionMode === 'demo' ? 'Decision routing is used only for Pi runs.' : 'Shadow records recommendations while assigned models continue. Active uses a confident assigned-model choice; other results request the configured supervisor within its allowances, or stop for your review if no supervisor is available. Only local assignments are routed; cloud assignments and agents already using the supervisor continue directly.'}</small></label>
        {routing.mode !== 'off' && <>
          <label className="field full-width"><span>Decision backend</span><select value={routing.backend} onChange={event => routingSettings(event.target.value === 'llama-cpp' ? { backend: 'llama-cpp', baseUrl: 'http://127.0.0.1:8080/v1', modelId: '', apiKeyEnv: '' } : { backend: 'system-one', baseUrl: defaultRoutingSettings.baseUrl, modelId: defaultRoutingSettings.modelId, apiKeyEnv: defaultRoutingSettings.apiKeyEnv })}><option value="system-one">Native decision API — hosted or self-hosted</option><option value="llama-cpp">llama.cpp — local classifier</option></select><small>{routing.backend === 'system-one' ? 'Use Jev cloud or a self-hosted native decision API such as OpenJev. A regular Strata chat endpoint is not automatically a decision server.' : 'The local classifier uses raw model probabilities, which may be overconfident. Assess its recommendations in shadow mode before enabling routing.'}</small></label>
          <p className="routing-sharing-note full-width">The selected decision endpoint receives the assignment and retained review text. No files or images are attached. Hosted endpoints receive this text over the network. These credentials are separate from ChatGPT sign-in.</p>
          <label className="field full-width"><span>Decision endpoint URL</span><input type="url" value={routing.baseUrl} required maxLength={2000} onChange={event => routingSettings({ baseUrl: event.target.value })} spellCheck={false} /><small>Use the server's base URL, including /v1. Local and LAN addresses are supported.</small></label>
          <label className="field"><span>Decision model ID</span><input value={routing.modelId} required maxLength={300} onChange={event => routingSettings({ modelId: event.target.value })} placeholder="Exact model served by this endpoint" spellCheck={false} /></label>
          <label className="field"><span>Decision API key environment variable</span><input value={routing.apiKeyEnv} maxLength={200} onChange={event => routingSettings({ apiKeyEnv: event.target.value })} placeholder="Optional environment variable name" spellCheck={false} /><small>Enter a variable name, never the key value. Set it before starting or restarting Crawlspace.</small></label>
          <label className="field"><span>Decision confidence threshold</span><input type="number" min={0.5} max={1} step={0.01} value={routing.confidenceThreshold} onChange={event => routingSettings({ confidenceThreshold: Number(event.target.value) })} /><small>0.95 means a 95% model score, not measured accuracy.</small></label>
          <label className="field"><span>Decision timeout (seconds)</span><input type="number" min={1} max={120} step={1} value={routing.timeoutSeconds} onChange={event => routingSettings({ timeoutSeconds: Number(event.target.value) })} /></label>
          <label className="field"><span>Maximum decisions per cycle</span><input type="number" min={1} max={100} step={1} value={routing.maxDecisionsPerCycle} onChange={event => routingSettings({ maxDecisionsPerCycle: Number(event.target.value) })} /></label>
          <label className="field"><span>Maximum decisions per run</span><input type="number" min={1} max={1000} step={1} value={routing.maxDecisionsPerRun} onChange={event => routingSettings({ maxDecisionsPerRun: Number(event.target.value) })} /><small>Decision calls also count when they fail or are cancelled.</small></label>
          <label className="field"><span>Decision endpoint slots</span><input type="number" min={1} max={8} step={1} value={routing.maxConcurrentRequests} onChange={event => routingSettings({ maxConcurrentRequests: Number(event.target.value) })} /><small>Keep 1 unless your decision server can handle more at once.</small></label>
          <label className="field"><span>Decision context window (tokens)</span><input type="number" min={4096} max={64000} step={1} value={routing.contextWindow} onChange={event => routingSettings({ contextWindow: Number(event.target.value) })} /><small>Bounds the review text sent for each decision.</small></label>
          {routing.backend === 'llama-cpp' && <label className="field"><span>Decision temperature</span><input type="number" min={0.1} max={10} step={0.1} value={routing.temperature} onChange={event => routingSettings({ temperature: Number(event.target.value) })} /><small>Adjusts the local score distribution. Start at 1 and assess results in shadow mode.</small></label>}
        </>}
        <div className="routing-probe full-width"><button type="button" className="btn btn-secondary btn-small" disabled={routing.mode === 'off' || probingRouting || !routing.modelId.trim()} onClick={() => void testRoutingConnection()}>{probingRouting ? 'Testing decision connection…' : 'Test decision connection'}</button><p>Tests this draft configuration using a fixed sample assignment. Your project and saved review text are not sent by this test. A request is made only when you click.</p>{routingProbe && <p role="status" className={routingProbe.ready ? 'probe-success' : 'form-error'}>{routingProbe.message}{routingProbe.answer && <span> Sample recommendation: {routingChoiceLabel[routingProbe.answer.choice]} · {percent(routingProbe.answer.confidence)} score.</span>}</p>}</div>
      </fieldset></div>
      {error && <p className="form-error" role="alert">{error}</p>}<div className="modal-footer"><button className="btn btn-secondary" type="button" onClick={onClose}>Cancel</button><button className="btn btn-primary" type="submit"><Check size={16} />{saving ? 'Saving…' : 'Save settings'}</button></div></fieldset>
    </form></section></div>;
}



