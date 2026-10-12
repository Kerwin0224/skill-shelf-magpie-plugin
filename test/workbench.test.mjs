import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ShelfService } from '../src/domain.mjs';
import { scanWorkbench, workbenchDirectory } from '../src/workbench.mjs';
import { startServer } from '../src/server.mjs';
import { createFixture } from '../scripts/test-fixtures.mjs';

async function setup(t, workbenchOptions = {}) {
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const options = { environment: { PATH: '' }, platform: 'linux', applicationDirectories: [], ...workbenchOptions };
  const service = new ShelfService({ ...fixture, workbenchOptions: options });
  await service.initialize();
  return { ...fixture, service, options, scan: extra => scanWorkbench({ ...fixture, ...options, ...extra }) };
}

async function skill(directory, name) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: A local test skill.\n---\n\n# ${name}\n`);
  return directory;
}

async function httpSetup(t, workbenchOptions = {}) {
  const shelf = await setup(t, workbenchOptions);
  const webDir = path.join(shelf.root, 'web');
  await fs.mkdir(webDir);
  await fs.writeFile(path.join(webDir, 'index.html'), '<title>Workbench tests</title>');
  const opened = [];
  const instance = await startServer({ service: shelf.service, port: 0, webDir, opener: async directory => { opened.push(directory); } });
  t.after(() => instance.close());
  const base = instance.url.replace(/\/$/, '');
  const { token } = await (await fetch(`${base}/api/session`)).json();
  const api = async (route, input, headers = {}) => {
    const response = await fetch(base + route, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { 'X-Shelf-Token': token, ...(input !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
    });
    return { response, data: await response.json() };
  };
  return { ...shelf, api, base, opened };
}

test('workbench returns the desktop snapshot contract with truthful registry and shared inventory', async t => {
  const shelf = await setup(t);
  const snapshot = await shelf.service.workbenchSnapshot();
  assert.equal(snapshot.stats.totalSkills, 2);
  assert.equal(snapshot.stats.sharedSkills, 1);
  assert.equal(snapshot.stats.exclusiveSkills, 1);
  assert.equal(snapshot.stats.detectedAgents, 0);
  assert.equal(snapshot.stats.directoryAgents, 1);
  assert.equal(snapshot.stats.linkedSkills, 0);
  assert.deepEqual(snapshot.sharedDirectory, { exists: true, path: path.join(shelf.homeDir, '.agents/skills'), skillNames: ['Alpha Research'], status: 'ready' });
  assert.equal(snapshot.registry.source, 'plugin-presets');
  assert.equal(snapshot.registry.cliVersion, '');
  assert.equal(snapshot.registry.agentCount, snapshot.registry.agents.length);
  assert.ok(snapshot.registry.agents.some(agent => agent.id === 'magpie'));
  assert.ok(!snapshot.registry.agents.some(agent => agent.id === 'universal'));
  assert.deepEqual(snapshot.programSearch, { source: 'process', paths: [] });
  assert.deepEqual(snapshot.untrackedSkills, []);
  assert.deepEqual(snapshot.scanWarnings, []);
  assert.equal(Number.isNaN(Date.parse(snapshot.scannedAt)), false);
  const claude = snapshot.agentCoverage.find(agent => agent.id === 'claude-code');
  assert.equal(claude.program.status, 'not-found');
  assert.equal(claude.directoryExists, true);
  assert.equal(claude.availableSkills, 0);
  assert.equal(claude.ratio, 0);
  assert.deepEqual(claude.missingSkillNames, ['Alpha Research']);
  assert.deepEqual(claude.exclusiveSkillNames, ['Beta Design']);
  assert.deepEqual(claude.localSkills, [{ name: 'Beta Design', kind: 'copy', path: shelf.beta, canonicalPath: shelf.beta }]);
});

test('coverage deduplicates names, separates shared/direct/linked availability and reports canonical aliases', async t => {
  const shelf = await setup(t);
  const claudeRoot = path.dirname(shelf.beta);
  await fs.symlink(shelf.alpha, path.join(claudeRoot, 'alpha-link'));
  await skill(path.join(claudeRoot, 'alpha-copy'), 'Alpha Research');
  await fs.mkdir(path.join(shelf.homeDir, '.codex/skills'), { recursive: true });
  const snapshot = await shelf.service.workbenchSnapshot();
  assert.equal(snapshot.stats.totalSkills, 2);
  assert.equal(snapshot.stats.linkedSkills, 1);
  assert.equal(snapshot.symlinkHealth.valid, 1);
  assert.equal(snapshot.symlinkHealth.direct, 3);
  const claude = snapshot.agentCoverage.find(agent => agent.id === 'claude-code');
  assert.equal(claude.availableSkills, 1);
  assert.equal(claude.ratio, 1);
  assert.equal(claude.linkedSkills, 1);
  assert.equal(claude.directSkills, 0);
  assert.equal(claude.sharedSkills, 0);
  assert.equal(claude.exclusiveSkills, 1);
  assert.deepEqual(claude.missingSkillNames, []);
  assert.equal(claude.localSkills.find(item => item.kind === 'symlink').canonicalPath, shelf.alpha);
  const codex = snapshot.agentCoverage.find(agent => agent.id === 'codex');
  assert.equal(codex.readsSharedDirectory, true);
  assert.equal(codex.availableSkills, 1);
  assert.equal(codex.sharedSkills, 1);
  assert.equal(codex.linkedSkills, 0);
  assert.equal(codex.directSkills, 0);
  assert.equal(snapshot.stats.directoryAgents, 2);
});

test('readable global custom and Magpie roots count, but project skills and Pack copies do not', async t => {
  const shelf = await setup(t);
  await skill(path.join(shelf.magpieDir, 'library/skills/magpie-skill'), 'Magpie Only');
  const customRoot = path.join(shelf.root, 'custom');
  await skill(path.join(customRoot, 'custom-skill'), 'Custom Only');
  await shelf.service.addRoot({ path: customRoot, label: 'Custom source' });
  const project = path.join(shelf.root, 'project');
  await skill(path.join(project, '.agents/skills/project-skill'), 'Project Only');
  await shelf.service.addProject({ path: project, label: 'Project' });
  const alpha = (await shelf.service.snapshot()).skills.find(item => item.name === 'Alpha Research' && item.scopeId === 'global');
  await shelf.service.importSkills('default', { skillIds: [alpha.id] });
  const snapshot = await shelf.service.workbenchSnapshot();
  assert.equal(snapshot.stats.totalSkills, 4);
  assert.equal(snapshot.stats.exclusiveSkills, 3);
  assert.equal(snapshot.symlinkHealth.direct, 4);
  assert.deepEqual(snapshot.untrackedSkills, []);
  assert.ok(snapshot.agentCoverage.some(agent => agent.name === 'Custom source' && agent.exclusiveSkillNames.includes('Custom Only')));
  assert.ok(!snapshot.agentCoverage.flatMap(agent => agent.localSkills).some(item => item.name === 'Project Only' || item.path.startsWith(shelf.dataDir)));
});

test('broken links, cycles, missing Skill documents and inaccessible files are distinct without reading scripts', async t => {
  const shelf = await setup(t);
  const root = path.dirname(shelf.beta);
  await fs.symlink('missing-target', path.join(root, 'broken'));
  await fs.symlink('cycle', path.join(root, 'cycle'));
  const empty = path.join(shelf.root, 'empty-target');
  await fs.mkdir(empty);
  await fs.symlink(empty, path.join(root, 'missing-document'));
  await fs.mkdir(path.join(root, 'helpers'));
  const inaccessible = await skill(path.join(root, 'unreadable'), 'Unreadable');
  const deniedDocument = path.join(inaccessible, 'SKILL.md');
  const filesystem = { ...fs, open: async (location, ...args) => {
    if (location === deniedDocument) throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    assert.ok(location.endsWith('SKILL.md'), `Only documents may be read: ${location}`);
    return fs.open(location, ...args);
  } };
  const snapshot = await shelf.scan({ filesystem });
  assert.equal(snapshot.symlinkHealth.broken, 2);
  assert.equal(snapshot.symlinkHealth.missingDocuments, 1);
  assert.equal(snapshot.symlinkHealth.inaccessible, 1);
  assert.equal(snapshot.symlinkHealth.valid, 1);
  assert.equal(snapshot.stats.totalSkills, 2);
  assert.deepEqual(snapshot.symlinkHealth.issues.map(item => item.status).sort(), ['broken', 'broken', 'inaccessible', 'missing-document']);
  assert.ok(snapshot.symlinkHealth.issues.every(item => item.agentNames.includes('Claude Code')));
  assert.ok(!snapshot.symlinkHealth.issues.some(item => item.path.endsWith('helpers')));
  assert.equal(await fs.readFile(path.join(shelf.alpha, 'scripts/run.sh'), 'utf8'), '#!/bin/sh\nprintf "fixture\\n"\n');
});

test('deleted known Skill document is reported without inspecting nested parent symlink cycles', async t => {
  const shelf = await setup(t);
  await fs.rm(path.join(shelf.beta, 'SKILL.md'));
  const group = path.join(path.dirname(shelf.beta), 'group');
  await fs.mkdir(group);
  await fs.symlink('..', path.join(group, 'back-to-parent'));
  const snapshot = await shelf.service.workbenchSnapshot();
  assert.equal(snapshot.symlinkHealth.missingDocuments, 1);
  assert.equal(snapshot.symlinkHealth.broken, 0);
  assert.equal(snapshot.stats.totalSkills, 1);
});

test('source roots, nested Skills and hidden system folders stay outside the desktop workbench inventory', async t => {
  const shelf = await setup(t);
  const sharedRoot = path.dirname(shelf.alpha);
  await skill(sharedRoot, 'Root document');
  const nested = await skill(path.join(sharedRoot, 'helpers/nested-skill'), 'Nested Skill');
  const system = await skill(path.join(shelf.homeDir, '.codex/skills/.system/builtin'), 'System Skill');
  const hidden = await skill(path.join(sharedRoot, '.hidden-skill'), 'Hidden Skill');
  await fs.symlink('..', path.join(sharedRoot, 'helpers/back-to-parent'));
  const opened = [];
  const directories = [];
  const filesystem = { ...fs,
    open: async (location, ...args) => { opened.push(location); return fs.open(location, ...args); },
    opendir: async location => { directories.push(location); return fs.opendir(location); },
  };
  const before = await fs.readFile(shelf.service.stateFile);
  const snapshot = await shelf.scan({ filesystem, knownSkillPaths: [nested, system, hidden] });
  assert.equal(snapshot.stats.totalSkills, 2);
  assert.deepEqual(snapshot.sharedDirectory.skillNames, ['Alpha Research']);
  assert.equal(snapshot.symlinkHealth.direct, 2);
  assert.equal(snapshot.symlinkHealth.broken, 0);
  assert.equal(snapshot.symlinkHealth.missingDocuments, 0);
  assert.deepEqual(snapshot.symlinkHealth.issues, []);
  assert.deepEqual(snapshot.scanWarnings, []);
  assert.ok(!opened.includes(path.join(sharedRoot, 'SKILL.md')));
  assert.ok([nested, system, hidden].every(directory => !opened.includes(path.join(directory, 'SKILL.md'))));
  assert.ok(!directories.includes(path.join(sharedRoot, 'helpers')));
  assert.deepEqual(await fs.readFile(shelf.service.stateFile), before);
});

test('alias source directories share one health scan and preserve their Agent coverage', async t => {
  const shelf = await setup(t);
  await fs.mkdir(path.join(shelf.homeDir, '.continue'), { recursive: true });
  await fs.symlink(path.dirname(shelf.beta), path.join(shelf.homeDir, '.continue/skills'));
  const snapshot = await shelf.service.workbenchSnapshot();
  assert.equal(snapshot.stats.totalSkills, 2);
  assert.equal(snapshot.symlinkHealth.direct, 2);
  assert.equal(snapshot.stats.directoryAgents, 2);
  const continued = snapshot.agentCoverage.find(agent => agent.id === 'continue');
  assert.equal(continued.program.status, 'unverified');
  assert.deepEqual(continued.exclusiveSkillNames, ['Beta Design']);
  assert.equal(continued.localSkills[0].path, path.join(shelf.homeDir, '.continue/skills/beta-skill'));
  assert.equal(continued.localSkills[0].canonicalPath, shelf.beta);
  assert.equal(continued.localSkills[0].kind, 'symlink');
  assert.equal(snapshot.agentCoverage.find(agent => agent.id === 'claude-code').localSkills[0].kind, 'copy');
});

test('program detection statically checks process PATH and never executes executable probes or login shells', async t => {
  const shelf = await setup(t);
  const bin = path.join(shelf.root, 'bin');
  await fs.mkdir(bin);
  const marker = path.join(shelf.root, 'executed');
  const command = path.join(bin, 'claude');
  await fs.writeFile(command, `#!/bin/sh\ntouch '${marker}'\n`);
  await fs.chmod(command, 0o755);
  await fs.writeFile(path.join(bin, 'codex'), '#!/bin/sh\n');
  await fs.chmod(path.join(bin, 'codex'), 0o600);
  const snapshot = await shelf.scan({ environment: { PATH: `relative${path.delimiter}${bin}${path.delimiter}${bin}`, SHELL: command } });
  assert.deepEqual(snapshot.programSearch, { source: 'process', paths: [bin] });
  assert.equal(snapshot.stats.detectedAgents, 1);
  const claude = snapshot.agentCoverage.find(agent => agent.id === 'claude-code');
  assert.equal(claude.program.status, 'found');
  assert.deepEqual(claude.program.evidence, [{ kind: 'command', path: command }]);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  assert.equal(snapshot.agentCoverage.find(agent => agent.id === 'magpie').program.status, 'not-found');
});

test('inaccessible PATH probes are unverified, never claimed absent or installed', async t => {
  const shelf = await setup(t);
  const bin = path.join(shelf.root, 'denied-bin');
  const filesystem = { ...fs, stat: async location => {
    if (location.startsWith(`${bin}${path.sep}`)) throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    return fs.stat(location);
  } };
  const snapshot = await shelf.scan({ filesystem, environment: { PATH: bin } });
  const claude = snapshot.agentCoverage.find(agent => agent.id === 'claude-code');
  assert.equal(claude.program.status, 'unverified');
  assert.deepEqual(claude.program.evidence, []);
  assert.equal(snapshot.stats.detectedAgents, 0);
});

test('a stale app directory is not program evidence; complete executable bundles are', async t => {
  const shelf = await setup(t);
  const applications = path.join(shelf.root, 'Applications');
  await fs.mkdir(path.join(applications, 'Codex.app'), { recursive: true });
  let snapshot = await shelf.scan({ platform: 'darwin', applicationDirectories: [applications] });
  assert.equal(snapshot.stats.detectedAgents, 0);
  const contents = path.join(applications, 'Cursor.app/Contents');
  await fs.mkdir(path.join(contents, 'MacOS'), { recursive: true });
  await fs.writeFile(path.join(contents, 'Info.plist'), '<plist/>');
  await fs.writeFile(path.join(contents, 'MacOS/cursor'), 'Not executed');
  await fs.chmod(path.join(contents, 'MacOS/cursor'), 0o755);
  snapshot = await shelf.scan({ platform: 'darwin', applicationDirectories: [applications] });
  const cursor = snapshot.agentCoverage.find(agent => agent.id === 'cursor');
  assert.equal(cursor.directoryExists, false);
  assert.equal(cursor.program.status, 'found');
  assert.deepEqual(cursor.program.evidence, [{ kind: 'application', path: path.join(applications, 'Cursor.app') }]);
});

test('document and entry budgets return partial inventory without inspecting deep helper folders', async t => {
  const shelf = await setup(t);
  const root = path.dirname(shelf.beta);
  const huge = path.join(root, 'too-large');
  await fs.mkdir(huge);
  await fs.writeFile(path.join(huge, 'SKILL.md'), 'x'.repeat(4 * 1024 * 1024 + 1));
  await skill(path.join(root, ...Array.from({ length: 18 }, (_, index) => `depth${index}`)), 'Too Deep');
  let snapshot = await shelf.scan();
  assert.equal(snapshot.stats.totalSkills, 2);
  assert.ok(snapshot.scanWarnings.some(item => item.includes('document scan limit')));
  assert.ok(!snapshot.scanWarnings.some(item => item.includes('Skill scan limit')));
  assert.ok(snapshot.symlinkHealth.issues.some(item => item.path === huge && item.status === 'inaccessible'));
  const filesystem = { ...fs, opendir: async location => {
    if (location !== path.join(shelf.homeDir, '.agents/skills')) return fs.opendir(location);
    return (async function* () {
      for (let index = 0; index < 20000; index += 1) yield { name: `file-${index}`, isDirectory: () => false, isSymbolicLink: () => false };
    })();
  } };
  snapshot = await shelf.scan({ filesystem });
  assert.ok(snapshot.scanWarnings.some(item => item.includes('Skill scan limit')));
  assert.equal(snapshot.stats.totalSkills, 0);
});

test('permission-denied shared directory remains distinct from missing and cannot be opened', async t => {
  const shelf = await setup(t);
  const shared = path.join(shelf.homeDir, '.agents/skills');
  const filesystem = { ...fs, access: async (location, ...args) => {
    if (location === shared) throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    return fs.access(location, ...args);
  } };
  const snapshot = await shelf.scan({ filesystem });
  assert.equal(snapshot.sharedDirectory.exists, true);
  assert.equal(snapshot.sharedDirectory.status, 'inaccessible');
  assert.equal(snapshot.stats.sharedSkills, 0);
  assert.equal(snapshot.symlinkHealth.inaccessible, 1);
  assert.ok(snapshot.symlinkHealth.issues.some(issue => issue.path === shared && issue.status === 'inaccessible'));
  await assert.rejects(workbenchDirectory('shared', { ...shelf, filesystem }), failure => failure.status === 403 && /inaccessible/.test(failure.message));
  await assert.rejects(workbenchDirectory('cursor', shelf), failure => failure.status === 404 && /missing/.test(failure.message));
});

test('concurrent snapshot requests coalesce, while a later request scans changed files freshly', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let scans = 0;
  const filesystem = { ...fs, opendir: async location => {
    if (location.endsWith(`${path.sep}.agents${path.sep}skills`)) { scans += 1; await gate; }
    return fs.opendir(location);
  } };
  const shelf = await setup(t, { filesystem });
  const first = shelf.service.workbenchSnapshot();
  const second = shelf.service.workbenchSnapshot();
  assert.equal(first, second);
  release();
  assert.equal((await first).stats.totalSkills, 2);
  assert.equal(scans, 1);
  await skill(path.join(path.dirname(shelf.alpha), 'new-skill'), 'New Skill');
  assert.equal((await shelf.service.workbenchSnapshot()).stats.totalSkills, 3);
  assert.equal(scans, 2);
});

