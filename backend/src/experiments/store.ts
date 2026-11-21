import type { Static } from '@sinclair/typebox';
import type { Experiment, ExperimentListSchema } from '../contracts/match.js';

export class StorageError extends Error {
  constructor(readonly code: 'StorageUnavailable' | 'CorruptExperiment' | 'ExperimentNotFound', readonly statusCode: number) { super(code); }
}
export interface ExperimentStore {
  save(record: Experiment): Promise<void>;
  get(id: string): Promise<Experiment>;
  list(offset?: number, limit?: number): Promise<Static<typeof ExperimentListSchema>>;
  latest(matchId: string): Promise<Experiment>;
  recover(): Promise<void>;
  cleanupCandidates(protectedIds: ReadonlySet<string>): Promise<string[]>;
  removeCompleted(ids: readonly string[], protectedIds: ReadonlySet<string>): Promise<{ deleted: number; skipped: number; failed: number }>;
}
