import type { Folder, ManagedSkill, Position, Skill, Snapshot } from './types';

export type FinderItem = {
  key: string; id: string; kind: 'folder' | 'skill'; name: string;
  parentId: string | null; source: string; tags: string[];
  folder?: Folder; skill?: Skill | ManagedSkill;
};
export type SortKey = 'manual' | 'name' | 'kind' | 'source' | 'tags';
export type FinderOptions = { sort: SortKey; direction: 'asc' | 'desc'; group: SortKey; groupBy?: SortKey; snap: boolean };
export const defaultFinderOptions: FinderOptions = { sort: 'manual', direction: 'desc', group: 'manual', groupBy: 'kind', snap: false };
export const MAX_POSITION = 100000;

export function finderItems(snapshot: Snapshot, scope: string): FinderItem[] {
  const skills = [...snapshot.skills, ...snapshot.managedSkills].filter(skill => skill.scopeId === scope);
  return [
    ...snapshot.folders.filter(folder => folder.scopeId === scope).map(folder => ({
      key: `folder:${folder.id}`, id: folder.id, kind: 'folder' as const,
      name: folder.name, parentId: folder.parentId, source: '', tags: [], folder,
    })),
    ...skills.map(skill => ({
      key: `skill:${skill.id}`, id: skill.id, kind: 'skill' as const,
      name: skill.name, parentId: snapshot.organization[skill.id]?.folderId || null,
      source: skill.sourceLabel, tags: snapshot.organization[skill.id]?.tags || [], skill,
    })),
  ];
}

export function folderChain(folderId: string | null, folders: Folder[]) {
  const chain: Folder[] = []; const seen = new Set<string>();
  let folder = folders.find(folder => folder.id === folderId);
  while (folder && !seen.has(folder.id)) {
    chain.unshift(folder); seen.add(folder.id); folder = folders.find(parent => parent.id === folder!.parentId);
  }
  return chain;
}

export function descendantIds(ids: Iterable<string>, folders: Folder[]) {
  const result = new Set(ids);
  let added = true;
  while (added) {
    added = false;
    for (const folder of folders) if (folder.parentId && result.has(folder.parentId) && !result.has(folder.id)) { result.add(folder.id); added = true; }
  }
  return result;
}

export function selectedSkillIds(keys: string[], items: FinderItem[], folders: Folder[]) {
  const selected = new Set(keys);
  const descendants = descendantIds(keys.filter(key => key.startsWith('folder:')).map(key => key.slice(7)), folders);
  return items.filter(item => item.kind === 'skill' && (selected.has(item.key) || Boolean(item.parentId && descendants.has(item.parentId)))).map(item => item.id);
}

export function movableItems(keys: string[], items: FinderItem[], folders: Folder[]) {
  const selected = new Set(keys);
  const selectedFolders = keys.filter(key => key.startsWith('folder:')).map(key => key.slice(7));
  const descendants = descendantIds(selectedFolders, folders);
  return items.filter(item => selected.has(item.key) && !(item.parentId && descendants.has(item.parentId)));
}

export function selectRange(order: string[], anchor: string | null, target: string) {
  const start = anchor ? order.indexOf(anchor) : -1; const end = order.indexOf(target);
  return start < 0 || end < 0 ? [target] : order.slice(Math.min(start, end), Math.max(start, end) + 1);
}

export function applySelection(current: string[], candidates: string[], mode: 'replace' | 'add' | 'toggle') {
  if (mode === 'replace') return [...new Set(candidates)];
  const next = new Set(current);
  for (const key of candidates) { if (mode === 'toggle' && next.has(key)) next.delete(key); else next.add(key); }
  return [...next];
}

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
export function orderItems(items: FinderItem[], options: FinderOptions) {
  return [...items].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    const value = (item: FinderItem) => options.sort === 'source' ? item.source : options.sort === 'tags' ? [...item.tags].sort(collator.compare).join(',') : item.name;
    const direction = options.sort === 'manual' || options.direction === 'asc' ? 1 : -1;
    return (collator.compare(value(a), value(b)) || collator.compare(a.name, b.name)) * direction || a.key.localeCompare(b.key);
  });
}

export function groupLabel(item: FinderItem, group: SortKey) {
  if (group === 'kind') return item.kind === 'folder' ? '文件夹' : 'Skill';
  if (group === 'source') return item.source.trim() || '未知来源';
  if (group === 'tags') return [...item.tags].sort(collator.compare)[0] || '无标签';
  if (group === 'name') return Array.from(item.name.trim())[0]?.toLocaleUpperCase('zh-CN') || '#';
  return '';
}

