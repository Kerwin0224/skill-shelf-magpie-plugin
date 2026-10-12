import { expect, request as playwrightRequest, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { selectChoice } from './form-helpers';

type State = {
  skills: { id: string; name: string; path: string; scopeId: string }[];
  managedSkills: { id: string; name: string; path: string; packId: string }[];
  packs: { id: string; name: string }[];
  folders: { id: string; name: string; scopeId: string }[];
  organization: Record<string, { folderId: string | null; tags: string[] }>;
};
const prefix = '__Forms__';

async function api<T = State>(page: Page, route: string, method: 'GET' | 'POST' | 'PATCH' = 'GET', data?: unknown): Promise<T> {
  const session = await page.request.get('/api/session');
  expect(session.ok()).toBeTruthy();
  const response = await page.request.fetch(`/api${route}`, { method, headers: { 'X-Shelf-Token': (await session.json()).token }, data });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

async function showSidebar(page: Page) {
  const back = page.getByRole('button', { name: '返回', exact: true });
  if (await back.isVisible()) await back.click();
  const trigger = page.getByRole('button', { name: '打开侧边栏', exact: true });
  if (await trigger.isVisible()) await trigger.click();
}

async function settings(page: Page, section: string) {
  await showSidebar(page);
  await page.getByRole('navigation', { name: '应用设置', exact: true }).getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置分类', exact: true }).getByRole('button', { name: section, exact: true }).click();
  await expect(page.locator('.settings-content').getByRole('heading', { name: section, exact: true, level: 2 })).toBeVisible();
}

async function createPack(page: Page, info: TestInfo) {
  const before = await api(page, '/state');
  const state = await api(page, '/packs', 'POST', { name: `${prefix} ${info.project.name} ${Date.now()}` });
  return state.packs.find(pack => !before.packs.some(existing => existing.id === pack.id))!;
}

async function createFolder(page: Page, scopeId: string, name: string, parentId: string | null = null) {
  const before = await api(page, '/state');
  const state = await api(page, '/folders', 'POST', { name, scopeId, parentId });
  return state.folders.find(folder => !before.folders.some(existing => existing.id === folder.id))!;
}

async function importAlpha(page: Page, packId: string) {
  const state = await api(page, '/state');
  const alpha = state.skills.find(skill => skill.name === 'Alpha Research' && skill.scopeId === 'global')!;
  const imported = await api(page, `/packs/${packId}/skills`, 'POST', { skillIds: [alpha.id] });
  return { alpha, managed: imported.managedSkills.find(skill => skill.packId === packId)! };
}

async function expectCustomSelect(trigger: Locator) {
  await expect(trigger).toHaveAttribute('data-slot', 'select-trigger');
  await expect(trigger).toHaveAttribute('type', 'button');
  await expect(trigger).toHaveAttribute('aria-autocomplete', 'none');
  expect(await trigger.page().locator('select').evaluateAll(elements => elements.filter(element => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || !bounds.width || !bounds.height) return false;
    // WebKit's native minimum control size can exceed 1px despite a zero clipping rect.
    const completelyClipped = style.clip.replace(/[\s,]/g, '') === 'rect(0px0px0px0px)' || style.clipPath === 'inset(50%)';
    return !(element.getAttribute('aria-hidden') === 'true' && element.tabIndex < 0 && completelyClipped);
  }).length)).toBe(0);
  const icon = trigger.locator('[data-slot="select-icon"]');
  const controlBox = (await trigger.boundingBox())!;
  const iconBox = (await icon.boundingBox())!;
  expect(iconBox.width).toBeGreaterThanOrEqual(12);
  expect(Math.abs(iconBox.y + iconBox.height / 2 - controlBox.y - controlBox.height / 2)).toBeLessThanOrEqual(1.5);
  expect(iconBox.x + iconBox.width).toBeLessThan(controlBox.x + controlBox.width);
}

async function expectPopupWithinViewport(page: Page) {
  const popup = page.locator('[data-slot="select-content"]');
  await expect(popup).toBeVisible();
  const box = (await popup.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.y).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  const selected = page.getByRole('option').and(page.locator('[aria-selected="true"]'));
  const check = selected.locator('[data-slot="select-item-indicator"] svg');
  await expect(check).toBeVisible();
  const itemBox = (await selected.boundingBox())!;
  const checkBox = (await check.boundingBox())!;
  expect(checkBox.width).toBeCloseTo(16, 1);
  expect(checkBox.height).toBeCloseTo(16, 1);
  expect(Math.abs(checkBox.y + checkBox.height / 2 - itemBox.y - itemBox.height / 2)).toBeLessThanOrEqual(1.5);
}

