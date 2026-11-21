import type { Command, CompatibleSettings, DiscoveryApi, Experiment, ExperimentSummary, GameEvent, MatchConfig, MatchSnapshot, ModelList, PlayerSettings, ProbeResult, ProviderInfo } from './contracts';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
async function request<T>(path: string, init: RequestInit = {}, root = '/api/matches'): Promise<T> {
  const response = await fetch(`${root}${path}`, { ...init, signal: init.signal ?? AbortSignal.timeout(65000), cache: 'no-store' });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new ApiError(response.status, body?.error?.message ?? `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}
export const createMatch = (config: Partial<MatchConfig>, signal?: AbortSignal) => request<MatchSnapshot>('', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config), ...(signal ? { signal } : {}),
});
export const getMatch = (id: string, signal?: AbortSignal) => request<MatchSnapshot>(`/${id}`, signal ? { signal } : {});
export const listExperiments = (offset: number, signal: AbortSignal) => request<{ experiments: ExperimentSummary[]; total: number; unreadableFiles: number }>(`?offset=${offset}&limit=25`, { signal }, '/api/experiments');
export const getExperiment = (id: string, signal: AbortSignal) => request<Experiment>(`/${id}`, { signal }, '/api/experiments');
export const previewHistoryCleanup = (signal: AbortSignal) => request<{ schemaVersion: 1; gameIds: string[] }>('/cleanup', { signal }, '/api/experiments');
export const clearHistory = (gameIds: string[], signal: AbortSignal) => request<{ schemaVersion: 1; deleted: number; skipped: number; failed: number }>('', {
  method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gameIds }), signal,
}, '/api/experiments');
export const commandMatch = (id: string, command: Command, timeoutMs = 65000) => request<MatchSnapshot>(`/${id}/${command}`, { method: 'POST', signal: AbortSignal.timeout(timeoutMs) });
export const getProviderInfo = (signal: AbortSignal) => request<ProviderInfo>('', { signal }, '/api/providers');
export const discoverModels = (connection: Pick<CompatibleSettings, 'baseUrl' | 'credentialProfile'> & { discoveryApi: DiscoveryApi }, signal: AbortSignal) => request<ModelList>('/models', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(connection), signal,
}, '/api/providers');
export const probeProvider = (settings: PlayerSettings, signal: AbortSignal) => request<ProbeResult>('/probe', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings), signal,
}, '/api/providers');
export const getEvents = (id: string, after: number, signal: AbortSignal) => request<{
  events: GameEvent[]; hasMore: boolean; lastSequence: number;
}>(`/${id}/events?after=${after}&limit=500`, { signal });
