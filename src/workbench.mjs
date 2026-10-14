import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { getAgentRegistry, getUniversalInstallTarget, AGENT_REGISTRY_SOURCE } from './agent-registry.mjs';
import { AGENT_PROGRAMS } from './agent-programs.mjs';

const MAX_ENTRIES = 10000;
const DOCUMENT_LIMIT = 4 * 1024 * 1024;
const TOTAL_BYTES = 16 * 1024 * 1024;
const missing = error => error.code === 'ENOENT' || error.code === 'ENOTDIR';
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
const error = (status, message) => Object.assign(new Error(message), { status });
const emptyScan = () => ({ skills: [], broken: 0, direct: 0, inaccessible: 0, missingDocuments: 0, valid: 0, issues: [] });
const sortNames = names => [...names].sort((a, b) => a.localeCompare(b));

export function workbenchRegistry({ homeDir, magpieDir, customRoots = [], environment = process.env }) {
  const universal = getUniversalInstallTarget();
  const sharedReaders = new Set([...universal.agentIds, ...universal.hiddenAgentIds]);
  const presets = getAgentRegistry({ homeDir, environment }).map(agent => ({
    ...agent, path: agent.skillDirectories[0], configurationPaths: agent.detectionPaths,
    commands: AGENT_PROGRAMS[agent.id]?.commands ?? [], applications: AGENT_PROGRAMS[agent.id]?.apps ?? [],
    readsSharedDirectory: sharedReaders.has(agent.id),
  }));
  return [
    ...presets,
    { id: 'magpie', name: 'Magpie', path: path.join(magpieDir, 'library/skills'), configurationPaths: [magpieDir], commands: ['magpie'], applications: ['Magpie'], readsSharedDirectory: false },
    ...customRoots.filter(root => root.scopeId === 'global').map(root => ({
      id: root.id, name: root.label, path: root.path, configurationPaths: [], commands: [], applications: [], readsSharedDirectory: false,
    })),
  ];
}

async function directoryState(location, filesystem) {
  let exists = false;
  let canonicalPath = path.resolve(location);
  try {
    canonicalPath = await filesystem.realpath(location);
    if (!(await filesystem.stat(canonicalPath)).isDirectory()) return { status: 'inaccessible', canonicalPath: location, exists: false };
    exists = true;
    await filesystem.access(canonicalPath, constants.R_OK | constants.X_OK);
    return { status: 'ready', canonicalPath, exists: true };
  } catch (failure) {
    let linked = false;
    try { linked = (await filesystem.lstat(location)).isSymbolicLink(); } catch { /* A missing source is normal. */ }
    return { status: failure.code === 'ELOOP' || (linked && missing(failure)) ? 'broken' : missing(failure) ? 'missing' : 'inaccessible', canonicalPath, exists };
  }
}

async function detectProgram(agent, { filesystem, environment, platform, searchPaths, applicationDirectories }) {
  const commands = agent.commands;
  const applications = platform === 'darwin' ? agent.applications : [];
  const evidence = [];
  let uncertain = false;
  const extensions = platform === 'win32'
    ? ['', ...new Set((environment.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(value => /^\.[a-z0-9]{1,8}$/i.test(value)).slice(0, 16).flatMap(value => [value.toLowerCase(), value.toUpperCase()]))]
    : [''];
  for (const command of commands) {
    let found = false;
    for (const directory of searchPaths) {
      for (const extension of extensions) {
        const candidate = path.join(directory, command + extension);
        try {
          if (!(await filesystem.stat(candidate)).isFile()) continue;
          await filesystem.access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK);
          evidence.push({ kind: 'command', path: candidate });
          found = true;
          break;
        } catch (failure) {
          if (!missing(failure) && failure.code !== 'ELOOP') uncertain = true;
        }
      }
      if (found) break;
    }
  }
  for (const application of applications) {
    for (const directory of applicationDirectories) {
      const bundle = path.join(directory, `${application}.app`);
      try {
        if (!(await filesystem.stat(path.join(bundle, 'Contents/Info.plist'))).isFile()) continue;
        let inspected = 0;
        const entries = await filesystem.opendir(path.join(bundle, 'Contents/MacOS'));
        for await (const entry of entries) {
          if (++inspected > 128) { uncertain = true; break; }
          const binary = path.join(bundle, 'Contents/MacOS', entry.name);
          if (!(await filesystem.stat(binary)).isFile()) continue;
          await filesystem.access(binary, constants.X_OK);
          evidence.push({ kind: 'application', path: bundle });
          break;
        }
      } catch (failure) {
        if (!missing(failure) && failure.code !== 'ELOOP') uncertain = true;
      }
    }
  }
  return {
    status: evidence.length ? 'found' : uncertain || (!commands.length && !applications.length) ? 'unverified' : 'not-found',
    commands, applications, evidence: evidence.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

async function documentName(location, fallback, context) {
  const { filesystem, budget, warnings } = context;
  const real = await filesystem.realpath(location);
  const handle = await filesystem.open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > DOCUMENT_LIMIT || budget.bytes + stat.size > TOTAL_BYTES) throw error(413, 'Skill document scan limit reached.');
    // Read only a bounded document; scripts and other Skill assets are never opened.
    const buffer = Buffer.alloc(Math.min(DOCUMENT_LIMIT + 1, stat.size + 1));
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    budget.bytes += size;
    if (size > stat.size || budget.bytes > TOTAL_BYTES) throw error(413, 'Skill document changed or exceeded the scan limit.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
    const frontmatter = text.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!frontmatter) return fallback;
    try {
      const metadata = parseYaml(frontmatter[1], { maxAliasCount: 30 });
      return typeof metadata?.name === 'string' && metadata.name.trim() ? metadata.name.trim().slice(0, 500) : fallback;
    } catch {
      warnings.add(`Invalid frontmatter; using directory name: ${location}`);
      return fallback;
    }
  } finally { await handle.close(); }
}

