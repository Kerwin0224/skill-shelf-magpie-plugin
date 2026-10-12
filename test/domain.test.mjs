import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ShelfService, ShelfError } from '../src/domain.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'shelf-domain-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, 'home');
  const dataDir = path.join(root, 'data');
  const magpieDir = path.join(root, 'magpie');
  await fs.mkdir(homeDir);
  const service = new ShelfService({ homeDir, dataDir, magpieDir });
  return { root, homeDir, dataDir, magpieDir, service };
}

async function skill(root, name = 'alpha', content = 'original') {
  const location = path.join(root, name);
  await fs.mkdir(path.join(location, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(location, 'SKILL.md'), `---\nname: ${name}\ndescription: A useful skill\n---\n# ${name}\n${content}\n`);
  await fs.writeFile(path.join(location, 'scripts', 'run.sh'), `#!/bin/sh\necho ${content}\n`, { mode: 0o755 });
  await fs.writeFile(path.join(location, 'asset.bin'), Buffer.from([0, 255, 17]));
  return location;
}

async function imported(t, name = 'alpha') {
  const f = await fixture(t);
  f.source = await skill(path.join(f.homeDir, '.agents', 'skills'), name);
  let snapshot = await f.service.initialize();
  f.original = snapshot.skills[0];
  snapshot = await f.service.importSkills('default', { skillIds: [f.original.id] });
  f.managed = snapshot.managedSkills[0];
  return f;
}

const status = (expected) => (error) => error instanceof ShelfError && error.status === expected;
const exists = async (location) => { try { await fs.lstat(location); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

test('opening a Skill folder resolves only known canonical installed and managed directories without writes', async (t) => {
  const f = await imported(t);
  const beforeState = await fs.readFile(f.service.stateFile);
  const beforeSource = await fs.readFile(path.join(f.source, 'SKILL.md'));
  const beforeStat = await fs.lstat(f.source);
  const opened = [];
  for (const item of [f.original, f.managed]) {
    assert.deepEqual(await f.service.openSkillFolder({ id: item.id }, async directory => { opened.push(directory); }), { opened: true });
  }
  assert.deepEqual(opened, [f.source, f.managed.path]);
  assert.deepEqual(await fs.readFile(f.service.stateFile), beforeState);
  assert.deepEqual(await fs.readFile(path.join(f.source, 'SKILL.md')), beforeSource);
  const afterStat = await fs.lstat(f.source);
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
  assert.equal(afterStat.mode, beforeStat.mode);
});

test('opening a Skill folder rejects arbitrary paths, extra arguments and missing or symlink-replaced directories before launch', async (t) => {
  const f = await imported(t);
  let opened = 0;
  const opener = async () => { opened += 1; };
  for (const input of [null, [], {}, { id: '' }, { id: 123 }, { id: f.original.id, path: f.root }, { path: f.source }, { id: f.original.id, extra: true }]) {
    await assert.rejects(f.service.openSkillFolder(input, opener), status(400));
  }
  for (const id of ['missing', f.root, f.source]) await assert.rejects(f.service.openSkillFolder({ id }, opener), status(404));
  await fs.rename(f.source, `${f.source}.backup`);
  await assert.rejects(f.service.openSkillFolder({ id: f.original.id }, opener), status(409));
  await fs.writeFile(f.source, 'not a directory');
  await assert.rejects(f.service.openSkillFolder({ id: f.original.id }, opener), status(409));
  await fs.unlink(f.source);
  await fs.symlink(f.root, f.source);
  await assert.rejects(f.service.openSkillFolder({ id: f.original.id }, opener), status(409));
  assert.equal(opened, 0);
});

test('folder launch is serialized with service changes and opener failures propagate without poisoning the read queue', async (t) => {
  const f = await imported(t);
  let release;
  let launched;
  const pending = new Promise(accept => { release = accept; });
  const started = new Promise(accept => { launched = accept; });
  const opening = f.service.openSkillFolder({ id: f.original.id }, async () => { launched(); await pending; });
  await started;
  let rescanned = false;
  const rescanning = f.service.rescan().then(() => { rescanned = true; });
  await new Promise(accept => setImmediate(accept));
  assert.equal(rescanned, false);
  release();
  await Promise.all([opening, rescanning]);
  const failure = new Error('Native launch failed.');
  await assert.rejects(f.service.openSkillFolder({ id: f.original.id }, async () => { throw failure; }), error => error === failure);
  assert.deepEqual(await f.service.openSkillFolder({ id: f.original.id }, async () => {}), { opened: true });
});

test('folder creation saves the requested canvas point atomically and rejects invalid positions', async (t) => {
  const f = await fixture(t);
  await f.service.initialize();
  const point = { x: 348, y: 512 };
  const created = await f.service.createFolder({ name: 'At cursor', scopeId: 'global', position: point });
  const folder = created.folders.find(item => item.name === 'At cursor');
  assert.deepEqual(created.finderPositions[`folder:${folder.id}`], point);
  const reloaded = new ShelfService({ dataDir: f.dataDir, homeDir: f.homeDir, magpieDir: f.magpieDir });
  assert.deepEqual((await reloaded.initialize()).finderPositions[`folder:${folder.id}`], point);
  for (const invalid of [{ x: -1, y: 0 }, { x: 100001, y: 0 }, { x: 0, y: '2' }, { x: 0, y: 0, extra: true }]) {
    await assert.rejects(f.service.createFolder({ name: 'Invalid cursor', scopeId: 'global', position: invalid }), status(400));
  }
  assert.equal((await f.service.snapshot()).folders.some(item => item.name === 'Invalid cursor'), false);
});

test('scans preset agent and Magpie roots, canonical dedup merges aliases, IDs stay stable', async (t) => {
  const f = await fixture(t);
  const source = await skill(path.join(f.homeDir, '.agents', 'skills'));
  await fs.mkdir(path.join(f.homeDir, '.claude', 'skills'), { recursive: true });
  await fs.symlink(source, path.join(f.homeDir, '.claude', 'skills', 'alias'));
  await skill(path.join(f.magpieDir, 'library', 'skills'), 'magpie-skill');
  const first = await f.service.initialize();
  assert.equal(first.skills.length, 2);
  const alpha = first.skills.find((item) => item.name === 'alpha');
  assert.equal(alpha.path, source);
  assert.deepEqual(alpha.agents, ['Universal', 'Claude Code']);
  assert.equal(alpha.description, 'A useful skill');
  assert.equal(first.packs[0].id, 'default');
  const second = await f.service.rescan();
  assert.equal(second.skills.find((item) => item.name === 'alpha').id, alpha.id);
  const read = await f.service.readSkill(alpha.id);
  assert.equal(read.path, path.join(source, 'SKILL.md'));
  assert.match(read.text, /original/);
  first.skills[0].name = 'mutated by caller';
  assert.notEqual((await f.service.snapshot()).skills[0].name, 'mutated by caller');
});

test('Skill file tree and bounded text previews work for installed and owned Skills without writing files', async (t) => {
  const f = await imported(t);
  const original = await fs.readFile(path.join(f.source, 'SKILL.md'));
  for (const item of [f.original, f.managed]) {
    const tree = await f.service.skillFiles(item.id);
    assert.equal(tree.truncated, false);
    assert.deepEqual(tree.files.map(entry => [entry.name, entry.kind]), [['scripts', 'directory'], ['asset.bin', 'file'], ['SKILL.md', 'file']]);
    assert.equal(tree.files[0].children[0].path, 'scripts/run.sh');
    const preview = await f.service.readSkillFile(item.id, 'scripts/run.sh');
    assert.equal(preview.path, path.join(item.path, 'scripts/run.sh'));
    assert.match(preview.text, /echo original/);
    assert.equal((await f.service.readSkillFile(item.id, 'SKILL.md')).text, original.toString());
    await assert.rejects(f.service.readSkillFile(item.id, 'asset.bin'), status(415));
  }
  assert.deepEqual(await fs.readFile(path.join(f.source, 'SKILL.md')), original);
});

test('Skill previews reject traversal, excluded trees, invalid encoding and oversized or missing files', async (t) => {
  const f = await imported(t);
  for (const relative of ['../outside.txt', '/etc/passwd', 'scripts/../../secret', 'scripts\\run.sh', '', 'a\0b', 'a/./b', 'C:/secret']) {
    await assert.rejects(f.service.readSkillFile(f.original.id, relative), status(400));
  }
  await fs.mkdir(path.join(f.source, '.git'));
  await fs.writeFile(path.join(f.source, '.git/config'), 'secret');
  await assert.rejects(f.service.readSkillFile(f.original.id, '.git/config'), status(403));
  assert.ok(!(await f.service.skillFiles(f.original.id)).files.some(entry => entry.name === '.git'));
  await fs.writeFile(path.join(f.source, 'big.txt'), 'x'.repeat(96 * 1024 + 1));
  await fs.writeFile(path.join(f.source, 'invalid.txt'), Buffer.from([0xff, 0xfe]));
  await fs.writeFile(path.join(f.source, 'control.txt'), Buffer.from([65, 1, 66]));
  await assert.rejects(f.service.readSkillFile(f.original.id, 'big.txt'), status(413));
  await assert.rejects(f.service.readSkillFile(f.original.id, 'invalid.txt'), status(415));
  await assert.rejects(f.service.readSkillFile(f.original.id, 'control.txt'), status(415));
  await assert.rejects(f.service.readSkillFile(f.original.id, 'missing.txt'), status(404));
  await assert.rejects(f.service.readSkillFile(f.original.id, 'scripts'), status(415));
  await assert.rejects(f.service.skillFiles('missing'), status(404));
});

test('Skill previews never follow nested symlinks or a replaced canonical Skill directory', async (t) => {
  const f = await imported(t);
  const outside = path.join(f.root, 'private');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'NOT_A_SKILL');
  await fs.symlink(outside, path.join(f.source, 'linked-dir'));
  await fs.symlink(path.join(outside, 'secret.txt'), path.join(f.source, 'linked-file.txt'));
  const tree = await f.service.skillFiles(f.original.id);
  assert.ok(!tree.files.some(entry => entry.name.startsWith('linked-')));
  await assert.rejects(f.service.readSkillFile(f.original.id, 'linked-file.txt'), status(403));
  await assert.rejects(f.service.readSkillFile(f.original.id, 'linked-dir/secret.txt'), status(403));
  await fs.rename(path.join(f.source, 'SKILL.md'), path.join(f.source, 'document.backup'));
  await fs.symlink(path.join(outside, 'secret.txt'), path.join(f.source, 'SKILL.md'));
  await assert.rejects(f.service.readSkill(f.original.id), status(403));
  await fs.rename(f.source, `${f.source}.backup`);
  await fs.symlink(outside, f.source);
  await assert.rejects(f.service.skillFiles(f.original.id), status(409));
  await assert.rejects(f.service.readSkillFile(f.original.id, 'secret.txt'), status(409));
});

test('Skill preview tree has a finite entry budget and reports depth truncation', async (t) => {
  const f = await imported(t);
  let deep = f.source;
  for (let i = 0; i < 34; i++) { deep = path.join(deep, 'deep'); await fs.mkdir(deep); }
  await fs.writeFile(path.join(deep, 'hidden.txt'), 'outside preview depth');
  assert.equal((await f.service.skillFiles(f.original.id)).truncated, true);
  await fs.rm(path.join(f.source, 'deep'), { recursive: true });
  await Promise.all(Array.from({ length: 2010 }, (_, index) => fs.writeFile(path.join(f.source, `entry-${index}.txt`), '')));
  const tree = await f.service.skillFiles(f.original.id);
  assert.equal(tree.truncated, true);
  assert.ok(tree.files.length <= 2000);
});

test('same canonical skill appears independently in global and project scopes', async (t) => {
  const f = await fixture(t);
  const source = await skill(path.join(f.homeDir, '.agents', 'skills'));
  const project = path.join(f.root, 'project');
  await fs.mkdir(path.join(project, '.agents', 'skills'), { recursive: true });
  await fs.symlink(source, path.join(project, '.agents', 'skills', 'alias'));
  await f.service.initialize();
  const state = await f.service.addProject({ path: project, name: 'Workspace' });
  assert.equal(state.skills.length, 2);
  assert.notEqual(state.skills[0].id, state.skills[1].id);
  assert.ok(state.skills.some((item) => item.scopeId === `project:${state.projects[0].id}`));
  await assert.rejects(f.service.addProject({ path: project }), status(409));
  const removed = await f.service.removeProject(state.projects[0].id);
  assert.equal(removed.skills.length, 1);
  assert.equal(removed.projects.length, 0);
  assert.equal(await exists(source), true);
});

test('custom roots scan persist and removal never deletes originals', async (t) => {
  const f = await fixture(t);
  const custom = path.join(f.root, 'custom');
  const source = await skill(custom, 'custom-skill');
  await f.service.initialize();
  const added = await f.service.addRoot({ path: custom, label: 'Team' });
  assert.equal(added.skills[0].sourceLabel, 'Team');
  const customRoot = added.roots.find((root) => !root.preset);
  await assert.rejects(f.service.removeRoot('preset-universal'), status(404));
  const reloaded = new ShelfService(f);
  assert.equal((await reloaded.initialize()).skills[0].id, added.skills[0].id);
  const removed = await f.service.removeRoot(customRoot.id);
  assert.equal(removed.skills.length, 0);
  assert.equal(await exists(source), true);
});

test('scope-safe organization, folder cycles and hoisting are atomic metadata-only operations', async (t) => {
  const f = await imported(t);
  let state = await f.service.createFolder({ name: 'Parent', scopeId: 'global' });
  const parent = state.folders.at(-1);
  state = await f.service.createFolder({ name: 'Child', scopeId: 'global', parentId: parent.id, color: '#00aaFF' });
  const child = state.folders.at(-1);
  await assert.rejects(f.service.updateFolder(parent.id, { parentId: child.id }), /cycle/);
  await assert.rejects(f.service.organize({ ids: [f.original.id, f.managed.id], folderId: child.id, tags: ['x'] }), /same scope/);
  assert.equal((await f.service.snapshot()).organization[f.original.id], undefined);
  state = await f.service.organize({ ids: [f.original.id], folderId: child.id, tags: ['Team', 'Team', 'Review'] });
  assert.deepEqual(state.organization[f.original.id].tags, ['Team', 'Review']);
  state = await f.service.deleteFolder(child.id);
  assert.equal(state.organization[f.original.id].folderId, parent.id);
  state = await f.service.createFolder({ name: 'New Child', scopeId: 'global', parentId: parent.id });
  const newChild = state.folders.at(-1);
  state = await f.service.deleteFolder(parent.id);
  assert.equal(state.folders.find((folder) => folder.id === newChild.id).parentId, null);
  assert.equal(state.organization[f.original.id].folderId, null);
  assert.match(await fs.readFile(path.join(f.source, 'SKILL.md'), 'utf8'), /original/);
  await assert.rejects(f.service.createFolder({ name: 'Invalid', scopeId: 'pack:missing' }), status(404));
});

test('repeated and cross-Pack imports are independent full copies, excluded entries stay out', async (t) => {
  const f = await fixture(t);
  const source = await skill(path.join(f.homeDir, '.agents', 'skills'));
  await fs.mkdir(path.join(source, '.git'));
  await fs.writeFile(path.join(source, '.git', 'secret'), 'must not copy');
  await fs.mkdir(path.join(source, 'node_modules'));
  await fs.writeFile(path.join(source, '.DS_Store'), 'must not copy');
  let state = await f.service.initialize();
  const original = state.skills[0];
  await f.service.importSkills('default', { skillIds: [original.id] });
  state = await f.service.importSkills('default', { skillIds: [original.id] });
  const [first, second] = state.managedSkills;
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.path, second.path);
  assert.equal(await exists(path.join(first.path, '.git')), false);
  assert.equal(await exists(path.join(first.path, 'node_modules')), false);
  assert.equal(await exists(path.join(first.path, '.DS_Store')), false);
  assert.deepEqual(await fs.readFile(path.join(first.path, 'asset.bin')), Buffer.from([0, 255, 17]));
  assert.ok((await fs.stat(path.join(first.path, 'scripts', 'run.sh'))).mode & 0o111);
  state = await f.service.createPack({ name: 'Team Pack' });
  const pack = state.packs.at(-1);
  state = await f.service.importSkills(pack.id, { skillIds: [first.id] });
  const third = state.managedSkills.at(-1);
  await fs.writeFile(path.join(first.path, 'asset.bin'), 'edited');
  assert.deepEqual(await fs.readFile(path.join(second.path, 'asset.bin')), Buffer.from([0, 255, 17]));
  assert.deepEqual(await fs.readFile(path.join(third.path, 'asset.bin')), Buffer.from([0, 255, 17]));
  await f.service.deleteManagedSkill(first.id);
  assert.equal(await exists(source), true);
  assert.equal(await exists(second.path), true);
  assert.equal(await exists(third.path), true);
});

test('Default Pack is immutable; normal Packs rename and delete without touching originals', async (t) => {
  const f = await imported(t);
  await assert.rejects(f.service.updatePack('default', { name: 'Other' }), status(409));
  await assert.rejects(f.service.deletePack('default'), status(409));
  let state = await f.service.createPack({ name: 'One', description: 'First' });
  const pack = state.packs.at(-1);
  state = await f.service.updatePack(pack.id, { name: 'Two', description: 'Updated' });
  assert.equal(state.packs.at(-1).name, 'Two');
  state = await f.service.importSkills(pack.id, { skillIds: [f.original.id] });
  const copied = state.managedSkills.at(-1);
  await f.service.deletePack(pack.id);
  assert.equal(await exists(copied.path), false);
  assert.equal(await exists(f.source), true);
});

test('copy deployments reject overwrite, retain edited copies, and survive deleting their Pack', async (t) => {
  const f = await imported(t);
  let state = await f.service.createPack({ name: 'Deployable' });
  const pack = state.packs.at(-1);
  state = await f.service.importSkills(pack.id, { skillIds: [f.original.id] });
  const managed = state.managedSkills.at(-1);
  const target = path.join(f.root, 'deploy', 'nested');
  state = await f.service.deploy({ skillIds: [managed.id], targetPath: target, mode: 'copy' });
  const deployment = state.managedSkills.find((item) => item.id === managed.id).deployments[0];
  assert.equal(deployment.targetPath, path.join(target, 'alpha'));
  assert.equal(ownPrivate(deployment), false);
  await assert.rejects(f.service.deploy({ skillIds: [managed.id], targetPath: target, mode: 'copy' }), status(409));
  await fs.writeFile(path.join(deployment.targetPath, 'SKILL.md'), 'User-edited');
  await assert.rejects(f.service.removeDeployment({ skillId: managed.id, deploymentId: deployment.id }), status(409));
  assert.equal(await fs.readFile(path.join(deployment.targetPath, 'SKILL.md'), 'utf8'), 'User-edited');
  await f.service.deletePack(pack.id);
  assert.equal(await exists(managed.path), false);
  assert.equal(await exists(deployment.targetPath), true);
});

const ownPrivate = (value) => Object.keys(value).some((key) => key.startsWith('_'));

test('unchanged copies remove safely; modified assets including excluded names block removal', async (t) => {
  const f = await imported(t);
  const target = path.join(f.root, 'deploy');
  let state = await f.service.deploy({ skillIds: [f.managed.id], targetPath: target, mode: 'copy' });
  let deployment = state.managedSkills[0].deployments[0];
  await fs.writeFile(path.join(deployment.targetPath, '.DS_Store'), 'new user file');
  await assert.rejects(f.service.removeDeployment({ skillId: f.managed.id, deploymentId: deployment.id }), status(409));
  await fs.unlink(path.join(deployment.targetPath, '.DS_Store'));
  state = await f.service.removeDeployment({ skillId: f.managed.id, deploymentId: deployment.id });
  assert.equal(state.managedSkills[0].deployments.length, 0);
  assert.equal(await exists(deployment.targetPath), false);
  assert.equal(await exists(f.managed.path), true);
  state = await f.service.deploy({ skillIds: [f.managed.id], targetPath: target, mode: 'copy' });
  deployment = state.managedSkills[0].deployments[0];
  await fs.symlink(f.source, path.join(deployment.targetPath, 'new-link'));
  await assert.rejects(f.service.removeDeployment({ skillId: f.managed.id, deploymentId: deployment.id }), status(409));
  assert.equal(await exists(path.join(deployment.targetPath, 'new-link')), true);
});

test('live symlink deployments guard deletion; replaced links never removed', async (t) => {
  const f = await imported(t);
  let state = await f.service.createPack({ name: 'Linked Pack' });
  const pack = state.packs.at(-1);
  state = await f.service.importSkills(pack.id, { skillIds: [f.original.id] });
  const managed = state.managedSkills.at(-1);
  state = await f.service.deploy({ skillIds: [managed.id], targetPath: path.join(f.root, 'links'), mode: 'symlink' });
  const deployment = state.managedSkills.at(-1).deployments[0];
  assert.equal(await fs.readlink(deployment.targetPath), managed.path);
  await assert.rejects(f.service.deleteManagedSkill(managed.id), status(409));
  await assert.rejects(f.service.deletePack(pack.id), status(409));
  const replacement = path.join(f.root, 'replacement');
  await fs.mkdir(replacement);
  await fs.unlink(deployment.targetPath);
  await fs.symlink(replacement, deployment.targetPath);
  await assert.rejects(f.service.removeDeployment({ skillId: managed.id, deploymentId: deployment.id }), status(409));
  assert.equal(await fs.readlink(deployment.targetPath), replacement);
  await f.service.deletePack(pack.id);
  assert.equal(await fs.readlink(deployment.targetPath), replacement);
});

test('owned symlink removal works after reload and deleted-target deployment records can be forgotten', async (t) => {
  const f = await imported(t);
  let state = await f.service.deploy({ skillIds: [f.managed.id], targetPath: path.join(f.root, 'links'), mode: 'symlink' });
  const deployment = state.managedSkills[0].deployments[0];
  const reloaded = new ShelfService(f);
  await reloaded.initialize();
  state = await reloaded.removeDeployment({ skillId: f.managed.id, deploymentId: deployment.id });
  assert.equal(state.managedSkills[0].deployments.length, 0);
  assert.equal(await exists(deployment.targetPath), false);
  state = await reloaded.deploy({ skillIds: [f.managed.id], targetPath: path.join(f.root, 'links'), mode: 'copy' });
  const copyDeployment = state.managedSkills[0].deployments[0];
  await fs.rm(copyDeployment.targetPath, { recursive: true });
  state = await reloaded.removeDeployment({ skillId: f.managed.id, deploymentId: copyDeployment.id });
  assert.equal(state.managedSkills[0].deployments.length, 0);
});

test('deployment batches reject conflicts before writing and safe agent roots allow unrelated Skills', async (t) => {
  const f = await imported(t);
  await f.service.importSkills('default', { skillIds: [f.original.id] });
  const state = await f.service.snapshot();
  const target = path.join(f.root, 'destination');
  await assert.rejects(f.service.deploy({ skillIds: state.managedSkills.map((item) => item.id), targetPath: target, mode: 'copy' }), status(409));
  assert.equal(await exists(target), false);
  await assert.rejects(f.service.deploy({ skillIds: [f.managed.id], targetPath: f.dataDir, mode: 'copy' }), /storage/);
  await assert.rejects(f.service.deploy({ skillIds: [f.managed.id], targetPath: f.root, mode: 'copy' }), /ancestor/);
  await assert.rejects(f.service.deploy({ skillIds: [f.managed.id], targetPath: path.join(f.source, 'nested'), mode: 'copy' }), /source/);
  const alias = path.join(f.root, 'storage-alias');
  await fs.symlink(f.dataDir, alias);
  await assert.rejects(f.service.deploy({ skillIds: [f.managed.id], targetPath: path.join(alias, 'new'), mode: 'copy' }), /storage/);
  const agentRoot = path.join(f.homeDir, '.claude', 'skills');
  await skill(agentRoot, 'unrelated');
  await f.service.rescan();
  const deployed = await f.service.deploy({ skillIds: [f.managed.id], targetPath: agentRoot, mode: 'copy' });
  assert.equal(await exists(path.join(agentRoot, 'alpha', 'SKILL.md')), true);
  assert.equal(await exists(path.join(agentRoot, 'unrelated', 'SKILL.md')), true);
  assert.equal(deployed.managedSkills[0].deployments.length, 1);
});

test('nested source symlinks reject the entire import without touching source or state', async (t) => {
  const f = await fixture(t);
  const good = await skill(path.join(f.homeDir, '.agents', 'skills'), 'good');
  const bad = await skill(path.join(f.homeDir, '.agents', 'skills'), 'bad');
  await fs.symlink(path.join(good, 'asset.bin'), path.join(bad, 'nested-link'));
  const state = await f.service.initialize();
  await assert.rejects(f.service.importSkills('default', { skillIds: state.skills.map((item) => item.id) }), /symlink/);
  assert.equal((await f.service.snapshot()).managedSkills.length, 0);
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'skills')), []);
  assert.equal((await fs.lstat(path.join(bad, 'nested-link'))).isSymbolicLink(), true);
});

