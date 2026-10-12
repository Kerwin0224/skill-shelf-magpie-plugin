import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, symlink, stat, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ShelfService } from '../src/domain.mjs';
import { AIBridge } from '../src/ai.mjs';
import { createFixture } from '../scripts/test-fixtures.mjs';

const ENGLISH = 'This Skill helps research and summarize reliable sources.';
const CHINESE = '\u6574\u7406\u53ef\u9760\u6765\u6e90\uff0c\u5e76\u4fdd\u7559\u51c6\u786e\u7684\u5f15\u7528\u3002';
const hasStatus = status => error => error.status === status;
const digest = text => createHash('sha256').update(text).digest('hex');

async function fixture(t) {
  const previous = process.env.XDG_STATE_HOME;
  delete process.env.XDG_STATE_HOME;
  t.after(() => { if (previous === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous; });
  const options = await createFixture();
  t.after(options.cleanup);
  const service = new ShelfService(options);
  return { ...options, service };
}

async function addSkill(directory, name, description = ENGLISH) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\nsourceUrl: https://untrusted.example/not-a-source\n---\n\n# Reference only\n`);
}

async function bridgeFixture(t, description = ENGLISH) {
  const f = await fixture(t);
  await addSkill(f.alpha, 'Alpha Research', description);
  const snapshot = await f.service.initialize();
  const skill = snapshot.skills.find(item => item.name === 'Alpha Research');
  const bridge = new AIBridge({ service: f.service, magpieDir: f.magpieDir });
  const calls = [];
  for (const method of ['baseUrl', 'discover', 'request']) bridge[method] = async () => {
    calls.push(method);
    throw new Error('This test must never contact a gateway.');
  };
  t.after(() => bridge.close());
  return { ...f, bridge, calls, skill };
}

test('shared directories keep canonical directory metadata when Agent aliases point at them', async t => {
  const f = await fixture(t);
  const alias = path.join(f.homeDir, '.claude/skills/alpha-alias');
  await symlink(f.alpha, alias);
  await writeFile(path.join(f.homeDir, '.agents/.skill-lock.json'), JSON.stringify({ skills: {
    'Alpha Research': { sourceType: 'github', source: 'example/skills', sourceUrl: 'https://github.com/example/skills/tree/main/alpha' },
  } }));
  const before = await readFile(path.join(f.alpha, 'SKILL.md'));
  const snapshot = await f.service.initialize();
  const alpha = snapshot.skills.find(item => item.name === 'Alpha Research');
  assert.equal(alpha.installKind, 'directory');
  assert.equal(alpha.linkTarget, undefined);
  assert.equal(alpha.sourceUrl, 'https://github.com/example/skills/tree/main/alpha');
  assert.ok(alpha.agents.includes('Claude Code'));
  assert.equal(alpha.installations.length, 1);
  assert.equal(alpha.installations[0].installKind, 'directory');
  assert.equal(alpha.installations[0].linkTarget, undefined);
  assert.equal((await f.service.snapshot()).skills.length, snapshot.skills.length);
  assert.deepEqual(await readFile(path.join(f.alpha, 'SKILL.md')), before);
});

test('symlink-only installations expose the real target without inventing tracked source URLs', async t => {
  const f = await fixture(t);
  const target = path.join(f.root, 'external-skill');
  await addSkill(target, 'Linked Reference');
  await symlink(target, path.join(f.homeDir, '.claude/skills/linked'));
  await writeFile(path.join(f.homeDir, '.agents/.skill-lock.json'), JSON.stringify({ skills: {
    'Linked Reference': { sourceType: 'github', source: 'example/linked' },
  } }));
  const snapshot = await f.service.initialize();
  const linked = snapshot.skills.find(item => item.name === 'Linked Reference');
  assert.equal(linked.installKind, 'symlink');
  assert.equal(linked.linkTarget, target);
  assert.equal(linked.path, target);
  assert.equal(linked.sourceUrl, undefined);
  assert.equal(linked.installations[0].linkTarget, target);
  assert.equal((await stat(path.join(target, 'SKILL.md'))).isFile(), true);
});

