import { useCallback, useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import { ArrowUpRight, ChevronDown, CircleAlert, Eye, FolderOpen, HardDrive, Link2, RefreshCw, Search, Terminal, Users, X } from 'lucide-react';
import { request } from './api';
import { Input } from './ShelfForm';
import type { Snapshot } from './types';
import type { AgentCoverageEntry, DirectoryStatus, WorkbenchSnapshot } from './workbench-types';
import './shelf-workbench.css';

// Labels and view structure are transplanted from Skill Shelf's desktop workbench.
import { number, t, useI18n } from './desktop-ui';
import { AgentAccessWorkspace } from './AgentAccessWorkspace';
import './agent-access.css';
const cn = (...values: Array<string | false | undefined>) => values.filter(Boolean).join(' ');
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function Button({ size = 'sm', variant = 'outline', className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  size?: 'xs' | 'sm'; variant?: 'outline' | 'ghost';
}) {
  return <button type="button" className={cn('workbench-button', `is-${variant}`, `size-${size}`, className)} data-slot="button" {...props} />;
}

function SearchField({ className, label, onChange, onClear, value }: {
  className: string; label: string; onChange: (value: string) => void; onClear: () => void; value: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  function clear() { onClear(); input.current?.focus(); }
  return <div className={`search-control-field ${className}`} data-search-active={Boolean(value)}>
    <Search aria-hidden="true" />
    <Input aria-label={label} placeholder={label} ref={input} type="search" value={value}
      onChange={event => event.target.value === '' ? onClear() : onChange(event.target.value)}
      onKeyDown={event => { if (event.key === 'Escape' && value) { event.preventDefault(); event.stopPropagation(); clear(); } }} />
    {value ? <button type="button" aria-label={t('common.clearSearch')} title={t('common.clearSearch')} onClick={clear}><X aria-hidden="true" /></button> : null}
  </div>;
}

function directoryNote(status: DirectoryStatus | undefined, exists: boolean, shared = false) {
  if (status === 'inaccessible') return '无法访问此目录；请检查目录或父目录的访问权限。';
  if (status === 'broken') return '目录链接的目标不存在；请检查并恢复链接目标。';
  if (!exists || status === 'missing') return t(shared ? 'desktop.workbench.inventory.noSharedDirectory' : 'desktop.workbench.agents.noDirectory');
  return null;
}

export default function Workbench({ state, focusedAgents, onManageAgents, onRefresh, busy, onError, onApplyingChange }: {
  state: Snapshot;
  focusedAgents: string[];
  onManageAgents: () => void;
  onRefresh: () => Promise<void>;
  busy: boolean;
  onError: (message: string) => void;
  onApplyingChange: (applying: boolean) => void;
}) {
  const [accessAgentId, setAccessAgentId] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const entryFocus = useRef<HTMLElement | null>(null);
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const refreshGuard = useRef(false);
  const mounted = useRef(true);
  const errorCallback = useRef(onError);
  errorCallback.current = onError;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; };
  }, []);
  const loadWorkbench = useCallback(async (signal?: AbortSignal) => {
    if (!mounted.current) return;
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const result = await request<WorkbenchSnapshot>('/workbench', 'GET', undefined, true, signal);
      if (current === generation.current && !signal?.aborted) setSnapshot(result);
    } catch (caught) {
      if (current === generation.current && !signal?.aborted) setError(errorMessage(caught));
    } finally {
      if (current === generation.current && !signal?.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    // Explicit refresh already reloads after the catalog scan, so do not scan twice.
    if (refreshGuard.current) return;
    const controller = new AbortController();
    void loadWorkbench(controller.signal);
    return () => controller.abort();
  }, [loadWorkbench, state.scannedAt]);

  async function refresh() {
    if (refreshGuard.current || busy || loading) return;
    refreshGuard.current = true;
    setRefreshing(true);
    setError(null);
    try { await onRefresh(); await loadWorkbench(); }
    catch (caught) { if (mounted.current) setError(errorMessage(caught)); }
    finally { if (mounted.current) setRefreshing(false); refreshGuard.current = false; }
  }
  async function openDirectory(id: string) {
    try { await request('/workbench/open-directory', 'POST', { id }); }
    catch (caught) { errorCallback.current(errorMessage(caught)); }
  }
  const scanning = loading || refreshing || busy || applying;
  const scannedTime = snapshot ? new Date(snapshot.scannedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '';
  return <section className="workbench-workspace" aria-label={t('desktop.workbench.title')} aria-busy={scanning}>
    <header className="workbench-page-header" data-slot="page-header" hidden={Boolean(accessAgentId)}>
      <div data-slot="page-header-heading">
        <p data-slot="page-header-eyebrow">{t('desktop.workbench.eyebrow')}</p>
        <h1>{t('desktop.workbench.title')}</h1>
        <p data-slot="page-header-description">{t('desktop.workbench.description')}</p>
      </div>
      <div data-slot="page-header-actions"><Button disabled={scanning} onClick={() => void refresh()}>
        <RefreshCw className={scanning ? 'animate-spin' : undefined} />
        {t(scanning ? 'desktop.workbench.scanning' : 'desktop.workbench.refresh')}
      </Button></div>
      <div data-slot="page-header-content">
        {snapshot ? <div className="workbench-scan-meta"><span className="status-dot" />{t('desktop.workbench.lastScanned', { time: scannedTime })}<i />{t('desktop.workbench.localScan')}</div>
          : loading ? <div aria-hidden="true" className="workbench-scan-meta skeleton-scan-meta"><span className="skeleton-block" /></div> : null}
      </div>
    </header>
    {loading && !snapshot ? <WorkbenchSkeleton /> : null}
    {error ? <div className={cn('workbench-error', Boolean(snapshot) && 'with-snapshot')} role="alert">
      <CircleAlert /><strong>{t('desktop.workbench.errorTitle')}</strong><p>{error}</p>
      {snapshot ? <small>当前显示上次成功扫描的结果。</small> : null}
      <Button disabled={scanning} onClick={() => void loadWorkbench()}>{t('common.tryAgain')}</Button>
    </div> : null}
    {snapshot ? <div hidden={Boolean(accessAgentId)} className={cn('workbench-board', scanning && 'is-refreshing')}>
      {snapshot.scanWarnings?.length ? <details className="workbench-scan-warnings">
        <summary><CircleAlert />扫描有 {number(snapshot.scanWarnings.length)} 项提示</summary>
        <p>部分目录可能无法完整读取，以下统计仅包含本次可读取的结果。</p>
        <ul>{snapshot.scanWarnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
      </details> : null}
      <WorkbenchOverview snapshot={snapshot} onOpenDirectory={openDirectory} />
      <AgentCoverageCard focusedAgents={focusedAgents} onManageAgents={onManageAgents} snapshot={snapshot} onOpenAccess={id => {
        entryFocus.current = document.activeElement as HTMLElement;
        setAccessAgentId(id);
      }} />
      <WorkbenchFileChecks snapshot={snapshot} onOpenDirectory={openDirectory} />
    </div> : null}
    {snapshot && accessAgentId ? <AgentAccessWorkspace snapshot={snapshot} focusedAgents={focusedAgents} initialAgentId={accessAgentId}
      onApplyingChange={value => { setApplying(value); onApplyingChange(value); }}
      onBack={() => { setAccessAgentId(null); requestAnimationFrame(() => entryFocus.current?.focus()); }}
      onChanged={async () => { await onRefresh(); await loadWorkbench(); }} onOpenDirectory={id => void openDirectory(id)} /> : null}
  </section>;
}

export function WorkbenchOverview({
  snapshot,
  onOpenDirectory,
}: {
  snapshot: WorkbenchSnapshot
  onOpenDirectory: (id: string) => void
}) {
  const { number, t } = useI18n()
  const exclusiveNames = [
    ...new Set(
      snapshot.agentCoverage.flatMap((agent) => agent.exclusiveSkillNames)
    ),
  ]
  return (
    <section className="workbench-inventory">
      <header>
        <HardDrive />
        <h2>{t('desktop.workbench.inventory.title')}</h2>
        <span>
          {t('desktop.workbench.inventory.total', {
            count: number(snapshot.stats.totalSkills),
          })}
        </span>
      </header>
      <div className="workbench-inventory-locations">
        <div className="workbench-shared-location">
          <div className="workbench-location-heading">
            <h3>{t('desktop.workbench.inventory.shared')}</h3>
            <strong>
              {number(snapshot.stats.sharedSkills)}
              <small>Skills</small>
            </strong>
          </div>
          <div className="workbench-directory-path">
            <code>{snapshot.sharedDirectory.path}</code>
            <Button
              disabled={!snapshot.sharedDirectory.exists}
              onClick={() => onOpenDirectory('shared')}
              size="xs"
              variant="outline"
            >
              <FolderOpen />
              {t('desktop.workbench.openDirectory')}
            </Button>
          </div>
          <p>{t('desktop.workbench.inventory.sharedDescription')}</p>
          {directoryNote(snapshot.sharedDirectory.status, snapshot.sharedDirectory.exists, true) ? (
            <small>{directoryNote(snapshot.sharedDirectory.status, snapshot.sharedDirectory.exists, true)}</small>
          ) : null}
        </div>
        <div>
          <div className="workbench-location-heading">
            <h3>{t('desktop.workbench.inventory.exclusive')}</h3>
            <strong>
              {number(snapshot.stats.exclusiveSkills)}
              <small>Skills</small>
            </strong>
          </div>
          <p>{t('desktop.workbench.inventory.exclusiveDescription')}</p>
          <div className="workbench-exclusive-preview">
            {exclusiveNames.slice(0, 3).map((name) => (
              <span key={name}>{name}</span>
            ))}
            {exclusiveNames.length > 3 ? (
              <span>+{number(exclusiveNames.length - 3)}</span>
            ) : null}
          </div>
          <small>{t('desktop.workbench.inventory.counting')}</small>
        </div>
      </div>
    </section>
  )
}

export function WorkbenchFileChecks({
  snapshot,
  onOpenDirectory,
}: {
  snapshot: WorkbenchSnapshot
  onOpenDirectory: (id: string) => void
}) {
  const { number, t } = useI18n()
  const files = snapshot.symlinkHealth
  return (
    <details className="workbench-file-checks">
      <summary>
        <Link2 />
        <strong>{t('desktop.workbench.files.title')}</strong>
        <span>
          {files.issues.length
            ? t('desktop.workbench.files.issueCount', {
                count: number(files.issues.length),
              })
            : t('desktop.workbench.files.clear')}
        </span>
        <ChevronDown />
      </summary>
      <div className="workbench-file-checks-body">
        <p>{t('desktop.workbench.files.method')}</p>
        <div className="workbench-file-counts">
          <span>
            {t('desktop.workbench.files.valid', { count: number(files.valid) })}
          </span>
          <span>
            {t('desktop.workbench.files.broken', {
              count: number(files.broken),
            })}
          </span>
          <span>
            {t('desktop.workbench.files.unreadable', {
              count: number(files.inaccessible),
            })}
          </span>
          <span>
            {t('desktop.workbench.files.missing', {
              count: number(files.missingDocuments),
            })}
          </span>
        </div>
        {files.issues.length ? (
          <ul className="workbench-file-issues">
            {files.issues.map((issue) => {
              const agentId =
                snapshot.agentCoverage.find((agent) =>
                  issue.agentNames.includes(agent.name)
                )?.id ?? 'shared'
              return (
                <li key={`${issue.path}:${issue.status}`}>
                  <div>
                    <strong>{issue.skillName}</strong>
                    <span>
                      {t(`desktop.workbench.files.status.${issue.status}`)}
                    </span>
                    <small>
                      {issue.agentNames.join(', ') ||
                        t('desktop.workbench.inventory.shared')}
                    </small>
                    <code>{issue.path}</code>
                    <p>{t(`desktop.workbench.files.fix.${issue.status}`)}</p>
                  </div>
                  <Button
                    onClick={() => onOpenDirectory(agentId)}
                    size="xs"
                    variant="outline"
                  >
                    <FolderOpen />
                    {t('desktop.workbench.openDirectory')}
                  </Button>
                </li>
              )
            })}
          </ul>
        ) : null}
      </div>
    </details>
  )
}

type AgentFilter = 'all' | 'found' | 'not-found' | 'unverified' | 'focused'
type SkillTab = 'missing' | 'exclusive' | 'local'

export function AgentCoverageCard({
  focusedAgents,
  onManageAgents,
  onOpenAccess,
  snapshot,
}: {
  focusedAgents: string[]
  onManageAgents: () => void
  onOpenAccess: (id: string) => void
  snapshot: WorkbenchSnapshot
}) {
  const { number, t } = useI18n()
  const [filter, setFilter] = useState<AgentFilter>('all')
  const [query, setQuery] = useState('')
  const [showAll, setShowAll] = useState(false)
  const focused = useMemo(() => new Set(focusedAgents), [focusedAgents])
  const agents = useMemo(
    () =>
      [...snapshot.agentCoverage].sort(
        (left, right) =>
          Number(focused.has(right.name)) - Number(focused.has(left.name)) ||
          Number(right.program.status === 'found') -
            Number(left.program.status === 'found') ||
          left.name.localeCompare(right.name)
      ),
    [snapshot.agentCoverage, focused]
  )
  const visibleAgents = agents.filter(
    (agent) =>
      (filter === 'all' ||
        (filter === 'focused'
          ? focused.has(agent.name)
          : agent.program.status === filter)) &&
      `${agent.name} ${agent.path}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase())
  )
  const absentFocused = focusedAgents.filter(
    (name) => !agents.some((agent) => agent.name === name)
  )
  const filters: AgentFilter[] = [
    'all',
    'found',
    'not-found',
    'unverified',
    'focused',
  ]
  const counts: Record<AgentFilter, number> = {
    all: agents.length,
    found: agents.filter((agent) => agent.program.status === 'found').length,
    'not-found': agents.filter((agent) => agent.program.status === 'not-found')
      .length,
    unverified: agents.filter((agent) => agent.program.status === 'unverified')
      .length,
    focused: agents.filter((agent) => focused.has(agent.name)).length,
  }
  return (
    <section className="workbench-agent-panel">
      <header className="workbench-section-heading">
        <Users />
        <div>
          <h2>{t('desktop.workbench.agents.title')}</h2>
          <p>{t('desktop.workbench.agents.description')}</p>
        </div>
        <Button onClick={onManageAgents} size="sm" variant="ghost">
          <Eye />
          {t('desktop.workbench.coverage.manage')}
        </Button>
      </header>
      <div className="workbench-agent-toolbar">
        <div
          className="workbench-agent-filters"
          aria-label={t('desktop.workbench.agents.filters')}
        >
          {filters.map((item) => (
            <button
              aria-pressed={filter === item}
              key={item}
              onClick={() => {
                setFilter(item)
                setShowAll(false)
              }}
              type="button"
            >
              {t(`desktop.workbench.agents.filter.${item}`)}
              <span>{number(counts[item])}</span>
            </button>
          ))}
        </div>
        <SearchField
          className="workbench-agent-search"
          label={t('desktop.workbench.agents.search')}
          onChange={(value) => {
            setQuery(value)
            setShowAll(false)
          }}
          onClear={() => {
            setQuery('')
            setShowAll(false)
          }}
          value={query}
        />
      </div>
      {absentFocused.length && (filter === 'all' || filter === 'focused') ? (
        <p className="workbench-agent-absent">
          {t('desktop.workbench.agents.absent', {
            names: absentFocused.join(', '),
          })}
        </p>
      ) : null}
      <div className="workbench-agent-columns" aria-hidden="true">
        <span>Agent</span>
        <span>{t('desktop.workbench.agents.program')}</span>
        <span>{t('desktop.workbench.agents.shared')}</span>
        <span />
      </div>
      <div className="workbench-agent-list">
        {(showAll ? visibleAgents : visibleAgents.slice(0, 6)).map((agent) => {
          const missing = agent.missingSkillNames.length
          return (
            <div className="workbench-agent" key={agent.id}>
              <button
                className="workbench-agent-row"
                onClick={() => onOpenAccess(agent.id)}
                type="button"
              >
                <span className="workbench-agent-name">
                  <strong>
                    {focused.has(agent.name) ? <Eye /> : null}
                    {agent.name}
                  </strong>
                  <small>
                    {agent.readsSharedDirectory
                      ? t('desktop.workbench.agents.directRead')
                      : t('desktop.workbench.agents.localRead')}
                  </small>
                </span>
                <span>
                  <span
                    className={`workbench-program-status is-${agent.program.status}`}
                  >
                    <i />
                    {t(
                      `desktop.workbench.agents.status.${agent.program.status}`
                    )}
                  </span>
                </span>
                <span className="workbench-agent-coverage">
                  <strong>
                    {snapshot.stats.sharedSkills
                      ? `${number(agent.availableSkills)} / ${number(snapshot.stats.sharedSkills)}`
                      : '—'}
                  </strong>
                  <small>
                    {snapshot.stats.sharedSkills
                      ? missing
                        ? t('desktop.workbench.agents.missingCount', {
                            count: number(missing),
                          })
                        : t('desktop.workbench.agents.complete')
                      : t('desktop.workbench.coverage.noSharedSkills')}
                  </small>
                  {agent.exclusiveSkills > 0 ? (
                    <small title={t('desktop.workbench.agents.exclusive')}>
                      {t('desktop.workbench.agents.additionalLocal', {
                        count: number(agent.exclusiveSkills),
                      })}
                    </small>
                  ) : null}
                </span>
                <span className="workbench-agent-manage">
                  {t('desktop.agentAccess.workspace.manage')}
                  <ArrowUpRight />
                </span>
              </button>
            </div>
          )
        })}
        {!visibleAgents.length ? (
          <div className="workbench-agent-empty">
            {t('desktop.workbench.agents.empty')}
          </div>
        ) : null}
      </div>
      {visibleAgents.length > 6 ? (
        <button
          className="workbench-agents-more"
          onClick={() => setShowAll((value) => !value)}
          type="button"
        >
          {showAll
            ? t('desktop.workbench.agents.showLess')
            : t('desktop.workbench.agents.showMore', {
                count: number(visibleAgents.length - 6),
              })}
        </button>
      ) : null}
      <footer className="workbench-agent-footnote">
        {t('desktop.workbench.agents.limit')}
        <details className="workbench-search-scope">
          <summary>{t('desktop.workbench.programSearch.title')}</summary>
          <p>
            {t(
              `desktop.workbench.programSearch.${snapshot.programSearch.source}`
            )}
          </p>
          <code>{snapshot.programSearch.paths.join('\n')}</code>
        </details>
      </footer>
    </section>
  )
}


function Block({
  width = '100%',
  height = 10,
  className = '',
}: {
  width?: CSSProperties['width']
  height?: number
  className?: string
}) {
  return (
    <span className={`skeleton-block ${className}`} style={{ width, height }} />
  )
}

function LoadingLayout({
  children,
  className,
  label,
}: {
  children: ReactNode
  className: string
  label: string
}) {
  return (
    <div aria-label={label} className={className} role="status">
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="skeleton-layout">
        {children}
      </div>
    </div>
  )
}

function Copy({ wide = false }: { wide?: boolean }) {
  return (
    <div className="skeleton-copy">
      <Block width={wide ? '72%' : '54%'} />
      <Block height={8} width={wide ? '92%' : '78%'} />
    </div>
  )
}

export function WorkbenchSkeleton() {
  const { t } = useI18n()
  return (
    <LoadingLayout
      className="workbench-board workbench-skeleton"
      label={t('desktop.workbench.scanning')}
    >
      <div className="workbench-inventory">
        <header>
          <Block height={18} width={18} />
          <Block width={120} height={13} />
          <Block width={62} />
        </header>
        <div className="workbench-inventory-locations">
          {[0, 1].map((index) => (
            <div
              className={index === 0 ? 'workbench-shared-location' : ''}
              key={index}
            >
              <div className="workbench-location-heading">
                <Block width={96} height={12} />
                <Block width={48} height={24} />
              </div>
              <div className="skeleton-location-copy">
                <Block width="66%" />
                <Block width="96%" />
                <Block width="84%" />
                <Block width="72%" height={8} />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="workbench-agent-panel">
        <div className="workbench-section-heading">
          <Block width={18} height={18} />
          <Copy />
          <Block width={86} height={28} />
        </div>
        <div className="workbench-agent-toolbar">
          <div className="skeleton-filter-group">
            {[66, 88, 88, 76, 68].map((width, index) => (
              <Block height={28} key={index} width={width} />
            ))}
          </div>
          <div className="workbench-agent-search">
            <Block height={31} />
          </div>
        </div>
        <div className="workbench-agent-columns">
          {[64, 72, 64, 52, 12].map((width, index) => (
            <Block key={index} width={width} height={8} />
          ))}
        </div>
        {Array.from({ length: 6 }, (_, index) => (
          <div className="workbench-agent" key={index}>
            <div className="workbench-agent-row skeleton-agent-row">
              <Copy />
              <Block width={78} />
              <Copy />
              <Block width={28} />
              <Block width={12} />
            </div>
          </div>
        ))}
        <div className="skeleton-agent-footer">
          <Block width="70%" height={8} />
        </div>
      </div>
      <div className="workbench-file-checks skeleton-file-checks">
        <Block width={16} height={16} />
        <Block width="40%" />
        <Block width={12} />
      </div>
    </LoadingLayout>
  )
}

