// Run only inside Compose. The orchestrating shell recreates/kills containers between phases.
import assert from 'node:assert/strict';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { Chess } from 'chess.js';
const marker = join(process.env.DATA_DIR, '.persistence-check.json');
const phase = process.argv[2];
const root = 'http://frontend:5173/api';
async function api(path, body) {
  const response = await fetch(`${root}${path}`, { ...(body !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  assert(response.ok, `${path}: HTTP ${response.status}`);
  return response.headers.get('content-type')?.includes('json') ? response.json() : response.text();
}
if (phase === 'prepare') {
  const completed = await api('/matches', { players: { white: { strategy: 'ScriptedMoves', moves: ['f2f3', 'g2g4'] }, black: { strategy: 'ScriptedMoves', moves: ['e7e5', 'd8h4'] } } });
  for (let i = 0; i < 4; i++) await api(`/matches/${completed.id}/next-move`, {});
  const pgn = await api(`/experiments/${completed.gameId}/export.pgn`);
  const active = await api('/matches', { players: { white: { strategy: 'DelayedResponse', delayMs: 60000, timeoutMs: 30000 }, black: { strategy: 'RandomLegalMove' } } });
  await api(`/matches/${active.id}/start`, {});
  for (let i = 0; i < 100; i++) {
    const saved = await api(`/experiments/${active.gameId}`);
    if (saved.snapshot.attempts.some(attempt => attempt.status === 'Pending')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
    assert(i < 99, 'No persisted pending attempt');
  }
  await writeFile(`${marker}.tmp`, JSON.stringify({ completed, pgn, active })); await rename(`${marker}.tmp`, marker);
  console.log(JSON.stringify({ phase, completed: completed.gameId, active: active.gameId }));
} else if (phase === 'verify') {
  const { completed, pgn, active } = JSON.parse(await readFile(marker, 'utf8'));
  const saved = await api(`/experiments/${completed.gameId}/export.json`);
  assert.equal(saved.statistics.resultCategory, 'ChessWin');
  assert.equal(saved.statistics.plies, 4);
  const exported = await api(`/experiments/${completed.gameId}/export.pgn`);
  assert.equal(exported, pgn);
  const replay = new Chess(); replay.loadPgn(exported);
  assert.equal(replay.fen(), saved.snapshot.position.fen);
  const stopped = await api(`/experiments/${active.gameId}`);
  assert.equal(stopped.snapshot.result.reason, 'ServerShutdown');
  assert.equal(stopped.snapshot.attempts[0].status, 'Cancelled');
  assert.equal(stopped.snapshot.busy, false);
  assert.equal((await api(`/matches/${active.id}`)).archived, true);
  if (process.argv.includes('--crash')) assert(stopped.recoveredAt, 'Expected recovery after SIGKILL');
  const fresh = await api(`/experiments/${completed.gameId}/replay`, {});
  assert.notEqual(fresh.gameId, completed.gameId); assert.deepEqual(fresh.config, completed.config);
  console.log(JSON.stringify({ phase, pgnRoundTrip: true, completedSurvived: true, pendingCancelled: true, recoveredAfterCrash: Boolean(stopped.recoveredAt), freshGameId: fresh.gameId }));
} else throw new Error('Use prepare or verify [--crash]');
