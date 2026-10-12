import { expect, test, type Page } from '@playwright/test';
import type { Snapshot } from '../web/src/types';

// The fixture server has an isolated HOME. All parity-specific data and operations
// are mocked in the browser; these tests never install, update, or deploy a Skill.
async function prepare(page: Page, { view = 'list', compact = false, status = 'update-available', stale = false, translationStale = false, linked = true } = {}) {
  const session = await (await page.request.get('/api/session')).json();
  const state = await (await page.request.get('/api/state', { headers: { 'X-Shelf-Token': session.token } })).json() as Snapshot;
  const alpha = state.skills.find(skill => skill.name === 'Alpha Research')!;
  const beta = state.skills.find(skill => skill.name === 'Beta Design')!;
  Object.assign(alpha, { installKind: 'symlink', linkTarget: '/fixture/shared/alpha', sourceUrl: 'https://github.com/fixture/alpha' });
  Object.assign(beta, { installKind: 'directory' });
  alpha.description = Array.from({ length: 18 }, (_, index) => `Description line ${index + 1}.`).join('\n');
  state.organization[alpha.id] = { folderId: null, tags: ['research', 'daily', 'notes', 'sources', 'fifth'] };
  state.folders = [];
  state.packs = [{ id: 'finder-parity-pack', name: 'Parity Pack', description: '', createdAt: '2026-01-01', updatedAt: '2026-01-01' }];
  state.managedSkills = [{ ...alpha, id: 'finder-parity-managed', scopeId: 'pack:finder-parity-pack', packId: 'finder-parity-pack', sourcePath: '/fixture/import/original', importedAt: '2026-01-01', deployments: linked ? [{ id: 'fixture-link', mode: 'symlink', targetPath: '/fixture/deployment/alpha', createdAt: '2026-01-01' }] : [] }];
  const checkedAt = new Date(Date.now() - (stale ? 31 * 60_000 : 0)).toISOString();
  const checks = { [alpha.id]: { status, reason: 'remote-changed', checkedAt }, [beta.id]: { status: 'current', reason: 'up-to-date', checkedAt: new Date().toISOString() } };
  const updates = { scanId: 'fixture-scan', scannedAt: checkedAt, scanning: false, updating: false, completed: 2, total: 2, checks, summary: {} };
  const calls: string[] = [];
  await page.route('**/api/state', route => route.fulfill({ json: state }));
  await page.route('**/api/skills/status', route => route.fulfill({ json: updates }));
  await page.route('**/api/ai/annotations', route => route.fulfill({ json: { annotations: translationStale ? [{ skillId: alpha.id, kind: 'translation', language: 'zh-CN', stale: true, text: 'Expired annotation', createdAt: '2026-01-01', sourceDigest: 'fixture' }] : [] } }));
  await page.route('**/api/skills/scan', route => { calls.push('scan'); return route.fulfill({ json: { state, updates: { ...updates, checks: { ...checks, [alpha.id]: { ...checks[alpha.id], checkedAt: new Date().toISOString() } } } } }); });
  await page.route('**/api/skills/update', route => { calls.push('update'); return route.fulfill({ status: 409, json: { error: 'Parity test does not modify Skills' } }); });
  await page.addInitScript(({ view, compact }) => {
    localStorage.setItem('shelf-view', JSON.stringify(view));
    localStorage.setItem('shelf-ui:preferences', JSON.stringify({ density: compact ? 'compact' : 'comfortable' }));
    localStorage.setItem('shelf-scope-collapsed', 'true');
    localStorage.setItem('shelf-sidebar-collapsed', 'true');
  }, { view, compact });
  return { state, alpha, beta, calls };
}

