// ==UserScript==
// @name         BC Party Games
// @name:zh-TW   BC 派對遊戲
// @namespace    https://github.com/awdrrawd/BC-PartyGames
// @version      0.3.0
// @description  Modular multiplayer party games for Bondage Club. UNO is the first game.
// @description:zh-TW  在 Bondage Club 聊天室遊玩的模組化多人派對遊戲；首款遊戲為 UNO。
// @author       Liko
// @include      /^https:\/\/(www\.)?(bondage(projects\.elementfx|-(europe|asia))\.com|bondageeurope\.com)\/R*/
// @grant        none
// @require      https://cdn.jsdelivr.net/gh/awdrrawd/liko-Plugin-Repository@main/Plugins/expand/bcmodsdk.js
// @downloadURL  https://raw.githubusercontent.com/awdrrawd/BC-PartyGames/main/dist/BC-PartyGames.user.js
// @updateURL    https://raw.githubusercontent.com/awdrrawd/BC-PartyGames/main/dist/BC-PartyGames.user.js
// ==/UserScript==



// ---- src/core.js ----
(function registerPartyGamesCore(root, factory) {
    const modules = root.BCPartyGamesModules = root.BCPartyGamesModules || {};
    if (!modules.core) modules.core = factory();
})(typeof globalThis !== "undefined" ? globalThis : window, function partyGamesCoreFactory() {
    "use strict";

    const COLORS = ["red", "yellow", "green", "blue"];
    const DEFAULT_RULES = Object.freeze({
        preset: "classic",
        startingHandSize: 7,
        stacking: false,
        drawUntilPlayable: false,
        playDrawnCard: true,
        wildDrawFourChallenge: false,
        jumpIn: false,
        sevenZero: false,
        forcePlay: false,
        unoCallMode: "automatic",
        unoPenaltyCards: 0,
        reconnectSeconds: 60,
        voteSeconds: 60,
        voteCooldownSeconds: 300,
        turnSeconds: 45,
    });

    function makeId(prefix = "id") {
        const random = globalThis.crypto?.getRandomValues
            ? Array.from(globalThis.crypto.getRandomValues(new Uint32Array(2)), n => n.toString(36)).join("")
            : Math.random().toString(36).slice(2) + Date.now().toString(36);
        return `${prefix}-${random}`;
    }

    function normalizeRules(rules = {}) {
        if (!rules || typeof rules !== "object") rules = {};
        const result = { ...DEFAULT_RULES };
        for (const [key, min, max] of [["startingHandSize", 3, 9], ["turnSeconds", 15, 120], ["reconnectSeconds", 15, 180], ["voteSeconds", 15, 120], ["voteCooldownSeconds", 30, 600]]) {
            const value = Number(rules[key]);
            if (Number.isFinite(value)) result[key] = Math.max(min, Math.min(max, Math.round(value)));
        }
        for (const key of ["stacking", "drawUntilPlayable", "playDrawnCard", "forcePlay", "strictWildFour"]) result[key] = rules[key] === true;
        if (rules.playDrawnCard == null) result.playDrawnCard = true;
        return result;
    }

    function createDeck() {
        const cards = [];
        for (const color of COLORS) {
            cards.push({ id: makeId("card"), color, kind: "number", value: 0 });
            for (let value = 1; value <= 9; value++) {
                cards.push({ id: makeId("card"), color, kind: "number", value });
                cards.push({ id: makeId("card"), color, kind: "number", value });
            }
            for (const kind of ["skip", "reverse", "draw2"]) {
                cards.push({ id: makeId("card"), color, kind, value: null });
                cards.push({ id: makeId("card"), color, kind, value: null });
            }
        }
        for (let i = 0; i < 4; i++) {
            cards.push({ id: makeId("card"), color: "wild", kind: "wild", value: null });
            cards.push({ id: makeId("card"), color: "wild", kind: "wild4", value: null });
        }
        return cards;
    }

    function shuffle(cards, random = Math.random) {
        const result = cards.slice();
        for (let i = result.length - 1; i > 0; i--) {
            const j = Math.floor(random() * (i + 1));
            [result[i], result[j]] = [result[j], result[i]];
        }
        return result;
    }

    function nextPlayerIndex(state, steps = 1, from = state.turnIndex) {
        const count = state.players.length;
        if (!count || state.players.every(p => p.status === "lost")) return -1;
        let index = from;
        for (let moved = 0; moved < steps;) {
            index = (index + state.direction + count) % count;
            if (state.players[index]?.status !== "lost") moved++;
        }
        return index;
    }

    function recycleDiscard(state, random = Math.random) {
        if (state.drawPile.length || state.discardPile.length <= 1) return;
        const top = state.discardPile.pop();
        state.drawPile = shuffle(state.discardPile, random);
        state.discardPile = [top];
    }

    function drawCards(state, memberNumber, count, random = Math.random) {
        const hand = state.hands[String(memberNumber)];
        if (!hand) return [];
        const drawn = [];
        for (let i = 0; i < count; i++) {
            recycleDiscard(state, random);
            const card = state.drawPile.pop();
            if (!card) break;
            hand.push(card);
            drawn.push(card);
        }
        return drawn;
    }

    function canPlayCard(card, state) {
        if (!card || state.phase !== "playing") return false;
        if (state.pendingDraw) return state.rules.stacking && card.kind === state.pendingDrawKind;
        if (card.color === "wild") return true;
        const top = state.discardPile[state.discardPile.length - 1];
        return card.color === state.activeColor
            || card.kind === top?.kind && card.kind !== "number"
            || card.kind === "number" && top?.kind === "number" && card.value === top.value;
    }

    function hasColorMatch(hand, activeColor, excludedCardId) {
        return hand.some(card => card.id !== excludedCardId && card.color === activeColor);
    }

    function applyInitialCard(state, random = Math.random) {
        let guard = state.drawPile.length;
        while (guard-- > 0) {
            const card = state.drawPile.pop();
            if (!card) break;
            if (card.kind === "wild4") {
                state.drawPile.unshift(card);
                continue;
            }
            state.discardPile.push(card);
            state.activeColor = card.color === "wild" ? COLORS[Math.floor(random() * COLORS.length)] : card.color;
            if (card.kind === "reverse") {
                state.direction = -1;
                state.turnIndex = state.players.length - 1;
            } else if (card.kind === "skip") {
                state.turnIndex = nextPlayerIndex(state);
            } else if (card.kind === "draw2") {
                const target = state.players[state.turnIndex];
                drawCards(state, target.memberNumber, 2, random);
                state.turnIndex = nextPlayerIndex(state);
            }
            return;
        }
        throw new Error("No valid initial card");
    }

    function createGame({ hostId, players, rules = {}, random = Math.random }) {
        if (!Array.isArray(players) || players.length < 2 || players.length > 10) throw new Error("UNO requires 2-10 players");
        if (players.some(p => !Number.isSafeInteger(Number(p.memberNumber)) || Number(p.memberNumber) <= 0)
            || new Set(players.map(p => Number(p.memberNumber))).size !== players.length
            || !players.some(p => Number(p.memberNumber) === Number(hostId))) throw new Error("Invalid players");
        const normalizedPlayers = players.map(player => ({
            memberNumber: Number(player.memberNumber),
            name: String(player.name || player.memberNumber),
            status: "online",
            disconnectedAt: null,
        }));
        const state = {
            schema: 1,
            game: "uno",
            gameId: makeId("uno"),
            hostId: Number(hostId),
            hostEpoch: 1,
            revision: 0,
            phase: "playing",
            players: normalizedPlayers,
            hands: Object.fromEntries(normalizedPlayers.map(p => [String(p.memberNumber), []])),
            drawPile: shuffle(createDeck(), random),
            discardPile: [],
            activeColor: null,
            direction: 1,
            turnIndex: 0,
            winnerId: null,
            drawnThisTurn: false,
            playableDrawnCardId: null,
            lastAction: null,
            rules: normalizeRules(rules),
            pendingDraw: 0,
            pendingDrawKind: null,
            vote: null,
            voteCooldowns: {},
            createdAt: Date.now(),
            turnStartedAt: Date.now(),
        };
        for (let round = 0; round < state.rules.startingHandSize; round++) {
            for (const player of state.players) drawCards(state, player.memberNumber, 1, random);
        }
        applyInitialCard(state, random);
        return state;
    }

    function currentPlayer(state) { return state.players[state.turnIndex] || null; }

    function playCard(state, memberNumber, cardId, chosenColor) {
        const id = Number(memberNumber);
        if (state.phase !== "playing") return { ok: false, error: "notPlaying" };
        if (currentPlayer(state)?.memberNumber !== id) return { ok: false, error: "notYourTurn" };
        const hand = state.hands[String(id)] || [];
        const cardIndex = hand.findIndex(card => card.id === cardId);
        if (cardIndex < 0) return { ok: false, error: "cardNotFound" };
        const card = hand[cardIndex];
        if (!canPlayCard(card, state)) return { ok: false, error: "illegalCard" };
        if (state.drawnThisTurn && state.playableDrawnCardId && card.id !== state.playableDrawnCardId) return { ok: false, error: "onlyDrawnCard" };
        if (card.kind === "wild4" && state.rules.strictWildFour && !state.pendingDraw && hasColorMatch(hand, state.activeColor, card.id)) {
            return { ok: false, error: "wild4HasColor" };
        }
        if (card.color === "wild" && !COLORS.includes(chosenColor)) return { ok: false, error: "chooseColor" };

        hand.splice(cardIndex, 1);
        state.discardPile.push(card);
        state.activeColor = card.color === "wild" ? chosenColor : card.color;
        state.drawnThisTurn = false;
        state.playableDrawnCardId = null;
        state.lastAction = { type: "play", memberNumber: id, card, chosenColor: state.activeColor, uno: hand.length === 1 };

        if (hand.length === 0) {
            if (card.kind === "draw2" || card.kind === "wild4") drawCards(state, state.players[nextPlayerIndex(state)].memberNumber, (state.pendingDraw || 0) + (card.kind === "draw2" ? 2 : 4));
            state.pendingDraw = 0; state.pendingDrawKind = null;
            state.phase = "finished";
            state.winnerId = id;
            return { ok: true, won: true, card };
        }

        let advance = 1;
        if (card.kind === "reverse") {
            state.direction *= -1;
            if (state.players.filter(p => p.status !== "lost").length === 2) advance = 2;
        } else if (card.kind === "skip") {
            advance = 2;
        } else if (card.kind === "draw2" || card.kind === "wild4") {
            const amount = card.kind === "draw2" ? 2 : 4;
            const targetIndex = nextPlayerIndex(state);
            const target = state.players[targetIndex];
            if (state.rules.stacking) {
                state.pendingDraw = (state.pendingDraw || 0) + amount;
                state.pendingDrawKind = card.kind;
            } else {
                drawCards(state, target.memberNumber, amount);
                advance = 2;
            }
        }
        state.turnIndex = nextPlayerIndex(state, advance);
        return { ok: true, card };
    }

    function drawForTurn(state, memberNumber, { timeout = false } = {}) {
        const id = Number(memberNumber);
        if (state.phase !== "playing") return { ok: false, error: "notPlaying" };
        if (currentPlayer(state)?.memberNumber !== id) return { ok: false, error: "notYourTurn" };
        if (state.drawnThisTurn) return { ok: false, error: "alreadyDrew" };
        if (state.pendingDraw) {
            const drawn = drawCards(state, id, state.pendingDraw);
            state.pendingDraw = 0; state.pendingDrawKind = null;
            state.lastAction = { type: "draw", memberNumber: id, count: drawn.length };
            state.turnIndex = nextPlayerIndex(state);
            return { ok: true, playable: false };
        }
        const legal = card => canPlayCard(card, state) && !(card.kind === "wild4" && state.rules.strictWildFour && hasColorMatch(state.hands[String(id)], state.activeColor, card.id));
        if (!timeout && state.rules.forcePlay && state.hands[String(id)].some(legal)) return { ok: false, error: "mustPlay" };
        const drawn = [];
        do {
            const batch = drawCards(state, id, 1);
            if (!batch.length) break;
            drawn.push(batch[0]);
        } while (state.rules.drawUntilPlayable && !legal(drawn.at(-1)));
        const last = drawn.at(-1);
        const playable = !!last && legal(last);
        state.drawnThisTurn = true;
        state.playableDrawnCardId = playable && state.rules.playDrawnCard ? last.id : null;
        state.lastAction = { type: "draw", memberNumber: id, count: drawn.length };
        if (!state.playableDrawnCardId) {
            state.drawnThisTurn = false;
            state.turnIndex = nextPlayerIndex(state);
        }
        return { ok: true, card: last, playable: !!state.playableDrawnCardId };
    }

    function passAfterDraw(state, memberNumber) {
        const id = Number(memberNumber);
        if (state.phase !== "playing" || currentPlayer(state)?.memberNumber !== id || !state.drawnThisTurn) return { ok: false, error: "cannotPass" };
        state.drawnThisTurn = false;
        state.playableDrawnCardId = null;
        state.lastAction = { type: "pass", memberNumber: id };
        state.turnIndex = nextPlayerIndex(state);
        return { ok: true };
    }

    function removePlayer(state, memberNumber, random = Math.random) {
        const id = Number(memberNumber);
        const index = state.players.findIndex(p => p.memberNumber === id);
        if (index < 0 || state.players[index].status === "lost") return false;
        const hand = state.hands[String(id)] || [];
        state.drawPile = shuffle(state.drawPile.concat(hand), random);
        state.hands[String(id)] = [];
        state.players[index].status = "lost";
        state.players[index].disconnectedAt = null;
        if (state.turnIndex === index) {
            state.turnIndex = nextPlayerIndex(state);
            state.drawnThisTurn = false; state.playableDrawnCardId = null;
            state.turnStartedAt = Date.now();
        }
        const alive = state.players.filter(p => p.status !== "lost");
        if (alive.length <= 1) {
            state.phase = "finished";
            state.winnerId = alive[0]?.memberNumber ?? null;
        }
        return true;
    }

    function publicView(state, viewerId) {
        const clone = JSON.parse(JSON.stringify(state));
        const ownKey = String(Number(viewerId));
        clone.handCounts = Object.fromEntries(Object.entries(clone.hands).map(([id, hand]) => [id, hand.length]));
        clone.hands = { [ownKey]: clone.hands[ownKey] || [] };
        clone.drawPile = { count: state.drawPile.length };
        return clone;
    }

    return {
        COLORS, DEFAULT_RULES, normalizeRules, makeId, createDeck, shuffle, createGame, currentPlayer,
        nextPlayerIndex, canPlayCard, playCard, drawForTurn, passAfterDraw, drawCards,
        removePlayer, publicView,
    };
});

