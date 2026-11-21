import { expect, test } from '@playwright/test';
import { openSettings, showInfo } from './ui-helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('connection')).toHaveText('SSE подключён');
});

test('drawer preserves independent drafts, traps focus, closes in three ways and keeps one SSE', async ({ page }) => {
  let streams = 0;
  page.on('request', request => { if (request.url().endsWith('/stream')) streams++; });
  const id = await page.evaluate(() => sessionStorage.getItem('arena-match'));
  await openSettings(page, 'Белые');
  const dialog = page.getByRole('dialog', { name: 'Настройки эксперимента', exact: true });
  await page.getByLabel('Seed · белые', { exact: true }).fill('1234');
  await page.getByRole('tab', { name: 'Белые', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Чёрные', exact: true })).toBeFocused();
  await page.getByLabel('Seed · чёрные', { exact: true }).fill('5678');
  await openSettings(page, 'Общие');
  await page.getByLabel('Максимум полуходов', { exact: true }).fill('20');
  const apply = page.getByRole('button', { name: 'Применить настройки', exact: true });
  await apply.focus(); await page.keyboard.press('Tab');
  expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Настройки', exact: true })).toBeFocused();
  await openSettings(page, 'Белые');
  await expect(page.getByLabel('Seed · белые', { exact: true })).toHaveValue('1234');
  await page.getByRole('button', { name: 'Закрыть: Настройки эксперимента', exact: true }).click();
  await openSettings(page, 'Чёрные');
  await expect(page.getByLabel('Seed · чёрные', { exact: true })).toHaveValue('5678');
  await page.mouse.click(20, 300);
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: 'История экспериментов', exact: true }).click();
  await openSettings(page, 'Общие');
  await expect(page.getByLabel('Максимум полуходов', { exact: true })).toHaveValue('20');
  expect(await page.evaluate(() => sessionStorage.getItem('arena-match'))).toBe(id);
  expect(streams).toBe(0);
  await page.screenshot({ path: '/artifacts/e2e/settings-drawer.png' });
  await apply.click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: 'Текущий матч', exact: true }).click();
  const freshId = await page.evaluate(() => sessionStorage.getItem('arena-match'));
  const fresh = await (await page.request.get(`/api/matches/${freshId}`)).json();
  expect(fresh.config.players.white.seed).toBe(1234);
  expect(fresh.config.players.black.seed).toBe(5678);
  expect(fresh.config.maxPlies).toBe(20);
  expect(fresh.status).toBe('Created');
  await page.getByRole('button', { name: 'Next Move', exact: true }).click();
  await expect(page.getByTestId('ply-count')).toHaveText('1');
  await openSettings(page, 'Общие');
  await expect(apply).toBeDisabled();
  await expect(page.getByLabel('Максимум полуходов', { exact: true })).toBeDisabled();
});

for (const [width, height] of [[1920, 1080], [1440, 900], [1366, 768], [1280, 720]] as const) {
  test(`desktop ${width}x${height}: board, players and controls fit; long tabs scroll internally`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const created = await (await page.request.post('/api/matches', { data: { maxPlies: 160, players: {
      white: { strategy: 'RandomLegalMove', seed: 21 }, black: { strategy: 'RandomLegalMove', seed: 42 },
    } } })).json();
    await page.request.post(`/api/matches/${created.id}/start`);
    await expect.poll(async () => (await (await page.request.get(`/api/matches/${created.id}`)).json()).result !== null, { timeout: 20000 }).toBe(true);
    await page.evaluate(id => sessionStorage.setItem('arena-match', id), created.id);
    await page.reload();
    await expect(page.getByTestId('connection')).toHaveText('SSE подключён');
    for (const selector of ['.board-frame', '.player', '.controls', '.history-nav']) {
      for (const element of await page.locator(selector).all()) {
        const box = (await element.boundingBox())!;
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(height);
      }
    }
    const board = (await page.locator('.board-frame').boundingBox())!;
    expect(Math.abs(board.width - board.height)).toBeLessThan(1);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const tab of ['Ходы', 'Журнал', 'Обзор'] as const) {
      await showInfo(page, tab);
      const scroller = page.locator(tab === 'Журнал' ? '.event-log' : '.tab-content:visible');
      const dimensions = await scroller.evaluate(element => ({ total: element.scrollHeight, visible: element.clientHeight }));
      expect(dimensions.visible).toBeGreaterThan(200);
      if (tab !== 'Обзор') expect(dimensions.total).toBeGreaterThan(dimensions.visible);
      expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
    }
    await page.screenshot({ path: `/artifacts/e2e/compact-${width}x${height}.png` });
    await showInfo(page, 'Журнал');
    await page.screenshot({ path: `/artifacts/e2e/compact-log-${width}x${height}.png` });
  });
}

