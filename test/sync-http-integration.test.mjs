import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { ShelfService } from '../src/domain.mjs';
import { SyncService } from '../src/sync.mjs';
import { WebDavSyncService } from '../src/webdav.mjs';
import { createFixture } from '../scripts/test-fixtures.mjs';

test('two isolated shelves exchange files and compatible backup history through actual loopback WebDAV HTTP', async t => {
  const files = new Map();
  const writes = [];
  let revision = 0;
  const server = createServer(async (request, response) => {
    const location = request.url;
    const existing = files.get(location);
    if (request.method === 'PROPFIND') {
      response.writeHead(207, { 'Content-Type': 'application/xml' });
      response.end(`<d:multistatus xmlns:d="DAV:">${[...files.keys()].filter(file => file.startsWith(location)).map(file => `<d:response><d:href>${file}</d:href></d:response>`).join('')}</d:multistatus>`);
    } else if (request.method === 'GET') {
      response.writeHead(existing ? 200 : 404, existing ? { ETag: existing.etag, 'Content-Type': 'application/json' } : {});
      response.end(existing?.contents);
    } else if (request.method === 'PUT') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      if ((request.headers['if-none-match'] === '*' && existing) || (request.headers['if-match'] && request.headers['if-match'] !== existing?.etag)) {
        response.writeHead(412); response.end(); return;
      }
      assert.ok(request.headers['if-match'] || request.headers['if-none-match'], 'Every DAV write must be conditional.');
      const contents = Buffer.concat(chunks).toString('utf8');
      files.set(location, { contents, etag: `"revision-${++revision}"` });
      writes.push(location);
      response.writeHead(201); response.end();
    } else { response.writeHead(request.method === 'MKCOL' ? 201 : 405); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }));
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const service = new ShelfService(fixture);
  const state = await service.initialize();
  await service.importSkills('default', { skillIds: [state.skills[0].id] });
  const second = new ShelfService({ ...fixture, dataDir: path.join(fixture.root, 'other-shelf') });
  await second.initialize();
  const endpoint = `http://127.0.0.1:${server.address().port}/dav/`;
  const connect = async shelf => {
    const webdav = new WebDavSyncService(path.join(shelf.dataDir, 'webdav-sync.json'));
    await webdav.save({ url: endpoint, username: 'fixture', password: 'fake-app-password' });
    return new SyncService({ service: shelf, webdav });
  };
  const a = await connect(service);
  const b = await connect(second);
  const apply = async (sync, preview) => sync.apply({ previewId: preview.id, resolutions: Object.fromEntries(preview.conflicts.map(conflict => [conflict.id, preview.mode === 'upload' ? 'local' : 'incoming'])) });
  const result = await apply(a, await a.previewUpload());
  assert.equal(result.uploaded, true);
  assert.equal(result.cloudBackupSaved, true);
  await apply(b, await b.previewPull());
  assert.equal((await second.snapshot()).managedSkills.length, 1);
  await apply(b, await b.previewPull());
  assert.equal((await second.snapshot()).managedSkills.length, 1);
  const local = await b.exportDocument();
  const original = await a.exportDocument();
  assert.deepEqual(local.managedSkills.map(skill => skill.copyId), original.managedSkills.map(skill => skill.copyId));
  assert.deepEqual(local.managedSkills[0].files, original.managedSkills[0].files);
  await apply(b, await b.previewUpload());
  const history = JSON.parse(files.get('/dav/SkillShelf/backups/index.json').contents);
  assert.equal(history.version, 2);
  assert.equal(history.entries.length, 2);
  assert.equal(new Set(history.entries.map(entry => entry.source.deviceId)).size, 2);
  assert.equal(writes.filter(file => file === '/dav/SkillShelf/skill-shelf-metadata.json').length, 2);
});