test('export/import round trip preserves binary assets, execution bits, hierarchy and tags with all IDs rebased', async (t) => {
  const f = await imported(t);
  let state = await f.service.createFolder({ name: 'Parent', scopeId: 'pack:default' });
  const parent = state.folders.at(-1);
  state = await f.service.createFolder({ name: 'Child', scopeId: 'pack:default', parentId: parent.id, color: '#11aa33' });
  const child = state.folders.at(-1);
  await f.service.organize({ ids: [f.managed.id], folderId: child.id, tags: ['tools'] });
  await f.service.deploy({ skillIds: [f.managed.id], targetPath: path.join(f.root, 'deploy'), mode: 'copy' });
  const exported = await f.service.exportPack('default');
  const serialized = JSON.stringify(exported);
  assert.equal(serialized.includes(f.root), false);
  assert.equal(serialized.includes('deployments'), false);
  assert.equal(serialized.includes('sourcePath'), false);
  state = await f.service.importPack(exported);
  const pack = state.packs.at(-1);
  const managed = state.managedSkills.at(-1);
  const importedFolders = state.folders.filter((folder) => folder.scopeId === `pack:${pack.id}`);
  assert.notEqual(pack.id, 'default');
  assert.notEqual(managed.id, f.managed.id);
  assert.deepEqual(state.organization[managed.id].tags, ['tools']);
  const importedChild = importedFolders.find((folder) => folder.name === 'Child');
  const importedParent = importedFolders.find((folder) => folder.name === 'Parent');
  assert.notEqual(importedChild.id, child.id);
  assert.equal(importedChild.parentId, importedParent.id);
  assert.equal(state.organization[managed.id].folderId, importedChild.id);
  assert.deepEqual(await fs.readFile(path.join(managed.path, 'asset.bin')), Buffer.from([0, 255, 17]));
  assert.ok((await fs.stat(path.join(managed.path, 'scripts', 'run.sh'))).mode & 0o111);
  assert.deepEqual(managed.deployments, []);
  assert.equal(managed.sourcePath, '');
});