async function scanDirectory(directory, state, context) {
  const scan = emptyScan();
  const { filesystem, budget, warnings, expectedNames, expectedDirectories, excludedDirectory } = context;
  function issue(location, status) {
    scan[status === 'missing-document' ? 'missingDocuments' : status] += 1;
    scan.issues.push({ path: location, skillName: path.basename(location), status });
  }
  if (state.status !== 'ready') {
    if (state.status !== 'missing') issue(directory, state.status);
    return scan;
  }
  if (excludedDirectory && inside(excludedDirectory, state.canonicalPath)) return scan;
  const inspect = async location => {
    let linked = false;
    let real;
    try {
      const entry = await filesystem.lstat(location);
      linked = entry.isSymbolicLink();
      if (!entry.isDirectory() && !linked) return;
      real = await filesystem.realpath(location);
      if (excludedDirectory && inside(excludedDirectory, real)) return;
      if (!(await filesystem.stat(real)).isDirectory()) return;
      await filesystem.access(real, constants.R_OK | constants.X_OK);
      if (linked) scan.valid += 1;
    } catch (failure) {
      issue(location, failure.code === 'ELOOP' || (linked && missing(failure)) ? 'broken' : 'inaccessible');
      return;
    }
    try {
      const name = await documentName(path.join(real, 'SKILL.md'), path.basename(location), context);
      const kind = linked ? 'symlink' : 'copy';
      scan.skills.push({ kind, name, path: location, canonicalPath: real });
      if (kind === 'copy') scan.direct += 1;
      return;
    } catch (failure) {
      if (!missing(failure)) {
        issue(location, 'inaccessible');
        if (failure.status === 413) warnings.add(`${failure.message} ${location}`);
        return;
      }
    }
    // Helper folders are not failed Skills merely because they lack SKILL.md.
    if (linked || expectedNames.has(path.basename(location)) || expectedDirectories.has(real)) issue(location, 'missing-document');
  };
  // Match the desktop inventory: inspect source children, never the root or nested helpers.
  try {
    const entries = await filesystem.opendir(state.canonicalPath);
    for await (const entry of entries) {
      if (++budget.entries > MAX_ENTRIES) { warnings.add(`Skill scan limit reached: ${directory}`); break; }
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (entry.isDirectory() || entry.isSymbolicLink()) await inspect(path.join(state.canonicalPath, entry.name));
    }
  } catch { issue(directory, 'inaccessible'); }
  return scan;
}

