import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { link, lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectChange, ProjectSettings, TestExecution } from '../shared/types';
import { isExcludedProjectPath, ProjectReader } from './project';

const maxFileBytes = 512 * 1024;
const maxOutputBytes = 16_000;
const maxCapturedBytes = 64_000;
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const abort = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException('Run stopped.', 'AbortError'); };
const samePath = (left: string, right: string) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

function sourceText(buffer: Buffer): string {
  if (buffer.length > maxFileBytes) throw new Error('File exceeds the 512 KiB agent edit limit.');
  if (buffer.includes(0)) throw new Error('Binary files cannot be edited as source text.');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); }
  catch { throw new Error('Only valid UTF-8 source files can be edited.'); }
}

function sourceBuffer(content: string): Buffer {
  if (typeof content !== 'string') throw new Error('Provide UTF-8 text content.');
  const buffer = Buffer.from(content, 'utf8');
  sourceText(buffer);
  if (buffer.toString('utf8') !== content) throw new Error('Text contains invalid Unicode characters.');
  return buffer;
}

function testEnvironment(): NodeJS.ProcessEnv {
  // Test commands execute trusted project code, not an OS sandbox. Do not inherit
  // server credentials or injection settings such as NODE_OPTIONS into that code.
  const allowed = /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMFILES(?:\(X86\))?|COMMONPROGRAMFILES|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|LANG|LC_ALL|LC_CTYPE|TERM|COLORTERM|CI|NO_COLOR|FORCE_COLOR|JAVA_HOME|DOTNET_ROOT|RUSTUP_HOME|CARGO_HOME|PNPM_HOME)$/i;
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => allowed.test(key) && value !== undefined));
}

function outputRedactor(): (value: string) => string {
  const values = Object.entries(process.env)
    .filter(([key, value]) => /secret|token|password|passwd|api[_-]?key|private[_-]?key|credential|authorization|cookie|session|registration/i.test(key) && (value?.length ?? 0) >= 4)
    .map(([, value]) => value!).sort((left, right) => right.length - left.length);
  return value => {
    for (const secret of values) {
      value = value.split(secret).join('[REDACTED]');
      // A capture boundary must not expose a prefix of a secret value.
      const start = value.lastIndexOf(secret.slice(0, 4));
      if (start >= 0 && secret.startsWith(value.slice(start))) value = `${value.slice(0, start)}[REDACTED]`;
    }
    const buffer = Buffer.from(value, 'utf8');
    if (buffer.length <= maxOutputBytes) return value;
    const marker = '\n[Output truncated.]';
    return new TextDecoder().decode(buffer.subarray(0, maxOutputBytes - Buffer.byteLength(marker) - 3)) + marker;
  };
}

async function terminateTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!Number.isSafeInteger(pid) || !pid || pid < 1) return;
  if (process.platform === 'win32') {
    await new Promise<void>(resolve => {
      const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => { killer.kill(); child.kill('SIGKILL'); resolve(); }, 5000);
      const done = () => { clearTimeout(timer); resolve(); };
      killer.once('close', done);
      killer.once('error', () => { child.kill('SIGKILL'); done(); });
    });
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}

/** File writes are confined to the project. Configured test commands are trusted
 * user code with the operating-system permissions of the Crawlspace service. */
export class ProjectTools {
  private changeLog: ProjectChange[] = [];
  private testLog: TestExecution[] = [];
  private testCalls = 0;
  private busy = false;
  private constructor(private project: ProjectReader, private settings: ProjectSettings, private onActivity?: (activity: { change?: ProjectChange; test?: TestExecution }) => Promise<void>) {}

  static async open(project: ProjectReader, settings: ProjectSettings, onActivity?: (activity: { change?: ProjectChange; test?: TestExecution }) => Promise<void>): Promise<ProjectTools> {
    if (!settings.path || !samePath(await realpath(path.resolve(settings.path)), project.root)) throw new Error('Project tools must use the selected project folder.');
    const commands = settings.testCommands.map(command => ({ ...command }));
    if (commands.some(command => !command.id || !command.name || !command.command.trim() || command.command.length > 10_000 || !Number.isFinite(command.timeoutSeconds) || command.timeoutSeconds < 1 || command.timeoutSeconds > 600)) throw new Error('Test commands need a name, command, and timeout of 1–600 seconds.');
    if (new Set(commands.map(command => command.id)).size !== commands.length) throw new Error('Test command IDs must be unique.');
    return new ProjectTools(project, { ...settings, testCommands: commands }, onActivity);
  }

