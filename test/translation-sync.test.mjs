import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { ShelfService } from '../src/domain.mjs';
import { AIBridge } from '../src/ai.mjs';
import { SyncService } from '../src/sync.mjs';
import { parseSyncDocument } from '../src/sync-format.mjs';

const SOURCE_DESCRIPTION = 'Organize reliable sources and preserve references.';
const SOURCE_TEXT = `---\nname: Demo\ndescription: ${SOURCE_DESCRIPTION}\n---\n\nOriginal Skill instructions.\n`;
const TRANSLATED_AT = '2026-01-01T00:00:00.000Z';
const clone = value => structuredClone(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const translation = (content = 'Translated description.', overrides = {}) => ({
  content, sourceDescription: SOURCE_DESCRIPTION, translatedAt: TRANSLATED_AT, method: 'ai', ...overrides,
});
const choices = (preview, choice = 'incoming') => ({
  previewId: preview.id,
  resolutions: Object.fromEntries(preview.conflicts.map(conflict => [conflict.id, choice])),
});

async function fixture(t, { injected = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shelf-translation-sync-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, 'home');
  const skillDir = path.join(homeDir, '.agents', 'skills', 'demo');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), SOURCE_TEXT);
  await fs.writeFile(path.join(homeDir, '.agents', '.skill-lock.json'), JSON.stringify({
    skills: { Demo: { source: 'fixture/demo', sourceType: 'github' } },
  }));
  const service = new ShelfService({ dataDir: path.join(root, 'data'), homeDir, magpieDir: path.join(root, 'magpie') });
  await service.initialize();
  const skillId = service.skills[0].id;
  const ai = new AIBridge({ service, magpieDir: service.magpieDir });
  ai.request = async () => { assert.fail('Translation sync must not call a model or gateway.'); };
  t.after(() => ai.close());
  const sync = new SyncService({ service, ...(injected ? { ai } : {}) });
  const aiFile = path.join(service.dataDir, 'ai-results.json');
  const annotation = (overrides = {}) => ({
    skillId, kind: 'translation', language: 'en', text: 'Local translation.', model: 'fixture/writer',
    sourceDigest: digest(SOURCE_TEXT), createdAt: TRANSLATED_AT, savedAt: TRANSLATED_AT, ...overrides,
  });
  const seed = annotations => fs.writeFile(aiFile, JSON.stringify({ version: 1, annotations }, null, 2), { mode: 0o600 });
  const save = async (overrides = {}) => {
    const draftId = randomUUID();
    const source = await ai.source(skillId);
    ai.drafts.set(draftId, { draftId, skillId, kind: 'translation', language: 'en',
      text: 'Local translation.', model: 'fixture/writer', sourceDigest: source.sourceDigest,
      sourceDescription: source.description, createdAt: new Date().toISOString(), ...overrides });
    return ai.save({ draftId });
  };
  return { root, service, skillDir, skillId, ai, sync, aiFile, annotation, seed, save };
}

function cloud(sync, document) {
  const webdav = {
    revision: 0, contents: JSON.stringify(document), etag: 'fixture-1', uploads: [],
    getStatus: () => ({ url: 'https://example.test/dav', username: 'fixture', hasPassword: true }),
    async read() { return { contents: this.contents, etag: this.etag, folderUrl: 'https://example.test/dav/SkillShelf/' }; },
    async upload(contents, previous, backup) {
      this.uploads.push({ contents, previous, backup });
      this.contents = contents;
      return true;
    },
  };
  sync.webdav = webdav;
  return webdav;
}

test('malformed source frontmatter excludes translations without blocking organization sync', async t => {
  const f = await fixture(t);
  const document = await f.sync.exportDocument();
  document.skills[0].tags = ['desktop-tag'];
  document.skills[0].translations.en = translation();
  const malformed = '---\nname: Demo\ndescription: [\n---\n\nInstructions.\n';
  await fs.writeFile(path.join(f.skillDir, 'SKILL.md'), malformed);
  const exported = await f.sync.exportDocument();
  assert.deepEqual(exported.skills[0].translations, {});
  const preview = await f.sync.previewImport(document);
  assert.equal(preview.matched, 1);
  await f.sync.apply(choices(preview));
  assert.deepEqual(f.service.state.organization[f.skillId].tags, ['desktop-tag']);
  await assert.rejects(fs.access(f.aiFile), error => error.code === 'ENOENT');
  assert.equal(await fs.readFile(path.join(f.skillDir, 'SKILL.md'), 'utf8'), malformed);
});

