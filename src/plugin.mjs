import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { DEFAULT_PORT, absolutePath, connectWorkbench, defaultMagpieDir, openOnce, peerAt } from './runtime.mjs';

let instance;

// The only exported function is the OpenCode-compatible plugin entry point.
export default async function SkillShelfPlugin(input = {}, options = {}) {
  const homeDir = homedir();
  const magpieDir = absolutePath(input.directory, defaultMagpieDir(homeDir), homeDir);
  const dataDir = absolutePath(options.dataDir, join(magpieDir, 'skill-shelf'), homeDir);
  const port = options.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Skill Shelf port must be between 1024 and 65535.');
  if (options.open !== undefined && typeof options.open !== 'boolean') throw new Error('Skill Shelf open must be a boolean.');
  if (instance) {
    if (instance.dataDir !== dataDir || instance.port !== port) throw new Error('Only one Skill Shelf profile can run in each plugin host.');
    return instance.hooks;
  }
  const settings = { dataDir, homeDir, magpieDir, port };
  const current = { ...settings, app: null, url: null, stopping: false, checking: null, timer: null };
  const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  async function enabled() {
    try {
      const list = JSON.parse(await readFile(join(magpieDir, 'plugins.json'), 'utf8')).plugins;
      if (!Array.isArray(list)) throw new Error('Invalid Magpie plugins.json.');
      return list.some((entry) => {
        if (entry.off || typeof entry.spec !== 'string') return false;
        return resolve(entry.spec) === packageDir || resolve(entry.spec) === fileURLToPath(import.meta.url)
          || /(?:^|\/|:)skill-shelf-magpie-plugin(?:\.git)?(?:#.*|@[^/]*)?$/.test(entry.spec);
      });
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      throw error;
    }
  }
  function ensure() {
    if (current.stopping) return Promise.resolve();
    if (current.checking) return current.checking;
    current.checking = (async () => {
      if (!await enabled()) {
        current.stopping = true;
        clearInterval(current.timer);
        await current.app?.close();
        current.app = null;
        if (instance === current) instance = undefined;
        return;
      }
      if (current.app) return;
      if (current.url) {
        try { await peerAt(Number(new URL(current.url).port), dataDir); return; }
        catch {}
      }
      const connected = await connectWorkbench(settings);
      current.app = connected.app;
      if (current.url !== connected.url) {
        current.url = connected.url;
        await input.client?.app?.log?.({ body: { service: 'skill-shelf', level: 'info', message: `Skill Shelf workbench: ${current.url}` } });
        if (options.open === true && !current.stopping) {
          openOnce(current.url, dataDir).catch((error) => console.error(`Skill Shelf: ${error.message} Open ${current.url} manually.`));
        }
      }
    })().finally(() => { current.checking = null; });
    return current.checking;
  }
  async function dispose() {
    current.stopping = true;
    clearInterval(current.timer);
    await current.checking;
    await current.app?.close();
    current.app = null;
    if (instance === current) instance = undefined;
  }
  // Magpie exposes OAuth methods as buttons; these open pages without saving an account.
  current.hooks = {
    auth: {
      provider: 'skill-shelf',
      methods: [
        { label: '\u6253\u5f00 Skill Shelf', url: null },
        { label: 'GitHub', url: 'https://github.com/voidrinz/skill-shelf-magpie-plugin' },
      ].map(({ label, url }) => ({
        type: 'oauth',
        label,
        async authorize() {
          await ensure();
          if (current.stopping || !current.url) throw new Error('Enable Skill Shelf in Magpie before opening the workbench.');
          if (!url) await peerAt(Number(new URL(current.url).port), dataDir);
          return {
            url: url ?? `${current.url}/`,
            instructions: '\u6b64\u5165\u53e3\u53ea\u6253\u5f00\u9875\u9762\uff0c\u4e0d\u662f\u4f9b\u5e94\u5546\u767b\u5f55\u3002\u65e0\u9700\u5bc6\u94a5\u6216\u9a8c\u8bc1\u7801\uff1b\u9875\u9762\u6253\u5f00\u540e\u53ef\u4ee5\u53d6\u6d88\u6b64\u7a97\u53e3\u3002',
            method: 'code',
            callback: async () => ({ type: 'failed' }),
          };
        },
      })),
      async loader() { return {}; },
    },
    async config(config) {
      config.provider ??= {};
      config.provider['skill-shelf'] = { name: 'Skill Shelf', models: {} };
    },
  };
  try { await ensure(); }
  catch (error) { await dispose(); throw error; }
  if (current.stopping) return {};
  instance = current;
  current.timer = setInterval(() => {
    ensure().catch((error) => console.error('Skill Shelf:', error.message));
  }, 2000);
  current.timer.unref?.();
  current.dispose = dispose;
  return current.hooks;
}

export const _internal = { dispose: async () => instance?.dispose() };
