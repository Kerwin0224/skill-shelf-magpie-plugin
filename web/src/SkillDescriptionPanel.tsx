import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Languages, LoaderCircle, RotateCw, Settings2 } from 'lucide-react';
import { request } from './api';
import ShelfButton from './ShelfButton';
import { DropdownMenu } from './ShelfMenu';
import { aiLanguages, readAiPreferences, resolveAiModel, useAiPreferences, type AiStatus } from './ai-preferences';
import { isDescriptionClearlyInTargetLanguage } from './description-language';
import { getSkillTranslation, isLikelyIncompleteTranslation } from './resolve-skill-description';
import type { AiAnnotation, AiDraft, Skill } from './types';

export type SkillDescriptionPanelProps = {
  skill: Skill;
  disabled?: boolean;
  onOpenAiSettings: () => void;
  onSaved?: (annotation: AiAnnotation) => void;
};

function DescriptionText({ text, empty }: { text: string; empty: boolean }) {
  const id = useId();
  const textRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element) return;
    const measure = () => setOverflows(element.scrollHeight > parseFloat(getComputedStyle(element).lineHeight) * 4 + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);
  return <div className="skill-description-body"><p id={id} ref={textRef} className={`${expanded ? '' : 'is-collapsed'}${empty ? ' is-empty' : ''}`}>{text}</p>{overflows && <ShelfButton className="skill-description-expand" aria-controls={id} aria-expanded={expanded} size="xs" variant="ghost" onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : '展开描述'}{expanded ? <ChevronUp /> : <ChevronDown />}</ShelfButton>}</div>;
}

