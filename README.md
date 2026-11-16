# LLM Chess Arena

Локальное приложение для экспериментальных шахматных матчей между двумя LLM. **Этап 5: постоянный JSON-архив, аналитика, PGN/JSON-экспорт и повторный запуск конфигураций.** Mock и универсальный OpenAI-compatible Provider работают независимо от GPU. Необязательный локальный NVIDIA vLLM и подключения Metal/Model Runner добавлены на этапе 4B. Результаты: [этап 5](docs/verification-stage-5.md), [GPU-inference](docs/verification-stage-4b.md).

Архитектура: [docs/architecture.md](docs/architecture.md). Требования: [docs/requirements.md](docs/requirements.md). Прогресс: [docs/implementation-plan.md](docs/implementation-plan.md). Контракты, переходы состояний и REST/SSE: [docs/api.md](docs/api.md). Проверки: [этап 1](docs/verification.md), [этап 2](docs/verification-stage-2.md), [этап 3](docs/verification-stage-3.md).

## Запуск

Нужны Docker Engine с Compose 2.20.0+ на Linux либо актуальный Docker Desktop с Linux containers на Windows/macOS. На Windows используйте WSL2 backend. **Node.js/npm на хосте не нужны**: все зависимости, сервисы и проверки запускаются в Docker. Интернет требуется для первой загрузки образов/зависимостей и отдельного образа браузерных тестов.

Из корня проекта:

```sh
docker compose up --build
```

Откройте **http://localhost:5173**. Появятся шахматная доска и индикатор «SSE подключён». Backend также доступен по http://localhost:3000/api/health. Для фонового запуска:

```sh
docker compose up --build -d
docker compose ps
docker compose logs --tail=100
```

Оба сервиса должны стать healthy. Frontend ждёт успешного health check backend. Приложение запускается без `.env`, API-ключей, GPU и inference runtime.

## Тестовые партии без LLM

В браузере выберите стратегии Mock для белых и чёрных и нажмите «Применить настройки». Доступны случайные легальные ходы с seed, сценарии UCI, нелегальные ходы, неверный JSON и задержанный ответ. Можно настроить число полуходов/retries, задержку между ходами, режим A/B и системную инструкцию. По умолчанию первый матч имеет 600 мс между ходами и 300 мс на ответ Mock для удобного наблюдения; REST по умолчанию использует нулевую задержку.

Start начинает автоматическую игру; в пошаговом режиме выполняет первый ход. Next Move выполняет один ход с повторами и оставляет паузу. Pause разрешает текущему ответу завершиться; Resume продолжает автоматику. Stop/Reset доступны при ожидании ответа и отменяют его. Reset сохраняет настройки и UUID матча, меняет gameId и очищает показанный журнал. Применение настроек создаёт отдельный матч; оно доступно до старта или после завершения/Stop. Неприменённые поля не влияют на текущую партию.

Ходы SAN выбирают исторический FEN без изменения действительной партии. Навигация под доской возвращает к текущей позиции, кнопка ⇅ переворачивает доску. Ошибочные клетки подсвечиваются красным без перемещения фигур; журнал показывает исходный ответ, модель, полуход, категорию и диагностику. При временном разрыве SSE браузер переподключается и восстанавливает журнал через REST без постоянного polling.

После запуска Compose:

```sh
docker compose exec backend node scripts/play-mock-match.mjs
docker compose exec backend node scripts/play-mock-match.mjs --random
docker compose exec -e API_BASE_URL=http://frontend:5173 backend node scripts/play-mock-match.mjs --errors
```

Первый сценарий заканчивается матом чёрных за 4 полухода. Второй проводит детерминированную партию RandomLegalMove (seed 42/99); проверенная партия закончилась ничьей из-за недостаточного материала на 367-м полуходе. Третий через Vite проверяет два ошибочных ответа, неизменную доску и техническое поражение. Скрипт обращается к работающему REST API, проверяет итог и PGN и возвращает ненулевой код при неуспехе.

Доступны Start/Pause/Resume/NextMove/Stop/Reset, режимы A/B, настройка system prompt, retries и тайм-аутов. API: `POST /api/matches`, затем команды `/api/matches/:id/start` и т. п.; снимок — `GET /api/matches/:id`, журнал — `GET /api/matches/:id/events`. Примеры и семантика в [docs/api.md](docs/api.md).

