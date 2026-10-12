import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { ShelfError } from './domain.mjs';
import { AIBridge, annotationSource } from './ai.mjs';
import { parseSyncDocument, MAX_FILE_BYTES, MAX_LIBRARY_BYTES, MAX_FILES, assertPortablePath, assertPortableTree, managedFilesHash, skillFingerprint, portableKey } from './sync-format.mjs';

const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const empty = value => value == null || value === '' || (Array.isArray(value) && !value.length);
const date = () => new Date().toISOString();
const fail = (message, status = 400) => { throw new ShelfError(status, message); };
const folderKey = names => JSON.stringify(names.map(portableKey));
const copyKey = skill => `${portableKey(skill.packName ?? 'Default')}\0${skill.copyId ?? `${skill.name}\0${skill.identity ?? skill.fingerprint}`}`;
const installedKey = skill => JSON.stringify([skill.name, skill.identity, skill.scope, skill.projectName ?? null]);
const sameReference = (left, right) => left.name === right.name && Boolean((left.identity && left.identity === right.identity) || (left.fingerprint && left.fingerprint === right.fingerprint));
const memberMatches = (left, right) => left.copyId && right.copyId ? left.copyId === right.copyId : sameReference(left, right);
const slug = name => name.normalize('NFKD').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90).toLowerCase() || 'skill';
const LIMITS = { file: MAX_FILE_BYTES, total: MAX_LIBRARY_BYTES };
const sameNode = (left, right) => left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
const sameTranslation = (left, right) => left?.content === right?.content && left?.sourceDescription === right?.sourceDescription;

async function readFiles(root, counter) {
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await fs.realpath(root) !== root) fail('Sync requires a real managed Skill directory.', 409);
  const files = [];
  let entries = 0;
  async function walk(directory, prefix = '', depth = 0) {
    if (depth > 32) fail('Sync Skill directory is too deeply nested.');
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      if (++entries > 20000) fail('Too many Skill directory entries.', 413);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      assertPortablePath(relative);
      const location = path.join(directory, entry.name);
      const stat = await fs.lstat(location);
      if (stat.isSymbolicLink()) fail('Nested symlinks cannot be synced.');
      if (stat.isDirectory()) { await walk(location, relative, depth + 1); continue; }
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES || counter.bytes + stat.size > MAX_LIBRARY_BYTES || counter.files >= MAX_FILES) fail('Sync files exceed the 20 MiB/file, 64 MiB/library or 10000 file limit.', 413);
      const handle = await fs.open(location, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let bytes;
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || !sameNode(opened, stat) || opened.size > MAX_FILE_BYTES) fail('Skill changed while reading sync data.', 409);
        const buffer = Buffer.alloc(opened.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length !== opened.size || !sameNode(opened, await fs.lstat(location))) fail('Skill changed while reading sync data.', 409);
        bytes = buffer.subarray(0, length);
      } finally { await handle.close(); }
      counter.files++; counter.bytes += bytes.length;
      if (counter.bytes > MAX_LIBRARY_BYTES) fail('Sync library is too large.', 413);
      files.push({ path: relative, content: bytes.toString('base64'), executable: Boolean(stat.mode & 0o111) });
    }
  }
  await walk(root);
  if (!sameNode(rootStat, await fs.lstat(root)) || await fs.realpath(root) !== root) fail('Skill directory changed during sync.', 409);
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  assertPortableTree(files);
  return files;
}

export class SyncService {
  constructor({ service, webdav, ai }) {
    this.service = service;
    this.webdav = webdav;
    this.ai = ai ?? new AIBridge({ service, magpieDir: service.magpieDir || service.dataDir });
    this.pending = new Map();
    this.configurationRevision = 0;
  }

  invalidatePreviews() { this.configurationRevision++; this.pending.clear(); }

  async source() {
    if (this.sourceValue) return clone(this.sourceValue);
    const location = path.join(this.service.dataDir, 'sync-device.json');
    let deviceId;
    try {
      const value = JSON.parse(await fs.readFile(location, 'utf8'));
      if (typeof value.deviceId !== 'string' || !/^[a-f\d-]{36}$/i.test(value.deviceId)) fail('Invalid private sync device identity.', 500);
      deviceId = value.deviceId;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      deviceId = randomUUID();
      try { await fs.writeFile(location, JSON.stringify({ deviceId }), { mode: 0o600, flag: 'wx' }); }
      catch (failure) {
        if (failure.code !== 'EEXIST') throw failure;
        const persisted = JSON.parse(await fs.readFile(location, 'utf8'));
        if (typeof persisted.deviceId !== 'string' || !/^[a-f\d-]{36}$/i.test(persisted.deviceId)) fail('Invalid private sync device identity.', 500);
        deviceId = persisted.deviceId;
      }
    }
    this.sourceValue = { deviceId, deviceName: os.hostname().slice(0, 128) || 'Skill Shelf', appVersion: '0.1.0' };
    return clone(this.sourceValue);
  }

