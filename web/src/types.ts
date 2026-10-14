export type PortableFinderOptions = { alignToGrid: boolean; groupBy: string; sortBy: string; sortDirection: 'ascending' | 'descending'; useGroups: boolean; viewMode: 'canvas' | 'list' | 'columns' };
export type PortablePreferences = { language?: 'en' | 'zh-CN' | 'system'; theme?: Theme; density?: 'comfortable' | 'compact'; libraryViewMode?: 'canvas' | 'list' | 'columns'; defaultAgents?: string[]; focusedAgents?: string[]; sidebarCollapsed?: boolean };
export type Folder = { id: string; name: string; scopeId: string; parentId: string | null; color: string; viewOptions?: PortableFinderOptions };
export type Organization = { folderId: string | null; tags: string[] };
export type Skill = {
  id: string; name: string; slug: string; description: string; path: string;
  scopeId: string; agents: string[]; sourceLabel: string;
  installKind?: 'directory' | 'symlink' | 'unknown'; linkTarget?: string; sourceUrl?: string;
  installations?: SkillInstallation[];
};
export type SkillInstallation = Omit<Skill, 'installations'> & {
  isCanonical: boolean; documentMatchesCanonical: boolean;
  organization: Organization; position: Position | null;
};
export type Deployment = { id: string; targetPath: string; mode: 'copy' | 'symlink'; createdAt: string };
export type ManagedSkill = Skill & {
  packId: string; sourcePath: string; importedAt: string; deployments: Deployment[];
};
export type Pack = { id: string; name: string; description: string; createdAt: string; updatedAt: string; sort?: 'manual' | 'name-asc' | 'name-desc'; viewOptions?: Record<string, PortableFinderOptions> };
export type Root = { id: string; path: string; label: string; scopeId: string; preset: boolean; exists: boolean };
export type Project = { id: string; name: string; path: string };
export type Snapshot = {
  version: 1; skills: Skill[]; managedSkills: ManagedSkill[]; packs: Pack[];
  folders: Folder[]; organization: Record<string, Organization>; roots: Root[];
  projects: Project[]; scanWarnings: string[]; scannedAt: string; dataDir: string; homeDir: string;
  finderPositions?: Record<string, { x: number; y: number }>;
  portablePreferences?: PortablePreferences;
  rootViewOptions?: Record<string, PortableFinderOptions>;
  portableDescriptions?: Record<string, Record<string, string>>;
};
export type ViewMode = 'grid' | 'list' | 'columns';
export type Theme = 'light' | 'dark' | 'system';
export type Position = { x: number; y: number };
export type FinderMove = { scopeId: string; items: { kind: 'folder' | 'skill'; id: string; position?: Position }[]; parentId?: string | null };
export type AiAnnotation = {
  skillId: string; kind: 'summary' | 'translation'; language: string; text: string;
  model: string; sourceDigest: string; createdAt: string; savedAt?: string; stale?: boolean;
};
export type AiDraft = AiAnnotation & { draftId: string };
