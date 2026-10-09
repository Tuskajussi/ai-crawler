import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { aborted } from './engine';

const ignoredDirectories = new Set(['.git', '.crawlspace', 'node_modules', '.next', '.venv', 'venv', 'dist', 'build', 'coverage']);
function secretName(name: string): boolean {
  return /^\.env(?:\.|$)/i.test(name) || /\.(?:pem|key|p12|pfx|keystore)$/i.test(name)
    || /^(?:id_rsa|id_ed25519|credentials|secrets?\.json|\.npmrc|\.netrc)$/i.test(name);
}

/** Every lookup resolves symlinks before deciding whether it is within the root. */
export class ProjectReader {
  private observedFiles = new Set<string>();
  private constructor(readonly root: string) {}

  static async open(directory: string): Promise<ProjectReader> {
    if (!directory.trim()) throw new Error('Set a project folder in workflow settings before starting a Pi run.');
    let root: string;
    try { root = await realpath(path.resolve(directory)); } catch { throw new Error('The selected project folder does not exist or cannot be read.'); }
    if (!(await stat(root)).isDirectory()) throw new Error('Project path must point to a folder.');
    return new ProjectReader(root);
  }

  async resolve(input: string, directory = false): Promise<string> {
    if (typeof input !== 'string' || input.length > 4000) throw new Error('Provide a project-relative path.');
    const candidate = await realpath(path.resolve(this.root, input || '.'));
    const relative = path.relative(this.root, candidate);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Access outside the selected project folder is blocked.');
    const parts = relative.split(path.sep);
    if (parts.some(part => ignoredDirectories.has(part.toLowerCase()) || secretName(part))) throw new Error('Generated folders, credentials, and secret files are excluded from agent access.');
    const info = await stat(candidate);
    if (directory ? !info.isDirectory() : !info.isFile()) throw new Error(directory ? 'Path must point to a directory.' : 'Path must point to a file.');
    return candidate;
  }

  async read(input: string, offset = 1, limit = 300, signal?: AbortSignal): Promise<string> {
    if (signal) aborted(signal);
    const candidate = await this.resolve(input);
    if ((await stat(candidate)).size > 512 * 1024) throw new Error('File exceeds the 512 KiB agent read limit.');
    const buffer = await readFile(candidate);
    if (buffer.includes(0)) throw new Error('Binary files cannot be read as source text.');
    this.observedFiles.add(candidate);
    if (!Number.isInteger(offset) || offset < 1 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Offset starts at 1 and limit must be 1–500 lines.');
    const lines = buffer.toString('utf8').split('\n');
    return lines.slice(offset - 1, offset - 1 + limit).map((line, index) => `${offset + index}: ${line}`).join('\n').slice(0, 40_000)
      + `\n[${path.relative(this.root, candidate).replaceAll('\\', '/')} · ${lines.length} lines total]`;
  }

  hasObserved(resolvedPath: string): boolean { return this.observedFiles.has(resolvedPath); }

  async lineCount(input: string): Promise<number> {
    const candidate = await this.resolve(input);
    if ((await stat(candidate)).size > 512 * 1024) throw new Error('Finding refers to a file beyond the agent read limit.');
    return (await readFile(candidate, 'utf8')).split('\n').length;
  }

  async list(input = '.', signal?: AbortSignal): Promise<string> {
    if (signal) aborted(signal);
    const directory = await this.resolve(input, true);
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter(entry => !entry.isSymbolicLink() && !ignoredDirectories.has(entry.name.toLowerCase()) && !secretName(entry.name))
      .slice(0, 500).map(entry => `${entry.isDirectory() ? '[dir] ' : ''}${entry.name}`).join('\n');
  }

  async files(signal?: AbortSignal): Promise<string[]> {
    const files: string[] = [];
    const queue = [this.root];
    let visited = 0;
    while (queue.length && visited < 5000 && files.length < 5000) {
      if (signal) aborted(signal);
      const directory = queue.shift()!;
      // Re-check actual paths as well as skipping directory-entry symlinks.
      await this.resolve(path.relative(this.root, directory), true);
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (++visited > 5000) break;
        if (entry.isSymbolicLink() || ignoredDirectories.has(entry.name.toLowerCase()) || secretName(entry.name)) continue;
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) queue.push(candidate);
        else if (entry.isFile()) files.push(path.relative(this.root, candidate).replaceAll('\\', '/'));
      }
    }
    return files;
  }

  async find(pattern: string, signal?: AbortSignal): Promise<string> {
    if (!pattern || pattern.length > 300) throw new Error('Use a filename substring of 1–300 characters.');
    const files = await this.files(signal);
    const results = files.filter(file => file.toLowerCase().includes(pattern.toLowerCase())).slice(0, 200);
    return `${results.join('\n') || 'No matching files.'}\n[Search capped at 5,000 entries and 200 results.]`;
  }

  async grep(query: string, signal?: AbortSignal): Promise<string> {
    if (!query || query.length > 300) throw new Error('Use a literal search string of 1–300 characters.');
    const files = await this.files(signal);
    const matches: string[] = [];
    for (const file of files) {
      if (signal) aborted(signal);
      try {
        const candidate = await this.resolve(file);
        if ((await stat(candidate)).size > 512 * 1024) continue;
        const buffer = await readFile(candidate);
        if (buffer.includes(0)) continue;
        const lines = buffer.toString('utf8').split('\n');
        const countBefore = matches.length;
        for (let index = 0; index < lines.length; index++) {
          if (lines[index].includes(query)) matches.push(`${file}:${index + 1}: ${lines[index].slice(0, 300)}`);
          if (matches.length >= 100) break;
        }
        if (matches.length > countBefore) this.observedFiles.add(candidate);
      } catch (error) {
        if (signal?.aborted) throw error;
        // Ignore files removed or made inaccessible during a crawl.
      }
      if (matches.length >= 100) break;
    }
    return `${matches.join('\n') || 'No matches.'}\n[Literal search capped at 5,000 entries and 100 matches; generated/secret/binary/large files skipped.]`;
  }
}
