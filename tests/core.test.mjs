import assert from "node:assert/strict";
import test from "node:test";
import "../src/core.js";

const core = globalThis.BCPartyGamesModules.core;
const players = [
  { memberNumber: 1, name: "A" },
  { memberNumber: 2, name: "B" },
  { memberNumber: 3, name: "C" },
];

function fixture(rules = {}) {
  const state = core.createGame({ hostId: 1, players, rules });
  state.turnIndex = 0; state.direction = 1; state.activeColor = "red";
  state.discardPile = [{ id: "top", color: "red", kind: "number", value: 5 }];
  state.hands["1"] = [{ id: "draw2", color: "red", kind: "draw2" }, { id: "spare", color: "blue", kind: "number", value: 8 }];
  return state;
}

test("same-type stacking accumulates penalties and blocks ordinary cards", () => {
  const state = fixture({ stacking: true });
  state.hands["2"] = [{ id: "stack", color: "blue", kind: "draw2" }, { id: "other", color: "red", kind: "number", value: 5 }];
  core.playCard(state, 1, "draw2");
  assert.equal(state.pendingDraw, 2);
  assert.equal(core.canPlayCard(state.hands["2"][1], state), false);
  assert.equal(core.playCard(state, 2, "stack").ok, true);
  assert.equal(state.pendingDraw, 4);
  const count = state.hands["3"].length;
  core.drawForTurn(state, 3);
  assert.equal(state.hands["3"].length, count + 4);
  assert.equal(state.pendingDraw, 0); assert.equal(state.turnIndex, 0);
});

test("draw until playable stops on a legal card and limits play to it", () => {
  const state = fixture({ drawUntilPlayable: true });
  state.drawPile = [{ id: "legal", color: "red", kind: "number", value: 3 }, { id: "bad", color: "green", kind: "number", value: 7 }];
  const result = core.drawForTurn(state, 1);
  assert.equal(result.playable, true); assert.equal(state.lastAction.count, 2);
  assert.equal(core.playCard(state, 1, "draw2").error, "onlyDrawnCard");
  assert.equal(core.playCard(state, 1, "legal").ok, true);
});

test("must-play rule rejects drawing but permits timeout recovery", () => {
  const state = fixture({ forcePlay: true });
  assert.equal(core.drawForTurn(state, 1).error, "mustPlay");
  assert.equal(core.drawForTurn(state, 1, { timeout: true }).ok, true);
});

test("strict wild four rejects a matching color without mutating the hand", () => {
  const state = fixture({ strictWildFour: true });
  state.hands["1"].push({ id: "four", color: "wild", kind: "wild4" });
  assert.equal(core.playCard(state, 1, "four", "blue").error, "wild4HasColor");
  assert.equal(state.hands["1"].length, 3);
});

test("empty deck ends the turn instead of locking the game", () => {
  const state = fixture(); state.drawPile = [];
  assert.equal(core.drawForTurn(state, 1).ok, true);
  assert.equal(state.turnIndex, 1);
});

test("winning with a draw card applies the final penalty", () => {
  const state = fixture({ stacking: true });
  state.hands["1"] = [state.hands["1"][0]];
  state.pendingDraw = 4; state.pendingDrawKind = "draw2";
  const count = state.hands["2"].length;
  assert.equal(core.playCard(state, 1, "draw2").won, true);
  assert.equal(state.hands["2"].length, count + 6);
  assert.equal(state.pendingDraw, 0);
});

test("removing the final player terminates without an infinite loop", () => {
  const state = fixture();
  for (const player of players) core.removePlayer(state, player.memberNumber);
  assert.equal(state.phase, "finished"); assert.equal(state.winnerId, null);
  assert.equal(core.nextPlayerIndex(state), -1);
});

test("rule normalization bounds dealing and disables unimplemented variants", () => {
  const rules = core.normalizeRules({ startingHandSize: Infinity, turnSeconds: -3, stacking: "false", jumpIn: true });
  assert.equal(rules.startingHandSize, 7); assert.equal(rules.turnSeconds, 15);
  assert.equal(rules.stacking, false); assert.equal(rules.jumpIn, false);
  assert.throws(() => core.createGame({ hostId: 1, players: [players[0], players[0]] }));
});

test("classic UNO deck has 108 unique cards", () => {
  const deck = core.createDeck();
  assert.equal(deck.length, 108);
  assert.equal(new Set(deck.map(card => card.id)).size, 108);
});

test("new game deals seven cards and exposes hand counts", () => {
  const state = core.createGame({ hostId: 1, players, random: () => 0.42 });
  assert.deepEqual(Object.values(state.hands).map(hand => hand.length), [7, 7, 7]);
  assert.equal(state.discardPile.length, 1);
  const view = core.publicView(state, 2);
  assert.deepEqual(view.handCounts, { 1: 7, 2: 7, 3: 7 });
  assert.deepEqual(Object.keys(view.hands), ["2"]);
});

test("a number matches by color or value", () => {
  const state = core.createGame({ hostId: 1, players: players.slice(0, 2), random: () => 0.37 });
  state.phase = "playing";
  state.activeColor = "red";
  state.discardPile = [{ id: "top", color: "red", kind: "number", value: 5 }];
  assert.equal(core.canPlayCard({ color: "red", kind: "number", value: 8 }, state), true);
  assert.equal(core.canPlayCard({ color: "blue", kind: "number", value: 5 }, state), true);
  assert.equal(core.canPlayCard({ color: "blue", kind: "number", value: 8 }, state), false);
  assert.equal(core.canPlayCard({ color: "wild", kind: "wild", value: null }, state), true);
});

test("player with no cards wins", () => {
  const state = core.createGame({ hostId: 1, players: players.slice(0, 2), random: () => 0.23 });
  state.turnIndex = 0;
  state.activeColor = "red";
  state.discardPile = [{ id: "top", color: "red", kind: "number", value: 2 }];
  state.hands["1"] = [{ id: "last", color: "red", kind: "number", value: 9 }];
  const result = core.playCard(state, 1, "last");
  assert.equal(result.ok, true);
  assert.equal(result.won, true);
  assert.equal(state.winnerId, 1);
  assert.equal(state.phase, "finished");
});
