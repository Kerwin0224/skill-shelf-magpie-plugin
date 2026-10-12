import { expect, test } from '@playwright/test';
import http from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixture } from '../scripts/test-fixtures.mjs';
import { connectWorkbench } from '../src/runtime.mjs';

test('The local entry opens the actual fallback workbench and its browser API uses that port', async ({ page }) => {
  const fixture = await createFixture();
  const foreign = http.createServer((_request, response) => response.end('foreign application'));
  let connected;
  try {
    await new Promise<void>((resolve, reject) => foreign.listen(0, '127.0.0.1', resolve).once('error', reject));
    const preferred = (foreign.address() as import('node:net').AddressInfo).port;
    connected = await connectWorkbench({ ...fixture, port: preferred });
    expect(connected.port).not.toBe(preferred);
    await page.goto(pathToFileURL(join(fixture.dataDir, 'Skill Shelf.html')).href);
    const entry = page.getByRole('link', { name: /Open Skill Shelf/ });
    await expect(entry).toHaveAttribute('href', `${connected.url}/`);
    await entry.click();
    await expect(page).toHaveURL(new RegExp(`^${connected.url}/`));
    await expect(page.getByRole('heading', { name: '本地 Skill 工作台', exact: true })).toBeVisible();
    const state = await page.evaluate(async () => {
      const { token } = await (await fetch('/api/session')).json();
      return (await fetch('/api/state', { headers: { 'X-Shelf-Token': token } })).json();
    });
    expect(state.skills).toHaveLength(2);
    expect(state.dataDir).toBe(fixture.dataDir);
    expect(await (await fetch(`http://127.0.0.1:${preferred}`)).text()).toBe('foreign application');
  } finally {
    await connected?.app?.close();
    await new Promise<void>(resolve => { foreign.close(() => resolve()); foreign.closeAllConnections(); });
    await fixture.cleanup();
  }
});
