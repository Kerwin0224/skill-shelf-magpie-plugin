import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, rename, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ShelfService } from '../src/domain.mjs';
import { SkillOperations, SKILLS_CLI_VERSION, checkTrackedSkill, runSkillsCli } from '../src/skill-operations.mjs';

const OLD = 'a'.repeat(40), NEW = 'b'.repeat(40);
const status = value => error => error.status === value;
const lockEntry = (name = 'alpha', overrides = {}) => ({ source: 'example/skills', sourceType: 'github', sourceUrl: 'https://github.com/example/skills', skillPath: `skills/${name}/SKILL.md`, skillFolderHash: OLD, ...overrides });
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const tree = (names = ['alpha'], hash = NEW) => ({ sha: NEW, tree: names.map(name => ({ path: `skills/${name}`, sha: hash, type: 'tree' })), truncated: false });
const cliSuccess = { code: 0, stdout: 'Installed 1 skill', stderr: '', timedOut: false };

async function writeSkill(root, name, body = 'original') {
  const directory = join(root, name);
  await mkdir(join(directory, 'scripts'), { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Example skill\n---\n# ${name}\n${body}\n`);
  await writeFile(join(directory, 'scripts', 'do-not-run.sh'), '#!/bin/sh\nexit 99\n');
  return directory;
}

async function fixture(t, names = ['alpha']) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'skill-shelf-test-operations-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const homeDir = join(root, 'home');
  await mkdir(homeDir);
  const service = new ShelfService({ homeDir, dataDir: join(root, 'data'), magpieDir: join(root, 'magpie') });
  for (const name of names) await writeSkill(join(homeDir, '.agents', 'skills'), name);
  const lockPath = join(homeDir, '.agents', '.skill-lock.json');
  await mkdir(join(homeDir, '.agents'), { recursive: true });
  const locks = Object.fromEntries(names.map(name => [name, lockEntry(name)]));
  await writeFile(lockPath, JSON.stringify({ version: 3, skills: locks }));
  await service.initialize();
  const calls = [];
  const runner = async (...args) => { calls.push(args); return cliSuccess; };
  const operations = new SkillOperations({ service, runner, fetcher: async () => response(tree(names)), gitTreeFetcher: null, now: () => new Date('2026-10-12T08:00:00Z'), environment: {} });
  return { root, homeDir, service, lockPath, locks, operations, calls };
}

test('upstream scan compares tree hashes, groups repository requests, reports all catalog entries, and writes nothing', async t => {
  const f = await fixture(t, ['alpha', 'beta']);
  const source = join(f.homeDir, '.agents', 'skills', 'alpha', 'SKILL.md');
  const before = await readFile(source), persisted = await readFile(f.service.stateFile), lock = await readFile(f.lockPath);
  const requests = [], progress = [];
  f.operations.fetcher = async (...args) => { requests.push(args); return response(tree(['alpha', 'beta'])); };
  const result = await f.operations.scanUpdates({ onProgress: event => progress.push(event) });
  assert.equal(requests.length, 1);
  assert.match(requests[0][0], /api.github.com\/repos\/example\/skills\/git\/trees\/HEAD\?recursive=1/);
  assert.equal(result.updates.scanning, false);
  assert.equal(result.updates.total, 2);
  assert.equal(result.updates.completed, 2);
  assert.equal(result.updates.summary['update-available'], 2);
  assert.equal(progress.length, 2);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await readFile(source), before);
  assert.deepEqual(await readFile(f.service.stateFile), persisted);
  assert.deepEqual(await readFile(f.lockPath), lock);
});

test('scan labels local/unsupported/untracked sources without remote traffic', async t => {
  const f = await fixture(t, ['local', 'unsupported', 'untracked', 'malformed']);
  await writeFile(f.lockPath, JSON.stringify({ skills: { local: lockEntry('local', { sourceType: 'local' }), unsupported: lockEntry('unsupported', { sourceType: 'gitlab' }), malformed: lockEntry('malformed', { skillPath: '../SKILL.md' }) } }));
  f.operations.fetcher = () => { throw new Error('No network allowed for these sources'); };
  const result = await f.operations.scanUpdates();
  const byName = new Map(result.state.skills.map(skill => [skill.name, result.updates.checks[skill.id]]));
  assert.equal(byName.get('local').reason, 'local-source');
  assert.equal(byName.get('unsupported').reason, 'unsupported-source');
  assert.equal(byName.get('untracked').reason, 'untracked');
  assert.equal(byName.get('malformed').reason, 'untracked');
  assert.equal(result.updates.summary.unavailable, 4);
});