// ---- src/transport.js ----
(function registerPartyGamesTransport(root, factory) {
    const modules = root.BCPartyGamesModules = root.BCPartyGamesModules || {};
    if (!modules.transport) modules.transport = factory();
})(typeof globalThis !== "undefined" ? globalThis : window, function partyGamesTransportFactory() {
    "use strict";

    const CONTENT = "BCPG_MSG";
    const PROTOCOL = 1;
    const TAG = "BCPartyGames";

    class Transport {
        constructor(modApi, getLocalId) {
            this.modApi = modApi;
            this.getLocalId = getLocalId;
            this.handlers = new Set();
            this.unhook = null;
        }

        start() {
            if (this.unhook) return;
            this.unhook = this.modApi.hookFunction("ChatRoomMessage", 2, (args, next) => {
                const data = args[0];
                if (data?.Type === "Hidden" && data.Content === CONTENT) {
                    const packet = this.extract(data);
                    if (packet) this.emit(packet, data.Sender);
                    return;
                }
                return next(args);
            });
        }

        extract(data) {
            const raw = Array.isArray(data.Dictionary)
                ? data.Dictionary.find(item => item?.Tag === TAG)?.Data
                : data.Dictionary?.Tag === TAG ? data.Dictionary.Data : data.Dictionary;
            if (!raw || typeof raw !== "object" || raw.protocol !== PROTOCOL || typeof raw.type !== "string") return null;
            if (raw.target != null && Number(raw.target) !== Number(this.getLocalId())) return null;
            return raw;
        }

        send(type, payload = {}, target = null) {
            if (typeof ServerSend !== "function") return false;
            const packet = {
                protocol: PROTOCOL,
                type,
                from: Number(this.getLocalId()),
                target: target == null ? null : Number(target),
                sentAt: Date.now(),
                ...payload,
            };
            ServerSend("ChatRoomChat", {
                Type: "Hidden",
                Content: CONTENT,
                // 不使用 BC 的 Target 欄位：部分伺服器/版本不會把定向 Hidden 送達。
                // 一律在目前聊天室廣播，再由 packet.target 於接收端過濾；不要求好友關係。
                Dictionary: [{ Tag: TAG, Data: packet }],
            });
            return true;
        }

        on(handler) { this.handlers.add(handler); return () => this.handlers.delete(handler); }
        emit(packet, sender) {
            if (Number(packet.from) !== Number(sender)) return;
            for (const handler of this.handlers) {
                try { handler(packet); } catch (error) { console.error("[BC PartyGames] packet handler", error); }
            }
        }
        stop() {
            try { this.unhook?.(); } catch (_) {}
            this.unhook = null;
            this.handlers.clear();
        }
    }

    return { Transport, CONTENT, PROTOCOL, TAG };
});

