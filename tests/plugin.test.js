"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const pluginPath = path.join(__dirname, "..", "plugin", "CoopPl_Core.js");
const pluginSource = fs.readFileSync(pluginPath, "utf8");

class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static latest = null;

    constructor(url) {
        this.url = url;
        this.readyState = FakeWebSocket.CONNECTING;
        this.listeners = new Map();
        this.sent = [];
        FakeWebSocket.latest = this;
    }

    addEventListener(type, callback) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(callback);
    }

    emit(type, event = {}) {
        for (const callback of (this.listeners.get(type) || [])) callback(event);
    }

    send(payload) {
        if (this.readyState !== FakeWebSocket.OPEN) throw new Error("socket is not open");
        this.sent.push(JSON.parse(payload));
    }

    open() {
        this.readyState = FakeWebSocket.OPEN;
        this.emit("open");
    }

    receive(message) {
        this.emit("message", { data: JSON.stringify(message) });
    }

    close(code = 1000) {
        this.readyState = FakeWebSocket.CLOSED;
        this.emit("close", { code });
    }
}

class FakeGameCharacter {
    constructor() {
        this._x = 0;
        this._y = 0;
        this._realX = 0;
        this._realY = 0;
        this._characterName = "";
        this._characterIndex = 0;
        this._direction = 2;
        this._pattern = 1;
        this._transparent = false;
    }

    setThrough(value) { this._through = value; }
    setPriorityType(value) { this._priorityType = value; }
    characterName() { return this._characterName; }
    characterIndex() { return this._characterIndex; }
    setImage(name, index) {
        this._characterName = name;
        this._characterIndex = index;
    }
    setDirection(value) { this._direction = value; }
    direction() { return this._direction; }
    setPattern(value) { this._pattern = value; }
    pattern() { return this._pattern; }
}

class FakeGameSwitches {
    constructor() { this._data = []; }
    value(id) { return Boolean(this._data[id]); }
    setValue(id, value) {
        if (id > 0) {
            this._data[id] = Boolean(value);
            this.onChange();
        }
    }
    onChange() {}
}

class FakeGameVariables {
    constructor() { this._data = []; }
    value(id) { return this._data[id] || 0; }
    setValue(id, value) {
        if (id > 0) {
            this._data[id] = typeof value === "number" ? Math.floor(value) : value;
            this.onChange();
        }
    }
    onChange() {}
}

class FakeSceneMap {
    start() {}
    update() {}
}

class FakeSpriteCharacter {
    constructor(character) {
        this.character = character;
        this.parent = null;
        this.destroyed = false;
    }
    destroy() { this.destroyed = true; }
}

class FakeSpritesetMap {
    constructor() {
        this._tilemap = {
            children: [],
            addChild(sprite) {
                sprite.parent = this;
                this.children.push(sprite);
            },
            removeChild(sprite) {
                this.children = this.children.filter(child => child !== sprite);
                sprite.parent = null;
            }
        };
    }
    update() {}
}