test('scan caps concurrent repository lookups at three and only sends GitHub credentials to fixed API host', async t => {
  const names = Array.from({ length: 8 }, (_, index) => `skill-${index}`);
  const f = await fixture(t, names);
  await writeFile(f.lockPath, JSON.stringify({ skills: Object.fromEntries(names.map((name, index) => [name, lockEntry(name, { source: `example/repo-${index}` })])) }));
  let active = 0, peak = 0, requests = 0;
  f.operations.environment = { GITHUB_TOKEN: 'isolated-fixture-token' };
  f.operations.fetcher = async (url, options) => {
    active += 1; peak = Math.max(peak, active); requests += 1;
    assert.equal(new URL(url).hostname, 'api.github.com');
    assert.equal(options.headers.Authorization, 'Bearer isolated-fixture-token');
    assert.equal(options.redirect, 'error');
    await new Promise(accept => setImmediate(accept)); active -= 1;
    return response(tree(names));
  };
  const result = await f.operations.scanUpdates();
  assert.equal(requests, 8); assert.equal(peak, 3); assert.equal(result.updates.summary['update-available'], 8);
});

test('XDG global lock selection matches the pinned CLI instead of reading a different home lock', async t => {
  const f = await fixture(t);
  const stateHome = join(f.root, 'xdg-state'); await mkdir(join(stateHome, 'skills'), { recursive: true });
  await writeFile(join(stateHome, 'skills', '.skill-lock.json'), JSON.stringify({ skills: { alpha: lockEntry('alpha', { skillFolderHash: NEW }) } }));
  f.operations.environment = { XDG_STATE_HOME: stateHome };
  const result = await f.operations.scanUpdates();
  assert.equal(result.updates.summary.current, 1);
});

test('scan uses project lock and project ref without global/project identity conflation', async t => {
  const f = await fixture(t);
  const project = join(f.root, 'project'); await mkdir(project);
  await writeSkill(join(project, '.agents', 'skills'), 'alpha');
  await writeFile(join(project, 'skills-lock.json'), JSON.stringify({ skills: { alpha: lockEntry('alpha', { ref: 'feature/example', skillFolderHash: NEW }) } }));
  await f.service.addProject({ path: project });
  const urls = [];
  f.operations.fetcher = async url => { urls.push(url); return response(tree()); };
  const result = await f.operations.scanUpdates();
  assert.equal(result.state.skills.length, 2);
  const global = result.state.skills.find(skill => skill.scopeId === 'global');
  const local = result.state.skills.find(skill => skill.scopeId !== 'global');
  assert.equal(result.updates.checks[global.id].status, 'update-available');
  assert.equal(result.updates.checks[local.id].status, 'current');
  assert.equal(urls.some(url => url.includes('feature%2Fexample')), true);
});

test('scan falls back only when needed and uses desktop missing/current/error states', async t => {
  const f = await fixture(t);
  let fallback = 0;
  f.operations.fetcher = async () => response({}, 403);
  f.operations.gitTreeFetcher = async (source, ref) => { fallback += 1; assert.equal(source, 'example/skills'); assert.equal(ref, 'HEAD'); return { status: 'available', rootSha: NEW, tree: [{ path: 'skills/alpha', sha: OLD, type: 'tree' }] }; };
  let result = await f.operations.scanUpdates();
  assert.equal(result.updates.summary.current, 1); assert.equal(fallback, 1);
  f.operations.fetcher = async () => response(tree([], NEW));
  result = await f.operations.scanUpdates();
  assert.equal(result.updates.summary.missing, 1); assert.equal(fallback, 1);
  f.operations.fetcher = async () => response({ ...tree([]), truncated: true });
  result = await f.operations.scanUpdates();
  assert.equal(Object.values(result.updates.checks)[0].reason, 'network-error');
  f.operations.gitTreeFetcher = null;
  f.operations.fetcher = async () => response({}, 404);
  result = await f.operations.scanUpdates();
  assert.equal(Object.values(result.updates.checks)[0].reason, 'source-unavailable');
  assert.equal(checkTrackedSkill(lockEntry('alpha', { skillPath: 'SKILL.md' }), { status: 'available', rootSha: OLD, tree: [] }, 'now').status, 'current');
});

