"use strict";

const { randomUUID } = require("node:crypto");
const { WebSocketServer, WebSocket } = require("ws");
const {
    isRecord,
    normalizeRoomCode,
    normalizePlayerName,
    normalizeState,
    normalizeSequence,
    normalizeWorldSnapshot,
    normalizeWorldChange,
    normalizeEventRequest,
    normalizeEventResult,
    normalizeEventActivity,
    normalizePartySnapshot
} = require("./protocol");

const MAX_MESSAGE_BYTES = 256 * 1024;
const DEFAULT_MAX_PLAYERS = 4;
const DEFAULT_MAX_CLIENTS = 32;

function safeSend(socket, message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
        socket.send(JSON.stringify(message));
        return true;
    } catch (_) {
        return false;
    }
}

function publicPlayer(peer) {
    return {
        playerId: peer.id,
        name: peer.name,
        state: peer.state
    };
}

function sendError(peer, code, message, fatal = false) {
    safeSend(peer.socket, { type: "error", code, message, fatal });
}

function startServer(options = {}) {
    const host = options.host || process.env.COOP_HOST || "127.0.0.1";
    const port = options.port === undefined ? Number(process.env.COOP_PORT || 8080) : Number(options.port);
    const maxPlayers = Number(options.maxPlayers || process.env.COOP_MAX_PLAYERS || DEFAULT_MAX_PLAYERS);
    const maxClients = Number(options.maxClients || process.env.COOP_MAX_CLIENTS || DEFAULT_MAX_CLIENTS);

    const minimumPort = options.port === 0 ? 0 : 1;
    if (!Number.isInteger(port) || port < minimumPort || port > 65535) {
        throw new Error("COOP_PORT must be an integer between 1 and 65535 (0 is allowed only for ephemeral test ports)");
    }
    if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 16) {
        throw new Error("COOP_MAX_PLAYERS must be an integer between 2 and 16");
    }
    if (!Number.isInteger(maxClients) || maxClients < maxPlayers) {
        throw new Error("COOP_MAX_CLIENTS must be an integer greater than or equal to COOP_MAX_PLAYERS");
    }

    const wss = new WebSocketServer({
        host,
        port,
        maxPayload: MAX_MESSAGE_BYTES,
        perMessageDeflate: false
    });
    const rooms = new Map();
    let heartbeatTimer = null;

    function broadcast(room, message, exceptId = null) {
        if (!room) return;
        for (const peer of room.members.values()) {
            if (peer.id !== exceptId) safeSend(peer.socket, message);
        }
    }

    function removePeer(peer) {
        if (!peer.roomCode) return;

        const room = rooms.get(peer.roomCode);
        const oldRoomCode = peer.roomCode;
        peer.roomCode = null;

        if (!room) return;
        room.members.delete(peer.id);
        broadcast(room, { type: "player_left", playerId: peer.id }, peer.id);
        for (const [requestId, request] of room.eventRequests) {
            if (request.requesterId !== peer.id) continue;
            room.eventRequests.delete(requestId);
            const lock = room.activeEvents.get(request.key);
            if (lock && lock.status === "pending" && lock.requestId === requestId) {
                room.activeEvents.delete(request.key);
            }
        }

        if (room.hostId === peer.id) {
            for (const request of room.eventRequests.values()) {
                const requester = room.members.get(request.requesterId);
                if (requester) safeSend(requester.socket, {
                    type: "event_result", requestId: request.requestId,
                    kind: request.kind, mapId: request.mapId, eventId: request.eventId,
                    accepted: false, reason: "HOST_DISCONNECTED"
                });
            }
            for (const lock of room.activeEvents.values()) {
                if (lock.status !== "active" || !lock.requestId ||
                    room.eventRequests.has(lock.requestId)) continue;
                const requester = room.members.get(lock.requesterId);
                if (requester) safeSend(requester.socket, {
                    type: "event_finished", requestId: lock.requestId,
                    kind: lock.kind, mapId: lock.mapId, eventId: lock.eventId
                });
            }
            room.eventRequests.clear();
            room.activeEvents.clear();
            const next = room.members.keys().next();
            room.hostId = next.done ? null : next.value;
            if (room.hostId) broadcast(room, { type: "host_changed", hostId: room.hostId });
        }

        if (room.members.size === 0) rooms.delete(oldRoomCode);
    }

    function joinRoom(peer, message) {
        if (peer.roomCode) {
            sendError(peer, "ALREADY_JOINED", "This connection already joined a room.", true);
            peer.socket.close(1008, "already joined");
            return;
        }

        const roomCode = normalizeRoomCode(message.room);
        const name = normalizePlayerName(message.name);
        const state = normalizeState(message.state);
        const sequence = normalizeSequence(message.seq === undefined ? 0 : message.seq);

        if (!roomCode || !name || !state || sequence === null) {
            sendError(peer, "INVALID_JOIN", "Room, player name, state or sequence is invalid.", true);
            peer.socket.close(1008, "invalid join");
            return;
        }

        let room = rooms.get(roomCode);
        if (!room) {
            room = {
                code: roomCode,
                hostId: null,
                members: new Map(),
                world: {
                    switches: Object.create(null),
                    variables: Object.create(null),
                    selfSwitches: Object.create(null),
                    revision: 0
                },
                party: null,
                activeEvents: new Map(),
                eventRequests: new Map()
            };
            rooms.set(roomCode, room);
        }

        if (room.members.size >= maxPlayers) {
            sendError(peer, "ROOM_FULL", "The room has reached its player limit.", true);
            peer.socket.close(1008, "room full");
            if (room.members.size === 0) rooms.delete(roomCode);
            return;
        }

        peer.roomCode = roomCode;
        peer.name = name;
        peer.state = state;
        peer.lastSequence = sequence;
        peer.id = randomUUID();

        if (!room.hostId) room.hostId = peer.id;
        room.members.set(peer.id, peer);

        safeSend(peer.socket, {
            type: "welcome",
            playerId: peer.id,
            room: room.code,
            hostId: room.hostId,
            isHost: peer.id === room.hostId,
            players: Array.from(room.members.values(), publicPlayer),
            world: room.world,
            party: room.party
        });

        broadcast(room, {
            type: "player_joined",
            player: publicPlayer(peer),
            hostId: room.hostId
        }, peer.id);

        console.info("[Coop-Pl] joined", name, "room", roomCode,
            "(" + room.members.size + "/" + maxPlayers + ")");
    }

    function updateState(peer, message) {
        if (!peer.roomCode) {
            sendError(peer, "NOT_JOINED", "Join a room before sending player state.");
            return;
        }

        const state = normalizeState(message.state);
        const sequence = normalizeSequence(message.seq);
        if (!state || sequence === null) {
            sendError(peer, "INVALID_STATE", "Player state or sequence is invalid.");
            return;
        }
        if (sequence <= peer.lastSequence) return;

        peer.lastSequence = sequence;
        peer.state = state;
        const room = rooms.get(peer.roomCode);
        broadcast(room, {
            type: "state",
            playerId: peer.id,
            name: peer.name,
            seq: sequence,
            state
        }, peer.id);
    }


    function updateWorldSnapshot(peer, message) {
        if (!peer.roomCode) {
            sendError(peer, "NOT_JOINED", "Join a room before syncing shared world state.");
            return;
        }
        const room = rooms.get(peer.roomCode);
        if (!room || peer.id !== room.hostId) {
            sendError(peer, "HOST_ONLY", "Only the room host may publish authoritative world snapshots.");
            return;
        }

        const snapshot = normalizeWorldSnapshot(message.world);
        if (!snapshot) {
            sendError(peer, "INVALID_WORLD_SNAPSHOT", "Shared world snapshot is invalid.");
            return;
        }

        room.world = {
            switches: snapshot.switches,
            variables: snapshot.variables,
            selfSwitches: snapshot.selfSwitches,
            revision: room.world.revision + 1
        };

        safeSend(peer.socket, {
            type: "world_snapshot_ack",
            revision: room.world.revision
        });
        broadcast(room, {
            type: "world_snapshot",
            world: room.world
        }, peer.id);
    }

    function requestWorldChange(peer, message) {
        if (!peer.roomCode) {
            sendError(peer, "NOT_JOINED", "Join a room before requesting world changes.");
            return;
        }

        const room = rooms.get(peer.roomCode);
        if (!room || peer.id === room.hostId) {
            sendError(peer, "INVALID_WORLD_REQUEST", "The host does not request its own world changes.");
            return;
        }

        const change = normalizeWorldChange(message);
        if (!change) {
            sendError(peer, "INVALID_WORLD_CHANGE", "Requested switch or variable change is invalid.");
            return;
        }

        const host = room.members.get(room.hostId);
        if (!host) {
            sendError(peer, "HOST_UNAVAILABLE", "The room host is not connected.");
            return;
        }

        safeSend(host.socket, {
            type: "world_request",
            playerId: peer.id,
            playerName: peer.name,
            kind: change.kind,
            ...(change.kind === "selfSwitch" ? { key: change.key } : { id: change.id }),
            value: change.value
        });
    }

    function publishWorldChange(peer, message) {
        if (!peer.roomCode) {
            sendError(peer, "NOT_JOINED", "Join a room before syncing shared world changes.");
            return;
        }

        const room = rooms.get(peer.roomCode);
        if (!room || peer.id !== room.hostId) {
            sendError(peer, "HOST_ONLY", "Only the room host may publish authoritative world changes.");
            return;
        }

        const change = normalizeWorldChange(message);
        if (!change) {
            sendError(peer, "INVALID_WORLD_CHANGE", "Shared switch or variable change is invalid.");
            return;
        }

        const collection = change.kind === "switch" ? room.world.switches :
            change.kind === "variable" ? room.world.variables : room.world.selfSwitches;
        const key = change.kind === "selfSwitch" ? change.key : String(change.id);
        if ((change.kind === "switch" && change.value === false) ||
            (change.kind === "variable" && change.value === 0) ||
            (change.kind === "selfSwitch" && change.value === false)) delete collection[key];
        else collection[key] = change.value;

        room.world.revision += 1;
        broadcast(room, {
            type: "world_change",
            revision: room.world.revision,
            kind: change.kind,
            ...(change.kind === "selfSwitch" ? { key: change.key } : { id: change.id }),
            value: change.value
        });
    }

    function publishPartySnapshot(peer, message) {
        if (!peer.roomCode) {
            sendError(peer, "NOT_JOINED", "Join a room before syncing party state.");
            return;
        }
        const room = rooms.get(peer.roomCode);
        if (!room || peer.id !== room.hostId) {
            sendError(peer, "HOST_ONLY", "Only the room host may publish authoritative party state.");
            return;
        }
        const party = normalizePartySnapshot(message.party);
        if (!party) {
            sendError(peer, "INVALID_PARTY_SNAPSHOT", "Party snapshot is invalid.");
            return;
        }
        room.party = party;
        broadcast(room, { type: "party_snapshot", party: room.party }, peer.id);
    }

    function eventLockKey(kind, mapId, eventId) {
        return kind + ":" + mapId + ":" + eventId;
    }
    function sendEventResult(peer, request, accepted, reason) {
        if (!peer || !request) return;
        const result = { type: "event_result", requestId: request.requestId, kind: request.kind,
            mapId: request.mapId, eventId: request.eventId, accepted: Boolean(accepted) };
        if (reason) result.reason = String(reason).slice(0, 64);
        safeSend(peer.socket, result);
    }
    function handleEventRequest(peer, message) {
        if (!peer.roomCode) {
            sendError(peer, "NOT_JOINED", "Join a room before requesting a shared event.");
            return;
        }
        const request = normalizeEventRequest(message);
        const room = rooms.get(peer.roomCode);
        if (!request || !room) {
            sendError(peer, "INVALID_EVENT_REQUEST", "Shared event request is invalid.");
            return;
        }
        if (peer.id === room.hostId) return sendEventResult(peer, request, false, "HOST_ALREADY_EXECUTES_EVENTS");
        if (!peer.state || peer.state.mapId !== request.mapId) return sendEventResult(peer, request, false, "MAP_MISMATCH");
        if (room.eventRequests.has(request.requestId)) return sendEventResult(peer, request, false, "DUPLICATE_REQUEST");
        const key = eventLockKey(request.kind, request.mapId, request.eventId);
        if (room.activeEvents.has(key)) return sendEventResult(peer, request, false, "EVENT_BUSY");
        const host = room.members.get(room.hostId);
        if (!host) return sendEventResult(peer, request, false, "HOST_UNAVAILABLE");
        const lock = { ...request, key, requesterId: peer.id, hostId: room.hostId, status: "pending" };
        room.activeEvents.set(key, lock);
        room.eventRequests.set(request.requestId, lock);
        safeSend(host.socket, {
            type: "event_request", ...request,
            playerId: peer.id, playerName: peer.name, playerState: peer.state
        });
    }
    function handleEventResult(peer, message) {
        if (!peer.roomCode) {
            sendError(peer, "NOT_JOINED", "Join a room before returning an event result.");
            return;
        }
        const result = normalizeEventResult(message);
        const room = rooms.get(peer.roomCode);
        if (!result || !room) {
            sendError(peer, "INVALID_EVENT_RESULT", "Shared event result is invalid.");
            return;
        }
        if (peer.id !== room.hostId) {
            sendError(peer, "HOST_ONLY", "Only the host may accept or reject shared events.");
            return;
        }
        const pending = room.eventRequests.get(result.requestId);
        if (!pending || pending.kind !== result.kind || pending.mapId !== result.mapId ||
            pending.eventId !== result.eventId) {
            sendError(peer, "UNKNOWN_EVENT_REQUEST", "No matching shared event request is pending.");
            return;
        }
        room.eventRequests.delete(result.requestId);
        const lock = room.activeEvents.get(pending.key);
        const requester = room.members.get(pending.requesterId);
        if (result.accepted) {
            if (lock) lock.status = "active";
        } else if (lock && lock.requestId === result.requestId && lock.status === "pending") {
            room.activeEvents.delete(pending.key);
        }
        sendEventResult(requester, result, result.accepted, result.reason);
    }
    function handleEventActivity(peer, message) {
        if (!peer.roomCode) {
            sendError(peer, "NOT_JOINED", "Join a room before publishing event activity.");
            return;
        }
        const activity = normalizeEventActivity(message);
        const room = rooms.get(peer.roomCode);
        if (!activity || !room) {
            sendError(peer, "INVALID_EVENT_ACTIVITY", "Shared event activity is invalid.");
            return;
        }
        if (peer.id !== room.hostId) {
            sendError(peer, "HOST_ONLY", "Only the host may publish shared event activity.");
            return;
        }
        const key = eventLockKey(activity.kind, activity.mapId, activity.eventId);
        if (activity.active) {
            const existing = room.activeEvents.get(key);
            if (existing) existing.status = "active";
            else room.activeEvents.set(key, {
                ...activity, key, requestId: null, requesterId: null,
                hostId: peer.id, status: "active"
            });
            return;
        }
        const lock = room.activeEvents.get(key);
        if (!lock) return;
        room.activeEvents.delete(key);
        if (!lock.requestId || !lock.requesterId) return;
        const requester = room.members.get(lock.requesterId);
        if (room.eventRequests.has(lock.requestId)) {
            room.eventRequests.delete(lock.requestId);
            sendEventResult(requester, lock, false, "EVENT_ENDED_BEFORE_ACCEPTANCE");
        } else if (requester) {
            safeSend(requester.socket, {
                type: "event_finished", requestId: lock.requestId,
                kind: lock.kind, mapId: lock.mapId, eventId: lock.eventId
            });
        }
    }

    wss.on("connection", socket => {
        if (wss.clients.size > maxClients) {
            safeSend(socket, {
                type: "error",
                code: "SERVER_FULL",
                message: "The server has reached its connection limit.",
                fatal: true
            });
            socket.close(1013, "server full");
            return;
        }

        const peer = {
            id: null,
            socket,
            roomCode: null,
            name: null,
            state: null,
            lastSequence: -1,
            alive: true
        };

        socket.on("pong", () => {
            peer.alive = true;
        });

        socket.on("message", data => {
            const byteLength = Buffer.isBuffer(data)
                ? data.length
                : Buffer.byteLength(String(data));

            if (byteLength > MAX_MESSAGE_BYTES) {
                sendError(peer, "MESSAGE_TOO_LARGE", "Message exceeds the configured limit.", true);
                socket.close(1009, "message too large");
                return;
            }

            let message;
            try {
                message = JSON.parse(data.toString("utf8"));
            } catch (_) {
                sendError(peer, "INVALID_JSON", "Message must contain valid JSON.");
                return;
            }

            if (!isRecord(message) || typeof message.type !== "string") {
                sendError(peer, "INVALID_MESSAGE", "Message must be a JSON object with a type.");
                return;
            }

            switch (message.type) {
                case "join":
                    joinRoom(peer, message);
                    break;
                case "state":
                    updateState(peer, message);
                    break;
                case "world_snapshot":
                    updateWorldSnapshot(peer, message);
                    break;
                case "world_request":
                    requestWorldChange(peer, message);
                    break;
                case "world_change":
                    publishWorldChange(peer, message);
                    break;
                case "party_snapshot":
                    publishPartySnapshot(peer, message);
                    break;
                case "event_request":
                    handleEventRequest(peer, message);
                    break;
                case "event_result":
                    handleEventResult(peer, message);
                    break;
                case "event_activity":
                    handleEventActivity(peer, message);
                    break;
                case "ping":
                    safeSend(socket, { type: "pong", timestamp: Date.now() });
                    break;
                case "leave":
                    removePeer(peer);
                    socket.close(1000, "client left room");
                    break;
                default:
                    sendError(peer, "UNKNOWN_MESSAGE", "Unsupported message type.");
            }
        });

        socket.on("close", () => removePeer(peer));
        socket.on("error", error => {
            console.warn("[Coop-Pl] socket error:", error.message);
            removePeer(peer);
        });
    });

    heartbeatTimer = setInterval(() => {
        for (const socket of wss.clients) {
            if (socket.readyState !== WebSocket.OPEN) continue;

            const peerAlive = socket.__coopAlive !== false;
            if (!peerAlive) {
                socket.terminate();
                continue;
            }

            socket.__coopAlive = false;
            socket.once("pong", () => {
                socket.__coopAlive = true;
            });
            try {
                socket.ping();
            } catch (_) {
                socket.terminate();
            }
        }
    }, 30000);

    wss.on("listening", () => {
        const address = wss.address();
        const actualPort = address && typeof address === "object" ? address.port : port;
        console.info("[Coop-Pl] WebSocket server listening on ws://" + host + ":" + actualPort);
        console.info("[Coop-Pl] Trusted LAN testing only; no authentication or TLS is built in.");
    });

    function close() {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        return new Promise(resolve => {
            for (const socket of wss.clients) socket.close(1001, "server shutting down");
            wss.close(() => resolve());
        });
    }

    return { wss, rooms, close };
}

if (require.main === module) {
    let instance;
    try {
        instance = startServer();
    } catch (error) {
        console.error("[Coop-Pl] Could not start:", error.message);
        process.exitCode = 1;
    }

    if (instance) {
        const shutdown = () => instance.close().finally(() => process.exit(0));
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
    }
}

module.exports = { startServer };
