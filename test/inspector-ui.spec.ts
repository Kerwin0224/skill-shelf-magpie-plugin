import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AiAnnotation, AiDraft, Snapshot } from '../web/src/types';
import { selectChoice } from './form-helpers';

type Options = { description?: string; language?: string; model?: string; translations?: { language: string; text: string; stale?: boolean }[]; variants?: boolean; installKind?: 'directory' | 'symlink' | 'unknown' };
async function prepare(page: Page, options: Options = {}) {
  const session = await (await page.request.get('/api/session')).json();
  const response = await page.request.get('/api/state', { headers: { 'X-Shelf-Token': session.token } });
  expect(response.ok()).toBeTruthy();
  const state = await response.json() as Snapshot;
  expect(path.basename(path.dirname(state.homeDir))).toMatch(/^skill-shelf-test-/);
  const alpha = state.skills.find(skill => skill.name === 'Alpha Research')!;
  const source = await readFile(path.join(alpha.path, 'SKILL.md'), 'utf8');
  if (options.description) alpha.description = options.description;
  alpha.installKind = options.installKind || 'directory';
  if (alpha.installKind === 'symlink') alpha.linkTarget = path.join(state.homeDir, '.agents/skills/fixture-linked-target');
  alpha.agents = ['Amp', 'Claude Code', 'Codex', 'Cursor', 'Gemini CLI', 'OpenCode'];
  state.folders = [{ id: 'inspector-folder', name: 'Research', scopeId: 'global', parentId: null, color: '#ed6a4a' }];
  state.organization[alpha.id] = { folderId: null, tags: ['canonical-tag'] };
  if (options.variants) {
    alpha.sourceUrl = 'https://github.com/fixture/alpha';
    alpha.installKind = 'symlink';
    alpha.linkTarget = path.join(state.homeDir, '.agents/skills/fixture-linked-target');
    const canonical = { ...alpha, installations: undefined, isCanonical: true, documentMatchesCanonical: true, organization: state.organization[alpha.id], position: null };
    const variant = { ...canonical, id: 'inspector-variant', sourceLabel: 'Cursor', path: `${alpha.path}-variant`, description: 'Variant-specific original description.', installKind: 'directory' as const, isCanonical: false, documentMatchesCanonical: false, organization: { folderId: null, tags: ['variant-tag'] } };
    delete variant.sourceUrl;
    delete variant.linkTarget;
    alpha.installations = [canonical, variant];
    state.organization[variant.id] = variant.organization;
  }
  const annotation = (language: string, text: string, stale = false): AiAnnotation => ({ skillId: alpha.id, kind: 'translation', language, text, stale, model: 'fixture/writing', sourceDigest: 'fixture-source', createdAt: '2026-10-12T00:00:00Z', savedAt: '2026-10-12T00:00:00Z' });
  const translations = (options.translations || []).map(item => annotation(item.language, item.text, item.stale));
  const generates: Record<string, unknown>[] = [], saves: Record<string, unknown>[] = [], copies: Record<string, unknown>[] = [], unexpected: string[] = [];
  let draft: AiDraft | null = null;
  // This catch-all prevents any inspector test from reaching an installer,
  // real update scan, model provider, or file write.
  await page.route('**/api/skills/**', route => {
    const endpoint = new URL(route.request().url()).pathname;
    if (endpoint === '/api/skills/status') return route.fulfill({ json: { scanId: null, scannedAt: null, scanning: false, updating: false, completed: 0, total: 0, checks: {}, summary: {} } });
    unexpected.push(endpoint); return route.fulfill({ status: 409, json: { error: 'Fixture operation blocked' } });
  });
  await page.route('**/api/ai/**', route => { unexpected.push(new URL(route.request().url()).pathname); return route.fulfill({ status: 409, json: { error: 'Fixture AI operation blocked' } }); });
  await page.route('**/api/state', route => route.fulfill({ json: state }));
  await page.route('**/api/organization', route => {
    const values = route.request().postDataJSON();
    for (const id of values.ids) state.organization[id] = { ...state.organization[id], ...(values.tags ? { tags: values.tags } : {}), ...('folderId' in values ? { folderId: values.folderId } : {}) };
    return route.fulfill({ json: state });
  });
  await page.route('**/api/ai/status', route => route.fulfill({ json: { available: true, models: [{ id: 'fixture/chat', name: 'Chat' }, { id: 'fixture/writing', name: 'Writing' }] } }));
  await page.route('**/api/ai/annotations', route => route.fulfill({ json: { annotations: translations } }));
  await page.route('**/api/ai/result?**', route => route.fulfill({ json: { summary: { ...annotation('zh-CN', 'Generated summary must not replace the original.'), kind: 'summary' }, translations: translations.filter(item => item.skillId === new URL(route.request().url()).searchParams.get('id')) } }));
  await page.route('**/api/ai/generate', route => {
    const input = route.request().postDataJSON(); generates.push(input);
    draft = { ...annotation(input.language, input.language === 'zh-CN' ? '研究并整理可靠来源，保留准确的引用。' : 'Explicit fixture translation.'), draftId: 'inspector-draft' };
    return route.fulfill({ json: draft });
  });
  await page.route('**/api/ai/save', route => {
    saves.push(route.request().postDataJSON());
    const saved = { ...draft! }; translations.splice(0, translations.length, ...translations.filter(item => item.language !== saved.language), saved);
    return route.fulfill({ json: saved });
  });
  await page.route('**/api/ai/source-copy', route => {
    const input = route.request().postDataJSON(); copies.push(input);
    const saved = { ...annotation(input.language, alpha.description), model: 'source-copy' };
    translations.push(saved); return route.fulfill({ json: saved });
  });
  await page.route('**/api/skill/files?**', route => route.fulfill({ json: { files: [{ name: 'SKILL.md', path: 'SKILL.md', kind: 'file' }], truncated: false } }));
  await page.route('**/api/skill/file?**', route => route.fulfill({ json: { path: 'SKILL.md', text: source } }));
  await page.addInitScript(({ language, model }) => {
    localStorage.setItem('shelf-ai:preferences', JSON.stringify({ enabled: true, chatModel: 'fixture/chat', summaryModel: 'fixture/chat', translationModel: model, targetLanguage: language }));
    localStorage.setItem('shelf-ui:preferences', JSON.stringify({ focusedAgents: ['OpenCode', 'Cursor'] }));
    localStorage.setItem('shelf-scope-collapsed', 'true');
  }, { language: options.language || 'zh-CN', model: options.model ?? 'fixture/writing' });
  const open = async () => {
    await page.goto('/#skills:global');
    await page.locator(`[data-finder-item-key="skill:${alpha.id}"]`).getByRole('button', { name: '查看 Alpha Research 详情', exact: true }).click();
    const inspector = page.getByRole('dialog', { name: 'Alpha Research', exact: true });
    await expect(inspector.getByTestId('skill-description-panel')).toBeVisible();
    await expect(inspector.getByRole('button', { name: '翻译选项', exact: true })).toBeEnabled();
    return inspector;
  };
  const preserved = async () => { expect(unexpected).toEqual([]); expect(await readFile(path.join(alpha.path, 'SKILL.md'), 'utf8')).toBe(source); };
  return { state, alpha, translations, generates, saves, copies, open, preserved };
}

