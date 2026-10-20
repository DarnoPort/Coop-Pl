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


test("server keeps host-authoritative world state and routes guest requests to host", async t => {
    const instance = startServer({
        host: "127.0.0.1",
        port: 0,
        maxPlayers: 3,
        maxClients: 4
    });

    let host;
    let guest;
    t.after(async () => {
        if (host && host.readyState === WebSocket.OPEN) host.close();
        if (guest && guest.readyState === WebSocket.OPEN) guest.close();
        await instance.close();
    });

    await once(instance.wss, "listening");
    const address = instance.wss.address();
    assert.ok(address && typeof address === "object");
    const url = "ws://127.0.0.1:" + address.port;

    host = new WebSocket(url);
    await once(host, "open");
    const hostWelcomePromise = waitForType(host, "welcome");
    host.send(JSON.stringify({
        type: "join",
        room: "WORLD_TEST",
        name: "Host",
        seq: 0,
        state: makeState(2, 2)
    }));
    const hostWelcome = await hostWelcomePromise;
    assert.equal(hostWelcome.isHost, true);

    const snapshotAckPromise = waitForType(host, "world_snapshot_ack");
    host.send(JSON.stringify({
        type: "world_snapshot",
        world: {
            switches: { "2": true }, variables: { "3": 42 },
            selfSwitches: { "1,7,A": true }
        }
    }));
    const snapshotAck = await snapshotAckPromise;
    assert.equal(snapshotAck.revision, 1);

    guest = new WebSocket(url);
    await once(guest, "open");
    const guestWelcomePromise = waitForType(guest, "welcome");
    const hostJoinedPromise = waitForType(host, "player_joined");
    guest.send(JSON.stringify({
        type: "join",
        room: "WORLD_TEST",
        name: "Guest",
        seq: 0,
        state: makeState(4, 4)
    }));
    const [guestWelcome] = await Promise.all([guestWelcomePromise, hostJoinedPromise]);
    assert.equal(guestWelcome.world.revision, 1);
    assert.equal(guestWelcome.world.switches["2"], true);
    assert.equal(guestWelcome.world.variables["3"], 42);
    assert.equal(guestWelcome.world.selfSwitches["1,7,A"], true);

    const requestPromise = waitForType(host, "world_request");
    guest.send(JSON.stringify({
        type: "world_request",
        kind: "switch",
        id: 5,
        value: true
    }));
    const request = await requestPromise;
    assert.equal(request.playerId, guestWelcome.playerId);
    assert.equal(request.kind, "switch");
    assert.equal(request.id, 5);
    assert.equal(request.value, true);

    const hostChangePromise = waitForType(host, "world_change");
    const guestChangePromise = waitForType(guest, "world_change");
    host.send(JSON.stringify({
        type: "world_change",
        kind: "switch",
        id: request.id,
        value: request.value
    }));
    const [hostChange, guestChange] = await Promise.all([
        hostChangePromise,
        guestChangePromise
    ]);
    assert.equal(hostChange.revision, 2);
    assert.equal(guestChange.revision, 2);
    assert.equal(guestChange.id, 5);
    assert.equal(guestChange.value, true);
    assert.equal(instance.rooms.get("WORLD_TEST").world.switches["5"], true);

    const ssRequestPromise = waitForType(host, "world_request");
    guest.send(JSON.stringify({ type: "world_request", kind: "selfSwitch", key: "1,8,B", value: true }));
    const ssRequest = await ssRequestPromise;
    assert.equal(ssRequest.kind, "selfSwitch");
    assert.equal(ssRequest.key, "1,8,B");
    const hostSelfSwitchChangePromise = waitForType(host, "world_change");
    const guestSelfSwitchChangePromise = waitForType(guest, "world_change");
    host.send(JSON.stringify({ type: "world_change", kind: "selfSwitch", key: ssRequest.key, value: true }));
    const [hostSelfSwitchChange, guestSelfSwitchChange] = await Promise.all([
        hostSelfSwitchChangePromise, guestSelfSwitchChangePromise
    ]);
    assert.equal(hostSelfSwitchChange.revision, 3);
    assert.equal(guestSelfSwitchChange.key, "1,8,B");
    assert.equal(instance.rooms.get("WORLD_TEST").world.selfSwitches["1,8,B"], true);
});


test("server routes guest shared-event requests to host and releases event locks", async t => {
    const instance = startServer({ host: "127.0.0.1", port: 0, maxPlayers: 3, maxClients: 4 });
    let host;
    let guest;
    t.after(async () => {
        if (host && host.readyState === WebSocket.OPEN) host.close();
        if (guest && guest.readyState === WebSocket.OPEN) guest.close();
        await instance.close();
    });
    await once(instance.wss, "listening");
    const address = instance.wss.address();
    const url = "ws://127.0.0.1:" + address.port;
    host = new WebSocket(url);
    await once(host, "open");
    const hostWelcome = waitForType(host, "welcome");
    host.send(JSON.stringify({ type: "join", room: "EVENT_TEST", name: "Host", seq: 0, state: makeState(8, 6) }));
    await hostWelcome;

    guest = new WebSocket(url);
    await once(guest, "open");
    const guestWelcomePromise = waitForType(guest, "welcome");
    const joinedPromise = waitForType(host, "player_joined");
    guest.send(JSON.stringify({ type: "join", room: "EVENT_TEST", name: "Guest", seq: 0, state: makeState(8, 6) }));
    const [guestWelcome] = await Promise.all([guestWelcomePromise, joinedPromise]);
    const request = { requestId: "ev-test-1", kind: "map", mapId: 1, eventId: 7 };
    const forwardedPromise = waitForType(host, "event_request");
    guest.send(JSON.stringify({ type: "event_request", ...request }));
    const forwarded = await forwardedPromise;
    assert.equal(forwarded.requestId, request.requestId);
    assert.equal(forwarded.playerId, guestWelcome.playerId);

    host.send(JSON.stringify({
        type: "event_activity", requestId: "activity-map-1-7",
        kind: "map", mapId: 1, eventId: 7, active: true
    }));
    const acceptedPromise = waitForType(guest, "event_result");
    host.send(JSON.stringify({ type: "event_result", ...request, accepted: true }));
    assert.equal((await acceptedPromise).accepted, true);

    const busyPromise = waitForType(guest, "event_result");
    guest.send(JSON.stringify({ type: "event_request", ...request, requestId: "ev-test-2" }));
    const busy = await busyPromise;
    assert.equal(busy.accepted, false);
    assert.equal(busy.reason, "EVENT_BUSY");

    const finishedPromise = waitForType(guest, "event_finished");
    host.send(JSON.stringify({
        type: "event_activity", requestId: "activity-map-1-7",
        kind: "map", mapId: 1, eventId: 7, active: false
    }));
    assert.equal((await finishedPromise).requestId, request.requestId);
    assert.equal(instance.rooms.get("EVENT_TEST").activeEvents.size, 0);
});
