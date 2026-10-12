import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ShelfService } from '../src/domain.mjs';
import { SyncService } from '../src/sync.mjs';
import { parseSyncDocument, managedFilesHash, skillFingerprint, MAX_FILE_BYTES } from '../src/sync-format.mjs';

const clone = value => structuredClone(value);
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shelf-sync-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, 'home');
  const skillDir = path.join(homeDir, '.agents/skills/demo');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: Demo\ndescription: Example\n---\n\nHello\n');
  await fs.writeFile(path.join(skillDir, 'run.sh'), '#!/bin/sh\necho demo\n', { mode: 0o755 });
  const service = new ShelfService({ dataDir: path.join(root, 'data'), homeDir, magpieDir: path.join(root, 'magpie') });
  await service.initialize();
  const sync = new SyncService({ service });
  return { root, homeDir, service, sync, skillDir };
}
async function second(f, t) {
  const service = new ShelfService({ dataDir: path.join(f.root, 'second'), homeDir: f.homeDir, magpieDir: path.join(f.root, 'magpie') });
  await service.initialize();
  return { service, sync: new SyncService({ service }) };
}
const choices = (preview, choice = 'incoming') => ({ previewId: preview.id, resolutions: Object.fromEntries(preview.conflicts.map(conflict => [conflict.id, choice])) });
function editFiles(skill, contents) {
  skill.files.find(file => file.path === 'SKILL.md').content = Buffer.from(contents).toString('base64');
  skill.fingerprint = skillFingerprint(skill.files);
  skill.contentHash = managedFilesHash(skill.files);
}
function cloud(sync, document) {
  const webdav = { revision: 0, contents: JSON.stringify(document), etag: '1', uploads: [], getStatus: () => ({ url: 'https://example.test/dav', username: 'demo', hasPassword: true }), read() { return Promise.resolve({ contents: this.contents, etag: this.etag, folderUrl: 'https://example.test/dav/SkillShelf/' }); }, upload(contents, previous, backup) { this.uploads.push({ contents, previous, backup }); this.contents = contents; return Promise.resolve(true); } };
  sync.webdav = webdav;
  return webdav;
}

test('v5 roundtrip synchronizes installed metadata, independent duplicate copies and empty nested Pack folders', async t => {
  const f = await fixture(t);
  const installed = f.service.skills[0];
  await f.service.createFolder({ name: 'Work', scopeId: 'global', parentId: null, color: '#123456' });
  const work = f.service.state.folders[0];
  await f.service.mutate(async () => { f.service.state.organization[installed.id] = { folderId: work.id, tags: ['coding'] }; f.service.state.finderPositions[`skill:${installed.id}`] = { x: 10, y: 20 }; });
  await f.service.importSkills('default', { skillIds: [installed.id] });
  await f.service.importSkills('default', { skillIds: [installed.id] });
  await f.service.createFolder({ name: 'Empty', scopeId: 'pack:default', parentId: null, color: '#112233' });
  const empty = f.service.state.folders.find(folder => folder.name === 'Empty');
  await f.service.createFolder({ name: 'Nested', scopeId: 'pack:default', parentId: empty.id, color: '#334455' });
  const document = await f.sync.exportDocument();
  assert.equal(document.version, 5);
  assert.notEqual(document.managedSkills[0].copyId, document.managedSkills[1].copyId);
  assert.deepEqual(parseSyncDocument(JSON.stringify(document)), document);
  assert(!JSON.stringify(document).includes(f.root));
  const other = await second(f, t);
  const preview = await other.sync.previewImport(document);
  assert.equal(preview.skipped, 0);
  await other.sync.apply(choices(preview));
  assert.equal(other.service.state.managedSkills.length, 2);
  assert.equal(other.service.state.folders.filter(folder => folder.scopeId === 'pack:default').length, 2);
  assert.deepEqual(other.service.state.organization[other.service.skills[0].id].tags, ['coding']);
  const again = await other.sync.previewImport(document);
  assert.equal(again.added, 0);
  assert.equal(again.changed, 0);
  assert.equal(again.conflicts.length, 0);
  await other.sync.apply(choices(again));
  assert.equal(other.service.state.managedSkills.length, 2);
  const copied = other.service.state.managedSkills[0];
  assert.equal(await fs.readFile(path.join(copied.path, 'run.sh'), 'utf8'), '#!/bin/sh\necho demo\n');
  assert((await fs.stat(path.join(copied.path, 'run.sh'))).mode & 0o111);
});

test('source identity and copy identity remain stable across restarts and content edits', async t => {
  const f = await fixture(t);
  await f.service.importSkills('default', { skillIds: [f.service.skills[0].id] });
  const first = await f.sync.exportDocument();
  await fs.appendFile(path.join(f.service.state.managedSkills[0].path, 'SKILL.md'), '\nChanged\n');
  const restarted = new ShelfService({ dataDir: f.service.dataDir, homeDir: f.homeDir, magpieDir: f.service.magpieDir });
  const document = await new SyncService({ service: restarted }).exportDocument();
  assert.equal(document.source.deviceId, first.source.deviceId);
  assert.equal(document.managedSkills[0].copyId, first.managedSkills[0].copyId);
  assert.equal(document.managedSkills[0].identity, first.managedSkills[0].identity);
  assert.notEqual(document.managedSkills[0].fingerprint, first.managedSkills[0].fingerprint);
  assert.equal((await fs.stat(path.join(f.service.dataDir, 'sync-device.json'))).mode & 0o777, 0o600);
});