for (const view of ['list', 'columns']) {
  for (const compact of [false, true]) {
    test(`${view} ${compact ? 'compact' : 'normal'} matches desktop title glyph and trailing action geometry`, async ({ page }) => {
      await prepare(page, { view, compact });
      await page.goto('/#skills:global');
      if (compact) await page.evaluate(() => document.documentElement.dataset.density = 'compact');
      const item = page.locator('[data-skill-name="Alpha Research"]');
      const title = item.locator('.skill-row-title');
      await expect(title.locator(':scope > :first-child')).toHaveClass('skill-update-indicator');
      await expect(title.locator('.skill-update-indicator')).toHaveAttribute('data-status', 'update-available');
      await expect(item.locator('.skill-row-quick-actions .skill-update-indicator')).toHaveCount(0);
      const actions = item.locator('.skill-row-quick-actions > button');
      await expect(actions).toHaveCount(3);
      await expect(actions.nth(0)).toHaveAccessibleName('预览 Alpha Research 的信息');
      await expect(actions.nth(1)).toHaveAccessibleName('打开 Alpha Research 文件夹');
      await expect(actions.nth(2)).toHaveAccessibleName('更新 Alpha Research');
      const geometry = await item.evaluate(element => {
        const titleGlyph = element.querySelector('.skill-row-title .skill-update-indicator > svg')!;
        const action = element.querySelector('.skill-row-quick-button')!;
        const actionGlyph = action.querySelector('svg')!;
        const styles = getComputedStyle(action);
        return { titleGlyph: titleGlyph.getBoundingClientRect().width, action: action.getBoundingClientRect().width, actionGlyph: actionGlyph.getBoundingClientRect().width, stroke: getComputedStyle(actionGlyph).strokeWidth, padding: styles.padding, radius: styles.borderRadius, actionBackground: styles.backgroundColor, rowVariable: getComputedStyle(element).getPropertyValue('--finder-row-height').trim() };
      });
      expect(geometry.titleGlyph).toBe(view === 'columns' ? 12 : 14);
      expect(geometry.action).toBe(view === 'columns' ? compact ? 20 : 24 : compact ? 22 : 28);
      expect(geometry.actionGlyph).toBe(view === 'columns' ? 11 : 13);
      expect(geometry.stroke).toBe('1.9px');
      expect(geometry.padding).toBe('0px');
      expect(geometry.radius).toBe('5px');
      expect(geometry.rowVariable).toBe(view === 'columns' ? compact ? '28px' : '38px' : compact ? '30px' : '44px');
      if (view === 'columns') expect(geometry.actionBackground).toBe('rgba(0, 0, 0, 0)');
      await expect(page.getByRole('button', { name: '更新 Beta Design', exact: true })).toBeDisabled();
    });
  }
}

