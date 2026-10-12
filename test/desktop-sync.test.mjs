import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { ShelfService } from '../src/domain.mjs';
import { SyncService } from '../src/sync.mjs';
import { AIBridge } from '../src/ai.mjs';
import { createFixture } from '../scripts/test-fixtures.mjs';

const desktop = path.resolve(process.env.SHELF_DESKTOP_SOURCE || '../skill-shelf', 'desktop/src/main/services');

test('v5 files round-trip through the real desktop parser and managed import service', async t => {
  try { await access(path.join(desktop, 'metadata-sync-service.ts')); }
  catch { t.skip('The optional Skill Shelf desktop source checkout is unavailable.'); return; }
  const fixture = await createFixture();
  t.after(fixture.cleanup);
  const service = new ShelfService(fixture);
  const initial = await service.initialize();
  const alpha = initial.skills.find(skill => skill.name === 'Alpha Research');
  await service.organize({ ids: [alpha.id], tags: ['installed-metadata'] });
  await service.importSkills('default', { skillIds: [alpha.id] });
  await service.importSkills('default', { skillIds: [alpha.id] });
  const other = await service.createPack({ name: 'Research' });
  const pack = other.packs.find(item => item.name === 'Research');
  await service.importSkills(pack.id, { skillIds: [alpha.id] });
  const folderState = await service.createFolder({ name: 'Reading', scopeId: `pack:${pack.id}`, color: '#123abc' });
  const folder = folderState.folders.find(item => item.name === 'Reading');
  await service.createFolder({ name: 'Empty', scopeId: `pack:${pack.id}`, parentId: folder.id });
  const member = folderState.managedSkills.find(item => item.packId === pack.id);
  await service.organize({ ids: [member.id], folderId: folder.id, tags: ['research'] });
  const ai = new AIBridge({ service, magpieDir: fixture.magpieDir });
  const translatedAt = new Date().toISOString();
  ai.drafts.set('translation-fixture', { draftId: 'translation-fixture', skillId: alpha.id, kind: 'translation', language: 'zh-CN', text: 'Plugin description translation', model: 'fixture/model', sourceDescription: alpha.description.trim(), method: 'ai', sourceDigest: createHash('sha256').update(await readFile(path.join(alpha.path, 'SKILL.md'))).digest('hex'), createdAt: translatedAt });
  await ai.save({ draftId: 'translation-fixture' });
  const sync = new SyncService({ service, ai });
  const document = await sync.exportDocument();

  // Compile the actual desktop services, not a second hand-written schema oracle.
  const output = path.join(fixture.root, 'desktop-services.mjs');
  await build({
    stdin: { contents: [
      `export { MetadataSyncService, parseSyncDocument } from ${JSON.stringify(path.join(desktop, 'metadata-sync-service.ts'))};`,
      `export { ShelfStore } from ${JSON.stringify(path.join(desktop, 'shelf-store.ts'))};`,
      `export { ManagedSkillService } from ${JSON.stringify(path.join(desktop, 'managed-skill-service.ts'))};`,
    ].join('\n'), resolveDir: desktop },
    outfile: output, bundle: true, platform: 'node', format: 'esm', target: 'node22',
    banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(createRequire(import.meta.url).resolve('esbuild'))});` },
    logLevel: 'silent',
  });
  const { MetadataSyncService, parseSyncDocument, ShelfStore, ManagedSkillService } = await import(pathToFileURL(output).href);
  const parsed = parseSyncDocument(JSON.stringify(document));
  assert.equal(parsed.version, 5);
  assert.equal(parsed.managedSkills.length, document.managedSkills.length);

  const store = new ShelfStore(path.join(fixture.root, 'desktop-shelf.json'));
  const managed = new ManagedSkillService(path.join(fixture.root, 'desktop-managed'), path.join(fixture.root, 'desktop-managed.json'));
  await managed.initialize();
  const getCatalog = async () => {
    const state = await store.getState();
    return {
      cliVersion: '', externalSkills: [], groups: state.groups, projects: [], scannedAt: new Date().toISOString(),
      skills: initial.skills.map(skill => ({
        ...skill, id: `global:${skill.id}`, scope: 'global', sourceType: 'local', source: skill.path,
        installKind: 'directory', tags: [], groupId: null, position: null, descriptions: {}, translations: {},
        updateCheck: { status: 'unchecked', reason: 'not-scanned' },
        ...(state.organizations[`global:${skill.id}`] ?? {}),
      })),
    };
  };
  const desktopSync = new MetadataSyncService(store, getCatalog, { managedSkills: managed });
  const preview = await desktopSync.preview(JSON.stringify(document));
  assert.equal(preview.matched, initial.skills.length);
  assert.equal(preview.managedSkills.skipped.length, 0);
  await desktopSync.apply({ previewId: preview.id, resolutions: Object.fromEntries(preview.conflicts.map(item => [item.id, 'incoming'])), includePreferences: false });
  assert.equal((await store.getState()).organizations[`global:${alpha.id}`].translations['zh-CN'].content, 'Plugin description translation');
  await store.saveSkillTranslation({ skillId: `global:${alpha.id}`, language: 'it', content: 'Desktop description translation', sourceDescription: alpha.description.trim(), method: 'ai' });
  await store.saveSkillTranslation({ skillId: `global:${alpha.id}`, language: 'en', content: alpha.description.trim(), sourceDescription: alpha.description.trim(), method: 'source-copy' });
  const reexport = await desktopSync.exportDocument();
  assert.deepEqual(reexport.skills.find(skill => skill.name === alpha.name).tags, ['installed-metadata']);
  const research = reexport.packs.find(item => item.name === 'Research');
  assert.deepEqual(research.skills[0].tags, ['research']);
  assert.deepEqual(research.skills[0].folderPath, ['Reading']);
  assert.ok(research.folders.some(item => JSON.stringify(item.path) === JSON.stringify(['Reading', 'Empty'])));
  assert.deepEqual(reexport.managedSkills.map(item => item.copyId).sort(), document.managedSkills.map(item => item.copyId).sort());
  assert.deepEqual(reexport.managedSkills.map(item => item.contentHash).sort(), document.managedSkills.map(item => item.contentHash).sort());

  const second = new ShelfService({ ...fixture, dataDir: path.join(fixture.root, 'plugin-restored') });
  await second.initialize();
  const secondSync = new SyncService({ service: second });
  const incoming = await secondSync.previewImport(reexport);
  assert.equal(incoming.skipped, 0);
  await secondSync.apply({ previewId: incoming.id, resolutions: Object.fromEntries(incoming.conflicts.map(item => [item.id, 'incoming'])) });
  const restored = await secondSync.exportDocument();
  const restoredTranslations = restored.skills.find(skill => skill.name === alpha.name).translations;
  assert.deepEqual(restoredTranslations, reexport.skills.find(skill => skill.name === alpha.name).translations);
  const restoredAi = new AIBridge({ service: second, magpieDir: fixture.magpieDir });
  const results = await restoredAi.results(second.skills.find(skill => skill.name === alpha.name).id);
  assert.equal(results.translations.find(item => item.language === 'it').text, 'Desktop description translation');
  assert.equal(results.translations.find(item => item.language === 'en').model, 'source-copy');
  assert(results.translations.every(item => item.stale === false));
  assert.deepEqual(restored.managedSkills.map(item => item.copyId).sort(), document.managedSkills.map(item => item.copyId).sort());
  parseSyncDocument(JSON.stringify(restored));
});