test('conflicts require complete choices; local choice preserves data and incoming updates managed files only', async t => {
  const f = await fixture(t);
  await f.service.importSkills('default', { skillIds: [f.service.skills[0].id] });
  const document = await f.sync.exportDocument();
  await f.service.mutate(async () => { f.service.state.organization[f.service.skills[0].id] = { folderId: null, tags: ['local'] }; });
  document.skills[0].tags = ['incoming'];
  editFiles(document.managedSkills[0], '# Incoming\n');
  const preview = await f.sync.previewImport(document);
  assert(preview.conflicts.some(conflict => conflict.field === 'files'));
  assert(preview.conflicts.some(conflict => conflict.field === 'tags'));
  await assert.rejects(f.sync.apply({ previewId: preview.id, resolutions: {} }), /every sync conflict/);
  await f.sync.apply(choices(preview, 'local'));
  assert.deepEqual(f.service.state.organization[f.service.skills[0].id].tags, ['local']);
  const next = await f.sync.previewImport(document);
  await f.sync.apply(choices(next));
  assert.deepEqual(f.service.state.organization[f.service.skills[0].id].tags, ['incoming']);
  assert.equal(await fs.readFile(path.join(f.service.state.managedSkills[0].path, 'SKILL.md'), 'utf8'), '# Incoming\n');
  assert.equal(await fs.readFile(path.join(f.skillDir, 'SKILL.md'), 'utf8'), '---\nname: Demo\ndescription: Example\n---\n\nHello\n');
});

test('ambiguous, uninstalled and identity-less metadata is skipped without creating installed files', async t => {
  const f = await fixture(t);
  const document = await f.sync.exportDocument();
  document.skills[0].identity = null;
  document.skills.push({ ...clone(document.skills[0]), name: 'Missing', identity: `sha256:${'a'.repeat(64)}` });
  const preview = await f.sync.previewImport(document);
  assert.equal(preview.skipped, 2);
  await f.sync.apply(choices(preview));
  assert.equal(f.service.skills.length, 1);
});

test('previews reject stale metadata, managed files and one-shot reuse', async t => {
  const f = await fixture(t);
  await f.service.importSkills('default', { skillIds: [f.service.skills[0].id] });
  const document = await f.sync.exportDocument();
  const preview = await f.sync.previewImport(document);
  await fs.appendFile(path.join(f.service.state.managedSkills[0].path, 'run.sh'), 'echo stale\n');
  await assert.rejects(f.sync.apply(choices(preview)), /stale/);
  const next = await f.sync.previewImport(await f.sync.exportDocument());
  await f.service.createPack({ name: 'New' });
  await assert.rejects(f.sync.apply(choices(next)), /stale/);
  const final = await f.sync.previewImport(await f.sync.exportDocument());
  await f.sync.apply(choices(final));
  await assert.rejects(f.sync.apply(choices(final)), /expired/);
});

test('failed save rolls back created files and replaced trees atomically', async t => {
  const f = await fixture(t);
  await f.service.importSkills('default', { skillIds: [f.service.skills[0].id] });
  const document = await f.sync.exportDocument();
  const skill = f.service.state.managedSkills[0];
  const original = await fs.readFile(path.join(skill.path, 'SKILL.md'), 'utf8');
  editFiles(document.managedSkills[0], '# Replaced\n');
  const another = clone(document.managedSkills[0]); another.copyId = 'another'; document.managedSkills.push(another);
  const preview = await f.sync.previewImport(document);
  const save = f.service.save;
  f.service.save = async () => { throw new Error('Simulated save failure'); };
  await assert.rejects(f.sync.apply(choices(preview)), /Simulated save failure/);
  f.service.save = save;
  assert.equal(f.service.state.managedSkills.length, 1);
  assert.equal(await fs.readFile(path.join(skill.path, 'SKILL.md'), 'utf8'), original);
  assert.deepEqual((await fs.readdir(f.service.skillDir)).sort(), [skill.id]);
});

test('live symlink deployment blocks incoming managed replacement without modifying target', async t => {
  const f = await fixture(t);
  await f.service.importSkills('default', { skillIds: [f.service.skills[0].id] });
  const skill = f.service.state.managedSkills[0];
  await f.service.deploy({ skillIds: [skill.id], targetPath: path.join(f.root, 'deployed'), mode: 'symlink' });
  const document = await f.sync.exportDocument();
  editFiles(document.managedSkills[0], '# Changed\n');
  const preview = await f.sync.previewImport(document);
  assert(preview.warnings.some(warning => warning.includes('链接部署')));
  await assert.rejects(f.sync.apply(choices(preview)), /live symlink/);
  assert((await fs.lstat(skill.deployments[0].targetPath)).isSymbolicLink());
});

