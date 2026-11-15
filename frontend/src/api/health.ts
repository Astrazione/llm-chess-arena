export interface HealthResponse {
  status: 'ok';
  service: 'backend';
}

export async function checkHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const timeout = AbortSignal.timeout(5_000);
  const response = await fetch('/api/health', {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Backend вернул HTTP ${response.status}`);
  const body: unknown = await response.json();
  if (
    typeof body !== 'object' || body === null ||
    !('status' in body) || body.status !== 'ok' ||
    !('service' in body) || body.service !== 'backend'
  ) {
    throw new Error('Неожиданный ответ backend');
  }
  return { status: body.status, service: body.service };
}
