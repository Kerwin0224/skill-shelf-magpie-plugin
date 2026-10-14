import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ShelfError } from './domain.mjs';

const names = ['AGENTS.md', 'CLAUDE.md'];
const MAX_BYTES = 1024 * 1024;
const digest = value => createHash('sha256').update(value).digest('hex');
const hasCode = (error, code) => error?.code === code;
const fail = (message, status = 400) => { throw new ShelfError(status, message); };

export class ProjectInstructionsService {
  tail = Promise.resolve();

  constructor(getProjects, backupDirectory) {
    this.getProjects = getProjects;
    this.backupDirectory = backupDirectory;
  }

  async root(projectId) {
    if (typeof projectId !== 'string') fail('Invalid project instructions');
    const project = (await this.getProjects()).find(item => item.id === projectId);
    if (!project) fail('Project is no longer available', 404);
    try {
      return await realpath(project.path);
    } catch (error) {
      if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR')) fail('Project is no longer available', 404);
      throw error;
    }
  }

  async get(projectId) {
    const root = await this.root(projectId);
    const [agents, claude] = await Promise.all(names.map(name => readInstruction(root, name)));
    return { projectId, projectPath: root, files: { 'AGENTS.md': agents, 'CLAUDE.md': claude }, claudeUsesAgents: importsAgents(claude.content) };
  }

  save(input) {
    return this.mutate(async () => {
      if (!input || !names.includes(input.name) || typeof input.content !== 'string' || input.content.includes('\0') || Buffer.byteLength(input.content) > MAX_BYTES) fail('Invalid project instructions');
      const root = await this.root(input.projectId);
      await this.write(root, input.name, input.content, input.expectedRevision);
      return this.get(input.projectId);
    });
  }

  connectClaude(input) {
    return this.mutate(async () => {
      if (!input) fail('Invalid project instructions');
      const root = await this.root(input.projectId);
      const agents = await readInstruction(root, 'AGENTS.md');
      if (!agents.exists || !agents.content.trim()) fail('Project instructions must be saved first');
      const claude = await readInstruction(root, 'CLAUDE.md');
      assertRevision(claude, input.expectedRevision);
      if (!importsAgents(claude.content)) {
        const newline = claude.content.includes('\r\n') ? '\r\n' : '\n';
        const separator = claude.content ? (claude.content.endsWith(newline) ? newline : newline + newline) : '';
        await this.write(root, 'CLAUDE.md', claude.content + separator + '@AGENTS.md' + newline, input.expectedRevision);
      }
      return this.get(input.projectId);
    });
  }

  mutate(operation) {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  async write(root, name, content, expected) {
    const current = await readInstruction(root, name);
    assertRevision(current, expected);
    if (current.exists && current.content === content) return;
    if (current.exists) {
      const directory = join(this.backupDirectory, digest(root));
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, `${name}.${Date.now()}.${randomUUID()}.bak`), current.content, { mode: 0o600, flag: 'wx' });
    }
    const temporary = join(root, `.${name}.${randomUUID()}.tmp`);
    try {
      const mode = current.exists ? (await lstat(join(root, name))).mode & 0o777 : 0o644;
      await writeFile(temporary, content, { flag: 'wx', mode });
      if (current.exists) await chmod(temporary, mode);
      // Retain edits made in another editor while preparing the atomic replacement.
      assertRevision(await readInstruction(root, name), expected);
      if (current.exists) await rename(temporary, join(root, name));
      else {
        try {
          await link(temporary, join(root, name));
        } catch (error) {
          if (hasCode(error, 'EEXIST')) fail('Project instructions changed externally', 409);
          throw error;
        }
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

async function readInstruction(root, name) {
  const unavailable = () => ({ name, content: '', exists: true, readOnly: true, revision: null });
  let file;
  try {
    if ((await lstat(join(root, name))).isSymbolicLink()) return unavailable();
    file = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return { name, content: '', exists: false, readOnly: false, revision: null };
    if (['ELOOP', 'EACCES', 'EPERM', 'EISDIR'].some(code => hasCode(error, code))) return unavailable();
    throw error;
  }
  try {
    const stats = await file.stat();
    if (!stats.isFile() || stats.size > MAX_BYTES) return unavailable();
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    if (bytes.length > MAX_BYTES || bytes.includes(0)) return unavailable();
    let content;
    try {
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return unavailable();
    }
    return { name, content, exists: true, readOnly: !(stats.mode & 0o222), revision: digest(content) };
  } finally {
    await file.close();
  }
}

function assertRevision(file, expected) {
  if (file.readOnly) fail('Project instruction file is read-only', 403);
  if (expected !== file.revision) fail('Project instructions changed externally', 409);
}

export function importsAgents(content) {
  const instructions = content.replace(/(?:^|\n)[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]{0,3}\1[ \t]*(?=\n|$)|$)|`[^`\n]*`/g, '');
  return /(?:^|[\s(])@(?:\.\/)?AGENTS\.md(?=$|[\s),;]|\.(?:\s|$))/m.test(instructions);
}