test('cloud upload preserves remote annotations, preferences, AI credentials, view options and remote-only copies', async t => {
  const f = await fixture(t);
  const document = await f.sync.exportDocument();
  document.skills[0].descriptions = { en: 'Desktop annotation' };
  document.skills[0].translations = { en: { content: 'Translation', sourceDescription: 'Description', translatedAt: new Date().toISOString() } };
  document.preferences = { language: 'zh-CN' };
  document.aiPreferences = { availableModels: { deepseek: [{ id: 'deepseek-chat', displayName: 'DeepSeek Chat' }] }, contextMode: 'skill-md', targetLanguage: 'en', models: Object.fromEntries(['analysis', 'chat', 'writing'].map(role => [role, { provider: 'deepseek', model: 'deepseek-chat' }])) };
  document.aiConnections = [{ provider: 'deepseek', enabled: true, apiKey: 'SECRET_API_KEY' }];
  document.skills.push({ ...clone(document.skills[0]), name: 'Remote only' });
  const webdav = cloud(f.sync, document);
  const preview = await f.sync.previewUpload();
  assert(!JSON.stringify(preview).includes('SECRET_API_KEY'));
  assert.deepEqual(preview.warnings, []);
  const result = await f.sync.apply(choices(preview, 'local'));
  assert.equal(result.uploaded, true);
  assert.equal(result.cloudBackupSaved, true);
  const uploaded = parseSyncDocument(webdav.contents);
  assert.deepEqual(uploaded.skills[0].descriptions, document.skills[0].descriptions);
  assert.deepEqual(uploaded.skills[0].translations, document.skills[0].translations);
  assert.deepEqual(uploaded.aiConnections, document.aiConnections);
  assert.deepEqual(uploaded.preferences, document.preferences);
  assert.equal(uploaded.skills.length, 2);
  assert.equal(webdav.uploads[0].backup.format, 'skill-shelf-metadata');
});

test('cloud uploads reject changed remote data and changed account configuration', async t => {
  const f = await fixture(t);
  const webdav = cloud(f.sync, await f.sync.exportDocument());
  const preview = await f.sync.previewUpload();
  webdav.etag = '2';
  await assert.rejects(f.sync.apply(choices(preview)), /Cloud snapshot changed/);
  const accountPreview = await f.sync.previewUpload();
  webdav.revision++;
  await assert.rejects(f.sync.apply(choices(accountPreview)), /stale/);
  assert.equal(webdav.uploads.length, 0);
});

test('legacy encrypted AI upload is rejected rather than re-labelled as v5', async t => {
  const f = await fixture(t);
  const document = await f.sync.exportDocument();
  delete document.managedSkills;
  document.version = 3;
  document.aiPreferences = { availableModels: { deepseek: [{ id: 'deepseek-chat', displayName: 'DeepSeek Chat' }] }, contextMode: 'skill-md', targetLanguage: 'en', models: Object.fromEntries(['analysis', 'chat', 'writing'].map(role => [role, { provider: 'deepseek', model: 'deepseek-chat' }])) };
  document.aiConnections = { cipher: 'aes-256-gcm', kdf: 'scrypt', salt: Buffer.alloc(16).toString('base64'), iv: Buffer.alloc(12).toString('base64'), tag: Buffer.alloc(16).toString('base64'), ciphertext: 'AA==' };
  cloud(f.sync, document);
  await assert.rejects(f.sync.previewUpload(), /Migrate/);
});

test('v5 validation rejects traversal, Windows names/collisions, invalid hashes and base64', async t => {
  const f = await fixture(t);
  await f.service.importSkills('default', { skillIds: [f.service.skills[0].id] });
  const document = await f.sync.exportDocument();
  for (const unsafe of ['../escape', '/escape', 'dir\\file', 'CON.txt', 'dir/name.', 'dir/name ', 'bad:stream', '.git/config', 'a//b']) {
    const value = clone(document); value.managedSkills[0].files[1].path = unsafe;
    assert.throws(() => parseSyncDocument(JSON.stringify(value)), /path|collision/);
  }
  for (const paths of [['a', 'a/b'], ['Dir/a', 'dir/b'], ['SKILL.md', 'skill.MD']]) {
    const value = clone(document);
    for (const name of paths) value.managedSkills[0].files.push({ path: name, content: '', executable: false });
    assert.throws(() => parseSyncDocument(JSON.stringify(value)), /collision|Duplicate/);
  }
  const invalid = clone(document); invalid.managedSkills[0].files[0].content = 'YQ=';
  assert.throws(() => parseSyncDocument(JSON.stringify(invalid)), /file/);
  const mismatched = clone(document); mismatched.managedSkills[0].contentHash = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => parseSyncDocument(JSON.stringify(mismatched)), /hashes/);
});

test('sync supports files larger than portable Pack legacy 4 MiB budget', async t => {
  const f = await fixture(t);
  await f.service.importSkills('default', { skillIds: [f.service.skills[0].id] });
  const document = await f.sync.exportDocument();
  document.managedSkills[0].files.push({ path: 'large.bin', content: Buffer.alloc(5 * 1024 * 1024, 7).toString('base64'), executable: false });
  document.managedSkills[0].files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  document.managedSkills[0].contentHash = managedFilesHash(document.managedSkills[0].files);
  const other = await second(f, t);
  const preview = await other.sync.previewImport(document);
  await other.sync.apply(choices(preview));
  assert.equal((await fs.stat(path.join(other.service.state.managedSkills[0].path, 'large.bin'))).size, 5 * 1024 * 1024);
  const exported = await other.sync.exportDocument();
  assert.equal(exported.managedSkills[0].contentHash, document.managedSkills[0].contentHash);
  const tooLarge = clone(document);
  tooLarge.managedSkills[0].files[0].content = Buffer.alloc(MAX_FILE_BYTES + 1).toString('base64');
  assert.throws(() => parseSyncDocument(JSON.stringify(tooLarge)), /file|limit/);
});

test('failed upload can retry with different resolutions without reusing previous local edits', async t => {
  const f = await fixture(t);
  await f.service.mutate(async () => { f.service.state.organization[f.service.skills[0].id] = { folderId: null, tags: ['local'] }; });
  const document = await f.sync.exportDocument(); document.skills[0].tags = ['remote'];
  const webdav = cloud(f.sync, document);
  const upload = webdav.upload;
  let fail = true;
  webdav.upload = function (...args) { if (fail) { fail = false; return Promise.reject(new Error('Offline')); } return upload.apply(this, args); };
  const preview = await f.sync.previewUpload();
  await assert.rejects(f.sync.apply(choices(preview, 'local')), /Offline/);
  await f.sync.apply(choices(preview, 'incoming'));
  assert.deepEqual(parseSyncDocument(webdav.contents).skills[0].tags, ['remote']);
});