test('default sync exports saved legacy description translations in desktop format, not summaries, files or Pack annotations', async t => {
  const f = await fixture(t, { injected: false });
  await f.service.importSkills('default', { skillIds: [f.skillId] });
  const managedId = f.service.state.managedSkills[0].id;
  await f.seed([
    f.annotation(),
    f.annotation({ language: 'fr', text: SOURCE_DESCRIPTION, model: 'source-copy' }),
    f.annotation({ kind: 'summary', text: 'Private summary only.' }),
    f.annotation({ kind: 'file-translation', filePath: 'SKILL.md', text: 'Private historic file translation.' }),
    f.annotation({ skillId: managedId, text: 'Private Pack translation.' }),
  ]);
  const before = await fs.readFile(f.aiFile, 'utf8');
  const document = await f.sync.exportDocument();
  assert.deepEqual(document.skills[0].translations, {
    en: translation('Local translation.'),
    fr: translation(SOURCE_DESCRIPTION, { method: 'source-copy' }),
  });
  assert.deepEqual(document.skills[0].descriptions, {});
  assert.equal(document.version, 5);
  assert.deepEqual(parseSyncDocument(JSON.stringify(document)), document);
  assert(document.managedSkills.every(skill => !Object.hasOwn(skill, 'translations')));
  assert(document.packs.every(pack => pack.skills.every(skill => !Object.hasOwn(skill, 'translations'))));
  const portable = JSON.stringify(document);
  for (const localOnly of ['fixture/writer', 'sourceDigest', 'savedAt', 'Private summary', 'Private historic', 'Private Pack', f.root, f.skillId]) {
    assert(!portable.includes(localOnly), localOnly);
  }
  assert.equal(await fs.readFile(f.aiFile, 'utf8'), before);
  assert.equal(await fs.readFile(path.join(f.skillDir, 'SKILL.md'), 'utf8'), SOURCE_TEXT);
});

test('sync excludes stale and unknown legacy translations without deleting local AI records', async t => {
  const f = await fixture(t);
  await f.seed([
    f.annotation({ sourceDigest: '0'.repeat(64), text: 'Outdated translation.' }),
    f.annotation({ skillId: 'unknown-skill', language: 'fr', text: 'Unknown translation.' }),
  ]);
  const before = await fs.readFile(f.aiFile, 'utf8');
  assert.deepEqual((await f.sync.exportDocument()).skills[0].translations, {});
  assert.equal(await fs.readFile(f.aiFile, 'utf8'), before);
});

test('new description translations remain valid after body-only changes but become stale when the source description changes', async t => {
  const f = await fixture(t);
  await f.save();
  const original = (await f.sync.exportDocument()).skills[0].translations.en;
  await fs.appendFile(path.join(f.skillDir, 'SKILL.md'), '\nA body-only change.\n');
  assert.equal((await f.ai.results(f.skillId)).translations[0].stale, false);
  assert.deepEqual((await f.sync.exportDocument()).skills[0].translations.en, original);
  await fs.writeFile(path.join(f.skillDir, 'SKILL.md'), SOURCE_TEXT.replace(SOURCE_DESCRIPTION, 'A new source description.'));
  assert.equal((await f.ai.results(f.skillId)).translations[0].stale, true);
  assert.deepEqual((await f.sync.exportDocument()).skills[0].translations, {});
  const saved = JSON.parse(await fs.readFile(f.aiFile, 'utf8'));
  assert.equal(saved.annotations[0].text, 'Local translation.');
});