Партии, попытки и события сохраняются в Docker volume после каждого перехода. Reset архивирует старый gameId отдельно. После перезапуска/hot reload backend сохранённый матч открывается для просмотра; незавершённая партия получает Stopped/ServerShutdown без автоматической отправки новых запросов. «Новый эксперимент с этими настройками» создаёт новые matchId/gameId с прежней конфигурацией. Три повторения/50 ходов не объявляются автоматической ничьей: доступно отдельное заявление через REST; пять повторений/75 ходов завершают игру автоматически.

## Архив, статистика и экспорт

Откройте «История экспериментов», выберите партию и используйте прежнюю доску для просмотра сохранённых FEN/SAN. Журнал содержит запросы, исходные ответы, отклонённые попытки, feedback и категории ошибок. Таблица сравнивает успешные/недопустимые ходы, ошибки формата, повторы, долю допустимых ответов, среднее/медианное HTTP-время и входные/выходные токены. Частичные данные отмечаются; отсутствие метрики показывается как «—», а не ноль. Проверки API до матча учитываются отдельно от ходов. Длительность включает паузы; после аварии точное время завершения неизвестно и длительность равна null.

Кнопки «Скачать PGN» и «Скачать JSON» доступны у текущей и архивной партии. PGN содержит только принятые ходы, игроков, дату, результат и причину завершения. Техническое поражение имеет решающий счёт и Termination=rules infraction; Stop/лимит полуходов — `*`. JSON имеет `schema=llm-chess-arena/experiment`, `schemaVersion=1`, конфигурацию, снимок, хронологию событий, попытки, FEN и статистику.

В настройках OpenAI-compatible игрока раздел «Воспроизводимость» позволяет задать необязательный seed, runtime/его версию, ревизию модели, квантование и контекст. Seed передаётся API при явном выборе; неподдерживаемое поле не удаляется автоматически. Остальные поля — сообщённые пользователем метаданные, они не перенастраивают inference-сервер. Одинаковый seed не гарантирует одинаковые результаты между GPU, версиями runtime и провайдерами. Исходные промпты и фактически отправленный контекст сохраняются отдельно.

## Подключение языковых моделей

Для каждого цвета выберите «OpenAI-compatible API», укажите произвольное название провайдера, **Base URL с API-префиксом, без `/chat/completions`**, model ID и тайм-аут. Например, Base URL локального Ollama на хосте — `http://host.docker.internal:11434/v1`; адрес из контейнера `localhost` указывает на сам backend. Model ID должен существовать на выбранном сервере. Можно смешивать Mock, локальный и облачный API, использовать одну модель с обеих сторон либо разные endpoints.

Temperature и лимит токенов можно оставить пустыми: эти поля не отправляются. Если лимит задан, выберите поддерживаемое endpoint имя: `max_tokens` или `max_completion_tokens`. JSON mode (`response_format: {type: "json_object"}`) включается отдельно; обычный режим также требует от модели JSON и использует тот же строгий Parser. Неподдерживаемые параметры не удаляются автоматически: HTTP 400/422 отображается с предложением проверить настройки.

Кнопка «Проверить модель» выполняет **настоящий тестовый completion** с выбранной моделью и параметрами. Перед первым ходом каждой игры такая проверка выполняется для обоих игроков. Это может расходовать платные токены; запросов при одном лишь открытии страницы/применении настроек нет. У OpenAI-compatible API нет универсального метода проверки capabilities: успешный запрос подтверждает принятие настроек сервером, но не доказывает, что сервер применил каждое поле. Проверяйте документацию выбранной модели. Проверка не является шахматным ходом; её метрики хранятся отдельно в `snapshot.providerChecks`.

Ключи задаются только в server env. `OPENAI_API_KEY` и `OPENROUTER_API_KEY` создают профили `openai` и `openrouter`, привязанные соответственно к `https://api.openai.com/v1` и `https://openrouter.ai/api/v1`. Для любых других поставщиков в `.env`:

```dotenv
LLM_API_KEY_1=your-server-key
LLM_API_KEY_2=another-server-key
LLM_ENDPOINTS_JSON='{"cloud":{"baseUrl":"https://provider.example/v1","apiKeyEnv":"LLM_API_KEY_1"},"second":{"baseUrl":"http://host.docker.internal:8000/v1","apiKeyEnv":"LLM_API_KEY_2"}}'
```

