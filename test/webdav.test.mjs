import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebDavSyncService, validateWebDavInput } from '../src/webdav.mjs';
import { MAX_SYNC_BYTES } from '../src/sync-format.mjs';

const base = 'https://dav.example.test/dav/';
const sharedPath = '/dav/SkillShelf/skill-shelf-metadata.json';
const indexPath = '/dav/SkillShelf/backups/index.json';
const source = { deviceId: '11111111-1111-4111-8111-111111111111', deviceName: 'Fixture plugin', appVersion: '0.1.0' };
const otherSource = { ...source, deviceId: '22222222-2222-4222-8222-222222222222', deviceName: 'Fixture desktop' };
const document = { format: 'skill-shelf-metadata', version: 5, exportedAt: '2026-10-12T00:00:00Z', skills: [], preferences: {}, packs: [], managedSkills: [], source };
const contents = JSON.stringify(document);
const snapshot = (id, owner = source) => ({ id, kind: 'device', exportedAt: document.exportedAt, skills: 0, packs: 0, managedSkills: 0, source: owner });

function memoryDav({ folders = ['/', '/dav/'], hook, listingHrefs = [] } = {}) {
  const collections = new Set(folders);
  const files = new Map();
  const calls = [];
  let revision = 0;
  const putFile = (file, value, etag = `"v${++revision}"`) => files.set(file, { contents: typeof value === 'string' ? value : JSON.stringify(value), etag });
  const request = async (input, options) => {
    const url = new URL(input);
    const headers = new Headers(options.headers);
    const call = { method: options.method, path: url.pathname, headers, body: options.body };
    calls.push(call);
    assert.equal(url.origin, new URL(base).origin);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(headers.get('authorization'), `Basic ${Buffer.from('fixture-user:fixture-password').toString('base64')}`);
    const override = await hook?.(call, { files, collections, putFile });
    if (override) return override;
    if (call.method === 'GET') {
      const file = files.get(call.path);
      return file ? new Response(file.contents, { headers: file.etag === null ? {} : { ETag: file.etag } }) : new Response('', { status: 404 });
    }
    if (call.method === 'PROPFIND') {
      if (!collections.has(call.path)) return new Response('', { status: 404 });
      const hrefs = headers.get('depth') === '1'
        ? [...files.keys()].filter(file => new URL('.', new URL(file, base)).pathname === call.path).concat(listingHrefs)
        : [];
      return new Response(`<d:multistatus xmlns:d="DAV:">${hrefs.map(href => `<d:response><d:href>${href}</d:href></d:response>`).join('')}</d:multistatus>`, { status: 207 });
    }
    if (call.method === 'MKCOL') {
      if (collections.has(call.path)) return new Response('', { status: 405 });
      if (!collections.has(new URL('..', url).pathname)) return new Response('', { status: 409 });
      collections.add(call.path);
      return new Response('', { status: 201 });
    }
    if (call.method === 'PUT') {
      if (!collections.has(new URL('.', url).pathname)) return new Response('', { status: 409 });
      const file = files.get(call.path);
      if ((headers.has('if-match') && headers.get('if-match') !== file?.etag) || (headers.get('if-none-match') === '*' && file)) return new Response('', { status: 412 });
      putFile(call.path, call.body);
      return new Response('', { status: 201 });
    }
    throw new Error(`Unexpected mock request ${call.method}`);
  };
  return { request, calls, files, collections, putFile };
}

