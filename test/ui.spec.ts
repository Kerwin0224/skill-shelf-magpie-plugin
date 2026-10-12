import { expect, request as playwrightRequest, test, type Locator, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { selectChoice } from './form-helpers';

type UiSnapshot = {
  dataDir: string;
  homeDir: string;
  skills: { id: string; name: string; path: string }[];
  managedSkills: { id: string; name: string; path: string; sourcePath: string; packId: string; deployments: { id: string; targetPath: string }[] }[];
  organization: Record<string, { folderId: string | null; tags: string[] }>;
  folders: { id: string; scopeId: string; name: string; parentId: string | null }[];
  finderPositions: Record<string, { x: number; y: number }>;
  packs: { id: string; name: string }[];
  roots: { id: string; path: string }[];
};

async function session(page: Page) {
  const response = await page.request.get('/api/session');
  expect(response.ok()).toBeTruthy();
  return (await response.json()).token as string;
}

async function snapshot(page: Page): Promise<UiSnapshot> {
  const token = await session(page);
  const response = await page.request.get('/api/state', { headers: { 'X-Shelf-Token': token } });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

async function update(page: Page, route: string, method: 'post' | 'patch', data: unknown): Promise<UiSnapshot> {
  const response = await page.request[method](route, { headers: { 'X-Shelf-Token': await session(page) }, data });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

async function openNavigation(page: Page) {
  const menu = page.getByRole('button', { name: '打开侧边栏', exact: true });
  if (await menu.isVisible()) await menu.click();
}

async function openPacks(page: Page) {
  await openNavigation(page);
  await page.getByRole('navigation', { name: 'Skill Shelf 导航', exact: true }).getByRole('button', { name: 'Packs', exact: true }).click();
  await openNavigation(page);
}

async function chooseFinderOption(page: Page, trigger: '排序' | '群组方式', name: string) {
  await page.getByRole('button', { name: trigger, exact: true }).click();
  await page.getByRole('menuitemradio', { name, exact: true }).click();
}

async function expectFinderOption(page: Page, trigger: '排序' | '群组方式', name: string) {
  await page.getByRole('button', { name: trigger, exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name, exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
}

async function rightClickItem(page: Page, item: Locator) {
  await item.scrollIntoViewIfNeeded();
  const box = (await item.boundingBox())!;
  await page.mouse.click(box.x + 12, box.y + Math.min(35, box.height / 2), { button: 'right' });
}

async function rightClickBackground(page: Page) {
  const browser = page.locator('.finder-browser');
  const bounds = (await browser.boundingBox())!;
  const viewport = page.viewportSize()!;
  // Stay off native scrollbar tracks, which WebKit consumes without contextmenu.
  const point = { x: Math.round(Math.min(bounds.x + bounds.width - 36, viewport.width - 36)), y: Math.round(Math.min(bounds.y + bounds.height - 36, viewport.height - 48)) };
  expect(await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    return Boolean(element?.closest('.finder-browser') && !element.closest('[data-finder-item-key]'));
  }, point)).toBeTruthy();
  await page.mouse.click(point.x, point.y, { button: 'right' });
  return point;
}

async function clearFinderSelection(page: Page) {
  const point = await rightClickBackground(page);
  await page.keyboard.press('Escape');
  await page.mouse.click(point.x, point.y);
  await expect(page.locator('[data-finder-item-key][aria-selected="true"]')).toHaveCount(0);
}

async function expectSourceFinderUi(page: Page) {
  await expect(page.locator('.finder-browser').getByRole('checkbox')).toHaveCount(0);
  await expect(page.locator('.finder-browser input[type="checkbox"]')).toHaveCount(0);
  await expect(page.getByTestId('selection-toolbar')).toHaveCount(0);
  await expect(page.getByTestId('deploy-selection')).toHaveCount(0);
  await expect(page.locator('.finder-browser').getByRole('button', { name: '更多操作', exact: true })).toHaveCount(0);
}

async function expectVisibleMenusWithinViewport(page: Page) {
  const viewport = page.viewportSize()!;
  const menus = page.getByRole('menu');
  for (const menu of await menus.all()) {
    if (!await menu.isVisible()) continue;
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  }
}

async function clickCascadedChoice(page: Page, trigger: Locator, choice: Locator) {
  await trigger.hover();
  await expect(choice).toBeVisible();
  const from = (await trigger.boundingBox())!;
  const to = (await choice.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 16 });
  await expect(choice).toBeVisible();
  await page.mouse.click(to.x + to.width / 2, to.y + to.height / 2);
}

async function finderPoint(item: Locator) {
  return item.evaluate(element => {
    const transform = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return { x: transform.m41, y: transform.m42 };
  });
}

async function dragCanvasItem(page: Page, item: Locator, target: { x: number; y: number }) {
  const handle = item.locator('.finder-icon-button');
  await handle.scrollIntoViewIfNeeded();
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 32);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 14 });
  await page.mouse.up();
}

async function captureFinder(page: Page, filename: string) {
  await page.evaluate(contextMenu => {
    const label = document.createElement('div');
    label.textContent = 'PREVIEW / SYNTHETIC TEST DATA';
    label.style.cssText = 'position:fixed;bottom:10px;right:12px;z-index:2000;background:#fff9ec;color:#785a34;border:1px solid #d9c39c;padding:5px 9px;border-radius:6px;font:10px monospace;letter-spacing:.04em';
    if (contextMenu) { label.style.bottom = 'auto'; label.style.top = '10px'; label.style.right = '48px'; }
    document.body.appendChild(label);
  }, filename === 'skill-shelf-context-menu.png');
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `/Users/laz/.codex/visualizations/2026/10/12/01a12de0-d42d-72a1-a0b2-5f925bd5cfff/${filename}`, fullPage: true, animations: 'disabled' });
}