test('Portable Pack validation rejects traversal, collisions, malformed base64, cycles, unknown fields and missing docs before writing', async (t) => {
  const f = await imported(t);
  const original = await f.service.exportPack('default');
  const cases = [
    (doc) => { doc.skills[0].files[0].path = '../escape'; },
    (doc) => { doc.skills[0].files[0].path = '/tmp/escape'; },
    (doc) => { doc.skills[0].files[0].path = 'scripts\\escape'; },
    (doc) => { doc.skills[0].files[0].path = 'C:/escape'; },
    (doc) => { doc.skills[0].files[0].path = 'scripts//escape'; },
    (doc) => { doc.skills[0].files.push({ ...doc.skills[0].files[0] }); },
    (doc) => { doc.skills[0].files.push({ ...doc.skills[0].files[0], path: 'ASSET.BIN' }); },
    (doc) => { doc.skills[0].files.push({ path: 'scripts', content: '', executable: false }); },
    (doc) => { doc.skills[0].files[0].content = '%%%%'; },
    (doc) => { doc.skills[0].files[0].content = 'Zg='; },
    (doc) => { doc.skills[0].files[0].content = 'Zh=='; },
    (doc) => { doc.skills[0].files[0].symlink = 'target'; },
    (doc) => { doc.skills[0].files[0].path = '.git/config'; },
    (doc) => { doc.skills[0].files = doc.skills[0].files.filter((file) => file.path !== 'SKILL.md'); },
    (doc) => { doc.skills[0].folderId = 'missing'; },
    (doc) => { doc.skills[0].slug = '../bad'; },
    (doc) => { doc.skills.push({ ...doc.skills[0] }); },
    (doc) => { doc.folders = [{ id: 'a', name: 'Cycle', parentId: 'a', color: '#ffffff' }]; },
    (doc) => { doc.folders = [{ id: 'a', name: 'Missing parent', parentId: 'x', color: '#ffffff' }]; },
    (doc) => { doc.version = 5; },
  ];
  for (const change of cases) {
    const doc = structuredClone(original);
    change(doc);
    await assert.rejects(f.service.importPack(doc), (error) => error instanceof ShelfError, JSON.stringify(doc));
    assert.equal((await f.service.snapshot()).packs.length, 1);
    assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'skills')), [f.managed.id]);
  }
});

