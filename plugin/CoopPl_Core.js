/*:
 * @target MZ
 * @plugindesc Co-op prototype: exchange player position and appearance over WebSocket.
 * @author DarnoPort
 *
 * @param ServerUrl
 * @text WebSocket server URL
 * @type string
 * @default ws://127.0.0.1:8080
 *
 * @param RoomCode
 * @text Room code
 * @type string
 * @default TEST
 *
 * @param PlayerName
 * @text Player name
 * @type string
 * @default Player
 *
 * @param AutoConnect
 * @text Connect automatically on map
 * @type boolean
 * @default true
 *
 * @param SendIntervalFrames
 * @text State send interval (frames)
 * @type number
 * @min 1
 * @max 60
 * @default 6
 *
 * @param ReconnectDelayMs
 * @text Reconnect delay (ms)
 * @type number
 * @min 250
 * @max 30000
 * @default 3000
 *
 * @command Connect
 * @text Connect to co-op room
 *
 * @command Disconnect
 * @text Disconnect from co-op room
 *
 * @help
 * Coop-Pl prototype for RPG Maker MZ 1.10.x.
 *
 * Current scope:
 * - Connects to a Coop-Pl WebSocket server.
 * - Sends local map, position, direction and character graphics.
 * - Displays remote player sprites when they are on the same map.
 *
 * Not implemented yet: synchronized events, switches, variables, inventory,
 * combat, story progression, save state, authentication or secure public hosting.
 *
 * Setup:
 * 1. Copy this file into your game's js/plugins/ folder.
 * 2. Enable CoopPl_Core in Plugin Manager.
 * 3. Set ServerUrl and RoomCode. Give each player a distinguishable PlayerName.
 * 4. Start the companion server described in the repository README.
 *
 * Safety: the initial server is intended for trusted LAN testing only.
 * Do not expose a plain ws:// server to the public Internet.
 *
 * Plugin commands Connect and Disconnect are available to event commands.
 */

