import { Type, type Static } from '@sinclair/typebox';

const objectOptions = { additionalProperties: false } as const;
const enumeration = <const T extends readonly string[]>(values: T) =>
  Type.Enum(Object.fromEntries(values.map(value => [value, value])) as { [K in T[number]]: K });
export const ColorSchema = enumeration(['white', 'black']);
export type Color = Static<typeof ColorSchema>;
export const StatusSchema = enumeration(['Created', 'Running', 'Paused', 'Completed', 'Stopped']);
export type MatchStatus = Static<typeof StatusSchema>;
export const ErrorCodeSchema = enumeration(['InvalidFormat', 'IllegalMove', 'Timeout', 'ProviderError', 'EmptyResponse']);
export type MoveErrorCode = Static<typeof ErrorCodeSchema>;
export const DrawClaimSchema = enumeration(['ThreefoldRepetition', 'FiftyMoves']);
export type DrawClaim = Static<typeof DrawClaimSchema>;
const scoreSchema = enumeration(['1-0', '0-1', '1/2-1/2']);
export const ChessOutcomeSchema = Type.Object({
  kind: Type.Literal('Chess'),
  reason: enumeration(['Checkmate', 'Stalemate', 'InsufficientMaterial', 'FivefoldRepetition', 'SeventyFiveMoves']),
  score: scoreSchema,
  winner: Type.Union([ColorSchema, Type.Null()]),
}, objectOptions);
export type ChessOutcome = Static<typeof ChessOutcomeSchema>;
export const ResultSchema = Type.Union([
  ChessOutcomeSchema,
  Type.Object({ kind: Type.Literal('ClaimedDraw'), reason: DrawClaimSchema, score: Type.Literal('1/2-1/2'), winner: Type.Null() }, objectOptions),
  Type.Object({ kind: Type.Literal('TechnicalLoss'), reason: ErrorCodeSchema, score: enumeration(['1-0', '0-1']), winner: ColorSchema, loser: ColorSchema }, objectOptions),
  Type.Object({ kind: Type.Literal('Limit'), reason: Type.Literal('MaxPlies'), score: Type.Literal('*'), winner: Type.Null() }, objectOptions),
  Type.Object({ kind: Type.Literal('Stopped'), reason: enumeration(['UserStop', 'Reset', 'ServerShutdown', 'InternalError']), score: Type.Literal('*'), winner: Type.Null() }, objectOptions),
]);
export type MatchResult = Static<typeof ResultSchema>;
export const MoveSchema = Type.Object({
  ply: Type.Integer({ minimum: 1 }), color: ColorSchema,
  uci: Type.String(), san: Type.String(), before: Type.String(), after: Type.String(),
}, objectOptions);
export type MoveRecord = Static<typeof MoveSchema>;
export const PositionSchema = Type.Object({
  fen: Type.String(), ascii: Type.String(), turn: ColorSchema, inCheck: Type.Boolean(),
  legalMoves: Type.Array(Type.String()), history: Type.Array(MoveSchema), positions: Type.Array(Type.String()),
  halfmoveClock: Type.Integer(), repetitionCount: Type.Integer(),
  claimableDraws: Type.Array(DrawClaimSchema), outcome: Type.Union([ChessOutcomeSchema, Type.Null()]),
}, objectOptions);
export type PositionSnapshot = Static<typeof PositionSchema>;
export const ProviderPositionSchema = Type.Object({
  fen: Type.String(), ascii: Type.String(), color: ColorSchema,
  history: Type.Array(Type.String()), legalMoves: Type.Optional(Type.Array(Type.String())),
}, objectOptions);
export const MoveErrorSchema = Type.Object({ code: ErrorCodeSchema, message: Type.String() }, objectOptions);
export type MoveError = Static<typeof MoveErrorSchema>;
export const CompletionRequestSchema = Type.Object({
  systemPrompt: Type.String(), userPrompt: Type.String(), position: ProviderPositionSchema,
  feedback: Type.Optional(MoveErrorSchema),
}, objectOptions);
export type CompletionRequest = Static<typeof CompletionRequestSchema>;
export const MockSettingsSchema = Type.Object({
  provider: Type.Optional(Type.Literal('mock')),
  systemPrompt: Type.Optional(Type.String({ minLength: 1, maxLength: 16000 })),
  strategy: enumeration(['RandomLegalMove', 'ScriptedMoves', 'InvalidMove', 'MalformedResponse', 'DelayedResponse']),
  seed: Type.Optional(Type.Integer({ minimum: 0, maximum: 4294967295 })),
  moves: Type.Optional(Type.Array(Type.String({ maxLength: 128 }), { maxItems: 2000 })),
  invalidEvery: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  delayMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 60000 })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 30000 })),
}, objectOptions);
export type MockSettings = Static<typeof MockSettingsSchema>;
export const DiscoveryApiSchema = enumeration(['ollama', 'vllm', 'openai-compatible']);
export const ModelConnectionSchema = Type.Object({
  baseUrl: Type.String({ minLength: 1, maxLength: 2048 }),
  discoveryApi: DiscoveryApiSchema,
  credentialProfile: Type.Optional(Type.String({ pattern: '^[a-zA-Z0-9_-]{1,64}$' })),
}, objectOptions);
export type ModelConnection = Static<typeof ModelConnectionSchema>;
export const DiscoveredModelSchema = Type.Object({
  id: Type.String(), displayName: Type.String(), provider: DiscoveryApiSchema,
  status: enumeration(['available', 'loaded', 'cached']),
  parameterSize: Type.Optional(Type.String()), quantization: Type.Optional(Type.String()),
  sizeBytes: Type.Optional(Type.Integer({ minimum: 0 })),
}, objectOptions);
export type DiscoveredModel = Static<typeof DiscoveredModelSchema>;
export const ModelListSchema = Type.Object({
  schemaVersion: Type.Literal(1), models: Type.Array(DiscoveredModelSchema), warnings: Type.Array(Type.String()),
}, objectOptions);
export type ModelList = Static<typeof ModelListSchema>;
export const CompatibleSettingsSchema = Type.Object({
  provider: Type.Literal('openai-compatible'),
  providerName: Type.String({ minLength: 1, maxLength: 128 }),
  baseUrl: Type.String({ minLength: 1, maxLength: 2048 }),
  modelId: Type.String({ minLength: 1, maxLength: 256 }),
  discoveryApi: Type.Optional(DiscoveryApiSchema),
  credentialProfile: Type.Optional(Type.String({ pattern: '^[a-zA-Z0-9_-]{1,64}$' })),
  temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
  seed: Type.Optional(Type.Integer({ minimum: 0, maximum: 4294967295 })),
  runtime: Type.Optional(Type.String({ maxLength: 128 })),
  runtimeVersion: Type.Optional(Type.String({ maxLength: 128 })),
  modelRevision: Type.Optional(Type.String({ maxLength: 256 })),
  quantization: Type.Optional(Type.String({ maxLength: 128 })),
  maxContextTokens: Type.Optional(Type.Integer({ minimum: 1 })),
  maxOutputTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 131072 })),
  tokenLimitParameter: enumeration(['max_tokens', 'max_completion_tokens']),
  responseFormat: enumeration(['text', 'json_object']),
  timeoutMs: Type.Integer({ minimum: 1, maximum: 300000 }),
  systemPrompt: Type.Optional(Type.String({ minLength: 1, maxLength: 16000 })),
}, objectOptions);
export type CompatibleSettings = Static<typeof CompatibleSettingsSchema>;
export const PlayerSettingsSchema = Type.Union([MockSettingsSchema, CompatibleSettingsSchema]);
export type PlayerSettings = Static<typeof PlayerSettingsSchema>;
export const MatchConfigSchema = Type.Object({
  players: Type.Object({ white: PlayerSettingsSchema, black: PlayerSettingsSchema }, objectOptions),
  mode: enumeration(['A', 'B']), maxRetries: Type.Integer({ minimum: 0, maximum: 10 }),
  moveDelayMs: Type.Integer({ minimum: 0, maximum: 60000 }),
  maxPlies: Type.Integer({ minimum: 1, maximum: 2000 }),
  systemPrompt: Type.String({ minLength: 1, maxLength: 16000 }),
}, objectOptions);
export type MatchConfig = Static<typeof MatchConfigSchema>;
export const CreateMatchSchema = Type.Partial(MatchConfigSchema, objectOptions);
export type CreateMatchRequest = Static<typeof CreateMatchSchema>;
const diagnosticSchema = Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]));
export type ProviderDiagnostics = Static<typeof diagnosticSchema>;
const nullableNumber = Type.Union([Type.Number({ minimum: 0 }), Type.Null()]);
export const RequestMetricsSchema = Type.Object({
  responseTimeMs: nullableNumber, inputTokens: nullableNumber, outputTokens: nullableNumber,
  totalTokens: nullableNumber, generationTimeMs: nullableNumber, modelLoadTimeMs: nullableNumber,
}, objectOptions);
export type RequestMetrics = Static<typeof RequestMetricsSchema>;
export const ProbeResultSchema = Type.Object({
  available: Type.Boolean(), diagnostic: Type.String(),
  error: Type.Union([MoveErrorSchema, Type.Null()]), metrics: RequestMetricsSchema,
  diagnostics: Type.Optional(diagnosticSchema),
}, objectOptions);
export type ProbeResult = Static<typeof ProbeResultSchema>;
export const ProviderInfoSchema = Type.Object({
  defaultSystemPrompt: Type.String(),
  profiles: Type.Array(Type.Object({ id: Type.String(), baseUrl: Type.String() }, objectOptions)),
}, objectOptions);
export const ProviderCheckSchema = Type.Object({ color: ColorSchema, checkedAt: Type.String(), result: ProbeResultSchema,
  request: Type.Optional(CompletionRequestSchema), rawText: Type.Optional(Type.String()),
}, objectOptions);
export const AttemptSchema = Type.Object({
  id: Type.Integer(), gameId: Type.String(), color: ColorSchema, modelId: Type.String(), ply: Type.Integer(),
  attemptNumber: Type.Integer(), status: enumeration(['Pending', 'Accepted', 'Rejected', 'Cancelled']),
  startedAt: Type.String(), finishedAt: Type.Union([Type.String(), Type.Null()]),
  elapsedMs: Type.Union([Type.Number(), Type.Null()]), request: CompletionRequestSchema,
  rawText: Type.Union([Type.String(), Type.Null()]), move: Type.Union([Type.String(), Type.Null()]),
  error: Type.Union([MoveErrorSchema, Type.Null()]), diagnostics: Type.Optional(diagnosticSchema),
  metrics: Type.Optional(RequestMetricsSchema),
}, objectOptions);
export type Attempt = Static<typeof AttemptSchema>;
export const EventSchema = Type.Object({
  schemaVersion: Type.Literal(1), matchId: Type.String(), gameId: Type.String(), sequence: Type.Integer(),
  at: Type.String(), type: enumeration(['GameCreated', 'GameStarted', 'MoveRequested', 'MoveAccepted', 'MoveRejected', 'ProviderFailed', 'AttemptCancelled', 'GamePaused', 'GameResumed', 'GameCompleted', 'GameStopped', 'GameReset', 'OperationSettled', 'ProviderCheckRequested', 'ProviderChecked']),
  status: StatusSchema, ply: Type.Integer(), fen: Type.String(),
  data: Type.Object({
    attempt: Type.Optional(AttemptSchema), move: Type.Optional(MoveSchema), result: Type.Optional(ResultSchema),
    color: Type.Optional(ColorSchema), message: Type.Optional(Type.String()), previousGameId: Type.Optional(Type.String()),
  }, objectOptions),
}, { ...objectOptions, $id: 'GameEvent' });
export type GameEvent = Static<typeof EventSchema>;
export const PlayerStatisticsSchema = Type.Object({
  successfulMoves: Type.Integer(), illegalMoves: Type.Integer(), formatErrors: Type.Integer(), errors: Type.Integer(),
  retries: Type.Integer(), requests: Type.Integer(), completedAttempts: Type.Integer(),
  legalMoveRatio: nullableNumber, meanResponseMs: nullableNumber, medianResponseMs: nullableNumber,
  inputTokens: nullableNumber, outputTokens: nullableNumber,
  inputTokenSamples: Type.Integer(), outputTokenSamples: Type.Integer(), responseSamples: Type.Integer(),
}, objectOptions);
export const StatisticsSchema = Type.Object({
  players: Type.Object({ white: PlayerStatisticsSchema, black: PlayerStatisticsSchema }, objectOptions),
  plies: Type.Integer(), durationMs: nullableNumber, moveRequests: Type.Integer(), preflightRequests: Type.Integer(),
  totalRequests: Type.Integer(), resultCategory: enumeration(['Ongoing', 'ChessWin', 'Draw', 'TechnicalLoss', 'Stopped', 'Limit']),
}, objectOptions);
export type ExperimentStatistics = Static<typeof StatisticsSchema>;
export const SnapshotSchema = Type.Object({
  schemaVersion: Type.Literal(1), id: Type.String(), gameId: Type.String(), generation: Type.Integer(),
  status: StatusSchema, busy: Type.Boolean(), config: MatchConfigSchema,
  position: PositionSchema, attempts: Type.Array(AttemptSchema),
  providerChecks: Type.Array(ProviderCheckSchema),
  result: Type.Union([ResultSchema, Type.Null()]), pgn: Type.String(), lastEventSequence: Type.Integer(),
  statistics: Type.Optional(StatisticsSchema),
  storageError: Type.Optional(Type.String()),
  archived: Type.Optional(Type.Boolean()),
}, { ...objectOptions, $id: 'MatchSnapshot' });
export type MatchSnapshot = Static<typeof SnapshotSchema>;
export const StreamUpdateSchema = Type.Object({
  schemaVersion: Type.Literal(1), event: EventSchema, snapshot: SnapshotSchema,
}, objectOptions);
export type StreamUpdate = Static<typeof StreamUpdateSchema>;
export const ApiErrorSchema = Type.Object({ error: Type.Object({ code: Type.String(), message: Type.String() }, objectOptions) }, objectOptions);
export type ApiErrorResponse = Static<typeof ApiErrorSchema>;

export const ExperimentSchema = Type.Object({
  schema: Type.Literal('llm-chess-arena/experiment'), schemaVersion: Type.Literal(1),
  id: Type.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' }),
  matchId: Type.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' }),
  createdAt: Type.String(), updatedAt: Type.String(), recoveredAt: Type.Optional(Type.String()),
  snapshot: Type.Ref(SnapshotSchema), events: Type.Array(Type.Ref(EventSchema)), statistics: StatisticsSchema,
}, objectOptions);
export type Experiment = Static<typeof ExperimentSchema> & { snapshot: MatchSnapshot; events: GameEvent[] };
export const ExperimentSummarySchema = Type.Object({
  id: Type.String(), matchId: Type.String(), createdAt: Type.String(), updatedAt: Type.String(),
  status: StatusSchema, players: Type.Object({ white: Type.String(), black: Type.String() }, objectOptions),
  result: Type.Union([ResultSchema, Type.Null()]), statistics: StatisticsSchema,
}, objectOptions);
export const ExperimentListSchema = Type.Object({
  experiments: Type.Array(ExperimentSummarySchema), unreadableFiles: Type.Integer(), total: Type.Integer(),
}, objectOptions);
