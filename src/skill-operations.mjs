import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, lstat, readdir, readlink, realpath, mkdtemp, rm, access } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ShelfError } from './domain.mjs';

export const SKILLS_CLI_VERSION = '1.5.23';
const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const SOURCE_PATTERN = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i;
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,159}$/i;
const MAX_OUTPUT = 2 * 1024 * 1024;
const SCAN_FRESH_MS = 30 * 60 * 1000;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message, status = 400) => { throw new ShelfError(status, message); };
const digest = value => createHash('sha256').update(value).digest('hex');
const stripAnsi = value => value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
const inside = (parent, child) => { const part = relative(parent, child); return part === '' || (part !== '..' && !part.startsWith('../') && !part.startsWith('..\\') && !isAbsolute(part)); };

export async function resolveSkillsCliPath() {
  const bundled = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'skills', 'bin', 'cli.mjs');
  let bundledExists = false;
  try { await access(bundled); bundledExists = true; } catch {}
  if (bundledExists) {
    const manifest = JSON.parse(await readFile(join(dirname(bundled), '..', 'package.json'), 'utf8'));
    if (manifest.version !== SKILLS_CLI_VERSION) fail('The Skills installer version does not match this plugin.', 503);
    return bundled;
  }
  let manifestPath;
  try { manifestPath = require.resolve('skills/package.json'); } catch { fail('The Skills installer is missing. Rebuild or reinstall the plugin.', 503); }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.version !== SKILLS_CLI_VERSION) fail('The Skills installer version does not match this plugin.', 503);
  return join(dirname(manifestPath), 'bin', 'cli.mjs');
}

export async function runSkillsCli(args, cwd, { homeDir, timeoutMs = 120_000, cliPath, environment = process.env, signal } = {}) {
  if (signal?.aborted) return { code: null, stdout: '', stderr: '', timedOut: false, cancelled: true };
  const executable = cliPath ?? await resolveSkillsCliPath();
  return new Promise(accept => {
    let stdout = '', stderr = '', bytes = 0, settled = false, stopped;
    let timeout, forceKill;
    const child = spawn(process.execPath, [executable, ...args], {
      cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...environment, ...(homeDir ? { HOME: homeDir, USERPROFILE: homeDir } : {}), NODE_DISABLE_COMPILE_CACHE: '1', ELECTRON_RUN_AS_NODE: '1', FORCE_COLOR: '0', NO_COLOR: '1', DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', GIT_TERMINAL_PROMPT: '0' },
    });
    const terminate = signal => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch {}
    };
    const onAbort = () => stop('cancelled');
    const finish = value => { if (settled) return; settled = true; clearTimeout(timeout); clearTimeout(forceKill); signal?.removeEventListener('abort', onAbort); accept(value); };
    const stop = reason => {
      if (stopped) return;
      stopped = reason;
      terminate('SIGTERM');
      forceKill = setTimeout(() => { terminate('SIGKILL'); finish({ code: null, stdout, stderr, timedOut: reason === 'timeout', outputExceeded: reason === 'output', cancelled: reason === 'cancelled' }); }, 1500);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    timeout = setTimeout(() => stop('timeout'), timeoutMs);
    const collect = channel => chunk => {
      if (stopped) return;
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) { stop('output'); return; }
      if (channel === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
    };
    child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
    child.once('error', () => finish({ code: null, stdout, stderr: 'The Skills installer could not be started.', timedOut: false }));
    child.once('close', code => {
      // Keep the force-kill timer alive after a stopped parent exits: its Git
      // subprocesses may still own this process group and must not keep writing.
      if (!stopped) finish({ code, stdout, stderr, timedOut: false, outputExceeded: false });
    });
  });
}