(() => {
    "use strict";

    const PLUGIN_NAME = "CoopPl_Core";
    const parameters = PluginManager.parameters(PLUGIN_NAME);

    const config = {
        serverUrl: String(parameters.ServerUrl || "ws://127.0.0.1:8080").trim(),
        roomCode: String(parameters.RoomCode || "TEST").trim(),
        playerName: String(parameters.PlayerName || "Player").trim(),
        autoConnect: parameters.AutoConnect !== "false",
        sendIntervalFrames: Math.max(1, Number.parseInt(parameters.SendIntervalFrames || "6", 10) || 6),
        reconnectDelayMs: Math.max(250, Number.parseInt(parameters.ReconnectDelayMs || "3000", 10) || 3000)
    };

    const log = (...args) => console.info("[Coop-Pl]", ...args);

    class CoopRemoteCharacter extends Game_Character {
        constructor() {
            super();
            this._coopMapId = 0;
            this._coopTargetRealX = 0;
            this._coopTargetRealY = 0;
            this._coopInitialized = false;
            this._transparent = false;
            this.setThrough(true);
            this.setPriorityType(1);
        }

        applyNetworkState(state) {
            if (!state || !Number.isInteger(state.mapId)) return;

            const mapChanged = this._coopMapId !== state.mapId;
            const dx = Math.abs((this._realX || 0) - state.realX);
            const dy = Math.abs((this._realY || 0) - state.realY);
            const shouldSnap = !this._coopInitialized || mapChanged || dx > 3 || dy > 3;

            this._coopMapId = state.mapId;
            this._x = state.x;
            this._y = state.y;
            this._coopTargetRealX = state.realX;
            this._coopTargetRealY = state.realY;

            if (shouldSnap) {
                this._realX = state.realX;
                this._realY = state.realY;
            }
            this._coopInitialized = true;

            if (this.characterName() !== state.characterName ||
                this.characterIndex() !== state.characterIndex) {
                this.setImage(state.characterName, state.characterIndex);
            }

            if ([2, 4, 6, 8].includes(state.direction)) {
                this.setDirection(state.direction);
            }

            if (Number.isInteger(state.pattern) && state.pattern >= 0 && state.pattern <= 2) {
                this.setPattern(state.pattern);
            }
        }

        updateNetworkInterpolation() {
            if (!this._coopInitialized) return;

            const factor = 0.35;
            const dx = this._coopTargetRealX - this._realX;
            const dy = this._coopTargetRealY - this._realY;

            this._realX = Math.abs(dx) < 0.025
                ? this._coopTargetRealX
                : this._realX + dx * factor;
            this._realY = Math.abs(dy) < 0.025
                ? this._coopTargetRealY
                : this._realY + dy * factor;
        }

        isTransparent() {
            return !this._coopInitialized ||
                this._transparent ||
                !$gameMap ||
                this._coopMapId !== $gameMap.mapId();
        }
    }

    const network = {
        socket: null,
        connected: false,
        connecting: false,
        manualDisconnect: false,
        localId: null,
        roomCode: config.roomCode,
        hostId: null,
        isHost: false,
        status: "not connected",
        sequence: 0,
        lastSendFrame: 0,
        reconnectTimer: null,
        remotePlayers: new Map(),

        setStatus(status) {
            this.status = status;
            log(status);
        },

        currentState() {
            if (!$gamePlayer || !$gameMap) return null;

            return {
                mapId: $gameMap.mapId(),
                x: $gamePlayer.x,
                y: $gamePlayer.y,
                realX: $gamePlayer._realX,
                realY: $gamePlayer._realY,
                direction: $gamePlayer.direction(),
                characterName: $gamePlayer.characterName(),
                characterIndex: $gamePlayer.characterIndex(),
                pattern: $gamePlayer.pattern()
            };
        },

        send(message) {
            if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
            try {
                this.socket.send(JSON.stringify(message));
                return true;
            } catch (error) {
                console.warn("[Coop-Pl] Send failed:", error);
                return false;
            }
        },

        connect() {
            this.manualDisconnect = false;

            if (this.socket &&
                (this.socket.readyState === WebSocket.OPEN ||
                 this.socket.readyState === WebSocket.CONNECTING)) {
                return;
            }

            if (typeof WebSocket === "undefined") {
                this.setStatus("WebSocket API is not available in this runtime");
                return;
            }

            let parsedUrl;
            try {
                parsedUrl = new URL(config.serverUrl);
            } catch (_) {
                this.setStatus("Invalid server URL");
                return;
            }

            if (parsedUrl.protocol !== "ws:" && parsedUrl.protocol !== "wss:") {
                this.setStatus("Server URL must use ws:// or wss://");
                return;
            }

            if (this.reconnectTimer) {
                clearTimeout(this.reconnectTimer);
                this.reconnectTimer = null;
            }

            this.roomCode = config.roomCode;
            this.connecting = true;
            this.setStatus("connecting to " + config.serverUrl);

            let socket;
            try {
                socket = new WebSocket(config.serverUrl);
            } catch (error) {
                this.connecting = false;
                this.setStatus("connection could not start: " + error.message);
                this.scheduleReconnect();
                return;
            }

            this.socket = socket;

            socket.addEventListener("open", () => {
                this.connecting = false;
                this.send({
                    type: "join",
                    room: this.roomCode,
                    name: config.playerName,
                    state: this.currentState(),
                    seq: this.sequence
                });
            });

            socket.addEventListener("message", event => {
                this.handleMessage(event.data);
            });

            socket.addEventListener("error", () => {
                this.setStatus("WebSocket connection error");
            });

            socket.addEventListener("close", event => {
                if (this.socket === socket) this.socket = null;
                this.connected = false;
                this.connecting = false;
                this.localId = null;
                this.hostId = null;
                this.isHost = false;
                this.remotePlayers.clear();
                this.setStatus("disconnected (code " + event.code + ")");
                this.scheduleReconnect();
            });
        },

        disconnect(permanent = true) {
            if (permanent) this.manualDisconnect = true;
            if (this.reconnectTimer) {
                clearTimeout(this.reconnectTimer);
                this.reconnectTimer = null;
            }

            const socket = this.socket;
            this.socket = null;
            this.connected = false;
            this.connecting = false;
            this.localId = null;
            this.hostId = null;
            this.isHost = false;
            this.remotePlayers.clear();

            if (socket && socket.readyState < WebSocket.CLOSING) {
                try {
                    socket.close(1000, "client requested disconnect");
                } catch (_) {
                    // A closing socket can throw in some embedded Chromium builds.
                }
            }

            this.setStatus("disconnected");
        },

        scheduleReconnect() {
            if (this.manualDisconnect || this.reconnectTimer) return;
            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null;
                this.connect();
            }, config.reconnectDelayMs);
        },

        handleMessage(rawData) {
            let message;
            try {
                message = JSON.parse(String(rawData));
            } catch (_) {
                console.warn("[Coop-Pl] Ignoring invalid server JSON");
                return;
            }

            switch (message.type) {
                case "welcome": {
                    this.connected = true;
                    this.connecting = false;
                    this.localId = String(message.playerId || "");
                    this.hostId = String(message.hostId || "");
                    this.isHost = Boolean(message.isHost);
                    this.remotePlayers.clear();

                    for (const player of (Array.isArray(message.players) ? message.players : [])) {
                        this.upsertRemote(player);
                    }

                    this.setStatus(
                        "connected to room " + String(message.room || this.roomCode) +
                        (this.isHost ? " (host)" : "")
                    );
                    break;
                }
                case "player_joined":
                    this.upsertRemote(message.player);
                    log("player joined:", message.player && message.player.name);
                    break;
                case "state":
                    if (String(message.playerId || "") !== this.localId) {
                        const current = this.remotePlayers.get(String(message.playerId || ""));
                        if (current) {
                            current.character.applyNetworkState(message.state);
                            current.name = String(message.name || current.name);
                            current.lastSequence = Number(message.seq) || 0;
                        } else {
                            this.upsertRemote({
                                playerId: message.playerId,
                                name: message.name,
                                state: message.state
                            });
                        }
                    }
                    break;
                case "player_left":
                    this.remotePlayers.delete(String(message.playerId || ""));
                    log("player left:", message.playerId);
                    break;
                case "host_changed":
                    this.hostId = String(message.hostId || "");
                    this.isHost = this.localId === this.hostId;
                    this.setStatus(this.connected
                        ? "connected to room " + this.roomCode + (this.isHost ? " (host)" : "")
                        : this.status);
                    break;
                case "pong":
                    break;
                case "error":
                    this.setStatus("server error " + String(message.code || "") +
                        ": " + String(message.message || "unknown error"));
                    if (message.fatal) this.manualDisconnect = true;
                    break;
                default:
                    console.warn("[Coop-Pl] Unknown server message:", message.type);
            }
        },

        upsertRemote(player) {
            if (!player || !player.playerId) return;

            const playerId = String(player.playerId);
            if (playerId === this.localId) return;

            let remote = this.remotePlayers.get(playerId);
            if (!remote) {
                remote = {
                    playerId,
                    name: String(player.name || "Player"),
                    character: new CoopRemoteCharacter(),
                    lastSequence: 0
                };
                this.remotePlayers.set(playerId, remote);
            }

            remote.name = String(player.name || remote.name);
            if (player.state) remote.character.applyNetworkState(player.state);
        },

        update() {
            if (!this.connected) return;
            if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
            if (Graphics.frameCount - this.lastSendFrame < config.sendIntervalFrames) return;

            const state = this.currentState();
            if (!state) return;

            this.lastSendFrame = Graphics.frameCount;
            this.sequence += 1;
            this.send({
                type: "state",
                seq: this.sequence,
                state
            });
        },

        getStatus() {
            return {
                connected: this.connected,
                connecting: this.connecting,
                status: this.status,
                roomCode: this.roomCode,
                localId: this.localId,
                isHost: this.isHost,
                remotePlayerCount: this.remotePlayers.size
            };
        }
    };

    PluginManager.registerCommand(PLUGIN_NAME, "Connect", () => network.connect());
    PluginManager.registerCommand(PLUGIN_NAME, "Disconnect", () => network.disconnect(true));

    const _Scene_Map_start = Scene_Map.prototype.start;
    Scene_Map.prototype.start = function() {
        _Scene_Map_start.call(this);
        if (config.autoConnect && !network.manualDisconnect) network.connect();
    };

    const _Scene_Map_update = Scene_Map.prototype.update;
    Scene_Map.prototype.update = function() {
        _Scene_Map_update.call(this);
        network.update();
    };

    const _Spriteset_Map_update = Spriteset_Map.prototype.update;
    Spriteset_Map.prototype.update = function() {
        _Spriteset_Map_update.call(this);
        this.updateCoopRemoteSprites();
    };

    Spriteset_Map.prototype.updateCoopRemoteSprites = function() {
        if (!this._coopRemoteSprites) this._coopRemoteSprites = new Map();

        const activeIds = new Set(network.remotePlayers.keys());

        for (const [playerId, sprite] of this._coopRemoteSprites) {
            if (!activeIds.has(playerId)) {
                if (sprite.parent) sprite.parent.removeChild(sprite);
                sprite.destroy();
                this._coopRemoteSprites.delete(playerId);
            }
        }

        for (const [playerId, remote] of network.remotePlayers) {
            remote.character.updateNetworkInterpolation();

            let sprite = this._coopRemoteSprites.get(playerId);
            if (!sprite) {
                sprite = new Sprite_Character(remote.character);
                this._tilemap.addChild(sprite);
                this._coopRemoteSprites.set(playerId, sprite);
            }
        }
    };

    window.CoopPl = {
        connect: () => network.connect(),
        disconnect: () => network.disconnect(true),
        status: () => network.getStatus()
    };

    window.addEventListener("beforeunload", () => network.disconnect(true));

    log("plugin loaded; auto-connect:", config.autoConnect);
})();
