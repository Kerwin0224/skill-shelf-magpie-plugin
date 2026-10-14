import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { scanWorkbench, workbenchDirectory } from './workbench.mjs';
import { getAgentRegistry, getAgentInstallRegistry } from './agent-registry.mjs';

const FILE_LIMIT = 4 * 1024 * 1024;
const TOTAL_LIMIT = 16 * 1024 * 1024;
const COUNT_LIMIT = 2000;
const PREVIEW_LIMIT = 96 * 1024;
const EXCLUDED = new Set(['.git', 'node_modules', '.DS_Store']);
const PRESETS = [
  ['Universal', '.agents/skills'], ['Claude Code', '.claude/skills'],
  ['Codex', '.codex/skills'], ['Cursor', '.cursor/skills'],
  ['Gemini CLI', '.gemini/skills'], ['OpenCode', '.config/opencode/skills'],
  ['GitHub Copilot', '.copilot/skills'], ['Windsurf', '.codeium/windsurf/skills'],
  ['Continue', '.continue/skills'], ['Cline', '.cline/skills'],
  ['Goose', '.config/goose/skills'], ['Amp', '.config/amp/skills'],
  ['Pi', '.pi/agent/skills'], ['Roo Code', '.roo/skills'],
];

export class ShelfError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ShelfError';
    this.status = status;
  }
}

const fail = (message, status = 400) => { throw new ShelfError(status, message); };
const now = () => new Date().toISOString();
const hash = (value) => createHash('sha256').update(value).digest('hex');
const stableId = (scope, location) => `skill-${hash(`${scope}\0${location}`).slice(0, 24)}`;
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = (value) => structuredClone(value);
const sameIdentity = (left, right) => left !== null && right !== null && left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;

async function trackedSourceUrls(location) {
  let handle;
  try {
    handle = await fs.open(location, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return {};
    const document = JSON.parse(await handle.readFile('utf8'));
    if (!record(document.skills)) return {};
    return Object.fromEntries(Object.entries(document.skills).flatMap(([name, entry]) => {
      if (!record(entry) || entry.sourceType !== 'github' || typeof entry.source !== 'string' || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(entry.source)) return [];
      let sourceUrl = `https://github.com/${entry.source}`;
      try {
        const url = new URL(entry.sourceUrl);
        if (url.protocol === 'https:' && url.hostname.toLowerCase() === 'github.com' && !url.port && !url.username && !url.password && !url.search && !url.hash) sourceUrl = url.href;
      } catch { /* The tracked repository remains a safe source link. */ }
      return [[name, sourceUrl]];
    }));
  } catch { return {}; }
  finally { await handle?.close(); }
}

function text(value, label, max = 200, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()) || value.includes('\0')) fail(`Invalid ${label}.`);
  return value.trim();
}

function tags(value) {
  if (!Array.isArray(value) || value.length > 100) fail('Tags must be an array of at most 100 strings.');
  return [...new Set(value.map((tag) => text(tag, 'tag', 80)))];
}

function color(value = '#ed6a4a') {
  if (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value)) fail('Folder color must be a six-digit hex color.');
  return value;
}

function position(value) {
  if (!record(value) || Object.keys(value).some((key) => key !== 'x' && key !== 'y') || !['x', 'y'].every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 100000)) fail('Finder position must contain finite x/y coordinates between 0 and 100000.');
  return { x: value.x, y: value.y };
}

function slug(value) {
  // Names from SKILL.md are not trusted as filesystem paths.
  const result = value.normalize('NFKD').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90).toLowerCase();
  return result && result !== '.' && result !== '..' ? result : 'skill';
}

function absolute(value, label = 'path') {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) fail(`${label} must be an absolute filesystem path.`);
  return path.resolve(value);
}

async function lstat(location) {
  try { return await fs.lstat(location); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function canonical(location) {
  // Resolve existing ancestors too, so a missing child of a symlink cannot evade containment checks.
  try { return await fs.realpath(location); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(location);
    if (parent === location) throw error;
    return path.join(await canonical(parent), path.basename(location));
  }
}

function budget() { return { bytes: 0, count: 0 }; }
function charge(counter, size) {
  if (size > FILE_LIMIT) fail('A file exceeds the 4 MiB limit.', 413);
  counter.bytes += size;
  counter.count += 1;
  if (counter.bytes > TOTAL_LIMIT || counter.count > COUNT_LIMIT) fail('Operation exceeds the 16 MiB / 2,000 file limit.', 413);
}

async function filesInTree(root, counter = budget(), excluded = true) {
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('Skill source must be a real directory, not a symlink.');
  const result = [];
  let entriesSeen = 0;
  async function visit(directory, prefix = '', depth = 0) {
    if (depth > 64) fail('Skill directory is too deeply nested.');
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (excluded && EXCLUDED.has(entry.name)) continue;
      if (++entriesSeen > 10000) fail('Skill directory contains too many entries.', 413);
      const local = prefix ? `${prefix}/${entry.name}` : entry.name;
      safeFilePath(local);
      const location = path.join(directory, entry.name);
      const stat = await fs.lstat(location);
      if (stat.isSymbolicLink()) fail(`Nested symlinks are not allowed: ${local}`);
      if (stat.isDirectory()) { await visit(location, local, depth + 1); continue; }
      if (!stat.isFile()) fail(`Unsupported file type: ${local}`);
      charge(counter, stat.size);
      const data = await fs.readFile(location);
      if (data.length !== stat.size || data.length > FILE_LIMIT) fail('A source file changed during the operation.', 409);
      result.push({ path: local, data, executable: Boolean(stat.mode & 0o111) });
    }
  }
  await visit(root);
  return result;
}

function safeFilePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || value.includes('\\') || value.includes('\0') || value.includes(':') || value.startsWith('/')) fail('Invalid portable file path.');
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[\x00-\x1f]/.test(part))) fail('Unsafe portable file path.');
  return value;
}

async function previewRoot(skill) {
  const root = path.resolve(skill.path);
  const stat = await lstat(root);
  if (!stat?.isDirectory() || stat.isSymbolicLink() || await fs.realpath(root) !== root) {
    fail('Skill directory has changed. Rescan the source.', 409);
  }
  return { root, stat };
}

async function previewLocation(root, relative) {
  safeFilePath(relative);
  const parts = relative.split('/');
  if (parts.some(part => EXCLUDED.has(part))) fail('This file is excluded from Skill previews.', 403);
  let location = root;
  for (const part of parts) {
    location = path.join(location, part);
    const stat = await lstat(location);
    if (!stat) fail('Skill file is missing. Refresh the file list.', 404);
    if (stat.isSymbolicLink()) fail('Nested symlinks cannot be previewed.', 403);
  }
  if (!inside(root, await fs.realpath(location))) fail('Skill file is outside its directory.', 403);
  return location;
}