async function readLock(location) {
  try {
    const bytes = await readFile(location);
    const parsed = JSON.parse(bytes.toString('utf8'));
    return { skills: record(parsed?.skills) ? parsed.skills : {}, fingerprint: digest(bytes), location };
  } catch (error) {
    if (error.code === 'ENOENT') return { skills: {}, fingerprint: 'missing', location };
    if (error instanceof SyntaxError) return { skills: {}, fingerprint: 'invalid', location };
    throw error;
  }
}

function githubSource(entry) {
  if (typeof entry.source === 'string' && SOURCE_PATTERN.test(entry.source)) return entry.source;
  return typeof entry.sourceUrl === 'string' ? entry.sourceUrl.match(/^https:\/\/github\.com\/([a-z0-9_.-]+\/[a-z0-9_.-]+?)(?:\.git)?$/i)?.[1] ?? null : null;
}

function validSkillPath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[#@%\u0000-\u001f\u007f]/.test(value)) return false;
  const normalized = value.replaceAll('\\', '/');
  return !posix.isAbsolute(normalized) && !normalized.split('/').some(part => ['..', ''].includes(part)) && posix.basename(normalized) === 'SKILL.md';
}

function folderPath(value) { const folder = posix.dirname(value.replaceAll('\\', '/')); return folder === '.' ? '' : folder; }
function unavailable(reason, checkedAt) { return { checkedAt, reason, status: 'unavailable' }; }

export function checkTrackedSkill(entry, result, checkedAt) {
  if (result.status === 'unavailable') return unavailable('source-unavailable', checkedAt);
  if (result.status !== 'available' || !Array.isArray(result.tree)) return unavailable('network-error', checkedAt);
  const folder = folderPath(entry.skillPath);
  const hash = folder ? result.tree.find(item => item.type === 'tree' && item.path === folder)?.sha : result.rootSha;
  if (!hash) return result.truncated ? unavailable('network-error', checkedAt) : { checkedAt, reason: 'remote-missing', status: 'missing' };
  return hash.toLowerCase() === entry.skillFolderHash.toLowerCase()
    ? { checkedAt, reason: 'up-to-date', status: 'current' }
    : { checkedAt, reason: 'remote-changed', status: 'update-available' };
}

export async function fetchGitHubTreeWithGit(source, ref, { signal } = {}) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'skill-shelf-update-'));
  try {
    const args = ['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', '--quiet'];
    if (ref !== 'HEAD') args.push('--branch', ref);
    args.push(`https://github.com/${source}.git`, temporaryDirectory);
    const run = args => execFileAsync('git', args, { timeout: 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, signal, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    await run(args);
    const [root, directories] = await Promise.all([run(['-C', temporaryDirectory, 'rev-parse', 'HEAD^{tree}']), run(['-C', temporaryDirectory, 'ls-tree', '-r', '-d', 'HEAD'])]);
    return { status: 'available', rootSha: root.stdout.trim().toLowerCase(), tree: directories.stdout.split('\n').flatMap(line => {
      const match = line.match(/^\d+\s+tree\s+([0-9a-f]{40})\t(.+)$/i);
      return match ? [{ path: match[2], sha: match[1].toLowerCase(), type: 'tree' }] : [];
    }), truncated: false };
  } catch { return { status: 'error' }; }
  finally { await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {}); }
}

async function directoryFingerprint(location) {
  const canonical = await realpath(location);
  if (canonical !== location) fail('The Skill directory changed. Scan for updates again.', 409);
  const hash = createHash('sha256');
  let count = 0, bytes = 0;
  const visit = async (directory, depth) => {
    if (depth > 32) fail('The Skill directory is too deep to validate safely.', 409);
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git') continue;
      if (++count > 10000) fail('The Skill contains too many files to validate safely.', 409);
      const file = join(directory, entry.name), info = await lstat(file);
      hash.update(JSON.stringify([relative(location, file), info.dev, info.ino, info.mode, info.size, info.mtimeMs]));
      if (info.isSymbolicLink()) hash.update(await readlink(file));
      else if (info.isDirectory()) await visit(file, depth + 1);
      else if (info.isFile()) { bytes += info.size; if (bytes > 64 * 1024 * 1024) fail('The Skill is too large to validate safely.', 409); hash.update(await readFile(file)); }
      else fail('The Skill contains an unsupported file.', 409);
    }
  };
  const root = await lstat(location);
  if (!root.isDirectory() || root.isSymbolicLink()) fail('The Skill directory changed. Scan for updates again.', 409);
  hash.update(JSON.stringify([location, root.dev, root.ino, root.mode, root.birthtimeMs]));
  await visit(location, 0);
  return hash.digest('hex');
}

