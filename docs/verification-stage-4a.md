# Проверка этапа 4A: универсальный Chat Completions Provider

Дата: 16 ноября 2026 года. Среда: Windows, Docker Desktop/WSL2, Linux-контейнеры Node.js 24. Разработка и проверки выполнялись через Docker Compose; зависимости на хост не устанавливались и изолированы в анонимных volumes. На хосте node_modules — пустые каталоги точек монтирования Docker. Зависимости на этом этапе не менялись.

## Реализовано

- OpenAI-compatible HTTP adapter поверх native fetch: независимые Base URL, model ID, названия и параметры игроков. Поддерживаются одинаковые модели, разные endpoints и смешанный Mock/API матч.
- Опциональные temperature/лимит, выбор max_tokens/max_completion_tokens, text/JSON mode. Параметры не удаляются автоматически. Тестовый completion проверяет принятие модели/настроек до ходов; GET /providers и POST /providers/probe поддержаны строгими TypeBox-схемами.
- Server credential profiles: alias/URL доступны UI, env names/значения ключей остаются на сервере. Ключ привязан к точному нормализованному Base URL; URL с userinfo/query/fragment и redirects отклоняются. Upstream error body не публикуется; известные ключи удаляются из отражённых ответов.
- Общий и отдельные редактируемые системные шаблоны, восстановление стандартного, color/fen/ascii/history перед каждой попыткой; неизвестные/незакрытые переменные отклоняются. Контекст не содержит инструкций/ответов соперника. В режиме A легальных ходов нет, включая retry; режим B получает полный список.
- Строгий JSON/UCI Parser и Chess Engine без исправления ответов. Ошибки формата/легальности/пустого текста разделены; feedback относится к неизменной позиции, принятый повтор отмечен в UI.
- Метрики попыток: startedAt/finishedAt/elapsedMs, responseTimeMs, inputTokens/outputTokens/totalTokens. Неизвестные значения, в том числе генерация/загрузка, равны null. Usage сохраняется и для отклонённых ответов. Preflight usage отделён в snapshot.providerChecks.
- AbortSignal и тайм-аут до конца чтения HTTP-тела, предел 1 MiB, 429 и сетевые ошибки. Единственная операция и защита сессии сохранены. PreClose отменяет также ручные probe-запросы.
- Расширенные формы без поля ввода ключа, проверка модели, диагностика подключения, отдельные промпты и восстановление стандартного. Mock-сценарии и старый Mock DTO сохранены.

## Проверки

```sh
docker compose up --build -d --force-recreate
docker compose exec backend npm run check
docker compose exec frontend npm run check
docker compose -f compose.yaml -f compose.test.yaml run --build --rm e2e
docker compose -f compose.yaml -f compose.test.yaml run --rm --no-deps e2e
```

Backend: **96 тестов**, ESLint, TypeScript и build прошли. 80 прежних тестов сохранены. 16 новых проверяют реальный локальный HTTP-клиент: тело запроса и параметры, usage и отсутствие скрытого reasoning, опциональные поля, HTTP 400/401/429/500, размер и неверный envelope, тайм-аут тела/отмену/недоступный сервер, redirects и ключи, два endpoints через REST, ошибочный JSON → нелегальный ход → успешный retry, шаблоны/режимы A/B, EmptyResponse с usage, публичные snapshots/events без секретов и shutdown во время preflight.

Frontend: **6 тестов**, ESLint, TypeScript и build прошли. Chromium: **14 сценариев** через браузер → Vite → backend. Все прежние 11 сценариев сохранены; добавлены:

1. Два тестовых endpoints, выбранные независимо в UI: четыре полухода, исправление ошибки после повтора, player prompts, max_completion_tokens/JSON mode, usage и отсутствие чужих инструкций в запросе; мобильный экран 360 px без переполнения.
2. Ошибка подключения HTTP 429 в UI, затем партия совместимого API против Mock.
3. Reset при активном HTTP-запросе; запоздавший ответ не меняет новую игру и журнал.

Первый e2e-прогон обнаружил потерю доступных имён select-полей. Полям возвращены явные aria-label; затем весь набор прошёл дважды, последний прогон на окончательных исходниках после пересоздания сервисов: **14 passed**. Образ браузера собран первой командой с --build; повторы использовали готовый образ и bind-mounted тесты. Frontend обслуживался Vite из актуального bind mount.

Дополнительно:

- После force-recreate оба сервиса healthy, health напрямую и через Vite вернул ok. JSON-маркер в DATA_DIR сохранился, volume experiments не удалялся. Это проверяет сохранность volume, а не сохранение RAM-матчей.
- В открытом Chromium временная правка footer появилась через HMR без навигации и смены UUID. Проверочная правка отменена.
- Изменение mtime backend-файла вызвало nodemon restart. Открытый SSE не удерживал shutdown; UI сообщил о потере RAM-матча, «Переподключить» восстановило API/SSE с новым UUID. Необработанных JS-исключений не было.
- Скриншот `artifacts/e2e/compatible-mobile.png` просмотрен: формы, метрики и доска читаются, горизонтального переполнения нет. Артефакты исключены из Git.
- После тестов вспомогательный mock-api остановлен. Основные backend/frontend оставлены запущенными и healthy. git diff --check не выявил ошибок пробелов.

## Границы проверки

Настоящие LLM не вызывались. Проверка наличия серверных ключей вернула false; пользовательские endpoint profiles отсутствуют. Бесплатные GET-проверки типичных локальных API `host.docker.internal:11434/api/tags` и `host.docker.internal:8000/v1/models` не обнаружили доступного сервера. Платные запросы без отдельного разрешения не выполнялись. Игра на тестовом HTTP API не является подтверждением качества/совместимости двух настоящих моделей.

У совместимого протокола нет универсального capabilities endpoint. Probe подтверждает принятие выбранных полей; молчаливое игнорирование полей сервером нельзя обнаружить таким запросом. Модель обязана выдавать корректный JSON; обёртки Markdown и пояснения намеренно не исправляются. 429 расходует обычный бюджет retries; Retry-After сохраняется как диагностика, автоматического ожидания/скрытых HTTP-повторов нет.

Постоянные JSON Store, архив и файловый экспорт относятся к 4B; текущие конфигурации/попытки/метрики остаются в RAM. vLLM CUDA и специальная GPU-инфраструктура не добавлялись. Конкретные облачные API, macOS/Linux host, Firefox/Safari и большие нагрузочные эксперименты не проверялись.

При реализации изучены [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create), [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility), [OpenRouter Chat Completions](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion). Настройка описана в [README](../README.md), контракты — в [api.md](api.md), дальнейшие этапы — в [implementation-plan.md](implementation-plan.md).