test('source links require strict GitHub tracking and reject external, credentialed and unsafe URL overrides', async t => {
  const f = await fixture(t);
  const entries = {
    safe: { sourceType: 'github', source: 'example/skills', sourceUrl: 'https://github.com/example/skills' },
    external: { sourceType: 'github', source: 'example/skills', sourceUrl: 'https://outside.example/repo' },
    credentials: { sourceType: 'github', source: 'example/skills', sourceUrl: 'https://user:secret@github.com/example/skills' },
    insecure: { sourceType: 'github', source: 'example/skills', sourceUrl: 'http://github.com/example/skills' },
    port: { sourceType: 'github', source: 'example/skills', sourceUrl: 'https://github.com:1234/example/skills' },
    query: { sourceType: 'github', source: 'example/skills', sourceUrl: 'https://github.com/example/skills?secret=fixture' },
    fragment: { sourceType: 'github', source: 'example/skills', sourceUrl: 'https://github.com/example/skills#secret' },
    spoofed: { sourceType: 'github', source: 'example/skills', sourceUrl: 'https://github.com.evil.example/example/skills' },
    local: { sourceType: 'local', source: 'example/skills', sourceUrl: 'https://github.com/example/skills' },
    invalid: { sourceType: 'github', source: '../example/skills', sourceUrl: 'https://github.com/example/skills' },
    urlOnly: { sourceType: 'github', sourceUrl: 'https://github.com/example/skills' },
  };
  for (const name of Object.keys(entries)) await addSkill(path.join(f.homeDir, '.agents/skills', name), name);
  const lockPath = path.join(f.homeDir, '.agents/.skill-lock.json');
  await writeFile(lockPath, JSON.stringify({ skills: entries }));
  const lockBefore = await readFile(lockPath);
  const snapshot = await f.service.initialize();
  for (const name of Object.keys(entries)) {
    const skill = snapshot.skills.find(item => item.name === name);
    assert.equal(skill.installKind, 'directory');
    assert.equal(skill.sourceUrl, ['local', 'invalid', 'urlOnly'].includes(name) ? undefined : 'https://github.com/example/skills', name);
  }
  assert.deepEqual(await readFile(lockPath), lockBefore);
});

test('project and global tracked source URLs remain scope-specific for the same Skill name', async t => {
  const f = await fixture(t);
  const project = path.join(f.root, 'project');
  await addSkill(path.join(project, '.agents/skills/alpha'), 'Alpha Research');
  await writeFile(path.join(f.homeDir, '.agents/.skill-lock.json'), JSON.stringify({ skills: {
    'Alpha Research': { sourceType: 'github', source: 'example/global' },
  } }));
  await writeFile(path.join(project, 'skills-lock.json'), JSON.stringify({ skills: {
    'Alpha Research': { sourceType: 'github', source: 'example/project' },
  } }));
  await f.service.initialize();
  const snapshot = await f.service.addProject({ path: project });
  const alphas = snapshot.skills.filter(item => item.name === 'Alpha Research');
  assert.equal(alphas.length, 2);
  assert.equal(alphas.find(item => item.scopeId === 'global').sourceUrl, 'https://github.com/example/global');
  assert.equal(alphas.find(item => item.scopeId !== 'global').sourceUrl, 'https://github.com/example/project');
});

test('malformed and symlinked lock files do not contribute source URLs', async t => {
  const f = await fixture(t);
  const lockPath = path.join(f.homeDir, '.agents/.skill-lock.json');
  await writeFile(lockPath, '{invalid-json');
  let snapshot = await f.service.initialize();
  assert.equal(snapshot.skills.find(item => item.name === 'Alpha Research').sourceUrl, undefined);
  const target = path.join(f.root, 'external-lock.json');
  await writeFile(target, JSON.stringify({ skills: { 'Alpha Research': { sourceType: 'github', source: 'example/ignored' } } }));
  // Only the disposable lock fixture is replaced; source Skill files stay untouched.
  await unlink(lockPath);
  await symlink(target, lockPath);
  snapshot = await f.service.rescan();
  assert.equal(snapshot.skills.find(item => item.name === 'Alpha Research').sourceUrl, undefined);
  assert.equal(JSON.parse(await readFile(target, 'utf8')).skills['Alpha Research'].source, 'example/ignored');
});

