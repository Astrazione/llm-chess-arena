# Проверка этапа 5: архив, аналитика, экспорт и MVP

Дата: 16 ноября 2026 года. Среда: Windows, Docker Desktop/WSL2; приложение, npm, линтеры, TypeScript, тесты и сборки выполнялись только через Docker Compose. Зависимости не менялись; host node_modules не создавались. Существующие изменения этапа 4B сохранены.

## Реализованные возможности

- ExperimentStore и атомарный JSON Store в DATA_DIR/именованном volume: temp 0600 → fsync → rename → fsync каталога. Последовательные checkpoint содержат запрос Pending до вызова и результат до следующего запроса. Сбой записи не превращается в техническое поражение модели: live-матч останавливается как InternalError и сообщает StorageUnavailable/storageError.
- Версионированная запись `llm-chess-arena/experiment`, v1: конфигурация, промпты, все попытки и feedback, ответы, UCI/SAN/FEN, события, временные метки, метрики, итог и статистика. Известные server keys и Bearer-токены удаляются рекурсивно; headers, process.env и скрытые рассуждения не сохраняются.
- Независимые файлы gameId после Reset; UUID ресурса и глобальный sequence сохраняют прежнюю семантику. Архив доступен после рестарта. Незавершённые игры не запускаются автоматически; восстановление отмечается recoveredAt, Pending отменяется без выдуманного времени ответа. Для нового запуска копируется исходная конфигурация в новые ID.
- История UI с пагинацией, готовыми историческими FEN на прежней доске, журналом запросов/ответов/ошибок, сравнением игроков, PGN/JSON-загрузками и повторным экспериментом. Архивный снимок не меняется вместе с live-матчем.
- Статистика: успешные/недопустимые/форматные ошибки, все ошибки, повторы, доля допустимых завершённых попыток, среднее и медиана известных HTTP latency, входные/выходные токены и samples. Неизвестные метрики — null, нулевой usage остаётся нулём; частичные суммы отмечены. Проверки API хранятся отдельно от ходов, но входят в общее число зарегистрированных запросов.
- PGN с игроками, датой, Result, подтверждёнными ходами и метаданными Termination/EndReason/ResultKind/GameId/MatchId/Mode. Технический проигрыш имеет решающий счёт; Stop/MaxPlies — `*`. Повторный импорт проверяет ходы, каждую историческую и конечную позицию.
- Необязательный seed для Chat Completions; runtime/version/modelRevision/quantization/context как явно заданные метаданные. Неподдерживаемые поля API не удаляются молча. Одинаковый seed не гарантирует идентичные ответы между версиями runtime, GPU и провайдерами.

## Проверки и результаты

```sh
docker compose exec backend npm run check
docker compose exec frontend npm run check
docker compose -f compose.yaml -f compose.test.yaml run --build --rm e2e
```

**Backend: 108 тестов; frontend: 6; Chromium: 17. Все проходят, lint/typecheck/build обоих сервисов проходят.** Новые 10 backend-тестов проверяют постоянную запись/экспорт/импорт, retry, техническое поражение, Reset с Pending, recovery, повреждённые файлы/неизвестную версию, реальный отказ записи chmod, копирование конфигурации, медиану/частичный usage/нулевые значения и редактирование секретов, включая ключ с кавычкой. Два новых браузерных сценария проверяют архив и экспорт через настоящий Vite proxy.

Обнаруженные проблемы исправлены без отключения проверок: валидация UUID TypeBox вне Fastify, обработка replay без тела, optional boolean при exactOptionalPropertyTypes, сброс пошагового режима при пересоздании React-компонента. После последнего исправления полный Chromium-набор прошёл: 17/17, без skipped. Просмотрен screenshot `artifacts/e2e/experiment-history.png`; доска, сравнительная таблица, экспорт и журнал помещаются в 360 px. Регрессионные проверки 320/360/768/1440 px также проходят.

Восемь сценариев задания:

| Сценарий | Подтверждение |
| --- | --- |
| Два Mock, партия и PGN | experiments.test.ts; experiments.spec.ts, сценарный мат |
| Нелегальный ход → retry → принятый ход | orchestrator/experiments tests; архив UI показывает 50% |
| Исчерпание retries → технический проигрыш | orchestrator/experiments tests; PGN rules infraction |
| Pause во время запроса → продолжение | управляемый deferred Provider, REST и Chromium |
| Reset → поздний ответ | deferred Provider игнорирует отмену, HTTP-adapter и Chromium; старая партия архивируется |
| Пересоздание контейнеров → сохранный результат | check-persistence.mjs prepare/verify на настоящем volume |
| Независимые OpenAI-compatible endpoints | compatible-provider.test.ts и compatible.spec.ts через mock-api white/black |
| Повторный импорт PGN с совпадением позиций | experiments.test.ts и check-persistence.mjs, также настоящая Qwen |