После изменения `.env` выполните `docker compose up -d --force-recreate`. В браузере выбирается только имя профиля; его Base URL подставляется автоматически. Ключ никогда не вводится в UI. Профиль разрешено использовать только с точным нормализованным Base URL. Редиректы запрещены; URL с паролем, query или fragment отклоняются. Для API без авторизации оставьте «Без ключа». Дополнительные server env-переменные можно передать через собственный Compose override; изменений исходного кода не требуется.

Общий шаблон инструкции используется по умолчанию; у каждого игрока можно задать собственный. Переменные `{{color}}`, `{{fen}}`, `{{ascii}}`, `{{history}}` подставляются перед каждой попыткой. Есть восстановление стандартного шаблона. Режим A не включает список легальных ходов даже после ошибки; режим B включает полный список. Другому игроку передаётся только публичная история ходов. Parser принимает ровно `{"move":"e2e4"}` без обёрток, пояснений или исправления хода; все изменения доски проверяет Chess Engine.

В журнале отображаются категории ошибок, повторы, время и доступные usage-токены. Неизвестные метрики равны `null`; время HTTP-запроса не выдаётся за время генерации. Для отклонённых JSON/ходов usage также сохраняется. Ошибки HTTP 429 используют общий лимит попыток, без скрытых транспортных повторов; числовой Retry-After сохраняется в диагностике. Тайм-аут и AbortSignal охватывают чтение ответа; максимальный ответ — 1 MiB. Stop/Reset отменяют HTTP-запрос; запоздавший ответ не меняет партию.

Автотесты используют только тестовые HTTP API. Партия двух настоящих LLM на этом этапе не подтверждена: платные запросы без отдельного разрешения не выполнялись. Подробности: [проверка 4A](docs/verification-stage-4a.md).

## Конфигурация

При необходимости скопируйте `.env.example` в `.env` (`Copy-Item .env.example .env` в PowerShell или `cp .env.example .env` в Linux/macOS).

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| FRONTEND_PORT | 5173 | Порт браузера на хосте |
| BACKEND_PORT | 3000 | Диагностический API-порт на хосте |
| LOG_LEVEL | info | Уровень backend-логов |
| WATCH_USE_POLLING | true | Polling для Windows/WSL2/macOS bind mounts; на Linux можно false |
| WATCH_INTERVAL_MS | 500 | Интервал polling в мс |
| OPENAI_API_KEY / OPENROUTER_API_KEY | пусто | Server-only ключи стандартных профилей |
| LLM_API_KEY_1 / LLM_API_KEY_2 | пусто | Server-only ключи любых других endpoints |
| LLM_ENDPOINTS_JSON | пусто | Профили `{alias: {baseUrl, apiKeyEnv}}`; секреты не включать в JSON |

`HOST=0.0.0.0`, `PORT=3000`, `DATA_DIR=/data/experiments` и `API_PROXY_TARGET=http://backend:3000` задаются Compose внутри контейнеров. Изменение host-портов не меняет внутренние адреса. После изменения `.env`: `docker compose up -d --force-recreate`.

API-ключи настраиваются только в server env; не добавляйте `VITE_*` с секретами. `.env` исключён из Git и Docker build contexts. Frontend получает только настройки watcher/proxy. Браузер обращается к относительным `/api/*`, Vite проксирует их в Docker-сети. CORS не требуется.

## Разработка и зависимости

Редактируйте `frontend/src` и `backend/src` на хосте. Vite применяет изменения через HMR, nodemon перезапускает backend с SIGTERM. Образы при изменении исходников пересобирать не нужно. Polling включён для работы с Docker Desktop. Изменение конфигурации watcher/Docker требует пересоздания контейнера.

У каждого сервиса свой Dockerfile и lockfile. Установка `npm ci` выполняется в образе; node_modules и dist находятся в отдельных анонимных Docker volumes и не смешиваются с хостом. Приложения работают от пользователя node. Build stages доступны командой `docker build --target build ./backend` (аналогично frontend), но обычные проверки ниже используют Compose.

После изменения зависимостей обновите manifest и lockfile **в контейнере**, затем обновите образы и анонимные volumes:

```sh
docker compose exec backend npm install --package-lock-only --save-exact package-name@version
docker compose up --build -d --force-recreate --renew-anon-volumes
```

