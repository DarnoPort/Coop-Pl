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
        this._opacity = 255;
        this._priorityType = 1;
    }

    setThrough(value) { this._through = value; }
    setPriorityType(value) { this._priorityType = value; }
    priorityType() { return this._priorityType; }
    setOpacity(value) { this._opacity = value; }
    opacity() { return this._opacity; }
    setTransparent(value) { this._transparent = Boolean(value); }
    isTransparent() { return this._transparent; }
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

class FakeGameMessage {
    constructor() {
        this.busy = false;
        this.faceName = "";
        this.faceIndex = 0;
        this.background = 0;
        this.positionType = 2;
        this.texts = [];
        this.choices = [];
        this.choiceCallback = null;
        this._choiceCallback = null;
        this.choiceBackground = 0;
        this.choicePositionType = 2;
        this.defaultType = -1;
        this.cancelType = -2;
    }
    isBusy() { return this.busy || this.texts.length > 0 || this.choices.length > 0; }
    setFaceImage(name, index) { this.faceName = name; this.faceIndex = index; }
    setBackground(value) { this.background = value; }
    setPositionType(value) { this.positionType = value; }
    add(text) { this.texts.push(text); }
    setChoices(choices, defaultType, cancelType) {
        this.choices = choices.slice();
        this.defaultType = defaultType;
        this.cancelType = cancelType;
    }
    setChoiceBackground(value) { this.choiceBackground = value; }
    setChoicePositionType(value) { this.choicePositionType = value; }
    setChoiceCallback(callback) {
        this.choiceCallback = callback;
        this._choiceCallback = callback;
    }
    onChoice(result) {
        const callback = this.choiceCallback;
        this.choiceCallback = null;
        this._choiceCallback = null;
        this.choices = [];
        if (callback) callback(result);
    }
}

class FakeGameInterpreter {
    constructor() {
        this._params = [];
        this._list = [];
        this._index = 0;
        this._eventId = 0;
        this._childInterpreter = null;
        this._lastChoice = null;
        this.gameMessage = null;
    }
    command101(params) {
        if (!Array.isArray(params)) throw new TypeError("MZ command101 requires params");
        this.lastCommand101Params = params;
        return true;
    }
    command117(params) {
        if (!Array.isArray(params)) throw new TypeError("MZ command117 requires params");
        this.lastCommand117Params = params;
        return true;
    }
    setupChoices(params) {
        this.gameMessage.setChoices(params[0].slice(), params[2], params[1]);
        this.gameMessage.setChoicePositionType(params[3] === undefined ? 2 : params[3]);
        this.gameMessage.setChoiceBackground(params[4] === undefined ? 0 : params[4]);
        this.gameMessage.setChoiceCallback(result => { this._lastChoice = result; });
    }
    setupChild(list, eventId) {
        this._childInterpreter = new FakeGameInterpreter();
        this._childInterpreter.gameMessage = this.gameMessage;
        this._childInterpreter._list = list;
        this._childInterpreter._eventId = eventId;
    }
    updateWaitMode() { return false; }
    terminate() { return true; }
}

