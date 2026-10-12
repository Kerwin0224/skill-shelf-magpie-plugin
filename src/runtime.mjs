import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, resolve, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, link, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { ShelfService } from './domain.mjs';
import { AIBridge } from './ai.mjs';
import { AssistantBridge } from './assistant.mjs';
import { SkillOperations } from './skill-operations.mjs';
import { SyncService } from './sync.mjs';
import { WebDavSyncService } from './webdav.mjs';
import { startServer } from './server.mjs';

export const PRODUCT = 'skill-shelf-magpie-plugin';
export const VERSION = '0.1.0';
export const DEFAULT_PORT = 47822;

export function defaultMagpieDir(home = homedir()) {
  return join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'magpie');
}

export function absolutePath(value, fallback, home = homedir()) {
  const path = value === undefined ? fallback : value;
  if (typeof path !== 'string' || !path.trim()) throw new Error('Expected an absolute directory path.');
  const expanded = path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path;
  if (!isAbsolute(expanded)) throw new Error('Directory paths must be absolute.');
  return resolve(expanded);
}

export async function webDirectory() {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, 'web'), join(here, '..', 'dist', 'web'), join(here, '..', 'web')]) {
    try { await access(join(candidate, 'index.html')); return candidate; }
    catch {}
  }
  throw new Error('Workbench assets are missing. Run pnpm build before installing the plugin.');
}

export async function launchBrowser(url) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(url)) throw new Error('Only a local workbench can be opened.');
  const program = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  await new Promise((accept, reject) => {
    const child = spawn(program, args, { stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? accept() : reject(new Error(`Could not open a browser (${program}).`)));
  });
}

export async function openOnce(url, dataDir) {
  await withProfileLock(dataDir, async () => {
    const stamp = join(dataDir, '.browser-opened');
    let session;
    try { session = JSON.parse(await readFile(join(dataDir, '.workbench.json'), 'utf8')).id; }
    catch {}
    try {
      const last = JSON.parse(await readFile(stamp, 'utf8'));
      if (last.url === url && last.session === session && Date.now() - last.time < 30_000) return;
    } catch {}
    await launchBrowser(url);
    await atomicWrite(stamp, JSON.stringify({ url, session, time: Date.now() }));
  }, '.browser-open.lock');
}

export async function startWorkbench({ dataDir, homeDir = homedir(), magpieDir, port = DEFAULT_PORT, dev = false, autoPort = !dev }) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const service = new ShelfService({ dataDir, homeDir, magpieDir });
  await service.initialize();
  const ai = new AIBridge({ service, magpieDir: magpieDir || defaultMagpieDir(homeDir) });
  const assistant = new AssistantBridge({ service, ai });
  const skills = new SkillOperations({ service });
  const sync = new SyncService({ service, ai, webdav: new WebDavSyncService(join(dataDir, 'webdav-sync.json')) });
  const settings = {
    service,
    ai,
    assistant,
    skills,
    sync,
    port,
    allowedOrigins: dev ? ['http://127.0.0.1:17131', 'http://localhost:17131'] : [],
  };
  try {
    settings.webDir = await webDirectory();
    try { return await startServer(settings); }
    catch (error) {
      if (!autoPort || error.code !== 'EADDRINUSE' || port === 0) throw error;
      // Bind port 0 directly: probing an apparently free port first would race other apps.
      return await startServer({ ...settings, port: 0 });
    }
  } catch (error) {
    assistant.close();
    ai.close();
    skills.close();
    throw error;
  }
}

export async function peerAt(port, dataDir) {
  const response = await fetch(`http://127.0.0.1:${port}/_identity`, { signal: AbortSignal.timeout(1200), redirect: 'error' });
  const identity = await response.json();
  const profile = createHash('sha256').update(await realpath(dataDir)).digest('hex');
  if (!response.ok || identity.product !== PRODUCT || identity.profile !== profile || identity.version !== VERSION) {
    throw new Error(`Port ${port} does not belong to this Skill Shelf profile and version.`);
  }
  return identity;
}

async function atomicWrite(file, text) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}

