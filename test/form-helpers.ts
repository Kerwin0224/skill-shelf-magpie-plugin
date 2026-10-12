import { expect, type Locator } from '@playwright/test';

export async function selectChoice(trigger: Locator, valueOrLabel: string) {
  const page = trigger.page();
  await trigger.click();
  // Radix temporarily hides the parent dialog/trigger from the accessibility tree.
  await expect(page.getByRole('listbox')).toBeVisible();
  let option = page.getByRole('option', { name: valueOrLabel, exact: true });
  if (await option.count() === 0) {
    const byValue = page.getByRole('option').and(page.locator(`[data-value=${JSON.stringify(valueOrLabel)}]`));
    await expect(byValue).toHaveCount(1);
    option = page.getByRole('option', { name: (await byValue.innerText()).trim(), exact: true });
  }
  await expect(option).toBeEnabled();
  const value = await option.getAttribute('data-value');
  await option.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  if (value !== null) await expect(trigger).toHaveAttribute('data-value', value);
}