async function capturePreview(page: Page, project: string) {
  if (process.env.SHELF_CAPTURE_SCREENSHOTS !== '1' || !['desktop', 'mobile'].includes(project)) return;
  const state = await snapshot(page);
  const token = await session(page);
  const headers = { 'X-Shelf-Token': token };
  const fixturePath = path.join(state.dataDir, '..', `preview-fixtures-${project}`);
  for (const [slug, name, description] of [
    ['delta-planning', 'Delta Planning', 'Turn ambitious ideas into clear, achievable milestones.'],
    ['epsilon-testing', 'Epsilon Testing', 'Build reliable regression checks and actionable test plans.'],
  ]) {
    await mkdir(path.join(fixturePath, slug), { recursive: true });
    await writeFile(path.join(fixturePath, slug, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nThis is synthetic test data.\n`);
  }
  const addedRoot = await page.request.post('/api/roots', { headers, data: { path: fixturePath, label: 'Preview Fixtures' } });
  expect(addedRoot.ok()).toBeTruthy();
  const added = await addedRoot.json() as UiSnapshot & { roots: { id: string; path: string }[] };
  const root = added.roots.find(item => item.path === fixturePath)!;
  const folderResponse = await page.request.post('/api/folders', { headers, data: { name: 'Research & Ideas', scopeId: 'global', color: '#ed6a4a' } });
  expect(folderResponse.ok()).toBeTruthy();
  const folderState = await folderResponse.json() as UiSnapshot;
  const folder = folderState.folders.find(item => item.name === 'Research & Ideas')!;
  for (const skill of added.skills) {
    const tags = skill.name.includes('Research') ? ['research', 'daily'] : skill.name.includes('Design') ? ['design', 'creative'] : skill.name.includes('Planning') ? ['planning', 'work'] : ['testing', 'quality'];
    const response = await page.request.patch('/api/organization', { headers, data: { ids: [skill.id], tags } });
    expect(response.ok()).toBeTruthy();
  }
  await page.reload();
  await expect(page.getByTestId('skill-card')).toHaveCount(4);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(350);
  await page.evaluate(() => {
    const label = document.createElement('div');
    label.textContent = 'PREVIEW / SYNTHETIC TEST DATA';
    label.style.cssText = 'position:fixed;bottom:10px;right:12px;z-index:2000;background:#fff9ec;color:#785a34;border:1px solid #d9c39c;padding:5px 9px;border-radius:6px;font:10px monospace;letter-spacing:.04em';
    document.body.appendChild(label);
  });
  const output = '/Users/laz/.codex/visualizations/2026/10/12/01a12de0-d42d-72a1-a0b2-5f925bd5cfff';
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: path.join(output, `skill-shelf-${project}.png`), fullPage: true, animations: 'disabled' });
  expect((await page.request.delete(`/api/roots/${root.id}`, { headers })).ok()).toBeTruthy();
  expect((await page.request.delete(`/api/folders/${folder.id}`, { headers })).ok()).toBeTruthy();
}

test.beforeEach(async ({ page }) => {
  const state = await snapshot(page);
  const token = await session(page);
  const headers = { 'X-Shelf-Token': token };
  const reset = await page.request.patch('/api/organization', { headers, data: { ids: state.skills.map(skill => skill.id), folderId: null, tags: [] } });
  expect(reset.ok()).toBeTruthy();
  for (const folder of state.folders.filter(folder => folder.scopeId === 'global')) {
    const response = await page.request.delete(`/api/folders/${folder.id}`, { headers });
    expect(response.ok()).toBeTruthy();
  }
  await update(page, '/api/finder', 'patch', { scopeId: 'global', items: state.skills.map((skill, index) => ({ kind: 'skill', id: skill.id, position: { x: 16 + index * 128, y: 18 } })) });
  const status = await page.request.get('/api/ai/status', { headers });
  const gateway = await status.json();
  expect(gateway.available).toBeTruthy();
  expect((await page.request.post(`${gateway.baseUrl}/__test/status`, { data: { reset: true, failure: false } })).ok()).toBeTruthy();
});

test('loads the packaged workbench, searches Skills, previews instructions and rescans', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const alpha = (await snapshot(page)).skills.find(skill => skill.name === 'Alpha Research')!;
  const annotationResponse = await page.request.get('/api/ai/annotations', { headers: { 'X-Shelf-Token': await session(page) } });
  expect(annotationResponse.ok()).toBeTruthy();
  const { annotations } = await annotationResponse.json() as { annotations: { skillId: string; stale: boolean; language: string; text: string; savedAt?: string; createdAt: string }[] };
  const annotation = annotations.filter(item => item.skillId === alpha.id && !item.stale && item.language === 'zh-CN')
    .sort((a, b) => new Date(a.savedAt || a.createdAt).getTime() - new Date(b.savedAt || b.createdAt).getTime()).at(-1);
  await page.goto('/#skills:global');
  await expect(page.getByRole('heading', { name: '全局', exact: true })).toBeVisible();
  await expect(page.getByTestId('skill-card')).toHaveCount(2);
  await page.getByRole('button', { name: '预览 Alpha Research 的信息', exact: true }).hover();
  await expect(page.getByRole('tooltip', { name: 'Alpha Research 信息预览', exact: true })).toContainText(annotation?.text || 'Research and summarize reliable sources.');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const search = page.getByRole('textbox', { name: '搜索已安装的 Skill', exact: true });
  await search.fill('reliable');
  await expect(page.getByTestId('skill-card')).toHaveCount(2);
  await search.press('Enter');
  await expect(page.getByTestId('skill-card')).toHaveCount(1);
  await expect(page.getByTestId('skill-card')).toContainText('Alpha Research');
  await page.getByTestId('skill-card').getByRole('button', { name: '查看 Alpha Research 详情' }).click();
  const detail = page.getByRole('dialog', { name: 'Alpha Research', exact: true });
  await expect(detail).toHaveAttribute('aria-modal', 'false');
  await expect(page.getByTestId('skill-card')).toHaveAttribute('aria-selected', 'true');
  await expect(detail.getByRole('tab', { name: '信息', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(detail.getByRole('tree')).toHaveCount(0);
  await detail.getByRole('tab', { name: '文件', exact: true }).click();
  await expect(detail.getByRole('tree', { name: 'Skill 文件', exact: true })).toBeVisible();
  await expect(detail.getByRole('heading', { name: 'SKILL.md', exact: true })).toBeVisible();
  await expect(detail.locator('.markdown-section .markdown-body').getByRole('heading', { name: 'Alpha Research', exact: true })).toBeVisible();
  await expect(detail.locator('.markdown-section .markdown-body')).not.toContainText('name: Alpha Research');
  await expect(detail).toContainText('Follow references/context.md before answering.');
  await expect(detail.locator('.skill-file-preview [contenteditable="true"]')).toHaveCount(0);
  await expect(detail.locator('.skill-file-preview textarea')).toHaveCount(0);
  await detail.getByRole('button', { name: '源码', exact: true }).click();
  await expect(detail.locator('.skill-file-source')).toContainText('name: Alpha Research');
  await detail.getByRole('treeitem', { name: 'references', exact: true }).click();
  await detail.getByRole('treeitem', { name: 'context.md', exact: true }).click();
  await expect(detail.getByRole('heading', { name: 'references/context.md', exact: true })).toBeVisible();
  await expect(detail.locator('.markdown-body')).toContainText('Keep citations precise.');
  await expect(detail.getByRole('button', { name: '渲染', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(detail).not.toBeVisible();
  await page.getByRole('button', { name: '清除搜索', exact: true }).click();
  await expect(page.getByTestId('skill-card')).toHaveCount(2);
  await search.fill('Alpha');
  await page.getByRole('button', { name: '筛选', exact: true }).click();
  await expect(page.getByTestId('skill-card')).toHaveCount(1);
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(search).toBeFocused();
  await expect(page.getByTestId('skill-card')).toHaveCount(2);
  await page.getByTestId('skill-card').filter({ hasText: 'Alpha Research' }).getByRole('button', { name: '查看 Alpha Research 详情', exact: true }).click();
  await expect(detail).toBeVisible();
  await openPacks(page);
  await expect(detail).not.toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Default');
  await page.getByRole('navigation', { name: 'Skill Shelf 导航', exact: true }).getByRole('button', { name: /^Skills/ }).click();
  await expect(page.getByRole('button', { name: '扫描更新', exact: true })).toBeVisible();
  await update(page, '/api/rescan', 'post', {});
  await page.reload();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(errors).toEqual([]);
  await capturePreview(page, testInfo.project.name);
});

test('organizes Skills and completes independent Pack import, export and deployment', async ({ page }, testInfo) => {
  const suffix = testInfo.project.name;
  const folderName = `Field Notes ${suffix}`;
  const packName = `Team Starter ${suffix}`;
  const tag = `knowledge-${suffix}`;
  const original = (await snapshot(page)).skills.find(skill => skill.name === 'Alpha Research')!;
  const originalText = await readFile(path.join(original.path, 'SKILL.md'), 'utf8');
  await page.goto('/#skills:global');
  await expect(page.getByTestId('skill-card')).toHaveCount(2);
  await page.getByRole('button', { name: '新建文件夹', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '创建文件夹', exact: true });
  await dialog.getByLabel('文件夹名称', { exact: true }).fill(folderName);
  await dialog.getByRole('button', { name: '创建文件夹', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: '列表视图', exact: true }).click();
  const originalItem = page.locator(`[data-finder-item-key="skill:${original.id}"]`);
  await originalItem.getByRole('button', { name: '查看 Alpha Research 详情', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Alpha Research', exact: true });
  for (const label of [tag, 'daily']) {
    await dialog.getByRole('textbox', { name: '添加标签', exact: true }).fill(label);
    await dialog.getByRole('textbox', { name: '添加标签', exact: true }).press('Enter');
    await expect(dialog.getByRole('button', { name: `移除标签 ${label}`, exact: true })).toBeVisible();
  }
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('textbox', { name: '搜索已安装的 Skill', exact: true }).fill(tag);
  await page.getByRole('button', { name: '筛选', exact: true }).click();
  await expect(page.getByTestId('skill-card')).toHaveCount(1);
  await expect(page.getByTestId('skill-card')).toContainText(tag);
  await page.getByRole('button', { name: '清除搜索', exact: true }).click();
  await rightClickItem(page, originalItem);
  const moveTrigger = page.getByRole('menuitem', { name: '移动到文件夹', exact: true });
  await moveTrigger.hover();
  await expect(page.getByRole('menuitemcheckbox', { name: '未整理', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('menuitemcheckbox', { name: folderName, exact: true })).toHaveAttribute('aria-checked', 'false');
  await clickCascadedChoice(page, moveTrigger, page.getByRole('menuitemcheckbox', { name: folderName, exact: true }));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('skill-card')).toHaveCount(1);
  const folderButton = page.getByTestId('folder-item').getByRole('button', { name: folderName, exact: true });
  await folderButton.click();
  await expect(page.getByRole('navigation', { name: '文件夹位置', exact: true }).getByRole('button', { name: folderName, exact: true })).toHaveCount(0);
  await folderButton.dblclick();
  await expect(page.getByRole('navigation', { name: '文件夹位置', exact: true }).getByRole('button', { name: folderName, exact: true })).toBeVisible();
  await expect(page.getByTestId('skill-card')).toContainText('Alpha Research');
  await rightClickItem(page, originalItem);
  await page.getByRole('menuitem', { name: '移动到文件夹', exact: true }).hover();
  await expect(page.getByRole('menuitemcheckbox', { name: folderName, exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expectSourceFinderUi(page);

  await openPacks(page);
  await page.getByTestId('create-pack').click();
  dialog = page.getByRole('dialog', { name: '新建 Pack', exact: true });
  await dialog.getByLabel('Pack 名称', { exact: true }).fill(packName);
  await dialog.getByLabel('说明', { exact: true }).fill('A fixture collection, safely isolated.');
  await dialog.getByRole('button', { name: '保存 Pack', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(packName);
  await expect(page.getByTestId('skill-card')).toHaveCount(0);
  await page.getByTestId('add-to-pack').click();
  dialog = page.getByRole('dialog', { name: `导入到 ${packName}`, exact: true });
  const importSearch = dialog.getByRole('textbox', { name: '搜索已安装 Skill', exact: true });
  await importSearch.fill('Alpha');
  await importSearch.press('Enter');
  await dialog.locator('.managed-selection-row').click();
  await expect(dialog.locator('.managed-selection-row')).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('button', { name: '导入 1 个', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByTestId('skill-card')).toHaveCount(1);
  await page.getByRole('button', { name: '列表视图', exact: true }).click();
  await expect(page.getByTestId('skill-card')).toContainText(packName);
  const imported = await snapshot(page);
  const pack = imported.packs.find(item => item.name === packName)!;
  const managed = imported.managedSkills.find(item => item.packId === pack.id)!;
  expect(managed.path).not.toEqual(original.path);
  expect(await readFile(path.join(managed.path, 'SKILL.md'), 'utf8')).toEqual(originalText);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 Pack', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain('skill-shelf-pack.json');
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  const portable = JSON.parse(await readFile(downloadPath!, 'utf8'));
  expect(portable.format).toBe('skill-shelf-pack');
  expect(portable.skills).toHaveLength(1);
  expect(JSON.stringify(portable)).not.toContain(imported.homeDir);
  const importedDocument = { ...portable, pack: { ...portable.pack, name: `${packName} shared` } };
  await page.getByLabel('导入 Pack JSON', { exact: true }).setInputFiles({ name: 'shared.skill-shelf-pack.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(importedDocument)) });
  await expect(page.getByRole('status')).toContainText('Pack 已导入');
  expect((await snapshot(page)).packs.some(item => item.name === `${packName} shared`)).toBeTruthy();

  await rightClickItem(page, page.locator(`[data-finder-item-key="skill:${managed.id}"]`));
  await expect(page.getByRole('menuitem', { name: '整理 Alpha Research', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '删除', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '移动到文件夹', exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: '添加 Skill', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '部署 Skills', exact: true });
  const target = path.join(imported.dataDir, '..', `ui-deploy-${suffix}`);
  await dialog.getByLabel('目标目录（绝对路径）').fill(target);
  await dialog.getByRole('button', { name: '部署到目标目录', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  let deployed = (await snapshot(page)).managedSkills.find(item => item.id === managed.id)!;
  expect(deployed.deployments).toHaveLength(1);
  expect(await readFile(path.join(deployed.deployments[0].targetPath, 'SKILL.md'), 'utf8')).toEqual(originalText);
  await page.getByTestId('skill-card').getByRole('button', { name: '查看 Alpha Research 详情' }).click();
  dialog = page.getByRole('dialog', { name: 'Alpha Research', exact: true });
  await expect(dialog.getByRole('heading', { name: /^部署记录/ })).toContainText('1');
  await expect(dialog).toContainText(deployed.deployments[0].targetPath);
  await dialog.getByRole('button', { name: '移除部署', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '移除这次部署？', exact: true });
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  deployed = (await snapshot(page)).managedSkills.find(item => item.id === managed.id)!;
  expect(deployed.deployments).toHaveLength(0);
  expect(await readFile(path.join(original.path, 'SKILL.md'), 'utf8')).toEqual(originalText);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('supports alternate views, settings and narrow screens without document overflow', async ({ page }) => {
  await page.goto('/#skills:global');
  await expect(page.getByTestId('skill-card')).toHaveCount(2);
  for (const name of ['图标视图', '列表视图', '分栏视图']) {
    const control = page.getByRole('button', { name, exact: true });
    await control.click();
    await expect(control).toHaveAttribute('aria-pressed', 'true');
    await expectSourceFinderUi(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  }
  await openNavigation(page);
  const primaryNavigation = page.getByRole('navigation', { name: 'Skill Shelf 导航', exact: true });
  await expect(primaryNavigation.getByRole('button', { name: /^Skills/ })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('navigation', { name: '安装范围', exact: true })).toBeVisible();
  await expect(page.getByTestId('create-pack')).toHaveCount(0);
  await primaryNavigation.getByRole('button', { name: 'Packs', exact: true }).click();
  await openNavigation(page);
  await expect(page.getByRole('navigation', { name: 'Packs', exact: true })).toBeVisible();
  await expect(page.getByTestId('create-pack')).toBeVisible();
  await expect(page.getByRole('navigation', { name: '安装范围', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  for (const name of ['图标视图', '列表视图', '分栏视图']) {
    await page.getByRole('button', { name, exact: true }).click();
    await expectSourceFinderUi(page);
  }
  await openNavigation(page);
  await primaryNavigation.getByRole('button', { name: /^Skills/ }).click();
  await openNavigation(page);
  await page.getByRole('navigation', { name: '应用设置', exact: true }).getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  const settingsNavigation = page.getByRole('navigation', { name: '设置分类', exact: true });
  await settingsNavigation.getByRole('button', { name: 'Skills 与 Agent', exact: true }).click();
  await expect(page.getByRole('heading', { name: '已安装的 Skill', exact: true })).toBeVisible();
  await settingsNavigation.getByRole('button', { name: '外观', exact: true }).click();
  await page.getByRole('radiogroup', { name: '外观主题', exact: true }).getByRole('radio', { name: '深色', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('radiogroup', { name: '外观主题', exact: true }).getByRole('radio', { name: '浅色', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await settingsNavigation.getByRole('button', { name: 'Skills 与 Agent', exact: true }).click();
  await page.getByRole('button', { name: '添加来源', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '连接 Skill 来源', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Skill 目录（绝对路径）', { exact: true }).fill('relative/path');
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('请输入本机绝对路径');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
});

test('Finder mixes folder and Skill selection, moves by canvas folder drop and retains real hierarchy history', async ({ page }, testInfo) => {
  const initial = await snapshot(page);
  const alpha = initial.skills.find(item => item.name === 'Alpha Research')!;
  const beta = initial.skills.find(item => item.name === 'Beta Design')!;
  const suffix = testInfo.project.name;
  let state = await update(page, '/api/folders', 'post', { name: `Destination ${suffix}`, scopeId: 'global' });
  const destination = state.folders.find(item => item.name === `Destination ${suffix}`)!;
  state = await update(page, '/api/folders', 'post', { name: `Movable ${suffix}`, scopeId: 'global' });
  const movable = state.folders.find(item => item.name === `Movable ${suffix}`)!;
  state = await update(page, '/api/folders', 'post', { name: `Nested ${suffix}`, scopeId: 'global', parentId: destination.id });
  const nested = state.folders.find(item => item.name === `Nested ${suffix}`)!;
  await update(page, '/api/organization', 'patch', { ids: [alpha.id], folderId: nested.id });
  await page.goto('/#skills:global');
  const movableItem = page.locator(`[data-finder-item-key="folder:${movable.id}"]`);
  const betaItem = page.locator(`[data-finder-item-key="skill:${beta.id}"]`);
  await movableItem.click({ position: { x: 5, y: 5 } });
  await betaItem.click({ modifiers: ['Meta'], position: { x: 5, y: 5 } });
  await expect(movableItem).toHaveAttribute('aria-selected', 'true');
  await expect(betaItem).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-finder-item-key][aria-selected="true"]')).toHaveCount(2);
  await movableItem.click({ button: 'right', position: { x: 5, y: 5 } });
  const menu = page.getByRole('menu', { name: 'Finder 快捷操作', exact: true });
  await expect(menu).toContainText('已选择 2 项');
  await expect(menu.getByRole('menuitem', { name: '移动到文件夹', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  const target = page.locator(`[data-finder-item-key="folder:${destination.id}"] .finder-icon-button`);
  await target.scrollIntoViewIfNeeded();
  const targetBox = (await target.boundingBox())!;
  await dragCanvasItem(page, movableItem, { x: targetBox.x + targetBox.width / 2, y: targetBox.y + 32 });
  await expect.poll(async () => (await snapshot(page)).organization[beta.id].folderId).toBe(destination.id);
  state = await snapshot(page);
  expect(state.folders.find(item => item.id === movable.id)!.parentId).toBe(destination.id);
  expect(state.organization[beta.id].folderId).toBe(destination.id);
  await page.getByRole('button', { name: '分栏视图', exact: true }).click();
  await expect(page.getByTestId('finder-column')).toHaveCount(1);
  await page.getByTestId('finder-column').first().getByRole('button', { name: new RegExp(`^${destination.name}`) }).click();
  await expect(page.getByTestId('finder-column')).toHaveCount(2);
  await expect(page.getByTestId('finder-column').nth(1)).toContainText(movable.name);
  await expect(page.getByTestId('finder-column').nth(1)).toContainText('Beta Design');
  await page.getByTestId('finder-column').nth(1).getByRole('button', { name: new RegExp(`^${nested.name}`) }).click();
  await expect(page.getByTestId('finder-column')).toHaveCount(3);
  await expect(page.getByTestId('finder-column').nth(2)).toContainText('Alpha Research');
  await expect(page.getByRole('navigation', { name: '文件夹位置', exact: true }).getByRole('button', { name: nested.name, exact: true })).toBeVisible();
  const search = page.getByRole('textbox', { name: '搜索已安装的 Skill', exact: true });
  await search.fill(destination.name);
  await search.press('Enter');
  await expect(page.getByTestId('skill-card')).toHaveCount(0);
  await expect(page.getByTestId('folder-item')).toHaveCount(0);
  await search.fill('');
  await expect(page.getByTestId('finder-column')).toHaveCount(3);
  await search.fill('Beta');
  await expect(page.getByTestId('finder-column')).toHaveCount(3);
  await search.press('Enter');
  await expect(page.getByTestId('finder-column')).toHaveCount(1);
  await expect(page.getByTestId('skill-card')).toContainText('Beta Design');
  await expect(page.getByTestId('folder-item')).toHaveCount(0);
  await search.fill('');
  await expect(page.getByTestId('finder-column')).toHaveCount(3);
  await expect(page.getByTestId('finder-column').nth(2)).toContainText('Alpha Research');
  await expect(page.getByRole('navigation', { name: '文件夹位置', exact: true }).getByRole('button', { name: nested.name, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '后退', exact: true }).click();
  await expect(page.getByTestId('finder-column')).toHaveCount(2);
  await expect(page.getByRole('navigation', { name: '文件夹位置', exact: true }).getByRole('button', { name: destination.name, exact: true })).toBeVisible();
  await page.getByRole('button', { name: '前进', exact: true }).click();
  await expect(page.getByTestId('finder-column')).toHaveCount(3);
  await expect(page.getByRole('navigation', { name: '文件夹位置', exact: true }).getByRole('button', { name: nested.name, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  if (process.env.SHELF_CAPTURE_SCREENSHOTS === '1' && testInfo.project.name === 'desktop') {
    await captureFinder(page, 'skill-shelf-finder-columns.png');
  }
});

test('Finder persists group canvas drag, supports marquee and additive Shift selection, sort and clean up', async ({ page }, testInfo) => {
  await page.goto('/#skills:global');
  const initial = await snapshot(page);
  const alpha = initial.skills.find(item => item.name === 'Alpha Research')!;
  const beta = initial.skills.find(item => item.name === 'Beta Design')!;
  const alphaItem = page.locator(`[data-finder-item-key="skill:${alpha.id}"]`);
  const betaItem = page.locator(`[data-finder-item-key="skill:${beta.id}"]`);
  await alphaItem.getByRole('button', { name: '查看 Alpha Research 详情', exact: true }).click({ modifiers: ['Meta'] });
  await betaItem.getByRole('button', { name: '查看 Beta Design 详情', exact: true }).click({ modifiers: ['Meta'] });
  await alphaItem.scrollIntoViewIfNeeded();
  const start = (await alphaItem.boundingBox())!;
  await page.mouse.move(start.x + 5, start.y + 5);
  await page.mouse.down();
  await page.mouse.move(start.x + 36, start.y + 105, { steps: 10 });
  await page.mouse.up();
  await expect.poll(async () => (await snapshot(page)).finderPositions[`skill:${alpha.id}`]).toEqual({ x: 47, y: 118 });
  expect((await snapshot(page)).finderPositions[`skill:${beta.id}`]).toEqual({ x: 175, y: 118 });
  await page.reload();
  await expect(alphaItem).toHaveAttribute('style', /47px.*118px/);
  await expect(betaItem).toHaveAttribute('style', /175px.*118px/);
  const surface = page.getByTestId('finder-canvas-surface');
  await surface.scrollIntoViewIfNeeded();
  const box = (await surface.boundingBox())!;
  const a = (await alphaItem.boundingBox())!;
  const b = (await betaItem.boundingBox())!;
  const right = Math.max(a.x + a.width, b.x + b.width) - box.x + 2;
  const bottom = Math.max(a.y + a.height, b.y + b.height) - box.y + 2;
  // Keep the gesture outside the scope pane's overlapping resize handle.
  await page.mouse.move(box.x + 12, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + right, box.y + bottom, { steps: 10 });
  await page.mouse.up();
  await expect(alphaItem).toHaveAttribute('aria-selected', 'true');
  await expect(betaItem).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-finder-item-key][aria-selected="true"]')).toHaveCount(2);
  await clearFinderSelection(page);
  await alphaItem.getByRole('button', { name: '查看 Alpha Research 详情', exact: true }).click();
  const detail = page.getByRole('dialog', { name: 'Alpha Research', exact: true });
  await expect(detail).toHaveAttribute('aria-modal', 'false');
  if (testInfo.project.name === 'mobile') {
    await detail.getByRole('button', { name: '关闭', exact: true }).click();
  } else {
    const resize = detail.getByRole('separator', { name: '调整 Skill 详情宽度', exact: true });
    await resize.focus();
    await resize.press('Home');
    await expect(resize).toHaveAttribute('aria-valuenow', await resize.getAttribute('aria-valuemin') || '480');
  }
  await betaItem.click({ modifiers: ['Shift'], position: { x: 2, y: 2 } });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('[data-finder-item-key][aria-selected="true"]')).toHaveCount(2);
  await chooseFinderOption(page, '排序', '名称');
  await chooseFinderOption(page, '排序', '降序');
  const names = await page.getByTestId('skill-card').evaluateAll(elements => elements.map(element => element.getAttribute('data-skill-name')));
  expect(names).toEqual(['Beta Design', 'Alpha Research']);
  await chooseFinderOption(page, '群组方式', '来源');
  await expect(page.locator('.finder-group-heading')).toHaveCount(2);
  await chooseFinderOption(page, '排序', '无');
  await chooseFinderOption(page, '群组方式', '无');
  await rightClickBackground(page);
  await clickCascadedChoice(page, page.getByRole('menuitem', { name: '显示', exact: true }), page.getByRole('menuitemcheckbox', { name: '对齐到网格', exact: true }));
  await rightClickBackground(page);
  await page.getByRole('menuitem', { name: '显示', exact: true }).hover();
  await expect(page.getByRole('menuitemcheckbox', { name: '对齐到网格', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '排序', exact: true }).click();
  await page.getByRole('menuitem', { name: '整理', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).finderPositions[`skill:${alpha.id}`].y).toBe(24);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  if (process.env.SHELF_CAPTURE_SCREENSHOTS === '1' && testInfo.project.name === 'desktop') {
    await captureFinder(page, 'skill-shelf-finder-canvas.png');
  }
});

test('Magpie AI sidebar performs explicit fake-gateway generation, save, reload, translation and safe error handling', async ({ page }, testInfo) => {
  const state = await snapshot(page);
  const alpha = state.skills.find(item => item.name === 'Alpha Research')!;
  const original = await readFile(path.join(alpha.path, 'SKILL.md'), 'utf8');
  const headers = { 'X-Shelf-Token': await session(page) };
  const status = await (await page.request.get('/api/ai/status', { headers })).json();
  const stats = async () => (await (await page.request.get(`${status.baseUrl}/__test/status`)).json()).requests as { body: { model: string } }[];
  const results = async () => (await (await page.request.get(`/api/ai/result?id=${alpha.id}`, { headers })).json());
  const baseline = await results();
  await page.goto('/#skills:global');
  await page.evaluate(() => localStorage.setItem('shelf-ai:preferences', JSON.stringify({ enabled: true, chatModel: 'fixture/other', summaryModel: 'fixture/text', translationModel: 'fixture/other', targetLanguage: 'en', summaryContext: 'skill-md' })));
  await page.reload();
  await page.locator(`[data-finder-item-key="skill:${alpha.id}"]`).getByRole('button', { name: '查看 Alpha Research 详情' }).click();
  const panel = page.getByTestId('ai-assistant-sidebar');
  await expect(panel).toHaveCount(0);
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  const model = panel.getByRole('combobox', { name: '对话模型', exact: true });
  await expect(model).toBeVisible();
  await model.click();
  await expect(page.getByRole('option')).toHaveCount(2);
  await page.keyboard.press('Escape');
  expect(await stats()).toHaveLength(0);
  await panel.getByRole('button', { name: '生成描述', exact: true }).click();
  await expect(panel.locator('.ai-message.is-assistant').last()).toContainText('Fixture summary: research reliable sources and preserve accurate citations.');
  expect(await stats()).toHaveLength(1);
  expect((await results()).summary?.savedAt).toBe(baseline.summary?.savedAt);
  if (process.env.SHELF_CAPTURE_SCREENSHOTS === '1' && testInfo.project.name === 'desktop') await captureFinder(page, 'skill-shelf-magpie-ai.png');
  await panel.getByRole('button', { name: '新建对话', exact: true }).click();
  await expect(panel.locator('.ai-message')).toHaveCount(0);
  expect((await results()).summary?.savedAt).toBe(baseline.summary?.savedAt);
  await panel.getByRole('button', { name: '生成描述', exact: true }).click();
  await expect(panel.getByRole('button', { name: '保存为描述', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: '保存为描述', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('描述已保存在本地。');
  expect((await results()).summary.model).toBe('fixture/other');
  expect(await stats()).toHaveLength(2);
  expect(await readFile(path.join(alpha.path, 'SKILL.md'), 'utf8')).toBe(original);
  await page.reload();
  await page.locator(`[data-finder-item-key="skill:${alpha.id}"]`).getByRole('button', { name: '查看 Alpha Research 详情' }).click();
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await expect(panel).toBeVisible();
  expect(await stats()).toHaveLength(2);
  await selectChoice(panel.getByRole('combobox', { name: '翻译为', exact: true }), 'zh-CN');
  await panel.getByRole('button', { name: '翻译', exact: true }).click();
  await expect(panel.locator('.ai-message.is-assistant').last()).toContainText('Fixture translation: research and summarize reliable sources.');
  await panel.getByRole('button', { name: '保存为描述', exact: true }).click();
  await expect(panel.getByRole('button', { name: '已保存', exact: true })).toBeVisible();
  expect((await results()).translations.some((item: { language: string }) => item.language === 'zh-CN')).toBeTruthy();
  expect(await stats()).toHaveLength(3);
  await panel.getByRole('button', { name: '关闭 AI 助手', exact: true }).click();
  await page.getByRole('dialog', { name: 'Alpha Research', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
  expect(alpha.path).toContain('skill-shelf-test-');
  try {
    await writeFile(path.join(alpha.path, 'SKILL.md'), original + '\nThis isolated fixture now has updated source content.\n');
    await update(page, '/api/rescan', 'post', {});
    await page.reload();
    await page.getByRole('button', { name: '列表视图', exact: true }).click();
    const row = page.locator(`[data-finder-item-key="skill:${alpha.id}"]`);
    await expect(row.locator('.skill-row-description')).toHaveText('Research and summarize reliable sources.');
    await expect(row.locator('.ai-inline-badge')).toHaveCount(0);
    expect((await results()).summary.stale).toBeTruthy();
    expect(await stats()).toHaveLength(3);
  } finally {
    await writeFile(path.join(alpha.path, 'SKILL.md'), original);
    await update(page, '/api/rescan', 'post', {});
    await page.reload();
  }
  await page.locator(`[data-finder-item-key="skill:${alpha.id}"]`).getByRole('button', { name: '查看 Alpha Research 详情', exact: true }).click();
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  expect((await page.request.post(`${status.baseUrl}/__test/status`, { data: { failure: true } })).ok()).toBeTruthy();
  try {
    await panel.getByRole('button', { name: '生成描述', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('HTTP 502');
    await expect(panel.getByRole('button', { name: '保存为描述', exact: true })).toHaveCount(0);
    expect((await results()).summary.model).toBe('fixture/other');
    expect(await readFile(path.join(alpha.path, 'SKILL.md'), 'utf8')).toBe(original);
  } finally {
    expect((await page.request.post(`${status.baseUrl}/__test/status`, { data: { failure: false } })).ok()).toBeTruthy();
  }
});

test('read-only file preview follows listed relative links without fetching missing files or external content', async ({ page }) => {
  const state = await snapshot(page);
  const alpha = state.skills.find(skill => skill.name === 'Alpha Research')!;
  expect(alpha.path).toContain('skill-shelf-test-');
  const filename = path.join(alpha.path, 'SKILL.md');
  const original = await readFile(filename, 'utf8');
  const fileRequests: string[] = [];
  const externalRequests: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/skill/file') fileRequests.push(url.searchParams.get('path') || '');
    if (url.hostname === 'example.invalid') externalRequests.push(request.url());
  });
  try {
    await writeFile(filename, original + '\n[Context](references/context.md)\n\n[Missing](missing.md)\n\n[Outside](../../../secret.md)\n\n[External](https://example.invalid/reference)\n\n![Remote image](https://example.invalid/image.png)\n');
    await update(page, '/api/rescan', 'post', {});
    await page.goto('/#skills:global');
    await page.getByTestId('skill-card').filter({ hasText: 'Alpha Research' }).getByRole('button', { name: '查看 Alpha Research 详情', exact: true }).click();
    const detail = page.getByRole('dialog', { name: 'Alpha Research', exact: true });
    await detail.getByRole('tab', { name: '文件', exact: true }).click();
    const preview = detail.locator('.markdown-body');
    await expect(preview.getByRole('link', { name: 'Context', exact: true })).toBeVisible();
    await expect(preview.getByRole('link', { name: 'Missing', exact: true })).toHaveCount(0);
    await expect(preview.getByRole('link', { name: 'Outside', exact: true })).toHaveCount(0);
    await expect(preview.locator('.markdown-unavailable-link')).toHaveText(['Missing', 'Outside']);
    await expect(preview.getByRole('link', { name: 'External', exact: true })).toHaveAttribute('target', '_blank');
    await expect(preview.getByRole('link', { name: 'External', exact: true })).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(preview.getByRole('img')).toHaveCount(0);
    await preview.getByRole('link', { name: 'Context', exact: true }).click();
    await expect(detail.getByRole('treeitem', { name: 'references', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await expect(detail.getByRole('treeitem', { name: 'context.md', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(preview).toContainText('Keep citations precise.');
    expect(fileRequests).toEqual(['SKILL.md', 'references/context.md']);
    expect(externalRequests).toEqual([]);
  } finally {
    await writeFile(filename, original);
    await update(page, '/api/rescan', 'post', {});
  }
  expect(await readFile(filename, 'utf8')).toBe(original);
});

test('Finder inherits first-visit options, persists each location and isolates scopes without trapping inspector focus', async ({ page }, testInfo) => {
  const initial = await snapshot(page);
  const alpha = initial.skills.find(skill => skill.name === 'Alpha Research')!;
  if (!initial.managedSkills.some(skill => skill.packId === 'default')) {
    await update(page, '/api/packs/default/skills', 'post', { skillIds: [alpha.id] });
  }
  const folderName = `View Memory ${testInfo.project.name}`;
  const state = await update(page, '/api/folders', 'post', { name: folderName, scopeId: 'global' });
  const folder = state.folders.find(item => item.name === folderName)!;
  await update(page, '/api/organization', 'patch', { ids: [alpha.id], folderId: folder.id });
  await page.goto('/#skills:global');
  await page.getByTestId('skill-card').getByRole('button', { name: '查看 Beta Design 详情', exact: true }).click();
  const detail = page.getByRole('dialog', { name: 'Beta Design', exact: true });
  await expect(detail).toHaveAttribute('aria-modal', 'false');
  const sort = page.getByRole('button', { name: '排序', exact: true });
  for (const key of ['Escape', 'Tab']) {
    await sort.focus();
    await sort.press('Enter');
    await expect(page.getByRole('menu', { name: '排序', exact: true })).toBeVisible();
    await page.keyboard.press(key);
    if (key === 'Tab') {
      await expect(page.getByRole('menu', { name: '排序', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
    }
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(detail).toBeVisible();
  }
  await detail.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '分栏视图', exact: true }).click();
  await chooseFinderOption(page, '排序', '名称');
  await chooseFinderOption(page, '群组方式', '种类');
  await page.getByTestId('finder-column').first().getByRole('button', { name: folderName, exact: true }).click();
  await expect(page.getByTestId('finder-column')).toHaveCount(2);
  await expect(page.getByRole('button', { name: '分栏视图', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expectFinderOption(page, '排序', '名称');
  await expectFinderOption(page, '群组方式', '种类');
  await page.getByRole('button', { name: '列表视图', exact: true }).click();
  await chooseFinderOption(page, '排序', '标签');
  await page.getByRole('button', { name: '后退', exact: true }).click();
  await expect(page.getByRole('button', { name: '分栏视图', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('finder-column')).toHaveCount(1);
  await expectFinderOption(page, '排序', '名称');
  await page.getByRole('button', { name: '前进', exact: true }).click();
  await expect(page.getByRole('button', { name: '列表视图', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expectFinderOption(page, '排序', '标签');
  await page.getByRole('navigation', { name: '文件夹位置', exact: true }).getByRole('button', { name: '全局', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: '分栏视图', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expectFinderOption(page, '排序', '名称');
  await page.getByTestId('finder-column').first().getByRole('button', { name: folderName, exact: true }).click();
  await expect(page.getByRole('button', { name: '列表视图', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expectFinderOption(page, '排序', '标签');
  await openPacks(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '图标视图', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await chooseFinderOption(page, '排序', '来源');
  await chooseFinderOption(page, '群组方式', '标签');
  await openNavigation(page);
  await page.getByRole('navigation', { name: 'Skill Shelf 导航', exact: true }).getByRole('button', { name: /^Skills/ }).click();
  await expect(page.getByRole('button', { name: '分栏视图', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expectFinderOption(page, '排序', '名称');
  await expectFinderOption(page, '群组方式', '种类');
  await openPacks(page);
  await page.keyboard.press('Escape');
  await expectFinderOption(page, '排序', '来源');
  await expectFinderOption(page, '群组方式', '标签');
});

test('native item and background context menus keep source selection rules and do not mix actions', async ({ page }, testInfo) => {
  const initial = await snapshot(page);
  const alpha = initial.skills.find(skill => skill.name === 'Alpha Research')!;
  const beta = initial.skills.find(skill => skill.name === 'Beta Design')!;
  const folderName = `Context Selection ${testInfo.project.name}`;
  const state = await update(page, '/api/folders', 'post', { name: folderName, scopeId: 'global' });
  const folder = state.folders.find(item => item.name === folderName)!;
  await page.goto('/#skills:global');
  const alphaItem = page.locator(`[data-finder-item-key="skill:${alpha.id}"]`);
  const betaItem = page.locator(`[data-finder-item-key="skill:${beta.id}"]`);
  const folderItem = page.locator(`[data-finder-item-key="folder:${folder.id}"]`);
  await alphaItem.getByRole('button', { name: '查看 Alpha Research 详情', exact: true }).click({ modifiers: ['Meta'] });
  await betaItem.getByRole('button', { name: '查看 Beta Design 详情', exact: true }).click({ modifiers: ['Meta'] });
  await rightClickItem(page, betaItem);
  const menu = page.getByRole('menu').first();
  await expect(menu).toContainText('已选择 2 项');
  await expect(alphaItem).toHaveAttribute('aria-selected', 'true');
  await expect(betaItem).toHaveAttribute('aria-selected', 'true');
  await expect(menu.getByRole('menuitem', { name: '移动到文件夹', exact: true })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: '翻译所选项目的 description', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '将所选 Skill 导入 Packs', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '编辑所选标签', exact: true })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: '显示', exact: true })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: '新建文件夹', exact: true })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: '查看详情', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  const blank = await rightClickBackground(page);
  await expect(menu).toContainText('当前位置');
  await expect(menu.getByRole('menuitem', { name: '显示', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '移动到文件夹', exact: true })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: '编辑所选标签', exact: true })).toHaveCount(0);
  // Original source preserves selection on blank right click; only a left click clears it.
  await expect(alphaItem).toHaveAttribute('aria-selected', 'true');
  await expect(betaItem).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await page.mouse.click(blank.x, blank.y);
  await expect(page.locator('[data-finder-item-key][aria-selected="true"]')).toHaveCount(0);
  await rightClickItem(page, folderItem);
  await expect(folderItem).toHaveAttribute('aria-selected', 'true');
  await expect(alphaItem).toHaveAttribute('aria-selected', 'false');
  await expect(betaItem).toHaveAttribute('aria-selected', 'false');
  await expect(menu.getByRole('menuitem', { name: '重命名文件夹', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '移动到文件夹', exact: true })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: '翻译此文件夹中的 description', exact: true })).toBeDisabled();
  await expect(menu.getByRole('menuitem', { name: '将文件夹中的 Skill 导入 Packs', exact: true })).toBeDisabled();
  await expect(menu.getByRole('menuitem', { name: '新建文件夹', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  if (testInfo.project.name !== 'mobile') {
    await alphaItem.getByRole('button', { name: '查看 Alpha Research 详情', exact: true }).click();
    const detail = page.getByRole('dialog', { name: 'Alpha Research', exact: true });
    const resize = detail.getByRole('separator', { name: '调整 Skill 详情宽度', exact: true });
    await resize.focus();
    await resize.press('Home');
    await rightClickItem(page, betaItem);
    await expect(detail).not.toBeVisible();
    await expect(betaItem).toHaveAttribute('aria-selected', 'true');
    await expect(alphaItem).toHaveAttribute('aria-selected', 'false');
    await expect(menu.getByRole('menuitem', { name: '查看详情', exact: true })).toBeVisible();
  }
});

test('source context actions save description-only translations, import directly with deduplication and open the actual folder', async ({ page }, testInfo) => {
  const initial = await snapshot(page);
  expect(initial.dataDir).toContain('skill-shelf-test-');
  const fixturePath = path.join(initial.dataDir, '..', `context-translation-${testInfo.project.name}-${Date.now()}`);
  const alphaName = `Context Alpha ${testInfo.project.name}`;
  const betaName = `Context Beta ${testInfo.project.name}`;
  for (const [slug, name, description] of [['alpha', alphaName, 'Research and summarize reliable sources.'], ['beta', betaName, 'Design thoughtful interface layouts.']]) {
    await mkdir(path.join(fixturePath, slug), { recursive: true });
    await writeFile(path.join(fixturePath, slug, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# Synthetic test fixture\n\nNEVER SEND THESE INSTRUCTIONS FOR DESCRIPTION TRANSLATION.\n`);
  }
  const added = await update(page, '/api/roots', 'post', { path: fixturePath, label: 'Context translation fixtures' });
  const root = added.roots.find(item => item.path === fixturePath)!;
  const cleanup = await playwrightRequest.newContext({ baseURL: testInfo.project.use.baseURL });
  const cleanupHeaders = { 'X-Shelf-Token': await session(page) };
  try {
    const alpha = added.skills.find(skill => skill.name === alphaName)!;
    const beta = added.skills.find(skill => skill.name === betaName)!;
    const originals = await Promise.all([alpha, beta].map(skill => readFile(path.join(skill.path, 'SKILL.md'), 'utf8')));
    let state = await update(page, '/api/folders', 'post', { name: `Translate ${testInfo.project.name}`, scopeId: 'global' });
    const folder = state.folders.find(item => item.name === `Translate ${testInfo.project.name}`)!;
    state = await update(page, '/api/folders', 'post', { name: 'Nested translation', parentId: folder.id, scopeId: 'global' });
    const nested = state.folders.find(item => item.parentId === folder.id)!;
    await update(page, '/api/organization', 'patch', { ids: [alpha.id], folderId: nested.id });
    const headers = { 'X-Shelf-Token': await session(page) };
    const ai = await (await page.request.get('/api/ai/status', { headers })).json();
    const stats = async () => (await (await page.request.get(`${ai.baseUrl}/__test/status`)).json()).requests as { body: { messages: { role: string; content: string }[] } }[];
    const openerRequests: unknown[] = [];
    await page.route('**/api/skill/open-folder', async route => {
      openerRequests.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ opened: true }) });
    });
    await page.goto('/#skills:global');
    const folderItem = page.locator(`[data-finder-item-key="folder:${folder.id}"]`);
    const betaItem = page.locator(`[data-finder-item-key="skill:${beta.id}"]`);
    await folderItem.getByRole('button', { name: folder.name, exact: true }).click({ modifiers: ['Meta'] });
    await betaItem.getByRole('button', { name: `查看 ${betaName} 详情`, exact: true }).click({ modifiers: ['Meta'] });
    await rightClickItem(page, folderItem);
    await page.getByRole('menuitem', { name: '翻译所选项目的 description', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('ai-draft-preview')).toHaveCount(0);
    await expect.poll(async () => {
      const results = await Promise.all([alpha, beta].map(async skill => (await (await page.request.get(`/api/ai/result?id=${skill.id}`, { headers })).json()).translations));
      return results.every(items => items.some((item: { language: string; text: string }) => item.language === 'zh-CN' && item.text === 'Fixture translation: research and summarize reliable sources.'));
    }).toBeTruthy();
    await expect.poll(async () => (await stats()).length).toBe(2);
    const references = (await stats()).map(call => {
      const user = call.body.messages.find(item => item.role === 'user')!.content;
      return JSON.parse(user.split('BEGIN_UNTRUSTED_SKILL_REFERENCE_JSON\n')[1].split('\nEND_UNTRUSTED_SKILL_REFERENCE_JSON')[0]);
    });
    expect(references).toEqual(expect.arrayContaining([
      { skillName: alphaName, untrustedReference: 'Research and summarize reliable sources.' },
      { skillName: betaName, untrustedReference: 'Design thoughtful interface layouts.' },
    ]));
    expect(await Promise.all([alpha, beta].map(skill => readFile(path.join(skill.path, 'SKILL.md'), 'utf8')))).toEqual(originals);
    await expect(page.getByRole('status')).toContainText('已翻译 2 个 description');
    await rightClickItem(page, folderItem);
    await page.getByRole('menuitem', { name: '翻译所选项目的 description', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('所选 description 已有当前语言的翻译');
    expect(await stats()).toHaveLength(2);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: '列表视图', exact: true }).click();
    await betaItem.getByRole('button', { name: `打开 ${betaName} 文件夹`, exact: true }).click();
    await expect.poll(() => openerRequests).toEqual([{ id: beta.id }]);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await rightClickItem(page, folderItem);
    await page.getByRole('menuitem', { name: '将所选 Skill 导入 Packs', exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).managedSkills.filter(skill => [alpha.path, beta.path].includes(skill.sourcePath)).length).toBe(2);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const imported = (await snapshot(page)).managedSkills.filter(skill => [alpha.path, beta.path].includes(skill.sourcePath));
    expect(imported.every(skill => skill.packId === 'default')).toBeTruthy();
    for (const skill of imported) {
      expect(await readFile(path.join(skill.path, 'SKILL.md'), 'utf8')).toBe(originals[skill.sourcePath === alpha.path ? 0 : 1]);
    }
    await rightClickItem(page, folderItem);
    await page.getByRole('menuitem', { name: '将所选 Skill 导入 Packs', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('所选 Skill 已经导入 Packs');
    expect((await snapshot(page)).managedSkills.filter(skill => [alpha.path, beta.path].includes(skill.sourcePath))).toHaveLength(2);
    await expectSourceFinderUi(page);
  } finally {
    try {
      const fresh = await (await cleanup.get('/api/state', { headers: cleanupHeaders })).json() as UiSnapshot;
      for (const skill of fresh.managedSkills.filter(skill => skill.sourcePath.startsWith(fixturePath + path.sep))) {
        expect((await cleanup.delete(`/api/managed/${skill.id}`, { headers: cleanupHeaders })).ok()).toBeTruthy();
      }
      const response = await cleanup.delete(`/api/roots/${root.id}`, { headers: cleanupHeaders });
      expect(response.ok()).toBeTruthy();
    } finally { await cleanup.dispose(); }
  }
});

