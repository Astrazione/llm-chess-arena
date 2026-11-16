# Проверка обнаружения моделей

Дата: 16 ноября 2026 года. Windows, Docker Desktop/WSL2; разработка, runtime и все проверки — через Docker Compose. Зависимости и lock-файлы не менялись, host node_modules не создавались.

## Реализованное поведение

Отдельный порт ModelDiscovery и HTTP-адаптер получают Ollama tags/ps либо OpenAI-compatible/vLLM models. Endpoint POST `/api/providers/models` принимает подключение без Model ID, возвращает versioned DTO с точными ID и только сообщёнными характеристиками. Ollama различает скачанные и загруженные модели по отдельному успешному /api/ps; при его отказе сведения о памяти неизвестны. vLLM показывает перечисленные сервером модели, без предположений о GPU-памяти или загрузке другого repo.

Новые списки игроков загружаются при изменении подключения, имеют Refresh, ручной ввод и состояния загрузки/ошибки/пустого ответа. Обновление списка и переключение режима не стирают ID. Выбор меняет существующий modelId, сохраняется в snapshots/JSON и не меняет Temperature/лимит/Timeout/промпты. discoveryApi — необязательное поле; прежние конфигурации/эксперименты читаются. Preflight перед матчем сохранён.

Адреса ограничены server allowlist: стандартные локальные шаблоны, точные URL профилей и явно заданные LLM_DISCOVERY_URLS_JSON. Ключи разрешаются только для точного исходного URL. Redirect/userinfo/query/fragment запрещены, ошибки не включают upstream bodies, метаданные проходят редактирование известных секретов. Проверяются Origin/Host, DTO и дополнительные поля; Vite сохраняет Host. Ограничения: 4096 bytes запроса, 1 MiB ответа, 2000 записей, четыре активных запроса, deadline 5 с и дополнительный deadline ps 1 с. Disconnect/preClose отменяют операции.

## Выполненные проверки

| Проверка | Результат |
| --- | --- |
| `docker compose exec backend npm run check` | lint, typecheck, **129 тестов**, build прошли |
| `docker compose exec frontend npm run check` | lint, typecheck, **12 тестов**, build прошли |
| `docker compose -f compose.yaml -f compose.test.yaml run --build --rm e2e` | **19 Chromium-сценариев прошли**; после исправления SSE весь набор повторён без пересборки browser image |
| `docker compose -f compose.yaml -f compose.test.yaml up --build -d backend frontend mock-api` | Пересборка/пересоздание успешны, health checks проходят |
| `docker compose up --build -d` после проверок | Обычная конфигурация возвращена, тестовый allowlist снят; experiments volume сохранён |
| `docker compose exec backend node scripts/check-persistence.mjs prepare` и `verify` после пересоздания | Завершённая партия/PGN сохранены, PGN импортирован с совпадением FEN, Pending отменён, архив доступен, replay имеет новые ID |
| `docker compose -f compose.yaml -f compose.test.yaml run --rm --no-deps e2e node e2e/verify-hotreload.mjs` + touch исходников внутри Compose | Frontend HMR без навигации, backend restart, тот же matchId/FEN, SSE восстановлен |
| `docker compose -f compose.yaml -f compose.test.yaml run --rm --no-deps e2e node e2e/verify-model-discovery.mjs` | Настоящий vLLM вернул `Qwen/Qwen2.5-7B-Instruct-AWQ`; браузер выбрал ID, Refresh сохранил его, конфигурация записана; completion не вызывался |
| `docker compose exec vllm hf cache ls --cache-dir /root/.cache/huggingface/hub --filter type=model --format json` | CLI huggingface_hub 2.2.0 прочитал Qwen/Qwen2.5-7B-Instruct-AWQ из cache volume, revision main; модели не загружались/не переключались |

Новые backend HTTP-тесты покрывают оба API, пустые списки, точные URL/ID, reverse proxy prefix, необязательный ps, неверный JSON/структуру/число записей, предел тела, deadline чтения, недоступный сервер, отмену, allowlist, ключи, redirects, DTO/Origin, конкурентность/shutdown и исчезнувшую перед preflight модель без изменения доски. Frontend-тесты проверяют выбор, Refresh, ручной режим, независимость игроков, ошибки и игнорирование старого ответа. Браузерные проверки проходят реальную цепочку browser → Vite → backend → Mock HTTP API, затем проверяют snapshot/экспорт и preflight. Прежние тесты сохранены; прежние ручные UI-сценарии адаптированы к явному переключателю ввода.

При первой проверке HMR обнаружено: временный HTTP-ответ Vite вместо SSE переводил EventSource в CLOSED и прекращал автоматический reconnect. Исправлено пересоздание только окончательно закрытого потока с отменяемой задержкой; CONNECTING использует native retry. Команды хода автоматически не повторяются. Unit-регрессия и повторная реальная HMR-проверка прошли.

Скриншоты: `artifacts/e2e/model-discovery.png`, `real-vllm-model-discovery.png`, существующие desktop/mobile и история экспериментов. Каталог исключён из Git.

## Ограничения

- Настоящий Ollama не запускался; tags/ps и ошибки проверены Mock HTTP API без GPU/ключей. Метаданные OpenAI-compatible cloud API также проверены имитацией HTTP; платные запросы не выполнялись.
- HF Cache доступен отдельной штатной CLI-командой внутри локального inference-контейнера. В веб-список кеш не включён: backend не имеет Python, доступа к cache volume или Docker socket; удалённый vLLM не предоставляет файловую систему через models API. Для веб-просмотра нужен отдельный ограниченный read-only канал.
- Cached repo может быть неполным или иметь другой served alias. Скачанная модель не выдаётся за обслуживаемую и не загружается выбором ID. Активация другой модели выполняется пользователем через VLLM_MODEL_ID/revision и пересоздание runtime; инструкция в README. Приложение не перезапускает Docker и не управляет загрузкой весов.
- Списки относятся ко времени GET; наличие ID не подтверждает текущую память, контекст или поддержку generation parameters. Перед матчем выполняется прежний completion preflight.
- Старые конфигурации без discoveryApi используют OpenAI-compatible список; для native tags достаточно выбрать API списка Ollama. Отказ списка не запрещает ручной Model ID и прежний completion.
