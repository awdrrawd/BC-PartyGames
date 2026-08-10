import assert from "node:assert/strict";
import test from "node:test";
import "../src/core.js";

const core = globalThis.BCPartyGamesModules.core;
const players = [
  { memberNumber: 1, name: "A" },
  { memberNumber: 2, name: "B" },
  { memberNumber: 3, name: "C" },
];

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
