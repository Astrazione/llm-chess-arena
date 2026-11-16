# Локальный GPU-inference: этап 4B

Инструкции сверены с официальными источниками 16 ноября 2026 года. Результаты фактического запуска отдельно указаны в [отчёте](verification-stage-4b.md). Приведённая модель — начальная конфигурация, а не обещание качества шахматной игры или размещения при любой загрузке памяти.

## Устройство и адреса

`compose.yaml` описывает разработку приложения и включает `compose.inference.yaml`. В нём только необязательный сервис `vllm` с профилем `nvidia` и постоянный кеш Hugging Face. Backend не имеет depends_on для inference и запускается при выключенном/сломавшемся GPU-сервере. Оркестратор продолжает обращаться к порту LlmProvider; все перечисленные runtimes используют один HTTP-адаптер. Браузер обращается только к `/api/*` через Vite.

Нужен Docker Compose с поддержкой `include` (2.20.0+). Обычный запуск на всех платформах:

```sh
docker compose up --build
```

| Подключение | Base URL в настройках игрока (адрес для backend) | Model ID |
| --- | --- | --- |
| NVIDIA профиль этого проекта | `http://vllm:8000/v1` | `VLLM_MODEL_ID`, по умолчанию `Qwen/Qwen2.5-7B-Instruct-AWQ` |
| Внешний vLLM | `http://server:8000/v1` или URL владельца | Из `/v1/models` |
| Нативный vLLM-Metal на Mac | `http://host.docker.internal:8000/v1` | Из `/v1/models` |
| Docker Model Runner, Desktop | `http://model-runner.docker.internal/engines/v1` | Полное имя и tag из списка моделей |
| Ollama на хосте | `http://host.docker.internal:11434/v1` | Имя из `ollama list` или `/v1/models` |
| Облачный API | URL поставщика, например `https://api.openai.com/v1` | По документации поставщика |

