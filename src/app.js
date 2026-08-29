(function startBCPartyGames(root) {
    "use strict";
    if (typeof window === "undefined") return;
    window.Liko = window.Liko || {};
    if (window.Liko.BCPartyGames?.loaded || window.Liko.BCPartyGames?.loading) return;

    const API = window.Liko.BCPartyGames = window.Liko.BCPartyGames || {};
    Object.assign(API, { version: "0.2.1", loading: true, loaded: false });
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
        const text = t(key, vars);
        if (typeof ChatRoomSendLocal === "function" && window.CurrentScreen === "ChatRoom") ChatRoomSendLocal(`<b>[PartyGames]</b> ${text}`, 8000);
        else console.log(`[BC PartyGames] ${text}`);
    }

    function notify(key, vars) {
        const known = ["lobbyCreated", "voteCooldown", "notYourTurn", "illegalCard", "chooseColorError", "inviteReceived", "inviteDeclined", "inviteDelivered", "inviteNoResponse"];
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
