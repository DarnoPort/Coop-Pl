"use strict";

const { randomUUID } = require("node:crypto");
const { WebSocketServer, WebSocket } = require("ws");
const {
    isRecord,
    normalizeRoomCode,
    normalizePlayerName,
    normalizeState,
    normalizeSequence
} = require("./protocol");

const MAX_MESSAGE_BYTES = 16 * 1024;
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
    const port = Number(options.port || process.env.COOP_PORT || 8080);
    const maxPlayers = Number(options.maxPlayers || process.env.COOP_MAX_PLAYERS || DEFAULT_MAX_PLAYERS);
    const maxClients = Number(options.maxClients || process.env.COOP_MAX_CLIENTS || DEFAULT_MAX_CLIENTS);

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("COOP_PORT must be an integer between 1 and 65535");
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

        if (room.hostId === peer.id) {
            const next = room.members.keys().next();
            room.hostId = next.done ? null : next.value;
            if (room.hostId) {
                broadcast(room, { type: "host_changed", hostId: room.hostId });
            }
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
            room = { code: roomCode, hostId: null, members: new Map() };
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
            players: Array.from(room.members.values(), publicPlayer)
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
        console.info("[Coop-Pl] WebSocket server listening on ws://" + host + ":" + port);
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
