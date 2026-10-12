import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { createFixture } from '../scripts/test-fixtures.mjs';
import { connectWorkbench, peerAt, startWorkbench } from '../src/runtime.mjs';

async function foreignServer(t, handler = (_request, response) => response.end('not Skill Shelf'), port = 0) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => server.listen(port, '127.0.0.1', resolve).once('error', reject));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { server, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` };
}

async function fixtureFor(t) {
  const fixture = await createFixture();
  const owned = [];
  fixture.own = app => { owned.push(app); return app; };
  t.after(async () => {
    try { for (const app of owned.reverse()) await app.close(); }
    finally { await fixture.cleanup(); }
  });
  return fixture;
}

test('an occupied preferred port falls back to an OS-assigned loopback port, with unchanged HTTP security', async t => {
  const foreign = await foreignServer(t);
  const fixture = await fixtureFor(t);
  const app = fixture.own(await startWorkbench({ ...fixture, port: foreign.port }));
  assert.notEqual(app.port, foreign.port);
  assert.equal(app.server.address().address, '127.0.0.1');
  assert.equal(app.url, `http://127.0.0.1:${app.port}`);
  await peerAt(app.port, fixture.dataDir);
  assert.equal(await (await fetch(foreign.url)).text(), 'not Skill Shelf');
  assert.equal((await fetch(app.url)).status, 200);
  assert.equal((await fetch(`${app.url}/api/session`, { headers: { Origin: app.url } })).status, 200);
  assert.equal((await fetch(`${app.url}/api/session`, { headers: { Origin: foreign.url } })).status, 403);
  const wrongHost = await new Promise((resolve, reject) => {
    const request = http.get(`${app.url}/api/session`, { headers: { Host: `127.0.0.1:${foreign.port}` } }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
  });
  assert.equal(wrongHost, 403);
  assert.equal((await fetch(`${app.url}/api/state`)).status, 403);
});

test('development and explicitly strict listeners fail rather than silently moving their fixed endpoint', async t => {
  const foreign = await foreignServer(t);
  const fixture = await fixtureFor(t);
  await assert.rejects(startWorkbench({ ...fixture, port: foreign.port, autoPort: false }), { code: 'EADDRINUSE' });
  await assert.rejects(startWorkbench({ ...fixture, port: foreign.port, dev: true }), { code: 'EADDRINUSE' });
  await assert.rejects(startWorkbench({ ...fixture, port: 65536 }), /Invalid port/);
  assert.equal(await (await fetch(foreign.url)).text(), 'not Skill Shelf');
});

test('concurrent starts reuse one fallback workbench and retain its port across clean takeover', async t => {
  const foreign = await foreignServer(t);
  const fixture = await fixtureFor(t);
  const settings = { ...fixture, port: foreign.port };
  const connected = await Promise.all(Array.from({ length: 5 }, () => connectWorkbench(settings)));
  const owner = connected.find(value => value.app);
  fixture.own(owner.app);
  assert.equal(connected.filter(value => value.app).length, 1);
  assert.equal(new Set(connected.map(value => value.url)).size, 1);
  assert.notEqual(owner.port, foreign.port);
  const file = join(fixture.dataDir, '.workbench.json');
  const record = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(record.port, owner.port);
  assert.equal(record.preferredPort, foreign.port);
  assert.match(await readFile(join(fixture.dataDir, 'Skill Shelf.html'), 'utf8'), new RegExp(`${owner.url}/`));
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  const token = (await (await fetch(`${owner.url}/api/session`)).json()).token;
  await owner.app.close();
  assert.doesNotMatch(await readFile(join(fixture.dataDir, 'Skill Shelf.html'), 'utf8'), /href="http/);
  const takeover = await connectWorkbench(settings);
  fixture.own(takeover.app);
  assert.ok(takeover.app);
  assert.equal(takeover.url, owner.url);
  assert.notEqual((await (await fetch(`${takeover.url}/api/session`)).json()).token, token);
});

test('stale records never reuse another profile or incompatible version, and occupied last ports are avoided', async t => {
  const fixture = await fixtureFor(t);
  const other = await fixtureFor(t);
  const otherApp = other.own(await startWorkbench({ ...other, port: 0 }));
  await assert.rejects(peerAt(otherApp.port, fixture.dataDir), /does not belong/);
  const identity = await (await fetch(`${otherApp.url}/_identity`)).json();
  const wrongVersion = await foreignServer(t, (_request, response) => response.end(JSON.stringify({ ...identity, version: 'old' })));
  await assert.rejects(peerAt(wrongVersion.port, other.dataDir), /does not belong/);
  await writeFile(join(fixture.dataDir, '.workbench.json'), JSON.stringify({ port: otherApp.port, preferredPort: wrongVersion.port }));
  const current = await connectWorkbench({ ...fixture, port: wrongVersion.port });
  fixture.own(current.app);
  assert.notEqual(current.port, otherApp.port);
  assert.notEqual(current.port, wrongVersion.port);
  await peerAt(current.port, fixture.dataDir);
  await peerAt(otherApp.port, other.dataDir);
});

test('corrupt discovery records and crashed startup/recovery locks do not prevent concurrent startup', async t => {
  const fixture = await fixtureFor(t);
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  const reaper = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve, reject) => { reaper.once('exit', resolve); reaper.once('error', reject); });
  await writeFile(join(fixture.dataDir, '.workbench-start.lock'), JSON.stringify({ pid: child.pid, id: 'dead-start' }));
  const recoveryFile = join(fixture.dataDir, '.workbench-start.lock.dead-start.recover');
  await writeFile(recoveryFile, JSON.stringify({ pid: reaper.pid, id: 'dead-reaper' }));
  await writeFile(join(fixture.dataDir, '.workbench.json'), '{unfinished');
  const connected = await Promise.all(Array.from({ length: 3 }, () => connectWorkbench({ ...fixture, port: 0 })));
  const current = connected.find(value => value.app);
  fixture.own(current.app);
  assert.equal(connected.filter(value => value.app).length, 1);
  assert.equal(new Set(connected.map(value => value.url)).size, 1);
  assert.ok(current.app);
  await peerAt(current.port, fixture.dataDir);
  await assert.rejects(stat(join(fixture.dataDir, '.workbench-start.lock')), { code: 'ENOENT' });
  await assert.rejects(stat(recoveryFile), { code: 'ENOENT' });
});

test('an unresponsive foreign listener cannot stall fallback discovery indefinitely', async t => {
  const foreign = await foreignServer(t, () => {});
  const fixture = await fixtureFor(t);
  const current = await connectWorkbench({ ...fixture, port: foreign.port });
  fixture.own(current.app);
  assert.notEqual(current.port, foreign.port);
  await peerAt(current.port, fixture.dataDir);
});