test('source copies save the real original description privately without any gateway call', async t => {
  const f = await bridgeFixture(t);
  const original = await readFile(path.join(f.alpha, 'SKILL.md'), 'utf8');
  const stateBefore = await readFile(f.service.stateFile);
  const authBefore = await readFile(path.join(f.magpieDir, 'plugin-auth.json'));
  const result = await f.bridge.saveSourceCopy({ skillId: f.skill.id, language: 'en' });
  assert.equal(result.kind, 'translation');
  assert.equal(result.model, 'source-copy');
  assert.equal(result.text, ENGLISH);
  assert.equal(result.sourceDigest, digest(original));
  assert.equal(result.stale, false);
  assert.equal(result.draftId, undefined);
  assert.deepEqual(f.calls, []);
  assert.equal(f.bridge.activeRequests, 0);
  assert.equal(f.bridge.drafts.size, 0);
  assert.equal((await stat(path.join(f.dataDir, 'ai-results.json'))).mode & 0o777, 0o600);
  assert.equal(await readFile(path.join(f.alpha, 'SKILL.md'), 'utf8'), original);
  assert.deepEqual(await readFile(f.service.stateFile), stateBefore);
  assert.deepEqual(await readFile(path.join(f.magpieDir, 'plugin-auth.json')), authBefore);
  const fresh = new AIBridge({ service: f.service, magpieDir: f.magpieDir });
  t.after(() => fresh.close());
  assert.deepEqual((await fresh.results(f.skill.id)).translations, [result]);
  assert.equal((await fresh.list()).annotations[0].model, 'source-copy');
});

test('source copy rejects relabeling, unsupported languages, injected fields and missing original descriptions', async t => {
  const f = await bridgeFixture(t);
  for (const language of ['zh-CN', 'ja', 'ko', 'de']) await assert.rejects(f.bridge.saveSourceCopy({ skillId: f.skill.id, language }), hasStatus(409));
  for (const input of [
    { skillId: f.skill.id, language: 'unknown' },
    { skillId: f.skill.id, language: 'en', text: 'Untrusted client-provided text' },
    { skillId: f.skill.id, language: 'en', model: 'fixture/model' },
    { language: 'en' },
  ]) await assert.rejects(f.bridge.saveSourceCopy(input), hasStatus(400));
  await writeFile(path.join(f.alpha, 'SKILL.md'), '# No description\n');
  await assert.rejects(f.bridge.saveSourceCopy({ skillId: f.skill.id, language: 'en' }), hasStatus(409));
  assert.deepEqual(f.calls, []);
  assert.equal(f.bridge.drafts.size, 0);
  assert.ok(!(await readdir(f.dataDir)).includes('ai-results.json'));
});

test('Chinese source copies support both Chinese targets without claiming model translation', async t => {
  const f = await bridgeFixture(t, CHINESE);
  for (const language of ['zh-CN', 'zh-TW']) {
    const result = await f.bridge.saveSourceCopy({ skillId: f.skill.id, language });
    assert.equal(result.text, CHINESE);
    assert.equal(result.language, language);
    assert.equal(result.model, 'source-copy');
  }
  assert.equal((await f.bridge.results(f.skill.id)).translations.length, 2);
  assert.deepEqual(f.calls, []);
});