  get changes(): ProjectChange[] { return this.changeLog.map(change => ({ ...change })); }
  get tests(): TestExecution[] { return this.testLog.map(result => ({ ...result })); }

  private async target(input: string, exists: boolean): Promise<string> {
    if (typeof input !== 'string' || !input || input.length > 4000 || path.isAbsolute(input) || path.win32.isAbsolute(input) || input.includes(':') || /[\x00-\x1f]/.test(input)) throw new Error('Provide a project-relative file path.');
    const parts = input.split(/[\\/]/);
    if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Use a plain project-relative file path without traversal or device names.');
    if (isExcludedProjectPath(input)) throw new Error('Generated folders, credentials, and secret files are excluded from agent access.');
    let current = this.project.root;
    const rootInfo = await lstat(current);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('The project folder changed or is a link.');
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      const final = index === parts.length - 1;
      let info;
      try { info = await lstat(current); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && final && !exists) return current;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !final) throw new Error('The parent folder must already exist. Create files inside an existing project folder.');
        throw error;
      }
      if (info.isSymbolicLink()) throw new Error('Editing through symbolic links or junctions is blocked.');
      if (!samePath(await realpath(current), current)) throw new Error('The project path changed or resolves through a link.');
      if (!final && !info.isDirectory()) throw new Error('The parent path must be a directory.');
      if (final) {
        if (!exists) throw new Error('The file already exists. Read it and use edit_file to change existing files.');
        if (!info.isFile() || info.nlink > 1) throw new Error('Only regular files with no hard links can be edited.');
        if (info.size > maxFileBytes) throw new Error('File exceeds the 512 KiB agent edit limit.');
      }
    }
    return current;
  }

  private async recordChange(candidate: string, action: ProjectChange['action']): Promise<void> {
    const relative = path.relative(this.project.root, candidate).replaceAll('\\', '/');
    const existing = this.changeLog.find(change => change.path === relative);
    if (!existing) this.changeLog.push({ path: relative, action });
    this.changeLog = this.changeLog.slice(-100);
    this.testLog = [];
    await this.onActivity?.({ change: { path: relative, action } });
  }

  private summary(candidate: string, action: string, before: Buffer | undefined, after: Buffer): string {
    return `${action} ${path.relative(this.project.root, candidate).replaceAll('\\', '/')}\nBefore: ${before ? `${hash(before)} · ${before.length} bytes · ${sourceText(before).split('\n').length} lines` : 'new file'}\nAfter: ${hash(after)} · ${after.length} bytes · ${sourceText(after).split('\n').length} lines`;
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('Another project edit or test is running. Wait for it to finish before the next operation.');
    this.busy = true;
    try { return await operation(); } finally { this.busy = false; }
  }

  async edit(input: string, oldText: string, newText: string, signal?: AbortSignal): Promise<string> {
    return this.exclusive(() => this.editFile(input, oldText, newText, signal));
  }

  private async editFile(input: string, oldText: string, newText: string, signal?: AbortSignal): Promise<string> {
    if (!this.settings.allowEdits) throw new Error('Code editing is disabled in project settings.');
    abort(signal);
    if (typeof oldText !== 'string' || !oldText) throw new Error('oldText must be a non-empty exact match from an observed file.');
    sourceBuffer(oldText); sourceBuffer(newText);
    const candidate = await this.target(input, true);
    const canonical = await this.project.resolve(input);
    if (!this.project.hasObserved(canonical)) throw new Error('Read the file before editing it.');
    const original = await readFile(candidate);
    const content = sourceText(original);
    if (this.project.observedHash(canonical) !== hash(original)) throw new Error('The file changed since it was read. Read it again before editing.');
    const start = content.indexOf(oldText);
    if (start < 0 || content.indexOf(oldText, start + 1) >= 0) throw new Error('oldText must match exactly once. Read the file and provide a unique exact match.');
    const updated = sourceBuffer(content.slice(0, start) + newText + content.slice(start + oldText.length));
    const beforeInfo = await lstat(candidate);
    const temporary = path.join(path.dirname(candidate), `.${path.basename(candidate)}.crawlspace-${randomUUID()}.tmp`);
    let created = false;
    try {
      const handle = await open(temporary, 'wx', beforeInfo.mode & 0o777);
      created = true;
      try { await handle.writeFile(updated); await handle.sync(); } finally { await handle.close(); }
      await this.target(input, true);
      const currentInfo = await lstat(candidate);
      if (currentInfo.dev !== beforeInfo.dev || currentInfo.ino !== beforeInfo.ino || hash(await readFile(candidate)) !== hash(original)) throw new Error('The file changed during editing. Read it again before editing.');
      abort(signal);
      await rename(temporary, candidate);
      created = false;
      await this.recordChange(candidate, 'edited');
      return this.summary(candidate, 'Edited', original, updated);
    } finally { if (created) await unlink(temporary).catch(() => {}); }
  }

  async write(input: string, content: string, signal?: AbortSignal): Promise<string> {
    return this.exclusive(() => this.writeFile(input, content, signal));
  }

  private async writeFile(input: string, content: string, signal?: AbortSignal): Promise<string> {
    if (!this.settings.allowEdits) throw new Error('Code editing is disabled in project settings.');
    abort(signal);
    const buffer = sourceBuffer(content);
    const candidate = await this.target(input, false);
    const temporary = path.join(path.dirname(candidate), `.${path.basename(candidate)}.crawlspace-${randomUUID()}.tmp`);
    let created = false;
    try {
      const handle = await open(temporary, 'wx');
      created = true;
      try { await handle.writeFile(buffer); await handle.sync(); } finally { await handle.close(); }
      await this.target(input, false);
      abort(signal);
      // Linking a complete temporary file commits atomically without replacing
      // a destination created by somebody else while the write was in flight.
      await link(temporary, candidate);
      await unlink(temporary).catch(() => {});
      created = false;
      await this.recordChange(candidate, 'created');
      return this.summary(candidate, 'Created', undefined, buffer);
    } finally { if (created) await unlink(temporary).catch(() => {}); }
  }

  async runTests(commandId: string, signal: AbortSignal): Promise<TestExecution> {
    return this.exclusive(() => this.runConfiguredTests(commandId, signal));
  }

  private async runConfiguredTests(commandId: string, signal: AbortSignal): Promise<TestExecution> {
    if (!this.settings.allowTests) throw new Error('Test execution is disabled in project settings.');
    abort(signal);
    const command = this.settings.testCommands.find(candidate => candidate.id === commandId);
    if (!command) throw new Error('Choose a configured test command ID. Agents cannot supply shell commands.');
    if (this.testCalls >= 20) throw new Error('The 20-test-command limit for this agent visit has been reached.');
    await this.targetRoot();
    abort(signal);
    this.testCalls++;
    const started = Date.now();
    const redact = outputRedactor();
    const chunks: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    let cancelled = false;
    let spawnError = '';
    return await new Promise<TestExecution>((resolve, reject) => {
      const child = spawn(command.command, { cwd: this.project.root, env: testEnvironment(), shell: true, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      let termination: Promise<void> | undefined;
      const stop = () => {
        termination ??= terminateTree(child).finally(() => { child.stdout?.destroy(); child.stderr?.destroy(); });
      };
      const onAbort = () => { cancelled = true; stop(); };
      const timer = setTimeout(() => { timedOut = true; stop(); }, command.timeoutSeconds * 1000);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      const capture = (chunk: Buffer) => {
        if (bytes >= maxCapturedBytes) return;
        const included = chunk.subarray(0, maxCapturedBytes - bytes);
        chunks.push(included); bytes += included.length;
      };
      child.stdout?.on('data', capture);
      child.stderr?.on('data', capture);
      child.once('error', error => { spawnError = error.message; });
      child.once('close', async exitCode => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        try {
          await termination;
          const text = Buffer.concat(chunks).toString('utf8') + (spawnError ? `\n${spawnError}` : '');
          const output = redact(redact(text) + (bytes >= maxCapturedBytes ? '\n[Capture truncated.]' : ''));
          const result: TestExecution = { commandId: command.id, name: command.name, exitCode, passed: exitCode === 0 && !timedOut && !cancelled && !spawnError, timedOut, durationMs: Date.now() - started, output };
          this.testLog = this.testLog.filter(previous => previous.commandId !== result.commandId);
          this.testLog.push(result);
          this.testLog = this.testLog.slice(-20);
          await this.onActivity?.({ test: { ...result } });
          if (cancelled) reject(new DOMException('Run stopped. Test process tree terminated.', 'AbortError'));
          else resolve({ ...result });
        } catch (error) { reject(error); }
      });
    });
  }

  private async targetRoot(): Promise<void> {
    const info = await lstat(this.project.root);
    if (info.isSymbolicLink() || !info.isDirectory() || !samePath(await realpath(this.project.root), this.project.root)) throw new Error('The project folder changed or is a link.');
  }
}
