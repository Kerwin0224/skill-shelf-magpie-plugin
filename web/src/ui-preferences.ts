export type StartupPage = 'workbench' | 'skills' | 'packs';
export type UiPreferences = { startupPage: StartupPage; rememberLocation: boolean; density: 'comfortable' | 'compact'; focusedAgents: string[] };
export const UI_PREFERENCES_KEY = 'shelf-ui:preferences';
export const defaultUiPreferences: UiPreferences = { startupPage: 'workbench', rememberLocation: false, density: 'comfortable', focusedAgents: [] };

export function readUiPreferences(): UiPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(UI_PREFERENCES_KEY) || '{}');
    return {
      startupPage: ['workbench', 'skills', 'packs'].includes(value.startupPage) ? value.startupPage : 'workbench',
      rememberLocation: value.rememberLocation === true,
      density: value.density === 'compact' ? 'compact' : 'comfortable',
      focusedAgents: Array.isArray(value.focusedAgents) ? [...new Set(value.focusedAgents.filter((name: unknown): name is string => typeof name === 'string' && name.length <= 100))].slice(0, 100) as string[] : [],
    };
  } catch { return { ...defaultUiPreferences }; }
}

export function saveUiPreferences(value: UiPreferences) {
  localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify(value));
}

export function initialPage(): { screen: 'workbench' | 'shelf' | 'discover'; scope: string; folderId: string | null } {
  const preferences = readUiPreferences();
  let hash = window.location.hash;
  if ((!hash || hash === '#settings') && preferences.rememberLocation) {
    try { hash = localStorage.getItem('shelf-last-location') || ''; } catch { /* Use the configured startup page. */ }
  }
  if (hash === '#workbench') return { screen: 'workbench', scope: 'global', folderId: null };
  if (hash === '#discover') return { screen: 'discover', scope: 'global', folderId: null };
  if (hash.startsWith('#skills:') || hash.startsWith('#packs:')) {
    try {
      const [page, folder] = hash.slice(1).split('/');
      return { screen: 'shelf', scope: page.startsWith('packs:') ? `pack:${decodeURIComponent(page.slice(6))}` : decodeURIComponent(page.slice(7)) || 'global', folderId: folder ? decodeURIComponent(folder) : null };
    } catch { /* Ignore malformed external links. */ }
  }
  return { screen: preferences.startupPage === 'workbench' ? 'workbench' : 'shelf', scope: preferences.startupPage === 'packs' ? 'pack:default' : 'global', folderId: null };
}

export function rememberPage(screen: 'workbench' | 'shelf' | 'discover', scope: string, folderId: string | null) {
  const hash = screen === 'workbench' ? '#workbench' : screen === 'discover' ? '#discover' : `${scope.startsWith('pack:') ? `#packs:${encodeURIComponent(scope.slice(5))}` : `#skills:${encodeURIComponent(scope)}`}${folderId ? `/${encodeURIComponent(folderId)}` : ''}`;
  window.history.replaceState(null, '', hash);
  try { localStorage.setItem('shelf-last-location', hash); } catch { /* Navigation does not require persistent browser storage. */ }
}
