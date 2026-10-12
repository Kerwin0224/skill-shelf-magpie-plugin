import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PORT, absolutePath, defaultMagpieDir, launchBrowser, startWorkbench } from './runtime.mjs';

const args = process.argv.slice(2);
const config = { port: DEFAULT_PORT, open: true, dev: false };
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (key === '--help' || key === '-h') {
    console.log('Skill Shelf workbench\n\nnode dist/cli.mjs [--port 47822] [--no-open] [--data-dir PATH] [--home-dir PATH] [--magpie-dir PATH]');
    process.exit(0);
  }
  if (key === '--no-open') { config.open = false; continue; }
  if (key === '--dev') { config.dev = true; continue; }
  if (!['--port', '--data-dir', '--home-dir', '--magpie-dir'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--')) {
    throw new Error(`Unknown option or missing value: ${key}. Use --help.`);
  }
  const value = args[++i];
  if (key === '--port') config.port = Number(value);
  else config[{ '--data-dir': 'dataDir', '--home-dir': 'homeDir', '--magpie-dir': 'magpieDir' }[key]] = value;
}
config.homeDir = absolutePath(config.homeDir, homedir());
config.magpieDir = absolutePath(config.magpieDir, defaultMagpieDir(config.homeDir), config.homeDir);
config.dataDir = absolutePath(config.dataDir, join(config.magpieDir, 'skill-shelf'), config.homeDir);
const app = await startWorkbench(config);
console.log(`Skill Shelf: ${app.url}\nData: ${config.dataDir}\nScanning and AI do not change Skill files. Press Ctrl+C to stop.`);
if (config.open) launchBrowser(app.url).catch((error) => console.error(error.message));
let closing = false;
const stop = async () => {
  if (closing) return;
  closing = true;
  await app.close();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