test('update preserves @ and percent characters in tracked refs by encoding CLI fragments', async t => {
  const f = await fixture(t);
  await writeFile(f.lockPath, JSON.stringify({ skills: { alpha: lockEntry('alpha', { ref: 'release@v2%ready' }) } }));
  const { state, updates } = await f.operations.scanUpdates();
  await f.operations.update({ skillIds: [state.skills[0].id], scanId: updates.scanId, confirmed: true });
  assert.equal(f.calls[0][0][1], 'example/skills/skills/alpha#release%40v2%25ready');
});

test('unsafe tracked source subpaths do not become ambiguous CLI fragments', async t => {
  const f = await fixture(t);
  for (const skillPath of ['skills/alpha#other/SKILL.md', 'skills/alpha@other/SKILL.md', 'skills/alpha%2fother/SKILL.md']) {
    await writeFile(f.lockPath, JSON.stringify({ skills: { alpha: lockEntry('alpha', { skillPath }) } }));
    const result = await f.operations.scanUpdates();
    assert.equal(Object.values(result.updates.checks)[0].reason, 'untracked');
  }
  assert.equal(f.calls.length, 0);
});

test('updates require current scan, explicit confirmation and selected update-available ids', async t => {
  const f = await fixture(t);
  const id = (await f.service.snapshot()).skills[0].id;
  await assert.rejects(f.operations.update({ skillIds: [id], confirmed: true, scanId: 'never-scanned' }), status(409));
  const { updates } = await f.operations.scanUpdates();
  for (const input of [{ skillIds: [], scanId: updates.scanId, confirmed: true }, { skillIds: [id], scanId: updates.scanId }, { skillIds: [id], scanId: 'stale', confirmed: true }, { skillIds: ['unknown'], scanId: updates.scanId, confirmed: true }]) await assert.rejects(f.operations.update(input), status(409));
  f.operations.fetcher = async () => response(tree(['alpha'], OLD));
  const current = await f.operations.scanUpdates();
  await assert.rejects(f.operations.update({ skillIds: [id], scanId: current.updates.scanId, confirmed: true }), status(409));
  assert.equal(f.calls.length, 0);
});

test('scans expire after thirty minutes and stale scans never execute an updater', async t => {
  const f = await fixture(t);
  let time = Date.parse('2026-10-12T08:00:00Z');
  f.operations.now = () => new Date(time);
  const { state, updates } = await f.operations.scanUpdates();
  time += 30 * 60 * 1000;
  await assert.rejects(f.operations.update({ skillIds: [state.skills[0].id], scanId: updates.scanId, confirmed: true }), status(409));
  assert.equal(f.calls.length, 0);
});

test('selected updates re-add just selected Skills without destructive CLI update or unselected changes', async t => {
  const f = await fixture(t, ['alpha', 'beta']);
  const { state, updates } = await f.operations.scanUpdates();
  const alpha = state.skills.find(skill => skill.name === 'alpha'), beta = state.skills.find(skill => skill.name === 'beta');
  const betaBefore = await readFile(join(beta.path, 'SKILL.md'));
  const result = await f.operations.update({ skillIds: [alpha.id, alpha.id], scanId: updates.scanId, confirmed: true });
  assert.equal(result.success, true); assert.equal(result.results.length, 1); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0][0], ['add', 'example/skills/skills/alpha', '--skill', 'alpha', '--global', '--yes', '--agent', 'universal']);
  assert.deepEqual(await readFile(join(beta.path, 'SKILL.md')), betaBefore);
  assert.equal(result.updates.scanId, null); assert.equal(result.updates.updating, false);
  assert.equal(result.updates.checks[alpha.id].status, 'unchecked');
  await assert.rejects(f.operations.update({ skillIds: [alpha.id], scanId: updates.scanId, confirmed: true }), status(409));
});

