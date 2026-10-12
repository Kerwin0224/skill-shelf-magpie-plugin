import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { selectChoice } from './form-helpers';

type Skill = { id: string; name: string; path: string };
type Job = { id: string; status: string; content: string; model: string; contextFiles: string[]; error?: string };
type Conversation = { id: string; title: string; preview: string; updatedAt: string; skillId?: string; messages: { role: string; content: string }[] };
async function api<T>(page: Page, route: string): Promise<T> {
  const session = await page.request.get('/api/session');
  const response = await page.request.get(`/api${route}`, { headers: { 'X-Shelf-Token': (await session.json()).token } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function openAssistant(page: Page, selectSkill = true) {
  await page.goto('/#skills:global');
  const state = await api<{ skills: Skill[] }>(page, '/state');
  const alpha = state.skills.find(skill => skill.name === 'Alpha Research')!;
  expect(alpha.path).toContain('skill-shelf-test-');
  if (selectSkill) await page.locator(`[data-finder-item-key="skill:${alpha.id}"]`).getByRole('button', { name: '查看 Alpha Research 详情' }).click();
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  const panel = page.getByTestId('ai-assistant-sidebar');
  await expect(panel.getByRole('combobox', { name: '对话模型', exact: true })).toBeVisible();
  return { panel, alpha };
}
async function mockAssistant(page: Page) {
  const calls: { prompt: string; model: string; language: string; skillId?: string; history: { role: string; content: string }[] }[] = [];
  const conversations = new Map<string, Conversation>();
  const jobs = new Map<string, Job>();
  const controls = { failNext: false, hold: false, stops: 0 };
  await page.route('**/api/ai/status', route => route.fulfill({ json: { available: true, baseUrl: '', models: [{ id: 'fixture/text', name: 'Fixture Text' }, { id: 'fixture/other', name: 'Fixture Other' }] } }));
  await page.route('**/api/ai/conversations**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === 'POST') {
      const input = request.postDataJSON();
      const value: Conversation = { ...input, title: input.messages.find((message: { role: string }) => message.role === 'user')?.content || '通用对话',
        preview: input.messages.at(-1)?.content || '', updatedAt: new Date().toISOString() };
      conversations.set(value.id, value); await route.fulfill({ json: value });
    } else if (request.method() === 'DELETE') {
      conversations.delete(url.pathname.split('/').at(-1)!); await route.fulfill({ json: { deleted: true } });
    } else await route.fulfill({ json: url.searchParams.has('id') ? conversations.get(url.searchParams.get('id')!) || null : [...conversations.values()].reverse() });
  });
  await page.route('**/api/ai/chat**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.endsWith('/stop')) {
      const job = jobs.get(request.postDataJSON().id)!; controls.stops += 1; job.status = 'stopped'; await route.fulfill({ json: job });
    } else if (request.method() === 'POST') {
      const input = request.postDataJSON(); calls.push(input);
      const job: Job = { id: randomUUID(), status: controls.failNext ? 'failed' : 'running', content: '', model: input.model, contextFiles: input.skillId ? ['SKILL.md'] : [] };
      if (controls.failNext) { job.error = '模拟回复失败'; controls.failNext = false; }
      jobs.set(job.id, job); await route.fulfill({ json: job });
    } else {
      const job = jobs.get(url.searchParams.get('id')!)!;
      if (job.status === 'running') { job.content = controls.hold ? '正在逐步显示的回复' : '完整的测试回复'; if (!controls.hold) job.status = 'completed'; }
      await route.fulfill({ json: job });
    }
  });
  return { calls, controls, jobs, conversations };
}

