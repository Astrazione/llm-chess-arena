# Проверка этапа 4B: локальный GPU-inference

Дата: 16 ноября 2026 года. Среда: Windows, Docker Desktop/WSL2, Docker Compose 5.5.1. Доступна NVIDIA GeForce RTX 5070 Ti, 16303 MiB, драйвер Windows 621.01. Mac M5 и отдельный Linux-хост отсутствуют. Все запуски приложения, сборки и тесты выполнялись внутри Docker Compose; зависимости не менялись и на хост не устанавливались.

## Реализовано

- Необязательный сервис vllm в отдельном compose.inference.yaml, включённом в основной Compose. Без профиля nvidia активны только backend/frontend. Нет depends_on приложения от GPU-сервиса.
- Официальный образ vllm/vllm-openai:v0.32.0; release notes, Docker manifest, SM120/Marlin в исходниках и quantization_config Qwen2.5-7B-Instruct-AWQ проверены отдельно. CUDA/PyTorch не переустанавливаются поверх образа.
- GPU reservation count=1, shared memory 2 GB, без privileged/host IPC. Начальная модель AWQ 4-bit, context 4096, utilization 0.8, max-num-seqs 1, eager. Model/revision/контекст/память/порт доступны в env; HF_TOKEN передаётся только runtime; HF cache хранится в именованном volume.
- Шаблоны адресов NVIDIA/внешний vLLM/Metal/DMR/Ollama/cloud, независимые настройки цветов. Универсальные Base URL/Model ID/Provider сохранены, шахматный движок не менялся.
- Диагностика HTTP-доступности и времени, модели из completion, контекста из опционального /models. Безопасная классификация структурированного HTTP OOM. Неизвестные показатели не подменяются оценками VRAM или временем HTTP.
- Инструкции Windows/Linux/macOS с официальными источниками и точными API URLs: [local-inference.md](local-inference.md). Smoke-скрипт check-inference.mjs проверяет реальный Provider и четыре полухода; его исполнение на тестовом HTTP-сервере проверено отдельно от настоящей модели.

## Автоматические и инфраструктурные проверки

```sh
docker compose config --services
docker compose --profile nvidia config --services
docker compose --profile nvidia config --quiet
docker compose up --build -d --force-recreate
docker compose exec backend npm run check
docker compose exec frontend npm run check
docker compose -f compose.yaml -f compose.test.yaml run --build --rm e2e
```

Backend: **98 тестов**, frontend: **6 тестов**, lint/typecheck/build обоих сервисов прошли. Два новых backend-сценария проверяют сообщённую сервером модель/контекст, отсутствие произвольной telemetry, необязательность /models и безопасную OOM-диагностику с сохранением в providerChecks. Старые тесты секретов, deadlines, cancellation, concurrency и шахматных правил сохранены.

Chromium: **15 сценариев прошли**, включая независимые API, OOM без раскрытия исходного error body, все шесть шаблонов URL с редактируемым model ID, context/model в UI и REST-снимке, команды/Reset/SSE и адаптивность. Полный набор прошёл и с прежним образом Chromium и актуальными bind mounts, и после успешной пересборки browser-tests target с --build. Ошибка типов нового массива e2e была исправлена; итоговый typecheck прошёл.

Дополнительно:

- При базовом запуске без GPU profile backend/frontend healthy; health напрямую и через Vite вернул HTTP 200/ok.
- После пересоздания приложения маркер в DATA_DIR сохранился. Это проверка volume, а не сохранения RAM-матчей. Volumes не удалялись.
- В открытом Chromium изменение footer 4A → 4B появилось через HMR без навигации и смены UUID. Touch backend config вызвал nodemon restart; UI обнаружил потерю RAM-матча, «Переподключить» восстановило API/SSE с новым UUID.
- Просмотрен artifacts/e2e/compatible-mobile.png: новые поля/диагностика помещаются в мобильный экран; проверки переполнения на 320/360/768/1440 px прошли.

## NVIDIA: аппаратная проверка

```sh
docker compose --profile nvidia pull vllm
docker compose --profile nvidia run --rm --no-deps --entrypoint python3 vllm -c "import torch; print(torch.__version__, torch.version.cuda); print(torch.cuda.is_available()); print(torch.cuda.get_device_name(0), torch.cuda.get_device_capability(0)); print((torch.ones(16,device='cuda')+1).sum().item())"
docker compose --profile nvidia up -d vllm
```

