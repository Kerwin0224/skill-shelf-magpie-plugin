import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['web/src/resolve-skill-description.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { getSkillTranslation, selectSkillAnnotation } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const annotation = (kind, language, text, date, stale = false) => ({ skillId: 'fixture', kind, language, text, createdAt: date, savedAt: date, stale });
const translation = annotation('translation', 'zh-CN', '这是一个完整的描述。', '2026-10-01T00:00:00Z');
const summary = annotation('summary', 'zh-CN', '较晚保存的摘要。', '2026-10-02T00:00:00Z');

test('explicit translation wins over a later summary regardless of storage order', () => {
  for (const values of [[summary, translation], [translation, summary]]) {
    assert.equal(selectSkillAnnotation(values, 'fixture', 'zh-CN', 'Research reliable sources.'), translation);
  }
});

test('language fallback uses the base language, preferring an exact locale', () => {
  const base = { ...translation, language: 'zh' };
  assert.equal(getSkillTranslation([base], 'fixture', 'zh-CN'), base);
  assert.equal(getSkillTranslation([base, translation], 'fixture', 'zh-CN'), translation);
  assert.equal(selectSkillAnnotation([translation], 'fixture', 'en', 'Original.'), undefined);
});

test('stale and incomplete translations do not replace a valid summary or original', () => {
  assert.equal(selectSkillAnnotation([{ ...translation, stale: true }, summary], 'fixture', 'zh-CN', 'Original.'), summary);
  assert.equal(selectSkillAnnotation([{ ...translation, text: '未完成，' }], 'fixture', 'zh-CN', 'Original.'), undefined);
  assert.equal(selectSkillAnnotation([{ ...summary, stale: true }], 'fixture', 'zh-CN', 'Original.'), undefined);
});

test('file translations and annotations for other Skills cannot become the description', () => {
  assert.equal(selectSkillAnnotation([{ ...translation, kind: 'file-translation' }, { ...translation, skillId: 'other' }], 'fixture', 'zh-CN', 'Original.'), undefined);
});
