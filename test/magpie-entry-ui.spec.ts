import { expect, test } from '@playwright/test';
import { access, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const assets = process.env.MAGPIE_GUI_ASSETS || '/Users/laz/Coding/github/magpie/internal/gui/assets';
const repository = 'https://github.com/voidrinz/skill-shelf-magpie-plugin';
const contentTypes: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const methods = [
  { type: 'oauth', label: '\u6253\u5f00 Skill Shelf' },
  { type: 'oauth', label: 'GitHub' },
];

test('Magpie shows both launch choices before authorization and its remaining sign-in UI can be canceled', async ({ page }) => {
  try { await access(join(assets, 'app.js')); }
  catch { test.skip(true, 'Set MAGPIE_GUI_ASSETS to the Magpie internal/gui/assets checkout'); }
  const asked: number[] = [];
  const callbacks: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  // Render the real host assets against isolated APIs; never open GitHub or a live workbench.
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'magpie.test') return route.abort();
    const json = (data: unknown) => route.fulfill({ json: data });
    if (url.pathname === '/boot.js') return route.fulfill({ contentType: 'text/javascript', body: 'window.bootPrefs = {lang:"zh",theme:"light",web:false};' });
    if (url.pathname === '/wails/runtime.js') return route.fulfill({ contentType: 'text/javascript', body: 'export const Window = {};' });
    if (url.pathname === '/api/state') return json({ agents: [], profiles: [], settings: { lang: 'zh', theme: 'light' } });
    if (url.pathname === '/api/providers') return json({
      providers: [{ id: 'openai', name: 'OpenAI', icon: 'openai', preset: 'openai', models: [], agents: [], key: { set: true, masked: 'fixture' } }],
      presets: [], excluded: [], gateway: { running: true, window: true },
      plugins: [{ id: 'skill-shelf', pid: 'skill-shelf', name: 'Skill Shelf', icon: 'generic', spec: 'skill-shelf-magpie-plugin', signedIn: false, models: 0, methods }],
    });
    if (url.pathname === '/api/groups') return json({ groups: [], pools: [] });
    if (url.pathname === '/api/gateway/trace') return json({ routes: [] });
    if (url.pathname === '/api/plugin-signin/prompt') return json({ prompt: null, inputs: {} });
    if (url.pathname === '/api/plugin-signin') {
      const { method } = route.request().postDataJSON();
      asked.push(method);
      return json({ id: 'launch', agent: 'skill-shelf', state: 'waiting', url: method === 0 ? 'http://127.0.0.1:47822/' : repository, pasteCode: true, instructions: '\u9875\u9762\u6253\u5f00\u540e\u53ef\u4ee5\u53d6\u6d88\u6b64\u7a97\u53e3\u3002' });
    }
    if (url.pathname.endsWith('/callback')) callbacks.push(url.pathname);
    if (url.pathname === '/api/signin/launch') return json({ id: 'launch', agent: 'skill-shelf', state: 'waiting' });
    if (url.pathname.startsWith('/api/')) return json({});
    const file = join(assets, url.pathname === '/' ? 'index.html' : url.pathname);
    const contentType = contentTypes[extname(file)] || 'application/octet-stream';
    try { await route.fulfill({ body: await readFile(file), contentType }); }
    catch { await route.fulfill({ status: 404, body: '' }); }
  });
  await page.goto('http://magpie.test/?view=providers');
  await page.locator('#addProvider').click();
  const sheet = page.locator('#addSheet');
  const tile = sheet.locator('.tile[data-pick="Skill Shelf"]');
  const box = sheet.locator('.signing');
  for (const method of [0, 1]) {
    await tile.click();
    await expect(box.locator('.choices button')).toHaveText(methods.map(item => item.label));
    expect(asked).toHaveLength(method);
    await expect(box.getByRole('textbox', { name: '\u9a8c\u8bc1\u7801', exact: true })).toHaveCount(0);
    await box.getByRole('button', { name: methods[method].label, exact: true }).click();
    await expect(box.locator('.signlink code')).toHaveText(method === 0 ? 'http://127.0.0.1:47822/' : repository);
    // Two methods restore the picker, not a pure-open protocol: acknowledge the host form.
    await expect(box.getByRole('textbox', { name: '\u9a8c\u8bc1\u7801', exact: true })).toBeVisible();
    await box.getByRole('button', { name: '\u53d6\u6d88', exact: true }).click();
    await expect(box).toHaveCount(0);
  }
  expect(asked).toEqual([0, 1]);
  expect(callbacks).toEqual([]);
  expect(errors).toEqual([]);
});