Сеть/недоступный inference, timeout чтения тела, отмена HTTP, 429, OOM-диагностика, сокрытие upstream body, graceful shutdown при NextMove, SSE reconnect и дедупликация покрыты сохранёнными тестами предыдущих этапов.

## Реальная проверка контейнеров и hot reload

```sh
docker compose exec backend node scripts/check-persistence.mjs prepare
docker compose stop backend frontend
docker compose up --build -d --force-recreate --renew-anon-volumes --wait backend frontend
docker compose exec backend node scripts/check-persistence.mjs verify
```

Остановка заняла около секунды, завершённый матч сохранился; ожидающая попытка отменена как ServerShutdown. Пересозданы backend/frontend и анонимные volumes, именованный experiments сохранён. Оба сервиса healthy. verify подтвердил неизменный PGN, повторный импорт, четыре хода, доступность архива по прежнему matchId и новый эксперимент с одинаковой конфигурацией.

Отдельно повторён prepare → `docker compose kill -s SIGKILL backend` → `docker compose up -d --wait backend` → `verify --crash`. Результат: completedSurvived=true, pendingCancelled=true, recoveredAfterCrash=true, pgnRoundTrip=true. Повреждённых файлов после аварии не обнаружено; старые временные файлы не считаются экспериментами. `down --volumes` не выполнялся.

```sh
docker compose -f compose.yaml -f compose.test.yaml run --rm --no-deps e2e node e2e/verify-restored.mjs
```

Chromium открыл архивный матч по sessionStorage ID после рестарта, подтвердил FEN/журнал, отсутствие команд исполнения, переподключение SSE без новых запросов модели и ошибок JavaScript. Screenshot: `artifacts/e2e/restored-experiment.png`.

`verify-hotreload.mjs` запущен тем же способом; во время ожидания выполнены `docker compose exec frontend touch src/App.tsx` и `docker compose exec backend touch src/config.ts`. Получен настоящий Vite websocket update без навигации; nodemon перезапустил backend, FEN/UUID сохранились, UI открыл архивный режим и восстановил SSE.

## Настоящая локальная GPU-модель

Уже работающий vLLM v0.32.0 / Qwen2.5-7B-Instruct-AWQ проверен с seed=42, temperature=0, max_tokens=128, режимом B. Заданы известные по предыдущему запуску runtime/revision/quantization, без изменения GPU-конфигурации. Выполнены `e2e4 b8c6 d2d4 a7a6` без ошибок/retries. Результат Limit/MaxPlies, `*`. JSON сохранён, PGN повторно импортирован с совпадением FEN. GameId: `c7ad89a1-df86-4f10-9c6a-cba3398b4020`.

Сохранённые показатели ходов: белые 968 входных/18 выходных токенов, чёрные 938/18; средний HTTP-ответ около 184/227 мс. Четыре запроса ходов + две проверки перед матчем = шесть; ручной probe находится вне журнала эксперимента. Эти измерения относятся к одному прогретому локальному запуску и не являются benchmark или временем чистой генерации. Настоящие платные API не вызывались.

## Оставшиеся ограничения

- Один backend-процесс и локальный Docker volume. Нет конкурентной записи реплик, индекса большого архива, TTL/очистки реестра или автоматического удаления результатов. Список читает JSON-файлы; полные checkpoint переписываются, что подходит MVP с ограниченными партиями, но не массовым турнирам.
- После рестарта просмотр и копирование конфигурации, без продолжения прежнего вычисления. Ответ между последним успешным checkpoint и аварией восстановить нельзя. При отказе диска сохранён только последний успешный checkpoint. Фактическое время аварии неизвестно, durationMs=null.
- Полные публичные completion requests/message.content сохраняются; произвольный HTTP body/headers, hidden reasoning и ручные проверки подключения вне матча исключены. Доставка Pending после аварии не доказуема, счётчик означает зарегистрированные обращения.
- Ревизия/квантование/runtime version вводятся явно, если API их не сообщает. Неизвестные GPU/load/generation метрики не оцениваются. Реальные OOM с падением GPU и длинные партии у границы контекста не проверялись.
- Mac M5/Metal/DMR и отдельный Linux-хост недоступны. Настоящие облачные API и размещение двух разных моделей одновременно не проверялись. Независимость endpoints подтверждена тестовыми HTTP-серверами; аппаратный запуск использует один vLLM для двух цветов.
- Шахматные границы предыдущих этапов сохраняются: распознаваемый chess.js недостаточный материал, заявления ничьей по текущей позиции, без полного решателя dead positions и судейских процедур.

README, AGENTS.md, архитектура, API и план актуализированы. Stockfish, Elo, турниры, БД и очереди не добавлялись. Базовые сервисы и ранее запущенный vLLM оставлены работающими; результаты проверок в volume сохранены.
