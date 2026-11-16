import { expect, test } from '@playwright/test';

test('saved checkmate: board history, player statistics, downloads and a fresh experiment', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('connection')).toHaveText('SSE подключён');
  await page.getByLabel('Модель · белые', { exact: true }).selectOption('ScriptedMoves');
  await page.getByLabel('Модель · чёрные', { exact: true }).selectOption('ScriptedMoves');
  await page.getByLabel('Ходы UCI · белые', { exact: true }).fill('f2f3 g2g4');
  await page.getByLabel('Ходы UCI · чёрные', { exact: true }).fill('e7e5 d8h4');
  await page.getByLabel('Между ходами, мс', { exact: true }).fill('0');
  await page.getByRole('button', { name: 'Применить настройки', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page.getByTestId('ply-count')).toHaveText('4');
  const id = await page.evaluate(() => sessionStorage.getItem('arena-match')!);
  const original = await (await page.request.get(`/api/matches/${id}`)).json();
  await page.getByRole('button', { name: 'История экспериментов', exact: true }).click();
  await page.getByRole('button').filter({ hasText: original.gameId.slice(0, 8) }).click();
  await expect(page.getByRole('heading', { name: 'Сохранённая партия' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Сравнение игроков' })).toContainText('Шахматная победа');
  await page.getByRole('button', { name: 'Полуход 2: e5', exact: true }).click();
  await expect(page.locator('.board-frame')).toHaveAttribute('data-fen', original.position.positions[2]);
  await expect(page.getByRole('log')).toContainText('Ход выполнен');
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Скачать PGN' }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe(`${original.gameId}.pgn`);
  const pgn = await (await page.request.get(`/api/experiments/${original.gameId}/export.pgn`)).text();
  expect(pgn).toContain('[Result "0-1"]'); expect(pgn).toContain('Qh4#');
  const exported = await (await page.request.get(`/api/experiments/${original.gameId}/export.json`)).json();
  expect(exported.snapshot.position.history).toEqual(original.position.history);
  expect(exported.statistics.plies).toBe(4);
  await page.setViewportSize({ width: 360, height: 960 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/artifacts/e2e/experiment-history.png', fullPage: true });
  await page.getByRole('button', { name: 'Новый эксперимент с этими настройками' }).click();
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeEnabled();
  await expect(page.getByTestId('ply-count')).toHaveText('0');
  const freshId = await page.evaluate(() => sessionStorage.getItem('arena-match')!);
  expect(freshId).not.toBe(id);
  const fresh = await (await page.request.get(`/api/matches/${freshId}`)).json();
  expect(fresh.config).toEqual(original.config);
});

test('archive preserves rejected attempts and Reset games independently', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('connection')).toHaveText('SSE подключён');
  const created = await (await page.request.post('/api/matches', { data: { maxRetries: 1, players: {
    white: { strategy: 'ScriptedMoves', moves: ['e2e5', 'e2e4'] }, black: { strategy: 'RandomLegalMove' },
  } } })).json();
  await page.request.post(`/api/matches/${created.id}/next-move`);
  await page.request.post(`/api/matches/${created.id}/reset`);
  await page.getByRole('button', { name: 'История экспериментов', exact: true }).click();
  await page.getByRole('button').filter({ hasText: created.gameId.slice(0, 8) }).click();
  await expect(page.getByTestId('ply-count')).toHaveText('1');
  await expect(page.getByRole('log')).toContainText('IllegalMove');
  await expect(page.getByRole('region', { name: 'Сравнение игроков' })).toContainText('50.0%');
  const snapshot = await (await page.request.get(`/api/experiments/${created.gameId}`)).json();
  expect(snapshot.snapshot.result.reason).toBe('Reset');
  expect(snapshot.snapshot.attempts).toHaveLength(2);
  await page.getByRole('button', { name: 'К списку экспериментов' }).click();
  await expect(page.getByRole('heading', { name: 'История экспериментов', exact: true })).toBeVisible();
});
