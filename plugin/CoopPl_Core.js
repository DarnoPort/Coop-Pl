/*:
 * @target MZ
 * @plugindesc Coop-Pl: network players and sync shared switches/variables over WebSocket.
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
 * @param SyncSwitchesVariables
 * @text Sync shared switches and variables
 * @type boolean
 * @default true
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
 * - Synchronizes RPG Maker switches and primitive variable values through the host.
 *
 * Switches and variables are host-authoritative: guest event commands request a
 * change; the host applies it and the server broadcasts the accepted value.
 * Variable values are limited to JSON-safe primitives (number, string, boolean,
 * null); plugin-specific objects/arrays are not synchronized.
 *
 * Shared map events and common-event calls are host-authoritative. Guests request
 * activation instead of executing shared event command lists a second time.
 * Put <CoopLocal> in an event/common-event comment to keep that content client-local.
 *
 * Standard Show Text commands (101/401) from host-owned shared events are mirrored
 * to guests on the same map. The host remains the only client executing event logic.
 * Choices, movement routes, battles, and event-driven map transfers are not yet
 * synchronized. The host must be on the same map for a guest map-event request.
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
        reconnectDelayMs: Math.max(250, Number.parseInt(parameters.ReconnectDelayMs || "3000", 10) || 3000),
        syncSwitchesVariables: parameters.SyncSwitchesVariables !== "false"
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
        applyingWorldState: false,
        applyingPartyState: false,
        pendingPartySnapshot: null,
        pendingWorldRequests: new Map(),
        pendingEventRequests: new Map(),
        pendingEventKeys: new Map(),
        pendingEventUi: [],
        pendingChoiceResults: new Map(),
        choiceSequence: 0,
        activeRemoteChoice: null,
        remoteChoiceResolved: false,
        eventRequestSequence: 0,
        activeSharedEvents: new Set(),
        lastWorldRevision: 0,
        warnedVariableTypes: new Set(),

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



        createPartySnapshot() {
            if (typeof $gameParty === "undefined" || !$gameParty ||
                typeof $gameActors === "undefined" || !$gameActors) return null;

            const inventorySnapshot = source => {
                const result = {};
                let count = 0;
                for (const [rawId, quantity] of Object.entries(source || {})) {
                    const id = Number(rawId);
                    if (!Number.isInteger(id) || id < 1 || id > 999999 ||
                        !Number.isInteger(quantity) || quantity < 1 || count >= 2000) continue;
                    result[String(id)] = quantity;
                    count += 1;
                }
                return result;
            };

            const ids = Array.isArray($gameParty._actors) ? $gameParty._actors.slice(0, 32) : [];
            const actors = [];
            for (const rawActorId of ids) {
                const actorId = Number(rawActorId);
                if (!Number.isInteger(actorId) || actorId < 1) continue;
                const actor = $gameActors.actor(actorId);
                if (!actor) continue;

                const currentClass = typeof actor.currentClass === "function" ? actor.currentClass() : null;
                const expValue = typeof actor.currentExp === "function" ? actor.currentExp() :
                    (actor._exp && currentClass ? actor._exp[currentClass.id] : 0);
                const equips = typeof actor.equips === "function" ? actor.equips() : [];
                const normalizedEquips = (Array.isArray(equips) ? equips : []).slice(0, 16).map(item => {
                    if (!item) return null;
                    if ($dataWeapons && $dataWeapons[item.id] === item) return { kind: "weapon", id: item.id };
                    if ($dataArmors && $dataArmors[item.id] === item) return { kind: "armor", id: item.id };
                    return null;
                });
                const safeIds = (list, limit) => Array.isArray(list)
                    ? list.filter(id => Number.isInteger(id) && id > 0 && id <= 999999).slice(0, limit)
                    : [];
                const buffs = Array.isArray(actor._buffs)
                    ? actor._buffs.slice(0, 32).map(level =>
                        Math.max(-2, Math.min(2, Math.trunc(Number(level) || 0))))
                    : [];
                const buffTurns = Array.isArray(actor._buffTurns)
                    ? actor._buffTurns.slice(0, buffs.length).map(turns =>
                        Math.max(0, Math.trunc(Number(turns) || 0)))
                    : [];
                while (buffTurns.length < buffs.length) buffTurns.push(0);
                const stateTurns = {};
                if (actor._stateTurns && typeof actor._stateTurns === "object") {
                    for (const [stateId, turns] of Object.entries(actor._stateTurns)) {
                        if (/^[1-9][0-9]{0,5}$/.test(stateId) &&
                            Number.isInteger(turns) && turns >= 0 && turns <= 999999) {
                            stateTurns[stateId] = turns;
                        }
                    }
                }

                actors.push({
                    actorId,
                    classId: currentClass && Number.isInteger(currentClass.id) && currentClass.id > 0
                        ? currentClass.id : Math.max(1, Number(actor._classId) || 1),
                    exp: Math.max(0, Math.min(1000000000000, Math.trunc(Number(expValue) || 0))),
                    hp: Math.max(0, Math.min(9999999, Math.trunc(Number(actor.hp) || 0))),
                    mp: Math.max(0, Math.min(9999999, Math.trunc(Number(actor.mp) || 0))),
                    tp: Math.max(0, Math.min(100, Math.trunc(Number(actor.tp) || 0))),
                    states: safeIds(actor._states, 128),
                    stateTurns,
                    skills: safeIds(actor._skills, 256),
                    buffs,
                    buffTurns,
                    equips: normalizedEquips,
                    name: typeof actor.name === "function" ? String(actor.name()).slice(0, 64) : undefined
                });
            }

            const gold = typeof $gameParty.gold === "function" ? $gameParty.gold() : $gameParty._gold;
            return {
                gold: Math.max(0, Math.min(999999999, Math.trunc(Number(gold) || 0))),
                items: inventorySnapshot($gameParty._items),
                weapons: inventorySnapshot($gameParty._weapons),
                armors: inventorySnapshot($gameParty._armors),
                actors
            };
        },

        sendPartySnapshot() {
            if (!this.connected || !this.isHost || !this.socket ||
                typeof $gameParty === "undefined" || !$gameParty) return false;
            const party = this.createPartySnapshot();
            if (!party) return false;
            if (JSON.stringify(party).length > 220 * 1024) {
                console.warn("[Coop-Pl] Party snapshot is too large; it was not sent.");
                return false;
            }
            return this.send({ type: "party_snapshot", party });
        },

        applyPartySnapshot(snapshot) {
            if (this.isHost || !snapshot || typeof snapshot !== "object" ||
                typeof $gameParty === "undefined" || !$gameParty) return false;
            if (typeof $gameParty.inBattle === "function" && $gameParty.inBattle()) {
                this.pendingPartySnapshot = snapshot;
                return false;
            }
            if (!Array.isArray(snapshot.actors) || snapshot.actors.length > 32 ||
                !Number.isInteger(snapshot.gold) || snapshot.gold < 0) return false;

            this.applyingPartyState = true;
            try {
                const party = $gameParty;
                if (Array.isArray(party._actors) &&
                    typeof party.removeActor === "function" &&
                    typeof party.addActor === "function") {
                    for (const actorId of party._actors.slice()) party.removeActor(actorId);
                    for (const state of snapshot.actors) {
                        if (state && Number.isInteger(state.actorId) && state.actorId > 0) {
                            party.addActor(state.actorId);
                        }
                    }
                }

                const copyInventory = source => {
                    const result = {};
                    if (!source || typeof source !== "object" || Array.isArray(source)) return result;
                    for (const [rawId, quantity] of Object.entries(source)) {
                        if (/^[1-9][0-9]{0,5}$/.test(rawId) &&
                            Number.isInteger(quantity) && quantity > 0 && quantity <= 999999) {
                            result[rawId] = quantity;
                        }
                    }
                    return result;
                };

                for (const state of snapshot.actors) {
                    if (!state || !Number.isInteger(state.actorId) || !Number.isInteger(state.classId)) continue;
                    const actor = $gameActors && typeof $gameActors.actor === "function"
                        ? $gameActors.actor(state.actorId) : null;
                    if (!actor) continue;

                    const currentClass = typeof actor.currentClass === "function" ? actor.currentClass() : null;
                    if (currentClass && currentClass.id !== state.classId &&
                        typeof actor.changeClass === "function") actor.changeClass(state.classId, false);
                    if (typeof actor.changeExp === "function") actor.changeExp(state.exp, false);
                    if (typeof actor.setName === "function" && typeof state.name === "string") {
                        actor.setName(state.name);
                    }

                    actor._skills = Array.isArray(state.skills) ? state.skills.slice(0, 256) : [];
                    actor._states = Array.isArray(state.states) ? state.states.slice(0, 128) : [];
                    actor._stateTurns = state.stateTurns &&
                        typeof state.stateTurns === "object" && !Array.isArray(state.stateTurns)
                        ? Object.assign({}, state.stateTurns) : {};
                    actor._buffs = Array.isArray(state.buffs) ? state.buffs.slice(0, 32) : [];
                    actor._buffTurns = Array.isArray(state.buffTurns)
                        ? state.buffTurns.slice(0, actor._buffs.length) : [];
                    if (typeof actor.forceChangeEquip === "function" && Array.isArray(state.equips)) {
                        const equips = state.equips.slice(0, 16);
                        const slotCount = typeof actor.equips === "function" ? actor.equips().length : equips.length;
                        for (let slot = 0; slot < Math.min(equips.length, slotCount); slot++) {
                            const descriptor = equips[slot];
                            let item = null;
                            if (descriptor && descriptor.kind === "weapon" && $dataWeapons) {
                                item = $dataWeapons[descriptor.id] || null;
                            } else if (descriptor && descriptor.kind === "armor" && $dataArmors) {
                                item = $dataArmors[descriptor.id] || null;
                            }
                            actor.forceChangeEquip(slot, item);
                        }
                    }
                    if (typeof actor.refresh === "function") actor.refresh();
                    if (typeof actor.setHp === "function") actor.setHp(state.hp);
                    if (typeof actor.setMp === "function") actor.setMp(state.mp);
                    if (typeof actor.setTp === "function") actor.setTp(state.tp);
                }

                party._items = copyInventory(snapshot.items);
                party._weapons = copyInventory(snapshot.weapons);
                party._armors = copyInventory(snapshot.armors);
                party._gold = snapshot.gold;
                if ($gamePlayer && typeof $gamePlayer.refresh === "function") $gamePlayer.refresh();
                if ($gameMap && typeof $gameMap.requestRefresh === "function") $gameMap.requestRefresh();
            } finally {
                this.applyingPartyState = false;
            }

            this.pendingPartySnapshot = null;
            return true;
        },

        applyPendingPartySnapshot() {
            if (!this.pendingPartySnapshot ||
                ($gameParty && typeof $gameParty.inBattle === "function" && $gameParty.inBattle())) return;
            const snapshot = this.pendingPartySnapshot;
            this.pendingPartySnapshot = null;
            this.applyPartySnapshot(snapshot);
        },

        isLocalEventData(data) {
            if (!data) return false;
            if (typeof data.note === "string" && /<CoopLocal(?:\s|>)/i.test(data.note)) return true;
            const hasTag = list => Array.isArray(list) && list.some(command =>
                command && (command.code === 108 || command.code === 408) &&
                Array.isArray(command.parameters) &&
                /<CoopLocal(?:\s|>)/i.test(String(command.parameters[0] || "")));
            if (hasTag(data.list)) return true;
            return Array.isArray(data.pages) && data.pages.some(page => page && hasTag(page.list));
        },
        isLocalMapEvent(event) {
            return this.isLocalEventData(event && typeof event.event === "function" ? event.event() : null);
        },
        isLocalCommonEvent(eventId) {
            return Boolean($dataCommonEvents && this.isLocalEventData($dataCommonEvents[eventId]));
        },
        normalizeSelfSwitchKey(key) {
            const raw = Array.isArray(key) ? key.join(",") : String(key || "");
            return /^[1-9][0-9]{0,5},[1-9][0-9]{0,5},[A-D]$/.test(raw) ? raw : null;
        },
        eventKey(kind, mapId, eventId) {
            return kind + ":" + mapId + ":" + eventId;
        },
        requestEvent(kind, mapId, eventId) {
            if (!this.connected || this.isHost || !["map", "common"].includes(kind) ||
                !Number.isInteger(mapId) || mapId < 1 ||
                !Number.isInteger(eventId) || eventId < 1) return null;
            const key = this.eventKey(kind, mapId, eventId);
            if (this.pendingEventKeys.has(key)) return this.pendingEventKeys.get(key);

            // Send fresh position/map state immediately before the interaction request.
            // This avoids stale-map rejections when a player interacts just after transfer.
            const currentState = this.currentState();
            if (!currentState) return null;
            this.sequence += 1;
            if (!this.send({ type: "state", seq: this.sequence, state: currentState })) return null;
            this.lastSendFrame = Graphics.frameCount;

            this.eventRequestSequence += 1;
            const requestId = "ev-" + Date.now().toString(36) + "-" + this.eventRequestSequence.toString(36);
            this.pendingEventRequests.set(requestId, {
                requestId, kind, mapId, eventId, key, accepted: false, createdAt: Date.now()
            });
            this.pendingEventKeys.set(key, requestId);
            if (!this.send({ type: "event_request", requestId, kind, mapId, eventId })) {
                this.pendingEventRequests.delete(requestId);
                this.pendingEventKeys.delete(key);
                return null;
            }
            return requestId;
        },
        requestMapEvent(event) {
            if (!event || !event.isTriggerIn || !event.isTriggerIn([0, 1, 2]) || !$gameMap) return null;
            return this.requestEvent("map", $gameMap.mapId(), event.eventId());
        },
        requestCommonEvent(eventId) {
            if (!$gameMap || !Number.isInteger(Number(eventId))) return null;
            return this.requestEvent("common", $gameMap.mapId(), Number(eventId));
        },

        publishSharedText(interpreter) {
            if (!this.connected || !this.isHost || !interpreter ||
                !["map", "common"].includes(interpreter._coopEventKind) ||
                !Number.isInteger(interpreter._coopEventMapId) ||
                !Number.isInteger(interpreter._coopEventId)) return false;

            const params = Array.isArray(interpreter._params) ? interpreter._params : [];
            const list = Array.isArray(interpreter._list) ? interpreter._list : [];
            const lines = [];
            let totalLength = 0;
            for (let index = Number(interpreter._index) + 1;
                index < list.length && list[index] && list[index].code === 401;
                index++) {
                const rawText = list[index].parameters && list[index].parameters[0];
                const line = typeof rawText === "string" ? rawText : String(rawText || "");
                if (lines.length >= 40 || line.length > 4096) return false;
                totalLength += line.length;
                if (totalLength > 32768) return false;
                lines.push(line);
            }
            if (lines.length === 0) return false;

            const faceName = String(params[0] || "");
            const faceIndex = Number(params[1]) || 0;
            const background = Number(params[2]) || 0;
            const positionType = Number(params[3]) || 0;
            if (faceName.length > 64 || faceName.includes("/") || faceName.includes("\\") ||
                /[\u0000-\u001f\u007f]/.test(faceName) ||
                !Number.isInteger(faceIndex) || faceIndex < 0 || faceIndex > 7 ||
                !Number.isInteger(background) || background < 0 || background > 2 ||
                !Number.isInteger(positionType) || positionType < 0 || positionType > 2) return false;

            return this.send({
                type: "event_ui",
                kind: interpreter._coopEventKind,
                mapId: interpreter._coopEventMapId,
                eventId: interpreter._coopEventId,
                action: "show_text",
                faceName,
                faceIndex,
                background,
                positionType,
                lines
            });
        },

        publishSharedChoices(interpreter, params) {
            if (!this.connected || !this.isHost || !interpreter ||
                !["map", "common"].includes(interpreter._coopEventKind) ||
                !Number.isInteger(interpreter._coopEventMapId) ||
                !Number.isInteger(interpreter._coopEventId) ||
                !Array.isArray(params) || !Array.isArray(params[0]) ||
                params[0].length < 1 || params[0].length > 20) return null;

            const choices = params[0].map(value => String(value));
            if (choices.some(value => value.length > 1024) ||
                choices.reduce((total, value) => total + value.length, 0) > 8192) return null;
            const cancelType = Number.isInteger(params[1]) ? params[1] : -2;
            const defaultType = Number.isInteger(params[2]) ? params[2] : -1;
            const positionType = Number.isInteger(params[3]) ? params[3] : 2;
            const background = Number.isInteger(params[4]) ? params[4] : 0;
            if (cancelType < -2 || cancelType >= choices.length ||
                defaultType < -1 || defaultType >= choices.length ||
                positionType < 0 || positionType > 2 ||
                background < 0 || background > 2) return null;

            this.choiceSequence += 1;
            const choiceId = "choice-" + Date.now().toString(36) + "-" + this.choiceSequence.toString(36);
            const context = {
                choiceId,
                kind: interpreter._coopEventKind,
                mapId: interpreter._coopEventMapId,
                eventId: interpreter._coopEventId
            };
            const sent = this.send({
                type: "event_ui",
                ...context,
                action: "show_choices",
                choices,
                cancelType,
                defaultType,
                positionType,
                background
            });
            return sent ? { ...context, choices } : null;
        },

        publishSharedChoiceResult(context, result) {
            if (!this.connected || !this.isHost || !context ||
                !Number.isInteger(result) || result < -1 || result > 19) return false;
            return this.send({
                type: "event_choice_result",
                choiceId: context.choiceId,
                kind: context.kind,
                mapId: context.mapId,
                eventId: context.eventId,
                result
            });
        },

        queueSharedEventUi(message) {
            if (!this.connected || this.isHost || !message || !$gameMap ||
                message.mapId !== $gameMap.mapId() ||
                !["map", "common"].includes(message.kind) ||
                !Number.isInteger(message.eventId) || message.eventId < 1 ||
                this.pendingEventUi.length >= 100) return false;

            if (message.action === "show_text") {
                if (typeof message.faceName !== "string" || message.faceName.length > 64 ||
                    !Number.isInteger(message.faceIndex) || message.faceIndex < 0 || message.faceIndex > 7 ||
                    !Number.isInteger(message.background) || message.background < 0 || message.background > 2 ||
                    !Number.isInteger(message.positionType) || message.positionType < 0 || message.positionType > 2 ||
                    !Array.isArray(message.lines) || message.lines.length < 1 || message.lines.length > 40) return false;
                let totalLength = 0;
                for (const line of message.lines) {
                    if (typeof line !== "string" || line.length > 4096) return false;
                    totalLength += line.length;
                    if (totalLength > 32768) return false;
                }
                this.pendingEventUi.push({
                    action: "show_text",
                    faceName: message.faceName,
                    faceIndex: message.faceIndex,
                    background: message.background,
                    positionType: message.positionType,
                    lines: message.lines.slice()
                });
                return true;
            }

            if (message.action === "show_choices") {
                if (typeof message.choiceId !== "string" ||
                    !/^[A-Za-z0-9_-]{1,96}$/.test(message.choiceId) ||
                    !Array.isArray(message.choices) || message.choices.length < 1 || message.choices.length > 20 ||
                    !Number.isInteger(message.cancelType) || message.cancelType < -2 ||
                    message.cancelType >= message.choices.length ||
                    !Number.isInteger(message.defaultType) || message.defaultType < -1 ||
                    message.defaultType >= message.choices.length ||
                    !Number.isInteger(message.positionType) || message.positionType < 0 || message.positionType > 2 ||
                    !Number.isInteger(message.background) || message.background < 0 || message.background > 2) return false;
                let totalLength = 0;
                for (const choice of message.choices) {
                    if (typeof choice !== "string" || choice.length > 1024) return false;
                    totalLength += choice.length;
                    if (totalLength > 8192) return false;
                }
                this.pendingEventUi.push({
                    action: "show_choices",
                    choiceId: message.choiceId,
                    kind: message.kind,
                    mapId: message.mapId,
                    eventId: message.eventId,
                    choices: message.choices.slice(),
                    cancelType: message.cancelType,
                    defaultType: message.defaultType,
                    positionType: message.positionType,
                    background: message.background
                });
                return true;
            }
            return false;
        },

        receiveSharedChoiceResult(message) {
            if (this.isHost || !message || !$gameMap ||
                message.mapId !== $gameMap.mapId() ||
                !["map", "common"].includes(message.kind) ||
                !Number.isInteger(message.eventId) || message.eventId < 1 ||
                typeof message.choiceId !== "string" ||
                !/^[A-Za-z0-9_-]{1,96}$/.test(message.choiceId) ||
                !Number.isInteger(message.result) || message.result < -1 || message.result > 19) return false;

            const result = {
                choiceId: message.choiceId, kind: message.kind,
                mapId: message.mapId, eventId: message.eventId, result: message.result
            };
            if (this.activeRemoteChoice && this.activeRemoteChoice.choiceId === result.choiceId) {
                return this.applySharedChoiceResult(result);
            }
            if (this.pendingChoiceResults.size >= 100) {
                const oldest = this.pendingChoiceResults.keys().next().value;
                if (oldest !== undefined) this.pendingChoiceResults.delete(oldest);
            }
            this.pendingChoiceResults.set(result.choiceId, result);
            return true;
        },

        applySharedChoiceResult(result) {
            const active = this.activeRemoteChoice;
            if (!result || !active || active.choiceId !== result.choiceId ||
                result.kind !== active.kind || result.mapId !== active.mapId ||
                result.eventId !== active.eventId ||
                result.result < -1 || result.result >= active.choices.length) return false;

            this.remoteChoiceResolved = true;
            active.result = result.result;
            const scene = typeof SceneManager !== "undefined" ? SceneManager._scene : null;
            const messageWindow = scene && scene._messageWindow;
            const choiceWindow = messageWindow && messageWindow._choiceListWindow;
            if (choiceWindow && typeof choiceWindow.select === "function") {
                if (result.result >= 0) {
                    choiceWindow.select(result.result);
                } else if (typeof choiceWindow.processOk === "function") {
                    // A host cancellation has no selectable row on the guest. Acknowledge
                    // through a valid row immediately; the guest callback is intentionally a no-op.
                    choiceWindow.select(active.defaultType >= 0 ? active.defaultType : 0);
                    choiceWindow.processOk();
                }
            }
            return true;
        },

        clearRemoteChoice() {
            this.activeRemoteChoice = null;
            this.remoteChoiceResolved = false;
        },

        drainSharedEventUi() {
            if (!this.connected || this.isHost || this.pendingEventUi.length === 0 ||
                typeof $gameMessage === "undefined" || !$gameMessage ||
                typeof $gameMessage.isBusy !== "function" || $gameMessage.isBusy()) return false;

            const message = this.pendingEventUi[0];
            if (message.action === "show_text") {
                if (typeof $gameMessage.setFaceImage !== "function" ||
                    typeof $gameMessage.setBackground !== "function" ||
                    typeof $gameMessage.setPositionType !== "function" ||
                    typeof $gameMessage.add !== "function") return false;
                this.pendingEventUi.shift();
                $gameMessage.setFaceImage(message.faceName, message.faceIndex);
                $gameMessage.setBackground(message.background);
                $gameMessage.setPositionType(message.positionType);
                for (const line of message.lines) $gameMessage.add(line);
                return true;
            }

            if (message.action === "show_choices") {
                if (typeof $gameMessage.setChoices !== "function" ||
                    typeof $gameMessage.setChoiceBackground !== "function" ||
                    typeof $gameMessage.setChoicePositionType !== "function" ||
                    typeof $gameMessage.setChoiceCallback !== "function") return false;
                this.pendingEventUi.shift();
                this.activeRemoteChoice = {
                    choiceId: message.choiceId,
                    kind: message.kind,
                    mapId: message.mapId,
                    eventId: message.eventId,
                    choices: message.choices.slice(),
                    defaultType: message.defaultType,
                    result: null
                };
                this.remoteChoiceResolved = false;
                $gameMessage.setChoices(message.choices.slice(), message.defaultType, message.cancelType);
                $gameMessage.setChoiceBackground(message.background);
                $gameMessage.setChoicePositionType(message.positionType);
                $gameMessage.setChoiceCallback(() => {});
                const pendingResult = this.pendingChoiceResults.get(message.choiceId);
                if (pendingResult) {
                    this.pendingChoiceResults.delete(message.choiceId);
                    this.applySharedChoiceResult(pendingResult);
                }
                return true;
            }
            this.pendingEventUi.shift();
            return false;
        },
        isPlayerNearEvent(playerState, event) {
            if (!playerState || !event || playerState.mapId !== ($gameMap ? $gameMap.mapId() : 0)) return false;
            const dx = Number(event.x) - playerState.x;
            const dy = Number(event.y) - playerState.y;
            if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
            if (Number(event._trigger) === 0) {
                const facing = { 2: [0, 1], 4: [-1, 0], 6: [1, 0], 8: [0, -1] }[playerState.direction];
                return Boolean(facing && Number(event.x) === playerState.x + facing[0] &&
                    Number(event.y) === playerState.y + facing[1]);
            }
            // Player Touch and Event Touch require both characters to occupy the same tile.
            return dx === 0 && dy === 0;
        },
        sendEventResult(request, accepted, reason) {
            if (!request) return false;
            const result = {
                type: "event_result", requestId: request.requestId, kind: request.kind,
                mapId: request.mapId, eventId: request.eventId, accepted: Boolean(accepted)
            };
            if (reason) result.reason = String(reason).slice(0, 64);
            return this.send(result);
        },
        handleEventRequest(message) {
            if (!this.connected || !this.isHost || !message) return;
            const request = {
                requestId: String(message.requestId || ""), kind: message.kind,
                mapId: message.mapId, eventId: message.eventId
            };
            const valid = /^[A-Za-z0-9_-]{1,96}$/.test(request.requestId) &&
                ["map", "common"].includes(request.kind) &&
                Number.isInteger(request.mapId) && request.mapId > 0 &&
                Number.isInteger(request.eventId) && request.eventId > 0;
            if (!valid || !$gameMap || request.mapId !== $gameMap.mapId()) {
                this.sendEventResult(request, false, "MAP_MISMATCH");
                return;
            }
            const key = this.eventKey(request.kind, request.mapId, request.eventId);
            if (this.activeSharedEvents.has(key)) {
                this.sendEventResult(request, false, "EVENT_BUSY");
                return;
            }
            if (request.kind === "map") {
                const event = $gameMap.event(request.eventId);
                if (!event || this.isLocalMapEvent(event) ||
                    !event.isTriggerIn || !event.isTriggerIn([0, 1, 2]) ||
                    (event.isStarting && event.isStarting()) ||
                    !this.isPlayerNearEvent(message.playerState, event)) {
                    this.sendEventResult(request, false, "EVENT_NOT_AVAILABLE");
                    return;
                }
                event.start();
                if (event.isStarting && !event.isStarting()) {
                    this.sendEventResult(request, false, "EVENT_COULD_NOT_START");
                    return;
                }
                this.sendEventResult(request, true);
                return;
            }
            const commonEvent = $dataCommonEvents && $dataCommonEvents[request.eventId];
            if (!commonEvent || this.isLocalEventData(commonEvent) || commonEvent.trigger !== 0 ||
                !$gameTemp || typeof $gameTemp.reserveCommonEvent !== "function" ||
                ($gameTemp.isCommonEventReserved && $gameTemp.isCommonEventReserved())) {
                this.sendEventResult(request, false, "COMMON_EVENT_NOT_AVAILABLE");
                return;
            }
            $gameTemp.reserveCommonEvent(request.eventId);
            this.sendEventResult(request, true);
        },
        handleEventResult(message) {
            if (!message || typeof message.requestId !== "string") return;
            const pending = this.pendingEventRequests.get(message.requestId);
            if (!pending || pending.kind !== message.kind ||
                pending.mapId !== message.mapId || pending.eventId !== message.eventId) return;
            if (message.accepted) {
                pending.accepted = true;
                return;
            }
            this.pendingEventRequests.delete(pending.requestId);
            this.pendingEventKeys.delete(pending.key);
            log("shared event rejected:", pending.kind, pending.eventId, message.reason || "request rejected");
        },
        handleEventFinished(message) {
            if (!message || typeof message.requestId !== "string") return;
            const pending = this.pendingEventRequests.get(message.requestId);
            if (!pending || pending.kind !== message.kind ||
                pending.mapId !== message.mapId || pending.eventId !== message.eventId) return;
            this.pendingEventRequests.delete(pending.requestId);
            this.pendingEventKeys.delete(pending.key);
        },
        sendEventActivity(kind, mapId, eventId, active) {
            this.send({ type: "event_activity",
                requestId: "activity-" + kind + "-" + mapId + "-" + eventId,
                kind, mapId, eventId, active });
        },
        registerSharedEvent(kind, mapId, eventId) {
            if (!this.connected || !this.isHost || !Number.isInteger(mapId) ||
                mapId < 1 || !Number.isInteger(eventId) || eventId < 1) return;
            const key = this.eventKey(kind, mapId, eventId);
            if (this.activeSharedEvents.has(key)) return;
            this.activeSharedEvents.add(key);
            this.sendEventActivity(kind, mapId, eventId, true);
        },
        finishSharedEvent(kind, mapId, eventId) {
            const key = this.eventKey(kind, mapId, eventId);
            if (!this.activeSharedEvents.has(key)) return;
            this.activeSharedEvents.delete(key);
            if (this.connected && this.isHost) this.sendEventActivity(kind, mapId, eventId, false);
        },
        finishInterpreterEvent(interpreter) {
            if (!interpreter) return;
            if (interpreter._coopEventKind && Number.isInteger(interpreter._coopEventMapId) &&
                Number.isInteger(interpreter._coopEventId)) {
                // Send state-changing event rewards before the requester's finished signal.
                this.sendPartySnapshot();
                this.finishSharedEvent(interpreter._coopEventKind,
                    interpreter._coopEventMapId, interpreter._coopEventId);
            }
            interpreter._coopEventKind = null;
            interpreter._coopEventMapId = null;
            interpreter._coopEventId = null;
        },
        publishSelfSwitchChange(key, value) {
            const normalizedKey = this.normalizeSelfSwitchKey(key);
            if (!config.syncSwitchesVariables || !this.connected || !this.isHost ||
                this.applyingWorldState || !normalizedKey || typeof value !== "boolean") return;
            this.send({ type: "world_change", kind: "selfSwitch", key: normalizedKey, value });
        },
        requestSelfSwitchChange(key, value) {
            const normalizedKey = this.normalizeSelfSwitchKey(key);
            if (!config.syncSwitchesVariables || !this.connected || this.isHost ||
                !normalizedKey || typeof value !== "boolean") return false;
            const pendingKey = "selfSwitch:" + normalizedKey;
            const encoded = JSON.stringify(value);
            if (this.pendingWorldRequests.get(pendingKey) === encoded) return true;
            this.pendingWorldRequests.set(pendingKey, encoded);
            const sent = this.send({ type: "world_request", kind: "selfSwitch", key: normalizedKey, value });
            if (!sent) this.pendingWorldRequests.delete(pendingKey);
            return sent;
        },

        normalizeSharedValue(value) {
            if (value === null || typeof value === "boolean") return value;
            if (typeof value === "number") {
                return Number.isFinite(value) ? value : undefined;
            }
            if (typeof value === "string" && value.length <= 4096) return value;
            return undefined;
        },

        normalizedVariableValue(value) {
            return typeof value === "number" ? Math.floor(value) : value;
        },

        isValidWorldId(kind, id) {
            if (!Number.isInteger(id) || id < 1) return false;
            if (!$dataSystem) return false;
            const table = kind === "switch" ? $dataSystem.switches :
                kind === "variable" ? $dataSystem.variables : null;
            return Array.isArray(table) && id < table.length && id <= 999999;
        },

        publishWorldChange(kind, id, value) {
            if (!config.syncSwitchesVariables || !this.connected || !this.isHost ||
                this.applyingWorldState || !this.isValidWorldId(kind, id)) return;

            const normalized = kind === "variable" ? this.normalizedVariableValue(value) : value;
            if (kind === "switch" && typeof normalized !== "boolean") return;
            if (this.normalizeSharedValue(normalized) === undefined &&
                normalized !== null) {
                const warningKey = kind + ":" + id;
                if (!this.warnedVariableTypes.has(warningKey)) {
                    this.warnedVariableTypes.add(warningKey);
                    console.warn("[Coop-Pl] Variable " + id +
                        " uses a non-primitive value; this value will not be synchronized.");
                }
                return;
            }

            this.send({
                type: "world_change",
                kind,
                id,
                value: normalized
            });
        },

        requestWorldChange(kind, id, value) {
            if (!config.syncSwitchesVariables || !this.connected || this.isHost ||
                !this.isValidWorldId(kind, id)) return false;

            const normalized = kind === "variable" ? this.normalizedVariableValue(value) : value;
            if (kind === "switch" && typeof normalized !== "boolean") return false;
            if (this.normalizeSharedValue(normalized) === undefined &&
                normalized !== null) return false;

            const key = kind + ":" + id;
            const encoded = JSON.stringify(normalized);
            if (this.pendingWorldRequests.get(key) === encoded) return true;

            this.pendingWorldRequests.set(key, encoded);
            const sent = this.send({
                type: "world_request",
                kind,
                id,
                value: normalized
            });
            if (!sent) this.pendingWorldRequests.delete(key);
            return sent;
        },

        createWorldSnapshot() {
            const switches = Object.create(null);
            const variables = Object.create(null);

            if ($gameSwitches && Array.isArray($gameSwitches._data) &&
                $dataSystem && Array.isArray($dataSystem.switches)) {
                const switchLimit = Math.min($dataSystem.switches.length, 5001);
                for (let id = 1; id < switchLimit; id++) {
                    if ($gameSwitches._data[id] === true) switches[String(id)] = true;
                }
            }

            if ($gameVariables && Array.isArray($gameVariables._data) &&
                $dataSystem && Array.isArray($dataSystem.variables)) {
                const variableLimit = Math.min($dataSystem.variables.length, 5001);
                for (let id = 1; id < variableLimit; id++) {
                    const value = $gameVariables._data[id];
                    if (value === undefined || (typeof value === "number" && value === 0)) continue;
                    const normalized = this.normalizeSharedValue(value);
                    if (normalized === undefined) {
                        const warningKey = "snapshot:" + id;
                        if (!this.warnedVariableTypes.has(warningKey)) {
                            this.warnedVariableTypes.add(warningKey);
                            console.warn("[Coop-Pl] Variable " + id +
                                " uses a non-primitive value; it is omitted from shared snapshots.");
                        }
                        continue;
                    }
                    variables[String(id)] = normalized;
                }
            }

            const selfSwitches = Object.create(null);
            if ($gameSelfSwitches && $gameSelfSwitches._data &&
                typeof $gameSelfSwitches._data === "object") {
                let count = 0;
                for (const [rawKey, value] of Object.entries($gameSelfSwitches._data)) {
                    if (value !== true || count >= 5000) continue;
                    const key = this.normalizeSelfSwitchKey(rawKey);
                    if (key) { selfSwitches[key] = true; count += 1; }
                }
            }
            return { switches, variables, selfSwitches };
        },

        sendWorldSnapshot() {
            if (!config.syncSwitchesVariables || !this.connected || !this.isHost) return;
            const world = this.createWorldSnapshot();
            const encoded = JSON.stringify(world);
            if (encoded.length > 220 * 1024) {
                this.setStatus("shared world snapshot is too large to send");
                return;
            }
            this.send({ type: "world_snapshot", world });
        },

        applyWorldSnapshot(world) {
            if (!config.syncSwitchesVariables || !world ||
                typeof world !== "object" ||
                !world.switches || typeof world.switches !== "object" ||
                !world.variables || typeof world.variables !== "object" ||
                (world.selfSwitches !== undefined &&
                    (!world.selfSwitches || typeof world.selfSwitches !== "object"))) return;

            this.applyingWorldState = true;
            try {
                if ($gameSwitches) {
                    $gameSwitches._data = [];
                    for (const [rawId, value] of Object.entries(world.switches)) {
                        const id = Number(rawId);
                        if (this.isValidWorldId("switch", id) && typeof value === "boolean") {
                            $gameSwitches._data[id] = value;
                        }
                    }
                    if (typeof $gameSwitches.onChange === "function") $gameSwitches.onChange();
                }

                if ($gameVariables) {
                    $gameVariables._data = [];
                    for (const [rawId, value] of Object.entries(world.variables)) {
                        const id = Number(rawId);
                        const normalized = this.normalizeSharedValue(value);
                        if (this.isValidWorldId("variable", id) &&
                            (normalized !== undefined || value === null)) {
                            $gameVariables._data[id] = normalized;
                        }
                    }
                    if (typeof $gameVariables.onChange === "function") $gameVariables.onChange();
                }
                if ($gameSelfSwitches) {
                    $gameSelfSwitches._data = Object.create(null);
                    for (const [rawKey, value] of Object.entries(world.selfSwitches || {})) {
                        const key = this.normalizeSelfSwitchKey(rawKey);
                        if (key && value === true) $gameSelfSwitches._data[key] = true;
                    }
                    if (typeof $gameSelfSwitches.onChange === "function") $gameSelfSwitches.onChange();
                }
            } finally {
                this.applyingWorldState = false;
            }

            this.lastWorldRevision = Number.isInteger(world.revision) ? world.revision : 0;
            this.pendingWorldRequests.clear();
        },

        applyWorldChange(message) {
            if (!config.syncSwitchesVariables || !message ||
                !Number.isInteger(message.revision) ||
                message.revision <= this.lastWorldRevision) return;

            const kind = message.kind;
            const value = message.value;
            if (kind === "selfSwitch") {
                const key = this.normalizeSelfSwitchKey(message.key);
                if (!key || typeof value !== "boolean" || !$gameSelfSwitches) return;
                this.applyingWorldState = true;
                try { $gameSelfSwitches.setValue(key.split(","), value); }
                finally { this.applyingWorldState = false; }
                this.lastWorldRevision = message.revision;
                this.pendingWorldRequests.delete("selfSwitch:" + key);
                return;
            }
            const id = message.id;
            if (!this.isValidWorldId(kind, id)) return;
            const normalized = kind === "variable" ? this.normalizedVariableValue(value) : value;
            if (kind === "switch" && typeof normalized !== "boolean") return;
            if (this.normalizeSharedValue(normalized) === undefined &&
                normalized !== null) return;

            this.applyingWorldState = true;
            try {
                if (kind === "switch") {
                    $gameSwitches.setValue(id, normalized);
                } else {
                    $gameVariables.setValue(id, normalized);
                }
            } finally {
                this.applyingWorldState = false;
            }

            this.lastWorldRevision = message.revision;
            this.pendingWorldRequests.delete(kind + ":" + id);
        },

        handleWorldRequest(message) {
            if (!config.syncSwitchesVariables || !this.connected || !this.isHost || !message) return;
            if (message.kind === "selfSwitch") {
                const key = this.normalizeSelfSwitchKey(message.key);
                if (!key || typeof message.value !== "boolean" || !$gameSelfSwitches) return;
                $gameSelfSwitches.setValue(key.split(","), message.value);
                return;
            }
            if (!this.isValidWorldId(message.kind, message.id)) return;
            const normalized = message.kind === "variable"
                ? this.normalizedVariableValue(message.value)
                : message.value;
            if (message.kind === "switch" && typeof normalized !== "boolean") return;
            if (this.normalizeSharedValue(normalized) === undefined &&
                normalized !== null) return;

            if (message.kind === "switch") {
                $gameSwitches.setValue(message.id, normalized);
            } else {
                $gameVariables.setValue(message.id, normalized);
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
                this.pendingEventRequests.clear();
                this.pendingEventKeys.clear();
                this.pendingEventUi.length = 0;
                this.pendingChoiceResults.clear();
                this.clearRemoteChoice();
                this.activeSharedEvents.clear();
                this.pendingWorldRequests.clear();
                this.pendingPartySnapshot = null;
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
            this.pendingEventRequests.clear();
            this.pendingEventKeys.clear();
            this.pendingEventUi.length = 0;
            this.pendingChoiceResults.clear();
            this.clearRemoteChoice();
            this.activeSharedEvents.clear();
            this.pendingWorldRequests.clear();
            this.pendingPartySnapshot = null;

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

                    if (message.world && (!this.isHost ||
                        (Number.isInteger(message.world.revision) && message.world.revision > 0))) {
                        this.applyWorldSnapshot(message.world);
                    }
                    if (this.isHost) {
                        this.sendWorldSnapshot();
                        this.sendPartySnapshot();
                    } else if (message.party) {
                        this.applyPartySnapshot(message.party);
                    }

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
                case "world_snapshot":
                    if (!this.isHost) this.applyWorldSnapshot(message.world);
                    break;
                case "world_snapshot_ack":
                    if (Number.isInteger(message.revision)) {
                        this.lastWorldRevision = message.revision;
                    }
                    break;
                case "world_change":
                    this.applyWorldChange(message);
                    break;
                case "world_request":
                    this.handleWorldRequest(message);
                    break;
                case "party_snapshot":
                    if (!this.isHost) this.applyPartySnapshot(message.party);
                    break;
                case "event_ui":
                    if (!this.isHost) this.queueSharedEventUi(message);
                    break;
                case "event_choice_result":
                    if (!this.isHost) this.receiveSharedChoiceResult(message);
                    break;
                case "event_request":
                    this.handleEventRequest(message);
                    break;
                case "event_result":
                    this.handleEventResult(message);
                    break;
                case "event_finished":
                    this.handleEventFinished(message);
                    break;
                case "host_changed":
                    this.hostId = String(message.hostId || "");
                    this.isHost = this.localId === this.hostId;
                    if (this.isHost) {
                        this.sendWorldSnapshot();
                        this.sendPartySnapshot();
                    }
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
            const now = Date.now();
            for (const pending of this.pendingEventRequests.values()) {
                if (!pending.accepted && now - pending.createdAt > 15000) {
                    this.pendingEventRequests.delete(pending.requestId);
                    this.pendingEventKeys.delete(pending.key);
                    log("shared event request timed out:", pending.kind, pending.eventId);
                }
            }
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
                remotePlayerCount: this.remotePlayers.size,
                worldRevision: this.lastWorldRevision,
                worldSyncEnabled: config.syncSwitchesVariables,
                pendingEventCount: this.pendingEventRequests.size,
                pendingEventUiCount: this.pendingEventUi.length,
                activeRemoteChoice: this.activeRemoteChoice ? this.activeRemoteChoice.choiceId : null,
                activeSharedEventCount: this.activeSharedEvents.size
            };
        }
    };

    if (typeof Game_Switches !== "undefined") {
        const _Game_Switches_setValue = Game_Switches.prototype.setValue;
        Game_Switches.prototype.setValue = function(switchId, value) {
            const id = Number(switchId);
            const normalized = Boolean(value);

            if (config.syncSwitchesVariables && network.connected &&
                !network.applyingWorldState && !network.isHost &&
                network.isValidWorldId("switch", id)) {
                const current = this.value(id);
                if (current !== normalized) network.requestWorldChange("switch", id, normalized);
                return;
            }

            const result = _Game_Switches_setValue.call(this, switchId, value);
            if (!network.applyingWorldState && config.syncSwitchesVariables &&
                network.connected && network.isHost && network.isValidWorldId("switch", id)) {
                network.publishWorldChange("switch", id, normalized);
            }
            return result;
        };
    }

    if (typeof Game_Variables !== "undefined") {
        const _Game_Variables_setValue = Game_Variables.prototype.setValue;
        Game_Variables.prototype.setValue = function(variableId, value) {
            const id = Number(variableId);
            const normalized = network.normalizedVariableValue(value);
            const shareable = network.normalizeSharedValue(normalized) !== undefined ||
                normalized === null;

            if (config.syncSwitchesVariables && network.connected &&
                !network.applyingWorldState && !network.isHost &&
                network.isValidWorldId("variable", id) && shareable) {
                const rawCurrent = this._data[id];
                const current = rawCurrent === undefined ? 0 : rawCurrent;
                if (current !== normalized) network.requestWorldChange("variable", id, normalized);
                return;
            }

            const result = _Game_Variables_setValue.call(this, variableId, value);
            if (!network.applyingWorldState && config.syncSwitchesVariables &&
                network.connected && network.isHost && network.isValidWorldId("variable", id)) {
                network.publishWorldChange("variable", id, normalized);
            }
            return result;
        };
    }


    if (typeof Game_Event !== "undefined") {
        const _Game_Event_start = Game_Event.prototype.start;
        Game_Event.prototype.start = function() {
            const mapId = $gameMap ? $gameMap.mapId() : this._mapId;
            const eventId = typeof this.eventId === "function" ? this.eventId() : this._eventId;
            if (network.connected && !network.isHost && !network.isLocalMapEvent(this)) {
                if (this.isTriggerIn && this.isTriggerIn([0, 1, 2])) network.requestMapEvent(this);
                return;
            }
            const result = _Game_Event_start.call(this);
            if (network.connected && network.isHost && !network.isLocalMapEvent(this) &&
                (!this.isStarting || this.isStarting())) {
                network.registerSharedEvent("map", mapId, eventId);
            }
            return result;
        };
        if (typeof Game_Event.prototype.updateParallel === "function") {
            const _Game_Event_updateParallel = Game_Event.prototype.updateParallel;
            Game_Event.prototype.updateParallel = function() {
                if (network.connected && !network.isHost && !network.isLocalMapEvent(this)) return;
                return _Game_Event_updateParallel.call(this);
            };
        }
    }

    if (typeof Game_Map !== "undefined") {
        if (typeof Game_Map.prototype.setupAutorunCommonEvent === "function") {
            const _Game_Map_setupAutorunCommonEvent = Game_Map.prototype.setupAutorunCommonEvent;
            Game_Map.prototype.setupAutorunCommonEvent = function() {
                if (network.connected && !network.isHost) {
                    const localAuto = ($dataCommonEvents || []).find(item =>
                        item && item.trigger === 1 && $gameSwitches &&
                        $gameSwitches.value(item.switchId) && network.isLocalEventData(item));
                    if (localAuto && $gameTemp && $gameTemp.reserveCommonEvent) {
                        $gameTemp.reserveCommonEvent(localAuto.id);
                        return true;
                    }
                    return false;
                }
                return _Game_Map_setupAutorunCommonEvent.call(this);
            };
        }
        if (typeof Game_Map.prototype.setupStartingEvent === "function") {
            const _Game_Map_setupStartingEvent = Game_Map.prototype.setupStartingEvent;
            Game_Map.prototype.setupStartingEvent = function() {
                const result = _Game_Map_setupStartingEvent.call(this);
                if (result && network.connected && network.isHost && this._interpreter &&
                    Number.isInteger(this._interpreter._eventId) && this._interpreter._eventId > 0) {
                    const key = network.eventKey("map", this.mapId(), this._interpreter._eventId);
                    if (network.activeSharedEvents.has(key)) {
                        this._interpreter._coopEventKind = "map";
                        this._interpreter._coopEventMapId = this.mapId();
                        this._interpreter._coopEventId = this._interpreter._eventId;
                    }
                }
                return result;
            };
        }
        if (typeof Game_Map.prototype.setupReservedCommonEvent === "function") {
            const _Game_Map_setupReservedCommonEvent = Game_Map.prototype.setupReservedCommonEvent;
            Game_Map.prototype.setupReservedCommonEvent = function() {
                const reserved = $gameTemp && typeof $gameTemp.reservedCommonEvent === "function"
                    ? $gameTemp.reservedCommonEvent() : null;
                if (network.connected && !network.isHost && reserved && !network.isLocalEventData(reserved)) {
                    if ($gameTemp && $gameTemp.clearCommonEventReservation) $gameTemp.clearCommonEventReservation();
                    return false;
                }
                const result = _Game_Map_setupReservedCommonEvent.call(this);
                if (result && network.connected && network.isHost && reserved && !network.isLocalEventData(reserved)) {
                    network.registerSharedEvent("common", this.mapId(), reserved.id);
                    if (this._interpreter) {
                        this._interpreter._coopEventKind = "common";
                        this._interpreter._coopEventMapId = this.mapId();
                        this._interpreter._coopEventId = reserved.id;
                    }
                }
                return result;
            };
        }
    }

    if (typeof Game_CommonEvent !== "undefined" && typeof Game_CommonEvent.prototype.update === "function") {
        const _Game_CommonEvent_update = Game_CommonEvent.prototype.update;
        Game_CommonEvent.prototype.update = function() {
            if (network.connected && !network.isHost && !network.isLocalCommonEvent(this._commonEventId)) return;
            return _Game_CommonEvent_update.call(this);
        };
    }

    if (typeof Game_Interpreter !== "undefined") {
        if (typeof Game_Interpreter.prototype.command101 === "function") {
            const _Game_Interpreter_command101 = Game_Interpreter.prototype.command101;
            Game_Interpreter.prototype.command101 = function() {
                if (network.connected && network.isHost) network.publishSharedText(this);
                return _Game_Interpreter_command101.call(this);
            };
        }
        if (typeof Game_Interpreter.prototype.setupChild === "function") {
            const _Game_Interpreter_setupChild = Game_Interpreter.prototype.setupChild;
            Game_Interpreter.prototype.setupChild = function(list, eventId) {
                const result = _Game_Interpreter_setupChild.call(this, list, eventId);
                const child = this._childInterpreter;
                if (child && this._coopEventKind && !this._coopLocalChildEvent) {
                    child._coopEventKind = this._coopEventKind;
                    child._coopEventMapId = this._coopEventMapId;
                    child._coopEventId = this._coopEventId;
                }
                return result;
            };
        }
        if (typeof Game_Interpreter.prototype.setupChoices === "function") {
            const _Game_Interpreter_setupChoices = Game_Interpreter.prototype.setupChoices;
            Game_Interpreter.prototype.setupChoices = function(params) {
                const sharedChoice = network.connected && network.isHost
                    ? network.publishSharedChoices(this, params) : null;
                const result = _Game_Interpreter_setupChoices.call(this, params);
                if (sharedChoice && typeof $gameMessage !== "undefined" && $gameMessage &&
                    typeof $gameMessage.setChoiceCallback === "function") {
                    const originalCallback = $gameMessage._choiceCallback;
                    $gameMessage.setChoiceCallback(choiceResult => {
                        if (typeof originalCallback === "function") originalCallback(choiceResult);
                        network.publishSharedChoiceResult(sharedChoice, choiceResult);
                    });
                }
                return result;
            };
        }
        if (typeof Game_Interpreter.prototype.command117 === "function") {
            const _Game_Interpreter_command117 = Game_Interpreter.prototype.command117;
            Game_Interpreter.prototype.command117 = function() {
                const commonEventId = Number(this._params && this._params[0]);
                if (network.connected && network.isHost &&
                    this._coopEventKind && network.isLocalCommonEvent(commonEventId)) {
                    this._coopLocalChildEvent = true;
                    try {
                        return _Game_Interpreter_command117.call(this);
                    } finally {
                        this._coopLocalChildEvent = false;
                    }
                }
                if (network.connected && !network.isHost &&
                    commonEventId > 0 && !network.isLocalCommonEvent(commonEventId)) {
                    const requestId = network.requestCommonEvent(commonEventId);
                    if (requestId) {
                        this._coopEventWaitRequestId = requestId;
                        this.setWaitMode("coopEvent");
                    }
                    return true;
                }
                return _Game_Interpreter_command117.call(this);
            };
        }
        if (typeof Game_Interpreter.prototype.updateWaitMode === "function") {
            const _Game_Interpreter_updateWaitMode = Game_Interpreter.prototype.updateWaitMode;
            Game_Interpreter.prototype.updateWaitMode = function() {
                if (this._waitMode === "coopEvent") {
                    if (this._coopEventWaitRequestId &&
                        network.pendingEventRequests.has(this._coopEventWaitRequestId)) return true;
                    this._coopEventWaitRequestId = null;
                    this._waitMode = "";
                    return false;
                }
                return _Game_Interpreter_updateWaitMode.call(this);
            };
        }
        if (typeof Game_Interpreter.prototype.terminate === "function") {
            const _Game_Interpreter_terminate = Game_Interpreter.prototype.terminate;
            Game_Interpreter.prototype.terminate = function() {
                if ($gameMap && $gameMap._interpreter === this && network.connected && network.isHost) {
                    network.finishInterpreterEvent(this);
                }
                return _Game_Interpreter_terminate.call(this);
            };
        }
    }

    if (typeof Window_ChoiceList !== "undefined") {
        const _Window_ChoiceList_processHandling = Window_ChoiceList.prototype.processHandling;
        if (typeof _Window_ChoiceList_processHandling === "function") {
            Window_ChoiceList.prototype.processHandling = function() {
                if (network.connected && !network.isHost && network.activeRemoteChoice &&
                    !network.remoteChoiceResolved) return;
                return _Window_ChoiceList_processHandling.call(this);
            };
        }

        for (const methodName of ["processCursorMove", "processTouch"]) {
            const original = Window_ChoiceList.prototype[methodName];
            if (typeof original !== "function") continue;
            Window_ChoiceList.prototype[methodName] = function() {
                if (network.connected && !network.isHost && network.activeRemoteChoice) return;
                return original.call(this);
            };
        }

        for (const methodName of ["processOk", "processCancel"]) {
            const original = Window_ChoiceList.prototype[methodName];
            if (typeof original !== "function") continue;
            Window_ChoiceList.prototype[methodName] = function() {
                const isRemoteChoice = network.connected && !network.isHost &&
                    Boolean(network.activeRemoteChoice);
                if (isRemoteChoice && !network.remoteChoiceResolved) return;
                const result = original.call(this);
                if (isRemoteChoice) network.clearRemoteChoice();
                return result;
            };
        }
    }

    if (typeof Game_SelfSwitches !== "undefined") {
        const _Game_SelfSwitches_setValue = Game_SelfSwitches.prototype.setValue;
        Game_SelfSwitches.prototype.setValue = function(key, value) {
            const normalizedKey = network.normalizeSelfSwitchKey(key);
            const normalizedValue = Boolean(value);
            if (normalizedKey && config.syncSwitchesVariables && network.connected &&
                !network.applyingWorldState && !network.isHost) {
                if (this.value(key) !== normalizedValue) network.requestSelfSwitchChange(normalizedKey, normalizedValue);
                return;
            }
            const result = _Game_SelfSwitches_setValue.call(this, key, value);
            if (normalizedKey && !network.applyingWorldState && config.syncSwitchesVariables &&
                network.connected && network.isHost) network.publishSelfSwitchChange(normalizedKey, normalizedValue);
            return result;
        };
    }

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
        network.drainSharedEventUi();
        network.applyPendingPartySnapshot();
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
