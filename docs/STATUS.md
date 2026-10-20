# Статус и журнал работ

## 2026-10-20 — первый слой общей модели событий



### Сделано
- Гость отправляет запрос на запуск общего map event вместо локального выполнения его команд.
- Хост проверяет карту, существование и тип триггера события, а также базовую близость гостя; повторная активация заблокирована до завершения.
- Сервер пересылает `event_request`, подтверждение или отказ и освобождает блокировку по `event_finished`.
- Общие parallel map events и parallel common events не выполняются на гостях; вызовы trigger-None common events маршрутизируются хосту.
- Добавлен маркер `<CoopLocal>` в комментариях события/common event для локального контента.
- Self-switches включены в авторитетный world snapshot и сообщения изменений.
- Добавлены тесты протокола и маршрутизации запросов/блокировок сервера, а также mock-тест владения map event у гостя.
- Поправлена фикстура `prepare-test-builds`, которая формировала вложенный массив вместо обычного массива `$plugins`.

### Границы этапа
- Хост должен быть на той же карте, чтобы принять запрос гостя на запуск map event.
- Стандартные окна Show Text и Show Choices транслируются гостям на той же карте; результат выбора задаёт хост. Маршруты персонажей, промежуточные проверки инвентаря/параметров, бои и переходы карты пока не синхронизированы как единый процесс.
- Синхронизация switch/variable/self-switch не делает произвольный event interpreter атомарной общей транзакцией.
- Проверка близости использует последнее состояние, полученное сервером, и упрощённые tile-правила.
- Возобновление частично выполненного события после смены хоста не реализовано.

## 2026-10-20 — снимок группы после общих событий

### Сделано
- Сервер принимает снимок группы только от текущего хоста, валидирует поля и кэширует последнее состояние в комнате.
- Новый гость получает сохранённый снимок при подключении; существующие гости получают обновление по WebSocket.
- Плагин передаёт снимок при подключении хоста и после завершения каждого host-owned map/common event.
- В снимок входят порядок участников, золото, предметы/оружие/броня, класс, опыт, HP/MP/TP, состояния и их длительности, навыки, усиления и экипировка.
- Применение снимка на госте откладывается, пока он находится в бою, и выполняется после возврата на карту.
- Добавлены тесты валидации, кеширования/пересылки и применения снимка группы; последний CI для функциональных изменений прошёл успешно.

### Границы
- Это коррекция состояния в конце события, а не копирование команд по мере выполнения. Хост исполняет команды события один раз.
- Show Text и Show Choices передаются гостям как UI; результат выбора приходит с хоста. Ветку события исполняет только хост, а маршруты, промежуточные проверки инвентаря/параметров, бои и переходы карт не воспроизводятся у гостя.
- Пользовательские поля сторонних плагинов не входят в формат снимка.

## 2026-10-19 — начальный сетевой прототип

### Сделано
- Создан репозиторий Coop-Pl и ветка разработки game/rpg-maker-mz-coop.
- Прочитаны AGENTS.md и связанные playbook/skills репозитория coop-anything.
- Исследованы кандидаты на повторное использование: Alpha NET Z, MMORPGMaker-MZ и другие найденные плагины. Ни один пока не принят как проверенная совместимая зависимость.
- Проверен архив проекта Michael Way – Double Way: RPG Maker MZ 1.10.0, пустой список включённых плагинов, одна карта Map001 без событий.
- Спроектирован первый вертикальный срез: WebSocket-комнаты и отображение удалённого персонажа.
- Написан начальный клиентский плагин, сервер комнаты, проверка протокола и документы по тестированию.
- Добавлен mock-тест, проверяющий подключение плагина, отправку начального состояния, создание видимого удалённого sprite и очистку после выхода.
- Добавлен WebSocket-тест реального сервера: создание комнаты, назначение host, снимок игроков при входе, пересылка состояния и удаление отключившегося игрока.
- Исправлена начальная прозрачность удалённого персонажа.
- Реализована синхронизация общих переключателей и переменных через хоста.
- Добавлены проверки на недопустимые значения, базовые ограничения размера world-снимка и номер ревизии.
- Добавлены тесты обмена world snapshot/change/request и mock-тест guest-поведения.
- По ручному тесту владельца, переключатель и переменная синхронизируются успешно в двух экспортированных играх MZ.
- Добавлен `tools/prepare-test-builds.js`: готовит Host/Guest из одного Windows-экспорта, обновляет плагин, параметры подключения и `package.json` профили. Для стандартной структуры MZ учитывается `www/js/plugins.js`.
- GitHub Actions для коммита 6874a94 прошёл: **16 тестов, 16 прошли, 0 провалились**. В том числе подтверждены два теста помощника подготовки парных сборок из стандартной структуры Windows Deployment RPG Maker MZ. Более поздние коммиты меняют только документацию.
- Владелец подтвердил, что две экспортированные игры MZ запускаются одновременно, сервер видит двух игроков, а тест общего переключателя и переменной прошёл. Фоновое окно визуально обновляется после возврата фокуса.