test('source-copy abort and bridge shutdown reject before source reads or private writes', async t => {
  const f = await bridgeFixture(t);
  const controller = new AbortController();
  controller.abort();
  let reads = 0;
  const originalSource = f.bridge.source.bind(f.bridge);
  f.bridge.source = async (...args) => { reads += 1; return originalSource(...args); };
  await assert.rejects(f.bridge.saveSourceCopy({ skillId: f.skill.id, language: 'en' }, { signal: controller.signal }), hasStatus(499));
  f.bridge.close();
  await assert.rejects(f.bridge.saveSourceCopy({ skillId: f.skill.id, language: 'en' }), hasStatus(499));
  assert.equal(reads, 0);
  assert.deepEqual(f.calls, []);
  assert.ok(!(await readdir(f.dataDir)).includes('ai-results.json'));
});

test('shutdown during a pending original-description read cannot create a source-copy draft', async t => {
  const f = await bridgeFixture(t);
  const source = await f.bridge.source(f.skill.id);
  let release;
  f.bridge.source = () => new Promise(resolve => { release = () => resolve(source); });
  const saving = f.bridge.saveSourceCopy({ skillId: f.skill.id, language: 'en' });
  f.bridge.close(); release();
  await assert.rejects(saving, hasStatus(499));
  assert.equal(f.bridge.drafts.size, 0);
  assert.deepEqual(f.calls, []);
  assert.ok(!(await readdir(f.dataDir)).includes('ai-results.json'));
});

test('cancellation before source-copy commit preserves an earlier saved result and removes temporary files', async t => {
  const f = await bridgeFixture(t);
  await f.bridge.saveSourceCopy({ skillId: f.skill.id, language: 'en' });
  const file = path.join(f.dataDir, 'ai-results.json');
  const before = await readFile(file);
  const originalSource = f.bridge.source.bind(f.bridge);
  let reads = 0, release, reached;
  const gate = new Promise(resolve => { reached = resolve; });
  f.bridge.source = async (...args) => {
    const source = await originalSource(...args);
    if (++reads === 2) { reached(); await new Promise(resolve => { release = resolve; }); }
    return source;
  };
  const controller = new AbortController();
  const saving = f.bridge.saveSourceCopy({ skillId: f.skill.id, language: 'en' }, { signal: controller.signal });
  await gate; controller.abort(); release();
  await assert.rejects(saving, hasStatus(499));
  assert.deepEqual(await readFile(file), before);
  assert.equal(f.bridge.drafts.size, 0);
  assert.ok(!(await readdir(f.dataDir)).some(name => name.endsWith('.tmp')));
  assert.deepEqual(f.calls, []);
});

test('source-copy save rechecks the real document and never stores a changed description under an old digest', async t => {
  const f = await bridgeFixture(t);
  const originalSource = f.bridge.source.bind(f.bridge);
  let reads = 0;
  f.bridge.source = async (...args) => {
    if (++reads === 2) await addSkill(f.alpha, 'Alpha Research', 'This Skill helps organize different source documents.');
    return originalSource(...args);
  };
  await assert.rejects(f.bridge.saveSourceCopy({ skillId: f.skill.id, language: 'en' }), hasStatus(409));
  assert.equal(f.bridge.drafts.size, 0);
  assert.ok(!(await readdir(f.dataDir)).some(name => name === 'ai-results.json' || name.endsWith('.tmp')));
  assert.deepEqual(f.calls, []);
});

test('shutdown while a summary or description-translation source is pending prevents all gateway discovery', async t => {
  for (const kind of ['summary', 'translation']) await t.test(kind, async t => {
    const f = await bridgeFixture(t);
    const source = await f.bridge.source(f.skill.id);
    let release;
    f.bridge.source = () => new Promise(resolve => { release = () => resolve(source); });
    const pending = f.bridge.generate({ skillId: f.skill.id, kind, model: 'fixture/no-gateway', language: 'en' });
    assert.equal(f.bridge.activeRequests, 1);
    f.bridge.close(); release();
    await assert.rejects(pending, hasStatus(499));
    assert.equal(f.bridge.activeRequests, 0);
    assert.equal(f.bridge.drafts.size, 0);
    assert.deepEqual(f.calls, []);
    assert.ok(!(await readdir(f.dataDir)).includes('ai-results.json'));
  });
});