test('canvas uses the desktop Boxes tile and isolated Info trigger, not an invented FileText glyph', async ({ page }) => {
  await prepare(page, { view: 'grid' });
  await page.goto('/#skills:global');
  const item = page.locator('[data-skill-name="Alpha Research"]');
  await expect(item.locator('.finder-skill-icon > svg')).toHaveClass(/lucide-boxes/);
  await expect(item.locator('.finder-skill-icon')).toHaveCSS('width', '58px');
  await expect(item.locator('.finder-skill-icon > svg')).toHaveCSS('width', '27px');
  await expect(item.locator('.finder-skill-icon .skill-update-indicator')).toHaveCSS('width', '18px');
  await expect(item.locator('.finder-skill-info')).toHaveCSS('width', '22px');
  const info = item.getByRole('button', { name: '预览 Alpha Research 的信息', exact: true });
  await info.hover();
  await expect(page.locator('.skill-hover-card')).toBeVisible();
  await info.click();
  await expect(page.locator('.skill-hover-card')).toHaveCount(0);
  await expect(item).toHaveAttribute('aria-selected', 'false');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('Info matches mouse-only 320/140ms timing, click, retained focus and touch behavior', async ({ page }) => {
  await prepare(page);
  await page.goto('/#skills:global');
  const item = page.locator('[data-skill-name="Alpha Research"]');
  const info = item.getByRole('button', { name: '预览 Alpha Research 的信息', exact: true });
  await item.locator('.skill-row-title strong').hover();
  await page.waitForTimeout(400);
  await expect(page.locator('.skill-hover-card')).toHaveCount(0);
  await info.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  await expect(page.locator('.skill-hover-card')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await info.dispatchEvent('pointerover', { pointerType: 'touch' });
  await page.waitForTimeout(400);
  await expect(page.locator('.skill-hover-card')).toHaveCount(0);
  await info.dispatchEvent('pointerout', { pointerType: 'touch' });
  await info.dispatchEvent('pointerover', { pointerType: 'mouse' });
  await page.waitForTimeout(100);
  await expect(page.locator('.skill-hover-card')).toHaveCount(0);
  await expect(page.locator('.skill-hover-card')).toBeVisible();
  await info.dispatchEvent('pointerout', { pointerType: 'mouse' });
  await page.waitForTimeout(50);
  await expect(page.locator('.skill-hover-card')).toBeVisible();
  await expect(page.locator('.skill-hover-card')).toHaveCount(0);
  await expect(item).toHaveAttribute('aria-selected', 'false');
  await item.locator('.skill-row-open').click({ modifiers: ['Meta'] });
  await expect(item).toHaveAttribute('aria-selected', 'true');
  await info.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(item).toHaveAttribute('aria-selected', 'true');
});

test('hover facts reflect actual metadata, stale translation and tags without changing selection', async ({ page }) => {
  await prepare(page, { translationStale: true });
  await page.goto('/#skills:global');
  await page.getByRole('button', { name: '预览 Alpha Research 的信息', exact: true }).hover();
  const card = page.getByRole('tooltip', { name: 'Alpha Research 信息预览', exact: true });
  await expect(card.locator('.skill-hover-card-heading small')).toHaveText('https://github.com/fixture/alpha');
  await expect(card.locator('.skill-hover-card-description-source [data-source="original"]')).toHaveText('Skill 原始 description');
  await expect(card.locator('[data-state="stale"]')).toHaveText('已保存的翻译已过期');
  await expect(card.locator('.skill-hover-card-description p')).not.toContainText('Expired annotation');
  await expect(card.locator('.skill-hover-card-facts > span')).toHaveText(['可更新', '全局', '软链接']);
  await expect(card.locator('.skill-hover-card-facts > span').last()).toHaveAttribute('title', '/fixture/shared/alpha');
  await expect(card.locator('.skill-hover-card-tags > span')).toHaveText(['#research', '#daily', '#notes', '#sources', '+1']);
  const viewport = page.viewportSize()!;
  const bounds = (await card.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(12);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width - 12);
  expect(bounds.y).toBeGreaterThanOrEqual(12);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height - 12);
  await card.locator('.skill-hover-card-description p').hover();
  await page.mouse.wheel(0, 40);
  await expect(card).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(card).toHaveCount(0);
});

test('single-item update uses freshness policy and the real confirmation flow, with mocked scans only', async ({ page }) => {
  const fixture = await prepare(page, { stale: true });
  await page.goto('/#skills:global');
  const item = page.locator('[data-skill-name="Alpha Research"]');
  await expect(item.locator('.skill-row-title .skill-update-indicator')).toHaveAttribute('data-stale', 'true');
  await item.getByRole('button', { name: '检查并更新 Alpha Research', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '更新 Skill', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: '更新 Skill', exact: true }).locator('.skill-update-list li')).toHaveCount(1);
  expect(fixture.calls).toEqual(['scan']);
  await expect(item).toHaveAttribute('aria-selected', 'false');
  await expect(page.getByRole('dialog', { name: 'Alpha Research', exact: true })).toHaveCount(0);
});

test('context update follows desktop order, icon, freshness policy and single-selection restriction', async ({ page }) => {
  await prepare(page);
  await page.goto('/#skills:global');
  const alpha = page.locator('[data-skill-name="Alpha Research"]');
  const beta = page.locator('[data-skill-name="Beta Design"]');
  await alpha.locator('.skill-row-title strong').click({ button: 'right' });
  const update = page.getByRole('menuitem', { name: '更新', exact: true });
  await expect(update.locator('svg')).toHaveClass(/lucide-refresh-cw/);
  await expect(update).toBeEnabled();
  await expect(page.getByRole('menuitem').last()).toHaveText('更新');
  await page.keyboard.press('Escape');
  await beta.locator('.skill-row-title strong').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '更新', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await alpha.locator('.skill-row-open').click({ modifiers: ['Meta'] });
  await expect(page.locator('[data-finder-item-key][aria-selected="true"]')).toHaveCount(2);
  await alpha.locator('.skill-row-title strong').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '更新', exact: true })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: '将所选 Skill 导入 Packs', exact: true })).toBeVisible();
});

for (const linked of [false, true]) {
  test(`Packs hides upstream status/update actions and decorates only ${linked ? 'a recorded soft link' : 'real linked deployments'}`, async ({ page }) => {
    await prepare(page, { linked });
    await page.goto('/#packs:finder-parity-pack');
    const item = page.locator('[data-skill-name="Alpha Research"]');
    await expect(item.locator('.skill-update-indicator')).toHaveCount(0);
    await expect(item.locator('.skill-row-quick-actions > button')).toHaveCount(2);
    await expect(item.locator('.finder-skill-link-indicator')).toHaveCount(linked ? 1 : 0);
    await item.getByRole('button', { name: '预览 Alpha Research 的信息', exact: true }).hover();
    const card = page.locator('.skill-hover-card');
    await expect(card.locator('.skill-hover-card-heading small')).toHaveText('/fixture/import/original');
    await expect(card.locator('.skill-hover-card-facts > span')).toHaveText(['Parity Pack', '实际目录']);
    await expect(card.locator('.skill-hover-card-facts [data-status]')).toHaveCount(0);
  });
}
