"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
    normalizeRoomCode,
    normalizePlayerName,
    normalizeState,
    normalizeSequence
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