В UI выберите OpenAI-compatible API и шаблон подключения независимо для белых и чёрных. Шаблон заполняет адрес/название, Model ID остаётся редактируемым. Для внешнего/облачного API введите собственный адрес. Base URL должен включать `/v1` (у DMR `/engines/v1`), без `/chat/completions`: адаптер добавляет этот путь. DMR Desktop использует специальный DNS без порта 12434; хостовый TCP API — `http://localhost:12434/engines/v1` после включения TCP. Это разные адреса. [DMR API](https://docs.docker.com/ai/model-runner/api-reference/), [Ollama](https://docs.ollama.com/api/openai-compatibility).

Нажмите «Проверить модель», затем «Применить настройки». Preflight отправляет настоящий completion с выбранными параметрами; перед первым ходом проверяются оба игрока. Для начальной проверки: режим B, temperature 0, max_tokens 128, text, тайм-аут 120000 мс, 4 полухода. JSON mode включайте после проверки поддержки конкретным сервером. Ошибочные ходы остаются ошибками эксперимента.

## NVIDIA: версия, модель и память

Используется официальный `vllm/vllm-openai:v0.32.0`. В [release notes](https://github.com/vllm-project/vllm/releases/tag/v0.32.0) указан CUDA 13.0 для этого тега; существование amd64 manifest проверено Docker CLI. CUDA/PyTorch вручную поверх образа не устанавливаются. Смена `VLLM_IMAGE` требует повторной проверки; `latest` не используется.

RTX 5070 Ti относится к Blackwell SM 12.0. Общая таблица quantization vLLM не имеет отдельной колонки Blackwell, поэтому её недостаточно как доказательства. В [CMake выбранного релиза](https://github.com/vllm-project/vllm/blob/v0.32.0/CMakeLists.txt) присутствуют target 12.0 и Marlin 12.0f для CUDA 13; [Marlin](https://github.com/vllm-project/vllm/blob/v0.32.0/vllm/model_executor/layers/quantization/utils/marlin_utils.py) поддерживает AWQ uint4 с zero points и group size 128. Это соответствует [config Qwen2.5-7B-Instruct-AWQ](https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-AWQ/blob/main/config.json). Формат берётся из quantization_config модели, специальные legacy-флаги awq_marlin не навязываются. Поддержка в исходниках отдельно от успешного запуска собранных kernels; итог GPU-проверки см. в отчёте.

Начальные настройки для 16 GB:

| Переменная `.env` | Значение | Причина |
| --- | --- | --- |
| VLLM_MODEL_ID | Qwen/Qwen2.5-7B-Instruct-AWQ | Instruct, AWQ 4-bit, 7B-класс |
| VLLM_MODEL_REVISION | main | Можно заменить SHA коммита HF для воспроизводимости |
| VLLM_MAX_MODEL_LEN | 4096 | Вход и выход вместе; история партии постепенно растёт |
| VLLM_GPU_MEMORY_UTILIZATION | 0.80 | Бюджет одного процесса, оставляет запас для рабочего стола |
| VLLM_MAX_NUM_SEQS | 1 | Минимальная конкурентность и давление на KV cache |
| VLLM_PORT | 8000 | Только host-порт; Docker-адрес остаётся vllm:8000 |

Всегда включён `--enforce-eager`: он уменьшает затраты на CUDA graphs/компиляцию ценой производительности. Это начальный выбор ради памяти, не обязательный обход ошибки RTX 5070 Ti. Privileged, host IPC, trust-remote-code и принудительные kernels не нужны; выделяется один GPU стандартной [reservation Compose](https://docs.docker.com/compose/how-tos/gpu-support/) и 2 GB shared memory контейнера. [Docker vLLM](https://docs.vllm.ai/en/stable/deployment/docker/), [serve options](https://docs.vllm.ai/en/stable/cli/serve/).

[Файлы AWQ-модели](https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-AWQ/tree/main) занимают около 5.58 GB: кроме 4-битной основной части есть scales/zero points и неквантованные слои. Это размер файлов, не измеренная VRAM. При FP16/BF16 KV и параметрах модели теоретический KV для одной последовательности 4096 составляет около 224 MiB (2 × 28 слоёв × 4 KV heads × 128 × 2 bytes × 4096); фактический allocator vLLM может резервировать больше под заданный бюджет. Дополнительно нужны activations, buffers, kernels, CUDA context и память экрана/других процессов. Поэтому «8B помещается» без формата и контекста неверно. Полноточные 8B уже требуют около 16 GB одних весов. UI оценок VRAM не показывает.

Если OOM возникает до готовности API, UI видит недоступный endpoint, точная причина остаётся в `docker compose logs vllm`. Если HTTP API вернул структурированную ошибку памяти, Provider передаёт безопасный `resourceError: OutOfMemory`. Уменьшайте контекст/конкурентность, используйте меньшие квантованные веса и освобождайте память. Снижение utilization освобождает бюджет для других процессов, но может оставить слишком мало KV; оно не уменьшает размер весов.

## Windows 11 / Docker Desktop / WSL2

1. Установите актуальный NVIDIA Windows driver с поддержкой RTX 5070 Ti и WSL GPU-PV. Для образа CUDA 13.0 нужен драйвер ветки R580 или новее, поддерживающий конкретную карту; forward compatibility старого драйвера на GeForce не предполагается. Сверяйтесь с [CUDA driver requirements](https://docs.nvidia.com/cuda/cuda-toolkit-release-notes/index.html).
2. Обновите WSL, включите WSL2 backend и Linux containers в Docker Desktop. В PowerShell:

```powershell
wsl --update
wsl --status
nvidia-smi
docker compose version
```

Не устанавливайте Linux display driver внутри WSL для Docker Desktop: используется Windows-драйвер и GPU-PV. Доступ GPU предоставляет интеграция Desktop; ручная настройка toolkit в пользовательском WSL-дистрибутиве нужна только для собственного Docker Engine, не для daemon Desktop. [Требования Docker Desktop GPU](https://docs.docker.com/desktop/features/gpu/), [CUDA on WSL](https://docs.nvidia.com/cuda/wsl-user-guide/index.html).

3. Скопируйте `.env.example` в `.env`, если нужен другой model ID/контекст. Для публичной Qwen HF_TOKEN не требуется. Для gated/private HF-модели примите условия доступа и задайте HF_TOKEN только в env; он передаётся только inference-сервису и не запекается в образы.
4. Загрузите образ, проверьте проброс GPU и CUDA (модель ещё не загружается):

```sh
docker compose --profile nvidia pull vllm
docker compose --profile nvidia run --rm --no-deps --entrypoint nvidia-smi vllm
docker compose --profile nvidia run --rm --no-deps --entrypoint python3 vllm -c "import torch; print(torch.__version__, torch.version.cuda); print(torch.cuda.is_available()); print(torch.cuda.get_device_name(0), torch.cuda.get_device_capability(0)); print((torch.ones(16,device='cuda')+1).sum().item())"
```

Ожидается CUDA available=True, карта RTX 5070 Ti, capability (12, 0), сумма 32. Одного успешного nvidia-smi недостаточно для проверки kernels.

5. Запустите приложение и один inference runtime:

```sh
docker compose --profile nvidia up --build
```

Для фонового запуска добавьте `-d`. Первая загрузка HF-модели и kernels может занимать значительно больше 15 минут при медленной сети; health start_period — 15 минут, а не предел загрузки. Проверяйте логи и `/health`. Модель хранится в `llm-chess-arena_huggingface`; кеш переживает пересоздание контейнера.

6. Проверьте API в PowerShell:

```powershell
Invoke-RestMethod http://localhost:8000/health
Invoke-RestMethod http://localhost:8000/v1/models
```

В UI используйте `http://vllm:8000/v1`, а не localhost. Дополнительная проверка четырёх ходов через реальный Provider и Chess Engine выполняется командой ниже.

## Linux / Docker Engine

Установите NVIDIA driver для карты и CUDA образа, Docker Engine и Compose plugin. Затем установите NVIDIA Container Toolkit из официального репозитория для своего дистрибутива: [пошаговая установка](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html). После установки:

Для Ubuntu/Debian с обычным rootful Docker Engine установка репозитория и пакета выглядит так (для RPM/rootless используйте соответствующий раздел официального руководства):

```sh
sudo apt-get update
sudo apt-get install -y curl gnupg2 ca-certificates
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update
sudo apt-get install -y nvidia-container-toolkit
```

После установки настройте доступ GPU и проверьте inference:

```sh
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
nvidia-smi
docker compose --profile nvidia pull vllm
docker compose --profile nvidia run --rm --no-deps --entrypoint nvidia-smi vllm
docker compose --profile nvidia up --build -d
curl -f http://127.0.0.1:8000/health
curl -f http://127.0.0.1:8000/v1/models
```

Выполните и CUDA tensor-команду из раздела Windows, затем smoke-проверку ниже. Docker daemon restart затрагивает остальные контейнеры машины; выполняйте при настройке хоста. Rootless Docker требует отдельного раздела toolkit guide. Проект не настраивает драйверы за пользователя.

## macOS / Apple Silicon M5, около 25 GB общей памяти

Frontend/backend остаются в Docker Compose. Для Metal выберите **один** из следующих нативных runtimes. Обычная Linux VM Docker Desktop не получает прямой доступ к Metal; профиль nvidia здесь не включайте. Общая память одновременно используется macOS, Docker VM и inference: доступные 25 GB не равны 25 GB свободной памяти модели.

### vLLM-Metal

Официальная [установка](https://docs.vllm.ai/projects/vllm-metal/en/stable/installation/) требует Apple Silicon и macOS 15+. Homebrew устанавливает стабильную сборку с Python и готовыми wheels. `pip install vllm-metal` не является поддерживаемым способом.

```sh
brew tap vllm-project/vllm-metal https://github.com/vllm-project/vllm-metal
brew install vllm-project/vllm-metal/vllm-metal
vllm serve mlx-community/Qwen2.5-7B-Instruct-4bit --host 0.0.0.0 --port 8000 --max-model-len 4096 --max-num-seqs 1 --gpu-memory-utilization 0.8
```

Используется [MLX 4-bit instruct checkpoint](https://huggingface.co/mlx-community/Qwen2.5-7B-Instruct-4bit), около 4.3 GB файлов, не CUDA AWQ. Qwen2 поддерживается в [списке архитектур](https://docs.vllm.ai/projects/vllm-metal/en/stable/supported_models/). Это стартовый рецепт для M5, требующий проверки на машине пользователя. Подробности памяти/контекста: [рецепты Metal](https://docs.vllm.ai/projects/vllm-metal/en/stable/recipes/).

`0.0.0.0` нужен для доступа из Docker; ограничьте входящие подключения firewall доверенным окружением. При использовании в общей сети включите авторизацию runtime и server credential profile Arena. Секрет не вставляйте в URL/Model ID/промпт. Проверка на хосте:

```sh
curl -f http://127.0.0.1:8000/health
curl -f http://127.0.0.1:8000/v1/models
docker compose up --build -d
docker compose exec -e INFERENCE_BASE_URL=http://host.docker.internal:8000/v1 -e INFERENCE_MODEL_ID=mlx-community/Qwen2.5-7B-Instruct-4bit backend node scripts/check-inference.mjs
```

Проверка выполняет реальные completions и четыре шахматных полухода. В UI выберите vLLM-Metal, сверив model ID с ответом API. Если ошибка Metal возникает при старте, читайте stdout нативного процесса. Остановка — Ctrl+C; кеш HF на хосте сохраняется.

### Docker Model Runner

Установите актуальный Docker Desktop с поддержкой Model Runner на Apple Silicon. Settings → AI → Enable Docker Model Runner; для проверки через localhost включите host-side TCP support на 12434. Metal использует нативный llama.cpp engine, отдельный NVIDIA-контейнер не нужен. [Установка](https://docs.docker.com/ai/model-runner/get-started/), [engines](https://docs.docker.com/ai/model-runner/inference-engines/).

```sh
docker model version
docker model status
docker model pull ai/qwen2.5:7B-Q4_K_M
docker model configure --context-size 4096 ai/qwen2.5:7B-Q4_K_M
docker model list
curl -f http://localhost:12434/engines/v1/models
docker compose up --build -d
docker compose exec -e INFERENCE_BASE_URL=http://model-runner.docker.internal/engines/v1 -e INFERENCE_MODEL_ID=ai/qwen2.5:7B-Q4_K_M backend node scripts/check-inference.mjs
```

При необходимости `docker model run ai/qwen2.5:7B-Q4_K_M` открывает интерактивную проверку модели; HTTP-запрос также загружает её по требованию. Tag проверен в [каталоге Docker](https://hub.docker.com/r/ai/qwen2.5/tags), формат GGUF Q4_K_M. Model ID для запроса сверяйте с API: runtime может возвращать другое каноническое имя. [Настройка context](https://docs.docker.com/ai/model-runner/configuration/) сохраняется Model Runner. `docker model logs` помогает подтвердить Metal, загрузку модели и ошибки. Каталожные оценки VRAM не считаются измерениями.

DMR Desktop использует `model-runner.docker.internal` автоматически; не переназначайте его host-gateway. Для Docker Engine на Linux API иной: хостовый gateway с портом 12434 и `/engines/v1`. В этом проекте уже задан `host.docker.internal:host-gateway`, поэтому укажите `http://host.docker.internal:12434/engines/v1` при наличии DMR Engine. API DMR не имеет авторизации; доступ ограничивается настройками Desktop/сетью.

## Общая проверка и диагностика

```sh
docker compose exec -e INFERENCE_BASE_URL=http://vllm:8000/v1 -e INFERENCE_MODEL_ID=Qwen/Qwen2.5-7B-Instruct-AWQ backend node scripts/check-inference.mjs
docker compose --profile nvidia ps
docker compose --profile nvidia logs --tail 100 vllm
docker compose --profile nvidia exec vllm nvidia-smi
```

Скрипт вызывает backend `/providers/probe`, создаёт матч двух подключений к выбранной модели, выполняет четыре NextMove в режиме B, печатает принятые UCI, ошибки и метрики. При нелегальном ответе/недоступности завершается с ненулевым кодом, не заменяет ответ Mock-ходом. Для Metal/DMR/Ollama замените URL/Model ID согласно таблице; при авторизации задайте `INFERENCE_CREDENTIAL_PROFILE` (alias серверного профиля). Внешние API вызываются только по указанной оператором конфигурации.

Ручной completion с хоста Linux/macOS (Windows: `curl.exe` с JSON-файлом через `--data-binary @request.json`):

```sh
curl -f http://localhost:8000/v1/chat/completions -H 'Content-Type: application/json' --data '{"model":"Qwen/Qwen2.5-7B-Instruct-AWQ","messages":[{"role":"user","content":"Return only JSON: {\"move\":\"e2e4\"}"}],"max_tokens":128,"temperature":0}'
```

Диагностика UI относится ко времени последней проверки, это не непрерывный мониторинг. Completion возвращает доступность, HTTP-время, model и usage. Дополнительно опциональный `GET <Base URL>/models` извлекает только ID выбранной модели и `max_model_len`/`context_length`; 404, malformed, redirect или отсутствие поля не мешают работе completion. Серверный список не доказывает резидентность весов в памяти: фактический запуск подтверждает completion. Неизвестные значения остаются «нет данных»/null; VRAM, время загрузки и генерации не выводятся из HTTP latency. Если процесс погиб от OOM без HTTP-ответа, причина видна лишь в логах runtime. Тела upstream ошибок, произвольные metadata и ключи в UI/журнал не попадают.

Для стандартных серверов `/v1/models` можно проверить из backend:

```sh
docker compose exec backend node -e "fetch('http://vllm:8000/v1/models').then(async r=>{console.log(r.status); const b=await r.json(); console.log(b.data?.map(m=>({id:m.id,max_model_len:m.max_model_len})))})"
```

Смените URL на Metal/DMR при проверке контейнер → хост. Успех curl на хосте не подтверждает доступ из backend. На Linux host runtime должен слушать Docker-доступный интерфейс; localhost внутри backend означает сам контейнер. При ошибке модели сверяйте ID, формат квантования, поддержку параметров и startup logs; Provider не удаляет отвергнутые параметры молча.

## Две модели и ограничения платформ

Один сервис vLLM обслуживает одну выбранную модель. Оба игрока могут обращаться к нему: в одном матче ход только один, поэтому это не удваивает веса. Для разных моделей укажите два независимых endpoints (например локальный vLLM и удалённый сервер, либо два разных GPU). Второй тяжёлый сервер проект автоматически не создаёт. Два процесса с utilization 0.8 на одной карте конкурируют за один объём памяти; даже две 4-битные модели требуют отдельных weights, KV и runtime. Не складывайте проценты как независимые лимиты. На Mac две модели аналогично конкурируют с macOS/Docker за unified memory; последовательная смена сервера не позволяет двум разным моделям участвовать в автоматическом матче без отдельного механизма выгрузки, которого здесь нет.

| Платформа | Поддержанный путь | Известные ограничения |
| --- | --- | --- |
| Windows 11, RTX 5070 Ti | Desktop WSL2 GPU-PV, профиль nvidia | Драйвер должен поддерживать карту и CUDA образа; shared GPU с экраном, сеть HF и место под большой образ; nvidia-smi не проверяет все kernels |
| Linux NVIDIA | Engine + Container Toolkit, профиль nvidia | Нужна настройка toolkit у daemon; rootless отличается; native host endpoint должен быть доступен Docker-сети |
| macOS M5 | Базовый Compose + нативный Metal или DMR llama.cpp | Metal не пробрасывается Linux-контейнеру; GPU/CPU/VM делят общую память; MLX/GGUF не взаимозаменяемы с CUDA AWQ |
| Любая платформа без GPU/runtime | Mock или внешний/облачный API | Интерфейс запускается; локальный inference недоступен до настройки runtime |

`docker compose --profile nvidia stop vllm` освобождает GPU, сохраняя кеш и эксперименты. vLLM получает SIGTERM и grace period 60 секунд; приложение отдельно отменяет операции через Fastify preClose. Не используйте `down --volumes`: он удаляет и эксперименты, и кеш. Изменение inference env требует `docker compose --profile nvidia up -d --force-recreate vllm`. RAM-матчи при рестарте backend пока теряются; постоянное JSON-хранилище запланировано следующим этапом 4C.
