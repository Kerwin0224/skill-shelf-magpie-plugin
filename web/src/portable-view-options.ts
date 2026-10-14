import type { FinderOptions, SortKey } from './finder-state';
import type { Folder, PortableFinderOptions, ViewMode } from './types';

export function portableFolderKey(folders: Folder[], id: string | null) {
  if (!id) return 'root';
  const names: string[] = [];
  while (id) {
    const folder = folders.find(item => item.id === id);
    if (!folder) return 'root';
    names.unshift(folder.name.trim().toLocaleLowerCase('en-US'));
    id = folder.parentId;
  }
  return JSON.stringify(names);
}

export function fromPortableView(value: PortableFinderOptions): FinderOptions & { view: ViewMode } {
  const supported = (key: string, fallback: SortKey): SortKey => ['name', 'kind', 'source', 'tags'].includes(key) ? key as SortKey : fallback;
  const groupBy = supported(value.groupBy, 'kind');
  return { snap: value.alignToGrid, sort: value.sortBy === 'none' ? 'manual' : supported(value.sortBy, 'name'),
    direction: value.sortDirection === 'ascending' ? 'asc' : 'desc', group: value.useGroups ? groupBy : 'manual', groupBy,
    view: value.viewMode === 'canvas' ? 'grid' : value.viewMode };
}

export function toPortableView(value: FinderOptions & { view: ViewMode }): PortableFinderOptions {
  return { alignToGrid: value.snap, sortBy: value.sort === 'manual' ? 'none' : value.sort,
    sortDirection: value.direction === 'asc' ? 'ascending' : 'descending', groupBy: value.groupBy ?? 'kind',
    useGroups: value.group !== 'manual', viewMode: value.view === 'grid' ? 'canvas' : value.view };
}