test('project updates are limited to chosen project and preserve tracked refs', async t => {
  const f = await fixture(t, []);
  const project = join(f.root, 'project'); await mkdir(project);
  await writeSkill(join(project, '.agents', 'skills'), 'alpha');
  await writeFile(join(project, 'skills-lock.json'), JSON.stringify({ skills: { alpha: lockEntry('alpha', { ref: 'main' }) } }));
  await f.service.addProject({ path: project });
  f.operations.fetcher = async () => response(tree());
  const { state, updates } = await f.operations.scanUpdates();
  const result = await f.operations.update({ skillIds: [state.skills[0].id], scanId: updates.scanId, confirmed: true });
  assert.equal(result.success, true); assert.equal(f.calls[0][1], project);
  assert.deepEqual(f.calls[0][0], ['add', 'example/skills/skills/alpha#main', '--skill', 'alpha', '--yes', '--agent', 'universal']);
});

test('updates refuse changed docs, scripts, lock identities and replaced directories before CLI', async t => {
  const f = await fixture(t);
  const skill = (await f.service.snapshot()).skills[0];
  let result = await f.operations.scanUpdates();
  await writeFile(join(skill.path, 'scripts', 'do-not-run.sh'), 'modified');
  await assert.rejects(f.operations.update({ skillIds: [skill.id], scanId: result.updates.scanId, confirmed: true }), status(409));
  result = await f.operations.scanUpdates();
  await writeFile(f.lockPath, JSON.stringify({ skills: { alpha: lockEntry('alpha', { source: 'changed/repository' }) } }));
  await assert.rejects(f.operations.update({ skillIds: [skill.id], scanId: result.updates.scanId, confirmed: true }), status(409));
  result = await f.operations.scanUpdates();
  await rename(skill.path, `${skill.path}-old`);
  await symlink(`${skill.path}-old`, skill.path);
  await assert.rejects(f.operations.update({ skillIds: [skill.id], scanId: result.updates.scanId, confirmed: true }), status(409));
  assert.equal(f.calls.length, 0);
});

test('independent copies remain inspectable and are never silently overwritten by updating logical Skill', async t => {
  const f = await fixture(t);
  const copy = await writeSkill(join(f.homeDir, '.cursor', 'skills'), 'alpha', 'different document');
  await f.service.rescan();
  const { state, updates } = await f.operations.scanUpdates();
  assert.equal(state.skills.length, 1); assert.equal(state.skills[0].installations.length, 2);
  const before = await readFile(join(copy, 'SKILL.md'));
  await assert.rejects(f.operations.update({ skillIds: [state.skills[0].id], scanId: updates.scanId, confirmed: true }), status(409));
  assert.equal(f.calls.length, 0); assert.deepEqual(await readFile(join(copy, 'SKILL.md')), before);
});

test('updating a shared Skill leaves existing differently-named Agent aliases and unrelated destinations untouched', async t => {
  const f = await fixture(t);
  const canonical = join(f.homeDir, '.agents', 'skills', 'alpha');
  const agentRoot = join(f.homeDir, '.claude', 'skills'); await mkdir(agentRoot, { recursive: true });
  await symlink(canonical, join(agentRoot, 'custom-alias'));
  const unrelated = await writeSkill(agentRoot, 'alpha', 'different name in the frontmatter');
  await writeFile(join(unrelated, 'SKILL.md'), '---\nname: unrelated\ndescription: This is not alpha\n---\nOriginal content\n');
  await f.service.rescan();
  const { state, updates } = await f.operations.scanUpdates();
  const alpha = state.skills.find(skill => skill.name === 'alpha');
  assert.equal(alpha.agents.includes('Claude Code'), true);
  const before = await readFile(join(unrelated, 'SKILL.md'));
  await f.operations.update({ skillIds: [alpha.id], scanId: updates.scanId, confirmed: true });
  assert.deepEqual(f.calls[0][0].slice(-2), ['--agent', 'universal']);
  assert.deepEqual(await readFile(join(unrelated, 'SKILL.md')), before);
});

test('a tracked Skill with a manually mismatched directory slug never writes into a guessed CLI destination', async t => {
  const f = await fixture(t);
  await rename(join(f.homeDir, '.agents', 'skills', 'alpha'), join(f.homeDir, '.agents', 'skills', 'manually-renamed'));
  await f.service.rescan();
  const { state, updates } = await f.operations.scanUpdates();
  await assert.rejects(f.operations.update({ skillIds: [state.skills[0].id], scanId: updates.scanId, confirmed: true }), status(409));
  assert.equal(f.calls.length, 0);
});