test('file, aggregate and count limits reject imports atomically', async (t) => {
  const f = await imported(t);
  let doc = await f.service.exportPack('default');
  doc.skills[0].files[0].content = Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64');
  await assert.rejects(f.service.importPack(doc), status(413));
  doc = await f.service.exportPack('default');
  doc.skills[0].files = [{ path: 'SKILL.md', content: '', executable: false }, ...Array.from({ length: 5 }, (_, i) => ({ path: `${i}.bin`, content: Buffer.alloc(4 * 1024 * 1024).toString('base64'), executable: false }))];
  await assert.rejects(f.service.importPack(doc), status(413));
  doc = await f.service.exportPack('default');
  doc.skills[0].files = Array.from({ length: 2001 }, (_, i) => ({ path: i === 0 ? 'SKILL.md' : `${i}.txt`, content: '', executable: false }));
  await assert.rejects(f.service.importPack(doc), (error) => error instanceof ShelfError);
  assert.equal((await f.service.snapshot()).packs.length, 1);
});

test('state persistence failure rolls back imported trees, deployments and staged deletions', async (t) => {
  const f = await imported(t);
  const originalSave = f.service.save.bind(f.service);
  const brokenSave = async () => { throw new Error('simulated persistence failure'); };
  f.service.save = brokenSave;
  await assert.rejects(f.service.importSkills('default', { skillIds: [f.original.id] }), /persistence/);
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'skills')), [f.managed.id]);
  const target = path.join(f.root, 'new', 'nested');
  await assert.rejects(f.service.deploy({ skillIds: [f.managed.id], targetPath: target, mode: 'copy' }), /persistence/);
  assert.equal(await exists(path.join(f.root, 'new')), false);
  await assert.rejects(f.service.deploy({ skillIds: [f.managed.id], targetPath: target, mode: 'symlink' }), /persistence/);
  assert.equal(await exists(path.join(f.root, 'new')), false);
  await assert.rejects(f.service.deleteManagedSkill(f.managed.id), /persistence/);
  assert.equal(await exists(path.join(f.managed.path, 'SKILL.md')), true);
  assert.equal((await f.service.snapshot()).managedSkills.length, 1);
  f.service.save = originalSave;
  let state = await f.service.deploy({ skillIds: [f.managed.id], targetPath: target, mode: 'copy' });
  const deployment = state.managedSkills[0].deployments[0];
  f.service.save = brokenSave;
  await assert.rejects(f.service.removeDeployment({ skillId: f.managed.id, deploymentId: deployment.id }), /persistence/);
  assert.equal(await exists(path.join(deployment.targetPath, 'SKILL.md')), true);
  assert.equal((await f.service.snapshot()).managedSkills[0].deployments.length, 1);
  const exported = await f.service.exportPack('default');
  await assert.rejects(f.service.importPack(exported), /persistence/);
  assert.equal((await f.service.snapshot()).packs.length, 1);
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'skills')), [f.managed.id]);
  f.service.save = originalSave;
  state = await f.service.organize({ ids: [f.managed.id], tags: ['after-failure'] });
  assert.deepEqual(state.organization[f.managed.id].tags, ['after-failure']);
});