Для frontend замените имя сервиса. Это обновляет node_modules из нового образа; исходники остаются на хосте, volume experiments сохраняется. Обычный `up --build` может сохранить старый анонимный node_modules, поэтому при изменении зависимостей нужен `--renew-anon-volumes`.

## Проверки внутри Docker

Полный набор: ESLint, TypeScript, тесты и сборка:

```sh
docker compose exec backend npm run check
docker compose exec frontend npm run check
```

Отдельные команды (замените backend на frontend для второго сервиса):

```sh
docker compose exec backend npm test
docker compose exec backend npm run lint
docker compose exec backend npm run typecheck
docker compose exec backend npm run build
```

Без запущенных сервисов можно использовать `docker compose run --build --rm --no-deps backend npm run check`. Браузерные тесты проверяют доску, команды, историю, ошибки, восстановление SSE и адаптивность через настоящий Vite proxy:

```sh
docker compose -f compose.yaml -f compose.test.yaml run --build --rm e2e
```

Браузер и системные библиотеки устанавливаются только в отдельном target browser-tests. Обычные frontend/backend образы их не содержат. Test override также запускает `mock-api` с двумя тестовыми Chat Completions endpoints без host-порта. Основной Compose не поднимает тестовые сервисы. После проверок их можно остановить: `docker compose -f compose.yaml -f compose.test.yaml stop mock-api`.

HTTP-проверки из PowerShell:

```powershell
Invoke-RestMethod http://localhost:3000/api/health
Invoke-RestMethod http://localhost:5173/api/health
```

На Linux/macOS: `curl -f http://localhost:5173/api/health`. Ответ обоих адресов: `{"status":"ok","service":"backend"}`.

## Данные, остановка и логи

Именованный volume `llm-chess-arena_experiments` смонтирован в backend как `/data/experiments`; каталог создаётся и проверяется при запуске. Одна партия — один `<gameId>.json`. Запись: отдельный временный файл с правами 0600 → fsync → rename → fsync каталога. Вызовы модели ждут сохранения Pending; следующие попытки ждут сохранения результата предыдущей. При ошибке записи запрос получает 503 StorageUnavailable, матч останавливается с InternalError и UI показывает ошибку; последний целый файл остаётся доступным. Потребуется устранить причину и создать новый эксперимент.

Повреждённый JSON/неизвестная версия дают 422 CorruptExperiment; список считает такие файлы и продолжает показывать остальные. Файлы не удаляются и не исправляются автоматически. При старте незавершённые партии переводятся в остановленные; Pending становится Cancelled с неизвестным временем/usage. `recoveredAt` отличает аварийное восстановление от штатного shutdown. Старые временные файлы игнорируются. Единственный backend-процесс владеет записью; совместная запись нескольких реплик в один volume не поддерживается.

```sh
docker compose stop
docker compose start
docker compose down
docker compose up --build -d
docker compose up -d --force-recreate
docker compose logs -f backend frontend
```

`stop` останавливает сервисы с grace period 15 секунд; backend обрабатывает SIGINT/SIGTERM через Fastify.close. `down` удаляет контейнеры и сеть, сохраняя именованный volume. `up --force-recreate` пересоздаёт контейнеры. **`docker compose down --volumes` удаляет в том числе все эксперименты**; не используйте эту команду для обычной остановки или обновления зависимостей.

Скопировать данные на хост: `docker compose cp backend:/data/experiments ./data-backup`. Для согласованной копии нескольких файлов сначала остановите активные партии через API. API-ключи/Authorization headers не входят в формат; известные server keys и Bearer-значения редактируются перед сохранением/экспортом. Содержимое пользовательских промптов и ответов в остальном сохраняется: не вводите туда секреты.

Проверка реального пересоздания контейнеров (останавливает активные матчи, оставляет тестовые партии в архиве):

```sh
docker compose exec backend node scripts/check-persistence.mjs prepare
docker compose stop backend frontend
docker compose up --build -d --force-recreate --renew-anon-volumes --wait backend frontend
docker compose exec backend node scripts/check-persistence.mjs verify
```

Для проверки аварии вместо stop/recreate выполните `docker compose kill -s SIGKILL backend`, затем `docker compose up -d --wait backend` и `verify --crash`. Не удаляйте volume. Скрипт проверяет сохранность завершённого матча, отмену Pending, повторный импорт PGN и создание нового эксперимента.