async function readPreview(skill, relative, limit, validateText = true) {
  const { root, stat: rootStat } = await previewRoot(skill);
  const location = await previewLocation(root, relative);
  let handle;
  try {
    handle = await fs.open(location, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile()) fail('Only regular files can be previewed.', 415);
    if (stat.size > limit) fail(`File exceeds the ${limit / 1024} KiB preview limit.`, 413);
    // Bounded reads also protect against a file growing after the size check.
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) fail('File grew beyond the preview limit.', 413);
    const finalLocation = await previewLocation(root, relative);
    if (!sameIdentity(stat, await fs.lstat(finalLocation)) || !sameIdentity(rootStat, await fs.lstat(root)) || await fs.realpath(root) !== root) {
      fail('Skill file changed during the preview. Refresh the file list.', 409);
    }
    const data = buffer.subarray(0, length);
    let value;
    if (validateText) {
      if (data.includes(0)) fail('Binary files cannot be previewed as text.', 415);
      try { value = new TextDecoder('utf-8', { fatal: true }).decode(data); }
      catch { fail('This file is not UTF-8 text and cannot be previewed.', 415); }
      if (/[\x01-\x08\x0b\x0c\x0e-\x1f]/.test(value)) fail('Binary files cannot be previewed as text.', 415);
    } else value = data.toString('utf8');
    return { path: location, text: value };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') fail('Skill file is missing. Refresh the file list.', 404);
    if (error.code === 'ELOOP') fail('Nested symlinks cannot be previewed.', 403);
    throw error;
  } finally { await handle?.close(); }
}

async function writeTree(destination, files, onCreated) {
  await fs.mkdir(destination, { recursive: false, mode: 0o700 });
  await onCreated();
  for (const file of files) {
    const location = path.join(destination, ...file.path.split('/'));
    await fs.mkdir(path.dirname(location), { recursive: true, mode: 0o700 });
    await fs.writeFile(location, file.data, { flag: 'wx', mode: file.executable ? 0o700 : 0o600 });
  }
}

async function fingerprint(location, limits = { file: FILE_LIMIT, total: TOTAL_LIMIT }) {
  const stat = await fs.lstat(location);
  if (stat.isSymbolicLink()) return `link:${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${await fs.readlink(location)}`;
  if (!stat.isDirectory()) fail('Deployment is no longer a directory.', 409);
  const digest = createHash('sha256').update(`root:${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.mode & 0o777}`);
  let count = 0;
  let bytes = 0;
  async function visit(directory, prefix = '', depth = 0) {
    if (depth > 64) fail('Deployment has changed or is too large to verify.', 409);
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++count > 10000) fail('Deployment has changed or is too large to verify.', 409);
      const location = path.join(directory, entry.name);
      const relative = `${prefix}/${entry.name}`;
      const stat = await fs.lstat(location);
      if (stat.isSymbolicLink()) fail('Deployment contains a new symlink; it will not be removed.', 409);
      digest.update(JSON.stringify([relative, stat.mode & 0o777, stat.isDirectory() ? 'directory' : 'file']));
      if (stat.isDirectory()) { await visit(location, relative, depth + 1); continue; }
      bytes += stat.size;
      if (!stat.isFile() || stat.size > limits.file || bytes > limits.total) fail('Deployment has changed or is too large to verify.', 409);
      digest.update(await fs.readFile(location));
    }
  }
  await visit(location);
  return `copy:${digest.digest('hex')}`;
}

function metadata(document, basename) {
  let frontmatter = {};
  const match = document.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (match) {
    const parsed = parseYaml(match[1], { maxAliasCount: 50 });
    if (record(parsed)) frontmatter = parsed;
  }
  const name = typeof frontmatter.name === 'string' && frontmatter.name.trim() ? frontmatter.name.trim().slice(0, 200) : basename;
  const description = typeof frontmatter.description === 'string' ? frontmatter.description.trim().slice(0, 10000) : '';
  return { name, slug: slug(basename), description };
}

function initialState() {
  const date = now();
  return {
    version: 1,
    packs: [{ id: 'default', name: 'Default', description: 'Independent copies of your Skills.', createdAt: date, updatedAt: date }],
    folders: [], organization: {}, finderPositions: {}, customRoots: [], projects: [], managedSkills: [],
  };
}

export class ShelfService {
  constructor({ dataDir, homeDir, magpieDir, workbenchOptions = {} }) {
    this.dataDir = absolute(dataDir, 'dataDir');
    this.homeDir = absolute(homeDir, 'homeDir');
    this.magpieDir = absolute(magpieDir, 'magpieDir');
    this.workbenchOptions = workbenchOptions;
    this.stateFile = path.join(this.dataDir, 'state.json');
    this.skillDir = path.join(this.dataDir, 'skills');
    this.state = initialState();
    this.skills = [];
    this.physicalSkills = [];
    this.roots = [];
    this.scanWarnings = [];
    this.scannedAt = '';
    this.queue = Promise.resolve();
    this.ready = false;
  }