  async persistIdentities() {
    await this.service.initialize();
    if (!this.service.state.managedSkills.some(skill => !skill.syncCopyId || !skill.syncIdentity)) return;
    await this.service.mutate(async () => {
      const counter = { bytes: 0, files: 0 };
      const locks = await this.sourceLocks();
      for (const skill of this.service.state.managedSkills) {
        if (!skill.syncCopyId) skill.syncCopyId = skill.id;
        if (!skill.syncIdentity) {
          const source = this.service.physicalSkills.find(item => item.path === skill.sourcePath);
          skill.syncIdentity = (source && this.lockIdentity(locks.get(source.scopeId)?.skills?.[source.name])) || skillFingerprint(await readFiles(skill.path, counter));
        }
      }
    });
  }

  async sourceLocks() {
    const globalPath = process.env.XDG_STATE_HOME && path.isAbsolute(process.env.XDG_STATE_HOME)
      ? path.join(process.env.XDG_STATE_HOME, 'skills', '.skill-lock.json') : path.join(this.service.homeDir, '.agents', '.skill-lock.json');
    const locations = [['global', globalPath], ...this.service.state.projects.map(project => [`project:${project.id}`, path.join(project.path, 'skills-lock.json')])];
    const result = new Map();
    for (const [scope, location] of locations) {
      let handle;
      try {
        handle = await fs.open(location, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Unsupported source lock.');
        const buffer = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length !== stat.size) throw new Error('Source lock changed.');
        const parsed = JSON.parse(buffer.subarray(0, length).toString('utf8'));
        if (!parsed || typeof parsed.skills !== 'object' || parsed.skills === null || Array.isArray(parsed.skills)) throw new Error('Invalid source lock.');
        result.set(scope, parsed);
      } catch {
        result.set(scope, null);
      } finally { await handle?.close(); }
    }
    return result;
  }