class FakeGameEvent {
    constructor(id, local = false) {
        this._eventId = id; this._trigger = 0; this.x = 8; this.y = 7;
        this._starting = false; this.startCount = 0;
        this._data = { id, name: "Event " + id, note: "",
            pages: [{ list: local
                ? [{ code: 108, indent: 0, parameters: ["<CoopLocal>"] }]
                : [{ code: 0, indent: 0, parameters: [] }] }] };
    }
    event() { return this._data; }
    eventId() { return this._eventId; }
    isTriggerIn(triggers) { return triggers.includes(this._trigger); }
    isStarting() { return this._starting; }
    start() { this._starting = true; this.startCount += 1; }
}
function makeRuntime() {
    FakeWebSocket.latest = null;
    const commands = new Map();
    const player = {
        x: 8,
        y: 6,
        _realX: 8,
        _realY: 6,
        direction: () => 2,
        characterName: () => "player",
        characterIndex: () => 0,
        pattern: () => 1
    };
    const map = {
        _events: new Map(),
        mapId: () => 1,
        event(id) { return this._events.get(id) || null; }
    };
    const windowObject = { addEventListener() {} };
    const context = vm.createContext({
        console,
        URL,
        setTimeout,
        clearTimeout,
        WebSocket: FakeWebSocket,
        window: windowObject,
        PluginManager: {
            parameters: () => ({
                ServerUrl: "ws://127.0.0.1:8080",
                RoomCode: "TEST_ROOM",
                PlayerName: "Local",
                AutoConnect: "true",
                SendIntervalFrames: "6",
                ReconnectDelayMs: "3000",
                SyncSwitchesVariables: "true"
            }),
            registerCommand(pluginName, commandName, callback) {
                commands.set(commandName, callback);
            }
        },
        Game_Character: FakeGameCharacter,
        Game_Event: FakeGameEvent,
        Game_Switches: FakeGameSwitches,
        Game_Variables: FakeGameVariables,
        Scene_Map: FakeSceneMap,
        Spriteset_Map: FakeSpritesetMap,
        Sprite_Character: FakeSpriteCharacter,
        $gamePlayer: player,
        $gameMap: map,
        $gameSwitches: new FakeGameSwitches(),
        $gameVariables: new FakeGameVariables(),
        $gameSelfSwitches: null,
        $dataSystem: {
            switches: Array(32).fill(""),
            variables: Array(32).fill("")
        },
        Graphics: { frameCount: 10 }
    });

    vm.runInContext(pluginSource, context, { filename: pluginPath });
    return { context, commands, player, map, windowObject };
}

test("plugin connects, sends local state, renders remote sprite and removes it on leave", () => {
    const runtime = makeRuntime();
    const scene = new runtime.context.Scene_Map();
    scene.start();

    const socket = FakeWebSocket.latest;
    assert.ok(socket, "Scene_Map.start should open a WebSocket connection");
    assert.equal(socket.url, "ws://127.0.0.1:8080");

    socket.open();
    assert.equal(socket.sent.length, 1);
    assert.equal(socket.sent[0].type, "join");
    assert.equal(socket.sent[0].room, "TEST_ROOM");
    assert.equal(socket.sent[0].name, "Local");
    assert.equal(socket.sent[0].state.mapId, 1);

    const localState = {
        mapId: 1, x: 8, y: 6, realX: 8, realY: 6,
        direction: 2, characterName: "player", characterIndex: 0, pattern: 1
    };
    const remoteState = {
        mapId: 1, x: 4, y: 5, realX: 4, realY: 5,
        direction: 4, characterName: "player", characterIndex: 1, pattern: 2
    };

    socket.receive({
        type: "welcome",
        playerId: "local-id",
        room: "TEST_ROOM",
        hostId: "local-id",
        isHost: true,
        players: [
            { playerId: "local-id", name: "Local", state: localState },
            { playerId: "remote-id", name: "Remote", state: remoteState }
        ]
    });

    assert.equal(runtime.windowObject.CoopPl.status().connected, true);
    assert.equal(runtime.windowObject.CoopPl.status().remotePlayerCount, 1);

    const spriteset = new runtime.context.Spriteset_Map();
    spriteset.update();

    assert.equal(spriteset._tilemap.children.length, 1);
    const sprite = spriteset._tilemap.children[0];
    assert.equal(sprite.character.characterName(), "player");
    assert.equal(sprite.character.characterIndex(), 1);
    assert.equal(sprite.character.isTransparent(), false);
    assert.equal(sprite.character.direction(), 4);
    assert.equal(sprite.character.pattern(), 2);

    socket.receive({ type: "player_left", playerId: "remote-id" });
    spriteset.update();
    assert.equal(spriteset._tilemap.children.length, 0);
    assert.equal(sprite.destroyed, true);

    runtime.windowObject.CoopPl.disconnect();
    assert.equal(runtime.windowObject.CoopPl.status().connected, false);
});

test("plugin registers connect and disconnect event commands", () => {
    const runtime = makeRuntime();
    assert.equal(typeof runtime.commands.get("Connect"), "function");
    assert.equal(typeof runtime.commands.get("Disconnect"), "function");
});


