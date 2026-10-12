import { expect, test, type Page, type Route } from '@playwright/test';
import type { SkillUpdateStatus, SkillsUpdateSnapshot } from '../web/src/SkillsOperations';
import type { Snapshot } from '../web/src/types';

async function snapshot(page: Page): Promise<Snapshot> {
  const session = await page.request.get('/api/session');
  const response = await page.request.get('/api/state', { headers: { 'X-Shelf-Token': (await session.json()).token } });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

function updateSnapshot(state: Snapshot, status?: SkillUpdateStatus, checkedAt = new Date().toISOString()): SkillsUpdateSnapshot {
  const summary = { current: 0, 'update-available': 0, missing: 0, unavailable: 0, unchecked: 0 };
  const checks = Object.fromEntries(state.skills.map(skill => {
    summary[status ?? 'unchecked'] += 1;
    return [skill.id, { status: status ?? 'unchecked', reason: status === 'update-available' ? 'remote-changed' : 'not-scanned', ...(status ? { checkedAt } : {}) }];
  }));
  return { scanId: status ? 'isolated-test-scan' : null, scannedAt: status ? checkedAt : null, scanning: false, updating: false, completed: 0, total: state.skills.length, checks, summary };
}

async function mockOperations(page: Page) {
  const state = await snapshot(page);
  state.organization = {}; state.folders = [];
  await page.route('**/api/state', route => route.fulfill({ json: state }));
  let updates = updateSnapshot(state);
  const calls: { operation: string; body: unknown }[] = [];
  const handlers = new Map<string, (route: Route) => Promise<void>>();
  await page.route('**/api/skills/**', async route => {
    const operation = new URL(route.request().url()).pathname.slice('/api/skills/'.length);
    if (route.request().method() === 'POST') calls.push({ operation, body: route.request().postDataJSON() });
    const handler = handlers.get(operation);
    if (handler) return handler(route);
    if (operation === 'status') return route.fulfill({ json: updates });
    if (operation === 'scan') { updates = updateSnapshot(state, 'update-available'); return route.fulfill({ json: { state, updates } }); }
    if (operation === 'update') { updates = updateSnapshot(state); return route.fulfill({ json: { success: true, message: 'Selected Skills updated.', results: state.skills.map(skill => ({ id: skill.id, success: true, message: 'Skill updated.' })), state, updates } }); }
    // Every Skills operation is intercepted; UI tests must never launch a real installer or upstream scan.
    return route.fulfill({ status: 500, json: { error: 'Unexpected isolated test operation' } });
  });
  return { state, calls, handlers, setUpdates: (value: SkillsUpdateSnapshot) => { updates = value; } };
}

async function revealSidebar(page: Page) {
  const button = page.getByRole('button', { name: '打开侧边栏', exact: true });
  if (await button.isVisible()) await button.click();
}

async function showSkills(page: Page) {
  await page.goto('/#skills:global');
  await expect(page.locator('.finder-browser')).toBeVisible();
}

test('Library retains scan/update and organizing without install or discovery controls', async ({ page }) => {
  const mock = await mockOperations(page);
  await showSkills(page);
  const header = page.locator('.finder-page-header');
  await expect(header.getByRole('button', { name: '扫描更新', exact: true })).toBeEnabled();
  await expect(header.getByRole('button', { name: '扫描后更新', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '添加 Skill', exact: true })).toHaveCount(0);
  await revealSidebar(page);
  await expect(page.getByRole('navigation', { name: 'Skill Shelf 导航', exact: true }).getByRole('button', { name: '发现', exact: true })).toHaveCount(0);
  if (await page.getByRole('button', { name: '关闭侧边栏', exact: true }).isVisible()) await page.getByRole('button', { name: '关闭侧边栏', exact: true }).click();
  const legend = page.locator('.skill-update-legend');
  await expect(legend.getByRole('button')).toHaveText(['已是最新0', '可更新0', '上游已移除0', '无法确认0', `待确认${mock.state.skills.length}`]);
  expect(await legend.getByRole('button').first().evaluate(element => getComputedStyle(element).height)).toBe('22px');
  await legend.getByRole('button', { name: /^可更新/ }).click();
  await expect(legend.getByRole('button', { name: /^可更新/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-finder-item-key^="skill:"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '群组方式', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '排序', exact: true })).toBeDisabled();
  await expect(page.locator('.finder-folder-empty')).toContainText('没有匹配项目');
  await legend.getByRole('button', { name: /^可更新/ }).click();
  await expect(page.locator('[data-finder-item-key^="skill:"]')).toHaveCount(mock.state.skills.length);
  expect(mock.calls).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('Legacy Discover links and remembered locations return to the existing-Skills organizer', async ({ page }) => {
  const mock = await mockOperations(page);
  await page.goto('/#discover');
  await expect(page.locator('.finder-browser')).toBeVisible();
  await expect(page).toHaveURL(/#skills:global$/);
  await expect(page.getByRole('textbox', { name: 'Skill 来源', exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    localStorage.setItem('shelf-ui:preferences', JSON.stringify({ startupPage: 'workbench', rememberLocation: true }));
    localStorage.setItem('shelf-last-location', '#discover');
  });
  await page.goto('/');
  await expect(page.locator('.finder-browser')).toBeVisible();
  await expect(page).toHaveURL(/#skills:global$/);
  expect(await page.evaluate(() => localStorage.getItem('shelf-last-location'))).toBe('#skills:global');
  expect(mock.calls).toEqual([]);
});

test('Empty library offers local rescan and scanning sources instead of installation', async ({ page }) => {
  const mock = await mockOperations(page);
  const installed = mock.state.skills;
  mock.state.skills = [];
  mock.setUpdates(updateSnapshot(mock.state));
  let rescans = 0;
  await page.route('**/api/rescan', async route => {
    rescans += 1;
    mock.state.skills = installed;
    await route.fulfill({ json: mock.state });
  });
  await page.goto('/#skills:global');
  const empty = page.locator('.empty-state');
  await expect(empty).toContainText('尚未发现已安装的 Skill');
  await expect(empty.getByRole('button', { name: '管理扫描来源', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /添加 Skill|安装 Skill/ })).toHaveCount(0);
  await expect(empty).not.toContainText('skills.sh');
  await empty.getByRole('button', { name: '重新扫描', exact: true }).click();
  await expect(page.locator('.finder-browser')).toBeVisible();
  await expect(page.locator('[data-finder-item-key^="skill:"]')).toHaveCount(installed.length);
  expect(rescans).toBe(1);
  expect(mock.calls).toEqual([]);
});

test('Packs still import existing Skills without offering source installation', async ({ page }) => {
  const mock = await mockOperations(page);
  await page.goto('/#packs:default');
  await expect(page.getByTestId('add-to-pack')).toHaveText('导入已安装 Skill');
  await page.getByTestId('add-to-pack').click();
  const dialog = page.getByRole('dialog', { name: `导入到 ${mock.state.packs.find(pack => pack.id === 'default')!.name}`, exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: '搜索已安装 Skill', exact: true })).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Skill 来源', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  expect(mock.calls).toEqual([]);
});

test('Scanning compares upstream before update; cancellation does not execute and explicit confirmation carries scan identity', async ({ page }) => {
  const mock = await mockOperations(page);
  await showSkills(page);
  const header = page.locator('.finder-page-header');
  await header.getByRole('button', { name: '扫描更新', exact: true }).click();
  const update = header.getByRole('button', { name: `更新 ${mock.state.skills.length} 个`, exact: true });
  await expect(update).toBeEnabled();
  expect(mock.calls.map(call => call.operation)).toEqual(['scan']);
  await update.click();
  const dialog = page.getByRole('dialog', { name: '更新 Skill', exact: true });
  await expect(dialog.locator('li')).toHaveCount(mock.state.skills.length);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect(mock.calls.map(call => call.operation)).toEqual(['scan']);
  await update.click();
  await dialog.getByRole('button', { name: `更新 ${mock.state.skills.length} 个`, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(mock.calls[1]).toEqual({ operation: 'update', body: { skillIds: mock.state.skills.map(skill => skill.id), scanId: 'isolated-test-scan', confirmed: true } });
  await expect(header.getByRole('button', { name: '扫描后更新', exact: true })).toBeDisabled();
});

test('Expired update checks use the desktop rescan label and do not allow update', async ({ page }) => {
  const mock = await mockOperations(page);
  mock.setUpdates(updateSnapshot(mock.state, 'update-available', new Date(Date.now() - 31 * 60_000).toISOString()));
  await showSkills(page);
  await expect(page.locator('.finder-page-header').getByRole('button', { name: '重新扫描后更新', exact: true })).toBeDisabled();
  expect(mock.calls).toEqual([]);
});

test('Checking and updating a single Skill scans first and only offers that Skill for confirmation', async ({ page }) => {
  const mock = await mockOperations(page);
  await showSkills(page);
  const skill = mock.state.skills[0];
  const item = page.locator(`[data-finder-item-key="skill:${skill.id}"]`);
  await item.scrollIntoViewIfNeeded();
  const bounds = (await item.boundingBox())!;
  await page.mouse.click(bounds.x + 12, bounds.y + Math.min(35, bounds.height / 2), { button: 'right' });
  await page.getByRole('menuitem', { name: '更新', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '更新 Skill', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('li')).toHaveText([`${skill.name}全局`]);
  expect(mock.calls.map(call => call.operation)).toEqual(['scan']);
  await dialog.getByRole('button', { name: '更新 1 个', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(mock.calls[1].body).toEqual({ skillIds: [skill.id], scanId: 'isolated-test-scan', confirmed: true });
});

test('Skill status and scan failures provide recovery without exposing transport internals', async ({ page }) => {
  const mock = await mockOperations(page);
  mock.handlers.set('status', route => route.fulfill({ status: 503, json: { error: 'Synthetic internal status stack' } }));
  await showSkills(page);
  await expect(page.getByRole('alert')).toContainText('无法读取 Skill 更新状态，请重试扫描。');
  await expect(page.getByRole('alert')).not.toContainText('Synthetic');
  mock.handlers.set('scan', route => route.fulfill({ status: 503, json: { error: 'Synthetic internal upstream stack' } }));
  const scan = page.locator('.finder-page-header').getByRole('button', { name: '扫描更新', exact: true });
  await scan.click();
  await expect(page.getByRole('alert')).toContainText('扫描更新失败，请稍后重试。');
  await expect(page.getByRole('alert')).not.toContainText('Synthetic');
  mock.handlers.delete('scan'); mock.handlers.delete('status');
  await scan.click();
  await expect(page.locator('.finder-page-header').getByRole('button', { name: `更新 ${mock.state.skills.length} 个`, exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(mock.calls.map(call => call.operation)).toEqual(['scan', 'scan']);
});

for (const scenario of ['missing', 'stale', 'current', 'available', 'scanning', 'updating'] as const) {
  test(`Toolbar matches desktop fixed geometry and glyphs: ${scenario}`, async ({ page }) => {
    const mock = await mockOperations(page);
    const value = updateSnapshot(mock.state, scenario === 'current' ? 'current' : scenario === 'missing' ? undefined : 'update-available', new Date(Date.now() - (scenario === 'stale' ? 31 * 60_000 : 0)).toISOString());
    value.scanning = scenario === 'scanning';
    value.updating = false;
    mock.setUpdates(value);
    await showSkills(page);
    const buttons = page.locator('.finder-page-header .heading-actions > .shelf-button');
    await expect(buttons).toHaveCount(2);
    let release: (() => void) | undefined;
    if (scenario === 'updating') {
      mock.handlers.set('update', async route => {
        await new Promise<void>(resolve => { release = resolve; });
        await route.fulfill({ json: { success: true, message: 'Updated fixture', state: mock.state, updates: updateSnapshot(mock.state) } });
      });
      await buttons.nth(1).click();
      await page.getByRole('dialog', { name: '更新 Skill', exact: true }).getByRole('button', { name: `更新 ${mock.state.skills.length} 个`, exact: true }).click();
      await expect(buttons.nth(1).locator('svg')).toHaveClass(/lucide-loader-circle/);
    }
    for (const button of await buttons.all()) {
      const geometry = await button.evaluate(element => {
        const style = getComputedStyle(element), glyph = element.querySelector('svg')!;
        const icon = getComputedStyle(glyph);
        return { height: style.height, gap: style.gap, fontSize: style.fontSize, width: icon.width, iconHeight: icon.height };
      });
      expect(geometry).toEqual({ height: '32px', gap: '4px', fontSize: '12px', width: '16px', iconHeight: '16px' });
    }
    await expect(buttons.nth(0).locator('svg')).toHaveClass(/lucide-refresh-cw/);
    await expect(buttons.nth(1).locator('svg')).toHaveClass(scenario === 'updating' ? /lucide-loader-circle/ : /lucide-circle-arrow-up/);
    if (scenario === 'scanning') {
      await expect(buttons.nth(0)).toHaveText('正在扫描…');
      expect(await buttons.nth(0).locator('svg').evaluate(element => ({ duration: getComputedStyle(element).animationDuration, box: getComputedStyle(element).transformBox }))).toEqual({ duration: '1s', box: 'fill-box' });
    }
    if (scenario === 'available') await expect(buttons.nth(1)).toBeEnabled();
    else await expect(buttons.nth(1)).toBeDisabled();
    if (scenario === 'updating') {
      expect(mock.calls.map(call => call.operation)).toEqual(['update']);
      release?.();
      await expect(page.getByRole('dialog', { name: '更新 Skill', exact: true })).toHaveCount(0);
    } else expect(mock.calls).toEqual([]);
  });
}