test('Skill inspector uses desktop header, description card, compact controls, Agent collapse and final path', async ({ page }) => {
  const mock = await prepare(page);
  const inspector = await mock.open();
  expect(await inspector.locator('.inspector-header').evaluate(element => Array.from(element.children).map(child => child.className || child.getAttribute('data-slot')))).toEqual(['inspector-kicker', 'sheet-title', 'sr-only', 'inspector-actions']);
  await expect(inspector.locator('.inspector-header')).toHaveCSS('padding', '14px 56px 14px 16px');
  await expect(inspector.locator('[data-slot="sheet-description"]')).toHaveCSS('position', 'absolute');
  await expect(inspector.locator('.inspector-actions')).toHaveCSS('grid-row', '1 / 3');
  await expect(inspector.getByRole('button', { name: 'AI 助手', exact: true })).toHaveCount(0);
  await expect(inspector.getByRole('button', { name: '打开文件夹', exact: true })).toHaveCSS('height', '32px');
  await expect(inspector.getByRole('button', { name: '打开文件夹', exact: true }).locator('svg')).toHaveCSS('width', '16px');
  await expect(inspector.getByRole('textbox', { name: '添加标签', exact: true })).toHaveCSS('height', '30px');
  await expect(inspector.getByRole('combobox', { name: '文件夹', exact: true })).toHaveCSS('height', '36px');
  await expect(inspector.locator('.skill-description-toolbar')).toHaveCSS('min-height', '28px');
  await expect(inspector.getByRole('button', { name: '翻译为简体中文', exact: true })).toHaveCSS('height', '28px');
  await expect(inspector.getByRole('button', { name: '翻译为简体中文', exact: true }).locator('svg')).toHaveCSS('width', '12px');
  await expect(inspector.locator('.skill-description-source')).toHaveText('原文');
  await expect(inspector.locator('.skill-description-body')).toHaveText(mock.alpha.description);
  await expect(inspector.locator('.agent-detail-badge')).toHaveCount(4);
  await expect(inspector.locator('.agent-detail-badge.is-focused')).toHaveText(['Cursor', 'OpenCode']);
  await expect(inspector.locator('.agent-detail-badge i').first()).toHaveCSS('width', '5px');
  await inspector.getByRole('button', { name: '+2', exact: true }).click();
  await expect(inspector.locator('.agent-detail-badge')).toHaveCount(6);
  await inspector.getByRole('button', { name: '收起', exact: true }).click();
  await expect(inspector.locator('.agent-detail-badge')).toHaveCount(4);
  expect(await inspector.locator('.inspector-scroll').evaluate(element => element.lastElementChild?.className)).toBe('path-block');
  await expect(inspector.locator('.path-block')).toContainText('实际目录');
  await expect(inspector.locator('.inspector-path')).toHaveText(mock.alpha.path);
  expect(mock.generates).toHaveLength(0); expect(mock.copies).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await mock.preserved();
});

