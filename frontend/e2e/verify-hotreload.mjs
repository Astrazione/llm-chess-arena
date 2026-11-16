// Start this script, then touch frontend/src/App.tsx and backend/src/config.ts in Compose.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
const root = process.env.E2E_BASE_URL ?? 'http://frontend:5173';
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  let updated = false;
  let navigations = 0;
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
  page.on('websocket', socket => socket.on('framereceived', frame => {
    if (typeof frame.payload === 'string' && frame.payload.includes('"type":"update"') && frame.payload.includes('/src/App.tsx')) updated = true;
  }));
  await page.goto(root);
  await expect(page.getByTestId('connection')).toHaveText('SSE подключён');
  await page.getByRole('button', { name: 'Next Move', exact: true }).click();
  await expect(page.getByTestId('ply-count')).toHaveText('1');
  const id = await page.evaluate(() => sessionStorage.getItem('arena-match'));
  const fen = await page.locator('.board-frame').getAttribute('data-fen');
  const before = navigations;
  console.log('Ready for frontend and backend touch');
  await expect.poll(() => updated, { timeout: 45000 }).toBe(true);
  assert.equal(navigations, before, 'HMR navigated the page');
  await expect(page.getByRole('heading', { name: 'Сохранённая партия' })).toBeVisible({ timeout: 45000 });
  await expect(page.getByTestId('connection')).toHaveText('SSE подключён');
  await expect(page.locator('.board-frame')).toHaveAttribute('data-fen', fen);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('arena-match')), id);
  console.log(JSON.stringify({ frontendHmr: true, noNavigation: true, backendRestart: true, sameMatchId: id, fenPreserved: true, sseRestored: true }));
} finally { await browser.close(); }