test("guest requests shared switch and variable changes; authoritative updates apply without echo", () => {
    const runtime = makeRuntime();
    const scene = new runtime.context.Scene_Map();
    scene.start();
    const socket = FakeWebSocket.latest;
    socket.open();

    socket.receive({
        type: "welcome",
        playerId: "guest-id",
        room: "TEST_ROOM",
        hostId: "host-id",
        isHost: false,
        players: [],
        world: {
            revision: 3,
            switches: { "2": true },
            variables: { "3": 42 }
        }
    });

    assert.equal(runtime.context.$gameSwitches.value(2), true);
    assert.equal(runtime.context.$gameVariables.value(3), 42);
    assert.equal(runtime.windowObject.CoopPl.status().worldRevision, 3);

    runtime.context.$gameSwitches.setValue(5, true);
    assert.equal(runtime.context.$gameSwitches.value(5), false,
        "guest change is not applied optimistically");
    assert.equal(socket.sent.at(-1).type, "world_request");
    assert.equal(socket.sent.at(-1).kind, "switch");
    assert.equal(socket.sent.at(-1).id, 5);
    assert.equal(socket.sent.at(-1).value, true);

    socket.receive({
        type: "world_change",
        revision: 4,
        kind: "switch",
        id: 5,
        value: true
    });
    assert.equal(runtime.context.$gameSwitches.value(5), true);
    assert.equal(runtime.windowObject.CoopPl.status().worldRevision, 4);
    assert.equal(socket.sent.filter(message => message.type === "world_request").length, 1,
        "applying a server update must not echo another request");

    runtime.context.$gameVariables.setValue(4, 123);
    assert.equal(runtime.context.$gameVariables.value(4), 0);
    assert.equal(socket.sent.at(-1).type, "world_request");
    assert.equal(socket.sent.at(-1).kind, "variable");
    assert.equal(socket.sent.at(-1).id, 4);
    assert.equal(socket.sent.at(-1).value, 123);

    socket.receive({
        type: "world_change",
        revision: 5,
        kind: "variable",
        id: 4,
        value: 123
    });
    assert.equal(runtime.context.$gameVariables.value(4), 123);
    assert.equal(runtime.windowObject.CoopPl.status().worldRevision, 5);

    runtime.windowObject.CoopPl.disconnect();
});


test("guest requests host execution for shared map events but keeps local-tagged events local", () => {
    const runtime = makeRuntime();
    const scene = new runtime.context.Scene_Map();
    scene.start();
    const socket = FakeWebSocket.latest;
    socket.open();
    socket.receive({
        type: "welcome", playerId: "guest-id", room: "TEST_ROOM",
        hostId: "host-id", isHost: false, players: [],
        world: { revision: 0, switches: {}, variables: {} }
    });
    const shared = new runtime.context.Game_Event(7, false);
    runtime.map._events.set(7, shared);
    shared.start();
    assert.equal(shared.startCount, 0);
    const request = socket.sent.find(m => m.type === "event_request" && m.kind === "map");
    assert.ok(request);
    assert.equal(request.eventId, 7);
    socket.receive({
        type: "event_result", requestId: request.requestId, kind: "map",
        mapId: 1, eventId: 7, accepted: false, reason: "EVENT_NOT_AVAILABLE"
    });
    assert.equal(runtime.windowObject.CoopPl.status().pendingEventCount, 0);
    const local = new runtime.context.Game_Event(8, true);
    runtime.map._events.set(8, local);
    local.start();
    assert.equal(local.startCount, 1);
    assert.equal(socket.sent.filter(m => m.type === "event_request").length, 1);
    runtime.windowObject.CoopPl.disconnect();
});