export async function scanWorkbench(options) {
  const {
    homeDir, magpieDir, customRoots = [], knownSkillNames = [], knownSkillPaths = [], dataDir,
    filesystem = fs, environment = process.env, platform = process.platform,
    applicationDirectories = platform === 'darwin' ? ['/Applications', path.join(homeDir, 'Applications')] : [],
  } = options;
  const registry = workbenchRegistry({ homeDir, magpieDir, customRoots, environment });
  const sharedPath = path.join(homeDir, '.agents/skills');
  const allSearchPaths = [...new Set((environment.PATH || '').split(path.delimiter).filter(value => path.isAbsolute(value)))];
  const searchPaths = allSearchPaths.slice(0, 128);
  const warnings = new Set();
  if (allSearchPaths.length > 128) warnings.add('Program PATH scan was limited to 128 directories.');
  const context = { filesystem, budget: { entries: 0, bytes: 0 }, warnings, expectedNames: new Set(knownSkillNames), expectedDirectories: new Set(knownSkillPaths), excludedDirectory: dataDir };
  const sharedState = await directoryState(sharedPath, filesystem);
  const sharedScan = await scanDirectory(sharedPath, sharedState, context);
  const sharedNames = new Set(sharedScan.skills.map(skill => skill.name));
  for (const name of sharedNames) context.expectedNames.add(name);
  const scans = new Map([[sharedState.canonicalPath, { scan: sharedScan, directory: sharedState.canonicalPath, agentNames: [] }]]);
  const coverage = [];
  let directoryAgents = 0;
  for (const agent of registry) {
    for (const directory of agent.skillDirectories ?? []) {
      if ((await directoryState(directory, filesystem)).exists) { agent.path = directory; break; }
    }
    const state = await directoryState(agent.path, filesystem);
    const configurationPaths = [];
    for (const candidate of agent.configurationPaths) {
      if ((await directoryState(candidate, filesystem)).status === 'ready') configurationPaths.push(candidate);
    }
    const program = await detectProgram(agent, { filesystem, environment, platform, searchPaths, applicationDirectories });
    if (state.status === 'missing' && !configurationPaths.length && program.status !== 'found') continue;
    const sameAsShared = state.canonicalPath === sharedState.canonicalPath;
    if (state.exists && !sameAsShared) directoryAgents += 1;
    let scan = emptyScan();
    if (!sameAsShared) {
      if (!scans.has(state.canonicalPath)) scans.set(state.canonicalPath, { scan: await scanDirectory(agent.path, state, context), directory: state.canonicalPath, agentNames: [] });
      const group = scans.get(state.canonicalPath);
      const sourceAlias = state.canonicalPath !== path.resolve(agent.path);
      scan = { ...group.scan, skills: group.scan.skills.map(skill => ({ ...skill,
        path: path.join(agent.path, path.relative(group.directory, skill.path)), kind: sourceAlias ? 'symlink' : skill.kind })) };
      group.agentNames.push(agent.name);
    }
    const readsSharedDirectory = sameAsShared || agent.readsSharedDirectory;
    const localNames = new Set(scan.skills.map(skill => skill.name));
    const knownNames = new Set([...localNames, ...(readsSharedDirectory ? sharedNames : [])]);
    const linkedNames = new Set(scan.skills.filter(skill => skill.kind === 'symlink').map(skill => skill.name));
    const directNames = new Set(scan.skills.filter(skill => skill.kind === 'copy' && !linkedNames.has(skill.name)).map(skill => skill.name));
    const matching = names => [...names].filter(name => sharedNames.has(name)).length;
    const availableSkills = matching(knownNames);
    coverage.push({
      id: agent.id, name: agent.name, path: agent.path, directoryExists: state.exists, directoryStatus: state.status,
      configurationPaths, program, readsSharedDirectory,
      localSkills: [...scan.skills].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)),
      availableSkills, linkedSkills: matching(linkedNames), directSkills: matching(directNames),
      sharedSkills: availableSkills - matching(localNames), exclusiveSkills: knownNames.size - availableSkills,
      ratio: sharedNames.size ? availableSkills / sharedNames.size : 0,
      missingSkillNames: sortNames([...sharedNames].filter(name => !knownNames.has(name))),
      exclusiveSkillNames: sortNames([...knownNames].filter(name => !sharedNames.has(name))),
    });
  }
  const health = { broken: 0, direct: 0, inaccessible: 0, missingDocuments: 0, valid: 0, issues: [] };
  const allNames = new Set(sharedNames);
  const deployedNames = new Set();
  for (const [key, { scan, agentNames }] of scans) {
    for (const count of ['broken', 'direct', 'inaccessible', 'missingDocuments', 'valid']) health[count] += scan[count];
    health.issues.push(...scan.issues.map(issue => ({ ...issue, agentNames })));
    for (const skill of scan.skills) {
      allNames.add(skill.name);
      if (key !== sharedState.canonicalPath && sharedNames.has(skill.name)) deployedNames.add(skill.name);
    }
  }
  health.issues.sort((a, b) => a.path.localeCompare(b.path));
  coverage.sort((a, b) => b.availableSkills - a.availableSkills || a.name.localeCompare(b.name));
  return {
    scannedAt: new Date().toISOString(),
    registry: { agentCount: registry.length, agents: registry.map(({ id, name }) => ({ id, name })), source: 'skills', cliVersion: AGENT_REGISTRY_SOURCE.version },
    sharedDirectory: { exists: sharedState.exists, path: sharedPath, skillNames: sortNames(sharedNames), status: sharedState.status },
    programSearch: { source: 'process', paths: searchPaths },
    stats: {
      totalSkills: allNames.size, sharedSkills: sharedNames.size, exclusiveSkills: allNames.size - sharedNames.size,
      linkedSkills: deployedNames.size, detectedAgents: coverage.filter(agent => agent.program.status === 'found').length,
      directoryAgents,
      directoryOnlyAgents: coverage.filter(agent => agent.program.status === 'not-found').length,
    },
    agentCoverage: coverage, symlinkHealth: health, untrackedSkills: [], scanWarnings: [...warnings],
  };
}

export async function workbenchDirectory(id, options) {
  const filesystem = options.filesystem || fs;
  const entry = id === 'shared' ? { path: path.join(options.homeDir, '.agents/skills') } : workbenchRegistry(options).find(agent => agent.id === id);
  if (!entry) throw error(404, 'Unknown Agent directory.');
  for (const directory of entry.skillDirectories ?? []) {
    if ((await directoryState(directory, filesystem)).exists) { entry.path = directory; break; }
  }
  const state = await directoryState(entry.path, filesystem);
  if (state.status !== 'ready') throw error(state.status === 'inaccessible' ? 403 : 404, `Agent directory is ${state.status}.`);
  if (options.dataDir && inside(options.dataDir, state.canonicalPath)) throw error(403, 'Agent directory overlaps plugin storage.');
  return state.canonicalPath;
}
