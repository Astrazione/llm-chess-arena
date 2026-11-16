import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelPicker } from './ModelPicker';
import type { CompatibleSettings, ModelList } from '../api/contracts';

const settings: CompatibleSettings = { provider: 'openai-compatible', providerName: 'test', discoveryApi: 'vllm', baseUrl: 'http://test/v1', modelId: 'previous', timeoutMs: 1000, responseFormat: 'text', tokenLimitParameter: 'max_tokens' };
const list: ModelList = { schemaVersion: 1, models: [{ id: 'new/exact:7b', displayName: 'New', provider: 'vllm', status: 'available' }], warnings: [] };
function Picker({ side = 'белые', initial = settings }: { side?: string; initial?: CompatibleSettings }) {
  const [value, setValue] = useState(initial);
  return <><ModelPicker settings={value} side={side} disabled={false} onChange={patch => setValue(current => ({ ...current, ...patch }))} /><output aria-label={`ID · ${side}`}>{value.modelId}</output></>;
}
afterEach(() => { vi.unstubAllGlobals(); });

describe('model selection', () => {
  it('loads automatically, selects exact IDs and preserves the choice through refresh and manual/list switches', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(list))));
    vi.stubGlobal('fetch', fetchMock);
    render(<Picker />);
    expect(screen.getByRole('status', { name: 'Список моделей · белые' })).toHaveTextContent('Загрузка моделей');
    await screen.findByRole('option', { name: /New/ });
    expect(screen.getByLabelText('Модель · белые')).toHaveValue('previous');
    fireEvent.change(screen.getByLabelText('Модель · белые'), { target: { value: 'new/exact:7b' } });
    expect(screen.getByLabelText('ID · белые')).toHaveTextContent('new/exact:7b');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh · белые' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await screen.findByRole('option', { name: /New/ });
    expect(screen.getByLabelText('Модель · белые')).toHaveValue('new/exact:7b');
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('textbox')).toHaveValue('new/exact:7b');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'manual:exact' } });
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('combobox', { name: 'Модель · белые' })).toHaveValue('manual:exact');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('keeps independent selections for both players', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(list)))));
    render(<><Picker /><Picker side="чёрные" initial={{ ...settings, modelId: 'black' }} /></>);
    await screen.findAllByRole('option', { name: /New/ });
    fireEvent.change(screen.getByLabelText('Модель · белые'), { target: { value: 'new/exact:7b' } });
    expect(screen.getByLabelText('Модель · чёрные')).toHaveValue('black');
  });
  it.each([['empty', { ...list, models: [] }, 'Модели не найдены'], ['error', null, 'Connection failed']] as const)('handles %s without clearing saved ID', async (_name, result, message) => {
    vi.stubGlobal('fetch', vi.fn(() => result ? Promise.resolve(new Response(JSON.stringify(result))) : Promise.reject(new Error('Connection failed'))));
    render(<Picker />);
    await waitFor(() => expect(screen.getByRole('status', { name: 'Список моделей · белые' })).toHaveTextContent(message));
    expect(screen.getByLabelText('Модель · белые')).toHaveValue('previous');
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('textbox')).toHaveValue('previous');
  });
  it('ignores delayed responses from an old connection', async () => {
    let finishOld!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => { finishOld = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    const changed = vi.fn();
    const view = render(<ModelPicker settings={settings} side="белые" disabled={false} onChange={changed} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify(list))));
    view.rerender(<ModelPicker settings={{ ...settings, baseUrl: 'http://new/v1' }} side="белые" disabled={false} onChange={changed} />);
    await screen.findByRole('option', { name: /New/ });
    await act(async () => { finishOld(new Response(JSON.stringify({ ...list, models: [{ ...list.models[0], id: 'stale', displayName: 'Stale' }] }))); });
    expect(screen.queryByRole('option', { name: /Stale/ })).not.toBeInTheDocument();
    expect(changed).not.toHaveBeenCalled();
  });
});