test('cloud organization references follow the selected managed payload and empty local metadata can be chosen', async t => {
  const f = await fixture(t);
  await f.service.importSkills('default', { skillIds: [f.service.skills[0].id] });
  const document = await f.sync.exportDocument();
  const webdav = cloud(f.sync, document);
  await fs.appendFile(path.join(f.service.state.managedSkills[0].path, 'SKILL.md'), '\nLocal content update\n');
  const remote = clone(document); remote.skills[0].tags = ['remote']; webdav.contents = JSON.stringify(remote);
  const preview = await f.sync.previewUpload();
  assert(preview.conflicts.some(conflict => conflict.field === 'tags' && conflict.local === '[]'));
  await f.sync.apply(choices(preview, 'local'));
  const uploaded = parseSyncDocument(webdav.contents);
  assert.deepEqual(uploaded.skills[0].tags, []);
  assert.equal(uploaded.packs[0].skills[0].fingerprint, uploaded.managedSkills[0].fingerprint);
  assert.equal(uploaded.packs[0].skills[0].identity, uploaded.managedSkills[0].identity);
});

test('cloud backup contains the current device snapshot even for the first upload', async t => {
  const f = await fixture(t);
  const webdav = cloud(f.sync, await f.sync.exportDocument()); webdav.contents = null; webdav.etag = null;
  const preview = await f.sync.previewUpload();
  await f.sync.apply(choices(preview));
  assert.equal(webdav.uploads[0].backup.source.deviceId, parseSyncDocument(webdav.contents).source.deviceId);
  assert.equal(webdav.uploads[0].backup.skills.length, 1);
});

test('incoming file replacements support existing large files and roll back on failure', async t => {
  const f = await fixture(t);
  await f.service.importSkills('default', { skillIds: [f.service.skills[0].id] });
  const managed = f.service.state.managedSkills[0];
  await fs.writeFile(path.join(managed.path, 'large.bin'), Buffer.alloc(5 * 1024 * 1024, 7));
  const document = await f.sync.exportDocument();
  editFiles(document.managedSkills[0], '# Different\n');
  const preview = await f.sync.previewImport(document);
  await f.sync.apply(choices(preview));
  assert.equal(await fs.readFile(path.join(managed.path, 'SKILL.md'), 'utf8'), '# Different\n');
  assert.equal((await fs.stat(path.join(managed.path, 'large.bin'))).size, 5 * 1024 * 1024);
  editFiles(document.managedSkills[0], '# Failed\n');
  const retry = await f.sync.previewImport(document);
  f.service.save = async () => { throw new Error('Save failed'); };
  await assert.rejects(f.sync.apply(choices(retry)), /Save failed/);
  assert.equal(await fs.readFile(path.join(managed.path, 'SKILL.md'), 'utf8'), '# Different\n');
  assert.equal((await fs.stat(path.join(managed.path, 'large.bin'))).size, 5 * 1024 * 1024);
});

test('unknown source/folder/position fields cannot expose credentials in preview conflicts', async t => {
  const f = await fixture(t);
  await f.service.createFolder({ name: 'Local', scopeId: 'global' });
  await f.service.mutate(async () => { f.service.state.organization[f.service.skills[0].id] = { folderId: f.service.state.folders[0].id, tags: [] }; });
  const document = await f.sync.exportDocument();
  document.source.apiKey = 'SECRET';
  document.skills[0].folder[0].password = 'SECRET';
  document.skills[0].folder[0].name = 'Remote';
  document.skills[0].position = { x: 10, y: 20, password: 'SECRET' };
  cloud(f.sync, document);
  const preview = await f.sync.previewUpload();
  assert(!JSON.stringify(preview).includes('SECRET'));
});

test('sync folder choices do not prevent incoming Skill coordinates from applying', async t => {
  const f = await fixture(t);
  const id = f.service.skills[0].id;
  await f.service.mutate(async () => { f.service.state.finderPositions[`skill:${id}`] = { x: 30, y: 40 }; });
  const document = await f.sync.exportDocument();
  document.skills[0].folder = [{ name: 'Incoming', color: '#112233', position: null }];
  const preview = await f.sync.previewImport(document);
  await f.sync.apply(choices(preview));
  assert.deepEqual(f.service.state.finderPositions[`skill:${id}`], { x: 30, y: 40 });
  document.skills[0].folder = [{ name: 'Different', color: '#223344', position: null }];
  document.skills[0].position = { x: 50, y: 60 };
  const next = await f.sync.previewImport(document);
  assert(next.conflicts.some(conflict => conflict.field === 'folder'));
  assert(!next.conflicts.some(conflict => conflict.field === 'position'));
  await f.sync.apply(choices(next, 'local'));
  assert.deepEqual(f.service.state.finderPositions[`skill:${id}`], { x: 50, y: 60 });
  assert.equal(f.service.folder(f.service.state.organization[id].folderId).name, 'Incoming');
});