async function setup(t, options) {
  const directory = await mkdtemp(path.join(tmpdir(), 'skill-shelf-plugin-dav-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const location = path.join(directory, 'webdav.json');
  const dav = memoryDav(options);
  const service = new WebDavSyncService(location, dav.request);
  await service.save({ url: base, username: 'fixture-user', password: 'fixture-password' });
  return { ...dav, service, location, directory };
}

test('WebDAV URL validation allows HTTPS and explicit loopback HTTP only', () => {
  for (const url of ['https://example.test/dav', 'http://localhost:1234/dav', 'http://127.0.0.1:1234/dav', 'http://[::1]:1234/dav']) {
    assert.equal(validateWebDavInput({ url, username: ' user ' }).url, `${url}/`);
  }
  assert.equal(validateWebDavInput({ url: ' https://example.test/dav/ ', username: '' }).url, 'https://example.test/dav/');
  for (const url of ['http://example.test/dav', 'http://192.168.1.2/dav', 'ftp://example.test/dav', 'file:///tmp/skills', 'not-a-url', 'https://user:password@example.test/', 'https://example.test/?a=1', 'https://example.test/#fragment', 'https://example.test/?', 'https://example.test/#', 'https://exam\nple.test/']) {
    assert.throws(() => validateWebDavInput({ url, username: '' }), /Invalid sync WebDAV/);
  }
  for (const username of ['colon:user', 'bad\nuser', 'bad\ruser']) assert.throws(() => validateWebDavInput({ url: base, username }), /Invalid sync WebDAV/);
  assert.throws(() => validateWebDavInput({ url: base, username: '', password: 4 }), /Invalid sync WebDAV/);
  assert.throws(() => validateWebDavInput([]), /Invalid sync WebDAV/);
});

test('credentials are atomically private, omitted password is retained only for the same account', async t => {
  const { service, location, directory, request } = await setup(t);
  const status = await service.save({ url: base, username: 'fixture-user' });
  assert.deepEqual(status, { url: base, username: 'fixture-user', hasPassword: true, passwordNeedsReentry: false });
  assert.equal(Object.hasOwn(status, 'password'), false);
  assert.equal((await stat(location)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(location, 'utf8')).password, 'fixture-password');
  assert.deepEqual(await readdir(directory), ['webdav.json']);
  assert.deepEqual(await new WebDavSyncService(location, request).getStatus(), status);
  const before = await readFile(location, 'utf8');
  await assert.rejects(service.save({ url: 'https://user:secret@example.test/', username: '' }), /Invalid sync WebDAV URL/);
  assert.equal(await readFile(location, 'utf8'), before);
  assert.equal((await service.save({ url: base, username: 'different-user' })).hasPassword, false);
  assert.equal(JSON.parse(await readFile(location, 'utf8')).password, '');
});

test('connection revisions change only after a successful save, including password-only edits', async t => {
  const { service } = await setup(t);
  const revision = service.getRevision();
  assert.equal(typeof revision, 'number');
  await service.save({ url: base, username: 'fixture-user', password: 'changed-password' });
  assert.equal(service.getRevision(), revision + 1);
  assert.equal(Object.hasOwn(await service.getStatus(), 'revision'), false);
  await assert.rejects(service.save({ url: 'not-a-url', username: '' }), /Invalid sync WebDAV/);
  assert.equal(service.getRevision(), revision + 1);
  await service.save({ url: base, username: 'fixture-user' });
  assert.equal(service.getRevision(), revision + 2);
});

test('saving credentials waits for the entire read and invalidates its old upload target', async t => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let blocked = false;
  const { service, calls } = await setup(t, { hook: async call => {
    if (!blocked && call.method === 'GET') {
      blocked = true;
      entered.resolve();
      await release.promise;
    }
  } });
  const reading = service.read();
  await entered.promise;
  const revision = service.getRevision();
  let saved = false;
  const saving = service.save({ url: 'https://dav.example.test/other/', username: 'fixture-user', password: 'changed-password' }).then(() => { saved = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saved, false);
  assert.equal(service.getRevision(), revision);
  release.resolve();
  const previous = await reading;
  await saving;
  assert.equal(service.getRevision(), revision + 1);
  const count = calls.length;
  await assert.rejects(service.upload(contents, previous), /connection changed/);
  assert.equal(calls.length, count);
  assert.ok(calls.every(call => call.path.startsWith('/dav/')));
});

test('saving during an upload cannot switch authentication before its backup index commits', async t => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let blocked = false;
  const { service, files } = await setup(t, { folders: ['/', '/dav/', '/dav/SkillShelf/'], hook: async call => {
    if (!blocked && call.method === 'PUT' && call.path === sharedPath) {
      blocked = true;
      entered.resolve();
      await release.promise;
    }
  } });
  const uploading = service.upload(contents, { contents: null, etag: null }, document);
  await entered.promise;
  let saved = false;
  const saving = service.save({ url: base, username: 'fixture-user', password: 'changed-password' }).then(() => { saved = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saved, false);
  release.resolve();
  assert.equal(await uploading, true);
  assert.equal(JSON.parse(files.get(indexPath).contents).entries.length, 1);
  await saving;
  assert.equal(saved, true);
});

test('unversioned encrypted credentials require reentry without network access', async t => {
  const { location } = await setup(t);
  await writeFile(location, JSON.stringify({ url: base, username: 'fixture-user', password: 'old-system-encrypted-value' }));
  const service = new WebDavSyncService(location, () => { throw new Error('Network must not be touched'); });
  assert.deepEqual(await service.getStatus(), { url: base, username: 'fixture-user', hasPassword: false, passwordNeedsReentry: true });
  await assert.rejects(service.test(), /Sync WebDAV password required/);
  await assert.rejects(service.save({ url: base, username: 'fixture-user' }), /Sync WebDAV password required/);
  assert.equal((await service.save({ url: base, username: 'fixture-user', password: 'replacement-password' })).passwordNeedsReentry, false);
  await writeFile(location, '{bad json');
  const broken = new WebDavSyncService(location);
  await assert.rejects(broken.getStatus(), /Sync credentials unavailable/);
  assert.equal((await broken.save({ url: base, username: '' })).hasPassword, false);
});

test('missing WebDAV collections are created parent-first; racing creation is verified', async t => {
  const { service, calls } = await setup(t, { folders: ['/'], hook: (call, { collections }) => {
    if (call.method === 'MKCOL' && call.path.endsWith('/SkillShelf/')) {
      collections.add(call.path);
      return new Response('', { status: 405 });
    }
  } });
  await service.test();
  assert.deepEqual(calls.filter(call => call.method === 'MKCOL').map(call => call.path), ['/dav/', '/dav/SkillShelf/']);
  assert.equal(calls.at(-1).method, 'PROPFIND');
  const denied = await setup(t, { hook: call => call.method === 'MKCOL' ? new Response('', { status: 405 }) : undefined });
  await assert.rejects(denied.service.test(), /folder creation HTTP 405/);
});

test('missing shared data creates SkillShelf and uses conditional create/update requests', async t => {
  const { service, calls, files, collections } = await setup(t);
  const previous = await service.read();
  assert.deepEqual(previous, { contents: null, etag: null });
  assert.ok(collections.has('/dav/SkillShelf/'));
  await service.upload(contents, previous);
  const first = calls.find(call => call.method === 'PUT');
  assert.equal(first.path, sharedPath);
  assert.equal(first.headers.get('if-none-match'), '*');
  const remote = await service.read();
  assert.equal(remote.contents, contents);
  await service.upload(contents, remote);
  const last = calls.at(-1);
  assert.equal(last.headers.get('if-match'), remote.etag);
  assert.equal(last.headers.has('if-none-match'), false);
  assert.equal(files.get(sharedPath).contents, contents);
});

test('a configured SkillShelf folder is not appended twice', async t => {
  const { service, calls } = await setup(t, { folders: ['/', '/dav/', '/dav/SkillShelf/'] });
  await service.save({ url: `${base}SkillShelf/`, username: 'fixture-user', password: 'fixture-password' });
  await service.read();
  assert.equal(calls.filter(call => call.method === 'GET').length, 1);
  assert.equal(calls[0].path, sharedPath);
});

test('legacy shared data stays at the location and ETag that were read', async t => {
  const { service, calls, files, putFile } = await setup(t);
  putFile('/dav/skill-shelf-metadata.json', contents);
  const remote = await service.read();
  assert.equal(remote.folderUrl, base);
  await service.upload(contents, remote);
  assert.equal(calls.at(-1).path, '/dav/skill-shelf-metadata.json');
  assert.equal(files.has(sharedPath), false);
  await assert.rejects(service.upload(contents, { ...remote, folderUrl: 'https://evil.example.test/' }), /invalid snapshot location/);
});

test('upload requires a syntactically strong ETag and never overwrites concurrent changes', async t => {
  const { service, calls, putFile } = await setup(t, { folders: ['/', '/dav/', '/dav/SkillShelf/'] });
  for (const etag of [null, '', 'W/"version"', 'unquoted', '"bad space"']) {
    await assert.rejects(service.upload(contents, { contents, etag }), /requires an ETag/);
  }
  assert.equal(calls.length, 0);
  putFile(sharedPath, contents, '"newer"');
  await assert.rejects(service.upload(contents, { contents, etag: '"older"' }), /HTTP 412/);
  assert.equal(calls.filter(call => call.method === 'PUT').length, 1);
  await assert.rejects(service.upload(contents, { contents: null, etag: null }), /HTTP 412/);
});

test('PUT retries folder creation without weakening its original conditional header', async t => {
  const { service, calls, collections } = await setup(t);
  await service.upload(contents, { contents: null, etag: null });
  assert.ok(collections.has('/dav/SkillShelf/'));
  const writes = calls.filter(call => call.method === 'PUT');
  assert.equal(writes.length, 2);
  assert.ok(writes.every(call => call.headers.get('if-none-match') === '*'));
});

test('backups use desktop index v2, preserve concurrent devices and keep a complete original document', async t => {
  const otherId = '33333333-3333-4333-8333-333333333333';
  let raced = false;
  const { service, files, putFile, calls } = await setup(t, { folders: ['/', '/dav/', '/dav/SkillShelf/'], hook: (call, dav) => {
    if (!raced && call.method === 'PUT' && call.path === indexPath) {
      raced = true;
      dav.putFile(indexPath, { version: 2, entries: [snapshot(otherId, otherSource)] });
    }
  } });
  assert.equal(await service.upload(contents, { contents: null, etag: null }, document), true);
  const index = JSON.parse(files.get(indexPath).contents);
  assert.equal(index.version, 2);
  assert.equal(index.entries.length, 2);
  assert.ok(index.entries.some(entry => entry.id === otherId));
  const own = index.entries.find(entry => entry.source.deviceId === source.deviceId);
  assert.deepEqual(own, snapshot(own.id));
  assert.deepEqual(JSON.parse(files.get(`/dav/SkillShelf/backups/${own.id}.json`).contents), document);
  const writes = calls.filter(call => call.method === 'PUT' && call.path === indexPath);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].headers.get('if-none-match'), '*');
  assert.ok(writes[1].headers.get('if-match'));
  putFile(`/dav/SkillShelf/backups/${otherId}.json`, { ...document, source: otherSource });
  const snapshots = await service.listSnapshots();
  assert.equal(snapshots.length, 3);
  assert.equal(snapshots[0].id, 'shared');
  assert.deepEqual(JSON.parse(await service.readSnapshot(own.id)), document);
  assert.deepEqual(JSON.parse(await service.readSnapshot('shared')), document);
  await assert.rejects(service.readSnapshot('../outside'), /Invalid sync snapshot/);
});

