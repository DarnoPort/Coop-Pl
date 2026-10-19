# Coop-Pl — кооперативный плагин для RPG Maker MZ

Здесь разрабатывается сетевой кооператив для RPG Maker MZ. Основная работа ведётся в отдельной ветке по правилам исследовательского репозитория Co-op Anything.

## Актуальная ветка разработки

**[game/rpg-maker-mz-coop](https://github.com/DarnoPort/Coop-Pl/tree/game/rpg-maker-mz-coop)**

В ней находятся исходник плагина, WebSocket-сервер, тесты и документация. Код пока является прототипом: полноценный кооператив и запуск в двух экземплярах RPG Maker MZ ещё не подтверждены.

- [Статус и журнал работ](https://github.com/DarnoPort/Coop-Pl/blob/game/rpg-maker-mz-coop/docs/STATUS.md)
- [Архитектура](https://github.com/DarnoPort/Coop-Pl/blob/game/rpg-maker-mz-coop/docs/ARCHITECTURE.md)
- [Инструкция по тестированию](https://github.com/DarnoPort/Coop-Pl/blob/game/rpg-maker-mz-coop/docs/TESTING.md)
- [Плагин CoopPl_Core.js](https://github.com/DarnoPort/Coop-Pl/blob/game/rpg-maker-mz-coop/plugin/CoopPl_Core.js)

## Первичная цель

Первый вертикальный срез: подключить два клиента, отобразить второго персонажа на той же карте, синхронизировать позицию и направление, а затем корректно обработать выход и переподключение. Сюжет, события, инвентарь и бои будут добавляться отдельными проверяемыми этапами.

Первый проект совместимости — Michael Way – Double Way, RPG Maker MZ 1.10.0. Его игровые данные и ресурсы намеренно не хранятся в этом репозитории.