function operationResult(result, name, successMessage) {
  const outputLines = stripAnsi(`${result.stdout ?? ''}\n${result.stderr ?? ''}`).split('\n').map(line => line.trim()).filter(Boolean).slice(-24);
  const success = result.code === 0 && !result.timedOut && !result.outputExceeded && !result.cancelled && !/Failed to install \d+|Installation failed/i.test(outputLines.join('\n'));
  const message = success ? successMessage : result.cancelled ? 'The Skills operation was cancelled.' : result.timedOut ? 'The Skills command timed out. Scan again before retrying.' : result.outputExceeded ? 'The Skills command produced too much output.' : 'The Skill could not be updated. Scan again before retrying.';
  return { ...(name ? { name } : {}), success, message, outputLines };
}

export class SkillOperations {
  constructor({ service, runner = runSkillsCli, fetcher = fetch, gitTreeFetcher = fetchGitHubTreeWithGit, now = () => new Date(), environment = process.env }) {
    if (!service) throw new Error('A Shelf service is required.');
    Object.assign(this, { service, runner, fetcher, gitTreeFetcher, now, environment });
    this.checks = new Map(); this.tracked = new Map(); this.scanId = null; this.scannedAt = null;
    this.scanning = false; this.updating = false; this.completed = 0; this.total = 0;
    this.controller = new AbortController();
  }

  status() {
    const summary = { current: 0, missing: 0, unavailable: 0, unchecked: 0, 'update-available': 0 };
    for (const check of this.checks.values()) summary[check.status] += 1;
    return { scanId: this.scanId, scannedAt: this.scannedAt, scanning: this.scanning, updating: this.updating, completed: this.completed, total: this.total, checks: Object.fromEntries(this.checks), summary };
  }

  ensureIdle() { if (this.controller.signal.aborted) fail('The Skills service is shutting down.', 503); if (this.scanning || this.updating) fail('Another Skills operation is already running.', 409); }

  close() { this.controller.abort(); }

  globalLockPath() {
    return this.environment.XDG_STATE_HOME?.trim() ? join(this.environment.XDG_STATE_HOME.trim(), 'skills', '.skill-lock.json') : join(this.service.homeDir, '.agents', '.skill-lock.json');
  }