test('native edge context menus cascade by mouse and keyboard and preserve source group preferences', async ({ page }, testInfo) => {
  await page.goto('/#skills:global');
  await rightClickBackground(page);
  const rootMenu = page.getByRole('menu').first();
  await expect(rootMenu).toContainText('当前位置');
  for (const name of ['显示', '群组方式', '排序方式', '整理方式']) {
    await expect(rootMenu.getByRole('menuitem', { name, exact: true })).toHaveAttribute('aria-haspopup', 'menu');
  }
  await expect(rootMenu.getByRole('menuitemcheckbox', { name: '使用群组', exact: true })).toHaveAttribute('aria-checked', 'false');
  await expectVisibleMenusWithinViewport(page);
  const display = rootMenu.getByRole('menuitem', { name: '显示', exact: true });
  await display.hover();
  const list = page.getByRole('menuitemradio', { name: '列表视图', exact: true });
  await expect(list).toBeVisible();
  await expect(page.getByRole('menuitemradio', { name: '图标视图', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('menuitemcheckbox', { name: '对齐到网格', exact: true })).toBeVisible();
  await expectVisibleMenusWithinViewport(page);
  if (process.env.SHELF_CAPTURE_SCREENSHOTS === '1' && testInfo.project.name === 'desktop') {
    await captureFinder(page, 'skill-shelf-context-menu.png');
  }
  const triggerBox = (await display.boundingBox())!;
  const targetBox = (await list.boundingBox())!;
  await page.mouse.move(triggerBox.x + triggerBox.width / 2, triggerBox.y + triggerBox.height / 2);
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 12 });
  await expect(list).toBeVisible();
  await page.mouse.click(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2);
  await expect(page.getByRole('button', { name: '列表视图', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await rightClickBackground(page);
  await expect(rootMenu.getByRole('menuitem', { name: '整理方式', exact: true })).toHaveCount(0);
  const listDisplay = rootMenu.getByRole('menuitem', { name: '显示', exact: true });
  await listDisplay.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('menuitemradio', { name: '列表视图', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('menuitemcheckbox', { name: '对齐到网格', exact: true })).toHaveCount(0);
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('menu')).toHaveCount(1);
  await expect(listDisplay).toBeFocused();
  const listSort = rootMenu.getByRole('menuitem', { name: '排序方式', exact: true });
  await listSort.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('menuitemradio', { name: '无', exact: true })).toHaveCount(0);
  await expect(page.getByRole('menuitemradio', { name: '名称', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('menuitemradio', { name: '降序', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(listSort).toBeFocused();
  await listDisplay.focus();
  await page.keyboard.press('ArrowRight');
  const iconView = page.getByRole('menuitemradio', { name: '图标视图', exact: true });
  await expect(iconView).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: '图标视图', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await rightClickBackground(page);
  await clickCascadedChoice(page, rootMenu.getByRole('menuitem', { name: '群组方式', exact: true }), page.getByRole('menuitemradio', { name: '标签', exact: true }));
  await expect(page.getByRole('menu')).toHaveCount(0);
  for (const checked of ['true', 'false']) {
    await rightClickBackground(page);
    const toggle = rootMenu.getByRole('menuitemcheckbox', { name: '使用群组', exact: true });
    await expect(toggle).toHaveAttribute('aria-checked', checked);
    await toggle.click();
    await expect(page.getByRole('menu')).toHaveCount(0);
  }
  await rightClickBackground(page);
  await rootMenu.getByRole('menuitem', { name: '群组方式', exact: true }).hover();
  await expect(page.getByRole('menuitemradio', { name: '标签', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expectVisibleMenusWithinViewport(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  const originalViewport = page.viewportSize()!;
  const previousGroup = await page.getByRole('button', { name: '群组方式', exact: true }).textContent();
  const previousSort = await page.getByRole('button', { name: '排序', exact: true }).textContent();
  try {
    await page.setViewportSize({ width: 320, height: originalViewport.height });
    await expect(page.getByRole('button', { name: '打开侧边栏', exact: true })).toBeVisible();
    await expect(page.locator('.navigation-panels')).toHaveAttribute('aria-hidden', 'true');
    for (const location of ['middle', 'edge']) {
      if (location === 'edge') await rightClickBackground(page);
      else {
        const bounds = (await page.locator('.finder-browser').boundingBox())!;
        const point = { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(Math.min(bounds.y + bounds.height - 20, originalViewport.height - 48)) };
        expect(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('.finder-browser')), point)).toBeTruthy();
        await page.mouse.click(point.x, point.y, { button: 'right' });
      }
      await expect(rootMenu).toContainText('当前位置');
      await expect(rootMenu.getByRole('menuitemcheckbox', { name: '使用群组', exact: true })).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByRole('button', { name: '群组方式', exact: true })).toHaveText(previousGroup!);
      await expect(page.getByRole('button', { name: '排序', exact: true })).toHaveText(previousSort!);
      await expect(page.getByRole('button', { name: '图标视图', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('selection-toolbar')).toHaveCount(0);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await rootMenu.getByRole('menuitem', { name: '显示', exact: true }).hover();
      await expect(page.getByRole('menuitemradio', { name: '列表视图', exact: true })).toBeVisible();
      await expectVisibleMenusWithinViewport(page);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toHaveCount(0);
    }
  } finally {
    await page.setViewportSize(originalViewport);
  }
});

test('blank native context creation uses the scrolled canvas point instead of a default grid position', async ({ page }, testInfo) => {
  await page.goto('/#skills:global');
  await expect(page.getByTestId('skill-card')).toHaveCount(2);
  if (testInfo.project.name === 'webkit') await page.evaluate(() => {
    const events: Record<string, unknown>[] = [];
    (window as unknown as { contextEvents: unknown[] }).contextEvents = events;
    for (const name of ['focusin', 'focusout', 'contextmenu', 'pointerdown', 'pointerup', 'scroll']) document.addEventListener(name, event => {
      const element = event.target as HTMLElement;
      events.push({ time: performance.now(), name, tag: element.tagName, role: element.getAttribute?.('role'), label: element.getAttribute?.('aria-label'), x: (event as PointerEvent).clientX, y: (event as PointerEvent).clientY });
    }, true);
    let count = 0;
    new MutationObserver(() => {
      const next = document.querySelectorAll('[role="menu"]').length;
      if (next !== count) { events.push({ time: performance.now(), name: 'menus', count: next }); count = next; }
    }).observe(document.body, { childList: true, subtree: true });
  });
  const browser = page.locator('.finder-browser');
  await browser.evaluate(element => { element.scrollLeft = 80; element.scrollTop = 80; });
  const bounds = (await browser.boundingBox())!;
  const scroll = await browser.evaluate(element => ({ x: element.scrollLeft, y: element.scrollTop }));
  const click = await rightClickBackground(page);
  const expected = { x: Math.max(12, click.x - bounds.x + scroll.x), y: Math.max(12, click.y - bounds.y + scroll.y) };
  try {
    await expect(page.getByRole('menuitem', { name: '新建文件夹', exact: true })).toBeVisible();
  } finally {
    if (testInfo.project.name === 'webkit') {
      const events = await page.evaluate(() => (window as unknown as { contextEvents: unknown[] }).contextEvents);
      await testInfo.attach('context-menu-events', { body: Buffer.from(JSON.stringify({ bounds, scroll, click, events }, null, 2)), contentType: 'application/json' });
    }
  }
  await page.getByRole('menuitem', { name: '新建文件夹', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '创建文件夹', exact: true });
  const name = `Pointer Folder ${testInfo.project.name}`;
  await dialog.getByLabel('文件夹名称', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: '创建文件夹', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const state = await snapshot(page);
  const folder = state.folders.find(item => item.name === name)!;
  expect(state.finderPositions[`folder:${folder.id}`]).toEqual(expected);
  const folderItem = page.locator(`[data-finder-item-key="folder:${folder.id}"]`);
  await expect.poll(() => finderPoint(folderItem)).toEqual(expected);
});

test('automatic sort and grouping reject free-position drops but still accept real folder drops', async ({ page }, testInfo) => {
  const initial = await snapshot(page);
  const alpha = initial.skills.find(skill => skill.name === 'Alpha Research')!;
  const folderName = `Auto Drop ${testInfo.project.name}`;
  const created = await update(page, '/api/folders', 'post', { name: folderName, scopeId: 'global' });
  const folder = created.folders.find(item => item.name === folderName)!;
  const finderWrites: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/finder' && request.method() === 'PATCH') finderWrites.push(request.postData() || ''); });
  for (const mode of ['sorted', 'grouped']) {
    await update(page, '/api/organization', 'patch', { ids: [alpha.id], folderId: null });
    await page.goto('/#skills:global');
    if (mode === 'sorted') await chooseFinderOption(page, '排序', '名称');
    else {
      await chooseFinderOption(page, '排序', '无');
      await chooseFinderOption(page, '群组方式', '种类');
    }
    const item = page.locator(`[data-finder-item-key="skill:${alpha.id}"]`);
    await item.scrollIntoViewIfNeeded();
    const originalVisual = await finderPoint(item);
    const originalPersisted = (await snapshot(page)).finderPositions[`skill:${alpha.id}`];
    finderWrites.length = 0;
    const browser = (await page.locator('.finder-browser').boundingBox())!;
    const viewport = page.viewportSize()!;
    await dragCanvasItem(page, item, { x: Math.min(browser.x + browser.width - 20, viewport.width - 20), y: Math.min(browser.y + browser.height - 32, viewport.height - 64) });
    await expect.poll(() => finderPoint(item)).toEqual(originalVisual);
    expect((await snapshot(page)).finderPositions[`skill:${alpha.id}`]).toEqual(originalPersisted);
    expect(finderWrites).toEqual([]);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    if (mode === 'sorted') await expectFinderOption(page, '排序', '名称');
    else await expectFinderOption(page, '群组方式', '种类');
    const target = page.locator(`[data-finder-item-key="folder:${folder.id}"] .finder-icon-button`);
    await target.scrollIntoViewIfNeeded();
    const targetBox = (await target.boundingBox())!;
    await dragCanvasItem(page, item, { x: targetBox.x + targetBox.width / 2, y: targetBox.y + 32 });
    await expect.poll(async () => (await snapshot(page)).organization[alpha.id].folderId).toBe(folder.id);
    expect(finderWrites).toHaveLength(1);
    await expect(item).toHaveCount(0);
    await expect(page.getByTestId('selection-toolbar')).toHaveCount(0);
  }
});

test('marquee stays transient until mouse release and pointer cancellation retains the original selection', async ({ page }) => {
  const state = await snapshot(page);
  const alpha = state.skills.find(skill => skill.name === 'Alpha Research')!;
  const beta = state.skills.find(skill => skill.name === 'Beta Design')!;
  await page.goto('/#skills:global');
  const alphaItem = page.locator(`[data-finder-item-key="skill:${alpha.id}"]`);
  const betaItem = page.locator(`[data-finder-item-key="skill:${beta.id}"]`);
  const surface = page.getByTestId('finder-canvas-surface');
  await betaItem.getByRole('button', { name: '查看 Beta Design 详情', exact: true }).click({ modifiers: ['Meta'] });
  const origin = (await surface.boundingBox())!;
  const a = (await alphaItem.boundingBox())!;
  await page.mouse.move(origin.x + 12, origin.y + 12);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width + 2, a.y + a.height + 2, { steps: 10 });
  await expect(alphaItem).toHaveAttribute('data-box-selected', 'true');
  await expect(alphaItem).toHaveAttribute('aria-selected', 'false');
  await expect(betaItem).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-finder-item-key][aria-selected="true"]')).toHaveCount(1);
  await page.mouse.up();
  await expect(alphaItem).toHaveAttribute('aria-selected', 'true');
  await expect(betaItem).toHaveAttribute('aria-selected', 'false');
  const b = (await betaItem.boundingBox())!;
  await surface.evaluate(element => {
    element.addEventListener('pointerdown', event => element.setAttribute('data-test-pointer-id', String((event as PointerEvent).pointerId)), { once: true });
  });
  await page.mouse.move(b.x - 10, origin.y + 12);
  await page.mouse.down();
  try {
    await page.mouse.move(b.x + b.width + 2, b.y + b.height + 2, { steps: 10 });
    await expect(betaItem).toHaveAttribute('data-box-selected', 'true');
    await expect(alphaItem).toHaveAttribute('aria-selected', 'true');
    await expect(betaItem).toHaveAttribute('aria-selected', 'false');
    // The gesture is real mouse input; only the browser cancellation is injected.
    await surface.dispatchEvent('pointercancel', { pointerId: Number(await surface.getAttribute('data-test-pointer-id')), isPrimary: true, button: 0 });
    await expect(alphaItem).toHaveAttribute('aria-selected', 'true');
    await expect(betaItem).toHaveAttribute('aria-selected', 'false');
    await expect(page.locator('[data-finder-item-key][aria-selected="true"]')).toHaveCount(1);
    await expect(page.locator('[data-box-selected]')).toHaveCount(0);
  } finally {
    await page.mouse.up();
  }
  await clearFinderSelection(page);
  await page.getByRole('button', { name: '列表视图', exact: true }).click();
  await expect(alphaItem).toHaveAttribute('draggable', 'false');
  await expect(betaItem).toHaveAttribute('draggable', 'false');
  await betaItem.getByRole('button', { name: '查看 Beta Design 详情', exact: true }).click({ modifiers: ['Meta'] });
  const list = page.locator('.finder-browser');
  const listBounds = (await list.boundingBox())!;
  const row = (await alphaItem.boundingBox())!;
  const lastRow = (await betaItem.boundingBox())!;
  await page.mouse.move(listBounds.x + 14, Math.min(Math.max(row.y + row.height, lastRow.y + lastRow.height) + 24, listBounds.y + listBounds.height - 20));
  await page.mouse.down();
  try {
    await page.mouse.move(row.x + row.width - 14, Math.min(row.y, lastRow.y) + 2, { steps: 10 });
    await expect(alphaItem).toHaveAttribute('data-box-selected', 'true');
    await expect(alphaItem).toHaveAttribute('aria-selected', 'false');
    await expect(betaItem).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-finder-item-key][aria-selected="true"]')).toHaveCount(1);
  } finally {
    await page.mouse.up();
  }
  await expect(alphaItem).toHaveAttribute('aria-selected', 'true');
  await expect(betaItem).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-box-selected]')).toHaveCount(0);
  await page.getByRole('button', { name: '分栏视图', exact: true }).click();
  await expect(alphaItem).toHaveAttribute('draggable', 'true');
  await expect(betaItem).toHaveAttribute('draggable', 'true');
});

test('canvas missing-position cache survives resizing, filtering cannot drag and matching single inspector survives drag', async ({ page }, testInfo) => {
  test.setTimeout(60000);
  const initial = await snapshot(page);
  expect(initial.dataDir).toContain('skill-shelf-test-');
  const originalViewport = page.viewportSize()!;
  const fixturePath = path.join(initial.dataDir, '..', `canvas-cache-${testInfo.project.name}`);
  const skillPath = path.join(fixturePath, 'cache-skill');
  const name = `Canvas Cache ${testInfo.project.name}`;
  await mkdir(skillPath, { recursive: true });
  await writeFile(path.join(skillPath, 'SKILL.md'), `---\nname: ${name}\ndescription: Synthetic canvas positioning fixture.\n---\n\n# ${name}\n`);
  const added = await update(page, '/api/roots', 'post', { path: fixturePath, label: name });
  const root = added.roots.find(item => item.path === fixturePath)!;
  const cleanup = await playwrightRequest.newContext({ baseURL: testInfo.project.use.baseURL });
  const cleanupToken = (await (await cleanup.get('/api/session')).json()).token as string;
  const cleanupHeaders = { 'X-Shelf-Token': cleanupToken };
  const skill = added.skills.find(item => item.name === name)!;
  const alpha = added.skills.find(item => item.name === 'Alpha Research')!;
  const item = page.locator(`[data-finder-item-key="skill:${skill.id}"]`);
  const writes: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/finder' && request.method() === 'PATCH') writes.push(request.postData() || ''); });
  try {
    await page.goto('/#skills:global');
    expect((await snapshot(page)).finderPositions[`skill:${skill.id}`]).toBeUndefined();
    // Existing 108x102 rectangles occupy slots 0/1, so source slot 2 is first free.
    await expect.poll(() => finderPoint(item)).toEqual({ x: 276, y: 24 });
    await page.setViewportSize({ width: 320, height: originalViewport.height });
    await expect.poll(() => finderPoint(item)).toEqual({ x: 276, y: 24 });
    await page.setViewportSize(originalViewport);
    await expect.poll(() => finderPoint(item)).toEqual({ x: 276, y: 24 });
    expect(writes).toEqual([]);

    if (testInfo.project.name !== 'mobile') {
      const alphaItem = page.locator(`[data-finder-item-key="skill:${alpha.id}"]`);
      await alphaItem.getByRole('button', { name: '查看 Alpha Research 详情', exact: true }).click();
      const inspector = page.getByRole('dialog', { name: 'Alpha Research', exact: true });
      const resize = inspector.getByRole('separator', { name: '调整 Skill 详情宽度', exact: true });
      await resize.focus();
      await resize.press('Home');
      const handle = alphaItem.locator('.finder-icon-button');
      await handle.scrollIntoViewIfNeeded();
      const start = (await handle.boundingBox())!;
      const original = (await snapshot(page)).finderPositions[`skill:${alpha.id}`];
      await dragCanvasItem(page, alphaItem, { x: start.x + start.width / 2 + 24, y: start.y + 32 + 36 });
      await expect.poll(async () => (await snapshot(page)).finderPositions[`skill:${alpha.id}`]).toEqual({ x: original.x + 24, y: original.y + 36 });
      await expect(inspector).toBeVisible();
      await expect(alphaItem).toHaveAttribute('aria-selected', 'true');
      expect(writes).toHaveLength(1);
      await inspector.getByRole('button', { name: '关闭', exact: true }).click();
    }

    const search = page.getByRole('textbox', { name: '搜索已安装的 Skill', exact: true });
    await search.fill(name);
    await search.press('Enter');
    await expect(page.getByTestId('skill-card')).toHaveCount(1);
    await expect(page.getByTestId('finder-canvas-surface')).toHaveCount(0);
    await expect(item).toHaveClass(/skill-row/);
    await expect(page.getByRole('button', { name: '图标视图', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(item).toHaveAttribute('draggable', 'false');
    const before = await finderPoint(item);
    const handle = item.locator('.skill-row-open');
    await handle.scrollIntoViewIfNeeded();
    const bounds = (await handle.boundingBox())!;
    writes.length = 0;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 16);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2 + 40, bounds.y + 90, { steps: 14 });
    await page.mouse.up();
    await expect.poll(() => finderPoint(item)).toEqual(before);
    expect(writes).toEqual([]);
    expect((await snapshot(page)).finderPositions[`skill:${skill.id}`]).toBeUndefined();
    await search.press('Escape');
    await expect.poll(() => finderPoint(item)).toEqual({ x: 276, y: 24 });

    const packName = `Canvas Cache Pack ${testInfo.project.name}`;
    const packed = await update(page, '/api/packs', 'post', { name: packName });
    const pack = packed.packs.find(entry => entry.name === packName)!;
    try {
      const beta = initial.skills.find(entry => entry.name === 'Beta Design')!;
      const imported = await update(page, `/api/packs/${pack.id}/skills`, 'post', { skillIds: [alpha.id, beta.id] });
      const managed = imported.managedSkills.filter(entry => entry.packId === pack.id);
      expect(managed).toHaveLength(2);
      for (const entry of managed) expect(imported.finderPositions[`skill:${entry.id}`]).toBeUndefined();
      await page.reload();
      await openPacks(page);
      await page.getByTestId(`pack-${pack.id}`).click();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(packName);
      await expect(page.getByTestId('skill-card')).toHaveCount(2);
      const positions: Record<string, { x: number; y: number }> = {};
      for (const entry of managed) positions[entry.id] = await finderPoint(page.locator(`[data-finder-item-key="skill:${entry.id}"]`));
      expect(Object.values(positions)).toEqual([{ x: 28, y: 24 }, { x: 152, y: 24 }]);
      await page.getByRole('button', { name: '新建文件夹', exact: true }).click();
      const folderDialog = page.getByRole('dialog', { name: '创建文件夹', exact: true });
      const folderName = `Durable Folder ${testInfo.project.name}`;
      await folderDialog.getByLabel('文件夹名称', { exact: true }).fill(folderName);
      await folderDialog.getByRole('button', { name: '创建文件夹', exact: true }).click();
      await expect(folderDialog).not.toBeVisible();
      const saved = await snapshot(page);
      const folder = saved.folders.find(entry => entry.scopeId === `pack:${pack.id}` && entry.name === folderName)!;
      expect(saved.finderPositions[`folder:${folder.id}`]).toEqual({ x: 276, y: 24 });
      const folderItem = page.locator(`[data-finder-item-key="folder:${folder.id}"]`);
      await expect.poll(() => finderPoint(folderItem)).toEqual({ x: 276, y: 24 });
      for (const viewport of [{ width: 320, height: originalViewport.height }, originalViewport]) {
        await page.setViewportSize(viewport);
        for (const entry of managed) {
          await expect.poll(() => finderPoint(page.locator(`[data-finder-item-key="skill:${entry.id}"]`))).toEqual(positions[entry.id]);
        }
        await expect.poll(() => finderPoint(folderItem)).toEqual({ x: 276, y: 24 });
      }
      const selected = managed.find(entry => entry.name === 'Alpha Research')!;
      const selectedItem = page.locator(`[data-finder-item-key="skill:${selected.id}"]`);
      for (const entry of managed) {
        await page.locator(`[data-finder-item-key="skill:${entry.id}"]`).getByRole('button', { name: `查看 ${entry.name} 详情`, exact: true }).click({ modifiers: ['Meta'] });
      }
      await rightClickItem(page, selectedItem);
      await expect(page.getByRole('menu').first()).toContainText('已选择 2 项');
      for (const name of ['添加 Skill', '整理 Alpha Research', '删除', '移动到文件夹']) {
        await expect(page.getByRole('menuitem', { name, exact: true })).toHaveCount(0);
      }
      await page.keyboard.press('Escape');
      await clearFinderSelection(page);
      const info = selectedItem.getByRole('button', { name: '预览 Alpha Research 的信息', exact: true });
      await info.hover();
      await expect(page.getByRole('tooltip', { name: 'Alpha Research 信息预览', exact: true })).toBeVisible();
      await expect(selectedItem).toHaveAttribute('aria-selected', 'false');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await info.click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await selectedItem.getByRole('button', { name: '查看 Alpha Research 详情', exact: true }).click();
      const inspector = page.getByRole('dialog', { name: 'Alpha Research', exact: true });
      await expect(inspector).toBeVisible();
      await expect(selectedItem).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('[data-finder-item-key][aria-selected="true"]')).toHaveCount(1);
      await inspector.getByRole('button', { name: '关闭', exact: true }).click();
    } finally {
      const response = await cleanup.delete(`/api/packs/${pack.id}`, { headers: cleanupHeaders });
      expect(response.ok()).toBeTruthy();
    }
  } finally {
    try {
      const response = await cleanup.delete(`/api/roots/${root.id}`, { headers: cleanupHeaders });
      expect(response.ok()).toBeTruthy();
    } finally {
      await cleanup.dispose();
      if (!page.isClosed()) await page.setViewportSize(originalViewport).catch(() => {});
    }
  }
});