export function finderGroups(items: FinderItem[], group: SortKey) {
  const groups = new Map<string, FinderItem[]>();
  for (const item of items) {
    const label = groupLabel(item, group);
    const members = groups.get(label) || [];
    members.push(item); groups.set(label, members);
  }
  return new Map([...groups].sort(([a], [b]) => {
    if (a === b) return 0;
    if (group === 'kind') return a === '文件夹' ? -1 : 1;
    const missing = group === 'source' ? '未知来源' : group === 'tags' ? '无标签' : null;
    if (a === missing || b === missing) return a === missing ? 1 : -1;
    return collator.compare(a, b);
  }));
}

export function gridPosition(index: number, width: number): Position {
  const columns = Math.max(1, Math.floor(((Number.isFinite(width) ? Math.max(0, width) : 980) - 40) / 124));
  return { x: 28 + (index % columns) * 124, y: 24 + Math.floor(index / columns) * 122 };
}

export function defaultCanvasPosition(index: number): Position {
  return { x: 28 + (index % 7) * 124, y: 24 + Math.floor(index / 7) * 122 };
}

export function nextCanvasPosition(occupied: Position[]): Position {
  // Same strict 108x102 overlap check as the source, indexed to avoid cubic scans.
  const blocked = new Set<number>();
  for (const point of occupied) {
    const firstColumn = Math.max(0, Math.floor((point.x - 28 - 108) / 124) + 1);
    const lastColumn = Math.min(6, Math.ceil((point.x - 28 + 108) / 124) - 1);
    const firstRow = Math.max(0, Math.floor((point.y - 24 - 102) / 122) + 1);
    const lastRow = Math.min(Math.floor((MAX_POSITION - 24) / 122), Math.ceil((point.y - 24 + 102) / 122) - 1);
    for (let row = firstRow; row <= lastRow; row++) for (let column = firstColumn; column <= lastColumn; column++) blocked.add(row * 7 + column);
  }
  for (let index = 0; index < 10000; index++) {
    const point = defaultCanvasPosition(index);
    if (point.y > MAX_POSITION) break;
    if (!blocked.has(index)) return point;
  }
  return availablePosition(defaultCanvasPosition(0), occupied);
}

export function draggedCanvasPositions(origins: Record<string, Position>, anchorKey: string, start: Position, pointer: Position, bounded = true): Record<string, Position> {
  const anchor = origins[anchorKey]; const points = Object.values(origins);
  if (!anchor || points.length === 0) return origins;
  const anchorX = Math.max(8, Math.round(anchor.x + pointer.x - start.x));
  const anchorY = Math.max(8, Math.round(anchor.y + pointer.y - start.y));
  const minX = Math.min(...points.map(point => point.x)); const maxX = Math.max(...points.map(point => point.x));
  const minY = Math.min(...points.map(point => point.y)); const maxY = Math.max(...points.map(point => point.y));
  const dx = Math.min(bounded ? MAX_POSITION - maxX : Infinity, Math.max(anchorX - anchor.x, 8 - minX));
  const dy = Math.min(bounded ? MAX_POSITION - maxY : Infinity, Math.max(anchorY - anchor.y, 8 - minY));
  return Object.fromEntries(Object.entries(origins).map(([key, point]) => [key, { x: Math.round(point.x + dx), y: Math.round(point.y + dy) }]));
}

export function snapPosition(position: Position): Position {
  return {
    x: 28 + Math.min(Math.floor((MAX_POSITION - 28) / 124), Math.max(0, Math.round((position.x - 28) / 124))) * 124,
    y: 24 + Math.min(Math.floor((MAX_POSITION - 24) / 122), Math.max(0, Math.round((position.y - 24) / 122))) * 122,
  };
}

export function availablePosition(preferred: Position, occupied: Position[]): Position {
  const snapped = snapPosition(preferred);
  const used = new Set(occupied.map(position => { const point = snapPosition(position); return `${point.x}:${point.y}`; }));
  const preferredColumn = Math.round((snapped.x - 28) / 124);
  const preferredRow = Math.round((snapped.y - 24) / 122);
  for (let radius = 0; radius < 1000; radius++) {
    const candidates: Position[] = [];
    for (let rowOffset = -radius; rowOffset <= radius; rowOffset++) {
      for (let columnOffset = -radius; columnOffset <= radius; columnOffset++) {
        if (radius > 0 && Math.max(Math.abs(rowOffset), Math.abs(columnOffset)) !== radius) continue;
        const column = preferredColumn + columnOffset; const row = preferredRow + rowOffset;
        if (column < 0 || row < 0) continue;
        const point = { x: 28 + column * 124, y: 24 + row * 122 };
        if (point.x > MAX_POSITION || point.y > MAX_POSITION) continue;
        if (!used.has(`${point.x}:${point.y}`)) candidates.push(point);
      }
    }
    candidates.sort((a, b) => (a.x - snapped.x) ** 2 + (a.y - snapped.y) ** 2 - ((b.x - snapped.x) ** 2 + (b.y - snapped.y) ** 2) || a.y - b.y || a.x - b.x);
    if (candidates[0]) return candidates[0];
  }
  return snapped;
}

export function intersects(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  return a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
}
