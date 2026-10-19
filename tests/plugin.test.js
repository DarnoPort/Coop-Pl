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
    const map = { mapId: () => 1 };
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
        Game_Switches: FakeGameSwitches,
        Game_Variables: FakeGameVariables,
        Scene_Map: FakeSceneMap,
        Spriteset_Map: FakeSpritesetMap,
        Sprite_Character: FakeSpriteCharacter,
        $gamePlayer: player,
        $gameMap: map,
        $gameSwitches: new FakeGameSwitches(),
        $gameVariables: new FakeGameVariables(),
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
