import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { WorkbenchSnapshot } from '../web/src/workbench-types';
import { selectChoice } from './form-helpers';

type UiSnapshot = { skills: { id: string; name: string; description: string; path: string }[] };
type Completion = { body: { model: string; messages: { role: string; content: string }[] } };

async function api<T>(page: Page, route: string): Promise<T> {
  const session = await page.request.get('/api/session');
  expect(session.ok()).toBeTruthy();
  const response = await page.request.get(`/api${route}`, { headers: { 'X-Shelf-Token': (await session.json()).token } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

async function inferenceCalls(page: Page): Promise<Completion[]> {
  const status = await api<{ baseUrl: string }>(page, '/ai/status');
  const response = await page.request.get(`${status.baseUrl}/__test/status`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()).requests;
}

async function showSidebar(page: Page) {
  const back = page.getByRole('button', { name: '返回', exact: true });
  if (await back.isVisible()) await back.click();
  const trigger = page.getByRole('button', { name: '打开侧边栏', exact: true });
  if (await trigger.isVisible()) await trigger.click();
}

async function openSettings(page: Page, section: string) {
  await showSidebar(page);
  await page.getByRole('navigation', { name: '应用设置', exact: true }).getByRole('button', { name: '设置', exact: true }).click();
  await chooseSection(page, section);
}

async function chooseSection(page: Page, name: string) {
  await page.getByRole('navigation', { name: '设置分类', exact: true }).getByRole('button', { name, exact: true }).click();
  await expect(page.locator('.settings-content').getByRole('heading', { name: name === '模型服务' ? 'Magpie' : name, level: 2, exact: true })).toBeVisible();
}

async function goSkills(page: Page) {
  await showSidebar(page);
  await page.getByRole('navigation', { name: 'Skill Shelf 导航', exact: true }).getByRole('button', { name: /^Skills/ }).click();
  await expect(page.locator('.finder-browser')).toBeVisible();
}

async function goWorkbench(page: Page) {
  await showSidebar(page);
  await page.getByRole('navigation', { name: 'Skill Shelf 导航', exact: true }).getByRole('button', { name: '工作台', exact: true }).click();
  await expect(page.getByRole('heading', { name: '本地 Skill 工作台', exact: true })).toBeVisible();
  await expect(page.locator('.workbench-workspace')).toHaveAttribute('aria-busy', 'false');
}

async function openAlpha(page: Page) {
  const state = await api<UiSnapshot>(page, '/state');
  const alpha = state.skills.find(skill => skill.name === 'Alpha Research')!;
  await page.locator(`[data-finder-item-key="skill:${alpha.id}"]`).getByRole('button', { name: '查看 Alpha Research 详情' }).click();
  await page.getByRole('button', { name: '打开 AI 助手', exact: true }).click();
  await expect(page.getByTestId('ai-assistant-sidebar')).toBeVisible();
  return alpha;
}

function referenceOf(call: Completion): string {
  const content = call.body.messages.find(message => message.role === 'user')!.content;
  const match = content.match(/BEGIN_UNTRUSTED_SKILL_REFERENCE_JSON\n([^\n]*)\nEND_UNTRUSTED_SKILL_REFERENCE_JSON/)!;
  return JSON.parse(match[1]).untrustedReference;
}

test('Workbench is the default page and reports real global inventory, agent filters and read-only diagnostics', async ({ page }) => {
  const baseline = (await inferenceCalls(page)).length;
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '本地 Skill 工作台', exact: true })).toBeVisible();
  await expect(page.locator('.workbench-workspace')).toHaveAttribute('aria-busy', 'false');
  const snapshot = await api<WorkbenchSnapshot>(page, '/workbench');
  const inventory = page.locator('.workbench-inventory');
  await expect(inventory.locator('header')).toContainText(`共 ${snapshot.stats.totalSkills} 个`);
  const locations = inventory.locator('.workbench-inventory-locations > div');
  await expect(locations.nth(0).locator('.workbench-location-heading strong')).toHaveText(`${snapshot.stats.sharedSkills}Skills`);
  await expect(locations.nth(1).locator('.workbench-location-heading strong')).toHaveText(`${snapshot.stats.exclusiveSkills}Skills`);
  await expect(inventory).toContainText('按 Skill 名称去重；本页不统计项目内的 Skill。');
  await expect(inventory.locator('code')).toHaveText(snapshot.sharedDirectory.path);
  const filters = page.locator('.workbench-agent-filters');
  for (const [label, status] of [['找到程序', 'found'], ['可能残留', 'not-found'], ['未验证', 'unverified']] as const) {
    const button = filters.getByRole('button', { name: new RegExp(`^${label}`) });
    await expect(button.locator('span')).toHaveText(String(snapshot.agentCoverage.filter(agent => agent.program.status === status).length));
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.workbench-agent-row')).toHaveCount(Math.min(6, snapshot.agentCoverage.filter(agent => agent.program.status === status).length));
  }
  await filters.getByRole('button', { name: /^全部/ }).click();
  const agent = snapshot.agentCoverage.find(agent => agent.exclusiveSkills > 0) || snapshot.agentCoverage[0];
  expect(agent).toBeTruthy();
  const search = page.getByRole('searchbox', { name: '搜索 Agent 或目录', exact: true });
  await search.fill(agent.path);
  await expect(page.locator('.workbench-agent-row')).toHaveCount(1);
  const row = page.locator('.workbench-agent-row');
  await expect(row).toContainText(agent.name);
  await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  const detail = page.locator('.workbench-agent-detail');
  await expect(detail).toContainText('程序检测依据');
  await expect(detail).toContainText(agent.path);
  await detail.getByRole('button', { name: /^专属 Skill/ }).click();
  if (agent.exclusiveSkillNames.length) await expect(detail.locator('.workbench-skill-names li strong')).toHaveText(agent.exclusiveSkillNames);
  await search.fill('no-such-agent-unique-fixture');
  await expect(page.locator('.workbench-agent-row')).toHaveCount(0);
  await expect(page.locator('.workbench-agent-empty')).toHaveText('没有符合筛选条件的 Agent。');
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(search).toBeFocused();
  await page.locator('.workbench-file-checks summary').click();
  await expect(page.locator('.workbench-file-checks-body')).toContainText(`链接目标缺失 ${snapshot.symlinkHealth.broken}`);
  await expect(page.locator('.workbench-file-checks-body')).toContainText('不执行 Skill，也不评估内容质量');
  await page.locator('.workbench-workspace').getByRole('button', { name: '重新扫描', exact: true }).click();
  await expect(page.locator('.workbench-workspace')).toHaveAttribute('aria-busy', 'false');
  await expect(inventory.locator('header')).toContainText(`共 ${snapshot.stats.totalSkills} 个`);
  expect(await inferenceCalls(page)).toHaveLength(baseline);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('Settings keeps desktop sections and user-facing copy while refreshing models without inference', async ({ page }) => {
  const baseline = (await inferenceCalls(page)).length;
  await page.goto('/');
  await openSettings(page, '通用');
  await expect(page.locator('.settings-navigation button')).toHaveText(['通用', '外观', '快捷键', 'Skills 与 Agent', '云同步', '关于', '模型服务', '默认模型', 'AI 行为']);
  for (const name of ['通用', '外观', '快捷键', 'Skills 与 Agent', '关于', '模型服务', '默认模型', 'AI 行为']) {
    await chooseSection(page, name);
    await expect(page.locator('.settings-content')).not.toContainText(/客户端相同|实际启用|真实|原版|占位|不会伪装|宿主适配|宿主生命周期|模拟地址|当前浏览器|插件接口|Magpie 源码|无后台推理|推理请求/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  }
  await chooseSection(page, '模型服务');
  const section = page.getByTestId('settings-ai-provider');
  const status = await api<{ baseUrl: string; models: { id: string; name: string }[] }>(page, '/ai/status');
  await expect(section).toContainText('服务商、账号和模型请在 Magpie 中管理。');
  await expect(section).not.toContainText(status.baseUrl);
  for (const model of status.models) await expect(section).toContainText(model.id);
  await expect(section).not.toContainText('fixture/image');
  await expect(section.locator('input')).toHaveCount(0);
  await section.getByRole('button', { name: '刷新模型', exact: true }).click();
  await expect(section.getByRole('button', { name: '刷新模型', exact: true })).toBeEnabled();
  await expect(section.getByRole('status')).toHaveText('已连接');
  expect(await inferenceCalls(page)).toHaveLength(baseline);
});

test('Settings shares desktop headings and compact structure without unsupported or comparative rows', async ({ page }, info) => {
  await page.goto('/');
  await openSettings(page, '通用');
  const content = page.locator('.settings-content');
  await expect(content.getByRole('heading', { level: 3 })).toHaveText(['启动']);
  await expect(content.locator('.setting-row strong')).toHaveText(['启动页面', '记住上次位置']);
  await expect(content.getByRole('switch', { name: '登录时启动', exact: true })).toHaveCount(0);
  if (info.project.name !== 'mobile') {
    expect(await page.locator('.settings-workspace').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ')[0])).toBe('200px');
    expect(await content.locator('.settings-page').evaluate(element => getComputedStyle(element).paddingTop)).toBe('16px');
  }
  await chooseSection(page, '外观');
  await expect(content.getByRole('heading', { level: 3 })).toHaveText(['界面']);
  await expect(content.locator('.setting-row strong')).toHaveText(['主题', '列表密度']);
  await chooseSection(page, '快捷键');
  await expect(content.getByRole('heading', { level: 3 })).toHaveText(['Skill 浏览', 'Skill 详情面板', '搜索']);
  await expect(content.locator('.shortcut-keys').first().locator('kbd')).toHaveCount(2);
  await chooseSection(page, 'Skills 与 Agent');
  await expect(content.getByRole('heading', { level: 3 }).first()).toHaveText('已安装的 Skill');
  await expect(content.getByRole('heading', { level: 3 }).nth(1)).toHaveText('关注的 Agent');
  await expect(content.getByRole('button', { name: '导入 Pack 文件', exact: true })).toBeVisible();
  await expect(content.getByRole('combobox', { name: '导出的 Pack', exact: true })).toBeVisible();
  await expect(content.locator('.settings-agent-grid')).toHaveCount(0);
  await expect(content.getByRole('button', { name: '管理', exact: true })).toBeVisible();
  await chooseSection(page, '关于');
  await expect(content.locator('.about-identity')).toContainText('Skill Shelf');
  await expect(content.locator('.privacy-card')).toContainText('你的 Skill 书架保存在这台电脑上。');
  await expect(content).not.toContainText(/客户端交互|宿主|WebDAV|更新器|开机启动/);
  await chooseSection(page, 'AI 行为');
  await expect(content.getByRole('heading', { level: 3 })).toHaveText(['AI 行为']);
  await expect(content.locator('.setting-row strong')).toHaveText(['默认输出语言', '上下文范围']);
  await content.locator('.settings-privacy-note summary').click();
  await expect(content).toContainText('内容经 Magpie 发送给所选模型服务，并按该服务计费。');
  await expect(content).toContainText('描述翻译只发送原始描述。');
  await expect(content).toContainText('对话可以附上所选 Skill 的 SKILL.md 和会话内容');
});

test('Settings connection failures offer recovery without exposing internal errors', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.workbench-workspace')).toHaveAttribute('aria-busy', 'false');
  let failed = true;
  await page.route('**/api/ai/status', route => failed
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic internal AI transport error' }) })
    : route.continue());
  await openSettings(page, '模型服务');
  const provider = page.getByTestId('settings-ai-provider');
  await expect(provider.getByRole('status')).toHaveText('无法连接 Magpie，请确认已打开后重试。');
  await expect(provider).not.toContainText('Synthetic internal');
  failed = false;
  await provider.getByRole('button', { name: '刷新模型', exact: true }).click();
  await expect(provider.getByRole('status')).toHaveText('已连接');
  failed = true;
  await page.route('**/api/workbench', route => failed
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic internal Agent registry error' }) })
    : route.continue());
  await chooseSection(page, 'Skills 与 Agent');
  const content = page.locator('.settings-content');
  await expect(content.getByRole('alert')).toContainText('无法加载 Agent，请重试。');
  await expect(content).not.toContainText('Synthetic internal');
  failed = false;
  await content.getByRole('button', { name: '重试', exact: true }).click();
  await expect(content.getByRole('alert')).toHaveCount(0);
  await content.getByRole('button', { name: '管理', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '关注的 Agent', exact: true }).locator('.agent-focus-section button').first()).toBeVisible();
});

test('Shared settings controls retain desktop dimensions, grouping and keyboard behavior', async ({ page }, info) => {
  await page.goto('/');
  await openSettings(page, '通用');
  const content = page.locator('.settings-content');
  const startup = content.getByRole('combobox', { name: '启动页面', exact: true });
  expect(await startup.evaluate(element => ({ height: getComputedStyle(element).height, width: getComputedStyle(element).width }))).toEqual({ height: '36px', width: '180px' });
  expect(await content.getByRole('switch').evaluate(element => ({ height: getComputedStyle(element).height, width: getComputedStyle(element).width }))).toEqual({ height: '20px', width: '36px' });
  expect(await content.locator('.setting-rows').evaluate(element => ({ border: getComputedStyle(element).borderTopWidth, padding: getComputedStyle(element).padding }))).toEqual({ border: '1px', padding: '0px' });
  await chooseSection(page, '外观');
  const theme = content.getByRole('radiogroup');
  expect(await theme.evaluate(element => getComputedStyle(element).height)).toBe('36px');
  expect(await theme.getByRole('radio').first().evaluate(element => getComputedStyle(element).height)).toBe('28px');
  await theme.getByRole('radio', { name: '跟随系统', exact: true }).click();
  await page.keyboard.press('ArrowRight');
  await expect(theme.getByRole('radio', { name: '浅色', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(theme.getByRole('radio', { name: '浅色', exact: true })).toBeFocused();
  const density = content.getByRole('tablist');
  expect(await density.evaluate(element => getComputedStyle(element).height)).toBe('36px');
  await density.getByRole('tab', { name: '舒适', exact: true }).click();
  await page.keyboard.press('ArrowRight');
  await expect(density.getByRole('tab', { name: '紧凑', exact: true })).toHaveAttribute('aria-selected', 'true');
  await chooseSection(page, '默认模型');
  const role = content.getByRole('combobox', { name: 'Skill 分析模型', exact: true });
  await expect(role.locator('.ai-model-option strong')).toHaveCount(1);
  await expect(role.locator('.ai-model-option small')).toContainText('Magpie ·');
  const modelStyle = await role.evaluate(element => ({ minHeight: getComputedStyle(element).minHeight, width: getComputedStyle(element).width }));
  expect(modelStyle.minHeight).toBe('44px');
  if (info.project.name !== 'mobile') expect(modelStyle.width).toBe('288px');
  await chooseSection(page, '模型服务');
  await expect(content.locator('.ai-provider-browser > aside')).toBeVisible();
  await expect(content.locator('.ai-provider-section > h3')).toHaveText(['服务状态', '模型连接']);
  await expect(content.locator('.ai-provider-models > div')).not.toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('Focused Agents use the desktop modal with search, selection limit, automatic mode and restored focus', async ({ page }) => {
  await page.goto('/');
  await openSettings(page, 'Skills 与 Agent');
  const trigger = page.locator('.settings-content').getByRole('button', { name: '管理', exact: true });
  await expect(trigger).toBeEnabled();
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '关注的 Agent', exact: true });
  expect(await dialog.evaluate(element => element.matches(':modal'))).toBeTruthy();
  const search = dialog.getByRole('searchbox', { name: '搜索 Agent', exact: true });
  await expect(search).toBeFocused();
  await search.fill('no-such-agent-fixture');
  await search.press('Enter');
  await expect(dialog.locator('.agent-focus-section button')).toHaveCount(0);
  await expect(dialog).toContainText('没有匹配的 Agent');
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(dialog).toBeVisible();
  const choices = dialog.locator('.agent-focus-section button');
  expect(await choices.count()).toBeGreaterThan(12);
  for (let index = 0; index < 12; index++) await dialog.locator('.agent-focus-section button[aria-pressed="false"]').first().click();
  await expect(dialog.locator('.agent-focus-count')).toContainText('已选择 12 个');
  await expect(dialog.locator('.agent-focus-section button[aria-pressed="false"]').first()).toBeDisabled();
  await expect(dialog.locator('.agent-focus-section button[aria-pressed="true"]').first()).toBeEnabled();
  await dialog.getByRole('button', { name: '改用自动展示', exact: true }).click();
  await expect(dialog.locator('.agent-focus-count')).toContainText('已选择 0 个');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.locator('.focused-agent-summary')).toHaveText('自动展示 · 未固定 Agent');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('AI settings save distinct models, language and description-only summary and disabled AI prevents inference', async ({ page }) => {
  const baseline = (await inferenceCalls(page)).length;
  await page.goto('/');
  await openSettings(page, '默认模型');
  const models = page.getByTestId('settings-ai-models');
  await expect(models.getByRole('button', { name: '保存默认模型', exact: true })).toBeEnabled();
  await selectChoice(models.getByRole('combobox', { name: '对话模型', exact: true }), 'fixture/other');
  await selectChoice(models.getByRole('combobox', { name: 'Skill 分析模型', exact: true }), 'fixture/other');
  await selectChoice(models.getByRole('combobox', { name: '描述与翻译模型', exact: true }), 'fixture/text');
  expect(await page.evaluate(() => localStorage.getItem('shelf-ai:preferences'))).toBeNull();
  await models.getByRole('button', { name: '保存默认模型', exact: true }).click();
  await chooseSection(page, 'AI 行为');
  const behavior = page.getByTestId('settings-ai-behavior');
  await selectChoice(behavior.getByRole('combobox', { name: '默认输出语言', exact: true }), 'en');
  await selectChoice(behavior.getByRole('combobox', { name: '上下文范围', exact: true }), 'description');
  await behavior.getByRole('button', { name: '保存 AI 设置', exact: true }).click();
  expect(await inferenceCalls(page)).toHaveLength(baseline);
  await goSkills(page);
  const alpha = await openAlpha(page);
  const original = await readFile(path.join(alpha.path, 'SKILL.md'), 'utf8');
  const baselineResults = await api<unknown>(page, `/ai/result?id=${encodeURIComponent(alpha.id)}`);
  const panel = page.getByTestId('ai-assistant-sidebar');
  await expect(panel.getByRole('combobox', { name: '对话模型', exact: true })).toHaveAttribute('data-value', 'fixture/other');
  await expect(panel.getByRole('combobox', { name: '翻译为', exact: true })).toHaveAttribute('data-value', 'en');
  await panel.getByRole('button', { name: '生成描述', exact: true }).click();
  await expect(panel.locator('.ai-message.is-assistant').last()).toContainText('Fixture summary:');
  let calls = await inferenceCalls(page);
  expect(calls).toHaveLength(baseline + 1);
  expect(calls.at(-1)!.body.model).toBe('fixture/text');
  expect(referenceOf(calls.at(-1)!)).toBe(alpha.description);
  expect(calls.at(-1)!.body.messages[0].content).toContain('Write in English');
  expect(await api<unknown>(page, `/ai/result?id=${encodeURIComponent(alpha.id)}`)).toEqual(baselineResults);
  await panel.getByRole('button', { name: '新建对话', exact: true }).click();
  await panel.getByRole('button', { name: '翻译', exact: true }).click();
  await expect(panel.locator('.ai-message.is-assistant').last()).toContainText('Fixture translation:');
  calls = await inferenceCalls(page);
  expect(calls).toHaveLength(baseline + 2);
  expect(calls.at(-1)!.body.model).toBe('fixture/text');
  expect(referenceOf(calls.at(-1)!)).toBe(alpha.description);
  expect(await readFile(path.join(alpha.path, 'SKILL.md'), 'utf8')).toBe(original);
  if (await panel.isVisible()) await panel.getByRole('button', { name: '关闭 AI 助手', exact: true }).click();
  await page.getByRole('dialog', { name: 'Alpha Research', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
  await openSettings(page, '模型服务');
  await page.getByTestId('settings-ai-provider').getByRole('switch', { name: '启用 AI 功能', exact: true }).click();
  await goSkills(page);
  await openAlpha(page);
  await expect(panel.getByRole('button', { name: '生成描述', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '翻译', exact: true })).toHaveCount(0);
  await expect(panel).toContainText('连接模型后使用助手');
  if (await panel.isVisible()) await panel.getByRole('button', { name: '关闭 AI 助手', exact: true }).click();
  await page.getByRole('dialog', { name: 'Alpha Research', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator(`[data-finder-item-key="skill:${alpha.id}"]`).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '翻译 description', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.reload();
  await openAlpha(page);
  await expect(panel).toContainText('连接模型后使用助手');
  expect(await inferenceCalls(page)).toHaveLength(baseline + 2);
});

test('An explicit missing AI model stays missing and never silently chooses another model', async ({ page }) => {
  const baseline = (await inferenceCalls(page)).length;
  await page.goto('/#skills:global');
  await page.evaluate(() => localStorage.setItem('shelf-ai:preferences', JSON.stringify({ enabled: true, summaryModel: 'not-enabled/paid-model', translationModel: 'not-enabled/paid-model', targetLanguage: 'en', summaryContext: 'skill-md' })));
  await page.reload();
  await openAlpha(page);
  const panel = page.getByTestId('ai-assistant-sidebar');
  await expect(panel.getByRole('combobox', { name: '对话模型', exact: true })).toHaveAttribute('data-value', 'not-enabled/paid-model');
  await expect(panel.getByRole('button', { name: '生成描述', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: '翻译', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: '提问', exact: true })).toBeDisabled();
  if (await panel.isVisible()) await panel.getByRole('button', { name: '关闭 AI 助手', exact: true }).click();
  await page.getByRole('dialog', { name: 'Alpha Research', exact: true }).getByRole('button', { name: '关闭', exact: true }).click();
  await openSettings(page, '默认模型');
  await expect(page.getByTestId('settings-ai-models').getByRole('button', { name: '保存默认模型', exact: true })).toBeDisabled();
  await expect(page.getByTestId('settings-ai-models').getByRole('alert')).toContainText('请重新选择');
  expect(await inferenceCalls(page)).toHaveLength(baseline);
});

test('Theme, actual Finder list density, startup workspace and remembered location persist', async ({ page }) => {
  await page.goto('/');
  await openSettings(page, '外观');
  await page.getByRole('radiogroup', { name: '外观主题', exact: true }).getByRole('radio', { name: '浅色', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('radio', { name: '浅色', exact: true })).toHaveAttribute('aria-checked', 'true');
  await goSkills(page);
  await page.getByRole('button', { name: '列表视图', exact: true }).click();
  const rows = page.locator('[data-finder-item-key]');
  await expect(rows.first()).toBeVisible();
  const comfortableHeight = (await rows.first().boundingBox())!.height;
  await openSettings(page, '外观');
  await page.getByRole('radiogroup', { name: '外观主题', exact: true }).getByRole('radio', { name: '深色', exact: true }).click();
  await page.getByRole('tablist', { name: '列表密度', exact: true }).getByRole('tab', { name: '紧凑', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  await expect(page.getByRole('tab', { name: '紧凑', exact: true })).toHaveAttribute('aria-selected', 'true');
  await goSkills(page);
  await expect(rows.first()).toBeVisible();
  expect((await rows.first().boundingBox())!.height).toBeLessThan(comfortableHeight);
  await page.reload();
  await expect(page.locator('.finder-browser')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
  expect((await rows.first().boundingBox())!.height).toBeLessThan(comfortableHeight);
  await openSettings(page, '通用');
  const startup = page.getByRole('combobox', { name: '启动页面', exact: true });
  await selectChoice(startup, 'skills');
  await page.goto('/');
  await expect(page.locator('.finder-browser')).toBeVisible();
  await expect(page.locator('.workbench-workspace')).toHaveCount(0);
  await openSettings(page, '通用');
  await selectChoice(startup, 'packs');
  await page.goto('/');
  await expect(page.getByTestId('create-pack')).toBeVisible();
  await expect(page.getByRole('navigation', { name: '安装范围', exact: true })).toHaveCount(0);
  await openSettings(page, '通用');
  await selectChoice(startup, 'workbench');
  await page.getByRole('switch', { name: '记住上次位置', exact: true }).click();
  await expect(page.getByRole('switch', { name: '记住上次位置', exact: true })).toHaveAttribute('aria-checked', 'true');
  await goSkills(page);
  await page.goto('/');
  await expect(page.locator('.finder-browser')).toBeVisible();
  await expect(page.locator('.workbench-workspace')).toHaveCount(0);
  await openSettings(page, '通用');
  await page.getByRole('switch', { name: '记住上次位置', exact: true }).click();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '本地 Skill 工作台', exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('shelf-ui:preferences')!))).toMatchObject({ startupPage: 'workbench', rememberLocation: false, density: 'compact' });
});

test('Manage focused Agents uses the settings selection and persists into Workbench focused filtering', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.workbench-workspace')).toHaveAttribute('aria-busy', 'false');
  const snapshot = await api<WorkbenchSnapshot>(page, '/workbench');
  const agent = snapshot.agentCoverage.find(candidate => snapshot.registry.agents.some(entry => entry.name === candidate.name))!;
  expect(agent).toBeTruthy();
  await page.getByRole('button', { name: '管理关注', exact: true }).click();
  await expect(page.locator('.settings-content').getByRole('heading', { name: 'Skills 与 Agent', exact: true })).toBeVisible();
  await page.locator('.settings-content').getByRole('button', { name: '管理', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '关注的 Agent', exact: true });
  const choice = dialog.locator('.agent-focus-section button').filter({ has: page.getByText(agent.name, { exact: true }) });
  await expect(choice).toHaveAttribute('aria-pressed', 'false');
  await choice.click();
  await expect(choice).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await goWorkbench(page);
  const focused = page.locator('.workbench-agent-filters').getByRole('button', { name: /^已关注/ });
  await expect(focused.locator('span')).toHaveText('1');
  await focused.click();
  await expect(page.locator('.workbench-agent-row')).toHaveCount(1);
  await expect(page.locator('.workbench-agent-row')).toContainText(agent.name);
  await page.reload();
  await expect(page.locator('.workbench-workspace')).toHaveAttribute('aria-busy', 'false');
  await focused.click();
  await expect(page.locator('.workbench-agent-row')).toHaveCount(1);
  await expect(page.locator('.workbench-agent-row')).toContainText(agent.name);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('shelf-ui:preferences')!).focusedAgents)).toEqual([agent.name]);
  await page.getByRole('button', { name: '管理关注', exact: true }).click();
  await page.locator('.settings-content').getByRole('button', { name: '管理', exact: true }).click();
  await expect(choice).toHaveAttribute('aria-pressed', 'true');
  await choice.click();
  await page.keyboard.press('Escape');
  await goWorkbench(page);
  await focused.click();
  await expect(page.locator('.workbench-agent-row')).toHaveCount(0);
  await expect(page.locator('.workbench-agent-empty')).toHaveText('没有符合筛选条件的 Agent。');
});

test('Workbench handles initial errors, retries, preserves stale results and sends directory IDs without opening the OS', async ({ page }) => {
  let failScan = true;
  const directoryRequests: unknown[] = [];
  await page.route('**/api/workbench', async route => {
    if (failScan) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Synthetic workbench scan failure' }) });
    else await route.continue();
  });
  await page.route('**/api/workbench/open-directory', async route => {
    directoryRequests.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.goto('/');
  const workspace = page.locator('.workbench-workspace');
  await expect(workspace.getByRole('alert')).toContainText('无法扫描本地工作区');
  await expect(workspace.getByRole('alert')).toContainText('Synthetic workbench scan failure');
  await expect(workspace).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.workbench-inventory')).toHaveCount(0);
  failScan = false;
  await workspace.getByRole('button', { name: '重试', exact: true }).click();
  await expect(workspace.getByRole('alert')).toHaveCount(0);
  await expect(workspace).toHaveAttribute('aria-busy', 'false');
  const snapshot = await api<WorkbenchSnapshot>(page, '/workbench');
  const inventory = page.locator('.workbench-inventory');
  await expect(inventory.locator('header')).toContainText(`共 ${snapshot.stats.totalSkills} 个`);
  await page.locator('.workbench-shared-location').getByRole('button', { name: '打开目录', exact: true }).click();
  await expect.poll(() => directoryRequests).toEqual([{ id: 'shared' }]);
  const agent = snapshot.agentCoverage.find(agent => agent.directoryExists)!;
  expect(agent).toBeTruthy();
  await page.getByRole('searchbox', { name: '搜索 Agent 或目录', exact: true }).fill(agent.path);
  await page.locator('.workbench-agent-row').click();
  await page.locator('.workbench-agent-detail').getByRole('button', { name: '打开目录', exact: true }).click();
  await expect.poll(() => directoryRequests).toEqual([{ id: 'shared' }, { id: agent.id }]);
  failScan = true;
  await workspace.getByRole('button', { name: '重新扫描', exact: true }).click();
  await expect(workspace.getByRole('alert')).toContainText('Synthetic workbench scan failure');
  await expect(workspace.getByRole('alert')).toContainText('当前显示上次成功扫描的结果。');
  await expect(workspace).toHaveAttribute('aria-busy', 'false');
  await expect(inventory.locator('header')).toContainText(`共 ${snapshot.stats.totalSkills} 个`);
  failScan = false;
  await workspace.getByRole('button', { name: '重试', exact: true }).click();
  await expect(workspace.getByRole('alert')).toHaveCount(0);
  await expect(workspace).toHaveAttribute('aria-busy', 'false');
  await expect(inventory.locator('header')).toContainText(`共 ${snapshot.stats.totalSkills} 个`);
});