class FakeWindowChoiceList {
    constructor(gameMessage) {
        this.gameMessage = gameMessage;
        this.selectedIndex = -1;
        this.startCalls = 0;
        this.handlingCalls = 0;
        this.cursorCalls = 0;
        this.touchCalls = 0;
        this.okCalls = 0;
        this.cancelCalls = 0;
    }
    start() {
        this.startCalls += 1;
        // Simulate MZ's native start behavior, which selects the configured default.
        const defaultIndex = this.gameMessage.defaultType >= 0 ? this.gameMessage.defaultType : 0;
        this.select(defaultIndex);
    }
    processHandling() { this.handlingCalls += 1; }
    processCursorMove() { this.cursorCalls += 1; }
    processTouch() { this.touchCalls += 1; }
    processOk() {
        this.okCalls += 1;
        this.gameMessage.onChoice(this.selectedIndex);
    }
    processCancel() {
        this.cancelCalls += 1;
        this.gameMessage.onChoice(-1);
    }
    select(index) { this.selectedIndex = index; }
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

class FakeGameEvent extends FakeGameCharacter {
    constructor(id, local = false) {
        super();
        this._eventId = id;
        this._trigger = 0;
        this.x = 8;
        this.y = 7;
        this._realX = 8;
        this._realY = 7;
        this._starting = false;
        this.startCount = 0;
        this.selfMoveUpdates = 0;
        this._erased = false;
        this._data = {
            id, name: "Event " + id, note: "",
            pages: [{ list: local
                ? [{ code: 108, indent: 0, parameters: ["<CoopLocal>"] }]
                : [{ code: 0, indent: 0, parameters: [] }] }]
        };
    }
    event() { return this._data; }
    eventId() { return this._eventId; }
    isTriggerIn(triggers) { return triggers.includes(this._trigger); }
    isStarting() { return this._starting; }
    start() { this._starting = true; this.startCount += 1; }
    updateSelfMovement() { this.selfMoveUpdates += 1; }
    isErased() { return this._erased; }
    erase() { this._erased = true; }
    refresh() {}
}
function makeRuntime() {
    FakeWebSocket.latest = null;
    // The plugin patches engine prototypes during load. Each mock runtime needs its
    // own subclass so hooks from one simulated client cannot leak into another test.
    const RuntimeGameCharacter = class extends FakeGameCharacter {};
    const RuntimeGameEvent = class extends FakeGameEvent {};
    const RuntimeGameInterpreter = class extends FakeGameInterpreter {};
    const RuntimeWindowChoiceList = class extends FakeWindowChoiceList {};
    const RuntimeGameSwitches = class extends FakeGameSwitches {};
    const RuntimeGameVariables = class extends FakeGameVariables {};
    const RuntimeSceneMap = class extends FakeSceneMap {};
    const RuntimeSpritesetMap = class extends FakeSpritesetMap {};
    const RuntimeSpriteCharacter = class extends FakeSpriteCharacter {};
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
        events() { return Array.from(this._events.values()); },
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
        Game_Character: RuntimeGameCharacter,
        Game_Event: RuntimeGameEvent,
        Game_Interpreter: RuntimeGameInterpreter,
        Window_ChoiceList: RuntimeWindowChoiceList,
        SceneManager: { _scene: null },
        Game_Switches: RuntimeGameSwitches,
        Game_Variables: RuntimeGameVariables,
        Scene_Map: RuntimeSceneMap,
        Spriteset_Map: RuntimeSpritesetMap,
        Sprite_Character: RuntimeSpriteCharacter,
        $gamePlayer: player,
        $gameMap: map,
        $gameSwitches: new RuntimeGameSwitches(),
        $gameVariables: new RuntimeGameVariables(),
        $gameSelfSwitches: null,
        $gameMessage: new FakeGameMessage(),
        $dataCommonEvents: [null],
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

test("host publishes authoritative map-event states and excludes CoopLocal events", () => {
    const runtime = makeRuntime();
    const shared = new runtime.context.Game_Event(2);
    shared.x = 4; shared.y = 5; shared._realX = 4.25; shared._realY = 5;
    shared.setImage("Npc", 1); shared.setDirection(6); shared.setPattern(2);
    shared.setOpacity(180); shared.setPriorityType(2);
    runtime.map._events.set(2, shared);
    runtime.map._events.set(3, new runtime.context.Game_Event(3, true));
    const scene = new runtime.context.Scene_Map();
    scene.start();
    const socket = FakeWebSocket.latest;
    socket.open();
    socket.receive({
        type: "welcome", playerId: "host-id", room: "TEST_ROOM",
        hostId: "host-id", isHost: true, players: [],
        world: { revision: 0, switches: {}, variables: {}, selfSwitches: {} }
    });
    runtime.context.Graphics.frameCount = 20;
    scene.update();
    const packet = socket.sent.find(message => message.type === "event_states");
    assert.ok(packet);
    assert.equal(packet.mapId, 1);
    assert.equal(packet.events.length, 1);
    assert.equal(packet.events[0].eventId, 2);
    assert.equal(packet.events[0].x, 4);
    assert.equal(packet.events[0].y, 5);
    assert.equal(packet.events[0].realX, 4.25);
    assert.equal(packet.events[0].characterName, "Npc");
    assert.equal(packet.events[0].characterIndex, 1);
    assert.equal(packet.events[0].pattern, 2);
    assert.equal(packet.events[0].opacity, 180);
    assert.equal(packet.events[0].priorityType, 2);
    runtime.windowObject.CoopPl.disconnect();
});

test("guest applies host event positions and visuals, interpolates movement, and leaves CoopLocal events alone", () => {
    const runtime = makeRuntime();
    const shared = new runtime.context.Game_Event(2);
    const local = new runtime.context.Game_Event(3, true);
    runtime.map._events.set(2, shared);
    runtime.map._events.set(3, local);
    const scene = new runtime.context.Scene_Map();
    scene.start();
    const socket = FakeWebSocket.latest;
    socket.open();
    socket.receive({
        type: "welcome", playerId: "guest-id", room: "TEST_ROOM",
        hostId: "host-id", isHost: false,
        players: [{
            playerId: "host-id", name: "Host",
            state: {
                mapId: 1, x: 8, y: 6, realX: 8, realY: 6,
                direction: 2, characterName: "player", characterIndex: 0, pattern: 1
            }
        }],
        world: { revision: 0, switches: {}, variables: {}, selfSwitches: {} }
    });
    const firstState = {
        eventId: 2, x: 4, y: 5, realX: 4, realY: 5, direction: 6,
        characterName: "Npc", characterIndex: 1, pattern: 2,
        transparent: false, opacity: 180, priorityType: 2, erased: false
    };
    socket.receive({ type: "event_states", mapId: 1, events: [firstState] });
    assert.equal(shared._x, 4);
    assert.equal(shared._y, 5);
    assert.equal(shared._realX, 4);
    assert.equal(shared._realY, 5);
    assert.equal(shared.direction(), 6);
    assert.equal(shared.characterName(), "Npc");
    assert.equal(shared.characterIndex(), 1);
    assert.equal(shared.pattern(), 2);
    assert.equal(shared.opacity(), 180);
    assert.equal(shared.priorityType(), 2);
    socket.receive({
        type: "event_states", mapId: 1,
        events: [{ ...firstState, x: 5, realX: 5, direction: 4, pattern: 1 }]
    });
    const spriteset = new runtime.context.Spriteset_Map();
    spriteset.update();
    assert.equal(shared._x, 5);
    assert.ok(Math.abs(shared._realX - 4.35) < 0.0001);
    assert.equal(shared.direction(), 4);
    assert.equal(shared.pattern(), 1);
    shared.updateSelfMovement();
    local.updateSelfMovement();
    assert.equal(shared.selfMoveUpdates, 0);
    assert.equal(local.selfMoveUpdates, 1);
    assert.equal(local._coopEventStateInitialized, undefined);
    runtime.windowObject.CoopPl.disconnect();
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



test("host mirrors Show Text from shared interpreters and propagates context to child interpreters", () => {
    const runtime = makeRuntime();
    const scene = new runtime.context.Scene_Map();
    scene.start();
    const socket = FakeWebSocket.latest;
    socket.open();
    socket.receive({
        type: "welcome", playerId: "host-id", room: "TEST_ROOM",
        hostId: "host-id", isHost: true, players: [],
        world: { revision: 0, switches: {}, variables: {}, selfSwitches: {} }
    });

    const interpreter = new runtime.context.Game_Interpreter();
    interpreter._coopEventKind = "map";
    interpreter._coopEventMapId = 1;
    interpreter._coopEventId = 7;
    interpreter._params = ["Actor1", 2, 1, 0];
    interpreter._list = [
        { code: 101, parameters: ["Actor1", 2, 1, 0] },
        { code: 401, parameters: ["Host-only command execution, shared display."] },
        { code: 401, parameters: ["Second line."] },
        { code: 0, parameters: [] }
    ];
    interpreter._index = 0;
    interpreter.command101(["Actor1", 2, 1, 0]);

    const packet = socket.sent.find(message => message.type === "event_ui");
    assert.ok(packet);
    assert.equal(packet.kind, "map");
    assert.equal(packet.eventId, 7);
    assert.equal(packet.faceName, "Actor1");
    assert.equal(packet.faceIndex, 2);
    assert.deepEqual(Array.from(packet.lines), [
        "Host-only command execution, shared display.", "Second line."
    ]);

    interpreter.setupChild([{ code: 101, parameters: [] }], 7);
    assert.equal(interpreter._childInterpreter._coopEventKind, "map");
    assert.equal(interpreter._childInterpreter._coopEventMapId, 1);
    assert.equal(interpreter._childInterpreter._coopEventId, 7);
    runtime.windowObject.CoopPl.disconnect();
});

test("guest displays host Show Text packets when the message window is free", () => {
    const runtime = makeRuntime();
    const scene = new runtime.context.Scene_Map();
    scene.start();
    const socket = FakeWebSocket.latest;
    socket.open();
    socket.receive({
        type: "welcome", playerId: "guest-id", room: "TEST_ROOM",
        hostId: "host-id", isHost: false, players: [],
        world: { revision: 0, switches: {}, variables: {}, selfSwitches: {} }
    });

    runtime.context.$gameMessage.busy = true;
    socket.receive({
        type: "event_ui", kind: "map", mapId: 1, eventId: 7, action: "show_text",
        faceName: "Actor1", faceIndex: 1, background: 2, positionType: 0,
        lines: ["Shared greeting", "Second line"]
    });
    scene.update();
    assert.deepEqual(Array.from(runtime.context.$gameMessage.texts), [],
        "shared text waits while a local message window is busy");

    runtime.context.$gameMessage.busy = false;
    scene.update();
    assert.deepEqual(Array.from(runtime.context.$gameMessage.texts), ["Shared greeting", "Second line"]);
    assert.equal(runtime.context.$gameMessage.faceName, "Actor1");
    assert.equal(runtime.context.$gameMessage.faceIndex, 1);
    assert.equal(runtime.context.$gameMessage.background, 2);
    assert.equal(runtime.context.$gameMessage.positionType, 0);
    runtime.windowObject.CoopPl.disconnect();
});


test("host publishes shared choices and broadcasts the authoritative selected branch", () => {
    const runtime = makeRuntime();
    const scene = new runtime.context.Scene_Map();
    scene.start();
    const socket = FakeWebSocket.latest;
    socket.open();
    socket.receive({
        type: "welcome", playerId: "host-id", room: "TEST_ROOM",
        hostId: "host-id", isHost: true, players: [],
        world: { revision: 0, switches: {}, variables: {}, selfSwitches: {} }
    });

    const interpreter = new runtime.context.Game_Interpreter();
    interpreter.gameMessage = runtime.context.$gameMessage;
    interpreter._coopEventKind = "map";
    interpreter._coopEventMapId = 1;
    interpreter._coopEventId = 7;
    interpreter.setupChoices([["Keep", "Leave"], -2, 0, 2, 1]);

    const choicePacket = socket.sent.find(message =>
        message.type === "event_ui" && message.action === "show_choices");
    assert.ok(choicePacket);
    assert.deepEqual(Array.from(choicePacket.choices), ["Keep", "Leave"]);
    assert.equal(choicePacket.defaultType, 0);
    assert.equal(choicePacket.background, 1);

    runtime.context.$gameMessage.onChoice(1);
    assert.equal(interpreter._lastChoice, 1);
    const resultPacket = socket.sent.find(message => message.type === "event_choice_result");
    assert.ok(resultPacket);
    assert.equal(resultPacket.choiceId, choicePacket.choiceId);
    assert.equal(resultPacket.result, 1);
    runtime.windowObject.CoopPl.disconnect();
});

test("guest shows locked host choices and automatically acknowledges the authoritative result", () => {
    const runtime = makeRuntime();
    const scene = new runtime.context.Scene_Map();
    scene.start();
    const socket = FakeWebSocket.latest;
    socket.open();
    socket.receive({
        type: "welcome", playerId: "guest-id", room: "TEST_ROOM",
        hostId: "host-id", isHost: false, players: [],
        world: { revision: 0, switches: {}, variables: {}, selfSwitches: {} }
    });
    const choiceWindow = new runtime.context.Window_ChoiceList(runtime.context.$gameMessage);
    scene._messageWindow = { _choiceListWindow: choiceWindow };
    runtime.context.SceneManager._scene = scene;

    socket.receive({
        type: "event_ui", kind: "map", mapId: 1, eventId: 7,
        action: "show_choices", choiceId: "choice-host-1",
        choices: ["Keep", "Leave"], cancelType: -2, defaultType: 0,
        positionType: 2, background: 0
    });
    scene.update();
    assert.deepEqual(Array.from(runtime.context.$gameMessage.choices), ["Keep", "Leave"]);
    assert.ok(runtime.windowObject.CoopPl.status().activeRemoteChoice);
    choiceWindow.start();
    assert.equal(choiceWindow.selectedIndex, 0, "the guest initially shows the local default before the host decides");

    choiceWindow.processHandling();
    choiceWindow.processCursorMove();
    choiceWindow.processTouch();
    assert.equal(choiceWindow.handlingCalls, 0, "guest must not accept a choice independently");
    assert.equal(choiceWindow.cursorCalls, 0, "guest must not move the authoritative selection");
    assert.equal(choiceWindow.touchCalls, 0, "guest touch input must not override the host choice");

    socket.receive({
        type: "event_choice_result", kind: "map", mapId: 1, eventId: 7,
        choiceId: "choice-host-1", result: 1
    });
    assert.equal(choiceWindow.selectedIndex, 1);
    assert.equal(choiceWindow.okCalls, 1, "the guest automatically acknowledges the host's decision");
    assert.equal(runtime.windowObject.CoopPl.status().activeRemoteChoice, null);
    assert.deepEqual(Array.from(runtime.context.$gameMessage.choices), []);

    // Regression: the host can finish choosing while the guest is still closing
    // an earlier text window. The host result then arrives before MZ calls start().
    socket.receive({
        type: "event_ui", kind: "map", mapId: 1, eventId: 8,
        action: "show_choices", choiceId: "choice-host-race",
        choices: ["Keep", "Leave"], cancelType: -2, defaultType: 0,
        positionType: 2, background: 0
    });
    scene.update();
    socket.receive({
        type: "event_choice_result", kind: "map", mapId: 1, eventId: 8,
        choiceId: "choice-host-race", result: 1
    });
    choiceWindow.start();
    assert.equal(choiceWindow.selectedIndex, 1,
        "MZ start must not overwrite the host's earlier result with the local default");
    assert.equal(choiceWindow.okCalls, 2,
        "a host result received before native start must be acknowledged automatically");
    assert.equal(runtime.windowObject.CoopPl.status().activeRemoteChoice, null);
    assert.deepEqual(Array.from(runtime.context.$gameMessage.choices), []);

    socket.receive({
        type: "event_ui", kind: "map", mapId: 1, eventId: 9,
        action: "show_choices", choiceId: "choice-host-cancel",
        choices: ["Wait", "Go"], cancelType: -1, defaultType: 0,
        positionType: 2, background: 0
    });
    scene.update();
    assert.ok(runtime.windowObject.CoopPl.status().activeRemoteChoice);
    choiceWindow.start();
    socket.receive({
        type: "event_choice_result", kind: "map", mapId: 1, eventId: 9,
        choiceId: "choice-host-cancel", result: -1
    });
    assert.equal(choiceWindow.cancelCalls, 1, "the host's cancellation should close the guest's non-interactive window");
    assert.equal(runtime.windowObject.CoopPl.status().activeRemoteChoice, null,
        "a host cancellation must not leave the guest choice window locked");
    assert.deepEqual(Array.from(runtime.context.$gameMessage.choices), []);
    runtime.windowObject.CoopPl.disconnect();
});


test("host preserves RPG Maker MZ command parameters when intercepting Show Text and Call Common Event", () => {
    const runtime = makeRuntime();
    const scene = new runtime.context.Scene_Map();
    scene.start();
    const socket = FakeWebSocket.latest;
    socket.open();
    socket.receive({
        type: "welcome", playerId: "host-id", room: "TEST_ROOM",
        hostId: "host-id", isHost: true, players: [],
        world: { revision: 0, switches: {}, variables: {}, selfSwitches: {} }
    });

    const interpreter = new runtime.context.Game_Interpreter();
    const textParams = ["", 0, 0, 2];
    interpreter._coopEventKind = "map";
    interpreter._coopEventMapId = 1;
    interpreter._coopEventId = 4;
    interpreter._list = [
        { code: 101, parameters: textParams },
        { code: 401, parameters: ["Parameter forwarding test"] },
        { code: 0, parameters: [] }
    ];
    interpreter._index = 0;
    interpreter.command101(textParams);
    assert.deepEqual(Array.from(interpreter.lastCommand101Params), textParams);

    const commonEventParams = [12];
    interpreter.command117(commonEventParams);
    assert.deepEqual(Array.from(interpreter.lastCommand117Params), commonEventParams);
    runtime.windowObject.CoopPl.disconnect();
});

test("host accepts a trigger only when the event really starts and locks duplicate activations", () => {
    const runtime = makeRuntime();
    const scene = new runtime.context.Scene_Map();
    scene.start();
    const socket = FakeWebSocket.latest;
    socket.open();
    const state = {
        mapId: 1, x: 8, y: 6, realX: 8, realY: 6,
        direction: 2, characterName: "player", characterIndex: 0, pattern: 1
    };
    socket.receive({
        type: "welcome", playerId: "host-id", room: "TEST_ROOM",
        hostId: "host-id", isHost: true,
        players: [{ playerId: "guest-id", name: "Guest", state }],
        world: { revision: 0, switches: {}, variables: {}, selfSwitches: {} }
    });

    const event = new runtime.context.Game_Event(7, false);
    runtime.map._events.set(7, event);
    const request = {
        type: "event_request", requestId: "ev-host-1", kind: "map",
        mapId: 1, eventId: 7, playerId: "guest-id", playerName: "Guest",
        playerState: state
    };
    socket.receive(request);
    assert.equal(event.startCount, 1);
    assert.equal(runtime.windowObject.CoopPl.status().activeSharedEventCount, 1);
    assert.equal(socket.sent.at(-1).type, "event_result");
    assert.equal(socket.sent.at(-1).accepted, true);

    socket.receive({ ...request, requestId: "ev-host-duplicate" });
    assert.equal(event.startCount, 1);
    assert.equal(socket.sent.at(-1).accepted, false);
    assert.equal(socket.sent.at(-1).reason, "EVENT_BUSY");

    const cannotStart = new runtime.context.Game_Event(8, false);
    cannotStart.start = function() { this.startCount += 1; };
    runtime.map._events.set(8, cannotStart);
    socket.receive({ ...request, requestId: "ev-host-cannot-start", eventId: 8 });
    assert.equal(cannotStart.startCount, 1);
    assert.equal(socket.sent.at(-1).accepted, false);
    assert.equal(socket.sent.at(-1).reason, "EVENT_COULD_NOT_START");
    assert.equal(runtime.windowObject.CoopPl.status().activeSharedEventCount, 1,
        "failed starts must not introduce an event lock");

    runtime.windowObject.CoopPl.disconnect();
});
