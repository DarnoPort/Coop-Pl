# Архитектура Coop-Pl

Дата первичного проектирования: 2026-10-19.

## Подтверждённая среда

- Проект для первого интеграционного теста: Michael Way – Double Way.
- Файл проекта указывает RPG Maker MZ 1.10.0.
- В предоставленном архиве js/plugins.js содержит пустой список подключённых плагинов.
- В архиве есть Map001 и два актёра в Actors.json; события карты в Map001 отсутствуют.
- Проверено по предоставленному архиву, но игра ещё не запускалась с Coop-Pl.

## Схема первого прототипа

RPG Maker MZ client A ── WebSocket ──┐
                                     ├── Coop-Pl room server
RPG Maker MZ client B ── WebSocket ──┘

Сервер пересылает обновления положения и графики между участниками комнаты. Он назначает ID игрокам, создаёт кодовые комнаты, ограничивает размеры сообщений и проверяет поля пакетов.

## Текущий сетевой протокол

- join: room, display name, initial player state, sequence number.
- welcome: player ID, room, host ID, host flag and current player snapshot.
- player_joined / player_left: membership changes.
- state: map ID, tile and real coordinates, direction, character sheet name/index and walking pattern.
- world_snapshot: current host's sparse snapshot of switches and supported variables.
- world_request: guest request to change one switch or variable, routed only to the host.
- world_change: host-authorized change broadcast to all clients with monotonically increasing room revision.
- world_snapshot_ack: revision acknowledgement returned to the host.
- host_changed: выбор нового владельца комнаты при отключении первого участника.
- error: код и описание ошибки.

Все сетевые данные рассматриваются как недоверенные. Сервер принимает только перечисленные типы сообщений и не выполняет игровые команды, присланные клиентом.

## Синхронизация общих переключателей и переменных

Текущий хост является единственным автором подтверждённого состояния switch/variable. При соединении он передаёт разреженный снимок: включённые переключатели и переменные, у которых задано нетривиальное значение. Сервер хранит снимок с ревизией и передаёт его поздно подключившимся участникам.

Изменения, выполненные на хосте через Game_Switches.setValue / Game_Variables.setValue, публикуются серверу. Изменение, инициированное гостем, перехватывается и отправляется как world_request; сервер пересылает его только текущему хосту. Хост применяет запрос через штатный setter, публикует world_change, а сервер увеличивает ревизию и рассылает подтверждённое значение. Клиент, получающий world_change, применяет его в режиме подавления исходящих сетевых сообщений, чтобы не возникала петля эха.

Переключатели по умолчанию выключены, неназначенные переменные равны 0; снимок очищает гостевые массивы перед применением авторитетных значений. Изменения мира на госте не применяются оптимистично: они вступают в силу после подтверждения хоста. Если сеть отключена, клиент снова использует обычное локальное поведение до переподключения.

В сетевом состоянии поддерживаются только JSON-примитивы для переменных: finite number, string ограниченной длины, boolean и null. Сторонние плагины, хранящие в Game_Variables объекты или массивы, могут ожидать локальную семантику и пока не поддерживаются синхронизацией.

Это не даёт хосту авторитетность над выполнением событий: одинаковая страница события или autorun/parallel event всё ещё может исполняться в обоих клиентах. Общее владение event-интерпретаторами, наградами и переносами между картами — отдельный этап.

## Границы прототипа

Уже есть обмен позицией/графикой и host-authoritative switch/variable state. Пока не реализованы общая синхронизация выполнения событий, инвентаря, боёв, врагов, здоровья, опыта, наград, журнала квестов, переходов карты и сохранений. Эти возможности нельзя считать работающими, пока не добавлены отдельные тесты.

Начальная транспортная цель — доверенная локальная сеть. Сервер по умолчанию привязывается к 127.0.0.1. Для доступа с другого компьютера в одной LAN его можно явно привязать к 0.0.0.0 и разрешить порт в межсетевом экране. Прототип не содержит TLS, аутентификации, защиты от подбора кодов комнаты или публичного рейт-лимитинга; его нельзя напрямую выставлять в публичный Интернет.

## Решения для следующих этапов

1. Проверить двух игроков в одной комнате и корректное удаление sprite после выхода.
2. Решить, какие игровые данные имеют общий статус, а какие личные.
3. Синхронизировать действия через host-authority и подавлять повторный запуск event-команд на гостях.
4. Определить стратегию для боёв, переходов между картами, позднего подключения и восстановления после разрыва соединения.
5. Только после LAN-прототипа спроектировать безопасное интернет-соединение: TLS, идентификация комнаты и игроков, лимиты и проверка сетевого ввода.


## Shared-event execution model — first implementation (2026-10-20)

The room host owns shared map-event execution. A guest can request activation of a map
event whose trigger is Action Button, Player Touch, or Event Touch. The server routes the
request to the host and locks that event key until the host's main map interpreter finishes
the event. The host verifies that it is on the same map, the event exists and is triggerable,
and the requester is within a basic tile range. If the event is busy, missing, or out of
range, the request is rejected rather than executed a second time.

Shared parallel map events and parallel common events are suppressed on guests. A guest
calling a trigger-None common event requests execution on the host and waits for the host
to report completion. Shared autorun common events remain host-owned. The server only
routes validated requests and maintains event locks; it does not run game scripts.

Add a comment command containing \`<CoopLocal>\` to an event or common event to keep its
commands local to each client. Use this only for visual/player-specific effects, not shared
rewards or shared story state.

Self-switches \`[mapId,eventId,A-D]\` are now part of the host-authoritative sparse world
snapshot and incremental changes, allowing switch-controlled event pages to converge.

### Current boundaries

- The host must be on the same map for a guest map-event request to be accepted.
- The host executes shared commands once, but this first layer does not replay the event
  command list on guests. Dialogue, choices, movement routes, battle flow, and map transfers
  initiated by event commands are not yet replicated. Party inventory/gold/actor state is
  corrected from the host snapshot when the shared event finishes; it is not replicated
  command-by-command while the event is running.
- Range validation uses the most recently received player position and simple tile rules;
  counters, looping maps, custom radii, and plugin-specific triggers are not handled.
- Pending event requests are cleared on disconnect/host migration; partially executed
  events are not resumed after host migration.


## Authoritative party snapshots — 2026-10-20

The host sends a validated party snapshot when it joins the room and whenever a host-owned
shared event finishes. The server caches the latest snapshot for guests that join later and
relays updates to connected guests. Party snapshots contain party order, gold, item/weapon/
armor inventory, actor class and EXP, HP/MP/TP, states and state turns, skills, buffs and
equipment. Values are bounded and shape-validated by \`normalizePartySnapshot\`.

A guest that receives a party snapshot during a battle queues it and applies it after the
guest returns to the map. That avoids rewriting battle participants while a battle scene is
active. This is an end-of-event state correction, not per-command replay or transaction
replication: the host still executes the shared event only once.

### Event/party synchronization boundaries

- Switches, variables and self-switches update through the existing host-authoritative world
  state channel. The party snapshot transfers event-granted items/gold and actor state after
  the host finishes the shared event.
- The event command list is not replayed on guests. Dialogue, choice windows, character route
  animation, intermediate checks based on party/inventory state, battle flow, enemy state and
  map transfers are not yet replicated.
- Custom plugin-owned actor/party fields are outside the snapshot schema and need explicit
  adapters before they can be considered synchronized.
- Host must still be on the same map to accept a guest's map-event request. An interrupted
  shared event is not resumed after host migration.
