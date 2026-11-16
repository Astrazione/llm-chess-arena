// These are address templates, not runtime-specific Provider implementations.
export const connectionPresets = {
  nvidia: { name: 'Локальный NVIDIA vLLM', baseUrl: 'http://vllm:8000/v1', discoveryApi: 'vllm' },
  external: { name: 'Внешний vLLM endpoint', baseUrl: '', discoveryApi: 'vllm' },
  metal: { name: 'vLLM-Metal на macOS', baseUrl: 'http://host.docker.internal:8000/v1', discoveryApi: 'vllm' },
  dmr: { name: 'Docker Model Runner', baseUrl: 'http://model-runner.docker.internal/engines/v1', discoveryApi: 'openai-compatible' },
  ollama: { name: 'Ollama', baseUrl: 'http://host.docker.internal:11434/v1', discoveryApi: 'ollama' },
  cloud: { name: 'Облачный API', baseUrl: '', discoveryApi: 'openai-compatible' },
} as const;
