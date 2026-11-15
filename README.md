# LLM Chess Arena

Локальное приложение для экспериментальных шахматных матчей между двумя LLM. Сейчас реализован **этап 1: архитектура и Docker-окружение**. Доступны проверка состояния backend и минимальная страница соединения. Шахматная логика, реальные вызовы моделей и интерфейс матча запланированы следующими этапами.

Архитектура: [docs/architecture.md](docs/architecture.md). Требования: [docs/requirements.md](docs/requirements.md). Прогресс: [docs/implementation-plan.md](docs/implementation-plan.md). Результаты фактических проверок: [docs/verification.md](docs/verification.md). Этап 1 проверен в Docker Desktop на Windows: 13 unit/API и 2 браузерных теста, hot reload обоих сервисов, остановка и сохранность volume после пересоздания.

## Запуск

Нужны Docker Engine с Compose v2+ на Linux либо Docker Desktop с Linux containers на Windows/macOS. На Windows используйте WSL2 backend. **Node.js/npm на хосте не нужны**: все зависимости, сервисы и проверки запускаются в Docker. Интернет требуется для первой загрузки образов/зависимостей и отдельного образа браузерных тестов.

Из корня проекта:

```sh
docker compose up --build
```

Откройте **http://localhost:5173**. Страница должна показать «Backend подключён». Backend также доступен по http://localhost:3000/api/health. Для фонового запуска:

```sh
docker compose up --build -d
docker compose ps
docker compose logs --tail=100
```

Оба сервиса должны стать healthy. Frontend ждёт успешного health check backend. Приложение запускается без `.env`, API-ключей, GPU и inference runtime.

## Конфигурация

При необходимости скопируйте `.env.example` в `.env` (`Copy-Item .env.example .env` в PowerShell или `cp .env.example .env` в Linux/macOS).

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| FRONTEND_PORT | 5173 | Порт браузера на хосте |
| BACKEND_PORT | 3000 | Диагностический API-порт на хосте |
| LOG_LEVEL | info | Уровень backend-логов |
| WATCH_USE_POLLING | true | Polling для Windows/WSL2/macOS bind mounts; на Linux можно false |
| WATCH_INTERVAL_MS | 500 | Интервал polling в мс |
| OPENAI_API_KEY / OPENROUTER_API_KEY | пусто | Server-only env, резерв для этапа LLM-интеграции |

`HOST=0.0.0.0`, `PORT=3000`, `DATA_DIR=/data/experiments` и `API_PROXY_TARGET=http://backend:3000` задаются Compose внутри контейнеров. Изменение host-портов не меняет внутренние адреса. После изменения `.env`: `docker compose up -d --force-recreate`.

API-ключи не используются на этапе 1. В дальнейшем они настраиваются только в server env; не добавляйте `VITE_*` с секретами. `.env` исключён из Git и Docker build contexts. Frontend получает только настройки watcher/proxy. Браузер обращается к относительному `/api/health`, Vite проксирует его в Docker-сети. CORS не требуется.

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

Без запущенных сервисов можно использовать `docker compose run --build --rm --no-deps backend npm run check`. Браузерный тест проверяет React и настоящий запрос через Vite к backend, а также восстановление после HTTP-ошибки:

```sh
docker compose -f compose.yaml -f compose.test.yaml run --build --rm e2e
```

Браузер и системные библиотеки устанавливаются только в отдельном target browser-tests. Обычные frontend/backend образы их не содержат. Основной Compose не поднимает тестовый сервис.

HTTP-проверки из PowerShell:

```powershell
Invoke-RestMethod http://localhost:3000/api/health
Invoke-RestMethod http://localhost:5173/api/health
```

На Linux/macOS: `curl -f http://localhost:5173/api/health`. Ответ обоих адресов: `{"status":"ok","service":"backend"}`.

## Данные, остановка и логи