test('upload upgrades unique legacy copy-less payload and member instead of duplicating them', async t => {
  const f = await fixture(t);
  await f.service.importSkills('default', { skillIds: [f.service.skills[0].id] });
  const document = await f.sync.exportDocument();
  const copyId = document.managedSkills[0].copyId;
  delete document.managedSkills[0].copyId;
  delete document.packs[0].skills[0].copyId;
  const webdav = cloud(f.sync, document);
  const preview = await f.sync.previewUpload();
  await f.sync.apply(choices(preview, 'local'));
  const uploaded = parseSyncDocument(webdav.contents);
  assert.equal(uploaded.managedSkills.length, 1);
  assert.equal(uploaded.packs[0].skills.length, 1);
  assert.equal(uploaded.managedSkills[0].copyId, copyId);
  assert.equal(uploaded.packs[0].skills[0].copyId, copyId);
});

test('distinct modern copy IDs remain independent when uploading identical content', async t => {
  const f = await fixture(t);
  await f.service.importSkills('default', { skillIds: [f.service.skills[0].id] });
  const document = await f.sync.exportDocument();
  document.managedSkills[0].copyId = 'remote-copy';
  document.packs[0].skills[0].copyId = 'remote-copy';
  const webdav = cloud(f.sync, document);
  const preview = await f.sync.previewUpload();
  await f.sync.apply(choices(preview, 'local'));
  const uploaded = parseSyncDocument(webdav.contents);
  assert.equal(uploaded.managedSkills.length, 2);
  assert.equal(uploaded.packs[0].skills.length, 2);
});

test('legacy unowned managed payload expands independently for each referencing Pack and stays idempotent', async t => {
  const f = await fixture(t);
  await f.service.importSkills('default', { skillIds: [f.service.skills[0].id] });
  const document = await f.sync.exportDocument();
  delete document.managedSkills[0].packName;
  delete document.managedSkills[0].copyId;
  const member = clone(document.packs[0].skills[0]); delete member.copyId;
  document.packs = [ { name: 'One', description: 'First', folders: [], skills: [clone(member)] }, { name: 'Two', description: 'Second', folders: [], skills: [clone(member)] } ];
  const other = await second(f, t);
  const preview = await other.sync.previewImport(document);
  await other.sync.apply(choices(preview));
  assert.equal(other.service.state.managedSkills.length, 2);
  assert.deepEqual(other.service.state.managedSkills.map(skill => other.service.pack(skill.packId).name).sort(), ['One', 'Two']);
  const again = await other.sync.previewImport(document);
  assert.equal(again.added, 0);
  assert.equal(again.skipped, 0);
  await other.sync.apply(choices(again));
  assert.equal(other.service.state.managedSkills.length, 2);
});

test('desktop limits report offending Skill/Pack and actionable field limit', async t => {
  const f = await fixture(t);
  await f.service.mutate(async () => { f.service.state.organization[f.service.skills[0].id] = { folderId: null, tags: Array.from({ length: 13 }, (_, index) => `tag-${index}`) }; });
  await assert.rejects(f.sync.exportDocument(), /Demo:.*at most 12 tags/);
  await f.service.mutate(async () => { f.service.state.organization[f.service.skills[0].id].tags = []; });
  await f.service.createPack({ name: 'Too Detailed', description: 'a'.repeat(501) });
  await assert.rejects(f.sync.exportDocument(), /Too Detailed: Pack description.*500/);
});

test('bounded source lock identities interoperate with desktop GitHub and URL metadata, content revisions remain checked', async t => {
  const f = await fixture(t);
  const lock = path.join(f.homeDir, '.agents', '.skill-lock.json');
  await fs.writeFile(lock, JSON.stringify({ skills: { Demo: { source: 'Owner/Repo.git', sourceType: 'github' } } }));
  const document = await f.sync.exportDocument();
  assert.equal(document.skills[0].identity, 'github:owner/repo');
  await f.service.importSkills('default', { skillIds: [f.service.skills[0].id] });
  const managed = await f.sync.exportDocument();
  assert.equal(managed.managedSkills[0].identity, 'github:owner/repo');
  document.skills[0].tags = ['desktop'];
  const preview = await f.sync.previewImport(document);
  assert.equal(preview.matched, 1);
  await fs.appendFile(path.join(f.skillDir, 'SKILL.md'), '\nChanged\n');
  await assert.rejects(f.sync.apply(choices(preview)), /stale/);
  await fs.writeFile(lock, JSON.stringify({ skills: { Demo: { sourceUrl: 'https://skills.example.test/catalog/' } } }));
  assert.equal((await f.sync.exportDocument()).skills[0].identity, 'url:https://skills.example.test/catalog');
  await fs.writeFile(lock, '{');
  const fallback = await f.sync.previewImport(await f.sync.exportDocument());
  assert.deepEqual(fallback.warnings, []);
  await fs.writeFile(lock, 'x'.repeat(1024 * 1024 + 1));
  assert.match((await f.sync.exportDocument()).skills[0].identity, /^sha256:/);
});

async function positionedFixture(t) {
  const f = await fixture(t);
  const installed = f.service.skills[0];
  await f.service.importSkills('default', { skillIds: [installed.id] });
  await f.service.createFolder({ name: 'Work', scopeId: 'global', color: '#123456' });
  await f.service.createFolder({ name: 'Pack Work', scopeId: 'pack:default', color: '#234567' });
  const managed = f.service.state.managedSkills[0];
  const installedFolder = f.service.state.folders.find(folder => folder.scopeId === 'global');
  const packFolder = f.service.state.folders.find(folder => folder.scopeId === 'pack:default');
  await f.service.mutate(async () => {
    f.service.state.organization[installed.id] = { folderId: installedFolder.id, tags: ['local'] };
    f.service.state.organization[managed.id] = { folderId: packFolder.id, tags: ['local'] };
    for (const key of [`skill:${installed.id}`, `skill:${managed.id}`, `folder:${installedFolder.id}`, `folder:${packFolder.id}`]) {
      f.service.state.finderPositions[key] = { x: 10, y: 20 };
    }
  });
  return { ...f, installed, managed, installedFolder, packFolder };
}

