import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { Snapshot } from '../web/src/types';

type Connection = { url: string; username: string; hasPassword: boolean; passwordNeedsReentry: boolean };
type Call = { path: string; method: string; body?: Record<string, unknown> };
const documentFixture = { version: 1, exportedAt: '2026-10-12T08:00:00Z', source: { deviceName: 'Desktop fixture' }, packs: [], metadata: {} };
const previewFixture = {
  id: 'preview-fixture', mode: 'import', exportedAt: documentFixture.exportedAt, source: documentFixture.source,
  matched: 2, skipped: 1, added: 1, changed: 2,
  total: 3, unchanged: 0, localOnly: 0,
  packs: { total: 1, changed: 1, matchedMembers: 5 },
  managedSkills: { total: 5, added: 1, updated: 2, unchanged: 2 },
  conflicts: [
    { id: 'tags-conflict', skillName: 'Research fixture', field: 'tags', local: '["local-tag"]', incoming: '["desktop-tag"]' },
    { id: 'folder-conflict', skillName: 'Research fixture', field: 'folder', local: 'Local folder', incoming: 'Desktop folder' },
  ],
  warnings: [],
};

async function showSidebar(page: Page) {
  const back = page.getByRole('button', { name: '返回', exact: true });
  if (await back.isVisible()) await back.click();
  const trigger = page.getByRole('button', { name: '打开侧边栏', exact: true });
  if (await trigger.isVisible()) await trigger.click();
}

async function openSync(page: Page) {
  await showSidebar(page);
  await page.getByRole('navigation', { name: '应用设置', exact: true }).getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置分类', exact: true }).getByRole('button', { name: '云同步', exact: true }).click();
  await expect(page.getByTestId('settings-sync')).toHaveAttribute('aria-busy', 'false');
}

async function stateSnapshot(page: Page): Promise<Snapshot> {
  const session = await page.request.get('/api/session');
  const response = await page.request.get('/api/state', { headers: { 'X-Shelf-Token': (await session.json()).token } });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function mockSync(page: Page) {
  const calls: Call[] = [];
  const options: {
    connection: Connection; configFailure: boolean; oldBackend?: boolean; applyFailure: boolean; cloudBackupSaved?: boolean; snapshot?: Snapshot; conflicts?: typeof previewFixture.conflicts; applyGate?: Promise<void>;
  } = {
    connection: { url: 'https://dav.example.test/shared/', username: 'desktop-user', hasPassword: true, passwordNeedsReentry: false },
    configFailure: false, applyFailure: false, cloudBackupSaved: true,
  };
  await page.route('**/api/sync/**', async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace('/api/sync/', '');
    const method = req.method();
    const body = method === 'POST' ? req.postDataJSON() as Record<string, unknown> : undefined;
    calls.push({ path, method, ...(body ? { body } : {}) });
    let result: unknown;
    if (path === 'webdav' && method === 'GET') {
      if (options.oldBackend) return route.fulfill({ status: 404, json: { error: 'Unknown workbench operation.' } });
      if (options.configFailure) return route.fulfill({ status: 503, json: { error: 'Fixture connection read failure' } });
      result = options.connection;
    } else if (path === 'webdav' && body) {
      const accountChanged = body.url !== options.connection.url || body.username !== options.connection.username;
      options.connection = { url: String(body.url), username: String(body.username), hasPassword: !!body.password || (!accountChanged && options.connection.hasPassword), passwordNeedsReentry: false };
      result = options.connection;
    } else if (path === 'test') result = { connected: true };
    else if (path === 'export') result = documentFixture;
    else if (path === 'preview' || path === 'pull' || path === 'upload') result = { ...previewFixture, ...(options.conflicts ? { conflicts: options.conflicts } : {}), mode: path === 'upload' ? 'upload' : 'import' };
    else if (path === 'apply') {
      if (options.applyGate) await options.applyGate;
      if (options.applyFailure) return route.fulfill({ status: 409, json: { error: 'Sync preview is stale; preview again.' } });
      const uploading = calls.some(call => call.path === 'upload');
      result = { ...(options.snapshot ? { snapshot: options.snapshot } : {}), ...(uploading ? { uploaded: true, ...(options.cloudBackupSaved !== undefined ? { cloudBackupSaved: options.cloudBackupSaved } : {}) } : {}) };
    } else return route.fulfill({ status: 404, json: { error: 'Unexpected sync fixture route' } });
    await route.fulfill({ status: 200, json: result });
  });
  return { calls, options };
}

