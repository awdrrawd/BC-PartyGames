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

    function applyDrawPenalty(state, target, amount) {
        const drawn = drawCards(state, target.memberNumber, amount);
        state.lastAction.penalty = { memberNumber: target.memberNumber, requested: amount, count: drawn.length };
    }

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
            if (card.kind === "draw2" || card.kind === "wild4") applyDrawPenalty(state, state.players[nextPlayerIndex(state)], (state.pendingDraw || 0) + (card.kind === "draw2" ? 2 : 4));
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
                applyDrawPenalty(state, target, amount);
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
            const requested = state.pendingDraw;
            const drawn = drawCards(state, id, state.pendingDraw);
            state.pendingDraw = 0; state.pendingDrawKind = null;
            state.lastAction = { type: "draw", memberNumber: id, count: drawn.length, penalty: { memberNumber: id, requested, count: drawn.length } };
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