Образ загружен успешно. Проверка CUDA внутри контейнера вернула:

```text
2.13.0+cu130 13.0
True
NVIDIA GeForce RTX 5070 Ti (12, 0)
32.0
```

Startup vLLM определил Qwen2ForCausalLM, auto_awq, MarlinLinearKernel/AutoAWQMarlinLinearMethod и FlashAttention 2. Затем модель полностью загрузилась, `/health` и `/v1/models` вернули HTTP 200; API сообщил точный Model ID и max_model_len=4096. Специальные обходы для SM120 не потребовались.

```sh
docker compose exec -e INFERENCE_BASE_URL=http://vllm:8000/v1 -e INFERENCE_MODEL_ID=Qwen/Qwen2.5-7B-Instruct-AWQ backend node scripts/check-inference.mjs
```

**Настоящая GPU-модель выполнила четыре легальных полухода без ошибок и повторов:** `e2e4 b8c6 d2d4 a7a6`. Итог — Limit/MaxPlies, без шахматной ничьей. Использовались оба цвета на одном endpoint, режим B, temperature 0, max_tokens 128, text. Usage ходов: 461/467/525/489 total tokens. Первый ручной probe занял около 18.1 с, первый ход около 32.9 с, последующие HTTP-ответы около 161–203 мс. Это отдельные наблюдения с холодными kernels/префиксным кешем, не универсальный benchmark или измерение чистой генерации.

Дополнительно в Chromium через реальный UI выбраны NVIDIA-шаблоны для обоих игроков, заполнен Model ID и проверен context 4096. Запущена автоматическая партия через браузер → Vite → backend → vLLM; те же четыре UCI приняты без ошибок. ProviderChecks обоих цветов содержат reportedModel и reportedMaxContextTokens=4096. Скриншот: artifacts/e2e/nvidia-real.png.

Фактические данные этого запуска:

- Model revision HF: `b25037543e9394b818fdfca67ab2a00ecc7dd641` (разрешённый main).
- Образ: `vllm/vllm-openai@sha256:befccf0e7e4089aa23926bb6f887a85c0d46c2a99e6de5c5ffdf5cb7957c5b34`.
- Runtime сообщил checkpoint 5.19 GiB, загрузку модели 5.29 GiB и доступный KV budget 6.99 GiB при utilization 0.8. Первая загрузка с HF заняла около 8.6 минут внутри фазы loading, весь старт около 9.5 минут.
- `nvidia-smi` после загрузки/во время первого запроса показал **14433 MiB из 16303 MiB**. Это суммарная память GPU, включая остальные процессы и экран, не изолированное потребление весов. Эти данные не используются как оценка VRAM в интерфейсе.

После первых проверок inference-контейнер пересоздан с сохранением именованного HF volume. SIGTERM завершил старый процесс без ожидания предельных 60 секунд; новая модель загрузилась из кеша, повторный `/health` вернул HTTP 200, сервис healthy. При пересоздании модель передаётся позиционным аргументом `vllm serve`, чтобы не использовать устаревающий --model. Весовые файлы повторно не скачивались; инициализация/autotune runtime всё равно выполняются.

Итог: backend, frontend и vllm оставлены запущенными; вспомогательный mock-api остановлен. Проверочный маркер удалён из DATA_DIR после проверки сохранности volume; эксперименты и HF cache сохранены. `git diff --check` прошёл.

## Непроверенные сценарии и границы

Mac M5, нативный vLLM-Metal и Model Runner/Metal аппаратно не проверялись. Их способы установки, API-префиксы и форматы MLX/GGUF сверены с документацией; точные команды установки, проверки /models и четырёх ходов приведены в [руководстве](local-inference.md). Linux Toolkit описан по официальным инструкциям; отдельного теста Linux-хоста нет.

Не проверялись одновременное размещение двух разных моделей в 16 GB, длинные партии у предела контекста, реальные OOM с падением GPU-процесса, облачные API и gated HF-модели. Ошибка памяти имитируется тестовым HTTP API; если настоящий runtime завершился до HTTP-ответа, UI сообщает сетевую ошибку, точная причина остаётся в логах.

Матчи остаются в RAM; постоянное хранение и экспорт перенесены в этап 4C. Stockfish, турниры, inference SDK, БД и очереди не добавлялись. Отсутствие /models или telemetry не требует специализированного Provider.