test('backup failures and weak index ETags report separately after a successful shared upload', async t => {
  const failed = await setup(t, { folders: ['/', '/dav/', '/dav/SkillShelf/'], hook: call => call.path.includes('/backups/') ? new Response('', { status: 500 }) : undefined });
  assert.equal(await failed.service.upload(contents, { contents: null, etag: null }, document), false);
  assert.equal(failed.files.get(sharedPath).contents, contents);
  const weak = await setup(t, { folders: ['/', '/dav/', '/dav/SkillShelf/', '/dav/SkillShelf/backups/'] });
  weak.putFile(indexPath, { version: 2, entries: [] }, 'W/"weak"');
  assert.equal(await weak.service.upload(contents, { contents: null, etag: null }, document), false);
  assert.equal(weak.calls.filter(call => call.method === 'PUT' && call.path === indexPath).length, 0);
});

test('repeated backup index conflicts stop after four conditional attempts', async t => {
  const { service, calls, files } = await setup(t, { folders: ['/', '/dav/', '/dav/SkillShelf/'], hook: call => call.method === 'PUT' && call.path === indexPath ? new Response('', { status: 412 }) : undefined });
  assert.equal(await service.upload(contents, { contents: null, etag: null }, document), false);
  assert.equal(calls.filter(call => call.method === 'PUT' && call.path === indexPath).length, 4);
  assert.equal(files.get(sharedPath).contents, contents);
});

