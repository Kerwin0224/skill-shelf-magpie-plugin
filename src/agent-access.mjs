// Ownership, preview and recovery semantics transplanted from Skill Shelf v0.1.14.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve
} from "node:path";
import {
  getAgentRegistry,
  getUniversalInstallTarget
} from "./agent-registry.mjs";
const PREVIEW_TTL_MS = 5 * 6e4;
const MAX_PREVIEWS = 32;
const MAX_TREE_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TREE_ENTRIES = 1e4;
const RECOVERY_DIRECTORY_NAME = /^\.skill-shelf-access-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function missing(error) {
  return error?.code === "ENOENT";
}
function assertName(value) {
  if (typeof value !== "string" || !value || value.length > 255 || value !== value.trim() || value === "." || value === ".." || /[/\\:\x00-\x1f\x7f]/.test(value))
    throw new Error("Invalid Skill folder name");
}
function identity(value) {
  return `${value.dev}:${value.ino}:${value.birthtimeMs}`;
}
function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}
function overlaps(left, right) {
  const inside = (parent, child) => {
    const path = relative(parent, child);
    return path === "" || !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && path !== ".." && !isAbsolute(path);
  };
  return inside(left, right) || inside(right, left);
}
async function pathStats(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
async function readTree(root) {
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink())
    throw new Error("Skill is not a physical directory");
  const entries = [];
  let totalBytes = 0;
  async function walk(directory, prefix, depth) {
    if (depth > 100) throw new Error("Skill tree is too deep");
    const before = await lstat(directory);
    if (!before.isDirectory() || before.isSymbolicLink())
      throw new Error("Skill contains symbolic links or special files");
    const children = (await readdir(directory)).sort();
    for (const name of children) {
      assertName(name);
      if (entries.length >= MAX_TREE_ENTRIES)
        throw new Error("Skill tree is too large");
      const path = prefix ? `${prefix}/${name}` : name;
      const absolute = join(directory, name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink())
        throw new Error("Skill contains nested symbolic links");
      if (metadata.isDirectory()) {
        entries.push({ path, type: "directory", mode: metadata.mode & 511 });
        await walk(absolute, path, depth + 1);
      } else if (metadata.isFile()) {
        if (metadata.size > MAX_FILE_BYTES || totalBytes + metadata.size > MAX_TREE_BYTES)
          throw new Error("Skill tree is too large");
        const handle = await open(
          absolute,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
        let content;
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || identity(opened) !== identity(metadata) || opened.size > MAX_FILE_BYTES)
            throw new Error("Skill changed while reading");
          const buffer = Buffer.alloc(opened.size + 1);
          let length = 0;
          while (length < buffer.length) {
            const result = await handle.read(
              buffer,
              length,
              buffer.length - length,
              null
            );
            if (!result.bytesRead) break;
            length += result.bytesRead;
          }
          const after2 = await handle.stat();
          if (length !== opened.size || after2.mtimeMs !== opened.mtimeMs || after2.ctimeMs !== opened.ctimeMs)
            throw new Error("Skill changed while reading");
          content = buffer.subarray(0, length);
        } finally {
          await handle.close();
        }
        totalBytes += content.length;
        entries.push({
          path,
          type: "file",
          mode: metadata.mode & 511,
          content
        });
      } else throw new Error("Skill contains special files");
    }
    const after = await lstat(directory);
    if (identity(before) !== identity(after) || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error("Skill changed while reading");
  }
  await walk(root, "", 0);
  if (identity(await lstat(root)) !== identity(rootStats))
    throw new Error("Skill changed while reading");
  const document = entries.find(
    (entry) => entry.path === "SKILL.md" && entry.type === "file"
  );
  if (!document?.content) throw new Error("Skill has no SKILL.md");
  const text = new TextDecoder("utf8", { fatal: true }).decode(document.content);
  if (!text.trim() || text.includes("\0")) throw new Error("Invalid SKILL.md");
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return {
    hash: hash(
      JSON.stringify(
        entries.map(({ path, type, mode, content }) => ({
          path,
          type,
          executable: Boolean(mode & 73),
          content: content?.toString("base64")
        }))
      )
    ),
    identity: identity(rootStats),
    entries
  };
}
async function writeTree(root, tree) {
  await mkdir(root, { mode: 448 });
  const directories = tree.entries.filter((entry) => entry.type === "directory");
  for (const entry of [...directories].sort(
    (a, b) => a.path.split("/").length - b.path.split("/").length
  ))
    await mkdir(join(root, entry.path), { mode: 448 });
  for (const entry of tree.entries.filter((entry2) => entry2.type === "file")) {
    await writeFile(join(root, entry.path), entry.content, {
      mode: entry.mode,
      flag: "wx"
    });
    await chmod(join(root, entry.path), entry.mode);
  }
  for (const entry of [...directories].reverse())
    await chmod(join(root, entry.path), entry.mode);
  await chmod(root, 493);
}
async function inspectParents(directory, guardedRoots) {
  const paths = [];
  for (let path = resolve(directory); ; path = dirname(path)) {
    paths.unshift(path);
    if (dirname(path) === path) break;
  }
  const facts = [];
  let canonical = paths[0];
  for (const path of paths) {
    const metadata = await pathStats(path);
    if (metadata) {
      if (!metadata.isDirectory() && !metadata.isSymbolicLink())
        throw new Error("Agent Skill directory has a non-directory parent");
      canonical = await realpath(path);
      if (!(await stat(path)).isDirectory())
        throw new Error("Agent Skill directory is inaccessible");
      facts.push([
        path,
        identity(metadata),
        metadata.isSymbolicLink() ? await readlink(path) : null,
        canonical
      ]);
    } else {
      canonical = join(canonical, basename(path));
      facts.push([path, null, canonical]);
    }
  }
  if (guardedRoots.some((source) => overlaps(source, canonical)))
    throw new Error("Agent Skill directory overlaps the shared source");
  return { fingerprint: hash(JSON.stringify(facts)), canonical };
}
class AgentAccessService {
  constructor(statePath, registry = getAgentRegistry(), sharedDirectory = join(homedir(), ".agents", "skills")) {
    this.statePath = statePath;
    this.registry = registry;
    this.sharedDirectory = resolve(sharedDirectory);
  }
  state = { version: 1, relations: [] };
  initialization;
  diskStateFingerprint = null;
  previews = /* @__PURE__ */ new Map();
  activeTransactions = /* @__PURE__ */ new Set();
  mutations = Promise.resolve();
  sharedDirectory;
  initialize() {
    this.initialization ??= this.loadState();
    return this.initialization;
  }
  async getSnapshot(agentId) {
    await this.initialize();
    return (await this.scan(agentId)).snapshot;
  }
  async preview(input) {
    await this.initialize();
    this.validateInput(input);
    const scan = await this.scan(input.agentId);
    const entries = input.skillNames.map((name) => {
      const inspected = scan.inspections.get(name);
      if (!inspected)
        throw new Error("Skill is not present in the shared inventory");
      return { ...inspected.entry, operation: this.operation(inspected, input) };
    });
    const expires = Date.now() + PREVIEW_TTL_MS;
    const preview = {
      id: randomUUID(),
      agentId: input.agentId,
      action: input.action,
      mode: input.mode,
      expiresAt: new Date(expires).toISOString(),
      entries
    };
    for (const [id, value] of this.previews)
      if (value.expires <= Date.now()) this.previews.delete(id);
    while (this.previews.size >= MAX_PREVIEWS)
      this.previews.delete(this.previews.keys().next().value);
    this.previews.set(preview.id, {
      preview: structuredClone(preview),
      input: structuredClone(input),
      expires,
      fingerprints: new Map(
        input.skillNames.map((name) => [
          name,
          scan.inspections.get(name).fingerprint
        ])
      ),
      parentFingerprint: scan.parentFingerprint,
      stateFingerprint: JSON.stringify(this.state)
    });
    return preview;
  }
  async discard(previewId) {
    if (typeof previewId !== "string")
      throw new Error("Invalid preview identifier");
    this.previews.delete(previewId);
  }
  apply(previewId) {
    const run = this.mutations.then(async () => {
      try {
        return await this.applyPreview(previewId);
      } finally {
        this.activeTransactions.clear();
      }
    });
    this.mutations = run.catch(() => void 0);
    return run;
  }
  async getFolderPath(input) {
    await this.initialize();
    if (!input || typeof input !== "object" || !["source", "target"].includes(input.location))
      throw new Error("Invalid folder location");
    assertName(input.skillName);
    const scan = await this.scan(input.agentId);
    const entry = scan.inspections.get(input.skillName)?.entry;
    if (!entry) throw new Error("Unknown Skill");
    const path = input.location === "source" ? entry.sourcePath : entry.targetPath;
    if (!(await stat(path)).isDirectory())
      throw new Error("Skill folder is unavailable");
    return path;
  }
  agent(agentId) {
    if (typeof agentId !== "string") throw new Error("Invalid Agent identifier");
    const agent = this.registry.find((entry) => entry.id === agentId);
    if (!agent || !agent.skillDirectories.length)
      throw new Error("Unknown Agent");
    return agent;
  }
  validateInput(input) {
    if (!input || typeof input !== "object")
      throw new Error("Invalid access request");
    this.agent(input.agentId);
    if (!["connect", "update", "repair", "disconnect"].includes(input.action) || !["symlink", "copy"].includes(input.mode))
      throw new Error("Invalid access request");
    if (!Array.isArray(input.skillNames) || !input.skillNames.length || input.skillNames.length > 500)
      throw new Error("Select between 1 and 500 Skills");
    input.skillNames.forEach(assertName);
    if (new Set(input.skillNames).size !== input.skillNames.length)
      throw new Error("Duplicate Skill names");
  }
  async loadState() {
    let value;
    try {
      const metadata = await lstat(this.statePath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4 * 1024 * 1024)
        throw new Error("Invalid Agent access state");
      const bytes = await readFile(this.statePath, "utf8");
      value = JSON.parse(bytes);
      this.diskStateFingerprint = hash(`${identity(metadata)}\0${bytes}`);
    } catch (error) {
      if (missing(error)) return;
      throw new Error("Cannot read Agent access state; no files were changed", {
        cause: error
      });
    }
    if (!value || typeof value !== "object" || value.version !== 1 || !Array.isArray(value.relations))
      throw new Error("Invalid Agent access state; no files were changed");
    const state = value;
    const keys = /* @__PURE__ */ new Set();
    for (const record of state.relations) {
      if (!record || typeof record !== "object")
        throw new Error("Invalid Agent access state");
      assertName(record.name);
      const agent = this.agent(record.agentId);
      const key = `${record.agentId}\0${record.name}`;
      if (keys.has(key) || !["symlink", "copy"].includes(record.mode) || record.sourcePath !== join(this.sharedDirectory, record.name) || !agent.skillDirectories.some(
        (directory) => record.targetPath === join(resolve(directory), record.name)
      ) || typeof record.sourceRealPath !== "string" || !isAbsolute(record.sourceRealPath) || resolve(record.sourceRealPath) !== record.sourceRealPath || typeof record.targetDirectoryRealPath !== "string" || !isAbsolute(record.targetDirectoryRealPath) || typeof record.targetIdentity !== "string" || !/^\d+:\d+:\d+(?:\.\d+)?$/.test(record.targetIdentity) || record.mode === "copy" && (typeof record.copiedHash !== "string" || !/^[a-f0-9]{64}$/.test(record.copiedHash)) || record.mode === "symlink" && record.copiedHash !== void 0)
        throw new Error("Invalid Agent access state; no files were changed");
      keys.add(key);
    }
    this.state = structuredClone(state);
  }
  async scan(agentId) {
    const agent = this.agent(agentId);
    let targetDirectory = resolve(agent.skillDirectories[0]);
    for (const directory of agent.skillDirectories) {
      try {
        if ((await stat(directory)).isDirectory()) {
          targetDirectory = resolve(directory);
          break;
        }
      } catch (error) {
        if (!missing(error)) break;
      }
    }
    const universal = getUniversalInstallTarget();
    const sharedReader = (/* @__PURE__ */ new Set([...universal.agentIds, ...universal.hiddenAgentIds])).has(
      agent.id
    ) || targetDirectory === this.sharedDirectory;
    if (sharedReader) targetDirectory = this.sharedDirectory;
    const names = new Set(
      this.state.relations.filter((record) => record.agentId === agentId).map((record) => record.name)
    );
    let sourceNames = [];
    try {
      sourceNames = await readdir(this.sharedDirectory);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const guardedRoots = [];
    try {
      guardedRoots.push(await realpath(this.sharedDirectory));
    } catch {
      guardedRoots.push(this.sharedDirectory);
    }
    for (const name of sourceNames) {
      try {
        assertName(name);
        const sourcePath = join(this.sharedDirectory, name);
        const metadata = await stat(join(sourcePath, "SKILL.md"));
        if (metadata.isFile()) {
          names.add(name);
          guardedRoots.push(await realpath(sourcePath));
        }
      } catch {
      }
    }
    let parentFingerprint = "shared";
    let parentRealPath = this.sharedDirectory;
    let parentError;
    if (!sharedReader) {
      try {
        const parents = await inspectParents(targetDirectory, guardedRoots);
        parentFingerprint = parents.fingerprint;
        parentRealPath = parents.canonical;
      } catch (error) {
        parentError = error;
        parentFingerprint = "unsafe";
      }
    }
    const inspections = /* @__PURE__ */ new Map();
    for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
      const sourcePath = join(this.sharedDirectory, name);
      const relation = this.state.relations.find(
        (record) => record.agentId === agentId && record.name === name
      );
      const targetPath = relation?.targetPath ?? join(targetDirectory, name);
      const entry = {
        name,
        sourcePath,
        targetPath,
        mode: sharedReader ? "shared" : relation?.mode ?? null,
        ownership: sharedReader ? "shared" : relation ? "managed" : "external",
        status: "missing",
        actions: []
      };
      let source;
      let sourceRealPath;
      let sourceError;
      let sourcePathIdentity;
      let sourceLink;
      try {
        const sourceMetadata = await lstat(sourcePath);
        sourcePathIdentity = identity(sourceMetadata);
        if (sourceMetadata.isSymbolicLink())
          sourceLink = await readlink(sourcePath);
        sourceRealPath = await realpath(sourcePath);
        source = await readTree(sourceRealPath);
        if (identity(await lstat(sourcePath)) !== sourcePathIdentity || await realpath(sourcePath) !== sourceRealPath)
          throw new Error("Skill changed while reading");
      } catch (error) {
        sourceError = error;
      }
      if (sourceError) source = void 0;
      if (sourceRealPath) entry.resolvedSourcePath = sourceRealPath;
      const facts = [
        sourcePathIdentity,
        sourceLink,
        sourceRealPath,
        source?.identity,
        source?.hash,
        sourceError ? missing(sourceError) ? "missing" : "unreadable" : null
      ];
      const inspection = {
        entry,
        source,
        sourceRealPath,
        sourcePathIdentity,
        fingerprint: ""
      };
      if (sharedReader) {
        entry.status = source ? "shared" : missing(sourceError) ? "source-missing" : "unreadable";
      } else if (parentError || dirname(targetPath) !== targetDirectory || relation && relation.targetDirectoryRealPath !== parentRealPath) {
        entry.status = "unreadable";
      } else {
        try {
          const target = await pathStats(targetPath);
          inspection.targetIdentity = target ? identity(target) : void 0;
          facts.push(inspection.targetIdentity);
          if (!target) {
            entry.status = source ? "missing" : missing(sourceError) ? "source-missing" : "unreadable";
            if (relation) {
              entry.actions = ["disconnect"];
              if (source && sourceRealPath === relation.sourceRealPath && relation.mode === "symlink")
                entry.actions.unshift("repair");
            } else if (source) entry.actions = ["connect"];
          } else if (target.isSymbolicLink()) {
            entry.mode = "symlink";
            const link = await readlink(targetPath);
            inspection.targetLink = resolve(dirname(targetPath), link);
            let actual;
            try {
              actual = await realpath(targetPath);
            } catch (error) {
              if (!missing(error)) throw error;
            }
            entry.actualTargetPath = actual ?? inspection.targetLink;
            facts.push(link, actual);
            const ownLink = relation?.mode === "symlink" && inspection.targetIdentity === relation.targetIdentity && inspection.targetLink === relation.sourceRealPath;
            const correctLink = sourceRealPath && actual === sourceRealPath;
            if (relation && !ownLink) entry.status = "conflict";
            else if (correctLink && source) {
              entry.status = "linked";
              if (ownLink) entry.actions = ["disconnect"];
            } else if (ownLink && !source) {
              entry.status = missing(sourceError) ? "source-missing" : "unreadable";
              entry.actions = ["disconnect"];
            } else if (ownLink) {
              entry.status = actual ? "conflict" : "broken";
              entry.actions = ["disconnect"];
            } else entry.status = actual ? "conflict" : "broken";
          } else if (target.isDirectory()) {
            entry.mode = "copy";
            const copied = await readTree(targetPath);
            inspection.targetHash = copied.hash;
            facts.push(copied.hash);
            if (relation?.mode === "copy" && inspection.targetIdentity === relation.targetIdentity) {
              if (copied.hash !== relation.copiedHash)
                entry.status = "copy-modified";
              else {
                entry.status = !source ? missing(sourceError) ? "source-missing" : "unreadable" : copied.hash === source.hash ? "copy-current" : "copy-outdated";
                entry.actions = ["disconnect"];
                if (source && sourceRealPath === relation.sourceRealPath && copied.hash !== source.hash)
                  entry.actions.unshift("update");
              }
            } else if (!relation && source && copied.hash === source.hash)
              entry.status = "copy-current";
            else entry.status = "conflict";
          } else entry.status = "conflict";
        } catch (error) {
          entry.status = "unreadable";
          facts.push(error.message);
        }
      }
      inspection.fingerprint = hash(JSON.stringify([entry, facts]));
      inspections.set(name, inspection);
    }
    const notices = !sharedReader && !parentError ? await this.recoveryNotices(targetDirectory) : [];
    return {
      snapshot: {
        agentId,
        agentName: agent.name,
        sharedDirectory: this.sharedDirectory,
        targetDirectory,
        readsSharedDirectory: sharedReader,
        scannedAt: (/* @__PURE__ */ new Date()).toISOString(),
        entries: [...inspections.values()].map((value) => value.entry),
        ...notices.length ? { notices } : {}
      },
      inspections,
      parentFingerprint,
      parentRealPath,
      guardedRoots
    };
  }
  async recoveryNotices(directory) {
    const notices = [];
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort(
        (a, b) => a.name.localeCompare(b.name)
      )) {
        if (!entry.isDirectory() || !RECOVERY_DIRECTORY_NAME.test(entry.name))
          continue;
        const path = join(directory, entry.name);
        try {
          const metadata = await lstat(path);
          if (metadata.isDirectory() && !metadata.isSymbolicLink() && !this.activeTransactions.has(await realpath(path)))
            notices.push({ kind: "recovery-retained", path });
        } catch {
        }
      }
    } catch {
    }
    return notices;
  }
  operation(inspected, input) {
    const entry = inspected.entry;
    if (!entry.actions.includes(input.action)) return "blocked";
    if (input.action === "connect")
      return input.mode === "symlink" ? "create-link" : "create-copy";
    if (input.action === "update")
      return entry.mode === "copy" ? "update-copy" : "blocked";
    if (input.action === "repair")
      return entry.mode === "symlink" ? "repair-link" : "blocked";
    if (!inspected.targetIdentity) return "forget";
    return entry.mode === "symlink" ? "remove-link" : "remove-copy";
  }
  async applyPreview(previewId) {
    await this.initialize();
    if (typeof previewId !== "string")
      throw new Error("Invalid preview identifier");
    const stored = this.previews.get(previewId);
    this.previews.delete(previewId);
    if (!stored || stored.expires <= Date.now())
      throw new Error("Access preview expired; preview again");
    if (stored.preview.entries.some((entry) => entry.operation === "blocked"))
      throw new Error("Preview contains blocked operations");
    await this.assertDiskState();
    if (JSON.stringify(this.state) !== stored.stateFingerprint)
      throw new Error("Access state changed; preview again");
    const scan = await this.scan(stored.input.agentId);
    if (scan.parentFingerprint !== stored.parentFingerprint || stored.input.skillNames.some(
      (name) => scan.inspections.get(name)?.fingerprint !== stored.fingerprints.get(name)
    ))
      throw new Error("Access preview is stale; preview again");
    const originalState = structuredClone(this.state);
    const nextState = structuredClone(this.state);
    const createdParents = [];
    const mutations = [];
    let transaction;
    let transactionIdentity;
    let stateTemp;
    let activeParentFingerprint = scan.parentFingerprint;
    const assertParents = async () => {
      const current = await inspectParents(
        scan.snapshot.targetDirectory,
        scan.guardedRoots
      );
      if (current.fingerprint !== activeParentFingerprint)
        throw new Error("Agent Skill parent changed during apply");
    };
    try {
      const needsDisk = stored.preview.entries.some(
        (entry) => entry.operation !== "forget"
      );
      if (needsDisk) {
        const missingParents = [];
        for (let path = scan.snapshot.targetDirectory; !await pathStats(path); path = dirname(path))
          missingParents.unshift(path);
        await assertParents();
        for (const path of missingParents) {
          await mkdir(path);
          createdParents.push({ path, identity: identity(await lstat(path)) });
        }
        activeParentFingerprint = (await inspectParents(scan.snapshot.targetDirectory, scan.guardedRoots)).fingerprint;
        transaction = join(
          scan.snapshot.targetDirectory,
          `.skill-shelf-access-${randomUUID()}`
        );
        this.activeTransactions.add(
          join(scan.parentRealPath, basename(transaction))
        );
        await mkdir(transaction, { mode: 448 });
        transactionIdentity = identity(await lstat(transaction));
        for (const [index, entry] of stored.preview.entries.entries()) {
          const inspected = scan.inspections.get(entry.name);
          if (["create-copy", "update-copy"].includes(entry.operation))
            await writeTree(
              join(transaction, `new-${index}`),
              inspected.source
            );
          if (["create-link", "repair-link"].includes(entry.operation))
            await symlink(
              inspected.sourceRealPath,
              join(transaction, `new-${index}`),
              "dir"
            );
        }
      }
      const checked = await this.scan(stored.input.agentId);
      if (stored.input.skillNames.some(
        (name) => checked.inspections.get(name)?.fingerprint !== stored.fingerprints.get(name)
      ))
        throw new Error("Access preview is stale; preview again");
      await assertParents();
      await mkdir(dirname(this.statePath), { recursive: true });
      stateTemp = join(
        dirname(this.statePath),
        `.agent-access-${randomUUID()}.tmp`
      );
      for (const [index, entry] of stored.preview.entries.entries()) {
        const inspected = scan.inspections.get(entry.name);
        await assertParents();
        await this.verifySource(inspected);
        await this.verifyTarget(inspected, entry.targetPath);
        const current = await pathStats(entry.targetPath);
        if ((current ? identity(current) : void 0) !== inspected.targetIdentity)
          throw new Error("Agent Skill entry changed during apply");
        const recordIndex = nextState.relations.findIndex(
          (record) => record.agentId === stored.input.agentId && record.name === entry.name
        );
        if (recordIndex !== -1) nextState.relations.splice(recordIndex, 1);
        if (entry.operation === "forget") continue;
        const mutation = {
          target: entry.targetPath,
          inspected
        };
        mutations.push(mutation);
        if (current) {
          const backup = join(transaction, `old-${index}`);
          await rename(entry.targetPath, backup);
          mutation.backup = backup;
          await this.verifyTarget(inspected, backup);
        }
        if (["create-link", "create-copy", "update-copy", "repair-link"].includes(
          entry.operation
        )) {
          await rename(join(transaction, `new-${index}`), entry.targetPath);
          mutation.installedIdentity = identity(await lstat(entry.targetPath));
          const mode = entry.operation.includes("copy") ? "copy" : "symlink";
          mutation.installedHash = mode === "copy" ? inspected.source.hash : void 0;
          mutation.installedLink = mode === "symlink" ? inspected.sourceRealPath : void 0;
          nextState.relations.push({
            agentId: stored.input.agentId,
            name: entry.name,
            sourcePath: entry.sourcePath,
            sourceRealPath: inspected.sourceRealPath,
            targetPath: entry.targetPath,
            targetDirectoryRealPath: scan.parentRealPath,
            mode,
            targetIdentity: mutation.installedIdentity,
            ...mode === "copy" ? { copiedHash: inspected.source.hash } : {}
          });
        }
      }
      await writeFile(stateTemp, `${JSON.stringify(nextState, null, 2)}
`, {
        mode: 384,
        flag: "wx"
      });
      const nextDiskFingerprint = hash(
        `${identity(await lstat(stateTemp))}\0${JSON.stringify(nextState, null, 2)}
`
      );
      await assertParents();
      await this.assertDiskState();
      for (const mutation of mutations)
        if (mutation.backup)
          await this.verifyTarget(mutation.inspected, mutation.backup);
      await rename(stateTemp, this.statePath);
      stateTemp = void 0;
      this.state = nextState;
      this.diskStateFingerprint = nextDiskFingerprint;
    } catch (error) {
      this.state = originalState;
      const failures = [];
      for (const mutation of [...mutations].reverse()) {
        if (!mutation.backup && !mutation.installedIdentity) continue;
        try {
          await assertParents();
          const current = await pathStats(mutation.target);
          if (current) {
            if (identity(current) !== mutation.installedIdentity)
              throw new Error("Rollback destination was changed externally");
            if (mutation.installedHash && (await readTree(mutation.target)).hash !== mutation.installedHash)
              throw new Error("Rollback copy was changed externally");
            if (mutation.installedLink && resolve(
              dirname(mutation.target),
              await readlink(mutation.target)
            ) !== mutation.installedLink)
              throw new Error("Rollback link was changed externally");
            await rm(mutation.target, { recursive: true, force: true });
          }
          if (mutation.backup) await rename(mutation.backup, mutation.target);
        } catch (rollbackError) {
          failures.push(rollbackError);
        }
      }
      if (failures.length)
        throw new AggregateError(
          [error, ...failures],
          `Agent access failed; recovery files retained at ${transaction}`
        );
      if (transaction) {
        await assertParents();
        if (identity(await lstat(transaction)) !== transactionIdentity)
          throw new Error("Transaction directory changed externally");
        await rm(transaction, { recursive: true, force: true });
        transaction = void 0;
      }
      for (const parent of [...createdParents].reverse()) {
        try {
          if (identity(await lstat(parent.path)) === parent.identity)
            await rmdir(parent.path);
        } catch {
        }
      }
      throw error;
    } finally {
      if (stateTemp) await rm(stateTemp, { force: true }).catch(() => void 0);
    }
    const notices = [];
    if (transaction) {
      try {
        await assertParents();
        if (identity(await lstat(transaction)) !== transactionIdentity)
          throw new Error("Transaction directory changed externally");
        for (const mutation of mutations)
          if (mutation.backup)
            await this.verifyTarget(mutation.inspected, mutation.backup);
        await rm(transaction, { recursive: true, force: true });
      } catch (error) {
        notices.push({ kind: "recovery-retained", path: transaction });
        console.warn(
          `Agent access committed; recovery files retained at ${transaction}`,
          error
        );
      }
    }
    try {
      const snapshot = (await this.scan(stored.input.agentId)).snapshot;
      const combined = new Map(
        [...snapshot.notices ?? [], ...notices].map((notice) => [
          JSON.stringify(notice),
          notice
        ])
      );
      return combined.size ? { ...snapshot, notices: [...combined.values()] } : snapshot;
    } catch {
      return {
        ...scan.snapshot,
        scannedAt: (/* @__PURE__ */ new Date()).toISOString(),
        notices: [
          ...scan.snapshot.notices ?? [],
          ...notices,
          { kind: "refresh-failed" }
        ],
        entries: scan.snapshot.entries.map((entry) => {
          const operation = stored.preview.entries.find(
            (item) => item.name === entry.name
          )?.operation;
          if (!operation) return entry;
          if (["remove-link", "remove-copy", "forget"].includes(operation))
            return {
              ...entry,
              ownership: "external",
              mode: null,
              actualTargetPath: void 0,
              status: "unreadable",
              actions: []
            };
          return {
            ...entry,
            ownership: "managed",
            mode: operation.includes("copy") ? "copy" : "symlink",
            status: "unreadable",
            actions: []
          };
        })
      };
    }
  }
  async verifySource(inspected) {
    if (!inspected.source) return;
    const metadata = await lstat(inspected.entry.sourcePath);
    const canonical = await realpath(inspected.entry.sourcePath);
    if (identity(metadata) !== inspected.sourcePathIdentity || canonical !== inspected.sourceRealPath)
      throw new Error("Shared Skill changed during apply");
    const tree = await readTree(canonical);
    if (tree.identity !== inspected.source.identity || tree.hash !== inspected.source.hash)
      throw new Error("Shared Skill changed during apply");
  }
  async verifyTarget(inspected, path) {
    const metadata = await pathStats(path);
    if ((metadata ? identity(metadata) : void 0) !== inspected.targetIdentity)
      throw new Error("Agent Skill entry changed during apply");
    if (inspected.targetHash && (await readTree(path)).hash !== inspected.targetHash)
      throw new Error("Agent Skill copy changed during apply");
    if (inspected.targetLink && resolve(dirname(path), await readlink(path)) !== inspected.targetLink)
      throw new Error("Agent Skill link changed during apply");
  }
  async assertDiskState() {
    let fingerprint = null;
    const metadata = await pathStats(this.statePath);
    if (metadata) {
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4 * 1024 * 1024)
        throw new Error("Agent access state changed externally");
      fingerprint = hash(
        `${identity(metadata)}\0${await readFile(this.statePath, "utf8")}`
      );
    }
    if (fingerprint !== this.diskStateFingerprint)
      throw new Error("Agent access state changed externally");
  }
}
export {
  AgentAccessService
};