test('validation of all selected ids is atomic and partial CLI failure does not mark unchecked items current', async t => {
  const f = await fixture(t, ['alpha', 'beta']);
  let result = await f.operations.scanUpdates();
  const ids = result.state.skills.map(skill => skill.id);
  await assert.rejects(f.operations.update({ skillIds: [ids[0], 'missing'], scanId: result.updates.scanId, confirmed: true }), status(409));
  assert.equal(f.calls.length, 0);
  let calls = 0;
  f.operations.runner = async () => { calls += 1; if (calls === 1) return cliSuccess; throw new Error('mock failure'); };
  result = await f.operations.update({ skillIds: ids, scanId: result.updates.scanId, confirmed: true });
  assert.equal(result.success, false); assert.equal(result.results.length, 2); assert.equal(result.results[0].success, true); assert.equal(result.results[1].success, false);
  assert.equal(Object.values(result.updates.checks).every(check => check.status === 'unchecked'), true);
});

test('each selected Skill is revalidated immediately before its command, preserving edits during an earlier update', async t => {
  const f = await fixture(t, ['alpha', 'beta']);
  const { state, updates } = await f.operations.scanUpdates();
  const beta = state.skills.find(skill => skill.name === 'beta');
  let calls = 0;
  f.operations.runner = async () => { calls += 1; await writeFile(join(beta.path, 'scripts', 'do-not-run.sh'), 'user edit made during another update'); return cliSuccess; };
  const result = await f.operations.update({ skillIds: state.skills.map(skill => skill.id), scanId: updates.scanId, confirmed: true });
  assert.equal(calls, 1); assert.equal(result.success, false); assert.equal(result.results[1].success, false);
  assert.equal(await readFile(join(beta.path, 'scripts', 'do-not-run.sh'), 'utf8'), 'user edit made during another update');
});

test('CLI zero exit status with reported per-Agent install failures is not reported as success', async t => {
  const f = await fixture(t);
  f.operations.runner = async () => ({ ...cliSuccess, stdout: 'Installed 1 skill\nFailed to install 1\nDone!' });
  const scan = await f.operations.scanUpdates();
  const result = await f.operations.update({ skillIds: scan.state.skills.map(skill => skill.id), scanId: scan.updates.scanId, confirmed: true });
  assert.equal(result.success, false);
});

test('busy operations are rejected while progress remains readable', async t => {
  const f = await fixture(t);
  let release, started;
  const wait = new Promise(accept => { release = accept; });
  const ready = new Promise(accept => { started = accept; });
  f.operations.fetcher = async () => { started(); await wait; return response(tree()); };
  const scanning = f.operations.scanUpdates(); await ready;
  assert.equal(f.operations.status().scanning, true);
  await assert.rejects(f.operations.scanUpdates(), status(409));
  await assert.rejects(f.operations.update({}), status(409));
  release(); await scanning;
  assert.equal(f.operations.status().scanning, false);
});

