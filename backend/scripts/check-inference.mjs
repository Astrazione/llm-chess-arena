// Run only via docker compose exec backend node scripts/check-inference.mjs.
// Uses local/external endpoints explicitly selected by the operator, no cloud defaults.
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
const baseUrl = process.env.INFERENCE_BASE_URL ?? 'http://vllm:8000/v1';
const modelId = process.env.INFERENCE_MODEL_ID;
if (!modelId) throw new Error('Set INFERENCE_MODEL_ID to the exact ID returned by /models');
const settings = {
  provider: 'openai-compatible', providerName: 'Inference smoke check', baseUrl, modelId,
  timeoutMs: 120000, maxOutputTokens: 128, temperature: 0,
  tokenLimitParameter: 'max_tokens', responseFormat: 'text',
  ...(process.env.INFERENCE_CREDENTIAL_PROFILE ? { credentialProfile: process.env.INFERENCE_CREDENTIAL_PROFILE } : {}),
  ...(process.env.INFERENCE_SEED ? { seed: Number(process.env.INFERENCE_SEED) } : {}),
  ...(process.env.INFERENCE_RUNTIME ? { runtime: process.env.INFERENCE_RUNTIME } : {}),
  ...(process.env.INFERENCE_RUNTIME_VERSION ? { runtimeVersion: process.env.INFERENCE_RUNTIME_VERSION } : {}),
  ...(process.env.INFERENCE_QUANTIZATION ? { quantization: process.env.INFERENCE_QUANTIZATION } : {}),
  ...(process.env.INFERENCE_MODEL_REVISION ? { modelRevision: process.env.INFERENCE_MODEL_REVISION } : {}),
};
async function post(path, body) {
  const response = await fetch(`http://127.0.0.1:3000/api${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(125000),
  });
  if (!response.ok) throw new Error(`Arena API HTTP ${response.status}`);
  return response.json();
}
const probe = await post('/providers/probe', settings);
console.log(JSON.stringify({ phase: 'probe', ...probe }));
if (!probe.available) process.exit(1);
let match = await post('/matches', { players: { white: settings, black: settings }, mode: 'B', maxPlies: 4, maxRetries: 2 });
try {
  for (let ply = 1; ply <= 4; ply++) {
    match = await post(`/matches/${match.id}/next-move`);
    console.log(JSON.stringify({ phase: 'move', ply, accepted: match.position.history.at(-1)?.uci,
      status: match.status, errors: match.attempts.filter(attempt => attempt.error).map(attempt => attempt.error),
      metrics: match.attempts.at(-1)?.metrics }));
    if (match.position.history.length !== ply) throw new Error('Model did not produce a legal move; inspect the Arena event log');
  }
  const savedResponse = await fetch(`http://127.0.0.1:3000/api/experiments/${match.gameId}/export.json`);
  assert(savedResponse.ok); const saved = await savedResponse.json();
  assert.deepEqual(saved.snapshot.position.history, match.position.history);
  const pgnResponse = await fetch(`http://127.0.0.1:3000/api/experiments/${match.gameId}/export.pgn`);
  assert(pgnResponse.ok); const replay = new Chess(); replay.loadPgn(await pgnResponse.text());
  assert.equal(replay.fen(), match.position.fen);
  console.log(JSON.stringify({ phase: 'complete', matchId: match.id, gameId: match.gameId, plies: match.position.history.length, result: match.result, statistics: saved.statistics, pgnRoundTrip: true }));
} finally {
  if (!match.result) await post(`/matches/${match.id}/stop`);
}
