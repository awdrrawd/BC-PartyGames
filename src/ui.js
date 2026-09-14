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
                ? 680
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
            gradient.addColorStop(0, "#202a35"); gradient.addColorStop(1, "#080e17");
            ctx.fillStyle = gradient; ctx.fillRect(0, 0, w, h);
            ctx.strokeStyle = "rgba(255,255,255,.025)"; ctx.lineWidth = 1;
            for (let x = 0; x < w; x += 44) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
            ctx.save();
            ctx.shadowColor = "#000b"; ctx.shadowBlur = 28; ctx.shadowOffsetY = 14;
            this.roundRect(ctx, 38, 112, w - 76, 382, 180, "#202329", "#665640");
            ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
            const felt = ctx.createRadialGradient(w / 2, 280, 10, w / 2, 280, w / 2);
            felt.addColorStop(0, "#206457"); felt.addColorStop(1, "#0b342e");
            this.roundRect(ctx, 53, 127, w - 106, 352, 165, felt, "#b19a65");
            ctx.setLineDash([3, 6]); ctx.strokeStyle = "#d3c49a38"; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.roundRect(68, 142, w - 136, 322, 150); ctx.stroke();
            ctx.setLineDash([]); ctx.textAlign = "center"; ctx.fillStyle = "#cbd6c91c"; ctx.font = "700 20px sans-serif";
            ctx.fillText("P A R T Y   G A M E S", w / 2, 283);
            ctx.restore();
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
            const columns = Math.min(5, opponents.length);
            const spacing = (w - 100) / Math.max(1, columns);
            opponents.forEach((player, i) => {
                const row = Math.floor(i / columns), rowCount = Math.min(columns, opponents.length - row * columns);
                const x = w / 2 + ((i % columns) - (rowCount - 1) / 2) * spacing, y = (opponents.length > 5 ? 105 : 147) + row * 88;
                const seatW = Math.min(176, spacing - 10);
                const isActive = player.memberNumber === active?.memberNumber && state.phase === "playing";
                this.roundRect(ctx, x - seatW / 2, y - 12, seatW, 72, 14, isActive ? "#264a43" : "#131e29", isActive ? "#f3d48b" : "#47525b");
                this.avatarUrl(player);
                const avatar = this.avatarImages.get(player.memberNumber);
                const ax = x - seatW / 2 + 27;
                ctx.save(); ctx.beginPath(); ctx.arc(ax, y + 21, 19, 0, Math.PI * 2); ctx.clip();
                ctx.fillStyle = "#344c60"; ctx.fillRect(ax - 19, y + 2, 38, 38);
                if (avatar) ctx.drawImage(avatar, ax - 19, y + 2, 38, 38);
                else { ctx.fillStyle = "#fff"; ctx.font = "18px sans-serif"; ctx.fillText(Array.from(player.name || "?")[0], ax, y + 27); }
                ctx.restore();
                const count = state.hands[String(player.memberNumber)]?.length || 0;
                ctx.fillStyle = player.status === "disconnected" ? "#ffadad" : player.status === "lost" ? "#999" : "#fff";
                ctx.font = "600 13px sans-serif";
                let name = player.name;
                while (name.length > 1 && ctx.measureText(name).width > seatW - 70) name = name.slice(0, -1);
                ctx.textAlign = "left";
                ctx.fillText(`${name}${name !== player.name ? "…" : ""}`, ax + 27, y + 13, seatW - 60);
                ctx.fillStyle = count === 1 ? "#ffe098" : "#a8bcbd";
                ctx.fillText(`${this.t("cardsCount", { count })}${count === 1 ? " · UNO" : ""}`, ax + 27, y + 34, seatW - 60);
                if (isActive) { ctx.fillStyle = "#edca7a"; ctx.fillRect(x - seatW / 2 + 12, y + 52, seatW - 24, 2); }
                ctx.textAlign = "center";
                if (player.memberNumber === state.hostId) { ctx.fillStyle = "#f7c948"; ctx.fillText("★", ax - 16, y - 4); }
            });

            const top = state.discardPile[state.discardPile.length - 1];
            const centerY = 298, deckX = w / 2 - 130, discardX = w / 2 + 32;
            this.drawDeck(ctx, deckX, centerY, 96, 140, state.drawPile.length);
            this.drawCard(ctx, top, discardX, centerY, 96, 140, false);
            ctx.fillStyle = CARD_COLORS[state.activeColor] || "#fff";
            ctx.beginPath(); ctx.arc(discardX + 120, centerY + 70, 16, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = "#fff"; ctx.stroke();
            ctx.fillStyle = "#fff"; ctx.font = "14px sans-serif"; ctx.textAlign = "center";
            ctx.fillText(this.t("color_" + state.activeColor), discardX + 120, centerY + 104);
            if (state.pendingDraw) ctx.fillText(this.t("pendingDraw", { count: state.pendingDraw }), w / 2, centerY - 10);
            const penalty = state.lastAction?.penalty;
            if (penalty) {
                const target = state.players.find(p => p.memberNumber === penalty.memberNumber);
                this.roundRect(ctx, w / 2 - 245, 481, 490, 32, 16, "#3a2d1c", "#af9157");
                ctx.fillStyle = "#ffe3a4"; ctx.font = "600 14px sans-serif";
                ctx.fillText(this.t("penaltyApplied", { name: target?.name || penalty.memberNumber, count: penalty.count }), w / 2, 502, 466);
            }
            if (state.phase === "playing" && active?.memberNumber === localId && !state.drawnThisTurn) {
                ctx.fillStyle = "#fff"; ctx.font = "700 15px sans-serif"; ctx.textAlign = "center";
                ctx.fillText(state.pendingDraw ? this.t("takePenalty", { count: state.pendingDraw }) : this.t("clickToDraw"), deckX + 48, centerY + 162);
                this.hitWelcomeActions.push({ x: deckX - 8, y: centerY - 8, w: 112, h: 178, action: "draw" });
            }

            const hand = state.hands[String(localId)] || [];
            this.roundRect(ctx, 22, h - 148, w - 44, 140, 18, "#101923", "#344047");
            ctx.textAlign = "left"; ctx.fillStyle = "#c8baa0"; ctx.font = "600 12px sans-serif";
            ctx.fillText(this.t("yourHand", { count: hand.length }), 34, h - 157);
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
            else if (card.kind === "wild") this.drawWildSymbol(ctx, x + w / 2, y + h / 2, w * .29);
            else ctx.fillText(label, x + w / 2, y + h / 2);
            ctx.shadowBlur = 0; ctx.fillStyle = card.color === "yellow" ? "#273139" : "#fff";
            ctx.font = `800 ${Math.round(w * .19)}px sans-serif`; ctx.textAlign = "left";
            const corner = card.kind === "wild" ? "◆" : label;
            ctx.fillText(corner, x + 10, y + 17);
            ctx.translate(x + w - 10, y + h - 17); ctx.rotate(Math.PI); ctx.fillText(corner, 0, 0);
            ctx.restore();
        }

        drawWildSymbol(ctx, cx, cy, radius) {
            ctx.save(); ctx.translate(cx, cy); ctx.rotate(-Math.PI / 7);
            core.COLORS.forEach((color, i) => {
                const start = i * Math.PI / 2;
                ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, radius, start, start + Math.PI / 2); ctx.closePath();
                ctx.fillStyle = CARD_COLORS[color]; ctx.fill(); ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke();
            });
            ctx.restore();
        }

        drawDrawCardSymbol(ctx, card, x, y, w, h) {
            const colors = card.kind === "wild4" ? ["red", "yellow", "green", "blue"] : [card.color, card.color];
            colors.forEach((color, i) => {
                ctx.save(); ctx.translate(x + w * .5 + (i - (colors.length - 1) / 2) * w * .12, y + h * .46);
                ctx.rotate((i - (colors.length - 1) / 2) * .2);
                ctx.shadowColor = "#0008"; ctx.shadowBlur = 3;
                this.roundRect(ctx, -w * .12, -h * .17, w * .24, h * .34, 3, CARD_COLORS[color], "#fff");
                ctx.restore();
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
            const state = this.controller.state;
            const card = state?.hands[String(this.controller.localId)]?.find(c => c.id === this.pendingWildCardId);
            ctx.font = "15px sans-serif";
            ctx.fillText(this.t(card?.kind === "wild4" ? (state.rules.stacking ? "wildFourStackHint" : "wildFourHint") : "wildHint"), cx, cy + radius + 35, this.width - 60);
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
                if (myTurn && !state.drawnThisTurn) buttons.push(["draw", state.pendingDraw ? "takePenalty" : "drawCard"]);
                if (myTurn && state.drawnThisTurn) buttons.push(["pass", "pass"]);
                if (state.phase === "finished") { buttons.push(["vote-restart", "voteRestart", !!state.vote]); buttons.push(["leave", "leave"]); }
                if (state.vote && state.vote.votes[String(localId)] == null) {
                    buttons.push(["vote-yes", "yes"]); buttons.push(["vote-no", "no"]);
                }
            }
            buttons.push(["close", "close"]);
            const markup = buttons.map(([act, key, disabled]) => `<button data-act="${act}" ${disabled ? "disabled" : ""}>${escapeHtml(this.t(key, { count: state?.pendingDraw || 0 }))}</button>`).join("");
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
            if (act === "refresh") return this.controller.transport.send("HELLO", { version: "0.3.1", name: this.controller.localPlayer().name });
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