async function withProfileLock(dataDir, action, name = '.workbench-start.lock') {
  const lock = join(dataDir, name);
  const claim = `${lock}.${randomUUID()}.tmp`;
  // A hard link publishes the complete owner record atomically, including across Bun hosts.
  await writeFile(claim, JSON.stringify({ pid: process.pid, id: randomUUID() }), { mode: 0o600, flag: 'wx' });
  const deadline = Date.now() + 15_000;
  async function acquire(file) {
    for (;;) {
      if (Date.now() >= deadline) throw new Error('Another Skill Shelf host is still starting. Try enabling the plugin again.');
      try { await link(claim, file); return; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      try {
        const owner = JSON.parse(await readFile(file, 'utf8'));
        if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('Invalid workbench lock owner.');
        if (owner.id !== undefined && (typeof owner.id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(owner.id))) throw new Error('Invalid workbench lock identity.');
        try { process.kill(owner.pid, 0); }
        catch (error) {
          if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error;
          if (error.code === 'ESRCH') {
            // Serialize reapers so a late reaper cannot unlink a new host's lock.
            // Recovery locks use the same protocol if the reaper itself crashes.
            const recovery = `${file}.${owner.id || owner.pid}.recover`;
            await acquire(recovery);
            try {
              const latest = JSON.parse(await readFile(file, 'utf8'));
              if (latest.pid === owner.pid && latest.id === owner.id) await unlink(file);
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
            finally { await unlink(recovery); }
            continue;
          }
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  try {
    await acquire(lock);
    try { return await action(); }
    finally { await unlink(lock); }
  } finally { await unlink(claim).catch(() => {}); }
}

async function writeLauncher(dataDir, url) {
  const target = url ? `<p><a href="${url}/">Open Skill Shelf / &#25171;&#24320;&#20070;&#26550;</a></p><p>${url}</p>` : '<p>Start Magpie and enable Skill Shelf, then reopen this file.</p>';
  await atomicWrite(join(dataDir, 'Skill Shelf.html'), `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Skill Shelf</title>
<style>body{max-width:36rem;margin:12vh auto;padding:2rem;font:18px Georgia,serif;background:#faf7ef;color:#28251f}a{display:inline-block;padding:1rem 1.5rem;background:#28251f;color:#fff;border-radius:.5rem;text-decoration:none}p{line-height:1.6}</style>
<h1>Skill Shelf</h1>${target}<p>Keep Magpie running. This local file is updated when the workbench starts; reopen it after a restart.</p></html>\n`);
}

export async function connectWorkbench(settings) {
  const { dataDir, port = DEFAULT_PORT } = settings;
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const recordFile = join(dataDir, '.workbench.json');
  return withProfileLock(dataDir, async () => {
    let record;
    try { record = JSON.parse(await readFile(recordFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    const recordedPort = Number.isInteger(record?.port) && record.port > 0 && record.port <= 65535 ? record.port : undefined;
    for (const candidate of new Set([recordedPort, port].filter(value => value !== undefined && value !== 0))) {
      try { await peerAt(candidate, dataDir); }
      catch { continue; }
      const url = `http://127.0.0.1:${candidate}`;
      await atomicWrite(recordFile, JSON.stringify({ ...record, port: candidate, preferredPort: port }));
      await writeLauncher(dataDir, url);
      return { app: null, port: candidate, url };
    }
    const app = await startWorkbench({ ...settings, port: recordedPort && record.preferredPort === port ? recordedPort : port });
    const id = randomUUID();
    try {
      await atomicWrite(recordFile, JSON.stringify({ id, pid: process.pid, port: app.port, preferredPort: port }));
      await writeLauncher(dataDir, app.url);
    } catch (error) { await app.close(); throw error; }
    const close = app.close;
    let closing;
    app.close = () => closing ??= withProfileLock(dataDir, async () => {
      await close();
      let latest;
      try { latest = JSON.parse(await readFile(recordFile, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (latest?.id === id) {
        // Keep the last port for takeover, but do not leave a live link after a clean shutdown.
        await writeLauncher(dataDir, null);
      }
    });
    return { app, port: app.port, url: app.url };
  });
}
