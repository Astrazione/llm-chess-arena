# REST, SSE и архив экспериментов — этап 5

Базовый URL с хоста: `http://localhost:3000/api` либо `http://localhost:5173/api` через Vite. В Docker-сети: `http://backend:3000/api`. Все тела — JSON, все изменения состояния — только на backend. Поддерживаются Mock и произвольные OpenAI-compatible Chat Completions endpoints. SSE доступен через тот же Vite proxy.

Единый источник схем и TypeScript DTO: `backend/src/contracts/match.ts` (TypeBox + Static). Запросы валидирует Fastify: неизвестные поля запрещены, числовые строки вместо чисел не преобразуются. Все snapshots и события имеют `schemaVersion: 1`. GET-ответы состояния/событий не кешируются.

## Ресурсы и команды

| Метод и путь | Тело | Ответ | Поведение |
| --- | --- | --- | --- |
| GET `/health` | — | 200, status/service | Готовность backend |
| GET `/providers` | — | 200, defaultSystemPrompt/profiles | Стандартный шаблон и публичные alias/Base URL ключей, без имён env/секретов |
| POST `/providers/probe` | PlayerSettings | 200, ProbeResult | Тестовый completion; возможен расход платных токенов. 400 при неверной конфигурации |
| POST `/matches` | Конфигурация или `{}` | 201, MatchSnapshot; Location | Создать стандартную партию в Created |
| GET `/matches/:id` | — | 200, MatchSnapshot | Текущее состояние |
| POST `/matches/:id/start` | Нет или `{}` | 202, MatchSnapshot | Created → Running, автоматическая игра |
| POST `/matches/:id/pause` | Нет или `{}` | 200, MatchSnapshot | Running → Paused; активный запрос может закончиться |
| POST `/matches/:id/resume` | Нет или `{}` | 202, MatchSnapshot | Paused → Running, только когда busy=false |
| POST `/matches/:id/next-move` | Нет или `{}` | 200, MatchSnapshot | Created/Paused → один успешный ход с retries → Paused либо Completed |
| POST `/matches/:id/stop` | Нет или `{}` | 200, MatchSnapshot | Created/Running/Paused → Stopped, отмена активной операции |
| POST `/matches/:id/reset` | Нет или `{}` | 200, MatchSnapshot | Новая стандартная партия в Created с прежними настройками |
| POST `/matches/:id/claim-draw` | `{"reason":"ThreefoldRepetition"}` или `{"reason":"FiftyMoves"}` | 200, MatchSnapshot | Явное заявление активной стороны, только Created/Paused, busy=false |
| GET `/matches/:id/events?after=0&limit=100` | — | 200, страница событий | Последовательность строго больше after; limit 1…500 |
| GET `/matches/:id/stream` | — | 200, text/event-stream | Начальный snapshot и события со снимками, heartbeat каждые 15 секунд |

`:id` — UUID ресурса матча. Он сохраняется при Reset; `gameId` меняется и `generation` увеличивается. Новая партия имеет свежие Mock Providers, начальные seed/cursor, чистые попытки и доску. HTTP API не принимает произвольный FEN; нестандартные стартовые позиции используются только в доменных тестах.

Start/Resume возвращают принятый снимок после записи накопленных переходов; ответа модели не ждут. NextMove дожидается одного успешного хода, завершения или Stop и сохранения результата. Ошибки и retries относятся к одному полуходу; после него второй полуход не запускается. При Reset во время NextMove ожидающий запрос получает 409 SessionChanged.

Pause не отменяет текущий запрос. Если ответ легален, он применяется; если отклонён, новый retry не начинается до Resume/NextMove. Уже использованный бюджет попыток и описание ошибки сохраняются. При busy=true команды NextMove и Resume из Paused возвращают 409 OperationInProgress. Stop/Reset работают и во время preflight/ожидания ответа, применяют AbortSignal и инвалидируют старую операцию. Поздний ответ не меняет ни доску, ни события новой/остановленной игры.

## Конфигурация

Пример гарантированного мата двумя Mock Providers:

```json
{
  "players": {
    "white": { "strategy": "ScriptedMoves", "moves": ["f2f3", "g2g4"] },
    "black": { "strategy": "ScriptedMoves", "moves": ["e7e5", "d8h4"] }
  },
  "mode": "A",
  "maxRetries": 2,
  "maxPlies": 512
}
```