test("guest applies authoritative party snapshot and defers it while a battle is active", () => {
    const runtime = makeRuntime();
    const actors = {};
    const makeActor = actorId => ({
        _actorId: actorId,
        _classId: 1,
        _expValue: 0,
        _hp: 1,
        _mp: 1,
        _tp: 0,
        _skills: [],
        _states: [],
        _stateTurns: {},
        _buffs: [0, 0],
        _buffTurns: [0, 0],
        _equips: [null, null],
        _name: "Actor " + actorId,
        actorId() { return this._actorId; },
        currentClass() { return { id: this._classId }; },
        changeClass(id) { this._classId = id; },
        changeExp(exp) { this._expValue = exp; },
        setName(name) { this._name = name; },
        name() { return this._name; },
        equips() { return this._equips; },
        forceChangeEquip(slot, item) { this._equips[slot] = item; },
        refresh() {},
        setHp(value) { this._hp = value; },
        setMp(value) { this._mp = value; },
        setTp(value) { this._tp = value; }
    });
    actors[1] = makeActor(1);
    actors[2] = makeActor(2);
    actors[99] = makeActor(99);

    runtime.context.$gameActors = { actor(id) { return actors[id] || null; } };
    runtime.context.$gameParty = {
        _actors: [1, 99],
        _gold: 0,
        _items: {},
        _weapons: {},
        _armors: {},
        _inBattle: true,
        inBattle() { return this._inBattle; },
        gold() { return this._gold; },
        removeActor(id) { this._actors = this._actors.filter(actorId => actorId !== id); },
        addActor(id) { if (!this._actors.includes(id)) this._actors.push(id); }
    };
    const weapon = { id: 1, wtypeId: 1, name: "Test Sword" };
    const armor = { id: 1, atypeId: 1, name: "Test Shield" };
    runtime.context.$dataWeapons = [null, weapon];
    runtime.context.$dataArmors = [null, armor];

    const scene = new runtime.context.Scene_Map();
    scene.start();
    const socket = FakeWebSocket.latest;
    socket.open();
    socket.receive({
        type: "welcome", playerId: "guest-id", room: "TEST_ROOM",
        hostId: "host-id", isHost: false, players: [],
        world: { revision: 0, switches: {}, variables: {}, selfSwitches: {} }
    });

    const partySnapshot = {
        gold: 250,
        items: { "1": 3 },
        weapons: {},
        armors: { "1": 1 },
        actors: [{
            actorId: 1,
            classId: 1,
            exp: 450,
            hp: 27,
            mp: 11,
            tp: 20,
            states: [2],
            stateTurns: { "2": 3 },
            skills: [1, 5],
            buffs: [0, 1],
            buffTurns: [0, 4],
            equips: [{ kind: "weapon", id: 1 }, null],
            name: "Hero"
        }, {
            actorId: 2,
            classId: 1,
            exp: 0,
            hp: 16,
            mp: 4,
            tp: 0,
            states: [],
            stateTurns: {},
            skills: [],
            buffs: [0, 0],
            buffTurns: [0, 0],
            equips: [null, { kind: "armor", id: 1 }],
            name: "Mage"
        }]
    };

    socket.receive({ type: "party_snapshot", party: partySnapshot });
    assert.deepEqual(runtime.context.$gameParty._actors, [1, 99],
        "party snapshots are queued during battle rather than mutating an active battle");
    assert.equal(runtime.context.$gameParty._gold, 0);

    runtime.context.$gameParty._inBattle = false;
    scene.update();
    assert.deepEqual(runtime.context.$gameParty._actors, [1, 2]);
    assert.equal(runtime.context.$gameParty._gold, 250);
    assert.equal(runtime.context.$gameParty._items["1"], 3);
    assert.equal(runtime.context.$gameParty._armors["1"], 1);
    assert.equal(actors[1]._expValue, 450);
    assert.equal(actors[1]._hp, 27);
    assert.equal(actors[1]._mp, 11);
    assert.equal(actors[1]._tp, 20);
    assert.equal(actors[1]._states.join(","), "2");
    assert.equal(actors[1]._stateTurns["2"], 3);
    assert.equal(actors[1]._skills.join(","), "1,5");
    assert.equal(actors[1]._equips[0], weapon);
    assert.equal(actors[2]._equips[1], armor);
    runtime.windowObject.CoopPl.disconnect();
});