function setDocumentPositions(document, position) {
  document.skills[0].position = clone(position);
  document.skills[0].folder[0].position = clone(position);
  document.packs[0].folders[0].position = clone(position);
  document.packs[0].skills[0].position = clone(position);
}

test('import and cloud pull apply layout-only changes on confirmation without position conflicts', async t => {
  for (const mode of ['import', 'pull']) {
    const f = await positionedFixture(t);
    const document = await f.sync.exportDocument();
    setDocumentPositions(document, { x: 80, y: 90 });
    document.skills[0].folder[0].viewOptions = { alignToGrid: true, useGroups: false, groupBy: 'name', sortBy: 'name', sortDirection: 'ascending', viewMode: 'list' };
    if (mode === 'pull') cloud(f.sync, document);
    const before = clone(f.service.state.finderPositions);
    const preview = mode === 'pull' ? await f.sync.previewPull() : await f.sync.previewImport(document);
    assert.equal(preview.conflicts.length, 0);
    assert.equal(preview.changed, 1);
    assert.equal(preview.packs.changed, 1);
    assert.equal(preview.managedSkills.updated, 0);
    assert.deepEqual(f.service.state.finderPositions, before);
    await f.sync.apply(choices(preview));
    for (const key of Object.keys(before)) assert.deepEqual(f.service.state.finderPositions[key], { x: 80, y: 90 });
  }
});

test('keeping local content and metadata still accepts cloud layout including cleared positions', async t => {
  const f = await positionedFixture(t);
  const document = await f.sync.exportDocument();
  setDocumentPositions(document, null);
  document.skills[0].tags = ['cloud'];
  document.skills[0].folder[0].color = '#abcdef';
  document.packs[0].folders[0].color = '#abcdef';
  document.packs[0].skills[0].tags = ['cloud'];
  document.managedSkills[0].description = 'Cloud description';
  editFiles(document.managedSkills[0], '# Cloud content\n');
  const original = await fs.readFile(path.join(f.managed.path, 'SKILL.md'), 'utf8');
  const preview = await f.sync.previewImport(document);
  assert(preview.conflicts.some(conflict => conflict.field === 'files'));
  assert(preview.conflicts.some(conflict => conflict.field === 'color'));
  assert(preview.conflicts.some(conflict => conflict.field === 'description'));
  assert(preview.conflicts.some(conflict => conflict.field === 'tags'));
  assert(!preview.conflicts.some(conflict => conflict.field === 'position'));
  await f.sync.apply(choices(preview, 'local'));
  assert.deepEqual(f.service.state.finderPositions, {});
  assert.deepEqual(f.service.state.organization[f.installed.id].tags, ['local']);
  assert.deepEqual(f.service.state.organization[f.managed.id].tags, ['local']);
  assert.equal(f.service.folder(f.installedFolder.id).color, '#123456');
  assert.equal(f.service.folder(f.packFolder.id).color, '#234567');
  assert.equal(await fs.readFile(path.join(f.managed.path, 'SKILL.md'), 'utf8'), original);
});

test('upload retains existing cloud layout including null and opaque folder view preferences without conflicts', async t => {
  for (const position of [null, { x: 80, y: 90 }]) {
    const f = await positionedFixture(t);
    const document = await f.sync.exportDocument();
    setDocumentPositions(document, position);
    document.skills[0].folder[0].viewOptions = { alignToGrid: true, useGroups: false, groupBy: 'name', sortBy: 'name', sortDirection: 'ascending', viewMode: 'list' };
    const webdav = cloud(f.sync, document);
    const before = clone(f.service.state.finderPositions);
    const preview = await f.sync.previewUpload();
    assert.equal(preview.conflicts.length, 0);
    assert.equal(preview.changed, 0);
    assert.deepEqual(f.service.state.finderPositions, before);
    await f.sync.apply(choices(preview, 'local'));
    const uploaded = parseSyncDocument(webdav.contents);
    assert.deepEqual(uploaded.skills[0].position, position);
    assert.deepEqual(uploaded.skills[0].folder[0], document.skills[0].folder[0]);
    assert.deepEqual(uploaded.packs[0].folders[0].position, position);
    assert.deepEqual(uploaded.packs[0].skills[0].position, position);
    assert.deepEqual(f.service.state.finderPositions, before);
  }
});

test('upload choices for actual folder details and tags preserve existing cloud folder layout', async t => {
  const f = await positionedFixture(t);
  const document = await f.sync.exportDocument();
  setDocumentPositions(document, null);
  document.skills[0].tags = ['cloud'];
  document.skills[0].folder[0].color = '#abcdef';
  document.skills[0].folder[0].viewOptions = { alignToGrid: true, useGroups: false, groupBy: 'name', sortBy: 'name', sortDirection: 'ascending', viewMode: 'list' };
  document.packs[0].folders[0].color = '#abcdef';
  document.packs[0].skills[0].tags = ['cloud'];
  const webdav = cloud(f.sync, document);
  const before = clone(f.service.state.finderPositions);
  const preview = await f.sync.previewUpload();
  const folderConflict = preview.conflicts.find(conflict => conflict.field === 'folder');
  assert(folderConflict);
  assert(!folderConflict.local.includes('position'));
  assert(!folderConflict.incoming.includes('viewOptions'));
  assert(preview.conflicts.some(conflict => conflict.field === 'tags'));
  assert(preview.conflicts.some(conflict => conflict.field === 'color'));
  assert(!preview.conflicts.some(conflict => conflict.field === 'position'));
  await f.sync.apply(choices(preview, 'local'));
  const uploaded = parseSyncDocument(webdav.contents);
  assert.deepEqual(uploaded.skills[0].tags, ['local']);
  assert.equal(uploaded.skills[0].folder[0].color, '#123456');
  assert.equal(uploaded.skills[0].folder[0].position, null);
  assert.deepEqual(uploaded.skills[0].folder[0].viewOptions, document.skills[0].folder[0].viewOptions);
  assert.equal(uploaded.packs[0].folders[0].color, '#234567');
  assert.equal(uploaded.packs[0].folders[0].position, null);
  assert.equal(uploaded.packs[0].skills[0].position, null);
  assert.deepEqual(f.service.state.finderPositions, before);
});