test('concurrent mutations serialize and atomic persisted snapshots reload all changes', async (t) => {
  const f = await fixture(t);
  await f.service.initialize();
  await Promise.all(Array.from({ length: 20 }, (_, index) => f.service.createPack({ name: `Pack ${index}` })));
  const snapshot = await f.service.snapshot();
  assert.equal(snapshot.packs.length, 21);
  const persisted = JSON.parse(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'));
  assert.equal(persisted.packs.length, 21);
  assert.deepEqual((await fs.readdir(f.dataDir)).filter((name) => name.endsWith('.tmp')), []);
  const reloaded = new ShelfService(f);
  assert.equal((await reloaded.initialize()).packs.length, 21);
});

test('invalid persisted state is not reset or overwritten and unsafe managed paths are refused', async (t) => {
  const f = await imported(t);
  const stateFile = path.join(f.dataDir, 'state.json');
  const persisted = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  persisted.managedSkills[0].path = f.source;
  await fs.writeFile(stateFile, JSON.stringify(persisted));
  const reloaded = new ShelfService(f);
  await assert.rejects(reloaded.initialize(), status(500));
  assert.equal(JSON.parse(await fs.readFile(stateFile, 'utf8')).managedSkills[0].path, f.source);
  assert.equal(await exists(f.source), true);
});

test('folder names are unique among siblings including case variants, updates and imported folders', async (t) => {
  const f = await imported(t);
  let state = await f.service.createFolder({ name: 'Work', scopeId: 'global' });
  const work = state.folders.at(-1);
  await assert.rejects(f.service.createFolder({ name: 'work', scopeId: 'global' }), status(409));
  state = await f.service.createFolder({ name: 'Other', scopeId: 'global' });
  const other = state.folders.at(-1);
  await assert.rejects(f.service.updateFolder(other.id, { name: 'WORK' }), status(409));
  state = await f.service.createFolder({ name: 'Work', scopeId: 'global', parentId: other.id });
  const child = state.folders.at(-1);
  await assert.rejects(f.service.updateFolder(child.id, { parentId: null }), status(409));
  await assert.rejects(f.service.deleteFolder(other.id), status(409));
  assert.equal((await f.service.snapshot()).folders.find((folder) => folder.id === other.id).name, 'Other');
  await f.service.createFolder({ name: 'Work', scopeId: 'pack:default' });
  const doc = await f.service.exportPack('default');
  doc.folders = [
    { id: 'one', name: 'Work', parentId: null, color: '#ffffff' },
    { id: 'two', name: 'work', parentId: null, color: '#ffffff' },
  ];
  await assert.rejects(f.service.importPack(doc), /duplicate sibling/);
  assert.equal((await f.service.snapshot()).folders.find((folder) => folder.id === work.id).name, 'Work');
});

test('exports and Skill document reads serialize with queued deletion', async (t) => {
  const f = await imported(t);
  const exportOperation = f.service.exportPack('default');
  const readOperation = f.service.readSkill(f.managed.id);
  const deleteOperation = f.service.deleteManagedSkill(f.managed.id);
  const [exported, read, state] = await Promise.all([exportOperation, readOperation, deleteOperation]);
  assert.equal(exported.skills.length, 1);
  assert.match(read.text, /original/);
  assert.equal(state.managedSkills.length, 0);
  await assert.rejects(f.service.readSkill(f.managed.id), status(404));
});

test('missing input roots and projects return useful 404 errors without partial mutations', async (t) => {
  const f = await fixture(t);
  await f.service.initialize();
  const missing = path.join(f.root, 'missing');
  await assert.rejects(f.service.addRoot({ path: missing }), status(404));
  await assert.rejects(f.service.addProject({ path: missing }), status(404));
  assert.equal((await f.service.snapshot()).projects.length, 0);
});

test('a destination created after batch preflight is preserved while earlier owned deployments roll back', async (t) => {
  const f = await imported(t);
  await skill(path.join(f.homeDir, '.agents', 'skills'), 'beta');
  let state = await f.service.rescan();
  const beta = state.skills.find((item) => item.name === 'beta');
  state = await f.service.importSkills('default', { skillIds: [beta.id] });
  const betaManaged = state.managedSkills.at(-1);
  const target = path.join(f.root, 'batch-target');
  const makeParent = f.service.makeParent.bind(f.service);
  f.service.makeParent = async (location, transaction) => {
    await makeParent(location, transaction);
    await fs.mkdir(path.join(location, 'beta'));
    await fs.writeFile(path.join(location, 'beta', 'user-data'), 'Keep this');
  };
  await assert.rejects(f.service.deploy({ skillIds: [f.managed.id, betaManaged.id], targetPath: target, mode: 'copy' }), status(409));
  assert.equal(await exists(path.join(target, 'alpha')), false);
  assert.equal(await fs.readFile(path.join(target, 'beta', 'user-data'), 'utf8'), 'Keep this');
  assert.ok((await f.service.snapshot()).managedSkills.every((item) => item.deployments.length === 0));
});

test('symlink removal rollback keeps ownership valid for retry and Pack deletion guards the restored link', async (t) => {
  const f = await imported(t);
  let state = await f.service.deploy({ skillIds: [f.managed.id], targetPath: path.join(f.root, 'retry-links'), mode: 'symlink' });
  const deployment = state.managedSkills[0].deployments[0];
  const save = f.service.save.bind(f.service);
  f.service.save = async () => { throw new Error('simulated failure'); };
  await assert.rejects(f.service.removeDeployment({ skillId: f.managed.id, deploymentId: deployment.id }), /simulated failure/);
  assert.equal(await fs.readlink(deployment.targetPath), f.managed.path);
  f.service.save = save;
  await assert.rejects(f.service.deleteManagedSkill(f.managed.id), status(409));
  state = await f.service.removeDeployment({ skillId: f.managed.id, deploymentId: deployment.id });
  assert.equal(state.managedSkills[0].deployments.length, 0);
  assert.equal(await exists(deployment.targetPath), false);
});

test('root permission changes count as user edits and are preserved', async (t) => {
  const f = await imported(t);
  const state = await f.service.deploy({ skillIds: [f.managed.id], targetPath: path.join(f.root, 'permissions'), mode: 'copy' });
  const deployment = state.managedSkills[0].deployments[0];
  await fs.chmod(deployment.targetPath, 0o700);
  await assert.rejects(f.service.removeDeployment({ skillId: f.managed.id, deploymentId: deployment.id }), status(409));
  assert.equal((await fs.stat(deployment.targetPath)).mode & 0o777, 0o700);
});

test('managed copies have private file modes and do not change source file permissions', async (t) => {
  const f = await imported(t);
  assert.equal((await fs.stat(f.managed.path)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(f.managed.path, 'scripts'))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(f.managed.path, 'SKILL.md'))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(f.managed.path, 'scripts', 'run.sh'))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(f.source, 'scripts', 'run.sh'))).mode & 0o777, 0o755);
});