const callsTo = (calls: Call[], path: string) => calls.filter(call => call.path === path);

async function chooseConflicts(page: Page) {
  const conflicts = page.getByTestId('sync-preview').getByRole('combobox');
  await conflicts.nth(0).selectOption('local');
  await conflicts.nth(1).selectOption('incoming');
}

test('Sync uses desktop form geometry, Enter-save, preview dimensions and separate installed and Pack totals', async ({ page }) => {
  const { calls } = await mockSync(page);
  await page.goto('/');
  await openSync(page);
  const sync = page.getByTestId('settings-sync');
  await expect(sync.getByRole('heading', { level: 2 })).toHaveText('同步');
  await expect(sync.getByRole('heading', { level: 3 })).toHaveText(['导出／导入', 'WebDAV']);
  await expect(sync.locator('.sync-method .sync-actions button')).toHaveText(['导出同步数据', '导入同步数据']);
  await expect(sync.locator('.sync-webdav-actions button')).toHaveText(['测试连接', '上传数据', '拉取数据']);
  const url = sync.getByRole('textbox', { name: 'WebDAV 服务地址', exact: true });
  const username = sync.getByRole('textbox', { name: 'WebDAV 用户名', exact: true });
  const password = sync.getByLabel('WebDAV 密码', { exact: true });
  const urlBox = (await url.boundingBox())!;
  const usernameBox = (await username.boundingBox())!;
  const passwordBox = (await password.boundingBox())!;
  if (page.viewportSize()!.width > 700) {
    expect(Math.abs(usernameBox.y - passwordBox.y)).toBeLessThan(1);
    expect(urlBox.width).toBeCloseTo(usernameBox.width + passwordBox.width + 14, 0);
  } else {
    expect(passwordBox.y).toBeGreaterThan(usernameBox.y);
    expect(urlBox.width).toBeCloseTo(usernameBox.width, 0);
  }
  await username.fill('enter-save-user');
  await username.press('Enter');
  await expect(sync.getByRole('button', { name: '保存连接', exact: true })).toBeDisabled();
  expect(callsTo(calls, 'webdav').filter(call => call.method === 'POST')).toHaveLength(1);
  expect(callsTo(calls, 'webdav').at(-1)?.body).toMatchObject({ username: 'enter-save-user' });
  await sync.getByRole('button', { name: '拉取数据', exact: true }).click();
  const preview = page.getByTestId('sync-preview');
  await expect(preview).toBeVisible();
  expect((await preview.boundingBox())!.width).toBeCloseTo(Math.min(680, page.viewportSize()!.width - 32), 0);
  await expect(preview.locator('.sync-preview-stats > span')).toHaveText(['2匹配的 Skill', '2有变更的 Skill', '1跳过的 Skill', '2字段冲突']);
  await expect(preview).toContainText('包含 3 个已安装 Skill');
  await expect(preview).toContainText('包含 1 个 Pack');
  await expect(preview).toContainText('包含 5 个 Packs Skill');
  expect((await preview.getByRole('combobox').first().boundingBox())!.width).toBeCloseTo((await preview.locator('.sync-conflict').first().boundingBox())!.width - 26, 0);
  await expect(preview.locator('[data-slot="dialog-title"]')).toHaveCSS('font-size', '18px');
  await expect(preview.getByRole('button', { name: '确认合并', exact: true })).toHaveCSS('height', '36px');
  await preview.getByRole('button', { name: '取消', exact: true }).click();
  expect(callsTo(calls, 'apply')).toHaveLength(0);
});

