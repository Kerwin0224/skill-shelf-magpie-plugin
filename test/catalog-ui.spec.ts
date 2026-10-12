import { expect, test } from '@playwright/test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Snapshot } from '../web/src/types';
import { selectChoice } from './form-helpers';

test('one logical catalog drives sidebar, workbench and sync without discarding distinct installations', async ({ page }, testInfo) => {
  const session = await page.request.get('/api/session');
  expect(session.ok()).toBeTruthy();
  const headers = { 'X-Shelf-Token': (await session.json()).token as string };
  const getState = async (): Promise<Snapshot> => {
    const response = await page.request.get('/api/state', { headers });
    expect(response.ok()).toBeTruthy();
    return response.json();
  };
  const rescan = async (): Promise<Snapshot> => {
    const response = await page.request.post('/api/rescan', { headers, data: {} });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const organize = async (ids: string[], values: { folderId?: string | null; tags?: string[] }) => {
    const response = await page.request.patch('/api/organization', { headers, data: { ids, ...values } });
    expect(response.ok(), await response.text()).toBeTruthy();
  };

  const initial = await getState();
  // Filesystem writes and sync export are restricted to the disposable test home.
  expect(path.basename(path.dirname(initial.homeDir))).toMatch(/^skill-shelf-test-/);
  expect(path.basename(initial.homeDir)).toBe('home');
  expect(path.dirname(initial.dataDir)).toBe(path.dirname(initial.homeDir));
  expect(initial.skills).toHaveLength(2);
  const original = initial.skills.find(skill => skill.name === 'Alpha Research')!;
  expect(original).toBeTruthy();
  const originalDocument = await readFile(path.join(original.path, 'SKILL.md'), 'utf8');
  const suffix = testInfo.project.name;
  const variantPath = path.join(initial.homeDir, '.cursor', 'skills', `catalog-alpha-${suffix}`);
  const hiddenPath = path.join(initial.homeDir, '.codex', 'skills', '.system', `catalog-hidden-${suffix}`);
  const variantDocument = '---\nname: Alpha Research\ndescription: Cursor-specific catalog fixture.\n---\n\n# Alpha Research\n\nCursor installation keeps its own instructions.\n';
  const hiddenDocument = '---\nname: Hidden Catalog Fixture\ndescription: Built-in fixture, not a library item.\n---\n\n# Hidden Catalog Fixture\n';
  let variantId: string | undefined;

  try {
    await mkdir(variantPath, { recursive: true });
    await mkdir(hiddenPath, { recursive: true });
    await writeFile(path.join(variantPath, 'SKILL.md'), variantDocument, { flag: 'wx' });
    await writeFile(path.join(hiddenPath, 'SKILL.md'), hiddenDocument, { flag: 'wx' });
    const scanned = await rescan();
    expect(scanned.skills).toHaveLength(2);
    expect(scanned.skills.map(skill => skill.name).sort()).toEqual(['Alpha Research', 'Beta Design']);
    const family = scanned.skills.find(skill => skill.id === original.id)!;
    expect(family.path).toBe(original.path);
    expect(family.installations).toHaveLength(2);
    const variant = family.installations!.find(installation => installation.path === variantPath)!;
    expect(variant).toMatchObject({ isCanonical: false, documentMatchesCanonical: false, sourceLabel: 'Cursor' });
    variantId = variant.id;
    expect(family.installations!.find(installation => installation.id === family.id)).toMatchObject({ isCanonical: true, documentMatchesCanonical: true });
    expect(scanned.skills.flatMap(skill => skill.installations ?? []).some(installation => installation.path === hiddenPath)).toBe(false);

    const workbenchResponse = await page.request.get('/api/workbench', { headers });
    expect(workbenchResponse.ok()).toBeTruthy();
    const workbench = await workbenchResponse.json();
    expect(workbench.stats.totalSkills).toBe(2);
    expect(workbench.sharedDirectory.skillNames).toEqual(['Alpha Research']);
    expect(workbench.agentCoverage.flatMap((agent: { localSkills: { name: string }[] }) => agent.localSkills).some((skill: { name: string }) => skill.name === 'Hidden Catalog Fixture')).toBe(false);
    const exportedResponse = await page.request.get('/api/sync/export', { headers });
    expect(exportedResponse.ok()).toBeTruthy();
    const exported = await exportedResponse.json();
    expect(exported.skills).toHaveLength(2);
    expect(exported.skills.map((skill: { name: string }) => skill.name).sort()).toEqual(['Alpha Research', 'Beta Design']);
    const previewResponse = await page.request.post('/api/sync/preview', { headers, data: { document: exported } });
    expect(previewResponse.ok(), await previewResponse.text()).toBeTruthy();
    expect(await previewResponse.json()).toMatchObject({ total: 2, matched: 2, skipped: 0, changed: 0 });

    await organize(initial.skills.map(skill => skill.id), { folderId: null });
    await organize([original.id], { tags: ['catalog-canonical'] });
    await organize([variant.id], { tags: ['catalog-cursor'] });
    await page.goto('/#skills:global');
    await expect(page.getByTestId('skill-card')).toHaveCount(2);
    const menu = page.getByRole('button', { name: '打开侧边栏', exact: true });
    if (await menu.isVisible()) await menu.click();
    const skillsNavigation = page.getByRole('navigation', { name: 'Skill Shelf 导航', exact: true }).locator('button[title="Skills"]');
    await expect(skillsNavigation.locator('small')).toHaveText('2');
    await skillsNavigation.click();
    await page.locator(`[data-finder-item-key="skill:${original.id}"]`).getByRole('button', { name: '查看 Alpha Research 详情' }).click();
    const detail = page.getByRole('dialog', { name: 'Alpha Research', exact: true });
    await expect(detail.locator('.inspector-path')).toHaveText(original.path);
    await expect(detail.getByRole('button', { name: '移除标签 catalog-canonical', exact: true })).toBeVisible();
    await selectChoice(detail.getByRole('combobox', { name: '查看 Skill 安装位置', exact: true }), variant.id);
    await expect(detail.locator('.inspector-path')).toHaveText(variantPath);
    await expect(detail).toContainText('Cursor-specific catalog fixture.');
    await expect(detail.getByRole('button', { name: '移除标签 catalog-cursor', exact: true })).toBeVisible();
    await expect(detail.getByRole('button', { name: '移除标签 catalog-canonical', exact: true })).toHaveCount(0);
    await detail.getByRole('textbox', { name: '添加标签', exact: true }).fill('catalog-cursor-added');
    await detail.getByRole('textbox', { name: '添加标签', exact: true }).press('Enter');
    await expect(detail.getByRole('button', { name: '移除标签 catalog-cursor-added', exact: true })).toBeVisible();
    await expect(detail.locator('.inspector-path')).toHaveText(variantPath);
    const edited = await getState();
    expect(edited.organization[variant.id].tags).toEqual(['catalog-cursor', 'catalog-cursor-added']);
    expect(edited.organization[original.id].tags).toEqual(['catalog-canonical']);
    await detail.getByRole('tab', { name: '文件', exact: true }).click();
    await expect(detail.locator('.markdown-section .markdown-body')).toContainText('Cursor installation keeps its own instructions.');
    await expect(detail.locator('.markdown-section .markdown-body')).not.toContainText('Follow references/context.md before answering.');
    await detail.getByRole('tab', { name: '信息', exact: true }).click();
    await selectChoice(detail.getByRole('combobox', { name: '查看 Skill 安装位置', exact: true }), original.id);
    await expect(detail.locator('.inspector-path')).toHaveText(original.path);
    await expect(detail.getByRole('button', { name: '移除标签 catalog-canonical', exact: true })).toBeVisible();
    await expect(detail.getByRole('button', { name: '移除标签 catalog-cursor-added', exact: true })).toHaveCount(0);
    await detail.getByRole('tab', { name: '文件', exact: true }).click();
    await expect(detail.locator('.markdown-section .markdown-body')).toContainText('Follow references/context.md before answering.');
    await expect(detail.locator('.markdown-section .markdown-body')).not.toContainText('Cursor installation keeps its own instructions.');
    expect(await readFile(path.join(original.path, 'SKILL.md'), 'utf8')).toBe(originalDocument);
    expect(await readFile(path.join(variantPath, 'SKILL.md'), 'utf8')).toBe(variantDocument);
    expect(await readFile(path.join(hiddenPath, 'SKILL.md'), 'utf8')).toBe(hiddenDocument);
  } finally {
    try {
      for (const skill of initial.skills) await organize([skill.id], initial.organization[skill.id] ?? { folderId: null, tags: [] });
      if (variantId) await organize([variantId], { folderId: null, tags: [] });
    } finally {
      await rm(variantPath, { recursive: true, force: true });
      await rm(hiddenPath, { recursive: true, force: true });
      expect((await rescan()).skills).toHaveLength(2);
      expect(await readFile(path.join(original.path, 'SKILL.md'), 'utf8')).toBe(originalDocument);
    }
  }
});