// ---- src/controller.js ----
(function registerPartyGamesController(root, factory) {
    const modules = root.BCPartyGamesModules = root.BCPartyGamesModules || {};
    if (!modules.controller) modules.controller = factory(modules.core);
})(typeof globalThis !== "undefined" ? globalThis : window, function partyGamesControllerFactory(core) {
    "use strict";

    class Controller {
        constructor({ transport, localPlayer, roomPlayers, notify, action }) {
            this.transport = transport;
            this.localPlayer = localPlayer;
            this.roomPlayers = roomPlayers;
            this.notify = notify || (() => {});
            this.action = action || (() => {});
            this.lobby = null;
            this.state = null;
            this.listeners = new Set();
            this.seenRoomMembers = new Set();
            this.presenceTimer = null;
            this.tickTimer = null;
            this.pendingTransfer = null;
            this.peers = new Map();
            this.pendingInvite = null;
            this.helloTimer = null;
            this.outgoingInvites = new Map();
            this.joining = null;
            this.inviteHistory = new Map();
        }

        get localId() { return Number(this.localPlayer().memberNumber); }
        isHost() { return Number(this.state?.hostId ?? this.lobby?.hostId) === this.localId; }
        onChange(handler) { this.listeners.add(handler); return () => this.listeners.delete(handler); }
        changed() { for (const fn of this.listeners) fn(this.snapshot()); }
        snapshot() {
            const roomIds = new Set(this.roomPlayers().map(p => Number(p.memberNumber)));
            const peers = [...this.peers.values()].filter(peer => roomIds.has(peer.memberNumber) && Date.now() - peer.lastSeen < 20000);
            return { lobby: this.lobby, state: this.state, localId: this.localId, isHost: this.isHost(), peers, pendingInvite: this.pendingInvite, joining: this.joining, outgoingInvites: this.outgoingInvites };
        }

        start() {
            this.unsubscribeTransport = this.transport.on(packet => this.handle(packet));
            this.presenceTimer = setInterval(() => this.checkPresence(), 1000);
            this.tickTimer = setInterval(() => this.tick(), 500);
            this.helloTimer = setInterval(() => this.transport.send("HELLO", { version: "0.3.0", name: this.localPlayer().name }), 10000);
            this.checkPresence();
            this.transport.send("HELLO", { version: "0.3.0", name: this.localPlayer().name });
        }

        createLobby() {
            if (this.state?.phase === "playing") return;
            if (this.lobby) return;
            this.state = null; this.pendingInvite = null; this.joining = null;
            this.outgoingInvites.clear();
            const me = this.localPlayer();
            this.lobby = {
                game: "uno", lobbyId: core.makeId("lobby"), hostId: this.localId,
                players: [{ memberNumber: this.localId, name: me.name, ready: true }],
                invited: [],
                rules: core.normalizeRules(), rulesRevision: 0, createdAt: Date.now(),
            };
            this.broadcastLobby();
            this.notify("lobbyCreated");
            this.changed();
        }

        invite(memberNumber) {
            const target = Number(memberNumber);
            if (!this.snapshot().peers.some(p => p.memberNumber === target) || target === this.localId || this.state || this.outgoingInvites.has(target)) return;
            if (!this.lobby) this.createLobby();
            if (!this.isHost() || this.lobby.players.length >= 10 || this.lobby.players.some(p => p.memberNumber === target)) return;
            if (!this.lobby.invited.includes(target)) this.lobby.invited.push(target);
            const inviteId = core.makeId("invite");
            this.transport.send("INVITE", {
                lobbyId: this.lobby.lobbyId, hostId: this.localId,
                hostName: this.localPlayer().name, game: "uno", rules: this.lobby.rules, inviteId,
            }, target);
            this.outgoingInvites.set(target, { lobbyId: this.lobby.lobbyId, inviteId, sentAt: Date.now(), expiresAt: Date.now() + 60000, attempts: 1, acknowledged: false });
            this.broadcastLobby();
            this.changed();
        }

        acceptInvite() {
            const invite = this.pendingInvite;
            if (!invite || this.lobby || this.state || this.joining) return;
            this.joining = { ...invite, startedAt: Date.now(), lastSentAt: Date.now() };
            const me = this.localPlayer();
            this.transport.send("LOBBY_JOIN", { lobbyId: invite.lobbyId, name: me.name }, invite.hostId);
            this.pendingInvite = null;
            this.changed();
        }

        declineInvite() {
            if (!this.pendingInvite) return;
            this.transport.send("INVITE_DECLINE", { lobbyId: this.pendingInvite.lobbyId }, this.pendingInvite.hostId);
            this.pendingInvite = null;
            this.changed();
        }

        joinLobby() {
            if (!this.lobby || this.lobby.players.some(p => p.memberNumber === this.localId)) return;
            const me = this.localPlayer();
            this.transport.send("LOBBY_JOIN", { lobbyId: this.lobby.lobbyId, name: me.name }, this.lobby.hostId);
        }

        leave() {
            this.pendingInvite = null; this.joining = null; this.outgoingInvites.clear();
            if (this.lobby && !this.state) {
                this.transport.send("LOBBY_LEAVE", { lobbyId: this.lobby.lobbyId });
                if (this.isHost()) this.transport.send("LOBBY_CLOSE", { lobbyId: this.lobby.lobbyId });
                this.lobby = null;
                this.changed();
                return;
            }
            if (this.state && this.isHost()) {
                const oldHostId = this.localId;
                core.removePlayer(this.state, oldHostId);
                const successor = this.state.players.find(p => p.status === "online" && p.memberNumber !== oldHostId);
                if (successor) {
                    this.state.hostId = successor.memberNumber;
                    this.state.hostEpoch++;
                    this.state.revision = 0;
                    this.transport.send("HOST_TRANSFER_COMMIT", {
                        gameId: this.state.gameId, hostId: successor.memberNumber,
                        hostEpoch: this.state.hostEpoch, state: this.state,
                    });
                    this.changed();
                } else {
                    this.state.phase = "finished";
                    this.state.winnerId = null;
                    this.commit("gameEnded", {});
                }
            } else if (this.state) {
                this.transport.send("PLAYER_LEAVE", { gameId: this.state.gameId });
            }
            this.state = null; this.lobby = null; this.changed();
        }

        updateRules(patch) {
            if (!this.isHost() || !this.lobby || this.state) return;
            this.lobby.rules = core.normalizeRules({ ...this.lobby.rules, ...patch });
            this.lobby.rulesRevision = (this.lobby.rulesRevision || 0) + 1;
            for (const player of this.lobby.players) player.ready = player.memberNumber === this.localId;
            this.broadcastLobby(); this.changed();
        }

        setReady(ready) {
            if (!this.lobby || this.isHost()) return;
            this.transport.send("LOBBY_READY", { lobbyId: this.lobby.lobbyId, rulesRevision: this.lobby.rulesRevision, ready: !!ready }, this.lobby.hostId);
        }

        startGame() {
            if (!this.isHost() || !this.lobby || this.lobby.players.length < 2 || this.lobby.players.some(p => !p.ready || !this.roomPlayers().some(r => r.memberNumber === p.memberNumber))) return;
            this.state = core.createGame({ hostId: this.localId, players: this.lobby.players, rules: this.lobby.rules });
            this.state.lobbyId = this.lobby.lobbyId;
            this.outgoingInvites.clear();
            this.lobby = null;
            this.commit("gameStarted", { playerCount: this.state.players.length });
        }

        requestPlay(cardId, chosenColor = null) {
            if (!this.state) return;
            const payload = { gameId: this.state.gameId, cardId, chosenColor };
            if (this.isHost()) this.hostPlay(this.localId, payload); else this.transport.send("PLAY_REQUEST", payload, this.state.hostId);
        }
        requestDraw() {
            if (!this.state) return;
            const payload = { gameId: this.state.gameId };
            if (this.isHost()) this.hostDraw(this.localId); else this.transport.send("DRAW_REQUEST", payload, this.state.hostId);
        }
        requestPass() {
            if (!this.state) return;
            const payload = { gameId: this.state.gameId };
            if (this.isHost()) this.hostPass(this.localId); else this.transport.send("PASS_REQUEST", payload, this.state.hostId);
        }

        hostPlay(sender, packet) {
            const result = core.playCard(this.state, sender, packet.cardId, packet.chosenColor);
            if (!result.ok) return this.reject(sender, result.error);
            if (!result.won) this.state.turnStartedAt = Date.now();
            const player = this.state.players.find(p => p.memberNumber === Number(sender));
            this.commit(result.won ? "winner" : result.card && this.state.lastAction?.uno ? "uno" : "cardPlayed", {
                player: player?.name, card: result.card, winnerId: result.won ? Number(sender) : null,
            });
        }
        hostDraw(sender) {
            const result = core.drawForTurn(this.state, sender);
            if (!result.ok) return this.reject(sender, result.error);
            if (!result.playable) this.state.turnStartedAt = Date.now();
            this.commit("cardDrawn", { memberNumber: Number(sender), playable: result.playable });
        }
        hostPass(sender) {
            const result = core.passAfterDraw(this.state, sender);
            if (!result.ok) return this.reject(sender, result.error);
            this.state.turnStartedAt = Date.now();
            this.commit("turnPassed", { memberNumber: Number(sender) });
        }
        reject(target, error) { if (Number(target) === this.localId) this.notify(error); else this.transport.send("ACTION_REJECTED", { gameId: this.state?.gameId, error }, target); }

        commit(event, eventData = {}) {
            if (!this.state || !this.isHost()) return;
            this.state.revision++;
            this.state.updatedAt = Date.now();
            this.transport.send("STATE", { gameId: this.state.gameId, hostEpoch: this.state.hostEpoch, revision: this.state.revision, state: this.state, event, eventData });
            this.action(event, eventData, this.state);
            this.changed();
        }
        broadcastLobby() {
            if (this.lobby && this.isHost()) this.transport.send("LOBBY_STATE", { lobby: this.lobby });
        }

        proposeHost(targetId) {
            if (!this.isHost() || !this.state || Number(targetId) === this.localId) return;
            if (!this.state.players.some(p => p.memberNumber === Number(targetId) && p.status === "online")) return;
            this.pendingTransfer = { targetId: Number(targetId), expiresAt: Date.now() + 15000 };
            this.transport.send("HOST_TRANSFER_PROPOSE", { gameId: this.state.gameId, state: this.state }, targetId);
        }

        startVote(kind) {
            if (!this.state || !["restart", "end"].includes(kind)) return;
            const cooldown = Number(this.state.voteCooldowns?.[String(this.localId)] || 0);
            if (cooldown > Date.now()) return this.notify("voteCooldown", { seconds: Math.ceil((cooldown - Date.now()) / 1000) });
            if (this.isHost()) this.hostStartVote(this.localId, kind);
            else this.transport.send("VOTE_START", { gameId: this.state.gameId, kind }, this.state.hostId);
        }
        castVote(yes) {
            if (!this.state?.vote) return;
            if (this.isHost()) this.hostCastVote(this.localId, yes);
            else this.transport.send("VOTE_CAST", { gameId: this.state.gameId, voteId: this.state.vote.id, yes: !!yes }, this.state.hostId);
        }
        hostStartVote(sender, kind) {
            if (!this.state.players.some(p => p.memberNumber === Number(sender) && p.status === "online")) return;
            if (this.state.vote || !["restart", "end"].includes(kind)) return;
            const key = String(sender), now = Date.now();
            if (Number(this.state.voteCooldowns[key] || 0) > now) return this.reject(sender, "voteCooldown");
            this.state.voteCooldowns[key] = now + this.state.rules.voteCooldownSeconds * 1000;
            this.state.vote = { id: core.makeId("vote"), kind, proposerId: Number(sender), endsAt: now + this.state.rules.voteSeconds * 1000, votes: { [key]: true } };
            this.commit("voteStarted", { kind, proposerId: Number(sender) });
            this.checkVote();
        }
        hostCastVote(sender, yes) {
            if (!this.state.players.some(p => p.memberNumber === Number(sender) && p.status === "online")) return;
            if (!this.state.vote || this.state.vote.endsAt <= Date.now()) return;
            this.state.vote.votes[String(sender)] = !!yes;
            this.commit("voteUpdated", {});
            this.checkVote();
        }
        checkVote() {
            if (!this.isHost() || !this.state?.vote) return;
            const eligible = this.state.players.filter(p => p.status === "online").map(p => p.memberNumber);
            const yes = eligible.filter(id => this.state.vote.votes[String(id)] === true).length;
            if (yes > eligible.length / 2) this.resolveVote(true);
        }
        resolveVote(passed) {
            const vote = this.state?.vote;
            if (!vote) return;
            if (passed && vote.kind === "restart") {
                const prior = this.state;
                if (prior.players.filter(p => p.status !== "lost").length < 2) return this.resolveVote(false);
                this.state = core.createGame({ hostId: this.localId, players: prior.players.filter(p => p.status !== "lost"), rules: prior.rules });
                this.state.previousGameId = prior.gameId;
                this.state.hostEpoch = prior.hostEpoch;
                this.state.voteCooldowns = prior.voteCooldowns;
                this.commit("gameRestarted", {});
            } else if (passed && vote.kind === "end") {
                this.state.vote = null;
                this.state.phase = "finished";
                this.state.winnerId = null;
                this.commit("gameEnded", {});
            } else {
                this.state.vote = null;
                this.commit("voteFailed", { kind: vote.kind });
            }
        }

        checkPresence() {
            const current = new Set(this.roomPlayers().map(p => Number(p.memberNumber)));
            if (this.lobby) {
                if (!current.has(this.lobby.hostId)) { this.lobby = null; this.changed(); }
                else if (this.isHost()) {
                    const players = this.lobby.players.filter(p => current.has(p.memberNumber));
                    if (players.length !== this.lobby.players.length) { this.lobby.players = players; this.broadcastLobby(); this.changed(); }
                }
            }
            if (!this.seenRoomMembers.size) { this.seenRoomMembers = current; return; }
            if (this.state) {
                const now = Date.now();
                let dirty = false;
                for (const player of this.state.players) {
                    if (player.status === "lost") continue;
                    const online = current.has(player.memberNumber);
                    if (!online && player.status === "online") { player.status = "disconnected"; player.disconnectedAt = now; dirty = true; }
                    if (online && player.status === "disconnected") { player.status = "online"; player.disconnectedAt = null; dirty = true; }
                }
                if (dirty) {
                    const active = core.currentPlayer(this.state);
                    if (active?.status === "online") this.state.turnStartedAt = Date.now();
                    if (this.isHost()) this.commit("presenceChanged", {});
                    else this.changed();
                }
            }
            this.seenRoomMembers = current;
        }

        tick() {
            this.tickInvites();
            if (!this.state) return;
            const now = Date.now();
            if (this.isHost()) {
                const active = core.currentPlayer(this.state);
                const deadline = Number(this.state.turnStartedAt || now) + Number(this.state.rules.turnSeconds || 45) * 1000;
                if (this.state.phase === "playing" && active?.status === "online" && now >= deadline) {
                    const result = this.state.drawnThisTurn ? core.passAfterDraw(this.state, active.memberNumber) : core.drawForTurn(this.state, active.memberNumber, { timeout: true });
                    if (result.ok && result.playable) core.passAfterDraw(this.state, active.memberNumber);
                    this.state.turnStartedAt = now;
                    this.commit("turnTimedOut", { memberNumber: active.memberNumber, name: active.name });
                }
                const expired = this.state.players.filter(p => p.status === "disconnected" && now - p.disconnectedAt >= this.state.rules.reconnectSeconds * 1000);
                for (const player of expired) core.removePlayer(this.state, player.memberNumber);
                if (expired.length) this.commit("playersTimedOut", { players: expired.map(p => p.name) });
                if (this.state.vote?.endsAt <= now) this.resolveVote(false);
            } else {
                const host = this.state.players.find(p => p.memberNumber === this.state.hostId);
                if (host?.status === "disconnected" && now - host.disconnectedAt >= this.state.rules.reconnectSeconds * 1000) this.tryTakeover();
            }
            if (this.pendingTransfer?.expiresAt <= now) this.pendingTransfer = null;
        }

        tickInvites() {
            const now = Date.now();
            if (this.pendingInvite && (now - this.pendingInvite.receivedAt >= 60000 || !this.roomPlayers().some(p => p.memberNumber === this.pendingInvite.hostId))) { this.pendingInvite = null; this.changed(); }
            if (this.joining) {
                if (now - this.joining.startedAt >= 10000) { this.joining = null; this.notify("joinFailed"); this.changed(); }
                else if (now - this.joining.lastSentAt >= 2000) {
                    this.joining.lastSentAt = now;
                    this.transport.send("LOBBY_JOIN", { lobbyId: this.joining.lobbyId, name: this.localPlayer().name }, this.joining.hostId);
                }
            }
            for (const [key, expires] of this.inviteHistory) if (expires <= now) this.inviteHistory.delete(key);
            for (const [target, invite] of this.outgoingInvites) {
                if (now >= invite.expiresAt || (!invite.acknowledged && invite.attempts >= 3 && now - invite.sentAt >= 2000)) {
                    this.outgoingInvites.delete(target);
                    if (this.lobby) { this.lobby.invited = this.lobby.invited.filter(id => id !== target); this.broadcastLobby(); }
                    this.notify("inviteNoResponse", { name: this.peers.get(target)?.name || target });
                    this.changed();
                    continue;
                }
                if (invite.acknowledged || now - invite.sentAt < 2000) continue;
                invite.attempts++;
                invite.sentAt = now;
                this.transport.send("INVITE", {
                    lobbyId: invite.lobbyId, hostId: this.localId,
                    hostName: this.localPlayer().name, game: "uno", rules: this.lobby?.rules, inviteId: invite.inviteId,
                }, target);
            }
        }

        tryTakeover() {
            const candidates = this.state.players.filter(p => p.status === "online" && p.memberNumber !== this.state.hostId);
            if (!candidates.length || candidates[0].memberNumber !== this.localId) return;
            this.state.hostId = this.localId;
            this.state.hostEpoch++;
            this.state.revision = 0;
            this.commit("hostTakenOver", { hostId: this.localId });
        }

        handle(packet) {
            const sender = Number(packet.from);
            if (!Number.isSafeInteger(sender) || sender === this.localId || !this.roomPlayers().some(p => p.memberNumber === sender)) return;
            switch (packet.type) {
                case "HELLO":
                    this.rememberPeer(sender, packet);
                    this.transport.send("HELLO_ACK", { version: "0.3.0", name: this.localPlayer().name }, sender);
                    if (this.isHost() && this.lobby) this.broadcastLobby();
                    if (this.isHost() && this.state) this.commit("sync", {});
                    break;
                case "HELLO_ACK":
                    this.rememberPeer(sender, packet);
                    break;
                case "INVITE":
                    if (!this.state && !this.lobby && !this.joining && packet.game === "uno" && packet.hostId === sender && typeof packet.lobbyId === "string") {
                        this.transport.send("INVITE_ACK", { lobbyId: packet.lobbyId }, sender);
                        const key = `${sender}:${packet.lobbyId}:${packet.inviteId || "legacy"}`;
                        if (this.inviteHistory.has(key) || this.pendingInvite) break;
                        this.inviteHistory.set(key, Date.now() + 60000);
                        this.pendingInvite = { lobbyId: packet.lobbyId, hostId: sender, hostName: String(packet.hostName || sender), rules: core.normalizeRules(packet.rules), receivedAt: Date.now() };
                        this.notify("inviteReceived", { name: this.pendingInvite.hostName });
                        this.changed();
                    }
                    break;
                case "INVITE_ACK": {
                    const outgoing = this.outgoingInvites.get(sender);
                    if (outgoing?.lobbyId === packet.lobbyId && !outgoing.acknowledged) {
                        outgoing.acknowledged = true;
                        this.changed();
                        this.notify("inviteDelivered", { name: this.peers.get(sender)?.name || sender });
                    }
                    break;
                }
                case "INVITE_DECLINE":
                    if (this.isHost() && this.lobby?.lobbyId === packet.lobbyId) {
                        this.lobby.invited = this.lobby.invited.filter(id => id !== sender);
                        this.outgoingInvites.delete(sender);
                        this.notify("inviteDeclined", { name: this.peers.get(sender)?.name || sender });
                        this.broadcastLobby(); this.changed();
                    }
                    break;
                case "LOBBY_STATE":
                    if (!this.state && packet.lobby?.hostId === sender
                        && ((this.lobby?.hostId === sender && this.lobby.lobbyId === packet.lobby.lobbyId) || (this.joining?.hostId === sender && this.joining.lobbyId === packet.lobby.lobbyId))
                        && packet.lobby.players?.some(p => p.memberNumber === this.localId)) {
                        this.lobby = packet.lobby; this.joining = null; this.changed();
                    }
                    break;
                case "LOBBY_JOIN":
                    if (this.isHost() && this.lobby?.lobbyId === packet.lobbyId && this.lobby.players.some(p => p.memberNumber === sender)) { this.broadcastLobby(); break; }
                    if (this.isHost() && this.lobby?.lobbyId === packet.lobbyId && this.lobby.invited.includes(sender) && this.lobby.players.length < 10 && !this.lobby.players.some(p => p.memberNumber === sender)) {
                        this.lobby.players.push({ memberNumber: sender, name: String(packet.name || sender), ready: false });
                        this.lobby.invited = this.lobby.invited.filter(id => id !== sender);
                        this.outgoingInvites.delete(sender); this.broadcastLobby(); this.changed();
                    }
                    break;
                case "LOBBY_READY":
                    if (this.isHost() && this.lobby?.lobbyId === packet.lobbyId && packet.rulesRevision === this.lobby.rulesRevision) {
                        const player = this.lobby.players.find(p => p.memberNumber === sender);
                        if (player) { player.ready = packet.ready === true; this.broadcastLobby(); this.changed(); }
                    }
                    break;
                case "LOBBY_LEAVE":
                    if (this.isHost() && this.lobby?.lobbyId === packet.lobbyId) { this.lobby.players = this.lobby.players.filter(p => p.memberNumber !== sender); this.broadcastLobby(); this.changed(); }
                    break;
                case "LOBBY_CLOSE":
                    for (const key of ["lobby", "pendingInvite", "joining"]) if (this[key]?.lobbyId === packet.lobbyId && sender === this[key].hostId) { this[key] = null; this.changed(); }
                    break;
                case "PLAY_REQUEST": if (this.isHost() && packet.gameId === this.state?.gameId) this.hostPlay(sender, packet); break;
                case "DRAW_REQUEST": if (this.isHost() && packet.gameId === this.state?.gameId) this.hostDraw(sender); break;
                case "PASS_REQUEST": if (this.isHost() && packet.gameId === this.state?.gameId) this.hostPass(sender); break;
                case "PLAYER_LEAVE": if (this.isHost() && packet.gameId === this.state?.gameId && core.removePlayer(this.state, sender)) this.commit("playerLeft", { memberNumber: sender }); break;
                case "STATE": this.acceptState(packet, sender); break;
                case "ACTION_REJECTED": if (sender === this.state?.hostId && packet.gameId === this.state.gameId) this.notify(packet.error); break;
                case "HOST_TRANSFER_PROPOSE":
                    if (packet.gameId === this.state?.gameId && sender === this.state.hostId && packet.state) {
                        this.state = packet.state; this.transport.send("HOST_TRANSFER_ACCEPT", { gameId: packet.gameId }, sender); this.changed();
                    }
                    break;
                case "HOST_TRANSFER_ACCEPT":
                    if (this.pendingTransfer?.targetId === sender && packet.gameId === this.state?.gameId) {
                        this.state.hostId = sender; this.state.hostEpoch++; this.state.revision = 0;
                        this.transport.send("HOST_TRANSFER_COMMIT", { gameId: this.state.gameId, hostId: sender, hostEpoch: this.state.hostEpoch, state: this.state });
                        this.pendingTransfer = null; this.changed();
                    }
                    break;
                case "HOST_TRANSFER_COMMIT":
                    if (packet.gameId === this.state?.gameId && sender === this.state.hostId && packet.state && packet.hostEpoch === this.state.hostEpoch + 1 && packet.state.hostEpoch === packet.hostEpoch && packet.state.hostId === packet.hostId && this.state.players.some(p => p.memberNumber === packet.hostId && p.status === "online")) { this.state = packet.state; this.changed(); }
                    break;
                case "VOTE_START": if (this.isHost() && packet.gameId === this.state?.gameId) this.hostStartVote(sender, packet.kind); break;
                case "VOTE_CAST": if (this.isHost() && packet.gameId === this.state?.gameId && packet.voteId === this.state.vote?.id) this.hostCastVote(sender, packet.yes); break;
            }
        }

        acceptState(packet, sender) {
            const incoming = packet.state;
            if (!incoming || sender !== Number(incoming.hostId) || incoming.game !== "uno") return;
            if (!Array.isArray(incoming.players) || !incoming.players.some(p => p.memberNumber === this.localId)) return;
            if (this.state) {
                if (sender !== this.state.hostId) {
                    const host = this.state.players.find(p => p.memberNumber === this.state.hostId);
                    const successor = this.state.players.find(p => p.status === "online" && p.memberNumber !== this.state.hostId);
                    if (host?.status !== "disconnected" || Date.now() - host.disconnectedAt < this.state.rules.reconnectSeconds * 1000 || successor?.memberNumber !== sender || incoming.hostEpoch !== this.state.hostEpoch + 1) return;
                }
                if (incoming.gameId !== this.state.gameId) {
                    if (sender !== this.state.hostId || incoming.previousGameId !== this.state.gameId || !["gameRestarted", "sync"].includes(packet.event)) return;
                } else {
                if (incoming.hostEpoch < this.state.hostEpoch) return;
                if (incoming.hostEpoch === this.state.hostEpoch && incoming.revision <= this.state.revision) return;
                }
            } else {
                const session = this.lobby || this.joining;
                if (!session || sender !== session.hostId || incoming.lobbyId !== session.lobbyId) return;
            }
            this.state = incoming;
            this.joining = null; this.pendingInvite = null;
            this.lobby = null;
            this.action(packet.event, packet.eventData || {}, incoming);
            this.changed();
        }

        rememberPeer(sender, packet) {
            if (!Number.isFinite(sender) || sender === this.localId) return;
            const room = this.roomPlayers().find(p => p.memberNumber === sender);
            this.peers.set(sender, {
                memberNumber: sender,
                name: String(packet.name || room?.name || sender),
                version: String(packet.version || "unknown"),
                lastSeen: Date.now(),
            });
            this.changed();
        }

        destroy() {
            this.unsubscribeTransport?.();
            clearInterval(this.presenceTimer); clearInterval(this.tickTimer); clearInterval(this.helloTimer);
            this.listeners.clear();
        }
    }

    return { Controller };
});

