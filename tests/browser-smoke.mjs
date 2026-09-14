// Run with PLAYWRIGHT_MODULE pointing to an installed playwright package if needed.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "@playwright/test");
const browser = await chromium.launch({ channel: "msedge", headless: true });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = []; page.on("pageerror", error => errors.push(error.message));
try {
    await page.setContent('<html><head><meta charset="utf-8"></head><body style="margin:0;background:#d6dbe1"><button id="opener">Open</button></body></html>');
    for (const file of ["src/core.js", "src/controller.js", "src/ui.js", "Translation/PartyGames-i18n.js"]) await page.addScriptTag({ path: path.join(root, file) });
    await page.evaluate(() => {
        const players = Array.from({ length: 10 }, (_, i) => ({ memberNumber: i + 1, name: ["Alice", "小夜", "夏日微風", "Luna", "Mika", "星空", "A very long player name", "安安", "Yuki", "Rin"][i] }));
        const t = (key, vars = {}) => Object.entries(vars).reduce((s, [k,v]) => s.replaceAll(`{${k}}`, v), BCPartyGamesI18nStrings[key]?.TW || key);
        window.demo = new BCPartyGamesModules.controller.Controller({ transport: { send() {} }, localPlayer: () => players[0], roomPlayers: () => players });
        players.slice(1).forEach(p => demo.rememberPeer(p.memberNumber, p));
        BCPartyGamesModules.ui.installStyles();
        window.ui = new BCPartyGamesModules.ui.GameUI({ controller: demo, t }); ui.mount(); ui.toggle(true);
    });
    assert.equal(await page.locator('.bcpg-player').count(), 9);
    await page.evaluate(async () => {
        const cv = document.createElement("canvas"); cv.width = 500; cv.height = 1000;
        cv.getContext("2d").fillRect(0, 0, 500, 1000);
        window.ChatRoomCharacter = [{ MemberNumber: 2, Canvas: cv }, { MemberNumber: 3, Canvas: cv, MustDraw: true }];
        window.Liko = {};
        window.avatarHooks = new Map();
        for (const name of ["ChatRoomSyncSingle", "ChatRoomSyncItem", "ChatRoomSyncExpression", "ChatRoomSyncPose", "CharacterLoadCanvas"]) window[name] = () => {};
        ui.installAvatarHooks({ hookFunction(name, priority, hook) { avatarHooks.set(name, hook); return () => avatarHooks.delete(name); } });
        ui.avatarDirty.clear(); ui.lobbyMarkup = ""; ui.render();
    });
    await page.waitForFunction(() => ui.avatars.get(2)?.startsWith("data:image/"));
    assert.equal(await page.evaluate(() => ui.avatars.get(3)), "");
    assert.equal(await page.evaluate(() => ui.captureFace(ChatRoomCharacter[0]).startsWith("data:image/")), true);
    await page.evaluate(() => { avatarHooks.get("CharacterLoadCanvas")([ChatRoomCharacter[1]], args => { args[0].MustDraw = false; }); });
    assert.equal(await page.evaluate(() => ui.avatars.get(3)?.startsWith("data:image/")), true);
    assert.equal(await page.evaluate(() => {
        const before = ui.avatars.get(2);
        ChatRoomCharacter[0].Canvas.getContext("2d").clearRect(0, 0, 500, 1000);
        ui.render();
        if (before !== ui.avatars.get(2)) return false;
        avatarHooks.get("ChatRoomSyncItem")([{ Source: 3, Item: { Target: 2 } }], () => {});
        ui.render();
        return before !== ui.avatars.get(2);
    }), true);
    await page.evaluate(() => { ChatRoomCharacter = []; ui.render(); });
    assert.equal(await page.evaluate(() => ui.avatars.size), 0);
    await page.screenshot({ path: path.join(root, "tests/ui-welcome.png") });
    await page.locator('[data-act="create"]').click();
    await page.locator('[data-member="2"]').click();
    assert.equal(await page.locator('[data-member="2"]').isDisabled(), true);
    await page.evaluate(() => {
        demo.lobby.players = demo.roomPlayers().map(p => ({ ...p, ready: true })); demo.changed();
        ui.lounge.scrollTop = 0;
    });
    await page.screenshot({ path: path.join(root, "tests/ui-lobby.png") });
    await page.locator('[data-rule="startingHandSize"]').selectOption("9");
    assert.equal(await page.locator('[data-act="start"]').isDisabled(), true);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { ui.lounge.scrollTop = 0; });
    await page.screenshot({ path: path.join(root, "tests/ui-mobile.png") });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => { demo.lobby.players.forEach(p => p.ready = true); demo.startGame(); });
    await page.screenshot({ path: path.join(root, "tests/ui-game.png") });
    await page.evaluate(() => {
        demo.state.phase = "finished"; demo.state.winnerId = 1; demo.changed();
    });
    assert.equal(await page.locator('[data-act="vote-restart"]').count(), 1);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator('#bcpg-overlay').isVisible(), false);
    assert.deepEqual(errors, []);
    await page.evaluate(() => ui.destroy());
    assert.equal(await page.evaluate(() => avatarHooks.size), 0);
    console.log("Browser smoke passed: 10-player lobby, invitation, readiness, rules, mobile overflow, game, finish, Escape; no page errors.");
} finally { await browser.close(); }
