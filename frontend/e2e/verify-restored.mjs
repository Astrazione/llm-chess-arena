// Invoke after check-persistence.mjs prepare + container restart/recreate + verify.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
const root = process.env.E2E_BASE_URL ?? 'http://frontend:5173';
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const list = await (await page.request.get(`${root}/api/experiments?limit=100`)).json();
  const summary = list.experiments.find(record => record.result?.reason === 'ServerShutdown' && record.statistics.moveRequests > 0);
  assert(summary, 'No stopped persistence fixture found');
  const record = await (await page.request.get(`${root}/api/experiments/${summary.id}`)).json();
  await page.goto(root);
  await page.evaluate(id => sessionStorage.setItem('arena-match', id), record.matchId);
  await page.reload();
  await expect(page.getByTestId('connection')).toHaveText('SSE подключён');
  await expect(page.getByRole('heading', { name: 'Сохранённая партия' })).toBeVisible();
  await expect(page.locator('.board-frame')).toHaveAttribute('data-fen', record.snapshot.position.fen);
  await page.getByRole('tab', { name: 'Журнал', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('Матч остановлен');
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0);
  const before = await (await page.request.get(`${root}/api/matches/${record.matchId}/events?limit=500`)).json();
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByTestId('connection')).toHaveText('SSE подключён');
  await expect(page.getByRole('log')).toContainText('Матч остановлен');
  const after = await (await page.request.get(`${root}/api/matches/${record.matchId}/events?limit=500`)).json();
  assert.equal(after.lastSequence, before.lastSequence);
  await page.screenshot({ path: '/artifacts/e2e/restored-experiment.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ restoredMatch: record.matchId, board: true, archived: true, sseReconnect: true, browserErrors: errors.length }));
} finally { await browser.close(); }
