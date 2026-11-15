# Проверка этапа 1

Дата: 15 ноября 2026 года.

**Результат: этап 1 завершён.** Контейнеры оставлены запущенными; frontend доступен по http://localhost:5173 и показывает «Backend подключён».

## Среда

- Хост: Windows, PowerShell; Docker Desktop с WSL2 backend, Linux containers, x86_64 (kernel `6.18.33.2-microsoft-standard-WSL2`).
- Docker Engine 29.8.0, Compose v5.5.1, Node.js внутри контейнера v24.22.3.
- Docker Desktop при начале работы был остановлен; запущен перед проверками.
- Node.js/npm на хосте не использовались. Lock-файлы созданы npm в официальном Node Docker image; разработка и все дальнейшие проверки выполнены через Compose.

## Фактические проверки

| Проверка | Команда/метод | Результат |
| --- | --- | --- |
| Валидность Compose | `docker compose config --quiet` | Успешно |
| Основной запуск | `docker compose up --build -d` | Образы собраны, оба сервиса запущены |
| Готовность и логи | `docker compose ps`, `docker compose logs --tail=50` | Backend/frontend healthy, серверы слушают container interfaces |
| Frontend с хоста | `Invoke-WebRequest http://localhost:5173/` | HTTP 200 |
| Backend с хоста | `Invoke-RestMethod http://localhost:3000/api/health` | status=ok, service=backend |
| API через Vite с хоста | `Invoke-RestMethod http://localhost:5173/api/health` | Тот же настоящий ответ backend |
| Backend quality gate | `docker compose exec backend npm run check` | ESLint, TypeScript, 9 тестов и сборка прошли |
| Frontend quality gate | `docker compose exec frontend npm run check` | ESLint, TypeScript, 4 теста и production-сборка прошли |
| Chromium e2e в Docker | `docker compose -f compose.yaml -f compose.test.yaml run --build --rm e2e` | 2 теста прошли: реальная связь через Vite и восстановление после 503 |
| Пользователь сервисов | `docker compose exec backend id`, аналогично frontend | uid/gid 1000, node; root не используется для приложений |
| Backend hot reload | Временно добавлен X-Stage1-Reload в health route; опрос реального HTTP | Изменение ответа подтверждено без пересборки; исходник восстановлен, заголовок исчез |
| Frontend HMR | Chromium открыт, в App.tsx временно изменён текст статуса | DOM обновился; маркер в window сохранился, полной перезагрузки страницы не было; исходник восстановлен |
| Остановка | `docker compose stop`, проверка backend-логов | SIGTERM → Shutting down → Shutdown complete, без принудительного kill/OOM |
| Данные после пересоздания | Временный JSON записан в DATA_DIR; `docker compose up -d --force-recreate --wait` | JSON считан новым контейнером с ожидаемым содержимым |
| Финальная пересборка | `docker compose up --build -d --force-recreate --wait` | Оба сервиса снова healthy; повторно подтверждена сохранность JSON |
| Проверка после финального пересоздания | Оба `npm run check`, e2e через `run --no-deps --rm e2e`, HTTP с хоста | Повторно прошли все проверки, 13 unit/API + 2 e2e теста |

Backend-тесты проверяют публичный health-контракт, Cache-Control, готовность каталога, отказ запуска при некорректном storage path и валидацию конфигурации. Frontend-тесты проверяют успех, обработку HTTP/сетевой ошибки, повторную попытку и отказ считать произвольный JSON корректным health-ответом.

Для проверки volume использовался `/data/experiments/.stage1-persistence-check.json` с контрольным значением. Он удалён после успешного чтения новым контейнером; пользовательские данные не удалялись. Все изменения исходников для hot reload восстановлены. Backend hot reload дополнительно перепроверен после окончательной настройки nodemon.

При остановке nodemon/Vite оболочка контейнера может завершаться с кодом 143 (SIGTERM); это не признак тайм-аута. Для backend закрытие Fastify дополнительно подтверждено сообщением Shutdown complete. В nodemon используется `exec node`, чтобы промежуточная оболочка не завершалась раньше приложения.

## Зависимости и границы проверки

`npm audit --omit=dev --audit-level=moderate` в обоих сервисах: **0 уязвимостей** на дату проверки. Полный npm audit сообщает 8 moderate-позиций в backend и 7 в frontend, связанных с транзитивным minimatch в nodemon/typescript-eslint: [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249). High/critical не обнаружены. Автоматический `audit fix --force` не применялся: предлагаемые откаты tooling затрагивают совместимость с TypeScript; принудительная подмена minimatch на несовместимую major-версию также не внесена. Обновление upstream dev tooling оставлено задачей сопровождения.

Linux как отдельный хост и macOS/Apple Silicon физически не проверялись. Compose и образы подготовлены без платформенных/GPU-зависимостей, но это не заменяет проверку на этих системах. CUDA/Blackwell, vLLM, Metal, реальные LLM, SSE и сохранение настоящих матчей относятся к следующим этапам и сейчас не реализованы/не проверялись. Проверена сохранность файлового volume, а не ещё не существующий Experiment Store.
