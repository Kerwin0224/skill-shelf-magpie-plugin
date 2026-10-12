import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

export const MOCK_SUMMARY = 'Fixture summary: research reliable sources and preserve accurate citations.';
const MOCK_CHINESE_SUMMARY = '\u6d4b\u8bd5\u6458\u8981\uff1a\u6574\u7406\u53ef\u4fe1\u6765\u6e90\u5e76\u4fdd\u7559\u51c6\u786e\u5f15\u7528\u3002';
export const MOCK_TRANSLATION = 'Fixture translation: research and summarize reliable sources.';

export async function createMockGateway() {
  const requests = [];
  let failure = false;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    const body = text ? JSON.parse(text) : undefined;
    const send = (status, value) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (request.url === '/__test/status') {
      if (request.method === 'POST') { failure = Boolean(body?.failure); if (body?.reset) requests.length = 0; }
      return send(200, { failure, requests });
    }
    if (request.headers.authorization !== 'Bearer magpie-skill-shelf') return send(401, { error: 'Wrong test caller' });
    if (request.url === '/api/hello') return send(200, { name: 'magpie' });
    if (request.url === '/v1/models') return send(200, { data: [
      { id: 'fixture/text', display_name: 'Fixture Text Model', kind: 'text', modalities: { output: ['text'] } },
      { id: 'fixture/other', display_name: 'Fixture Other Model', kind: 'text' },
      { id: 'fixture/image', display_name: 'Not A Text Model', kind: 'image', modalities: { output: ['image'] } },
    ] });
    if (request.url === '/v1/chat/completions' && request.method === 'POST') {
      requests.push({ authorization: request.headers.authorization, body });
      if (failure) return send(502, { error: 'Deterministic fixture failure; no provider was called.' });
      const translation = body.messages?.[0]?.content?.includes('Translate the entire description');
      const chinese = /(?:Simplified|Traditional) Chinese/.test(body.messages?.[0]?.content || '');
      return send(200, { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: translation ? MOCK_TRANSLATION : chinese ? MOCK_CHINESE_SUMMARY : MOCK_SUMMARY } }] });
    }
    send(404, { error: 'Unknown fixture route' });
  });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  const close = () => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections?.(); });
  return { server, port, url: `http://127.0.0.1:${port}`, requests, setFailure: value => { failure = value; }, close };
}

export async function createFixture({ gateway = false } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'skill-shelf-test-')));
  const homeDir = path.join(root, 'home');
  const dataDir = path.join(root, 'shelf');
  const magpieDir = path.join(root, 'magpie');
  const alpha = path.join(homeDir, '.agents/skills/alpha-skill');
  const beta = path.join(homeDir, '.claude/skills/beta-skill');
  for (const directory of [alpha, beta, dataDir, magpieDir, path.join(alpha, 'references'), path.join(alpha, 'scripts')]) {
    await mkdir(directory, { recursive: true });
  }
  const alphaText = '---\nname: Alpha Research\ndescription: Research and summarize reliable sources.\n---\n\n# Alpha Research\n\nFollow references/context.md before answering.\n';
  await writeFile(path.join(alpha, 'SKILL.md'), alphaText);
  await writeFile(path.join(alpha, 'references/context.md'), '# Context\n\nKeep citations precise.\n');
  await writeFile(path.join(alpha, 'scripts/run.sh'), '#!/bin/sh\nprintf "fixture\\n"\n');
  await chmod(path.join(alpha, 'scripts/run.sh'), 0o755);
  await writeFile(path.join(beta, 'SKILL.md'), '---\nname: Beta Design\ndescription: Design thoughtful interface layouts.\n---\n\n# Beta Design\n\nUse a clear visual hierarchy.\n');
  await writeFile(path.join(magpieDir, 'plugin-auth.json'), '{"sentinel":{"type":"api","key":"not-real-secret"}}\n');
  await writeFile(path.join(magpieDir, 'preferences.json'), '{"untouched":true}\n');
  const mock = gateway ? await createMockGateway() : undefined;
  if (mock) await writeFile(path.join(magpieDir, 'settings.json'), JSON.stringify({ port: mock.port }));
  return { root, homeDir, dataDir, magpieDir, alpha, beta, alphaText, gateway: mock, cleanup: async () => {
    if (mock) await mock.close();
    await rm(root, { recursive: true, force: true });
  } };
}

async function serveUiFixture() {
  const fixture = await createFixture({ gateway: true });
  const cli = fileURLToPath(new URL('../dist/cli.mjs', import.meta.url));
  const child = spawn(process.execPath, [cli, '--data-dir', fixture.dataDir, '--home-dir', fixture.homeDir, '--magpie-dir', fixture.magpieDir, '--port', process.env.SHELF_TEST_PORT || '47931', '--no-open'], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, HOME: fixture.homeDir, MAGPIE_ADDR: '' },
  });
  const stop = () => child.kill('SIGTERM');
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  child.once('exit', async (code) => {
    await fixture.cleanup();
    process.exitCode = code ?? 0;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await serveUiFixture();
