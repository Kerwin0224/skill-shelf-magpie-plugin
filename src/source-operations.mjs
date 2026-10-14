import { mkdir, lstat, realpath, readdir, readFile, writeFile, cp, symlink, rm, mkdtemp } from 'node:fs/promises';
import { join, dirname, relative, resolve, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { ShelfError } from './domain.mjs';
import { runSkillsCli } from './skill-operations.mjs';
import { getAgentRegistry, getAgentInstallRegistry, getProjectAgentInstallTargets, getUniversalInstallTarget } from './agent-registry.mjs';

const namePattern = /^[a-z0-9][a-z0-9._-]{0,159}$/i;
const fail = (message, status = 400) => { throw new ShelfError(status, message); };
const exists = async location => { try { return await lstat(location); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
const installName = name => name.toLowerCase().replace(/[^a-z0-9._]+/g, '-').replace(/^[.\-]+|[.\-]+$/g, '').slice(0, 255) || 'unnamed-skill';

export function resolveInstallSource(value) {
  if (typeof value !== 'string' || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) fail('Enter a repository, GitHub URL, skills.sh URL or absolute local directory.');
  let source = value.trim(), skill;
  const command = source.match(/^\$?\s*npx\s+skills(?:@[a-z0-9._-]+)?\s+add\s+(\S+)(?:\s+--skill\s+([a-z0-9][a-z0-9._-]{0,159}))?$/i);
  if (command) { source = command[1]; skill = command[2]; }
  if (isAbsolute(source)) return { source, skill, local: true };
  const short = source.match(/^([a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)(?:@([a-z0-9][a-z0-9._-]{0,159}))?$/i);
  if (short) return { source: short[1], skill: skill ?? short[2], local: false };
  let url;
  try { url = new URL(source); } catch { fail('Only GitHub repositories, skills.sh links and absolute local directories are supported.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search) fail('Enter a public HTTPS GitHub or skills.sh URL.');
  const parts = url.pathname.replace(/\/$/, '').split('/').slice(1);
  if (parts.some(part => !namePattern.test(part))) fail('Invalid repository URL.');
  if (['skills.sh', 'www.skills.sh'].includes(url.hostname) && parts.length === 3 && !url.hash) return { source: `${parts[0]}/${parts[1]}`, skill: skill ?? parts[2], local: false };
  if (url.hostname !== 'github.com' || parts.length < 2 || (parts.length > 2 && !['tree', 'blob'].includes(parts[2]))) fail('Enter a GitHub repository URL.');
  if (url.hash && !/^#[a-z0-9._/-]+$/i.test(url.hash)) fail('Invalid repository ref.');
  return { source: url.href, skill, local: false };
}

async function readDocument(location, fallback) {
  const stat = await exists(location);
  if (!stat) return { document: fallback, bytes: null, stat: null };
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) fail('The installation lock is not a regular file.', 409);
  const bytes = await readFile(location);
  let document;
  try { document = JSON.parse(bytes); } catch { fail('The installation lock is invalid. Repair it before changing installations.', 409); }
  if (!document.skills || typeof document.skills !== 'object' || Array.isArray(document.skills)) fail('The installation lock is invalid.', 409);
  return { document, bytes, stat };
}

async function replaceDocument(service, location, previous, document, transaction) {
  const current = await exists(location);
  if (previous.stat ? !same(previous.stat, current) || hash(await readFile(location)) !== hash(previous.bytes) : current) fail('The installation lock changed. Try again.', 409);
  await service.makeParent(dirname(location), transaction);
  if (current) await service.stageDelete(location, transaction, null, previous.stat);
  await writeFile(location, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const identity = await lstat(location), expected = hash(await readFile(location));
  transaction.rollback.push(async () => {
    if (!same(identity, await exists(location)) || hash(await readFile(location)) !== expected) fail(`Installation lock changed; preserving ${location}.`, 409);
    await rm(location);
  });
}

async function safeParent(service, destination, transaction) {
  let ancestor = dirname(destination);
  while (!await exists(ancestor)) ancestor = dirname(ancestor);
  const info = await lstat(ancestor);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(ancestor) !== resolve(ancestor)) fail('An installation parent is a symbolic link. Choose a real directory.', 409);
  await service.makeParent(dirname(destination), transaction);
  if (await realpath(dirname(destination)) !== resolve(dirname(destination))) fail('An installation parent changed.', 409);
}

async function contentHash(location) {
  const files = [];
  async function collect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { if (!['.git', 'node_modules'].includes(entry.name)) await collect(path); }
      else if (entry.isFile()) files.push({ path, relative: relative(location, path).replaceAll('\\', '/') });
    }
  }
  await collect(location);
  const digest = createHash('sha256');
  for (const file of files.sort((a, b) => a.relative.localeCompare(b.relative))) { digest.update(file.relative); digest.update(await readFile(file.path)); }
  return digest.digest('hex');
}

export class SourceOperations {
  constructor({ service, runner = runSkillsCli, environment = process.env }) {
    Object.assign(this, { service, runner, environment });
    this.controller = new AbortController();
    this.task = null; this.plans = new Map(); this.busy = false;
  }
  close() { this.controller.abort(); }
  status() { return { busy: this.busy, task: this.task }; }
  agents() { return getAgentInstallRegistry(); }
  globalLockPath() { return this.environment.XDG_STATE_HOME?.trim() ? join(this.environment.XDG_STATE_HOME.trim(), 'skills', '.skill-lock.json') : join(this.service.homeDir, '.agents', '.skill-lock.json'); }
  ensureIdle() { if (this.busy) fail('Another installation or removal is running.', 409); if (this.controller.signal.aborted) fail('The installation service is shutting down.', 503); }

  async install(input) {
    this.ensureIdle();
    if (input?.confirmed !== true || !input.target || !Array.isArray(input.agents) || !input.agents.length) fail('Choose an installation target and confirm the installation.');
    const source = resolveInstallSource(input.source);
    const names = input.skillNames?.length ? input.skillNames : (source.skill ? [source.skill] : []);
    if (input.skillNames !== undefined && !Array.isArray(input.skillNames)) fail('Invalid Skill selection.');
    if (!Array.isArray(names) || names.length > 100 || names.some(name => typeof name !== 'string' || !namePattern.test(name))) fail('Invalid Skill selection.');
    const scope = input.target.scope;
    if (!['global', 'project'].includes(scope)) fail('Invalid installation scope.');
    const registry = new Map(this.agents().map(agent => [agent.id, agent]));
    const agentIds = [...new Set(input.agents)];
    if (agentIds.some(id => !registry.get(id)?.scopes.includes(scope))) fail('An Agent does not support this installation scope.');
    const snapshot = await this.service.snapshot();
    const project = snapshot.projects.find(project => project.id === input.target.projectId);
    if (scope === 'project' && !project) fail('Choose a registered project.', 404);
    const base = await realpath(scope === 'global' ? this.service.homeDir : project.path);
    const canonical = join(base, '.agents', 'skills');
    let roots;
    if (scope === 'project') roots = getProjectAgentInstallTargets(agentIds).map(target => join(base, target.directoryPath));
    else {
      const entries = new Map(getAgentRegistry({ homeDir: base, environment: this.environment }).map(agent => [agent.id, agent]));
      const universal = getUniversalInstallTarget(), directReaders = new Set([...universal.agentIds, ...universal.hiddenAgentIds]);
      roots = [canonical, ...agentIds.filter(id => !directReaders.has(id)).map(id => entries.get(id)?.skillDirectories[0])];
      if (roots.some(root => !root)) fail('An Agent installation directory is unavailable.');
    }
    roots = [...new Set(roots)];
    this.ensureIdle();
    this.busy = true;
    this.task = { id: randomUUID(), kind: 'install', status: 'running', source: source.source, startedAt: new Date().toISOString(), message: 'Downloading and validating Skills in an isolated directory.' };
    let temporary;
    try {
      if (source.local && !(await lstat(await realpath(source.source))).isDirectory()) fail('The local source must be a directory.');
      temporary = await mkdtemp(join(tmpdir(), 'skill-shelf-install-'));
      const home = join(temporary, 'home'), cwd = join(temporary, 'project');
      await mkdir(home); await mkdir(cwd);
      // Never run `skills add --yes` against live roots: it replaces existing directories.
      const environment = { PATH: this.environment.PATH, LANG: this.environment.LANG, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.state'), GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', TMPDIR: temporary, GITHUB_TOKEN: this.environment.GITHUB_TOKEN, GH_TOKEN: this.environment.GH_TOKEN };
      const args = ['add', source.source, '--yes', '--agent', 'universal', '--global'];
      args.push('--skill', ...(names.length ? names : ['*']));
      const result = await this.runner(args, cwd, { homeDir: home, environment, signal: this.controller.signal });
      const outputLines = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').split('\n').map(line => line.trim()).filter(Boolean).slice(-30);
      this.task.outputLines = outputLines;
      if (result.code !== 0 || result.timedOut || result.cancelled || result.outputExceeded || /Failed to install \d+|Installation failed/i.test(outputLines.join('\n'))) fail(result.cancelled ? 'Installation cancelled.' : result.timedOut ? 'The download timed out. No live Skills were changed.' : 'The source could not be installed. No live Skills were changed.', 502);
      const stagedRoot = join(home, '.agents', 'skills');
      const staged = [];
      for (const entry of await readdir(stagedRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !namePattern.test(entry.name)) fail('The source contains an unsupported Skill directory.');
        const location = join(stagedRoot, entry.name);
        await this.service.treeFingerprint(location);
        const text = await readFile(join(location, 'SKILL.md'), 'utf8');
        const match = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
        const metadata = match ? parseYaml(match[1], { maxAliasCount: 50 }) : null;
        if (!metadata || typeof metadata.name !== 'string' || !namePattern.test(metadata.name) || installName(metadata.name) !== entry.name) fail('The source contains an invalid Skill name.');
        staged.push({ folder: entry.name, name: metadata.name, location });
      }
      if (!staged.length || staged.length > 100 || names.some(name => !staged.some(skill => skill.name === name))) fail('The requested Skills were not found in the source.');
      if (names.length && staged.some(skill => !names.includes(skill.name))) fail('The installer returned Skills outside the confirmed selection. No live Skills were changed.');
      const stagedLock = await readDocument(join(home, '.state', 'skills', '.skill-lock.json'), { version: 3, skills: {} });
      for (const skill of staged) {
        const entry = stagedLock.document.skills[skill.name];
        if (!source.local && (!entry || entry.sourceType !== 'github' || typeof entry.source !== 'string' || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(entry.source))) fail('The installer did not produce a valid GitHub installation record. No live Skills were changed.', 502);
        const time = new Date().toISOString();
        skill.record = entry ?? { source: await realpath(source.source), sourceType: 'local', installedAt: time, updatedAt: time };
        if (scope === 'project') skill.computedHash = await contentHash(skill.location);
      }
      const lockPath = scope === 'global' ? this.globalLockPath() : join(base, 'skills-lock.json');
      this.task.message = `Installing ${staged.length} Skills without overwriting existing files.`;
      const state = await this.service.mutate(async transaction => {
        if (this.controller.signal.aborted) fail('Installation cancelled.', 499);
        const oldLock = await readDocument(lockPath, { version: scope === 'global' ? 3 : 1, skills: {}, ...(scope === 'global' ? { dismissed: {} } : {}) });
        for (const skill of staged) {
          if (Object.hasOwn(oldLock.document.skills, skill.name)) fail(`The installation record for ${skill.name} already exists. Remove or update it first.`, 409);
          for (const root of roots) {
            await this.service.deploymentParent(join(root, skill.folder));
            if (await exists(join(root, skill.folder))) fail(`${skill.name} already exists at ${root}. Existing files were not overwritten.`, 409);
          }
        }
        await safeParent(this.service, lockPath, transaction);
        for (const skill of staged) {
          const target = join(canonical, skill.folder);
          await safeParent(this.service, target, transaction);
          await mkdir(target, { mode: 0o700 });
          const ownership = await this.service.rememberCreation(target, transaction);
          await cp(skill.location, target, { recursive: true, force: false, errorOnExist: true });
          await this.service.finishCreation(target, ownership);
          for (const root of roots.filter(root => root !== canonical)) {
            const alias = join(root, skill.folder);
            await safeParent(this.service, alias, transaction);
            await symlink(process.platform === 'win32' ? target : relative(dirname(alias), target), alias, process.platform === 'win32' ? 'junction' : 'dir');
            const aliasOwnership = await this.service.rememberCreation(alias, transaction);
            await this.service.finishCreation(alias, aliasOwnership);
          }
          const entry = skill.record;
          oldLock.document.skills[skill.name] = scope === 'global' ? entry : { source: entry.source, sourceType: entry.sourceType, ...(entry.sourceUrl ? { sourceUrl: entry.sourceUrl } : {}), ...(entry.skillPath ? { skillPath: entry.skillPath } : {}), ...(entry.ref ? { ref: entry.ref } : {}), computedHash: skill.computedHash, skillFolderHash: entry.skillFolderHash ?? '' };
        }
        await replaceDocument(this.service, lockPath, oldLock, oldLock.document, transaction);
        await this.service.scan();
      });
      this.task = { ...this.task, status: 'succeeded', message: `${staged.length} Skills installed.`, finishedAt: new Date().toISOString(), installedNames: staged.map(skill => skill.name) };
      return { success: true, message: this.task.message, state, task: this.task };
    } catch (error) { this.task = { ...this.task, status: 'failed', message: error.message, finishedAt: new Date().toISOString() }; throw error; }
    finally { this.busy = false; if (temporary) await rm(temporary, { recursive: true, force: true }); }
  }

  async previewRemoval({ skillId }) {
    this.ensureIdle();
    const snapshot = await this.service.snapshot();
    const skill = snapshot.skills.find(skill => skill.id === skillId);
    if (!skill) fail('The Skill is no longer available.', 404);
    const installations = skill.installations?.length ? skill.installations : [skill];
    const targets = new Set(installations.map(item => item.path));
    const paths = [], fingerprints = [];
    // Catalog paths are realpaths. Detach external links without deleting their sources.
    const roots = snapshot.roots.filter(root => root.scopeId === skill.scopeId && root.exists);
    for (const root of roots) {
      const parent = await realpath(root.path);
      for (const entry of await readdir(parent, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const path = join(parent, entry.name);
        if (paths.includes(path) || !targets.has(await realpath(path).catch(() => null))) continue;
        paths.push(path);
        fingerprints.push({ path, fingerprint: await this.service.treeFingerprint(path), identity: await lstat(path), parent });
      }
    }
    if (!paths.length) fail('The installation paths changed. Refresh the library and try again.', 409);
    const base = skill.scopeId === 'global' ? this.service.homeDir : snapshot.projects.find(project => `project:${project.id}` === skill.scopeId)?.path;
    if (!base) fail('The Skill project is no longer available.', 409);
    const lockPath = skill.scopeId === 'global' ? this.globalLockPath() : join(base, 'skills-lock.json');
    const lock = await readDocument(lockPath, { version: 1, skills: {} });
    this.plans.clear();
    const planId = randomUUID();
    this.plans.set(planId, { skillId, name: skill.name, paths, fingerprints, lockPath, lock, expires: Date.now() + 10 * 60_000 });
    return { planId, name: skill.name, paths, warning: 'This removes the listed local installations and their shared-directory links. Independent Pack copies are not removed.' };
  }

  async remove(input) {
    this.ensureIdle();
    const plan = this.plans.get(input?.planId);
    if (input?.confirmed !== true || !plan || plan.expires <= Date.now()) fail('Preview the removal and confirm it again.', 409);
    this.busy = true;
    this.task = { id: randomUUID(), kind: 'remove', status: 'running', message: `Removing ${plan.name}.`, startedAt: new Date().toISOString() };
    try {
      const state = await this.service.mutate(async transaction => {
        if (!this.service.makeSnapshot().skills.some(skill => skill.id === plan.skillId)) fail('The Skill changed. Preview its removal again.', 409);
        for (const item of plan.fingerprints) {
          if (await realpath(item.parent) !== item.parent || !same(item.identity, await exists(item.path)) || await this.service.treeFingerprint(item.path) !== item.fingerprint) fail('An installation changed. Preview its removal again.', 409);
        }
        for (const item of [...plan.fingerprints].sort((a, b) => Number(b.identity.isSymbolicLink()) - Number(a.identity.isSymbolicLink()))) await this.service.stageDelete(item.path, transaction, item.fingerprint, item.identity);
        if (Object.hasOwn(plan.lock.document.skills, plan.name)) {
          const document = structuredClone(plan.lock.document); delete document.skills[plan.name];
          await safeParent(this.service, plan.lockPath, transaction);
          await replaceDocument(this.service, plan.lockPath, plan.lock, document, transaction);
        }
        await this.service.scan();
      });
      this.plans.delete(input.planId);
      this.task = { ...this.task, status: 'succeeded', message: `${plan.name} removed.`, finishedAt: new Date().toISOString() };
      return { success: true, message: this.task.message, state, task: this.task };
    } catch (error) { this.task = { ...this.task, status: 'failed', message: error.message, finishedAt: new Date().toISOString() }; throw error; }
    finally { this.busy = false; }
  }
}