test('upload keeps local-only positions while reusing cloud layout for shared installed folder paths', async t => {
  const f = await positionedFixture(t);
  const document = await f.sync.exportDocument();
  setDocumentPositions(document, null);
  document.skills[0].name = 'Cloud-only Skill';
  document.packs[0].skills = [];
  document.managedSkills = [];
  const webdav = cloud(f.sync, document);
  await f.service.createFolder({ name: 'Local-only Folder', scopeId: 'pack:default' });
  const localFolder = f.service.state.folders.find(folder => folder.name === 'Local-only Folder');
  await f.service.mutate(async () => { f.service.state.finderPositions[`folder:${localFolder.id}`] = { x: 55, y: 65 }; });
  const preview = await f.sync.previewUpload();
  await f.sync.apply(choices(preview, 'local'));
  const uploaded = parseSyncDocument(webdav.contents);
  const localSkill = uploaded.skills.find(skill => skill.name === f.installed.name);
  assert.deepEqual(localSkill.position, { x: 10, y: 20 });
  assert.equal(localSkill.folder[0].position, null);
  assert.deepEqual(uploaded.packs[0].skills[0].position, { x: 10, y: 20 });
  assert.deepEqual(uploaded.packs[0].folders.find(folder => folder.path[0] === 'Local-only Folder').position, { x: 55, y: 65 });
});

test('new installed Skills reuse complete shared cloud folder records without introducing color conflicts', async t => {
  const f = await positionedFixture(t);
  const document = await f.sync.exportDocument();
  document.skills[0].name = 'Cloud-only Skill';
  const cloudFolder = document.skills[0].folder[0];
  cloudFolder.color = '#abcdef';
  cloudFolder.position = null;
  cloudFolder.viewOptions = { alignToGrid: false, useGroups: true, groupBy: 'tags', sortBy: 'name', sortDirection: 'descending', viewMode: 'columns' };
  const webdav = cloud(f.sync, document);
  const preview = await f.sync.previewUpload();
  assert.deepEqual(preview.conflicts, []);
  await f.sync.apply(choices(preview, 'local'));
  const uploaded = parseSyncDocument(webdav.contents);
  const newSkill = uploaded.skills.find(skill => skill.name === f.installed.name);
  const existingSkill = uploaded.skills.find(skill => skill.name === 'Cloud-only Skill');
  assert.deepEqual(newSkill.folder[0], cloudFolder);
  assert.deepEqual(existingSkill.folder[0], cloudFolder);
  assert.equal(f.service.folder(f.installedFolder.id).color, '#123456');
  assert.deepEqual(f.service.state.finderPositions[`folder:${f.installedFolder.id}`], { x: 10, y: 20 });
});

test('sync uses the same canonical installed catalog as the library and preserves per-installation metadata', async t => {
  const f = await fixture(t);
  const cursor = path.join(f.homeDir, '.cursor/skills/demo');
  const builtin = path.join(f.homeDir, '.codex/skills/.system/builtin');
  await fs.mkdir(cursor, { recursive: true });
  await fs.writeFile(path.join(cursor, 'SKILL.md'), await fs.readFile(path.join(f.skillDir, 'SKILL.md')));
  await fs.mkdir(builtin, { recursive: true });
  await fs.writeFile(path.join(builtin, 'SKILL.md'), '---\nname: Builtin\ndescription: System\n---\nSystem\n');
  const snapshot = await f.service.rescan();
  assert.equal(snapshot.skills.length, 1);
  assert.equal(snapshot.skills[0].installations.length, 2);
  const cursorPath = await fs.realpath(cursor);
  const variant = snapshot.skills[0].installations.find(item => item.path === cursorPath);
  await f.service.organize({ ids: [variant.id], tags: ['variant'] });
  const document = await f.sync.exportDocument();
  assert.equal(document.skills.length, snapshot.skills.length);
  document.skills[0].tags = ['cloud'];
  const preview = await f.sync.previewImport(document);
  assert.equal(preview.total, 1);
  assert.equal(preview.matched, 1);
  assert.equal(preview.changed, 1);
  assert.equal(preview.skipped, 0);
  await f.sync.apply(choices(preview));
  assert.deepEqual(f.service.state.organization[f.service.skills[0].id].tags, ['cloud']);
  assert.deepEqual(f.service.state.organization[variant.id].tags, ['variant']);
  assert.equal((await f.service.snapshot()).skills[0].installations.length, 2);
});

