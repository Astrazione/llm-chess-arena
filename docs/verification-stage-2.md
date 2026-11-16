# Проверка этапа 2

Дата: 15 ноября 2026 года. Среда: Windows, Docker Desktop/WSL2, Linux containers x86_64. Node.js/npm на хосте не запускались. Все зависимости, сборки, тесты и сценарии выполнялись через Docker Compose.

## Реализованный объём

Chess Engine на chess.js 1.4.0, строгие DTO/JSON-схемы TypeBox 0.34.52, Game Orchestrator, MatchService, LLM Provider contract, пять стратегий Mock, parser/prompts A/B, журнал публикации/подписки, REST. Docker-окружение первого этапа сохранено. Frontend не расширялся до интерфейса матча.

## Проверки

| Проверка | Команда/способ | Результат |
| --- | --- | --- |
| Зависимости | `docker compose exec backend npm install --package-lock-only --save-exact ...` | Обновлены manifest/lockfile в контейнере |
| Обновление окружения | `docker compose up --build -d --force-recreate --renew-anon-volumes --wait` | Новые зависимости доступны; постоянный volume сохранён |
| Backend quality gate | `docker compose exec backend npm run check` | Lint, TypeScript, 77 тестов и сборка прошли |
| Frontend regression | `docker compose exec frontend npm run check` | Lint, TypeScript, 4 теста и production-сборка прошли |
| Browser regression | `docker compose -f compose.yaml -f compose.test.yaml run --no-deps --rm e2e` | 2 Chromium-теста связи через Vite/восстановления после 503 прошли |
| HTTP-партия по сценарию | `docker compose exec backend node scripts/play-mock-match.mjs` | Completed/Chess/Checkmate, победа чёрных 0-1, 4 полухода и 4 принятые попытки |
| Полная случайная партия | Та же команда с `--random` | Seed белых 42/чёрных 99: Completed/Chess/InsufficientMaterial, 1/2-1/2, 367 полуходов и 367 принятых попыток |
| Ошибки через Vite | `docker compose exec -e API_BASE_URL=http://frontend:5173 backend node scripts/play-mock-match.mjs --errors` | Две IllegalMove-попытки, TechnicalLoss белых; 0 ходов, FEN не изменён |
| PGN | Сценарии загружают итоговую PGN через chess.js | Совпали финальная FEN и Result для обеих законченных шахматных партий |
| Реальный shutdown | Из frontend-контейнера запущен ожидающий HTTP NextMove; `docker compose stop backend` | HTTP 200 с Stopped/ServerShutdown, текущая попытка Cancelled, доска не изменена; Shutting down → Shutdown complete |
| Финальная пересборка | `docker compose up --build -d --force-recreate --wait` | Оба сервиса healthy, исходники и зависимости включены в образ |
| HTTP после финального перезапуска | Повторены scripted-checkmate и illegal-moves через Vite; HTTP frontend/health с хоста | Мат, техническое поражение и неизменность доски подтверждены повторно; HTTP 200 |
| Постоянный volume | Контрольный JSON записан до пересоздания, прочитан после; затем удалён | Содержимое сохранилось; пользовательские файлы не удалялись |

77 backend-тестов: 25 Chess Engine, 5 Mock Provider, 23 оркестратор, 15 REST, 9 из первого этапа.

Покрыты шах/мат/пат, обе рокировки обоих цветов и запрет через шах, en passant и истечение права, все четыре превращения, недостаточный материал, право заявления при 3 повторах/50 ходах, автоматическое завершение при 5/75 и приоритет мата. Проверены UCI/SAN, PGN, история позиций, неизменность состояния при ошибках, все пять категорий ошибок, feedback и retries, техническое поражение, Pause/Resume, NextMove, двойные Start/NextMove, Stop/Reset при игнорирующем отмену провайдере, непрерывность sequence и изоляция наблюдателей. Внутренняя ошибка Engine не приписывается модели как поражение.

REST-тесты проверяют JSON-сериализацию DTO, строгие поля без coercion, ошибки 400/404/409, все команды, идемпотентные повторы, события/пагинацию, Reset в активном HTTP-запросе, shutdown до истечения длинного timeout. Дополнительно сценарии запускались против настоящего TCP API, включая POST через Vite.

## Известные ограничения и готовность к этапу 3

- Реестр, попытки и журнал находятся только в RAM. Перезапуск backend очищает их. Сохранность Docker volume проверена отдельно от ещё не реализованного Experiment Store.
- Нет SSE, JSON Store, файловых export endpoints и агрегированной статистики. PGN доступен в snapshot; отдельный архив старых gameId пока отсутствует, их попытки доступны через сохранённые в RAM события.
- Нет реальных API-провайдеров, GPU-inference и интерфейса матча. Наличие OpenAI/vLLM/Ollama не требуется.
- Idempotency keys не реализованы: NextMove/Reset/Create нельзя вслепую повторять после потери HTTP-ответа.
- Draw claims поддерживаются по текущей позиции; заявления с будущим ходом и полный арбитраж FIDE не реализованы. Недостаточный материал определяется возможностями chess.js, без отдельного решателя всех dead positions.
- Внешний адаптер, игнорирующий AbortSignal, может продолжить собственную сетевую работу; его результат после отмены/timeout не влияет на игру. Mock реально прерывает задержки.
- На Linux-хосте и macOS отдельно не проверялось. Предупреждения о dev-зависимостях из отчёта этапа 1 не являлись задачей этого этапа.

Этап 2 готов. Для этапа 3 есть versioned DTO, REST-контракт, sequence/gameId, publish/subscribe, журнал всех попыток, детерминированный Mock и контейнерные сценарии проверки. Следующая работа — подключить SSE и атомарное JSON-хранение с восстановлением/экспортом и статистикой.