test('import updates an already loaded injected AI bridge immediately and reexports equivalent desktop translations', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.ai.results(f.skillId), { translations: [] });
  const document = await f.sync.exportDocument();
  document.skills[0].translations = { en: translation(), fr: translation('Description francaise.', { method: 'source-copy' }), it: translation('Descrizione italiana.') };
  const beforeState = await fs.readFile(path.join(f.service.dataDir, 'state.json'), 'utf8');
  const preview = await f.sync.previewImport(document);
  assert.equal(preview.conflicts.length, 0);
  assert.equal(preview.changed, 1);
  assert.deepEqual(await f.ai.results(f.skillId), { translations: [] });
  assert.equal(await fs.readFile(path.join(f.service.dataDir, 'state.json'), 'utf8'), beforeState);
  await f.sync.apply(choices(preview));
  const results = await f.ai.results(f.skillId);
  assert.deepEqual(results.translations.map(item => [item.language, item.text, item.stale]).sort(), [
    ['en', 'Translated description.', false], ['fr', 'Description francaise.', false], ['it', 'Descrizione italiana.', false],
  ]);
  assert.deepEqual((await f.ai.list()).annotations.map(item => item.text).sort(), ['Description francaise.', 'Descrizione italiana.', 'Translated description.']);
  assert.deepEqual((await f.sync.exportDocument()).skills[0].translations, document.skills[0].translations);
  const again = await f.sync.previewImport(document);
  assert.equal(again.changed, 0);
  assert.equal(again.conflicts.length, 0);
  assert.equal(await fs.readFile(path.join(f.skillDir, 'SKILL.md'), 'utf8'), SOURCE_TEXT);
});

test('default sync imports translations that a fresh AI bridge can display after restart', async t => {
  const f = await fixture(t, { injected: false });
  const document = await f.sync.exportDocument();
  document.skills[0].translations = { en: translation('Desktop translation.') };
  const preview = await f.sync.previewImport(document);
  await f.sync.apply(choices(preview));
  const results = await f.ai.results(f.skillId);
  assert.equal(results.translations[0].text, 'Desktop translation.');
  assert.equal(results.translations[0].stale, false);
  assert.deepEqual((await f.sync.exportDocument()).skills[0].translations, document.skills[0].translations);
});

test('same-language description conflicts obey local and incoming choices', async t => {
  for (const choice of ['local', 'incoming']) {
    const f = await fixture(t);
    await f.save();
    const document = await f.sync.exportDocument();
    document.skills[0].translations.en = translation('Desktop translation.');
    const preview = await f.sync.previewImport(document);
    assert.equal(preview.changed, 1);
    assert.equal(preview.conflicts.length, 1);
    const conflict = preview.conflicts[0];
    assert.equal(conflict.field, 'translation:en');
    assert.match(conflict.local, /Local translation/);
    assert.match(conflict.incoming, /Desktop translation/);
    await assert.rejects(f.sync.apply({ previewId: preview.id, resolutions: {} }), /every sync conflict/);
    await f.sync.apply(choices(preview, choice));
    const expected = choice === 'local' ? 'Local translation.' : 'Desktop translation.';
    assert.equal((await f.ai.results(f.skillId)).translations[0].text, expected);
    assert.equal((await f.sync.exportDocument()).skills[0].translations.en.content, expected);
  }
});

test('import merges separate languages and retains summaries and historic file annotations', async t => {
  const f = await fixture(t);
  const summary = f.annotation({ kind: 'summary', text: 'Existing summary.' });
  const historical = f.annotation({ kind: 'file-translation', filePath: 'SKILL.md', text: 'Historic file result.' });
  await f.seed([f.annotation(), summary, historical]);
  await f.ai.results(f.skillId);
  const document = await f.sync.exportDocument();
  document.skills[0].translations = { fr: translation('Desktop French translation.') };
  const preview = await f.sync.previewImport(document);
  assert.equal(preview.conflicts.length, 0);
  await f.sync.apply(choices(preview));
  assert.deepEqual((await f.ai.results(f.skillId)).translations.map(item => item.language).sort(), ['en', 'fr']);
  const saved = JSON.parse(await fs.readFile(f.aiFile, 'utf8'));
  assert.deepEqual(saved.annotations.find(item => item.kind === 'summary'), summary);
  assert.deepEqual(saved.annotations.find(item => item.kind === 'file-translation'), historical);
  assert.deepEqual(Object.keys((await f.sync.exportDocument()).skills[0].translations).sort(), ['en', 'fr']);
});