## Платформы и локальные LLM

**Windows / WSL2.** Запустите Docker Desktop, включите WSL2 backend и Linux containers. Compose можно выполнять в PowerShell из этой папки или в WSL с включённой интеграцией Docker Desktop. Polling покрывает исходники на Windows-диске; хранение репозитория в файловой системе WSL обычно ускоряет bind mounts. Если Docker CLI не может подключиться к daemon, сначала запустите Docker Desktop. Занятые порты можно заменить через `.env`.

**Linux.** Нужны работающий Docker daemon и Compose plugin. Дополнительный `host.docker.internal:host-gateway` позволяет backend обращаться к HTTP-inference на хосте; сервер на хосте должен слушать интерфейс, доступный Docker-сети, а не только loopback. Основным сервисам доступ к GPU не нужен.

**NVIDIA CUDA / RTX 5070 Ti 16 GB.** `docker compose --profile nvidia up --build` запускает официальный vLLM v0.32.0 отдельно от приложения. Начальная модель: Qwen2.5-7B-Instruct-AWQ, контекст 4096, бюджет GPU 0.8, один запрос. Нужны подходящий драйвер и доступ GPU через Docker Desktop/WSL2 или NVIDIA Container Toolkit на Linux. Model ID, revision, context и memory budget задаются в `.env`. Кеш HF — постоянный volume. Backend подключается к `http://vllm:8000/v1`. Второй inference-сервер автоматически не запускается.

**macOS Apple Silicon / M5.** Frontend/backend запускаются обычной командой Compose. Inference работает нативно: vLLM-Metal (`http://host.docker.internal:8000/v1`) либо Docker Model Runner (`http://model-runner.docker.internal/engines/v1`). Metal в Linux-контейнер не передаётся. Model ID сверяется с конкретным сервером; примеры квантованных MLX/GGUF-моделей и команды установки приведены в руководстве.

Подробные инструкции Windows/Linux/macOS, обоснование Blackwell/quantization, адреса API, диагностика OOM, ограничения памяти и команды ручной проверки: **[docs/local-inference.md](docs/local-inference.md)**. Два игрока независимо выбирают шаблон подключения, Base URL, Model ID и профиль ключа. Состояние endpoint, модель из ответа, HTTP-время и доступный серверный контекст отображаются при проверке; неизвестная VRAM не оценивается. Реально проверенные платформы указаны в [отчёте](docs/verification-stage-4b.md).

## Структура

```text
backend/
  Dockerfile, package.json, package-lock.json
  src/app.ts, server.ts, config.ts
  src/routes/health.ts
  src/contracts/match.ts       # JSON-схемы и TypeScript DTO
  src/domain/chess/engine.ts   # Оболочка chess.js
  src/application/             # Оркестратор, сервис, промпты и parser
  src/llm/                     # Контракт, Mock/Chat Completions, credentials и deadline
  src/events/journal.ts        # Журнал событий с подписками
  src/experiments/             # Порт хранилища, статистика и экспорт
  src/storage/                 # Атомарный JSON Store
  src/routes/matches.ts        # REST-команды, страницы событий и SSE
  scripts/play-mock-match.mjs  # Воспроизводимые HTTP-проверки
  tests/
frontend/
  Dockerfile, package.json, package-lock.json
  src/App.tsx, styles.css
  src/api/                    # REST, публичные DTO
  src/state/                  # SSE, REST recovery, защита состояния
  src/components/             # Настройки, игроки, журнал
  src/test/, src/state/*.test.*
  e2e/match.spec.ts
  vite.config.ts, vitest.config.ts, playwright.config.ts
docs/
  requirements.md, architecture.md, implementation-plan.md, api.md
  verification.md, verification-stage-2.md, verification-stage-3.md
compose.yaml
compose.test.yaml               # Необязательные браузерные проверки
.env.example
AGENTS.md
```

Ограничения MVP и фактические результаты проверок перечислены в [отчёте этапа 5](docs/verification-stage-5.md). Приложение разрабатывается и проверяется внутри Docker Compose; Metal runtime устанавливается нативно по требованиям платформы. Скриншоты UI-проверок сохраняются в `artifacts/e2e/` (исключено из Git).