// ---- src/ui.js ----
(function registerPartyGamesUi(root, factory) {
    const modules = root.BCPartyGamesModules = root.BCPartyGamesModules || {};
    if (!modules.ui) modules.ui = factory(modules.core);
})(typeof globalThis !== "undefined" ? globalThis : window, function partyGamesUiFactory(core) {
    "use strict";

    const CARD_COLORS = { red: "#d72638", yellow: "#f7c948", green: "#159447", blue: "#1769c2", wild: "#181818" };
    const SYMBOLS = { skip: "⊘", reverse: "↻", draw2: "+2", wild: "W", wild4: "+4" };
    const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    const RULE_FIELDS = [
        ["startingHandSize", [3, 5, 7, 9]], ["turnSeconds", [15, 30, 45, 60, 90, 120]],
        ["reconnectSeconds", [15, 30, 60, 120, 180]], ["voteSeconds", [15, 30, 60, 120]],
        ["voteCooldownSeconds", [30, 60, 180, 300, 600]],
        ["stacking"], ["drawUntilPlayable"], ["playDrawnCard"], ["forcePlay"], ["strictWildFour"],
    ];

    class GameUI {
        constructor({ controller, t }) {
            this.controller = controller;
            this.t = t;
            this.root = null;
            this.canvas = null;
            this.ctx = null;
            this.toolbar = null;
            this.hitCards = [];
            this.hitPeers = [];
            this.hitWelcomeActions = [];
            this.pendingWildCardId = null;
            this.settingsOpen = false;
            this.opened = false;
            this.avatars = new Map();
            this.avatarImages = new Map();
            this.avatarDirty = new Set();
            this.avatarUnhooks = [];
            this.lobbyMarkup = "";
            this.keyHandler = event => {
                if (!this.opened) return;
                if (event.key === "Escape") { if (this.pendingWildCardId) { this.pendingWildCardId = null; this.render(); } else this.toggle(false); }
                if (event.key === "Tab") {
                    const focusable = [...this.root.querySelectorAll('button:not(:disabled), select:not(:disabled), input:not(:disabled)')].filter(el => el.getClientRects().length);
                    const first = focusable[0], last = focusable.at(-1);
                    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
                    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
                }
            };
            this.unsubscribe = controller.onChange(() => this.resize());
            this.resizeHandler = () => this.resize();
        }

        mount() {
            if (this.root) return;
            const root = document.createElement("div");
            root.id = "bcpg-overlay";
            root.innerHTML = `<div class="bcpg-window" role="dialog" aria-modal="true" aria-label="${escapeHtml(this.t("title"))}"><div class="bcpg-title"><span>♠ &nbsp; ${escapeHtml(this.t("title"))}</span><button data-act="close" aria-label="${escapeHtml(this.t("close"))}">×</button></div><div class="bcpg-lounge"></div><div class="bcpg-table-scroll"><canvas></canvas></div><div class="bcpg-toolbar"></div></div>`;
            document.body.appendChild(root);
            this.root = root;
            this.canvas = root.querySelector("canvas");
            this.ctx = this.canvas.getContext("2d");
            this.toolbar = root.querySelector(".bcpg-toolbar");
            this.lounge = root.querySelector(".bcpg-lounge");
            root.addEventListener("change", event => {
                const key = event.target.dataset.rule;
                if (key) this.controller.updateRules({ [key]: event.target.type === "checkbox" ? event.target.checked : Number(event.target.value) });
            });
            root.addEventListener("click", event => this.click(event));
            this.canvas.addEventListener("click", event => this.canvasClick(event));
            window.addEventListener("resize", this.resizeHandler);
            window.addEventListener("keydown", this.keyHandler);
            this.resize();
        }

        toggle(force) {
            this.mount();
            this.opened = force == null ? !this.opened : !!force;
            this.root.classList.toggle("open", this.opened);
            if (this.opened) { this.previousFocus = document.activeElement; this.resize(); this.root.querySelector("button")?.focus(); }
            else this.previousFocus?.focus?.();
        }

        resize() {
            if (!this.canvas) return;
            const viewport = window.visualViewport;
            const viewportWidth = viewport?.width || window.innerWidth;
            const viewportHeight = viewport?.height || window.innerHeight;
            const fullTable = !!this.controller.state;
            const width = fullTable
                ? Math.min(1080, Math.max(820, viewportWidth - 40))
                : Math.min(880, Math.max(280, viewportWidth - 24));
            const height = fullTable
                ? 560
                : Math.min(380, Math.max(280, viewportHeight - 220));
            this.root?.classList.toggle("bcpg-compact", !fullTable);
            const dpr = Math.min(2, window.devicePixelRatio || 1);
            this.canvas.style.width = `${width}px`;
            this.canvas.style.height = `${height}px`;
            this.canvas.width = Math.floor(width * dpr);
            this.canvas.height = Math.floor(height * dpr);
            this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            this.width = width; this.height = height;
            this.render();
        }

        render() {
            if (!this.opened || !this.ctx) return;
            const roomIds = new Set((globalThis.ChatRoomCharacter || []).map(c => Number(c.MemberNumber)));
            roomIds.add(Number(globalThis.Player?.MemberNumber));
            for (const id of new Set([...this.avatars.keys(), ...this.avatarDirty])) {
                if (!roomIds.has(id)) { this.avatars.delete(id); this.avatarImages.delete(id); this.avatarDirty.delete(id); }
            }
            const snap = this.controller.snapshot();
            this.lounge.hidden = !!snap.state;
            this.root.querySelector(".bcpg-table-scroll").hidden = !snap.state;
            if (!snap.state) { this.renderLounge(snap); this.renderToolbar(snap); return; }
            if (this.pendingWildCardId && (core.currentPlayer(snap.state)?.memberNumber !== snap.localId || snap.state.phase !== "playing" || !(snap.state.hands[String(snap.localId)] || []).some(c => c.id === this.pendingWildCardId))) this.pendingWildCardId = null;
            this.hitCards = [];
            this.hitPeers = [];
            this.hitWelcomeActions = [];
            this.drawTable();
            if (snap.state) this.drawGame(snap);
            else if (snap.lobby) this.drawLobby(snap);
            else this.drawWelcome(snap);
            this.renderToolbar(snap);
        }

        avatarUrl(player) {
            const id = Number(player.memberNumber);
            if (this.avatars.has(id) && !this.avatarDirty.has(id)) return this.avatars.get(id) || "";
            const character = globalThis.ChatRoomCharacter?.find(c => Number(c.MemberNumber) === id) || (Number(globalThis.Player?.MemberNumber) === id ? globalThis.Player : null);
            if (!character) return "";
            this.avatars.set(id, this.avatars.get(id) || "");
            if (!character?.Canvas?.width || character.MustDraw) { this.avatarDirty.add(id); return this.avatars.get(id); }
            const url = this.captureFace(character);
            this.avatarDirty.delete(id);
            if (!url) return this.avatars.get(id) || "";
            if (url !== this.avatars.get(id)) {
                this.avatars.set(id, url);
                const img = new Image();
                img.onload = () => {
                    if (this.avatars.get(id) !== url) return;
                    this.avatarImages.set(id, img); this.render();
                };
                img.src = url;
            }
            return url;
        }

        installAvatarHooks(modApi) {
            if (this.avatarUnhooks.length) return;
            const hooks = [
                ["ChatRoomSyncSingle", data => data?.Character?.MemberNumber],
                ["ChatRoomSyncItem", data => data?.Item?.Target],
                ["ChatRoomSyncExpression", data => data?.MemberNumber],
                ["ChatRoomSyncPose", data => data?.MemberNumber],
                ["CharacterLoadCanvas", character => character?.MemberNumber],
            ];
            for (const [name, memberOf] of hooks) {
                if (typeof globalThis[name] !== "function") continue;
                this.avatarUnhooks.push(modApi.hookFunction(name, 0, (args, next) => {
                    const result = next(args);
                    const id = Number(memberOf(args[0]));
                    if (Number.isSafeInteger(id) && (globalThis.ChatRoomCharacter || []).some(c => Number(c.MemberNumber) === id)) {
                        this.avatarDirty.add(id);
                        // Coalesce updates and let the current BC update finish before reading its canvas.
                        if (!this.avatarRenderQueued) {
                            this.avatarRenderQueued = true;
                            queueMicrotask(() => { this.avatarRenderQueued = false; if (this.root) this.render(); });
                        }
                    }
                    return result;
                }));
            }
        }

        captureFace(character) {
            // Crop the already-rendered room character; no network, database or other plugin.
            const source = character?.Canvas;
            if (!source?.width || source.height < 950 || character.MustDraw) return "";
            try {
                const canvas = document.createElement("canvas"); canvas.width = canvas.height = 100;
                const ctx = canvas.getContext("2d"); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
                ctx.fillStyle = "#24354b"; ctx.fillRect(0, 0, 100, 100);
                ctx.drawImage(source, source.width / 2 - 105, 740, 210, 210, 0, 0, 100, 100);
                return canvas.toDataURL("image/webp", .9);
            } catch (_) { return ""; }
        }

        playerMarkup(player, detail, action = "") {
            const url = this.avatarUrl(player);
            return `<div class="bcpg-player"><span class="bcpg-avatar">${url ? `<img src="${escapeHtml(url)}" referrerpolicy="no-referrer" alt="" loading="lazy">` : escapeHtml(Array.from(player.name || "?")[0])}</span><div class="bcpg-player-info"><strong>${escapeHtml(player.name)}</strong><small>#${player.memberNumber} · ${escapeHtml(detail)}</small></div>${action}</div>`;
        }

        renderLounge(snap) {
            const { lobby, peers, localId, isHost, pendingInvite, joining, outgoingInvites } = snap;
            const tr = key => escapeHtml(this.t(key));
            const button = (act, key, disabled = false, extra = "") => `<button data-act="${act}" ${disabled ? "disabled" : ""} ${extra}>${tr(key)}</button>`;
            let content = `<div class="bcpg-hero"><span class="bcpg-eyebrow">PARTY GAMES / UNO</span><h2>${tr(lobby ? "unoLobby" : "welcome")}</h2><p>${tr(lobby ? "lobbyHint" : "welcomeHint")}</p><span class="bcpg-badge">2–10 ${tr("playersLabel")} · 108 ${tr("cardsLabel")}</span></div>`;
            if (joining) content += `<div class="bcpg-notice" role="status">${tr("joining")}</div>`;
            if (pendingInvite) content += `<section class="bcpg-invitation">${this.playerMarkup({ memberNumber: pendingInvite.hostId, name: pendingInvite.hostName }, this.t("inviteFrom", { name: pendingInvite.hostName }))}<p>${escapeHtml(this.rulesSummary(pendingInvite.rules))}</p><div class="bcpg-actions">${button("invite-accept", "acceptInvite")}${button("invite-decline", "declineInvite")}</div></section>`;
            if (lobby) {
                content += `<div class="bcpg-lobby-grid"><section><h3>${escapeHtml(this.t("playersCount", { count: lobby.players.length }))} / 10</h3><div class="bcpg-player-list">${lobby.players.map(p => this.playerMarkup(p, [p.memberNumber === lobby.hostId ? this.t("host") : "", p.ready ? this.t("ready") : this.t("notReady")].filter(Boolean).join(" · "))).join("")}</div></section><section class="bcpg-rules"><h3>${tr("rulesTitle")}</h3><p>${tr("rulesHint")}</p>${RULE_FIELDS.map(([key, values]) => `<label><span>${tr("rule_" + key)}</span>${values ? `<select data-rule="${key}" ${isHost ? "" : "disabled"}>${[...new Set([...values, lobby.rules[key]])].sort((a,b) => a-b).map(v => `<option value="${v}" ${v === lobby.rules[key] ? "selected" : ""}>${v}</option>`).join("")}</select>` : `<input type="checkbox" data-rule="${key}" ${lobby.rules[key] ? "checked" : ""} ${isHost ? "" : "disabled"}>`}</label>`).join("")}<small>${tr("stackingHint")}</small></section></div>`;
            }
            if ((!lobby || isHost) && !joining && !pendingInvite) {
                const candidates = peers.filter(p => !lobby?.players.some(joined => joined.memberNumber === p.memberNumber));
                content += `<section><h3>${tr("installedPlayers")} <span class="bcpg-badge">${candidates.length}</span></h3><div class="bcpg-player-list">${candidates.length ? candidates.map(p => {
                    const invitation = outgoingInvites.get(p.memberNumber);
                    return this.playerMarkup(p, invitation ? this.t(invitation.acknowledged ? "inviteWaiting" : "inviteSending") : this.t("available"), button("invite-member", invitation ? "inviteWaiting" : "invite", !!invitation || (lobby?.players.length >= 10), `data-member="${p.memberNumber}"`));
                }).join("") : `<p class="bcpg-empty">${tr("noInstalledPlayers")}</p>`}</div></section>`;
            }
            if (content !== this.lobbyMarkup) {
                const sessionKey = lobby?.lobbyId || "welcome";
                const scroll = this.loungeSession === sessionKey ? this.lounge.scrollTop : 0;
                this.loungeSession = sessionKey;
                const key = document.activeElement?.dataset.rule;
                this.lounge.innerHTML = content; this.lobbyMarkup = content;
                this.lounge.scrollTop = scroll;
                if (key) this.lounge.querySelector(`[data-rule="${key}"]`)?.focus({ preventScroll: true });
                this.lounge.querySelectorAll("img").forEach(img => img.addEventListener("error", () => { img.replaceWith(document.createTextNode("♟")); }, { once: true }));
            }
        }

        rulesSummary(rules = {}) {
            return `${this.t("rule_startingHandSize")}: ${rules.startingHandSize || 7} · ${this.t("rule_turnSeconds")}: ${rules.turnSeconds || 45} · ${RULE_FIELDS.filter(([key, values]) => !values && rules[key]).map(([key]) => this.t("rule_" + key)).join(" / ")}`;
        }

        drawTable() {
            const ctx = this.ctx, w = this.width, h = this.height;
            const gradient = ctx.createRadialGradient(w / 2, h / 2, 40, w / 2, h / 2, Math.max(w, h));
            gradient.addColorStop(0, "#255c59"); gradient.addColorStop(1, "#101f2b");
            ctx.fillStyle = gradient; ctx.fillRect(0, 0, w, h);
            ctx.strokeStyle = "rgba(255,255,255,.025)"; ctx.lineWidth = 1;
            for (let x = 0; x < w; x += 44) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
        }

        drawWelcome({ peers, pendingInvite }) {
            const ctx = this.ctx;
            ctx.textAlign = "center"; ctx.fillStyle = "#fff"; ctx.font = "700 42px sans-serif";
            ctx.fillText(this.t("welcome"), this.width / 2, 76);
            ctx.font = "20px sans-serif"; ctx.fillStyle = "#d9efe5";
            ctx.fillText(this.t("welcomeHint"), this.width / 2, 112);
            if (pendingInvite) {
                ctx.fillStyle = "rgba(0,0,0,.5)"; ctx.fillRect(this.width / 2 - 230, 150, 460, 90);
                ctx.fillStyle = "#f7c948"; ctx.font = "700 22px sans-serif";
                ctx.fillText(this.t("inviteFrom", { name: pendingInvite.hostName }), this.width / 2, 185);
                this.drawCanvasButton(this.width / 2 - 175, 204, 165, 48, this.t("acceptInvite"), "#397a48", "invite-accept");
                this.drawCanvasButton(this.width / 2 + 10, 204, 165, 48, this.t("declineInvite"), "#8c3b38", "invite-decline");
                return;
            }
            ctx.fillStyle = "#fff"; ctx.font = "700 21px sans-serif";
            ctx.fillText(this.t("installedPlayers"), this.width / 2, 166);
            if (!peers.length) {
                ctx.fillStyle = "#b8d2c5"; ctx.font = "17px sans-serif";
                ctx.fillText(this.t("noInstalledPlayers"), this.width / 2, 205);
            } else {
                peers.forEach((peer, index) => {
                    const x = this.width / 2 - 230, y = 184 + index * 58, w = 460, h = 46;
                    this.roundRect(ctx, x, y, w, h, 8, "rgba(0,0,0,.34)", "rgba(255,255,255,.28)");
                    ctx.fillStyle = "#fff"; ctx.font = "600 18px sans-serif"; ctx.textAlign = "left";
                    ctx.fillText(`${peer.name} (#${peer.memberNumber})`, x + 18, y + 29);
                    this.roundRect(ctx, x + w - 102, y + 7, 88, 32, 6, "#8b5b1f", "#f7d67e");
                    ctx.fillStyle = "#fff"; ctx.font = "700 15px sans-serif"; ctx.textAlign = "center";
                    ctx.fillText(this.t("invite"), x + w - 58, y + 28);
                    this.hitPeers.push({ x, y, w, h, memberNumber: peer.memberNumber });
                });
            }
        }

        drawLobby({ lobby, localId }) {
            const ctx = this.ctx;
            ctx.textAlign = "center"; ctx.fillStyle = "#fff"; ctx.font = "700 34px sans-serif";
            ctx.fillText(this.t("unoLobby"), this.width / 2, 72);
            ctx.font = "18px sans-serif"; ctx.fillStyle = "#cfe8dc";
            ctx.fillText(this.t("playersCount", { count: lobby.players.length }), this.width / 2, 108);
            lobby.players.forEach((player, i) => {
                const y = 160 + i * 42;
                ctx.fillStyle = player.memberNumber === lobby.hostId ? "#f7c948" : "#fff";
                ctx.font = "600 21px sans-serif";
                ctx.fillText(`${player.memberNumber === lobby.hostId ? "★ " : ""}${player.name}${player.memberNumber === localId ? ` (${this.t("you")})` : ""}`, this.width / 2, y);
            });
        }

        drawGame({ state, localId }) {
            const ctx = this.ctx, w = this.width, h = this.height;
            const active = core.currentPlayer(state);
            ctx.textAlign = "center"; ctx.fillStyle = "#fff"; ctx.font = "700 24px sans-serif";
            ctx.fillText(state.phase === "finished" ? this.finishedText(state) : this.t("turn", { name: active?.name || "-" }), w / 2, 38);
            if (state.phase === "playing") {
                const remains = active?.status === "disconnected" ? null : Math.max(0, Math.ceil((Number(state.turnStartedAt || Date.now()) + Number(state.rules.turnSeconds || 45) * 1000 - Date.now()) / 1000));
                ctx.fillStyle = remains != null && remains <= 10 ? "#ffad66" : "#d7ecdf";
                ctx.font = "700 16px sans-serif";
                ctx.fillText(remains == null ? this.t("timerPaused") : this.t("turnTimer", { seconds: remains }), w / 2, 61);
            }
            ctx.font = "15px sans-serif"; ctx.fillStyle = "#d7ecdf";
            ctx.fillText(this.t("deckCount", { count: state.drawPile.length }), w / 2, 82);

            const opponents = state.players.filter(p => p.memberNumber !== localId);
            const spacing = w / Math.max(1, opponents.length);
            opponents.forEach((player, i) => {
                const x = spacing * i + spacing / 2, y = 105;
                this.avatarUrl(player);
                const avatar = this.avatarImages.get(player.memberNumber);
                ctx.save(); ctx.beginPath(); ctx.arc(x, y + 35, 21, 0, Math.PI * 2); ctx.clip();
                ctx.fillStyle = "#344c60"; ctx.fillRect(x - 21, y + 14, 42, 42);
                if (avatar) ctx.drawImage(avatar, x - 21, y + 14, 42, 42);
                else { ctx.fillStyle = "#fff"; ctx.font = "18px sans-serif"; ctx.fillText(Array.from(player.name || "?")[0], x, y + 41); }
                ctx.restore();
                const count = state.hands[String(player.memberNumber)]?.length || 0;
                ctx.fillStyle = player.status === "disconnected" ? "#ffadad" : player.status === "lost" ? "#999" : "#fff";
                ctx.font = "600 17px sans-serif";
                let name = player.name;
                const suffix = ` · ${this.t("cardsCount", { count })}`;
                while (name.length > 1 && ctx.measureText(name + suffix).width > spacing - 12) name = name.slice(0, -1);
                ctx.fillText(`${name}${name !== player.name ? "…" : ""}${suffix}`, x, y, spacing - 8);
                if (player.memberNumber === state.hostId) { ctx.fillStyle = "#f7c948"; ctx.fillText("★", x + 28, y + 35); }
                this.drawBacks(x, y + 64, Math.min(count, 12));
            });

            const top = state.discardPile[state.discardPile.length - 1];
            const centerY = 236, deckX = w / 2 - 132, discardX = w / 2 + 36;
            this.drawDeck(ctx, deckX, centerY, 96, 140, state.drawPile.length);
            this.drawCard(ctx, top, discardX, centerY, 96, 140, false);
            ctx.fillStyle = CARD_COLORS[state.activeColor] || "#fff";
            ctx.beginPath(); ctx.arc(discardX + 120, centerY + 70, 16, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = "#fff"; ctx.stroke();
            ctx.fillStyle = "#fff"; ctx.font = "14px sans-serif"; ctx.textAlign = "center";
            ctx.fillText(this.t("color_" + state.activeColor), discardX + 120, centerY + 104);
            if (state.pendingDraw) ctx.fillText(this.t("pendingDraw", { count: state.pendingDraw }), w / 2, centerY - 12);
            if (state.phase === "playing" && active?.memberNumber === localId && !state.drawnThisTurn) {
                ctx.fillStyle = "#fff"; ctx.font = "700 15px sans-serif"; ctx.textAlign = "center";
                ctx.fillText(this.t("clickToDraw"), deckX + 48, centerY + 162);
                this.hitWelcomeActions.push({ x: deckX - 8, y: centerY - 8, w: 112, h: 178, action: "draw" });
            }

            const hand = state.hands[String(localId)] || [];
            const cardW = 82, cardH = 120;
            const available = w - 70;
            const step = hand.length <= 1 ? cardW : Math.min(cardW + 8, (available - cardW) / (hand.length - 1));
            const total = cardW + Math.max(0, hand.length - 1) * step;
            const start = (w - total) / 2;
            hand.forEach((card, i) => {
                const x = start + i * step, y = h - cardH - 18;
                const playable = active?.memberNumber === localId && core.canPlayCard(card, state)
                    && !(card.kind === "wild4" && state.rules.strictWildFour && !state.pendingDraw && hand.some(c => c.id !== card.id && c.color === state.activeColor))
                    && (!state.drawnThisTurn || !state.playableDrawnCardId || card.id === state.playableDrawnCardId);
                this.drawCard(ctx, card, x, y - (playable ? 10 : 0), cardW, cardH, playable);
                this.hitCards.push({ x, y: y - (playable ? 10 : 0), w: cardW, h: cardH, card, playable });
            });

            if (state.vote) this.drawVote(state.vote, state);
            this.drawGear();
            if (this.settingsOpen) this.drawSettingsPanel(state, localId);
            if (this.pendingWildCardId) this.drawColorWheel();
        }

        finishedText(state) {
            if (!state.winnerId) return this.t("gameEnded");
            const winner = state.players.find(p => p.memberNumber === state.winnerId);
            return this.t("winner", { name: winner?.name || state.winnerId });
        }

        drawBacks(centerX, y, count) {
            const start = centerX - Math.max(0, count - 1) * 5 / 2 - 18;
            for (let i = 0; i < count; i++) {
                const x = start + i * 5;
                this.roundRect(this.ctx, x, y, 36, 52, 5, "#161616", "#eee");
                this.ctx.strokeStyle = "#d72638"; this.ctx.lineWidth = 2;
                this.ctx.beginPath(); this.ctx.ellipse(x + 18, y + 26, 10, 20, .6, 0, Math.PI * 2); this.ctx.stroke();
            }
        }

        drawCard(ctx, card, x, y, w, h, highlight) {
            if (!card) return;
            ctx.save();
            if (highlight) { ctx.shadowColor = "#fff59d"; ctx.shadowBlur = 14; }
            this.roundRect(ctx, x, y, w, h, 10, "#f8f4e8", highlight ? "#fff59d" : "#222");
            this.roundRect(ctx, x + 5, y + 5, w - 10, h - 10, 8, CARD_COLORS[card.color], "rgba(0,0,0,.3)");
            ctx.fillStyle = "rgba(255,255,255,.88)";
            ctx.beginPath(); ctx.ellipse(x + w / 2, y + h / 2, w * .28, h * .39, .55, 0, Math.PI * 2); ctx.fill();
            const label = card.kind === "number" ? String(card.value) : SYMBOLS[card.kind];
            ctx.fillStyle = card.color === "yellow" ? "#333" : CARD_COLORS[card.color] || "#111";
            if (card.color === "wild") ctx.fillStyle = "#111";
            ctx.font = `900 ${Math.floor(w * .42)}px sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
            if (card.kind === "draw2" || card.kind === "wild4") this.drawDrawCardSymbol(ctx, card, x, y, w, h);
            else ctx.fillText(label, x + w / 2, y + h / 2);
            ctx.restore();
        }

        drawDrawCardSymbol(ctx, card, x, y, w, h) {
            const colors = card.kind === "wild4" ? ["red", "yellow", "green", "blue"] : [card.color, card.color];
            colors.forEach((color, i) => {
                const cols = colors.length === 4 ? 2 : 2, row = colors.length === 4 ? Math.floor(i / 2) : 0, col = i % cols;
                this.roundRect(ctx, x + w * .28 + col * w * .22, y + h * .28 + row * h * .14, w * .2, h * .28, 3, CARD_COLORS[color], "#fff");
            });
            ctx.fillStyle = "#111"; ctx.font = `900 ${Math.floor(w * .28)}px sans-serif`; ctx.textAlign = "center";
            ctx.fillText(card.kind === "wild4" ? "+4" : "+2", x + w / 2, y + h * .76);
        }

        drawDeck(ctx, x, y, w, h, count) {
            for (let layer = 3; layer >= 0; layer--) this.roundRect(ctx, x + layer * 2, y - layer * 2, w, h, 10, "#eee9db", "#222");
            this.roundRect(ctx, x + 5, y + 5, w - 10, h - 10, 8, "#151515", "#eee");
            ctx.fillStyle = "#e52535"; ctx.beginPath(); ctx.ellipse(x + w / 2, y + h / 2, w * .25, h * .36, .55, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = "#fff"; ctx.font = `900 ${Math.floor(w * .22)}px sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
            ctx.fillText("UNO", x + w / 2, y + h / 2); ctx.textBaseline = "alphabetic";
            ctx.font = "700 13px sans-serif"; ctx.fillText(String(count), x + w - 13, y + h - 10);
        }

        drawGear() {
            const x = this.width - 58, y = 18;
            this.roundRect(this.ctx, x, y, 40, 40, 20, this.settingsOpen ? "#a66e27" : "rgba(0,0,0,.5)", "#ead28c");
            this.ctx.fillStyle = "#fff"; this.ctx.font = "25px sans-serif"; this.ctx.textAlign = "center"; this.ctx.fillText("⚙", x + 20, y + 29);
            this.hitWelcomeActions.push({ x, y, w: 40, h: 40, action: "settings" });
        }

        drawSettingsPanel(state, localId) {
            const x = this.width - 268, y = 68, w = 250;
            this.ctx.fillStyle = "rgba(18,15,11,.95)"; this.ctx.fillRect(x, y, w, 230);
            this.ctx.strokeStyle = "#d4af55"; this.ctx.strokeRect(x, y, w, 230);
            this.ctx.fillStyle = "#fff"; this.ctx.font = "700 19px sans-serif"; this.ctx.textAlign = "center";
            this.ctx.fillText(this.t("gameManagement"), x + w / 2, y + 30);
            let by = y + 46;
            const add = (label, action, color = "#6e451e") => { this.drawCanvasButton(x + 18, by, w - 36, 38, label, color, action); by += 46; };
            if (!state.vote && state.phase !== "finished") { add(this.t("voteRestart"), "vote-restart"); add(this.t("voteEnd"), "vote-end", "#713b32"); }
            if (Number(state.hostId) === Number(localId) && state.phase === "playing") add(this.t("transferHost"), "transfer");
            add(this.t("leave"), "leave", "#713b32");
        }

        drawColorWheel() {
            const ctx = this.ctx, cx = this.width / 2, cy = this.height / 2, radius = Math.min(105, this.height * .22);
            ctx.save(); ctx.fillStyle = "rgba(0,0,0,.76)"; ctx.fillRect(0, 0, this.width, this.height);
            ctx.fillStyle = "#fff"; ctx.font = "700 24px sans-serif"; ctx.textAlign = "center"; ctx.fillText(this.t("chooseColor"), cx, cy - radius - 24);
            core.COLORS.forEach((color, index) => {
                const start = -Math.PI / 2 + index * Math.PI / 2;
                ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, radius, start, start + Math.PI / 2); ctx.closePath();
                ctx.fillStyle = CARD_COLORS[color]; ctx.fill(); ctx.strokeStyle = "#fff"; ctx.lineWidth = 3; ctx.stroke();
            });
            ctx.beginPath(); ctx.arc(cx, cy, radius * .26, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill();
            ctx.fillStyle = "#111"; ctx.font = "900 17px sans-serif"; ctx.fillText("UNO", cx, cy + 6); ctx.restore();
        }

        drawVote(vote, state) {
            const ctx = this.ctx, seconds = Math.max(0, Math.ceil((vote.endsAt - Date.now()) / 1000));
            const eligible = state.players.filter(p => p.status === "online").length;
            const yes = Object.values(vote.votes).filter(Boolean).length;
            ctx.fillStyle = "rgba(0,0,0,.72)"; ctx.fillRect(this.width / 2 - 190, 74, 380, 62);
            ctx.fillStyle = "#fff"; ctx.font = "600 17px sans-serif"; ctx.textAlign = "center";
            ctx.fillText(this.t(vote.kind === "restart" ? "voteRestartStatus" : "voteEndStatus", { yes, total: eligible, seconds }), this.width / 2, 111);
        }

        renderToolbar({ lobby, state, localId, isHost, peers, pendingInvite, joining }) {
            const buttons = [];
            if (!lobby && !state) {
                if (pendingInvite) { buttons.push(["invite-accept", "acceptInvite"]); buttons.push(["invite-decline", "declineInvite"]); }
                else if (!joining) { buttons.push(["create", "createLobby"]); buttons.push(["refresh", "refreshPlayers"]); }
            }
            if (lobby) {
                if (!lobby.players.some(p => p.memberNumber === localId)) buttons.push(["join", "joinLobby"]);
                if (isHost) { buttons.push(["start", "startGame", lobby.players.length < 2 || lobby.players.some(p => !p.ready)]); buttons.push(["refresh", "refreshPlayers"]); }
                else buttons.push(["ready", lobby.players.find(p => p.memberNumber === localId)?.ready ? "cancelReady" : "ready"]);
                buttons.push(["leave", "leave"]);
            }
            if (state) {
                const myTurn = state.phase === "playing" && core.currentPlayer(state)?.memberNumber === localId;
                if (myTurn && !state.drawnThisTurn) buttons.push(["draw", "drawCard"]);
                if (myTurn && state.drawnThisTurn) buttons.push(["pass", "pass"]);
                if (state.phase === "finished") { buttons.push(["vote-restart", "voteRestart", !!state.vote]); buttons.push(["leave", "leave"]); }
                if (state.vote && state.vote.votes[String(localId)] == null) {
                    buttons.push(["vote-yes", "yes"]); buttons.push(["vote-no", "no"]);
                }
            }
            buttons.push(["close", "close"]);
            const markup = buttons.map(([act, key, disabled]) => `<button data-act="${act}" ${disabled ? "disabled" : ""}>${escapeHtml(this.t(key))}</button>`).join("");
            if (this.toolbar.innerHTML !== markup) this.toolbar.innerHTML = markup;
        }

        click(event) {
            const act = event.target.closest("[data-act]")?.dataset.act;
            if (!act) return;
            if (act === "invite-member") return this.controller.invite(Number(event.target.closest("[data-member]").dataset.member));
            if (act === "ready") return this.controller.setReady(!this.controller.lobby.players.find(p => p.memberNumber === this.controller.localId)?.ready);
            if (act === "close") return this.toggle(false);
            if (act === "invite") return this.chooseInvitee();
            if (act === "invite-accept") return this.controller.acceptInvite();
            if (act === "invite-decline") return this.controller.declineInvite();
            if (act === "refresh") return this.controller.transport.send("HELLO", { version: "0.3.0", name: this.controller.localPlayer().name });
            if (act === "create") this.controller.createLobby();
            else if (act === "join") this.controller.joinLobby();
            else if (act === "start") this.controller.startGame();
            else if (act === "leave") this.controller.leave();
            else if (act === "draw") this.controller.requestDraw();
            else if (act === "pass") this.controller.requestPass();
            else if (act === "vote-restart") this.controller.startVote("restart");
            else if (act === "vote-end") this.controller.startVote("end");
            else if (act === "vote-yes") this.controller.castVote(true);
            else if (act === "vote-no") this.controller.castVote(false);
            else if (act === "transfer") this.chooseHost();
        }

        canvasClick(event) {
            const rect = this.canvas.getBoundingClientRect();
            const x = (event.clientX - rect.left) * this.width / rect.width;
            const y = (event.clientY - rect.top) * this.height / rect.height;
            if (this.pendingWildCardId) {
                const dx = x - this.width / 2, dy = y - this.height / 2, radius = Math.min(105, this.height * .22);
                if (Math.hypot(dx, dy) <= radius) {
                    let angle = Math.atan2(dy, dx); if (angle < -Math.PI / 2) angle += Math.PI * 2;
                    const color = core.COLORS[Math.floor((angle + Math.PI / 2) / (Math.PI / 2)) % 4];
                    const cardId = this.pendingWildCardId; this.pendingWildCardId = null;
                    this.controller.requestPlay(cardId, color); this.render();
                }
                return;
            }
            const welcomeAction = [...this.hitWelcomeActions].reverse().find(hit => x >= hit.x && x <= hit.x + hit.w && y >= hit.y && y <= hit.y + hit.h);
            if (welcomeAction?.action === "invite-accept") return this.controller.acceptInvite();
            if (welcomeAction?.action === "invite-decline") return this.controller.declineInvite();
            if (welcomeAction?.action === "draw") return this.controller.requestDraw();
            if (welcomeAction?.action === "settings") { this.settingsOpen = !this.settingsOpen; return this.render(); }
            if (welcomeAction?.action === "vote-restart") return this.controller.startVote("restart");
            if (welcomeAction?.action === "vote-end") return this.controller.startVote("end");
            if (welcomeAction?.action === "transfer") return this.chooseHost();
            if (welcomeAction?.action === "leave") return this.controller.leave();
            if (this.settingsOpen) return;
            const peer = this.hitPeers.find(hit => x >= hit.x && x <= hit.x + hit.w && y >= hit.y && y <= hit.y + hit.h);
            if (peer) return this.controller.invite(peer.memberNumber);
            const hit = [...this.hitCards].reverse().find(card => x >= card.x && x <= card.x + card.w && y >= card.y && y <= card.y + card.h);
            if (!hit?.playable) return;
            if (hit.card.color === "wild") {
                this.pendingWildCardId = hit.card.id;
                this.render();
            } else this.controller.requestPlay(hit.card.id);
        }

        chooseHost() {
            const state = this.controller.state;
            const choices = state.players.filter(p => p.status === "online" && p.memberNumber !== this.controller.localId);
            if (!choices.length) return;
            const text = choices.map(p => `${p.memberNumber}: ${p.name}`).join("\n");
            const id = Number(prompt(`${this.t("transferPrompt")}\n${text}`, String(choices[0].memberNumber)));
            if (choices.some(p => p.memberNumber === id)) this.controller.proposeHost(id);
        }

        chooseInvitee() {
            const peers = this.controller.snapshot().peers;
            if (!peers.length) return;
            const text = peers.map(p => `${p.memberNumber}: ${p.name}`).join("\n");
            const id = Number(prompt(`${this.t("invitePrompt")}\n${text}`, String(peers[0].memberNumber)));
            if (peers.some(p => p.memberNumber === id)) this.controller.invite(id);
        }

        drawCanvasButton(x, y, w, h, label, color, action) {
            this.roundRect(this.ctx, x, y, w, h, 7, color, "#f4dc9b");
            this.ctx.fillStyle = "#fff"; this.ctx.font = "700 16px sans-serif";
            this.ctx.textAlign = "center"; this.ctx.textBaseline = "middle";
            this.ctx.fillText(label, x + w / 2, y + h / 2);
            this.ctx.textBaseline = "alphabetic";
            this.hitWelcomeActions.push({ x, y, w, h, action });
        }

        roundRect(ctx, x, y, w, h, r, fill, stroke) {
            ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fillStyle = fill; ctx.fill();
            if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke(); }
        }

        destroy() {
            this.unsubscribe?.(); window.removeEventListener("resize", this.resizeHandler);
            window.removeEventListener("keydown", this.keyHandler);
            for (const unhook of this.avatarUnhooks) unhook();
            this.avatarUnhooks = [];
            this.avatars.clear(); this.avatarImages.clear(); this.avatarDirty.clear();
            this.root?.remove(); this.root = null;
        }
    }

    function installStyles() {
        if (document.getElementById("bcpg-style")) return;
        const style = document.createElement("style"); style.id = "bcpg-style";
        style.textContent = `
#bcpg-overlay{display:none;position:fixed;inset:0;z-index:10050;background:rgba(0,0,0,.72);align-items:center;justify-content:center;font-family:Arial,sans-serif;overflow:auto;padding:10px;box-sizing:border-box}
#bcpg-overlay.open{display:flex}.bcpg-window{display:flex;position:relative;isolation:isolate;flex-direction:column;background:#17201b;border:2px solid #d9b45b;border-radius:12px;overflow:hidden;box-shadow:0 20px 70px #000;color:#fff;max-width:calc(100vw - 20px);max-height:calc(100vh - 20px)}
.bcpg-title{position:relative;z-index:3;height:42px;min-height:42px;display:flex;align-items:center;justify-content:space-between;padding:0 12px;background:#24170c;font-weight:700;font-size:19px;flex:0 0 auto}.bcpg-title button{font-size:28px;color:#fff;background:none;border:0;cursor:pointer}
#bcpg-overlay canvas{display:block!important;position:relative!important;inset:auto!important;z-index:1!important;min-height:0;max-width:100%;flex:1 1 auto}.bcpg-toolbar{position:relative;z-index:3;min-height:52px;padding:7px;display:flex;gap:7px;justify-content:center;align-items:center;flex-wrap:wrap;background:#24170c;flex:0 0 auto;box-sizing:border-box}
.bcpg-toolbar button{padding:8px 14px;border:1px solid #e5c675;border-radius:6px;background:#6e451e;color:#fff;font-weight:700;cursor:pointer}.bcpg-toolbar button:hover{background:#93622f}.bcpg-toolbar button:disabled{opacity:.45;cursor:not-allowed}
#bcpg-chat-button img{width:70%;height:70%;object-fit:contain}
#bcpg-overlay{background:rgba(8,13,23,.78);backdrop-filter:blur(8px);font-family:Inter,"Noto Sans TC",system-ui,sans-serif}
#bcpg-overlay *{box-sizing:border-box}.bcpg-window{width:1080px;background:#101b29;border:1px solid #42546b;border-radius:20px;box-shadow:0 28px 100px #0009}.bcpg-compact .bcpg-window{width:880px}
.bcpg-title{height:58px;min-height:58px;background:#142131;padding:0 22px;letter-spacing:.4px;border-bottom:1px solid #ffffff12}.bcpg-title span{font-size:17px}.bcpg-title button{width:36px;height:36px;border-radius:10px}
.bcpg-lounge{padding:26px;overflow:auto;min-height:0;color:#e9eef7}.bcpg-lounge[hidden],.bcpg-table-scroll[hidden]{display:none!important}.bcpg-table-scroll{overflow:auto;min-height:0;flex:1 1 auto}.bcpg-table-scroll canvas{max-width:none!important;flex:none!important}
.bcpg-hero{background:radial-gradient(ellipse at top right,#3c647155,transparent 70%),#1b2b3e;border:1px solid #ffffff12;border-radius:16px;padding:24px;margin-bottom:24px}.bcpg-eyebrow{font-size:11px;letter-spacing:2.5px;color:#a5d9cf}.bcpg-hero h2{font-size:30px;margin:10px 0}.bcpg-hero p,.bcpg-rules p{color:#aebdd0;font-size:14px;line-height:1.7;margin:8px 0 16px}.bcpg-badge{display:inline-block;font-size:12px;padding:5px 10px;border-radius:20px;background:#ffffff0b;color:#b7d7d7;font-weight:500}
.bcpg-lounge h3{font-size:15px;margin:0 0 14px}.bcpg-lounge section{margin-bottom:20px}.bcpg-lobby-grid{display:grid;grid-template-columns:1fr 1fr;gap:22px}.bcpg-player-list{display:grid;gap:9px}.bcpg-player{display:flex;gap:12px;align-items:center;background:#1b293b;border:1px solid #ffffff0c;padding:12px;border-radius:12px;min-width:0}.bcpg-avatar{width:44px;height:44px;border-radius:13px;background:#345260;display:grid;place-items:center;flex:none;font-size:20px;overflow:hidden}.bcpg-avatar img{width:100%;height:100%;object-fit:cover}.bcpg-player-info{flex:1;min-width:0}.bcpg-player strong{display:block;overflow-wrap:anywhere;font-size:14px}.bcpg-player small{display:block;color:#9fb2c9;font-size:12px;margin-top:5px}.bcpg-player button{flex:none}
.bcpg-rules{background:#142232;border:1px solid #ffffff12;border-radius:14px;padding:18px}.bcpg-rules label{display:flex;gap:10px;align-items:center;justify-content:space-between;padding:9px 0;border-top:1px solid #ffffff0b;font-size:13px}.bcpg-rules select{background:#24354b;color:#e9eef7;border:1px solid #486077;border-radius:7px;padding:5px;min-width:70px}.bcpg-rules input{accent-color:#a5dfce;width:18px;height:18px}.bcpg-rules small{display:block;color:#91a8bc;font-size:12px;line-height:1.7;margin-top:12px}.bcpg-rules :disabled{opacity:.7}
.bcpg-toolbar{background:#142131;border-top:1px solid #ffffff12;padding:14px;gap:10px}.bcpg-toolbar button,.bcpg-lounge button{border:1px solid #638a89;border-radius:9px;background:#285451;color:#eafff9;padding:9px 14px;font:600 13px inherit;cursor:pointer;min-height:38px}.bcpg-toolbar button:hover,.bcpg-lounge button:hover{background:#386e68}.bcpg-toolbar button:disabled,.bcpg-lounge button:disabled{opacity:.45;cursor:not-allowed}#bcpg-overlay button:focus-visible,#bcpg-overlay select:focus-visible,#bcpg-overlay input:focus-visible{outline:2px solid #ead8a5;outline-offset:3px}.bcpg-actions{display:flex;gap:10px}.bcpg-invitation{border:1px solid #87b9a7;background:#203d3a;border-radius:14px;padding:18px}.bcpg-invitation p{font-size:13px;line-height:1.8;color:#bfdcd4}.bcpg-notice,.bcpg-empty{padding:18px;color:#a7bbce;font-size:14px;line-height:1.8}.bcpg-notice{border:1px solid #557d92;border-radius:12px;margin-bottom:18px}
.bcpg-lounge button,.bcpg-toolbar button{font-family:inherit;font-size:13px;font-weight:600}
@media(max-width:650px){.bcpg-lounge{padding:14px}.bcpg-lobby-grid{grid-template-columns:1fr;gap:0}.bcpg-hero{padding:18px}.bcpg-hero h2{font-size:25px}.bcpg-title{padding:0 14px}.bcpg-toolbar{padding:10px}.bcpg-player{gap:8px}.bcpg-player button{padding:8px}.bcpg-window{border-radius:14px}}
`;
        document.head.appendChild(style);
    }

    return { GameUI, installStyles };
});