test('equal translation content and source do not conflict when timestamps or method differ', async t => {
  const f = await fixture(t);
  await f.save();
  const document = await f.sync.exportDocument();
  document.skills[0].translations.en.translatedAt = '2025-01-01T00:00:00.000Z';
  document.skills[0].translations.en.method = 'source-copy';
  const before = await fs.readFile(f.aiFile, 'utf8');
  const preview = await f.sync.previewImport(document);
  assert.equal(preview.changed, 0);
  assert.equal(preview.conflicts.length, 0);
  await f.sync.apply(choices(preview));
  assert.equal(await fs.readFile(f.aiFile, 'utf8'), before);
  const webdav = cloud(f.sync, document);
  const upload = await f.sync.previewUpload();
  assert.equal(upload.changed, 0);
  assert.equal(upload.conflicts.length, 0);
  await f.sync.apply(choices(upload, 'local'));
  assert.deepEqual(parseSyncDocument(webdav.contents).skills[0].translations.en, document.skills[0].translations.en);
});

test('mismatched source descriptions are skipped without overwriting valid local translations', async t => {
  for (const existing of [false, true]) {
    const f = await fixture(t);
    if (existing) await f.save();
    const document = await f.sync.exportDocument();
    document.skills[0].translations = {
      en: translation('Wrong-source translation.', { sourceDescription: 'A different description.' }),
      fr: translation('Valid French translation.'),
    };
    const preview = await f.sync.previewImport(document);
    assert.equal(preview.conflicts.length, 0);
    assert.equal(preview.changed, 1);
    assert(preview.warnings.length > 0);
    await f.sync.apply(choices(preview));
    const exported = (await f.sync.exportDocument()).skills[0].translations;
    assert.equal(exported.fr.content, 'Valid French translation.');
    if (existing) assert.equal(exported.en.content, 'Local translation.');
    else assert.equal(exported.en, undefined);
    assert(!(await f.ai.results(f.skillId)).translations.some(item => item.text === 'Wrong-source translation.'));
  }
});

test('sync validates translation source, content, language and timestamp without applying anything', async t => {
  const f = await fixture(t);
  const document = await f.sync.exportDocument();
  document.skills[0].translations = { en: translation() };
  const invalidValues = [
    { sourceDescription: null }, { sourceDescription: '' }, { sourceDescription: 'x'.repeat(4001) },
    { content: null }, { content: '' }, { content: 'x'.repeat(4001) },
    { translatedAt: 'not-a-date' }, { translatedAt: null },
  ];
  for (const overrides of invalidValues) {
    const invalid = clone(document);
    invalid.skills[0].translations.en = translation('Invalid fixture.', overrides);
    assert.throws(() => parseSyncDocument(JSON.stringify(invalid)), undefined, JSON.stringify(overrides));
    await assert.rejects(f.sync.previewImport(invalid), undefined, JSON.stringify(overrides));
  }
  for (const locale of ['zh_cn', 'en;model', '', 'x'.repeat(49)]) {
    const invalid = clone(document);
    invalid.skills[0].translations = { [locale]: translation() };
    assert.throws(() => parseSyncDocument(JSON.stringify(invalid)), undefined, locale);
  }
  assert.deepEqual(await f.ai.results(f.skillId), { translations: [] });
  assert.equal(await fs.readFile(path.join(f.skillDir, 'SKILL.md'), 'utf8'), SOURCE_TEXT);
});

test('desktop translation entries without or with unrecognized method normalize to AI translations', async t => {
  for (const method of [undefined, null, 'model-name']) {
    const f = await fixture(t);
    const document = await f.sync.exportDocument();
    document.skills[0].translations = { en: translation('Translated description.', { method }) };
    if (method === undefined) delete document.skills[0].translations.en.method;
    const preview = await f.sync.previewImport(document);
    await f.sync.apply(choices(preview));
    assert.equal((await f.ai.results(f.skillId)).translations[0].text, 'Translated description.');
    assert.deepEqual((await f.sync.exportDocument()).skills[0].translations.en, translation());
  }
});

test('saved AI translation changes invalidate previously cached import and upload previews', async t => {
  for (const mode of ['import', 'upload']) {
    const f = await fixture(t);
    const document = await f.sync.exportDocument();
    if (mode === 'upload') cloud(f.sync, document);
    const preview = mode === 'upload' ? await f.sync.previewUpload() : await f.sync.previewImport(document);
    await f.save({ text: 'New translation after preview.' });
    await assert.rejects(f.sync.apply(choices(preview)), /stale|expired/i);
    assert.equal((await f.ai.results(f.skillId)).translations[0].text, 'New translation after preview.');
    if (mode === 'upload') assert.equal(f.sync.webdav.uploads.length, 0);
  }
});