test('duplicate installed metadata references are skipped like the desktop without applying one twice', async t => {
  const f = await fixture(t);
  const document = await f.sync.exportDocument();
  document.skills.push(clone(document.skills[0]));
  document.skills[0].tags = ['first'];
  document.skills[1].tags = ['second'];
  const preview = await f.sync.previewImport(document);
  assert.equal(preview.total, 2);
  assert.equal(preview.matched, 0);
  assert.equal(preview.changed, 0);
  assert.equal(preview.skipped, 2);
  assert.equal(preview.localOnly, 1);
  await f.sync.apply(choices(preview));
  assert.equal(f.service.state.organization[f.service.skills[0].id], undefined);
});

test('import summaries keep installed Skills separate from Pack folders, members and managed file changes', async t => {
  const f = await fixture(t);
  await f.service.importSkills('default', { skillIds: [f.service.skills[0].id] });
  await f.service.importSkills('default', { skillIds: [f.service.skills[0].id] });
  const document = await f.sync.exportDocument();
  document.packs[0].description = 'Incoming Pack description';
  document.packs[0].folders.push({ path: ['New'] }, { path: ['New', 'Nested'], color: '#123456', position: { x: 1, y: 2 } });
  document.packs[0].skills[0].folderPath = ['New', 'Nested'];
  document.packs[0].skills.push({ name: 'Missing member', identity: null, fingerprint: null });
  editFiles(document.managedSkills[0], '---\nname: Demo\ndescription: Example\n---\nUpdated managed files\n');
  const preview = await f.sync.previewImport(document);
  assert.deepEqual({ total: preview.total, matched: preview.matched, changed: preview.changed, unchanged: preview.unchanged, skipped: preview.skipped, added: preview.added }, { total: 1, matched: 1, changed: 0, unchanged: 1, skipped: 0, added: 0 });
  assert.deepEqual(preview.managedSkills, { total: 2, added: 0, updated: 1, unchanged: 1, skipped: [] });
  assert.deepEqual(preview.packs, { total: 1, changed: 1, matchedMembers: 2, skippedMembers: [{ packName: 'Default', skillName: 'Missing member', reason: 'no-identity' }] });
  await f.sync.apply(choices(preview));
  assert.equal(f.service.skills.length, 1);
  assert.equal(f.service.state.managedSkills.length, 2);
  assert.equal(f.service.state.folders.length, 2);
});

test('upload summaries count new installed metadata separately from Packs and independent copies', async t => {
  const f = await fixture(t);
  await f.service.importSkills('default', { skillIds: [f.service.skills[0].id] });
  await f.service.importSkills('default', { skillIds: [f.service.skills[0].id] });
  await f.service.createFolder({ name: 'Empty folder', scopeId: 'pack:default' });
  await f.service.createPack({ name: 'Empty Pack' });
  const empty = await f.sync.exportDocument();
  empty.skills = []; empty.packs = []; empty.managedSkills = [];
  cloud(f.sync, empty);
  let preview = await f.sync.previewUpload();
  assert.deepEqual({ total: preview.total, matched: preview.matched, changed: preview.changed, skipped: preview.skipped, added: preview.added }, { total: 1, matched: 0, changed: 0, skipped: 0, added: 1 });
  assert.deepEqual(preview.managedSkills, { total: 2, added: 2, updated: 0, unchanged: 0, skipped: [] });
  assert.equal(preview.packs.total, 2);
  assert.equal(preview.packs.changed, 2);
  await f.sync.apply(choices(preview, 'local'));
  preview = await f.sync.previewUpload();
  assert.deepEqual({ matched: preview.matched, changed: preview.changed, skipped: preview.skipped, added: preview.added }, { matched: 1, changed: 0, skipped: 0, added: 0 });
  assert.deepEqual(preview.managedSkills, { total: 2, added: 0, updated: 0, unchanged: 2, skipped: [] });
  assert.equal(preview.packs.changed, 0);
  assert.equal(preview.packs.matchedMembers, 2);
});

test('import and pull count a Pack as changed for managed file, name or description changes alone', async t => {
  for (const mode of ['import', 'pull']) {
    for (const field of ['files', 'name', 'description']) {
      const f = await fixture(t);
      await f.service.importSkills('default', { skillIds: [f.service.skills[0].id] });
      const document = await f.sync.exportDocument();
      if (field === 'files') editFiles(document.managedSkills[0], '---\nname: Demo\ndescription: Example\n---\nChanged files only\n');
      else document.managedSkills[0][field] = `Changed ${field} only`;
      const before = clone(f.service.state);
      if (mode === 'pull') cloud(f.sync, document);
      const preview = mode === 'pull' ? await f.sync.previewPull() : await f.sync.previewImport(document);
      assert.equal(preview.packs.total, 1, `${mode}/${field}`);
      assert.equal(preview.packs.changed, 1, `${mode}/${field}`);
      assert.equal(preview.packs.matchedMembers, 1, `${mode}/${field}`);
      assert.deepEqual(preview.managedSkills, { total: 1, added: 0, updated: 1, unchanged: 0, skipped: [] }, `${mode}/${field}`);
      assert.equal(preview.matched, 1, `${mode}/${field}`);
      assert.equal(preview.changed, 0, `${mode}/${field}`);
      assert.deepEqual(f.service.state, before, `${mode}/${field}: preview must not apply changes`);
      await f.sync.apply(choices(preview));
      const again = mode === 'pull' ? await f.sync.previewPull() : await f.sync.previewImport(document);
      assert.equal(again.packs.changed, 0, `${mode}/${field}: repeated preview`);
      assert.equal(again.managedSkills.updated, 0, `${mode}/${field}: repeated preview`);
      assert.equal(again.managedSkills.unchanged, 1, `${mode}/${field}: repeated preview`);
    }
  }
});
