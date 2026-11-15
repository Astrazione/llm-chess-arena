import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('configuration', () => {
  it('binds to all container interfaces by default', () => {
    expect(loadConfig({})).toMatchObject({ host: '0.0.0.0', port: 3000 });
  });
  it.each(['0', '65536', 'NaN', '1.2', ''])('rejects invalid PORT=%s', (port) => {
    expect(() => loadConfig({ PORT: port })).toThrow('PORT');
  });
  it('rejects empty storage paths and unknown log levels', () => {
    expect(() => loadConfig({ DATA_DIR: ' ' })).toThrow('DATA_DIR');
    expect(() => loadConfig({ LOG_LEVEL: 'invalid' })).toThrow('LOG_LEVEL');
  });
});