test('mock cloud upload includes local translations, retains remote languages and backs up the local snapshot', async t => {
  const f = await fixture(t);
  await f.save();
  const document = await f.sync.exportDocument();
  document.skills[0].translations = { fr: translation('Cloud-only French translation.') };
  const webdav = cloud(f.sync, document);
  const before = await fs.readFile(f.aiFile, 'utf8');
  const preview = await f.sync.previewUpload();
  assert.equal(preview.conflicts.length, 0);
  assert.equal(preview.changed, 1);
  const result = await f.sync.apply(choices(preview, 'local'));
  assert.equal(result.uploaded, true);
  assert.equal(result.cloudBackupSaved, true);
  const uploaded = parseSyncDocument(webdav.contents);
  assert.equal(uploaded.skills[0].translations.en.content, 'Local translation.');
  assert.deepEqual(uploaded.skills[0].translations.fr, document.skills[0].translations.fr);
  assert.equal(webdav.uploads[0].backup.skills[0].translations.en.content, 'Local translation.');
  assert.equal(webdav.uploads[0].backup.skills[0].translations.fr, undefined);
  assert.equal(await fs.readFile(f.aiFile, 'utf8'), before);
  assert.equal((await f.ai.results(f.skillId)).translations.length, 1);
});

test('mock cloud upload same-language conflicts use selected translations and retain remote-only languages', async t => {
  for (const choice of ['local', 'incoming']) {
    const f = await fixture(t);
    await f.save();
    const document = await f.sync.exportDocument();
    document.skills[0].translations = { en: translation('Cloud translation.'), fr: translation('Cloud French translation.') };
    const webdav = cloud(f.sync, document);
    const preview = await f.sync.previewUpload();
    assert.equal(preview.conflicts.length, 1);
    assert.equal(preview.conflicts[0].field, 'translation:en');
    await f.sync.apply(choices(preview, choice));
    const uploaded = parseSyncDocument(webdav.contents);
    assert.equal(uploaded.skills[0].translations.en.content, choice === 'local' ? 'Local translation.' : 'Cloud translation.');
    assert.deepEqual(uploaded.skills[0].translations.fr, document.skills[0].translations.fr);
    assert.equal(webdav.uploads[0].backup.skills[0].translations.en.content, 'Local translation.');
    assert.equal((await f.ai.results(f.skillId)).translations[0].text, 'Local translation.');
  }
});

test('valid local translation replaces a stale same-language cloud translation without a conflict', async t => {
  const f = await fixture(t);
  await f.save();
  const document = await f.sync.exportDocument();
  document.skills[0].translations.en = translation('Outdated cloud translation.', { sourceDescription: 'An obsolete description.' });
  const webdav = cloud(f.sync, document);
  const preview = await f.sync.previewUpload();
  assert.equal(preview.conflicts.length, 0);
  assert.equal(preview.changed, 1);
  await f.sync.apply(choices(preview, 'incoming'));
  assert.equal(parseSyncDocument(webdav.contents).skills[0].translations.en.content, 'Local translation.');
});

test('failed state save rolls back imported translations on disk and in the loaded AI bridge', async t => {
  for (const existing of [false, true]) {
    const f = await fixture(t);
    if (existing) await f.save();
    const beforeResults = await f.ai.results(f.skillId);
    const before = existing ? await fs.readFile(f.aiFile, 'utf8') : null;
    const document = await f.sync.exportDocument();
    document.skills[0].translations = { en: translation('Incoming translation.'), fr: translation('Incoming French translation.') };
    const preview = await f.sync.previewImport(document);
    const save = f.service.save;
    f.service.save = async () => { throw new Error('Fixture state save failure'); };
    await assert.rejects(f.sync.apply(choices(preview)), /Fixture state save failure/);
    f.service.save = save;
    assert.deepEqual(await f.ai.results(f.skillId), beforeResults);
    if (existing) assert.equal(await fs.readFile(f.aiFile, 'utf8'), before);
    else await assert.rejects(fs.stat(f.aiFile), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(f.skillDir, 'SKILL.md'), 'utf8'), SOURCE_TEXT);
    assert(!(await fs.readdir(f.service.dataDir)).some(name => name.endsWith('.tmp')));
    const retry = await f.sync.previewImport(document);
    await f.sync.apply(choices(retry));
    assert.equal((await f.ai.results(f.skillId)).translations.length, 2);
  }
});