export default function SkillDescriptionPanel({ skill, disabled = false, onOpenAiSettings, onSaved }: SkillDescriptionPanelProps) {
  const preferences = useAiPreferences();
  const [selectedLanguage, setLanguage] = useState<string | null>(null);
  const language = selectedLanguage ?? preferences.targetLanguage;
  const languageName = aiLanguages.find(([id]) => id === language)?.[1] || language;
  const [mode, setMode] = useState<'original' | 'translation'>('translation');
  const [translations, setTranslations] = useState<AiAnnotation[]>([]);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [translating, setTranslating] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const headingId = useId();
  const generation = useRef(0);
  const operation = useRef<AbortController | null>(null);
  const lock = useRef(false);
  const originalDescription = skill.description.trim();
  const translation = getSkillTranslation(translations, skill.id, language);
  const translationIsStale = Boolean(translation && (translation.stale || isLikelyIncompleteTranslation(originalDescription, translation.text)));
  const hasTranslation = Boolean(translation && !translationIsStale && translation.text.trim() !== originalDescription);
  const showTranslation = mode === 'translation' && hasTranslation;
  const sourceMatchesTarget = isDescriptionClearlyInTargetLanguage(originalDescription, language);
  const writingModel = resolveAiModel(preferences.translationModel, status?.models || []);
  const aiAvailable = preferences.enabled && Boolean(status?.available) && Boolean(writingModel);
  const provenance = showTranslation ? '只保存在这台设备的 Skill Shelf 中' : '来自 SKILL.md 的只读原文';

  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    operation.current?.abort(); operation.current = null; lock.current = false;
    setTranslations([]); setStatus(null); setLoading(true); setTranslating(false); setError('');
    setLanguage(null); setMode('translation');
    void Promise.all([
      request<AiStatus>('/ai/status', 'GET', undefined, true, controller.signal),
      request<{ translations: AiAnnotation[] }>(`/ai/result?id=${encodeURIComponent(skill.id)}`, 'GET', undefined, true, controller.signal),
    ]).then(([available, results]) => {
      if (generation.current !== current) return;
      setStatus(available); setTranslations(results.translations || []);
      if (preferences.enabled && available.available && preferences.translationModel && !available.models.some(model => model.id === preferences.translationModel)) setError('描述与翻译模型暂不可用，请重新选择。');
    }).catch(() => { if (generation.current === current && !controller.signal.aborted) setError('无法加载翻译，请重试。'); })
      .finally(() => { if (generation.current === current) setLoading(false); });
    return () => { generation.current += 1; controller.abort(); operation.current?.abort(); };
  }, [skill.id, skill.description, revision]);

  async function translateDescription(force = false) {
    if (lock.current || disabled || !originalDescription) return;
    if (!sourceMatchesTarget && !aiAvailable) { onOpenAiSettings(); return; }
    if (!force && hasTranslation) { setMode('translation'); return; }
    const current = generation.current;
    const controller = new AbortController();
    operation.current = controller; lock.current = true;
    setTranslating(true); setError('');
    try {
      let annotation: AiAnnotation;
      if (sourceMatchesTarget) annotation = await request<AiAnnotation>('/ai/source-copy', 'POST', { skillId: skill.id, language }, true, controller.signal);
      else {
        const currentPreferences = readAiPreferences();
        if (!currentPreferences.enabled) { onOpenAiSettings(); return; }
        const available = await request<AiStatus>('/ai/status', 'GET', undefined, true, controller.signal);
        const model = resolveAiModel(currentPreferences.translationModel, available.models);
        if (!available.available || !model) throw new Error('描述与翻译模型暂不可用，请在翻译设置中重新选择。');
        const draft = await request<AiDraft>('/ai/generate', 'POST', { skillId: skill.id, kind: 'translation', model, language }, true, controller.signal);
        controller.signal.throwIfAborted();
        annotation = await request<AiAnnotation>('/ai/save', 'POST', { draftId: draft.draftId }, true, controller.signal);
      }
      if (generation.current !== current || controller.signal.aborted) return;
      setTranslations(values => [...values.filter(item => item.language !== language), annotation]);
      setMode('translation'); onSaved?.(annotation);
    } catch (caught) {
      if (generation.current === current && !controller.signal.aborted) setError(caught instanceof Error ? caught.message : '翻译失败，请重试。');
    } finally {
      if (generation.current === current && operation.current === controller) { operation.current = null; lock.current = false; setTranslating(false); }
    }
  }

  return <section aria-labelledby={headingId} className="skill-description-card" data-testid="skill-description-panel">
    <header className="skill-description-toolbar"><div className="skill-description-heading"><h3 id={headingId}>描述</h3><span className="skill-description-source" title={provenance}>{showTranslation ? `${languageName} · AI` : '原文'}</span></div>
      {originalDescription && <div className="skill-description-actions">
        {translating ? <ShelfButton disabled size="xs" variant="ghost"><LoaderCircle className="spin" />正在翻译…</ShelfButton> : hasTranslation ? <ShelfButton size="xs" variant="ghost" onClick={() => setMode(showTranslation ? 'original' : 'translation')}>{showTranslation ? '查看原文' : '查看译文'}</ShelfButton> : !sourceMatchesTarget ? <ShelfButton size="xs" variant="ghost" disabled={loading || disabled} onClick={() => void translateDescription()}><Languages />{aiAvailable ? `翻译为${languageName}` : '设置翻译'}</ShelfButton> : null}
        <DropdownMenu.Root modal={false}><DropdownMenu.Trigger asChild><ShelfButton size="xs" variant="ghost" aria-label="翻译选项" className={`skill-description-options${sourceMatchesTarget && !hasTranslation ? ' has-language' : ''}`} disabled={loading || disabled || translating}>{sourceMatchesTarget && !hasTranslation ? languageName : null}<ChevronDown /></ShelfButton></DropdownMenu.Trigger><DropdownMenu.Content align="end" className="skill-translation-menu"><DropdownMenu.Label>翻译目标语言</DropdownMenu.Label><DropdownMenu.RadioGroup value={language} onValueChange={value => { setLanguage(value); setMode('translation'); setError(''); }}>{aiLanguages.map(([id, label]) => <DropdownMenu.RadioItem key={id} value={id}>{label}</DropdownMenu.RadioItem>)}</DropdownMenu.RadioGroup><DropdownMenu.Separator />{(translation || sourceMatchesTarget) && <DropdownMenu.Item disabled={disabled || (!aiAvailable && !sourceMatchesTarget)} onSelect={() => void translateDescription(true)}><RotateCw />{sourceMatchesTarget ? '保存本地副本' : '重新翻译'}</DropdownMenu.Item>}<DropdownMenu.Item onSelect={onOpenAiSettings}><Settings2 />翻译设置</DropdownMenu.Item><p className="skill-translation-menu-note">{provenance}</p></DropdownMenu.Content></DropdownMenu.Root>
      </div>}
    </header>
    <DescriptionText key={`${skill.id}:${language}:${showTranslation ? 'translation' : 'original'}`} empty={!originalDescription} text={showTranslation ? translation!.text : originalDescription || '这个 Skill 没有声明描述。'} />
    {translationIsStale && !translating && <p className="skill-translation-stale" role="status">已保存的译文需要更新，可重新翻译。</p>}
    {error && <div className="skill-description-error" role="alert"><span>{error}</span><ShelfButton size="xs" variant="ghost" onClick={onOpenAiSettings}>翻译设置</ShelfButton><ShelfButton size="xs" variant="ghost" disabled={translating} onClick={() => loading || !status ? setRevision(value => value + 1) : void translateDescription(true)}>重试</ShelfButton></div>}
  </section>;
}