test('physical shared aliases are shared readers, and managed storage links never inflate global inventory', async t => {
  const shelf = await setup(t);
  await fs.mkdir(path.join(shelf.magpieDir, 'library'));
  await fs.symlink(path.dirname(shelf.alpha), path.join(shelf.magpieDir, 'library/skills'));
  const state = await shelf.service.snapshot();
  const alpha = state.skills.find(item => item.name === 'Alpha Research');
  await shelf.service.importSkills('default', { skillIds: [alpha.id] });
  await fs.symlink(shelf.service.skillDir, path.join(path.dirname(shelf.beta), 'pack-storage'));
  const snapshot = await shelf.service.workbenchSnapshot();
  const magpie = snapshot.agentCoverage.find(agent => agent.id === 'magpie');
  assert.equal(magpie.readsSharedDirectory, true);
  assert.equal(magpie.sharedSkills, 1);
  assert.deepEqual(magpie.localSkills, []);
  assert.equal(snapshot.stats.totalSkills, 2);
  assert.equal(snapshot.stats.directoryAgents, 1);
  assert.equal(snapshot.symlinkHealth.direct, 2);
  assert.equal(snapshot.symlinkHealth.valid, 0);
});

test('authenticated workbench and ID-only native opening never mutate Skills, aliases or plugin state', async t => {
  const shelf = await httpSetup(t);
  const alias = path.join(path.dirname(shelf.beta), 'alpha-link');
  await fs.symlink(shelf.alpha, alias);
  const before = {
    source: await fs.readFile(path.join(shelf.alpha, 'SKILL.md')),
    stat: await fs.lstat(path.join(shelf.alpha, 'SKILL.md')),
    state: await fs.readFile(shelf.service.stateFile),
    link: await fs.lstat(alias),
  };
  const result = await shelf.api('/api/workbench');
  assert.equal(result.response.status, 200);
  assert.match(result.response.headers.get('cache-control'), /no-store/);
  assert.equal(result.data.stats.totalSkills, 2);
  assert.equal(result.data.stats.linkedSkills, 1);
  const ids = ['shared', 'claude-code'];
  for (const id of ids) {
    const opened = await shelf.api('/api/workbench/open-directory', { id });
    assert.equal(opened.response.status, 200);
    assert.deepEqual(opened.data, { opened: true });
  }
  assert.deepEqual(shelf.opened, [path.join(shelf.homeDir, '.agents/skills'), path.dirname(shelf.beta)]);
  assert.deepEqual(await fs.readFile(shelf.service.stateFile), before.state);
  assert.deepEqual(await fs.readFile(path.join(shelf.alpha, 'SKILL.md')), before.source);
  assert.equal((await fs.lstat(path.join(shelf.alpha, 'SKILL.md'))).mtimeMs, before.stat.mtimeMs);
  assert.equal((await fs.lstat(alias)).ino, before.link.ino);
  assert.equal((await fs.lstat(alias)).mtimeMs, before.link.mtimeMs);
});

