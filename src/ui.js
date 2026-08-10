(function registerPartyGamesUi(root, factory) {
    const modules = root.BCPartyGamesModules = root.BCPartyGamesModules || {};
    if (!modules.ui) modules.ui = factory(modules.core);
})(typeof globalThis !== "undefined" ? globalThis : window, function partyGamesUiFactory(core) {
    "use strict";

    const CARD_COLORS = { red: "#d72638", yellow: "#f7c948", green: "#159447", blue: "#1769c2", wild: "#181818" };
    const SYMBOLS = { skip: "⊘", reverse: "↻", draw2: "+2", wild: "W", wild4: "+4" };

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
            this.unsubscribe = controller.onChange(() => this.resize());
            this.resizeHandler = () => this.resize();
        }

        mount() {
            if (this.root) return;
            const root = document.createElement("div");
            root.id = "bcpg-overlay";
            root.innerHTML = `<div class="bcpg-window"><div class="bcpg-title"><span>${this.t("title")}</span><button data-act="close">×</button></div><canvas></canvas><div class="bcpg-toolbar"></div></div>`;
            document.body.appendChild(root);
            this.root = root;
            this.canvas = root.querySelector("canvas");
            this.ctx = this.canvas.getContext("2d");
            this.toolbar = root.querySelector(".bcpg-toolbar");
            root.addEventListener("click", event => this.click(event));
            this.canvas.addEventListener("click", event => this.canvasClick(event));
            window.addEventListener("resize", this.resizeHandler);
            this.resize();
        }

        toggle(force) {
            this.mount();
            this.opened = force == null ? !this.opened : !!force;
            this.root.classList.toggle("open", this.opened);
            if (this.opened) this.render();
        }

        resize() {
            if (!this.canvas) return;
            const viewport = window.visualViewport;
            const viewportWidth = viewport?.width || window.innerWidth;
            const viewportHeight = viewport?.height || window.innerHeight;
            const fullTable = !!this.controller.state;
            const width = fullTable
                ? Math.min(1080, Math.max(620, viewportWidth - 70))
                : Math.min(680, Math.max(420, viewportWidth - 100));
            const height = fullTable
                ? Math.min(width / 2, Math.max(300, viewportHeight - 160))
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
            const snap = this.controller.snapshot();
            this.hitCards = [];
            this.hitPeers = [];
            this.hitWelcomeActions = [];
            this.drawTable();
            if (snap.state) this.drawGame(snap);
            else if (snap.lobby) this.drawLobby(snap);
            else this.drawWelcome(snap);
            this.renderToolbar(snap);
        }

        drawTable() {
            const ctx = this.ctx, w = this.width, h = this.height;
            const gradient = ctx.createRadialGradient(w / 2, h / 2, 40, w / 2, h / 2, Math.max(w, h));
            gradient.addColorStop(0, "#176b48"); gradient.addColorStop(1, "#073623");
            ctx.fillStyle = gradient; ctx.fillRect(0, 0, w, h);
            ctx.strokeStyle = "rgba(255,255,255,.08)"; ctx.lineWidth = 2;
            for (let x = 0; x < w; x += 44) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
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
            const spacing = w / Math.max(1, opponents.length);
            opponents.forEach((player, i) => {
                const x = spacing * i + spacing / 2, y = 105;
                const count = state.hands[String(player.memberNumber)]?.length || 0;
                ctx.fillStyle = player.status === "disconnected" ? "#ffadad" : player.status === "lost" ? "#999" : "#fff";
                ctx.font = "600 17px sans-serif";
                ctx.fillText(`${player.name} · ${this.t("cardsCount", { count })}`, x, y);
                if (player.memberNumber === state.hostId) { ctx.fillStyle = "#f7c948"; ctx.fillText("★", x, y + 24); }
                this.drawBacks(x, y + 36, Math.min(count, 12));
            });

            const top = state.discardPile[state.discardPile.length - 1];
            const centerY = h / 2 - 70, deckX = w / 2 - 132, discardX = w / 2 + 36;
            this.drawDeck(ctx, deckX, centerY, 96, 140, state.drawPile.length);
            this.drawCard(ctx, top, discardX, centerY, 96, 140, false);
            ctx.fillStyle = CARD_COLORS[state.activeColor] || "#fff";
            ctx.beginPath(); ctx.arc(discardX + 120, centerY + 70, 16, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = "#fff"; ctx.stroke();
            if (state.phase === "playing" && active?.memberNumber === localId && !state.drawnThisTurn) {
                ctx.fillStyle = "#fff"; ctx.font = "700 15px sans-serif"; ctx.textAlign = "center";
                ctx.fillText(this.t("clickToDraw"), deckX + 48, centerY + 162);
                this.hitWelcomeActions.push({ x: deckX - 8, y: centerY - 8, w: 112, h: 178, action: "draw" });
            }

            const hand = state.hands[String(localId)] || [];
            const cardW = 82, cardH = 120;
            const available = w - 70;
            const step = hand.length <= 1 ? cardW : Math.min(cardW + 8, (available - cardW) / (hand.length - 1));
            const total = cardW + Math.max(0, hand.length - 1) * step;
            const start = (w - total) / 2;
            hand.forEach((card, i) => {
                const x = start + i * step, y = h - cardH - 18;
                const playable = active?.memberNumber === localId && core.canPlayCard(card, state)
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
            else ctx.fillText(label, x + w / 2, y + h / 2);
            ctx.restore();
        }

        drawDrawCardSymbol(ctx, card, x, y, w, h) {
            const colors = card.kind === "wild4" ? ["red", "yellow", "green", "blue"] : [card.color, card.color];
            colors.forEach((color, i) => {
                const cols = colors.length === 4 ? 2 : 2, row = colors.length === 4 ? Math.floor(i / 2) : 0, col = i % cols;
                this.roundRect(ctx, x + w * .28 + col * w * .22, y + h * .28 + row * h * .14, w * .2, h * .28, 3, CARD_COLORS[color], "#fff");
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

        renderToolbar({ lobby, state, localId, isHost, peers, pendingInvite }) {
            const buttons = [];
            if (!lobby && !state) {
                if (pendingInvite) { buttons.push(["invite-accept", "acceptInvite"]); buttons.push(["invite-decline", "declineInvite"]); }
                else if (peers.length) buttons.push(["invite", "invitePlayer"]);
                else buttons.push(["refresh", "refreshPlayers"]);
            }
            if (lobby) {
                if (!lobby.players.some(p => p.memberNumber === localId)) buttons.push(["join", "joinLobby"]);
                if (isHost) buttons.push(["start", "startGame", lobby.players.length < 2]);
                buttons.push(["leave", "leave"]);
            }
            if (state) {
                const myTurn = state.phase === "playing" && core.currentPlayer(state)?.memberNumber === localId;
                if (myTurn && state.drawnThisTurn) buttons.push(["pass", "pass"]);
                if (state.vote && state.vote.votes[String(localId)] == null) {
                    buttons.push(["vote-yes", "yes"]); buttons.push(["vote-no", "no"]);
                }
            }
            buttons.push(["close", "close"]);
            this.toolbar.innerHTML = buttons.map(([act, key, disabled]) => `<button data-act="${act}" ${disabled ? "disabled" : ""}>${this.t(key)}</button>`).join("");
        }

        click(event) {
            const act = event.target.closest("[data-act]")?.dataset.act;
            if (!act) return;
            if (act === "close") return this.toggle(false);
            if (act === "invite") return this.chooseInvitee();
            if (act === "invite-accept") return this.controller.acceptInvite();
            if (act === "invite-decline") return this.controller.declineInvite();
            if (act === "refresh") return this.controller.transport.send("HELLO", { version: "0.2.1", name: this.controller.localPlayer().name });
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
            const welcomeAction = this.hitWelcomeActions.find(hit => x >= hit.x && x <= hit.x + hit.w && y >= hit.y && y <= hit.y + hit.h);
            if (welcomeAction?.action === "invite-accept") return this.controller.acceptInvite();
            if (welcomeAction?.action === "invite-decline") return this.controller.declineInvite();
            if (welcomeAction?.action === "draw") return this.controller.requestDraw();
            if (welcomeAction?.action === "settings") { this.settingsOpen = !this.settingsOpen; return this.render(); }
            if (welcomeAction?.action === "vote-restart") return this.controller.startVote("restart");
            if (welcomeAction?.action === "vote-end") return this.controller.startVote("end");
            if (welcomeAction?.action === "transfer") return this.chooseHost();
            if (welcomeAction?.action === "leave") return this.controller.leave();
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
`;
        document.head.appendChild(style);
    }

    return { GameUI, installStyles };
});
