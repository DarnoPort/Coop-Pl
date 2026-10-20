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


const MAX_WORLD_ENTRIES = 5000;
const MAX_WORLD_STRING_LENGTH = 4096;
const WORLD_ID_PATTERN = /^[1-9][0-9]{0,5}$/;
const SELF_SWITCH_KEY_PATTERN = /^[1-9][0-9]{0,5},[1-9][0-9]{0,5},[A-D]$/;
const EVENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,96}$/;

function normalizeWorldValue(value) {
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string") {
        return value.length <= MAX_WORLD_STRING_LENGTH ? value : null;
    }
    return null;
}

function normalizeWorldEntries(entries, kind) {
    if (!isRecord(entries)) return null;
    const keys = Object.keys(entries);
    if (keys.length > MAX_WORLD_ENTRIES) return null;

    const result = Object.create(null);
    for (const key of keys) {
        if (!WORLD_ID_PATTERN.test(key)) return null;
        const id = Number(key);
        if (!boundedInteger(id, 1, 999999)) return null;

        const value = normalizeWorldValue(entries[key]);
        if (value === null && entries[key] !== null) return null;
        if (kind === "switches" && typeof value !== "boolean") return null;
        result[key] = value;
    }
    return result;
}

function normalizeSelfSwitchEntries(entries) {
    if (!isRecord(entries)) return null;
    if (Object.keys(entries).length > MAX_WORLD_ENTRIES) return null;
    const result = Object.create(null);
    for (const [key, value] of Object.entries(entries)) {
        if (!SELF_SWITCH_KEY_PATTERN.test(key) || typeof value !== "boolean") return null;
        result[key] = value;
    }
    return result;
}

function normalizeWorldSnapshot(value) {
    if (!isRecord(value)) return null;
    const switches = normalizeWorldEntries(value.switches, "switches");
    const variables = normalizeWorldEntries(value.variables, "variables");
    const selfSwitches = value.selfSwitches === undefined
        ? Object.create(null)
        : normalizeSelfSwitchEntries(value.selfSwitches);
    if (!switches || !variables || !selfSwitches) return null;
    return { switches, variables, selfSwitches };
}

function normalizeWorldChange(value) {
    if (!isRecord(value)) return null;
    if (value.kind === "selfSwitch") {
        if (typeof value.key !== "string" || !SELF_SWITCH_KEY_PATTERN.test(value.key) ||
            typeof value.value !== "boolean") return null;
        return { kind: "selfSwitch", key: value.key, value: value.value };
    }
    if (value.kind !== "switch" && value.kind !== "variable") return null;
    if (!boundedInteger(value.id, 1, 999999)) return null;
    const normalizedValue = normalizeWorldValue(value.value);
    if (normalizedValue === null && value.value !== null) return null;
    if (value.kind === "switch" && typeof normalizedValue !== "boolean") return null;
    return { kind: value.kind, id: value.id, value: normalizedValue };
}

function normalizeEventRequest(value) {
    if (!isRecord(value) || (value.kind !== "map" && value.kind !== "common")) return null;
    if (!boundedInteger(value.mapId, 1, 999999) ||
        !boundedInteger(value.eventId, 1, 999999) ||
        typeof value.requestId !== "string" ||
        !EVENT_REQUEST_ID_PATTERN.test(value.requestId)) return null;
    return { kind: value.kind, mapId: value.mapId, eventId: value.eventId, requestId: value.requestId };
}

function normalizeEventResult(value) {
    const request = normalizeEventRequest(value);
    if (!request || typeof value.accepted !== "boolean") return null;
    if (value.reason !== undefined &&
        (typeof value.reason !== "string" || value.reason.length > 64)) return null;
    return { ...request, accepted: value.accepted, ...(value.reason ? { reason: value.reason } : {}) };
}

function normalizeEventActivity(value) {
    const request = normalizeEventRequest(value);
    if (!request || typeof value.active !== "boolean") return null;
    return { kind: request.kind, mapId: request.mapId, eventId: request.eventId, active: value.active };
}

