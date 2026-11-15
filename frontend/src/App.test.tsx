import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';

describe('connection check', () => {
  it('checks the same-origin API and displays a successful connection', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'ok', service: 'backend' })));
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    expect(await screen.findByText('Backend подключён')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/health', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('shows server errors and allows another connection attempt', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok', service: 'backend' })));
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 503');
    fireEvent.click(screen.getByRole('button', { name: 'Проверить снова' }));
    expect(await screen.findByText('Backend подключён')).toBeInTheDocument();
  });

  it('does not treat arbitrary JSON as a healthy backend', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')));
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Неожиданный ответ backend');
  });

  it('shows network errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Failed to fetch')));
    render(<App />);
    expect(await screen.findByText('Backend недоступен')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to fetch');
  });
});