test('history cleanup: confirmation, cancellation, error, actual deletion and active game protection', async ({ page }) => {
  const activeId = await page.evaluate(() => sessionStorage.getItem('arena-match'));
  await page.getByRole('button', { name: 'Next Move', exact: true }).click();
  await expect(page.getByTestId('ply-count')).toHaveText('1');
  const active = await (await page.request.get(`/api/matches/${activeId}`)).json();
  const first = await (await page.request.post('/api/matches', { data: {} })).json();
  expect((await page.request.post(`/api/matches/${first.id}/stop`)).ok()).toBe(true);
  const second = await (await page.request.post('/api/matches', { data: { maxPlies: 1 } })).json();
  expect((await page.request.post(`/api/matches/${second.id}/next-move`)).ok()).toBe(true);
  const ids = [first.gameId, second.gameId];
  const preview = await (await page.request.get('/api/experiments/cleanup')).json();
  expect(preview.gameIds).toEqual(expect.arrayContaining(ids));
  // Limit this browser's confirmation to its fixtures to preserve the user's archive volume.
  await page.route('**/api/experiments/cleanup', async route => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, gameIds: body.gameIds.filter((id: string) => ids.includes(id)) } });
  });
  const loadedPreview = page.waitForResponse('**/api/experiments/cleanup');
  await page.getByRole('button', { name: 'История экспериментов', exact: true }).click();
  expect((await (await loadedPreview).json()).gameIds).toHaveLength(2);
  const clear = page.getByRole('button', { name: 'Очистить историю', exact: true });
  await clear.click();
  const confirmation = page.getByRole('dialog', { name: 'Очистить историю?', exact: true });
  await expect(confirmation).toContainText('партии: 2');
  await expect(confirmation).toContainText('необратимо');
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
  expect((await page.request.get(`/api/experiments/${first.gameId}`)).ok()).toBe(true);
  await page.route('**/api/experiments', async route => {
    if (route.request().method() === 'DELETE') await route.fulfill({ status: 503, json: { error: { message: 'Тестовый отказ хранилища' } } });
    else await route.continue();
  });
  await clear.click(); await page.getByRole('button', { name: 'Удалить партии', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Тестовый отказ');
  await page.unroute('**/api/experiments');
  await clear.click(); await page.getByRole('button', { name: 'Удалить партии', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Удалено партий: 2');
  await expect(clear).toBeDisabled();
  for (const id of ids) expect((await page.request.get(`/api/experiments/${id}`)).status()).toBe(404);
  const preserved = await (await page.request.get(`/api/experiments/${active.gameId}`)).json();
  expect(preserved.snapshot.position.fen).toBe(active.position.fen);
  await page.getByRole('button', { name: 'Текущий матч', exact: true }).click();
  await expect(page.locator('.board-frame')).toHaveAttribute('data-fen', active.position.fen);
  await expect(page.getByTestId('connection')).toHaveText('SSE подключён');
  await page.unrouteAll({ behavior: 'wait' });
});

test('small drawer stays usable and invalid fields on another tab receive focus', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await openSettings(page, 'Белые');
  await page.getByLabel('Провайдер · белые', { exact: true }).selectOption('openai-compatible');
  await openSettings(page, 'Общие');
  await page.getByRole('button', { name: 'Применить настройки', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Белые', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Модель · белые', { exact: true })).toBeFocused();
  const dialog = page.getByRole('dialog', { name: 'Настройки эксперимента', exact: true });
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  const apply = (await page.getByRole('button', { name: 'Применить настройки', exact: true }).boundingBox())!;
  expect(apply.y + apply.height).toBeLessThanOrEqual(720);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 960, height: 540 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '150%'; });
  await page.getByRole('button', { name: 'Reset', exact: true }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Reset', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('empty history disables cleanup and compact pagination stays inside buttons', async ({ page }) => {
  await page.route('**/api/experiments?*', route => route.fulfill({ json: { experiments: [], total: 0, unreadableFiles: 0 } }));
  await page.route('**/api/experiments/cleanup', route => route.fulfill({ json: { schemaVersion: 1, gameIds: [] } }));
  await page.setViewportSize({ width: 320, height: 720 });
  await page.getByRole('button', { name: 'История экспериментов', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Очистить историю', exact: true })).toBeDisabled();
  await expect(page.getByText('Сохранённых партий пока нет.')).toBeVisible();
  for (const button of await page.locator('.archive-pagination button').all()) {
    expect(await button.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
