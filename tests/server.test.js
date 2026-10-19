"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const path = require("node:path");
const { WebSocket } = require(require.resolve("ws", {
    paths: [path.join(__dirname, "..", "server")]
}));
const { startServer } = require("../server/src/server");

function makeState(x, y) {
    return {
        mapId: 1,
        x,
        y,
        realX: x,
        realY: y,
        direction: 2,
        characterName: "player",
        characterIndex: 0,
        pattern: 1
    };
}

function waitForType(socket, type, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error("Timed out waiting for message type " + type));
        }, timeoutMs);

        const onMessage = raw => {
            let message;
            try {
                message = JSON.parse(raw.toString());
            } catch (_) {
                return;
            }
            if (message.type === "error") {
                cleanup();
                reject(new Error("Server error " + message.code + ": " + message.message));
            }
            if (message.type === type) {
                cleanup();
                resolve(message);
            }
        };

        function cleanup() {
            clearTimeout(timeout);
            socket.off("message", onMessage);
        }

        socket.on("message", onMessage);
    });
}

test("room server assigns host, sends player snapshots, relays state and removes leavers", async t => {
    const instance = startServer({
        host: "127.0.0.1",
        port: 0,
        maxPlayers: 3,
        maxClients: 4
    });

    let first;
    let second;
    t.after(async () => {
        if (first && first.readyState === WebSocket.OPEN) first.close();
        if (second && second.readyState === WebSocket.OPEN) second.close();
        await instance.close();
    });

    await once(instance.wss, "listening");
    const address = instance.wss.address();
    assert.ok(address && typeof address === "object");
    const url = "ws://127.0.0.1:" + address.port;

    first = new WebSocket(url);
    await once(first, "open");
    const firstWelcomePromise = waitForType(first, "welcome");
    first.send(JSON.stringify({
        type: "join",
        room: "TEST_ROOM",
        name: "Host",
        seq: 0,
        state: makeState(8, 6)
    }));
    const firstWelcome = await firstWelcomePromise;

    assert.equal(firstWelcome.isHost, true);
    assert.equal(firstWelcome.hostId, firstWelcome.playerId);
    assert.equal(firstWelcome.players.length, 1);

    const playerJoinedPromise = waitForType(first, "player_joined");
    second = new WebSocket(url);
    await once(second, "open");
    const secondWelcomePromise = waitForType(second, "welcome");
    second.send(JSON.stringify({
        type: "join",
        room: "TEST_ROOM",
        name: "Guest",
        seq: 0,
        state: makeState(4, 5)
    }));

    const [secondWelcome, playerJoined] = await Promise.all([
        secondWelcomePromise,
        playerJoinedPromise
    ]);
    assert.equal(secondWelcome.isHost, false);
    assert.equal(secondWelcome.hostId, firstWelcome.playerId);
    assert.equal(secondWelcome.players.length, 2);
    assert.equal(playerJoined.player.name, "Guest");

    const statePromise = waitForType(first, "state");
    second.send(JSON.stringify({
        type: "state",
        seq: 1,
        state: makeState(5, 5)
    }));
    const stateMessage = await statePromise;
    assert.equal(stateMessage.playerId, secondWelcome.playerId);
    assert.equal(stateMessage.state.x, 5);

    const leftPromise = waitForType(first, "player_left");
    second.close();
    const leftMessage = await leftPromise;
    assert.equal(leftMessage.playerId, secondWelcome.playerId);
});
