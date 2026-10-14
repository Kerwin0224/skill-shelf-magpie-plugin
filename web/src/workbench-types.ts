export type DirectoryStatus = 'ready' | 'missing' | 'inaccessible' | 'broken';

export type WorkbenchSkillFile = {
  kind: 'copy' | 'symlink';
  name: string;
  path: string;
  canonicalPath?: string;
};

export type AgentCoverageEntry = {
  availableSkills: number;
  directSkills: number;
  exclusiveSkills: number;
  id: string;
  linkedSkills: number;
  name: string;
  path: string;
  ratio: number;
  directoryExists: boolean;
  directoryStatus?: DirectoryStatus;
  configurationPaths: string[];
  program: {
    status: 'found' | 'not-found' | 'unverified';
    evidence: Array<{ kind: 'command' | 'application'; path: string }>;
    commands: string[];
    applications: string[];
  };
  readsSharedDirectory: boolean;
  localSkills: WorkbenchSkillFile[];
  missingSkillNames: string[];
  exclusiveSkillNames: string[];
  sharedSkills: number;
};

export type WorkbenchSnapshot = {
  agentCoverage: AgentCoverageEntry[];
  registry: {
    agentCount: number;
    agents: Array<{ id: string; name: string }>;
    cliVersion: string;
    source: 'skills';
  };
  scannedAt: string;
  sharedDirectory: { exists: boolean; path: string; skillNames: string[]; status?: DirectoryStatus };
  programSearch: { source: 'process'; paths: string[] };
  stats: {
    detectedAgents: number;
    directoryAgents: number;
    directoryOnlyAgents: number;
    exclusiveSkills: number;
    linkedSkills: number;
    sharedSkills: number;
    totalSkills: number;
  };
  symlinkHealth: {
    broken: number;
    direct: number;
    inaccessible: number;
    missingDocuments: number;
    valid: number;
    issues: Array<{
      agentNames: string[];
      path: string;
      skillName: string;
      status: 'broken' | 'inaccessible' | 'missing-document';
    }>;
  };
  untrackedSkills: unknown[];
  scanWarnings?: string[];
};

export type SourceSnapshot = WorkbenchSnapshot;
