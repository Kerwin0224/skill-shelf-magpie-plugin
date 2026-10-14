import { createHash } from 'node:crypto';
import { ShelfError } from './domain.mjs';

export const MAX_SYNC_BYTES = 100 * 1024 * 1024;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_LIBRARY_BYTES = 64 * 1024 * 1024;
export const MAX_FILES = 10000;
const fail = (message = 'Invalid sync document.', status = 400) => { throw new ShelfError(status, message); };
const object = value => { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(); return value; };
const string = (value, max, empty = false) => {
  if (typeof value !== 'string' || value.length > max || value.includes('\0') || (!empty && !value.trim())) fail();
  return value.trim();
};
const array = (value, max) => { if (!Array.isArray(value) || value.length > max) fail(); return value; };
const hex = value => { if (typeof value !== 'string' || !/^#[a-f0-9]{6}$/i.test(value)) fail(); return value; };
const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
export const managedFilesHash = files => digest(JSON.stringify(files));
export const portableKey = value => value.normalize('NFC').toLowerCase();
const folderKey = names => JSON.stringify(names.map(portableKey));
const identity = (value, fingerprint = false) => {
  if (value === null) return null;
  string(value, 2048);
  if (!(fingerprint ? /^sha256:[a-f0-9]{64}$/ : /^(github:|url:https:\/\/|sha256:[a-f0-9]{64}$)/).test(value)) fail();
  return value;
};
const coordinates = value => {
  if (value === null) return null;
  object(value);
  if (!['x', 'y'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 20000)) fail('Sync positions must be between 0 and 20000.');
  return { x: value.x, y: value.y };
};
const tags = value => [...new Set(array(value, 12).map(tag => string(tag, 32)))];
const locale = value => {
  try { if (value.length > 48 || Intl.getCanonicalLocales(value)[0] !== value) fail(); } catch { fail(); }
};
function viewOptions(value) {
  object(value);
  for (const key of ['alignToGrid', 'useGroups']) if (typeof value[key] !== 'boolean') fail();
  const sorts = ['kind', 'name', 'source', 'tags', 'update-status'];
  if (!sorts.includes(value.groupBy) || ![...sorts, 'none'].includes(value.sortBy) || !['ascending', 'descending'].includes(value.sortDirection) || !['canvas', 'columns', 'list'].includes(value.viewMode)) fail();
}
export { viewOptions as validateFinderViewOptions };
export function assertPortablePath(value) {
  if (typeof value !== 'string' || value.length > 1024 || /[\\:*?"<>|\x00-\x1f]/.test(value)) fail('Unsafe synced Skill path.');
  const parts = value.split('/');
  if (parts.length > 32 || parts.some(part => !part || part === '.' || part === '..' || /[ .]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || portableKey(part) === '.git')) fail('Unsafe synced Skill path.');
  return value;
}
export function assertPortableTree(files) {
  const paths = new Set();
  const directories = new Map();
  for (const file of files) {
    assertPortablePath(file.path);
    const key = portableKey(file.path);
    if (paths.has(key)) fail('Duplicate synced Skill file paths.');
    paths.add(key);
  }
  for (const file of files) {
    const parts = file.path.split('/');
    while (parts.length > 1) {
      parts.pop();
      const directory = parts.join('/');
      const key = portableKey(directory);
      if (paths.has(key) || (directories.has(key) && directories.get(key) !== directory)) fail('Synced Skill file/directory collision.');
      directories.set(key, directory);
    }
  }
}
export function skillFingerprint(files) {
  const document = files.find(file => file.path === 'SKILL.md');
  if (!document) fail('Synced Skill is missing SKILL.md.');
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(document.content, 'base64')).replace(/\r\n/g, '\n').trim(); } catch { fail('SKILL.md must be UTF-8 text.'); }
  if (!content || content.includes('\0')) fail('SKILL.md must be nonempty text.');
  return digest(content);
}
function member(value) {
  object(value);
  value.name = string(value.name, 256);
  identity(value.identity);
  identity(value.fingerprint, true);
  if (value.copyId !== undefined) string(value.copyId, 128);
  if (value.packName !== undefined) value.packName = string(value.packName, 64);
}
function validatePacks(packs) {
  const names = new Set();
  for (const pack of array(packs, 1000)) {
    object(pack);
    pack.name = string(pack.name, 64);
    pack.description = string(pack.description, 500, true);
    if (names.has(portableKey(pack.name))) fail('Duplicate synced Pack names.');
    names.add(portableKey(pack.name));
    if (pack.sort !== undefined && !['manual', 'name-asc', 'name-desc'].includes(pack.sort)) fail();
    if (pack.groups !== undefined && pack.folders !== undefined) fail();
    const paths = new Set();
    const groups = new Set();
    for (const group of pack.groups === undefined ? [] : array(pack.groups, 100)) {
      const key = portableKey(string(group, 64));
      if (groups.has(key)) fail();
      groups.add(key);
      paths.add(folderKey([group.trim()]));
    }
    if (pack.groups !== undefined) pack.groups = pack.groups.map(group => group.trim());
    for (const folder of pack.folders === undefined ? [] : array(pack.folders, 100)) {
      object(folder);
      folder.path = array(folder.path, 32).map(name => string(name, 64));
      if (!folder.path.length || paths.has(folderKey(folder.path))) fail();
      paths.add(folderKey(folder.path));
      if (folder.color !== undefined) hex(folder.color);
      if (folder.position !== undefined) folder.position = coordinates(folder.position);
    }
    for (const folder of pack.folders ?? []) if (folder.path.length > 1 && !paths.has(folderKey(folder.path.slice(0, -1)))) fail('Missing synced Pack parent folder.');
    for (const entry of array(pack.skills, 10000)) {
      member(entry);
      if (entry.group !== undefined && entry.folderPath !== undefined) fail();
      if (entry.folderPath != null) {
        const names = array(entry.folderPath, 32).map(name => string(name, 64));
        if (!paths.has(folderKey(names))) fail('Missing synced Pack member folder.');
        entry.folderPath = names;
      }
      if (entry.group != null) {
        entry.group = string(entry.group, 64);
        if (!groups.has(portableKey(entry.group))) fail();
      }
      if (entry.tags !== undefined) entry.tags = tags(entry.tags);
      if (entry.position !== undefined) entry.position = coordinates(entry.position);
    }
    if (pack.viewOptions !== undefined) for (const value of Object.values(object(pack.viewOptions))) viewOptions(value);
  }
}
function validateAi(document) {
  if (document.aiPreferences !== undefined) {
    const settings = object(document.aiPreferences);
    object(settings.availableModels);
    if (!['relevant-text', 'skill-md'].includes(settings.contextMode)) fail();
    locale(string(settings.targetLanguage, 48));
    object(settings.models);
    for (const role of ['analysis', 'chat', 'writing']) {
      const selection = object(settings.models[role]);
      if (selection.provider !== 'deepseek') fail();
      string(selection.model, 160);
      if (/[\r\n]/.test(selection.model)) fail();
    }
    for (const [provider, models] of Object.entries(settings.availableModels)) {
      if (provider !== 'deepseek') fail();
      const seen = new Set();
      if (!array(models, 40).length) fail();
      for (const model of models) {
        object(model); string(model.id, 160); string(model.displayName, 80);
        if (/[\r\n]/.test(model.id) || seen.has(model.id.trim())) fail();
        seen.add(model.id.trim());
        if (model.description !== undefined) string(model.description, 4000, true);
        if (model.shortName !== undefined) string(model.shortName, 256, true);
      }
    }
    for (const role of ['analysis', 'chat', 'writing']) if (!settings.availableModels[settings.models[role].provider]?.some(model => model.id.trim() === settings.models[role].model.trim())) fail('AI model selection references an unavailable model.');
  }
  if (document.aiConnections !== undefined) {
    if (![3, 4, 5].includes(document.version) || document.aiPreferences === undefined) fail();
    if (document.version === 3) {
      const encrypted = object(document.aiConnections);
      if (encrypted.cipher !== 'aes-256-gcm' || encrypted.kdf !== 'scrypt') fail();
      for (const [key, length] of [['salt', 16], ['iv', 12], ['tag', 16], ['ciphertext', null]]) {
        string(encrypted[key], 128 * 1024);
        const bytes = Buffer.from(encrypted[key], 'base64');
        if (!bytes.length || bytes.length > 64 * 1024 || bytes.toString('base64') !== encrypted[key] || (length !== null && bytes.length !== length)) fail('Invalid encrypted AI payload.');
      }
    } else {
      const seen = new Set();
      for (const connection of array(document.aiConnections, 1)) {
        object(connection);
        if (connection.provider !== 'deepseek' || seen.has(connection.provider) || typeof connection.enabled !== 'boolean') fail();
        seen.add(connection.provider);
        if (connection.apiKey !== null) {
          string(connection.apiKey, 512);
          if (connection.apiKey.length < 8 || connection.apiKey !== connection.apiKey.trim() || /[\r\n]/.test(connection.apiKey)) fail('Invalid AI connection.');
        }
        if (connection.enabled && !connection.apiKey) fail('Enabled AI connections require an API key.');
      }
    }
  }
}
export function parseSyncDocument(contents) {
  if (typeof contents !== 'string') fail('Sync document must be JSON text.');
  if (Buffer.byteLength(contents) > MAX_SYNC_BYTES) fail('Sync document exceeds the 100 MiB JSON limit.', 413);
  let document;
  try { document = object(JSON.parse(contents)); } catch { fail('Invalid sync JSON document.'); }
  if (document.format !== 'skill-shelf-metadata' || ![1, 2, 3, 4, 5].includes(document.version) || typeof document.exportedAt !== 'string' || !Number.isFinite(Date.parse(document.exportedAt))) fail('Not a Skill Shelf metadata sync document.');
  object(document.preferences);
  if (document.source !== undefined) {
    object(document.source);
    if (!/^[a-f\d-]{36}$/i.test(document.source.deviceId)) fail();
    string(document.source.deviceName, 128); string(document.source.appVersion, 64, true);
  }
  for (const skill of array(document.skills, 10000)) {
    object(skill); skill.name = string(skill.name, 256); identity(skill.identity);
    if (!['global', 'project'].includes(skill.scope)) fail();
    if (skill.scope === 'project') skill.projectName = string(skill.projectName, 256);
    skill.tags = tags(skill.tags); skill.position = coordinates(skill.position);
    for (const folder of array(skill.folder, 32)) {
      object(folder); folder.name = string(folder.name, 48); hex(folder.color); folder.position = coordinates(folder.position);
      if (folder.viewOptions !== undefined) viewOptions(folder.viewOptions);
    }
    for (const [language, value] of Object.entries(object(skill.descriptions))) { locale(language); string(value, 4000); }
    for (const [language, value] of Object.entries(object(skill.translations))) {
      locale(language); object(value); value.content = string(value.content, 4000); value.sourceDescription = string(value.sourceDescription, 4000);
      if (typeof value.translatedAt !== 'string' || !Number.isFinite(Date.parse(value.translatedAt))) fail();
    }
    if (Object.keys(skill.descriptions).length > 100 || Object.keys(skill.translations).length > 100) fail();
  }
  if (document.packs !== undefined) validatePacks(document.packs);
  if (document.managedSkills !== undefined && document.version !== 5) fail('Managed Skills require sync version 5.');
  let totalBytes = 0;
  let totalFiles = 0;
  const copies = new Set();
  for (const skill of document.managedSkills === undefined ? [] : array(document.managedSkills, 10000)) {
    member(skill); string(skill.description, 4000, true);
    if (!['global', 'project'].includes(skill.sourceScope) || !/^sha256:[a-f0-9]{64}$/.test(skill.contentHash) || skill.fingerprint === null) fail();
    const key = `${portableKey(skill.packName ?? '')}\0${skill.copyId ?? `${skill.name}\0${skill.identity ?? skill.fingerprint}`}`;
    if (copies.has(key)) fail('Duplicate synced independent copy.');
    copies.add(key);
    const files = array(skill.files, MAX_FILES).map(file => {
      object(file); assertPortablePath(file.path);
      if (typeof file.executable !== 'boolean' || typeof file.content !== 'string' || file.content.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 || file.content.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.content)) fail('Invalid synced Skill file.');
      const bytes = Buffer.from(file.content, 'base64');
      if (bytes.toString('base64') !== file.content) fail('Noncanonical synced file base64.');
      totalBytes += bytes.length;
      if (bytes.length > MAX_FILE_BYTES || totalBytes > MAX_LIBRARY_BYTES || ++totalFiles > MAX_FILES) fail('Sync exceeds the 20 MiB/file, 64 MiB/library or 10000 file limit.', 413);
      return { path: file.path, content: file.content, executable: file.executable };
    }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    assertPortableTree(files);
    if (skillFingerprint(files) !== skill.fingerprint || managedFilesHash(files) !== skill.contentHash) fail('Synced Skill hashes do not match its files.');
    skill.files = files;
  }
  validateAi(document);
  return document;
}
