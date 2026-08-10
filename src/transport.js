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
