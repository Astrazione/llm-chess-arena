import type { MoveErrorCode } from '../contracts/match.js';
import { UCI_PATTERN } from '../domain/chess/engine.js';

export class MoveResponseError extends Error {
  constructor(readonly code: MoveErrorCode, message: string) { super(message); }
}

export function parseMoveResponse(rawText: string): string {
  if (!rawText.trim()) throw new MoveResponseError('EmptyResponse', 'Provider returned an empty response');
  let value: unknown;
  try { value = JSON.parse(rawText); }
  catch { throw new MoveResponseError('InvalidFormat', 'Expected a JSON object with one UCI move'); }
  if (
    typeof value !== 'object' || value === null || Array.isArray(value) ||
    Object.keys(value).length !== 1 || !('move' in value) || typeof value.move !== 'string' ||
    !UCI_PATTERN.test(value.move)
  ) throw new MoveResponseError('InvalidFormat', 'Expected exactly {"move":"e2e4"} with a UCI move');
  return value.move;
}
