# BC Party Games

Modular multiplayer party games for Bondage Club. The first included game is classic UNO.

## Current features

- One installable userscript, built from modular source files.
- 2–10 player classic 108-card UNO.
- Room lobby, join/start flow, host-authoritative actions, full-state synchronization.
- Visible card counts for every player; only the local hand is rendered face-up.
- Automatic UNO announcement when a player reaches one card.
- 60-second reconnect window and deterministic host takeover.
- Voluntary host transfer.
- One-minute restart/end votes with strict majority and per-proposer five-minute cooldown.
- Shared Liko `BC_i18n` engine with Traditional Chinese, Simplified Chinese, and English placeholders.
- Canvas-rendered cards with a replaceable rendering layer.

## Build and test

```text
npm run build
npm run check
```

The installable result is `dist/BC-PartyGames.user.js`.

For local development, set these page globals before loading the userscript:

- `window.BCPartyGamesDevBase`: URL root of this repository.
- `window.LikoDevBase`: URL root of the `liko-Plugin-Repository/Plugins/` directory.

## Structure

- `src/core.js`: pure UNO deck and rules.
- `src/transport.js`: BC Hidden-message protocol.
- `src/controller.js`: lobby, authority, reconnect, host transfer, and voting.
- `src/ui.js`: Canvas table and controls.
- `src/main.js`: BC integration and shared-system loading.
- `Translation/PartyGames-i18n.js`: shared i18n namespace strings.