  lockIdentity(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    for (const source of [entry.sourceUrl, entry.sourceType === 'local' || entry.sourceType === 'local-source' ? null : entry.source]) {
      if (typeof source !== 'string' || source.length > 2048) continue;
      const github = source.match(/^(?:https:\/\/github\.com\/|github:)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i);
      if (github) return `github:${github[1].toLowerCase()}`;
      try {
        const url = new URL(source);
        if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) return `url:${url.href.replace(/\/$/, '')}`;
      } catch { /* Local lock sources use content identities. */ }
    }
    return null;
  }

  validateLocalDocument(document) {
    const bounded = (value, max, name, field) => { if (typeof value !== 'string' || value.length > max) fail(`${name}: ${field} exceeds the desktop sync limit of ${max} characters.`, 409); };
    const organization = (entry, name) => {
      if (entry.tags.length > 12) fail(`${name}: desktop sync allows at most 12 tags (currently ${entry.tags.length}).`, 409);
      for (const tag of entry.tags) bounded(tag, 32, name, 'tag');
      if (entry.position && (entry.position.x > 20000 || entry.position.y > 20000)) fail(`${name}: desktop sync positions must be between 0 and 20000.`, 409);
    };
    for (const skill of document.skills) {
      bounded(skill.name, 256, skill.name, 'Skill name'); organization(skill, skill.name);
      if (skill.folder.length > 32) fail(`${skill.name}: desktop sync allows at most 32 nested folders.`, 409);
      for (const folder of skill.folder) {
        bounded(folder.name, 48, folder.name, 'installed folder name');
        if (folder.position && (folder.position.x > 20000 || folder.position.y > 20000)) fail(`${folder.name}: desktop sync positions must be between 0 and 20000.`, 409);
      }
    }
    for (const pack of document.packs) {
      bounded(pack.name, 64, pack.name, 'Pack name'); bounded(pack.description, 500, pack.name, 'Pack description');
      if (pack.folders.length > 100) fail(`${pack.name}: desktop sync allows at most 100 Pack folders.`, 409);
      for (const folder of pack.folders) {
        if (folder.path.length > 32) fail(`${pack.name}: desktop sync allows at most 32 nested folders.`, 409);
        for (const name of folder.path) bounded(name, 64, name, 'Pack folder name');
        if (folder.position && (folder.position.x > 20000 || folder.position.y > 20000)) fail(`${folder.path.at(-1)}: desktop sync positions must be between 0 and 20000.`, 409);
      }
      for (const member of pack.skills) organization(member, member.name);
    }
    for (const skill of document.managedSkills) { bounded(skill.name, 256, skill.name, 'Skill name'); bounded(skill.description, 4000, skill.name, 'Skill description'); }
  }

  folderPath(id, state = this.service.state) {
    const result = [];
    const seen = new Set();
    while (id !== null && id !== undefined) {
      if (seen.has(id)) fail('Persisted folder cycle.', 500);
      seen.add(id);
      const folder = state.folders.find(item => item.id === id);
      if (!folder) fail('Persisted folder is missing.', 500);
      result.unshift(folder);
      id = folder.parentId;
    }
    return result;
  }

  async context() {
    const service = this.service;
    const document = { format: 'skill-shelf-metadata', version: 5, exportedAt: date(), skills: [], preferences: {}, packs: [], managedSkills: [], source: await this.source() };
    const installed = [];
    const managed = [];
    const warnings = [];
    const locks = await this.sourceLocks();
    const counter = { bytes: 0, files: 0 };
    for (const skill of service.skills) {
      const info = service.state.organization[skill.id] ?? { folderId: null, tags: [] };
      // Installed sources contribute metadata only; syncing never writes to an Agent's source tree.
      const read = await serviceReadIdentity(skill.path);
      let source;
      try { source = annotationSource(read.text); }
      catch (error) {
        if (!(error instanceof ShelfError) || error.status !== 400) throw error;
        // An unreadable description excludes its translations, not unrelated organization metadata.
        source = { sourceDigest: hash(read.text), description: '' };
      }
      const identity = this.lockIdentity(locks.get(skill.scopeId)?.skills?.[skill.name]) ?? read.identity;
      const scope = skill.scopeId === 'global' ? 'global' : 'project';
      const portable = {
        name: skill.name, identity, scope,
        ...(scope === 'project' ? { projectName: service.state.projects.find(project => `project:${project.id}` === skill.scopeId)?.name ?? '' } : {}),
        tags: clone(info.tags), folder: this.folderPath(info.folderId).map(folder => ({ name: folder.name, color: folder.color, position: clone(service.state.finderPositions[`folder:${folder.id}`] ?? null) })),
        position: clone(service.state.finderPositions[`skill:${skill.id}`] ?? null), descriptions: {}, translations: this.ai.portableTranslations(skill.id, source),
      };
      installed.push({ skill, portable, fingerprint: read.identity, source }); document.skills.push(portable);
    }
    for (const skill of service.state.managedSkills) {
      const files = await readFiles(skill.path, counter);
      const fingerprint = skillFingerprint(files);
      const portable = {
        copyId: skill.syncCopyId ?? skill.id, packName: service.pack(skill.packId).name,
        name: skill.name, description: skill.description, identity: skill.syncIdentity ?? fingerprint,
        fingerprint, sourceScope: skill.sourceScope ?? (skill.sourcePath && service.physicalSkills.some(item => item.path === skill.sourcePath && item.scopeId !== 'global') ? 'project' : 'global'),
        contentHash: managedFilesHash(files), files,
      };
      managed.push({ skill, portable }); document.managedSkills.push(portable);
    }
    for (const pack of service.state.packs) {
      const folders = service.state.folders.filter(folder => folder.scopeId === `pack:${pack.id}`);
      document.packs.push({ name: pack.name, description: pack.description, sort: 'manual', folders: folders.map(folder => ({ path: this.folderPath(folder.id).map(item => item.name), color: folder.color, position: clone(service.state.finderPositions[`folder:${folder.id}`] ?? null) })), skills: managed.filter(entry => entry.skill.packId === pack.id).map(({ skill, portable }) => {
        const info = service.state.organization[skill.id] ?? { folderId: null, tags: [] };
        return { copyId: portable.copyId, name: portable.name, identity: portable.identity, fingerprint: portable.fingerprint, folderPath: info.folderId === null ? null : this.folderPath(info.folderId).map(folder => folder.name), tags: clone(info.tags), position: clone(service.state.finderPositions[`skill:${skill.id}`] ?? null) };
      }) });
    }
    this.validateLocalDocument(document);
    parseSyncDocument(JSON.stringify(document));
    const revision = hash(JSON.stringify({ state: service.state, annotations: this.ai.syncRevision(), installed: installed.map(entry => [entry.skill.id, entry.portable.identity, entry.fingerprint]), managed: managed.map(entry => [entry.skill.id, entry.portable.contentHash]) }));
    return { document, installed, managed, revision, warnings };
  }

  async exportDocument() {
    return this.ai.withSync(async () => {
      await this.persistIdentities();
      return this.service.read(async () => (await this.context()).document);
    });
  }

  previewResult(mode, document, context) {
    const source = mode === 'upload' ? context.document : document;
    return { id: randomUUID(), mode, exportedAt: document.exportedAt, ...(document.source ? { source: { deviceId: document.source.deviceId, deviceName: document.source.deviceName, appVersion: document.source.appVersion } } : {}), total: source.skills.length, matched: 0, skipped: 0, added: 0, changed: 0, unchanged: 0, localOnly: 0,
      packs: { total: source.packs?.length ?? 0, changed: 0, matchedMembers: 0, skippedMembers: [] },
      managedSkills: { total: source.managedSkills?.length ?? 0, added: 0, updated: 0, unchanged: 0, skipped: [] },
      conflicts: [], warnings: [...context.warnings] };
  }

  choice(preview, key, skillName, field, local, incoming) {
    if (equal(local, incoming)) return null;
    const id = `conflict-${hash(key).slice(0, 24)}`;
    const display = value => {
      if (field === 'position' && value != null) return { x: value.x, y: value.y };
      if (field === 'folder' && Array.isArray(value)) return value.map(folder => typeof folder === 'string' ? folder : { name: folder.name, color: folder.color });
      return value;
    };
    preview.conflicts.push({ id, skillName, field, local: JSON.stringify(display(local)), incoming: JSON.stringify(display(incoming)) });
    return id;
  }

  async previewImport(input) {
    const document = this.expandLegacyCopies(parseSyncDocument(typeof input === 'string' ? input : JSON.stringify(input)));
    return this.ai.withSync(async () => {
      await this.persistIdentities();
      return this.service.read(async () => this.storeImport(document, await this.context()));
    });
  }

  expandLegacyCopies(document) {
    const result = clone(document);
    if (!result.managedSkills) return result;
    result.managedSkills = document.managedSkills.flatMap(skill => {
      if (skill.packName) return [clone(skill)];
      const owners = (document.packs ?? []).flatMap(pack => {
        const members = pack.skills.filter(member => memberMatches(member, skill));
        if (members.length !== 1) return [];
        const member = members[0];
        if (!(member.copyId && skill.copyId) && document.managedSkills.filter(candidate => memberMatches(member, candidate)).length !== 1) return [];
        return [{ ...clone(skill), packName: pack.name, ...(member.copyId ? { copyId: member.copyId } : {}) }];
      });
      return owners.length ? owners : [{ ...clone(skill), packName: 'Default' }];
    });
    return parseSyncDocument(JSON.stringify(result));
  }

  storeImport(document, context, remote = undefined) {
    const preview = this.previewResult('import', document, context);
    const state = clone(this.service.state);
    const operations = [];
    const changedInstalled = new Set();
    const changedPacks = new Set();
    const matchedInstalled = new Set();
    const incomingCounts = new Map();
    let staleTranslations = 0;
    for (const incoming of document.skills) incomingCounts.set(installedKey(incoming), (incomingCounts.get(installedKey(incoming)) ?? 0) + 1);
    const add = (key, skillName, field, local, incoming, action) => {
      if (equal(local, incoming)) return;
      const conflict = empty(local) ? null : this.choice(preview, `${key}:${field}`, skillName, field, local, incoming);
      operations.push({ conflict, action });
    };
    // Layout follows the incoming snapshot, but only after the user confirms the preview.
    const addPosition = (key, local, incoming) => {
      if (equal(local, incoming)) return;
      operations.push({ conflict: null, action: async () => {
        if (incoming === null) delete this.service.state.finderPositions[key];
        else this.service.state.finderPositions[key] = clone(incoming);
      } });
    };
    const packs = new Map();
    const ensurePack = (name, description = '') => {
      const key = portableKey(name);
      if (packs.has(key)) return packs.get(key);
      const candidates = state.packs.filter(pack => portableKey(pack.name) === key);
      if (candidates.length > 1) fail('Local Pack names are ambiguous; rename duplicates before syncing.', 409);
      let pack = candidates[0];
      if (!pack) {
        pack = { id: randomUUID(), name, description, createdAt: date(), updatedAt: date() };
        state.packs.push(pack); changedPacks.add(pack.id);
        operations.push({ conflict: null, action: async () => this.service.state.packs.push(clone(pack)) });
      }
      packs.set(key, pack); return pack;
    };
    const ensureFolders = (scopeId, incoming) => {
      let parentId = null;
      for (const folder of incoming) {
        let item = state.folders.find(candidate => candidate.scopeId === scopeId && candidate.parentId === parentId && portableKey(candidate.name) === portableKey(folder.name));
        if (!item) {
          item = { id: randomUUID(), name: folder.name, color: folder.color ?? '#ed6a4a', parentId, scopeId };
          state.folders.push(item);
          const created = clone(item);
          operations.push({ conflict: null, action: async () => this.service.state.folders.push(created) });
        } else if (folder.color !== undefined) {
          const id = item.id;
          add(`folder:${id}`, folder.name, 'color', item.color, folder.color, async () => { this.service.folder(id).color = folder.color; });
        }
        if (folder.position !== undefined) addPosition(`folder:${item.id}`, this.service.state.finderPositions[`folder:${item.id}`] ?? null, folder.position);
        parentId = item.id;
      }
      return parentId;
    };
    const organize = (skillId, name, scopeId, input) => {
      const info = state.organization[skillId] ?? { folderId: null, tags: [] };
      if (input.folder !== undefined) {
        const folderId = ensureFolders(scopeId, input.folder);
        add(`skill:${skillId}`, name, 'folder', this.folderPath(info.folderId, state).map(folder => folder.name), input.folder.map(folder => folder.name), async () => {
          this.service.state.organization[skillId] = { ...(this.service.state.organization[skillId] ?? { tags: [] }), folderId };
        });
      }
      if (input.tags !== undefined) add(`skill:${skillId}`, name, 'tags', info.tags, input.tags, async () => { this.service.state.organization[skillId] = { ...(this.service.state.organization[skillId] ?? { folderId: null }), tags: clone(input.tags) }; });
      if (input.position !== undefined) addPosition(`skill:${skillId}`, this.service.state.finderPositions[`skill:${skillId}`] ?? null, input.position);
    };
    for (const incoming of document.skills) {
      const candidates = incoming.identity === null ? [] : context.installed.filter(entry => installedKey(entry.portable) === installedKey(incoming));
      if (candidates.length !== 1 || incomingCounts.get(installedKey(incoming)) !== 1) { preview.skipped++; continue; }
      preview.matched++;
      const { skill, source, portable } = candidates[0];
      matchedInstalled.add(skill.id);
      const before = operations.length;
      organize(skill.id, skill.name, skill.scopeId, incoming);
      for (const [language, translation] of Object.entries(incoming.translations)) {
        if (translation.sourceDescription !== source.description) { staleTranslations++; continue; }
        const local = portable.translations[language];
        if (sameTranslation(local, translation)) continue;
        add(`skill:${skill.id}`, skill.name, `translation:${language}`, local?.content ?? '', translation.content, async transaction => {
          transaction.translations ??= [];
          transaction.translations.push({ skillId: skill.id, language, translation: clone(translation), sourceDigest: source.sourceDigest });
        });
      }
      if (operations.length !== before) changedInstalled.add(skill.id);
    }
    for (const incoming of document.packs ?? []) {
      const pack = ensurePack(incoming.name, incoming.description);
      const before = operations.length;
      add(`pack:${pack.id}`, pack.name, 'description', pack.description, incoming.description, async () => { this.service.pack(pack.id).description = incoming.description; });
      for (const folder of incoming.folders ?? (incoming.groups ?? []).map(name => ({ path: [name] }))) {
        const pathFolders = folder.path.map(name => ({ name }));
        pathFolders[pathFolders.length - 1] = { name: folder.path.at(-1), ...folder };
        ensureFolders(`pack:${pack.id}`, pathFolders);
      }
      if (operations.length !== before) changedPacks.add(pack.id);
    }
    const references = [];
    const used = new Set();
    for (const incoming of document.managedSkills ?? []) {
      const pack = ensurePack(incoming.packName ?? 'Default');
      const candidates = context.managed.filter(entry => incoming.copyId ? entry.portable.copyId === incoming.copyId && portableKey(entry.portable.packName) === portableKey(incoming.packName ?? 'Default') : entry.skill.packId === pack.id && entry.portable.name === incoming.name && (incoming.identity ? entry.portable.identity === incoming.identity : entry.portable.fingerprint === incoming.fingerprint));
      if (candidates.length > 1 || (candidates[0] && used.has(candidates[0].skill.id))) { preview.managedSkills.skipped.push(incoming.name); continue; }
      let skill = candidates[0]?.skill;
      if (!skill) {
        const id = randomUUID();
        skill = { id, name: incoming.name, slug: slug(incoming.name), description: incoming.description, path: path.join(this.service.skillDir, id), packId: pack.id, scopeId: `pack:${pack.id}`, sourcePath: '', sourceLabel: 'Desktop sync', sourceScope: incoming.sourceScope, agents: [], importedAt: date(), deployments: [], syncCopyId: incoming.copyId ?? id, syncIdentity: incoming.identity ?? incoming.fingerprint };
        const created = clone(skill);
        state.managedSkills.push(created); preview.managedSkills.added++;
        changedPacks.add(pack.id);
        operations.push({ conflict: null, action: async transaction => { await this.writeFiles(created.path, incoming.files, transaction); this.service.state.managedSkills.push(clone(created)); this.service.state.organization[created.id] = { folderId: null, tags: [] }; } });
      } else {
        used.add(skill.id);
        if (candidates[0].portable.contentHash !== incoming.contentHash || skill.name !== incoming.name || skill.description !== incoming.description) {
          preview.managedSkills.updated++;
          changedPacks.add(pack.id);
        } else preview.managedSkills.unchanged++;
        const id = skill.id;
        if (candidates[0].portable.contentHash !== incoming.contentHash) {
          if (skill.deployments.some(item => item.mode === 'symlink')) preview.warnings.push(`更新 ${skill.name} 的文件前，请先移除正在使用它的链接部署。`);
          add(`skill:${id}`, skill.name, 'files', candidates[0].portable.contentHash, incoming.contentHash, async transaction => {
            const current = this.service.managed(id);
            await this.service.assertNoLiveLink(current);
            // Stash the original tree and restore it if any later write or state save fails.
            const expected = await this.service.treeFingerprint(current.path, LIMITS);
            if (managedFilesHash(await readFiles(current.path, { bytes: 0, files: 0 })) !== candidates[0].portable.contentHash) fail('Managed Skill changed; preview again.', 409);
            await this.service.stageDelete(current.path, transaction, expected, null, LIMITS);
            await this.writeFiles(current.path, incoming.files, transaction);
          });
        }
        for (const field of ['name', 'description']) add(`skill:${id}`, skill.name, field, skill[field], incoming[field], async () => { this.service.managed(id)[field] = incoming[field]; });
      }
      references.push({ skill, incoming });
    }
    for (const incomingPack of document.packs ?? []) {
      const pack = packs.get(portableKey(incomingPack.name));
      for (const member of incomingPack.skills) {
        const candidates = references.filter(entry => entry.skill.packId === pack.id && (member.copyId ? entry.incoming.copyId === member.copyId : entry.incoming.name === member.name && ((member.identity && entry.incoming.identity === member.identity) || (member.fingerprint && entry.incoming.fingerprint === member.fingerprint))));
        // Metadata-only legacy documents can organize existing independent copies.
        if (!candidates.length) for (const entry of context.managed) if (entry.skill.packId === pack.id && (member.copyId ? entry.portable.copyId === member.copyId : entry.portable.name === member.name && ((member.identity && entry.portable.identity === member.identity) || (member.fingerprint && entry.portable.fingerprint === member.fingerprint)))) candidates.push({ skill: entry.skill });
        if (candidates.length !== 1) {
          preview.packs.skippedMembers.push({ packName: incomingPack.name, skillName: member.name, reason: candidates.length > 1 ? 'ambiguous' : !member.identity && !member.fingerprint ? 'no-identity' : 'not-found' });
          continue;
        }
        preview.packs.matchedMembers++;
        const memberPath = member.folderPath !== undefined ? member.folderPath : member.group !== undefined ? (member.group === null ? null : [member.group]) : undefined;
        const before = operations.length;
        organize(candidates[0].skill.id, member.name, `pack:${pack.id}`, { ...(memberPath !== undefined ? { folder: (memberPath ?? []).map(name => ({ name })) } : {}), ...(member.tags !== undefined ? { tags: member.tags } : {}), ...(member.position !== undefined ? { position: member.position } : {}) });
        if (operations.length !== before) changedPacks.add(pack.id);
      }
    }
    // Repeated folders can appear on many Skills; present each conflict just once.
    preview.conflicts = [...new Map(preview.conflicts.map(conflict => [conflict.id, conflict])).values()];
    if (preview.skipped) preview.warnings.push(`${preview.skipped} 项未找到唯一匹配的 Skill，已跳过。`);
    if (staleTranslations) preview.warnings.push(`${staleTranslations} 项译文对应的原始描述已变化，已跳过。`);
    if (preview.managedSkills.skipped.length || preview.packs.skippedMembers.length) preview.warnings.push('部分 Pack 内容未找到唯一匹配项，已跳过。');
    preview.changed = changedInstalled.size;
    preview.unchanged = preview.matched - preview.changed;
    preview.localOnly = context.installed.filter(entry => !matchedInstalled.has(entry.skill.id)).length;
    preview.packs.changed = (document.packs ?? []).filter(pack => changedPacks.has(packs.get(portableKey(pack.name))?.id)).length;
    this.remember(preview, { revision: context.revision, operations, remote });
    return clone(preview);
  }

  remember(preview, data) {
    if (this.pending.size >= 20) this.pending.delete(this.pending.keys().next().value);
    this.pending.set(preview.id, { preview: clone(preview), ...data, createdAt: Date.now(), configurationRevision: this.configurationRevision });
  }

  async previewPull() {
    if (!this.webdav) fail('WebDAV sync is unavailable.', 503);
    const remote = await this.webdav.read();
    if (!remote.contents) fail('Cloud has no shared sync snapshot yet.', 404);
    const document = this.expandLegacyCopies(parseSyncDocument(remote.contents));
    return this.ai.withSync(async () => {
      await this.persistIdentities();
      return this.service.read(async () => this.storeImport(document, await this.context(), remote));
    });
  }

  async previewUpload() {
    if (!this.webdav) fail('WebDAV sync is unavailable.', 503);
    const remote = await this.webdav.read();
    const document = remote.contents ? this.expandLegacyCopies(parseSyncDocument(remote.contents)) : { format: 'skill-shelf-metadata', version: 5, exportedAt: date(), skills: [], preferences: {}, packs: [], managedSkills: [] };
    if (document.version === 3 && document.aiConnections !== undefined) fail('Migrate this encrypted legacy snapshot using the desktop client before uploading from the plugin.', 409);
    return this.ai.withSync(async () => {
      await this.persistIdentities();
      const account = await this.accountRevision();
      return this.service.read(async () => {
        const context = await this.context();
        const preview = this.previewResult('upload', document, context);
        const merged = clone(document);
        merged.version = 5; merged.exportedAt = context.document.exportedAt; merged.source = context.document.source;
        merged.packs ??= []; merged.managedSkills ??= [];
        const operations = [];
        const changed = new Set();
        const changedInstalled = new Set();
        const changedPacks = new Set();
        const choose = (target, field, local, incoming, key, name, compare = equal) => {
          if (compare(local, incoming)) return;
          changed.add(key);
          if (empty(incoming)) { target[field] = clone(local); return; }
          const conflict = this.choice(preview, `${key}:${field}`, name, field, local, incoming);
          const previous = clone(incoming);
          operations.push({ conflict, action: () => { target[field] = clone(local); }, undo: () => { target[field] = clone(previous); } });
        };
        const installedFolderKey = (skill, names) => JSON.stringify([skill.scope, skill.projectName ?? null, folderKey(names)]);
        const cloudFolders = new Map();
        for (const skill of document.skills) skill.folder.forEach((folder, index) => {
          cloudFolders.set(installedFolderKey(skill, skill.folder.slice(0, index + 1).map(item => item.name)), folder);
        });
        const cloudLayout = (skill, preserveFolder = false) => skill.folder.map((folder, index) => {
          const remoteFolder = cloudFolders.get(installedFolderKey(skill, skill.folder.slice(0, index + 1).map(item => item.name)));
          if (!remoteFolder) return clone(folder);
          return preserveFolder ? clone(remoteFolder) : { ...clone(remoteFolder), ...folder, position: clone(remoteFolder.position) };
        });
        const folderDetails = folders => folders.map(folder => ({ name: folder.name, color: folder.color }));
        for (const local of context.document.skills) {
          const candidates = merged.skills.filter(skill => installedKey(skill) === installedKey(local));
          if (candidates.length > 1) { preview.skipped++; continue; }
          if (!candidates.length) { merged.skills.push({ ...clone(local), folder: cloudLayout(local, true) }); preview.added++; continue; }
          preview.matched++;
          const target = candidates[0];
          choose(target, 'tags', local.tags, target.tags, installedKey(local), local.name);
          choose(target, 'folder', cloudLayout(local), target.folder, installedKey(local), local.name, (left, right) => equal(folderDetails(left), folderDetails(right)));
          for (const [language, translation] of Object.entries(local.translations)) {
            const incoming = target.translations[language];
            if (sameTranslation(translation, incoming)) continue;
            changed.add(installedKey(local));
            if (!incoming || incoming.sourceDescription !== translation.sourceDescription) {
              target.translations[language] = clone(translation);
              continue;
            }
            const conflict = this.choice(preview, `${installedKey(local)}:translation:${language}`, local.name, `translation:${language}`, translation.content, incoming.content);
            const previous = clone(incoming);
            operations.push({ conflict, action: () => { target.translations[language] = clone(translation); }, undo: () => { target.translations[language] = clone(previous); } });
          }
          if (changed.has(installedKey(local))) changedInstalled.add(installedKey(local));
        }
        for (const local of context.document.managedSkills) {
          let candidates = merged.managedSkills.filter(skill => copyKey(skill) === copyKey(local));
          if (!candidates.length) {
            candidates = merged.managedSkills.filter(skill => portableKey(skill.packName ?? 'Default') === portableKey(local.packName) && (!skill.copyId || !local.copyId) && sameReference(skill, local));
            if (candidates.length === 1 && context.document.managedSkills.filter(skill => portableKey(skill.packName) === portableKey(candidates[0].packName ?? 'Default') && memberMatches(skill, candidates[0])).length !== 1) candidates = [];
          }
          if (!candidates.length) { merged.managedSkills.push(clone(local)); preview.managedSkills.added++; changedPacks.add(portableKey(local.packName)); continue; }
          if (candidates.length > 1) { preview.managedSkills.skipped.push(local.name); continue; }
          const target = candidates[0];
          if (target.contentHash !== local.contentHash || target.name !== local.name || target.description !== local.description) {
            preview.managedSkills.updated++;
            changedPacks.add(portableKey(local.packName));
          } else preview.managedSkills.unchanged++;
          if (!target.copyId && local.copyId) target.copyId = local.copyId;
          if (target.contentHash !== local.contentHash) {
            changed.add(copyKey(local));
            const conflict = this.choice(preview, `${copyKey(local)}:files`, local.name, 'files', local.contentHash, target.contentHash);
            const previous = { files: clone(target.files), contentHash: target.contentHash, fingerprint: target.fingerprint };
            operations.push({ conflict, action: () => { target.files = clone(local.files); target.contentHash = local.contentHash; target.fingerprint = local.fingerprint; }, undo: () => Object.assign(target, clone(previous)) });
          }
          for (const field of ['name', 'description']) choose(target, field, local[field], target[field], copyKey(local), local.name);
        }
        for (const local of context.document.packs) {
          let target = merged.packs.find(pack => portableKey(pack.name) === portableKey(local.name));
          if (!target) { merged.packs.push(clone(local)); changedPacks.add(portableKey(local.name)); continue; }
          const key = `pack:${portableKey(local.name)}`;
          if (!equal(local.description, target.description)) changedPacks.add(portableKey(local.name));
          choose(target, 'description', local.description, target.description, key, local.name);
          // Normalize legacy groups to folders while preserving desktop view preferences.
          if (target.groups) { target.folders = target.groups.map(name => ({ path: [name] })); delete target.groups; for (const member of target.skills) if (member.group !== undefined) { member.folderPath = member.group === null ? null : [member.group]; delete member.group; } }
          target.folders ??= [];
          for (const folder of local.folders) {
            const existing = target.folders.find(item => folderKey(item.path) === folderKey(folder.path));
            if (!existing) { target.folders.push(clone(folder)); changedPacks.add(portableKey(local.name)); continue; }
            if (!equal(folder.color, existing.color)) changedPacks.add(portableKey(local.name));
            choose(existing, 'color', folder.color, existing.color, `${key}:${folderKey(folder.path)}`, folder.path.at(-1));
          }
          for (const member of local.skills) {
            let candidates = target.skills.filter(item => member.copyId && item.copyId === member.copyId);
            if (!candidates.length) candidates = target.skills.filter(item => (!item.copyId || !member.copyId) && sameReference(item, member));
            if (candidates.length === 1 && local.skills.filter(item => memberMatches(item, candidates[0])).length !== 1) candidates = [];
            if (!candidates.length) { target.skills.push(clone(member)); changedPacks.add(portableKey(local.name)); continue; }
            if (candidates.length > 1) { preview.packs.skippedMembers.push({ packName: local.name, skillName: member.name, reason: 'ambiguous' }); continue; }
            preview.packs.matchedMembers++;
            const existing = candidates[0];
            if (!existing.copyId && member.copyId) existing.copyId = member.copyId;
            if (['folderPath', 'tags'].some(field => !equal(member[field], existing[field]))) changedPacks.add(portableKey(local.name));
            for (const field of ['folderPath', 'tags']) choose(existing, field, member[field], existing[field], `${key}:${member.copyId}`, member.name);
          }
        }
        preview.changed = changedInstalled.size;
        preview.unchanged = preview.matched - preview.changed;
        preview.localOnly = context.document.skills.length - preview.matched;
        preview.packs.changed = context.document.packs.filter(pack => changedPacks.has(portableKey(pack.name))).length;
        preview.conflicts = [...new Map(preview.conflicts.map(conflict => [conflict.id, conflict])).values()];
        if (preview.skipped) preview.warnings.push(`${preview.skipped} 项未找到唯一匹配的 Skill，已跳过。`);
        if (preview.managedSkills.skipped.length || preview.packs.skippedMembers.length) preview.warnings.push('部分 Pack 内容未找到唯一匹配项，已跳过。');
        parseSyncDocument(JSON.stringify(merged));
        this.remember(preview, { revision: context.revision, operations, merged, remote, account, backup: clone(context.document) });
        return clone(preview);
      });
    });
  }

  async accountRevision() {
    return JSON.stringify({ status: await this.webdav.getStatus(), revision: this.webdav.getRevision?.() ?? this.webdav.revision ?? this.webdav.configurationRevision ?? null, local: this.configurationRevision });
  }

  async apply(input) {
    return this.ai.withSync(() => this.applyLocked(input));
  }

  async applyLocked(input) {
    if (!input || typeof input !== 'object' || typeof input.previewId !== 'string') fail('Provide a sync preview ID.');
    const pending = this.pending.get(input.previewId);
    if (!pending || Date.now() - pending.createdAt > 30 * 60 * 1000 || pending.configurationRevision !== this.configurationRevision) fail('Sync preview has expired; preview again.', 409);
    const resolutions = input.resolutions ?? {};
    if (!resolutions || typeof resolutions !== 'object' || Array.isArray(resolutions)) fail('Invalid sync conflict resolutions.');
    const ids = new Set(pending.preview.conflicts.map(conflict => conflict.id));
    if (Object.keys(resolutions).some(id => !ids.has(id)) || [...ids].some(id => !['local', 'incoming'].includes(resolutions[id]))) fail('Choose local or incoming for every sync conflict.');
    if (pending.preview.mode === 'upload') {
      return this.service.read(async () => {
        if ((await this.context()).revision !== pending.revision || await this.accountRevision() !== pending.account) fail('Sync preview is stale; preview again.', 409);
        const currentRemote = await this.webdav.read();
        if (currentRemote.contents !== pending.remote.contents || currentRemote.etag !== pending.remote.etag || currentRemote.folderUrl !== pending.remote.folderUrl) fail('Cloud snapshot changed; preview again.', 409);
        for (const operation of pending.operations) operation.undo?.();
        for (const operation of pending.operations) if (!operation.conflict || resolutions[operation.conflict] === 'local') operation.action();
        const merged = clone(pending.merged);
        // Organization refers to the selected independent copy, never a separately chosen fingerprint.
        for (const pack of merged.packs ?? []) for (const member of pack.skills) {
          const candidates = merged.managedSkills.filter(skill => portableKey(skill.packName ?? 'Default') === portableKey(pack.name) && (member.copyId ? skill.copyId === member.copyId : skill.name === member.name && ((member.identity && skill.identity === member.identity) || (member.fingerprint && skill.fingerprint === member.fingerprint))));
          if (candidates.length === 1) Object.assign(member, { ...(candidates[0].copyId ? { copyId: candidates[0].copyId } : {}), name: candidates[0].name, identity: candidates[0].identity, fingerprint: candidates[0].fingerprint });
        }
        const contents = JSON.stringify(merged, null, 2);
        parseSyncDocument(contents);
        if (await this.accountRevision() !== pending.account) fail('Sync account changed; preview again.', 409);
        const result = await this.webdav.upload(contents, pending.remote, clone(pending.backup));
        this.pending.delete(input.previewId);
        return { uploaded: true, cloudBackupSaved: typeof result === 'boolean' ? result : Boolean(result?.cloudBackupSaved) };
      });
    }
    const snapshot = await this.service.mutate(async transaction => {
      if ((await this.context()).revision !== pending.revision) fail('Sync preview is stale; preview again.', 409);
      for (const operation of pending.operations) if (!operation.conflict || resolutions[operation.conflict] === 'incoming') await operation.action(transaction);
      if (transaction.translations?.length) await this.ai.applySyncedTranslations(transaction.translations, transaction);
    });
    this.pending.delete(input.previewId);
    return { snapshot };
  }

  async writeFiles(destination, files, transaction) {
    await fs.mkdir(destination, { recursive: false, mode: 0o700 });
    const ownership = await this.service.rememberCreation(destination, transaction, LIMITS);
    for (const file of files) {
      const location = path.join(destination, ...file.path.split('/'));
      await fs.mkdir(path.dirname(location), { recursive: true, mode: 0o700 });
      await fs.writeFile(location, Buffer.from(file.content, 'base64'), { flag: 'wx', mode: file.executable ? 0o700 : 0o600 });
    }
    await this.service.finishCreation(destination, ownership);
  }
}

async function serviceReadIdentity(root) {
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await fs.realpath(root) !== root) fail('Installed Skill directory changed during sync.', 409);
  const location = path.join(root, 'SKILL.md');
  const stat = await fs.lstat(location);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) fail('Installed SKILL.md is not a safe regular file.', 409);
  const handle = await fs.open(location, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameNode(opened, stat) || opened.size > MAX_FILE_BYTES) fail('Installed SKILL.md changed during sync.', 409);
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== opened.size || !sameNode(opened, await fs.lstat(location)) || !sameNode(rootStat, await fs.lstat(root)) || await fs.realpath(root) !== root) fail('Installed SKILL.md changed during sync.', 409);
    const bytes = buffer.subarray(0, length);
    return { identity: skillFingerprint([{ path: 'SKILL.md', content: bytes.toString('base64'), executable: false }]), text: bytes.toString('utf8') };
  } finally { await handle.close(); }
}
