// Public DTOs, schemaVersion 1. Canonical runtime schemas: backend/src/contracts/match.ts.
export type Color = 'white' | 'black';
export type MatchStatus = 'Created' | 'Running' | 'Paused' | 'Completed' | 'Stopped';
export type Strategy = 'RandomLegalMove' | 'ScriptedMoves' | 'InvalidMove' | 'MalformedResponse' | 'DelayedResponse';
export interface MockSettings {
  provider?: 'mock'; systemPrompt?: string;
  strategy: Strategy; seed?: number; moves?: string[]; invalidEvery?: number; delayMs?: number; timeoutMs?: number;
}
export interface CompatibleSettings {
  provider: 'openai-compatible'; providerName: string; baseUrl: string; modelId: string;
  credentialProfile?: string; temperature?: number; maxOutputTokens?: number;
  tokenLimitParameter: 'max_tokens' | 'max_completion_tokens'; responseFormat: 'text' | 'json_object';
  timeoutMs: number; systemPrompt?: string;
}
export type PlayerSettings = MockSettings | CompatibleSettings;
export interface RequestMetrics {
  responseTimeMs: number | null; inputTokens: number | null; outputTokens: number | null; totalTokens: number | null;
  generationTimeMs: number | null; modelLoadTimeMs: number | null;
}
export interface ProbeResult { available: boolean; diagnostic: string; error: Attempt['error']; metrics: RequestMetrics }
export interface ProviderInfo { defaultSystemPrompt: string; profiles: { id: string; baseUrl: string }[] }
export interface MatchConfig {
  players: Record<Color, PlayerSettings>; mode: 'A' | 'B'; maxRetries: number; maxPlies: number;
  moveDelayMs: number; systemPrompt: string;
}
export interface MoveRecord { ply: number; color: Color; uci: string; san: string; before: string; after: string }
export interface Attempt {
  id: number; gameId: string; color: Color; modelId: string; ply: number; attemptNumber: number;
  status: 'Pending' | 'Accepted' | 'Rejected' | 'Cancelled'; startedAt: string; finishedAt: string | null;
  elapsedMs: number | null; rawText: string | null; move: string | null;
  error: { code: 'InvalidFormat' | 'IllegalMove' | 'Timeout' | 'ProviderError' | 'EmptyResponse'; message: string } | null;
  diagnostics?: Record<string, string | number | boolean | null>;
  metrics?: RequestMetrics;
}
export interface MatchResult {
  kind: 'Chess' | 'ClaimedDraw' | 'TechnicalLoss' | 'Limit' | 'Stopped'; reason: string;
  score: string; winner: Color | null;
}
export interface MatchSnapshot {
  schemaVersion: 1; id: string; gameId: string; generation: number; status: MatchStatus; busy: boolean;
  config: MatchConfig; position: {
    fen: string; turn: Color; inCheck: boolean; history: MoveRecord[]; positions: string[];
    claimableDraws: string[];
  };
  attempts: Attempt[]; result: MatchResult | null; pgn: string; lastEventSequence: number;
  providerChecks?: { color: Color; checkedAt: string; result: ProbeResult }[];
}
export interface GameEvent {
  schemaVersion: 1; matchId: string; gameId: string; sequence: number; at: string;
  type: 'GameCreated' | 'GameStarted' | 'MoveRequested' | 'MoveAccepted' | 'MoveRejected' | 'ProviderFailed' |
    'AttemptCancelled' | 'GamePaused' | 'GameResumed' | 'GameCompleted' | 'GameStopped' | 'GameReset' | 'OperationSettled';
  status: MatchStatus; ply: number; fen: string;
  data: { attempt?: Attempt; move?: MoveRecord; result?: MatchResult; color?: Color; message?: string; previousGameId?: string };
}
export interface StreamUpdate { schemaVersion: 1; event: GameEvent; snapshot: MatchSnapshot }
export type Command = 'start' | 'pause' | 'resume' | 'next-move' | 'stop' | 'reset';
