import type { AiAnnotation } from './types';
export { isDescriptionClearlyInTargetLanguage } from './description-language';

function canonicalLocale(locale: string) {
  try { return Intl.getCanonicalLocales(locale)[0] ?? locale; } catch { return locale; }
}

function localizedAnnotation(annotations: AiAnnotation[], locale: string) {
  const canonical = canonicalLocale(locale);
  const ordered = [...annotations].sort((a, b) => Date.parse(b.savedAt || b.createdAt) - Date.parse(a.savedAt || a.createdAt));
  return ordered.find(item => canonicalLocale(item.language) === canonical)
    ?? ordered.find(item => canonicalLocale(item.language).split('-')[0] === canonical.split('-')[0]);
}

export function getSkillTranslation(annotations: AiAnnotation[], skillId: string, locale: string) {
  return localizedAnnotation(annotations.filter(item => item.skillId === skillId && item.kind === 'translation'), locale);
}

// Keep the desktop's explicit translation > generated description > original order.
export function selectSkillAnnotation(annotations: AiAnnotation[], skillId: string, locale: string, originalDescription = '') {
  const translation = getSkillTranslation(annotations, skillId, locale);
  if (translation && !translation.stale && !isLikelyIncompleteTranslation(originalDescription, translation.text)) return translation;
  return localizedAnnotation(annotations.filter(item => item.skillId === skillId && item.kind === 'summary' && !item.stale), locale);
}

export function isLikelyIncompleteTranslation(source: string, output: string, finishReason?: string) {
  const original = source.trim(), translated = output.trim();
  if (!translated) return true;
  if (translated === original) return false;
  if (finishReason === 'length' || /[,，、;；]$/u.test(translated)) return true;
  if ((translated.match(/`/gu)?.length ?? 0) % 2 !== 0) return true;
  const pairs = [['(', ')'], ['[', ']'], ['{', '}'], ['（', '）'], ['【', '】'], ['《', '》'], ['“', '”'], ['‘', '’']];
  if (pairs.some(([open, close]) => translated.split(open).length > translated.split(close).length)) return true;
  const length = original.replace(/\s/gu, '').length;
  return length >= 200 && translated.replace(/\s/gu, '').length < length * .15;
}