| Поле | Значение по умолчанию и ограничения |
| --- | --- |
| players | Два RandomLegalMove, seed белых 1, чёрных 2. При передаче players нужны обе стороны. |
| mode | A; B добавляет legalMoves в контекст/промпт |
| systemPrompt | Шаблон из `backend/src/application/prompts.ts`; можно задать при создании, 1…16000 символов |
| maxRetries | 2; 0…10. Это число повторов **после первой попытки**, всего максимум 1 + maxRetries на полуход |
| maxPlies | 512; 1…2000. Ограничение эксперимента, не шахматная ничья |
| moveDelayMs | 0; 0…60000. Серверная задержка между автоматическими ходами. Pause прерывает ожидание, Stop/Reset отменяют его. NextMove её не использует. |

Настройки каждой mock-модели:

| Поле | Значение |
| --- | --- |
| strategy | RandomLegalMove / ScriptedMoves / InvalidMove / MalformedResponse / DelayedResponse |
| seed | 0…4294967295, по умолчанию 1, zero также использует 1. Детерминированный xorshift32; разные игроки имеют отдельные генераторы |
| moves | Последовательность ответов для ScriptedMoves, до 2000 строк. Пустой/отсутствующий скрипт запрещён; исчерпание даёт ProviderError без подмены хода |
| invalidEvery | Для InvalidMove: каждая N-я попытка возвращает `a1a1`, по умолчанию 2; остальные выбирают легальный ход. 1…1000 |
| delayMs | 0…60000; по умолчанию 1000 для DelayedResponse, 0 для остальных стратегий |
| timeoutMs | 1…30000, по умолчанию 1000; независимо для каждого игрока |

MalformedResponse всегда возвращает некорректный JSON. Задержку можно добавить к любой стратегии. Mock получает допустимые ходы через отдельный внедрённый callback тестовой композиции, использующий Chess Engine. В режиме A они не попадают в контекст запроса. Поведение Mock не моделирует способность настоящей LLM понимать правила.

Перед первым ходом проверяются обе модели через `probe` с их тайм-аутами. Отказ preflight даёт ProviderFailed и TechnicalLoss соответствующей стороны без попыток ходов. Проверки preflight не входят в счётчики попыток хода; результаты сохраняются в snapshot.providerChecks. Настройки/создание ресурса не вызывают внешний API. Прерванный Stop/Reset preflight не изменяет новую/остановленную игру.

### Настройки Chat Completions игрока

```json
{
  "provider": "openai-compatible",
  "providerName": "Мой endpoint",
  "baseUrl": "http://host.docker.internal:11434/v1",
  "modelId": "your-model-id",
  "timeoutMs": 60000,
  "temperature": 0.3,
  "maxOutputTokens": 256,
  "tokenLimitParameter": "max_tokens",
  "responseFormat": "text",
  "systemPrompt": "Play chess as {{color}}. Return one JSON UCI move."
}
```

У каждого цвета независимые настройки; одинаковые модель/URL разрешены. providerName — метка пользователя. Base URL — API-префикс без `/chat/completions`, только HTTP(S), без userinfo/query/fragment. timeoutMs 1…300000. temperature 0…2 и maxOutputTokens 1…131072 опциональны: отсутствующие поля не отправляются. tokenLimitParameter — max_tokens либо max_completion_tokens; responseFormat — text либо json_object. Неподдерживаемые поля не удаляются автоматически. credentialProfile — необязательный публичный alias серверного профиля; разрешён только с его точным Base URL. Поля apiKey/apiKeyEnv запрещены схемой.

Общий config.systemPrompt и отдельные players[color].systemPrompt сохраняются в конфигурации. Отсутствующий промпт игрока использует общий; длина 1…16000. Оба типа игроков поддерживают промпт. Переменные color/fen/ascii/history в двойных фигурных скобках подставляются перед каждой попыткой; неизвестные переменные дают 400. Список легальных ходов добавляется только в userPrompt/position режима B, в том числе при retries. Ответы/инструкции соперника не передаются. Исправленная моделью попытка — Accepted с attemptNumber > 1.

