// Run only in Compose: docker compose exec backend node scripts/play-mock-match.mjs
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Chess, DEFAULT_POSITION } from 'chess.js';

const baseUrl = process.env.API_BASE_URL ?? 'http://127.0.0.1:3000';
const random = process.argv.includes('--random');
const errors = process.argv.includes('--errors');
if (random && errors) throw new Error('Select only one scenario');
async function api(path, body) {
  const response = await fetch(`${baseUrl}/api${path}`, {
    ...(body !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(5000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`);
  return data;
}
const config = errors ? {
  maxRetries: 1,
  players: { white: { strategy: 'InvalidMove', invalidEvery: 1 }, black: { strategy: 'RandomLegalMove' } },
} : random ? {
  maxPlies: 2000,
  players: { white: { strategy: 'RandomLegalMove', seed: 42 }, black: { strategy: 'RandomLegalMove', seed: 99 } },
} : {
  players: {
    white: { strategy: 'ScriptedMoves', moves: ['f2f3', 'g2g4'] },
    black: { strategy: 'ScriptedMoves', moves: ['e7e5', 'd8h4'] },
  },
};
let id;
try {
  let match = await api('/matches', config);
  id = match.id;
  await api(`/matches/${id}/start`, {});
  const deadline = Date.now() + 60000;
  do {
    await delay(50);
    match = await api(`/matches/${id}`);
    if (Date.now() > deadline) throw new Error('Match did not finish within 60 seconds');
  } while (match.status === 'Running' || match.busy);
  assert.equal(match.status, 'Completed');
  if (errors) {
    assert.equal(match.result.kind, 'TechnicalLoss');
    assert.equal(match.result.reason, 'IllegalMove');
    assert.equal(match.position.fen, DEFAULT_POSITION);
    assert.equal(match.attempts.length, 2);
    assert.equal(match.position.history.length, 0);
  } else {
    assert.equal(match.result.kind, 'Chess');
    assert(match.attempts.every(attempt => attempt.status === 'Accepted'));
    const replay = new Chess();
    replay.loadPgn(match.pgn);
    assert.equal(replay.fen(), match.position.fen);
    assert.equal(replay.getHeaders().Result, match.result.score);
    if (!random) {
      assert.equal(match.result.reason, 'Checkmate');
      assert.equal(match.result.winner, 'black');
      assert.equal(match.position.history.length, 4);
    }
  }
  console.log(JSON.stringify({
    scenario: errors ? 'illegal-moves' : random ? 'seeded-random' : 'scripted-checkmate',
    matchId: id, status: match.status, result: match.result,
    plies: match.position.history.length, attempts: match.attempts.length,
    events: match.lastEventSequence, pgn: match.pgn,
  }, null, 2));
} catch (error) {
  if (id) await api(`/matches/${id}/stop`, {}).catch(() => {});
  console.error(error);
  process.exitCode = 1;
}