  async initialize() {
    if (this.ready) return this.snapshot();
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      this.dataDir = await fs.realpath(this.dataDir);
      this.stateFile = path.join(this.dataDir, 'state.json');
      this.skillDir = path.join(this.dataDir, 'skills');
      await fs.mkdir(this.skillDir, { recursive: true, mode: 0o700 });
      const storageStat = await fs.lstat(this.skillDir);
      if (storageStat.isSymbolicLink() || !storageStat.isDirectory()) fail('Managed skill storage must be a real directory.', 500);
      try {
        const loaded = JSON.parse(await fs.readFile(this.stateFile, 'utf8'));
        this.validateState(loaded);
        this.state = loaded;
      } catch (error) {
        if (error.code !== 'ENOENT') throw new ShelfError(500, `Cannot load plugin state: ${error.message}`);
        await this.save();
      }
      await this.scan();
      this.ready = true;
      return this.makeSnapshot();
    })();
    try { return await this.initializing; } finally { this.initializing = null; }
  }

  validateState(value) {
    if (!record(value) || value.version !== 1 || !['packs', 'folders', 'customRoots', 'projects', 'managedSkills'].every((key) => Array.isArray(value[key])) || !record(value.organization)) fail('Invalid plugin state.', 500);
    if (!value.packs.some((pack) => pack.id === 'default')) fail('Default Pack is missing from plugin state.', 500);
    for (const skill of value.managedSkills) {
      if (!/^[a-z0-9-]+$/.test(skill.id) || skill.path !== path.join(this.skillDir, skill.id) || !Array.isArray(skill.deployments)) fail('Invalid managed skill storage path.', 500);
    }
    if (!own(value, 'finderPositions')) value.finderPositions = {};
    if (!record(value.finderPositions)) fail('Invalid persisted Finder positions.', 500);
    for (const coordinates of Object.values(value.finderPositions)) position(coordinates);
  }

  async save() {
    const temporary = `${this.stateFile}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(this.state, null, 2)); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, this.stateFile);
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }

  async snapshot() {
    if (!this.ready) return this.initialize();
    await this.queue;
    return this.makeSnapshot();
  }

  makeSnapshot() {
    const installations = new Map();
    const documents = new Map(this.physicalSkills.map((item) => [item.id, item.documentHash]));
    for (const item of this.physicalSkills) {
      if (!item.userManaged) continue;
      const key = `${item.scopeId}\0${item.name}`;
      if (!installations.has(key)) installations.set(key, []);
      installations.get(key).push(item);
    }
    return copy({
      version: 1, skills: this.skills.map((skill) => ({
        ...skill,
        installations: (installations.get(`${skill.scopeId}\0${skill.name}`) ?? []).map(({ documentHash, userManaged, canonicalPriority, ...installation }) => ({
          ...installation,
          isCanonical: installation.id === skill.id,
          documentMatchesCanonical: documentHash === documents.get(skill.id),
          organization: this.state.organization[installation.id] ?? { folderId: null, tags: [] },
          position: this.state.finderPositions[`skill:${installation.id}`] ?? null,
        })),
      })),
      managedSkills: this.state.managedSkills.map((skill) => ({ ...skill, deployments: skill.deployments.map(({ _fingerprint, ...deployment }) => deployment) })),
      packs: this.state.packs, folders: this.state.folders, organization: this.state.organization, finderPositions: this.state.finderPositions,
      roots: this.roots, projects: this.state.projects, scanWarnings: this.scanWarnings,
      scannedAt: this.scannedAt, dataDir: this.dataDir, homeDir: this.homeDir,
      portablePreferences: this.state.portablePreferences ?? {}, rootViewOptions: this.state.rootViewOptions ?? {},
      portableDescriptions: this.state.portableDescriptions ?? {},
    });
  }

  async mutate(action) {
    if (!this.ready) await this.initialize();
    const operation = this.queue.then(async () => {
      const previous = copy(this.state);
      const scanBefore = { skills: this.skills, physicalSkills: this.physicalSkills, roots: this.roots, scanWarnings: this.scanWarnings, scannedAt: this.scannedAt };
      const rollback = [];
      const cleanup = [];
      try {
        await action({ rollback, cleanup });
        this.pruneFinderPositions();
        await this.save();
      } catch (error) {
        this.state = previous;
        Object.assign(this, scanBefore);
        const errors = [];
        for (const undo of rollback.reverse()) { try { await undo(); } catch (failure) { errors.push(failure.message); } }
        if (errors.length) throw new ShelfError(500, `${error.message}; rollback needs attention: ${errors.join('; ')}`);
        if (error instanceof ShelfError) throw error;
        const status = { ENOENT: 404, ENOTDIR: 400, EINVAL: 400, EACCES: 403, EPERM: 403, EEXIST: 409 }[error.code] ?? 500;
        throw new ShelfError(status, error.message);
      }
      for (const finish of cleanup) { try { await finish(); } catch (error) { this.scanWarnings.push(`Cleanup pending: ${error.message}`); } }
      return this.makeSnapshot();
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async read(action) {
    if (!this.ready) await this.initialize();
    const operation = this.queue.then(action);
    this.queue = operation.catch(() => {});
    return operation;
  }

  pruneFinderPositions() {
    const known = new Set([
      ...this.state.folders.map((folder) => `folder:${folder.id}`),
      ...[...this.physicalSkills, ...this.state.managedSkills].map((skill) => `skill:${skill.id}`),
    ]);
    // Path-based source records may become hidden or temporarily unavailable; never migrate them away.
    for (const key of Object.keys(this.state.finderPositions)) if (!known.has(key) && !/^skill:skill-[a-f0-9]{24}$/.test(key)) delete this.state.finderPositions[key];
  }

  async scan() {
    const globalLock = process.env.XDG_STATE_HOME?.trim()
      ? path.join(process.env.XDG_STATE_HOME.trim(), 'skills', '.skill-lock.json')
      : path.join(this.homeDir, '.agents', '.skill-lock.json');
    const sourceUrls = new Map([['global', await trackedSourceUrls(globalLock)], ...await Promise.all(this.state.projects.map(async project => [`project:${project.id}`, await trackedSourceUrls(path.join(project.path, 'skills-lock.json'))]))]);
    const roots = PRESETS.map(([label, relative]) => ({ id: `preset-${slug(label)}`, path: path.join(this.homeDir, relative), label, scopeId: 'global', preset: true }));
    for (const agent of getAgentRegistry({ homeDir: this.homeDir })) {
      for (const [index, directory] of agent.skillDirectories.entries()) {
        if (!roots.some(root => root.path === directory)) roots.push({ id: `preset-${agent.id}-${index}`, path: directory, label: agent.name, scopeId: 'global', preset: true });
      }
    }
    roots.push({ id: 'preset-magpie', path: path.join(this.magpieDir, 'library', 'skills'), label: 'Magpie', scopeId: 'global', preset: true });
    roots.push(...this.state.customRoots);
    for (const project of this.state.projects) {
      for (const [label, relative] of PRESETS.filter(([, relative]) => !relative.startsWith('.config/') && relative !== '.pi/agent/skills')) {
        roots.push({ id: `project-${project.id}-${slug(label)}`, path: path.join(project.path, relative), label, scopeId: `project:${project.id}`, preset: true });
      }
      roots.push({ id: `project-${project.id}-opencode`, path: path.join(project.path, '.opencode/skills'), label: 'OpenCode', scopeId: `project:${project.id}`, preset: true });
      for (const agent of getAgentInstallRegistry()) {
        const directory = path.join(project.path, agent.projectSkillDirectory);
        if (!roots.some(root => root.scopeId === `project:${project.id}` && root.path === directory)) roots.push({ id: `project-${project.id}-${agent.id}`, path: directory, label: agent.name, scopeId: `project:${project.id}`, preset: true });
      }
    }
    const found = new Map();
    const warnings = [];
    for (const root of roots) {
      try { root.exists = Boolean(await lstat(root.path)); }
      catch (error) { root.exists = false; warnings.push(`Cannot access source ${root.path}: ${error.message}`); }
      if (!root.exists) continue;
      const visited = new Map();
      let count = 0;
      const visit = async (location, depth = 0, userManaged = true) => {
        if (depth > 16 || ++count > 10000) { warnings.push(`Scan limit reached: ${root.path}`); return; }
        const catalogEligible = depth === 1 && userManaged;
        let real;
        try {
          real = await fs.realpath(location);
          if (inside(this.dataDir, real)) return;
          if (visited.has(real) && (!catalogEligible || visited.get(real))) return;
          visited.set(real, catalogEligible);
          const stat = await fs.stat(real);
          if (!stat.isDirectory()) return;
          const locationStat = await lstat(location);
          const installation = { installKind: locationStat?.isSymbolicLink() ? 'symlink' : 'directory', ...(locationStat?.isSymbolicLink() ? { linkTarget: real } : {}) };
          const skillFile = path.join(real, 'SKILL.md');
          const docStat = await lstat(skillFile);
          if (docStat && (docStat.isFile() || docStat.isSymbolicLink())) {
            const documentStat = await fs.stat(skillFile);
            if (!documentStat.isFile() || documentStat.size > FILE_LIMIT) { warnings.push(`Unreadable or oversized SKILL.md: ${skillFile}`); return; }
            const key = `${root.scopeId}\0${real}`;
            const canonicalPriority = catalogEligible && root.preset && root.label === 'Universal' ? 0 : 1;
            const existing = found.get(key);
            if (existing) {
              if (catalogEligible) {
                if (!existing.userManaged) {
                  existing.agents = [root.label];
                  existing.sourceLabel = root.label;
                  existing.canonicalPriority = canonicalPriority;
                  Object.assign(existing, installation);
                } else {
                  if (!existing.agents.includes(root.label)) existing.agents.push(root.label);
                  if (canonicalPriority < existing.canonicalPriority) {
                    existing.sourceLabel = root.label;
                    delete existing.linkTarget;
                    Object.assign(existing, installation);
                  }
                  existing.canonicalPriority = Math.min(existing.canonicalPriority, canonicalPriority);
                }
                existing.userManaged = true;
              } else if (!existing.userManaged && !existing.agents.includes(root.label)) existing.agents.push(root.label);
            } else {
              const bytes = await fs.readFile(skillFile);
              const document = bytes.toString('utf8');
              let meta;
              try { meta = metadata(document, path.basename(real)); }
              catch (error) { meta = { name: path.basename(real), slug: slug(path.basename(real)), description: '' }; warnings.push(`Invalid frontmatter in ${skillFile}: ${error.message}`); }
              found.set(key, { id: stableId(root.scopeId, real), ...meta, path: real, scopeId: root.scopeId, agents: [root.label], sourceLabel: root.label, userManaged: catalogEligible, canonicalPriority, documentHash: hash(bytes) });
              Object.assign(found.get(key), installation);
            }
            const item = found.get(key);
            if (catalogEligible && root.preset && root.label === 'Universal' && own(sourceUrls.get(root.scopeId) ?? {}, item.name)) item.sourceUrl = sourceUrls.get(root.scopeId)[item.name];
            if (depth > 0) return;
          }
          for (const entry of await fs.readdir(real, { withFileTypes: true })) {
            if (!EXCLUDED.has(entry.name) && (entry.isDirectory() || entry.isSymbolicLink())) await visit(path.join(real, entry.name), depth + 1, userManaged && !entry.name.startsWith('.'));
          }
        } catch (error) { warnings.push(`Cannot scan ${location}: ${error.message}`); }
      };
      await visit(root.path);
    }
    this.physicalSkills = [...found.values()].sort((a, b) => a.canonicalPriority - b.canonicalPriority || a.path.localeCompare(b.path) || a.id.localeCompare(b.id));
    const catalog = new Map();
    // Like the desktop catalog, count direct source children by scope and name, shared first.
    // Keep the physical inventory intact so older IDs and differing copies remain accessible.
    for (const { documentHash, userManaged, canonicalPriority, ...installation } of this.physicalSkills) {
      if (!userManaged) continue;
      const key = `${installation.scopeId}\0${installation.name}`;
      const existing = catalog.get(key);
      if (existing) existing.agents = [...new Set([...existing.agents, ...installation.agents])];
      else catalog.set(key, { ...installation, agents: [...installation.agents] });
    }
    this.skills = [...catalog.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    this.roots = roots;
    this.scanWarnings = [...new Set(warnings)];
    this.scannedAt = now();
    this.pruneFinderPositions();
  }

  rescan() { return this.mutate(async () => { await this.scan(); }); }

  item(id) {
    const skill = this.skills.find((item) => item.id === id) || this.physicalSkills.find((item) => item.id === id) || this.state.managedSkills.find((item) => item.id === id);
    if (!skill) fail('Skill not found. Rescan if the source changed.', 404);
    return skill;
  }

  managed(id) {
    const skill = this.state.managedSkills.find((item) => item.id === id);
    if (!skill) fail('Managed Skill not found.', 404);
    return skill;
  }

  pack(id) {
    const pack = this.state.packs.find((item) => item.id === id);
    if (!pack) fail('Pack not found.', 404);
    return pack;
  }

  folder(id) {
    const folder = this.state.folders.find((item) => item.id === id);
    if (!folder) fail('Folder not found.', 404);
    return folder;
  }

  scope(scopeId) {
    if (scopeId === 'global') return;
    if (typeof scopeId === 'string' && scopeId.startsWith('pack:')) { this.pack(scopeId.slice(5)); return; }
    if (typeof scopeId === 'string' && scopeId.startsWith('project:') && this.state.projects.some((project) => project.id === scopeId.slice(8))) return;
    fail('Unknown scope.');
  }

  parent(parentId, scopeId) {
    if (parentId == null) return null;
    if (this.folder(parentId).scopeId !== scopeId) fail('Folders and Skills must stay within the same scope.');
    return parentId;
  }

  uniqueFolder(name, scopeId, parentId, exceptId = null) {
    const folded = name.normalize('NFC').toLowerCase();
    if (this.state.folders.some((folder) => folder.id !== exceptId && folder.scopeId === scopeId && folder.parentId === parentId && folder.name.normalize('NFC').toLowerCase() === folded)) fail('A sibling folder with this name already exists.', 409);
  }

  ids(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > COUNT_LIMIT || ids.some((id) => typeof id !== 'string')) fail('Select one or more valid Skill IDs.');
    if (new Set(ids).size !== ids.length) fail('Duplicate Skill IDs are not allowed.');
    return ids;
  }

  async readSkill(id) {
    return this.read(() => readPreview(this.item(id), 'SKILL.md', FILE_LIMIT, false));
  }

  async openSkillFolder(input, opener) {
    if (!record(input) || Object.keys(input).length !== 1 || !own(input, 'id')) fail('Provide only a Skill ID.');
    const id = text(input.id, 'Skill ID');
    return this.read(async () => {
      const { root } = await previewRoot(this.item(id));
      await opener(root);
      return { opened: true };
    });
  }

  workbenchInput() {
    return { ...this.workbenchOptions, homeDir: this.homeDir, magpieDir: this.magpieDir, dataDir: this.dataDir,
      customRoots: this.state.customRoots, knownSkillNames: this.skills.filter(skill => skill.scopeId === 'global').map(skill => skill.name),
      knownSkillPaths: this.skills.filter(skill => skill.scopeId === 'global').map(skill => skill.path) };
  }

  workbenchSnapshot() {
    if (!this.pendingWorkbenchScan) {
      this.pendingWorkbenchScan = this.read(() => scanWorkbench(this.workbenchInput())).finally(() => { this.pendingWorkbenchScan = null; });
    }
    return this.pendingWorkbenchScan;
  }

  openWorkbenchDirectory(input, opener) {
    if (!record(input) || Object.keys(input).length !== 1 || !own(input, 'id')) fail('Provide only an Agent directory ID.');
    const id = text(input.id, 'Agent directory ID');
    return this.read(async () => {
      const directory = await workbenchDirectory(id, this.workbenchInput());
      await opener(directory);
      return { opened: true };
    });
  }

  async readSkillFile(id, relative) {
    return this.read(() => readPreview(this.item(id), relative, PREVIEW_LIMIT));
  }

  async skillFiles(id) {
    return this.read(async () => {
      const { root, stat: rootStat } = await previewRoot(this.item(id));
      let count = 0;
      let truncated = false;
      const visit = async (relative = '', depth = 0) => {
        if (depth > 32) { truncated = true; return []; }
        const location = relative ? await previewLocation(root, relative) : root;
        const result = [];
        const directory = await fs.opendir(location);
        for await (const entry of directory) {
          if (++count > COUNT_LIMIT) { truncated = true; break; }
          if (EXCLUDED.has(entry.name)) continue;
          const local = relative ? `${relative}/${entry.name}` : entry.name;
          // A tree lists eligible previews without following nested links.
          if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) continue;
          const target = await previewLocation(root, local);
          const stat = await fs.lstat(target);
          if (stat.isDirectory()) result.push({ name: entry.name, path: local, kind: 'directory', children: await visit(local, depth + 1) });
          else if (stat.isFile()) result.push({ name: entry.name, path: local, kind: 'file', size: stat.size });
          if (truncated && count > COUNT_LIMIT) break;
        }
        return result.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1));
      };
      const files = await visit();
      if (!sameIdentity(rootStat, await fs.lstat(root)) || await fs.realpath(root) !== root) fail('Skill directory changed during the preview.', 409);
      return { files, truncated };
    });
  }

  addRoot(input) {
    return this.mutate(async () => {
      const location = await fs.realpath(absolute(input.path));
      if (!(await fs.stat(location)).isDirectory()) fail('Root must be a directory.');
      if (inside(this.dataDir, location) || inside(location, this.dataDir)) fail('A source root cannot overlap plugin storage.');
      if (this.roots.some((root) => root.scopeId === 'global' && root.path === location)) fail('Root already exists.', 409);
      this.state.customRoots.push({ id: randomUUID(), path: location, label: text(input.label ?? path.basename(location), 'root label'), scopeId: 'global', preset: false });
      await this.scan();
    });
  }

  removeRoot(id) {
    return this.mutate(async () => {
      const index = this.state.customRoots.findIndex((root) => root.id === id);
      if (index === -1) fail('Custom root not found. Preset roots cannot be removed.', 404);
      this.state.customRoots.splice(index, 1);
      await this.scan();
    });
  }

  addProject(input) {
    return this.mutate(async () => {
      const location = await fs.realpath(absolute(input.path));
      if (!(await fs.stat(location)).isDirectory()) fail('Project must be a directory.');
      if (inside(this.dataDir, location)) fail('Project cannot be inside plugin storage.');
      if (this.state.projects.some((project) => project.path === location)) fail('Project already exists.', 409);
      this.state.projects.push({ id: randomUUID(), path: location, name: text(input.name ?? path.basename(location), 'project name') });
      await this.scan();
    });
  }

  removeProject(id) {
    return this.mutate(async () => {
      if (!this.state.projects.some((project) => project.id === id)) fail('Project not found.', 404);
      const scopeId = `project:${id}`;
      for (const skill of this.physicalSkills.filter((skill) => skill.scopeId === scopeId)) {
        delete this.state.organization[skill.id];
        delete this.state.finderPositions[`skill:${skill.id}`];
      }
      this.state.folders = this.state.folders.filter((folder) => folder.scopeId !== scopeId);
      this.state.projects = this.state.projects.filter((project) => project.id !== id);
      await this.scan();
    });
  }

  createFolder(input) {
    return this.mutate(async () => {
      this.scope(input.scopeId);
      const name = text(input.name, 'folder name');
      const parentId = this.parent(input.parentId, input.scopeId);
      this.uniqueFolder(name, input.scopeId, parentId);
      const coordinates = own(input, 'position') ? position(input.position) : null;
      const folder = { id: randomUUID(), name, scopeId: input.scopeId, parentId, color: color(input.color) };
      this.state.folders.push(folder);
      if (coordinates) this.state.finderPositions[`folder:${folder.id}`] = coordinates;
    });
  }

  updateFolder(id, patch) {
    return this.mutate(async () => {
      const folder = this.folder(id);
      if (own(patch, 'name')) folder.name = text(patch.name, 'folder name');
      if (own(patch, 'color')) folder.color = color(patch.color);
      if (own(patch, 'parentId')) {
        const parentId = this.parent(patch.parentId, folder.scopeId);
        let current = parentId;
        const visited = new Set();
        while (current !== null) {
          if (current === id || visited.has(current)) fail('Folder move would create a cycle.');
          visited.add(current);
          current = this.folder(current).parentId;
        }
        if (folder.parentId !== parentId) delete this.state.finderPositions[`folder:${id}`];
        folder.parentId = parentId;
      }
      this.uniqueFolder(folder.name, folder.scopeId, folder.parentId, id);
    });
  }

  deleteFolder(id) {
    return this.mutate(async () => {
      const folder = this.folder(id);
      for (const child of this.state.folders.filter((child) => child.parentId === id)) this.uniqueFolder(child.name, child.scopeId, folder.parentId, id);
      for (const child of this.state.folders) if (child.parentId === id) {
        child.parentId = folder.parentId;
        delete this.state.finderPositions[`folder:${child.id}`];
      }
      for (const [skillId, organization] of Object.entries(this.state.organization)) if (organization.folderId === id) {
        organization.folderId = folder.parentId;
        delete this.state.finderPositions[`skill:${skillId}`];
      }
      this.state.folders = this.state.folders.filter((item) => item.id !== id);
    });
  }

  organize(input) {
    return this.mutate(async () => {
      const items = this.ids(input.ids).map((id) => this.item(id));
      const newTags = own(input, 'tags') ? tags(input.tags) : null;
      for (const item of items) {
        const previous = this.state.organization[item.id] ?? { folderId: null, tags: [] };
        const folderId = own(input, 'folderId') ? this.parent(input.folderId, item.scopeId) : previous.folderId;
        if (folderId !== previous.folderId) delete this.state.finderPositions[`skill:${item.id}`];
        this.state.organization[item.id] = {
          folderId,
          tags: newTags ?? previous.tags,
        };
      }
    });
  }

  layout(input) {
    return this.mutate(async () => {
      if (!record(input)) fail('Finder layout must be an object.');
      this.scope(input.scopeId);
      if (!Array.isArray(input.items) || !input.items.length || input.items.length > COUNT_LIMIT) fail('Finder layout must select between 1 and 2000 items.');
      const moving = own(input, 'parentId');
      if (moving && input.parentId !== null && typeof input.parentId !== 'string') fail('Finder parentId must be a folder ID or null.');
      const parentId = moving ? this.parent(input.parentId, input.scopeId) : null;
      const seen = new Set();
      const items = input.items.map((entry) => {
        if (!record(entry) || (entry.kind !== 'skill' && entry.kind !== 'folder') || typeof entry.id !== 'string' || !entry.id.length || entry.id.length > 200) fail('Invalid Finder item.');
        const key = `${entry.kind}:${entry.id}`;
        if (seen.has(key)) fail('Duplicate Finder items are not allowed.');
        seen.add(key);
        const item = entry.kind === 'folder' ? this.folder(entry.id) : this.item(entry.id);
        if (item.scopeId !== input.scopeId) fail('Finder items and their destination must stay within the same scope.');
        return { kind: entry.kind, item, key, coordinates: own(entry, 'position') ? position(entry.position) : null };
      });
      for (const { kind, item, key, coordinates } of items) {
        if (moving) {
          if (kind === 'folder') {
            if (item.parentId !== parentId) delete this.state.finderPositions[key];
            item.parentId = parentId;
          } else {
            const organization = this.state.organization[item.id] ?? { folderId: null, tags: [] };
            if (organization.folderId !== parentId) delete this.state.finderPositions[key];
            this.state.organization[item.id] = { ...organization, folderId: parentId };
          }
        }
        if (coordinates !== null) this.state.finderPositions[key] = coordinates;
      }
      // Validate the final graph rather than intermediate moves of a selected parent and child.
      const folders = this.state.folders.filter((folder) => folder.scopeId === input.scopeId);
      const byId = new Map(folders.map((folder) => [folder.id, folder]));
      const siblingNames = new Set();
      for (const folder of folders) {
        const siblingKey = JSON.stringify([folder.parentId, folder.name.normalize('NFC').toLowerCase()]);
        if (siblingNames.has(siblingKey)) fail('A sibling folder with this name already exists.', 409);
        siblingNames.add(siblingKey);
        let current = folder.parentId;
        const ancestors = new Set([folder.id]);
        while (current !== null) {
          if (ancestors.has(current)) fail('Finder move would create a folder cycle.');
          ancestors.add(current);
          const parent = byId.get(current);
          if (!parent) fail('Finder folder parent is outside the selected scope.');
          current = parent.parentId;
        }
      }
    });
  }

  createPack(input) {
    return this.mutate(async () => {
      const date = now();
      this.state.packs.push({ id: randomUUID(), name: text(input.name, 'Pack name'), description: text(input.description ?? '', 'Pack description', 10000, true), createdAt: date, updatedAt: date });
    });
  }

  updatePack(id, patch) {
    return this.mutate(async () => {
      const pack = this.pack(id);
      if (id === 'default') fail('The Default Pack cannot be edited.', 409);
      if (own(patch, 'name')) pack.name = text(patch.name, 'Pack name');
      if (own(patch, 'description')) pack.description = text(patch.description, 'Pack description', 10000, true);
      pack.updatedAt = now();
    });
  }

  async assertNoLiveLink(skill) {
    for (const deployment of skill.deployments.filter((item) => item.mode === 'symlink')) {
      const stat = await lstat(deployment.targetPath);
      if (stat?.isSymbolicLink()) {
        const target = path.resolve(path.dirname(deployment.targetPath), await fs.readlink(deployment.targetPath));
        if (inside(await canonical(skill.path), await canonical(target))) fail('Remove live symlink deployments before deleting this Skill or Pack.', 409);
      }
    }
  }

  treeFingerprint(location, limits = undefined) { return fingerprint(location, limits); }

  async stageDelete(location, transaction, expectedFingerprint = null, expectedIdentity = null, limits = undefined) {
    if (!await lstat(location)) return;
    const stash = path.join(path.dirname(location), `.shelf-trash-${randomUUID()}`);
    await fs.rename(location, stash);
    transaction.rollback.push(async () => {
      if (await lstat(location)) fail(`Rollback target was recreated; preserving it and the staged original at ${stash}.`, 409);
      await fs.rename(stash, location);
    });
    if (expectedIdentity !== null && !sameIdentity(await lstat(stash), expectedIdentity)) fail('Created target was replaced; preserving its replacement.', 409);
    if (expectedFingerprint !== null) {
      let actual;
      try { actual = await fingerprint(stash, limits); } catch (error) { fail(`Deployment changed during removal; preserving the target. ${error.message}`, 409); }
      if (actual !== expectedFingerprint) fail('Deployment changed during removal; preserving the target.', 409);
    }
    transaction.cleanup.push(async () => {
      if (expectedIdentity !== null && !sameIdentity(await lstat(stash), expectedIdentity)) fail(`Staged target was replaced; preserving it at ${stash}.`, 409);
      if (expectedFingerprint !== null && await fingerprint(stash, limits) !== expectedFingerprint) fail(`Staged deployment was changed; preserving it at ${stash}.`, 409);
      await fs.rm(stash, { recursive: true, force: true });
    });
  }

  async rememberCreation(location, transaction, limits = undefined) {
    const ownership = { identity: await fs.lstat(location), fingerprint: null, limits };
    transaction.rollback.push(async () => {
      const staged = { rollback: [], cleanup: [] };
      try {
        await this.stageDelete(location, staged, ownership.fingerprint, ownership.identity, ownership.limits);
        for (const finish of staged.cleanup) await finish();
      } catch (error) {
        for (const undo of staged.rollback.reverse()) await undo();
        throw error;
      }
    });
    return ownership;
  }

  async finishCreation(location, ownership) {
    if (!sameIdentity(await lstat(location), ownership.identity)) fail('Created target was replaced during the operation.', 409);
    ownership.fingerprint = await fingerprint(location, ownership.limits);
    if (!sameIdentity(await lstat(location), ownership.identity)) fail('Created target was replaced during the operation.', 409);
    return ownership.fingerprint;
  }

  deletePack(id) {
    return this.mutate(async (transaction) => {
      this.pack(id);
      if (id === 'default') fail('The Default Pack cannot be deleted.', 409);
      const skills = this.state.managedSkills.filter((skill) => skill.packId === id);
      for (const skill of skills) await this.assertNoLiveLink(skill);
      for (const skill of skills) { await this.stageDelete(skill.path, transaction); delete this.state.organization[skill.id]; }
      this.state.managedSkills = this.state.managedSkills.filter((skill) => skill.packId !== id);
      this.state.folders = this.state.folders.filter((folder) => folder.scopeId !== `pack:${id}`);
      this.state.packs = this.state.packs.filter((pack) => pack.id !== id);
    });
  }

  importSkills(packId, input) {
    return this.mutate(async (transaction) => {
      const pack = this.pack(packId);
      const folderId = this.parent(input.folderId, `pack:${packId}`);
      const sources = this.ids(input.skillIds).map((id) => this.item(id));
      const counter = budget();
      const copies = [];
      for (const source of sources) copies.push({ source, files: await filesInTree(source.path, counter) });
      for (const { source, files } of copies) {
        if (!files.some((file) => file.path === 'SKILL.md')) fail('Skill must contain SKILL.md.');
        const id = randomUUID();
        const destination = path.join(this.skillDir, id);
        let ownership;
        await writeTree(destination, files, async () => { ownership = await this.rememberCreation(destination, transaction); });
        await this.finishCreation(destination, ownership);
        this.state.managedSkills.push({ id, name: source.name, slug: source.slug, description: source.description, path: destination, packId, scopeId: `pack:${packId}`, sourcePath: source.path, sourceLabel: source.sourceLabel, agents: [], importedAt: now(), deployments: [] });
        this.state.organization[id] = { folderId, tags: copy(this.state.organization[source.id]?.tags ?? []) };
      }
      pack.updatedAt = now();
    });
  }

  deleteManagedSkill(id) {
    return this.mutate(async (transaction) => {
      const skill = this.managed(id);
      await this.assertNoLiveLink(skill);
      await this.stageDelete(skill.path, transaction);
      this.state.managedSkills = this.state.managedSkills.filter((skill) => skill.id !== id);
      delete this.state.organization[id];
      this.pack(skill.packId).updatedAt = now();
    });
  }

  async deploymentParent(input) {
    const requested = absolute(input, 'Deployment target');
    const target = await canonical(requested);
    if (inside(this.dataDir, target) || inside(target, this.dataDir)) fail('Deployment target cannot be plugin storage or an ancestor of it.');
    for (const skill of [...this.physicalSkills, ...this.state.managedSkills]) {
      if (inside(skill.path, target)) fail('Deployment target cannot be inside an existing Skill source.');
    }
    return target;
  }

  async makeParent(location, transaction) {
    const missing = [];
    let current = location;
    while (!await lstat(current)) { missing.push(current); current = path.dirname(current); }
    if (!(await fs.stat(current)).isDirectory()) fail('Deployment parent is not a directory.');
    for (const directory of missing.reverse()) {
      await fs.mkdir(directory, { recursive: false });
      transaction.rollback.push(async () => {
        try { await fs.rmdir(directory); } catch (error) {
          // A concurrent user-created entry must survive a failed deployment.
          if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST' && error.code !== 'ENOENT') throw error;
        }
      });
    }
  }

  deploy(input) {
    return this.mutate(async (transaction) => {
      if (input.mode !== 'copy' && input.mode !== 'symlink') fail('Deployment mode must be copy or symlink.');
      const skills = this.ids(input.skillIds).map((id) => this.managed(id));
      const target = await this.deploymentParent(input.targetPath);
      const destinations = skills.map((skill) => path.join(target, slug(skill.slug)));
      if (new Set(destinations).size !== destinations.length) fail('Selected Skills have duplicate destination names; deploy separately.', 409);
      for (const destination of destinations) {
        if ([...this.physicalSkills, ...this.state.managedSkills].some((skill) => inside(destination, skill.path))) fail('Deployment cannot contain an existing Skill source.');
        if (await lstat(destination)) fail(`Deployment already exists: ${destination}`, 409);
      }
      const counter = budget();
      const assets = [];
      for (const skill of skills) assets.push(await filesInTree(skill.path, counter));
      await this.makeParent(target, transaction);
      for (const [index, skill] of skills.entries()) {
        const destination = destinations[index];
        let ownership;
        // Reserve destinations with exclusive creation; never replace existing files or dangling links.
        if (input.mode === 'copy') {
          await fs.mkdir(destination, { recursive: false });
          ownership = await this.rememberCreation(destination, transaction);
          for (const file of assets[index]) {
            const location = path.join(destination, ...file.path.split('/'));
            await fs.mkdir(path.dirname(location), { recursive: true });
            await fs.writeFile(location, file.data, { flag: 'wx', mode: file.executable ? 0o755 : 0o644 });
          }
        } else {
          await fs.symlink(skill.path, destination, 'dir');
          ownership = await this.rememberCreation(destination, transaction);
        }
        skill.deployments.push({ id: randomUUID(), targetPath: destination, mode: input.mode, createdAt: now(), _fingerprint: await this.finishCreation(destination, ownership) });
      }
    });
  }

  removeDeployment(input) {
    return this.mutate(async (transaction) => {
      const skill = this.managed(input.skillId);
      const deployment = skill.deployments.find((item) => item.id === input.deploymentId);
      if (!deployment) fail('Deployment not found.', 404);
      const stat = await lstat(deployment.targetPath);
      if (stat) {
        let actual;
        try { actual = await fingerprint(deployment.targetPath); } catch (error) { fail(`Deployment changed; preserving the target. ${error.message}`, 409); }
        if (actual !== deployment._fingerprint) fail('Deployment changed or was replaced; preserving the target.', 409);
        await this.stageDelete(deployment.targetPath, transaction, deployment._fingerprint);
      }
      skill.deployments = skill.deployments.filter((item) => item.id !== deployment.id);
    });
  }

  async exportPack(id) {
    return this.read(async () => {
      const pack = this.pack(id);
      const folders = this.state.folders.filter((folder) => folder.scopeId === `pack:${id}`).map(({ scopeId, ...folder }) => folder);
      const skills = [];
      const counter = budget();
      for (const skill of this.state.managedSkills.filter((skill) => skill.packId === id)) {
        const files = await filesInTree(skill.path, counter);
        const organization = this.state.organization[skill.id] ?? { folderId: null, tags: [] };
        skills.push({ id: skill.id, name: skill.name, slug: skill.slug, description: skill.description, ...organization, files: files.map((file) => ({ path: file.path, content: file.data.toString('base64'), executable: file.executable })) });
      }
      return { format: 'skill-shelf-pack', version: 1, pack: { name: pack.name, description: pack.description }, folders: copy(folders), skills };
    });
  }

  validateDocument(document) {
    if (!record(document) || document.format !== 'skill-shelf-pack' || document.version !== 1 || !record(document.pack) || !Array.isArray(document.folders) || !Array.isArray(document.skills)) fail('Not a plugin Portable Pack v1 document.');
    const keys = (object, expected) => {
      if (!record(object) || Object.keys(object).some((key) => !expected.includes(key)) || expected.some((key) => !own(object, key))) fail('Portable Pack contains missing or unsupported fields.');
    };
    keys(document, ['format', 'version', 'pack', 'folders', 'skills']);
    // Base64 adds about one third to the decoded operation limit; metadata is bounded separately.
    if (Buffer.byteLength(JSON.stringify(document)) > 24 * 1024 * 1024) fail('Portable Pack document exceeds the 24 MiB JSON limit.', 413);
    keys(document.pack, ['name', 'description']);
    const name = text(document.pack.name, 'Pack name');
    const description = text(document.pack.description, 'Pack description', 10000, true);
    if (document.folders.length > COUNT_LIMIT || document.skills.length > COUNT_LIMIT) fail('Portable Pack contains too many entries.', 413);
    const folderMap = new Map();
    for (const folder of document.folders) {
      keys(folder, ['id', 'name', 'parentId', 'color']);
      const id = text(folder.id, 'portable folder ID');
      if (folderMap.has(id) || (folder.parentId !== null && typeof folder.parentId !== 'string')) fail('Invalid or duplicate portable folder ID.');
      folderMap.set(id, { id, name: text(folder.name, 'folder name'), parentId: folder.parentId, color: color(folder.color) });
    }
    for (const folder of folderMap.values()) {
      if ([...folderMap.values()].some((other) => other.id !== folder.id && other.parentId === folder.parentId && other.name.normalize('NFC').toLowerCase() === folder.name.normalize('NFC').toLowerCase())) fail('Portable Pack contains duplicate sibling folder names.');
      let current = folder.parentId;
      const visited = new Set([folder.id]);
      while (current !== null) {
        if (visited.has(current)) fail('Portable Pack folder cycle.');
        visited.add(current);
        const parent = folderMap.get(current);
        if (!parent) fail('Portable Pack references a missing folder.');
        current = parent.parentId;
      }
    }
    const seenIds = new Set();
    const counter = budget();
    const skills = [];
    let encodedBytes = 0;
    for (const skill of document.skills) {
      keys(skill, ['id', 'name', 'slug', 'description', 'folderId', 'tags', 'files']);
      const id = text(skill.id, 'portable Skill ID');
      if (seenIds.has(id)) fail('Duplicate portable Skill ID.');
      seenIds.add(id);
      if (skill.folderId !== null && !folderMap.has(skill.folderId)) fail('Portable Skill references a missing folder.');
      if (!Array.isArray(skill.files) || !skill.files.length || skill.files.length > COUNT_LIMIT) fail('Portable Skill must contain files.');
      const paths = new Set();
      const files = [];
      for (const file of skill.files) {
        keys(file, ['path', 'content', 'executable']);
        safeFilePath(file.path);
        if (file.path.split('/').some((part) => EXCLUDED.has(part))) fail('Portable Pack contains an excluded file or directory.');
        // Case folding prevents ambiguous archives when imported on case-insensitive filesystems.
        const folded = file.path.normalize('NFC').toLowerCase();
        if (paths.has(folded)) fail('Portable Pack has duplicate file paths.');
        paths.add(folded);
        if (typeof file.content !== 'string' || typeof file.executable !== 'boolean' || file.content.length > Math.ceil(FILE_LIMIT / 3) * 4) fail('Invalid or oversized portable file.', 413);
        encodedBytes += file.content.length;
        if (encodedBytes > Math.ceil(TOTAL_LIMIT / 3) * 4 + COUNT_LIMIT * 4) fail('Portable Pack is too large.', 413);
        const padding = file.content.endsWith('==') ? 2 : file.content.endsWith('=') ? 1 : 0;
        if (file.content.length / 4 * 3 - padding > FILE_LIMIT) fail('Portable file exceeds the 4 MiB limit.', 413);
        if (file.content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.content)) fail('Malformed base64 file content.');
        const data = Buffer.from(file.content, 'base64');
        if (data.toString('base64') !== file.content) fail('Non-canonical base64 file content.');
        charge(counter, data.length);
        files.push({ path: file.path, data, executable: file.executable });
      }
      for (const file of paths) {
        const parts = file.split('/');
        for (let depth = 1; depth < parts.length; depth++) if (paths.has(parts.slice(0, depth).join('/'))) fail('Portable Pack file/directory path collision.');
      }
      if (!files.some((file) => file.path === 'SKILL.md')) fail('Portable Skill must contain SKILL.md.');
      const portableSlug = text(skill.slug, 'Skill slug', 90);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(portableSlug)) fail('Unsafe portable Skill slug.');
      skills.push({ name: text(skill.name, 'Skill name'), slug: portableSlug, description: text(skill.description, 'Skill description', 10000, true), folderId: skill.folderId, tags: tags(skill.tags), files });
    }
    return { name, description, folders: [...folderMap.values()], skills };
  }

  importPack(document) {
    return this.mutate(async (transaction) => {
      const validated = this.validateDocument(document);
      const packId = randomUUID();
      const date = now();
      this.state.packs.push({ id: packId, name: validated.name, description: validated.description, createdAt: date, updatedAt: date });
      const folderIds = new Map(validated.folders.map((folder) => [folder.id, randomUUID()]));
      for (const folder of validated.folders) this.state.folders.push({ ...folder, id: folderIds.get(folder.id), parentId: folder.parentId === null ? null : folderIds.get(folder.parentId), scopeId: `pack:${packId}` });
      for (const skill of validated.skills) {
        const id = randomUUID();
        const destination = path.join(this.skillDir, id);
        let ownership;
        await writeTree(destination, skill.files, async () => { ownership = await this.rememberCreation(destination, transaction); });
        await this.finishCreation(destination, ownership);
        this.state.managedSkills.push({ id, name: skill.name, slug: skill.slug, description: skill.description, path: destination, scopeId: `pack:${packId}`, packId, sourcePath: '', sourceLabel: 'Portable Pack', agents: [], importedAt: date, deployments: [] });
        this.state.organization[id] = { folderId: skill.folderId === null ? null : folderIds.get(skill.folderId), tags: skill.tags };
      }
    });
  }
}