ProbeResult: `{available, diagnostic, error, metrics, diagnostics?}`. Для совместимого API выполняется реальный completion с выбранной моделью и параметрами; ответ проверяется как Chat Completions envelope с непустым content. Успех не доказывает, что сервер применяет поля, которые он молча игнорирует. Ошибка модели/сети возвращается как available=false, error.code/message с HTTP 200; нарушение схемы/профиля — HTTP 400. Probe отменяется при disconnect/shutdown.

На этапе 4B добавлены необязательные diagnostics: endpointState (responding/unreachable), reportedModel из completion, modelMetadata (reported/unavailable), listedModel и reportedMaxContextTokens из опционального GET `<Base URL>/models` (max_model_len/context_length). Metadata читается с коротким deadline и не обязательна для совместимости API. Список моделей не считается измерением резидентности в памяти. Структурированная HTTP-ошибка нехватки памяти даёт resourceError=OutOfMemory без передачи её исходного текста. Поле diagnostics сохраняется также в snapshot.providerChecks и SSE-снимках; attempt.diagnostics содержит модель из ответа. Неизвестные VRAM/context/load/generation не оцениваются. Адреса runtimes: [local-inference.md](local-inference.md).

## Снимок и результаты

`MatchSnapshot` содержит:

- `id`, `gameId`, `generation`, `status` (Created/Running/Paused/Completed/Stopped), `busy`.
- `config`: зафиксированные настройки эксперимента.
- `position`: FEN, ASCII, активный цвет white/black, inCheck, legalMoves UCI, history, positions, halfmoveClock, repetitionCount, claimableDraws, outcome.
- `position.history`: подтверждённые ходы с ply/color/uci/san/before/after; `position.positions` включает начальный FEN и каждый последующий.
- `attempts`: попытки **текущего gameId**, включая Pending/Accepted/Rejected/Cancelled, номер полухода и попытки, контекст, сырое содержимое ответа, ошибку, измеренное elapsedMs, метки времени и diagnostics.
- `attempts[].metrics`: responseTimeMs, inputTokens, outputTokens, totalTokens, generationTimeMs, modelLoadTimeMs; неизвестные значения равны null. elapsedMs включает всю попытку, responseTimeMs измеряет HTTP-ответ, generationTimeMs не выводится из них. Usage отклонённого JSON/хода также сохраняется. Поле optional для совместимости, новые попытки его имеют.
- `providerChecks`: color/checkedAt/result для завершённых preflight-проверок текущей игры. Метрики отдельно от попыток ходов; Reset их очищает.
- `result`: null до завершения; `pgn`: подтверждённые ходы с Result, соответствующим результату матча; `lastEventSequence`: общий курсор журнала ресурса.

| kind результата | Причина | Смысл |
| --- | --- | --- |
| Chess | Checkmate / Stalemate / InsufficientMaterial / FivefoldRepetition / SeventyFiveMoves | Автоматическое шахматное завершение; winner либо null, score 1-0/0-1/1/2-1/2 |
| ClaimedDraw | ThreefoldRepetition / FiftyMoves | Удовлетворённое явное заявление, score 1/2-1/2 |
| TechnicalLoss | InvalidFormat / IllegalMove / Timeout / ProviderError / EmptyResponse | Техническое поражение, отдельные loser/winner и score; не объявляется матом |
| Limit | MaxPlies | Ограничение эксперимента; score `*`, winner=null |
| Stopped | UserStop / Reset / ServerShutdown / InternalError | Принудительная остановка; score `*`, winner=null |

Результаты первых четырёх видов переводят исполнение в Completed. Stop не переписывает уже Completed-результат (409). Reset сохраняет старые события, но создаёт новую игру без результата. Внутренняя ошибка исполнения останавливает матч как InternalError, а не присуждает модели шахматное поражение.

## Ничьи

