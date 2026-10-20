"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
    normalizeRoomCode,
    normalizePlayerName,
    normalizeState,
    normalizeSequence,
    normalizeWorldValue,
    normalizeWorldSnapshot,
    normalizeWorldChange,
    normalizeEventRequest,
    normalizeEventResult,
    normalizeEventActivity
} = require("../server/src/protocol");

test("room codes accept short ASCII identifiers and reject invalid input", () => {
    assert.equal(normalizeRoomCode(" TEST_01 "), "TEST_01");
    assert.equal(normalizeRoomCode("a-b"), "a-b");
    assert.equal(normalizeRoomCode(""), null);
    assert.equal(normalizeRoomCode("../secret"), null);
    assert.equal(normalizeRoomCode("room with spaces"), null);
    assert.equal(normalizeRoomCode("x".repeat(33)), null);
});

test("player names are trimmed, bounded and stripped of control characters", () => {
    assert.equal(normalizePlayerName("  Darno\u0007  "), "Darno");
    assert.equal(normalizePlayerName("x".repeat(40)).length, 24);
    assert.equal(normalizePlayerName("   "), null);
    assert.equal(normalizePlayerName(42), null);
});

test("valid player state is returned in canonical form", () => {
    const state = normalizeState({
        mapId: 1,
        x: 8,
        y: 6,
        realX: 7.9,
        realY: 6,
        direction: 4,
        characterName: "player",
        characterIndex: 1,
        pattern: 2,
        ignoredField: "not forwarded"
    });

    assert.deepEqual(state, {
        mapId: 1,
        x: 8,
        y: 6,
        realX: 7.9,
        realY: 6,
        direction: 4,
        characterName: "player",
        characterIndex: 1,
        pattern: 2
    });
});

test("malformed states and path-like graphic names are rejected", () => {
    const base = {
        mapId: 1, x: 8, y: 6, realX: 8, realY: 6,
        direction: 2, characterName: "player", characterIndex: 0, pattern: 1
    };

    assert.equal(normalizeState(null), null);
    assert.equal(normalizeState({ ...base, x: 1.5 }), null);
    assert.equal(normalizeState({ ...base, direction: 7 }), null);
    assert.equal(normalizeState({ ...base, characterName: "../player" }), null);
    assert.equal(normalizeState({ ...base, characterName: "folder\\player" }), null);
    assert.equal(normalizeState({ ...base, characterIndex: 8 }), null);
    assert.equal(normalizeState({ ...base, realX: Infinity }), null);
});

test("sequence numbers must be safe non-negative integers", () => {
    assert.equal(normalizeSequence(0), 0);
    assert.equal(normalizeSequence(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
    assert.equal(normalizeSequence(-1), null);
    assert.equal(normalizeSequence(1.5), null);
    assert.equal(normalizeSequence(Number.MAX_SAFE_INTEGER + 1), null);
});


test("world snapshots accept sparse switches and JSON-safe variable values", () => {
    const normalized = normalizeWorldSnapshot({
        switches: { "2": true, "10": false },
        variables: { "1": 42, "3": "chapter two", "4": false, "5": null }
    });

    assert.ok(normalized);
    assert.equal(normalized.switches["2"], true);
    assert.equal(normalized.switches["10"], false);
    assert.equal(normalized.variables["1"], 42);
    assert.equal(normalized.variables["3"], "chapter two");
    assert.equal(normalized.variables["4"], false);
    assert.equal(normalized.variables["5"], null);
});

test("world snapshots reject invalid ids, non-boolean switches and unsupported values", () => {
    assert.equal(normalizeWorldSnapshot({ switches: { "0": true }, variables: {} }), null);
    assert.equal(normalizeWorldSnapshot({ switches: { "1": 1 }, variables: {} }), null);
    assert.equal(normalizeWorldSnapshot({ switches: {}, variables: { "1": { nested: true } } }), null);
    assert.equal(normalizeWorldSnapshot({ switches: {}, variables: { "../x": 1 } }), null);
    assert.equal(normalizeWorldSnapshot({ switches: {}, variables: { "1": "x".repeat(4097) } }), null);
});

test("world changes validate type, id, and JSON-safe values", () => {
    assert.deepEqual(normalizeWorldChange({ kind: "switch", id: 12, value: true }), {
        kind: "switch", id: 12, value: true
    });
    assert.deepEqual(normalizeWorldChange({ kind: "variable", id: 2, value: "value" }), {
        kind: "variable", id: 2, value: "value"
    });
    assert.equal(normalizeWorldChange({ kind: "switch", id: 1, value: 5 }), null);
    assert.equal(normalizeWorldChange({ kind: "plugin", id: 1, value: true }), null);
    assert.equal(normalizeWorldChange({ kind: "variable", id: 0, value: 1 }), null);
    assert.equal(normalizeWorldChange({ kind: "variable", id: 2, value: [] }), null);
});

test("world values preserve primitive types and reject non-finite numbers", () => {
    assert.equal(normalizeWorldValue(null), null);
    assert.equal(normalizeWorldValue(false), false);
    assert.equal(normalizeWorldValue(17), 17);
    assert.equal(normalizeWorldValue("ok"), "ok");
    assert.equal(normalizeWorldValue(Infinity), null);
    assert.equal(normalizeWorldValue({}), null);
});


test("self-switch snapshots and changes validate event keys", () => {
    const snapshot = normalizeWorldSnapshot({
        switches: { "2": true }, variables: { "3": 42 },
        selfSwitches: { "1,7,A": true, "12,42,D": false }
    });
    assert.ok(snapshot);
    assert.equal(snapshot.selfSwitches["1,7,A"], true);
    assert.equal(snapshot.selfSwitches["12,42,D"], false);
    assert.equal(normalizeWorldSnapshot({
        switches: {}, variables: {}, selfSwitches: { "0,1,A": true }
    }), null);
    assert.equal(normalizeWorldChange({
        kind: "selfSwitch", key: "1,7,A", value: true
    }).key, "1,7,A");
    assert.equal(normalizeWorldChange({
        kind: "selfSwitch", key: "1,7,X", value: true
    }), null);
});

test("shared event requests/results/activity validate ids and values", () => {
    const request = { kind: "map", mapId: 1, eventId: 7, requestId: "ev-abc-1" };
    assert.deepEqual(normalizeEventRequest(request), request);
    assert.equal(normalizeEventRequest({ ...request, eventId: 0 }), null);
    assert.equal(normalizeEventRequest({ ...request, requestId: "bad id" }), null);
    assert.deepEqual(normalizeEventResult({ ...request, accepted: false, reason: "EVENT_BUSY" }),
        { ...request, accepted: false, reason: "EVENT_BUSY" });
    assert.equal(normalizeEventResult({ ...request, accepted: "yes" }), null);
    assert.deepEqual(normalizeEventActivity({ ...request, active: true }),
        { kind: "map", mapId: 1, eventId: 7, active: true });
    assert.equal(normalizeEventActivity({ ...request, active: 0 }), null);
});