test('Description explicitly translates with writing model, saves, switches original/translation and restores on reopen', async ({ page }) => {
  const mock = await prepare(page);
  let inspector = await mock.open();
  expect(mock.generates).toHaveLength(0);
  await inspector.getByRole('button', { name: '翻译为简体中文', exact: true }).click();
  await expect(inspector.locator('.skill-description-source')).toHaveText('简体中文 · AI');
  await expect(inspector.locator('.skill-description-body')).toHaveText('研究并整理可靠来源，保留准确的引用。');
  expect(mock.generates).toEqual([{ skillId: mock.alpha.id, kind: 'translation', model: 'fixture/writing', language: 'zh-CN' }]);
  expect(mock.saves).toEqual([{ draftId: 'inspector-draft' }]);
  await inspector.getByRole('button', { name: '查看原文', exact: true }).click();
  await expect(inspector.locator('.skill-description-source')).toHaveText('原文');
  await expect(inspector.locator('.skill-description-body')).toHaveText(mock.alpha.description);
  await inspector.getByRole('button', { name: '查看译文', exact: true }).click();
  await expect(inspector.locator('.skill-description-source')).toHaveText('简体中文 · AI');
  await page.reload();
  inspector = await mock.open();
  await expect(inspector.locator('.skill-description-source')).toHaveText('简体中文 · AI');
  expect(mock.generates).toHaveLength(1);
  await mock.preserved();
});

test('Inspector footer stays 57px tall at the drawer bottom for short content and tall viewports', async ({ page }) => {
  const mock = await prepare(page, { description: 'Short original description.' });
  const inspector = await mock.open();
  const viewport = page.viewportSize()!;
  for (const height of [viewport.height, 1600]) {
    await page.setViewportSize({ width: viewport.width, height });
    const footer = inspector.locator('.inspector-footer');
    await expect(footer).toBeVisible();
    await expect(footer).toHaveCSS('height', '57px');
    await expect.poll(async () => inspector.evaluate(element => {
      const drawer = element.getBoundingClientRect();
      const footer = element.querySelector('.inspector-footer')!.getBoundingClientRect();
      return Math.abs(footer.bottom - (drawer.bottom - parseFloat(getComputedStyle(element).borderBottomWidth)));
    })).toBeLessThan(1);
    const dimensions = await inspector.evaluate(element => {
      const footer = element.querySelector('.inspector-footer')!.getBoundingClientRect();
      const tabs = element.querySelector('.skill-detail-tabs')!.getBoundingClientRect();
      return { footerHeight: footer.height, gap: footer.top - tabs.bottom };
    });
    expect(dimensions.footerHeight).toBe(57);
    expect(Math.abs(dimensions.gap)).toBeLessThan(1);
  }
  await mock.preserved();
});

