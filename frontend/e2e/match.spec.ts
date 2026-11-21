import { openSettings, showInfo } from './ui-helpers';
import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('connection')).toHaveText('SSE подключён');
});
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
async function apply(page: Page) {
  const saved = page.waitForResponse(response => response.url().endsWith('/api/matches') && response.request().method() === 'POST' && response.ok());
  await button(page, 'Применить настройки').click();
  await saved;
  await expect(button(page, 'Start')).toBeEnabled();
  await expect(page.getByTestId('connection')).toHaveText('SSE подключён');
}
async function matchId(page: Page) { return page.evaluate(() => sessionStorage.getItem('arena-match')!); }

test('automatic match, Pause, Resume, Next Move, history, Stop and Reset', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await expect(page.getByRole('img', { name: /Шахматная доска/ })).toBeVisible();
  await expect(page.locator('[data-square]')).toHaveCount(64);
  await expect(button(page, 'Pause')).toBeDisabled();
  await button(page, 'Start').click();
  await expect.poll(async () => Number(await page.getByTestId('ply-count').textContent())).toBeGreaterThanOrEqual(2);
  await button(page, 'Pause').click();
  await expect(button(page, 'Next Move')).toBeEnabled();
  const count = Number(await page.getByTestId('ply-count').textContent());
  await button(page, 'Next Move').click();
  await expect(page.getByTestId('ply-count')).toHaveText(String(count + 1));
  await expect(button(page, 'Resume')).toBeEnabled();
  const fen = await page.locator('.board-frame').getAttribute('data-fen');
  await button(page, 'Начало партии').click();
  await expect(page.getByRole('status', { name: 'Состояние партии' })).toContainText('Просмотр истории');
  expect(await page.locator('.board-frame').getAttribute('data-fen')).not.toBe(fen);
  await button(page, 'Следующий ход').click();
  await expect(page.getByRole('status', { name: 'Состояние партии' })).toContainText('полуход 1');
  await button(page, 'Последняя позиция').click();
  await expect(page.locator('.board-frame')).toHaveAttribute('data-fen', fen!);
  await button(page, 'Перевернуть доску').click();
  await expect(page.locator('.board-frame')).toHaveAttribute('data-orientation', 'black');
  await button(page, 'Resume').click();
  await expect.poll(async () => Number(await page.getByTestId('ply-count').textContent())).toBeGreaterThan(count + 1);
  await button(page, 'Stop').click();
  await expect(page.getByRole('heading', { name: 'Матч остановлен' })).toBeVisible();
  await button(page, 'Reset').click();
  await expect(page.getByTestId('ply-count')).toHaveText('0');
  await showInfo(page, 'Журнал');
  await expect(page.getByRole('log')).not.toContainText('Ход выполнен');
  await expect(button(page, 'Start')).toBeEnabled();
  expect(errors).toEqual([]);
  await page.screenshot({ path: '/artifacts/e2e/arena-desktop.png', fullPage: true });
});

test('illegal and malformed responses retain the board and expose diagnostics and retries', async ({ page }) => {
  await openSettings(page, 'Белые');
  await page.getByLabel('Модель · белые', { exact: true }).selectOption('InvalidMove');
  await openSettings(page, 'Общие');
  await page.getByLabel('Повторных попыток', { exact: true }).fill('1');
  await apply(page);
  const fen = await page.locator('.board-frame').getAttribute('data-fen');
  await button(page, 'Next Move').click();
  await expect(page.getByRole('heading', { name: 'Партия завершена' })).toBeVisible();
  await showInfo(page, 'Журнал');
  await expect(page.getByRole('log')).toContainText('IllegalMove');
  await showInfo(page, 'Журнал');
  await expect(page.getByRole('log')).toContainText('mock-white-InvalidMove');
  await showInfo(page, 'Журнал');
  await expect(page.getByRole('log')).toContainText('{"move":"a1a1"}');
  await showInfo(page, 'Журнал');
  await expect(page.getByRole('log')).toContainText('повтор 1');
  await expect(page.locator('.board-frame')).toHaveAttribute('data-fen', fen!);
  await expect(page.locator('[data-square="a1"] > div')).toHaveCSS('box-shadow', /238, 133, 133/);
  await button(page, 'Reset').click();
  await showInfo(page, 'Журнал');
  await expect(page.getByRole('log')).not.toContainText('IllegalMove');
  await openSettings(page, 'Белые');
  await page.getByLabel('Модель · белые', { exact: true }).selectOption('MalformedResponse');
  await apply(page);
  await button(page, 'Next Move').click();
  await showInfo(page, 'Журнал');
  await expect(page.getByRole('log')).toContainText('InvalidFormat');
  await expect(page.locator('.board-frame')).toHaveAttribute('data-fen', fen!);
});

