import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ShelfService } from '../src/domain.mjs';
import { SyncService } from '../src/sync.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'shelf-catalog-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = { homeDir: path.join(root, 'home'), dataDir: path.join(root, 'data'), magpieDir: path.join(root, 'magpie'), workbenchOptions: { environment: { PATH: '' }, platform: 'linux', applicationDirectories: [] } };
  const service = new ShelfService(options);
  return { root, options, service };
}

async function skill(directory, name = 'alpha', body = 'Shared document') {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Test skill\n---\n\n${body}\n`);
  return directory;
}

test('desktop-style catalog groups scope and name while preserving differing physical installations and their metadata', async t => {
  const f = await fixture(t);
  const shared = await skill(path.join(f.options.homeDir, '.agents/skills/alpha'));
  const cursor = await skill(path.join(f.options.homeDir, '.cursor/skills/alpha'), 'alpha', 'Different Cursor document');
  const copilot = await skill(path.join(f.options.homeDir, '.copilot/skills/alpha'));
  await fs.mkdir(path.join(f.options.homeDir, '.claude/skills'), { recursive: true });
  await fs.symlink(shared, path.join(f.options.homeDir, '.claude/skills/alias'));
  let snapshot = await f.service.initialize();
  assert.equal(snapshot.skills.length, 1);
  const canonical = snapshot.skills[0];
  assert.equal(canonical.path, shared);
  assert.deepEqual(canonical.agents, ['Universal', 'Claude Code', 'GitHub Copilot', 'Cursor']);
  assert.equal(canonical.installations.length, 3);
  const copies = new Map(canonical.installations.map(item => [item.path, item]));
  assert.deepEqual(copies.get(shared).agents, ['Universal', 'Claude Code']);
  assert.equal(copies.get(shared).isCanonical, true);
  assert.equal(copies.get(cursor).documentMatchesCanonical, false);
  assert.equal(copies.get(copilot).documentMatchesCanonical, true);
  assert.equal(new Set(canonical.installations.map(item => item.id)).size, 3);
  const cursorId = copies.get(cursor).id;
  await f.service.organize({ ids: [cursorId], tags: ['cursor-only'] });
  snapshot = await f.service.layout({ scopeId: 'global', items: [{ kind: 'skill', id: cursorId, position: { x: 9, y: 10 } }] });
  const cursorCopy = snapshot.skills[0].installations.find(item => item.id === cursorId);
  assert.deepEqual(cursorCopy.organization, { folderId: null, tags: ['cursor-only'] });
  assert.deepEqual(cursorCopy.position, { x: 9, y: 10 });
  assert.match((await f.service.readSkill(cursorId)).text, /Different Cursor document/);
  assert.deepEqual(snapshot.organization[canonical.id], undefined);
  const fresh = new ShelfService(f.options);
  assert.deepEqual((await fresh.initialize()).skills, snapshot.skills);
  const exported = await new SyncService({ service: fresh }).exportDocument();
  assert.equal(exported.skills.length, snapshot.skills.length);
  assert.deepEqual(exported.skills[0].tags, []);
  assert.equal((await fresh.workbenchSnapshot()).stats.totalSkills, snapshot.skills.length);
  for (const directory of [shared, cursor, copilot]) assert.equal((await fs.stat(path.join(directory, 'SKILL.md'))).isFile(), true);
  snapshot.skills[0].installations[0].agents.push('caller mutation');
  assert.equal((await fresh.snapshot()).skills[0].installations[0].agents.includes('caller mutation'), false);
});

test('nested dot-directory and system Skills stay outside the user catalog without pruning their legacy metadata', async t => {
  const f = await fixture(t);
  await skill(path.join(f.options.homeDir, '.agents/skills/alpha'));
  const system = await skill(path.join(f.options.homeDir, '.codex/skills/.system/builtin'), 'builtin');
  const hidden = await skill(path.join(f.options.homeDir, '.agents/skills/.hidden/private'), 'private');
  await f.service.initialize();
  const excluded = f.service.physicalSkills.filter(item => !item.userManaged);
  assert.equal(excluded.length, 2);
  const metadata = Object.fromEntries(excluded.map(item => [item.id, { folderId: null, tags: ['preserve'] }]));
  await f.service.mutate(async () => {
    Object.assign(f.service.state.organization, metadata);
    for (const item of excluded) f.service.state.finderPositions[`skill:${item.id}`] = { x: 30, y: 40 };
  });
  const fresh = new ShelfService(f.options);
  const snapshot = await fresh.initialize();
  assert.deepEqual(snapshot.skills.map(item => item.name), ['alpha']);
  assert.equal(snapshot.skills[0].installations.length, 1);
  for (const item of excluded) {
    assert.deepEqual(snapshot.organization[item.id], metadata[item.id]);
    assert.deepEqual(snapshot.finderPositions[`skill:${item.id}`], { x: 30, y: 40 });
    assert.equal(fresh.item(item.id).path, item.path);
  }
  assert.equal((await new SyncService({ service: fresh }).exportDocument()).skills.length, 1);
  assert.equal((await fresh.workbenchSnapshot()).stats.totalSkills, 1);
  assert.equal(await fs.readFile(path.join(system, 'SKILL.md'), 'utf8'), await fs.readFile(path.join(hidden, 'SKILL.md'), 'utf8').then(text => text.replace(/private/g, 'builtin')));
});

test('canonical source removal selects the remaining installation without copying or losing either path metadata', async t => {
  const f = await fixture(t);
  const shared = await skill(path.join(f.options.homeDir, '.agents/skills/alpha'));
  const cursor = await skill(path.join(f.options.homeDir, '.cursor/skills/alpha'), 'alpha', 'Cursor version');
  let snapshot = await f.service.initialize();
  const original = snapshot.skills[0];
  const variant = original.installations.find(item => item.path === cursor);
  await f.service.organize({ ids: [original.id], tags: ['shared'] });
  await f.service.organize({ ids: [variant.id], tags: ['cursor'] });
  await f.service.layout({ scopeId: 'global', items: [{ kind: 'skill', id: original.id, position: { x: 1, y: 2 } }, { kind: 'skill', id: variant.id, position: { x: 3, y: 4 } }] });
  await fs.rm(shared, { recursive: true });
  snapshot = await f.service.rescan();
  assert.equal(snapshot.skills[0].id, variant.id);
  assert.deepEqual(snapshot.organization[original.id].tags, ['shared']);
  assert.deepEqual(snapshot.finderPositions[`skill:${original.id}`], { x: 1, y: 2 });
  assert.deepEqual(snapshot.skills[0].installations[0].organization.tags, ['cursor']);
  const fresh = new ShelfService(f.options);
  snapshot = await fresh.initialize();
  assert.deepEqual(snapshot.finderPositions[`skill:${original.id}`], { x: 1, y: 2 });
  const exported = await new SyncService({ service: fresh }).exportDocument();
  assert.deepEqual(exported.skills[0].tags, ['cursor']);
  await skill(shared);
  snapshot = await fresh.rescan();
  assert.equal(snapshot.skills[0].id, original.id);
  assert.deepEqual(snapshot.skills[0].installations.find(item => item.isCanonical).organization.tags, ['shared']);
});

test('a visible direct Skill alias can expose a hidden physical Skill without counting it twice or depending on walk order', async t => {
  const f = await fixture(t);
  const sharedRoot = path.join(f.options.homeDir, '.agents/skills');
  const hiddenRoot = path.join(sharedRoot, '.hidden');
  const source = await skill(path.join(hiddenRoot, 'alpha'));
  await fs.symlink(source, path.join(sharedRoot, 'visible'));
  const snapshot = await f.service.initialize();
  assert.equal(snapshot.skills.length, 1);
  assert.equal(snapshot.skills[0].path, source);
  assert.equal(snapshot.skills[0].installations.length, 1);
  assert.equal((await f.service.workbenchSnapshot()).stats.totalSkills, 1);
});

test('ordinary nested Skills remain physical-only until exposed by a direct Skill symlink, preserving their legacy metadata', async t => {
  const f = await fixture(t);
  const sharedRoot = path.join(f.options.homeDir, '.agents/skills');
  await skill(path.join(sharedRoot, 'alpha'));
  const nested = await skill(path.join(sharedRoot, 'group/nested'), 'nested');
  const nestedDocument = await fs.readFile(path.join(nested, 'SKILL.md'));
  let snapshot = await f.service.initialize();
  assert.deepEqual(snapshot.skills.map(item => item.name), ['alpha']);
  const physical = f.service.physicalSkills.find(item => item.path === nested);
  assert.equal(physical.userManaged, false);
  assert.equal(f.service.item(physical.id).path, nested);
  await f.service.organize({ ids: [physical.id], tags: ['legacy nested'] });
  await f.service.layout({ scopeId: 'global', items: [{ kind: 'skill', id: physical.id, position: { x: 7, y: 8 } }] });
  const fresh = new ShelfService(f.options);
  snapshot = await fresh.initialize();
  assert.equal(snapshot.skills.length, 1);
  assert.deepEqual(snapshot.organization[physical.id], { folderId: null, tags: ['legacy nested'] });
  assert.deepEqual(snapshot.finderPositions[`skill:${physical.id}`], { x: 7, y: 8 });
  assert.match((await fresh.readSkill(physical.id)).text, /name: nested/);
  const sync = new SyncService({ service: fresh });
  assert.deepEqual((await sync.exportDocument()).skills.map(item => item.name), ['alpha']);
  await fs.symlink(nested, path.join(sharedRoot, 'zz-visible-nested'));
  snapshot = await fresh.rescan();
  assert.deepEqual(snapshot.skills.map(item => item.name), ['alpha', 'nested']);
  const visible = snapshot.skills.find(item => item.name === 'nested');
  assert.equal(visible.id, physical.id);
  assert.equal(visible.installations.length, 1);
  assert.deepEqual(visible.installations[0].organization.tags, ['legacy nested']);
  assert.deepEqual(visible.installations[0].position, { x: 7, y: 8 });
  assert.equal((await sync.exportDocument()).skills.length, snapshot.skills.length);
  assert.deepEqual(await fs.readFile(path.join(nested, 'SKILL.md')), nestedDocument);
});

test('source roots containing SKILL.md do not count themselves but still scan their direct child Skills', async t => {
  const f = await fixture(t);
  const sharedRoot = await skill(path.join(f.options.homeDir, '.agents/skills'), 'root-document');
  await skill(path.join(sharedRoot, 'alpha'));
  let snapshot = await f.service.initialize();
  assert.deepEqual(snapshot.skills.map(item => item.name), ['alpha']);
  const rootSkill = f.service.physicalSkills.find(item => item.path === sharedRoot);
  assert.equal(rootSkill.userManaged, false);
  assert.equal(f.service.item(rootSkill.id).path, sharedRoot);
  await f.service.organize({ ids: [rootSkill.id], tags: ['root legacy'] });
  snapshot = await f.service.layout({ scopeId: 'global', items: [{ kind: 'skill', id: rootSkill.id, position: { x: 11, y: 12 } }] });
  const fresh = new ShelfService(f.options);
  snapshot = await fresh.initialize();
  assert.equal(snapshot.skills.length, 1);
  assert.deepEqual(snapshot.organization[rootSkill.id].tags, ['root legacy']);
  assert.deepEqual(snapshot.finderPositions[`skill:${rootSkill.id}`], { x: 11, y: 12 });
  assert.deepEqual((await new SyncService({ service: fresh }).exportDocument()).skills.map(item => item.name), ['alpha']);
});

test('promoting a nested shared path through a direct Agent alias cannot steal canonical shared priority or claim shared installation coverage', async t => {
  const f = await fixture(t);
  const sharedRoot = path.join(f.options.homeDir, '.agents/skills');
  const directShared = await skill(path.join(sharedRoot, 'z-shared'), 'same-name', 'Canonical shared document');
  const nested = await skill(path.join(sharedRoot, 'a-group/nested'), 'same-name', 'Different nested document');
  await fs.mkdir(path.join(f.options.homeDir, '.cursor/skills'), { recursive: true });
  await fs.symlink(nested, path.join(f.options.homeDir, '.cursor/skills/direct-alias'));
  const snapshot = await f.service.initialize();
  assert.equal(snapshot.skills.length, 1);
  const canonical = snapshot.skills[0];
  assert.equal(canonical.path, directShared);
  assert.equal(canonical.sourceLabel, 'Universal');
  assert.deepEqual(canonical.agents, ['Universal', 'Cursor']);
  assert.equal(canonical.installations.length, 2);
  const variant = canonical.installations.find(item => item.path === nested);
  assert.equal(variant.isCanonical, false);
  assert.equal(variant.documentMatchesCanonical, false);
  assert.equal(variant.sourceLabel, 'Cursor');
  assert.deepEqual(variant.agents, ['Cursor']);
  const exported = await new SyncService({ service: f.service }).exportDocument();
  assert.equal(exported.skills.length, 1);
  await fs.rm(path.join(sharedRoot, 'z-shared'), { recursive: true });
  const remaining = (await f.service.rescan()).skills[0];
  assert.equal(remaining.path, nested);
  assert.equal(remaining.sourceLabel, 'Cursor');
  assert.deepEqual(remaining.agents, ['Cursor']);
});

test('custom sources use the same direct-child boundary and preserve nested source access and deployment safeguards', async t => {
  const f = await fixture(t);
  const customRoot = path.join(f.root, 'custom');
  const direct = await skill(path.join(customRoot, 'direct'), 'direct');
  const nested = await skill(path.join(customRoot, 'group/nested'), 'nested');
  await f.service.initialize();
  const snapshot = await f.service.addRoot({ path: customRoot, label: 'Custom' });
  assert.deepEqual(snapshot.skills.map(item => item.name), ['direct']);
  assert.equal(snapshot.skills[0].path, direct);
  const physical = f.service.physicalSkills.find(item => item.path === nested);
  assert.equal(physical.userManaged, false);
  assert.match((await f.service.readSkill(physical.id)).text, /name: nested/);
  assert.deepEqual((await new SyncService({ service: f.service }).exportDocument()).skills.map(item => item.name), ['direct']);
  const imported = await f.service.importSkills('default', { skillIds: [snapshot.skills[0].id] });
  await assert.rejects(f.service.deploy({ skillIds: [imported.managedSkills[0].id], targetPath: path.join(nested, 'inside'), mode: 'copy' }), /existing Skill source/);
});

test('project catalog keeps the same name and realpath independent of global scope and preserves project variants', async t => {
  const f = await fixture(t);
  const shared = await skill(path.join(f.options.homeDir, '.agents/skills/alpha'));
  await f.service.initialize();
  const project = path.join(f.root, 'project');
  await fs.mkdir(path.join(project, '.agents/skills'), { recursive: true });
  await fs.symlink(shared, path.join(project, '.agents/skills/alpha'));
  const variantPath = await skill(path.join(project, '.cursor/skills/alpha'), 'alpha', 'Project variant');
  let snapshot = await f.service.addProject({ path: project, name: 'Project' });
  assert.equal(snapshot.skills.length, 2);
  const global = snapshot.skills.find(item => item.scopeId === 'global');
  const projectSkill = snapshot.skills.find(item => item.scopeId !== 'global');
  assert.notEqual(global.id, projectSkill.id);
  assert.equal(projectSkill.path, shared);
  assert.equal(projectSkill.installations.length, 2);
  const variant = projectSkill.installations.find(item => item.path === variantPath);
  await f.service.organize({ ids: [variant.id], tags: ['project-only'] });
  await f.service.layout({ scopeId: projectSkill.scopeId, items: [{ kind: 'skill', id: variant.id, position: { x: 5, y: 6 } }] });
  const exported = await new SyncService({ service: f.service }).exportDocument();
  assert.deepEqual(exported.skills.map(item => item.scope).sort(), ['global', 'project']);
  snapshot = await f.service.removeProject(snapshot.projects[0].id);
  assert.equal(snapshot.skills.length, 1);
  assert.equal(snapshot.organization[variant.id], undefined);
  assert.equal(snapshot.finderPositions[`skill:${variant.id}`], undefined);
  assert.equal((await fs.stat(variantPath)).isDirectory(), true);
});

test('deployments still protect source directories excluded from the canonical catalog', async t => {
  const f = await fixture(t);
  await skill(path.join(f.options.homeDir, '.agents/skills/alpha'));
  const variant = await skill(path.join(f.options.homeDir, '.cursor/skills/alpha'), 'alpha', 'Variant');
  const system = await skill(path.join(f.options.homeDir, '.codex/skills/.system/builtin'), 'builtin');
  await f.service.initialize();
  const snapshot = await f.service.importSkills('default', { skillIds: [f.service.skills[0].id] });
  for (const directory of [variant, system]) {
    await assert.rejects(f.service.deploy({ skillIds: [snapshot.managedSkills[0].id], targetPath: path.join(directory, 'nested'), mode: 'copy' }), /existing Skill source/);
  }
});