test('missing and legacy indexes recover only same-origin direct backup files', async t => {
  const id = '44444444-4444-4444-8444-444444444444';
  const outside = '55555555-5555-4555-8555-555555555555';
  const { service, putFile, calls } = await setup(t, { folders: ['/', '/dav/', '/dav/SkillShelf/', '/dav/SkillShelf/backups/'], listingHrefs: [`https://evil.example.test/dav/SkillShelf/backups/${outside}.json`, `/dav/SkillShelf/backups/nested/${outside}.json`, `/dav/SkillShelf/backups/${outside}.json?query=1`, '/dav/SkillShelf/backups/../../secrets.json'] });
  putFile(sharedPath, contents);
  putFile(`/dav/SkillShelf/backups/${id}.json`, document);
  for (const version of [null, 1]) {
    if (version) putFile(indexPath, { version, entries: [] });
    const snapshots = await service.listSnapshots();
    assert.deepEqual(snapshots.map(item => item.id), ['shared', id]);
  }
  assert.equal(calls.some(call => call.path.includes(outside)), false);
});

test('unknown device sources in old backup entries remain omitted and their history is preserved', async t => {
  const id = '66666666-6666-4666-8666-666666666666';
  const { service, putFile, files } = await setup(t, { folders: ['/', '/dav/', '/dav/SkillShelf/', '/dav/SkillShelf/backups/'] });
  const { source: _source, ...unknown } = snapshot(id);
  putFile(indexPath, { version: 1, entries: [unknown] });
  assert.deepEqual(await service.listSnapshots(), [unknown]);
  const previous = await service.read();
  assert.equal(await service.upload(contents, previous, document), true);
  assert.deepEqual(JSON.parse(files.get(indexPath).contents).entries.find(entry => entry.id === id), unknown);
  putFile(indexPath, { version: 2, entries: [{ ...unknown, source: {} }] });
  await assert.rejects(service.listSnapshots(), /Invalid sync backup index/);
});

