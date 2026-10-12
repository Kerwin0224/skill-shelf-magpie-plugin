import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { ArrowDownToLine, ArrowUpRight, BookOpen, Boxes, ChevronDown, ChevronUp, CircleHelp, Copy, FolderOpen, HardDrive, Link2, LoaderCircle, RefreshCw, Tag, Trash2, Users, X } from 'lucide-react';
import ShelfButton from './ShelfButton';
import ShelfSelect from './ShelfSelect';
import { Input } from './ShelfForm';
import SkillDescriptionPanel from './SkillDescriptionPanel';
import type { AiAnnotation, ManagedSkill, Skill, Snapshot } from './types';
import './skill-inspector.css';

export type SkillInspectorProps = {
  skill: Skill | ManagedSkill;
  state: Snapshot;
  busy: boolean;
  focusedAgents?: string[];
  descriptions?: Record<string, AiAnnotation>;
  onClose: () => void;
  onOpenAiSettings: () => void;
  onSaved?: (annotation: AiAnnotation) => void;
  onTags: (tags: string[]) => Promise<boolean>;
  onFolder: (folderId: string | null) => Promise<boolean>;
  onDeploy: () => void;
  onOpenFolder: () => void;
  onRemoveDeployment: (id: string) => void;
  onInstallation: (skill: Skill) => void;
  renderFiles: (skillId: string) => ReactNode;
  updateAction?: { label: string; disabled: boolean; running?: boolean; onClick: () => void };
  onRemove?: () => void;
  onOpenSource?: () => void;
};
const readWidth = () => {
  try { const value = JSON.parse(localStorage.getItem('shelf-inspector-width') || '680'); return typeof value === 'number' && Number.isFinite(value) ? value : 680; }
  catch { return 680; }
};
function Section({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return <section className="inspector-section"><h3>{icon}{title}</h3>{children}</section>;
}

export default function SkillInspector({ skill, state, busy, focusedAgents = [], onClose, onOpenAiSettings, onSaved, onTags, onFolder, onDeploy, onOpenFolder, onRemoveDeployment, onInstallation, renderFiles, updateAction, onRemove, onOpenSource }: SkillInspectorProps) {
  const [tab, setTab] = useState<'info' | 'files'>('info');
  const [tagDraft, setTagDraft] = useState('');
  const [showAllAgents, setShowAllAgents] = useState(false);
  const [width, setWidth] = useState(readWidth);
  const panelRef = useRef<HTMLElement>(null);
  const tagLock = useRef(false);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const cleanupRef = useRef<(() => void) | null>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const instanceId = useId();
  const metadata = state.organization[skill.id] || { folderId: null, tags: [] };
  const managed = 'packId' in skill ? state.managedSkills.find(item => item.id === skill.id) || skill : null;
  const family = !managed ? state.skills.find(item => item.id === skill.id || item.installations?.some(installation => installation.id === skill.id)) : undefined;
  const bounds = () => {
    const maximum = Math.min(960, Math.max(0, (panelRef.current?.parentElement?.clientWidth || window.innerWidth) - 20));
    return { min: Math.min(480, maximum), max: maximum };
  };
  const clamp = (value: number) => { const { min, max } = bounds(); return Math.round(Math.min(max, Math.max(min, value))); };
  const saveWidth = (value: number) => {
    const next = clamp(value); setWidth(next);
    try { localStorage.setItem('shelf-inspector-width', JSON.stringify(next)); } catch { /* Resizing still works without storage. */ }
  };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('[aria-modal="true"]')) { event.preventDefault(); closeRef.current(); } };
    document.addEventListener('keydown', escape);
    const syncWidth = () => setWidth(current => clamp(current));
    syncWidth();
    const container = panelRef.current?.parentElement;
    const observer = container ? new ResizeObserver(syncWidth) : null;
    if (container) observer?.observe(container);
    window.addEventListener('resize', syncWidth);
    return () => {
      document.removeEventListener('keydown', escape); window.removeEventListener('resize', syncWidth); observer?.disconnect(); cleanupRef.current?.();
      if (document.activeElement === document.body) previous?.focus();
    };
  }, []);
  useEffect(() => { setTagDraft(''); setTab('info'); setShowAllAgents(false); }, [skill.id]);
  const resize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !panelRef.current) return;
    event.preventDefault(); cleanupRef.current?.();
    const panel = panelRef.current, startX = event.clientX, startWidth = panel.getBoundingClientRect().width;
    const cursor = document.body.style.cursor, userSelect = document.body.style.userSelect;
    let latest = startWidth;
    panel.dataset.resizing = 'true'; document.body.style.cursor = 'ew-resize'; document.body.style.userSelect = 'none';
    const move = (event: globalThis.PointerEvent) => { latest = clamp(startWidth + startX - event.clientX); panel.style.width = `${latest}px`; };
    const cleanup = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish);
      delete panel.dataset.resizing; document.body.style.cursor = cursor; document.body.style.userSelect = userSelect; cleanupRef.current = null;
    };
    const finish = () => { cleanup(); saveWidth(latest); };
    cleanupRef.current = cleanup;
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', finish, { once: true }); window.addEventListener('pointercancel', finish, { once: true });
  };
  const saveTag = async () => {
    const tag = tagDraft.trim();
    if (!tag || busy || tagLock.current || metadata.tags.includes(tag)) return;
    tagLock.current = true;
    try { if (await onTags([...metadata.tags, tag])) setTagDraft(''); } finally { tagLock.current = false; }
  };
  const tabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
      setTab(next === 0 ? 'info' : 'files'); tabRefs.current[next]?.focus();
    }
  };
  const focused = new Set(focusedAgents);
  const prioritized = [...skill.agents].sort((left, right) => Number(focused.has(right)) - Number(focused.has(left)) || left.localeCompare(right));
  const focusedInstalled = prioritized.filter(agent => focused.has(agent));
  const collapsed = [...focusedInstalled, ...prioritized.filter(agent => !focused.has(agent)).slice(0, Math.max(0, 4 - focusedInstalled.length))];
  const hiddenAgents = prioritized.filter(agent => !collapsed.includes(agent));
  const visibleAgents = showAllAgents ? prioritized : collapsed;
  const limits = bounds();

  return <aside ref={panelRef} role="dialog" aria-modal="false" aria-label={skill.name} tabIndex={-1} data-slot="sheet-content" className="skill-inspector skill-sheet-content" style={{ width }}>
    <div role="separator" aria-label="调整 Skill 详情宽度" aria-orientation="vertical" aria-valuemin={limits.min} aria-valuemax={limits.max} aria-valuenow={width} tabIndex={0} className="skill-drawer-resize-handle" onPointerDown={resize} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); saveWidth(event.key === 'Home' ? limits.min : event.key === 'End' ? limits.max : width + (event.key === 'ArrowLeft' ? 24 : -24));
    }}><span aria-hidden="true" /></div>
    <div className="inspector-header"><div className="inspector-kicker"><span>{managed ? <Boxes /> : <BookOpen />}</span>{managed ? 'Pack Skill' : '已安装的 Skill'}</div><h2 data-slot="sheet-title">{skill.name}</h2><p className="sr-only" data-slot="sheet-description">{skill.description || '这个 Skill 没有声明描述。'}</p><div className="inspector-actions"><ShelfButton size="sm" variant="outline" onClick={onOpenFolder}><FolderOpen />打开文件夹</ShelfButton>{onOpenSource && <ShelfButton size="sm" variant="ghost" onClick={onOpenSource}><ArrowUpRight />来源</ShelfButton>}{managed && <ShelfButton size="sm" variant="ghost" onClick={onDeploy}><ArrowDownToLine />添加 Skill</ShelfButton>}</div></div>
    <div className="skill-detail-tabs"><div className="skill-detail-tab-bar"><div className="skill-detail-tab-list" role="tablist" aria-label="Skill 详情">{(['info', 'files'] as const).map((value, index) => <button key={value} ref={element => { tabRefs.current[index] = element; }} role="tab" data-slot="tabs-trigger" id={`${instanceId}-${value}-tab`} aria-controls={`${instanceId}-${value}-panel`} aria-selected={tab === value} data-state={tab === value ? 'active' : 'inactive'} tabIndex={tab === value ? 0 : -1} onKeyDown={event => tabKey(event, index)} onClick={() => setTab(value)}>{value === 'info' ? '信息' : '文件'}</button>)}</div></div>
      {tab === 'files' ? <div className="skill-files-tab" data-slot="tabs-content" role="tabpanel" id={`${instanceId}-files-panel`} aria-labelledby={`${instanceId}-files-tab`}>{renderFiles(skill.id)}</div> : <div className="inspector-scroll" data-slot="tabs-content" role="tabpanel" id={`${instanceId}-info-panel`} aria-labelledby={`${instanceId}-info-tab`}>
        <SkillDescriptionPanel key={skill.id} skill={skill} disabled={busy} onOpenAiSettings={onOpenAiSettings} onSaved={onSaved} />
        <Section title="文件夹" icon={<Boxes />}><ShelfSelect aria-label="文件夹" value={metadata.folderId || ''} disabled={busy} onValueChange={value => void onFolder(value || null)} options={[{ value: '', label: '未整理' }, ...state.folders.filter(folder => folder.scopeId === skill.scopeId).map(folder => ({ value: folder.id, label: folder.name }))]} /></Section>
        <Section title="标签" icon={<Tag />}><div className="tag-editor">{metadata.tags.map(tag => <span data-slot="badge" className="inspector-badge is-secondary" key={tag}>{tag}<button type="button" aria-label={`移除标签 ${tag}`} disabled={busy} onClick={() => void onTags(metadata.tags.filter(value => value !== tag))}><X /></button></span>)}<Input aria-label="添加标签" maxLength={32} value={tagDraft} placeholder={metadata.tags.length ? '再添加一个标签' : '添加标签'} disabled={busy} onChange={event => setTagDraft(event.target.value)} onBlur={() => void saveTag()} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void saveTag(); } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setTagDraft(''); } }} /></div></Section>
        {!!family?.installations && family.installations.length > 1 && <Section title="安装位置" icon={<HardDrive />}><ShelfSelect aria-label="查看 Skill 安装位置" value={skill.id} disabled={busy} options={family.installations.map(installation => ({ value: installation.id, label: `${installation.sourceLabel === 'Universal' ? '共享目录' : installation.sourceLabel}${installation.isCanonical ? ' · 主来源' : ''}${installation.documentMatchesCanonical ? '' : ' · 文档不同'}` }))} onValueChange={id => { const installation = family.installations!.find(item => item.id === id); if (installation) onInstallation({ ...installation, installations: family.installations }); }} /></Section>}
        {!managed && <Section title={`已安装到 · ${skill.agents.length} 个兼容 Agent`} icon={<Users />}><div className="agent-detail-list">{visibleAgents.map(agent => <span data-slot="badge" className={`inspector-badge agent-detail-badge${focused.has(agent) ? ' is-focused' : ''}`} key={agent}><i />{agent}</span>)}{hiddenAgents.length > 0 && <button data-slot="badge" className="inspector-badge agent-detail-more" title={hiddenAgents.join(' · ')} aria-expanded={showAllAgents} onClick={() => setShowAllAgents(value => !value)}>{showAllAgents ? '收起' : `+${hiddenAgents.length}`}{showAllAgents ? <ChevronUp /> : <ChevronDown />}</button>}</div></Section>}
        <div className="path-block"><div className="path-block-heading"><span>本地路径</span><span data-kind={skill.installKind || 'unknown'}>{skill.installKind === 'symlink' ? <Link2 /> : skill.installKind === 'directory' ? <FolderOpen /> : <CircleHelp />}{skill.installKind === 'symlink' ? '软链接' : skill.installKind === 'directory' ? '实际目录' : '目录类型未知'}</span></div><code className="inspector-path">{skill.path}</code>{skill.installKind === 'symlink' && skill.linkTarget && <div className="path-block-target"><span>软链接目标</span><code>{skill.linkTarget}</code></div>}</div>
        {managed && <><Section title="所属 Pack" icon={<Boxes />}><span data-slot="badge" className="inspector-badge is-secondary">{state.packs.find(pack => pack.id === managed.packId)?.name || managed.packId}</span></Section><section className="inspector-section deployments-section"><h3><Link2 />部署记录 <span>{managed.deployments.length}</span></h3>{managed.deployments.map(deployment => <div className="deployment-row" key={deployment.id}>{deployment.mode === 'copy' ? <Copy size={14} /> : <Link2 size={14} />}<div><strong>{deployment.mode === 'copy' ? '文件复制' : '软链接'}</strong><code>{deployment.targetPath}</code></div><ShelfButton size="icon-sm" variant="ghost" aria-label="移除部署" disabled={busy} onClick={() => onRemoveDeployment(deployment.id)}><Trash2 /></ShelfButton></div>)}{managed.deployments.length === 0 && <p>尚未添加到其他位置</p>}</section><Section title="最初导入来源" icon={<HardDrive />}><code className="inspector-path">{managed.sourcePath}</code></Section></>}
      </div>}
    </div>
    {!managed && (updateAction || onRemove) && <div className="inspector-footer">{updateAction && <ShelfButton size="sm" aria-busy={Boolean(updateAction.running)} disabled={updateAction.disabled} onClick={updateAction.onClick}>{updateAction.running ? <LoaderCircle className="spin" /> : <RefreshCw />}{updateAction.label}</ShelfButton>}{onRemove && <ShelfButton size="sm" variant="ghost" onClick={onRemove}><Trash2 />移除</ShelfButton>}</div>}
    <ShelfButton size="icon-sm" variant="ghost" className="inspector-close" aria-label="关闭" onClick={onClose}><X /></ShelfButton>
  </aside>;
}
