import { MoveResponseError } from '../application/move-response.js';

// The race settles on cancellation even if an adapter ignores AbortSignal.
export function withDeadline<T>(parent: AbortSignal, timeoutMs: number, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  parent.throwIfAborted();
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      parent.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => {
      controller.abort(parent.reason);
      finish(() => reject(parent.reason));
    };
    const timer = setTimeout(() => {
      const error = new MoveResponseError('Timeout', 'Provider request timed out');
      controller.abort(error);
      finish(() => reject(error));
    }, timeoutMs);
    parent.addEventListener('abort', onAbort, { once: true });
    void Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return call(controller.signal);
    }).then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}