test('invalid documents and oversized declared or streamed responses are rejected before upload', async t => {
  const normal = await setup(t);
  await assert.rejects(normal.service.upload('{}', { contents: null, etag: null }), /sync document/i);
  assert.equal(normal.calls.length, 0);
  for (const kind of ['declared', 'streamed']) {
    let cancelled = false;
    const oversized = await setup(t, { hook: call => call.method === 'GET' ? kind === 'declared'
      ? new Response('small', { headers: { 'Content-Length': String(MAX_SYNC_BYTES + 1) } })
      : { ok: true, status: 200, headers: new Headers(), body: { getReader: () => ({ read: async () => ({ done: false, value: { byteLength: MAX_SYNC_BYTES + 1 } }), cancel: async () => { cancelled = true; } }) } }
      : undefined });
    await assert.rejects(oversized.service.read(), /Invalid sync document/);
    if (kind === 'streamed') assert.equal(cancelled, true);
  }
  normal.putFile(sharedPath, '{}');
  await assert.rejects(normal.service.read(), /sync document/i);
});

test('request and body failures never reveal remote error text, authentication data or URLs', async t => {
  const { location } = await setup(t);
  for (const [request, expected] of [
    [async () => { throw new Error('fixture-password https://sensitive.example.test/'); }, 'Sync WebDAV network error'],
    [async () => { throw new Error('Sync WebDAV fixture-password'); }, 'Sync WebDAV network error'],
    [async () => { throw Object.assign(new Error('fixture-password'), { name: 'TimeoutError' }); }, 'Sync WebDAV timeout'],
    [async () => new Response('', { status: 401 }), 'Sync WebDAV HTTP 401'],
    [async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('fixture-password')); } })), 'Sync WebDAV network error'],
  ]) {
    const service = new WebDavSyncService(location, request);
    await assert.rejects(service.read(), error => error.message === expected);
  }
});
