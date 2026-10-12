import { expect, test } from '@playwright/test';
import http from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixture } from '../scripts/test-fixtures.mjs';
import { connectWorkbench } from '../src/runtime.mjs';

test('The local entry opens the actual fallback workbench and its browser API uses that port', async ({ page }) => {
  const fixture = await createFixture({ gateway: true });
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
    const remembered = await page.evaluate(() => localStorage.getItem('shelf-last-location'));
    await page.goto(`${connected.url}/#settings`);
    await expect(page.getByRole('navigation', { name: '\u8bbe\u7f6e\u5206\u7c7b', exact: true })).toBeVisible();
    await expect(page.locator('.settings-content').getByRole('heading', { name: '\u901a\u7528', exact: true })).toBeVisible();
    await expect(page).toHaveURL(`${connected.url}/#settings`);
    expect(await page.evaluate(() => localStorage.getItem('shelf-last-location'))).toBe(remembered);
    await page.goBack();
    await expect(page).toHaveURL(`${connected.url}/#workbench`);
    await expect(page.getByRole('heading', { name: '\u672c\u5730 Skill \u5de5\u4f5c\u53f0', exact: true })).toBeVisible();
    await page.goForward();
    await expect(page).toHaveURL(`${connected.url}/#settings`);
    await expect(page.getByRole('navigation', { name: '\u8bbe\u7f6e\u5206\u7c7b', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '\u8fd4\u56de', exact: true }).click();
    await expect(page.getByRole('heading', { name: '\u672c\u5730 Skill \u5de5\u4f5c\u53f0', exact: true })).toBeVisible();
    await expect(page).toHaveURL(`${connected.url}/#workbench`);
    await page.evaluate(() => {
      localStorage.setItem('shelf-ui:preferences', JSON.stringify({ startupPage: 'workbench', rememberLocation: true }));
      localStorage.setItem('shelf-last-location', '#skills:global');
    });
    await page.goto(`${connected.url}/#settings`);
    await page.reload();
    await expect(page.getByRole('navigation', { name: '\u8bbe\u7f6e\u5206\u7c7b', exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('shelf-last-location'))).toBe('#skills:global');
    await page.getByRole('button', { name: '\u8fd4\u56de', exact: true }).click();
    await expect(page).toHaveURL(`${connected.url}/#skills:global`);
    await expect(page.locator('.status-title')).toHaveText('Skills');
    expect(await page.evaluate(() => localStorage.getItem('shelf-last-location'))).toBe('#skills:global');
    expect(fixture.gateway.requests).toHaveLength(0);
    expect(await (await fetch(`http://127.0.0.1:${preferred}`)).text()).toBe('foreign application');
  } finally {
    await connected?.app?.close();
    await new Promise<void>(resolve => { foreign.close(() => resolve()); foreign.closeAllConnections(); });
    await fixture.cleanup();
  }
});
