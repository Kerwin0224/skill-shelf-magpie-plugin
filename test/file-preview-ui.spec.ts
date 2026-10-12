import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Snapshot } from '../web/src/types';

async function api<T>(page: Page, route: string): Promise<T> {
  const session = await page.request.get('/api/session');
  const response = await page.request.get(`/api${route}`, { headers: { 'X-Shelf-Token': (await session.json()).token } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

async function prepare(page: Page, pack = false) {
  const state = await api<Snapshot>(page, '/state');
  const alpha = state.skills.find(skill => skill.name === 'Alpha Research')!;
  expect(alpha.path).toContain('skill-shelf-test-');
  const original = await readFile(path.join(alpha.path, 'SKILL.md'), 'utf8');
  const reference = await readFile(path.join(alpha.path, 'references/context.md'), 'utf8');
  const skillId = pack ? 'file-preview-managed' : alpha.id;
  state.folders = []; state.organization = {};
  if (pack) state.managedSkills = [{ ...alpha, id: skillId, scopeId: 'pack:default', packId: 'default', sourcePath: alpha.path, importedAt: new Date().toISOString(), deployments: [] }];
  await page.route('**/api/state', route => route.fulfill({ json: state }));
  const aiRequests: { method: string; pathname: string }[] = [];
  // Simulate legacy cached translations without generating or altering any data.
  await page.route('**/api/ai/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    aiRequests.push({ method, pathname });
    if (method !== 'GET') return route.fulfill({ status: 500, json: { error: 'Unexpected model action in a file preview' } });
    if (pathname === '/api/ai/status') return route.fulfill({ json: { available: true, models: [{ id: 'fixture/text', name: 'Fixture Text' }] } });
    if (pathname === '/api/ai/annotations') return route.fulfill({ json: { annotations: [] } });
    if (pathname === '/api/ai/result') return route.fulfill({ json: { translations: [], files: [{ skillId, kind: 'file-translation', filePath: 'SKILL.md', language: 'zh-CN', text: '# 不应显示的历史文件译文', stale: false }] } });
    return route.fulfill({ status: 500, json: { error: 'Unexpected AI read in a file preview' } });
  });
  const controls = { treeError: false, contentError: false };
  await page.route('**/api/skill/files?**', route => controls.treeError
    ? route.fulfill({ status: 503, json: { error: '无法读取文件列表' } })
    : route.fulfill({ json: { truncated: false, files: [
      { name: 'SKILL.md', path: 'SKILL.md', kind: 'file' },
      { name: 'plain.txt', path: 'plain.txt', kind: 'file' },
      { name: 'references', path: 'references', kind: 'directory', children: [{ name: 'context.md', path: 'references/context.md', kind: 'file' }] },
    ] } }));
  await page.route('**/api/skill/file?**', route => {
    const filePath = new URL(route.request().url()).searchParams.get('path');
    const text = filePath === 'SKILL.md' ? original : filePath === 'references/context.md' ? reference : 'Original plain text, not an AI translation.';
    return controls.contentError ? route.fulfill({ status: 503, json: { error: '无法读取文件内容' } }) : route.fulfill({ json: { path: filePath, text } });
  });
  const open = async () => {
    await page.goto(pack ? '/#packs:default' : '/#skills:global');
    await page.locator(`[data-finder-item-key="skill:${skillId}"]`).getByRole('button', { name: '查看 Alpha Research 详情', exact: true }).click();
    const detail = page.getByRole('dialog', { name: 'Alpha Research', exact: true });
    await detail.getByRole('tab', { name: '文件', exact: true }).click();
    return detail;
  };
  const preserved = async () => {
    expect(await readFile(path.join(alpha.path, 'SKILL.md'), 'utf8')).toBe(original);
    expect(await readFile(path.join(alpha.path, 'references/context.md'), 'utf8')).toBe(reference);
    expect(aiRequests.filter(request => request.method !== 'GET')).toEqual([]);
  };
  return { open, aiRequests, original, reference, controls, preserved };
}

for (const pack of [false, true]) {
  test(`${pack ? 'Packs' : 'Skills'} file preview uses original rendered/source content with no translation controls or AI requests`, async ({ page }) => {
    const mock = await prepare(page, pack);
    const detail = await mock.open();
    await expect(detail.locator('.markdown-body')).toContainText('Follow references/context.md before answering.');
    const baseline = [...mock.aiRequests];
    await expect(detail.getByRole('button', { name: /翻译|查看原文|查看译文|保存译文|丢弃|刷新文件/ })).toHaveCount(0);
    await expect(detail.locator('.markdown-heading').getByRole('button')).toHaveText(['渲染', '源码']);
    await detail.getByRole('button', { name: '源码', exact: true }).click();
    await expect(detail.locator('.skill-file-source')).toHaveText(mock.original);
    await detail.getByRole('button', { name: '渲染', exact: true }).click();
    await expect(detail.locator('.markdown-body')).not.toContainText('name: Alpha Research');
    await expect(detail).not.toContainText('不应显示的历史文件译文');
    await detail.getByRole('treeitem', { name: 'references', exact: true }).click();
    await detail.getByRole('treeitem', { name: 'context.md', exact: true }).click();
    await expect(detail.locator('.markdown-body')).toContainText('Keep citations precise.');
    await detail.getByRole('button', { name: '源码', exact: true }).click();
    await expect(detail.locator('.skill-file-source')).toHaveText(mock.reference);
    await detail.getByRole('treeitem', { name: 'SKILL.md', exact: true }).click();
    await expect(detail.getByRole('button', { name: '渲染', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(detail.locator('.markdown-body')).toContainText('Follow references/context.md before answering.');
    expect(mock.aiRequests).toEqual(baseline);
    await mock.preserved();
  });
}

test('Plain text files remain source-only and never load AI state or cached translations', async ({ page }) => {
  const mock = await prepare(page);
  const detail = await mock.open();
  await expect(detail.locator('.markdown-body')).toBeVisible();
  const baseline = [...mock.aiRequests];
  await detail.getByRole('treeitem', { name: 'plain.txt', exact: true }).click();
  await expect(detail.locator('.skill-file-source')).toHaveText('Original plain text, not an AI translation.');
  await expect(detail.locator('.markdown-heading').getByRole('button')).toHaveCount(0);
  expect(mock.aiRequests).toEqual(baseline);
  await mock.preserved();
});

test('File list retry and content errors stay within read-only browsing, without model recovery actions', async ({ page }) => {
  const mock = await prepare(page);
  mock.controls.treeError = true;
  const detail = await mock.open();
  await expect(detail.locator('.file-tree-error')).toContainText('无法读取文件列表');
  const baseline = [...mock.aiRequests];
  mock.controls.treeError = false;
  await detail.locator('.file-tree-error').getByRole('button', { name: '重试', exact: true }).click();
  await expect(detail.locator('.markdown-body')).toContainText('Follow references/context.md before answering.');
  mock.controls.contentError = true;
  await detail.getByRole('treeitem', { name: 'plain.txt', exact: true }).click();
  await expect(detail.getByRole('alert')).toContainText('无法读取文件内容');
  await expect(detail.getByRole('button', { name: /翻译|模型|查看译文/ })).toHaveCount(0);
  mock.controls.contentError = false;
  await detail.getByRole('treeitem', { name: 'SKILL.md', exact: true }).click();
  await expect(detail.locator('.markdown-body')).toContainText('Follow references/context.md before answering.');
  expect(mock.aiRequests).toEqual(baseline);
  await mock.preserved();
});
