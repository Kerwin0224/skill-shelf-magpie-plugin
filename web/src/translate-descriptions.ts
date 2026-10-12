import { request } from './api';
import { readAiPreferences, resolveAiModel, type AiStatus } from './ai-preferences';
import type { AiAnnotation, AiDraft, Snapshot } from './types';
export { AI_MODEL_KEY, AI_LANGUAGE_KEY, aiLanguages, type AiStatus } from './ai-preferences';

// The desktop's context action queues translations and saves local metadata.
// Serialize requests through the Magpie bridge; never send Skill instructions.
export async function translateDescriptions(
  ids: string[],
  onSaved: (annotation: AiAnnotation) => void | Promise<void>,
  onProgress: (text: string) => void,
) {
  const preferences = readAiPreferences();
  if (!preferences.enabled) { onProgress('AI 已停用，请在设置的 AI 行为中启用后再翻译。'); return; }
  const snapshot = await request<Snapshot>('/state');
  const selected = new Set(ids);
  const skills = snapshot.skills.filter(skill => selected.has(skill.id) && skill.description.trim());
  if (!skills.length) { onProgress('所选项目没有可翻译的 description。'); return; }
  const language = preferences.targetLanguage;
  const results = await request<{ annotations: AiAnnotation[] }>('/ai/annotations');
  const pending = skills.filter(skill => !results.annotations.some(annotation => annotation.skillId === skill.id && annotation.kind === 'translation' && annotation.language === language && !annotation.stale));
  if (!pending.length) { onProgress('所选 description 已有当前语言的翻译。'); return; }
  const status = await request<AiStatus>('/ai/status');
  if (!status.available || !status.models.length) throw new Error(status.reason || 'Magpie AI 暂不可用，请先在 Magpie 启用文本模型。');
  const model = resolveAiModel(preferences.translationModel, status.models);
  if (!model) throw new Error('已保存的描述与翻译模型未在 Magpie 中启用。请在设置的默认模型中重新选择，不会自动切换到其他模型。');
  const failures: string[] = [];
  let saved = 0;
  for (const [index, skill] of pending.entries()) {
    if (!readAiPreferences().enabled) { onProgress(`AI 已停用，翻译队列已停止；已保存 ${saved} 项。`); return; }
    onProgress(`正在翻译 ${index + 1}/${pending.length}：${skill.name}`);
    try {
      const draft = await request<AiDraft>('/ai/generate', 'POST', { skillId: skill.id, kind: 'translation', model, language });
      const annotation = await request<AiAnnotation>('/ai/save', 'POST', { draftId: draft.draftId });
      saved += 1;
      await onSaved(annotation);
    } catch (error) {
      failures.push(`${skill.name}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  onProgress(`已翻译 ${saved} 个 description，原始文件未改动。`);
  if (failures.length) throw new Error(`已保存 ${saved} 项，${failures.length} 项翻译失败；可再次右键翻译重试。\n${failures.join('\n')}`);
}