for (const installKind of ['symlink', 'unknown'] as const) test(`Inspector renders real ${installKind} installation metadata without inventing a directory`, async ({ page }) => {
  const mock = await prepare(page, { installKind });
  const inspector = await mock.open();
  const pathBlock = inspector.locator('.path-block');
  await expect(pathBlock.locator('[data-kind]')).toHaveAttribute('data-kind', installKind);
  await expect(pathBlock.locator('[data-kind]')).toHaveText(installKind === 'symlink' ? '软链接' : '目录类型未知');
  await expect(pathBlock).not.toContainText('实际目录');
  if (installKind === 'symlink') {
    await expect(pathBlock.locator('[data-kind] svg')).toHaveClass(/lucide-link2/);
    await expect(pathBlock.locator('.path-block-target')).toHaveText(`软链接目标${mock.alpha.linkTarget}`);
  } else await expect(pathBlock.locator('.path-block-target')).toHaveCount(0);
  await mock.preserved();
});

test('Description language options save source copy without inference and menu Escape keeps inspector open', async ({ page }) => {
  const mock = await prepare(page, { description: 'This Skill helps research the sources and preserve accurate citations.' });
  const inspector = await mock.open();
  await inspector.getByRole('button', { name: '翻译选项', exact: true }).click();
  await expect(page.getByRole('menu')).toContainText('翻译目标语言');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(inspector).toBeVisible();
  await expect(inspector.getByRole('button', { name: '翻译选项', exact: true })).toBeFocused();
  await inspector.getByRole('button', { name: '翻译选项', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'English', exact: true }).click();
  await expect(inspector.getByRole('button', { name: '翻译为English', exact: true })).toHaveCount(0);
  await inspector.getByRole('button', { name: '翻译选项', exact: true }).click();
  await page.getByRole('menuitem', { name: '保存本地副本', exact: true }).click();
  await expect.poll(() => mock.copies.length).toBe(1);
  expect(mock.copies[0]).toEqual({ skillId: mock.alpha.id, language: 'en' });
  expect(mock.generates).toHaveLength(0); expect(mock.saves).toHaveLength(0);
  await expect(inspector.locator('.skill-description-source')).toHaveText('原文');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('shelf-ai:preferences')!).targetLanguage)).toBe('zh-CN');
  await mock.preserved();
});

test('Description matches base language, excludes other-language and summary annotations, and expands four-line text', async ({ page }) => {
  const mock = await prepare(page, { description: Array.from({ length: 14 }, (_, index) => `Original line ${index + 1}: inspect reliable source documents.`).join('\n'), translations: [{ language: 'zh', text: Array.from({ length: 14 }, (_, index) => `中文第 ${index + 1} 行：检查可靠的来源文档并保留准确引用。`).join('\n') }, { language: 'fr', text: 'Not the selected language.' }] });
  const inspector = await mock.open();
  await expect(inspector.locator('.skill-description-source')).toHaveText('简体中文 · AI');
  await expect(inspector.locator('.skill-description-body > p')).toHaveClass('is-collapsed');
  const expand = inspector.getByRole('button', { name: '展开描述', exact: true });
  await expect(expand).toBeVisible(); await expect(expand).toHaveCSS('height', '24px');
  await expand.click();
  await expect(inspector.locator('.skill-description-body > p')).not.toHaveClass('is-collapsed');
  await inspector.locator('.skill-description-body').getByRole('button', { name: '收起', exact: true }).click();
  await expect(inspector.locator('.skill-description-body > p')).toHaveClass('is-collapsed');
  await inspector.getByRole('button', { name: '查看原文', exact: true }).click();
  await expect(inspector.locator('.skill-description-body > p')).toHaveText(mock.alpha.description);
  await expect(inspector.locator('.skill-description-body')).not.toContainText('Generated summary');
  expect(mock.generates).toHaveLength(0);
  await mock.preserved();
});

for (const stale of [true, false]) test(`Description warns on ${stale ? 'stale' : 'incomplete'} translation instead of presenting it as current`, async ({ page }) => {
  const mock = await prepare(page, { translations: [{ language: 'zh-CN', text: stale ? '已过期的译文。' : '没有完成的译文，', stale }] });
  const inspector = await mock.open();
  await expect(inspector.locator('.skill-description-source')).toHaveText('原文');
  await expect(inspector.getByRole('status')).toHaveText('已保存的译文需要更新，可重新翻译。');
  await inspector.getByRole('button', { name: '翻译选项', exact: true }).click();
  await page.getByRole('menuitem', { name: '重新翻译', exact: true }).click();
  await expect(inspector.locator('.skill-description-source')).toHaveText('简体中文 · AI');
  await expect(inspector.locator('.skill-translation-stale')).toHaveCount(0);
  expect(mock.generates).toHaveLength(1);
  await mock.preserved();
});