test('Assistant uses client header, welcome, context, compact Skill tools and composer without automatic inference', async ({ page }) => {
  const mock = await mockAssistant(page);
  const { panel } = await openAssistant(page);
  await expect(panel).toContainText('Skill 助手');
  await expect(panel).toContainText('想聊些什么？');
  await expect(panel).toContainText('可以询问 Alpha Research 的内容');
  await expect(panel.locator('.ai-context-chip')).toHaveText('目标 SkillAlpha Research');
  await expect(panel.getByRole('button', { name: '生成描述', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: '分析 Skill', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: '翻译', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: '提问', exact: true })).toBeDisabled();
  expect(await panel.locator('.ai-panel-header').evaluate(element => getComputedStyle(element).minHeight)).toBe('70px');
  expect(await panel.getByRole('button', { name: '新建对话', exact: true }).evaluate(element => getComputedStyle(element).width)).toBe('32px');
  expect(await panel.getByRole('button', { name: '生成描述', exact: true }).evaluate(element => getComputedStyle(element).height)).toBe('28px');
  await selectChoice(panel.getByRole('combobox', { name: '对话模型', exact: true }), 'fixture/other');
  await selectChoice(panel.getByRole('combobox', { name: '翻译为', exact: true }), 'en');
  await panel.locator('.ai-history-trigger').click();
  await expect(page.getByRole('menu')).toContainText('对话历史');
  await expect(page.getByRole('menu')).toContainText('还没有保存的对话');
  await page.keyboard.press('Escape');
  await panel.getByRole('button', { name: '移除 Skill 上下文', exact: true }).click();
  await expect(panel).toContainText('通用对话 · 未附加本地文件');
  await expect(panel.locator('.ai-skill-tools')).toHaveCount(0);
  expect(mock.calls).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('Assistant incremental reply can be stopped, retried, restored from history and deleted without attaching unintended context', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('shelf-ai:preferences', JSON.stringify({ enabled: true, chatModel: 'fixture/text', summaryModel: 'fixture/other', translationModel: 'fixture/text', targetLanguage: 'en', summaryContext: 'skill-md' })));
  const mock = await mockAssistant(page);
  mock.controls.hold = true;
  const { panel, alpha } = await openAssistant(page);
  const prompt = panel.getByRole('textbox', { name: '聊聊 Skill，或询问其他相关问题…', exact: true });
  await prompt.fill('解释所选 Skill'); await prompt.press('Enter');
  await expect(panel.locator('.ai-message.is-assistant')).toContainText('正在逐步显示的回复');
  await expect(panel.getByRole('button', { name: '停止回复', exact: true })).toBeVisible();
  expect(mock.calls).toHaveLength(1); expect(mock.calls[0].skillId).toBe(alpha.id); expect(mock.calls[0].language).toBe('en');
  await panel.getByRole('button', { name: '停止回复', exact: true }).click();
  await expect(panel.getByRole('button', { name: '提问', exact: true })).toBeVisible();
  await expect(panel.locator('.ai-message.is-assistant')).toContainText('已停止回复');
  expect(mock.controls.stops).toBe(1);
  await panel.getByRole('button', { name: '新建对话', exact: true }).click();
  await expect(panel.locator('.ai-message')).toHaveCount(0);
  await panel.getByRole('button', { name: '移除 Skill 上下文', exact: true }).click();
  mock.controls.hold = false; mock.controls.failNext = true;
  await prompt.fill('只进行通用对话'); await prompt.press('Enter');
  await expect(panel.getByRole('alert')).toContainText('模拟回复失败');
  expect(mock.calls[1].skillId).toBeUndefined();
  expect(mock.calls[1].language).toBe('en');
  await panel.getByRole('button', { name: '重试', exact: true }).click();
  await expect(panel.locator('.ai-message.is-assistant')).toContainText('完整的测试回复');
  expect(mock.calls).toHaveLength(3);
  expect(mock.calls[2]).toEqual(mock.calls[1]);
  await expect(panel.locator('.ai-message.is-user')).toHaveCount(1);
  await panel.getByRole('button', { name: '新建对话', exact: true }).click();
  await panel.locator('.ai-history-trigger').click();
  await page.getByRole('menuitem', { name: /只进行通用对话/ }).click();
  await expect(panel.locator('.ai-message.is-assistant')).toContainText('完整的测试回复');
  await expect(panel).toContainText('通用对话 · 未附加本地文件');
  await panel.getByRole('button', { name: '删除当前对话', exact: true }).click();
  await expect(panel.locator('.ai-message')).toHaveCount(0);
  await panel.locator('.ai-history-trigger').click();
  await expect(page.getByRole('menuitem', { name: /只进行通用对话/ })).toHaveCount(0);
  expect(mock.calls).toHaveLength(3);
});

test('Skill analysis uses its own default model and output language, independent of the temporary translation target', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('shelf-ai:preferences', JSON.stringify({ enabled: true, chatModel: 'fixture/text', summaryModel: 'fixture/other', translationModel: 'fixture/text', targetLanguage: 'en', summaryContext: 'skill-md' })));
  const mock = await mockAssistant(page);
  const { panel, alpha } = await openAssistant(page);
  await selectChoice(panel.getByRole('combobox', { name: '翻译为', exact: true }), 'fr');
  expect(mock.calls).toHaveLength(0);
  await panel.getByRole('button', { name: '分析 Skill', exact: true }).click();
  await expect(panel.locator('.ai-message.is-assistant')).toContainText('完整的测试回复');
  expect(mock.calls).toHaveLength(1);
  expect(mock.calls[0]).toMatchObject({ skillId: alpha.id, model: 'fixture/other', language: 'en' });
  await expect(panel.getByRole('combobox', { name: '对话模型', exact: true })).toHaveAttribute('data-value', 'fixture/text');
});

test('Assistant real local fixture gateway supports explicit chat with JSON compatibility and preserves Skill source', async ({ page }) => {
  const gateway = await api<{ baseUrl: string }>(page, '/ai/status');
  const before = (await (await page.request.get(`${gateway.baseUrl}/__test/status`)).json()).requests.length;
  const { panel, alpha } = await openAssistant(page);
  const original = await readFile(path.join(alpha.path, 'SKILL.md'), 'utf8');
  await expect(panel).toBeVisible();
  expect((await (await page.request.get(`${gateway.baseUrl}/__test/status`)).json()).requests).toHaveLength(before);
  await panel.getByRole('textbox').fill('说明这个 Skill 的用途，不执行任何命令');
  await panel.getByRole('button', { name: '提问', exact: true }).click();
  await expect(panel.locator('.ai-message.is-assistant')).not.toBeEmpty();
  await expect(panel.getByRole('button', { name: '提问', exact: true })).toBeVisible();
  const requests = (await (await page.request.get(`${gateway.baseUrl}/__test/status`)).json()).requests;
  expect(requests).toHaveLength(before + 1);
  expect(requests.at(-1).body.stream).toBeTruthy();
  expect(requests.at(-1).body.tools).toBeUndefined();
  expect(requests.at(-1).body.messages[0].content).toContain('untrusted reference data');
  await expect(panel.locator('.ai-context-details')).toContainText('1 个文件 · Magpie / fixture/text');
  expect(await readFile(path.join(alpha.path, 'SKILL.md'), 'utf8')).toBe(original);
  await panel.getByRole('button', { name: '删除当前对话', exact: true }).click();
  await expect(panel.locator('.ai-message')).toHaveCount(0);
});
