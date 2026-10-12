import { useCallback, useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import { ChevronDown, CircleAlert, Eye, FolderOpen, HardDrive, Link2, RefreshCw, Search, Terminal, Users, X } from 'lucide-react';
import { request } from './api';
import { Input } from './ShelfForm';
import type { Snapshot } from './types';
import type { AgentCoverageEntry, DirectoryStatus, WorkbenchSnapshot } from './workbench-types';
import './shelf-workbench.css';

// Labels and view structure are transplanted from Skill Shelf's desktop workbench.
const labels: Record<string, string> = {
  'desktop.workbench.openDirectory': '打开目录',
  'desktop.workbench.inventory.title': '本机全局 Skill',
  'desktop.workbench.inventory.total': '共 {count} 个',
  'desktop.workbench.inventory.shared': '共享目录',
  'desktop.workbench.inventory.sharedDescription':
    '默认位于 ~/.agents/skills。支持共享目录的 Agent 直接读取，其他 Agent 通过链接或副本读取。',
  'desktop.workbench.inventory.exclusive': '共享目录之外',
  'desktop.workbench.inventory.exclusiveDescription':
    '存放在各 Agent 独立目录中的 Skill，不计入共享覆盖率的分母。展开 Agent 可查看名称与位置。',
  'desktop.workbench.inventory.counting':
    '按 Skill 名称去重；本页不统计项目内的 Skill。',
  'desktop.workbench.inventory.noSharedDirectory': '尚未发现共享目录。',
  'desktop.workbench.agents.showLess': '收起更多 Agent',
  'desktop.workbench.agents.showMore': '显示其余 {count} 个 Agent',
  'desktop.workbench.agents.title': 'Agent 与 Skill 分布',
  'desktop.workbench.agents.description':
    '分别查看程序是否存在，以及磁盘上为它准备了哪些 Skill。点击一行查看详情。',
  'desktop.workbench.agents.filters': '筛选 Agent',
  'desktop.workbench.agents.filter.all': '全部',
  'desktop.workbench.agents.filter.found': '找到程序',
  'desktop.workbench.agents.filter.not-found': '可能残留',
  'desktop.workbench.agents.filter.unverified': '未验证',
  'desktop.workbench.agents.filter.focused': '已关注',
  'desktop.workbench.agents.search': '搜索 Agent 或目录',
  'desktop.workbench.agents.absent': '已关注但未发现程序或目录线索：{names}',
  'desktop.workbench.agents.program': '程序检测',
  'desktop.workbench.agents.shared': '共享 Skill 覆盖',
  'desktop.workbench.agents.exclusive': '专属 Skill',
  'desktop.workbench.agents.status.found': '已找到程序',
  'desktop.workbench.agents.status.not-found': '未找到程序',
  'desktop.workbench.agents.status.unverified': '程序未验证',
  'desktop.workbench.agents.directRead': '直读共享目录',
  'desktop.workbench.agents.localRead': '通过本地链接或副本',
  'desktop.workbench.agents.complete': '共享 Skill 已全部覆盖',
  'desktop.workbench.agents.missingCount': '缺少 {count} 个共享 Skill',
  'desktop.workbench.agents.empty': '没有符合筛选条件的 Agent。',
  'desktop.workbench.agents.limit':
    '覆盖率依据目录与读取规则计算，不代表程序正在运行或 Skill 已通过执行验证。',
  'desktop.workbench.agents.programEvidence': '程序检测依据',
  'desktop.workbench.agents.evidence.command': '命令路径',
  'desktop.workbench.agents.evidence.application': '应用路径',
  'desktop.workbench.agents.explanation.found': '已找到命令或应用。',
  'desktop.workbench.agents.explanation.not-found':
    '找到了目录线索，但在本次检查的 PATH 或应用目录中未找到程序。可能已卸载，也可能安装在其他位置。',
  'desktop.workbench.agents.explanation.unverified':
    '目前仅有目录线索。尚未配置此 Agent 的程序检测规则，不能确认是否已安装。',
  'desktop.workbench.agents.checkedCommands': '已查找命令：{commands}',
  'desktop.workbench.agents.checkedApps': '已查找应用：{apps}',
  'desktop.workbench.agents.directory': 'Agent 的 Skill 目录',
  'desktop.workbench.agents.localKinds':
    '已覆盖共享 Skill：{linked} 个链接，{direct} 个副本。',
  'desktop.workbench.agents.noDirectory': '此 Skill 目录尚不存在。',
  'desktop.workbench.agents.readsShared': '同时直接读取共享目录：{path}',
  'desktop.workbench.agents.configPaths': '配置目录线索：{paths}',
  'desktop.workbench.agents.skillLists': 'Skill 明细',
  'desktop.workbench.agents.tab.missing': '缺少的共享 Skill',
  'desktop.workbench.agents.tab.exclusive': '专属 Skill',
  'desktop.workbench.agents.tab.local': '本地链接与副本',
  'desktop.workbench.agents.tabDescription.missing':
    '这些 Skill 存在于共享目录，但尚未通过此 Agent 的读取方式覆盖。',
  'desktop.workbench.agents.tabDescription.exclusive':
    '这些名称不在共享目录中，单独统计，不影响其他 Agent 的覆盖率。',
  'desktop.workbench.agents.tabDescription.local':
    '此 Agent 目录中实际可读取的 Skill，包含共享 Skill 的部署和专属 Skill。',
  'desktop.workbench.agents.tabEmpty.missing': '没有缺少的共享 Skill。',
  'desktop.workbench.agents.tabEmpty.exclusive': '没有共享目录之外的 Skill。',
  'desktop.workbench.agents.tabEmpty.local': '此目录中没有可读取的 Skill。',
  'desktop.workbench.agents.kind.symlink': '链接',
  'desktop.workbench.agents.kind.copy': '副本 / 本地目录',
  'desktop.workbench.files.title': '文件与链接检查',
  'desktop.workbench.files.clear': '未发现文件访问问题',
  'desktop.workbench.files.issueCount': '发现 {count} 项文件访问问题',
  'desktop.workbench.files.method':
    '检查链接目标和已识别 Skill 部署中的 SKILL.md；跳过其他普通目录。不执行 Skill，也不评估内容质量，同一路径仅检查一次。',
  'desktop.workbench.files.valid': '可访问的链接目标 {count}',
  'desktop.workbench.files.broken': '链接目标缺失 {count}',
  'desktop.workbench.files.unreadable': '无法读取 {count}',
  'desktop.workbench.files.missing': '缺少 SKILL.md {count}',
  'desktop.workbench.files.status.broken': '链接目标不存在',
  'desktop.workbench.files.status.inaccessible': '无法访问或读取',
  'desktop.workbench.files.status.missing-document': '缺少 SKILL.md',
  'desktop.workbench.files.fix.broken':
    '检查链接指向的位置，恢复目标文件或重新安装该 Skill。',
  'desktop.workbench.files.fix.inaccessible': '检查该目录或文件的访问权限。',
  'desktop.workbench.files.fix.missing-document':
    '该条目不是可读取的 Skill；检查目录中是否存在 SKILL.md。',
  'desktop.workbench.programSearch.title': '程序检测范围',
  'desktop.workbench.programSearch.login-shell':
    '使用登录 Shell 与应用进程的 PATH 查找可执行文件；macOS 还检查系统与用户 Applications 目录。',
  'desktop.workbench.programSearch.process':
    '使用应用进程的 PATH 查找可执行文件；未取得登录 Shell 的 PATH，安装在其他位置的程序可能未被发现。',
  'desktop.workbench.coverage.aria':
    '{name}：可用 {available}/{total} 个共享 Skill，覆盖率 {percent}%',
  'desktop.workbench.coverage.available': '共享可用 {available} / {total}',
  'desktop.workbench.coverage.description':
    '以 ~/.agents/skills 为覆盖率基准，Agent 专属 Skill 单独统计。',
  'desktop.workbench.coverage.exclusive': '另有 {count} 个专属 Skill',
  'desktop.workbench.coverage.sharedReads': '直读共享目录',
  'desktop.workbench.coverage.noSharedSkills': '暂无共享 Skill',
  'desktop.workbench.coverage.noSharedAria': '{name}：暂无共享 Skill',
  'desktop.workbench.coverage.emptyDescription':
    '为 Agent 安装 Skill 后，覆盖情况会显示在这里。',
  'desktop.workbench.coverage.emptyTitle': '尚未检测到活跃 Agent',
  'desktop.workbench.coverage.linkKinds': '{linked} 个链接 · {direct} 个副本',
  'desktop.workbench.coverage.manage': '管理关注',
  'desktop.workbench.coverage.more':
    '还有 {agents} 个 Agent，分布在 {directories} 个目录',
  'desktop.workbench.coverage.notDetected': '未检测到 {agents}{count}',
  'desktop.workbench.coverage.notDetectedDescription':
    '已关注，但尚未发现本地 Skill 目录',
  'desktop.workbench.coverage.showLess': '收起其他目录',
  'desktop.workbench.coverage.title': 'Agent 可用情况',
  'desktop.workbench.description':
    '查看共享与专属 Skill 的存放位置，核对 Agent 程序和本地目录。',
  'desktop.workbench.errorTitle': '无法扫描本地工作区',
  'desktop.workbench.eyebrow': '工作台 / 本机环境',
  'desktop.workbench.health.aria':
    '健康度 {percent}%，{valid} 个健康条目，{broken} 个失效，{inaccessible} 个需要人工检查',
  'desktop.workbench.health.broken': '已失效',
  'desktop.workbench.health.description':
    '检查已安装的 Skill 是否可以正常访问。',
  'desktop.workbench.health.direct': '本地文件夹',
  'desktop.workbench.health.manual': '人工检查',
  'desktop.workbench.health.noSymlinks': '未发现已安装的 Skill 条目',
  'desktop.workbench.health.score': '健康度',
  'desktop.workbench.health.title': 'Skill 健康状态',
  'desktop.workbench.health.valid': '健康条目',
  'desktop.workbench.issues.broken': '链接失效',
  'desktop.workbench.issues.clear': '没有发现失效或无法访问的符号链接。',
  'desktop.workbench.issues.count.one': '有 {count} 个链接需要处理。',
  'desktop.workbench.issues.count.other': '有 {count} 个链接需要处理。',
  'desktop.workbench.issues.inaccessible': '人工检查',
  'desktop.workbench.issues.none': '本次扫描未发现链接问题。',
  'desktop.workbench.issues.title': '诊断队列',
  'desktop.workbench.lastScanned': '扫描于 {time}',
  'desktop.workbench.localScan': '本机环境扫描',
  'desktop.workbench.readOnly': '只读',
  'desktop.workbench.refresh': '重新扫描',
  'desktop.workbench.scanning': '正在扫描…',
  'desktop.workbench.stats.agents': '活跃 Agent',
  'desktop.workbench.stats.agentDirectories': 'Agent 目录',
  'desktop.workbench.stats.description': '共享 Skill 与本机实际安装情况。',
  'desktop.workbench.stats.focusedAgents': '关注的 Agent',
  'desktop.workbench.stats.linked': '已关联 Skill',
  'desktop.workbench.stats.skills': '共享 Skill',
  'desktop.workbench.stats.title': 'Skill Stats',
  'desktop.workbench.title': '本地 Skill 工作台',
  'common.tryAgain': '重试',
  'common.clearSearch': '清除搜索',
};
const number = (value: number) => value.toLocaleString('zh-CN');
const t = (key: string, values: Record<string, string | number> = {}) =>
  (labels[key] ?? key).replace(/\{([^}]+)\}/g, (_, name: string) => String(values[name] ?? `{${name}}`));