for (const mode of ['copy', 'symlink']) {
  test(`${mode} deployment replaced between fingerprint and atomic staging is restored, never deleted`, async (t) => {
    const f = await imported(t);
    const target = path.join(f.root, `replacement-race-${mode}`);
    const state = await f.service.deploy({ skillIds: [f.managed.id], targetPath: target, mode });
    const deployment = state.managedSkills[0].deployments[0];
    const originalRename = fs.rename;
    const aside = path.join(target, 'original-owned');
    const replacementSource = path.join(f.root, 'user-replacement');
    await fs.mkdir(replacementSource);
    let replaced = false;
    fs.rename = async (from, to) => {
      if (from === deployment.targetPath && path.basename(to).startsWith('.shelf-trash-') && !replaced) {
        replaced = true;
        await originalRename(from, aside);
        if (mode === 'copy') {
          await fs.mkdir(from);
          await fs.writeFile(path.join(from, 'user-data'), 'Never delete this replacement');
        } else {
          await fs.symlink(replacementSource, from, 'dir');
        }
      }
      return originalRename(from, to);
    };
    try {
      await assert.rejects(f.service.removeDeployment({ skillId: f.managed.id, deploymentId: deployment.id }), (error) => status(409)(error) && /changed during removal/.test(error.message));
    } finally { fs.rename = originalRename; }
    assert.equal(replaced, true);
    if (mode === 'copy') assert.equal(await fs.readFile(path.join(deployment.targetPath, 'user-data'), 'utf8'), 'Never delete this replacement');
    else assert.equal(await fs.readlink(deployment.targetPath), replacementSource);
    assert.equal(await exists(aside), true);
    assert.deepEqual((await fs.readdir(target)).filter((entry) => entry.startsWith('.shelf-trash-')), []);
    assert.equal((await f.service.snapshot()).managedSkills[0].deployments.length, 1);
  });
}

test('rollback preserves a concurrently recreated target and keeps the staged original with its recovery path', async (t) => {
  const f = await imported(t);
  const target = path.join(f.root, 'rollback-conflict');
  const state = await f.service.deploy({ skillIds: [f.managed.id], targetPath: target, mode: 'copy' });
  const deployment = state.managedSkills[0].deployments[0];
  const save = f.service.save.bind(f.service);
  f.service.save = async () => {
    await fs.mkdir(deployment.targetPath);
    await fs.writeFile(path.join(deployment.targetPath, 'new-user-file'), 'Keep the new destination');
    throw new Error('simulated persistence failure');
  };
  let recoveryPath;
  try {
    await assert.rejects(f.service.removeDeployment({ skillId: f.managed.id, deploymentId: deployment.id }), (error) => {
      assert.equal(error.status, 500);
      assert.match(error.message, /rollback needs attention/);
      const stashName = error.message.match(/\.shelf-trash-[a-z0-9-]+/)?.[0];
      assert.ok(stashName);
      recoveryPath = path.join(target, stashName);
      return true;
    });
  } finally { f.service.save = save; }
  assert.equal(await fs.readFile(path.join(deployment.targetPath, 'new-user-file'), 'utf8'), 'Keep the new destination');
  assert.match(await fs.readFile(path.join(recoveryPath, 'SKILL.md'), 'utf8'), /original/);
  assert.equal((await f.service.snapshot()).managedSkills[0].deployments.length, 1);
});

for (const operation of ['copy', 'symlink', 'import']) {
  test(`failed ${operation} creation preserves a target replaced before rollback instead of blindly deleting it`, async (t) => {
    const f = await imported(t);
    const parent = path.join(f.root, `created-${operation}`);
    let destination;
    let aside;
    const save = f.service.save.bind(f.service);
    f.service.save = async () => {
      destination = operation === 'import' ? f.service.state.managedSkills.at(-1).path : path.join(parent, 'alpha');
      aside = `${destination}-original`;
      await fs.rename(destination, aside);
      await fs.mkdir(destination);
      await fs.writeFile(path.join(destination, 'user-file'), 'Preserve the replacement');
      throw new Error('simulated persistence failure');
    };
    try {
      const mutation = operation === 'import'
        ? f.service.importSkills('default', { skillIds: [f.original.id] })
        : f.service.deploy({ skillIds: [f.managed.id], targetPath: parent, mode: operation });
      await assert.rejects(mutation, (error) => error.status === 500 && /rollback needs attention/.test(error.message));
    } finally { f.service.save = save; }
    assert.equal(await fs.readFile(path.join(destination, 'user-file'), 'utf8'), 'Preserve the replacement');
    assert.equal(await exists(aside), true);
    const state = await f.service.snapshot();
    assert.equal(state.managedSkills.length, 1);
    assert.equal(state.managedSkills[0].deployments.length, 0);
  });
}