test('Sync explicitly saves local credentials, omits blank password and blocks dirty cloud actions', async ({ page }) => {
  const { calls } = await mockSync(page);
  await page.goto('/');
  await openSync(page);
  const sync = page.getByTestId('settings-sync');
  await expect(sync).toContainText('相同的服务地址和账号');
  await expect(sync).not.toContainText('0600');
  await sync.locator('summary').click();
  await expect(sync).toContainText('未加密');
  await expect(sync.getByRole('heading', { name: '与客户端同步', exact: true })).toHaveCount(0);
  const webdav = sync.getByRole('region', { name: 'WebDAV', exact: true });
  await expect(webdav.locator('.setting-rows')).toHaveCount(1);
  await expect(webdav.getByLabel('WebDAV 服务地址', { exact: true })).toBeVisible();
  for (const name of ['保存连接', '测试连接', '拉取数据', '上传数据']) await expect(webdav.getByRole('button', { name, exact: true })).toBeVisible();
  await expect(sync.getByLabel('WebDAV 密码', { exact: true })).toHaveValue('');
  await expect(sync.getByRole('button', { name: '保存连接', exact: true })).toBeDisabled();
  const username = sync.getByRole('textbox', { name: 'WebDAV 用户名', exact: true });
  await username.fill('other-account');
  await expect(sync).toContainText('留空将清除旧密码');
  for (const name of ['测试连接', '拉取数据', '上传数据']) await expect(sync.getByRole('button', { name, exact: true })).toBeDisabled();
  expect(calls.filter(call => call.method === 'POST')).toHaveLength(0);
  await sync.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(sync).toHaveAttribute('aria-busy', 'false');
  expect(callsTo(calls, 'webdav').at(-1)?.body).toEqual({ url: 'https://dav.example.test/shared/', username: 'other-account' });
  await expect(page.getByRole('status')).toContainText('旧密码已清除');
  await expect(sync.getByRole('button', { name: '测试连接', exact: true })).toBeEnabled();
  await sync.getByLabel('WebDAV 密码', { exact: true }).fill('app-specific-secret');
  await sync.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(sync.getByLabel('WebDAV 密码', { exact: true })).toHaveValue('');
  expect(callsTo(calls, 'webdav').at(-1)?.body).toMatchObject({ password: 'app-specific-secret' });
  await sync.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(sync).toContainText('WebDAV 连接成功');
  expect(callsTo(calls, 'test')).toEqual([{ path: 'test', method: 'POST', body: {} }]);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('app-specific-secret');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('Sync file export downloads JSON and import previews require each explicit conflict choice before refreshing app state', async ({ page }) => {
  const { calls, options } = await mockSync(page);
  const snapshot = await stateSnapshot(page);
  options.snapshot = { ...snapshot, packs: [...snapshot.packs, { id: 'sync-fixture-pack', name: 'Synced desktop fixture', description: 'From shared cloud', createdAt: documentFixture.exportedAt, updatedAt: documentFixture.exportedAt }] };
  await page.goto('/');
  await openSync(page);
  const sync = page.getByTestId('settings-sync');
  const downloadPromise = page.waitForEvent('download');
  await sync.getByRole('button', { name: '导出同步数据', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.skill-shelf-sync\.json$/);
  expect(JSON.parse(await readFile((await download.path())!, 'utf8'))).toEqual(documentFixture);
  const input = sync.locator('input[type="file"]');
  await input.setInputFiles({ name: 'desktop.skill-shelf-sync.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(documentFixture)) });
  const preview = page.getByTestId('sync-preview');
  await expect(preview).toContainText('Desktop fixture');
  await expect(preview).toContainText('确认后才会写入');
  await expect(preview.getByRole('button', { name: '全部采用导入数据', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: '导入预览', exact: true })).toBeVisible();
  await expect(preview.getByRole('combobox')).toHaveCount(2);
  for (const select of await preview.getByRole('combobox').all()) await expect(select).toHaveValue('');
  await expect(preview).toContainText('标签');
  await expect(preview).not.toContainText('["local-tag"]');
  await expect(preview.getByRole('button', { name: '确认合并', exact: true })).toBeDisabled();
  expect(callsTo(calls, 'preview').at(-1)?.body).toEqual({ document: documentFixture });
  expect(callsTo(calls, 'apply')).toHaveLength(0);
  await preview.getByRole('button', { name: '取消', exact: true }).click();
  await expect(preview).toHaveCount(0);
  expect(callsTo(calls, 'apply')).toHaveLength(0);
  await input.setInputFiles({ name: 'desktop.skill-shelf-sync.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(documentFixture)) });
  await preview.getByRole('combobox').nth(0).selectOption('local');
  await expect(preview.getByRole('button', { name: '确认合并', exact: true })).toBeDisabled();
  await chooseConflicts(page);
  await expect(preview.getByRole('button', { name: '确认合并', exact: true })).toBeEnabled();
  await preview.getByRole('button', { name: '确认合并', exact: true }).click();
  await expect(preview).toHaveCount(0);
  expect(callsTo(calls, 'apply').at(-1)?.body).toEqual({ previewId: 'preview-fixture', resolutions: { 'tags-conflict': 'local', 'folder-conflict': 'incoming' } });
  await showSidebar(page);
  await page.getByRole('navigation', { name: 'Skill Shelf 导航', exact: true }).getByRole('button', { name: 'Packs', exact: true }).click();
  await expect(page.getByTestId('pack-sync-fixture-pack')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('Cloud previews clear on account changes and uploads are explicit, retryable and report missing backups', async ({ page }) => {
  const { calls, options } = await mockSync(page);
  await page.goto('/');
  await openSync(page);
  const sync = page.getByTestId('settings-sync');
  const preview = page.getByTestId('sync-preview');
  await sync.getByRole('button', { name: '拉取数据', exact: true }).click();
  await expect(preview).toBeVisible();
  await chooseConflicts(page);
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  await expect(sync.getByRole('button', { name: '拉取数据', exact: true })).toBeFocused();
  await sync.getByRole('textbox', { name: 'WebDAV 用户名', exact: true }).fill('temporary-account');
  await expect(preview).toHaveCount(0);
  await sync.getByRole('textbox', { name: 'WebDAV 用户名', exact: true }).fill('desktop-user');
  await sync.getByRole('button', { name: '上传数据', exact: true }).click();
  await expect(preview).toContainText('上传预览');
  expect(callsTo(calls, 'apply')).toHaveLength(0);
  await expect(preview.getByRole('combobox').first()).toHaveValue('');
  await chooseConflicts(page);
  options.applyFailure = true;
  await preview.getByRole('button', { name: '确认合并', exact: true }).click();
  await expect(preview.getByRole('alert')).toContainText('数据已变化');
  await expect(preview.getByRole('alert')).not.toContainText('Sync preview');
  await expect(preview).toBeVisible();
  await expect(preview.getByRole('button', { name: '确认合并', exact: true })).toBeEnabled();
  options.applyFailure = false; options.cloudBackupSaved = false;
  await preview.getByRole('button', { name: '确认合并', exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('未保存云端备份');
  expect(callsTo(calls, 'pull')).toEqual([{ path: 'pull', method: 'POST', body: {} }]);
  expect(callsTo(calls, 'upload')).toEqual([{ path: 'upload', method: 'POST', body: {} }]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('Sync retries config loading, requires legacy password reentry and rejects malformed or oversized files', async ({ page }) => {
  const { calls, options } = await mockSync(page);
  options.configFailure = true;
  await page.goto('/');
  await openSync(page);
  const sync = page.getByTestId('settings-sync');
  await expect(sync.getByRole('alert')).toContainText('Fixture connection read failure');
  await expect(sync.getByRole('button', { name: '测试连接', exact: true })).toBeDisabled();
  options.configFailure = false; options.connection.passwordNeedsReentry = true;
  await sync.getByRole('button', { name: '重新读取连接', exact: true }).click();
  await expect(sync.getByRole('alert')).toHaveCount(0);
  await expect(sync).toContainText('重新输入');
  for (const name of ['测试连接', '拉取数据', '上传数据']) await expect(sync.getByRole('button', { name, exact: true })).toBeDisabled();
  await sync.getByLabel('WebDAV 密码', { exact: true }).fill('legacy-config-password');
  await sync.getByRole('button', { name: '保存连接', exact: true }).click();
  await expect(sync.getByRole('button', { name: '测试连接', exact: true })).toBeEnabled();
  await sync.locator('input[type="file"]').setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{broken') });
  await expect(sync.getByRole('alert')).toContainText('有效的 JSON');
  expect(callsTo(calls, 'preview')).toHaveLength(0);
  // Override the file-size metadata to exercise the limit without transferring 100 MiB to every browser.
  await sync.locator('input[type="file"]').evaluate(input => {
    const file = new File(['{}'], 'oversized.json', { type: 'application/json' });
    Object.defineProperty(file, 'size', { value: 100 * 1024 * 1024 + 1 });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(sync.getByRole('alert')).toContainText('100 MiB');
  expect(callsTo(calls, 'preview')).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('Sync explains a stale backend and enables the form after the service is restarted and settings are retried', async ({ page }) => {
  const { calls, options } = await mockSync(page);
  options.oldBackend = true;
  await page.goto('/');
  await openSync(page);
  const sync = page.getByTestId('settings-sync');
  await expect(sync.getByRole('alert')).toContainText('重新启动 Skill Shelf');
  await expect(sync.getByRole('alert')).not.toContainText('Unknown workbench operation');
  await expect(sync.getByLabel('WebDAV 服务地址', { exact: true })).toBeDisabled();
  await expect(sync.getByRole('button', { name: '保存连接', exact: true })).toBeDisabled();
  options.oldBackend = false;
  await sync.getByRole('button', { name: '重新读取连接', exact: true }).click();
  await expect(sync.getByRole('alert')).toHaveCount(0);
  const url = sync.getByLabel('WebDAV 服务地址', { exact: true });
  await expect(url).toBeEditable();
  await expect(sync.getByLabel('WebDAV 用户名', { exact: true })).toBeEditable();
  await expect(sync.getByLabel('WebDAV 密码', { exact: true })).toBeEditable();
  await url.fill('https://dav.example.test/new-endpoint/');
  await expect(sync.getByRole('button', { name: '保存连接', exact: true })).toBeEnabled();
  expect(calls.filter(call => call.method === 'POST')).toHaveLength(0);
});

test('Sync modal supports both bulk choices and individual overrides without exposing technical values', async ({ page }) => {
  const { calls, options } = await mockSync(page);
  options.conflicts = [...previewFixture.conflicts, { id: 'files-conflict', skillName: 'Research fixture', field: 'files', local: '"abcdef0123456789"', incoming: '"9876543210fedcba"' }];
  options.conflicts[1] = { ...options.conflicts[1], local: '[{"name":"设计","color":"#ed6a4a"}]', incoming: '[{"name":"设计","color":"#3e77c7"}]' };
  await page.goto('/');
  await openSync(page);
  await page.getByRole('button', { name: '拉取数据', exact: true }).click();
  const preview = page.getByTestId('sync-preview');
  await expect(preview).toHaveJSProperty('open', true);
  await expect(preview).toContainText('文件内容有变化');
  await expect(preview).toContainText('设计（橙色）');
  await expect(preview).toContainText('设计（蓝色）');
  await expect(preview).not.toContainText('abcdef');
  await expect(preview).not.toContainText('tags');
  await preview.getByRole('button', { name: '全部保留本机', exact: true }).click();
  for (const select of await preview.getByRole('combobox').all()) await expect(select).toHaveValue('local');
  await preview.getByRole('button', { name: '全部采用导入数据', exact: true }).click();
  for (const select of await preview.getByRole('combobox').all()) await expect(select).toHaveValue('incoming');
  await preview.getByRole('combobox').first().selectOption('local');
  await preview.getByRole('button', { name: '确认合并', exact: true }).click();
  await expect(preview).toHaveCount(0);
  expect(callsTo(calls, 'apply').at(-1)?.body).toEqual({ previewId: 'preview-fixture', resolutions: { 'tags-conflict': 'local', 'folder-conflict': 'incoming', 'files-conflict': 'incoming' } });
});

test('Sync modal contains long conflicts, keeps confirmation visible and blocks background interaction', async ({ page }) => {
  const { calls, options } = await mockSync(page);
  options.conflicts = Array.from({ length: 45 }, (_, index) => ({ id: `conflict-${index}`, skillName: `Skill-${index}-${'long-name-'.repeat(8)}`, field: 'description', local: '本地说明'.repeat(90), incoming: '云端说明'.repeat(90) }));
  await page.goto('/');
  await openSync(page);
  await page.getByRole('button', { name: '拉取数据', exact: true }).click();
  const preview = page.getByTestId('sync-preview');
  const footer = preview.getByRole('button', { name: '确认合并', exact: true });
  await expect(footer).toBeInViewport();
  expect(await preview.locator('.sync-preview-scroll').evaluate(node => node.scrollHeight > node.clientHeight)).toBeTruthy();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  expect(await preview.evaluate(node => node.scrollWidth <= node.clientWidth)).toBeTruthy();
  const firstValue = preview.locator('.sync-conflict-values p').first();
  await expect(firstValue).toHaveAttribute('tabindex', '0');
  await expect(firstValue).toHaveAttribute('aria-label', /说明 · 本机数据/);
  await preview.getByRole('button', { name: '全部采用导入数据', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(firstValue).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => firstValue.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  const username = page.getByLabel('WebDAV 用户名', { exact: true });
  await username.evaluate(node => (node as HTMLElement).focus());
  await expect(username).not.toBeFocused();
  await page.keyboard.press('Tab');
  expect(await preview.evaluate(node => node.contains(document.activeElement))).toBeTruthy();
  await preview.getByRole('button', { name: '全部采用导入数据', exact: true }).click();
  await expect(footer).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  expect(callsTo(calls, 'apply')).toHaveLength(0);
  await expect(page.getByRole('button', { name: '拉取数据', exact: true })).toBeFocused();
});

test('Sync modal cannot be dismissed or applied twice during synchronization', async ({ page }) => {
  const { calls, options } = await mockSync(page);
  let release!: () => void;
  options.applyGate = new Promise<void>(resolve => { release = resolve; });
  await page.goto('/');
  await openSync(page);
  await page.getByRole('button', { name: '上传数据', exact: true }).click();
  const preview = page.getByTestId('sync-preview');
  await preview.getByRole('button', { name: '全部保留本机', exact: true }).click();
  await preview.getByRole('button', { name: '确认合并', exact: true }).click();
  await expect(preview.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
  await expect(preview.getByRole('button', { name: '正在同步…', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(preview).toBeVisible();
  expect(callsTo(calls, 'apply')).toHaveLength(1);
  release();
  await expect(preview).toHaveCount(0);
});

test('Sync confirms layout-only previews without asking for conflict choices', async ({ page }) => {
  const { calls, options } = await mockSync(page);
  options.conflicts = [];
  await page.goto('/');
  await openSync(page);
  await page.getByRole('button', { name: '拉取数据', exact: true }).click();
  const preview = page.getByTestId('sync-preview');
  await expect(preview).toBeVisible();
  await expect(preview.getByRole('region', { name: '内容冲突', exact: true })).toHaveCount(0);
  await expect(preview.getByRole('combobox')).toHaveCount(0);
  await expect(preview).not.toContainText('position');
  await expect(preview).not.toContainText('Desktop preferences');
  await expect(preview.getByRole('button', { name: '确认合并', exact: true })).toBeEnabled();
  expect(callsTo(calls, 'apply')).toHaveLength(0);
  await preview.getByRole('button', { name: '确认合并', exact: true }).click();
  await expect(preview).toHaveCount(0);
  expect(callsTo(calls, 'apply').at(-1)?.body).toEqual({ previewId: 'preview-fixture', resolutions: {} });
});

test('Description translation conflicts use desktop labels and bulk choices', async ({ page }) => {
  const { calls, options } = await mockSync(page);
  options.conflicts = [{ id: 'translation-conflict', skillName: 'Research fixture', field: 'translation:zh-CN', local: '"本机描述译文"', incoming: '"客户端描述译文"' }];
  await page.goto('/');
  await openSync(page);
  await page.getByRole('button', { name: '拉取数据', exact: true }).click();
  const preview = page.getByTestId('sync-preview');
  await expect(preview).toContainText('翻译 · zh-CN');
  await expect(preview).toContainText('本机描述译文');
  await expect(preview).toContainText('客户端描述译文');
  await expect(preview).not.toContainText('sourceDescription');
  await preview.getByRole('button', { name: '全部采用导入数据', exact: true }).click();
  await preview.getByRole('button', { name: '确认合并', exact: true }).click();
  expect(callsTo(calls, 'apply').at(-1)?.body).toEqual({ previewId: 'preview-fixture', resolutions: { 'translation-conflict': 'incoming' } });
});

test('Applying sync refreshes description translations without a rescan or page reload', async ({ page }) => {
  const { calls, options } = await mockSync(page);
  const snapshot = await stateSnapshot(page);
  const alpha = snapshot.skills.find(skill => skill.name === 'Alpha Research')!;
  options.snapshot = snapshot;
  options.conflicts = [];
  let annotationReads = 0;
  const unexpected: string[] = [];
  await page.route('**/api/ai/**', route => { unexpected.push(new URL(route.request().url()).pathname); return route.fulfill({ status: 409, json: { error: 'Fixture AI operation blocked' } }); });
  await page.route('**/api/ai/annotations', route => {
    annotationReads++;
    return route.fulfill({ json: { annotations: callsTo(calls, 'apply').length ? [{ skillId: alpha.id, kind: 'translation', language: 'zh-CN', text: '客户端同步的描述译文', model: 'desktop-sync', sourceDigest: 'fixture', createdAt: '2026-10-12T00:00:00Z', stale: false }] : [] } });
  });
  await page.addInitScript(() => {
    localStorage.setItem('shelf-ai:preferences', JSON.stringify({ enabled: true, targetLanguage: 'zh-CN' }));
    localStorage.setItem('shelf-view', JSON.stringify('list'));
  });
  await page.goto('/#skills:global');
  await expect.poll(() => annotationReads).toBeGreaterThan(0);
  await openSync(page);
  const before = annotationReads;
  await page.getByRole('button', { name: '拉取数据', exact: true }).click();
  await page.getByTestId('sync-preview').getByRole('button', { name: '确认合并', exact: true }).click();
  await expect.poll(() => annotationReads).toBeGreaterThan(before);
  await page.getByRole('button', { name: '返回', exact: true }).click();
  const row = page.locator(`[data-finder-item-key="skill:${alpha.id}"]`).first();
  await expect(row).toContainText('客户端同步的描述译文');
  expect(snapshot.scannedAt).toBe(options.snapshot.scannedAt);
  expect(unexpected).toEqual([]);
});
