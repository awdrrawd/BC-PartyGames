// Modular development entry. The installable dist bundle is assembled from
// the same modules by scripts/build.mjs.
window.Liko = window.Liko || {};

if (window.Liko.BCPartyGames) {
    console.warn('[BC PartyGames] Already loaded, skipping duplicate init.');
} else {
    const namespace = window.Liko.BCPartyGames = {};
    import('./core.js').then(() => Promise.all([
        import('./transport.js'),
        import('./controller.js'),
        import('./ui.js'),
        import('../Translation/PartyGames-i18n.js'),
    ])).then(() => import('./app.js')).catch(error => {
        if (window.Liko.BCPartyGames === namespace && !namespace.version) delete window.Liko.BCPartyGames;
        console.error('[BC PartyGames] Failed to load:', error);
    });
}
