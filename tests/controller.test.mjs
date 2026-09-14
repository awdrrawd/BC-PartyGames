import assert from "node:assert/strict";
import test from "node:test";
import "../src/core.js";
import "../src/controller.js";

const { core, controller: { Controller } } = globalThis.BCPartyGamesModules;
const players = [1, 2, 3].map(memberNumber => ({ memberNumber, name: `Player ${memberNumber}` }));
function setup(id = 1) {
    const sent = [], notices = [];
    const controller = new Controller({ transport: { send: (type, payload, target) => sent.push({ type, ...structuredClone(payload), target }) }, localPlayer: () => players[id - 1], roomPlayers: () => players, notify: (...args) => notices.push(args) });
    return { controller, sent, notices };
}
function lobby() {
    const host = setup(), guest = setup(2);
    host.controller.rememberPeer(2, { name: "Guest" });
    host.controller.invite(2);
    const invite = host.sent.find(p => p.type === "INVITE");
    guest.controller.handle({ ...invite, from: 1 });
    guest.controller.acceptInvite();
    host.controller.handle({ ...guest.sent.find(p => p.type === "LOBBY_JOIN"), from: 2 });
    guest.controller.handle({ ...host.sent.findLast(p => p.type === "LOBBY_STATE"), from: 1 });
    return { host, guest };
}

test("invitation joins the matching table and requires readiness", () => {
    const { host, guest } = lobby();
    assert.equal(guest.controller.joining, null);
    assert.equal(guest.controller.lobby.players.length, 2);
    host.controller.startGame();
    assert.equal(host.controller.state, null);
    guest.controller.setReady(true);
    host.controller.handle({ ...guest.sent.at(-1), from: 2 });
    host.controller.startGame();
    guest.controller.handle({ ...host.sent.at(-1), from: 1 });
    assert.equal(guest.controller.state.gameId, host.controller.state.gameId);
});

test("invites retry in the lobby and expire after acknowledgment", () => {
    const { controller: c, sent } = setup();
    c.rememberPeer(2, {}); c.invite(2);
    const invitation = c.outgoingInvites.get(2);
    invitation.sentAt -= 2100; c.tick();
    assert.equal(sent.filter(p => p.type === "INVITE").length, 2);
    invitation.acknowledged = true; invitation.expiresAt = Date.now() - 1; c.tick();
    assert.equal(c.outgoingInvites.size, 0);
    assert.deepEqual(c.lobby.invited, []);
});

test("duplicate invite does not reopen a declined invitation", () => {
    const { controller: c, notices } = setup(2);
    const packet = { type: "INVITE", from: 1, hostId: 1, game: "uno", lobbyId: "a" };
    c.handle(packet); c.declineInvite(); c.handle(packet);
    assert.equal(c.pendingInvite, null);
    assert.equal(notices.length, 1);
});

test("join retries are idempotent and unsolicited joins are rejected", () => {
    const { host, guest } = lobby();
    const packet = guest.sent.find(p => p.type === "LOBBY_JOIN");
    host.controller.handle({ ...packet, from: 2 });
    host.controller.handle({ ...packet, from: 3 });
    assert.equal(host.controller.lobby.players.length, 2);
    assert.equal(host.sent.at(-1).type, "LOBBY_STATE");
});

test("rule changes reset guest readiness and normalize values", () => {
    const { host } = lobby();
    host.controller.lobby.players[1].ready = true;
    host.controller.updateRules({ startingHandSize: 999, stacking: true });
    assert.equal(host.controller.lobby.rules.startingHandSize, 9);
    assert.equal(host.controller.lobby.players[1].ready, false);
});

test("uninvited state and unrelated lobby cannot hijack the client", () => {
    const { controller: c } = setup(2);
    const state = core.createGame({ hostId: 1, players });
    c.handle({ type: "STATE", from: 1, state });
    c.handle({ type: "LOBBY_STATE", from: 1, lobby: { hostId: 1, players } });
    assert.equal(c.state, null); assert.equal(c.lobby, null);
});

test("a delayed ready packet cannot approve changed rules", () => {
    const { host, guest } = lobby();
    guest.controller.setReady(true);
    const packet = guest.sent.at(-1);
    host.controller.updateRules({ stacking: true });
    host.controller.handle({ ...packet, from: 2 });
    assert.equal(host.controller.lobby.players[1].ready, false);
});

test("restart replaces the game on both participants", () => {
    const { host, guest } = lobby();
    host.controller.lobby.players[1].ready = true; host.controller.startGame();
    guest.controller.handle({ ...host.sent.at(-1), from: 1 });
    const oldId = guest.controller.state.gameId;
    host.controller.hostStartVote(1, "restart");
    host.controller.hostCastVote(2, true);
    guest.controller.handle({ ...host.sent.at(-1), from: 1 });
    assert.notEqual(guest.controller.state.gameId, oldId);
    assert.equal(guest.controller.state.gameId, host.controller.state.gameId);
});

test("timeout ends a turn when a drawn playable card is pending", () => {
    const { controller: c } = setup();
    c.state = core.createGame({ hostId: 1, players });
    c.state.turnIndex = 0; c.state.drawnThisTurn = true;
    c.state.playableDrawnCardId = "pending"; c.state.turnStartedAt = Date.now() - 200000;
    c.tick();
    assert.notEqual(c.state.turnIndex, 0);
    assert.equal(c.state.drawnThisTurn, false);
});

test("outsiders cannot start votes or forge a host transfer", () => {
    const { controller: c } = setup();
    c.state = core.createGame({ hostId: 1, players: players.slice(0, 2) });
    c.hostStartVote(3, "end"); assert.equal(c.state.vote, null);
    c.handle({ type: "HOST_TRANSFER_COMMIT", from: 3, gameId: c.state.gameId, hostId: 3, hostEpoch: 2, state: { ...c.state, hostId: 3, hostEpoch: 2 } });
    assert.equal(c.state.hostId, 1);
});

test("leaving a game clears local state and permits a new lobby", () => {
    const { controller: c } = setup(2);
    c.state = core.createGame({ hostId: 1, players });
    c.leave(); assert.equal(c.state, null);
    c.createLobby(); assert.equal(c.lobby.hostId, 2);
});