test('step mode and scripted checkmate use SAN and authoritative historical FEN', async ({ page }) => {
  await openSettings(page, 'Белые');
  await page.getByLabel('Модель · белые', { exact: true }).selectOption('ScriptedMoves');
  await openSettings(page, 'Чёрные');
  await page.getByLabel('Модель · чёрные', { exact: true }).selectOption('ScriptedMoves');
  await openSettings(page, 'Белые');
  await page.getByLabel('Ходы UCI · белые', { exact: true }).fill('f2f3 g2g4');
  await openSettings(page, 'Чёрные');
  await page.getByLabel('Ходы UCI · чёрные', { exact: true }).fill('e7e5 d8h4');
  await openSettings(page, 'Общие');
  await page.getByLabel('Режим игры', { exact: true }).selectOption('step');
  await openSettings(page, 'Общие');
  await page.getByLabel('Передача позиции', { exact: true }).selectOption('B');
  await apply(page);
  await button(page, 'Start').click();
  await expect(page.getByTestId('ply-count')).toHaveText('1');
  for (let ply = 2; ply <= 4; ply++) {
    await expect(button(page, 'Next Move')).toBeEnabled();
    await button(page, 'Next Move').click();
    await expect(page.getByTestId('ply-count')).toHaveText(String(ply));
  }
  await expect(page.getByRole('status', { name: 'Состояние партии' })).toContainText('Мат');
  await showInfo(page, 'Ходы');
  await expect(button(page, 'Полуход 4: Qh4#')).toBeVisible();
  await showInfo(page, 'Ходы');
  await button(page, 'Полуход 2: e5').click();
  await expect(page.getByRole('status', { name: 'Состояние партии' })).toContainText('Просмотр истории');
  const id = await matchId(page);
  const snapshot = await (await page.request.get(`/api/matches/${id}`)).json();
  await expect(page.locator('.board-frame')).toHaveAttribute('data-fen', snapshot.position.positions[2]);
  expect(snapshot.position.history).toHaveLength(4);
});

test('Reset cancels a pending Next Move without stale positions or journal entries', async ({ page }) => {
  await openSettings(page, 'Белые');
  await page.getByLabel('Время ответа, мс · белые', { exact: true }).fill('2500');
  await apply(page);
  await button(page, 'Next Move').click();
  await expect(page.getByRole('status', { name: 'Состояние партии' })).toContainText('Ожидание ответа');
  await expect(button(page, 'Reset')).toBeEnabled();
  await button(page, 'Reset').click();
  await expect(page.getByTestId('ply-count')).toHaveText('0');
  await expect(button(page, 'Start')).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.waitForTimeout(2700);
  await expect(page.getByTestId('ply-count')).toHaveText('0');
  await showInfo(page, 'Журнал');
  await expect(page.getByRole('log')).not.toContainText('Запрос хода');
});

test('SSE reconnect restores missed journal entries from REST and does not poll', async ({ page, context, request }) => {
  const id = await matchId(page);
  await context.setOffline(true);
  await expect(page.getByTestId('connection')).toHaveText('Восстановление соединения', { timeout: 20000 });
  await request.post(`/api/matches/${id}/next-move`);
  await context.setOffline(false);
  await expect(page.getByTestId('connection')).toHaveText('SSE подключён', { timeout: 15000 });
  await expect(page.getByTestId('ply-count')).toHaveText('1');
  await showInfo(page, 'Журнал');
  await expect(page.getByRole('log').locator('article').filter({ hasText: 'Ход выполнен' })).toHaveCount(1);
  let restReads = 0;
  page.on('request', req => { if (req.method() === 'GET' && req.url().includes('/api/matches/') && !req.url().endsWith('/stream')) restReads++; });
  await page.waitForTimeout(1600);
  expect(restReads).toBe(0);
});

test('historical view stays fixed while the automatic match continues', async ({ page }) => {
  const initialFen = await page.locator('.board-frame').getAttribute('data-fen');
  await button(page, 'Start').click();
  await expect.poll(async () => Number(await page.getByTestId('ply-count').textContent())).toBeGreaterThanOrEqual(2);
  await button(page, 'Начало партии').click();
  const count = Number(await page.getByTestId('ply-count').textContent());
  await expect.poll(async () => Number(await page.getByTestId('ply-count').textContent())).toBeGreaterThan(count);
  await expect(page.locator('.board-frame')).toHaveAttribute('data-fen', initialFen!);
  await button(page, 'К текущей позиции').click();
  await expect(page.locator('.board-frame')).not.toHaveAttribute('data-fen', initialFen!);
  await button(page, 'Stop').click();
});

test('reload restores the match in the same browser tab', async ({ page }) => {
  await button(page, 'Next Move').click();
  await expect(page.getByTestId('ply-count')).toHaveText('1');
  const id = await matchId(page);
  const fen = await page.locator('.board-frame').getAttribute('data-fen');
  await page.reload();
  await expect(page.getByTestId('connection')).toHaveText('SSE подключён');
  expect(await matchId(page)).toBe(id);
  await expect(page.locator('.board-frame')).toHaveAttribute('data-fen', fen!);
  await showInfo(page, 'Журнал');
  await expect(page.getByRole('log').locator('article').filter({ hasText: 'Ход выполнен' })).toHaveCount(1);
});

for (const width of [320, 360, 768, 1440]) {
  test(`responsive layout at ${width}px has no overflow or browser errors`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height: 960 });
    await expect(page.locator('[data-square]')).toHaveCount(64);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const board = await page.locator('.board-column').boundingBox();
    const controls = await page.locator('.info-column').boundingBox();
    if (width < 761) expect(controls!.y).toBeGreaterThan(board!.y + board!.height - 1);
    else expect(controls!.x).toBeGreaterThan(board!.x + board!.width);
    expect(errors).toEqual([]);
    await page.screenshot({ path: `/artifacts/e2e/arena-${width}.png`, fullPage: true });
  });
}