async function captureFormSelect(page: Page, info: TestInfo) {
  if (process.env.SHELF_CAPTURE_SCREENSHOTS !== '1') return;
  const output = process.env.SHELF_SCREENSHOT_DIR || info.outputPath('screenshots');
  await mkdir(output, { recursive: true });
  await page.evaluate(() => {
    const badge = document.createElement('div');
    badge.dataset.syntheticPreview = 'true';
    badge.textContent = 'PREVIEW / SYNTHETIC TEST DATA';
    badge.style.cssText = 'position:fixed;bottom:10px;right:12px;z-index:2000;background:#fff9ec;color:#785a34;border:1px solid #d9c39c;padding:5px 9px;border-radius:6px;font:10px monospace;letter-spacing:.04em;pointer-events:none';
    document.body.appendChild(badge);
  });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(output, `skill-shelf-form-select-${info.project.name}.png`), fullPage: true, animations: 'disabled' });
  await page.locator('[data-synthetic-preview]').evaluate(element => element.remove());
}

test.afterEach(async ({}, info) => {
  // Independent request context still works after a failed page action times out.
  const context = await playwrightRequest.newContext({ baseURL: info.project.use.baseURL as string });
  try {
    const session = await context.get('/api/session');
    const headers = { 'X-Shelf-Token': (await session.json()).token };
    const response = await context.get('/api/state', { headers });
    const state: State = await response.json();
    for (const pack of state.packs.filter(pack => pack.name.startsWith(prefix))) expect((await context.delete(`/api/packs/${pack.id}`, { headers })).ok()).toBeTruthy();
    for (const folder of state.folders.filter(folder => folder.scopeId === 'global' && folder.name.startsWith(prefix))) expect((await context.delete(`/api/folders/${folder.id}`, { headers })).ok()).toBeTruthy();
  } finally { await context.dispose(); }
});

test('Settings Selects use the themed controls and explicit AI settings save without inference', async ({ page }) => {
  await page.goto('/');
  const status = await api<{ baseUrl: string }>(page, '/ai/status');
  const calls = async () => (await (await page.request.get(`${status.baseUrl}/__test/status`)).json()).requests;
  const before = (await calls()).length;
  await settings(page, '通用');
  const startup = page.getByRole('combobox', { name: '启动页面', exact: true });
  await expectCustomSelect(startup);
  await selectChoice(startup, 'Skills');
  await expect(startup).toHaveText('Skills');
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: 'Skills 与 Agent', exact: true }).click();
  await expectCustomSelect(page.getByRole('combobox', { name: '导出的 Pack', exact: true }));
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '默认模型', exact: true }).click();
  const summary = page.getByRole('combobox', { name: 'Skill 分析模型', exact: true });
  await expect(summary).toBeEnabled();
  await expectCustomSelect(summary);
  await selectChoice(summary, 'fixture/other');
  await expect(summary).toContainText('Fixture Other Model');
  await expect(summary).toContainText('Magpie · fixture/other');
  expect(await page.evaluate(() => localStorage.getItem('shelf-ai:preferences'))).toBeNull();
  await page.getByRole('button', { name: '保存默认模型', exact: true }).click();
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: 'AI 行为', exact: true }).click();
  const language = page.getByRole('combobox', { name: '默认输出语言', exact: true });
  await expectCustomSelect(language);
  await selectChoice(language, 'en');
  await selectChoice(page.getByRole('combobox', { name: '上下文范围', exact: true }), 'description');
  await page.getByRole('button', { name: '保存 AI 设置', exact: true }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('shelf-ai:preferences')!))).toMatchObject({ summaryModel: 'fixture/other', targetLanguage: 'en', summaryContext: 'description' });
  expect(await calls()).toHaveLength(before);
});

