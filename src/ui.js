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

            // Theme and responsive settings
            this.isDarkTheme = false;
            this.isResponsive = true;
            this.soundEnabled = true;
            this.sounds = {};
            this.loadSettings();
            this.loadSounds();
        }

        loadSounds() {
            // Create audio elements for sound effects
            const soundFiles = {
                'card-play': 'sounds/card-play.mp3',
                'card-draw': 'sounds/card-draw.mp3',
                'uno': 'sounds/uno.mp3',
                'game-start': 'sounds/game-start.mp3',
                'game-end': 'sounds/game-end.mp3',
                'button-click': 'sounds/button-click.mp3'
            };

            // Pre-load sounds
            for (const [key, url] of Object.entries(soundFiles)) {
                const audio = new Audio();
                audio.src = url;
                audio.preload = 'auto';
                this.sounds[key] = audio;
            }
        }

        saveSettings() {
            localStorage.setItem('bcpg-theme', this.isDarkTheme ? 'dark' : 'light');
            localStorage.setItem('bcpg-responsive', this.isResponsive.toString());
            localStorage.setItem('bcpg-sound', this.soundEnabled.toString());
        }

        applyTheme() {
            if (this.root) {
                this.root.classList.toggle('bcpg-dark', this.isDarkTheme);
                this.root.classList.toggle('bcpg-light', !this.isDarkTheme);
            }
            // Also update toolbar button states if needed
        }

        calculateLayout() {
            const snap = this.controller.snapshot();
            const fullTable = !!snap.state;
            const viewportWidth = window.visualViewport?.width || window.innerWidth;
            const viewportHeight = window.visualViewport?.height || window.innerHeight;

            // Base layout parameters
            let width, height, cardW, cardH, spacing, playerRadius;

            if (this.isResponsive) {
                // Responsive adjustments
                if (viewportWidth < 600) {
                    // Narrow screen: vertical layout
                    width = Math.min(320, viewportWidth - 20);
                    height = Math.min(width * 1.8, viewportHeight - 100);
                    cardW = 50;
                    cardH = 80;
                    spacing = 10;
                    playerRadius = width / 2 - 40;
                } else if (viewportWidth < 900) {
                    // Medium screen: hybrid
                    width = Math.min(500, viewportWidth - 40);
                    height = Math.min(width * 1.5, viewportHeight - 120);
                    cardW = 60;
                    cardH = 100;
                    spacing = 15;
                    playerRadius = width / 2 - 50;
                } else {
                    // Wide screen: horizontal layout
                    width = Math.min(1080, Math.max(620, viewportWidth - 70));
                    height = Math.min(width / 2, Math.max(300, viewportHeight - 160));
                    cardW = 82;
                    cardH = 120;
                    spacing = 20;
                    playerRadius = width / 3 - 60;
                }
            } else {
                // Fixed layout (original behavior)
                width = fullTable
                    ? Math.min(1080, Math.max(620, viewportWidth - 70))
                    : Math.min(680, Math.max(420, viewportWidth - 100));
                height = fullTable
                    ? Math.min(width / 2, Math.max(300, viewportHeight - 160))
                    : Math.min(380, Math.max(280, viewportHeight - 220));
                cardW = 82;
                cardH = 120;
                spacing = 20;
                playerRadius = width / 2 - 80; // Approximate
            }

            return { width, height, cardW, cardH, spacing, playerRadius, fullTable };
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
            const { width, height, cardW, cardH, spacing, playerRadius, fullTable } = this.calculateLayout();
            this.root?.classList.toggle("bcpg-compact", !fullTable);
            const dpr = Math.min(2, window.devicePixelRatio || 1);
            this.canvas.style.width = `${width}px`;
            this.canvas.style.height = `${height}px`;
            this.canvas.width = Math.floor(width * dpr);
            this.canvas.height = Math.floor(height * dpr);
            this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            this.width = width; this.height = height;
            this.cardW = cardW;
            this.cardH = cardH;
            this.spacing = spacing;
            this.playerRadius = playerRadius;
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
            const titleSize = Math.max(28, Math.min(42, this.width * 0.07));
            const hintSize = Math.max(14, Math.min(20, this.width * 0.03));
            const labelSize = Math.max(14, Math.min(21, this.width * 0.035));
            const buttonSize = Math.max(12, Math.min(16, this.width * 0.025));

            ctx.textAlign = "center";
            ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--opponent-card-online').trim() || "#fff";
            ctx.font = `700 ${titleSize}px sans-serif`;
            ctx.fillText(this.t("welcome"), this.width / 2, 76);
            ctx.font = `${hintSize}px sans-serif`;
            ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--deck-text').trim() || "#d9efe5";
            ctx.fillText(this.t("welcomeHint"), this.width / 2, 112);
            if (pendingInvite) {
                ctx.fillStyle = "rgba(0,0,0,.5)";
                const inviteRectWidth = Math.min(460, this.width - 40);
                const inviteRectHeight = Math.min(90, this.height * 0.15);
                ctx.fillRect(this.width / 2 - inviteRectWidth / 2, 150, inviteRectWidth, inviteRectHeight);
                ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--host-star').trim() || "#f7c948";
                ctx.font = `700 ${Math.max(16, Math.min(22, this.width * 0.035))}px sans-serif`;
                ctx.fillText(this.t("inviteFrom", { name: pendingInvite.hostName }), this.width / 2, 185);
                const buttonWidth = Math.min(165, this.width * 0.25);
                const buttonHeight = Math.min(48, this.height * 0.08);
                this.drawCanvasButton(this.width / 2 - buttonWidth / 2 - 20, 204, buttonWidth, buttonHeight, this.t("acceptInvite"), "#397a48", "invite-accept");
                this.drawCanvasButton(this.width / 2 + 20, 204, buttonWidth, buttonHeight, this.t("declineInvite"), "#8c3b38", "invite-decline");
                return;
            }
            ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--opponent-card-online').trim() || "#fff";
            ctx.font = `700 ${labelSize}px sans-serif`;
            ctx.fillText(this.t("installedPlayers"), this.width / 2, 166);
            if (!peers.length) {
                ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--opponent-card-lost').trim() || "#b8d2c5";
                ctx.font = `${Math.max(12, Math.min(17, this.width * 0.025))}px sans-serif`;
                ctx.fillText(this.t("noInstalledPlayers"), this.width / 2, 205);
            } else {
                peers.forEach((peer, index) => {
                    const peerItemHeight = Math.min(46, this.height * 0.08);
                    const peerItemWidth = Math.min(460, this.width - 40);
                    const peerItemY = 184 + index * (peerItemHeight + 12);
                    const x = this.width / 2 - peerItemWidth / 2;
                    const y = peerItemY;
                    const w = peerItemWidth;
                    const h = peerItemHeight;
                    const bgColor = "rgba(0,0,0,.34)";
                    const borderColor = "rgba(255,255,255,.28)";
                    this.roundRect(ctx, x, y, w, h, 8, bgColor, borderColor);
                    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--opponent-card-online').trim() || "#fff";
                    ctx.font = `600 ${Math.max(14, Math.min(18, this.width * 0.03))}px sans-serif`;
                    ctx.textAlign = "left";
                    ctx.fillText(`${peer.name} (#${peer.memberNumber})`, x + 18, y + Math.max(18, h * 0.4));
                    const buttonColor = getComputedStyle(document.documentElement).getPropertyValue('--host-star').trim() || "#8b5b1f";
                    const buttonTextColor = getComputedStyle(document.documentElement).getPropertyValue('--button-text').trim() || "#f7d67e";
                    this.roundRect(ctx, x + w - Math.min(102, w * 0.22), y + Math.min(7, h * 0.15), Math.min(88, w * 0.19), Math.min(32, h * 0.48), 6, buttonColor, buttonTextColor);
                    ctx.fillStyle = buttonTextColor;
                    ctx.font = `700 ${Math.max(11, Math.min(15, this.width * 0.02))}px sans-serif`;
                    ctx.textAlign = "center";
                    ctx.fillText(this.t("invite"), x + w - Math.min(58, w * 0.13), y + Math.min(28, h * 0.55));
                    this.hitPeers.push({ x, y, w, h, memberNumber: peer.memberNumber });
                });
            }
        }

        drawLobby({ lobby, localId }) {
            const ctx = this.ctx;
            const titleSize = Math.max(24, Math.min(34, this.width * 0.05));
            const labelSize = Math.max(14, Math.min(18, this.width * 0.03));

            ctx.textAlign = "center";
            ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--opponent-card-online').trim() || "#fff";
            ctx.font = `700 ${titleSize}px sans-serif`;
            ctx.fillText(this.t("unoLobby"), this.width / 2, 72);
            ctx.font = `${Math.max(14, Math.min(18, this.width * 0.03))}px sans-serif`;
            ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--deck-text').trim() || "#cfe8dc";
            ctx.fillText(this.t("playersCount", { count: lobby.players.length }), this.width / 2, 108);
            lobby.players.forEach((player, i) => {
                const y = 160 + i * Math.max(30, Math.min(42, this.width * 0.06));
                const hostColor = getComputedStyle(document.documentElement).getPropertyValue('--host-star').trim() || "#f7c948";
                const onlineColor = getComputedStyle(document.documentElement).getPropertyValue('--opponent-card-online').trim() || "#fff";
                ctx.fillStyle = player.memberNumber === lobby.hostId ? hostColor : onlineColor;
                ctx.font = `600 ${Math.max(16, Math.min(21, this.width * 0.03))}px sans-serif`;
                ctx.fillText(`${player.memberNumber === lobby.hostId ? "★ " : ""}${player.name}${player.memberNumber === localId ? ` (${this.t("you")})` : ""}`, this.width / 2, y);
            });
        }

        drawGame({ state, localId }) {
            const ctx = this.ctx, w = this.width, h = this.height;
            const active = core.currentPlayer(state);

            // Use responsive fonts based on card width
            const titleSize = Math.max(18, Math.min(24, this.cardW * 0.3));
            const timerSize = Math.max(12, Math.min(16, this.cardW * 0.2));
            const labelSize = Math.max(12, Math.min(15, this.cardW * 0.18));

            ctx.textAlign = "center";
            ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--opponent-card-online').trim() || "#fff";
            ctx.font = `700 ${titleSize}px sans-serif`;
            ctx.fillText(state.phase === "finished" ? this.finishedText(state) : this.t("turn", { name: active?.name || "-" }), w / 2, 38);
            if (state.phase === "playing") {
                const remains = active?.status === "disconnected" ? null : Math.max(0, Math.ceil((Number(state.turnStartedAt || Date.now()) + Number(state.rules.turnSeconds || 45) * 1000 - Date.now()) / 1000));
                ctx.fillStyle = remains != null && remains <= 10 ? "#ffad66" : getComputedStyle(document.documentElement).getPropertyValue('--deck-text').trim() || "#d7ecdf";
                ctx.font = `700 ${timerSize}px sans-serif`;
                ctx.fillText(remains == null ? this.t("timerPaused") : this.t("turnTimer", { seconds: remains }), w / 2, 61);
            }
            ctx.font = `${labelSize}px sans-serif`;
            ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--deck-text').trim() || "#d7ecdf";
            ctx.fillText(this.t("deckCount", { count: state.drawPile.length }), w / 2, 82);

            const opponents = state.players.filter(p => p.memberNumber !== localId);
            const spacing = w / Math.max(1, opponents.length);
            opponents.forEach((player, i) => {
                const x = spacing * i + spacing / 2, y = 105;
                const count = state.hands[String(player.memberNumber)]?.length || 0;
                const disconnectedColor = getComputedStyle(document.documentElement).getPropertyValue('--opponent-card-disconnected').trim() || "#ffadad";
                const lostColor = getComputedStyle(document.documentElement).getPropertyValue('--opponent-card-lost').trim() || "#999";
                const onlineColor = getComputedStyle(document.documentElement).getPropertyValue('--opponent-card-online').trim() || "#fff";
                ctx.fillStyle = player.status === "disconnected" ? disconnectedColor : player.status === "lost" ? lostColor : onlineColor;
                ctx.font = `600 ${Math.max(14, Math.min(17, this.cardW * 0.2))}px sans-serif`;
                ctx.fillText(`${player.name} · ${this.t("cardsCount", { count })}`, x, y);
                if (player.memberNumber === state.hostId) {
                    const hostStarColor = getComputedStyle(document.documentElement).getPropertyValue('--host-star').trim() || "#f7c948";
                    ctx.fillStyle = hostStarColor;
                    ctx.fillText("★", x, y + 24);
                }
                this.drawBacks(x, y + 36, Math.min(count, 12));
            });

            const top = state.discardPile[state.discardPile.length - 1];
            const centerY = h / 2 - 70, deckX = w / 2 - 132, discardX = w / 2 + 36;
            this.drawDeck(ctx, deckX, centerY, 96, 140, state.drawPile.length);
            this.drawCard(ctx, top, discardX, centerY, 96, 140, false);

            const activeColor = getComputedStyle(document.documentElement).getPropertyValue('--card-text-color') || CARD_COLORS[state.activeColor] || "#fff";
            ctx.fillStyle = activeColor;
            ctx.beginPath(); ctx.arc(discardX + 120, centerY + 70, 16, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--opponent-card-online').trim() || "#fff";
            ctx.stroke();
            if (state.phase === "playing" && active?.memberNumber === localId && !state.drawnThisTurn) {
                ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--opponent-card-online').trim() || "#fff";
                ctx.font = `700 ${labelSize}px sans-serif`;
                ctx.textAlign = "center";
                ctx.fillText(this.t("clickToDraw"), deckX + 48, centerY + 162);
                this.hitWelcomeActions.push({ x: deckX - 8, y: centerY - 8, w: 112, h: 178, action: "draw" });
            }

            const hand = state.hands[String(localId)] || [];
            const cardW = this.cardW;
            const cardH = this.cardH;
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

            // Use animated position if available
            const renderX = this.animateTo?.x ?? x;
            const renderY = this.animateTo?.y ?? y;

            ctx.save();
            if (highlight) {
                ctx.shadowColor = getComputedStyle(document.documentElement).getPropertyValue('--card-shadow-color').trim() || "#fff59d";
                ctx.shadowBlur = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--card-shadow-blur')) || 14;
            }

            // Add subtle random rotation for realism (-5 to +5 degrees)
            const rotation = (Math.random() - 0.5) * (10 * Math.PI / 180); // -5 to +5 degrees in radians
            ctx.translate(renderX + w / 2, renderY + h / 2);
            ctx.rotate(rotation);
            ctx.translate(-w / 2, -h / 2);

            // Draw card with theme colors
            const cardBase = getComputedStyle(document.documentElement).getPropertyValue('--card-base').trim() || "#f8f4e8";
            const cardHighlight = getComputedStyle(document.documentElement).getPropertyValue('--card-highlight').trim() || "#fff59d";
            const cardInner = getComputedStyle(document.documentElement).getPropertyValue('--card-inner').trim() || "rgba(0,0,0,.3)";
            const cardEllipseFill = getComputedStyle(document.documentElement).getPropertyValue('--card-ellipse-fill').trim() || "rgba(255,255,255,.88)";
            const cardNumberColor = getComputedStyle(document.documentElement).getPropertyValue('--card-number-color').trim() || (card.color === "yellow" ? "#333" : "#111");

            this.roundRect(ctx, 0, 0, w, h, 10, cardBase, highlight ? cardHighlight : "#222");
            this.roundRect(ctx, 5, 5, w - 10, h - 10, 8, CARD_COLORS[card.color], cardInner);
            ctx.fillStyle = cardEllipseFill;
            ctx.beginPath(); ctx.ellipse(w / 2, h / 2, w * .28, h * .39, .55, 0, Math.PI * 2); ctx.fill();
            const label = card.kind === "number" ? String(card.value) : SYMBOLS[card.kind];

            // Use theme color for text, with special handling for yellow
            ctx.fillStyle = card.color === "yellow" ?
                (getComputedStyle(document.documentElement).getPropertyValue('--card-number-color').trim() || "#333") :
                (CARD_COLORS[card.color] || "#111");
            if (card.color === "wild") ctx.fillStyle = "#111";

            ctx.font = `900 ${Math.floor(w * .42)}px sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";

            if (card.kind === "draw2" || card.kind === "wild4") this.drawDrawCardSymbol(ctx, card, 0, 0, w, h);
            else ctx.fillText(label, w / 2, h / 2);
            ctx.restore();
        }

        // Animation for card movement
        animateCardMove(fromX, fromY, toX, toY, duration = 300, callback) {
            const startTime = performance.now();
            const animate = (currentTime) => {
                const elapsed = currentTime - startTime;
                const progress = Math.min(elapsed / duration, 1);
                const easeProgress = 1 - Math.pow(1 - progress, 3); // Ease out cubic

                const currentX = fromX + (toX - fromX) * easeProgress;
                const currentY = fromY + (toY - fromY) * easeProgress;

                // Store animated position for rendering
                this.animateTo = { x: currentX, y: currentY };

                if (progress < 1) {
                    requestAnimationFrame(animate);
                } else {
                    delete this.animateTo;
                    if (callback) callback();
                }
            };
            requestAnimationFrame(animate);
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
            this.ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--settings-panel-bg').trim() || "rgba(18,15,11,.95)";
            this.ctx.fillRect(x, y, w, 230);
            this.ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--settings-panel-border').trim() || "#d4af55";
            this.ctx.strokeRect(x, y, w, 230);
            this.ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--settings-panel-text').trim() || "#fff";
            this.ctx.font = "700 19px sans-serif";
            this.ctx.textAlign = "center";
            this.ctx.fillText(this.t("gameManagement"), x + w / 2, y + 30);
            let by = y + 46;

            // Rule toggles (only for host)
            if (Number(state.hostId) === Number(localId) && state.phase !== "finished") {
                const ruleLabelSize = Math.max(12, Math.min(14, this.width * 0.02));
                const ruleCheckboxSize = Math.max(16, Math.min(20, this.width * 0.03));

                this.ctx.font = `${ruleLabelSize}px sans-serif`;
                this.ctx.textAlign = "left";

                const addRuleToggle = (label, ruleKey, checked) => {
                    const checkboxX = x + 18;
                    const checkboxY = by;
                    const labelX = checkboxX + ruleCheckboxSize + 8;

                    // Draw checkbox background
                    this.roundRect(this.ctx, checkboxX, checkboxY, ruleCheckboxSize, ruleCheckboxSize, 3, "#eee", "#ccc");
                    // Draw checkmark if checked
                    if (checked) {
                        this.ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--host-star').trim() || "#f7c948";
                        this.ctx.beginPath();
                        this.ctx.moveTo(checkboxX + 4, checkboxY + ruleCheckboxSize / 2);
                        this.ctx.lineTo(checkboxX + ruleCheckboxSize / 2, checkboxY + ruleCheckboxSize - 4);
                        this.ctx.lineTo(checkboxX + ruleCheckboxSize - 2, checkboxY + 4);
                        this.ctx.stroke();
                    }
                    // Draw label
                    this.ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--settings-panel-text').trim() || "#fff";
                    this.ctx.fillText(label, labelX, checkboxY + ruleCheckboxSize - 2);

                    // Store hit area for click detection
                    this.hitWelcomeActions.push({
                        x: checkboxX, y: checkboxY,
                        w: ruleCheckboxSize + 180, h: ruleCheckboxSize,
                        action: `toggle-rule-${ruleKey}`
                    });

                    by += ruleCheckboxSize + 8;
                };

                // Add rule toggles
                addRuleToggle(this.t("ruleStacking"), "stacking", state.rules.stacking);
                addRuleToggle(this.t("ruleDrawUntilPlayable"), "drawUntilPlayable", state.rules.drawUntilPlayable);
                addRuleToggle(this.t("rulePlayDrawnCard"), "playDrawnCard", state.rules.playDrawnCard);
                addRuleToggle(this.t("ruleWildDrawFourChallenge"), "wildDrawFourChallenge", state.rules.wildDrawFourChallenge);
                addRuleToggle(this.t("ruleJumpIn"), "jumpIn", state.rules.jumpIn);
                addRuleToggle(this.t("ruleSevenZero"), "sevenZero", state.rules.sevenZero);
                addRuleToggle(this.t("ruleForcePlay"), "forcePlay", state.rules.forcePlay);

                by += 10; // Add some spacing
            }

            const add = (label, action, color = "#6e451e") => {
                const buttonWidth = w - 36;
                const buttonHeight = 38;
                this.drawCanvasButton(x + 18, by, buttonWidth, buttonHeight, label, color, action);
                by += buttonHeight + 8;
            };

            if (!state.vote && state.phase !== "finished") {
                add(this.t("voteRestart"), "vote-restart");
                add(this.t("voteEnd"), "vote-end", "#713b32");
            }
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
            this.playSound('button-click');
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
                    this.controller.requestPlay(cardId, color);
                    this.playSound('card-play');
                    this.render();
                }
                return;
            }
            const welcomeAction = this.hitWelcomeActions.find(hit => x >= hit.x && x <= hit.x + hit.w && y >= hit.y && y <= hit.y + hit.h);
            if (welcomeAction?.action === "invite-accept") {
                this.playSound('button-click');
                return this.controller.acceptInvite();
            }
            if (welcomeAction?.action === "invite-decline") {
                this.playSound('button-click');
                return this.controller.declineInvite();
            }
            if (welcomeAction?.action === "draw") {
                this.playSound('button-click');
                return this.controller.requestDraw();
            }
            if (welcomeAction?.action === "settings") {
                this.playSound('button-click');
                this.settingsOpen = !this.settingsOpen;
                return this.render();
            }
            if (welcomeAction?.action === "vote-restart") {
                this.playSound('button-click');
                return this.controller.startVote("restart");
            }
            if (welcomeAction?.action === "vote-end") {
                this.playSound('button-click');
                return this.controller.startVote("end");
            }
            if (welcomeAction?.action === "transfer") {
                this.playSound('button-click');
                return this.chooseHost();
            }
            if (welcomeAction?.action === "leave") {
                this.playSound('button-click');
                return this.controller.leave();
            }
            const peer = this.hitPeers.find(hit => x >= hit.x && x <= hit.x + hit.w && y >= hit.y && y <= hit.y + hit.h);
            if (peer) {
                this.playSound('button-click');
                return this.controller.invite(peer.memberNumber);
            }
            const hit = [...this.hitCards].reverse().find(card => x >= card.x && x <= card.x + card.w && y >= card.y && y <= card.y + card.h);
            if (!hit?.playable) return;
            if (hit.card.color === "wild") {
                this.pendingWildCardId = hit.card.id;
                this.playSound('button-click');
                this.render();
            } else {
                this.playSound('card-play');
                this.controller.requestPlay(hit.card.id);
            }
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
:root {
  --bg-gradient-start: #176b48;
  --bg-gradient-end: #073623;
  --table-line: rgba(255,255,255,.08);
  --card-base: #f8f4e8;
  --card-highlight: #fff59d;
  --card-inner: rgba(0,0,0,.3);
  --card-ellipse-fill: rgba(255,255,255,.88);
  --card-number-color: #333;
  --card-shadow-color: #fff59d;
  --card-shadow-blur: 14;
  --opponent-card-disconnected: #ffadad;
  --opponent-card-lost: #999;
  --opponent-card-online: #fff;
  --host-star: #f7c948;
  --deck-top: #eee9db;
  --deck-bottom: #222;
  --deck-inner: #151515;
  --deck-ellipse-fill: #e52535;
  --deck-text: #fff;
  --deck-count-color: #fff;
  --toolbar-bg: #24170c;
  --toolbar-button-bg: #6e451e;
  --toolbar-button-hover-bg: #93622f;
  --toolbar-button-disabled-opacity: .45;
  --settings-panel-bg: rgba(18,15,11,.95);
  --settings-panel-border: #d4af55;
  --settings-panel-text: #fff;
  --gear-bg-open: #a66e27;
  --gear-bg-closed: rgba(0,0,0,.5);
  --gear-border: #ead28c;
  --gear-text: #fff;
  --color-wheel-bg: rgba(0,0,0,.76);
  --color-wheel-text: #fff;
  --color-wheel-center-fill: #fff;
  --color-wheel-center-text: #111;
  --button-roundRect-fill: #6e451e;
  --button-roundRect-stroke: #f4dc9b;
  --button-text: #fff;
  --button-font: 700 16px sans-serif;
}

.bcpg-dark {
  --bg-gradient-start: #0d1117;
  --bg-gradient-end: #0d1117;
  --table-line: rgba(255,255,255,.08);
  --card-base: #30363d;
  --card-highlight: #8b949e;
  --card-inner: rgba(255,255,255,.1);
  --card-ellipse-fill: rgba(255,255,255,.1);
  --card-number-color: #fff;
  --card-shadow-color: #8b949e;
  --card-shadow-blur: 14;
  --opponent-card-disconnected: #ffadad;
  --opponent-card-lost: #999;
  --opponent-card-online: #e6edf3;
  --host-star: #f7c948;
  --deck-top: #eee9db;
  --deck-bottom: #222;
  --deck-inner: #151515;
  --deck-ellipse-fill: #e52535;
  --deck-text: #fff;
  --deck-count-color: #fff;
  --toolbar-bg: #24170c;
  --toolbar-button-bg: #6e451e;
  --toolbar-button-hover-bg: #93622f;
  --toolbar-button-disabled-opacity: .45;
  --settings-panel-bg: rgba(18,15,11,.95);
  --settings-panel-border: #d4af55;
  --settings-panel-text: #e6edf3;
  --gear-bg-open: #a66e27;
  --gear-bg-closed: rgba(0,0,0,.5);
  --gear-border: #ead28c;
  --gear-text: #fff;
  --color-wheel-bg: rgba(0,0,0,.76);
  --color-wheel-text: #fff;
  --color-wheel-center-fill: #fff;
  --color-wheel-center-text: #111;
  --button-roundRect-fill: #6e451e;
  --button-roundRect-stroke: #f4dc9b;
  --button-text: #fff;
  --button-font: 700 16px sans-serif;
}

#bcpg-overlay{display:none;position:fixed;inset:0;z-index:10050;background:rgba(0,0,0,.72);align-items:center;justify-content:center;font-family:Arial,sans-serif;overflow:auto;padding:10px;box-sizing:border-box}
#bcpg-overlay.open{display:flex}.bcpg-window{display:flex;position:relative;isolation:isolate;flex-direction:column;background:var(--bg-gradient-start);border:2px solid #d9b45b;border-radius:12px;overflow:hidden;box-shadow:0 20px 70px #000;color:var(--opponent-card-online);max-width:calc(100vw - 20px);max-height:calc(100vh - 20px)}
.bcpg-title{position:relative;z-index:3;height:42px;min-height:42px;display:flex;align-items:center;justify-content:space-between;padding:0 12px;background:var(--toolbar-bg);font-weight:700;font-size:19px;flex:0 0 auto}.bcpg-title button{font-size:28px;color:var(--button-text);background:none;border:0;cursor:pointer}
#bcpg-overlay canvas{display:block!important;position:relative!important;inset:auto!important;z-index:1!important;min-height:0;max-width:100%;flex:1 1 auto}.bcpg-toolbar{position:relative;z-index:3;min-height:52px;padding:7px;display:flex;gap:7px;justify-content:center;align-items:center;flex-wrap:wrap;background:var(--toolbar-bg);flex:0 0 auto;box-sizing:border-box}
.bcpg-toolbar button{padding:8px 14px;border:1px solid #e5c675;border-radius:6px;background:var(--toolbar-button-bg);color:var(--button-text);font-weight:700;cursor:pointer}.bcpg-toolbar button:hover{background:var(--toolbar-button-hover-bg)}.bcpg-toolbar button:disabled{opacity:var(--toolbar-button-disabled-opacity);cursor:not-allowed}
#bcpg-chat-button img{width:70%;height:70%;object-fit:contain}
.bcpg-compact { transform: scale(0.9); transform-origin: top; }
`;
        document.head.appendChild(style);
    }

    return { GameUI, installStyles };
});
