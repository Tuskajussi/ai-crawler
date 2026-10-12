import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BookOpen, Check, CircleAlert, Cloud, Cpu, Download, FileText, Film, FolderOpen, Image, LoaderCircle, Mic, Search, Settings2, Trash2, Upload, X } from 'lucide-react';
import { defaultChunkOptions, defaultEmbeddingConfig, type ChunkLocator, type ChunkOptions, type EmbeddingConfig, type KnowledgeJob, type KnowledgeModality, type KnowledgePreview, type KnowledgeSearchResult, type KnowledgeStatus } from '../shared/knowledge';
import './knowledge.css';

async function api<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/knowledge${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal });
  if (response.status === 204) return undefined as T;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

const modalityIcons = { text: FileText, pdf: FileText, image: Image, audio: Mic, video: Film };
const modalityLabels: Record<KnowledgeModality, string> = { text: 'Text', pdf: 'PDF', image: 'Image', audio: 'Audio', video: 'Video' };
const formatBytes = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const timecode = (seconds: number) => `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
function locationLabel(locator: ChunkLocator): string {
  if (locator.pageStart !== undefined) return locator.pageEnd !== undefined && locator.pageEnd !== locator.pageStart ? `Pages ${locator.pageStart}-${locator.pageEnd}` : `Page ${locator.pageStart}`;
  if (locator.startSeconds !== undefined) return `${locator.track === 'audio' ? 'Audio' : locator.track === 'video' ? 'Video' : 'Clip'} ${timecode(locator.startSeconds)}-${timecode(locator.endSeconds ?? locator.startSeconds)}`;
  if (locator.startLine !== undefined) return `Lines ${locator.startLine}-${locator.endLine ?? locator.startLine}`;
  if (locator.startChar !== undefined) return `Characters ${locator.startChar + 1}-${locator.endChar ?? locator.startChar + 1}`;
  return 'Whole source';
}
function destination(config: EmbeddingConfig): string {
  if (config.provider === 'gemini') return 'Google Gemini API';
  if (config.provider === 'vertex') return `Google Vertex AI (${config.location})`;
  return config.kind === 'local' ? `Your embedding server (${config.baseUrl})` : `Cloud embedding server (${config.baseUrl})`;
}
function providerDefaults(provider: EmbeddingConfig['provider']): EmbeddingConfig {
  if (provider === 'compatible') return { ...defaultEmbeddingConfig, provider, kind: 'local', modelId: 'embeddinggemma', baseUrl: 'http://127.0.0.1:11434/v1', apiKeyEnv: '' };
  if (provider === 'vertex') return { ...defaultEmbeddingConfig, provider, apiKeyEnv: '' };
  return { ...defaultEmbeddingConfig };
}

export function KnowledgePanel() {
  const [status, setStatus] = useState<KnowledgeStatus>();
  const [config, setConfig] = useState<EmbeddingConfig>({ ...defaultEmbeddingConfig });
  const [inputMode, setInputMode] = useState<'text' | 'file'>('text');
  const [name, setName] = useState('Notes');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File>();
  const [options, setOptions] = useState<ChunkOptions>({ ...defaultChunkOptions });
  const [preview, setPreview] = useState<KnowledgePreview>();
  const [busy, setBusy] = useState<'config' | 'prepare' | 'index' | 'search' | 'delete' | 'cancel'>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [embedConsent, setEmbedConsent] = useState(false);
  const [searchConsent, setSearchConsent] = useState(false);
  const [query, setQuery] = useState('');
  const [searchSource, setSearchSource] = useState('all');
  const [results, setResults] = useState<KnowledgeSearchResult[]>();
  const [deleteId, setDeleteId] = useState<string>();
  const prepareController = useRef<AbortController | undefined>(undefined);
  const requestController = useRef<AbortController | undefined>(undefined);
  const previewId = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const configDirty = !!status && JSON.stringify(config) !== JSON.stringify(status.config);
  const running = status?.job?.status === 'running';
  const blocked = !!busy || !!running || !status;
  const cloud = status?.config.kind === 'cloud';
  const unsupportedPreview = !!preview && status?.config.provider === 'compatible' && preview.modality !== 'text';
  const compatibleSources = status?.sources.filter(source => source.compatible) ?? [];

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void api<KnowledgeStatus>('', 'GET', undefined, controller.signal).then(next => { setStatus(next); setConfig(next.config); }).catch(failure => { if (!controller.signal.aborted) setError((failure as Error).message); });
    return () => {
      mounted.current = false;
      controller.abort(); prepareController.current?.abort(); requestController.current?.abort();
      if (previewId.current) void api(`/previews/${encodeURIComponent(previewId.current)}`, 'DELETE').catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!running) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const next = await api<KnowledgeStatus>('', 'GET', undefined, controller.signal);
        if (stopped) return;
        setStatus(next);
        if (next.job?.status === 'completed') {
          setNotice(`${next.job.sourceName} saved with ${next.job.totalChunks} searchable chunks.`);
          setPreview(undefined); previewId.current = undefined; setResults(undefined);
        } else if (next.job?.status === 'failed') setError(next.job.error || 'Embedding creation failed. No partial source was saved.');
        else if (next.job?.status === 'cancelled') setNotice('Embedding creation cancelled. No partial source was saved.');
        if (next.job?.status === 'running') timer = setTimeout(() => void poll(), 1000);
      } catch (failure) {
        if (!stopped) { setError(`Could not refresh embedding progress. ${(failure as Error).message}`); timer = setTimeout(() => void poll(), 2500); }
      }
    };
    timer = setTimeout(() => void poll(), 500);
    return () => { stopped = true; clearTimeout(timer); controller.abort(); };
  }, [running, status?.job?.id]);

  const clearPreview = () => {
    if (previewId.current) void api(`/previews/${encodeURIComponent(previewId.current)}`, 'DELETE').catch(() => {});
    previewId.current = undefined; setPreview(undefined); setEmbedConsent(false);
  };
  const patchConfig = (patch: Partial<EmbeddingConfig>) => { setConfig(current => ({ ...current, ...patch })); setEmbedConsent(false); setSearchConsent(false); };
  const action = async (kind: Exclude<typeof busy, undefined>, operation: (signal: AbortSignal) => Promise<void>) => {
    setBusy(kind); setError(''); setNotice('');
    const controller = new AbortController(); requestController.current = controller;
    try { await operation(controller.signal); }
    catch (failure) { if (mounted.current && !controller.signal.aborted) setError((failure as Error).message); }
    finally { if (mounted.current) setBusy(undefined); requestController.current = undefined; }
  };
  const saveConfig = (event: FormEvent) => {
    event.preventDefault();
    void action('config', async signal => {
      const next = await api<KnowledgeStatus>('/config', 'PUT', config, signal);
      clearPreview();
      setStatus(next); setConfig(next.config); setResults(undefined); setSearchSource('all'); setEmbedConsent(false); setSearchConsent(false); setNotice('Embedding settings saved.');
    });
  };
  const prepare = async (event: FormEvent) => {
    event.preventDefault();
    if (blocked) return;
    setError(''); setNotice(''); setBusy('prepare'); setEmbedConsent(false); clearPreview();
    const controller = new AbortController(); prepareController.current = controller;
    try {
      let next: KnowledgePreview;
      if (inputMode === 'text') next = await api<KnowledgePreview>('/preview', 'POST', { name: name.trim() || 'Notes', text, options }, controller.signal);
      else {
        if (!file) throw new Error('Choose a file to prepare.');
        if (status && file.size > status.limits.uploadBytes) throw new Error(`Choose a file smaller than ${formatBytes(status.limits.uploadBytes)}.`);
        const response = await fetch('/api/knowledge/preview', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), 'X-File-Type': file.type || '', 'X-Chunk-Options': JSON.stringify(options) }, body: file, signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `File preparation failed (${response.status})`);
        next = data;
      }
      if (!mounted.current) return;
      previewId.current = next.id; setPreview(next); setNotice('Chunks prepared on this machine. Review them before creating embeddings.');
    } catch (failure) { if (mounted.current) { if (controller.signal.aborted) setNotice('File preparation cancelled.'); else setError((failure as Error).message); } }
    finally { if (mounted.current) setBusy(undefined); prepareController.current = undefined; }
  };
  const createEmbeddings = () => {
    if (!preview || blocked || configDirty || unsupportedPreview || (cloud && !embedConsent)) return;
    void action('index', async signal => {
      const job = await api<KnowledgeJob>('/index', 'POST', { previewId: preview.id, allowCloudUpload: cloud ? embedConsent : false }, signal);
      // The backend consumes a preview when it accepts a job, including jobs that later fail or stop.
      previewId.current = undefined; setPreview(undefined);
      setStatus(current => current ? { ...current, job } : current); setEmbedConsent(false);
    });
  };
  const search = (event: FormEvent) => {
    event.preventDefault();
    if (blocked || configDirty || (cloud && !searchConsent)) return;
    void action('search', async signal => {
      const response = await api<{ results: KnowledgeSearchResult[] }>('/search', 'POST', { query: query.trim(), limit: 8, ...(searchSource === 'all' ? {} : { sourceIds: [searchSource] }), allowCloudUpload: cloud ? searchConsent : false }, signal);
      setResults(response.results); setSearchConsent(false);
    });
  };
  const deleteSource = (id: string) => void action('delete', async signal => {
    const next = await api<KnowledgeStatus>(`/sources/${encodeURIComponent(id)}`, 'DELETE', undefined, signal);
    setStatus(next); setDeleteId(undefined); setResults(undefined); if (searchSource === id) setSearchSource('all'); setNotice('Source and its saved embeddings deleted.');
  });
  const cancelJob = () => {
    if (!status?.job || busy) return;
    void action('cancel', async signal => {
      const next = await api<KnowledgeStatus>(`/jobs/${encodeURIComponent(status.job!.id)}/cancel`, 'POST', undefined, signal);
      setStatus(next);
      if (next.job?.status === 'completed') {
        setNotice(`${next.job.sourceName} saved with ${next.job.totalChunks} searchable chunks.`); setResults(undefined);
      } else if (next.job?.status === 'failed') setError(next.job.error || 'Embedding creation failed. Prepare the source again to retry.');
      else setNotice(next.job?.status === 'running' ? 'Cancellation requested. Waiting for the active chunk to stop.' : 'Embedding creation cancelled. Prepare the source again to retry.');
    });
  };

  return <section className="panel knowledge-panel">
    <div className="page-header"><div><div className="page-kicker">A SEARCHABLE MEMORY</div><h1>Knowledge</h1><p>Turn text, PDFs, images, audio and video into searchable chunks. Keep the chunks and their embeddings in your local workspace.</p></div><div className="knowledge-summary"><span><FolderOpen size={13} />{status?.sources.length ?? 0} sources</span><span><BookOpen size={13} />{status?.sources.reduce((total, source) => total + source.chunkCount, 0) ?? 0} chunks</span></div></div>
    {error && <div className="form-error" role="alert">{error}</div>}
    {notice && <div className="knowledge-notice" role="status"><Check size={16} />{notice}</div>}
    {!status && !error && <p className="knowledge-loading"><LoaderCircle size={17} className="spin" />Loading your local library...</p>}
    <div className="knowledge-setup-link"><span>{status ? `Current embedding model: ${status.config.modelId}` : 'Loading embedding setup'}</span><a href="#knowledge-embedding-setup">Embedding settings<Settings2 size={14} /></a></div>
    <div className="knowledge-layout">
      <div className="knowledge-workflow">
        <section className="knowledge-card"><header><Upload size={19} /><div><h2>1. Prepare your source</h2><p>Choose a file or paste text. Preparation splits it into chunks on this machine.</p></div></header>
          <div className="knowledge-input-tabs" aria-label="Source input"><button type="button" aria-pressed={inputMode === 'text'} disabled={blocked} onClick={() => { setInputMode('text'); clearPreview(); }}><FileText size={14} />Paste text</button><button type="button" aria-pressed={inputMode === 'file'} disabled={blocked} onClick={() => { setInputMode('file'); clearPreview(); }}><Upload size={14} />Choose a file</button></div>
          <form onSubmit={event => void prepare(event)}>
            {inputMode === 'text' ? <><label className="field">Source name<input value={name} maxLength={200} disabled={blocked} onChange={event => { setName(event.target.value); clearPreview(); }} /></label><label className="field">Text to index<textarea rows={7} placeholder="Paste notes, documentation, or an excerpt..." value={text} disabled={blocked} onChange={event => { setText(event.target.value); clearPreview(); }} required /></label></> : <><label className="field">File<input aria-label="File" className="knowledge-file-input" type="file" accept=".txt,.md,.markdown,.csv,.json,.html,.xml,.log,.pdf,.png,.jpg,.jpeg,.webp,.bmp,.heic,.heif,.avif,.mp3,.wav,.m4a,.flac,.ogg,.mp4,.mov,.mpeg,.mpg,.webm" disabled={blocked} onChange={event => { setFile(event.target.files?.[0]); clearPreview(); }} /><small>Text, PDFs, images, audio and video. Common formats include PNG, JPEG, WebP, MP3, WAV, MP4, MOV and more. Up to {formatBytes(status?.limits.uploadBytes ?? 100 * 1024 * 1024)} per source.</small></label>{file && <p className="knowledge-file-detail"><FileText size={14} />{file.name} · {formatBytes(file.size)}</p>}<p className="knowledge-section-help">PDFs use one page per chunk. Images use one chunk. Audio is split into clips; video includes separate picture and audio chunks for its default soundtrack, when present.</p></>}
            <details className="knowledge-options"><summary>Chunk options</summary><div className="form-grid"><label className="field">Text characters per chunk<input type="number" min={200} max={1800} value={options.textCharacters} disabled={blocked} onChange={event => { setOptions(current => ({ ...current, textCharacters: Number(event.target.value) })); clearPreview(); }} /></label><label className="field">Text overlap (characters)<input type="number" min={0} max={Math.min(400, options.textCharacters - 1)} value={options.textOverlap} disabled={blocked} onChange={event => { setOptions(current => ({ ...current, textOverlap: Number(event.target.value) })); clearPreview(); }} /></label><label className="field">Audio clip length (seconds)<input type="number" min={10} max={170} value={options.audioSeconds} disabled={blocked} onChange={event => { setOptions(current => ({ ...current, audioSeconds: Number(event.target.value) })); clearPreview(); }} /></label><label className="field">Video clip length (seconds)<input type="number" min={10} max={110} value={options.videoSeconds} disabled={blocked} onChange={event => { setOptions(current => ({ ...current, videoSeconds: Number(event.target.value) })); clearPreview(); }} /></label></div><p>Each source can contain up to {status?.limits.chunksPerSource ?? 100} chunks. FFmpeg is required for audio/video and for image formats other than PNG/JPEG.</p></details>
            <div className="knowledge-form-actions"><button type="submit" className="btn btn-secondary" disabled={blocked || (inputMode === 'text' ? !text.trim() : !file)}>{busy === 'prepare' ? <LoaderCircle className="spin" size={14} /> : <BookOpen size={14} />}{busy === 'prepare' ? 'Preparing chunks...' : 'Preview chunks'}</button>{busy === 'prepare' && <button type="button" className="btn btn-secondary" onClick={() => prepareController.current?.abort()}><X size={14} />Cancel preparation</button>}<span className="knowledge-actions-status">No embedding provider is contacted.</span></div>
          </form>
        </section>
        <section className="knowledge-card"><header><BookOpen size={19} /><div><h2>2. Review and create embeddings</h2><p>Every chunk receives a vector and a source location so search results keep their context.</p></div></header>
          {preview ? <><h3 className="knowledge-preview-title">{preview.name}</h3><p className="knowledge-preview-meta">{modalityLabels[preview.modality]} · {formatBytes(preview.bytes)} · {preview.chunks.length} chunks · Preview expires {new Date(preview.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>{preview.modality === 'pdf' && <p className="knowledge-note">Dense PDF pages can exceed the model's input limit and may be truncated. Split or simplify those pages for complete coverage.</p>}<div className="knowledge-chunk-list" aria-label="Prepared chunks">{preview.chunks.map(chunk => { const Icon = modalityIcons[chunk.modality]; return <article className="knowledge-chunk" key={chunk.id}><header><Icon size={13} /><strong>Chunk {chunk.index + 1}</strong><span>{modalityLabels[chunk.modality]}</span><span>{locationLabel(chunk.locator)}</span></header><p>{chunk.preview}</p></article>; })}</div><p className="knowledge-destination">{cloud ? <Cloud size={14} /> : <Cpu size={14} />}<span>Embedding destination: {status ? destination(status.config) : 'Load settings first'}. Vectors and source metadata are saved locally.</span></p>{unsupportedPreview && <p className="knowledge-note">This source needs Gemini or Vertex. Compatible servers support text chunks only.</p>}{configDirty && <p className="knowledge-note">Save your embedding settings before creating embeddings.</p>}{status && !status.readiness.ready && <p className="knowledge-note">Your embedding model needs setup. <a href="#knowledge-embedding-setup">Review embedding settings</a> before creating embeddings.</p>}{cloud && <label className="knowledge-cloud-consent"><input type="checkbox" checked={embedConsent} disabled={blocked || configDirty} onChange={event => setEmbedConsent(event.target.checked)} /><span>Send these {preview.chunks.length} chunks to {status ? destination(status.config) : 'the cloud provider'} to create embeddings. This can use billable API requests.</span></label>}<div className="knowledge-form-actions"><button type="button" className="btn btn-primary" disabled={blocked || configDirty || unsupportedPreview || !status?.readiness.ready || (cloud && !embedConsent)} onClick={createEmbeddings}><BookOpen size={14} />Create embeddings</button><button type="button" className="btn btn-secondary" disabled={blocked} onClick={clearPreview}>Discard preview</button></div></> : running ? null : <div className="knowledge-preview-empty"><BookOpen size={25} /><h3>Your chunks will appear here</h3><p>Prepare a source to review the exact pieces before sending them to an embedding model.</p></div>}
          {status?.job && <div className="knowledge-job" role="status"><header>{running ? <LoaderCircle size={15} className="spin" /> : status.job.status === 'completed' ? <Check size={15} /> : <CircleAlert size={15} />}<strong>{status.job.status === 'running' ? 'Creating embeddings' : status.job.status === 'completed' ? 'Embeddings saved' : status.job.status === 'cancelled' ? 'Creation cancelled' : 'Creation failed'}</strong></header><p>{status.job.sourceName} · {status.job.completedChunks} of {status.job.totalChunks} chunks</p><progress aria-label="Embedding progress" value={status.job.completedChunks} max={Math.max(1, status.job.totalChunks)} />{status.job.error && <p>{status.job.error}</p>}{running && <><p>The source is saved only after every chunk succeeds.</p><button type="button" className="btn btn-secondary" disabled={!!busy} onClick={cancelJob}>{busy === 'cancel' ? 'Requesting cancellation...' : 'Cancel creation'}</button></>}</div>}
        </section>
      </div>
      <section id="knowledge-embedding-setup" className="knowledge-card knowledge-provider" aria-labelledby="knowledge-provider-heading"><header><Settings2 size={19} /><div><h2 id="knowledge-provider-heading">Embedding model</h2><p>Configure your provider here. Use Google for all five media types, or your own text embedding server.</p></div></header>
        {status && <p className={`knowledge-readiness${status.readiness.ready ? '' : ' is-unready'}`} role="status">{status.readiness.ready ? <Check size={16} /> : <CircleAlert size={16} />}<span>{status.readiness.message}</span></p>}
        <form onSubmit={saveConfig}>
        <label className="field">Embedding provider<select aria-label="Embedding provider" value={config.provider} disabled={blocked} onChange={event => { setConfig(providerDefaults(event.target.value as EmbeddingConfig['provider'])); setEmbedConsent(false); setSearchConsent(false); }}><option value="gemini">Google Gemini API</option><option value="vertex">Google Vertex AI</option><option value="compatible">Compatible embedding server</option></select></label>
        {config.provider === 'compatible' && <><label className="field">Server location<select aria-label="Server location" value={config.kind} disabled={blocked} onChange={event => patchConfig({ kind: event.target.value as EmbeddingConfig['kind'] })}><option value="local">Local machine or private network</option><option value="cloud">Cloud service</option></select></label><label className="field">Embedding server URL<input aria-label="Embedding server URL" type="url" value={config.baseUrl} disabled={blocked} onChange={event => patchConfig({ baseUrl: event.target.value })} required /><small>For Ollama, use http://127.0.0.1:11434/v1. For another machine, use its private LAN IP. The server must support the embeddings endpoint.</small></label></>}
        <label className="field">Embedding model ID<input aria-label="Embedding model ID" value={config.modelId} disabled={blocked} readOnly={config.provider !== 'compatible'} onChange={event => patchConfig({ modelId: event.target.value })} required /><small>{config.provider === 'compatible' ? 'Choose a dedicated embedding model installed on your server, such as embeddinggemma.' : 'Gemini Embedding 2 places text, images, PDFs, audio and video in a shared search space.'}</small></label>
        {config.provider === 'vertex' ? <><label className="field">Google Cloud project ID<input aria-label="Google Cloud project ID" value={config.projectId} disabled={blocked} onChange={event => patchConfig({ projectId: event.target.value })} required /></label><label className="field">Vertex location<select aria-label="Vertex location" value={config.location} disabled={blocked} onChange={event => patchConfig({ location: event.target.value as EmbeddingConfig['location'] })}><option value="eu">EU</option><option value="us">US</option><option value="global">Global</option></select></label><p className="knowledge-note">Vertex uses Google Application Default Credentials on the Crawlspace server. Set them up before starting or restarting the app.</p></> : <label className="field">API key environment variable<input aria-label="API key environment variable" value={config.apiKeyEnv} placeholder={config.provider === 'gemini' ? 'GEMINI_API_KEY' : 'Optional for local servers'} pattern="[A-Z_][A-Z0-9_]*" disabled={blocked} onChange={event => patchConfig({ apiKeyEnv: event.target.value })} required={config.provider === 'gemini'} /><small>Enter the variable name, never the key. Set its value in the server environment before starting or restarting Crawlspace.</small></label>}
        <div className="form-grid"><label className="field">Vector dimensions<input aria-label="Vector dimensions" type="number" min={config.provider === 'compatible' ? 1 : 128} max={config.provider === 'compatible' ? 8192 : 3072} value={config.dimensions} disabled={blocked} onChange={event => patchConfig({ dimensions: Number(event.target.value) })} required /><small>768 uses less storage. The model must support the selected size.</small></label><label className="field">Request timeout (seconds)<input aria-label="Request timeout (seconds)" type="number" min={5} max={300} value={config.timeoutSeconds} disabled={blocked} onChange={event => patchConfig({ timeoutSeconds: Number(event.target.value) })} required /></label></div>
        <div className="knowledge-note">{config.provider === 'compatible' ? <><strong>Text only.</strong> Image, PDF, audio and video embeddings require Gemini or Vertex in this version.</> : <><strong>Cloud processing.</strong> Creating embeddings sends source chunks to Google. Searching sends your query. Each action asks you to opt in.</>}</div>
        <div className="knowledge-form-actions"><button type="submit" className="btn btn-secondary" disabled={blocked || !configDirty}>{busy === 'config' ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}{busy === 'config' ? 'Saving...' : 'Save embedding settings'}</button></div>
        {configDirty && <p className="knowledge-unsaved" role="status">Unsaved changes. Save settings to use this configuration.</p>}
      </form></section>
    </div>
    <section className="knowledge-card"><header className="knowledge-library-header"><FolderOpen size={19} /><div><h2>Saved sources</h2><p>Sources and vectors stay in this workspace. Changing embedding models keeps old sources, with separate search spaces.</p></div></header>{status?.sources.length ? <div className="knowledge-source-list">{status.sources.map(source => { const Icon = modalityIcons[source.modality]; return <div key={source.id}><article className="knowledge-source"><Icon size={21} /><div className="knowledge-source-body"><h3>{source.name}</h3><p>{modalityLabels[source.modality]} · {source.chunkCount} chunks · {source.dimensions} dimensions · {source.modelId} · {new Date(source.createdAt).toLocaleDateString()}</p>{!source.compatible && <p className="knowledge-incompatible">Uses another embedding space. Switch back to its provider, model and dimensions to search it.</p>}</div><div className="knowledge-source-actions"><a className="btn btn-secondary" aria-label={`Export ${source.name}`} title="Export chunks and vectors" href={`/api/knowledge/sources/${encodeURIComponent(source.id)}/export`} download><Download size={16} />Export</a><button type="button" className="btn btn-secondary danger-text" aria-label={`Delete ${source.name}`} disabled={blocked} onClick={() => setDeleteId(source.id)}><Trash2 size={16} />Delete</button></div></article>{deleteId === source.id && <div className="knowledge-delete-confirm"><p>Delete {source.name} and all its saved embeddings?</p><button type="button" className="btn btn-secondary btn-small" disabled={blocked} onClick={() => setDeleteId(undefined)}>Keep source</button><button type="button" className="btn btn-danger btn-small" disabled={blocked} onClick={() => deleteSource(source.id)}>Delete source</button></div>}</div>; })}</div> : <p className="knowledge-empty">Your library is empty. Preview a source, then create its embeddings to save it here.</p>}</section>
    <section className="knowledge-card"><header><Search size={19} /><div><h2>Search your chunks</h2><p>Find relevant text, pages, pictures or moments with a text query. Results include the original source location.</p></div></header><form onSubmit={search}><div className="knowledge-search-row"><label className="field">Search query<input value={query} placeholder="What would you like to find?" disabled={blocked} onChange={event => { setQuery(event.target.value); setSearchConsent(false); }} required maxLength={6000} /></label><button className="btn btn-primary" type="submit" disabled={blocked || configDirty || !status?.readiness.ready || !query.trim() || !compatibleSources.length || (cloud && !searchConsent)}>{busy === 'search' ? <LoaderCircle size={14} className="spin" /> : <Search size={14} />}{busy === 'search' ? 'Searching...' : 'Search chunks'}</button></div><label className="field" style={{ marginTop: 14 }}>Search sources<select aria-label="Search sources" value={searchSource} disabled={blocked || !compatibleSources.length} onChange={event => setSearchSource(event.target.value)}><option value="all">All sources in the current embedding space</option>{compatibleSources.map(source => <option value={source.id} key={source.id}>{source.name}</option>)}</select></label>{cloud && <label className="knowledge-cloud-consent"><input type="checkbox" checked={searchConsent} disabled={blocked || configDirty} onChange={event => setSearchConsent(event.target.checked)} /><span>Send this search query to {status ? destination(status.config) : 'the cloud provider'} to create its embedding. This can use a billable API request.</span></label>}{configDirty ? <p className="knowledge-section-help">Save your embedding settings before searching.</p> : status && !compatibleSources.length && <p className="knowledge-section-help">Create embeddings with the current provider, model and dimensions to search this space.</p>}</form>{results && <div className="knowledge-results" aria-label="Search results" aria-live="polite">{results.length ? results.map(result => <article className="knowledge-result" key={`${result.sourceId}-${result.chunk.id}`}><header><strong>{result.sourceName}</strong><span>Similarity {result.score.toFixed(3)}</span></header><p>{result.chunk.text || result.chunk.preview}</p><cite>{result.sourceName} · Chunk {result.chunk.index + 1} · {modalityLabels[result.chunk.modality]} · {locationLabel(result.chunk.locator)}</cite><a className="text-button knowledge-chunk-download" href={`/api/knowledge/sources/${encodeURIComponent(result.sourceId)}/chunks/${encodeURIComponent(result.chunk.id)}/content`} download aria-label={`Download chunk ${result.chunk.index + 1} from ${result.sourceName}`}><Download size={13} />Download chunk</a></article>) : <p className="knowledge-empty">No matching chunks found in the selected sources.</p>}</div>}</section>
  </section>;
}