test('Finder coordinates persist and reload for known folders and Skills without leaking into portable Packs', async (t) => {
  const f = await imported(t);
  let state = await f.service.createFolder({ name: 'Canvas', scopeId: 'global' });
  const folder = state.folders.at(-1);
  state = await f.service.layout({ scopeId: 'global', items: [
    { kind: 'skill', id: f.original.id, position: { x: 0, y: 100000 } },
    { kind: 'folder', id: folder.id, position: { x: 123.5, y: 456.25 } },
  ] });
  assert.deepEqual(state.finderPositions[`skill:${f.original.id}`], { x: 0, y: 100000 });
  assert.deepEqual(state.finderPositions[`folder:${folder.id}`], { x: 123.5, y: 456.25 });
  state.finderPositions[`folder:${folder.id}`].x = 999;
  assert.equal((await f.service.snapshot()).finderPositions[`folder:${folder.id}`].x, 123.5);
  const reloaded = new ShelfService(f);
  const restored = await reloaded.initialize();
  assert.deepEqual(restored.finderPositions, (await f.service.snapshot()).finderPositions);
  await reloaded.layout({ scopeId: 'pack:default', items: [{ kind: 'skill', id: f.managed.id, position: { x: 88, y: 99 } }] });
  const exported = await reloaded.exportPack('default');
  assert.equal('finderPositions' in exported, false);
  assert.equal(JSON.stringify(exported).includes('position'), false);
});

test('Finder mixed folder and Skill moves are atomic metadata-only changes with coordinate reset or replacement', async (t) => {
  const f = await imported(t);
  const sourceFile = path.join(f.source, 'SKILL.md');
  const sourceBefore = await fs.readFile(sourceFile);
  const sourceStat = await fs.stat(sourceFile);
  let state = await f.service.createFolder({ name: 'Destination', scopeId: 'global' });
  const destination = state.folders.at(-1);
  state = await f.service.createFolder({ name: 'Moving', scopeId: 'global' });
  const moving = state.folders.at(-1);
  await f.service.organize({ ids: [f.original.id], tags: ['Keep my tags'] });
  await f.service.layout({ scopeId: 'global', items: [
    { kind: 'skill', id: f.original.id, position: { x: 1, y: 2 } },
    { kind: 'folder', id: moving.id, position: { x: 3, y: 4 } },
  ] });
  state = await f.service.layout({ scopeId: 'global', parentId: destination.id, items: [
    { kind: 'skill', id: f.original.id },
    { kind: 'folder', id: moving.id, position: { x: 55, y: 66 } },
  ] });
  assert.equal(state.organization[f.original.id].folderId, destination.id);
  assert.deepEqual(state.organization[f.original.id].tags, ['Keep my tags']);
  assert.equal(state.folders.find((folder) => folder.id === moving.id).parentId, destination.id);
  assert.equal(state.finderPositions[`skill:${f.original.id}`], undefined);
  assert.deepEqual(state.finderPositions[`folder:${moving.id}`], { x: 55, y: 66 });
  state = await f.service.layout({ scopeId: 'global', parentId: destination.id, items: [{ kind: 'folder', id: moving.id }] });
  assert.deepEqual(state.finderPositions[`folder:${moving.id}`], { x: 55, y: 66 });
  assert.deepEqual(await fs.readFile(sourceFile), sourceBefore);
  assert.equal((await fs.stat(sourceFile)).mtimeMs, sourceStat.mtimeMs);
});

test('Finder selected parent and child move together according to the final graph independent of input order', async (t) => {
  const f = await imported(t);
  let state = await f.service.createFolder({ name: 'Destination', scopeId: 'global' });
  const destination = state.folders.at(-1);
  state = await f.service.createFolder({ name: 'Parent', scopeId: 'global' });
  const parent = state.folders.at(-1);
  state = await f.service.createFolder({ name: 'Child', scopeId: 'global', parentId: parent.id });
  const child = state.folders.at(-1);
  for (const ids of [[child.id, parent.id], [parent.id, child.id]]) {
    state = await f.service.layout({ scopeId: 'global', parentId: destination.id, items: ids.map((id) => ({ kind: 'folder', id })) });
    assert.equal(state.folders.find((folder) => folder.id === parent.id).parentId, destination.id);
    assert.equal(state.folders.find((folder) => folder.id === child.id).parentId, destination.id);
    await f.service.layout({ scopeId: 'global', parentId: null, items: [{ kind: 'folder', id: parent.id }] });
    await f.service.layout({ scopeId: 'global', parentId: parent.id, items: [{ kind: 'folder', id: child.id }] });
  }
});

test('Finder cycles, cross-scope destinations and final sibling name collisions reject the full mixed batch', async (t) => {
  const f = await imported(t);
  let state = await f.service.createFolder({ name: 'Parent', scopeId: 'global' });
  const parent = state.folders.at(-1);
  state = await f.service.createFolder({ name: 'Child', scopeId: 'global', parentId: parent.id });
  const child = state.folders.at(-1);
  state = await f.service.createFolder({ name: 'Name', scopeId: 'global' });
  const existing = state.folders.at(-1);
  state = await f.service.createFolder({ name: 'name', scopeId: 'global', parentId: parent.id });
  const collision = state.folders.at(-1);
  state = await f.service.createFolder({ name: 'Pack', scopeId: 'pack:default' });
  const packFolder = state.folders.at(-1);
  await f.service.layout({ scopeId: 'global', items: [{ kind: 'skill', id: f.original.id, position: { x: 10, y: 20 } }] });
  const before = await f.service.snapshot();
  const persisted = await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8');
  const cases = [
    { parentId: child.id, items: [{ kind: 'skill', id: f.original.id, position: { x: 99, y: 88 } }, { kind: 'folder', id: parent.id }] },
    { parentId: parent.id, items: [{ kind: 'folder', id: parent.id }] },
    { parentId: child.id, items: [{ kind: 'folder', id: parent.id }, { kind: 'folder', id: child.id }] },
    { parentId: packFolder.id, items: [{ kind: 'skill', id: f.original.id }] },
    { parentId: null, items: [{ kind: 'skill', id: f.original.id }, { kind: 'folder', id: collision.id }] },
    { items: [{ kind: 'skill', id: f.original.id, position: { x: 99, y: 88 } }, { kind: 'skill', id: f.managed.id, position: { x: 1, y: 2 } }] },
  ];
  for (const input of cases) {
    await assert.rejects(f.service.layout({ scopeId: 'global', ...input }), (error) => error instanceof ShelfError);
    assert.deepEqual(await f.service.snapshot(), before);
    assert.equal(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'), persisted);
  }
  assert.equal(before.folders.find((folder) => folder.id === existing.id).parentId, null);
});

test('Finder rejects malformed coordinates, duplicate IDs, empty or oversized batches and invalid items', async (t) => {
  const f = await imported(t);
  const entry = { kind: 'skill', id: f.original.id, position: { x: 1, y: 2 } };
  const invalidCoordinates = [null, {}, { x: '1', y: 2 }, { x: NaN, y: 2 }, { x: Infinity, y: 2 }, { x: 1, y: -1 }, { x: 100001, y: 0 }, { x: 1, y: 2, z: 3 }];
  for (const coordinates of invalidCoordinates) await assert.rejects(f.service.layout({ scopeId: 'global', items: [{ ...entry, position: coordinates }] }), status(400));
  const invalidInputs = [
    null, { scopeId: 'global', items: [] }, { scopeId: 'unknown', items: [entry] },
    { scopeId: 'global', items: [entry, entry] }, { scopeId: 'global', items: [null] },
    { scopeId: 'global', items: [{ ...entry, kind: 'root' }] }, { scopeId: 'global', items: [entry], parentId: 12 },
    { scopeId: 'global', items: Array.from({ length: 2001 }, () => entry) },
  ];
  for (const input of invalidInputs) await assert.rejects(f.service.layout(input), status(400));
  await assert.rejects(f.service.layout({ scopeId: 'global', items: [{ kind: 'folder', id: 'missing' }] }), status(404));
  assert.deepEqual((await f.service.snapshot()).finderPositions, {});
});

test('Finder changes roll back all mixed metadata and positions when persistence fails', async (t) => {
  const f = await imported(t);
  let state = await f.service.createFolder({ name: 'Destination', scopeId: 'global' });
  const destination = state.folders.at(-1);
  state = await f.service.createFolder({ name: 'Moving', scopeId: 'global' });
  const moving = state.folders.at(-1);
  await f.service.layout({ scopeId: 'global', items: [{ kind: 'folder', id: moving.id, position: { x: 3, y: 4 } }] });
  const before = await f.service.snapshot();
  const persisted = await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8');
  const save = f.service.save.bind(f.service);
  f.service.save = async () => { throw new Error('simulated persistence failure'); };
  try {
    await assert.rejects(f.service.layout({ scopeId: 'global', parentId: destination.id, items: [
      { kind: 'skill', id: f.original.id, position: { x: 8, y: 9 } }, { kind: 'folder', id: moving.id },
    ] }), /persistence failure/);
  } finally { f.service.save = save; }
  assert.deepEqual(await f.service.snapshot(), before);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'state.json'), 'utf8'), persisted);
});

