import { useEffect, useState, type FormEvent } from 'react';
import { CheckCircle2, Code2, FolderGit2, ListChecks, LoaderCircle, Plus, Save, Trash2 } from 'lucide-react';
import type { AppState, ProjectSettings } from '../shared/types';
import { request } from './api';
import './project.css';

function currentProject(state: AppState): ProjectSettings {
  return state.project ?? { path: state.workflow.settings.projectPath, previewUrl: state.workflow.settings.previewUrl, allowEdits: false, allowTests: false, testCommands: [] };
}

export function ProjectPanel({ state, locked, onSave }: { state: AppState; locked: boolean; onSave: (project: ProjectSettings) => Promise<void> }) {
  const source = JSON.stringify(currentProject(state));
  const [draft, setDraft] = useState<ProjectSettings>(() => structuredClone(currentProject(state)));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<'validate' | 'save' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const hosted = state.workspace?.hosted === true;
  const disabled = locked || !!busy;
  useEffect(() => { if (!dirty) setDraft(JSON.parse(source)); }, [source, dirty]);
  const update = (patch: Partial<ProjectSettings>) => { setDraft(value => ({ ...value, ...patch })); setDirty(true); setError(''); setNotice(''); };
  const validateDraft = () => {
    if (!draft.path.trim()) throw new Error('Choose the existing project folder to continue.');
    if (draft.testCommands.some(command => !command.name.trim() || !command.command.trim())) throw new Error('Give each test command a name and command, or remove the empty row.');
  };
  const validate = async () => {
    setError(''); setNotice(''); setBusy('validate');
    try {
      validateDraft();
      const result = await request('/project/validate', 'POST', { ...draft, path: draft.path.trim() }) as { path: string; message: string };
      setDraft(value => ({ ...value, path: result.path })); setDirty(true); setNotice(result.message);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The folder could not be checked.'); }
    finally { setBusy(null); }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setNotice(''); setBusy('save');
    try {
      validateDraft();
      await onSave({ ...draft, path: draft.path.trim(), previewUrl: draft.previewUrl.trim(), testCommands: draft.testCommands.map(command => ({ ...command, name: command.name.trim(), command: command.command.trim() })) });
      setDirty(false); setNotice('Project settings saved. All agents use this folder.');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Project settings could not be saved.'); }
    finally { setBusy(null); }
  };
  return <section className="panel project-panel"><div className="page-header"><div><div className="page-kicker">ONE PROJECT, YOUR WHOLE TEAM</div><h1>Project settings</h1><p>Point Crawlspace at an existing folder, then choose what your agents can do there.</p></div><span className="badge badge-green"><FolderGit2 size={14}/>{hosted ? 'Hosted project' : 'Local project'}</span></div>
    {locked && <p className="project-lock-note" role="status">Stop the current run before changing project settings.</p>}
    <form onSubmit={event => void save(event)}><fieldset disabled={disabled} className="project-fields">
      <section className="card project-section"><div className="project-section-heading"><span className="project-section-icon"><FolderGit2 size={21}/></span><div><h2>Project folder</h2><p>This location is shared by every agent in the workflow.</p></div></div>
        <label className="field"><span>Project folder path</span><input aria-label="Project folder path" required value={draft.path} maxLength={4000} spellCheck={false} placeholder={hosted ? `${state.workspace?.projectsRoot ?? ''}/your-app` : 'C:\\git\\your-app'} onChange={event => update({ path: event.target.value })}/><small>{hosted ? <>Your host provides projects inside <code>{state.workspace?.projectsRoot}</code>.</> : 'Enter the full path to a folder on the machine running Crawlspace. Your project stays in its current location.'}</small></label>
        <div className="project-folder-actions"><button type="button" className="btn btn-secondary" onClick={() => void validate()}>{busy === 'validate' ? <LoaderCircle size={15} className="spin"/> : <CheckCircle2 size={15}/>}Validate folder</button>{!state.project && state.workflow.settings.projectPath && <p>Your current workflow folder is shown above. Save to make it the shared project.</p>}</div>
        <label className="field"><span>UI preview URL</span><input aria-label="UI preview URL" type="url" value={draft.previewUrl} maxLength={2000} spellCheck={false} placeholder="http://localhost:5173" onChange={event => update({ previewUrl: event.target.value })}/><small>Optional for text reviews. Start your app separately and use its local address when an agent captures screenshots.</small></label>
      </section>
      <section className="card project-section"><div className="project-section-heading"><span className="project-section-icon"><Code2 size={21}/></span><div><h2>Agent permissions</h2><p>Enable capabilities here, then choose which agents may use them.</p></div></div>
        {hosted && <p className="project-host-note">Hosted workspaces support project review. File editing and test execution are available in your local copy.</p>}
        <label className="checkbox-field project-permission"><input type="checkbox" checked={draft.allowEdits} disabled={hosted} onChange={event => update({ allowEdits: event.target.checked })}/><span>Allow agents to edit project files<small>Agents write changes directly to this folder. Gates decide when the workflow continues.</small></span></label>
        <label className="checkbox-field project-permission"><input type="checkbox" checked={draft.allowTests} disabled={hosted} onChange={event => update({ allowTests: event.target.checked })}/><span>Allow agents to run configured tests<small>Only enable tests for projects and commands you trust. They run on this computer.</small></span></label>
        <p className="project-capacity-note">When agents edit files or run tests, the workflow runs one agent at a time to keep shared files consistent. Review-only workflows keep their parallel capacity.</p>
      </section>
      <section className="card project-section"><div className="project-section-heading project-commands-heading"><span className="project-section-icon"><ListChecks size={21}/></span><div><h2>Test commands</h2><p>Give each command a clear name. Commands run from the project folder.</p></div><button type="button" className="btn btn-secondary btn-small" disabled={hosted || draft.testCommands.length >= 20} onClick={() => update({ testCommands: [...draft.testCommands, { id: crypto.randomUUID(), name: '', command: '', timeoutSeconds: 600 }] })}><Plus size={14}/>Add test command</button></div>
        {!draft.testCommands.length ? <p className="project-empty-commands">No test commands configured. Add your project's test command, such as npm test.</p> : <div className="project-commands">{draft.testCommands.map((command, index) => <article className="project-command" key={command.id}><div className="project-command-heading"><strong>Command {index + 1}</strong><button type="button" className="btn-icon danger-text" aria-label={`Remove test command ${index + 1}`} onClick={() => update({ testCommands: draft.testCommands.filter(item => item.id !== command.id) })}><Trash2 size={16}/></button></div><div className="form-grid"><label className="field"><span>Test name</span><input aria-label="Test name" required maxLength={100} value={command.name} placeholder="Unit tests" onChange={event => update({ testCommands: draft.testCommands.map(item => item.id === command.id ? { ...item, name: event.target.value } : item) })}/></label><label className="field"><span>Timeout (seconds)</span><input aria-label="Timeout (seconds)" type="number" required min={1} max={600} step={1} value={command.timeoutSeconds} onChange={event => update({ testCommands: draft.testCommands.map(item => item.id === command.id ? { ...item, timeoutSeconds: Number(event.target.value) } : item) })}/></label><label className="field full-width"><span>Command</span><input aria-label="Command" required maxLength={2000} value={command.command} spellCheck={false} placeholder="npm test" onChange={event => update({ testCommands: draft.testCommands.map(item => item.id === command.id ? { ...item, command: event.target.value } : item) })}/><small>Runs exactly this command. Prepare the project's dependencies before starting an agent run.</small></label></div></article>)}</div>}
      </section>
      <div className="project-save-bar"><span>{dirty ? 'You have unsaved project changes.' : state.project ? 'Project settings are saved.' : 'Save your project to get started.'}</span><button type="submit" className="btn btn-primary">{busy === 'save' ? <LoaderCircle size={15} className="spin"/> : <Save size={15}/>}Save project</button></div>
    </fieldset></form>{error && <p className="form-error project-feedback" role="alert">{error}</p>}{notice && <p className="project-feedback project-success" role="status"><CheckCircle2 size={16}/>{notice}</p>}
  </section>;
}