test('service shutdown aborts an in-flight upstream lookup without invoking the Git fallback', async t => {
  const f = await fixture(t);
  let began;
  const started = new Promise(accept => { began = accept; });
  let fallback = 0;
  f.operations.gitTreeFetcher = async () => { fallback += 1; throw new Error('Git must not run after cancellation'); };
  f.operations.fetcher = async (url, { signal }) => {
    began();
    return new Promise((accept, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted isolated fetch')), { once: true }));
  };
  const scanning = f.operations.scanUpdates(); await started;
  f.operations.close();
  await assert.rejects(scanning, status(499));
  assert.equal(f.operations.status().scanning, false); assert.equal(f.operations.status().scanId, null); assert.equal(fallback, 0);
  await assert.rejects(f.operations.scanUpdates(), status(503));
});

test('service shutdown cancels a pending confirmed update and prevents later CLI calls', async t => {
  const f = await fixture(t);
  const scan = await f.operations.scanUpdates();
  const before = await readFile(join(f.homeDir, '.agents', 'skills', 'alpha', 'SKILL.md'));
  let began;
  const started = new Promise(accept => { began = accept; });
  f.operations.runner = async (args, cwd, options) => {
    began();
    return new Promise(accept => options.signal.addEventListener('abort', () => accept({ code: null, stdout: '', stderr: '', cancelled: true }), { once: true }));
  };
  const input = { skillIds: scan.state.skills.map(skill => skill.id), scanId: scan.updates.scanId, confirmed: true };
  const updating = f.operations.update(input);
  await started; f.operations.close();
  const result = await updating;
  assert.equal(result.success, false);
  assert.equal(result.updates.updating, false);
  assert.deepEqual(await readFile(join(f.homeDir, '.agents', 'skills', 'alpha', 'SKILL.md')), before);
  await assert.rejects(f.operations.update(input), status(503));
});

test('CLI launcher uses one argv, isolated HOME, no shell, disabled telemetry and does not execute Skill scripts', async t => {
  const f = await fixture(t);
  const fakeCli = join(f.root, 'fake-cli.mjs');
  await writeFile(fakeCli, `console.log(JSON.stringify({args:process.argv.slice(2),home:process.env.HOME,telemetry:process.env.DISABLE_TELEMETRY,cache:process.env.NODE_DISABLE_COMPILE_CACHE,cwd:process.cwd()}));`);
  const source = 'literal;$(touch-marker)';
  const result = await runSkillsCli(['add', source, '--yes'], f.homeDir, { homeDir: f.homeDir, cliPath: fakeCli, environment: {} });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { args: ['add', source, '--yes'], home: f.homeDir, telemetry: '1', cache: '1', cwd: f.homeDir });
  assert.equal((await readFile(join(f.homeDir, '.agents', 'skills', 'alpha', 'scripts', 'do-not-run.sh'), 'utf8')).includes('exit 99'), true);
});

test('CLI launcher bounds output and terminates timed-out commands', async t => {
  const f = await fixture(t);
  const slow = join(f.root, 'slow.mjs');
  await writeFile(slow, 'setInterval(()=>{},1000);');
  const result = await runSkillsCli([], f.homeDir, { cliPath: slow, homeDir: f.homeDir, environment: {}, timeoutMs: 75 });
  assert.equal(result.timedOut, true); assert.notEqual(result.code, 0);
  const loud = join(f.root, 'loud.mjs');
  await writeFile(loud, "process.stdout.write('x'.repeat(3*1024*1024));setInterval(()=>{},1000);");
  const excessive = await runSkillsCli([], f.homeDir, { cliPath: loud, homeDir: f.homeDir, environment: {}, timeoutMs: 5000 });
  assert.equal(excessive.outputExceeded, true);
  assert.equal(excessive.stdout.length <= 2 * 1024 * 1024, true);
  const preAborted = new AbortController(); preAborted.abort();
  const cancelled = await runSkillsCli([], f.homeDir, { signal: preAborted.signal, cliPath: 'must-not-spawn-this-missing-file' });
  assert.equal(cancelled.cancelled, true);
});

test('a clone that dies mid-transfer is a failed update even when the CLI exits zero', async t => {
  const f = await fixture(t);
  f.operations.runner = async () => ({ code: 0, stdout: 'Failed to clone repository\nfatal: early EOF', stderr: '', timedOut: false });
  const { state, updates } = await f.operations.scanUpdates();
  const result = await f.operations.update({ skillIds: [state.skills[0].id], scanId: updates.scanId, confirmed: true });
  assert.equal(result.success, false);
  assert.equal(result.results[0].success, false);
});

test('an update whose files never landed is a failure and rolls the version record back', async t => {
  const f = await fixture(t);
  const remoteSkill = '---\nname: alpha\ndescription: Example skill\n---\n# alpha\nupdated\n';
  const remoteScript = '#!/bin/sh\nexit 99\n';
  const blob = text => { const bytes = Buffer.from(text); return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); };
  f.operations.fetcher = async () => response({ sha: NEW, truncated: false, tree: [
    { path: 'skills', sha: 'c'.repeat(40), type: 'tree' },
    { path: 'skills/alpha', sha: NEW, type: 'tree' },
    { path: 'skills/alpha/SKILL.md', sha: blob(remoteSkill), type: 'blob' },
    { path: 'skills/alpha/scripts/do-not-run.sh', sha: blob(remoteScript), type: 'blob' },
  ] });
  // The installer advanced the lock without writing the new files.
  f.operations.runner = async () => {
    const document = JSON.parse(await readFile(f.lockPath, 'utf8'));
    document.skills.alpha.skillFolderHash = NEW;
    await writeFile(f.lockPath, JSON.stringify(document));
    return cliSuccess;
  };
  const { state, updates } = await f.operations.scanUpdates();
  const result = await f.operations.update({ skillIds: [state.skills[0].id], scanId: updates.scanId, confirmed: true });
  assert.equal(result.success, false);
  assert.match(result.results[0].message, /did not match the source/);
  const after = JSON.parse(await readFile(f.lockPath, 'utf8'));
  assert.equal(after.skills.alpha.skillFolderHash, OLD);
});

