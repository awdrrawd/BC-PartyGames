import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
for (const fails of [false, true]) {
    test(`initialization ${fails ? "survives a CRB failure" : "uses the CRB object API"}`, async () => {
        let spec, opened = 0;
        const commands = [], warnings = [], errors = [], timers = new Set();
        const context = vm.createContext({
            console: { log() {}, warn: (...args) => warnings.push(args), error: (...args) => errors.push(args) },
            setInterval(fn, ms) { const timer = setInterval(fn, ms); timers.add(timer); return timer; },
            clearInterval(timer) { clearInterval(timer); timers.delete(timer); },
            Player: { MemberNumber: 1, Name: "Alice" }, ChatRoomCharacter: [], ChatRoomMessage() {},
            CommandCombine: entries => commands.push(...entries), GetCommands: () => commands,
            bcModSdk: { registerMod: () => ({ unload() {} }) },
            Liko: {
                __Sys_i18n__: { ensure() {}, t: (_, key) => key },
                __Sys_ChatRoomButtons__: {
                    add(input) {
                        assert.equal(typeof input, "object");
                        assert.equal(input.id, "bcpg-chat-button");
                        assert.equal(input.order, 25);
                        assert.ok(input.icon.src.startsWith("data:image/svg+xml,"));
                        spec = input;
                        if (fails) throw new Error("CRB unavailable");
                    }, remove() {},
                },
            },
            BCPartyGamesModules: {
                transport: { Transport: class { start() {} stop() {} } },
                controller: { Controller: class { start() {} destroy() {} } },
                ui: { installStyles() {}, GameUI: class { mount() {} installAvatarHooks() {} toggle() { opened++; } destroy() {} } },
            },
        });
        context.window = context;
        try {
            vm.runInContext(source, context);
            const deadline = Date.now() + 2000;
            while (!context.Liko.BCPartyGames.loaded && !errors.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
            assert.equal(context.Liko.BCPartyGames.loaded, true);
            assert.equal(errors.length, 0);
            commands.find(c => c.Tag === "partygames").Action();
            assert.equal(opened, 1);
            if (!fails) { spec.onClick(); assert.equal(opened, 2); }
            else assert.equal(warnings.length, 1);
            context.Liko.BCPartyGames.destroy();
        } finally { for (const timer of timers) clearInterval(timer); }
    });
}