test('Missing explicit writing model never falls back to chat and routes to translation settings', async ({ page }) => {
  const mock = await prepare(page, { model: 'fixture/deleted-writing-model' });
  const inspector = await mock.open();
  await expect(inspector.getByRole('alert')).toContainText('描述与翻译模型暂不可用');
  await expect(inspector.getByRole('button', { name: '设置翻译', exact: true })).toBeVisible();
  expect(mock.generates).toHaveLength(0);
  await inspector.getByRole('button', { name: '设置翻译', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '设置分类', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '默认模型', exact: true })).toBeVisible();
  expect(mock.generates).toHaveLength(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('shelf-ai:preferences')!).translationModel)).toBe('fixture/deleted-writing-model');
  await mock.preserved();
});

test('Inspector keeps per-installation metadata, keyboard tabs, resize bounds and tag Escape', async ({ page }, info) => {
  const mock = await prepare(page, { variants: true });
  const inspector = await mock.open();
  await expect(inspector.getByRole('button', { name: '来源', exact: true })).toBeVisible();
  await expect(inspector.locator('.path-block-target code')).toHaveText(mock.alpha.linkTarget!);
  await selectChoice(inspector.getByRole('combobox', { name: '查看 Skill 安装位置', exact: true }), 'inspector-variant');
  await expect(inspector.locator('.inspector-path')).toHaveText(`${mock.alpha.path}-variant`);
  await expect(inspector.getByRole('button', { name: '来源', exact: true })).toHaveCount(0);
  await expect(inspector.locator('.path-block-target')).toHaveCount(0);
  await expect(inspector.locator('.path-block [data-kind]')).toHaveAttribute('data-kind', 'directory');
  await expect(inspector.locator('.inspector-footer')).toHaveCount(0);
  await expect(inspector.getByRole('button', { name: '移除标签 variant-tag', exact: true })).toBeVisible();
  await expect(inspector.getByRole('button', { name: '移除标签 canonical-tag', exact: true })).toHaveCount(0);
  const input = inspector.getByRole('textbox', { name: '添加标签', exact: true });
  await input.fill('temporary'); await input.press('Escape');
  await expect(input).toHaveValue(''); await expect(inspector).toBeVisible();
  await input.fill('variant-added'); await input.press('Enter');
  await expect(inspector.getByRole('button', { name: '移除标签 variant-added', exact: true })).toBeVisible();
  await expect(inspector.getByRole('button', { name: '来源', exact: true })).toHaveCount(0);
  await expect(inspector.locator('.path-block-target')).toHaveCount(0);
  expect(mock.state.organization[mock.alpha.id].tags).toEqual(['canonical-tag']);
  expect(mock.state.organization['inspector-variant'].tags).toEqual(['variant-tag', 'variant-added']);
  const infoTab = inspector.getByRole('tab', { name: '信息', exact: true });
  await infoTab.focus(); await infoTab.press('ArrowRight');
  await expect(inspector.getByRole('tab', { name: '文件', exact: true })).toBeFocused();
  await expect(inspector.getByRole('tab', { name: '文件', exact: true })).toHaveAttribute('aria-selected', 'true');
  await inspector.getByRole('tab', { name: '文件', exact: true }).press('Home');
  await expect(infoTab).toBeFocused(); await expect(infoTab).toHaveAttribute('aria-selected', 'true');
  if (info.project.name === 'mobile') await expect(inspector.locator('.skill-drawer-resize-handle')).toBeHidden();
  else {
    const resize = inspector.getByRole('separator', { name: '调整 Skill 详情宽度', exact: true });
    await resize.focus(); await resize.press('Home');
    expect(Number(await resize.getAttribute('aria-valuenow'))).toBe(Number(await resize.getAttribute('aria-valuemin')));
    await resize.press('End');
    expect(Number(await resize.getAttribute('aria-valuenow'))).toBe(Number(await resize.getAttribute('aria-valuemax')));
    expect(Number(await resize.getAttribute('aria-valuemax'))).toBeLessThanOrEqual(960);
  }
  await mock.preserved();
});