test('CRLF in a checked-out file is not mistaken for a stale file', async t => {
  const f = await fixture(t);
  const skill = join(f.homeDir, '.agents', 'skills', 'alpha', 'SKILL.md');
  const text = await readFile(skill, 'utf8');
  await writeFile(skill, text.replaceAll('\n', '\r\n'));
  const script = join(f.homeDir, '.agents', 'skills', 'alpha', 'scripts', 'do-not-run.sh');
  const scriptText = await readFile(script, 'utf8');
  const blob = value => { const bytes = Buffer.from(value); return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); };
  f.operations.fetcher = async () => response({ sha: NEW, truncated: false, tree: [
    { path: 'skills', sha: 'c'.repeat(40), type: 'tree' },
    { path: 'skills/alpha', sha: NEW, type: 'tree' },
    { path: 'skills/alpha/SKILL.md', sha: blob(text), type: 'blob' },
    { path: 'skills/alpha/scripts/do-not-run.sh', sha: blob(scriptText), type: 'blob' },
  ] });
  const { state, updates } = await f.operations.scanUpdates();
  const result = await f.operations.update({ skillIds: [state.skills[0].id], scanId: updates.scanId, confirmed: true });
  assert.equal(result.success, true);
});

test('a symlinked file is verified by its target path, not treated as missing', async t => {
  const f = await fixture(t);
  const skillDir = join(f.homeDir, '.agents', 'skills', 'alpha');
  await symlink('SKILL.md', join(skillDir, 'ALIAS.md'));
  const blob = value => { const bytes = Buffer.from(value); return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); };
  f.operations.fetcher = async () => response({ sha: NEW, truncated: false, tree: [
    { path: 'skills', sha: 'c'.repeat(40), type: 'tree' },
    { path: 'skills/alpha', sha: NEW, type: 'tree' },
    { path: 'skills/alpha/SKILL.md', sha: blob(await readFile(join(skillDir, 'SKILL.md'), 'utf8')), type: 'blob' },
    { path: 'skills/alpha/scripts/do-not-run.sh', sha: blob(await readFile(join(skillDir, 'scripts', 'do-not-run.sh'), 'utf8')), type: 'blob' },
    { path: 'skills/alpha/ALIAS.md', sha: blob('SKILL.md'), type: 'blob' },
  ] });
  const { state, updates } = await f.operations.scanUpdates();
  const result = await f.operations.update({ skillIds: [state.skills[0].id], scanId: updates.scanId, confirmed: true });
  assert.equal(result.success, true);
});

test('files the installer deliberately skips are not reported as missing', async t => {
  const f = await fixture(t);
  const skillDir = join(f.homeDir, '.agents', 'skills', 'alpha');
  await mkdir(join(skillDir, '__pypackages__', 'lib'), { recursive: true });
  await writeFile(join(skillDir, '__pypackages__', 'lib', 'leftover.py'), 'local tool state\n');
  const blob = value => { const bytes = Buffer.from(value); return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); };
  f.operations.fetcher = async () => response({ sha: NEW, truncated: false, tree: [
    { path: 'skills', sha: 'c'.repeat(40), type: 'tree' },
    { path: 'skills/alpha', sha: NEW, type: 'tree' },
    { path: 'skills/alpha/SKILL.md', sha: blob(await readFile(join(skillDir, 'SKILL.md'), 'utf8')), type: 'blob' },
    { path: 'skills/alpha/scripts/do-not-run.sh', sha: blob(await readFile(join(skillDir, 'scripts', 'do-not-run.sh'), 'utf8')), type: 'blob' },
    { path: 'skills/alpha/metadata.json', sha: blob('{"source":"example/skills"}'), type: 'blob' },
    { path: 'skills/alpha/__pycache__/thing.pyc', sha: blob('binary'), type: 'blob' },
  ] });
  const { state, updates } = await f.operations.scanUpdates();
  const result = await f.operations.update({ skillIds: [state.skills[0].id], scanId: updates.scanId, confirmed: true });
  assert.equal(result.success, true);
});