const useI18n = () => ({ number, t });
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

export default function Workbench({ state, focusedAgents, onManageAgents, onRefresh, busy, onError }: {
  state: Snapshot;
  focusedAgents: string[];
  onManageAgents: () => void;
  onRefresh: () => Promise<void>;
  busy: boolean;
  onError: (message: string) => void;
}) {
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
  const scanning = loading || refreshing || busy;
  const scannedTime = snapshot ? new Date(snapshot.scannedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '';
  return <section className="workbench-workspace" aria-label={t('desktop.workbench.title')} aria-busy={scanning}>
    <header className="workbench-page-header" data-slot="page-header">
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
    {snapshot ? <div className={cn('workbench-board', scanning && 'is-refreshing')}>
      {snapshot.scanWarnings?.length ? <details className="workbench-scan-warnings">
        <summary><CircleAlert />扫描有 {number(snapshot.scanWarnings.length)} 项提示</summary>
        <p>部分目录可能无法完整读取，以下统计仅包含本次可读取的结果。</p>
        <ul>{snapshot.scanWarnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
      </details> : null}
      <WorkbenchOverview snapshot={snapshot} onOpenDirectory={openDirectory} />
      <AgentCoverageCard focusedAgents={focusedAgents} onManageAgents={onManageAgents} snapshot={snapshot} onOpenDirectory={openDirectory} />
      <WorkbenchFileChecks snapshot={snapshot} onOpenDirectory={openDirectory} />
    </div> : null}
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
  onOpenDirectory,
  snapshot,
}: {
  focusedAgents: string[]
  onManageAgents: () => void
  onOpenDirectory: (id: string) => void
  snapshot: WorkbenchSnapshot
}) {
  const { number, t } = useI18n()
  const [filter, setFilter] = useState<AgentFilter>('all')
  const [query, setQuery] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [skillTab, setSkillTab] = useState<SkillTab>('missing')
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
        <span>{t('desktop.workbench.agents.exclusive')}</span>
        <span />
      </div>
      <div className="workbench-agent-list">
        {(showAll ? visibleAgents : visibleAgents.slice(0, 6)).map((agent) => {
          const expanded = expandedId === agent.id
          const missing = agent.missingSkillNames.length
          return (
            <div
              className={cn('workbench-agent', expanded && 'is-expanded')}
              key={agent.id}
            >
              <button
                aria-controls={`agent-detail-${agent.id}`}
                aria-expanded={expanded}
                className="workbench-agent-row"
                onClick={() => {
                  setExpandedId(expanded ? null : agent.id)
                  setSkillTab(
                    missing
                      ? 'missing'
                      : agent.exclusiveSkills
                        ? 'exclusive'
                        : 'local'
                  )
                }}
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
                </span>
                <span
                  className="workbench-agent-exclusive"
                  data-label={t('desktop.workbench.agents.exclusive')}
                >
                  <span className="sr-only">
                    {t('desktop.workbench.agents.exclusive')}{' '}
                  </span>
                  {number(agent.exclusiveSkills)}
                </span>
                <ChevronDown />
              </button>
              {expanded ? (
                <AgentDetail
                  agent={agent}
                  onOpenDirectory={onOpenDirectory}
                  onSkillTabChange={setSkillTab}
                  skillTab={skillTab}
                  snapshot={snapshot}
                />
              ) : null}
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
        <p>扫描范围为已知 Agent 的全局目录与已添加的全局自定义目录；不遍历整个磁盘，不统计项目内的 Skill，不执行 Agent 命令。</p>
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

function AgentDetail({
  agent,
  onOpenDirectory,
  onSkillTabChange,
  skillTab,
  snapshot,
}: {
  agent: AgentCoverageEntry
  onOpenDirectory: (id: string) => void
  onSkillTabChange: (tab: SkillTab) => void
  skillTab: SkillTab
  snapshot: WorkbenchSnapshot
}) {
  const { number, t } = useI18n()
  const tabs: Array<{ key: SkillTab; count: number }> = [
    { key: 'missing', count: agent.missingSkillNames.length },
    { key: 'exclusive', count: agent.exclusiveSkills },
    { key: 'local', count: agent.localSkills.length },
  ]
  const names =
    skillTab === 'missing'
      ? agent.missingSkillNames
      : skillTab === 'exclusive'
        ? agent.exclusiveSkillNames
        : agent.localSkills.map((skill) => skill.name)
  const issues = snapshot.symlinkHealth.issues.filter((issue) =>
    issue.agentNames.includes(agent.name)
  )
  return (
    <div className="workbench-agent-detail" id={`agent-detail-${agent.id}`}>
      <div className="workbench-agent-evidence">
        <div>
          <h3>
            <Terminal />
            {t('desktop.workbench.agents.programEvidence')}
          </h3>
          {agent.program.evidence.length ? (
            agent.program.evidence.map((evidence) => (
              <div
                className="workbench-evidence-path"
                key={`${evidence.kind}:${evidence.path}`}
              >
                <span>
                  {t(`desktop.workbench.agents.evidence.${evidence.kind}`)}
                </span>
                <code>{evidence.path}</code>
              </div>
            ))
          ) : (
            <p>
              {agent.program.status === 'unverified' && (agent.program.commands.length || agent.program.applications.length)
                ? '程序检测未能完成，无法确认是否已安装。请检查程序路径及相关目录的访问权限后重新扫描。'
                : t(`desktop.workbench.agents.explanation.${agent.program.status}`)}
            </p>
          )}
          {agent.program.commands.length ? (
            <small>
              {t('desktop.workbench.agents.checkedCommands', {
                commands: agent.program.commands.join(', '),
              })}
            </small>
          ) : null}
          {agent.program.applications.length ? (
            <small>
              {t('desktop.workbench.agents.checkedApps', {
                apps: agent.program.applications.join(', '),
              })}
            </small>
          ) : null}
        </div>
        <div>
          <h3>
            <FolderOpen />
            {t('desktop.workbench.agents.directory')}
          </h3>
          <div className="workbench-directory-path">
            <code>{agent.path}</code>
            <Button
              disabled={!agent.directoryExists}
              onClick={() => onOpenDirectory(agent.id)}
              size="xs"
              variant="outline"
            >
              <FolderOpen />
              {t('desktop.workbench.openDirectory')}
            </Button>
          </div>
          <p>
            {!directoryNote(agent.directoryStatus, agent.directoryExists)
              ? t('desktop.workbench.agents.localKinds', {
                  linked: number(agent.linkedSkills),
                  direct: number(agent.directSkills),
                })
              : directoryNote(agent.directoryStatus, agent.directoryExists)}
          </p>
          {agent.readsSharedDirectory ? (
            <small>
              {t('desktop.workbench.agents.readsShared', {
                path: snapshot.sharedDirectory.path,
              })}
            </small>
          ) : null}
          {agent.configurationPaths.length ? (
            <small>
              {t('desktop.workbench.agents.configPaths', {
                paths: agent.configurationPaths.join(', '),
              })}
            </small>
          ) : null}
        </div>
      </div>
      <div
        className="workbench-skill-tabs"
        aria-label={t('desktop.workbench.agents.skillLists')}
      >
        {tabs.map(({ key, count }) => (
          <button
            aria-pressed={skillTab === key}
            key={key}
            onClick={() => onSkillTabChange(key)}
            type="button"
          >
            {t(`desktop.workbench.agents.tab.${key}`)}
            <span>{number(count)}</span>
          </button>
        ))}
      </div>
      <p className="workbench-skill-list-note">
        {t(`desktop.workbench.agents.tabDescription.${skillTab}`)}
      </p>
      {names.length ? (
        <ul className="workbench-skill-names">
          {names.map((name, index) => {
            const local =
              skillTab === 'local'
                ? agent.localSkills[index]
                : agent.localSkills.find((skill) => skill.name === name)
            return (
              <li key={local?.path ?? name}>
                <strong>{name}</strong>
                {local ? (
                  <>
                    <span>
                      {t(`desktop.workbench.agents.kind.${local.kind}`)}
                    </span>
                    <code title={local.path}>{local.path}</code>
                    {local.kind === 'symlink' && local.canonicalPath && local.canonicalPath !== local.path ? (
                      <code title={local.canonicalPath}>目标：{local.canonicalPath}</code>
                    ) : null}
                  </>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="workbench-skill-empty">
          {t(`desktop.workbench.agents.tabEmpty.${skillTab}`)}
        </p>
      )}
      {issues.length ? (
        <div className="workbench-agent-file-issues">
          {issues.map((issue) => (
            <p key={issue.path}>
              <span>{t(`desktop.workbench.files.status.${issue.status}`)}</span>
              <code>{issue.path}</code>
            </p>
          ))}
        </div>
      ) : null}
    </div>
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

