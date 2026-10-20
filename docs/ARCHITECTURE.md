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

Сейчас есть ограниченный слой host-authoritative событий: гость запрашивает запуск, а хост исполняет событие один раз. Show Text и Show Choices транслируются гостям; результат выбора определяет хост. Это не делает всю модель RPG Maker общей: авторизация параллельных/autorun-событий, движение событий, промежуточные проверки, бои и переходы карт требуют отдельных механизмов.

## Границы прототипа

Есть обмен позицией/графикой, host-authoritative switch/variable/self-switch state, первый слой запуска общих событий, отображение Show Text/Show Choices и снимок группы в конце события. Не реализованы полноценная репликация event-command sequence, маршрутов персонажей, боёв/врагов, журнала квестов, переходов карты и сохранений. Нельзя считать эти возможности работающими, пока для них не добавлены тесты и проверки в настоящем MZ.

Начальная транспортная цель — доверенная локальная сеть. Сервер по умолчанию привязывается к 127.0.0.1. Для доступа с другого компьютера в одной LAN его можно явно привязать к 0.0.0.0 и разрешить порт в межсетевом экране. Прототип не содержит TLS, аутентификации, защиты от подбора кодов комнаты или публичного рейт-лимитинга; его нельзя напрямую выставлять в публичный Интернет.

## Решения для следующих этапов

1. Завершить ручную проверку двух игроков, UI выбора и снимка группы в настоящем RPG Maker MZ.
2. Определить и реализовать модель маршрутов персонажей и согласованных переходов карт.
3. Спроектировать host-authoritative бои, состояние врагов и победы/награды.
4. Продумать восстановление после разрыва соединения и позднее подключение к комнате.
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
- The host executes shared commands once; guests do not run a second copy of the event command
  list. Standard Show Text (101/401) and Show Choices (102) presentation packets are relayed
  by the host to guests on the same map. The host's selected choice result is sent to guests;
  guest input cannot select a different branch. This remains presentation plus an authoritative
  decision, not replay of the event's logic: branch commands execute only on the host.
  Movement routes, battle flow, and event-driven map transfers are not yet replicated.
  Party inventory/gold/actor state is corrected from the host snapshot when the event finishes.
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

A guest that receives a party snapshot during a battle queues it and applies it after the guest
returns to the map. This avoids rewriting battle participants while a battle scene is active.
This is an end-of-event state correction, not per-command replay or transaction replication:
the host still executes shared commands once.

### Event/party synchronization boundaries

- Switches, variables and self-switches update through the existing host-authoritative world
  state channel. The party snapshot transfers event-granted items/gold and actor state after
  the host finishes the shared event.
- Custom plugin-owned actor/party fields are outside the snapshot schema and need explicit
  adapters before they can be considered synchronized.
- The host must still be on the same map to accept a guest's map-event request. An interrupted
  shared event is not resumed after host migration.

## Shared event UI relay — 2026-10-20

The host relays standard Show Text commands (101/401) and Show Choices (102) from a host-owned
shared map/common event to guests on the same map. The server validates presentation fields and
accepts these packets only from the room host. Guests queue incoming UI until their message
window is available.

For Show Choices, the host's selection is sent as an authoritative result. While waiting, the
guest cannot move the cursor, use touch input or accept a local result. When the result arrives,
the guest's non-interactive window is automatically acknowledged and closed. If the result
arrives before RPG Maker MZ starts the native choice window, the plugin reapplies the host's
result after native start and then acknowledges it, avoiding a stale local default selection.

This is not event-command replay. Only the host evaluates conditional branches and runs commands
inside those branches. Checks that depend on party/inventory values, variable expansion differences,
parallel/autorun interactions, character routes, battle flow and event-driven map transfers are
not guaranteed to remain in sync. Choice and text UI packets only contain bounded presentation
data, not scripts or executable commands.