const MAX_PARTY_ACTORS = 16;
const MAX_PARTY_ITEMS_PER_KIND = 2000;
const MAX_ACTOR_STATES = 128;
const MAX_ACTOR_SKILLS = 256;
const MAX_EQUIP_SLOTS = 16;

function normalizeIdList(value, limit) {
    if (!Array.isArray(value) || value.length > limit) return null;
    const result = [];
    const seen = new Set();
    for (const id of value) {
        if (!boundedInteger(id, 1, 999999) || seen.has(id)) return null;
        seen.add(id);
        result.push(id);
    }
    return result;
}

function normalizeInventory(value) {
    if (!isRecord(value)) return null;
    const keys = Object.keys(value);
    if (keys.length > MAX_PARTY_ITEMS_PER_KIND) return null;
    const result = Object.create(null);
    for (const [rawId, count] of Object.entries(value)) {
        if (!/^[1-9][0-9]{0,5}$/.test(rawId) ||
            !boundedInteger(Number(rawId), 1, 999999) ||
            !boundedInteger(count, 1, 999999)) return null;
        result[rawId] = count;
    }
    return result;
}

function normalizePartySnapshot(value) {
    if (!isRecord(value) || !boundedInteger(value.gold, 0, 999999999)) return null;

    const items = normalizeInventory(value.items);
    const weapons = normalizeInventory(value.weapons);
    const armors = normalizeInventory(value.armors);
    if (!items || !weapons || !armors) return null;

    if (!Array.isArray(value.actors) || value.actors.length > MAX_PARTY_ACTORS) return null;
    const actorIds = new Set();
    const actors = [];

    for (const actor of value.actors) {
        if (!isRecord(actor) ||
            !boundedInteger(actor.actorId, 1, 999999) || actorIds.has(actor.actorId) ||
            !boundedInteger(actor.classId, 1, 999999) ||
            !boundedInteger(actor.exp, 0, 1000000000000) ||
            !boundedInteger(actor.hp, 0, 9999999) ||
            !boundedInteger(actor.mp, 0, 9999999) ||
            !boundedInteger(actor.tp, 0, 100) ||
            (actor.name !== undefined &&
                (typeof actor.name !== "string" || actor.name.length > 64))) return null;

        const states = normalizeIdList(actor.states, MAX_ACTOR_STATES);
        const skills = normalizeIdList(actor.skills, MAX_ACTOR_SKILLS);
        if (!states || !skills) return null;

        if (!Array.isArray(actor.buffs) || actor.buffs.length > 32 ||
            !actor.buffs.every(level => Number.isInteger(level) && level >= -2 && level <= 2)) return null;
        if (!Array.isArray(actor.buffTurns) || actor.buffTurns.length !== actor.buffs.length ||
            !actor.buffTurns.every(turns => boundedInteger(turns, 0, 999999))) return null;

        if (!Array.isArray(actor.equips) || actor.equips.length > MAX_EQUIP_SLOTS) return null;
        const equips = [];
        for (const equip of actor.equips) {
            if (equip === null) {
                equips.push(null);
                continue;
            }
            if (!isRecord(equip) ||
                (equip.kind !== "weapon" && equip.kind !== "armor") ||
                !boundedInteger(equip.id, 1, 999999)) return null;
            equips.push({ kind: equip.kind, id: equip.id });
        }

        actorIds.add(actor.actorId);
        actors.push({
            actorId: actor.actorId,
            classId: actor.classId,
            exp: actor.exp,
            hp: actor.hp,
            mp: actor.mp,
            tp: actor.tp,
            states,
            skills,
            buffs: actor.buffs.slice(),
            buffTurns: actor.buffTurns.slice(),
            equips,
            ...(actor.name === undefined ? {} : { name: actor.name })
        });
    }

    return { gold: value.gold, items, weapons, armors, actors };
}

module.exports = {
    isRecord,
    normalizeRoomCode,
    normalizePlayerName,
    normalizeState,
    normalizeSequence,
    normalizeWorldValue,
    normalizeWorldSnapshot,
    normalizeWorldChange,
    normalizeEventRequest,
    normalizeEventResult,
    normalizeEventActivity,
    normalizePartySnapshot
};