test('workbench routes reject missing auth, CSRF, arbitrary paths, extra keys, unknown IDs and absent directories', async t => {
  const shelf = await httpSetup(t);
  const get = '/api/workbench';
  const open = '/api/workbench/open-directory';
  for (const headers of [{ 'X-Shelf-Token': '' }, { 'X-Shelf-Token': 'wrong' }, { Origin: 'https://attacker.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await shelf.api(get, undefined, headers)).response.status, 403);
    assert.equal((await shelf.api(open, { id: 'shared' }, headers)).response.status, 403);
  }
  for (const input of [{}, { id: '' }, { id: 5 }, { id: null }, { path: shelf.homeDir }, { id: 'shared', path: shelf.homeDir }, { id: ['shared'] }]) {
    assert.equal((await shelf.api(open, input)).response.status, 400);
  }
  for (const id of ['unknown', '../../shared', shelf.homeDir, 'cursor']) assert.equal((await shelf.api(open, { id })).response.status, 404);
  assert.equal((await shelf.api(open)).response.status, 404);
  assert.equal((await shelf.api('/api/workbench/extra')).response.status, 404);
  assert.equal((await shelf.api(open + '/extra', { id: 'shared' })).response.status, 404);
  assert.equal((await shelf.api(open, { id: 'shared' }, { 'Content-Type': 'text/plain' })).response.status, 415);
  await fs.rename(path.dirname(shelf.beta), path.join(shelf.root, 'renamed'));
  assert.equal((await shelf.api(open, { id: 'claude-code' })).response.status, 404);
  assert.deepEqual(shelf.opened, []);
});

test('HTTP workbench exposes inaccessible directory status and opening returns a clear permission error', async t => {
  const filesystem = { ...fs, access: async (location, ...args) => {
    if (location.endsWith(`${path.sep}.agents${path.sep}skills`)) throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    return fs.access(location, ...args);
  } };
  const shelf = await httpSetup(t, { filesystem });
  const snapshot = await shelf.api('/api/workbench');
  assert.equal(snapshot.response.status, 200);
  assert.equal(snapshot.data.sharedDirectory.status, 'inaccessible');
  const opened = await shelf.api('/api/workbench/open-directory', { id: 'shared' });
  assert.equal(opened.response.status, 403);
  assert.match(opened.data.error, /inaccessible/);
  assert.deepEqual(shelf.opened, []);
});
