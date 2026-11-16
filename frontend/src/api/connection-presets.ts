// These are address templates, not runtime-specific Provider implementations.
export const connectionPresets = {
  nvidia: { name: 'Локальный NVIDIA vLLM', baseUrl: 'http://vllm:8000/v1' },
  external: { name: 'Внешний vLLM endpoint', baseUrl: '' },
  metal: { name: 'vLLM-Metal на macOS', baseUrl: 'http://host.docker.internal:8000/v1' },
  dmr: { name: 'Docker Model Runner', baseUrl: 'http://model-runner.docker.internal/engines/v1' },
  ollama: { name: 'Ollama', baseUrl: 'http://host.docker.internal:11434/v1' },
  cloud: { name: 'Облачный API', baseUrl: '' },
} as const;