// ---- Translation/PartyGames-i18n.js ----
(function (root) {
    const strings = {
        lobbyHint: { TW: "邀請同房玩家，確認規則並準備後即可開局。", CN: "邀请同房玩家，确认规则并准备后即可开局。", EN: "Invite room members, review the rules, and ready up." },
        playersLabel: { TW: "人", CN: "人", EN: "players" },
        cardsLabel: { TW: "張牌", CN: "张牌", EN: "cards" },
        host: { TW: "主持人", CN: "主持人", EN: "Host" },
        ready: { TW: "已準備", CN: "已准备", EN: "Ready" },
        notReady: { TW: "確認規則中", CN: "确认规则中", EN: "Reviewing rules" },
        cancelReady: { TW: "取消準備", CN: "取消准备", EN: "Unready" },
        available: { TW: "可邀請", CN: "可邀请", EN: "Available" },
        inviteSending: { TW: "邀請傳送中", CN: "邀请发送中", EN: "Sending invitation" },
        inviteWaiting: { TW: "等待回覆", CN: "等待回复", EN: "Awaiting reply" },
        joining: { TW: "正在加入牌局，等待主持人確認…", CN: "正在加入牌局，等待主持人确认…", EN: "Joining the table; waiting for the host…" },
        joinFailed: { TW: "加入逾時，牌局可能已開始或主持人已離開。請重新邀請。", CN: "加入超时，牌局可能已开始或主持人已离开。请重新邀请。", EN: "Joining timed out. The table may have started or closed. Request a new invitation." },
        rulesTitle: { TW: "牌局規則", CN: "牌局规则", EN: "Table rules" },
        rulesHint: { TW: "主持人可在開局前調整；變更後需重新準備。", CN: "主持人可在开局前调整；变更后需重新准备。", EN: "The host can edit before starting. Changes reset player readiness." },
        rule_startingHandSize: { TW: "起始手牌數", CN: "起始手牌数", EN: "Starting hand" },
        rule_turnSeconds: { TW: "回合秒數", CN: "回合秒数", EN: "Turn seconds" },
        rule_reconnectSeconds: { TW: "重連寬限秒數", CN: "重连宽限秒数", EN: "Reconnect seconds" },
        rule_voteSeconds: { TW: "投票秒數", CN: "投票秒数", EN: "Vote seconds" },
        rule_voteCooldownSeconds: { TW: "投票冷卻秒數", CN: "投票冷却秒数", EN: "Vote cooldown seconds" },
        rule_stacking: { TW: "同類罰牌疊加", CN: "同类罚牌叠加", EN: "Stack matching draw cards" },
        rule_drawUntilPlayable: { TW: "抽到可出為止", CN: "抽到可出为止", EN: "Draw until playable" },
        rule_playDrawnCard: { TW: "可立即打出剛抽的牌", CN: "可立即打出刚抽的牌", EN: "Allow playing drawn card" },
        rule_forcePlay: { TW: "有牌可出時不可抽牌", CN: "有牌可出时不可抽牌", EN: "Must play if possible" },
        rule_strictWildFour: { TW: "有同色牌時禁止出 +4", CN: "有同色牌时禁止出 +4", EN: "Restrict +4 with matching color" },
        stackingHint: { TW: "疊加只允許 +2 接 +2、+4 接 +4；無法接牌時抽取累計張數並跳過。嚴格 +4 不限制疊加回應。", CN: "叠加只允许 +2 接 +2、+4 接 +4；无法接牌时抽取累计张数并跳过。严格 +4 不限制叠加回应。", EN: "Stack +2 on +2 or +4 on +4. Drawing the accumulated penalty ends the turn. Strict +4 does not restrict stacking responses." },
        pendingDraw: { TW: "待承受罰牌：+{count}", CN: "待承受罚牌：+{count}", EN: "Pending draw penalty: +{count}" },
        mustPlay: { TW: "目前有牌可出，依規則不能抽牌。", CN: "目前有牌可出，依规则不能抽牌。", EN: "A playable card is available; drawing is disabled by the rules." },
        wild4HasColor: { TW: "你仍有目前顏色的牌，不能出 +4。", CN: "你仍有当前颜色的牌，不能出 +4。", EN: "You have a matching color and cannot play +4." },
        color_red: { TW: "紅色", CN: "红色", EN: "Red" },
        color_yellow: { TW: "黃色", CN: "黄色", EN: "Yellow" },
        color_green: { TW: "綠色", CN: "绿色", EN: "Green" },
        color_blue: { TW: "藍色", CN: "蓝色", EN: "Blue" },
        title: { TW: "BC 派對遊戲", CN: "BC 派对游戏", EN: "BC Party Games" },
        welcome: { TW: "UNO 派對桌", CN: "UNO 派对桌", EN: "UNO Party Table" },
        welcomeHint: { TW: "選擇已安裝插件的房間成員並提出邀請。", CN: "选择已安装插件的房间成员并发出邀请。", EN: "Choose a room member with the plugin and send an invitation." },
        installedPlayers: { TW: "已偵測到的插件玩家", CN: "已检测到的插件玩家", EN: "Detected plugin players" },
        noInstalledPlayers: { TW: "尚未偵測到其他玩家；請對方確認插件已載入。", CN: "尚未检测到其他玩家；请对方确认插件已加载。", EN: "No other players detected. Ask them to check that the plugin is loaded." },
        inviteFrom: { TW: "{name} 邀請你加入 UNO", CN: "{name} 邀请你加入 UNO", EN: "{name} invited you to UNO" },
        invitePlayer: { TW: "邀請玩家", CN: "邀请玩家", EN: "Invite player" },
        invite: { TW: "邀請", CN: "邀请", EN: "Invite" },
        invitePrompt: { TW: "輸入要邀請的會員編號：", CN: "输入要邀请的会员编号：", EN: "Enter the member number to invite:" },
        acceptInvite: { TW: "接受邀請", CN: "接受邀请", EN: "Accept" },
        declineInvite: { TW: "拒絕邀請", CN: "拒绝邀请", EN: "Decline" },
        refreshPlayers: { TW: "重新偵測", CN: "重新检测", EN: "Scan again" },
        close: { TW: "關閉", CN: "关闭", EN: "Close" },
        unoLobby: { TW: "UNO 等候室", CN: "UNO 等候室", EN: "UNO Lobby" },
        playersCount: { TW: "目前 {count} 位玩家", CN: "目前 {count} 位玩家", EN: "{count} players" },
        cardsCount: { TW: "{count} 張", CN: "{count} 张", EN: "{count} cards" },
        deckCount: { TW: "牌庫：{count}", CN: "牌库：{count}", EN: "Deck: {count}" },
        turn: { TW: "輪到 {name}", CN: "轮到 {name}", EN: "{name}'s turn" },
        turnTimer: { TW: "剩餘 {seconds} 秒", CN: "剩余 {seconds} 秒", EN: "{seconds}s remaining" },
        timerPaused: { TW: "等待玩家重連，計時暫停", CN: "等待玩家重连，计时暂停", EN: "Timer paused while waiting for reconnection" },
        winner: { TW: "{name} 獲勝！", CN: "{name} 获胜！", EN: "{name} wins!" },
        gameEnded: { TW: "牌局已結束", CN: "牌局已结束", EN: "Game ended" },
        you: { TW: "你", CN: "你", EN: "You" },
        createLobby: { TW: "建立 UNO 牌局", CN: "创建 UNO 牌局", EN: "Create UNO game" },
        joinLobby: { TW: "加入", CN: "加入", EN: "Join" },
        startGame: { TW: "開始遊戲", CN: "开始游戏", EN: "Start game" },
        leave: { TW: "離開牌局", CN: "离开牌局", EN: "Leave" },
        drawCard: { TW: "抽一張", CN: "抽一张", EN: "Draw" },
        pass: { TW: "結束回合", CN: "结束回合", EN: "Pass" },
        voteRestart: { TW: "投票重開", CN: "投票重开", EN: "Vote restart" },
        voteEnd: { TW: "投票結束", CN: "投票结束", EN: "Vote to end" },
        yes: { TW: "贊成", CN: "赞成", EN: "Yes" },
        no: { TW: "反對", CN: "反对", EN: "No" },
        transferHost: { TW: "讓渡主持", CN: "让渡主持", EN: "Transfer host" },
        transferPrompt: { TW: "輸入新主持人的會員編號：", CN: "输入新主持人的会员编号：", EN: "Enter the new host member number:" },
        chooseColor: { TW: "選擇顏色", CN: "选择颜色", EN: "Choose a color" },
        clickToDraw: { TW: "點擊牌庫抽牌", CN: "点击牌库抽牌", EN: "Click deck to draw" },
        gameManagement: { TW: "牌局管理", CN: "牌局管理", EN: "Game management" },
        voteRestartStatus: { TW: "重開投票：{yes}/{total}｜剩餘 {seconds} 秒", CN: "重开投票：{yes}/{total}｜剩余 {seconds} 秒", EN: "Restart vote: {yes}/{total} · {seconds}s" },
        voteEndStatus: { TW: "結束投票：{yes}/{total}｜剩餘 {seconds} 秒", CN: "结束投票：{yes}/{total}｜剩余 {seconds} 秒", EN: "End vote: {yes}/{total} · {seconds}s" },
        loaded: { TW: "BC 派對遊戲已載入。輸入 /partygames 或點擊聊天室按鈕開啟。", CN: "BC 派对游戏已加载。输入 /partygames 或点击聊天室按钮打开。", EN: "BC Party Games loaded. Use /partygames or the chat-room button." },
        lobbyCreated: { TW: "已建立 UNO 等候室。", CN: "已创建 UNO 等候室。", EN: "UNO lobby created." },
        inviteReceived: { TW: "收到 {name} 的 UNO 邀請。", CN: "收到 {name} 的 UNO 邀请。", EN: "UNO invitation received from {name}." },
        inviteDeclined: { TW: "{name} 拒絕了邀請。", CN: "{name} 拒绝了邀请。", EN: "{name} declined the invitation." },
        inviteDelivered: { TW: "邀請已送達 {name}，等待對方回覆。", CN: "邀请已送达 {name}，等待对方回复。", EN: "Invitation delivered to {name}; waiting for a response." },
        inviteNoResponse: { TW: "{name} 沒有回應邀請，請稍後再試。", CN: "{name} 没有回应邀请，请稍后再试。", EN: "{name} did not respond to the invitation. Try again later." },
        voteCooldown: { TW: "你還需要等待 {seconds} 秒才能再次發起投票。", CN: "你还需要等待 {seconds} 秒才能再次发起投票。", EN: "Wait {seconds}s before starting another vote." },
        notYourTurn: { TW: "現在不是你的回合。", CN: "现在不是你的回合。", EN: "It is not your turn." },
        illegalCard: { TW: "這張牌目前不能打出。", CN: "这张牌目前不能打出。", EN: "That card cannot be played now." },
        chooseColorError: { TW: "萬用牌必須選擇顏色。", CN: "万能牌必须选择颜色。", EN: "Choose a color for the wild card." },
        genericError: { TW: "操作失敗：{error}", CN: "操作失败：{error}", EN: "Action failed: {error}" }
    };
    // 字庫隨單一 userscript 內嵌；實際翻譯仍統一交由 Liko BC_i18n 引擎處理。
    root.BCPartyGamesI18nStrings = strings;
    root.Liko?.__Sys_i18n__?.register?.("BCPG", strings);
})(typeof globalThis !== "undefined" ? globalThis : window);

