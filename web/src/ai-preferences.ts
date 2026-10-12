import { useEffect, useState } from 'react';

export const AI_PREFERENCES_KEY = 'shelf-ai:preferences';
export const AI_MODEL_KEY = 'shelf-ai:model';
export const AI_LANGUAGE_KEY = 'shelf-ai:language';
const CHANGE_EVENT = 'shelf-ai:preferences-changed';
export const aiLanguages = [['zh-CN', '简体中文'], ['en', 'English'], ['zh-TW', '繁體中文'], ['ja', '日本語'], ['ko', '한국어'], ['de', 'Deutsch'], ['fr', 'Français'], ['es', 'Español'], ['pt', 'Português'], ['ru', 'Русский']];
export type AiStatus = { available: boolean; baseUrl: string; models: { id: string; name: string }[]; reason?: string };
export type AiPreferences = { enabled: boolean; chatModel: string; summaryModel: string; translationModel: string; targetLanguage: string; summaryContext: 'skill-md' | 'description' };
const defaultPreferences: AiPreferences = { enabled: true, chatModel: '', summaryModel: '', translationModel: '', targetLanguage: 'zh-CN', summaryContext: 'skill-md' };
const isModel = (value: unknown): value is string => typeof value === 'string' && value.length <= 512 && !/[\x00-\x1f]/.test(value);

export function readAiPreferences(): AiPreferences {
  try {
    let value: unknown;
    try { value = JSON.parse(localStorage.getItem(AI_PREFERENCES_KEY) || 'null'); } catch { value = null; }
    const stored = value && typeof value === 'object' && !Array.isArray(value) ? value as Partial<AiPreferences> : {};
    const legacyModel = localStorage.getItem(AI_MODEL_KEY) || '';
    const legacyLanguage = localStorage.getItem(AI_LANGUAGE_KEY) || '';
    const model = isModel(legacyModel) ? legacyModel : '';
    const language = stored.targetLanguage ?? legacyLanguage;
    return {
      enabled: typeof stored.enabled === 'boolean' ? stored.enabled : true,
      chatModel: isModel(stored.chatModel) ? stored.chatModel : isModel(stored.summaryModel) ? stored.summaryModel : model,
      summaryModel: isModel(stored.summaryModel) ? stored.summaryModel : model,
      translationModel: isModel(stored.translationModel) ? stored.translationModel : model,
      targetLanguage: aiLanguages.some(([id]) => id === language) ? language : 'zh-CN',
      summaryContext: stored.summaryContext === 'description' ? 'description' : 'skill-md',
    };
  } catch { return { ...defaultPreferences }; }
}

export function saveAiPreferences(patch: Partial<AiPreferences>): AiPreferences {
  if (('enabled' in patch && typeof patch.enabled !== 'boolean')
    || ('chatModel' in patch && !isModel(patch.chatModel))
    || ('summaryModel' in patch && !isModel(patch.summaryModel))
    || ('translationModel' in patch && !isModel(patch.translationModel))
    || ('targetLanguage' in patch && !aiLanguages.some(([id]) => id === patch.targetLanguage))
    || ('summaryContext' in patch && !['skill-md', 'description'].includes(patch.summaryContext!))) {
    throw new Error('AI 设置无效，请重新选择。');
  }
  const next = { ...readAiPreferences(), ...patch };
  try { localStorage.setItem(AI_PREFERENCES_KEY, JSON.stringify(next)); }
  catch { throw new Error('浏览器无法保存 AI 设置，请允许此页面使用本地存储后重试。'); }
  window.dispatchEvent(new Event(CHANGE_EVENT));
  return next;
}

export function useAiPreferences(): AiPreferences {
  const [preferences, setPreferences] = useState(readAiPreferences);
  useEffect(() => {
    const update = () => setPreferences(readAiPreferences());
    const onStorage = (event: StorageEvent) => { if (!event.key || [AI_PREFERENCES_KEY, AI_MODEL_KEY, AI_LANGUAGE_KEY].includes(event.key)) update(); };
    window.addEventListener(CHANGE_EVENT, update);
    window.addEventListener('storage', onStorage);
    update();
    return () => { window.removeEventListener(CHANGE_EVENT, update); window.removeEventListener('storage', onStorage); };
  }, []);
  return preferences;
}

// An explicit missing model never falls back to a different, possibly paid model.
export function resolveAiModel(preferred: string, models: AiStatus['models']): string {
  return preferred ? models.find(model => model.id === preferred)?.id || '' : models[0]?.id || '';
}
