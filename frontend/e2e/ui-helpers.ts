import type { Page } from '@playwright/test';

export async function openSettings(page: Page, tab: 'Белые' | 'Чёрные' | 'Общие' | 'белые' | 'чёрные') {
  if (!await page.getByRole('dialog', { name: 'Настройки эксперимента', exact: true }).isVisible()) {
    await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  }
  const name = tab === 'белые' ? 'Белые' : tab === 'чёрные' ? 'Чёрные' : tab;
  await page.getByRole('tab', { name, exact: true }).click();
}
export async function showInfo(page: Page, tab: 'Обзор' | 'Ходы' | 'Журнал') {
  await page.getByRole('tab', { name: tab, exact: true }).click();
}