// ---- src/app.js ----
(function startBCPartyGames(root) {
    "use strict";
    if (typeof window === "undefined") return;
    window.Liko = window.Liko || {};
    if (window.Liko.BCPartyGames?.loaded || window.Liko.BCPartyGames?.loading) return;

    const API = window.Liko.BCPartyGames = window.Liko.BCPartyGames || {};
    Object.assign(API, { version: "0.3.0", loading: true, loaded: false });
    const modules = root.BCPartyGamesModules;
    const LIKO_BASE = window.LikoDevBase || "https://raw.githubusercontent.com/awdrrawd/liko-Plugin-Repository/main/Plugins/";
    let modApi, transport, controller, ui, renderTimer;

    function waitFor(check, timeout = 30000, interval = 100) {
        return new Promise((resolve, reject) => {
            const started = Date.now();
            const timer = setInterval(() => {
                let value;
                try { value = check(); } catch (_) {}
                if (value) { clearInterval(timer); resolve(value); }
                else if (Date.now() - started >= timeout) { clearInterval(timer); reject(new Error("Timed out waiting for Bondage Club")); }
            }, interval);
        });
    }

    function waitForLogin() {
        if (typeof window.Player !== "undefined" && window.Player?.MemberNumber !== undefined) return Promise.resolve();
        return new Promise(resolve => {
            const removeHook = modApi.hookFunction("LoginResponse", 0, (args, next) => {
                const result = next(args);
                queueMicrotask(() => {
                    if (typeof window.Player === "undefined" || window.Player?.MemberNumber === undefined) return;
                    removeHook();
                    resolve();
                });
                return result;
            });
        });
    }

    async function loadScript(url) {
        const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
        const code = await response.text();
        if (code.trimStart().startsWith("<")) throw new Error(`Unexpected HTML: ${url}`);
        new Function(code)();
    }

    async function ensureSharedSystems() {
        if (typeof window.Liko?.__Sys_i18n__?.ensure !== "function") await loadScript(LIKO_BASE + "expand/BC_i18n.js");
        // PartyGames 的基本字庫已隨 userscript 內嵌，避免新版本尚未推上 GitHub 時反覆 404。
        // 翻譯解析、語言偵測與 fallback 仍全部使用共用 BC_i18n。
        if (window.BCPartyGamesI18nStrings) {
            window.Liko.__Sys_i18n__.register("BCPG", window.BCPartyGamesI18nStrings);
        }
        if (typeof window.Liko?.__Sys_ChatRoomButtons__?.add !== "function") {
            try { await loadScript(LIKO_BASE + "expand/BC_ChatRoomButtons.js"); } catch (error) { console.warn("[BC PartyGames] chat button helper unavailable", error); }
        }
    }

    function t(key, vars) {
        return window.Liko?.__Sys_i18n__?.t?.("BCPG", key, vars) || key;
    }

    function playerInfo(character = window.Player) {
        return {
            memberNumber: Number(character?.MemberNumber),
            name: String(character?.Nickname || character?.Name || character?.MemberNumber || "Player"),
        };
    }
    function roomPlayers() {
        return Array.isArray(window.ChatRoomCharacter) ? window.ChatRoomCharacter.map(playerInfo).filter(p => Number.isFinite(p.memberNumber)) : [];
    }

    function localMessage(key, vars) {
        const text = String(t(key, vars)).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
        if (typeof ChatRoomSendLocal === "function" && window.CurrentScreen === "ChatRoom") ChatRoomSendLocal(`<b>[PartyGames]</b> ${text}`, 8000);
        else console.log(`[BC PartyGames] ${text}`);
    }

    function notify(key, vars) {
        const known = ["lobbyCreated", "voteCooldown", "notYourTurn", "illegalCard", "chooseColorError", "inviteReceived", "inviteDeclined", "inviteDelivered", "inviteNoResponse", "joinFailed", "mustPlay", "wild4HasColor"];
        if (key === "chooseColor") key = "chooseColorError";
        if (key === "inviteReceived") setTimeout(() => ui?.toggle(true), 0);
        localMessage(known.includes(key) ? key : "genericError", known.includes(key) ? vars : { error: key });
    }

    function action(event, data, state) {
        if (event === "uno") localMessage("genericError", { error: `${data.player}: UNO!` });
        if (event === "winner") {
            const player = state.players.find(p => p.memberNumber === data.winnerId);
            localMessage("winner", { name: player?.name || data.winnerId });
        }
    }

    function makeIcon() {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="16" y="5" width="68" height="90" rx="12" fill="#161616" stroke="#fff" stroke-width="5"/><path d="M22 65L65 12h17L39 88H22z" fill="#e52535"/><circle cx="50" cy="50" r="18" fill="#f5c542"/><text x="50" y="58" text-anchor="middle" font-family="Arial" font-size="23" font-weight="900" fill="#111">UNO</text></svg>`;
        return `data:image/svg+xml,${encodeURIComponent(svg)}`;
    }

    function installChatButton() {
        const helper = window.Liko?.__Sys_ChatRoomButtons__;
        if (!helper?.add) return;
        helper.add("bcpg-chat-button", 25, () => {
            const button = document.createElement("button");
            button.id = "bcpg-chat-button";
            button.type = "button";
            button.title = t("title");
            const image = document.createElement("img"); image.src = makeIcon(); image.alt = "UNO";
            button.appendChild(image);
            button.addEventListener("click", () => ui?.toggle());
            return button;
        }, { plain: true });
    }

    function installCommand() {
        if (typeof CommandCombine !== "function") return;
        const exists = typeof GetCommands === "function" && GetCommands().some(command => command.Tag === "partygames" || command.Tag === "uno");
        if (exists) return;
        CommandCombine([
            { Tag: "partygames", Description: `: ${t("title")}`, Action: () => ui?.toggle(true) },
            { Tag: "uno", Description: `: ${t("title")}`, Action: () => ui?.toggle(true) },
        ]);
    }

    async function initialize() {
        const sdk = await waitFor(() => window.bcModSdk?.registerMod ? window.bcModSdk : null);
        modApi = sdk.registerMod({
            name: "BCPartyGames", fullName: "BC Party Games", version: API.version,
            repository: "https://github.com/awdrrawd/BC-PartyGames",
        }, { allowReplace: false });
        console.log(`[BC PartyGames] v${API.version} loaded`);

        await waitForLogin();
        await waitFor(() => typeof window.ChatRoomMessage === "function");
        await ensureSharedSystems();
        modules.ui.installStyles();
        transport = new modules.transport.Transport(modApi, () => Number(window.Player?.MemberNumber));
        transport.start();
        controller = new modules.controller.Controller({ transport, localPlayer: () => playerInfo(), roomPlayers, notify, action });
        controller.start();
        ui = new modules.ui.GameUI({ controller, t });
        ui.mount();
        ui.installAvatarHooks(modApi);
        installChatButton();
        installCommand();
        renderTimer = setInterval(() => ui?.opened && ui.render(), 500);

        Object.assign(API, {
            loaded: true, loading: false,
            open: () => ui.toggle(true), close: () => ui.toggle(false), toggle: () => ui.toggle(),
            controller, version: API.version, destroy,
        });
        localMessage("loaded");
    }

    function destroy() {
        clearInterval(renderTimer);
        try { window.Liko?.__Sys_ChatRoomButtons__?.remove?.("bcpg-chat-button"); } catch (_) {}
        ui?.destroy(); controller?.destroy(); transport?.stop();
        try { modApi?.unload?.(); } catch (_) {}
        window.Liko.BCPartyGames = {};
    }

    initialize().catch(error => {
        API.loading = false;
        API.error = String(error?.message || error);
        console.error("[BC PartyGames] initialization failed", error);
    });
})(typeof globalThis !== "undefined" ? globalThis : window);
