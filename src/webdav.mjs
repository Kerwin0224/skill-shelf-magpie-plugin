// Skill Shelf desktop-compatible WebDAV transport and snapshot protocol.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { MAX_SYNC_BYTES, parseSyncDocument } from "./sync-format.mjs";
class WebDavSyncService {
  constructor(path, request = fetch) {
    this.path = path;
    this.request = request;
  }
  config = null;
  passwordNeedsReentry = false;
  initializing = null;
  #revision = 0;
  #operationQueue = Promise.resolve();
  #remoteRevisions = new WeakMap();
  getRevision() {
    return this.#revision;
  }
  #run(action) {
    // A save cannot switch URL or credentials halfway through a multi-request operation.
    const operation = this.#operationQueue.then(action);
    this.#operationQueue = operation.catch(() => {});
    return operation;
  }
  async getStatus() {
    await this.initialize();
    return {
      url: this.config?.url ?? "",
      username: this.config?.username ?? "",
      hasPassword: Boolean(this.config?.password),
      passwordNeedsReentry: this.passwordNeedsReentry
    };
  }
  async save(value) {
    const input = validateWebDavInput(value);
    return this.#run(() => this.saveInput(input));
  }
  async saveInput(input) {
    await this.initialize().catch(() => {
      this.config = null;
    });
    const sameAccount = this.config?.url === input.url && this.config.username === input.username;
    if (sameAccount && this.passwordNeedsReentry && !input.password)
      throw new Error("Sync WebDAV password required");
    const password = input.password === void 0 && sameAccount ? this.config?.password ?? "" : input.password ?? "";
    const saved = {
      version: 1,
      url: input.url,
      username: input.username,
      password
    };
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(saved), {
        mode: 0o600,
        flag: "wx"
      });
      await rename(temporary, this.path);
    } finally {
      await unlink(temporary).catch(() => {
      });
    }
    this.config = { ...input, password };
    this.passwordNeedsReentry = false;
    this.initializing = Promise.resolve();
    this.#revision++;
    return this.getStatus();
  }
  async test() {
    return this.#run(() => this.ensureFolder());
  }
  async read() {
    return this.#run(async () => {
      const remote = await this.readRemote();
      this.#remoteRevisions.set(remote, this.#revision);
      return remote;
    });
  }
  async readRemote() {
    await this.initialize();
    const folder = this.syncFolder();
    let response = await this.send(
      new URL("skill-shelf-metadata.json", folder),
      { method: "GET" },
      [404]
    );
    let legacyFolderUrl;
    // Older desktop clients stored the shared document directly at the configured URL.
    if (response.status === 404 && folder.href !== this.config.url) {
      await response.body?.cancel();
      response = await this.send(
        "skill-shelf-metadata.json",
        { method: "GET" },
        [404]
      );
      if (response.status !== 404) legacyFolderUrl = this.config.url;
    }
    if (response.status === 404) {
      await response.body?.cancel();
      await this.ensureFolder();
      return { contents: null, etag: null };
    }
    const contents = await boundedText(response).catch((error) => {
      if (error instanceof Error && error.message === "Invalid sync document")
        throw error;
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
        throw new Error("Sync WebDAV timeout");
      throw new Error("Sync WebDAV network error");
    });
    parseSyncDocument(contents);
    return {
      contents,
      etag: response.headers.get("etag"),
      ...legacyFolderUrl ? { folderUrl: legacyFolderUrl } : {}
    };
  }
  async upload(contents, previous, backup) {
    return this.#run(() => this.uploadRemote(contents, previous, backup));
  }
  async uploadRemote(contents, previous, backup) {
    parseSyncDocument(contents);
    if (this.#remoteRevisions.has(previous) && this.#remoteRevisions.get(previous) !== this.#revision)
      throw new Error("Sync WebDAV connection changed");
    await this.initialize();
    let folder = this.syncFolder();
    if (previous.folderUrl !== void 0) {
      if (previous.folderUrl !== this.config.url)
        throw new Error("Sync WebDAV invalid snapshot location");
      folder = new URL(previous.folderUrl);
    }
    const file = new URL("skill-shelf-metadata.json", folder);
    if (previous.contents !== null && !strongEtag(previous.etag))
      throw new Error("Sync WebDAV requires an ETag");
    const options = {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...previous.contents === null ? { "If-None-Match": "*" } : { "If-Match": previous.etag }
      },
      body: contents
    };
    let response = await this.send(file, options, [404, 409]);
    if (response.status === 404 || response.status === 409) {
      await response.body?.cancel();
      await this.ensureFolder(folder);
      response = await this.send(file, options, [404, 409]);
      if (response.status === 404 || response.status === 409) {
        await response.body?.cancel();
        throw new Error("Sync WebDAV folder unavailable");
      }
    }
    await response.body?.cancel();
    if (backup) {
      // The shared write is committed; a failed history write must not imply otherwise.
      try {
        await this.saveBackup(backup);
        return true;
      } catch {
        return false;
      }
    }
  }
  async listSnapshots() {
    return this.#run(() => this.listRemoteSnapshots());
  }
  async listRemoteSnapshots() {
    const remote = await this.readRemote();
    const { entries } = await this.readBackupIndex();
    const shared = remote.contents ? parseSyncDocument(remote.contents) : null;
    return [
      ...shared ? [snapshotInfo("shared", "shared", shared)] : [],
      ...entries.sort(
        (a, b) => Date.parse(b.exportedAt) - Date.parse(a.exportedAt)
      )
    ];
  }
  async readSnapshot(id) {
    return this.#run(() => this.readRemoteSnapshot(id));
  }
  async readRemoteSnapshot(id) {
    if (id === "shared") {
      const remote = await this.readRemote();
      if (!remote.contents) throw new Error("Sync WebDAV has no data");
      return remote.contents;
    }
    if (!/^[a-f\d-]{36}$/i.test(id)) throw new Error("Invalid sync snapshot");
    const { entries } = await this.readBackupIndex();
    if (!entries.some((entry) => entry.id === id))
      throw new Error("Sync snapshot unavailable");
    const response = await this.send(
      new URL(`backups/${id}.json`, this.syncFolder()),
      { method: "GET" },
      [404]
    );
    if (response.status === 404) {
      await response.body?.cancel();
      throw new Error("Sync snapshot unavailable");
    }
    const contents = await boundedText(response);
    parseSyncDocument(contents);
    return contents;
  }
  async readBackupIndex() {
    await this.initialize();
    const response = await this.send(
      new URL("backups/index.json", this.syncFolder()),
      { method: "GET" },
      [404]
    );
    if (response.status === 404) {
      await response.body?.cancel();
      return {
        entries: await this.recoverBackupHistory([]),
        etag: null,
        exists: false
      };
    }
    const etag = response.headers.get("etag");
    const contents = await boundedText(response);
    const { version, entries } = parseBackupIndex(contents);
    return {
      entries: version === 1 ? await this.recoverBackupHistory(entries) : entries,
      etag,
      exists: true
    };
  }
  async recoverBackupHistory(entries) {
    const folder = new URL("backups/", this.syncFolder());
    const response = await this.send(
      folder,
      {
        method: "PROPFIND",
        headers: { Depth: "1", "Content-Type": "application/xml" },
        body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>'
      },
      [404]
    );
    if (response.status === 404) {
      await response.body?.cancel();
      return entries;
    }
    const ids = backupIdsFromListing(await boundedText(response), folder);
    const known = new Set(entries.map((entry) => entry.id));
    const recovered = [...entries];
    // A v1 index retained only the latest backup per device; recover older files too.
    const missing = ids.filter((id) => !known.has(id));
    for (let start = 0; start < missing.length; start += 4) {
      const batch = await Promise.all(
        missing.slice(start, start + 4).map(async (id) => {
          const response2 = await this.send(
            new URL(`${id}.json`, folder),
            {
              method: "GET"
            },
            [404]
          );
          if (response2.status === 404) {
            await response2.body?.cancel();
            return null;
          }
          const contents = await boundedText(response2);
          try {
            const document = parseSyncDocument(contents);
            return snapshotInfo(id, "device", document);
          } catch {
            return null;
          }
        })
      );
      recovered.push(...batch.filter((entry) => entry !== null));
    }
    return recovered;
  }
  async saveBackup(document) {
    const contents = JSON.stringify(document, null, 2);
    const parsed = parseSyncDocument(contents);
    if (!parsed.source) throw new Error("Sync device identity unavailable");
    const folder = new URL("backups/", this.syncFolder());
    await this.ensureFolder(folder);
    const id = randomUUID();
    const response = await this.send(new URL(`${id}.json`, folder), {
      method: "PUT",
      headers: { "Content-Type": "application/json", "If-None-Match": "*" },
      body: contents
    });
    await response.body?.cancel();
    // Retry only the index, merging fresh entries so concurrent devices retain history.
    for (let attempt = 0; attempt < 4; attempt++) {
      const { entries, etag, exists } = await this.readBackupIndex();
      if (exists && !strongEtag(etag))
        throw new Error("Sync WebDAV requires an ETag");
      const next = [
        snapshotInfo(id, "device", parsed),
        ...entries.filter((entry) => entry.id !== id)
      ];
      const body = JSON.stringify({ version: 2, entries: next });
      parseBackupIndex(body);
      const response2 = await this.send(
        new URL("index.json", folder),
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            ...etag ? { "If-Match": etag } : { "If-None-Match": "*" }
          },
          body
        },
        [412]
      );
      await response2.body?.cancel();
      if (response2.status !== 412) return;
    }
    throw new Error("Sync backup index changed");
  }
  async probeFolder(url) {
    const response = await this.send(
      url,
      {
        method: "PROPFIND",
        headers: { Depth: "0", "Content-Type": "application/xml" },
        body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>'
      },
      [404]
    );
    await response.body?.cancel();
    return response.status !== 404;
  }
  syncFolder() {
    if (!this.config) throw new Error("Sync WebDAV is not configured");
    const base = new URL(this.config.url);
    return /\/SkillShelf\/$/i.test(base.pathname) ? base : new URL("SkillShelf/", base);
  }
  async ensureFolder(folder) {
    await this.initialize();
    if (!this.config) throw new Error("Sync WebDAV is not configured");
    const missing = [];
    let current = folder ?? this.syncFolder();
    // Probe upwards, then create missing collections from their existing parent down.
    while (!await this.probeFolder(current)) {
      if (current.pathname === "/")
        throw new Error("Sync WebDAV folder unavailable");
      missing.push(current);
      current = new URL("..", current);
    }
    for (const folder2 of missing.reverse()) {
      const response = await this.send(folder2, { method: "MKCOL" }, "all");
      const status = response.status;
      await response.body?.cancel();
      if (response.ok) continue;
      if ((status === 405 || status === 409) && await this.probeFolder(folder2))
        continue;
      throw new Error(`Sync WebDAV folder creation HTTP ${status}`);
    }
  }
  async initialize() {
    if (!this.initializing)
      this.initializing = (async () => {
        try {
          const saved = JSON.parse(
            await readFile(this.path, "utf8")
          );
          if (!saved || saved.version !== void 0 && saved.version !== 1)
            throw new Error();
          if (saved.password !== void 0 && typeof saved.password !== "string")
            throw new Error();
          // Unversioned desktop credentials were system-encrypted: require reentry, not Keychain access.
          const input = validateWebDavInput({
            ...saved,
            password: saved.version === 1 ? saved.password : void 0
          });
          this.config = input;
          this.passwordNeedsReentry = saved.version === void 0 && Boolean(saved.password);
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
            return;
          throw new Error("Sync credentials unavailable");
        }
      })();
    const initializing = this.initializing;
    try {
      await initializing;
    } catch (error) {
      if (this.initializing === initializing) this.initializing = null;
      throw error;
    }
  }
  async send(file, options, allowedStatuses = []) {
    await this.initialize();
    const config = this.config;
    if (!config) throw new Error("Sync WebDAV is not configured");
    if (this.passwordNeedsReentry)
      throw new Error("Sync WebDAV password required");
    let response;
    try {
      response = await this.request(new URL(file, config.url), {
        ...options,
        redirect: "error",
        signal: AbortSignal.timeout(15e3),
        headers: {
          ...options.headers,
          ...config.username || config.password ? {
            Authorization: `Basic ${Buffer.from(`${config.username}:${config.password ?? ""}`).toString("base64")}`
          } : {}
        }
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
        throw new Error("Sync WebDAV timeout");
      throw new Error("Sync WebDAV network error");
    }
    if (!response.ok && allowedStatuses !== "all" && !allowedStatuses.includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Sync WebDAV HTTP ${response.status}`);
    }
    return response;
  }
}
function snapshotInfo(id, kind, document) {
  return {
    id,
    kind,
    exportedAt: document.exportedAt,
    skills: document.skills.length,
    packs: document.packs?.length ?? 0,
    ...document.managedSkills ? { managedSkills: document.managedSkills.length } : {},
    ...document.source ? { source: document.source } : {}
  };
}
function backupIdsFromListing(contents, folder) {
  const ids = /* @__PURE__ */ new Set();
  const entities = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'"
  };
  for (const match of contents.matchAll(
    /<(?:[\w.-]+:)?href\b[^>]*>([^<]*)<\/(?:[\w.-]+:)?href\s*>/gi
  )) {
    try {
      const href = match[1].trim().replace(
        /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
        (_entity, value) => {
          if (value.startsWith("#"))
            return String.fromCodePoint(
              value[1]?.toLowerCase() === "x" ? Number.parseInt(value.slice(2), 16) : Number.parseInt(value.slice(1), 10)
            );
          return entities[value.toLowerCase()];
        }
      );
      const url = new URL(href, folder);
      if (url.origin !== folder.origin || url.search || url.hash) continue;
      if (new URL(".", url).pathname !== folder.pathname) continue;
      const filename = decodeURIComponent(
        url.pathname.slice(folder.pathname.length)
      );
      if (/^[a-f\d-]{36}\.json$/i.test(filename)) ids.add(filename.slice(0, -5));
    } catch {
      continue;
    }
  }
  return [...ids];
}
function parseBackupIndex(contents) {
  try {
    const index = JSON.parse(contents);
    if (Buffer.byteLength(contents) > MAX_SYNC_BYTES || ![1, 2].includes(index?.version) || !Array.isArray(index.entries))
      throw new Error();
    const ids = /* @__PURE__ */ new Set();
    const entries = index.entries.map(
      (entry) => {
        if (!entry || !/^[a-f\d-]{36}$/i.test(entry.id) || entry.kind !== "device" || typeof entry.exportedAt !== "string" || !Number.isFinite(Date.parse(entry.exportedAt)) || !Number.isInteger(entry.skills) || entry.skills < 0 || entry.skills > 1e4 || !Number.isInteger(entry.packs) || entry.packs < 0 || entry.packs > 1e3 || entry.managedSkills !== void 0 && (!Number.isInteger(entry.managedSkills) || entry.managedSkills < 0 || entry.managedSkills > 1e4) || ids.has(entry.id))
          throw new Error();
        const source = entry.source === void 0 ? void 0 : parseSyncSource(entry.source);
        ids.add(entry.id);
        return {
          id: entry.id,
          kind: "device",
          exportedAt: entry.exportedAt,
          skills: entry.skills,
          packs: entry.packs,
          ...entry.managedSkills !== void 0 ? { managedSkills: entry.managedSkills } : {},
          ...source ? { source } : {}
        };
      }
    );
    return { version: index.version, entries };
  } catch {
    throw new Error("Invalid sync backup index");
  }
}
function validateWebDavInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid sync WebDAV settings");
  const input = value;
  if (typeof input.url !== "string" || input.url.length > 2048 || typeof input.username !== "string" || input.username.length > 256 || input.username.includes(":") || /[\r\n]/.test(input.username) || input.password !== void 0 && (typeof input.password !== "string" || input.password.length > 4096))
    throw new Error("Invalid sync WebDAV settings");
  try {
    if (/[\x00-\x20\x7f]/.test(input.url.trim())) throw new Error();
    const url = new URL(input.url.trim());
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
      throw new Error();
    if (url.username || url.password || url.href.includes("?") || url.href.includes("#"))
      throw new Error();
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return {
      url: url.href,
      username: input.username.trim(),
      password: input.password
    };
  } catch {
    throw new Error("Invalid sync WebDAV URL");
  }
}
async function boundedText(response) {
  if (Number(response.headers.get("content-length")) > MAX_SYNC_BYTES) {
    await response.body?.cancel();
    throw new Error("Invalid sync document");
  }
  if (!response.body) throw new Error("Invalid sync document");
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_SYNC_BYTES) throw new Error("Invalid sync document");
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "Invalid sync document") throw error;
    if (error?.name === "TimeoutError" || error?.name === "AbortError") throw new Error("Sync WebDAV timeout");
    throw new Error("Sync WebDAV network error");
  } finally {
    await reader.cancel().catch(() => {
    });
  }
  return Buffer.concat(chunks).toString("utf8");
}
function strongEtag(value) {
  return typeof value === "string" && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value);
}
function parseSyncSource(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid sync document");
  const source = value;
  if (typeof source.deviceId !== "string" || !/^[a-f\d-]{36}$/i.test(source.deviceId) || typeof source.deviceName !== "string" || !source.deviceName.trim() || source.deviceName.length > 128 || typeof source.appVersion !== "string" || source.appVersion.length > 64) throw new Error("Invalid sync document");
  return { deviceId: source.deviceId, deviceName: source.deviceName.trim(), appVersion: source.appVersion };
}
export {
  WebDavSyncService,
  validateWebDavInput
};
