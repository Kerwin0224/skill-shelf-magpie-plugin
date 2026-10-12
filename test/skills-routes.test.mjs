import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdir, writeFile, readFile, rename, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { ShelfService, ShelfError } from '../src/domain.mjs';
import { SkillOperations } from '../src/skill-operations.mjs';
import { AIBridge } from '../src/ai.mjs';
import { AssistantBridge } from '../src/assistant.mjs';
import { startServer } from '../src/server.mjs';
import { createFixture } from '../scripts/test-fixtures.mjs';

const OLD = 'a'.repeat(40), NEW = 'b'.repeat(40);

async function setup(t, { gateway = false, noSkills = false, noAssistant = false } = {}) {
  const fixture = await createFixture({ gateway });
  t.after(fixture.cleanup);
  const alpha = join(fixture.homeDir, '.agents', 'skills', 'alpha');
  await rename(fixture.alpha, alpha);
  await writeFile(join(alpha, 'SKILL.md'), '---\nname: alpha\ndescription: An isolated test Skill\n---\n# Alpha\nThis document is reference data.\n');
  const lockPath = join(fixture.homeDir, '.agents', '.skill-lock.json');
  await writeFile(lockPath, JSON.stringify({ skills: { alpha: { sourceType: 'github', source: 'example/skills', skillPath: 'skills/alpha/SKILL.md', skillFolderHash: OLD } } }));
  const webDir = join(fixture.root, 'web'); await mkdir(webDir);
  await writeFile(join(webDir, 'index.html'), '<!doctype html><title>Isolated route test</title>');
  const service = new ShelfService(fixture); await service.initialize();
  const calls = [];
  const skills = noSkills ? undefined : new SkillOperations({ service, environment: {}, gitTreeFetcher: null, fetcher: async () => ({ ok: true, status: 200, json: async () => ({ sha: NEW, tree: [{ path: 'skills/alpha', type: 'tree', sha: NEW }] }) }), runner: async (...args) => {
    calls.push(args);
    return { code: 0, stdout: 'Installed 1 skill', stderr: '' };
  } });
  const ai = gateway ? new AIBridge({ service, magpieDir: fixture.magpieDir, gatewayUrl: fixture.gateway.url }) : undefined;
  const assistant = !noAssistant && ai ? new AssistantBridge({ service, ai }) : undefined;
  const instance = await startServer({ service, skills, ai, assistant, port: 0, webDir });
  t.after(() => instance.close());
  const base = instance.url;
  const { token } = await (await fetch(`${base}/api/session`)).json();
  const api = async (route, { method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(`${base}${route}`, { method, headers: { 'X-Shelf-Token': token, ...(body !== undefined ? { 'Content-Type': 'application/json', Origin: base } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  return { ...fixture, ...instance, alpha, lockPath, service, skills, ai, assistant, base, token, api, calls };
}

test('new Skills routes require token and local Origin before any scan or installer delegation', async t => {
  const f = await setup(t);
  for (const route of ['/api/skills/status']) {
    assert.equal((await f.api(route, { headers: { 'X-Shelf-Token': '' } })).status, 403);
    assert.equal((await f.api(route, { headers: { Origin: 'https://attacker.invalid' } })).status, 403);
    assert.equal((await f.api(route, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  }
  for (const route of ['/api/skills/scan', '/api/skills/update']) {
    assert.equal((await f.api(route, { method: 'POST', body: {}, headers: { 'X-Shelf-Token': '' } })).status, 403);
    assert.equal((await f.api(route, { method: 'POST', body: {}, headers: { Origin: 'https://attacker.invalid' } })).status, 403);
  }
  assert.equal(f.calls.length, 0); assert.equal(f.skills.status().scanId, null);
  assert.equal((await f.api('/api/skills/scan', { method: 'GET' })).status, 404);
  assert.equal((await f.api('/api/skills/status', { method: 'POST', body: {} })).status, 404);
  assert.equal((await f.api('/api/skills/scan/extra', { method: 'POST', body: {} })).status, 404);
});

test('Skills HTTP routes delegate status/scan/update methods with safe mock runner', async t => {
  const f = await setup(t);
  assert.equal((await f.api('/api/skills/status')).data.scanId, null);
  let result = await f.api('/api/skills/scan', { method: 'POST', body: {} });
  assert.equal(result.status, 200); assert.equal(result.data.updates.summary['update-available'], 1);
  const alpha = result.data.state.skills.find(skill => skill.name === 'alpha');
  const input = { skillIds: [alpha.id], scanId: result.data.updates.scanId, confirmed: true };
  const before = await readFile(join(f.alpha, 'SKILL.md'));
  assert.equal((await f.api('/api/skills/update', { method: 'POST', body: { ...input, confirmed: false } })).status, 409);
  assert.equal(f.calls.length, 0);
  result = await f.api('/api/skills/update', { method: 'POST', body: input });
  assert.equal(result.status, 200); assert.equal(result.data.success, true);
  assert.deepEqual(f.calls[0][0], ['add', 'example/skills/skills/alpha', '--skill', 'alpha', '--global', '--yes', '--agent', 'universal']);
  assert.equal(result.data.updates.completed, 1); assert.equal(result.data.updates.total, 1);
  assert.equal((await f.api('/api/skills/update', { method: 'POST', body: input })).status, 409);
  assert.deepEqual(await readFile(join(f.alpha, 'SKILL.md')), before);
});

test('removed installation and registry endpoints cannot invoke a CLI or change existing Skills', async t => {
  const f = await setup(t);
  const before = await readFile(join(f.alpha, 'SKILL.md'));
  const lockBefore = await readFile(f.lockPath);
  assert.equal((await f.api('/api/skills/registry')).status, 404);
  assert.equal((await f.api('/api/skills/add', { method: 'POST', body: { source: 'owner/repo@skill', agents: ['universal'], target: { scope: 'global' } } })).status, 404);
  assert.equal(f.calls.length, 0);
  assert.equal(typeof f.skills.add, 'undefined');
  assert.deepEqual(await readFile(join(f.alpha, 'SKILL.md')), before);
  assert.deepEqual(await readFile(f.lockPath), lockBefore);
});

test('disabled service routes and invalid JSON content fail without invoking operations', async t => {
  const f = await setup(t, { noSkills: true, noAssistant: true });
  assert.equal((await f.api('/api/skills/status')).status, 503);
  assert.equal((await f.api('/api/skills/update', { method: 'POST', body: {} })).status, 503);
  assert.equal((await f.api('/api/ai/chat', { method: 'POST', body: {} })).status, 503);
  const working = await setup(t);
  const response = await fetch(`${working.base}/api/skills/scan`, { method: 'POST', headers: { 'X-Shelf-Token': working.token, 'Content-Type': 'text/plain', Origin: working.base }, body: '{}' });
  assert.equal(response.status, 415); assert.equal(working.skills.status().scanId, null);
});

test('Assistant chat and conversation routes enforce auth and delegate real local-only gateway bridge', async t => {
  const f = await setup(t, { gateway: true });
  const alpha = (await f.service.snapshot()).skills.find(skill => skill.name === 'alpha');
  const input = { prompt: 'Explain this Skill', model: 'fixture/text', skillId: alpha.id, history: [], language: 'en' };
  const before = await readFile(join(f.alpha, 'SKILL.md'));
  assert.equal((await f.api('/api/ai/chat', { method: 'POST', body: input, headers: { 'X-Shelf-Token': '' } })).status, 403);
  assert.equal((await f.api('/api/ai/conversations', { headers: { Origin: 'https://attacker.invalid' } })).status, 403);
  assert.equal(f.gateway.requests.length, 0);
  const started = await f.api('/api/ai/chat', { method: 'POST', body: input });
  assert.equal(started.status, 200); assert.equal(started.data.status, 'running');
  let job;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    job = await f.api(`/api/ai/chat?id=${started.data.id}`);
    if (job.data.status !== 'running') break;
    await new Promise(accept => setTimeout(accept, 5));
  }
  assert.equal(job.status, 200); assert.equal(job.data.status, 'completed'); assert.ok(job.data.content);
  assert.deepEqual(job.data.contextFiles, ['SKILL.md']);
  assert.equal(f.gateway.requests[0].body.stream, true);
  assert.equal(f.gateway.requests[0].body.messages.some(message => message.content.includes('BEGIN_UNTRUSTED_SKILL_REFERENCE_JSON')), true);
  const conversation = { id: randomUUID(), skillId: alpha.id, messages: [{ role: 'user', content: input.prompt }, { role: 'assistant', content: job.data.content }] };
  const saved = await f.api('/api/ai/conversations', { method: 'POST', body: conversation });
  assert.equal(saved.status, 200); assert.equal(saved.data.id, conversation.id);
  assert.equal((await f.api('/api/ai/conversations')).data.length, 1);
  assert.deepEqual((await f.api(`/api/ai/conversations?id=${conversation.id}`)).data.messages, conversation.messages);
  assert.equal((await lstat(join(f.dataDir, 'assistant-conversations.json'))).mode & 0o777, 0o600);
  assert.equal((await f.api(`/api/ai/conversations/${conversation.id}`, { method: 'DELETE', headers: { 'X-Shelf-Token': '' } })).status, 403);
  assert.equal((await f.api(`/api/ai/conversations/${conversation.id}`, { method: 'DELETE' })).data.deleted, true);
  assert.deepEqual((await f.api('/api/ai/conversations')).data, []);
  assert.deepEqual(await readFile(join(f.alpha, 'SKILL.md')), before);
});

test('Assistant stop route delegates AbortController instead of starting another request', async t => {
  const f = await setup(t, { gateway: true });
  let release, started;
  const waiting = new Promise(accept => { release = accept; });
  const ready = new Promise(accept => { started = accept; });
  const discover = f.ai.discover.bind(f.ai);
  f.ai.discover = async (...args) => { started(); await waiting; return discover(...args); };
  const result = await f.api('/api/ai/chat', { method: 'POST', body: { prompt: 'An isolated cancellable conversation', model: 'fixture/text', history: [], language: 'en' } });
  await ready;
  const stopped = await f.api('/api/ai/chat/stop', { method: 'POST', body: { id: result.data.id } });
  assert.equal(stopped.status, 200); assert.equal(stopped.data.status, 'stopped');
  release();
  for (let attempt = 0; attempt < 100 && f.assistant.active; attempt += 1) await new Promise(accept => setTimeout(accept, 5));
  assert.equal(f.assistant.active, 0); assert.equal(f.gateway.requests.length, 0);
});

test('removed file translation HTTP requests and file-path injection return 400 without any gateway calls', async t => {
  const f = await setup(t, { gateway: true });
  const alpha = (await f.service.snapshot()).skills.find(skill => skill.name === 'alpha');
  const original = await readFile(join(f.alpha, 'references', 'context.md'));
  const skillBefore = await readFile(join(f.alpha, 'SKILL.md'));
  const stateBefore = await readFile(join(f.dataDir, 'state.json'));
  let gatewayCalls = 0, fileReads = 0;
  f.ai.request = async () => { gatewayCalls += 1; throw new Error('Unsupported requests must never reach a gateway'); };
  f.service.readSkillFile = async () => { fileReads += 1; throw new Error('Unsupported requests must never read files'); };
  for (const parameters of [
    { kind: 'file-translation' },
    { kind: 'file-translation', filePath: 'SKILL.md' },
    { kind: 'file-translation', filePath: 'references/context.md' },
    ...['summary', 'translation'].map(kind => ({ kind, filePath: 'references/context.md' })),
  ]) {
    const result = await f.api('/api/ai/generate', { method: 'POST', body: { skillId: alpha.id, model: 'fixture/text', language: 'zh-CN', ...parameters } });
    assert.equal(result.status, 400);
  }
  for (const route of ['/api/ai/save', '/api/ai/source-copy']) {
    assert.equal((await f.api(route, { method: 'POST', body: { kind: 'file-translation', skillId: alpha.id, filePath: 'SKILL.md', language: 'zh-CN' } })).status, 400);
  }
  assert.equal(gatewayCalls, 0); assert.equal(fileReads, 0); assert.equal(f.gateway.requests.length, 0);
  assert.equal(f.ai.activeRequests, 0); assert.equal(f.ai.drafts.size, 0);
  assert.deepEqual(await readFile(join(f.alpha, 'references', 'context.md')), original);
  assert.deepEqual(await readFile(join(f.alpha, 'SKILL.md')), skillBefore);
  assert.deepEqual(await readFile(join(f.dataDir, 'state.json')), stateBefore);
});

test('historical file previews are hidden by HTTP result and annotation routes and preserved on description saves', async t => {
  const f = await setup(t, { gateway: true });
  const alpha = (await f.service.snapshot()).skills.find(skill => skill.name === 'alpha');
  const skillText = (await readFile(join(f.alpha, 'SKILL.md'), 'utf8')).replace('An isolated test Skill', 'This Skill helps organize source documents.');
  await writeFile(join(f.alpha, 'SKILL.md'), skillText);
  const original = await readFile(join(f.alpha, 'references', 'context.md'));
  const legacy = { skillId: alpha.id, kind: 'file-translation', filePath: 'references/context.md', language: 'zh-CN',
    text: 'Historical preview', model: 'old-model', sourceDigest: createHash('sha256').update(original).digest('hex'),
    createdAt: '2026-01-01T00:00:00.000Z', savedAt: '2026-01-01T00:00:00.000Z', keepExactly: { custom: true } };
  const store = join(f.dataDir, 'ai-results.json');
  const before = JSON.stringify({ version: 1, annotations: [legacy] }) + '\n';
  await writeFile(store, before);
  let gatewayCalls = 0;
  f.ai.request = async () => { gatewayCalls += 1; throw new Error('Reading history and source copies must not call a gateway'); };
  f.service.readSkillFile = async () => { throw new Error('Historical preview files must not be read'); };
  const result = await f.api(`/api/ai/result?id=${encodeURIComponent(alpha.id)}`);
  assert.equal(result.status, 200); assert.deepEqual(result.data, { translations: [] });
  const annotations = await f.api('/api/ai/annotations');
  assert.equal(annotations.status, 200); assert.deepEqual(annotations.data, { annotations: [] });
  assert.equal(await readFile(store, 'utf8'), before);
  const copied = await f.api('/api/ai/source-copy', { method: 'POST', body: { skillId: alpha.id, language: 'en' } });
  assert.equal(copied.status, 200); assert.equal(copied.data.kind, 'translation');
  assert.deepEqual(JSON.parse(await readFile(store, 'utf8')).annotations.filter(item => item.kind === 'file-translation'), [legacy]);
  const visible = (await f.api(`/api/ai/result?id=${encodeURIComponent(alpha.id)}`)).data;
  assert.equal(visible.files, undefined); assert.equal(visible.translations.length, 1);
  assert.ok((await f.api('/api/ai/annotations')).data.annotations.every(item => item.kind === 'translation'));
  assert.equal(gatewayCalls, 0); assert.equal(f.gateway.requests.length, 0);
  assert.deepEqual(await readFile(join(f.alpha, 'references', 'context.md')), original);
  assert.equal(await readFile(join(f.alpha, 'SKILL.md'), 'utf8'), skillText);
});

test('disconnecting description translation HTTP request aborts generation and releases capacity without saving a draft', async t => {
  const f = await setup(t, { gateway: true });
  const alpha = (await f.service.snapshot()).skills.find(skill => skill.name === 'alpha');
  const before = await readFile(join(f.alpha, 'SKILL.md'));
  let begun, aborted;
  const started = new Promise(accept => { begun = accept; });
  const cancelled = new Promise(accept => { aborted = accept; });
  const request = f.ai.request.bind(f.ai);
  f.ai.request = async (baseUrl, endpoint, body, timeout, signal) => {
    if (endpoint !== '/v1/chat/completions') return request(baseUrl, endpoint, body, timeout, signal);
    begun();
    return new Promise((accept, reject) => {
      signal.addEventListener('abort', () => { aborted(); reject(new ShelfError(499, 'Cancelled isolated request')); }, { once: true });
    });
  };
  const body = JSON.stringify({ skillId: alpha.id, kind: 'translation', model: 'fixture/text', language: 'zh-CN' });
  const client = httpRequest(`${f.base}/api/ai/generate`, { method: 'POST', headers: { 'X-Shelf-Token': f.token, Origin: f.base, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
  client.on('error', () => {}); client.end(body);
  await started; client.destroy();
  await Promise.race([cancelled, new Promise((accept, reject) => { const timer = setTimeout(() => reject(new Error('Disconnected translation was not aborted')), 1500); timer.unref(); })]);
  for (let attempt = 0; attempt < 100 && f.ai.activeRequests; attempt += 1) await new Promise(accept => setTimeout(accept, 5));
  assert.equal(f.ai.activeRequests, 0); assert.equal(f.ai.drafts.size, 0);
  assert.deepEqual(await readFile(join(f.alpha, 'SKILL.md')), before);
});