  async remoteTree(source, ref) {
    let result;
    try {
      const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
      const token = this.environment.GITHUB_TOKEN ?? this.environment.GH_TOKEN;
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await this.fetcher(`https://api.github.com/repos/${source}/git/trees/${encodeURIComponent(ref)}?recursive=1`, { headers, redirect: 'error', signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(12_000)]) });
      if (response.status === 404) result = { status: 'unavailable' };
      else if (!response.ok) result = { status: 'error' };
      else {
        const parsed = await response.json();
        result = record(parsed) && Array.isArray(parsed.tree) ? { status: 'available', rootSha: typeof parsed.sha === 'string' ? parsed.sha : undefined, truncated: parsed.truncated === true, tree: parsed.tree.filter(item => record(item) && typeof item.path === 'string' && typeof item.sha === 'string' && typeof item.type === 'string') } : { status: 'error' };
      }
    } catch { result = { status: 'error' }; }
    if (result.status === 'available' || !this.gitTreeFetcher || this.controller.signal.aborted) return result;
    try { const fallback = await this.gitTreeFetcher(source, ref, { signal: this.controller.signal }); return fallback.status === 'available' ? fallback : result; } catch { return result; }
  }

  async scanUpdates({ onProgress } = {}) {
    this.ensureIdle(); this.scanning = true; this.scanId = null; this.scannedAt = null;
    this.checks = new Map(); this.tracked = new Map(); this.completed = 0;
    try {
      const snapshot = await this.service.snapshot();
      this.total = snapshot.skills.length;
      const checkedAt = this.now().toISOString();
      const globalLock = await readLock(this.globalLockPath());
      const projectLocks = new Map(await Promise.all(snapshot.projects.map(async project => [project.id, await readLock(join(project.path, 'skills-lock.json'))])));
      const groups = new Map();
      const save = (id, check) => { this.checks.set(id, check); this.completed += 1; onProgress?.({ skillId: id, check, completed: this.completed, total: this.total }); };
      for (const skill of snapshot.skills) {
        const lock = skill.scopeId === 'global' ? globalLock : projectLocks.get(skill.scopeId.slice(8));
        const entry = lock?.skills[skill.name];
        if (!record(entry)) { save(skill.id, unavailable('untracked', checkedAt)); continue; }
        if (entry.sourceType === 'local') { save(skill.id, unavailable('local-source', checkedAt)); continue; }
        if (entry.sourceType !== 'github') { save(skill.id, unavailable('unsupported-source', checkedAt)); continue; }
        const source = githubSource(entry);
        const ref = entry.ref ?? 'HEAD';
        if (!source || !validSkillPath(entry.skillPath) || typeof entry.skillFolderHash !== 'string' || !/^[a-f0-9]{40}$/i.test(entry.skillFolderHash) || typeof ref !== 'string' || !ref || ref.length > 256 || /[\u0000-\u001f\u007f]/.test(ref)) { save(skill.id, unavailable('untracked', checkedAt)); continue; }
        const tracked = { skill, entry: { ...entry, source }, lock, fingerprint: null };
        try { tracked.fingerprint = await directoryFingerprint(skill.path); } catch {}
        this.tracked.set(skill.id, tracked);
        const key = `${source}\n${ref}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(tracked);
      }
      const entries = [...groups];
      for (let index = 0; index < entries.length; index += 3) {
        if (this.controller.signal.aborted) fail('The Skills operation was cancelled.', 499);
        await Promise.all(entries.slice(index, index + 3).map(async ([key, skills]) => {
          const [source, ref] = key.split('\n'); const tree = await this.remoteTree(source, ref);
          for (const tracked of skills) save(tracked.skill.id, checkTrackedSkill(tracked.entry, tree, checkedAt));
        }));
      }
      if (this.controller.signal.aborted) fail('The Skills operation was cancelled.', 499);
      this.scanId = randomUUID(); this.scannedAt = checkedAt;
      this.scanning = false;
      return { state: snapshot, updates: this.status() };
    } finally { this.scanning = false; }
  }

  workingDirectory(target, snapshot) {
    if (!record(target)) fail('Invalid update target.');
    if (target.scope === 'global') return this.service.homeDir;
    if (target.scope !== 'project' || typeof target.projectId !== 'string') fail('Invalid update target.');
    const project = snapshot.projects.find(project => project.id === target.projectId);
    if (!project) fail('The project is no longer available.', 404);
    return project.path;
  }

  async update(input) {
    this.ensureIdle();
    if (!record(input) || input.confirmed !== true || !Array.isArray(input.skillIds) || !input.skillIds.length || input.skillIds.length > 1000 || !input.skillIds.every(id => typeof id === 'string') || input.scanId !== this.scanId || !this.scanId || this.now().getTime() - Date.parse(this.scannedAt) >= SCAN_FRESH_MS) fail('Scan for updates and confirm the selected Skills before updating.', 409);
    const ids = [...new Set(input.skillIds)];
    this.updating = true;
    this.completed = 0; this.total = ids.length;
    const results = [];
    try {
      await this.service.read(async () => {
        const snapshot = this.service.makeSnapshot();
        const plans = [];
        for (const id of ids) {
          const tracked = this.tracked.get(id), current = snapshot.skills.find(skill => skill.id === id);
          if (!tracked || !current || this.checks.get(id)?.status !== 'update-available' || !SAFE_NAME.test(current.name)) fail('A selected Skill is not ready to update. Scan again.', 409);
          const lock = await readLock(tracked.lock.location);
          if (JSON.stringify(lock.skills[current.name]) !== JSON.stringify(tracked.lock.skills[current.name])) fail('The installation record changed. Scan for updates again.', 409);
          if (!tracked.fingerprint || current.path !== tracked.skill.path || current.scopeId !== tracked.skill.scopeId || await directoryFingerprint(current.path) !== tracked.fingerprint) fail('The Skill changed after the scan. Scan for updates again.', 409);
          const target = current.scopeId === 'global' ? { scope: 'global' } : { scope: 'project', projectId: current.scopeId.slice(8) };
          const cwd = this.workingDirectory(target, snapshot);
          const canonicalRoot = join(cwd, '.agents', 'skills');
          let canonical;
          try { canonical = await realpath(canonicalRoot); } catch { fail('This Skill is not a tracked shared installation.', 409); }
          if (!inside(canonical, current.path) || dirname(current.path) !== canonical) fail('This Skill is not a tracked shared installation.', 409);
          const installName = current.name.toLowerCase().replace(/[^a-z0-9._]+/g, '-').replace(/^[.\-]+|[.\-]+$/g, '').slice(0, 255) || 'unnamed-skill';
          if (current.path !== join(canonical, installName)) fail('This Skill is not a tracked shared installation.', 409);
          if (current.installations?.some(installation => installation.path !== current.path)) fail('This Skill has independent installation copies. Review them before updating.', 409);
          const folder = folderPath(tracked.entry.skillPath);
          const source = `${tracked.entry.source}${folder ? `/${folder}` : ''}${tracked.entry.ref ? `#${encodeURIComponent(tracked.entry.ref)}` : ''}`;
          // Re-add exactly one tracked Skill. CLI `update --yes` can delete unselected
          // missing Skills from the same repository, so it is deliberately not used.
          const args = ['add', source, '--skill', current.name];
          if (target.scope === 'global') args.push('--global');
          // Existing Agent aliases already point here. Do not recreate guessed
          // Agent destinations; their names or environment roots may differ.
          args.push('--yes', '--agent', 'universal');
          plans.push({ id, name: current.name, cwd, args, tracked });
        }
        for (const plan of plans) {
          let result;
          try {
            const lock = await readLock(plan.tracked.lock.location);
            if (this.controller.signal.aborted) fail('The Skills operation was cancelled.', 499);
            if (JSON.stringify(lock.skills[plan.name]) !== JSON.stringify(plan.tracked.lock.skills[plan.name]) || await directoryFingerprint(plan.tracked.skill.path) !== plan.tracked.fingerprint) fail('The Skill changed after the scan. Scan for updates again.', 409);
            result = operationResult(await this.runner(plan.args, plan.cwd, { homeDir: this.service.homeDir, environment: this.environment, signal: this.controller.signal }), plan.name, 'Skill updated.');
          }
          catch { result = { name: plan.name, success: false, message: 'The Skill could not be updated. Scan again before retrying.', outputLines: [] }; }
          results.push({ id: plan.id, ...result });
          this.completed += 1;
          this.checks.set(plan.id, { status: 'unchecked', reason: 'not-scanned' });
        }
      });
      const state = await this.service.rescan();
      this.scanId = null;
      this.updating = false;
      return { success: results.every(result => result.success), message: results.every(result => result.success) ? 'Selected Skills updated.' : 'Some Skills could not be updated.', results, state, updates: this.status() };
    } finally { this.updating = false; }
  }
}
