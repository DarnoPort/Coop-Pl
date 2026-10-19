"use strict";

const VALID_DIRECTIONS = new Set([2, 4, 6, 8]);
const ROOM_CODE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeRoomCode(value) {
    if (typeof value !== "string") return null;
    const room = value.trim();
    return ROOM_CODE_PATTERN.test(room) ? room : null;
}

function normalizePlayerName(value) {
    if (typeof value !== "string") return null;
    const name = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 24);
    return name.length > 0 ? name : null;
}

function finiteNumber(value, min, max) {
    return typeof value === "number" &&
        Number.isFinite(value) &&
        value >= min &&
        value <= max;
}

function boundedInteger(value, min, max) {
    return Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Return a canonical state object or null when the packet is malformed.
 * The protocol syncs player visuals only; it never accepts game commands.
 */
function normalizeState(value) {
    if (!isRecord(value)) return null;

    if (!boundedInteger(value.mapId, 1, 999999)) return null;
    if (!boundedInteger(value.x, 0, 99999) || !boundedInteger(value.y, 0, 99999)) return null;
    if (!finiteNumber(value.realX, -100000, 100000) ||
        !finiteNumber(value.realY, -100000, 100000)) return null;
    if (!VALID_DIRECTIONS.has(value.direction)) return null;

    const characterName = value.characterName === undefined ? "" : value.characterName;
    if (typeof characterName !== "string" || characterName.length > 64 ||
        characterName.includes("/") || characterName.includes("\\")) return null;

    const characterIndex = value.characterIndex === undefined ? 0 : value.characterIndex;
    const pattern = value.pattern === undefined ? 1 : value.pattern;

    if (!boundedInteger(characterIndex, 0, 7)) return null;
    if (!boundedInteger(pattern, 0, 2)) return null;

    return {
        mapId: value.mapId,
        x: value.x,
        y: value.y,
        realX: value.realX,
        realY: value.realY,
        direction: value.direction,
        characterName,
        characterIndex,
        pattern
    };
}

function normalizeSequence(value) {
    return boundedInteger(value, 0, Number.MAX_SAFE_INTEGER) ? value : null;
}

module.exports = {
    isRecord,
    normalizeRoomCode,
    normalizePlayerName,
    normalizeState,
    normalizeSequence
};