### Текущий функциональный статус
- Положение и внешний вид удалённого персонажа: владелец сообщает, что два клиента подключаются; фоновое окно не обновляется визуально до возврата фокуса.
- Переключатели/переменные: **автоматические тесты прошли и ручная проверка в двух реальных клиентах подтверждена владельцем**.
- Сервер поддерживает host-authoritative world snapshots и принимает изменения мира только от текущего хоста.
- Последняя успешная функциональная проверка протокола, WebSocket-сервера и mock-runtime — [GitHub Actions](https://github.com/DarnoPort/Coop-Pl/actions/runs/39442148895). Реальный RPG Maker MZ с двумя клиентами после изменений общих событий нужно проверить вручную.

### Известные ограничения
- Общие события управляются хостом. Show Text и Show Choices передаются гостю для отображения, а результат выбора определяется хостом; другие визуальные/игровые команды события пока не реплицируются.
- Предметы, золото и базовые параметры группы синхронизируются снимком по завершении события, а не посреди него.
- Переменные ограничены JSON-примитивами (число, строка, boolean, null); массивы и объекты от сторонних плагинов не синхронизируются.
- Боевой процесс, враги, переходы карты, сохранения и пользовательские поля сторонних плагинов не синхронизируются как общее состояние.
- Сервер не имеет TLS или аутентификации. По умолчанию слушает только loopback; это прототип для локальных тестов.
- Окна MZ неактивного клиента визуально замирают до возврата фокуса по наблюдению владельца; это отдельная проблема отображения/планирования кадров, не часть sync-пакетов.

### Следующие шаги
1. Проверить в двух настоящих клиентах RPG Maker MZ синхронизацию Show Text, Show Choices, результата выбора и снимка группы.
2. Реализовать передачу маршрутов движения событий и согласованную последовательность переходов карт.
3. Спроектировать host-authoritative бои и состояние врагов.
4. После стабилизации функционального потока спроектировать позднее подключение/восстановление; не выставлять текущий сервер в публичный Интернет.


## 2026-10-21 — guest choice display and background clients

### Fixed / improved
- The guest reapplies the host's selected choice after RPG Maker MZ starts its native choice window. This covers the timing race where the host result arrives while the guest is still dismissing earlier text and native `start()` would otherwise reset the highlighted row to the local default.
- Paired test builds generated by `tools/prepare-test-builds.js` now include Chromium/NW.js flags that reduce background renderer/timer throttling. This addresses the observed symptom where the host seemed to execute and display the event only after its window regained focus.
- Regression tests cover the early host-result/late guest-choice-window case and the background flags in generated Host/Guest package.json files.

### Verification limits
- These changes are committed to the development branch; they are not yet confirmed in the owner's real exported MZ build. Automated tests cannot fully emulate NW.js window scheduling or MZ's native message windows.
- Existing exports do not gain the new Chromium flags just by replacing the plugin. Update `chromium-args` in both existing `package.json` files or prepare a fresh test pair with the helper.


## 2026-10-21 — authoritative map-event movement snapshots

### Implemented
- Host sends a bounded `event_states` snapshot for map events at the same cadence as player state updates.
- Snapshots include tile/real coordinates, direction, character image/index, animation pattern, transparency, opacity, priority, and erased state.
- The server validates snapshots and accepts them only from the current host.
- Guests interpolate shared map-event position from host snapshots and suppress their own autonomous movement for shared events only while the host is on the same map. Events tagged `<CoopLocal>` remain local.
- Added protocol validation tests, a real WebSocket relay/host-only test, and plugin mock tests for payload creation, application, interpolation, and `<CoopLocal>` exclusion.
- GitHub Actions run [39486636614](https://github.com/DarnoPort/Coop-Pl/actions/runs/39486636614) passed on commit `ea53b7cfeccd5642ecdf22697adff0925e944028`: **34 tests passed, 0 failed**; JavaScript syntax checks passed.

### Boundaries and verification
- This is resulting position/basic visual-state replication, not replication of the full movement-route command stream or its exact wait/collision/trigger timing.
- Map transitions, cross-map snapshots, and event-command logic remain unsynchronized.
- The new route test still needs to be run in the two exported RPG Maker MZ clients; automated tests cannot prove native sprite timing.

## 2026-10-21 — automatic guest choice acknowledgement and CI repair

### Fixed / improved
- A guest no longer needs a second Enter to dismiss a non-interactive Show Choices window after the host has selected an option. When the guest window has already started, the plugin applies and acknowledges the host result immediately; if the result arrived before native window start, it is reapplied and acknowledged after start.
- Host cancellation is acknowledged through the guest's native cancel handling rather than confirming a local default row.
- Corrected a false-negative assertion in `tests/prepare-test-builds.test.js`: the helper intentionally writes one Windows path separator into the runtime `--user-data-dir` argument.
- Updated the plugin header and architecture/testing documents to match the actual choice behaviour and corrected the JSON examples for host/guest profile paths.

### Verification
- GitHub Actions run [39482096904](https://github.com/DarnoPort/Coop-Pl/actions/runs/39482096904) passed on commit `742fcace529279a0fd55f8498e634a40ab4c799c`: **30 tests passed, 0 failed**, and all JavaScript syntax checks passed.
- Mock regressions cover a result arriving after the choice window starts, a result arriving before native start, and host cancellation.
- Owner confirmation: the Show Text / Show Choices test passed in two actual exported RPG Maker MZ clients, including the late-result timing case where Guest closes the previous text first. Mock-runtime tests remain regression coverage, not a substitute for future engine-level checks.

## 2026-10-21 — background RAF throttling in test clients

### Changed
- Added NW.js launch flag `--disable-raf-throttling` to the Host/Guest test-build helper. The existing helper already set background timer, renderer-priority and occluded-window flags, but did not explicitly keep `requestAnimationFrame` running while the game window was hidden/minimized.
- Added a regression assertion so generated Host and Guest `package.json` files each contain the new flag exactly once.
- Updated the manual testing guide. The plugin itself cannot enable Chromium launch flags after NW.js starts; existing test exports need their `package.json` updated and both games restarted.

### Verification status
- GitHub Actions run [39489497434](https://github.com/DarnoPort/Coop-Pl/actions/runs/39489497434) passed on commit `5f567a01ea15252eabf239e4970ece6569b61d59`, including `npm test` and JavaScript syntax checks.
- A real two-client RPG Maker MZ test is still required to verify whether the background window keeps animating/updating while another application window has focus. Do not treat this runtime change as confirmed until that test passes.

## 2026-10-21 — scene update continues when NW.js loses focus

### Root cause
- A public MZ core-script mirror shows `SceneManager.updateScene()` calls the active scene's `update()` only if `SceneManager.isGameActive()` returns true; the stock implementation checks `window.top.document.hasFocus()`.
- The owner confirmed that adding `--disable-raf-throttling` and the other Chromium flags did not fix the observed freeze. That is consistent with the explicit MZ focus gate: keeping animation frames scheduled does not force MZ's scene to update.

### Implemented
- In NW.js only, Coop-Pl now overrides `SceneManager.isGameActive()` to return true. This keeps map/event/sprite scene updates running in the background. Non-NW.js environments retain the original check.
- Added an automated regression test for the NW.js override and browser fallback.
- The manual test guide now requires replacing the plugin in both test exports and restarting both clients; existing Chromium flags can remain but were not sufficient on their own.

### Verification status
- Automated CI and syntax/test status must be recorded from the run triggered by this code change.
- A real two-client RPG Maker MZ test is still required. Do not mark the background-window issue as fixed until the owner confirms the scene keeps updating while unfocused.