Три повторения и 100 полуходов без взятия/хода пешкой — **право заявить** ничью, а не автоматическое завершение. Пять повторений и 150 таких полуходов — автоматическая ничья; мат последним ходом имеет приоритет. Основание: [FIDE, статьи 9.2, 9.3, 9.6](https://handbook.fide.com/chapter/E012023).

Используются предикаты chess.js для мата, пата, недостаточного материала и заявляемых ничьих. `isGameOver()`/`isDraw()` не используются как автоматический итог, поскольку они включают заявляемые основания. Для отсутствующих в chess.js отдельных проверок пяти повторений/75 ходов оболочка считает канонические позиции, полученные из `chess.fen()` (без недоступного en passant), и читает halfmove clock из FEN. Правила ходов не дублируются. Документация библиотеки: [chess.js 1.4](https://jhlywa.github.io/chess.js/).

Поддерживается заявление по **уже возникшей** текущей позиции. Заявление с указанием будущего хода и судейские процедуры не реализованы. InsufficientMaterial соответствует распознаваемым библиотекой позициям; общего решателя всех возможных заблокированных dead positions нет. Mock автоматически не заявляет ничью.

## Идемпотентность и ошибки

- Start в Running, Resume в Running, Pause в Paused и Stop в Stopped возвращают тот же текущий статус и не дублируют события/операции. При работающем матче снимок может естественно измениться между вызовами.
- Остальные недопустимые переходы дают 409 InvalidTransition. Resume из Paused требует завершения активной операции; повторный NextMove при busy=true даёт 409 OperationInProgress.
- Create, NextMove и Reset не идемпотентны. После потерянного HTTP-ответа сначала прочитайте текущее состояние; автоматический повтор NextMove может выполнить ещё один ход. Idempotency keys пока отсутствуют.
- 400 InvalidRequest — нарушение схемы/конфигурации; 404 MatchNotFound — неизвестный UUID; 409 DrawNotClaimable — основание отсутствует; 409 SessionChanged — Reset во время ожидания; 503 ServerStopping — сервер закрывается.

Формат ошибок:

```json
{ "error": { "code": "OperationInProgress", "message": "A move or preflight is already in progress" } }
```

Ошибочный ход и ошибка провайдера — результат попытки, а не HTTP 500. NextMove может вернуть 200 с Completed/TechnicalLoss. Ключи и содержимое исключений внешнего провайдера не попадают в публичную диагностику. Сырые ответы ходов сохраняются без исправления.

## События и SSE

Ответ GET events: `{schemaVersion, matchId, events, lastSequence, hasMore}`. Для следующей страницы используйте sequence последнего полученного события; lastSequence — текущий верхний курсор, его нельзя пропускать при hasMore=true. После Reset курсор не обнуляется.

Событие содержит `{schemaVersion, matchId, gameId, sequence, at, type, status, ply, fen, data}`. Типы: GameCreated, GameStarted, MoveRequested, MoveAccepted, MoveRejected, ProviderFailed, AttemptCancelled, GamePaused, GameResumed, GameCompleted, GameStopped, GameReset. data содержит соответствующие attempt/move/result/color/message/previousGameId. MoveRequested фиксирует Pending; итоговая попытка передаётся отдельным событием без изменения прежнего события.

`OperationSettled` публикуется после освобождения операции и сообщает через снимок busy=false. Это служебное событие скрыто в пользовательском журнале. GamePaused может ещё иметь busy=true; OperationSettled после текущего ответа разрешает Resume/NextMove.

`EventJournal.subscribe()` возвращает unsubscribe. Наблюдатели получают копии событий асинхронно; их исключения не ломают матч. SSE начинает с `retry: 1000` и события `snapshot`, data — MatchSnapshot schemaVersion=1. Далее идут события `match`: `id` равен sequence, data — `{schemaVersion:1,event:GameEvent,snapshot:MatchSnapshot}` (StreamUpdateSchema в contracts/match.ts). Snapshot может быть новее вложенного события: backend успел выполнить следующий переход до доставки microtask. Клиент не выводит состояние из event.fen/status; принимает снимок с неубывающей generation/lastEventSequence и независимо добавляет событие в журнал.

Каждые 15 секунд отправляется комментарий `: heartbeat`. Заголовки запрещают кеширование, трансформации и буферизацию proxy. Disconnect удаляет подписку и таймер. Медленный потребитель отключается при backpressure; preClose закрывает потоки, чтобы они не удерживали shutdown.

Нативный EventSource восстанавливает соединение. Last-Event-ID не запускает серверный replay: при каждом подключении клиент читает REST snapshot, догружает страницы events после последнего REST-курсора и повторно читает snapshot. Курсор продвигается только страницами REST, поэтому SSE, пришедший раньше страницы, не создаёт пробел в журнале. События дедуплицируются по sequence и фильтруются по matchId/gameId. После Reset старый журнал скрывается, поздние HTTP/SSE-снимки старой generation игнорируются. Постоянного polling нет.

JSON-архив сохраняет каждую игру отдельно от реестра исполняемых матчей. После перезапуска GET matches/:id возвращает последний gameId с `archived:true`; SSE отправляет этот снимок и heartbeat, REST events возвращает сохранённый журнал последней игры. Исполнение автоматически не возобновляется. Команды к отсутствующему в RAM матчу дают 404; используйте replay для нового ресурса. При неизвестном UUID клиент предлагает переподключение, без повторной отправки команды хода.

## Архив и экспорт

| Метод и путь | Ответ |
| --- | --- |
| GET `/experiments?offset=0&limit=50` | experiments, total, unreadableFiles; limit 1…100, сортировка по createdAt убыванию |
| GET `/experiments/:gameId` | Полный Experiment |
| GET `/experiments/:gameId/export.json` | Experiment с Content-Disposition attachment |
| GET `/experiments/:gameId/export.pgn` | application/x-chess-pgn, attachment; только принятые ходы |
| POST `/experiments/:gameId/replay` | 201 MatchSnapshot, новые ID и Created; тело отсутствует или `{}`, провайдеры не вызываются |

Формат Experiment: `{schema:"llm-chess-arena/experiment",schemaVersion:1,id,matchId,createdAt,updatedAt,recoveredAt?,snapshot,events,statistics}`. id=gameId. events включают события только этой партии с исходными глобальными sequence. Reset сохраняет старый snapshot/attempts/result и создаёт новый файл. Все схемы, включая статистику и экспорт, определены в contracts/match.ts. Новые необязательные поля v1 добавляются совместимо; неизвестная версия файла отклоняется, миграции пока не требуются.

`statistics.players[color]`: successfulMoves, illegalMoves, formatErrors (InvalidFormat и EmptyResponse), errors, retries, requests, completedAttempts, legalMoveRatio, meanResponseMs, medianResponseMs, inputTokens/outputTokens и количества известных samples. Доля — Accepted/(Accepted+Rejected), Pending/Cancelled не считаются завершёнными. Среднее/медиана — только известные metrics.responseTimeMs, без подмены elapsedMs. Токены суммируются по известным значениям (включая отклонённые ответы), null означает отсутствие всех данных; samples позволяют отличить частичную сумму. Проверки до матча и их токены хранятся отдельно в providerChecks. totalRequests=moveRequests+preflightRequests; Mock probe не является HTTP-запросом. Это число зарегистрированных обращений: при аварии между сохранением Pending и отправкой нельзя доказать факт доставки запроса провайдеру.

Статистика партии содержит plies, durationMs (с паузами, null до старта и при неизвестном времени аварии), resultCategory=Ongoing/ChessWin/Draw/TechnicalLoss/Stopped/Limit. Причина и счёт находятся в snapshot.result. В PGN TechnicalLoss имеет решающий счёт и Termination="rules infraction"; Stop — `*`/abandoned, Limit — `*`/unterminated. EndReason/ResultKind/GameId/MatchId/Mode сохраняются дополнительными тегами. FEN/SetUp для нестандартной стартовой позиции выставляет Chess Engine.

Совместимый игрок также принимает необязательные seed (0…4294967295), runtime/runtimeVersion/modelRevision/quantization/maxContextTokens. Только seed передаётся в Chat Completions body; остальные — заявленные метаданные воспроизводимости. `ProviderCheckRequested` фиксирует намерение preflight до вызова, `ProviderChecked` — успешное завершение. providerChecks содержит request/rawText, когда они доступны; ошибка API не публикует upstream body/headers. Ручная кнопка probe — диагностика вне эксперимента и в его журнал не включается.

Ошибки архива: 404 ExperimentNotFound, 422 CorruptExperiment (включая неизвестную версию), 503 StorageUnavailable. При отказе записи модель больше не вызывается, в live snapshot появляется storageError, последний целый файл остаётся читаемым. До нового запуска устраните причину записи. После штатного shutdown результат ServerShutdown сохраняется до закрытия Fastify; после аварии recovery добавляет отметку recoveredAt и отменяет Pending без выдуманного времени ответа.