Именованный volume `llm-chess-arena_experiments` смонтирован в backend как `/data/experiments`. На этапе 1 матчей ещё нет: каталог создаётся и проверяется при запуске. Экспериментальные JSON будут сохраняться там после реализации хранилища.

```sh
docker compose stop
docker compose start
docker compose down
docker compose up --build -d
docker compose up -d --force-recreate
docker compose logs -f backend frontend
```

`stop` останавливает сервисы с grace period 15 секунд; backend обрабатывает SIGINT/SIGTERM через Fastify.close. `down` удаляет контейнеры и сеть, сохраняя именованный volume. `up --force-recreate` пересоздаёт контейнеры. **`docker compose down --volumes` удаляет в том числе все эксперименты**; не используйте эту команду для обычной остановки или обновления зависимостей.

Скопировать данные на хост: `docker compose cp backend:/data/experiments ./data-backup`. Перед резервным копированием будущих активных матчей останавливайте их через API; детали будут добавлены с хранилищем.

## Платформы и локальные LLM

**Windows / WSL2.** Запустите Docker Desktop, включите WSL2 backend и Linux containers. Compose можно выполнять в PowerShell из этой папки или в WSL с включённой интеграцией Docker Desktop. Polling покрывает исходники на Windows-диске; хранение репозитория в файловой системе WSL обычно ускоряет bind mounts. Если Docker CLI не может подключиться к daemon, сначала запустите Docker Desktop. Занятые порты можно заменить через `.env`.

**Linux.** Нужны работающий Docker daemon и Compose plugin. Дополнительный `host.docker.internal:host-gateway` позволяет backend обращаться к HTTP-inference на хосте; сервер на хосте должен слушать интерфейс, доступный Docker-сети, а не только loopback. Основным сервисам доступ к GPU не нужен.

**NVIDIA CUDA / RTX 5070 Ti 16 GB.** На этапе 1 vLLM не устанавливается и GPU не резервируется. На этапе 5 появятся profile `nvidia` и проверенная версия официального vLLM с поддержкой Blackwell sm_120, совместимыми драйверами/CUDA, cache volume и лимитами GPU/контекста. На Windows NVIDIA inference потребует Docker Desktop/WSL2 и GPU-драйвер с поддержкой WSL. Две разные модели могут требовать отдельных endpoints и не обязаны одновременно помещаться в 16 GB. Конкретные команды появятся после проверки runtime; текущий запуск полностью CPU-only.

**macOS Apple Silicon / M5.** Базовые frontend/backend контейнеры используют multi-architecture Node image. Metal GPU нельзя передавать Linux-контейнеру. На этапе 5 backend будет подключаться к vLLM-Metal либо Docker Model Runner на хосте через `host.docker.internal:<port>/v1`; порт и model ID зависят от выбранного runtime. При ~25 GB unified memory размер моделей и контекст потребуют отдельной проверки. Подключение inference на этапе 1 не реализовано.

Поддержка API vLLM CUDA/Metal, Ollama, Docker Model Runner и облачных провайдеров будет реализована универсальным OpenAI-compatible адаптером. Оркестратор не зависит от конкретного движка. Реально проверенные платформы указаны в отчёте проверки, остальные остаются целевыми.

## Структура

```text
backend/
  Dockerfile, package.json, package-lock.json
  src/app.ts, server.ts, config.ts
  src/routes/health.ts
  src/llm/provider.ts          # Только контракты будущей интеграции
  tests/
frontend/
  Dockerfile, package.json, package-lock.json
  src/App.tsx, api/health.ts, styles.css
  src/App.test.tsx, test/setup.ts
  e2e/connection.spec.ts
  vite.config.ts, vitest.config.ts, playwright.config.ts
docs/
  requirements.md, architecture.md, implementation-plan.md, verification.md
compose.yaml
compose.test.yaml               # Необязательные браузерные проверки
.env.example
AGENTS.md
```

Следующий этап — Chess Engine на chess.js и проверка шахматных правил внутри уже настроенного Docker-окружения.