test('old v1 state without Finder positions loads as empty and unknown persisted keys are cleaned after scanning', async (t) => {
  const f = await imported(t);
  const stateFile = path.join(f.dataDir, 'state.json');
  let persisted = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  delete persisted.finderPositions;
  await fs.writeFile(stateFile, JSON.stringify(persisted));
  let reloaded = new ShelfService(f);
  assert.deepEqual((await reloaded.initialize()).finderPositions, {});
  await reloaded.layout({ scopeId: 'global', items: [{ kind: 'skill', id: f.original.id, position: { x: 10, y: 20 } }] });
  persisted = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  persisted.finderPositions['folder:missing'] = { x: 1, y: 2 };
  persisted.finderPositions['skill:missing'] = { x: 3, y: 4 };
  persisted.finderPositions['unknown:missing'] = { x: 5, y: 6 };
  await fs.writeFile(stateFile, JSON.stringify(persisted));
  reloaded = new ShelfService(f);
  assert.deepEqual((await reloaded.initialize()).finderPositions, { [`skill:${f.original.id}`]: { x: 10, y: 20 } });
  persisted.finderPositions[`skill:${f.original.id}`] = { x: -1, y: 0 };
  await fs.writeFile(stateFile, JSON.stringify(persisted));
  await assert.rejects(new ShelfService(f).initialize(), status(500));
  assert.equal(JSON.parse(await fs.readFile(stateFile, 'utf8')).finderPositions[`skill:${f.original.id}`].x, -1);
});

test('Finder positions reset on parent changes and owned deletions but retain unavailable installed source records', async (t) => {
  const f = await imported(t);
  let state = await f.service.createFolder({ name: 'Parent', scopeId: 'global' });
  const parent = state.folders.at(-1);
  state = await f.service.createFolder({ name: 'Child', scopeId: 'global', parentId: parent.id });
  const child = state.folders.at(-1);
  await f.service.layout({ scopeId: 'global', items: [{ kind: 'folder', id: child.id, position: { x: 1, y: 2 } }] });
  state = await f.service.updateFolder(child.id, { parentId: null });
  assert.equal(state.finderPositions[`folder:${child.id}`], undefined);
  await f.service.layout({ scopeId: 'global', items: [{ kind: 'skill', id: f.original.id, position: { x: 1, y: 2 } }] });
  state = await f.service.organize({ ids: [f.original.id], folderId: parent.id });
  assert.equal(state.finderPositions[`skill:${f.original.id}`], undefined);
  await f.service.updateFolder(child.id, { parentId: parent.id });
  await f.service.layout({ scopeId: 'global', items: [
    { kind: 'skill', id: f.original.id, position: { x: 1, y: 2 } }, { kind: 'folder', id: child.id, position: { x: 3, y: 4 } },
    { kind: 'folder', id: parent.id, position: { x: 5, y: 6 } },
  ] });
  state = await f.service.deleteFolder(parent.id);
  assert.deepEqual(state.finderPositions, {});
  await f.service.layout({ scopeId: 'pack:default', items: [{ kind: 'skill', id: f.managed.id, position: { x: 10, y: 20 } }] });
  state = await f.service.deleteManagedSkill(f.managed.id);
  assert.equal(state.finderPositions[`skill:${f.managed.id}`], undefined);
  await f.service.layout({ scopeId: 'global', items: [{ kind: 'skill', id: f.original.id, position: { x: 10, y: 20 } }] });
  await fs.rm(f.source, { recursive: true });
  state = await f.service.rescan();
  assert.deepEqual(state.finderPositions[`skill:${f.original.id}`], { x: 10, y: 20 });
});

test('Finder positions for removed Pack and project scopes disappear without changing other scopes', async (t) => {
  const f = await imported(t);
  const projectPath = path.join(f.root, 'project');
  await skill(path.join(projectPath, '.agents', 'skills'), 'project-skill');
  let state = await f.service.addProject({ path: projectPath });
  const project = state.projects[0];
  const projectSkill = state.skills.find((item) => item.scopeId === `project:${project.id}`);
  state = await f.service.createFolder({ name: 'Project folder', scopeId: `project:${project.id}` });
  const projectFolder = state.folders.at(-1);
  await f.service.layout({ scopeId: `project:${project.id}`, items: [
    { kind: 'skill', id: projectSkill.id, position: { x: 1, y: 2 } }, { kind: 'folder', id: projectFolder.id, position: { x: 3, y: 4 } },
  ] });
  state = await f.service.createPack({ name: 'Temporary Pack' });
  const pack = state.packs.at(-1);
  state = await f.service.importSkills(pack.id, { skillIds: [f.original.id] });
  const packSkill = state.managedSkills.at(-1);
  state = await f.service.createFolder({ name: 'Pack folder', scopeId: `pack:${pack.id}` });
  const packFolder = state.folders.at(-1);
  await f.service.layout({ scopeId: `pack:${pack.id}`, items: [
    { kind: 'skill', id: packSkill.id, position: { x: 1, y: 2 } }, { kind: 'folder', id: packFolder.id, position: { x: 3, y: 4 } },
  ] });
  await f.service.layout({ scopeId: 'global', items: [{ kind: 'skill', id: f.original.id, position: { x: 100, y: 200 } }] });
  state = await f.service.removeProject(project.id);
  assert.equal(state.finderPositions[`skill:${projectSkill.id}`], undefined);
  assert.equal(state.finderPositions[`folder:${projectFolder.id}`], undefined);
  state = await f.service.deletePack(pack.id);
  assert.deepEqual(state.finderPositions, { [`skill:${f.original.id}`]: { x: 100, y: 200 } });
  assert.equal(await exists(path.join(projectSkill.path, 'SKILL.md')), true);
});