test('Import filter popup owns keyboard and Escape, overlays its modal and does not accidentally submit', async ({ page }, info) => {
  const pack = await createPack(page, info);
  const before = await api(page, '/state');
  const alpha = before.skills.find(skill => skill.name === 'Alpha Research')!;
  const original = await readFile(path.join(alpha.path, 'SKILL.md'), 'utf8');
  await page.goto(`/#packs:${pack.id}`);
  await page.getByTestId('add-to-pack').click();
  const dialog = page.getByRole('dialog', { name: `导入到 ${pack.name}`, exact: true });
  const filter = dialog.getByRole('combobox', { name: '按安装位置筛选', exact: true });
  await expectCustomSelect(filter);
  await dialog.locator('.managed-selection-row').filter({ hasText: 'Alpha Research' }).click();
  await filter.click();
  await expectPopupWithinViewport(page);
  await captureFormSelect(page, info);
  const option = page.getByRole('option', { name: '全局', exact: true });
  expect(await option.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)?.closest('[role="option"]') === element;
  })).toBeTruthy();
  expect(await page.getByRole('listbox').evaluate(element => !element.closest('[role="dialog"]'))).toBeTruthy();
  await page.keyboard.press('Escape');
  await expect(filter).toBeFocused();
  await expect(dialog).toBeVisible();
  await expect(filter).toHaveAttribute('data-value', 'all');
  await filter.press('ArrowDown');
  await expect(page.getByRole('listbox')).toBeVisible();
  await expect(page.getByRole('option', { name: '全部位置', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('option', { name: '项目', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(filter).toHaveAttribute('data-value', 'project');
  await expect(dialog.locator('.managed-selection-row')).toHaveCount(0);
  await expect(dialog).toBeVisible();
  expect((await api(page, '/state')).managedSkills).toHaveLength(before.managedSkills.length);
  await selectChoice(filter, 'global');
  await expect(dialog.locator('.managed-selection-row').filter({ hasText: 'Alpha Research' })).toHaveAttribute('aria-pressed', 'true');
  const heading = (await dialog.getByRole('heading', { name: `导入到 ${pack.name}`, exact: true }).boundingBox())!;
  await filter.click();
  await expectPopupWithinViewport(page);
  const outside = { x: heading.x + 8, y: heading.y + heading.height / 2 };
  const hitTest = await page.evaluate(point => {
    const popup = document.querySelector('[data-slot="select-content"]')!;
    const bounds = popup.getBoundingClientRect();
    const target = document.elementFromPoint(point.x, point.y);
    return { point, popup: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      target: target?.tagName, insidePopup: Boolean(target?.closest('[data-slot="select-content"]')) };
  }, outside);
  await info.attach('select-outside-hit-test', { body: JSON.stringify(hitTest), contentType: 'application/json' });
  expect(hitTest.insidePopup).toBeFalsy();
  await page.mouse.click(outside.x, outside.y);
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(filter).toHaveAttribute('data-value', 'global');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '导入 1 个', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const imported = (await api(page, '/state')).managedSkills.find(skill => skill.packId === pack.id)!;
  expect(await readFile(path.join(imported.path, 'SKILL.md'), 'utf8')).toBe(original);
  expect(await readFile(path.join(alpha.path, 'SKILL.md'), 'utf8')).toBe(original);
});

test('Pack organization Select supports long paths, empty root option and explicit metadata save without rewriting sources', async ({ page }, info) => {
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 320, height: 740 });
  const pack = await createPack(page, info);
  const { alpha, managed } = await importAlpha(page, pack.id);
  const original = await readFile(path.join(alpha.path, 'SKILL.md'), 'utf8');
  const parent = await createFolder(page, `pack:${pack.id}`, `${prefix} Parent folder with long hierarchy`);
  const folder = await createFolder(page, `pack:${pack.id}`, `${prefix} A very long folder name for layout checks`.slice(0, 48), parent.id);
  await page.goto(`/#packs:${pack.id}`);
  await page.getByRole('button', { name: '列表视图', exact: true }).click();
  const row = page.locator(`[data-finder-item-key="skill:${managed.id}"]`);
  await row.click({ button: 'right', position: { x: 12, y: 20 } });
  await page.getByRole('menuitem', { name: '整理 Alpha Research', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '整理 Alpha Research', exact: true });
  const folderSelect = dialog.getByRole('combobox', { name: '文件夹', exact: true });
  await expectCustomSelect(folderSelect);
  await selectChoice(folderSelect, folder.id);
  await expect(folderSelect).toHaveText(`${parent.name} / ${folder.name}`);
  await expect(folderSelect.locator('[data-slot="select-value"]')).toHaveCSS('text-overflow', 'ellipsis');
  await expectCustomSelect(folderSelect);
  await folderSelect.click();
  await expectPopupWithinViewport(page);
  await page.keyboard.press('Escape');
  await expect(folderSelect).toBeFocused();
  await expect(dialog).toBeVisible();
  expect((await api(page, '/state')).organization[managed.id]?.folderId || null).toBeNull();
  await selectChoice(folderSelect, '');
  await expect(folderSelect).toHaveText(pack.name);
  await selectChoice(folderSelect, `${parent.name} / ${folder.name}`);
  await dialog.getByRole('textbox', { name: '标签', exact: true }).fill('forms, independent');
  await dialog.getByRole('button', { name: '保存 Pack', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect((await api(page, '/state')).organization[managed.id]).toMatchObject({ folderId: folder.id, tags: ['forms', 'independent'] });
  expect(await readFile(path.join(alpha.path, 'SKILL.md'), 'utf8')).toBe(original);
  expect(await readFile(path.join(managed.path, 'SKILL.md'), 'utf8')).toBe(original);
});

test('Inspector folder Select preserves its parent on Escape, supports typeahead and saves metadata with no source writes', async ({ page }, info) => {
  const state = await api(page, '/state');
  const alpha = state.skills.find(skill => skill.name === 'Alpha Research')!;
  const original = await readFile(path.join(alpha.path, 'SKILL.md'), 'utf8');
  await api(page, '/organization', 'PATCH', { ids: [alpha.id], folderId: null, tags: [] });
  const folder = await createFolder(page, 'global', `${prefix} Zulu ${info.project.name}`);
  await page.goto('/#skills:global');
  await page.locator(`[data-finder-item-key="skill:${alpha.id}"]`).getByRole('button', { name: '查看 Alpha Research 详情' }).click();
  const dialog = page.getByRole('dialog', { name: 'Alpha Research', exact: true });
  const folderSelect = dialog.getByRole('combobox', { name: '文件夹', exact: true });
  await expectCustomSelect(folderSelect);
  await folderSelect.click();
  await page.keyboard.press('Escape');
  await expect(folderSelect).toBeFocused();
  await expect(dialog).toBeVisible();
  await expect(folderSelect).toHaveAttribute('data-value', '');
  await folderSelect.focus();
  await page.keyboard.type(prefix);
  await expect(folderSelect).toHaveAttribute('data-value', folder.id);
  await expect.poll(async () => (await api(page, '/state')).organization[alpha.id]?.folderId).toBe(folder.id);
  await expect(dialog).toBeVisible();
  await selectChoice(folderSelect, '未整理');
  await expect.poll(async () => (await api(page, '/state')).organization[alpha.id]?.folderId).toBeNull();
  await expect(folderSelect).toHaveText('未整理');
  expect(await readFile(path.join(alpha.path, 'SKILL.md'), 'utf8')).toBe(original);
});

test('Disabled saved AI model remains visible and unselected alternatives never cause inference or an implicit replacement', async ({ page }) => {
  await page.goto('/#skills:global');
  const status = await api<{ baseUrl: string }>(page, '/ai/status');
  const calls = async () => (await (await page.request.get(`${status.baseUrl}/__test/status`)).json()).requests;
  const baseline = (await calls()).length;
  await page.evaluate(() => localStorage.setItem('shelf-ai:preferences', JSON.stringify({ enabled: true, summaryModel: 'not-enabled/paid-model', translationModel: 'not-enabled/paid-model', targetLanguage: 'en', summaryContext: 'skill-md' })));
  await page.reload();
  const alpha = (await api(page, '/state')).skills.find(skill => skill.name === 'Alpha Research')!;
  await page.locator(`[data-finder-item-key="skill:${alpha.id}"]`).getByRole('button', { name: '查看 Alpha Research 详情' }).click();
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  const panel = page.getByTestId('ai-assistant-sidebar');
  const model = panel.getByRole('combobox', { name: '对话模型', exact: true });
  await expect(model).toContainText('未启用：not-enabled/paid-model');
  await expect(model).toHaveAttribute('data-value', 'not-enabled/paid-model');
  await model.click();
  await expect(page.getByRole('option', { name: /未启用：not-enabled\/paid-model/ })).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await expect(model).toBeFocused();
  await expect(model).toHaveAttribute('data-value', 'not-enabled/paid-model');
  await expect(page.getByRole('dialog', { name: 'Alpha Research', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: '生成描述', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: '翻译', exact: true })).toBeDisabled();
  expect(await calls()).toHaveLength(baseline);
});
