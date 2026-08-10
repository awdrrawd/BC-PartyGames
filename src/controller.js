(function registerPartyGamesController(root, factory) {
    const modules = root.BCPartyGamesModules = root.BCPartyGamesModules || {};
    if (!modules.controller) modules.controller = factory(modules.core);
})(typeof globalThis !== "undefined" ? globalThis : window, function partyGamesControllerFactory(core) {
    "use strict";

    class Controller {
        constructor({ transport, localPlayer, roomPlayers, notify, action }) {
            this.transport = transport;
            this.localPlayer = localPlayer;
            this.roomPlayers = roomPlayers;
            this.notify = notify || (() => {});
            this.action = action || (() => {});
            this.lobby = null;
            this.state = null;
            this.listeners = new Set();
            this.seenRoomMembers = new Set();
            this.presenceTimer = null;
            this.tickTimer = null;
            this.pendingTransfer = null;
            this.peers = new Map();
            this.pendingInvite = null;
            this.helloTimer = null;
            this.outgoingInvites = new Map();
        }

        get localId() { return Number(this.localPlayer().memberNumber); }
        isHost() { return Number(this.state?.hostId ?? this.lobby?.hostId) === this.localId; }
        onChange(handler) { this.listeners.add(handler); return () => this.listeners.delete(handler); }
        changed() { for (const fn of this.listeners) fn(this.snapshot()); }
        snapshot() {
            const roomIds = new Set(this.roomPlayers().map(p => Number(p.memberNumber)));
            const peers = [...this.peers.values()].filter(peer => roomIds.has(peer.memberNumber) && Date.now() - peer.lastSeen < 20000);
            return { lobby: this.lobby, state: this.state, localId: this.localId, isHost: this.isHost(), peers, pendingInvite: this.pendingInvite };
        }

        start() {
            this.transport.on(packet => this.handle(packet));
            this.presenceTimer = setInterval(() => this.checkPresence(), 1000);
            this.tickTimer = setInterval(() => this.tick(), 500);
            this.helloTimer = setInterval(() => this.transport.send("HELLO", { version: "0.2.1", name: this.localPlayer().name }), 10000);
            this.checkPresence();
            this.transport.send("HELLO", { version: "0.2.1", name: this.localPlayer().name });
        }

        createLobby() {
            if (this.state?.phase === "playing") return;
            const me = this.localPlayer();
            this.lobby = {
                game: "uno", lobbyId: core.makeId("lobby"), hostId: this.localId,
                players: [{ memberNumber: this.localId, name: me.name, ready: true }],
                invited: [],
                rules: { ...core.DEFAULT_RULES }, createdAt: Date.now(),
            };
            this.broadcastLobby();
            this.notify("lobbyCreated");
            this.changed();
        }

        invite(memberNumber) {
            const target = Number(memberNumber);
            if (!this.peers.has(target) || target === this.localId || this.state) return;
            if (!this.lobby) this.createLobby();
            if (!this.isHost() || this.lobby.players.some(p => p.memberNumber === target)) return;
            if (!this.lobby.invited.includes(target)) this.lobby.invited.push(target);
            this.transport.send("INVITE", {
                lobbyId: this.lobby.lobbyId, hostId: this.localId,
                hostName: this.localPlayer().name, game: "uno",
            }, target);
            this.outgoingInvites.set(target, { lobbyId: this.lobby.lobbyId, sentAt: Date.now(), attempts: 1, acknowledged: false });
            this.broadcastLobby();
            this.changed();
        }

        acceptInvite() {
            const invite = this.pendingInvite;
            if (!invite) return;
            const me = this.localPlayer();
            this.transport.send("LOBBY_JOIN", { lobbyId: invite.lobbyId, name: me.name }, invite.hostId);
            this.pendingInvite = null;
            this.changed();
        }

        declineInvite() {
            if (!this.pendingInvite) return;
            this.transport.send("INVITE_DECLINE", { lobbyId: this.pendingInvite.lobbyId }, this.pendingInvite.hostId);
            this.pendingInvite = null;
            this.changed();
        }

        joinLobby() {
            if (!this.lobby || this.lobby.players.some(p => p.memberNumber === this.localId)) return;
            const me = this.localPlayer();
            this.transport.send("LOBBY_JOIN", { lobbyId: this.lobby.lobbyId, name: me.name }, this.lobby.hostId);
        }

        leave() {
            if (this.lobby && !this.state) {
                this.transport.send("LOBBY_LEAVE", { lobbyId: this.lobby.lobbyId });
                if (this.isHost()) this.transport.send("LOBBY_CLOSE", { lobbyId: this.lobby.lobbyId });
                this.lobby = null;
                this.changed();
                return;
            }
            if (this.state && this.isHost()) {
                const oldHostId = this.localId;
                core.removePlayer(this.state, oldHostId);
                const successor = this.state.players.find(p => p.status === "online" && p.memberNumber !== oldHostId);
                if (successor) {
                    this.state.hostId = successor.memberNumber;
                    this.state.hostEpoch++;
                    this.state.revision = 0;
                    this.transport.send("HOST_TRANSFER_COMMIT", {
                        gameId: this.state.gameId, hostId: successor.memberNumber,
                        hostEpoch: this.state.hostEpoch, state: this.state,
                    });
                    this.changed();
                } else {
                    this.state.phase = "finished";
                    this.state.winnerId = null;
                    this.commit("gameEnded", {});
                }
            } else if (this.state) {
                this.transport.send("PLAYER_LEAVE", { gameId: this.state.gameId });
            }
        }

        startGame() {
            if (!this.isHost() || !this.lobby || this.lobby.players.length < 2) return;
            this.state = core.createGame({ hostId: this.localId, players: this.lobby.players, rules: this.lobby.rules });
            this.lobby = null;
            this.commit("gameStarted", { playerCount: this.state.players.length });
        }

        requestPlay(cardId, chosenColor = null) {
            if (!this.state) return;
            const payload = { gameId: this.state.gameId, cardId, chosenColor };
            if (this.isHost()) this.hostPlay(this.localId, payload); else this.transport.send("PLAY_REQUEST", payload, this.state.hostId);
        }
        requestDraw() {
            if (!this.state) return;
            const payload = { gameId: this.state.gameId };
            if (this.isHost()) this.hostDraw(this.localId); else this.transport.send("DRAW_REQUEST", payload, this.state.hostId);
        }
        requestPass() {
            if (!this.state) return;
            const payload = { gameId: this.state.gameId };
            if (this.isHost()) this.hostPass(this.localId); else this.transport.send("PASS_REQUEST", payload, this.state.hostId);
        }

        hostPlay(sender, packet) {
            const result = core.playCard(this.state, sender, packet.cardId, packet.chosenColor);
            if (!result.ok) return this.reject(sender, result.error);
            if (!result.won) this.state.turnStartedAt = Date.now();
            const player = this.state.players.find(p => p.memberNumber === Number(sender));
            this.commit(result.won ? "winner" : result.card && this.state.lastAction?.uno ? "uno" : "cardPlayed", {
                player: player?.name, card: result.card, winnerId: result.won ? Number(sender) : null,
            });
        }
        hostDraw(sender) {
            const result = core.drawForTurn(this.state, sender);
            if (!result.ok) return this.reject(sender, result.error);
            if (!result.playable) this.state.turnStartedAt = Date.now();
            this.commit("cardDrawn", { memberNumber: Number(sender), playable: result.playable });
        }
        hostPass(sender) {
            const result = core.passAfterDraw(this.state, sender);
            if (!result.ok) return this.reject(sender, result.error);
            this.state.turnStartedAt = Date.now();
            this.commit("turnPassed", { memberNumber: Number(sender) });
        }
        reject(target, error) { this.transport.send("ACTION_REJECTED", { gameId: this.state?.gameId, error }, target); }

        commit(event, eventData = {}) {
            if (!this.state || !this.isHost()) return;
            this.state.revision++;
            this.state.updatedAt = Date.now();
            this.transport.send("STATE", { gameId: this.state.gameId, hostEpoch: this.state.hostEpoch, revision: this.state.revision, state: this.state, event, eventData });
            this.action(event, eventData, this.state);
            this.changed();
        }
        broadcastLobby() {
            if (this.lobby && this.isHost()) this.transport.send("LOBBY_STATE", { lobby: this.lobby });
        }

        proposeHost(targetId) {
            if (!this.isHost() || !this.state || Number(targetId) === this.localId) return;
            this.pendingTransfer = { targetId: Number(targetId), expiresAt: Date.now() + 15000 };
            this.transport.send("HOST_TRANSFER_PROPOSE", { gameId: this.state.gameId, state: this.state }, targetId);
        }

        startVote(kind) {
            if (!this.state || !["restart", "end"].includes(kind)) return;
            const cooldown = Number(this.state.voteCooldowns?.[String(this.localId)] || 0);
            if (cooldown > Date.now()) return this.notify("voteCooldown", { seconds: Math.ceil((cooldown - Date.now()) / 1000) });
            if (this.isHost()) this.hostStartVote(this.localId, kind);
            else this.transport.send("VOTE_START", { gameId: this.state.gameId, kind }, this.state.hostId);
        }
        castVote(yes) {
            if (!this.state?.vote) return;
            if (this.isHost()) this.hostCastVote(this.localId, yes);
            else this.transport.send("VOTE_CAST", { gameId: this.state.gameId, voteId: this.state.vote.id, yes: !!yes }, this.state.hostId);
        }
        hostStartVote(sender, kind) {
            if (this.state.vote || !["restart", "end"].includes(kind)) return;
            const key = String(sender), now = Date.now();
            if (Number(this.state.voteCooldowns[key] || 0) > now) return this.reject(sender, "voteCooldown");
            this.state.voteCooldowns[key] = now + this.state.rules.voteCooldownSeconds * 1000;
            this.state.vote = { id: core.makeId("vote"), kind, proposerId: Number(sender), endsAt: now + this.state.rules.voteSeconds * 1000, votes: { [key]: true } };
            this.commit("voteStarted", { kind, proposerId: Number(sender) });
            this.checkVote();
        }
        hostCastVote(sender, yes) {
            if (!this.state.vote || this.state.vote.endsAt <= Date.now()) return;
            this.state.vote.votes[String(sender)] = !!yes;
            this.commit("voteUpdated", {});
            this.checkVote();
        }
        checkVote() {
            if (!this.isHost() || !this.state?.vote) return;
            const eligible = this.state.players.filter(p => p.status === "online").map(p => p.memberNumber);
            const yes = eligible.filter(id => this.state.vote.votes[String(id)] === true).length;
            if (yes > eligible.length / 2) this.resolveVote(true);
        }
        resolveVote(passed) {
            const vote = this.state?.vote;
            if (!vote) return;
            if (passed && vote.kind === "restart") {
                const prior = this.state;
                this.state = core.createGame({ hostId: this.localId, players: prior.players.filter(p => p.status !== "lost"), rules: prior.rules });
                this.state.hostEpoch = prior.hostEpoch;
                this.state.voteCooldowns = prior.voteCooldowns;
                this.commit("gameRestarted", {});
            } else if (passed && vote.kind === "end") {
                this.state.vote = null;
                this.state.phase = "finished";
                this.state.winnerId = null;
                this.commit("gameEnded", {});
            } else {
                this.state.vote = null;
                this.commit("voteFailed", { kind: vote.kind });
            }
        }

        checkPresence() {
            const current = new Set(this.roomPlayers().map(p => Number(p.memberNumber)));
            if (!this.seenRoomMembers.size) { this.seenRoomMembers = current; return; }
            if (this.state) {
                const now = Date.now();
                let dirty = false;
                for (const player of this.state.players) {
                    if (player.status === "lost") continue;
                    const online = current.has(player.memberNumber);
                    if (!online && player.status === "online") { player.status = "disconnected"; player.disconnectedAt = now; dirty = true; }
                    if (online && player.status === "disconnected") { player.status = "online"; player.disconnectedAt = null; dirty = true; }
                }
                if (dirty) {
                    const active = core.currentPlayer(this.state);
                    if (active?.status === "online") this.state.turnStartedAt = Date.now();
                    if (this.isHost()) this.commit("presenceChanged", {});
                    else this.changed();
                }
            }
            this.seenRoomMembers = current;
        }

        tick() {
            if (!this.state) return;
            const now = Date.now();
            if (this.isHost()) {
                const active = core.currentPlayer(this.state);
                const deadline = Number(this.state.turnStartedAt || now) + Number(this.state.rules.turnSeconds || 45) * 1000;
                if (this.state.phase === "playing" && active?.status === "online" && now >= deadline) {
                    const result = core.drawForTurn(this.state, active.memberNumber);
                    if (result.ok && result.playable) core.passAfterDraw(this.state, active.memberNumber);
                    this.state.turnStartedAt = now;
                    this.commit("turnTimedOut", { memberNumber: active.memberNumber, name: active.name });
                }
                const expired = this.state.players.filter(p => p.status === "disconnected" && now - p.disconnectedAt >= this.state.rules.reconnectSeconds * 1000);
                for (const player of expired) core.removePlayer(this.state, player.memberNumber);
                if (expired.length) this.commit("playersTimedOut", { players: expired.map(p => p.name) });
                if (this.state.vote?.endsAt <= now) this.resolveVote(false);
            } else {
                const host = this.state.players.find(p => p.memberNumber === this.state.hostId);
                if (host?.status === "disconnected" && now - host.disconnectedAt >= this.state.rules.reconnectSeconds * 1000) this.tryTakeover();
            }
            if (this.pendingTransfer?.expiresAt <= now) this.pendingTransfer = null;
            for (const [target, invite] of this.outgoingInvites) {
                if (invite.acknowledged || now - invite.sentAt < 2000) continue;
                if (invite.attempts >= 3) {
                    this.outgoingInvites.delete(target);
                    this.notify("inviteNoResponse", { name: this.peers.get(target)?.name || target });
                    continue;
                }
                invite.attempts++;
                invite.sentAt = now;
                this.transport.send("INVITE", {
                    lobbyId: invite.lobbyId, hostId: this.localId,
                    hostName: this.localPlayer().name, game: "uno",
                }, target);
            }
        }

        tryTakeover() {
            const candidates = this.state.players.filter(p => p.status === "online" && p.memberNumber !== this.state.hostId);
            if (!candidates.length || candidates[0].memberNumber !== this.localId) return;
            this.state.hostId = this.localId;
            this.state.hostEpoch++;
            this.state.revision = 0;
            this.commit("hostTakenOver", { hostId: this.localId });
        }

        handle(packet) {
            const sender = Number(packet.from);
            switch (packet.type) {
                case "HELLO":
                    this.rememberPeer(sender, packet);
                    this.transport.send("HELLO_ACK", { version: "0.2.1", name: this.localPlayer().name }, sender);
                    if (this.isHost() && this.lobby) this.broadcastLobby();
                    if (this.isHost() && this.state) this.commit("sync", {});
                    break;
                case "HELLO_ACK":
                    this.rememberPeer(sender, packet);
                    break;
                case "INVITE":
                    if (!this.state && packet.game === "uno" && packet.hostId === sender) {
                        this.transport.send("INVITE_ACK", { lobbyId: packet.lobbyId }, sender);
                        this.pendingInvite = { lobbyId: packet.lobbyId, hostId: sender, hostName: String(packet.hostName || sender), receivedAt: Date.now() };
                        this.notify("inviteReceived", { name: this.pendingInvite.hostName });
                        this.changed();
                    }
                    break;
                case "INVITE_ACK": {
                    const outgoing = this.outgoingInvites.get(sender);
                    if (outgoing?.lobbyId === packet.lobbyId && !outgoing.acknowledged) {
                        outgoing.acknowledged = true;
                        this.notify("inviteDelivered", { name: this.peers.get(sender)?.name || sender });
                    }
                    break;
                }
                case "INVITE_DECLINE":
                    if (this.isHost() && this.lobby?.lobbyId === packet.lobbyId) {
                        this.lobby.invited = this.lobby.invited.filter(id => id !== sender);
                        this.outgoingInvites.delete(sender);
                        this.notify("inviteDeclined", { name: this.peers.get(sender)?.name || sender });
                        this.broadcastLobby(); this.changed();
                    }
                    break;
                case "LOBBY_STATE":
                    if (!this.state && packet.lobby?.hostId === sender
                        && packet.lobby.players?.some(p => p.memberNumber === this.localId)) {
                        this.lobby = packet.lobby; this.changed();
                    }
                    break;
                case "LOBBY_JOIN":
                    if (this.isHost() && this.lobby?.lobbyId === packet.lobbyId && this.lobby.players.length < 10 && !this.lobby.players.some(p => p.memberNumber === sender)) {
                        this.lobby.players.push({ memberNumber: sender, name: String(packet.name || sender), ready: true });
                        this.outgoingInvites.delete(sender); this.broadcastLobby(); this.changed();
                    }
                    break;
                case "LOBBY_LEAVE":
                    if (this.isHost() && this.lobby?.lobbyId === packet.lobbyId) { this.lobby.players = this.lobby.players.filter(p => p.memberNumber !== sender); this.broadcastLobby(); this.changed(); }
                    break;
                case "LOBBY_CLOSE": if (this.lobby?.lobbyId === packet.lobbyId && sender === this.lobby.hostId) { this.lobby = null; this.changed(); } break;
                case "PLAY_REQUEST": if (this.isHost() && packet.gameId === this.state?.gameId) this.hostPlay(sender, packet); break;
                case "DRAW_REQUEST": if (this.isHost() && packet.gameId === this.state?.gameId) this.hostDraw(sender); break;
                case "PASS_REQUEST": if (this.isHost() && packet.gameId === this.state?.gameId) this.hostPass(sender); break;
                case "PLAYER_LEAVE": if (this.isHost() && packet.gameId === this.state?.gameId && core.removePlayer(this.state, sender)) this.commit("playerLeft", { memberNumber: sender }); break;
                case "STATE": this.acceptState(packet, sender); break;
                case "ACTION_REJECTED": this.notify(packet.error); break;
                case "HOST_TRANSFER_PROPOSE":
                    if (packet.gameId === this.state?.gameId && sender === this.state.hostId && packet.state) {
                        this.state = packet.state; this.transport.send("HOST_TRANSFER_ACCEPT", { gameId: packet.gameId }, sender); this.changed();
                    }
                    break;
                case "HOST_TRANSFER_ACCEPT":
                    if (this.pendingTransfer?.targetId === sender && packet.gameId === this.state?.gameId) {
                        this.state.hostId = sender; this.state.hostEpoch++; this.state.revision = 0;
                        this.transport.send("HOST_TRANSFER_COMMIT", { gameId: this.state.gameId, hostId: sender, hostEpoch: this.state.hostEpoch, state: this.state });
                        this.pendingTransfer = null; this.changed();
                    }
                    break;
                case "HOST_TRANSFER_COMMIT":
                    if (packet.gameId === this.state?.gameId && packet.state && packet.hostEpoch > this.state.hostEpoch) { this.state = packet.state; this.changed(); }
                    break;
                case "VOTE_START": if (this.isHost() && packet.gameId === this.state?.gameId) this.hostStartVote(sender, packet.kind); break;
                case "VOTE_CAST": if (this.isHost() && packet.gameId === this.state?.gameId && packet.voteId === this.state.vote?.id) this.hostCastVote(sender, packet.yes); break;
            }
        }

        acceptState(packet, sender) {
            const incoming = packet.state;
            if (!incoming || sender !== Number(incoming.hostId) || incoming.game !== "uno") return;
            if (this.state) {
                if (incoming.gameId !== this.state.gameId) return;
                if (incoming.hostEpoch < this.state.hostEpoch) return;
                if (incoming.hostEpoch === this.state.hostEpoch && incoming.revision <= this.state.revision) return;
            }
            this.state = incoming;
            this.lobby = null;
            this.action(packet.event, packet.eventData || {}, incoming);
            this.changed();
        }

        rememberPeer(sender, packet) {
            if (!Number.isFinite(sender) || sender === this.localId) return;
            const room = this.roomPlayers().find(p => p.memberNumber === sender);
            this.peers.set(sender, {
                memberNumber: sender,
                name: String(packet.name || room?.name || sender),
                version: String(packet.version || "unknown"),
                lastSeen: Date.now(),
            });
            this.changed();
        }

        destroy() {
            clearInterval(this.presenceTimer); clearInterval(this.tickTimer); clearInterval(this.helloTimer);
            this.listeners.clear();
        }
    }

    return { Controller };
});
