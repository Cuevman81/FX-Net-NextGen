// ═══════════════════════════════════════════════════════════════════════════════
// FX-Net NextGen | Tactical Meteorological Workstation
// (c) 2026 Rodney Cuevas, Meteorologist
// MapLibre GL JS v3.6.2 — Dark AWIPS-like UI
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

// ═══ NETWORK DEADLINE ═══
// Every feed call gets a deadline. Without one, a hung upstream leaves the
// promise pending forever: the refresh that fired it never settles, its Data
// Health row keeps reporting the last good stamp instead of going red, and each
// later tick stacks another dead request behind it. Installed once here rather
// than at ~70 call sites so no future fetch can be forgotten. Requests that
// bring their own signal (MapLibre's tile cancellation) are passed through
// untouched — MapLibre aborts those itself when a tile leaves the viewport.
const FETCH_TIMEOUT_MS = 45000;
(function installFetchDeadline() {
    if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return;
    const nativeFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
        if (init && init.signal) return nativeFetch(input, init);
        return nativeFetch(input, Object.assign({}, init, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }));
    };
})();

// Collapse overlapping refreshes of the same feed. The fast pollers (15 s
// warning/watch sweeps) can otherwise re-enter while the previous sweep is
// still in flight on a slow link, doubling load and interleaving two sets of
// results into the same layer.
const _refreshInFlight = new Set();
function guardedRefresh(key, fn) {
    if (_refreshInFlight.has(key)) return Promise.resolve();
    _refreshInFlight.add(key);
    return Promise.resolve()
        .then(fn)
        .catch(e => { addLiveLog(`REFRESH (${key}): ${e.message}`, '#ff3333'); })
        .finally(() => _refreshInFlight.delete(key));
}

// ═══ BACKGROUND-TAB PAUSE ═══
// Every poller in the app is a setInterval, and a tab nobody was looking at
// still ran all of them — the 15 s warning and watch sweeps, the 1 s clock,
// every feed refresh — at full rate for a whole shift. Patched once here, like
// the fetch deadline: while the document is hidden a tick is skipped and
// remembered, and the moment the tab is visible again each skipped callback
// runs once, so the display catches up in one pass instead of drifting in over
// the next few minutes. Intervals MapLibre created before this ran are
// untouched. Workspace tabs (panes alive across the app's own tabs) are a
// different thing and unaffected.
(function installVisibilityPause() {
    if (typeof document === 'undefined' || !('hidden' in document)) return;
    const nativeSetInterval = window.setInterval.bind(window);
    const nativeClearInterval = window.clearInterval.bind(window);
    const missed = new Map();   // interval id -> the callback it skipped
    window.setInterval = function (fn, ms, ...args) {
        if (typeof fn !== 'function') return nativeSetInterval(fn, ms, ...args);
        let id;
        id = nativeSetInterval(() => {
            if (document.hidden) { missed.set(id, () => fn(...args)); return; }
            fn(...args);
        }, ms);
        return id;
    };
    window.clearInterval = function (id) { missed.delete(id); return nativeClearInterval(id); };
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;
        const run = [...missed.values()];
        missed.clear();
        run.forEach(fn => { try { fn(); } catch (e) { console.error('catch-up tick failed:', e); } });
    });
})();

// ═══ PRODUCT BROWSER: KEYBOARD ═══
// The product rows are <div role="button" tabindex="0">. One delegated
// listener makes Enter and Space act as a click for all of them, and the
// observer mirrors the .active class into aria-pressed no matter which of the
// several toggle paths (click, workspace restore, site change) flipped it.
(function installProductKeyboard() {
    document.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const el = e.target && e.target.closest ? e.target.closest('.product-item') : null;
        if (!el || el !== e.target) return;   // a control inside the row keeps its own keys
        e.preventDefault();
        el.click();
    });
    const mirror = el => el.setAttribute('aria-pressed', el.classList.contains('active') ? 'true' : 'false');
    document.querySelectorAll('.product-item').forEach(mirror);
    new MutationObserver(muts => muts.forEach(m => {
        const t = m.target;
        if (t && t.classList && t.classList.contains('product-item')) mirror(t);
    })).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
})();

// ═══ GLOBAL STATE ═══
const maps = {};
let activePaneId = 't1-1';

// ═══ WORKSPACE TABS ═══
// Each tab is an independent multi-pane workspace with its OWN grid + maps that
// stay alive in the background. Pane ids are namespaced as `<tabId>-<n>` (e.g.
// 't1-1'..'t1-8', 't2-1'...), so the existing per-pane state objects (maps,
// paneRadarSites, paneGibs, …) and activePaneId keep working with these opaque
// string keys. `tabOfPane()` recovers the tab from a pane id so per-tab actions
// (pan/zoom sync, looping, layout) can be scoped to one workspace.
const TAB_PANE_COUNT = 8;
const tabs = {};            // tabId -> { id, name, layout }
let activeTabId = 't1';
let tabSeq = 1;             // monotonic counter for unique tab ids
const tabOfPane = paneId => String(paneId).split('-')[0];
const paneIdsForTab = tabId => Array.from({ length: TAB_PANE_COUNT }, (_, i) => `${tabId}-${i + 1}`);
const isPaneInActiveTab = paneId => tabOfPane(paneId) === activeTabId;
const activeTabMapEntries = () => Object.entries(maps).filter(([id]) => tabOfPane(id) === activeTabId);
let isPlaying = false;
let isPaused = false;
let animationTimer = null;
let animationFrameIndex = 0;
let animationFrames = [];
let animSatFrames = [];
let animRadFrames = [];
let animLastSi = -1;
// ═══ RADAR FEED RESOLUTION MODE ═══
// Set to true to test NCEP OpenGeo Super-Res (0.25km raw radial gates). Set to false to revert to standard Level III.
const USE_SUPER_RES_RADAR = false;

let animLastRi = -1;
let animL3Frames = {};      // paneId -> [{image, coordinates, time, label}] (NODD L3 loop frames)
let animL3Count = 0;        // longest per-pane L3 frame list in the current loop
let animL3Last = {};        // paneId -> last rendered L3 frame index
let loopDirection = 1;      // +1 forward, -1 reverse (used by Rock mode)
// ── Time-match tables (AWIPS-style) ──
// masterFrame index -> that stream's frame index. Streams run at different
// cadences (5-min radar vs 10-min satellite vs ~6-min L3 volume scans), so
// stepping every stream by position marched the coarse ones ahead of the fine
// ones and then froze them on their newest frame. These tables map each master
// time to the newest frame at or before it, so every stream shows the data that
// was actually valid at the frame's time.
let animSatIndex = [];
let animRadIndex = [];
let animL3Index = {};       // paneId -> index table
let preAnimVisibility = {}; // Stores layer visibility before loop starts
// Default radar mode = National Mosaic so "Reflectivity" shows CONUS, not a distant single site.
// (A real site code here switches that pane to single-site products via the SITE selector.)
let paneRadarSites = { '1': 'nexrad-n0q-900913', '2': 'nexrad-n0q-900913', '3': 'nexrad-n0q-900913', '4': 'nexrad-n0q-900913', '5': 'nexrad-n0q-900913', '6': 'nexrad-n0q-900913', '7': 'nexrad-n0q-900913', '8': 'nexrad-n0q-900913' };
let paneRadarProducts = { '1': 'sr_bref', '2': 'sr_bref', '3': 'sr_bref', '4': 'sr_bref', '5': 'sr_bref', '6': 'sr_bref', '7': 'sr_bref', '8': 'sr_bref' };
// NEXRAD Level III (NODD) overlay state, per pane: { station, product, meta }
let paneL3 = {};
// NASA GIBS satellite product active per pane (product key) or undefined
let paneGibs = {};
// Valid time (ISO Z string) of the GIBS frame currently painted in each pane
let paneGibsTime = {};
// Which bird the pane's GIBS layer was built from, so a sector change that
// switches birds rebuilds the source instead of retiling the wrong satellite.
let paneGibsBird = {};
let activeGoesChannel = null; // Convenience: always mirrors paneGoesChannels[activePaneId]
let paneGoesChannels = { '1': null, '2': null, '3': null, '4': null, '5': null, '6': null, '7': null, '8': null };
// GOES bird + sector per pane (key into GOES_SECTORS). Drives both the IEM
// per-channel tiles and which bird the GIBS products load. Absent = east-conus.
let paneGoesSector = {};
let activeRadarNational = false;
let activeSiteRadar = { bref: false, bvel: false, bdhc: false };
let cursorMarkers = {}; // Synchronized tactical cursor shadows
let isDataSamplerActive = false; // Real-time RGB radar pixel sampling
let metarsLoaded = false;
let metarGeoJSON = { type: 'FeatureCollection', features: [] };
let latestMetarTime = null;
let latestHmsTime = null;
let warningsSeen = new Set();
let warningsFirstLoad = true;
let warningsLoaded = false;
let lastIbwCount = 0;
let warningsGeoJSON = { type: 'FeatureCollection', features: [] };
// Warning display mode: false = filled polygons (default), true = bold colored
// outlines with minimal fill so numerous overlapping warnings stay legible.
let warningOutlineMode = (() => { try { return localStorage.getItem('fxnet_warn_outline') === '1'; } catch (e) { return false; } })();

// Escape feed-derived text before interpolating into innerHTML. NWS/CAP alert
// text, LSR spotter remarks, gauge names, etc. originate from many upstream
// systems — never trust them as markup.
function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

// A feed-supplied link is only ever rendered as an https URL. Anything else
// (javascript:, data:, a relative path, junk) collapses to '' and the anchor
// is simply not drawn.
function safeHttpsUrl(u) {
    const s = String(u ?? '').trim();
    return /^https:\/\/[^\s"'<>]+$/i.test(s) ? esc(s) : '';
}

// Severity priority for warning z-order. Higher = more urgent = drawn LAST in
// source order so it renders on top where polygons overlap.
function warningPriority(ev) {
    if (!ev) return 30;
    if (ev === 'Tornado Warning') return 100;
    if (ev === 'Severe Thunderstorm Warning') return 80;
    if (ev === 'Flash Flood Warning') return 75;
    if (ev === 'Special Marine Warning') return 45;
    if (ev.includes('Warning')) return 60;
    if (ev.includes('Watch')) return 40;
    if (ev.includes('Advisory')) return 35;
    if (ev.includes('Statement')) return 20;
    if (ev.includes('Outlook')) return 10;
    return 30;
}
// Sort ascending so the most severe warning ends up last (= on top within a layer).
function sortWarningsByPriority(fc) {
    if (fc && Array.isArray(fc.features)) {
        fc.features.sort((a, b) => warningPriority(a.properties && a.properties.event) - warningPriority(b.properties && b.properties.event));
    }
    return fc;
}

// Fill-opacity / outline-width expressions for the two display modes.
const WARN_FILL_OPACITY_FILLED = ['case',
    ['==', ['get', 'event'], 'Tornado Warning'], 0.6,
    ['==', ['get', 'event'], 'Severe Thunderstorm Warning'], 0.5,
    ['==', ['get', 'event'], 'Flash Flood Warning'], 0.5,
    ['in', 'Warning', ['get', 'event']], 0.4,
    ['in', 'Statement', ['get', 'event']], 0.25,
    ['in', 'Outlook', ['get', 'event']], 0.2,
    0.35
];
const WARN_FILL_OPACITY_OUTLINE = ['case',
    ['==', ['get', 'event'], 'Tornado Warning'], 0.18,
    ['==', ['get', 'event'], 'Severe Thunderstorm Warning'], 0.14,
    ['in', 'Warning', ['get', 'event']], 0.1,
    0.07
];
const WARN_OUTLINE_WIDTH_FILLED = ['case',
    ['==', ['get', 'event'], 'Tornado Warning'], 3.5,
    ['==', ['get', 'event'], 'Severe Thunderstorm Warning'], 2.5,
    ['==', ['get', 'event'], 'Flash Flood Warning'], 2.5,
    ['in', 'Warning', ['get', 'event']], 2.0,
    ['in', 'Statement', ['get', 'event']], 1.0,
    1.5
];
const WARN_OUTLINE_WIDTH_OUTLINE = ['case',
    ['==', ['get', 'event'], 'Tornado Warning'], 4.5,
    ['==', ['get', 'event'], 'Severe Thunderstorm Warning'], 3.5,
    ['==', ['get', 'event'], 'Flash Flood Warning'], 3.5,
    ['in', 'Warning', ['get', 'event']], 3.0,
    ['in', 'Statement', ['get', 'event']], 2.0,
    2.5
];

// Apply the current warning display mode (filled vs outline) to one map.
// Covers both the Warnings stack and the Advisories/Statements stack.
function applyWarningDisplayMode(map) {
    if (!map || !map.getLayer || !map.getLayer('nws-warnings-only-fill')) return;
    const outline = warningOutlineMode;
    const warningsOn = isLayerVisible(map, 'nws-warnings-only-fill');
    const advisOn = isLayerVisible(map, 'nws-advis-fill');
    try {
        map.setPaintProperty('nws-warnings-only-fill', 'fill-opacity', outline ? WARN_FILL_OPACITY_OUTLINE : WARN_FILL_OPACITY_FILLED);
        map.setPaintProperty('nws-warnings-only-outline', 'line-width', outline ? WARN_OUTLINE_WIDTH_OUTLINE : WARN_OUTLINE_WIDTH_FILLED);
        map.setLayoutProperty('nws-warnings-only-casing', 'visibility', (outline && warningsOn) ? 'visible' : 'none');
        map.setPaintProperty('nws-advis-fill', 'fill-opacity', outline ? WARN_FILL_OPACITY_OUTLINE : WARN_FILL_OPACITY_FILLED);
        map.setPaintProperty('nws-advis-outline', 'line-width', outline ? WARN_OUTLINE_WIDTH_OUTLINE : WARN_OUTLINE_WIDTH_FILLED);
        map.setLayoutProperty('nws-advis-casing', 'visibility', (outline && advisOn) ? 'visible' : 'none');
    } catch (e) { }
}
function applyWarningDisplayModeAll() {
    Object.values(maps).forEach(applyWarningDisplayMode);
}
// Reflect the current mode in the context-menu item label.
function updateWarnModeLabel() {
    const el = document.querySelector('.warn-mode-label');
    if (el) el.textContent = warningOutlineMode ? 'Warnings: Outline (overlap-safe)' : 'Warnings: Filled';
}

const zoneGeometryCache = {};  // Global cache for NWS zone polygons (persists across polling cycles)
let watchesLoaded = false;
let watchesGeoJSON = { type: 'FeatureCollection', features: [] };
let greatLakesLoaded = false;
let greatLakesGeoJSON = { type: 'FeatureCollection', features: [] };
let activeSpcDay = null;
// Per-pane product selections for tile-swap WMS layers. These MUST be keyed by
// pane — a single global + retiling every map's shared source made Panel 4's
// QPF flip to whatever Panel 2 selected (the "mirrored WPC QPF" bug).
let paneQpf = {};          // paneId -> WPC QPF sublayer id
let paneMrmsQpe = {};      // paneId -> MRMS QPE period ('1h'|'24h'|'48h'|'72h')
let paneCpcTemp = {};      // paneId -> CPC temp outlook period
let paneCpcPrecip = {};    // paneId -> CPC precip outlook period
const qpfWmsUrl = qpfId =>
    `https://mapservices.weather.noaa.gov/vector/rest/services/precip/wpc_qpf/MapServer/export?bbox={bbox-epsg-3857}&bboxSR=102100&layers=show:${qpfId}&size=512,512&imageSR=102100&format=png32&transparent=true&f=image`;
const mrmsQpeWmsUrl = period => {
    const layerMap = { '1h': 'mrms_p1h', '24h': 'mrms_p24h', '48h': 'mrms_p48h', '72h': 'mrms_p72h' };
    return `https://mesonet.agron.iastate.edu/cgi-bin/wms/us/mrms_nn.cgi?service=WMS&version=1.1.1&request=GetMap&layers=${layerMap[period] || 'mrms_p1h'}&format=image/png&transparent=true&styles=&srs=EPSG:3857&width=256&height=256&bbox={bbox-epsg-3857}`;
};
let isSyncingMaps = false;
// Panes pinned to an independent view — they neither drive nor follow the
// tab's pan/zoom sync. Session-only (resets on reload). Keyed by pane id.
const paneSyncDisabled = new Set();
let aqiFcstSeq = 0;   // unique-id counter for async AQI forecast popup injection

// ═══ DATA HEALTH SYSTEM ═══
const healthTrackers = {};
const HEALTH_THRESHOLDS = {
    radar:    { label: 'NEXRAD Radar',    thresholdMs: 6 * 60 * 1000 },
    sat:      { label: 'GOES Satellite',  thresholdMs: 10 * 60 * 1000 },
    lightning:{ label: 'NLDN Lightning',  thresholdMs: 30 * 60 * 1000 },
    metar:    { label: 'METAR Obs',       thresholdMs: 30 * 60 * 1000 },
    warnings: { label: 'NWS Warnings',    thresholdMs: 15 * 60 * 1000 },
    watches:  { label: 'NWS Watches',     thresholdMs: 15 * 60 * 1000 },
    hms:      { label: 'HMS Smoke',       thresholdMs: 4 * 60 * 60 * 1000 },
    aqi:      { label: 'AirNow AQI',      thresholdMs: 2 * 60 * 60 * 1000 },
    firms:    { label: 'FIRMS Fires',     thresholdMs: 4 * 60 * 60 * 1000 },
    wpcIsobars: { label: 'WPC Isobars',   thresholdMs: 5.5 * 60 * 60 * 1000 },
    // Aged against the bulletin's own VALID time, not our fetch. WPC analyses
    // every 3 h and posts ~1-1.5 h after valid time, so the live product is
    // legitimately ~4.5 h old just before the next one lands; 5.5 h flags a
    // genuinely stalled analysis without crying wolf every cycle.
    wpcFronts:  { label: 'WPC Fronts/HL', thresholdMs: 5.5 * 60 * 60 * 1000 },
    wpcQpf:     { label: 'WPC QPF',       thresholdMs: 8 * 60 * 60 * 1000 },
    radarL3:    { label: 'NODD Dual-Pol', thresholdMs: 15 * 60 * 1000 },
    gibsSat:    { label: 'GIBS Satellite', thresholdMs: 60 * 60 * 1000 },
    wpcEro:     { label: 'WPC ERO',       thresholdMs: 12 * 60 * 60 * 1000 },
    // Stamped with the source's own advisory/ingest time, not our fetch time.
    // Advisories land every 6 h (3 h when intermediates run) and the files publish
    // ~40 min after synoptic time, so 8 h means the feed itself has stalled.
    nhcStorms:  { label: 'NHC Storms',    thresholdMs: 8 * 60 * 60 * 1000 },
    nhcOutlook: { label: 'NHC Outlook',   thresholdMs: 6 * 60 * 60 * 1000 },
    spcOutlook: { label: 'SPC Outlooks',   thresholdMs: 60 * 60 * 1000 },
    spcFireWx:  { label: 'SPC Fire Wx',    thresholdMs: 12 * 60 * 60 * 1000 },
    spcMd:      { label: 'SPC MDs',       thresholdMs: 30 * 60 * 1000 },
    wpcMpd:     { label: 'WPC MPDs',      thresholdMs: 60 * 60 * 1000 },
    spcLsr:     { label: 'SPC LSRs',      thresholdMs: 30 * 60 * 1000 },
    cpcTemp:    { label: 'CPC Temp',      thresholdMs: 24 * 60 * 60 * 1000 },
    cpcPrecip:  { label: 'CPC Precip',    thresholdMs: 24 * 60 * 60 * 1000 },
    drought:    { label: 'Drought Monitor', thresholdMs: 7 * 24 * 60 * 60 * 1000 },
    riverGauges:  { label: 'River Gauges',   thresholdMs: 30 * 60 * 1000 },
    mrmsEchotops: { label: 'MRMS Echo Tops', thresholdMs: 30 * 60 * 1000 },
    mrmsQpe:      { label: 'MRMS QPE',       thresholdMs: 30 * 60 * 1000 },
    solar:        { label: 'Solar/Terminator', thresholdMs: 10 * 60 * 1000 },
    sfcIsobars2mb:    { label: 'Isobars 2mb',       thresholdMs: 15 * 60 * 1000 },
    sfcIsotherms:     { label: 'Isotherms',          thresholdMs: 15 * 60 * 1000 },
    sfcIsodrosotherms:{ label: 'Isodrosotherms',     thresholdMs: 15 * 60 * 1000 },
    sfcRelh:          { label: 'Rel Humidity',       thresholdMs: 15 * 60 * 1000 },
    sfcIsotachs:      { label: 'Isotachs',           thresholdMs: 15 * 60 * 1000 },
    sfcApparent:      { label: 'Apparent Temp',      thresholdMs: 15 * 60 * 1000 },
    probSevere:  { label: 'ProbSevere',       thresholdMs: 5 * 60 * 1000 },
    nexradAttr:  { label: 'Storm Attributes', thresholdMs: 15 * 60 * 1000 },
    ndfdTemp:    { label: 'NDFD Temp',        thresholdMs: 2 * 60 * 60 * 1000 },
    airSigmet:   { label: 'SIGMET/AIRMET',    thresholdMs: 20 * 60 * 1000 },
    gairmet:     { label: 'G-AIRMET',         thresholdMs: 20 * 60 * 1000 },
    pireps:      { label: 'PIREPs',           thresholdMs: 20 * 60 * 1000 },
    taf:         { label: 'TAF',              thresholdMs: 30 * 60 * 1000 },
    cwa:         { label: 'CWAs',             thresholdMs: 20 * 60 * 1000 },
    ndbc:        { label: 'NDBC Buoys',       thresholdMs: 30 * 60 * 1000 },
    reconHdob:   { label: 'Recon HDOB Feed',  thresholdMs: 40 * 60 * 1000 },
    adeck:       { label: 'Model Guidance',   thresholdMs: 8 * 60 * 60 * 1000 }
};

// Data-health feeds organized into collapsible sections that mirror the left
// sidebar's categories. Order is the display order; each entry lists the
// tracker ids that belong under that header.
const HEALTH_GROUPS = [
    { name: 'RADAR & LIGHTNING', ids: ['radar', 'radarL3', 'nexradAttr', 'mrmsEchotops', 'mrmsQpe', 'lightning'] },
    { name: 'SATELLITE',         ids: ['sat', 'gibsSat'] },
    { name: 'SURFACE ANALYSIS',  ids: ['metar', 'ndbc', 'sfcIsobars2mb', 'sfcIsotherms', 'sfcIsodrosotherms', 'sfcRelh', 'sfcIsotachs', 'sfcApparent', 'wpcIsobars', 'wpcFronts', 'ndfdTemp'] },
    { name: 'WARNINGS & WATCHES',ids: ['warnings', 'watches'] },
    { name: 'SPC PRODUCTS',      ids: ['spcOutlook', 'spcMd', 'spcLsr', 'probSevere'] },
    { name: 'AVIATION',          ids: ['airSigmet', 'gairmet', 'pireps', 'taf', 'cwa'] },
    { name: 'WPC PRODUCTS',      ids: ['wpcQpf', 'wpcEro', 'wpcMpd'] },
    { name: 'TROPICAL',          ids: ['nhcStorms', 'nhcOutlook', 'reconHdob', 'adeck'] },
    { name: 'CLIMATE & OUTLOOKS',ids: ['cpcTemp', 'cpcPrecip', 'drought'] },
    { name: 'FIRE & AIR',        ids: ['firms', 'hms', 'spcFireWx', 'aqi'] },
    { name: 'HYDRO & SOLAR',     ids: ['riverGauges', 'solar'] }
];

// ═══ US STATE CODES (all 50 for METAR fetch) ═══
const US_STATES = [
    'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
    'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
    'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
    'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
    'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'
];

// ═══ IEM RADAR ANIMATION FRAME NAMES ═══
const RADAR_ANIM_LAYERS = [
    { name: 'nexrad-n0q',      offsetMin: 0 },
    { name: 'nexrad-n0q-m05m', offsetMin: 5 },
    { name: 'nexrad-n0q-m10m', offsetMin: 10 },
    { name: 'nexrad-n0q-m15m', offsetMin: 15 },
    { name: 'nexrad-n0q-m20m', offsetMin: 20 },
    { name: 'nexrad-n0q-m25m', offsetMin: 25 },
    { name: 'nexrad-n0q-m30m', offsetMin: 30 },
    { name: 'nexrad-n0q-m35m', offsetMin: 35 },
    { name: 'nexrad-n0q-m40m', offsetMin: 40 },
    { name: 'nexrad-n0q-m45m', offsetMin: 45 },
    { name: 'nexrad-n0q-m50m', offsetMin: 50 },
    { name: 'nexrad-n0q-m55m', offsetMin: 55 }
];

// ═══ GOES SATELLITE — BIRDS & SECTORS ═══
// GOES-East (75°W) and GOES-West (137°W). `sats` is tried in order so a platform
// swap (GOES-19 -> a successor) degrades to "no timestamp" instead of breaking.
const GOES_BIRDS = {
    east: { label: 'GOES-East', short: 'GOES-E', lon0: -75,  sats: ['GOES-19', 'GOES-16'] },
    west: { label: 'GOES-West', short: 'GOES-W', lon0: -137, sats: ['GOES-18', 'GOES-17'] }
};

// IEM per-channel tile caches, layer pattern: goes_{bird}_{tile}_ch{NN}.
// Every entry below was probed live; the combinations IEM does NOT publish
// (GOES-East Alaska/Hawaii, GOES-West Puerto Rico, American Samoa) are absent
// rather than listed and broken.
//   dir       archive folder holding the valid-time JSON + world file. Hawaii
//             serves tiles but has no folder — it is cut from the GOES-West full
//             disk scan (identical valid times), so it reads that folder instead.
//   cadenceMs ABI scan interval: mesoscale 1 min, CONUS/PACUS 5 min, full disk
//             10 min. Alaska and Hawaii are full-disk cuts, so they follow it.
//   floater   sector roams with the event, so its extent must be read at runtime.
// NOTE: IEM's "full disk" cache is a northern-hemisphere crop (equator to ~68°N),
// not the whole disk — hence the label. NASA GIBS covers both hemispheres.
const GOES_SECTORS = {
    'east-conus':      { bird: 'east', tile: 'conus',       dir: 'conus',       label: 'CONUS',                   cadenceMs:  5 * 60 * 1000 },
    'east-fulldisk':   { bird: 'east', tile: 'fulldisk',    dir: 'fulldisk',    label: 'Full Disk (N Hem)',       cadenceMs: 10 * 60 * 1000 },
    'east-puertorico': { bird: 'east', tile: 'puertorico',  dir: 'puertorico',  label: 'Puerto Rico / Caribbean', cadenceMs:  5 * 60 * 1000 },
    'east-meso1':      { bird: 'east', tile: 'mesoscale-1', dir: 'mesoscale-1', label: 'Mesoscale 1 (floater)',   cadenceMs:       60 * 1000, floater: true },
    'east-meso2':      { bird: 'east', tile: 'mesoscale-2', dir: 'mesoscale-2', label: 'Mesoscale 2 (floater)',   cadenceMs:       60 * 1000, floater: true },
    'west-conus':      { bird: 'west', tile: 'conus',       dir: 'conus',       label: 'PACUS (West CONUS)',      cadenceMs:  5 * 60 * 1000 },
    'west-fulldisk':   { bird: 'west', tile: 'fulldisk',    dir: 'fulldisk',    label: 'Full Disk (N Hem)',       cadenceMs: 10 * 60 * 1000 },
    'west-alaska':     { bird: 'west', tile: 'alaska',      dir: 'alaska',      label: 'Alaska',                  cadenceMs: 10 * 60 * 1000 },
    // Hawaii has no archive folder, so no world file to derive an extent from —
    // this bbox was measured off the tile pyramid. Fixed sector, so it keeps.
    'west-hawaii':     { bird: 'west', tile: 'hawaii',      dir: null,          label: 'Hawaii',                  cadenceMs: 10 * 60 * 1000, bbox: [[-175, 13], [-123, 45]] },
    'west-meso1':      { bird: 'west', tile: 'mesoscale-1', dir: 'mesoscale-1', label: 'Mesoscale 1 (floater)',   cadenceMs:       60 * 1000, floater: true },
    'west-meso2':      { bird: 'west', tile: 'mesoscale-2', dir: 'mesoscale-2', label: 'Mesoscale 2 (floater)',   cadenceMs:       60 * 1000, floater: true }
};

const DEFAULT_GOES_SECTOR = 'east-conus';
function goesSectorDef(key) { return GOES_SECTORS[key] || GOES_SECTORS[DEFAULT_GOES_SECTOR]; }
function goesSectorFor(paneId) { return GOES_SECTORS[paneGoesSector[paneId]] ? paneGoesSector[paneId] : DEFAULT_GOES_SECTOR; }
function goesBirdFor(paneId) { return goesSectorDef(goesSectorFor(paneId)).bird; }
function goesSectorLabel(key) {
    const s = goesSectorDef(key);
    return `${GOES_BIRDS[s.bird].short} ${s.label.replace(/ \(floater\)$/, '')}`;
}

// ─── Sector extent, for "zoom to sector" ───
// IEM publishes a world file and the image itself beside every sector, both
// CORS-open and Range-capable, so the true footprint costs two tiny reads: the
// .wld affine (pixel size + upper-left corner, in GOES fixed-grid metres) and the
// 33-byte PNG header (image dimensions). That beats hardcoding extents, which
// would be wrong for the mesoscale sectors — they roam with the event.
const GEOS_SAT_H = 35786023.0;    // satellite height above the ellipsoid (m)
const GEOS_H     = 42164160.0;    // ... measured from the earth's centre
const GEOS_R_EQ  = 6378137.0;
const GEOS_R_POL = 6356752.31414;
const GEOS_RATIO = (GEOS_R_EQ * GEOS_R_EQ) / (GEOS_R_POL * GEOS_R_POL);

// Inverse geostationary projection (sweep=x, as the GOES-R series flies):
// fixed-grid metres -> [lon, lat]. Returns null where the ray misses the earth,
// which is what lets full-disk sampling find the limb instead of reporting the
// image corners (those are space).
function geosInverse(xm, ym, lon0) {
    const x = xm / GEOS_SAT_H, y = ym / GEOS_SAT_H;
    const sx = Math.sin(x), cx = Math.cos(x), sy = Math.sin(y), cy = Math.cos(y);
    const a = sx * sx + cx * cx * (cy * cy + GEOS_RATIO * sy * sy);
    const b = -2 * GEOS_H * cx * cy;
    const c = GEOS_H * GEOS_H - GEOS_R_EQ * GEOS_R_EQ;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const rs = (-b - Math.sqrt(disc)) / (2 * a);
    const sX = rs * cx * cy, sY = -rs * sx, sZ = rs * cx * sy;
    return [
        lon0 - Math.atan(sY / (GEOS_H - sX)) * 180 / Math.PI,
        Math.atan(GEOS_RATIO * sZ / Math.hypot(GEOS_H - sX, sY)) * 180 / Math.PI
    ];
}

const goesSectorBounds = {};                    // sectorKey -> { bounds, at }
const GOES_BOUNDS_TTL_MS = 5 * 60 * 1000;       // short: mesoscale sectors move

async function fetchGoesSectorBounds(sectorKey) {
    const cached = goesSectorBounds[sectorKey];
    if (cached && Date.now() - cached.at < GOES_BOUNDS_TTL_MS) return cached.bounds;
    const s = goesSectorDef(sectorKey);
    // A sector with no world file carries a measured extent instead; without this
    // it would fall through to the full disk folder and "zoom" to the whole disk.
    if (s.bbox) return s.bbox;
    const dir = s.dir;
    if (!dir) return cached ? cached.bounds : null;
    const lon0 = GOES_BIRDS[s.bird].lon0;
    // Channel 13 is published for every sector and defines the footprint; the
    // other bands cover the same ground at a different pixel size.
    for (const sat of GOES_BIRDS[s.bird].sats) {
        const base = `https://mesonet.agron.iastate.edu/data/gis/images/GOES/${dir}/channel13/${sat}_C13`;
        try {
            const [wldRes, pngRes] = await Promise.all([
                fetch(`${base}.wld`, { cache: 'no-store' }),
                fetch(`${base}.png`, { cache: 'no-store', headers: { Range: 'bytes=0-32' } })
            ]);
            if (!wldRes.ok || !pngRes.ok) continue;
            const wld = (await wldRes.text()).trim().split(/\s+/).map(Number);
            const head = new DataView(await pngRes.arrayBuffer());
            if (wld.length < 6 || wld.some(v => !isFinite(v)) || head.byteLength < 24) continue;
            const w = head.getUint32(16), h = head.getUint32(20);
            const px = wld[0], py = wld[3], ulx = wld[4], uly = wld[5];
            if (!w || !h || !px || !py) continue;
            // A world file references the CENTRE of the upper-left pixel.
            const x0 = ulx - px / 2, y0 = uly - py / 2;
            const x1 = x0 + px * w,  y1 = y0 + py * h;
            let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity, hits = 0;
            const N = 24;
            for (let i = 0; i <= N; i++) {
                for (let j = 0; j <= N; j++) {
                    const p = geosInverse(x0 + (x1 - x0) * i / N, y0 + (y1 - y0) * j / N, lon0);
                    if (!p) continue;
                    hits++;
                    if (p[0] < west) west = p[0];
                    if (p[0] > east) east = p[0];
                    if (p[1] < south) south = p[1];
                    if (p[1] > north) north = p[1];
                }
            }
            if (!hits) continue;
            const bounds = [[west, south], [east, north]];
            goesSectorBounds[sectorKey] = { bounds, at: Date.now() };
            return bounds;
        } catch (e) { /* try the next platform */ }
    }
    return cached ? cached.bounds : null;
}

async function zoomToGoesSector(paneId, sectorKey) {
    const map = maps[paneId];
    if (!map) return;
    const bounds = await fetchGoesSectorBounds(sectorKey);
    if (!bounds) {
        addLiveLog(`SECTOR: could not read ${goesSectorLabel(sectorKey)} extent`, '#ffb300');
        return;
    }
    try {
        map.fitBounds(bounds, { padding: 24, duration: 700, maxZoom: 9 });
        addLiveLog(`SECTOR: zoomed to ${goesSectorLabel(sectorKey)}`, '#00e5ff');
    } catch (e) {
        addLiveLog(`SECTOR: zoom failed — ${e.message}`, '#ff3333');
    }
}

const RADAR_LOCATIONS = {
    // Southern Region
    'AMA': [-101.70, 35.23], 'AMX': [-80.41, 25.61], 'BMX': [-86.76, 33.17], 'BRO': [-97.42, 25.91],
    'BYX': [-81.75, 24.58], 'CRP': [-97.50, 27.78], 'DFX': [-100.28, 29.27], 'DGX': [-90.07, 32.31],
    'DYX': [-99.25, 32.53], 'EOX': [-85.45, 31.46], 'EPZ': [-106.69, 31.87], 'EVX': [-85.92, 30.56],
    'EWX': [-97.78, 29.70], 'FDR': [-98.97, 34.36], 'FFC': [-84.56, 33.36], 'FWS': [-97.30, 32.57],
    'GRK': [-97.38, 30.72], 'GWX': [-88.32, 33.89], 'HGX': [-94.47, 29.47], 'HTX': [-86.34, 34.93],
    'INX': [-95.56, 36.17], 'JAX': [-81.70, 30.48], 'JGZ': [-83.56, 32.67], 'LBB': [-101.81, 33.65],
    'LCH': [-93.21, 30.12], 'HDC': [-90.41, 30.52], 'LZK': [-92.26, 34.83], 'MAF': [-102.18, 31.94],
    'MLB': [-80.65, 28.11], 'MOB': [-88.24, 30.67], 'MRX': [-83.40, 36.16], 'MXX': [-85.79, 32.53],
    'NQA': [-89.97, 35.34], 'OHX': [-86.56, 36.24], 'POE': [-92.97, 31.04], 'SHV': [-93.84, 32.45],
    'SJT': [-100.49, 31.37], 'SRX': [-94.36, 35.29], 'TBW': [-82.40, 27.70], 'TLH': [-84.33, 30.39],
    'TLX': [-97.27, 35.33], 'VAX': [-83.00, 30.89], 'VNX': [-98.12, 36.74],
    // Central Region
    'ABR': [-98.41, 45.45], 'APX': [-84.72, 44.90], 'ARX': [-91.19, 43.82], 'BIS': [-100.75, 46.77],
    'CYS': [-104.80, 41.15], 'DDC': [-99.96, 37.76], 'DLH': [-92.21, 46.83], 'DMX': [-93.72, 41.73],
    'DTX': [-83.47, 42.69], 'DVN': [-90.58, 41.61], 'EAX': [-94.26, 38.81], 'FSD': [-96.72, 43.58],
    'FTG': [-104.54, 39.78], 'GJX': [-108.21, 39.06], 'GLD': [-101.69, 39.36], 'GRB': [-88.11, 44.49],
    'GRR': [-85.52, 42.89], 'HPX': [-87.49, 36.65], 'ICT': [-97.44, 37.65], 'ILX': [-89.33, 40.15],
    'IND': [-86.28, 39.70], 'IWX': [-85.70, 41.35], 'JKL': [-83.31, 37.59], 'LNX': [-100.57, 41.85],
    'LOT': [-88.08, 41.60], 'LSX': [-90.48, 38.69], 'LVX': [-85.94, 37.97], 'MBX': [-101.33, 48.39],
    'MKX': [-88.55, 42.96], 'MPX': [-93.56, 44.84], 'MQT': [-87.54, 46.53], 'MVX': [-97.32, 47.52],
    'OAX': [-96.37, 41.32], 'PAH': [-88.77, 37.06], 'PUX': [-104.18, 38.45], 'RIW': [-108.48, 43.06],
    'SGF': [-93.40, 37.23], 'TWX': [-96.23, 39.00], 'UDX': [-102.82, 44.12], 'UEX': [-98.44, 40.32],
    'VWX': [-87.72, 38.26],
    // Eastern Region
    'AKQ': [-77.00, 36.98], 'ALY': [-74.06, 42.58], 'BGM': [-75.98, 42.20], 'BOX': [-71.28, 41.95],
    'BUF': [-78.73, 42.94], 'CAE': [-81.11, 33.94], 'CBW': [-67.80, 46.89], 'CCX': [-78.00, 40.92],
    'CLE': [-81.86, 41.41], 'CLX': [-80.02, 32.89], 'CXX': [-73.16, 44.51], 'DIX': [-74.41, 40.04],
    'FCX': [-80.21, 37.10], 'GSP': [-82.21, 34.88], 'GYX': [-70.30, 43.89], 'ILN': [-83.82, 39.42],
    'LTX': [-78.42, 33.98], 'LWX': [-77.48, 38.97], 'MHX': [-76.87, 34.77], 'OKX': [-72.86, 40.86],
    'PBZ': [-80.21, 40.53], 'RAH': [-78.48, 35.66], 'RLX': [-81.72, 38.31], 'TYX': [-75.72, 43.75],
    // Western Region
    'ABX': [-106.82, 35.14], 'ATX': [-122.49, 48.19], 'BBX': [-121.33, 39.10], 'BHX': [-124.29, 40.49],
    'BLX': [-108.60, 45.85], 'CBX': [-116.23, 43.49], 'DAX': [-121.63, 38.50], 'EMX': [-110.63, 31.89],
    'ESX': [-114.89, 35.70], 'EYX': [-117.56, 35.09], 'FDX': [-103.62, 34.63], 'FSX': [-111.19, 34.57],
    'GGW': [-106.62, 48.19], 'HDX': [-106.12, 32.83], 'HNX': [-119.63, 36.31], 'ICX': [-112.86, 37.59],
    'IWA': [-111.67, 33.28], 'LGX': [-124.10, 47.11], 'LRX': [-116.80, 40.73], 'MAX': [-122.71, 42.08],
    'MSX': [-113.98, 47.04], 'MTX': [-112.44, 41.26], 'MUX': [-121.89, 37.15], 'NKX': [-117.04, 32.91],
    'OTX': [-117.62, 47.68], 'PDT': [-118.85, 45.69], 'RGX': [-119.46, 39.83], 'RTX': [-122.96, 45.71],
    'SFX': [-112.44, 43.14], 'SOX': [-117.63, 33.81], 'TFX': [-111.38, 47.45], 'VTX': [-119.17, 34.41],
    'YUX': [-114.65, 32.49],
    // Alaska / Hawaii / PR / Guam & Legacy Aliases
    'ABC': [-161.87, 60.78], 'ACG': [-135.34, 57.04], 'AEC': [-165.44, 64.51], 'AHG': [-151.27, 60.51],
    'AIH': [-146.30, 59.43], 'AKC': [-156.63, 58.68], 'APD': [-147.37, 65.03], 'GUA': [144.81, 13.45],
    'HKI': [-159.73, 22.10], 'HKM': [-155.78, 20.14], 'HMO': [-157.10, 21.13], 'HWA': [-155.58, 19.14],
    'JUA': [-66.08, 18.11],
    // Legacy Aliases for backwards compatibility
    'OUN': [-97.46, 35.23], 'SJU': [-66.11, 18.45], 'MFL': [-80.41, 25.61], 'JAN': [-90.07, 32.31],
    'MEG': [-89.97, 35.34], 'PHI': [-74.41, 39.94], 'CTP': [-78.00, 40.92], 'RNK': [-80.21, 37.10],
    'BOI': [-116.23, 43.49], 'TWC': [-110.63, 32.23], 'VEF': [-114.89, 35.70], 'MTR': [-121.89, 37.34],
    'RTD': [-122.71, 45.71], 'SGX': [-117.04, 32.91], 'PHMO': [-158.07, 21.42], 'HUN': [-86.34, 34.93]
};

const SOUNDING_LOCATIONS = {
    'JAN': [-90.07, 32.31], 'BMX': [-86.76, 33.17], 'SHV': [-93.84, 32.45], 'LCH': [-93.21, 30.12],
    'LIX': [-89.82, 30.33], 'SIL': [-89.82, 30.33], 'LZK': [-92.26, 34.83], 'FFC': [-84.56, 33.36],
    'JAX': [-81.70, 30.48], 'TBW': [-82.40, 27.70], 'MFL': [-80.41, 25.61], 'TAE': [-84.33, 30.39],
    'EYW': [-81.75, 24.58], 'CRP': [-97.50, 27.77], 'BRO': [-97.42, 25.91], 'AMA': [-101.71, 35.22],
    'MAF': [-102.19, 31.94], 'EPZ': [-106.70, 31.85], 'OUN': [-97.46, 35.23], 'FWD': [-97.30, 32.82],
    'SGF': [-93.40, 37.23], 'DVN': [-90.58, 41.61], 'OAX': [-96.37, 41.32], 'TOP': [-95.62, 38.99],
    'ICT': [-97.44, 37.65], 'ILX': [-89.33, 40.15], 'DMX': [-93.72, 41.73], 'MPX': [-93.56, 44.84],
    'GRB': [-88.11, 44.48], 'DTX': [-83.47, 42.69], 'ILN': [-83.82, 39.42], 'PAH': [-88.77, 37.06],
    'BNA': [-86.67, 36.12], 'BIS': [-100.75, 46.77], 'GGW': [-106.62, 48.21], 'OKX': [-72.86, 40.86],
    'LWX': [-77.48, 38.97], 'PHI': [-74.41, 39.94], 'BOX': [-69.96, 41.67], 'ALY': [-73.83, 42.75],
    'BUF': [-78.73, 42.94], 'PIT': [-80.21, 40.50], 'CTP': [-78.00, 40.92], 'RNK': [-80.41, 37.20],
    'GSP': [-82.21, 34.88], 'CHS': [-80.02, 32.89], 'MHX': [-76.88, 34.78], 'ILM': [-77.90, 34.27],
    'WAL': [-75.48, 37.93], 'DNR': [-104.87, 39.75], 'ABQ': [-106.62, 35.05], 'TFX': [-111.38, 47.45],
    'BOI': [-116.23, 43.57], 'LKN': [-115.74, 40.86], 'VEF': [-115.19, 36.05], 'TWC': [-110.94, 32.23],
    'PSR': [-111.95, 33.45], 'FGZ': [-111.67, 35.23], 'NKX': [-117.11, 32.87], 'VBG': [-120.57, 34.74],
    'OAK': [-122.21, 37.72], 'MFR': [-122.87, 42.37], 'SLE': [-123.00, 44.91], 'UIL': [-124.55, 47.95],
    'OTX': [-117.62, 47.68], 'RIW': [-108.48, 43.06], 'ANC': [-149.98, 61.17], 'FAI': [-147.88, 64.81],
    'BET': [-161.80, 60.78], 'KTN': [-131.71, 55.35], 'LIH': [-159.35, 21.98], 'PHTO': [-155.07, 19.72],
    'GUM': [144.80, 13.48], 'SJU': [-66.11, 18.45]
};


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1: URL BUILDERS
// ═══════════════════════════════════════════════════════════════════════════════

function goesChannelUrl(ch, sectorKey) {
    // IEM tile cache — individual per-channel imagery for one bird + sector
    // (nowCOAST only has category-based layers so all visible channels look identical there)
    const s = goesSectorDef(sectorKey);
    const pad = String(ch).padStart(2, '0');
    return `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/goes_${s.bird}_${s.tile}_ch${pad}/{z}/{x}/{y}.png`;
}

function getNowCoastSatLayer(ch) {
    if (ch >= 1 && ch <= 3 || ch === 6) return 'goes_visible_imagery';
    if (ch === 4 || ch === 5) return 'goes_snow_ice_imagery';
    if (ch === 7) return 'goes_shortwave_imagery';
    if (ch >= 8 && ch <= 10) return 'goes_water_vapor_imagery';
    return 'goes_longwave_imagery'; // ch 11-16
}

function nowCoastSatUrl(channel, isoTimeStr) {
    const layer = getNowCoastSatLayer(channel);
    let url = `https://nowcoast.noaa.gov/geoserver/satellite/wms?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=${layer}&FORMAT=image/png&TRANSPARENT=true&STYLES=&SRS=EPSG:3857&WIDTH=256&HEIGHT=256&BBOX={bbox-epsg-3857}`;
    if (isoTimeStr) url += `&TIME=${isoTimeStr}`;
    return url;
}

function snapToNowCoastTime(date) {
    const d = new Date(date);
    // nowCOAST times end in :03, :08, :13, :18, :23, :28, :33, :38, :43, :48, :53, :58
    // Snap to nearest 5 min with +3 offset
    const min = d.getUTCMinutes();
    const snapped = Math.floor(min / 5) * 5 + 3;
    d.setUTCMinutes(snapped > 58 ? 58 : snapped, 0, 0);
    return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function nationalRadarUrl() {
    return 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q/{z}/{x}/{y}.png';
}

// Latest GOES-East frame time per nowCOAST category layer, parsed from the
// satellite WMS GetCapabilities (one doc covers every channel). The per-channel
// IEM tiles carry no timestamp, so nowCOAST's published frame time — driven by
// the same GOES feed on the same 5-min cadence — is the closest valid-time proxy.
const NOWCOAST_SAT_LAYERS = ['goes_visible_imagery', 'goes_snow_ice_imagery', 'goes_shortwave_imagery', 'goes_water_vapor_imagery', 'goes_longwave_imagery'];
let goesSatTimes = {};          // nowCOAST layer name -> latest ISO Z time
let goesSatTimesFetched = 0;
async function fetchGoesSatTimes(force) {
    const now = Date.now();
    if (!force && Object.keys(goesSatTimes).length && now - goesSatTimesFetched < 4 * 60 * 1000) return goesSatTimes;
    try {
        const url = 'https://nowcoast.noaa.gov/geoserver/satellite/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities';
        const txt = await (await fetch(url, { cache: 'no-store' })).text();
        NOWCOAST_SAT_LAYERS.forEach(L => {
            const idx = txt.indexOf(`<Name>${L}</Name>`);
            if (idx < 0) return;
            const ti = txt.indexOf('name="time"', idx);
            if (ti < 0 || ti - idx > 4000) return;      // keep within this layer's block
            const dm = txt.slice(ti, ti + 140).match(/default="([^"]+)"/);
            if (dm) goesSatTimes[L] = dm[1];
        });
        goesSatTimesFetched = now;
    } catch (e) { /* keep any stale values */ }
    return goesSatTimes;
}
function goesChannelTimeSuffix(ch, sectorKey) {
    // Prefer the exact valid time IEM publishes beside the image for this sector.
    // nowCOAST is only a fallback: it is a GOES-East CONUS mosaic, so it is a
    // rough proxy for East sectors and not a valid one for GOES-West at all.
    let t = iemGoesValid[iemValidKey(ch, sectorKey)];
    if (!t && goesSectorDef(sectorKey).bird === 'east') {
        // nowCOAST has no shortwave (Ch7) category; all ABI bands share the same
        // scan cadence, so fall back to longwave (or any available) frame time.
        t = goesSatTimes[getNowCoastSatLayer(ch)] || goesSatTimes['goes_longwave_imagery'] || Object.values(goesSatTimes)[0];
    }
    return (t && t.length >= 16) ? ` · ${t.substring(11, 16)}Z` : '';
}

// Exact valid time of the image behind IEM's live per-channel tiles (tiny CORS-*
// JSON published next to each image). Keyed by sector because the same channel
// has a different valid time per sector (meso scans every minute, full disk every
// ten). Each bird's platforms are tried in order so a satellite swap degrades to
// "no timestamp", not a break.
let iemGoesValid = {};   // `${sectorKey}|${ch}` -> ISO valid string
function iemValidKey(ch, sectorKey) { return `${GOES_SECTORS[sectorKey] ? sectorKey : DEFAULT_GOES_SECTOR}|${ch}`; }
async function fetchIemGoesValid(ch, sectorKey) {
    const key = iemValidKey(ch, sectorKey);
    const s = goesSectorDef(sectorKey);
    const pad = String(ch).padStart(2, '0');
    // Hawaii serves tiles but has no archive folder — it is a GOES-West full disk
    // cut and carries that scan's valid time exactly.
    const dir = s.dir || 'fulldisk';
    for (const sat of GOES_BIRDS[s.bird].sats) {
        try {
            const r = await fetch(`https://mesonet.agron.iastate.edu/data/gis/images/GOES/${dir}/channel${pad}/${sat}_C${pad}.json`, { cache: 'no-store' });
            if (!r.ok) continue;
            const j = await r.json();
            if (j?.meta?.valid) { iemGoesValid[key] = j.meta.valid; return j.meta.valid; }
        } catch (e) { /* try next platform */ }
    }
    return iemGoesValid[key] || null;
}

// ─── NASA GIBS GOES-East / GOES-West (web-mercator WMTS, real time-stamped frames) ───
// Browser-direct (CORS *), no proxy/render. Gives clean looping (real 10-min
// frames) AND smooth panning (tiles), incl. the GeoColor/composite products that
// the per-channel IEM tiles + category-based nowCOAST loop never animated cleanly.
// Both birds publish the same six products on the same tile matrix sets, so only
// the layer name changes — tms/max/iemCh are shared.
// Unlike IEM's northern-hemisphere tile crop, these are true full-disk layers,
// which is what makes GOES-West usable for the eastern Pacific.
// iemCh: products with a 1:1 ABI channel get their LIVE frame from IEM's
// per-channel tile cache (~5-10 min behind the scan) instead of the newest
// published GIBS frame (~45-60 min publication lag). Loops still run on GIBS
// timestamped frames — the IEM cache has no time dimension. The RGB composites
// (GeoColor/AirMass/Dust/FireTemp) have no single-channel equivalent, so their
// live frame stays GIBS.
const GIBS_PRODUCTS = {
    GeoColor: { layer: { east: 'GOES-East_ABI_GeoColor',              west: 'GOES-West_ABI_GeoColor' },              tms: 'GoogleMapsCompatible_Level7', max: 7, label: 'GeoColor' },
    CleanIR:  { layer: { east: 'GOES-East_ABI_Band13_Clean_Infrared', west: 'GOES-West_ABI_Band13_Clean_Infrared' }, tms: 'GoogleMapsCompatible_Level6', max: 6, label: 'Clean IR (Band 13)', iemCh: 13 },
    RedVis:   { layer: { east: 'GOES-East_ABI_Band2_Red_Visible_1km', west: 'GOES-West_ABI_Band2_Red_Visible_1km' }, tms: 'GoogleMapsCompatible_Level7', max: 7, label: 'Red Visible', iemCh: 2 },
    AirMass:  { layer: { east: 'GOES-East_ABI_Air_Mass',              west: 'GOES-West_ABI_Air_Mass' },              tms: 'GoogleMapsCompatible_Level6', max: 6, label: 'Air Mass RGB' },
    Dust:     { layer: { east: 'GOES-East_ABI_Dust',                  west: 'GOES-West_ABI_Dust' },                  tms: 'GoogleMapsCompatible_Level7', max: 7, label: 'Dust RGB' },
    FireTemp: { layer: { east: 'GOES-East_ABI_FireTemp',              west: 'GOES-West_ABI_FireTemp' },              tms: 'GoogleMapsCompatible_Level7', max: 7, label: 'Fire Temp RGB' }
};

function gibsLayerId(prodKey, bird) {
    const p = GIBS_PRODUCTS[prodKey];
    return (p && p.layer[bird]) || p.layer.east;
}

function gibsTileUrl(prodKey, isoTime, bird) {
    const p = GIBS_PRODUCTS[prodKey];
    // WMTS REST: .../{layer}/default/{time}/{TileMatrixSet}/{z}/{y}/{x}.png
    return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${gibsLayerId(prodKey, bird)}/default/${isoTime || 'default'}/${p.tms}/{z}/{y}/{x}.png`;
}

// Cache of recent real frame times, keyed product+bird — the two birds publish
// on independent schedules, so sharing one cache would loop West on East's times.
const gibsTimesCache = {};
function gibsTimesKey(prodKey, bird) { return `${prodKey}|${bird || 'east'}`; }
function gibsTimesFor(prodKey, bird) { return gibsTimesCache[gibsTimesKey(prodKey, bird)] || []; }
async function fetchGibsTimes(prodKey, bird) {
    const p = GIBS_PRODUCTS[prodKey];
    const key = gibsTimesKey(prodKey, bird);
    try {
        const res = await fetch(`/api/gibs-times?layer=${gibsLayerId(prodKey, bird)}&tms=${p.tms}&n=40`);
        const data = await res.json();
        if (data.times && data.times.length) gibsTimesCache[key] = data.times;
        return gibsTimesCache[key] || [];
    } catch (e) {
        return gibsTimesCache[key] || [];
    }
}

// ─── Lightning — NOAA nowCOAST NLDN (cloud-to-ground strike density) ───
// Keyless NOAA WMS; supports a TIME dimension (omit for latest). Chosen over GOES
// GLM because the only GLM tiles (SSEC RealEarth) watermark any full-viewport map:
// even a registered access key caps cumulative adjacent tiles at 2048px (~8 tiles),
// far below a normal map viewport — removable only via RealEarth Plus ($500/mo).
function lightningUrl(isoTimeStr) {
    let u = 'https://nowcoast.noaa.gov/geoserver/lightning_detection/wms?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap'
        + '&LAYERS=ldn_lightning_strike_density&FORMAT=image/png&TRANSPARENT=true&STYLES=&SRS=EPSG:3857'
        + '&WIDTH=256&HEIGHT=256&BBOX={bbox-epsg-3857}';
    if (isoTimeStr) u += `&TIME=${isoTimeStr}`;
    return u;
}

// NDFD gridded surface-temperature forecast (the one NDFD parameter NWS still
// serves as a public raster). Shared by the layer source and the 30-min refresh.
const NDFD_TEMP_URL = 'https://mapservices.weather.noaa.gov/raster/services/NDFD/NDFD_temp/MapServer/WMSServer?service=WMS&version=1.1.1&request=GetMap&layers=1&format=image/png&transparent=true&styles=&srs=EPSG:3857&width=256&height=256&bbox={bbox-epsg-3857}';

function iemRadarAnimUrl(layerName) {
    return `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/${layerName}/{z}/{x}/{y}.png`;
}

function ridgeRadarUrl(date) {
    const y = date.getUTCFullYear();
    const mo = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    const h = String(date.getUTCHours()).padStart(2, '0');
    // Radar usually on 5-min cadence
    const mi = String(Math.floor(date.getUTCMinutes() / 5) * 5).padStart(2, '0');
    const ts = `${y}${mo}${d}${h}${mi}`;
    return `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/ridge::USCOMP-N0Q-${ts}/{z}/{x}/{y}.png`;
}

function siteRadarUrlBase(site, product) {
    const s = site.toLowerCase();
    const prefix = ['abc','acg','aec','ahg','aih','akc','apd','gua','hki','hkm','hmo','hwa'].includes(s) ? 'p' : 'k';
    const ws = (s === 'jua' || s === 'sju') ? 'tjua' : `${prefix}${s}`;
    // 5-minute cache window keeps zoom transitions pulling from one cache bucket.
    const tsWindow = Math.floor(Date.now() / 300000);
    return `https://opengeo.ncep.noaa.gov/geoserver/${ws}/ows?service=wms&version=1.3.0&request=GetMap&layers=${ws}_${product}&crs=EPSG:3857&bbox={bbox-epsg-3857}&width=512&height=512&format=image/png&transparent=true&tiled=false&ts=${tsWindow}`;
}

// Live tiles PINNED to the latest known volume scan (so every zoom level renders
// the SAME scan — without an explicit time the WMS serves "latest at fetch time",
// which makes scans alternate as differently-cached tiles load on zoom). Falls
// back to unpinned "latest" until the scan time is known, then we repoint.
function siteRadarUrl(site, product) {
    const t = siteRadarTimes[(site || '').toUpperCase()];
    const scan = t && t[product];
    return siteRadarUrlBase(site, product) + (scan ? `&time=${scan}` : '');
}

function siteRadarAnimUrl(site, product, isoTimeStr) {
    return siteRadarUrlBase(site, product) + `&time=${isoTimeStr}`;
}

// Repoint every visible pane on `site` to its product's pinned-scan tiles.
function repointSiteRadar(site) {
    const key = (site || '').toUpperCase();
    const prodSrc = { sr_bref: 'site-bref', sr_bvel: 'site-bvel', bdhc: 'site-bdhc', bdsa: 'site-bdsa', boha: 'site-boha' };
    Object.entries(maps).forEach(([pid, m]) => {
        if ((paneRadarSites[pid] || '').toUpperCase() !== key) return;
        const src = prodSrc[paneRadarProducts[pid] || 'sr_bref'];
        if (src && m.getSource(src) && isLayerVisible(m, src + '-layer')) {
            m.getSource(src).setTiles([siteRadarUrl(paneRadarSites[pid], paneRadarProducts[pid] || 'sr_bref')]);
        }
    });
}

// Latest volume-scan time per site+product, read from the SAME source that
// renders the tiles (NCEP opengeo WMS GetCapabilities exposes a per-layer
// <Dimension name="time" default="…">). Cached + throttled; CORS is '*'.
const siteRadarTimes = {};            // { SITE: { sr_bref:'ISO', sr_bvel:'ISO', …, _ts:ms } }
const SITE_TIME_TTL = 60 * 1000;
function siteWorkspace(site) {
    const s = site.toLowerCase();
    if (s === 'jua' || s === 'sju') return 'tjua';
    const pPrefix = ['abc','acg','aec','ahg','aih','akc','apd','gua','hki','hkm','hmo','hwa'].includes(s) ? 'p' : 'k';
    return pPrefix + s;
}
async function fetchSiteRadarTimes(site, force = false) {
    if (!site || site.includes('nexrad')) return;
    const key = site.toUpperCase();
    const cached = siteRadarTimes[key];
    if (!force && cached && Date.now() - cached._ts < SITE_TIME_TTL) return;   // throttle
    const ws = siteWorkspace(site);
    try {
        const res = await fetch(`https://opengeo.ncep.noaa.gov/geoserver/${ws}/ows?service=wms&version=1.3.0&request=GetCapabilities`);
        const xml = await res.text();
        const times = { _ts: Date.now() };
        const re = new RegExp('<Name>' + ws + '_([a-z0-9_]+)</Name>');
        xml.split('<Layer').forEach(chunk => {
            const nm = chunk.match(re);
            const tm = chunk.match(/<Dimension name="time"[^>]*default="([^"]+)"/);
            if (nm && tm) times[nm[1]] = tm[1];
        });
        const prevBref = siteRadarTimes[key] && siteRadarTimes[key].sr_bref;
        siteRadarTimes[key] = times;
        // Pin the (possibly new) scan onto the live tiles so every zoom level
        // shows one consistent scan. Repoint on first read or when it advanced.
        if (force || prevBref !== times.sr_bref) repointSiteRadar(site);
        if (!isPlaying) refreshTimestampLabel();
    } catch (e) { /* keep stale/none — label just omits the time */ }
}
// "13:14Z" suffix for a site product, or '' if not known yet.
function siteTimeSuffix(site, product) {
    const t = siteRadarTimes[(site || '').toUpperCase()];
    const iso = t && t[product];
    return iso ? ` · ${iso.substring(11, 16)}Z` : '';
}

// ─── WIND BARB GENERATOR ───
function createWindBarbDataUrl(knots) {
    const k = Math.round(knots / 5) * 5;
    const svgWidth = 40;
    const svgHeight = 40;
    const stemX = 20;
    const stemY = 20;
    const stemLen = 18;
    
    let paths = `<line x1="${stemX}" y1="${stemY}" x2="${stemX}" y2="${stemY - stemLen}" stroke="currentColor" stroke-width="1.5" />`;
    
    if (k === 0) {
        paths = `<circle cx="${stemX}" cy="${stemY}" r="3" stroke="currentColor" stroke-width="1" fill="none" />`;
    } else {
        let remaining = k;
        let pos = 0;
        const spacing = 3.5;
        
        // 50kt Flags
        while (remaining >= 50) {
            paths += `<path d="M${stemX},${stemY - stemLen + pos} L${stemX + 7},${stemY - stemLen + pos + 2} L${stemX},${stemY - stemLen + pos + 4} Z" fill="currentColor" />`;
            remaining -= 50;
            pos += spacing * 1.5;
        }
        // 10kt Long Barbs
        while (remaining >= 10) {
            paths += `<line x1="${stemX}" y1="${stemY - stemLen + pos}" x2="${stemX + 8}" y2="${stemY - stemLen + pos - 3}" stroke="currentColor" stroke-width="1.5" />`;
            remaining -= 10;
            pos += spacing;
        }
        // 5kt Short Barbs
        if (remaining >= 5) {
            // If it's the only one, move it up slightly
            const offset = (pos === 0) ? spacing : 0;
            paths += `<line x1="${stemX}" y1="${stemY - stemLen + pos + offset}" x2="${stemX + 4}" y2="${stemY - stemLen + pos + offset - 1.5}" stroke="currentColor" stroke-width="1.5" />`;
        }
    }

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 40 40">${paths.replace(/currentColor/g, 'white')}</svg>`;
    return 'data:image/svg+xml;base64,' + btoa(svg);
}

function registerWindBarbs(map) {
    for (let i = 0; i <= 150; i += 5) {
        const url = createWindBarbDataUrl(i);
        const img = new Image();
        img.onload = () => { if (!map.hasImage(`barb-${i}`)) map.addImage(`barb-${i}`, img); };
        img.src = url;
    }
}

// For third-party hosts that ship no Cache-Control (Open-Meteo meta.json, the
// IEM feeds). NOT for our own /api/* functions — they set their own max-age and
// Vercel's CDN honours it; a unique query string turns every poll into a MISS
// that runs the function and hits the upstream for nothing.
function cacheBust(url) {
    const sep = url.includes('?') ? '&' : '?';
    return url + sep + '_cb=' + Date.now();
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2: LIVE LOG
// ═══════════════════════════════════════════════════════════════════════════════

function addLiveLog(msg, color = '#888') {
    const c = document.getElementById('live-log-entries');
    if (!c) return;
    const d = document.createElement('div');
    const ts = new Date().toISOString().substring(11, 19);
    d.innerHTML = `<span style="color:#444">[${ts}]</span> <span style="color:${color}">${esc(msg)}</span>`;
    c.prepend(d);
    while (c.children.length > 200) c.lastChild.remove();
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3: DATA HEALTH MONITORING
// ═══════════════════════════════════════════════════════════════════════════════

function initHealthTracker(id, label, thresholdMs) {
    healthTrackers[id] = {
        label: label,
        thresholdMs: thresholdMs,
        status: 'WAIT',
        lastUpdate: 0
    };
}

function updateHealth(id, ts) {
    // ts (optional) stamps the DATA's own valid time instead of the fetch time,
    // so freshness decays against the product's real cadence (e.g. model cycles)
    if (!healthTrackers[id]) return;
    healthTrackers[id].status = 'LIVE';
    healthTrackers[id].lastUpdate = ts || Date.now();
}

// Legend "as of" stamp for products whose freshness is the last successful pull
// from the source (vs. radar/satellite, which carry a published imagery valid
// time). Reads the data-health tracker's lastUpdate so the legend never runs
// ahead of the data actually loaded.
function healthTimeSuffix(id) {
    const t = healthTrackers[id];
    if (!t || !t.lastUpdate) return '';
    return ' · ' + new Date(t.lastUpdate).toISOString().substring(11, 16) + 'Z';
}

function checkHealthStatus() {
    const now = Date.now();
    for (const [id, tracker] of Object.entries(healthTrackers)) {
        if (tracker.lastUpdate === 0) {
            tracker.status = 'WAIT';
            continue;
        }
        const elapsed = now - tracker.lastUpdate;
        if (elapsed <= tracker.thresholdMs) {
            tracker.status = 'LIVE';
        } else if (elapsed <= tracker.thresholdMs * 2) {
            tracker.status = 'STALE';
        } else {
            tracker.status = 'FAIL';
        }
    }
    renderHealthUI();
}

const HEALTH_STATUS_COLOR = { LIVE: '#00ff88', STALE: '#ffb300', FAIL: '#ff3333', WAIT: '#666' };
const HEALTH_STATUS_RANK = { FAIL: 3, STALE: 2, WAIT: 1, LIVE: 0 };
let healthGroupsCollapsed = (() => {
    try { return JSON.parse(localStorage.getItem('fxnet_health_collapsed') || '{}'); } catch (e) { return {}; }
})();

function renderHealthUI() {
    const container = document.getElementById('health-rows-container');
    if (!container) return;

    // Track any ids not covered by a group so nothing silently disappears.
    const grouped = new Set();
    HEALTH_GROUPS.forEach(g => g.ids.forEach(id => grouped.add(id)));
    const leftovers = Object.keys(healthTrackers).filter(id => !grouped.has(id));
    const groups = leftovers.length
        ? [...HEALTH_GROUPS, { name: 'OTHER', ids: leftovers }]
        : HEALTH_GROUPS;

    const persist = () => {
        try { localStorage.setItem('fxnet_health_collapsed', JSON.stringify(healthGroupsCollapsed)); } catch (e) { }
    };

    const rowHtml = (id) => {
        const t = healthTrackers[id];
        if (!t) return '';
        const color = HEALTH_STATUS_COLOR[t.status] || '#666';
        const timeStr = t.lastUpdate > 0 ? new Date(t.lastUpdate).toISOString().substring(11, 16) + 'Z' : '--:--';
        return `<div class="health-row"><span>${t.label}</span>` +
            `<span class="health-status" style="color:${color};font-weight:bold;">${t.status} ${timeStr}</span></div>`;
    };

    container.innerHTML = groups.map(g => {
        const ids = g.ids.filter(id => healthTrackers[id]);
        if (!ids.length) return '';
        // Group dot = worst status among its feeds (red > amber > grey > green).
        const worst = ids.reduce((w, id) => {
            const s = healthTrackers[id].status;
            return (HEALTH_STATUS_RANK[s] || 0) > (HEALTH_STATUS_RANK[w] || 0) ? s : w;
        }, 'LIVE');
        const collapsed = !!healthGroupsCollapsed[g.name];
        const dot = `<span class="health-group-dot" style="background:${HEALTH_STATUS_COLOR[worst] || '#666'};"></span>`;
        return `<div class="health-group${collapsed ? ' collapsed' : ''}" data-group="${g.name}">` +
            `<div class="health-group-header">${dot}<span class="health-group-name">${g.name}</span>` +
            `<span class="health-group-caret">▾</span></div>` +
            `<div class="health-group-body">${ids.map(rowHtml).join('')}</div>` +
            `</div>`;
    }).join('');

    container.querySelectorAll('.health-group-header').forEach(header => {
        header.addEventListener('click', () => {
            const group = header.parentElement;
            const name = group.getAttribute('data-group');
            const nowCollapsed = group.classList.toggle('collapsed');
            healthGroupsCollapsed[name] = nowCollapsed;
            persist();
        });
    });
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4: MAP INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

function initMap(paneId) {
    if (maps[paneId]) return;

    const containerId = `map-${paneId}`;
    const el = document.getElementById(containerId);
    if (!el) return;

    addLiveLog(`PANE ${paneId}: Creating map...`, '#888');

    // When this pane has a saved view waiting to be restored, start the map
    // there directly — no default-CONUS flash, no camera jump after 'load'.
    const savedView = pendingRestore[paneId] && Array.isArray(pendingRestore[paneId].view) &&
        pendingRestore[paneId].view.length === 3 ? pendingRestore[paneId].view : null;
    const map = new maplibregl.Map({
        container: containerId,
        style: {
            version: 8,
            glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
            sources: {},
            layers: [
                { id: 'black-bg', type: 'background', paint: { 'background-color': '#000000' } }
            ]
        },
        center: savedView ? [savedView[0], savedView[1]] : [-90.18, 32.30],
        zoom: savedView ? savedView[2] : 6,
        preserveDrawingBuffer: true
    });

    // Suppress harmless MapLibre tile errors
    map.on('error', e => {
        const msg = e?.error?.message || '';
        if (msg.includes('image') || msg.includes('usable') || msg.includes('supported')) return;
    });

    maps[paneId] = map;
    attachSolarClick(paneId, map);   // sun-times click query (all panes, incl. new tabs)

    // Create synchronized cursor shadow box for this pane
    const cursorEl = document.createElement('div');
    cursorEl.className = 'sync-cursor-box';
    cursorEl.style.display = 'none';
    cursorMarkers[paneId] = new maplibregl.Marker({ element: cursorEl })
        .setLngLat([0, 0])
        .addTo(map);

    map.on('load', () => {
        registerWindBarbs(map);
        setupMapLayers(map, paneId);
        liftBoundaries(map);        // boundaries above imagery, below features/labels
        createRadarLegend(paneId);
        createEroLegend(paneId);
        createProbLegend(paneId);
        createFireWxLegend(paneId);
        applyPaneRestore(paneId);   // re-apply any persisted product setup for this pane
        addLiveLog(`PANE ${paneId}: Map ready`, '#00ff88');
        setTimeout(() => map.resize(), 100);
    });

    // Mouse tracking for HUD & Synchronized tactical cursor shadows
    map.on('mousemove', e => {
        if (paneId === activePaneId) {
            document.getElementById('val-lat').innerText = e.lngLat.lat.toFixed(4);
            document.getElementById('val-lon').innerText = e.lngLat.lng.toFixed(4);

            if (isDataSamplerActive) {
                try {
                    const canvas = map.getCanvas();
                    const gl = canvas.getContext('webgl') || canvas.getContext('webgl2');
                    if (gl) {
                        const rect = canvas.getBoundingClientRect();
                        const clientX = e.originalEvent.clientX;
                        const clientY = e.originalEvent.clientY;
                        const px = Math.round((clientX - rect.left) * (canvas.width / rect.width));
                        const py = Math.round((rect.bottom - clientY) * (canvas.height / rect.height));

                        const data = new Uint8Array(4);
                        gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, data);

                        const valSamplerEl = document.getElementById('val-sampler');

                        // Detect which product layer is active — MRMS takes priority (renders on top)
                        const mrmsEtVis = isLayerVisible(map, 'mrms-echotops-layer');
                        const mrmsQpeVis = isLayerVisible(map, 'mrms-qpe-layer');

                        if (mrmsEtVis) {
                            const readout = decodeMrmsPixel(data[0], data[1], data[2], 'echotops');
                            if (valSamplerEl) valSamplerEl.innerText = `MRMS ECHO TOPS: ${readout}`;
                        } else if (mrmsQpeVis && paneMrmsQpe[paneId]) {
                            const readout = decodeMrmsPixel(data[0], data[1], data[2], 'qpe');
                            const periodLabels = { '1h': '1-HR', '24h': '24-HR', '48h': '48-HR', '72h': '72-HR' };
                            const pLabel = periodLabels[paneMrmsQpe[paneId]] || 'QPE';
                            if (valSamplerEl) valSamplerEl.innerText = `MRMS ${pLabel} QPE: ${readout}`;
                        } else {
                            const prod = paneRadarProducts[paneId] || 'sr_bref';
                            const readout = decodeRadarPixel(data[0], data[1], data[2], prod);
                            const prodLabels = { 'sr_bref': 'BREF', 'sr_bvel': 'BVEL', 'bdhc': 'BDHC', 'bdsa': 'STP', 'boha': 'OHA' };
                            const prodLabel = prodLabels[prod] || prod.toUpperCase();
                            if (valSamplerEl) valSamplerEl.innerText = `${paneRadarSites[paneId] || 'DGX'} ${prodLabel}: ${readout}`;
                        }
                    }
                } catch (_) {}
            }
        }

        // Move cursor marker on all OTHER active panes
        Object.entries(cursorMarkers).forEach(([id, marker]) => {
            if (id !== paneId && maps[id]) {
                const markerEl = marker.getElement();
                if (markerEl) markerEl.style.display = 'block';
                marker.setLngLat(e.lngLat);
            } else if (id === paneId) {
                // Hide cursor on the pane currently being hovered over
                const markerEl = marker.getElement();
                if (markerEl) markerEl.style.display = 'none';
            }
        });
    });

    map.on('mouseout', () => {
        // Hide all cursor shadows when mouse leaves map
        Object.values(cursorMarkers).forEach(marker => {
            const el = marker?.getElement();
            if (el) el.style.display = 'none';
        });
    });

    // Sync all panes — pan/zoom one, the rest follow
    map.on('move', () => {
        if (isSyncingMaps) return;
        if (paneSyncDisabled.has(paneId)) return;   // pinned pane doesn't drive others
        isSyncingMaps = true;
        const center = map.getCenter();
        const zoom = map.getZoom();
        const bearing = map.getBearing();
        const pitch = map.getPitch();
        const myTab = tabOfPane(paneId);
        Object.entries(maps).forEach(([id, m]) => {
            // Only sync panes within the SAME tab; pinned panes keep their own view.
            if (String(id) !== String(paneId) && m && tabOfPane(id) === myTab && !paneSyncDisabled.has(id)) {
                m.jumpTo({ center, zoom, bearing, pitch });
            }
        });
        isSyncingMaps = false;
    });

    // Pane click — set active
    const paneEl = document.querySelector(`.pane[data-pane="${paneId}"]`);
    if (paneEl) {
        paneEl.addEventListener('click', () => {
            const wasActive = paneEl.classList.contains('active-pane');
            document.querySelectorAll('.pane').forEach(p => p.classList.remove('active-pane'));
            paneEl.classList.add('active-pane');
            activePaneId = paneId;
            activeGoesChannel = paneGoesChannels[paneId]; // Sync satellite channel to this pane
            if (!wasActive) {
                updateSidebarToActivePane();
                addLiveLog(`PANE ${paneId} SELECTED`, '#00e5ff');
            }
        });

        // Right-click context menu
        paneEl.addEventListener('contextmenu', e => {
            e.preventDefault();
            const menu = document.getElementById('pane-context-menu');
            if (!menu) return;
            menu.style.display = 'block';
            menu.style.left = e.pageX + 'px';
            menu.style.top = e.pageY + 'px';
            menu.dataset.pane = paneId;
            activePaneId = paneId;
            activeGoesChannel = paneGoesChannels[paneId]; // Sync satellite channel
            // Reflect this pane's current pin state in the menu label
            const pinLabel = menu.querySelector('.pin-label');
            if (pinLabel) pinLabel.textContent = paneSyncDisabled.has(paneId)
                ? 'Unpin Pane (Rejoin Sync)' : 'Pin Pane (Independent View)';
        });
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5: MAP LAYER SETUP (Z-ORDER)
// ═══════════════════════════════════════════════════════════════════════════════

function getEventColor(event) {
    const evt = (event || '').toLowerCase();
    if (evt.includes('tornado')) return '#ff0000';
    if (evt.includes('severe thunderstorm')) return '#ffa500';
    if (evt.includes('flash flood')) return '#8b0000';
    if (evt.includes('flood advisory') || evt.includes('small stream')) return '#00ff7f';
    if (evt.includes('flood')) return '#008b00';
    if (evt.includes('freeze warning')) return '#9370db';
    if (evt.includes('freeze')) return '#00bfff';
    if (evt.includes('winter storm')) return '#ff69b4';
    if (evt.includes('blizzard')) return '#ff4500';
    if (evt.includes('wind chill')) return '#afeeee';
    if (evt.includes('cold')) return '#0000ff';
    if (evt.includes('special weather statement')) return '#00ffff';
    if (evt.includes('watch')) return '#ffff00';
    return '#ff3333';
}

// Geopolitical boundary lines, bottom→top. They must render ABOVE the imagery
// (radar/satellite/GIBS) so they're legible — otherwise they sit under the
// semi-transparent imagery and wash out. Casing layers come before their core
// so the dark halo stays beneath the white line.
const GEO_BOUNDARY_LAYERS = [
    'counties-layer',
    'states-layer',
    'great-lakes-outline',
    'international-borders-casing-layer', 'international-borders-layer',
    'coastlines-casing-layer', 'coastlines-layer'
];

// The lowest boundary layer present — used as the insert anchor so runtime
// imagery (GIBS, L3, loop frames) lands BELOW the boundary block.
function firstBoundaryLayer(map) {
    return GEO_BOUNDARY_LAYERS.find(id => map.getLayer && map.getLayer(id));
}

// Lift boundary lines to sit just below the first feature overlay (smoke) — i.e.
// ABOVE all imagery but BELOW weather features + labels (the AWIPS z-order).
// Cheap and idempotent; called once after all static layers are added.
function liftBoundaries(map) {
    if (!map || !map.getStyle) return;
    const anchor = map.getLayer('hms-smoke-fill') ? 'hms-smoke-fill' : undefined;
    GEO_BOUNDARY_LAYERS.forEach(id => {
        if (map.getLayer(id)) { try { map.moveLayer(id, anchor); } catch (_) {} }
    });
}

function setupMapLayers(map, paneId) {
    // ─── Layer 0: Great Lakes Boundaries (High-fidelity vector polygons) ───
    map.addSource('great-lakes', {
        type: 'geojson',
        data: greatLakesLoaded ? greatLakesGeoJSON : { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
        id: 'great-lakes-outline',
        type: 'line',
        source: 'great-lakes',
        layout: { visibility: 'visible' },
        paint: {
            'line-color': '#00bfff', // Premium cyan sky-blue outline
            'line-width': 1.5,
            'line-opacity': 0.8
        }
    });

    // ─── Layer 0.5: Coastlines and International Borders ───
    // White cores with a dark casing (halo) so they stay legible over BOTH
    // bright cloud tops and dark land/ocean on grayscale satellite and radar.
    map.addSource('coastlines', {
        type: 'geojson',
        data: 'https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_coastline.geojson'
    });
    map.addLayer({
        id: 'coastlines-casing-layer',
        type: 'line',
        source: 'coastlines',
        layout: { visibility: 'visible' },
        paint: { 'line-color': '#000000', 'line-width': 3.0, 'line-opacity': 0.55, 'line-blur': 0.4 }
    });
    map.addLayer({
        id: 'coastlines-layer',
        type: 'line',
        source: 'coastlines',
        layout: { visibility: 'visible' },
        paint: { 'line-color': '#ffffff', 'line-width': 1.3, 'line-opacity': 0.95 }
    });

    map.addSource('international-borders', {
        type: 'geojson',
        data: 'https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_admin_0_boundary_lines_land.geojson'
    });
    map.addLayer({
        id: 'international-borders-casing-layer',
        type: 'line',
        source: 'international-borders',
        layout: { visibility: 'visible' },
        paint: { 'line-color': '#000000', 'line-width': 3.0, 'line-opacity': 0.5, 'line-blur': 0.4 }
    });
    map.addLayer({
        id: 'international-borders-layer',
        type: 'line',
        source: 'international-borders',
        layout: { visibility: 'visible' },
        paint: { 'line-color': '#ffffff', 'line-width': 1.2, 'line-dasharray': [2, 2], 'line-opacity': 0.9 }
    });

    // ─── Layer 1: State Boundaries (visible by default) ───
    map.addSource('states', {
        type: 'raster',
        tiles: ['https://mesonet.agron.iastate.edu/cgi-bin/wms/us/states.cgi?VERSION=1.1.1&SERVICE=WMS&REQUEST=GetMap&LAYERS=usstates&FORMAT=image/png&TRANSPARENT=true&STYLES=&SRS=EPSG:3857&WIDTH=256&HEIGHT=256&BBOX={bbox-epsg-3857}'],
        tileSize: 256
    });
    // IEM renders these lines in pure black; raster-brightness-min:1 lifts the
    // darkest pixels to white so state lines read on dark radar + grayscale sat.
    map.addLayer({ id: 'states-layer', type: 'raster', source: 'states', layout: { visibility: 'visible' }, paint: { 'raster-opacity': 0.95, 'raster-brightness-min': 1 } });

    // ─── Layer 1a: County Boundaries (IEM raster, off by default) ───
    // Same black-line WMS as states; whitened via raster-brightness-min. Stays
    // crisp at every zoom (re-rendered per bbox), unlike a coarse vector file.
    map.addSource('counties', {
        type: 'raster',
        tiles: ['https://mesonet.agron.iastate.edu/cgi-bin/wms/us/counties.cgi?VERSION=1.1.1&SERVICE=WMS&REQUEST=GetMap&LAYERS=uscounties&FORMAT=image/png&TRANSPARENT=true&STYLES=&SRS=EPSG:3857&WIDTH=256&HEIGHT=256&BBOX={bbox-epsg-3857}'],
        tileSize: 256
    });
    map.addLayer({ id: 'counties-layer', type: 'raster', source: 'counties', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.7, 'raster-brightness-min': 1 } });

    // ─── Layer 1b: NWS CWA Boundaries (County Warning Areas / WFO Zones) ───
    map.addSource('nws-cwa-wms', {
        type: 'raster',
        tiles: ['https://mapservices.weather.noaa.gov/static/services/nws_reference_maps/nws_reference_map/MapServer/WMSServer?service=WMS&version=1.1.1&request=GetMap&layers=11&format=image/png&transparent=true&styles=&srs=EPSG:3857&width=256&height=256&bbox={bbox-epsg-3857}'],
        tileSize: 256
    });
    map.addLayer({ id: 'nws-cwa-layer', type: 'raster', source: 'nws-cwa-wms', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.85 } });

    // CWA Labels (WFO identifiers at office locations)
    map.addSource('nws-cwa-labels', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
        id: 'nws-cwa-label-layer', type: 'symbol', source: 'nws-cwa-labels',
        layout: {
            visibility: 'none',
            'text-field': ['get', 'wfo'],
            'text-size': 11,
            'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
            'text-allow-overlap': false,
            'text-ignore-placement': false,
            'text-padding': 4
        },
        paint: {
            'text-color': '#00ddff',
            'text-halo-color': '#000000',
            'text-halo-width': 1.5
        }
    });

    // ─── Layer 4: SPC Outlooks (Independent Days) ───
    [1, 2, 3].forEach(day => {
        map.addSource(`spc-day${day}`, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        map.addLayer({
            id: `spc-day${day}-fill`,
            type: 'fill',
            source: `spc-day${day}`,
            layout: { visibility: 'none' },
            paint: {
                'fill-color': ['get', 'fill'],
                'fill-opacity': 0.3
            }
        });
        map.addLayer({
            id: `spc-day${day}-line`,
            type: 'line',
            source: `spc-day${day}`,
            layout: { visibility: 'none' },
            paint: {
                'line-color': ['get', 'stroke'],
                'line-width': 2
            }
        });
    });

    // ─── Layer 4a1b: SPC Day 4-8 Severe Weather Outlook (15%/30% probability) ───
    // One merged source for all five days; each feature is tagged d4-d8 and
    // carries SPC's own fill/stroke colors like the D1-3 products.
    map.addSource('spc-d48', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
        id: 'spc-d48-fill', type: 'fill', source: 'spc-d48',
        layout: { visibility: 'none' },
        paint: { 'fill-color': ['coalesce', ['get', 'fill'], '#b87aff'], 'fill-opacity': 0.25 }
    });
    map.addLayer({
        id: 'spc-d48-line', type: 'line', source: 'spc-d48',
        layout: { visibility: 'none' },
        paint: { 'line-color': ['coalesce', ['get', 'stroke'], '#b87aff'], 'line-width': 2 }
    });
    map.addLayer({
        id: 'spc-d48-label', type: 'symbol', source: 'spc-d48',
        layout: {
            visibility: 'none', 'symbol-placement': 'line',
            'text-field': ['get', 'dayTag'], 'text-font': ['Noto Sans Regular'], 'text-size': 11
        },
        paint: { 'text-color': '#e8d5ff', 'text-halo-color': '#000', 'text-halo-width': 1.5 }
    });

    // ─── Layer 7e3: Center Weather Advisories (CWSU CWA — short-fuse aviation) ───
    map.addSource('cwa', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
        id: 'cwa-fill', type: 'fill', source: 'cwa',
        layout: { visibility: 'none' },
        paint: { 'fill-color': '#ff5ac4', 'fill-opacity': 0.10 }
    });
    map.addLayer({
        id: 'cwa-outline', type: 'line', source: 'cwa',
        layout: { visibility: 'none' },
        paint: { 'line-color': '#ff5ac4', 'line-width': 1.8, 'line-dasharray': [3, 2] }
    });
    map.addLayer({
        id: 'cwa-label', type: 'symbol', source: 'cwa',
        layout: {
            visibility: 'none',
            'text-field': ['concat', ['coalesce', ['get', 'cwsu'], ''], ' CWA'],
            'text-font': ['Noto Sans Regular'], 'text-size': 10
        },
        paint: { 'text-color': '#ffb3e2', 'text-halo-color': '#000', 'text-halo-width': 1.4 }
    });

    // ─── Layer 7k: NDBC marine buoy observations ───
    map.addSource('ndbc', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
        id: 'ndbc-layer', type: 'circle', source: 'ndbc',
        layout: { visibility: 'none' },
        paint: {
            'circle-radius': 4.5,
            'circle-color': '#00b8d4',
            'circle-stroke-color': '#003c46', 'circle-stroke-width': 1.5, 'circle-opacity': 0.9
        }
    });
    map.addLayer({
        id: 'ndbc-label', type: 'symbol', source: 'ndbc',
        minzoom: 5,
        layout: {
            visibility: 'none',
            'text-field': ['get', 'tag'], 'text-font': ['Noto Sans Regular'],
            'text-size': 9, 'text-offset': [0, 1.1], 'text-anchor': 'top'
        },
        paint: { 'text-color': '#9fe8f5', 'text-halo-color': '#000', 'text-halo-width': 1.4 }
    });

    // ─── Layer 4a2: SPC Probabilistic Hazard Outlooks (Day 1 & 2: Tornado/Wind/Hail) ───
    // Each GeoJSON carries its own per-probability fill/stroke colors AND embedded
    // significant-severe "Conditional Intensity Group" features (CIG1/2/3, gray fill +
    // black #000000 stroke). We split one source by stroke color: colored probability
    // contours vs. the significant area, which SPC draws as intensity-graded hatching —
    // CIG1 sparse diagonal, CIG2 dense diagonal, CIG3 cross-hatch.
    [1, 2, 3].forEach(n => {
        const id = `spc-hatch-${n}`;
        if (map.hasImage(id)) return;
        const sz = 8;
        const cv = document.createElement('canvas');
        cv.width = cv.height = sz;
        const cx = cv.getContext('2d');
        drawSpcHatch(cx, sz, n);
        map.addImage(id, cx.getImageData(0, 0, sz, sz), { pixelRatio: 1 });
    });
    const PROB_ONLY = ['!=', ['get', 'stroke'], '#000000'];
    const SIG_ONLY = ['==', ['get', 'stroke'], '#000000'];
    [1, 2].forEach(day => {
        ['torn', 'wind', 'hail'].forEach(hz => {
            const sid = `spc-prob-${day}-${hz}`;
            map.addSource(sid, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
            map.addLayer({
                id: `${sid}-fill`, type: 'fill', source: sid, filter: PROB_ONLY,
                layout: { visibility: 'none' },
                paint: { 'fill-color': ['get', 'fill'], 'fill-opacity': 0.35 }
            });
            map.addLayer({
                id: `${sid}-line`, type: 'line', source: sid, filter: PROB_ONLY,
                layout: { visibility: 'none' },
                paint: { 'line-color': ['get', 'stroke'], 'line-width': 1.6 }
            });
            // Significant-severe hatching, one fill per Conditional Intensity Group
            [1, 2, 3].forEach(n => {
                map.addLayer({
                    id: `spc-sig-${day}-${hz}-i${n}`, type: 'fill', source: sid,
                    filter: ['==', ['get', 'LABEL'], `CIG${n}`],
                    layout: { visibility: 'none' },
                    paint: { 'fill-pattern': `spc-hatch-${n}`, 'fill-opacity': 0.9 }
                });
            });
            // Single black outline around all significant areas (drawn on top)
            map.addLayer({
                id: `spc-sig-${day}-${hz}-line`, type: 'line', source: sid, filter: SIG_ONLY,
                layout: { visibility: 'none' },
                paint: { 'line-color': '#000000', 'line-width': 1.1 }
            });
        });
    });

    // ─── Layer 4a3: SPC Fire Weather Outlooks (Days 1 & 2) ───
    // Fed by /api/spc-fire-wx (KMZ->GeoJSON). Categorical risk areas (Elevated/
    // Critical/Extremely Critical) are filled + outlined; dry-thunderstorm areas
    // (kind='dryt', no fill) draw as dashed boundaries over the categorical fills.
    const FWX_CAT = ['==', ['get', 'kind'], 'cat'];
    const FWX_DRYT = ['==', ['get', 'kind'], 'dryt'];
    [1, 2, 3, 4, 5, 6, 7, 8].forEach(day => {
        const sid = `spc-firewx-day${day}`;
        map.addSource(sid, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        map.addLayer({
            id: `${sid}-fill`, type: 'fill', source: sid, filter: FWX_CAT,
            layout: { visibility: 'none' },
            paint: { 'fill-color': ['get', 'fill'], 'fill-opacity': 0.35 }
        });
        map.addLayer({
            id: `${sid}-line`, type: 'line', source: sid, filter: FWX_CAT,
            layout: { visibility: 'none' },
            paint: { 'line-color': ['get', 'stroke'], 'line-width': 2 }
        });
        map.addLayer({
            id: `${sid}-dryt`, type: 'line', source: sid, filter: FWX_DRYT,
            layout: { visibility: 'none' },
            paint: { 'line-color': ['get', 'stroke'], 'line-width': 2, 'line-dasharray': [3, 2] }
        });
    });

    // ─── Layer 4b: WPC Excessive Rainfall Outlook (ERO, Days 1-3) ───
    // Categorical risk polygons (MRGL/SLGT/MDT/HIGH), fed by /api/wpc-ero
    // (KMZ->GeoJSON proxy). Same fill/line pattern as the SPC outlook.
    [1, 2, 3].forEach(day => {
        map.addSource(`wpc-ero-day${day}`, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        map.addLayer({
            id: `wpc-ero-day${day}-fill`,
            type: 'fill',
            source: `wpc-ero-day${day}`,
            layout: { visibility: 'none' },
            paint: {
                'fill-color': ['get', 'fill'],
                'fill-opacity': 0.35
            }
        });
        map.addLayer({
            id: `wpc-ero-day${day}-line`,
            type: 'line',
            source: `wpc-ero-day${day}`,
            layout: { visibility: 'none' },
            paint: {
                'line-color': ['get', 'stroke'],
                'line-width': 1.6
            }
        });
    });

    // ─── Layer 3: Satellite (GOES bird + sector chosen per pane) ───
    // Placeholder tiles only — the source is repointed the moment a channel is
    // picked, so the pane's own sector always wins over this default.
    map.addSource('satellite', {
        type: 'raster',
        tiles: [goesChannelUrl(13, DEFAULT_GOES_SECTOR)],
        tileSize: 256
    });
    map.addLayer({ id: 'satellite-layer', type: 'raster', source: 'satellite', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.8 } });

    // ─── Layer 3b: Lightning — NLDN Cloud-to-Ground Strike Density (NOAA nowCOAST) ───
    map.addSource('lightning', {
        type: 'raster',
        tiles: [lightningUrl()],
        tileSize: 256
    });
    map.addLayer({ id: 'lightning-layer', type: 'raster', source: 'lightning', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 150 } });

    // ─── Layer 4: National Radar (IEM mosaic) ───
    map.addSource('radar', {
        type: 'raster',
        tiles: [nationalRadarUrl()],
        tileSize: 256
    });
    map.addLayer({ id: 'radar-layer', type: 'raster', source: 'radar', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.9, 'raster-resampling': 'linear', 'raster-fade-duration': 150 } });

    // ─── Layer 4b: Site-Specific Radar (NCEP OpenGeo WMS) ───
    // Init hidden site sources with a valid placeholder when the pane is in National mode
    // (the national pseudo-site isn't a real OpenGeo workspace). Real site set on selection.
    const paneSite = paneRadarSites[paneId] || '';
    const defaultSite = (paneSite && !paneSite.includes('nexrad') ? paneSite : 'dgx').toLowerCase();
    map.addSource('site-bref', {
        type: 'raster',
        tiles: [siteRadarUrl(defaultSite, 'sr_bref')],
        tileSize: 512
    });
    map.addLayer({ id: 'site-bref-layer', type: 'raster', source: 'site-bref', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.9, 'raster-resampling': 'linear', 'raster-fade-duration': 150 } });

    map.addSource('site-bvel', {
        type: 'raster',
        tiles: [siteRadarUrl(defaultSite, 'sr_bvel')],
        tileSize: 512
    });
    map.addLayer({ id: 'site-bvel-layer', type: 'raster', source: 'site-bvel', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.9, 'raster-resampling': 'linear', 'raster-fade-duration': 150 } });

    map.addSource('site-bdhc', {
        type: 'raster',
        tiles: [siteRadarUrl(defaultSite, 'bdhc')],
        tileSize: 512
    });
    map.addLayer({ id: 'site-bdhc-layer', type: 'raster', source: 'site-bdhc', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.9, 'raster-resampling': 'linear', 'raster-fade-duration': 150 } });

    map.addSource('site-bdsa', {
        type: 'raster',
        tiles: [siteRadarUrl(defaultSite, 'bdsa')],
        tileSize: 512
    });
    map.addLayer({ id: 'site-bdsa-layer', type: 'raster', source: 'site-bdsa', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.9, 'raster-resampling': 'linear', 'raster-fade-duration': 150 } });

    map.addSource('site-boha', {
        type: 'raster',
        tiles: [siteRadarUrl(defaultSite, 'boha')],
        tileSize: 512
    });
    map.addLayer({ id: 'site-boha-layer', type: 'raster', source: 'site-boha', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.9, 'raster-resampling': 'linear', 'raster-fade-duration': 150 } });

    // ─── Layer 4c: Interactive Tactical Radar Domes (Right-Click Selector) ───
    initRadarDomeIcon(map);
    map.addSource('nexrad-sites', {
        type: 'geojson',
        data: getRadarSitesGeoJSON()
    });
    map.addLayer({
        id: 'nexrad-sites-layer',
        type: 'symbol',
        source: 'nexrad-sites',
        layout: {
            'visibility': 'none',
            'icon-image': 'radar-dome-icon',
            'icon-size': 0.75,
            'icon-allow-overlap': true,
            'text-field': ['get', 'id'],
            'text-font': ['Noto Sans Bold'],
            'text-size': 13,
            'text-offset': [0, 1.4],
            'text-anchor': 'top',
            'text-allow-overlap': false
        },
        paint: {
            'text-color': '#00ffff',
            'text-halo-color': '#000',
            'text-halo-width': 2
        }
    });

    // ─── Layer 5: SPC Convective Outlooks ───
    map.addSource('spc-outlook', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
        id: 'spc-outlook-fill', type: 'fill', source: 'spc-outlook',
        layout: { visibility: 'none' },
        paint: {
            'fill-color': ['coalesce', ['get', 'fill'],
                ['match', ['get', 'LABEL'],
                    'TSTM', '#90EE90', 'MRGL', '#006400', 'SLGT', '#FFFF00',
                    'ENH', '#FFA500', 'MDT', '#FF0000', 'HIGH', '#FF00FF', '#888888']
            ],
            'fill-opacity': 0.4
        }
    });
    map.addLayer({
        id: 'spc-outlook-line', type: 'line', source: 'spc-outlook',
        layout: { visibility: 'none' },
        paint: {
            'line-color': ['coalesce', ['get', 'stroke'],
                ['match', ['get', 'LABEL'],
                    'TSTM', '#44BB44', 'MRGL', '#004400', 'SLGT', '#BBBB00',
                    'ENH', '#BB8800', 'MDT', '#BB0000', 'HIGH', '#BB00BB', '#ffffff']
            ],
            'line-width': 2
        }
    });

    // ─── Layer 5b: Mesoscale Discussions ───
    map.addSource('spc-md', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
        id: 'spc-md-fill', type: 'fill', source: 'spc-md',
        layout: { visibility: 'none' },
        paint: { 'fill-color': '#ff0000', 'fill-opacity': 0.2 }
    });
    map.addLayer({
        id: 'spc-md-outline', type: 'line', source: 'spc-md',
        layout: { visibility: 'none' },
        paint: { 'line-color': '#ff4444', 'line-width': 3, 'line-dasharray': [2, 1] }
    });

    // ─── Layer 5b-2: WPC Mesoscale Precipitation Discussions (MPD) ───
    // Behaves like the SPC mesoscale discussions; fed by /api/wpc-mpd.
    map.addSource('wpc-mpd', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
        id: 'wpc-mpd-fill', type: 'fill', source: 'wpc-mpd',
        layout: { visibility: 'none' },
        paint: { 'fill-color': ['get', 'fill'], 'fill-opacity': 0.2 }
    });
    map.addLayer({
        id: 'wpc-mpd-outline', type: 'line', source: 'wpc-mpd',
        layout: { visibility: 'none' },
        paint: { 'line-color': ['get', 'stroke'], 'line-width': 3, 'line-dasharray': [2, 1] }
    });

    // ─── Layer 5b: SPC Local Storm Reports (GeoJSON points with icons) ───
    try { initLSRIcons(map); } catch (e) { console.error('LSR icon init failed:', e); }
    map.addSource('spc-lsr', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
        id: 'spc-lsr-icons', type: 'symbol', source: 'spc-lsr',
        layout: {
            visibility: 'none',
            'icon-image': ['get', 'iconId'],
            'icon-size': ['interpolate', ['linear'], ['zoom'], 3, 0.55, 7, 0.85, 12, 1.2],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true
        }
    });
    // Magnitude label below icon (hail size, wind speed)
    map.addLayer({
        id: 'spc-lsr-mag', type: 'symbol', source: 'spc-lsr',
        layout: {
            visibility: 'none',
            'text-field': ['get', 'magLabel'],
            'text-size': ['interpolate', ['linear'], ['zoom'], 5, 0, 7, 9, 12, 12],
            'text-offset': [0, 1.3],
            'text-allow-overlap': true,
            'text-ignore-placement': true,
            'text-font': ['Noto Sans Bold']
        },
        paint: {
            'text-color': '#ffffff',
            'text-halo-color': '#000000',
            'text-halo-width': 1.5
        },
        filter: ['!=', ['get', 'magLabel'], '']
    });

    // ─── Layer 6: NWS Alerts (GeoJSON polygons) ───
    map.addSource('nws-warnings', {
        type: 'geojson',
        data: warningsLoaded ? warningsGeoJSON : { type: 'FeatureCollection', features: [] }
    });
    map.addSource('nws-watches-vector', {
        type: 'geojson',
        data: watchesLoaded ? watchesGeoJSON : { type: 'FeatureCollection', features: [] }
    });

    // 6a: Warnings & Advisories Layers (Broadened)
    // ── Official NWS WWA Color Table (https://www.weather.gov/help-map) ──
    // Split into two independently-toggleable classes (like the Watches layer):
    //   Warnings   = event contains "Warning"/"Emergency" (imminent threat)
    //   Advisories = Statements / Advisories / Alerts / Outlooks (everything else)
    const nwsWwaKinds = ['any',
        ['in', 'Warning', ['get', 'event']],
        ['in', 'Emergency', ['get', 'event']],
        ['in', 'Statement', ['get', 'event']],
        ['in', 'Advisory', ['get', 'event']],
        ['in', 'Alert', ['get', 'event']],
        ['in', 'Outlook', ['get', 'event']]
    ];
    const nwsNotWatch = ['!', ['in', 'Watch', ['get', 'event']]];  // Watches have their own dedicated layer
    const nwsWarnClass = ['any', ['in', 'Warning', ['get', 'event']], ['in', 'Emergency', ['get', 'event']]];
    const nwsWwaFilter = ['all', nwsWwaKinds, nwsNotWatch, nwsWarnClass];            // warnings only
    const nwsAdvisFilter = ['all', nwsWwaKinds, nwsNotWatch, ['!', nwsWarnClass]];   // advisories/statements only
    const nwsColorExpr = ['match', ['get', 'event'],
        // ── Warnings (imminent threat) ──
        'Tsunami Warning',              '#fd6347',
        'Tornado Warning',              '#ff0000',
        'Extreme Wind Warning',         '#ff8c00',
        'Severe Thunderstorm Warning',  '#ffa500',
        'Flash Flood Warning',          '#8b0000',
        'Flash Flood Statement',        '#8b0000',
        'Severe Weather Statement',     '#00ffff',
        'Shelter In Place Warning',     '#fa8072',
        'Evacuation Immediate',         '#7fff00',
        'Civil Danger Warning',         '#ffb6c1',
        'Fire Warning',                 '#a0522d',
        'Storm Surge Warning',          '#b524f7',
        'Hurricane Force Wind Warning', '#cd5c5c',
        'Hurricane Warning',            '#dc143c',
        'Typhoon Warning',              '#dc143c',
        'Special Marine Warning',       '#ffa500',
        'Blizzard Warning',             '#ff4500',
        'Snow Squall Warning',          '#c71585',
        'Ice Storm Warning',            '#8b008b',
        'Heavy Freezing Spray Warning', '#00bfff',
        'Winter Storm Warning',         '#ff69b4',
        'Lake Effect Snow Warning',     '#008b8b',
        'Dust Storm Warning',           '#ffe4c4',
        'Blowing Dust Warning',         '#ffe4c4',
        'High Wind Warning',            '#daa520',
        'Tropical Storm Warning',       '#b22222',
        'Storm Warning',                '#9400d3',
        'Avalanche Warning',            '#1e90ff',
        'Earthquake Warning',           '#8b4513',
        'Volcano Warning',              '#2f4f4f',
        'Ashfall Warning',              '#a9a9a9',
        'Flood Warning',                '#00ff00',
        'Flood Statement',              '#00ff00',
        'Coastal Flood Warning',        '#228b22',
        'Lakeshore Flood Warning',      '#228b22',
        'High Surf Warning',            '#228b22',
        'Gale Warning',                 '#dda0dd',
        'Extreme Cold Warning',         '#0000ff',
        'Freeze Warning',               '#483d8b',
        'Hard Freeze Warning',          '#9400d3',
        'Red Flag Warning',             '#ff1493',
        'Excessive Heat Warning',       '#c71585',
        'Wind Chill Warning',           '#b0c4de',
        'Hazardous Seas Warning',       '#d8bfd8',
        // ── Watches (potential threat) ──
        'Tsunami Watch',                '#ff00ff',
        'Tornado Watch',                '#ffff00',
        'Severe Thunderstorm Watch',    '#db7093',
        'Flash Flood Watch',            '#2e8b57',
        'Flood Watch',                  '#2e8b57',
        'Coastal Flood Watch',          '#66cdaa',
        'Lakeshore Flood Watch',        '#66cdaa',
        'Hurricane Watch',              '#ff00ff',
        'Hurricane Force Wind Watch',   '#9932cc',
        'Typhoon Watch',                '#ff00ff',
        'Tropical Storm Watch',         '#f08080',
        'Storm Watch',                  '#ffe4b5',
        'Storm Surge Watch',            '#db7ff7',
        'Fire Weather Watch',           '#ffdead',
        'Winter Storm Watch',           '#4682b4',
        'Lake Effect Snow Watch',       '#87cefa',
        'Freeze Watch',                 '#00ffff',
        'Hard Freeze Watch',            '#4169e1',
        'Wind Chill Watch',             '#5f9ea0',
        'Extreme Cold Watch',           '#5f9ea0',
        'Excessive Heat Watch',         '#800000',
        'High Wind Watch',              '#b8860b',
        'Gale Watch',                   '#ffc0cb',
        'Hazardous Seas Watch',         '#483d8b',
        'Heavy Freezing Spray Watch',   '#bc8f8f',
        'Avalanche Watch',              '#f4a460',
        // ── Advisories ──
        'Wind Advisory',                '#d2b48c',
        'Lake Wind Advisory',           '#d2b48c',
        'Brisk Wind Advisory',          '#d8bfd8',
        'Small Craft Advisory',         '#d8bfd8',
        'Flood Advisory',               '#00ff7f',
        'Coastal Flood Advisory',       '#7cfc00',
        'Lakeshore Flood Advisory',     '#7cfc00',
        'Heat Advisory',                '#ff7f50',
        'Frost Advisory',               '#6495ed',
        'Dense Fog Advisory',           '#708090',
        'Dense Smoke Advisory',         '#f0e68c',
        'Freezing Fog Advisory',        '#008080',
        'Freezing Spray Advisory',      '#00bfff',
        'High Surf Advisory',           '#ba55d3',
        'Winter Weather Advisory',      '#7b68ee',
        'Freezing Rain Advisory',       '#da70d6',
        'Lake Effect Snow Advisory',    '#48d1cc',
        'Avalanche Advisory',           '#cd853f',
        'Dust Advisory',                '#bdb76b',
        'Blowing Dust Advisory',        '#bdb76b',
        'Ashfall Advisory',             '#696969',
        'Cold Weather Advisory',        '#afeeee',
        'Tsunami Advisory',             '#d2691e',
        'Low Water Advisory',           '#a52a2a',
        'Air Stagnation Advisory',      '#808080',
        // ── Statements & Alerts ──
        'Special Weather Statement',    '#ffe4b5',
        'Marine Weather Statement',     '#ffdab9',
        'Rip Current Statement',        '#40e0d0',
        'Beach Hazards Statement',      '#40e0d0',
        'Coastal Flood Statement',      '#6b8e23',
        'Lakeshore Flood Statement',    '#6b8e23',
        'Tropical Cyclone Local Statement', '#ffe4b5',
        'Air Quality Alert',            '#808080',
        'Hydrologic Outlook',           '#90ee90',
        'Hazardous Weather Outlook',    '#eee8aa',
        'Short Term Forecast',          '#98fb98',
        // ── Fallback ──
        '#c0c0c0'
    ];
    // Advisories / Statements stack — drawn beneath the warnings stack.
    map.addLayer({
        id: 'nws-advis-fill', type: 'fill', source: 'nws-warnings',
        layout: { visibility: 'none' },
        filter: nwsAdvisFilter,
        paint: {
            'fill-color': nwsColorExpr,
            'fill-opacity': ['case',
                ['in', 'Statement', ['get', 'event']], 0.25,
                ['in', 'Outlook', ['get', 'event']], 0.2,
                0.35
            ]
        }
    });
    map.addLayer({
        id: 'nws-advis-casing', type: 'line', source: 'nws-warnings',
        layout: { visibility: 'none' },
        filter: nwsAdvisFilter,
        paint: {
            'line-color': '#000000',
            'line-width': ['case', ['in', 'Statement', ['get', 'event']], 3.5, 4.0],
            'line-opacity': 0.55,
            'line-blur': 0.5
        }
    });
    map.addLayer({
        id: 'nws-advis-outline', type: 'line', source: 'nws-warnings',
        layout: { visibility: 'none' },
        filter: nwsAdvisFilter,
        paint: {
            'line-color': nwsColorExpr,
            'line-width': ['case', ['in', 'Statement', ['get', 'event']], 1.0, 1.5],
            'line-opacity': 0.9
        }
    });

    map.addLayer({
        id: 'nws-warnings-only-fill', type: 'fill', source: 'nws-warnings',
        layout: { visibility: 'none' },
        filter: nwsWwaFilter,
        paint: {
            'fill-color': nwsColorExpr,
            'fill-opacity': ['case',
                ['==', ['get', 'event'], 'Tornado Warning'], 0.6,
                ['==', ['get', 'event'], 'Severe Thunderstorm Warning'], 0.5,
                ['==', ['get', 'event'], 'Flash Flood Warning'], 0.5,
                ['in', 'Warning', ['get', 'event']], 0.4,
                ['in', 'Statement', ['get', 'event']], 0.25,
                ['in', 'Outlook', ['get', 'event']], 0.2,
                0.35
            ]
        }
    });
    // Dark casing beneath the colored outline — only shown in OUTLINE mode so the
    // severity-colored borders read clearly over radar/satellite/dark land.
    map.addLayer({
        id: 'nws-warnings-only-casing', type: 'line', source: 'nws-warnings',
        layout: { visibility: 'none' },
        filter: nwsWwaFilter,
        paint: {
            'line-color': '#000000',
            'line-width': ['case',
                ['==', ['get', 'event'], 'Tornado Warning'], 6.5,
                ['==', ['get', 'event'], 'Severe Thunderstorm Warning'], 5.5,
                ['==', ['get', 'event'], 'Flash Flood Warning'], 5.5,
                ['in', 'Warning', ['get', 'event']], 5.0,
                ['in', 'Statement', ['get', 'event']], 3.5,
                4.0
            ],
            'line-opacity': 0.55,
            'line-blur': 0.5
        }
    });
    map.addLayer({
        id: 'nws-warnings-only-outline', type: 'line', source: 'nws-warnings',
        layout: { visibility: 'none' },
        filter: nwsWwaFilter,
        paint: {
            'line-color': nwsColorExpr,
            'line-width': ['case',
                ['==', ['get', 'event'], 'Tornado Warning'], 3.5,
                ['==', ['get', 'event'], 'Severe Thunderstorm Warning'], 2.5,
                ['==', ['get', 'event'], 'Flash Flood Warning'], 2.5,
                ['in', 'Warning', ['get', 'event']], 2.0,
                ['in', 'Statement', ['get', 'event']], 1.0,
                1.5
            ],
            'line-opacity': 0.9
        }
    });

    // 6a-IBW: Enhanced / Impact-Based Warning Overlays (Considerable, Catastrophic, Emergency, PDS)
    // These layers sit on top of regular warnings and pulse to draw attention
    const enhancedWarnFilter = ['any',
        ['in', ['get', 'damageThreat'], ['literal', ['Considerable', 'Catastrophic', 'Destructive']]],
        ['==', ['get', 'isEmergency'], true],
        ['==', ['get', 'isPDS'], true]
    ];
    const enhancedColorExpr = ['case',
        ['any', ['==', ['get', 'damageThreat'], 'Catastrophic'], ['==', ['get', 'damageThreat'], 'Destructive'], ['==', ['get', 'isEmergency'], true]],
        '#ff0000',
        '#ff8800'  // Considerable / PDS
    ];
    map.addLayer({
        id: 'nws-enhanced-glow', type: 'line', source: 'nws-warnings',
        layout: { visibility: 'none' },
        filter: enhancedWarnFilter,
        paint: {
            'line-color': enhancedColorExpr,
            'line-width': 10,
            'line-opacity': 0.35,
            'line-blur': 6
        }
    });
    map.addLayer({
        id: 'nws-enhanced-outline', type: 'line', source: 'nws-warnings',
        layout: { visibility: 'none' },
        filter: enhancedWarnFilter,
        paint: {
            'line-color': '#ffffff',
            'line-width': ['case',
                ['any', ['==', ['get', 'damageThreat'], 'Catastrophic'], ['==', ['get', 'isEmergency'], true]], 3.5,
                2.5
            ],
            'line-opacity': 0.95,
            'line-dasharray': [3, 2]
        }
    });
    map.addLayer({
        id: 'nws-enhanced-fill', type: 'fill', source: 'nws-warnings',
        layout: { visibility: 'none' },
        filter: enhancedWarnFilter,
        paint: {
            'fill-color': enhancedColorExpr,
            'fill-opacity': 0.25
        }
    });
    // IBW label — shows threat tag ("CONSIDERABLE", "CATASTROPHIC", "EMERGENCY", "PDS") inside polygon
    map.addLayer({
        id: 'nws-enhanced-label', type: 'symbol', source: 'nws-warnings',
        layout: {
            visibility: 'none',
            'symbol-placement': 'point',
            'text-field': ['case',
                ['==', ['get', 'isEmergency'], true], '⚠ EMERGENCY',
                ['any', ['==', ['get', 'damageThreat'], 'Catastrophic'], ['==', ['get', 'damageThreat'], 'Destructive']], '⚠ CATASTROPHIC',
                ['==', ['get', 'isPDS'], true], '⚠ PDS',
                ['==', ['get', 'damageThreat'], 'Considerable'], '⚠ CONSIDERABLE',
                ''
            ],
            'text-size': 12,
            'text-font': ['Open Sans Bold'],
            'text-allow-overlap': true,
            'text-ignore-placement': true
        },
        filter: enhancedWarnFilter,
        paint: {
            'text-color': '#ffffff',
            'text-halo-color': ['case',
                ['any', ['==', ['get', 'damageThreat'], 'Catastrophic'], ['==', ['get', 'isEmergency'], true]], '#cc0000',
                '#cc6600'
            ],
            'text-halo-width': 2
        }
    });

    // 6b: Watches Layer (High-fidelity vector polygons from NOAA REST MapServer)
    map.addLayer({
        id: 'nws-watches-only-fill', type: 'fill', source: 'nws-watches-vector',
        layout: { visibility: 'none' },
        filter: ['in', 'Watch', ['get', 'prod_type']],
        paint: {
            'fill-color': ['match', ['get', 'prod_type'],
                'Tornado Watch',              '#ffff00',
                'Severe Thunderstorm Watch',  '#db7093',
                'Flash Flood Watch',          '#2e8b57',
                'Flood Watch',                '#2e8b57',
                'Coastal Flood Watch',        '#66cdaa',
                'Lakeshore Flood Watch',      '#66cdaa',
                'Fire Weather Watch',         '#ffdead',
                'Winter Storm Watch',         '#4682b4',
                'Lake Effect Snow Watch',     '#87cefa',
                'Freeze Watch',               '#00ffff',
                'Hard Freeze Watch',          '#4169e1',
                'Wind Chill Watch',           '#5f9ea0',
                'Extreme Cold Watch',         '#5f9ea0',
                'Excessive Heat Watch',       '#800000',
                'High Wind Watch',            '#b8860b',
                'Hurricane Watch',            '#ff00ff',
                'Tropical Storm Watch',       '#f08080',
                'Storm Surge Watch',          '#db7ff7',
                'Gale Watch',                 '#ffc0cb',
                'Hazardous Seas Watch',       '#483d8b',
                'Avalanche Watch',            '#f4a460',
                '#ffff00'
            ],
            'fill-opacity': 0.3
        }
    });
    map.addLayer({
        id: 'nws-watches-only-outline', type: 'line', source: 'nws-watches-vector',
        layout: { visibility: 'none' },
        filter: ['in', 'Watch', ['get', 'prod_type']],
        paint: {
            'line-color': ['match', ['get', 'prod_type'],
                'Tornado Watch',              '#ffff00',
                'Severe Thunderstorm Watch',  '#db7093',
                'Flash Flood Watch',          '#2e8b57',
                'Flood Watch',                '#2e8b57',
                'Coastal Flood Watch',        '#66cdaa',
                'Lakeshore Flood Watch',      '#66cdaa',
                'Fire Weather Watch',         '#ffdead',
                'Winter Storm Watch',         '#4682b4',
                'Lake Effect Snow Watch',     '#87cefa',
                'Freeze Watch',               '#00ffff',
                'Hard Freeze Watch',          '#4169e1',
                'Wind Chill Watch',           '#5f9ea0',
                'Extreme Cold Watch',         '#5f9ea0',
                'Excessive Heat Watch',       '#800000',
                'High Wind Watch',            '#b8860b',
                'Hurricane Watch',            '#ff00ff',
                'Tropical Storm Watch',       '#f08080',
                'Storm Surge Watch',          '#db7ff7',
                'Gale Watch',                 '#ffc0cb',
                'Hazardous Seas Watch',       '#483d8b',
                'Avalanche Watch',            '#f4a460',
                '#ffff00'
            ],
            'line-width': 1.5,
            'line-dasharray': [2, 1]
        }
    });

    // ─── Layer 6b: NWS WWA WMS Tiles (zone-based warnings) ───
    map.addSource('nws-wwa-wms', {
        type: 'raster',
        tiles: ['https://mapservices.weather.noaa.gov/eventdriven/services/WWA/watch_warn_adv/MapServer/WMSServer?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=0&FORMAT=image/png&TRANSPARENT=true&STYLES=&SRS=EPSG:3857&WIDTH=256&HEIGHT=256&BBOX={bbox-epsg-3857}'],
        tileSize: 256
    });
    map.addLayer({ id: 'nws-wwa-wms-layer', type: 'raster', source: 'nws-wwa-wms', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.7 } });

    // ─── Layer 6c: NWS Watches WMS Tiles (zone-based watches) ───
    map.addSource('nws-watches-wms', {
        type: 'raster',
        tiles: ['https://mapservices.weather.noaa.gov/eventdriven/services/WWA/watch_warn_adv/MapServer/WMSServer?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=0&FORMAT=image/png&TRANSPARENT=true&STYLES=&SRS=EPSG:3857&WIDTH=256&HEIGHT=256&BBOX={bbox-epsg-3857}'],
        tileSize: 256
    });
    map.addLayer({ id: 'nws-watches-wms-layer', type: 'raster', source: 'nws-watches-wms', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.8 } });

    // ─── Layer 6d: MRMS Products (National WMS Tiles) ───
    // Enhanced Echo Tops (NCEP GeoServer, 1km CONUS, ~2 min updates)
    map.addSource('mrms-echotops', {
        type: 'raster',
        tiles: ['https://opengeo.ncep.noaa.gov/geoserver/conus/conus_neet_v18/ows?service=wms&version=1.1.1&request=GetMap&layers=conus_neet_v18&format=image/png&transparent=true&styles=&srs=EPSG:3857&width=256&height=256&bbox={bbox-epsg-3857}'],
        tileSize: 256
    });
    map.addLayer({ id: 'mrms-echotops-layer', type: 'raster', source: 'mrms-echotops', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.85 } });

    // MRMS QPE — gauge-corrected precipitation estimates (IEM WMS, transparent for no-data)
    map.addSource('mrms-qpe', {
        type: 'raster',
        tiles: ['https://mesonet.agron.iastate.edu/cgi-bin/wms/us/mrms_nn.cgi?service=WMS&version=1.1.1&request=GetMap&layers=mrms_p1h&format=image/png&transparent=true&styles=&srs=EPSG:3857&width=256&height=256&bbox={bbox-epsg-3857}'],
        tileSize: 256
    });
    map.addLayer({ id: 'mrms-qpe-layer', type: 'raster', source: 'mrms-qpe', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.85 } });

    // ─── Layer 7: HMS Smoke Plumes ───
    map.addSource('hms-smoke', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
        id: 'hms-smoke-fill', type: 'fill', source: 'hms-smoke',
        layout: { visibility: 'none' },
        paint: {
            'fill-color': ['match', ['get', 'Density'],
                'Heavy', '#8B0000',
                'Medium', '#FF8C00',
                'Light', '#FFD700',
                '#999999'],
            'fill-opacity': 0.4
        }
    });
    map.addLayer({
        id: 'hms-smoke-outline', type: 'line', source: 'hms-smoke',
        layout: { visibility: 'none' },
        paint: {
            'line-color': ['match', ['get', 'Density'],
                'Heavy', '#8B0000',
                'Medium', '#FF8C00',
                'Light', '#FFD700',
                '#999999'],
            'line-width': 1
        }
    });

    // ─── Layer 7b: WPC Surface Isobars ───
    map.addSource('wpc-isobars', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
        id: 'wpc-isobars-line', type: 'line', source: 'wpc-isobars',
        layout: { visibility: 'none', 'line-join': 'round', 'line-cap': 'round' },
        paint: {
            'line-color': '#d0d0d0',
            'line-width': 1.2,
            'line-opacity': 0.8
        }
    });
    map.addLayer({
        id: 'wpc-isobars-label', type: 'symbol', source: 'wpc-isobars',
        layout: {
            'visibility': 'none',
            'symbol-placement': 'line',
            'text-field': ['to-string', ['get', 'pressure']],
            'text-font': ['Noto Sans Regular'],
            'text-size': 10,
            'text-allow-overlap': false,
            'symbol-spacing': 300,
            'text-max-angle': 30
        },
        paint: {
            'text-color': '#e0e0e0',
            'text-halo-color': '#000000',
            'text-halo-width': 1.5
        }
    });

    // ─── Layer 7b2: METAR-Contoured Isobars (2mb), Isotherms (2°F), Isodrosotherms (2°F) ───
    const contourProducts = Object.entries(SFC_CONTOUR_FIELDS)
        .map(([id, c]) => ({ id, color: c.color, field: 'value' }));
    contourProducts.forEach(p => {
        map.addSource(p.id, {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] }
        });
        map.addLayer({
            id: `${p.id}-line`, type: 'line', source: p.id,
            layout: { visibility: 'none', 'line-join': 'round', 'line-cap': 'round' },
            paint: {
                'line-color': p.color,
                'line-width': 1.2,
                'line-opacity': 0.8
            }
        });
        map.addLayer({
            id: `${p.id}-label`, type: 'symbol', source: p.id,
            layout: {
                'visibility': 'none',
                'symbol-placement': 'line',
                'text-field': ['to-string', ['get', 'value']],
                'text-font': ['Noto Sans Regular'],
                'text-size': 10,
                'text-allow-overlap': false,
                'symbol-spacing': 250,
                'text-max-angle': 30
            },
            paint: {
                'text-color': p.color,
                'text-halo-color': '#000000',
                'text-halo-width': 1.5
            }
        });
    });

    // ─── Layer 7c: Aviation — SIGMETs / AIRMETs (AWC) ───
    const AV_HAZARD_COLOR = ['match', ['get', 'hazard'],
        'CONVECTIVE', '#ff3b3b',
        'TURB', '#ff9e3b',
        'ICE', '#3bd4ff',
        'IFR', '#c46bff',
        'MTN OBSCN', '#b98a5a',
        'ASH', '#ff5ac4',
        '#ffd23c'];
    map.addSource('airsigmet', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
        id: 'airsigmet-fill', type: 'fill', source: 'airsigmet',
        layout: { visibility: 'none' },
        paint: { 'fill-color': AV_HAZARD_COLOR, 'fill-opacity': 0.12 }
    });
    map.addLayer({
        id: 'airsigmet-outline', type: 'line', source: 'airsigmet',
        layout: { visibility: 'none', 'line-join': 'round' },
        paint: { 'line-color': AV_HAZARD_COLOR, 'line-width': 2, 'line-dasharray': [3, 2] }
    });
    map.addLayer({
        id: 'airsigmet-label', type: 'symbol', source: 'airsigmet',
        layout: {
            visibility: 'none',
            'text-field': ['coalesce', ['get', 'hazard'], 'SIGMET'],
            'text-font': ['Noto Sans Regular'], 'text-size': 10,
            'symbol-placement': 'point', 'text-allow-overlap': false
        },
        paint: { 'text-color': '#ffffff', 'text-halo-color': '#000000', 'text-halo-width': 1.4 }
    });

    // ─── Layer 7d: Aviation — Pilot Reports (PIREPs) ───
    map.addSource('pireps', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
        id: 'pireps-layer', type: 'circle', source: 'pireps',
        layout: { visibility: 'none' },
        paint: {
            'circle-radius': 5,
            'circle-color': ['match', ['get', 'airepType'], 'Urgent PIREP', '#ff3b3b', '#00e5ff'],
            'circle-stroke-color': '#001018', 'circle-stroke-width': 1.2, 'circle-opacity': 0.9
        }
    });

    // ─── Layer 7e: ProbSevere storm objects (CIMSS via NCEP) ───
    const PS_COLOR = ['interpolate', ['linear'], ['to-number', ['coalesce', ['get', 'ProbSevere'], 0]],
        0, '#00e5ff', 30, '#ffe14d', 50, '#ff9900', 70, '#ff3b3b', 90, '#ff2bd0'];
    map.addSource('probsevere', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
        id: 'probsevere-fill', type: 'fill', source: 'probsevere',
        layout: { visibility: 'none' },
        paint: { 'fill-color': PS_COLOR, 'fill-opacity': 0.08 }
    });
    map.addLayer({
        id: 'probsevere-outline', type: 'line', source: 'probsevere',
        layout: { visibility: 'none', 'line-join': 'round' },
        paint: { 'line-color': PS_COLOR, 'line-width': 2.4 }
    });
    map.addLayer({
        id: 'probsevere-label', type: 'symbol', source: 'probsevere',
        layout: {
            visibility: 'none',
            'text-field': ['concat', ['to-string', ['coalesce', ['get', 'ProbSevere'], 0]], '%'],
            'text-font': ['Noto Sans Regular'], 'text-size': 11,
            'symbol-placement': 'point', 'text-allow-overlap': true
        },
        paint: { 'text-color': '#ffffff', 'text-halo-color': '#000000', 'text-halo-width': 1.6 }
    });

    // ─── Layer 7e2: Aviation — Graphical AIRMETs (G-AIRMET, AWC) ───
    const GA_HAZARD_COLOR = ['match', ['get', 'hazard'],
        'TURB', '#ff9e3b', 'TURB-HI', '#ff9e3b', 'TURB-LO', '#ffc07a',
        'ICE', '#3bd4ff',
        'IFR', '#c46bff',
        'MT_OBSC', '#b98a5a',
        'SFC_WND', '#ffd23c',
        'LLWS', '#ff5ac4',
        'FZLVL', '#7fbfff', 'M_FZLVL', '#7fbfff',
        '#ffd23c'];
    map.addSource('gairmet', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
        id: 'gairmet-fill', type: 'fill', source: 'gairmet',
        layout: { visibility: 'none' },
        paint: { 'fill-color': GA_HAZARD_COLOR, 'fill-opacity': 0.10 }
    });
    map.addLayer({
        id: 'gairmet-outline', type: 'line', source: 'gairmet',
        layout: { visibility: 'none', 'line-join': 'round' },
        paint: { 'line-color': GA_HAZARD_COLOR, 'line-width': 1.6, 'line-dasharray': [2, 2] }
    });
    map.addLayer({
        id: 'gairmet-label', type: 'symbol', source: 'gairmet',
        layout: {
            visibility: 'none',
            'text-field': ['coalesce', ['get', 'hazard'], 'G-AIRMET'],
            'text-font': ['Noto Sans Regular'], 'text-size': 9,
            'symbol-placement': 'point', 'text-allow-overlap': false
        },
        paint: { 'text-color': '#ffffff', 'text-halo-color': '#000000', 'text-halo-width': 1.2 }
    });

    // ─── Layer 7e3: Aviation — Terminal Forecasts (TAF, AWC) colored by flight cat ───
    const TAF_CAT_COLOR = ['match', ['get', 'fltcat'],
        'VFR', '#33c27a', 'MVFR', '#4d9fff', 'IFR', '#ff3b3b', 'LIFR', '#ff2bd0',
        '#8b97a3'];
    map.addSource('taf', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
        id: 'taf-layer', type: 'circle', source: 'taf',
        layout: { visibility: 'none' },
        paint: {
            'circle-radius': 5,
            'circle-color': TAF_CAT_COLOR,
            'circle-stroke-color': '#001018', 'circle-stroke-width': 1.2, 'circle-opacity': 0.9
        }
    });
    map.addLayer({
        id: 'taf-label', type: 'symbol', source: 'taf',
        layout: {
            visibility: 'none',
            'text-field': ['get', 'id'],
            'text-font': ['Noto Sans Regular'], 'text-size': 9,
            'text-offset': [0, -1.1], 'text-anchor': 'bottom', 'text-allow-overlap': false
        },
        paint: { 'text-color': '#cfe6ff', 'text-halo-color': '#000000', 'text-halo-width': 1.2 }
    });

    // ─── Layer 7f: Interrogation tools (measure / range rings / storm ETA) ───
    // One shared overlay per pane; features are pushed in by the tools module.
    map.addSource('tool-geo', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
        id: 'tool-rings', type: 'line', source: 'tool-geo',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'line-color': '#ffcc00', 'line-width': 1.3, 'line-opacity': 0.85, 'line-dasharray': [2, 2] }
    });
    map.addLayer({
        id: 'tool-line', type: 'line', source: 'tool-geo',
        filter: ['==', ['geometry-type'], 'LineString'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['coalesce', ['get', 'color'], '#00e5ff'], 'line-width': 2, 'line-dasharray': [2, 1] }
    });
    map.addSource('tool-pts', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
        id: 'tool-pts-dot', type: 'circle', source: 'tool-pts',
        paint: { 'circle-radius': 4, 'circle-color': ['coalesce', ['get', 'color'], '#00e5ff'], 'circle-stroke-color': '#001018', 'circle-stroke-width': 1.5 }
    });
    map.addLayer({
        id: 'tool-pts-label', type: 'symbol', source: 'tool-pts',
        layout: {
            'text-field': ['coalesce', ['get', 'label'], ''],
            'text-font': ['Noto Sans Regular'], 'text-size': 11,
            'text-offset': [0, -1.1], 'text-anchor': 'bottom', 'text-allow-overlap': true
        },
        paint: { 'text-color': '#ffffff', 'text-halo-color': '#000000', 'text-halo-width': 1.6 }
    });

    // ─── Layer 7g: Storm Tracks / attributes (NEXRAD L3 STI) ───
    map.addSource('storm-attr', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
        id: 'storm-attr-track', type: 'line', source: 'storm-attr',
        filter: ['==', ['geometry-type'], 'LineString'],
        layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffe14d', 'line-width': 1.8, 'line-dasharray': [2, 1.5], 'line-opacity': 0.9 }
    });
    map.addLayer({
        id: 'storm-attr-fpos', type: 'circle', source: 'storm-attr',
        filter: ['all', ['==', ['geometry-type'], 'Point'], ['==', ['get', 'kind'], 'ftick']],
        layout: { visibility: 'none' },
        paint: { 'circle-radius': 2.4, 'circle-color': '#ffe14d', 'circle-opacity': 0.9 }
    });
    map.addLayer({
        id: 'storm-attr-cell', type: 'circle', source: 'storm-attr',
        filter: ['all', ['==', ['geometry-type'], 'Point'], ['==', ['get', 'kind'], 'cell']],
        layout: { visibility: 'none' },
        paint: {
            'circle-radius': 6,
            'circle-color': 'rgba(255,43,208,0.15)',
            'circle-stroke-color': '#ff2bd0', 'circle-stroke-width': 2
        }
    });
    map.addLayer({
        id: 'storm-attr-label', type: 'symbol', source: 'storm-attr',
        filter: ['all', ['==', ['geometry-type'], 'Point'], ['==', ['get', 'kind'], 'cell']],
        layout: {
            visibility: 'none',
            'text-field': ['get', 'tag'],
            'text-font': ['Noto Sans Regular'], 'text-size': 10,
            'text-offset': [0, -1.2], 'text-anchor': 'bottom', 'text-allow-overlap': true
        },
        paint: { 'text-color': '#ffd0f4', 'text-halo-color': '#000000', 'text-halo-width': 1.5 }
    });

    // ─── Layer 7f2: Mesocyclone / TVS markers (NEXRAD L3 MDA, product NMD) ───
    // AWIPS-style: open circle for a detected circulation (color scales with
    // strength rank), inverted red triangle when the TVS flag is set.
    map.addSource('meso-markers', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
        id: 'meso-circ', type: 'circle', source: 'meso-markers',
        filter: ['!=', ['get', 'tvs'], 'Y'],
        layout: { visibility: 'none' },
        paint: {
            'circle-radius': ['case', ['>=', ['get', 'sr_n'], 8], 11, 8],
            'circle-color': 'rgba(0,0,0,0)',
            'circle-stroke-width': 2.5,
            'circle-stroke-color': ['case',
                ['>=', ['get', 'sr_n'], 8], '#ff2b2b',
                ['>=', ['get', 'sr_n'], 5], '#ff9e3b',
                '#ffe14d']
        }
    });
    map.addLayer({
        id: 'meso-tvs', type: 'symbol', source: 'meso-markers',
        filter: ['==', ['get', 'tvs'], 'Y'],
        layout: {
            visibility: 'none',
            'text-field': '▼', 'text-font': ['Noto Sans Regular'],
            'text-size': 18, 'text-allow-overlap': true
        },
        paint: { 'text-color': '#ff2b2b', 'text-halo-color': '#000000', 'text-halo-width': 2 }
    });
    map.addLayer({
        id: 'meso-label', type: 'symbol', source: 'meso-markers',
        layout: {
            visibility: 'none',
            'text-field': ['concat', ['get', 'id'], ' · SR', ['get', 'sr']],
            'text-font': ['Noto Sans Regular'], 'text-size': 9,
            'text-offset': [0, -1.5], 'text-anchor': 'bottom', 'text-allow-overlap': true
        },
        paint: { 'text-color': '#ffd23c', 'text-halo-color': '#000000', 'text-halo-width': 1.5 }
    });

    // ─── Layer 7g2: National storm attribute table (IEM SCIT, all NEXRADs) ───
    // One CORS-open GeoJSON carries every radar's current cell table, so this is
    // a CONUS-wide hail/rotation census rather than the per-pane STI/MDA above.
    // Cells are coloured on the severe-hail ladder (0.75" = NWS severe criteria,
    // 2.00" = significant severe) and ringed white when a mesocyclone is flagged.
    map.addSource('nexrad-attr', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
        id: 'natt-vector', type: 'line', source: 'nexrad-attr',
        filter: ['==', ['geometry-type'], 'LineString'],
        layout: { visibility: 'none', 'line-cap': 'round' },
        paint: { 'line-color': '#9fb4c7', 'line-width': 1.2, 'line-dasharray': [2, 1.6], 'line-opacity': 0.75 }
    });
    map.addLayer({
        id: 'natt-cell', type: 'circle', source: 'nexrad-attr',
        filter: ['all', ['==', ['geometry-type'], 'Point'], ['==', ['get', 'kind'], 'cell']],
        layout: { visibility: 'none' },
        paint: {
            'circle-radius': ['interpolate', ['linear'], ['get', 'max_size'],
                0, 3, 0.75, 6, 1.0, 7.5, 2.0, 10, 3.0, 13],
            'circle-color': ['step', ['get', 'max_size'],
                'rgba(110,198,255,0.30)',
                0.75, 'rgba(255,225,77,0.45)',
                1.0, 'rgba(255,158,59,0.50)',
                1.75, 'rgba(255,59,59,0.55)',
                2.5, 'rgba(255,43,208,0.60)'],
            'circle-stroke-color': ['case', ['>', ['get', 'meso_n'], 0], '#ffffff',
                ['step', ['get', 'max_size'],
                    '#6ec6ff', 0.75, '#ffe14d', 1.0, '#ff9e3b', 1.75, '#ff3b3b', 2.5, '#ff2bd0']],
            'circle-stroke-width': ['case', ['>', ['get', 'meso_n'], 0], 2.2, 1.3]
        }
    });
    map.addLayer({
        id: 'natt-tvs', type: 'symbol', source: 'nexrad-attr',
        filter: ['all', ['==', ['get', 'kind'], 'cell'], ['==', ['get', 'tvs'], 1]],
        layout: {
            visibility: 'none',
            'text-field': '▼', 'text-font': ['Noto Sans Regular'],
            'text-size': 17, 'text-allow-overlap': true, 'text-ignore-placement': true
        },
        paint: { 'text-color': '#ff2b2b', 'text-halo-color': '#000000', 'text-halo-width': 2 }
    });
    // Labels stay off the weak cells so a 700-cell CONUS table remains readable.
    map.addLayer({
        id: 'natt-label', type: 'symbol', source: 'nexrad-attr',
        filter: ['all', ['==', ['get', 'kind'], 'cell'],
            ['any', ['>=', ['get', 'max_size'], 0.75], ['>', ['get', 'meso_n'], 0]]],
        layout: {
            visibility: 'none',
            'text-field': ['get', 'tag'],
            'text-font': ['Noto Sans Regular'], 'text-size': 10,
            'text-offset': [0, -1.3], 'text-anchor': 'bottom',
            // Unlike the single-radar layers, this one can put 700 cells on
            // screen at once — let MapLibre drop colliding labels rather than
            // stacking them, and sort so the biggest hail wins the space.
            'text-allow-overlap': false, 'text-padding': 3,
            'symbol-sort-key': ['-', 0, ['get', 'max_size']]
        },
        paint: { 'text-color': '#ffffff', 'text-halo-color': '#000000', 'text-halo-width': 1.6 }
    });

function getRadarSitesGeoJSON() {
    const features = [];
    for (const [id, coords] of Object.entries(RADAR_LOCATIONS)) {
        if (['OUN','SJU','MFL','JAN','MEG','PHI','CTP','RNK','BOI','TWC','VEF','MTR','RTD','SGX','PHMO','HUN'].includes(id)) continue;
        features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: coords },
            properties: { id }
        });
    }
    return { type: 'FeatureCollection', features };
}

function initRadarDomeIcon(map) {
    if (map.hasImage('radar-dome-icon')) return;
    const canvas = document.createElement('canvas');
    canvas.width = 40; canvas.height = 40;
    const ctx = canvas.getContext('2d');

    ctx.beginPath();
    ctx.arc(20, 20, 16, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 255, 255, 0.25)';
    ctx.fill();
    ctx.strokeStyle = '#00ffff';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(20, 20, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#ffff00';
    ctx.fill();

    map.addImage('radar-dome-icon', ctx.getImageData(0, 0, 40, 40));
}

function initLSRIcons(map) {
    if (map.hasImage('lsr-tornado')) return;
    const size = 28;

    // Helper: draw an icon with background circle + text/shape
    function makeLSRIcon(bgColor, borderColor, drawFn) {
        const c = document.createElement('canvas');
        c.width = size; c.height = size;
        const ctx = c.getContext('2d');
        // Background circle
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
        ctx.fillStyle = bgColor;
        ctx.fill();
        ctx.strokeStyle = borderColor;
        ctx.lineWidth = 2;
        ctx.stroke();
        // Custom drawing
        drawFn(ctx);
        return ctx.getImageData(0, 0, size, size);
    }

    // Tornado — red circle with "T"
    map.addImage('lsr-tornado', makeLSRIcon('#cc0000', '#ff3333', ctx => {
        ctx.font = 'bold 16px Inter, Arial, sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('T', size / 2, size / 2 + 1);
    }));

    // Hail — green circle with "H"
    map.addImage('lsr-hail', makeLSRIcon('#007700', '#00cc00', ctx => {
        ctx.font = 'bold 16px Inter, Arial, sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('H', size / 2, size / 2 + 1);
    }));

    // Wind — blue circle with "W"
    map.addImage('lsr-wind', makeLSRIcon('#1166cc', '#3399ff', ctx => {
        ctx.font = 'bold 16px Inter, Arial, sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('W', size / 2, size / 2 + 1);
    }));

    // Flood — teal circle with "F"
    map.addImage('lsr-flood', makeLSRIcon('#006666', '#00cccc', ctx => {
        ctx.font = 'bold 16px Inter, Arial, sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('F', size / 2, size / 2 + 1);
    }));

    // Snow — purple circle with "S"
    map.addImage('lsr-snow', makeLSRIcon('#6633aa', '#cc88ff', ctx => {
        ctx.font = 'bold 16px Inter, Arial, sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('S', size / 2, size / 2 + 1);
    }));

    // Rain — blue-gray circle with "R"
    map.addImage('lsr-rain', makeLSRIcon('#005577', '#0088aa', ctx => {
        ctx.font = 'bold 16px Inter, Arial, sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('R', size / 2, size / 2 + 1);
    }));

    // Marine — indigo circle with "M"
    map.addImage('lsr-marine', makeLSRIcon('#444499', '#6666cc', ctx => {
        ctx.font = 'bold 16px Inter, Arial, sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('M', size / 2, size / 2 + 1);
    }));

    // Other/default — orange circle with "X"
    map.addImage('lsr-other', makeLSRIcon('#cc6600', '#ff9900', ctx => {
        ctx.font = 'bold 16px Inter, Arial, sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('X', size / 2, size / 2 + 1);
    }));
}

function initFrontalPipIcons(map) {
    if (map.hasImage('cold-pip')) return;
    
    const coldCanvas = document.createElement('canvas');
    coldCanvas.width = 32; coldCanvas.height = 32;
    const coldCtx = coldCanvas.getContext('2d');
    coldCtx.fillStyle = '#4488ff';
    coldCtx.beginPath();
    coldCtx.moveTo(0, 16);
    coldCtx.lineTo(32, 16);
    coldCtx.lineTo(16, 0);
    coldCtx.closePath();
    coldCtx.fill();
    map.addImage('cold-pip', coldCtx.getImageData(0, 0, 32, 32));

    const warmCanvas = document.createElement('canvas');
    warmCanvas.width = 32; warmCanvas.height = 32;
    const warmCtx = warmCanvas.getContext('2d');
    warmCtx.fillStyle = '#ff4444';
    warmCtx.beginPath();
    warmCtx.arc(16, 16, 14, Math.PI, 0, false);
    warmCtx.closePath();
    warmCtx.fill();
    map.addImage('warm-pip', warmCtx.getImageData(0, 0, 32, 32));

    const occCanvas = document.createElement('canvas');
    occCanvas.width = 36; occCanvas.height = 32;
    const occCtx = occCanvas.getContext('2d');
    occCtx.fillStyle = '#9944cc';
    occCtx.beginPath();
    occCtx.moveTo(2, 16);
    occCtx.lineTo(16, 16);
    occCtx.lineTo(9, 2);
    occCtx.closePath();
    occCtx.fill();
    occCtx.beginPath();
    occCtx.arc(26, 16, 8, Math.PI, 0, false);
    occCtx.closePath();
    occCtx.fill();
    map.addImage('occluded-pip', occCtx.getImageData(0, 0, 36, 32));

    const stnCanvas = document.createElement('canvas');
    stnCanvas.width = 40; stnCanvas.height = 32;
    const stnCtx = stnCanvas.getContext('2d');
    stnCtx.fillStyle = '#ff4444';
    stnCtx.beginPath();
    stnCtx.arc(10, 16, 8, Math.PI, 0, false);
    stnCtx.closePath();
    stnCtx.fill();
    stnCtx.fillStyle = '#4488ff';
    stnCtx.beginPath();
    stnCtx.moveTo(22, 16);
    stnCtx.lineTo(38, 16);
    stnCtx.lineTo(30, 30);
    stnCtx.closePath();
    stnCtx.fill();
    map.addImage('stationary-pip', stnCtx.getImageData(0, 0, 40, 32));
}

    // ─── Layer 7c: WPC Fronts ───
    initFrontalPipIcons(map);
    map.addSource('wpc-fronts', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
        id: 'wpc-fronts-solid', type: 'line', source: 'wpc-fronts',
        filter: ['in', ['get', 'frontType'], ['literal', ['COLD', 'WARM', 'OCFNT']]],
        layout: { 'visibility': 'none', 'line-cap': 'round', 'line-join': 'round' },
        paint: {
            'line-color': ['match', ['get', 'frontType'],
                'COLD', '#4488ff', 'WARM', '#ff4444', 'OCFNT', '#9944cc', '#888'],
            'line-width': ['match', ['get', 'strength'], 'STG', 3.5, 'WK', 2, 2.5],
            'line-opacity': 0.9
        }
    });
    map.addLayer({
        id: 'wpc-fronts-stnry', type: 'line', source: 'wpc-fronts',
        filter: ['==', ['get', 'frontType'], 'STNRY'],
        layout: { 'visibility': 'none', 'line-cap': 'round', 'line-join': 'round' },
        paint: {
            'line-color': '#cc44cc',
            'line-width': ['match', ['get', 'strength'], 'STG', 3.5, 'WK', 2, 2.5],
            'line-dasharray': [4, 2, 1, 2],
            'line-opacity': 0.9
        }
    });
    map.addLayer({
        id: 'wpc-fronts-trof', type: 'line', source: 'wpc-fronts',
        filter: ['==', ['get', 'frontType'], 'TROF'],
        layout: { 'visibility': 'none', 'line-cap': 'round', 'line-join': 'round' },
        paint: {
            'line-color': '#cc8844',
            'line-width': 2,
            'line-dasharray': [6, 4],
            'line-opacity': 0.9
        }
    });
    map.addLayer({
        id: 'wpc-fronts-pips',
        type: 'symbol',
        source: 'wpc-fronts',
        filter: ['in', ['get', 'frontType'], ['literal', ['COLD', 'WARM', 'OCFNT', 'STNRY']]],
        layout: {
            'visibility': 'none',
            'symbol-placement': 'line',
            'symbol-spacing': 75,
            'icon-image': ['match', ['get', 'frontType'],
                'COLD', 'cold-pip',
                'WARM', 'warm-pip',
                'OCFNT', 'occluded-pip',
                'STNRY', 'stationary-pip',
                'cold-pip'
            ],
            'icon-size': 0.65,
            'icon-rotate': 0,
            'icon-pitch-alignment': 'map',
            'icon-rotation-alignment': 'map',
            'icon-allow-overlap': true,
            'icon-ignore-placement': true
        }
    });

    // ─── Layer 7d: WPC Pressure Centers (H/L) ───
    map.addSource('wpc-pressure-centers', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
        id: 'wpc-hl-letter', type: 'symbol', source: 'wpc-pressure-centers',
        layout: {
            'visibility': 'none',
            'text-field': ['get', 'type'],
            'text-font': ['Noto Sans Bold'],
            'text-size': 22,
            'text-allow-overlap': true,
            'text-offset': [0, -0.3]
        },
        paint: {
            'text-color': ['match', ['get', 'type'], 'H', '#4488ff', 'L', '#ff4444', '#fff'],
            'text-halo-color': '#000',
            'text-halo-width': 2
        }
    });
    map.addLayer({
        id: 'wpc-hl-pressure', type: 'symbol', source: 'wpc-pressure-centers',
        layout: {
            'visibility': 'none',
            'text-field': ['to-string', ['get', 'pressure']],
            'text-font': ['Noto Sans Regular'],
            'text-size': 11,
            'text-allow-overlap': true,
            'text-offset': [0, 0.8]
        },
        paint: {
            'text-color': ['match', ['get', 'type'], 'H', '#6699ff', 'L', '#ff6666', '#ccc'],
            'text-halo-color': '#000',
            'text-halo-width': 1.5
        }
    });

    // ─── Layer 7e: WPC QPF (WMS Raster) ───
    map.addSource('wpc-qpf', {
        type: 'raster',
        tiles: ['https://mapservices.weather.noaa.gov/vector/rest/services/precip/wpc_qpf/MapServer/export?bbox={bbox-epsg-3857}&bboxSR=102100&layers=show:1&size=512,512&imageSR=102100&format=png32&transparent=true&f=image'],
        tileSize: 512
    });
    map.addLayer({
        id: 'wpc-qpf-layer', type: 'raster', source: 'wpc-qpf',
        layout: { visibility: 'none' },
        paint: { 'raster-opacity': 0.7 }
    });

    // ─── Layer 7f: NHC Active Storms (GeoJSON) ───
    map.addSource('nhc-storms', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
        id: 'nhc-cone-fill', type: 'fill', source: 'nhc-storms',
        filter: ['==', ['get', 'layerType'], 'cone'],
        layout: { visibility: 'none' },
        paint: { 'fill-color': '#ff6600', 'fill-opacity': 0.15 }
    });
    map.addLayer({
        id: 'nhc-cone-outline', type: 'line', source: 'nhc-storms',
        filter: ['==', ['get', 'layerType'], 'cone'],
        layout: { visibility: 'none' },
        paint: { 'line-color': ['case', ['==', ['get', 'isPTC'], 1], '#b388ff', '#ff6600'], 'line-width': 1.5 }
    });
    map.addLayer({
        id: 'nhc-track-line', type: 'line', source: 'nhc-storms',
        filter: ['==', ['get', 'layerType'], 'track'],
        layout: { visibility: 'none' },
        paint: { 'line-color': ['case', ['==', ['get', 'isPTC'], 1], '#b388ff', '#ffcc00'], 'line-width': 2, 'line-dasharray': [4, 2] }
    });
    map.addLayer({
        id: 'nhc-track-pts', type: 'circle', source: 'nhc-storms',
        filter: ['==', ['get', 'layerType'], 'point'],
        layout: { visibility: 'none' },
        paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 4, 8, 8],
            'circle-color': ['step', ['coalesce', ['get', 'maxwind'], 0],
                '#00e5ff', 34, '#ffff00', 64, '#ff6600', 96, '#ff0000', 130, '#ff00ff'],
            'circle-stroke-width': 1.5,
            'circle-stroke-color': '#000'
        }
    });
    map.addLayer({
        id: 'nhc-track-labels', type: 'symbol', source: 'nhc-storms',
        filter: ['==', ['get', 'layerType'], 'point'],
        layout: {
            visibility: 'none',
            'text-field': ['case',
                ['==', ['get', 'tau'], 0],
                ['concat', ['coalesce', ['get', 'displayname'], ['get', 'stormname']], '\n', ['to-string', ['get', 'maxwind']], ' kt'],
                ['concat', '+', ['to-string', ['round', ['get', 'tau']]], 'h ', ['to-string', ['get', 'maxwind']], ' kt']
            ],
            'text-font': ['Noto Sans Bold'],
            'text-size': 10,
            'text-offset': [0, 1.5],
            'text-allow-overlap': false
        },
        paint: { 'text-color': ['case', ['==', ['get', 'isPTC'], 1], '#b388ff', '#ffcc00'], 'text-halo-color': '#000', 'text-halo-width': 1.5 }
    });
    map.addLayer({
        id: 'nhc-warn-fill', type: 'fill', source: 'nhc-storms',
        filter: ['==', ['get', 'layerType'], 'warning'],
        layout: { visibility: 'none' },
        paint: { 'fill-color': '#ff0000', 'fill-opacity': 0.1 }
    });
    map.addLayer({
        id: 'nhc-warn-outline', type: 'line', source: 'nhc-storms',
        filter: ['==', ['get', 'layerType'], 'warning'],
        layout: { visibility: 'none' },
        paint: {
            // NHC's coastal-hazard colors, when the source tells us the hazard type
            // (the NHC-direct KMZ does; the NOAA mirror doesn't, and falls back).
            'line-color': ['match', ['coalesce', ['get', 'ww'], ''],
                'TWA', '#ffff00',   // Tropical Storm Watch
                'TWR', '#0080ff',   // Tropical Storm Warning
                'HWA', '#ff69b4',   // Hurricane Watch
                'HWR', '#ff0000',   // Hurricane Warning
                '#ff0000'],
            'line-width': 3
        }
    });

    // ─── Forecast History (run-to-run): past OFCL tracks + actual best-track path ───
    // Each prior advisory's official forecast track is drawn faded (older fainter,
    // newest highlighted) anchored at its fixed position, over the storm's actual
    // traveled path — showing how the forecast has trended cycle to cycle.
    map.addSource('nhc-fcst-history', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
        id: 'nhc-fcst-actual-line', type: 'line', source: 'nhc-fcst-history',
        filter: ['==', ['get', 'kind'], 'actual'],
        layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ff8c00', 'line-width': 3 }
    });
    map.addLayer({
        id: 'nhc-fcst-lines', type: 'line', source: 'nhc-fcst-history',
        filter: ['==', ['get', 'kind'], 'fcst'],
        layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
        paint: {
            'line-color': ['coalesce', ['get', 'color'], '#00e5ff'],
            'line-width': ['coalesce', ['get', 'w'], 1.5],
            'line-opacity': ['coalesce', ['get', 'op'], 0.6],
            'line-dasharray': [2.5, 2]
        }
    });
    map.addLayer({
        id: 'nhc-fcst-actual-pts', type: 'circle', source: 'nhc-fcst-history',
        filter: ['==', ['get', 'kind'], 'fix'],
        layout: { visibility: 'none' },
        paint: {
            'circle-radius': ['case', ['==', ['get', 'latest'], 1], 6, 3.2],
            'circle-color': ['step', ['coalesce', ['get', 'mw'], 0],
                '#00e5ff', 34, '#ffff00', 64, '#ff6600', 96, '#ff0000', 130, '#ff00ff'],
            'circle-stroke-width': 1.4,
            'circle-stroke-color': '#1a0e00'
        }
    });
    map.addLayer({
        id: 'nhc-fcst-labels', type: 'symbol', source: 'nhc-fcst-history',
        filter: ['==', ['get', 'kind'], 'fcstlabel'],
        layout: {
            visibility: 'none',
            'text-field': ['get', 'lbl'], 'text-font': ['Noto Sans Bold'],
            'text-size': 9, 'text-offset': [0, 0.8], 'text-allow-overlap': false
        },
        paint: {
            'text-color': ['coalesce', ['get', 'color'], '#00e5ff'],
            'text-opacity': ['coalesce', ['get', 'op'], 0.85],
            'text-halo-color': '#000', 'text-halo-width': 1.3
        }
    });

    // ─── Layer 7f2: Hurricane Hunter recon obs (HDOB flight tracks) ───
    // 30-second aircraft observations decoded from URNT15/URPA15 messages.
    // Points colored by the stronger of SFMR surface wind / flight-level wind.
    map.addSource('recon-hdob', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
        id: 'recon-hdob-line', type: 'line', source: 'recon-hdob',
        filter: ['==', ['get', 'layerType'], 'track'],
        layout: { visibility: 'none' },
        paint: { 'line-color': '#b0bec5', 'line-width': 1.2, 'line-dasharray': [2, 2] }
    });
    map.addLayer({
        id: 'recon-hdob-pts', type: 'circle', source: 'recon-hdob',
        filter: ['==', ['get', 'layerType'], 'ob'],
        layout: { visibility: 'none' },
        paint: {
            'circle-radius': ['case', ['==', ['get', 'latest'], 1], 6, 3],
            'circle-color': ['step', ['coalesce', ['get', 'windMax'], 0],
                '#34d5eb', 34, '#ffd166', 50, '#ff9e3b', 64, '#ff3b3b'],
            'circle-stroke-width': ['case', ['==', ['get', 'latest'], 1], 2, 0.5],
            'circle-stroke-color': '#000'
        }
    });
    map.addLayer({
        id: 'recon-hdob-labels', type: 'symbol', source: 'recon-hdob',
        filter: ['==', ['get', 'latest'], 1],
        layout: {
            visibility: 'none',
            'text-field': ['concat', ['get', 'callsign'], ' · ', ['get', 'storm']],
            'text-font': ['Noto Sans Bold'],
            'text-size': 10,
            'text-offset': [0, 1.6],
            'text-allow-overlap': true
        },
        paint: { 'text-color': '#7fff9e', 'text-halo-color': '#000', 'text-halo-width': 1.5 }
    });

    // ─── Layer 7f3: Model track guidance spaghetti (ATCF a-deck) ───
    // One colored LineString per model tech; points carry forecast intensity.
    map.addSource('adeck', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
        id: 'adeck-lines', type: 'line', source: 'adeck',
        filter: ['==', ['get', 'layerType'], 'line'],
        layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
        paint: {
            'line-color': ['get', 'color'],
            'line-width': ['get', 'width'],
            'line-opacity': ['coalesce', ['get', 'opacity'], 0.9]
        }
    });
    map.addLayer({
        id: 'adeck-pts', type: 'circle', source: 'adeck',
        filter: ['==', ['get', 'layerType'], 'pt'],
        layout: { visibility: 'none' },
        paint: {
            'circle-radius': ['case', ['==', ['get', 'major'], 1], 3.2, 1.8],
            'circle-color': ['get', 'color'],
            'circle-stroke-width': 0.5,
            'circle-stroke-color': '#000'
        }
    });
    map.addLayer({
        id: 'adeck-labels', type: 'symbol', source: 'adeck',
        filter: ['==', ['get', 'layerType'], 'end'],
        layout: {
            visibility: 'none',
            'text-field': ['coalesce', ['get', 'lbl'], ['get', 'tech']],
            'text-font': ['Noto Sans Bold'],
            'text-size': 9.5,
            'text-offset': [0, 1.1],
            'text-allow-overlap': true
        },
        paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#000', 'text-halo-width': 1.2 }
    });

    // ─── Layer 7g: NHC Tropical Outlook Areas (GeoJSON) ───
    map.addSource('nhc-outlook', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
        id: 'nhc-outlook-fill', type: 'fill', source: 'nhc-outlook',
        layout: { visibility: 'none' },
        paint: {
            'fill-color': ['match', ['get', 'risk7day'],
                'High', '#ff0000',
                'Medium', '#ff9900',
                'Low', '#ffff00',
                '#ffff00'
            ],
            'fill-opacity': 0.25
        }
    });
    map.addLayer({
        id: 'nhc-outlook-outline', type: 'line', source: 'nhc-outlook',
        layout: { visibility: 'none' },
        paint: {
            'line-color': ['match', ['get', 'risk7day'],
                'High', '#ff0000',
                'Medium', '#ff9900',
                'Low', '#ffff00',
                '#ffcc00'
            ],
            'line-width': 2,
            'line-dasharray': [4, 2]
        }
    });

    // ─── Layer 7h: CPC Temperature Outlook (WMS Raster) ───
    map.addSource('cpc-temp', {
        type: 'raster',
        tiles: ['https://mapservices.weather.noaa.gov/vector/services/outlooks/cpc_6_10_day_outlk/MapServer/WMSServer?service=WMS&version=1.1.1&request=GetMap&layers=1&format=image/png&transparent=true&styles=&srs=EPSG:3857&width=256&height=256&bbox={bbox-epsg-3857}'],
        tileSize: 256
    });
    map.addLayer({
        id: 'cpc-temp-layer', type: 'raster', source: 'cpc-temp',
        layout: { visibility: 'none' },
        paint: { 'raster-opacity': 0.65 }
    });

    // ─── Layer 7i: CPC Precipitation Outlook (WMS Raster) ───
    map.addSource('cpc-precip', {
        type: 'raster',
        tiles: ['https://mapservices.weather.noaa.gov/vector/services/outlooks/cpc_6_10_day_outlk/MapServer/WMSServer?service=WMS&version=1.1.1&request=GetMap&layers=0&format=image/png&transparent=true&styles=&srs=EPSG:3857&width=256&height=256&bbox={bbox-epsg-3857}'],
        tileSize: 256
    });
    map.addLayer({
        id: 'cpc-precip-layer', type: 'raster', source: 'cpc-precip',
        layout: { visibility: 'none' },
        paint: { 'raster-opacity': 0.65 }
    });

    // ─── Layer 7i2: NDFD gridded forecast — surface temperature (°F) ───
    // NWS mapservices only publishes the NDFD temperature grid as a live raster
    // service; wind/sky/QPF grids are no longer served publicly. WMS tiles are
    // loaded directly (no proxy needed — same-origin not required for <img> tiles).
    map.addSource('ndfd-temp', {
        type: 'raster',
        tiles: [NDFD_TEMP_URL],
        tileSize: 256
    });
    map.addLayer({
        id: 'ndfd-temp-layer', type: 'raster', source: 'ndfd-temp',
        layout: { visibility: 'none' },
        paint: { 'raster-opacity': 0.6 }
    });

    // ─── Layer 7j: US Drought Monitor (GeoJSON) ───
    map.addSource('drought-monitor', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
        id: 'drought-fill', type: 'fill', source: 'drought-monitor',
        layout: { visibility: 'none' },
        paint: {
            'fill-color': ['match', ['get', 'dm'],
                0, '#ffff00', 1, '#ffcc66', 2, '#ff9900', 3, '#ff0000', 4, '#660000', '#888'],
            'fill-opacity': 0.5
        }
    });
    map.addLayer({
        id: 'drought-outline', type: 'line', source: 'drought-monitor',
        layout: { visibility: 'none' },
        paint: { 'line-color': '#000', 'line-width': 0.5 }
    });

    // ─── Layer 7k: CPC Drought Outlook (WMS Raster) ───
    map.addSource('cpc-drought', {
        type: 'raster',
        tiles: ['https://mapservices.weather.noaa.gov/vector/services/outlooks/cpc_drought_outlk/MapServer/WMSServer?service=WMS&version=1.1.1&request=GetMap&layers=2&format=image/png&transparent=true&styles=&srs=EPSG:3857&width=256&height=256&bbox={bbox-epsg-3857}'],
        tileSize: 256
    });
    map.addLayer({
        id: 'cpc-drought-layer', type: 'raster', source: 'cpc-drought',
        layout: { visibility: 'none' },
        paint: { 'raster-opacity': 0.8 }
    });

    // ─── Layer 8: AQI Monitors ───
    map.addSource('airnow-aqi', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
        id: 'airnow-aqi-layer', type: 'circle', source: 'airnow-aqi',
        layout: { visibility: 'none' },
        paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 2, 8, 6],
            'circle-color': ['step', ['get', 'aqi'],
                '#00e400', 51, '#ffff00', 101, '#ff7e00', 151, '#ff0000', 201, '#8f3f97', 301, '#7e0023'],
            'circle-opacity': 0.8,
            'circle-stroke-width': 1,
            'circle-stroke-color': '#000'
        }
    });

    // ─── Layer 9: FIRMS Active Fires (GeoJSON points for click-to-inspect) ───
    map.addSource('firms-fires', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
        id: 'firms-fires-layer', type: 'circle', source: 'firms-fires',
        layout: { visibility: 'none' },
        paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 2, 8, 5, 12, 8],
            'circle-color': ['interpolate', ['linear'], ['coalesce', ['get', 'confidence'], 50],
                0, '#ff9900', 50, '#ff6600', 80, '#ff0000'],
            'circle-opacity': 0.85,
            'circle-stroke-width': 1,
            'circle-stroke-color': '#000'
        }
    });

    // ─── Layer 9b: NWS River Gauges ───
    map.addSource('river-gauges', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });
    // Outer glow ring for flooding gauges
    map.addLayer({
        id: 'river-gauges-glow', type: 'circle', source: 'river-gauges',
        filter: ['in', ['get', 'oc'], ['literal', ['action', 'minor', 'moderate', 'major']]],
        layout: { visibility: 'none' },
        paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 5, 7, 10, 10, 14],
            'circle-color': ['match', ['get', 'oc'],
                'major', '#ff00ff',
                'moderate', '#ff0000',
                'minor', '#ff8800',
                'action', '#ffff00',
                '#888888'],
            'circle-opacity': 0.3,
            'circle-blur': 0.8
        }
    });
    // Main gauge dots
    map.addLayer({
        id: 'river-gauges-layer', type: 'circle', source: 'river-gauges',
        layout: { visibility: 'none' },
        minzoom: 4,
        paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 2, 7, 4, 10, 6, 13, 9],
            'circle-color': ['match', ['get', 'oc'],
                'major', '#ff00ff',
                'moderate', '#ff0000',
                'minor', '#ff8800',
                'action', '#ffff00',
                'no_flooding', '#00cc00',
                'low_threshold', '#00cccc',
                'not_defined', '#888888',
                'obs_not_current', '#555555',
                '#666666'],
            'circle-opacity': 0.9,
            'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 4, 0.5, 10, 1.5],
            'circle-stroke-color': '#000000'
        }
    });
    // Gauge labels at high zoom
    map.addLayer({
        id: 'river-gauges-label', type: 'symbol', source: 'river-gauges',
        layout: {
            visibility: 'none',
            'text-field': ['concat', ['to-string', ['get', 'os']], ' ', ['get', 'ou']],
            'text-size': 9,
            'text-offset': [0, 1.4],
            'text-anchor': 'top',
            'text-allow-overlap': false,
            'text-optional': true
        },
        minzoom: 9,
        paint: {
            'text-color': ['match', ['get', 'oc'],
                'major', '#ff88ff',
                'moderate', '#ff6666',
                'minor', '#ffaa44',
                'action', '#ffff66',
                '#aaaaaa'],
            'text-halo-color': '#000000',
            'text-halo-width': 1.2
        }
    });

    // ─── Layer 9c: Solar Day/Night Terminator ───
    map.addSource('solar-terminator', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });
    // Civil twilight band (lighter shading) — deep blue reads as dusk over the dark map
    map.addLayer({
        id: 'solar-twilight-fill', type: 'fill', source: 'solar-terminator',
        filter: ['==', ['get', 'zone'], 'civil-twilight'],
        layout: { visibility: 'none' },
        paint: { 'fill-color': '#16244a', 'fill-opacity': 0.35 }
    });
    // Night polygon (darker shading)
    map.addLayer({
        id: 'solar-night-fill', type: 'fill', source: 'solar-terminator',
        filter: ['==', ['get', 'zone'], 'night'],
        layout: { visibility: 'none' },
        paint: { 'fill-color': '#0a1430', 'fill-opacity': 0.62 }
    });
    // Terminator edge line — bright amber, clearly visible
    map.addLayer({
        id: 'solar-terminator-line', type: 'line', source: 'solar-terminator',
        filter: ['==', ['get', 'zone'], 'night'],
        layout: { visibility: 'none' },
        paint: { 'line-color': '#ffc340', 'line-width': 2.2, 'line-opacity': 0.95 }
    });

    // ─── Layer 10: City Labels (ESRI Reference) ───
    map.addSource('esri-labels', {
        type: 'raster',
        tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256
    });
    map.addLayer({ id: 'esri-labels-layer', type: 'raster', source: 'esri-labels', layout: { visibility: 'visible' }, paint: { 'raster-opacity': 0.7, 'raster-brightness-max': 0.8 } });

    // ─── Layer 11: Roads (ESRI Transportation) ───
    map.addSource('esri-roads', {
        type: 'raster',
        tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256
    });
    map.addLayer({ id: 'esri-roads-layer', type: 'raster', source: 'esri-roads', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.6 } });

    // ─── Layer 12: METAR Station Plots (topmost) ───
    map.addSource('metars', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
    });

    // Wind Barbs
    map.addLayer({
        id: 'metars-barb',
        type: 'symbol',
        source: 'metars',
        minzoom: 6,
        layout: {
            'visibility': 'none',
            'icon-image': ['get', 'barb_icon'],
            'icon-rotate': ['get', 'drct'],
            'icon-rotation-alignment': 'map',
            'icon-allow-overlap': true,
            'icon-size': 0.8
        }
    });

    // Temperature (red, upper-left)
    map.addLayer({
        id: 'metars-temp', type: 'symbol', source: 'metars', minzoom: 6,
        layout: {
            'text-field': ['case', ['has', 'tmpf'], ['concat', ['to-string', ['round', ['get', 'tmpf']]], '°'], ''],
            'text-font': ['Noto Sans Regular'], 'text-size': 11,
            'text-offset': [-1.5, -0.8], visibility: 'none', 'text-allow-overlap': true
        },
        paint: { 'text-color': '#ff3333', 'text-halo-color': '#000', 'text-halo-width': 1 }
    });

    // Dewpoint (green, lower-left)
    map.addLayer({
        id: 'metars-dewp', type: 'symbol', source: 'metars', minzoom: 6,
        layout: {
            'text-field': ['case', ['has', 'dwpf'], ['concat', ['to-string', ['round', ['get', 'dwpf']]], '°'], ''],
            'text-font': ['Noto Sans Regular'], 'text-size': 11,
            'text-offset': [-1.5, 0.8], visibility: 'none', 'text-allow-overlap': true
        },
        paint: { 'text-color': '#00ff88', 'text-halo-color': '#000', 'text-halo-width': 1 }
    });

    // Altimeter/Pressure in millibars (cyan, upper-right)
    // Convert altimeter (inHg) to mb: alti × 33.8639
    map.addLayer({
        id: 'metars-press', type: 'symbol', source: 'metars', minzoom: 7,
        layout: {
            'text-field': ['case', ['has', 'alti'],
                ['concat', ['to-string', ['round', ['*', 33.8639, ['get', 'alti']]]], 'mb'],
                ''],
            'text-font': ['Noto Sans Regular'], 'text-size': 9,
            'text-offset': [1.8, -0.8], visibility: 'none', 'text-allow-overlap': true
        },
        paint: { 'text-color': '#00e5ff', 'text-halo-color': '#000', 'text-halo-width': 1 }
    });

    // Station ID
    map.addLayer({
        id: 'metars-id', type: 'symbol', source: 'metars', minzoom: 8,
        layout: {
            'text-field': ['get', 'station'], 'text-font': ['Noto Sans Regular'], 'text-size': 8,
            'text-offset': [0, 2.5], visibility: 'none', 'text-allow-overlap': false
        },
        paint: { 'text-color': '#888', 'text-halo-color': '#000', 'text-halo-width': 1 }
    });

    // City/Station name
    map.addLayer({
        id: 'metars-city', type: 'symbol', source: 'metars', minzoom: 7,
        layout: {
            'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 10,
            'text-offset': [0, 1.5], visibility: 'none', 'text-allow-overlap': false
        },
        paint: { 'text-color': '#cccccc', 'text-halo-color': '#000', 'text-halo-width': 1.5 }
    });

    // If we already have loaded data, push it to this new map
    if (metarsLoaded && metarGeoJSON.features.length > 0) {
        map.getSource('metars').setData(metarGeoJSON);
    }
    if (warningsLoaded && warningsGeoJSON?.features?.length > 0) {
        map.getSource('nws-warnings').setData(warningsGeoJSON);
    }
    if (watchesLoaded && watchesGeoJSON?.features?.length > 0) {
        map.getSource('nws-watches-vector').setData(watchesGeoJSON);
    }

    // ─── Click popups ───
    const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true, maxWidth: '440px' });

    // METAR station click
    map.on('click', 'metars-temp', e => {
        if (!e.features || !e.features[0]) return;
        const p = e.features[0].properties;
        const windDir = p.drct != null ? `${p.drct}°` : 'VRB';
        const windSpd = p.sknt != null ? `${p.sknt} kt` : 'Calm';
        const gustTxt = p.gust ? ` G${p.gust} kt` : '';
        const skyLayers = [];
        for (let i = 1; i <= 4; i++) {
            const cover = p[`skyc${i}`];
            const base = p[`skyl${i}`];
            if (cover && cover !== 'null') skyLayers.push(base ? `${cover} ${base} ft` : cover);
        }
        const sky = skyLayers.length ? skyLayers.join(', ') : 'CLR';
        const wx = (p.wxcodes && p.wxcodes !== 'null') ? p.wxcodes : '';
        const validDate = p.utc_valid ? new Date(p.utc_valid) : new Date();
        const validTimeLocal = validDate.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true, month: 'short', day: 'numeric', timeZoneName: 'short' });
        const validTimeUTC = validDate.toISOString().substring(11, 16) + 'Z';
        const html = `<div style="font-family:'Courier New',monospace;font-size:11px;color:#e0e0e0;background:#0d1117;padding:8px;border-radius:4px;line-height:1.6;">
            <div style="font-weight:bold;color:#00e5ff;font-size:13px;margin-bottom:2px;">${esc(p.station || '')} — ${esc(p.name || 'Unknown')}${p.state ? ', ' + esc(p.state) : ''}</div>
            <div style="color:#666;font-size:10px;margin-bottom:6px;">${validTimeLocal} (${validTimeUTC})</div>
            <div style="display:grid;grid-template-columns:auto 1fr;gap:2px 10px;">
                <span style="color:#888;">Temp:</span><span style="color:#ff4444;">${p.tmpf != null ? Math.round(p.tmpf) + '°F' : 'M'}</span>
                <span style="color:#888;">Dewpoint:</span><span style="color:#00cc88;">${p.dwpf != null ? Math.round(p.dwpf) + '°F' : 'M'}</span>
                <span style="color:#888;">RH:</span><span>${p.relh != null ? Math.round(p.relh) + '%' : 'M'}</span>
                <span style="color:#888;">Wind:</span><span>${windDir} ${windSpd}${gustTxt}</span>
                <span style="color:#888;">Visibility:</span><span>${p.vsby != null ? p.vsby + ' mi' : 'M'}</span>
                <span style="color:#888;">Altimeter:</span><span>${p.alti != null ? p.alti.toFixed(2) + ' inHg (' + Math.round(p.alti * 33.8639) + ' mb)' : 'M'}</span>
                <span style="color:#888;">Sky:</span><span>${esc(sky)}</span>
                ${wx ? `<span style="color:#888;">Wx:</span><span style="color:#ffb300;">${esc(wx)}</span>` : ''}
                ${p.feel != null ? `<span style="color:#888;">Feels Like:</span><span>${Math.round(p.feel)}°F</span>` : ''}
            </div>
            ${p.raw ? `<div style="border-top:1px solid #333;margin-top:6px;padding-top:4px;color:#888;font-size:10px;word-break:break-all;">${esc(p.raw)}</div>` : ''}
        </div>`;
        popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
    });
    map.on('mouseenter', 'metars-temp', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'metars-temp', () => { map.getCanvas().style.cursor = ''; });

    // AQI monitor click
    map.on('click', 'airnow-aqi-layer', e => {
        if (!e.features || !e.features[0]) return;
        const p = e.features[0].properties;
        const fcstId = `aqi-fcst-${++aqiFcstSeq}`;   // unique per click for async inject
        const ozAqi = (p.ozone_aqi != null && p.ozone_aqi !== 'null' && +p.ozone_aqi >= 0) ? +p.ozone_aqi : null;
        const pmAqi = (p.pm25_aqi != null && p.pm25_aqi !== 'null' && +p.pm25_aqi >= 0) ? +p.pm25_aqi : null;
        const ozPpb = (p.ozone_ppb != null && p.ozone_ppb !== 'null') ? +p.ozone_ppb : null;
        const pmUgm = (p.pm25_ugm3 != null && p.pm25_ugm3 !== 'null') ? +p.pm25_ugm3 : null;
        const ozTxt = ozAqi != null ? `${ozAqi} (${aqiCategory(ozAqi)})` : 'N/A';
        const pmTxt = pmAqi != null ? `${pmAqi} (${aqiCategory(pmAqi)})` : 'N/A';
        const ozConc = ozPpb != null ? `${ozPpb} ppb` : '';
        const pmConc = pmUgm != null ? `${pmUgm} µg/m³` : '';
        const overall = p.aqi || 0;
        const vtDate = p.valid_time ? new Date(p.valid_time) : null;
        const validStr = vtDate ? `${vtDate.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, month: 'short', day: 'numeric', timeZoneName: 'short' })} (${vtDate.toISOString().substring(11, 16)}Z)` : 'Unknown';
        const html = `<div style="font-family:Inter,sans-serif;font-size:11px;color:#e0e0e0;background:#0d1117;padding:8px;border-radius:4px;">
            <div style="font-weight:bold;color:${aqiColor(overall)};font-size:13px;margin-bottom:4px;">${esc(p.site_name || 'Monitor')}</div>
            <div style="color:#888;margin-bottom:6px;">${validStr}</div>
            <div style="display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin-bottom:6px;">
                <span style="color:#888;">Ozone AQI:</span><span style="color:${ozAqi > 0 ? aqiColor(ozAqi) : '#666'}">${ozTxt}</span>
                ${ozConc ? `<span style="color:#888;">Ozone Conc:</span><span style="color:#aaa;">${ozConc}</span>` : ''}
                <span style="color:#888;">PM2.5 AQI:</span><span style="color:${pmAqi > 0 ? aqiColor(pmAqi) : '#666'}">${pmTxt}</span>
                ${pmConc ? `<span style="color:#888;">PM2.5 Conc:</span><span style="color:#aaa;">${pmConc}</span>` : ''}
            </div>
            <div style="border-top:1px solid #333;padding-top:4px;">
                <span style="color:#888;">Overall AQI:</span> <span style="font-weight:bold;color:${aqiColor(overall)}">${overall} — ${aqiCategory(overall)}</span>
            </div>
            <div style="color:#555;font-size:9px;margin-top:4px;">Hourly EPA breakpoint AQI (not NowCast)</div>
            <div id="${fcstId}" style="margin-top:6px;color:#888;font-size:10px;">Loading forecast…</div>
        </div>`;
        popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
        // Async: fetch the area's O3 + PM2.5 forecast (today/tomorrow) and inject
        const coords = (e.features[0].geometry && e.features[0].geometry.coordinates) || [e.lngLat.lng, e.lngLat.lat];
        fetchAqiForecast(coords[0], coords[1]).then(fc => {
            const el = document.getElementById(fcstId);
            if (el) el.innerHTML = renderAqiForecast(fc);
        });
    });
    map.on('mouseenter', 'airnow-aqi-layer', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'airnow-aqi-layer', () => { map.getCanvas().style.cursor = ''; });

    // FIRMS fire click (point layer)
    map.on('click', 'firms-fires-layer', e => {
        if (!e.features || !e.features[0]) return;
        const p = e.features[0].properties;
        const coord = e.features[0].geometry.coordinates;
        const dt = p.acq_datetime || p.acq_date || '';
        const conf = p.confidence || p.conf || 'N/A';
        const confLabel = conf >= 80 ? 'High' : conf >= 40 ? 'Nominal' : 'Low';
        const bright = p.bright_ti4 || p.brightness || 'N/A';
        const frp = p.frp || 'N/A';
        const sensor = p.sensor || 'VIIRS';
        const satellite = p.satellite || 'Unknown';
        const html = `<div style="font-family:Inter,sans-serif;font-size:11px;color:#e0e0e0;background:#0d1117;padding:8px;border-radius:4px;">
            <div style="font-weight:bold;color:#ff6600;font-size:13px;margin-bottom:4px;">🔥 ${esc(sensor)} Fire Detection</div>
            <div style="color:#aaa;margin-bottom:2px;">Satellite: <b>${esc(satellite)}</b></div>
            <div style="color:#888;margin-bottom:6px;">${dt ? new Date(dt).toUTCString() : 'Recent'}</div>
            <div><span style="color:#888;">Confidence:</span> ${esc(confLabel)} (${esc(conf)}%)</div>
            <div><span style="color:#888;">Brightness:</span> ${esc(bright)}K</div>
            <div><span style="color:#888;">FRP:</span> ${esc(frp)} MW</div>
            <div style="color:#555;margin-top:4px;">${coord ? coord[1].toFixed(4) + '°N, ' + Math.abs(coord[0]).toFixed(4) + '°W' : ''}</div>
        </div>`;
        popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
    });
    map.on('mouseenter', 'firms-fires-layer', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'firms-fires-layer', () => { map.getCanvas().style.cursor = ''; });

    // River gauge click — opens detail panel with hydrograph
    map.on('click', 'river-gauges-layer', e => {
        if (!e.features || !e.features[0]) return;
        const p = e.features[0].properties;
        const gaugeId = p.id;
        if (gaugeId) showGaugeDetail(gaugeId, e.lngLat, e.originalEvent);
    });
    map.on('mouseenter', 'river-gauges-layer', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'river-gauges-layer', () => { map.getCanvas().style.cursor = ''; });

    // NHC Storm point click
    map.on('click', 'nhc-track-pts', e => {
        if (!e.features || !e.features[0]) return;
        const feat = e.features[0];
        const p = feat.properties;
        const name = p.displayname || p.stormname || p.STORMNAME || 'Unknown';
        const ptcTag = p.isPTC == 1 ? ' <span style="background:#b388ff;color:#1a1030;font-size:9px;font-weight:bold;padding:1px 5px;border-radius:3px;vertical-align:middle;">PTC</span>' : '';
        const wind = p.maxwind || p.MAXWIND || 0;
        const gust = p.gust || p.GUST || 0;
        const rawMslp = p.MSLP || p.mslp || 9999;
        const mslp = (rawMslp && rawMslp < 9990) ? `${Math.round(rawMslp)} mb` : null;
        const tau = p.tau || p.TAU || 0;
        const tauLabel = tau == 0 ? 'Current Position' : `Forecast +${Math.round(tau)}h`;
        const stormType = p.stormtype || p.STORMTYPE || '';
        const cat = stormType === 'HU' ? (wind >= 137 ? 'CAT 5' : wind >= 113 ? 'CAT 4' : wind >= 96 ? 'CAT 3' : wind >= 83 ? 'CAT 2' : 'CAT 1') :
                    stormType === 'TS' ? 'Tropical Storm' :
                    stormType === 'TD' ? 'Tropical Depression' :
                    stormType === 'STD' ? 'Subtropical Depression' :
                    stormType === 'STS' ? 'Subtropical Storm' :
                    stormType === 'EX' ? 'Post-Tropical' :
                    stormType === 'LO' ? 'Remnant Low' :
                    stormType === 'DB' ? 'Disturbance' :
                    wind >= 64 ? 'Hurricane' : wind >= 34 ? 'Tropical Storm' : 'Tropical Depression';

        // Movement: use API values if real, otherwise compute from track points
        const rawDir = p.tcdir != null ? p.tcdir : 9999;
        const rawSpd = p.tcspd != null ? p.tcspd : 9999;
        let movement = '';
        if (rawDir < 9990 && rawSpd < 9990) {
            movement = `${Math.round(rawDir)}° at ${Math.round(rawSpd)} kt`;
        } else {
            // Compute from consecutive forecast positions
            try {
                const src = map.getSource('nhc-storms');
                if (src && src._data) {
                    // NOAA's mirror groups by bin; NHC-direct features carry the
                    // ATCF id instead. Either way, only compare within one storm.
                    const key = f => f.binnumber || f.BINNUMBER || f.atcfid || '';
                    const stormId = key(p);
                    const pts = (src._data.features || [])
                        .filter(f => f.properties.layerType === 'point' && key(f.properties) === stormId)
                        .sort((a, b) => (a.properties.tau || 0) - (b.properties.tau || 0));
                    const idx = pts.findIndex(f => (f.properties.tau || 0) == tau);
                    if (idx > 0) {
                        const prev = pts[idx - 1].geometry.coordinates;
                        const curr = feat.geometry.coordinates;
                        const prevTau = pts[idx - 1].properties.tau || 0;
                        const dLon = (curr[0] - prev[0]) * Math.PI / 180;
                        const lat1 = prev[1] * Math.PI / 180, lat2 = curr[1] * Math.PI / 180;
                        const y = Math.sin(dLon) * Math.cos(lat2);
                        const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
                        let bearing = Math.atan2(y, x) * 180 / Math.PI;
                        if (bearing < 0) bearing += 360;
                        // Distance in nautical miles (1° lat ≈ 60 nm)
                        const dLatNm = (curr[1] - prev[1]) * 60;
                        const dLonNm = (curr[0] - prev[0]) * 60 * Math.cos((lat1 + lat2) / 2);
                        const distNm = Math.sqrt(dLatNm * dLatNm + dLonNm * dLonNm);
                        const hours = tau - prevTau;
                        const speed = hours > 0 ? distNm / hours : 0;
                        movement = `${Math.round(bearing)}° at ${Math.round(speed)} kt`;
                    }
                }
            } catch (err) { /* silently fall back */ }
        }
        // The initial position has no earlier point to difference against, but
        // NHC's own graphics state the heading — use it rather than showing none.
        if (!movement && p.motion) movement = p.motion;

        const validTime = p.fldatelbl || p.FLDATELBL || p.datelbl || p.DATELBL || '';
        const advNum = p.ADVISNUM || p.advisnum || 'N/A';
        // A trailing letter (e.g. 1A) marks an intermediate advisory — NHC updates
        // the position/watches on these, but the forecast track/cone only refreshes
        // on the full advisory. advdate is the actual issuance time.
        const isInter = /[A-Za-z]$/.test(String(advNum));
        const advDate = p.advdate || p.ADVDATE || '';
        // NOAA's GIS feed can lag NHC's official advisories by many hours — say so
        // loudly rather than presenting a day-old cone as current.
        const gisStale = nhcGisStaleBins[p.binnumber || p.BINNUMBER || ''];
        const html = `<div style="font-family:Inter,sans-serif;font-size:11px;color:#e0e0e0;background:#0d1117;padding:8px;border-radius:4px;max-width:320px;">
            <div style="font-weight:bold;color:#ff6600;font-size:14px;margin-bottom:2px;">${esc(name)}${ptcTag}</div>
            <div style="color:#888;font-size:10px;margin-bottom:6px;">${tauLabel}${validTime ? ' — ' + validTime : ''}</div>
            ${gisStale ? `<div style="background:#3d2600;border-left:3px solid #ffb300;padding:5px 8px;margin-bottom:7px;font-size:10px;line-height:1.5;color:#ffd479;">
                <b>&#9888; OUT OF DATE</b> — this track/cone is advisory <b>#${gisStale.gisAdv}</b> (${gisStale.gisDate}).<br>
                NHC's current advisory is <b>#${esc(gisStale.officialAdv)} — ${esc(gisStale.name)} (${esc(gisStale.cls)})</b>. NOAA's tropical GIS feed is behind; the text products under <b>Official Advisories</b> are current.
            </div>` : ''}
            <div style="display:grid;grid-template-columns:auto 1fr;gap:2px 10px;">
                <span style="color:#888;">Classification:</span><span style="color:#ffcc00;">${cat}</span>
                <span style="color:#888;">Max Wind:</span><span>${wind} kt${gust > 0 ? ' (gusts ' + Math.round(gust) + ' kt)' : ''}</span>
                ${mslp ? `<span style="color:#888;">Min Pressure:</span><span>${mslp}</span>` : ''}
                ${movement ? `<span style="color:#888;">Movement:</span><span>${movement}</span>` : ''}
                <span style="color:#888;">Advisory:</span><span>#${advNum}${isInter ? ' <span style="color:#8fd3ff;">(intermediate)</span>' : ''}</span>
                ${advDate ? `<span style="color:#888;">Issued:</span><span>${advDate}</span>` : ''}
            </div>
            ${isInter ? '<div style="color:#8fd3ff;font-size:9px;margin-top:5px;line-height:1.4;">Intermediate advisory — position &amp; watches updated; the forecast track/cone refreshes on the next full advisory.</div>' : ''}
            ${p.src === 'nhc' ? '<div style="color:#00cc66;font-size:9px;margin-top:5px;line-height:1.4;">Source: NHC advisory graphics (direct) — the NOAA GIS mirror is behind, so this cone/track came straight from the National Hurricane Center.</div>' : ''}
        </div>`;
        popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
    });
    map.on('mouseenter', 'nhc-track-pts', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'nhc-track-pts', () => { map.getCanvas().style.cursor = ''; });

    // Hurricane Hunter obs click → decoded observation popup
    map.on('click', 'recon-hdob-pts', e => {
        if (!e.features || !e.features[0]) return;
        const p = e.features[0].properties;
        const row = (k, v) => v != null && v !== '' ?
            `<div style="display:flex;justify-content:space-between;gap:14px;"><span style="color:#8b97a3;">${k}</span><span style="color:#fff;">${v}</span></div>` : '';
        const html = `
            <div style="font-family:'Roboto Mono',monospace;font-size:11px;min-width:230px;">
                <div style="color:#7fff9e;font-weight:700;margin-bottom:4px;">✈ ${esc(p.callsign)} · ${esc(p.storm)}<span style="color:#8b97a3;font-weight:400;"> · ${esc(p.timeStr)}Z</span></div>
                ${row('Flight-level wind', p.flWind)}
                ${row('Peak FL wind (10s)', p.peak != null ? p.peak + ' kt' : null)}
                ${row('SFMR sfc wind', p.sfmr != null ? p.sfmr + ' kt' : null)}
                ${row('Extrap sfc pressure', p.psfc != null ? p.psfc + ' mb' : null)}
                ${row('Flight-level temp', p.temp != null ? p.temp + '°C' : null)}
                ${row('Dew point', p.dp != null ? p.dp + '°C' : null)}
                ${row('Rain rate (SFMR)', p.rain != null ? p.rain + ' mm/hr' : null)}
            </div>`;
        new maplibregl.Popup({ maxWidth: '320px' }).setLngLat(e.lngLat).setHTML(html).addTo(map);
    });
    map.on('mouseenter', 'recon-hdob-pts', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'recon-hdob-pts', () => { map.getCanvas().style.cursor = ''; });

    // Model guidance point click → forecast position + intensity popup
    map.on('click', 'adeck-pts', e => {
        if (!e.features || !e.features[0]) return;
        const p = e.features[0].properties;
        const cat = v => v == null ? '' : v < 34 ? ' (TD)' : v < 64 ? ' (TS)' : v < 83 ? ' (Cat 1)' :
            v < 96 ? ' (Cat 2)' : v < 113 ? ' (Cat 3)' : v < 137 ? ' (Cat 4)' : ' (Cat 5)';
        const html = `
            <div style="font-family:'Roboto Mono',monospace;font-size:11px;min-width:210px;">
                <div style="color:${p.color};font-weight:700;margin-bottom:4px;">${p.name} <span style="color:#8b97a3;font-weight:400;">(${p.tech})</span>${isAiModel(p.tech) ? ' <span style="color:#ea80fc;font-weight:400;">✦ AI</span>' : ''}</div>
                <div style="color:#8b97a3;">Init ${p.cycle}Z · F${String(p.tau).padStart(3, '0')}</div>
                <div style="color:#fff;">Valid ${p.valid}</div>
                ${p.vmax ? `<div style="color:#ffd166;">Max wind ${p.vmax} kt${cat(p.vmax)}</div>` : ''}
                ${p.mslp ? `<div style="color:#fff;">MSLP ${p.mslp} mb</div>` : ''}
            </div>`;
        new maplibregl.Popup({ maxWidth: '300px' }).setLngLat(e.lngLat).setHTML(html).addTo(map);
    });
    map.on('mouseenter', 'adeck-pts', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'adeck-pts', () => { map.getCanvas().style.cursor = ''; });

    // NHC Tropical Outlook area click — shows probabilities + loads TWO discussion
    map.on('click', 'nhc-outlook-fill', e => {
        if (!e.features || !e.features[0]) return;
        const p = e.features[0].properties;
        const basin = (p.basin || '').toLowerCase();
        const basinLabel = basin.includes('pacific') || basin.includes('epac') ? 'Eastern Pacific' : basin.includes('atlantic') || basin.includes('atl') ? 'Atlantic' : (p.basin || 'Unknown');
        const basinCode = basin.includes('pacific') || basin.includes('epac') ? 'epac' : 'atl';

        const riskColor = (risk) => {
            const r = (risk || '').toLowerCase();
            if (r.includes('high') || r === 'high') return '#ff0000';
            if (r.includes('med') || r === 'medium') return '#ff9900';
            return '#ffff00';
        };

        const prob2 = p.prob2day || '0%';
        const prob7 = p.prob7day || '0%';
        const risk2 = p.risk2day || 'Low';
        const risk7 = p.risk7day || 'Low';
        const risk2Str = typeof risk2 === 'string' ? risk2 : (risk2 > 60 ? 'High' : risk2 > 20 ? 'Medium' : 'Low');
        const risk7Str = typeof risk7 === 'string' ? risk7 : (risk7 > 60 ? 'High' : risk7 > 20 ? 'Medium' : 'Low');

        const popupId = `nhc-two-btn-${Date.now()}`;
        const html = `<div style="font-family:Inter,sans-serif;font-size:11px;color:#e0e0e0;background:#0d1117;padding:10px;border-radius:4px;max-width:320px;">
            <div style="font-weight:bold;color:#ffcc00;font-size:13px;margin-bottom:6px;">Tropical Outlook — ${basinLabel}</div>
            <div style="display:grid;grid-template-columns:auto 1fr 1fr;gap:3px 12px;margin-bottom:8px;">
                <span></span><span style="color:#00e5ff;font-size:9px;text-transform:uppercase;">Probability</span><span style="color:#00e5ff;font-size:9px;text-transform:uppercase;">Risk</span>
                <span style="color:#888;">2-Day:</span><span style="font-weight:bold;">${prob2}</span><span style="color:${riskColor(risk2Str)};font-weight:bold;">${risk2Str}</span>
                <span style="color:#888;">7-Day:</span><span style="font-weight:bold;">${prob7}</span><span style="color:${riskColor(risk7Str)};font-weight:bold;">${risk7Str}</span>
            </div>
            <button id="${popupId}" style="background:#1a3a4a;color:#00e5ff;border:1px solid #00e5ff;padding:4px 10px;border-radius:3px;cursor:pointer;font-size:10px;width:100%;">View Full TWO Discussion →</button>
        </div>`;
        popup.setLngLat(e.lngLat).setHTML(html).addTo(map);

        // Wire up the button after popup renders
        setTimeout(() => {
            const btn = document.getElementById(popupId);
            if (btn) btn.addEventListener('click', () => {
                popup.remove();
                fetchNHCDiscussion(basinCode);
            });
        }, 50);
    });
    map.on('mouseenter', 'nhc-outlook-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'nhc-outlook-fill', () => { map.getCanvas().style.cursor = ''; });

    // Drought Monitor click
    map.on('click', 'drought-fill', e => {
        if (!e.features || !e.features[0]) return;
        const dm = e.features[0].properties.dm;
        const labels = { 0: 'D0 — Abnormally Dry', 1: 'D1 — Moderate Drought', 2: 'D2 — Severe Drought', 3: 'D3 — Extreme Drought', 4: 'D4 — Exceptional Drought' };
        const colors = { 0: '#ffff00', 1: '#ffcc66', 2: '#ff9900', 3: '#ff0000', 4: '#660000' };
        const html = `<div style="font-family:Inter,sans-serif;font-size:12px;color:#e0e0e0;background:#0d1117;padding:8px;border-radius:4px;">
            <div style="font-weight:bold;color:${colors[dm] || '#888'};font-size:13px;">${labels[dm] || 'Unknown'}</div>
        </div>`;
        popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
    });
    map.on('mouseenter', 'drought-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'drought-fill', () => { map.getCanvas().style.cursor = ''; });

    // NWS Alert map click (Universal Point Query for Warnings, Watches, Advisories)
    // Interrogation tools intercept clicks/moves when a tool mode is active.
    map.on('click', e => { if (window.interrogationMode) handleToolClick(map, paneId, e); });
    map.on('mousemove', e => { if (window.interrogationMode === 'measure') updateMeasurePreview(map, paneId, e.lngLat); });
    // Double-click finishes a measure line (and must not zoom the map)
    map.on('dblclick', e => {
        if (window.interrogationMode === 'measure') { e.preventDefault(); finishMeasure(map); }
    });

    map.on('click', async e => {
        if (window.interrogationMode) return;   // tool mode owns the click
        // Track each alert class separately so the point query surfaces only the
        // classes whose layer is actually on — matching the map's warnings /
        // advisories / watches split. (The legacy combined WWA WMS counts for
        // both warnings and advisories.)
        const warnLayerOn = isLayerVisible(map, 'nws-warnings-only-fill') || isLayerVisible(map, 'nws-wwa-wms-layer');
        const advisLayerOn = isLayerVisible(map, 'nws-advis-fill') || isLayerVisible(map, 'nws-wwa-wms-layer');
        const watchesActive = isLayerVisible(map, 'nws-watches-only-fill') || isLayerVisible(map, 'nws-watches-wms-layer') || isLayerVisible(map, 'nws-wwa-wms-layer');
        if (!warnLayerOn && !advisLayerOn && !watchesActive) return;

        // Ensure we didn't click on a METAR or FIRMS or MD icon, or an outlook area
        // (those have their own popups; only query alerts on a "bare" map click).
        const otlkLayers = [];
        [1, 2, 3].forEach(d => otlkLayers.push(`spc-day${d}-fill`));
        [1, 2].forEach(d => ['torn', 'wind', 'hail'].forEach(hz => otlkLayers.push(`spc-prob-${d}-${hz}-fill`)));
        [1, 2, 3, 4, 5, 6, 7, 8].forEach(d => otlkLayers.push(`spc-firewx-day${d}-fill`));
        const queryLayers = ['metars-temp', 'firms-fires-layer', 'spc-md-fill', 'wpc-mpd-fill', 'spc-lsr-icons', 'airnow-aqi-layer', 'drought-fill', 'nhc-track-pts', 'nhc-outlook-fill', 'nexrad-sites-layer', 'river-gauges-layer', 'wpc-ero-day1-fill', 'wpc-ero-day2-fill', 'wpc-ero-day3-fill', ...otlkLayers].filter(l => map.getLayer(l));
        const otherFeats = map.queryRenderedFeatures(e.point, { layers: queryLayers });
        if (otherFeats.length > 0) return;

        const lat = e.lngLat.lat.toFixed(4);
        const lng = e.lngLat.lng.toFixed(4);
        try {
            addLiveLog(`QUERY: Fetching alert data for [${lat}, ${lng}]...`, '#ffff00');
            const res = await fetch(`https://api.weather.gov/alerts/active?point=${lat},${lng}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const rawFeatures = data.features || [];
            
            // Filter to only the alert classes whose layer is on, using the same
            // classification as the map fill layers: Watch -> watches; else
            // Warning/Emergency -> warnings; everything else -> advisories.
            const features = rawFeatures.filter(f => {
                const eventName = f.properties?.event || '';
                if (eventName.includes('Watch')) return watchesActive;
                const isWarning = eventName.includes('Warning') || eventName.includes('Emergency');
                return isWarning ? warnLayerOn : advisLayerOn;
            });

            if (features.length === 0) {
                addLiveLog(`QUERY: No active alerts for visible layers at this location.`, '#00e5ff');
                return;
            }

            let combinedHtml = `<div style="font-family:Inter,sans-serif;font-size:11px;color:#e0e0e0;background:#0d1117;padding:10px;border-radius:4px;max-width:440px;max-height:450px;overflow-y:auto;">`;
            
            features.forEach((f, idx) => {
                const p = f.properties || {};
                // Escape before the newline->\<br\> pass, so the only markup that
                // survives into the popup is the line break we put there.
                const desc = esc(p.description || '').replace(/\n/g, '<br>');
                const instr = esc(p.instruction || '').replace(/\n/g, '<br>');
                const evtColor = getEventColor(p.event);
                // Detect IBW threat level from API response parameters
                const apiParams = p.parameters || {};
                const threatVal = apiParams.flashFloodDamageThreat?.[0] || apiParams.tornadoDamageThreat?.[0] || apiParams.thunderstormDamageThreat?.[0] || '';
                const hl = (p.headline || '').toLowerCase();
                const popupIsEmergency = hl.includes('tornado emergency') || hl.includes('flash flood emergency');
                const popupIsPDS = hl.includes('particularly dangerous situation');
                let threatBadge = '';
                if (popupIsEmergency) threatBadge = '<span style="display:inline-block;background:#ff0000;color:#fff;font-size:10px;font-weight:bold;padding:2px 6px;border-radius:3px;margin-left:8px;animation:ibw-badge-flash 1s ease-in-out infinite;">⚠ EMERGENCY</span>';
                else if (threatVal === 'Catastrophic' || threatVal === 'Destructive') threatBadge = `<span style="display:inline-block;background:#cc0000;color:#fff;font-size:10px;font-weight:bold;padding:2px 6px;border-radius:3px;margin-left:8px;">${threatVal.toUpperCase()}</span>`;
                else if (threatVal === 'Considerable') threatBadge = '<span style="display:inline-block;background:#ff6600;color:#fff;font-size:10px;font-weight:bold;padding:2px 6px;border-radius:3px;margin-left:8px;">CONSIDERABLE</span>';
                else if (popupIsPDS) threatBadge = '<span style="display:inline-block;background:#ff8800;color:#000;font-size:10px;font-weight:bold;padding:2px 6px;border-radius:3px;margin-left:8px;">PDS</span>';
                if (idx > 0) combinedHtml += `<hr style="border:0;border-top:1px solid #333;margin:12px 0;">`;
                combinedHtml += `
                    <div style="font-weight:bold;color:${evtColor};font-size:14px;margin-bottom:4px;">${esc(p.event || 'Weather Alert')}${threatBadge}</div>
                    <div style="color:#888;margin-bottom:4px;">${esc(p.senderName || '')}</div>
                    <div style="margin-bottom:6px;font-weight:bold;color:#fff;">${esc(p.headline || '')}</div>
                    <div style="color:#ffb300;font-size:10px;margin-bottom:8px;">Expires: ${p.expires ? new Date(p.expires).toUTCString() : 'Unknown'}</div>
                    ${desc ? `<div style="padding-top:6px;margin-bottom:6px;line-height:1.5;white-space:pre-wrap;">${desc}</div>` : ''}
                    ${instr ? `<div style="border-top:1px solid #333;padding-top:6px;color:#00e5ff;line-height:1.5;white-space:pre-wrap;"><b>PRECAUTIONARY/PREPAREDNESS ACTIONS:</b><br>${instr}</div>` : ''}
                `;
            });
            combinedHtml += `</div>`;
            popup.setLngLat(e.lngLat).setHTML(combinedHtml).addTo(map);
            addLiveLog(`QUERY: Displaying ${features.length} alert(s) for location.`, '#00ff88');
        } catch (err) {
            addLiveLog(`QUERY ERROR: Failed to retrieve point alert data (${err.message})`, '#ff3333');
        }
    });


    // SPC MD click
    map.on('click', 'spc-md-fill', e => {
        if (!e.features || !e.features[0]) return;
        const p = e.features[0].properties;
        const mcdNum = p.name || 'Unknown';
        const mcdInfo = p.folderpath || '';
        // Feed fields are text, never markup; the link only renders if it is
        // an https URL, so a bad feed can't hand the click anything else.
        const mcdLink = safeHttpsUrl(p.popupinfo);

        const html = `<div style="font-family:Inter,sans-serif;font-size:11px;color:#e0e0e0;background:#0d1117;padding:8px;border-radius:4px;max-width:300px;">
            <div style="font-weight:bold;color:#ff3333;font-size:13px;margin-bottom:4px;">Mesoscale Discussion ${esc(mcdNum)}</div>
            <div style="color:#888;margin-bottom:8px;">${esc(mcdInfo)}</div>
            ${mcdLink ? `<a href="${mcdLink}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:#333;color:white;padding:4px 8px;border-radius:2px;text-decoration:none;font-size:10px;">VIEW FULL DISCUSSION →</a>` : ''}
        </div>`;
        new maplibregl.Popup().setLngLat(e.lngLat).setHTML(html).addTo(map);
    });

    // WPC Mesoscale Precipitation Discussion click → popup w/ details + full discussion link
    map.on('click', 'wpc-mpd-fill', e => {
        if (!e.features || !e.features[0]) return;
        const p = e.features[0].properties;
        const fmtZ = s => (s && s.length >= 12) ? `${s.slice(4,6)}/${s.slice(6,8)} ${s.slice(8,10)}:${s.slice(10,12)}Z` : (s || '');
        const link = safeHttpsUrl(p.link);
        const html = `<div style="font-family:Inter,sans-serif;font-size:11px;color:#e0e0e0;background:#0d1117;padding:8px;border-radius:4px;max-width:320px;">
            <div style="font-weight:bold;color:#33c27a;font-size:13px;margin-bottom:4px;">WPC Mesoscale Precip Discussion #${esc(p.num || '?')}</div>
            <div style="color:#cfcfcf;margin-bottom:6px;">${esc(p.concern || '')}</div>
            <div style="color:#888;margin-bottom:8px;">Valid ${fmtZ(p.issue)} – ${fmtZ(p.expire)}</div>
            ${link ? `<a href="${link}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:#333;color:white;padding:4px 8px;border-radius:2px;text-decoration:none;font-size:10px;">VIEW FULL DISCUSSION →</a>` : ''}
        </div>`;
        new maplibregl.Popup().setLngLat(e.lngLat).setHTML(html).addTo(map);
    });
    map.on('mouseenter', 'wpc-mpd-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'wpc-mpd-fill', () => { map.getCanvas().style.cursor = ''; });

    // ─── SIGMET / AIRMET click ───
    map.on('click', 'airsigmet-fill', e => {
        if (!e.features || !e.features[0]) return;
        const p = e.features[0].properties || {};
        const hazColor = { CONVECTIVE: '#ff3b3b', TURB: '#ff9e3b', ICE: '#3bd4ff', IFR: '#c46bff', 'MTN OBSCN': '#b98a5a', ASH: '#ff5ac4' }[p.hazard] || '#ffd23c';
        const fmt = s => s ? String(s).replace('T', ' ').replace(/:\d{2}\.\d+Z?$/, 'Z').slice(5, 16) + 'Z' : '';
        const alt = (p.altitudeLow1 || p.altitudeHi1)
            ? `<div><span style="color:#888;">Altitude:</span> ${p.altitudeLow1 ? esc(p.altitudeLow1) : 'SFC'} – ${esc(p.altitudeHi1 || '?')} ft</div>` : '';
        const mov = (p.movementDir != null && p.movementDir !== '')
            ? `<div><span style="color:#888;">Movement:</span> ${esc(p.movementDir)}° @ ${esc(p.movementSpd || 0)} kt</div>` : '';
        const html = `<div style="font-family:Inter,sans-serif;font-size:11px;color:#e0e0e0;background:#0d1117;padding:8px;border-radius:4px;max-width:340px;">
            <div style="font-weight:bold;color:${hazColor};font-size:13px;margin-bottom:3px;">${esc(p.airSigmetType || 'SIGMET')} · ${esc(p.hazard || '')}</div>
            <div style="color:#888;margin-bottom:4px;">Valid ${fmt(p.validTimeFrom)} – ${fmt(p.validTimeTo)}</div>
            ${alt}${mov}
            ${p.rawAirSigmet ? `<pre style="white-space:pre-wrap;color:#9fd3ff;font-size:10px;margin:6px 0 0;border-top:1px solid #333;padding-top:5px;">${esc(p.rawAirSigmet)}</pre>` : ''}
        </div>`;
        popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
    });
    map.on('mouseenter', 'airsigmet-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'airsigmet-fill', () => { map.getCanvas().style.cursor = ''; });

    // ─── PIREP click ───
    map.on('click', 'pireps-layer', e => {
        if (!e.features || !e.features[0]) return;
        const p = e.features[0].properties || {};
        const urgent = p.airepType === 'Urgent PIREP';
        const html = `<div style="font-family:Inter,sans-serif;font-size:11px;color:#e0e0e0;background:#0d1117;padding:8px;border-radius:4px;max-width:320px;">
            <div style="font-weight:bold;color:${urgent ? '#ff3b3b' : '#00e5ff'};font-size:12px;margin-bottom:3px;">${urgent ? '⚠ URGENT PIREP' : 'PILOT REPORT'} · ${esc(p.icaoId || '')}</div>
            <div style="color:#888;margin-bottom:2px;">${esc(p.acType || 'Unknown aircraft')}${p.fltlvl ? ' · FL' + esc(p.fltlvl) : ''}</div>
            ${(p.temp != null && p.temp !== '') ? `<div><span style="color:#888;">Temp:</span> ${esc(p.temp)}°C</div>` : ''}
            ${(p.wdir != null && p.wdir !== '') ? `<div><span style="color:#888;">Wind:</span> ${esc(p.wdir)}° @ ${esc(p.wspd || 0)} kt</div>` : ''}
            ${p.rawOb ? `<pre style="white-space:pre-wrap;color:#9fd3ff;font-size:10px;margin:6px 0 0;border-top:1px solid #333;padding-top:5px;">${esc(p.rawOb)}</pre>` : ''}
        </div>`;
        popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
    });
    map.on('mouseenter', 'pireps-layer', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'pireps-layer', () => { map.getCanvas().style.cursor = ''; });

    // ─── ProbSevere storm-object click ───
    map.on('click', 'probsevere-fill', e => {
        if (!e.features || !e.features[0]) return;
        const p = e.features[0].properties || {};
        const bar = (label, val, color) => {
            const v = Math.max(0, Math.min(100, parseFloat(val) || 0));
            return `<div style="display:flex;align-items:center;gap:6px;margin:2px 0;">
                <span style="width:64px;color:#aaa;">${label}</span>
                <span style="flex:1;height:9px;background:#1a2230;border-radius:2px;overflow:hidden;"><span style="display:block;height:100%;width:${v}%;background:${color};"></span></span>
                <span style="width:34px;text-align:right;color:${color};font-weight:bold;">${v}%</span></div>`;
        };
        const mE = parseFloat(p.MOTION_EAST) || 0, mS = parseFloat(p.MOTION_SOUTH) || 0;
        const spd = Math.round(Math.hypot(mE, mS) * 1.94384);            // m/s → kt
        const dir = ((Math.atan2(-mE, mS) * 180 / Math.PI) + 360) % 360; // toward-direction of storm motion
        const html = `<div style="font-family:Inter,sans-serif;font-size:11px;color:#e0e0e0;background:#0d1117;padding:9px;border-radius:4px;max-width:290px;">
            <div style="font-weight:bold;color:#ff9900;font-size:13px;margin-bottom:5px;">ProbSevere · Storm ${esc(p.ID || '')}</div>
            ${bar('Severe', p.ProbSevere, '#ff9900')}
            ${bar('Tornado', p.ProbTor, '#ff2bd0')}
            ${bar('Wind', p.ProbWind, '#3bd4ff')}
            ${bar('Hail', p.ProbHail, '#ffe14d')}
            <div style="border-top:1px solid #333;margin-top:6px;padding-top:5px;color:#cfcfcf;line-height:1.5;">
                <div><span style="color:#888;">MUCAPE:</span> ${esc(p.MUCAPE || '–')} J/kg &nbsp; <span style="color:#888;">EBShear:</span> ${esc(p.EBSHEAR || '–')} kt</div>
                <div><span style="color:#888;">MESH:</span> ${esc(p.MESH || '–')} in &nbsp; <span style="color:#888;">VIL:</span> ${esc(p.VIL || '–')} &nbsp; <span style="color:#888;">Ref:</span> ${esc(p.COMPREF || '–')} dBZ</div>
                <div><span style="color:#888;">Motion:</span> ${Math.round(dir)}° @ ${spd} kt</div>
            </div>
        </div>`;
        popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
    });
    map.on('mouseenter', 'probsevere-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'probsevere-fill', () => { map.getCanvas().style.cursor = ''; });

    // ─── National storm attribute (SCIT) cell click ───
    map.on('click', 'natt-cell', e => {
        if (!e.features || !e.features[0]) return;
        const p = e.features[0].properties || {};
        const row = (k, v) => `<div><span style="color:#888;">${k}:</span> ${v}</div>`;
        const size = Number(p.max_size) || 0;
        const sizeColor = size >= 2.5 ? '#ff2bd0' : size >= 1.75 ? '#ff3b3b'
            : size >= 1.0 ? '#ff9e3b' : size >= 0.75 ? '#ffe14d' : '#6ec6ff';
        const flags = [];
        if (Number(p.meso_n) > 0) flags.push(`<span style="color:#ffffff;">MESO ${esc(p.meso_n)}</span>`);
        if (Number(p.tvs) === 1) flags.push('<span style="color:#ff2b2b;font-weight:bold;">TVS</span>');
        const html = `<div style="font-family:Inter,sans-serif;font-size:11px;color:#e0e0e0;background:#0d1117;padding:8px;border-radius:4px;max-width:250px;">
            <div style="font-weight:bold;color:${sizeColor};font-size:13px;margin-bottom:2px;">Cell ${esc(p.storm_id)} · K${esc(p.nexrad)}</div>
            ${flags.length ? `<div style="margin-bottom:4px;font-size:10px;letter-spacing:0.5px;">${flags.join(' · ')}</div>` : ''}
            <div style="line-height:1.6;">
                ${row('Max hail size', size > 0 ? `<b style="color:${sizeColor};">${size.toFixed(2)}"</b>` : 'none detected')}
                ${row('Prob of severe hail', p.posh != null ? esc(p.posh) + '%' : '—')}
                ${row('Prob of hail', p.poh != null ? esc(p.poh) + '%' : '—')}
                ${row('VIL', p.vil != null ? esc(p.vil) + ' kg/m²' : '—')}
                ${row('Max reflectivity', p.max_dbz != null ? esc(p.max_dbz) + ' dBZ' : '—')}
                ${row('Height of max dBZ', p.max_dbz_height != null ? esc(p.max_dbz_height) + ' kft' : '—')}
                ${row('Storm top', p.top != null ? esc(p.top) + ' kft' : '—')}
                ${row('Movement', (p.toward != null && p.toward !== '' && Number(p.sknt) > 0)
                    ? `toward ${Math.round(Number(p.toward))}° @ ${esc(p.sknt)} kt` : 'stationary / new')}
            </div>
            <div style="margin-top:5px;font-size:9px;color:#666;">Volume scan ${esc(String(p.valid).replace('T', ' ').replace('Z', 'Z'))}</div>
        </div>`;
        popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
    });
    map.on('mouseenter', 'natt-cell', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'natt-cell', () => { map.getCanvas().style.cursor = ''; });

    // ─── G-AIRMET hazard-area click ───
    map.on('click', 'gairmet-fill', e => {
        if (!e.features || !e.features[0]) return;
        const p = e.features[0].properties || {};
        const gaColor = { TURB: '#ff9e3b', 'TURB-HI': '#ff9e3b', 'TURB-LO': '#ffc07a', ICE: '#3bd4ff', IFR: '#c46bff', MT_OBSC: '#b98a5a', SFC_WND: '#ffd23c', LLWS: '#ff5ac4', FZLVL: '#7fbfff', M_FZLVL: '#7fbfff' }[p.hazard] || '#ffd23c';
        const fmt = s => s ? String(s).replace('T', ' ').replace(/:\d{2}(\.\d+)?Z?$/, 'Z').slice(5, 16) + 'Z' : '';
        const fh = (p.forecast != null && p.forecast !== '') ? `+${esc(p.forecast)}h` : '';
        const html = `<div style="font-family:Inter,sans-serif;font-size:11px;color:#e0e0e0;background:#0d1117;padding:8px;border-radius:4px;max-width:320px;">
            <div style="font-weight:bold;color:${gaColor};font-size:13px;margin-bottom:3px;">G-AIRMET ${esc(p.hazard || '')} <span style="color:#888;font-weight:normal;">${esc(p.product || '')} ${fh}</span></div>
            <div style="color:#888;margin-bottom:4px;">Valid ${fmt(p.validTime)}</div>
            ${p.dueTo ? `<div style="color:#cfcfcf;line-height:1.5;">${esc(p.dueTo)}</div>` : ''}
        </div>`;
        popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
    });
    map.on('mouseenter', 'gairmet-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'gairmet-fill', () => { map.getCanvas().style.cursor = ''; });

    // ─── TAF (terminal forecast) click ───
    map.on('click', 'taf-layer', e => {
        if (!e.features || !e.features[0]) return;
        const p = e.features[0].properties || {};
        const catColor = { VFR: '#33c27a', MVFR: '#4d9fff', IFR: '#ff3b3b', LIFR: '#ff2bd0' }[p.fltcat] || '#8b97a3';
        const fmt = s => s ? String(s).replace('T', ' ').replace(/:\d{2}(\.\d+)?Z?$/, 'Z').slice(5, 16) + 'Z' : '';
        const wind = (p.wdir != null && p.wdir !== '') ? `${String(p.wdir).padStart(3, '0')}° @ ${esc(p.wspd || 0)}${p.wgst ? 'G' + esc(p.wgst) : ''} kt` : '—';
        let clouds = '';
        try { const cl = typeof p.clouds === 'string' ? JSON.parse(p.clouds) : p.clouds; if (Array.isArray(cl)) clouds = cl.map(c => `${esc(c.cover)}${c.base != null ? Math.round(c.base / 100).toString().padStart(3, '0') : ''}`).join(' '); } catch (_) {}
        const html = `<div style="font-family:Inter,sans-serif;font-size:11px;color:#e0e0e0;background:#0d1117;padding:8px;border-radius:4px;max-width:300px;">
            <div style="font-weight:bold;color:${catColor};font-size:13px;margin-bottom:3px;">TAF ${esc(p.id || '')} · ${esc(p.fltcat || '')}</div>
            <div style="color:#888;margin-bottom:4px;">${esc(p.site || '')} · valid ${fmt(p.validTimeFrom)}–${fmt(p.validTimeTo)}</div>
            <div style="line-height:1.6;">
                <div><span style="color:#888;">Wind:</span> ${wind}</div>
                <div><span style="color:#888;">Vis:</span> ${esc(p.visib || '—')} sm &nbsp; <span style="color:#888;">Ceil:</span> ${p.ceil != null && p.ceil !== '' ? esc(p.ceil) * 100 + ' ft' : '—'}</div>
                ${clouds ? `<div><span style="color:#888;">Sky:</span> ${clouds}</div>` : ''}
            </div>
        </div>`;
        popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
    });
    map.on('mouseenter', 'taf-layer', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'taf-layer', () => { map.getCanvas().style.cursor = ''; });

    // ─── Center Weather Advisory click ───
    map.on('click', 'cwa-fill', e => {
        if (!e.features || !e.features[0]) return;
        const p = e.features[0].properties || {};
        const fmt = s => s ? String(s).replace('T', ' ').replace(/:\d{2}(\.\d+)?Z?$/, 'Z').slice(5, 16) + 'Z' : '';
        const html = `<div style="font-family:Inter,sans-serif;font-size:11px;color:#e0e0e0;background:#0d1117;padding:8px;border-radius:4px;max-width:340px;">
            <div style="font-weight:bold;color:#ff5ac4;font-size:13px;margin-bottom:3px;">CWA · ${esc(p.cwsu || '')} ${esc(p.name || '')} <span style="color:#888;font-weight:normal;">#${esc(p.seriesId || '')}</span></div>
            <div style="color:#888;margin-bottom:4px;">Valid ${fmt(p.validTimeFrom)} – ${fmt(p.validTimeTo)}</div>
            ${p.hazard ? `<div><span style="color:#888;">Hazard:</span> ${esc(p.hazard)}${p.qualifier ? ' (' + esc(p.qualifier) + ')' : ''}</div>` : ''}
            ${p.cwaText ? `<pre style="white-space:pre-wrap;color:#9fd3ff;font-size:10px;margin:6px 0 0;border-top:1px solid #333;padding-top:5px;">${esc(p.cwaText)}</pre>` : ''}
        </div>`;
        popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
    });
    map.on('mouseenter', 'cwa-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'cwa-fill', () => { map.getCanvas().style.cursor = ''; });

    // ─── NDBC buoy click ───
    map.on('click', 'ndbc-layer', e => {
        if (!e.features || !e.features[0]) return;
        const p = e.features[0].properties || {};
        const row = (label, v, unit) => (v != null && v !== 'null')
            ? `<div><span style="color:#888;">${label}:</span> ${esc(v)}${unit}</div>` : '';
        const html = `<div style="font-family:Inter,sans-serif;font-size:11px;color:#e0e0e0;background:#0d1117;padding:8px;border-radius:4px;max-width:250px;">
            <div style="font-weight:bold;color:#00b8d4;font-size:13px;margin-bottom:3px;">Buoy ${esc(p.id)} <span style="color:#888;font-weight:normal;">${esc(p.obs || '')}</span></div>
            <div style="line-height:1.6;">
                ${row('Wind', p.wdir != null && p.wspd != null ? `${p.wdir}° @ ${p.wspd}${p.gst != null ? 'G' + p.gst : ''}` : null, ' kt')}
                ${row('Waves', p.wvht, ' ft')}${row('Dom. period', p.dpd, ' s')}
                ${row('Pressure', p.pres, ' hPa')}
                ${row('Air temp', p.atmp, '°F')}${row('Water temp', p.wtmp, '°F')}
            </div>
        </div>`;
        popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
    });
    map.on('mouseenter', 'ndbc-layer', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'ndbc-layer', () => { map.getCanvas().style.cursor = ''; });

    // ─── SPC Day 4-8 outlook click ───
    map.on('click', 'spc-d48-fill', e => {
        if (!e.features || !e.features[0]) return;
        const p = e.features[0].properties || {};
        const html = `<div style="font-family:Inter,sans-serif;font-size:11px;color:#e0e0e0;background:#0d1117;padding:8px;border-radius:4px;max-width:280px;">
            <div style="font-weight:bold;color:#b87aff;font-size:13px;margin-bottom:3px;">SPC Day ${esc(p.day || '?')} Severe Outlook</div>
            <div><span style="color:#888;">Probability:</span> ${esc(p.LABEL2 || p.LABEL || '')}</div>
            <div style="color:#888;margin-top:3px;">Valid ${esc((p.VALID_ISO || '').slice(0, 10))} · issued ${esc((p.ISSUE_ISO || '').slice(0, 10))}</div>
        </div>`;
        popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
    });
    map.on('mouseenter', 'spc-d48-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'spc-d48-fill', () => { map.getCanvas().style.cursor = ''; });

    // ─── Storm-track cell click ───
    map.on('click', 'storm-attr-cell', e => {
        if (!e.features || !e.features[0]) return;
        const p = e.features[0].properties || {};
        const toward = (p.mvt_dir != null && p.mvt_dir !== '') ? Math.round((Number(p.mvt_dir) + 180) % 360) : null;
        const html = `<div style="font-family:Inter,sans-serif;font-size:11px;color:#e0e0e0;background:#0d1117;padding:8px;border-radius:4px;max-width:240px;">
            <div style="font-weight:bold;color:#ff2bd0;font-size:13px;margin-bottom:4px;">Storm Cell ${esc(p.id)}</div>
            <div style="line-height:1.6;">
                <div><span style="color:#888;">Max reflectivity:</span> ${p.dbzm != null ? esc(p.dbzm) + ' dBZ' : '—'}</div>
                <div><span style="color:#888;">Storm top:</span> ${p.top_kft != null ? esc(p.top_kft) + ' kft' : '—'}</div>
                <div><span style="color:#888;">Movement:</span> ${toward != null ? 'toward ' + toward + '° @ ' + esc(p.mvt_spd) + ' kt' : 'new / stationary'}</div>
            </div>
        </div>`;
        popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
    });
    map.on('mouseenter', 'storm-attr-cell', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'storm-attr-cell', () => { map.getCanvas().style.cursor = ''; });

    // ─── Mesocyclone / TVS marker click ───
    const mesoClick = e => {
        if (!e.features || !e.features[0]) return;
        const p = e.features[0].properties || {};
        const isTvs = p.tvs === 'Y';
        const html = `<div style="font-family:Inter,sans-serif;font-size:11px;color:#e0e0e0;background:#0d1117;padding:8px;border-radius:4px;max-width:250px;">
            <div style="font-weight:bold;color:${isTvs ? '#ff2b2b' : '#ff9e3b'};font-size:13px;margin-bottom:4px;">${isTvs ? '⚠ TVS · ' : ''}Circulation ${esc(p.id)} <span style="color:#888;font-weight:normal;">cell ${esc(p.stmid || '')}</span></div>
            <div style="line-height:1.6;">
                <div><span style="color:#888;">Strength rank:</span> ${esc(p.sr)} &nbsp; <span style="color:#888;">MSI:</span> ${esc(p.msi)}</div>
                <div><span style="color:#888;">Max rot. velocity:</span> ${p.maxrv != null ? esc(p.maxrv) + ' kt' : '—'}</div>
                <div><span style="color:#888;">Base:</span> ${p.base != null ? esc(p.base) + ' kft' : '—'} &nbsp; <span style="color:#888;">Depth:</span> ${p.depth != null ? esc(p.depth) + ' kft' : '—'}</div>
                <div><span style="color:#888;">Motion:</span> ${esc(p.mdir)}° @ ${esc(p.mspd)} kt</div>
            </div>
        </div>`;
        popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
    };
    map.on('click', 'meso-circ', mesoClick);
    map.on('click', 'meso-tvs', mesoClick);
    map.on('mouseenter', 'meso-circ', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'meso-circ', () => { map.getCanvas().style.cursor = ''; });

    // SPC LSR click
    map.on('click', 'spc-lsr-icons', e => {
        if (!e.features || !e.features[0]) return;
        const p = e.features[0].properties;
        const coord = e.features[0].geometry.coordinates;
        const timeStr = p.valid ? new Date(p.valid).toUTCString() : 'Recent';
        const mag = p.magnitude && p.unit ? `<div><span style="color:#888;">Magnitude:</span> ${esc(p.magnitude)} ${esc(p.unit)}</div>` : (p.magnitude ? `<div><span style="color:#888;">Magnitude:</span> ${esc(p.magnitude)}</div>` : '');
        const typeColors = {
            'TORNADO': '#ff0000', 'HAIL': '#00cc00', 'TSTM WND GST': '#3399ff',
            'TSTM WND DMG': '#3399ff', 'FLASH FLOOD': '#00cccc', 'FLOOD': '#008888',
            'SNOW': '#cc88ff', 'RAIN': '#0088aa', 'MARINE TSTM WIND': '#6666cc'
        };
        const color = typeColors[p.lsrType] || '#ff9900';
        const html = `<div style="font-family:Inter,sans-serif;font-size:11px;color:#e0e0e0;background:#0d1117;padding:8px;border-radius:4px;max-width:320px;">
            <div style="font-weight:bold;color:${color};font-size:13px;margin-bottom:2px;">${p.icon || '⚡'} ${esc(p.lsrType)}</div>
            <div style="color:#aaa;margin-bottom:2px;">${esc(p.city)}, ${esc(p.county)} Co., ${esc(p.state)}</div>
            <div style="color:#888;margin-bottom:6px;">${timeStr} — WFO: ${esc(p.wfo)}</div>
            ${mag}
            <div style="color:#888;margin-bottom:4px;"><span style="color:#888;">Source:</span> ${esc(p.source)}</div>
            ${p.remark ? `<div style="color:#ccc;font-style:italic;margin-top:4px;border-top:1px solid #333;padding-top:4px;">${esc(p.remark)}</div>` : ''}
            <div style="color:#555;margin-top:4px;">${coord ? coord[1].toFixed(4) + '°N, ' + Math.abs(coord[0]).toFixed(4) + '°W' : ''}</div>
        </div>`;
        popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
    });
    map.on('mouseenter', 'spc-lsr-icons', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'spc-lsr-icons', () => { map.getCanvas().style.cursor = ''; });

    // WPC ERO risk-area click → open the Excessive Rainfall Discussion in the text browser
    ['1', '2', '3'].forEach(day => {
        const lyr = `wpc-ero-day${day}-fill`;
        map.on('click', lyr, e => {
            if (!e.features || !e.features[0]) return;
            openEroDiscussion(e.features[0].properties.category);
        });
        map.on('mouseenter', lyr, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', lyr, () => { map.getCanvas().style.cursor = ''; });
    });

    // ─── SPC outlook / fire-weather area click → details popup + in-app discussion ───
    // Mimics the NHC tropical-outlook popup: click an area, read its category, and
    // open the associated SPC narrative. Convective categorical + probabilistic
    // outlooks share one Day-N discussion; fire weather has its own per-day text
    // (Days 3-8 are one combined product).
    const cursorPointer = lyr => {
        map.on('mouseenter', lyr, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', lyr, () => { map.getCanvas().style.cursor = ''; });
    };
    const showDiscPopup = (lngLat, accent, title, sub, url, discTitle, header) => {
        const btnId = `spc-disc-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
        popup.setLngLat(lngLat).setHTML(
            `<div style="font-family:Inter,sans-serif;font-size:11px;color:#e0e0e0;background:#0d1117;padding:10px;border-radius:4px;max-width:300px;">
                <div style="font-weight:bold;color:${accent};font-size:13px;margin-bottom:4px;">${title}</div>
                ${sub ? `<div style="color:#cfcfcf;margin-bottom:8px;">${sub}</div>` : ''}
                <button id="${btnId}" style="background:#1a3a4a;color:#00e5ff;border:1px solid #00e5ff;padding:4px 10px;border-radius:3px;cursor:pointer;font-size:10px;width:100%;">View Full Discussion →</button>
            </div>`
        ).addTo(map);
        setTimeout(() => {
            const btn = document.getElementById(btnId);
            if (btn) btn.addEventListener('click', () => { popup.remove(); openSpcDiscussion(url, discTitle, header); });
        }, 50);
    };
    const otlkDiscUrl = day => `https://www.spc.noaa.gov/products/outlook/day${day}otlk.html`;
    const fireWxDiscUrl = day => (day <= 2)
        ? `https://www.spc.noaa.gov/products/fire_wx/fwdy${day}.html`
        : 'https://www.spc.noaa.gov/products/exper/fire_wx/index.html';

    // Convective categorical outlooks (Day 1-3)
    [1, 2, 3].forEach(day => {
        const lyr = `spc-day${day}-fill`;
        map.on('click', lyr, e => {
            if (!e.features || !e.features[0]) return;
            const p = e.features[0].properties || {};
            const label = p.LABEL2 || p.LABEL || 'Categorical Risk';
            showDiscPopup(e.lngLat, p.fill || '#ff4d4d', `SPC Day ${day} Outlook`, label,
                otlkDiscUrl(day), `SPC Day ${day} Convective Outlook`, `>>> Clicked area: ${label} <<<`);
        });
        cursorPointer(lyr);
    });

    // Probabilistic hazard outlooks (Day 1-2 torn/wind/hail) — share the Day-N narrative
    [1, 2].forEach(day => {
        ['torn', 'wind', 'hail'].forEach(hz => {
            const lyr = `spc-prob-${day}-${hz}-fill`;
            map.on('click', lyr, e => {
                if (!e.features || !e.features[0]) return;
                const p = e.features[0].properties || {};
                const pct = !isNaN(parseFloat(p.LABEL)) ? `${Math.round(parseFloat(p.LABEL) * 100)}% probability` : (p.LABEL2 || '');
                const hazName = SPC_HAZARD_NAMES[hz] || hz;
                showDiscPopup(e.lngLat, p.fill || '#ff884d', `SPC Day ${day} ${hazName} Prob`, pct,
                    otlkDiscUrl(day), `SPC Day ${day} Convective Outlook`, `>>> Clicked area: ${hazName} ${pct} <<<`);
            });
            cursorPointer(lyr);
        });
    });

    // Fire weather outlooks (Day 1-8): categorical fills + dry-thunderstorm boundaries
    [1, 2, 3, 4, 5, 6, 7, 8].forEach(day => {
        ['fill', 'dryt'].forEach(suf => {
            const lyr = `spc-firewx-day${day}-${suf}`;
            map.on('click', lyr, e => {
                if (!e.features || !e.features[0]) return;
                const p = e.features[0].properties || {};
                const cat = p.category || p.label || 'Fire Weather';
                showDiscPopup(e.lngLat, p.stroke || '#ff7f00', `SPC Day ${day} Fire Wx`, cat,
                    fireWxDiscUrl(day),
                    day <= 2 ? `SPC Day ${day} Fire Weather Outlook` : 'SPC Day 3-8 Fire Weather Outlook',
                    `>>> Clicked area: ${cat} <<<`);
            });
            cursorPointer(lyr);
        });
    });

    map.on('click', 'nexrad-sites-layer', e => {
        if (!e.features || e.features.length === 0) return;
        const siteId = e.features[0].properties.id;
        addLiveLog(`RADAR: Jumping directly to ${siteId} radar station`, '#00ffff');

        Object.values(maps).forEach(m => {
            if (m && m.getLayer('nexrad-sites-layer')) {
                m.setLayoutProperty('nexrad-sites-layer', 'visibility', 'none');
            }
        });

        const selectEl = document.getElementById('radar-site-select');
        if (selectEl) {
            selectEl.value = siteId;
            selectEl.dispatchEvent(new Event('change'));
        }
    });
    map.on('mouseenter', 'nexrad-sites-layer', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'nexrad-sites-layer', () => { map.getCanvas().style.cursor = ''; });
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 6: METAR FETCHER (all 50 states)
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchMETARs() {
    addLiveLog('SURFACE: Fetching METAR observations (all 50 states)...', '#00e5ff');
    const allFeatures = [];
    const batchSize = 10;

    try {
        for (let i = 0; i < US_STATES.length; i += batchSize) {
            const batch = US_STATES.slice(i, i + batchSize);
            const results = await Promise.allSettled(
                batch.map(st =>
                    fetch(`https://mesonet.agron.iastate.edu/api/1/currents.geojson?network=${st}_ASOS`)
                        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
                )
            );
            results.forEach(r => {
                if (r.status === 'fulfilled' && r.value && r.value.features) {
                    r.value.features.forEach(f => {
                        const sknt = f.properties.sknt || 0;
                        const drct = f.properties.drct || 0;
                        // Map barb icon name
                        const barbSpeed = Math.round(sknt / 5) * 5;
                        f.properties.barb_icon = `barb-${Math.min(barbSpeed, 150)}`;
                        allFeatures.push(f);
                    });
                }
            });
        }

        metarGeoJSON = { type: 'FeatureCollection', features: allFeatures };
        metarsLoaded = true;

        // Extract latest observation time
        latestMetarTime = null;
        const now = new Date();
        allFeatures.forEach(f => {
            const t = f.properties?.utc_valid;
            if (t) {
                const d = new Date(t);
                // Only accept times that are not in the future (plus 5 min buffer for clock drift)
                if (d.getTime() <= (now.getTime() + 300000)) {
                    if (!latestMetarTime || d > latestMetarTime) latestMetarTime = d;
                }
            }
        });

        // Push data to all maps
        Object.values(maps).forEach(m => {
            if (m.getSource('metars')) m.getSource('metars').setData(metarGeoJSON);
        });

        updateHealth('metar');
        addLiveLog(`SURFACE: ${allFeatures.length} stations loaded`, '#00ff88');
        refreshTimestampLabel();
    } catch (e) {
        addLiveLog(`SURFACE ERROR: ${e.message}`, '#ff3333');
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 7: SPC PRODUCTS
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchSPCOutlook(day, show, prefetch) {
    if (!show && !prefetch) {
        updateSidebarToActivePane();
        return;
    }

    addLiveLog(`SPC: Fetching Day ${day} Convective Outlook...`, '#ffb300');
    try {
        const res = await fetch(`https://www.spc.noaa.gov/products/outlook/day${day}otlk_cat.nolyr.geojson`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        Object.values(maps).forEach(m => {
            if (m.getSource(`spc-day${day}`)) m.getSource(`spc-day${day}`).setData(data);
        });
        if (!prefetch) updateSidebarToActivePane();
        updateHealth('spcOutlook');
        addLiveLog(`SPC: Day ${day} Outlook loaded (${data.features?.length || 0} areas)`, '#ffff00');
    } catch (e) {
        addLiveLog(`SPC ERROR: ${e.message}`, '#ff3333');
    }
}

// SPC Day 4-8 severe outlook (15%/30% probability areas, one product per day).
// All five days merge into one source; features tagged D4-D8. A day with no
// areas ships a "Predictability Too Low" placeholder (DN 0, empty geometry).
async function fetchSPCD48(show) {
    if (!show) { updateSidebarToActivePane(); return; }
    addLiveLog('SPC: Fetching Day 4-8 Severe Outlooks...', '#ffb300');
    try {
        const results = await Promise.all([4, 5, 6, 7, 8].map(async d => {
            try {
                const r = await fetch(`https://www.spc.noaa.gov/products/exper/day4-8/day${d}prob.nolyr.geojson`);
                if (!r.ok) return [];
                const j = await r.json();
                return (j.features || [])
                    .filter(f => f.geometry && f.properties && Number(f.properties.DN) > 0)
                    .map(f => { f.properties.dayTag = `D${d}`; f.properties.day = d; return f; });
            } catch (_) { return []; }
        }));
        const feats = results.flat();
        const fc = { type: 'FeatureCollection', features: feats };
        Object.values(maps).forEach(m => { if (m.getSource('spc-d48')) m.getSource('spc-d48').setData(fc); });
        updateHealth('spcOutlook');
        addLiveLog(`SPC: Day 4-8 loaded — ${feats.length ? feats.length + ' probability area(s)' : 'no areas (predictability too low)'}`, '#ffff00');
    } catch (e) {
        addLiveLog(`SPC D4-8 ERROR: ${e.message}`, '#ff3333');
    }
}

const SPC_HAZARD_NAMES = { torn: 'Tornado', wind: 'Wind', hail: 'Hail' };
// Cache of the displayed probabilistic features per `${day}-${hazard}` so the
// on-map legend can be built without reaching into MapLibre source internals.
const spcProbData = {};
async function fetchSPCProb(day, hazard, show, prefetch) {
    if (!show && !prefetch) {
        updateSidebarToActivePane();
        return;
    }
    const hzName = SPC_HAZARD_NAMES[hazard] || hazard;
    addLiveLog(`SPC: Fetching Day ${day} ${hzName} Probability...`, '#ffb300');
    try {
        const res = await fetch(`https://www.spc.noaa.gov/products/outlook/day${day}otlk_${hazard}.nolyr.geojson`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        // The significant-severe area ("CIG"/"SIGN", black stroke) ships inside
        // this same file; the layers split it out by stroke color (see setup).
        spcProbData[`${day}-${hazard}`] = data;
        Object.values(maps).forEach(m => {
            const s = m.getSource(`spc-prob-${day}-${hazard}`);
            if (s) s.setData(data);
        });

        if (!prefetch) updateSidebarToActivePane();
        Object.keys(maps).forEach(updateProbLegend);
        updateHealth('spcOutlook');
        addLiveLog(`SPC: Day ${day} ${hzName} loaded (${data.features?.length || 0} areas)`, '#ffff00');
    } catch (e) {
        addLiveLog(`SPC PROB ERROR: ${e.message}`, '#ff3333');
    }
}

async function fetchERO(day, show, prefetch) {
    if (!show && !prefetch) {
        updateSidebarToActivePane();
        return;
    }

    addLiveLog(`WPC: Fetching Day ${day} Excessive Rainfall Outlook...`, '#39ff5a');
    try {
        const res = await fetch(`/api/wpc-ero?day=${day}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        Object.values(maps).forEach(m => {
            if (m.getSource(`wpc-ero-day${day}`)) m.getSource(`wpc-ero-day${day}`).setData(data);
        });
        if (!prefetch) updateSidebarToActivePane();
        updateHealth('wpcEro');
        addLiveLog(`WPC: ERO Day ${day} loaded (${data.features?.length || 0} risk areas)`, '#39ff5a');
    } catch (e) {
        addLiveLog(`WPC ERO ERROR: ${e.message}`, '#ff3333');
    }
}

// Cache of the displayed fire-weather features per day, so the on-map legend
// can be built without reaching into MapLibre source internals.
const spcFireWxData = {};
async function fetchSPCFireWx(day, show, prefetch) {
    if (!show && !prefetch) {
        updateSidebarToActivePane();
        return;
    }
    addLiveLog(`SPC: Fetching Day ${day} Fire Weather Outlook...`, '#ff7f00');
    try {
        const res = await fetch(`/api/spc-fire-wx?day=${day}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        spcFireWxData[day] = data;
        Object.values(maps).forEach(m => {
            const s = m.getSource(`spc-firewx-day${day}`);
            if (s) s.setData(data);
        });
        if (!prefetch) updateSidebarToActivePane();
        Object.keys(maps).forEach(updateFireWxLegend);
        updateHealth('spcFireWx');
        addLiveLog(`SPC: Fire Wx Day ${day} loaded (${data.features?.length || 0} areas)`, '#ffb300');
    } catch (e) {
        addLiveLog(`SPC FIRE WX ERROR: ${e.message}`, '#ff3333');
    }
}

// Open the WPC Excessive Rainfall Discussion (QPFERD) in the text browser panel.
// A single discussion product covers Days 1-3; the clicked category is noted on top.
async function openEroDiscussion(category) {
    const panel = document.getElementById('text-panel');
    const contentEl = document.getElementById('text-product-content');
    if (panel) panel.style.display = 'flex';
    if (contentEl) contentEl.textContent = 'Loading WPC Excessive Rainfall Discussion...';
    addLiveLog(`WPC: Opening Excessive Rainfall Discussion${category ? ' (' + category + ')' : ''}...`, '#39ff5a');
    try {
        const res = await fetch('/api/wpc-ero-discussion');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        const pre = new DOMParser().parseFromString(html, 'text/html').querySelector('pre');
        const text = pre ? pre.textContent.trim() : '';
        if (!text) throw new Error('discussion text not found');
        const header = category ? `>>> Clicked area: ${category} <<<\n\n` : '';
        if (contentEl) contentEl.textContent = header + text;
        addLiveLog('WPC: Excessive Rainfall Discussion loaded', '#00ff88');
    } catch (e) {
        if (contentEl) contentEl.textContent = `Error loading WPC Excessive Rainfall Discussion: ${e.message}`;
        addLiveLog(`WPC ERO DISC ERROR: ${e.message}`, '#ff3333');
    }
}

// Load an SPC text discussion (the narrative inside the page's <pre>) into the
// in-app text browser — used by the outlook/fire-weather area-click popups so
// the user can read the discussion for the area they clicked, NHC-style. SPC
// HTML pages are CORS-enabled, so no proxy is needed.
async function openSpcDiscussion(url, title, header) {
    const panel = document.getElementById('text-panel');
    const contentEl = document.getElementById('text-product-content');
    if (panel) panel.style.display = 'flex';
    if (contentEl) contentEl.textContent = `Loading ${title}...`;
    addLiveLog(`SPC: Opening ${title}...`, '#ffb300');
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        const pre = new DOMParser().parseFromString(html, 'text/html').querySelector('pre');
        const text = pre ? pre.textContent.trim() : '';
        if (!text) throw new Error('discussion text not found');
        if (contentEl) contentEl.textContent = (header ? header + '\n\n' : '') + text;
        addLiveLog(`SPC: ${title} loaded`, '#00ff88');
    } catch (e) {
        if (contentEl) contentEl.textContent = `Error loading ${title}: ${e.message}`;
        addLiveLog(`SPC DISC ERROR: ${e.message}`, '#ff3333');
    }
}

async function fetchMesoscaleDiscussions(show, prefetch) {
    if (!show && !prefetch) {
        updateSidebarToActivePane();
        return;
    }

    addLiveLog('SPC: Fetching Mesoscale Discussions...', '#ff3333');
    try {
        const url = 'https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/spc_mesoscale_discussion/MapServer/0/query?where=1=1&outFields=*&f=geojson';
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        // Filter out 'NoArea' placeholder features
        const realFeatures = (data.features || []).filter(f => f.properties?.name !== 'NoArea');
        const filteredData = { ...data, features: realFeatures };

        Object.values(maps).forEach(m => {
            if (m.getSource('spc-md')) m.getSource('spc-md').setData(filteredData);
        });
        if (!prefetch) updateSidebarToActivePane();

        updateHealth('spcMd');
        if (realFeatures.length > 0) {
            addLiveLog(`SPC: ${realFeatures.length} Mesoscale Discussion(s) active`, '#ff3333');
        } else {
            addLiveLog('SPC: No active Mesoscale Discussions found', '#888');
        }
    } catch (e) {
        addLiveLog(`SPC MD ERROR: ${e.message}`, '#ff3333');
    }
}

async function fetchMPDs(show, prefetch) {
    if (!show && !prefetch) {
        updateSidebarToActivePane();
        return;
    }

    addLiveLog('WPC: Fetching Mesoscale Precipitation Discussions...', '#33c27a');
    try {
        const res = await fetch('/api/wpc-mpd');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        Object.values(maps).forEach(m => {
            if (m.getSource('wpc-mpd')) m.getSource('wpc-mpd').setData(data);
        });
        if (!prefetch) updateSidebarToActivePane();

        updateHealth('wpcMpd');
        const n = data.features?.length || 0;
        if (n > 0) {
            addLiveLog(`WPC: ${n} Mesoscale Precipitation Discussion(s) active`, '#33c27a');
        } else {
            addLiveLog('WPC: No active Mesoscale Precipitation Discussions', '#888');
        }
    } catch (e) {
        addLiveLog(`WPC MPD ERROR: ${e.message}`, '#ff3333');
    }
}

async function fetchLSRs(show) {
    if (!show) {
        updateSidebarToActivePane();
        return;
    }

    addLiveLog('SPC: Fetching Local Storm Reports...', '#ff9900');
    try {
        // IEM LSR GeoJSON — last 24 hours, all WFOs
        const now = new Date();
        const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const fmt = d => d.toISOString().replace(/[-:T]/g, '').substring(0, 12);
        const url = `https://mesonet.agron.iastate.edu/geojson/lsr.geojson?sts=${fmt(start)}&ets=${fmt(now)}&wfos=`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        // LSR type → map icon ID (matches initLSRIcons image names)
        const iconIdMap = {
            'T': 'lsr-tornado', 'TORNADO': 'lsr-tornado', 'LANDSPOUT': 'lsr-tornado',
            'H': 'lsr-hail', 'HAIL': 'lsr-hail',
            'G': 'lsr-wind', 'TSTM WND GST': 'lsr-wind',
            'D': 'lsr-wind', 'TSTM WND DMG': 'lsr-wind',
            'N': 'lsr-wind', 'NON-TSTM WND GST': 'lsr-wind',
            'O': 'lsr-wind', 'NON-TSTM WND DMG': 'lsr-wind',
            'F': 'lsr-flood', 'FLASH FLOOD': 'lsr-flood',
            'E': 'lsr-flood', 'FLOOD': 'lsr-flood',
            'S': 'lsr-snow', 'SNOW': 'lsr-snow',
            'R': 'lsr-rain', 'RAIN': 'lsr-rain',
            'M': 'lsr-marine', 'MARINE TSTM WIND': 'lsr-marine'
        };
        // Emoji for popup display
        const emojiMap = {
            'lsr-tornado': '🌪️', 'lsr-hail': '🧊', 'lsr-wind': '💨',
            'lsr-flood': '🌊', 'lsr-snow': '❄️', 'lsr-rain': '🌧️',
            'lsr-marine': '⚓', 'lsr-other': '⚡'
        };

        const fc = {
            type: 'FeatureCollection',
            features: (data.features || []).filter(f => f.geometry?.type === 'Point').map(f => {
                const p = f.properties;
                const typeText = p.typetext || 'UNKNOWN';
                const iconId = iconIdMap[typeText] || iconIdMap[p.type] || 'lsr-other';
                // Build magnitude label for display below icon
                const mag = p.magnitude && p.magnitude !== '' && p.magnitude !== 'UNK' && p.magnitude !== 'None' && p.magnitude !== null;
                const magLabel = mag ? `${p.magnitude}${p.unit ? ' ' + p.unit : ''}` : '';
                return {
                    type: 'Feature',
                    geometry: f.geometry,
                    properties: {
                        lsrType: typeText,
                        typeCode: p.type || '',
                        iconId: iconId,
                        icon: emojiMap[iconId] || '⚡',
                        magnitude: p.magnitude || '',
                        magLabel: magLabel,
                        unit: p.unit || '',
                        city: p.city || '',
                        county: p.county || '',
                        state: p.st || p.state || '',
                        remark: p.remark || '',
                        source: p.source || '',
                        wfo: p.wfo || '',
                        valid: p.valid || ''
                    }
                };
            })
        };

        Object.values(maps).forEach(m => {
            if (m.getSource('spc-lsr')) m.getSource('spc-lsr').setData(fc);
        });
        updateSidebarToActivePane();

        // Count by type for log
        const typeCounts = {};
        fc.features.forEach(f => {
            const t = f.properties.lsrType;
            typeCounts[t] = (typeCounts[t] || 0) + 1;
        });
        const summary = Object.entries(typeCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([t, c]) => `${c} ${t}`)
            .join(', ');

        updateHealth('spcLsr');
        addLiveLog(`SPC: ${fc.features.length} Local Storm Reports loaded (${summary})`, '#ff9900');
    } catch (e) {
        addLiveLog(`SPC LSR ERROR: ${e.message}`, '#ff3333');
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 8: HMS SMOKE PLUMES
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchHMSSmoke(show) {
    if (!show) {
        updateSidebarToActivePane();
        return;
    }

    addLiveLog('HMS: Fetching smoke plume analysis...', '#FFD700');
    try {
        const url = 'https://services2.arcgis.com/C8EMgrsFcRFL6LrL/arcgis/rest/services/NOAA_Satellite_Smoke_Detection_(v1)/FeatureServer/0/query?where=1%3D1&outFields=*&f=geojson&resultRecordCount=2000';
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        // Extract analysis time from features
        if (data.features && data.features.length > 0) {
            const firstProps = data.features[0].properties || {};
            const dateField = firstProps.Start || firstProps.Date || firstProps.date;
            if (dateField) {
                latestHmsTime = new Date(dateField);
            } else {
                latestHmsTime = new Date();
            }
        }

        Object.values(maps).forEach(m => {
            if (m.getSource('hms-smoke')) m.getSource('hms-smoke').setData(data);
        });
        updateSidebarToActivePane();
        updateHealth('hms');
        addLiveLog(`HMS: ${data.features?.length || 0} smoke polygons loaded`, '#FFD700');
        refreshTimestampLabel();
    } catch (e) {
        addLiveLog(`HMS ERROR: ${e.message}`, '#ff3333');
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 8b: WPC SURFACE ISOBARS
// ═══════════════════════════════════════════════════════════════════════════════

function smoothLineString(coords, iterations = 3) {
    if (coords.length < 3) return coords;
    let current = coords;
    for (let it = 0; it < iterations; it++) {
        const next = [];
        next.push(current[0]);
        for (let i = 0; i < current.length - 1; i++) {
            const p0 = current[i];
            const p1 = current[i + 1];
            const q = [0.75 * p0[0] + 0.25 * p1[0], 0.75 * p0[1] + 0.25 * p1[1]];
            const r = [0.25 * p0[0] + 0.75 * p1[0], 0.25 * p0[1] + 0.75 * p1[1]];
            next.push(q, r);
        }
        next.push(current[current.length - 1]);
        current = next;
    }
    return current;
}

function parseIsobarsText(text) {
    const features = [];
    const lines = text.split('\n');
    let i = 0;

    while (i < lines.length) {
        const line = lines[i].trim();

        if (line.startsWith('<VG_TYPE>')) {
            const closedMatch = line.match(/<CLOSED>(\d)/);
            const isClosed = closedMatch ? closedMatch[1] === '1' : false;

            i++;
            if (i >= lines.length) break;
            const groupLine = lines[i].trim();
            const pressureMatch = groupLine.match(/<GROUPED TEXT>(\d+)/);
            if (!pressureMatch) { i++; continue; }
            const pressure = parseInt(pressureMatch[1]);

            i++;
            if (i >= lines.length) break;
            const ptsLine = lines[i].trim();
            const numPtsMatch = ptsLine.match(/<NUMPTS>(\d+)/);
            if (!numPtsMatch) { i++; continue; }
            const numPts = parseInt(numPtsMatch[1]);

            const coords = [];
            const firstCoordMatch = ptsLine.match(/>\s+([-\d.]+)\s+([-\d.]+)\s*$/);
            let startJ = 0;
            if (firstCoordMatch) {
                const lat = parseFloat(firstCoordMatch[1]);
                const lon = parseFloat(firstCoordMatch[2]);
                if (!isNaN(lat) && !isNaN(lon)) coords.push([lon, lat]);
                startJ = 1;
            }

            for (let j = startJ; j < numPts && (i + 1 + j - startJ) < lines.length; j++) {
                const coordLine = lines[i + 1 + j - startJ].trim();
                if (coordLine.startsWith('<')) break;
                const parts = coordLine.split(/\s+/);
                if (parts.length >= 2) {
                    const lat = parseFloat(parts[0]);
                    const lon = parseFloat(parts[1]);
                    if (!isNaN(lat) && !isNaN(lon)) coords.push([lon, lat]);
                }
            }
            i += (numPts - startJ) + 1;

            if (coords.length >= 2) {
                if (isClosed && coords.length >= 3) {
                    coords.push([...coords[0]]);
                }
                const smoothedCoords = smoothLineString(coords, 3);
                features.push({
                    type: 'Feature',
                    geometry: { type: 'LineString', coordinates: smoothedCoords },
                    properties: { pressure }
                });
            }
            continue;
        }
        i++;
    }

    return { type: 'FeatureCollection', features };
}

// ─── CWA Labels (WFO identifiers) ───
let cwaLabelsLoaded = false;
async function fetchCWALabels() {
    if (cwaLabelsLoaded) return;
    try {
        const url = 'https://mapservices.weather.noaa.gov/static/rest/services/nws_reference_maps/nws_reference_map/MapServer/1/query' +
            '?where=1%3D1&outFields=cwa,wfo,city,state,lon,lat&f=json&returnGeometry=false&resultRecordCount=200';
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const features = (data.features || []).map(f => {
            const a = f.attributes;
            return {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [a.lon, a.lat] },
                properties: { wfo: a.wfo || a.cwa, city: a.city, state: a.state }
            };
        }).filter(f => f.geometry.coordinates[0] && f.geometry.coordinates[1]);

        const geojson = { type: 'FeatureCollection', features };
        Object.values(maps).forEach(m => {
            if (m.getSource('nws-cwa-labels')) m.getSource('nws-cwa-labels').setData(geojson);
        });
        cwaLabelsLoaded = true;
        addLiveLog(`CWA: Loaded ${features.length} WFO labels`, '#00ddff');
    } catch (err) {
        addLiveLog(`CWA LABELS ERROR: ${err.message}`, '#ff3333');
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 8b-CONTOUR: METAR-BASED CONTOURING ENGINE (IDW + Marching Squares)
// Generates isotherms, isodrosotherms, and 2mb isobars from METAR point obs
// ═══════════════════════════════════════════════════════════════════════════════

// Every surface-analysis contour in one place: the METAR property to contour,
// the interval, and the QC bounds. `qcTol` is how far an ob may sit from its
// neighbours' median before it is treated as a bad sensor rather than real
// weather — set per field, since 12°F between neighbouring sites is a front
// while 12 mb is a broken barometer.
//
// NOTE ON PRESSURE: mslp is used directly and never reconstructed from the
// altimeter setting. They are different quantities — the altimeter setting
// reduces to sea level through the STANDARD atmosphere, MSLP through the
// observed one. Measured against the ~half of stations that report both, they
// differ by 2.9 mb on average and up to 20 mb in the mountain West, i.e. more
// than the 2 mb contour interval. Stations omit MSLP precisely where the
// reduction stops being meaningful (high terrain), so honouring that omission
// is what NWS and WPC do, and it is why the West is analysed from fewer, real
// obs instead of many plausible-looking fabricated ones.
const SFC_CONTOUR_FIELDS = {
    'sfc-isobars-2mb':    { field: 'mslp', interval: 2,  unit: 'mb', label: 'ISOBARS',
                            color: '#d0d0d0', health: 'sfcIsobars2mb',     range: [950, 1070], qcTol: 6 },
    'sfc-isotherms':      { field: 'tmpf', interval: 2,  unit: '°F', label: 'ISOTHERMS',
                            color: '#ff4444', health: 'sfcIsotherms',      range: [-60, 140],  qcTol: 14 },
    'sfc-isodrosotherms': { field: 'dwpf', interval: 2,  unit: '°F', label: 'ISODROSOTHERMS',
                            color: '#44cc44', health: 'sfcIsodrosotherms', range: [-60, 100],  qcTol: 14 },
    'sfc-relh':           { field: 'relh', interval: 10, unit: '%',  label: 'REL HUMIDITY',
                            color: '#00d0ff', health: 'sfcRelh',           range: [1, 100],    qcTol: 30 },
    'sfc-isotachs':       { field: 'sknt', interval: 5,  unit: 'kt', label: 'ISOTACHS',
                            color: '#ffb300', health: 'sfcIsotachs',       range: [0, 150],    qcTol: 20 },
    'sfc-apparent':       { field: 'feel', interval: 4,  unit: '°F', label: 'APPARENT TEMP',
                            color: '#ff7ad1', health: 'sfcApparent',       range: [-80, 150],  qcTol: 16 }
};

// An ob older than this cannot anchor a surface analysis.
const SFC_OB_MAX_AGE_MIN = 90;

/**
 * Reject obs that disagree with their own neighbourhood by more than `tol`.
 * Uses the median of the nearest few stations, so one bad sensor cannot vote
 * itself valid, and a genuine gradient (which moves the neighbours too) passes.
 */
function spatialOutlierFilter(pts, tol) {
    if (!isFinite(tol) || pts.length < 8) return pts;
    const binSize = 2.0, bins = {};
    pts.forEach((p, i) => {
        const key = `${Math.floor(p.lon / binSize)},${Math.floor(p.lat / binSize)}`;
        (bins[key] || (bins[key] = [])).push(i);
    });
    const kept = [];
    for (const p of pts) {
        const cbx = Math.floor(p.lon / binSize), cby = Math.floor(p.lat / binSize);
        const cosLat = Math.cos(p.lat * Math.PI / 180);
        const near = [];
        for (let by = cby - 1; by <= cby + 1; by++) {
            for (let bx = cbx - 1; bx <= cbx + 1; bx++) {
                const bin = bins[`${bx},${by}`];
                if (!bin) continue;
                for (const i of bin) {
                    const q = pts[i];
                    if (q === p) continue;
                    const dx = (q.lon - p.lon) * cosLat, dy = q.lat - p.lat;
                    near.push({ d: dx * dx + dy * dy, v: q.val });
                }
            }
        }
        if (near.length < 4) { kept.push(p); continue; }   // too sparse to judge
        near.sort((a, b) => a.d - b.d);
        const vals = near.slice(0, 8).map(n => n.v).sort((a, b) => a - b);
        const med = vals[Math.floor(vals.length / 2)];
        if (Math.abs(p.val - med) <= tol) kept.push(p);
    }
    return kept;
}

/**
 * Inverse Distance Weighting interpolation from scattered points to a regular grid.
 * Uses a spatial index (binning) for fast neighbour lookup.
 * @param {Array} pts - [{lon, lat, val}] observation points
 * @param {Object} bounds - {west, east, south, north}
 * @param {number} cols - grid columns
 * @param {number} rows - grid rows
 * @param {number} power - IDW exponent (1.5 = smooth blend, 2 = standard, 3 = sharp)
 * @param {number} searchRadius - max degrees to search for neighbours
 * @param {number} minNeighbours - require at least N neighbours or mark NaN
 * @param {number} maxVoid - if the NEAREST ob is farther than this (degrees),
 *        mark NaN. Without it IDW happily invents values hundreds of km out
 *        over the Gulf, the Atlantic and Canada, where there are no ASOS at
 *        all, and the analysis sprouts contours that no observation supports.
 * @returns {Float64Array} grid[row * cols + col]
 */
function idwGrid(pts, bounds, cols, rows, power = 1.5, searchRadius = 8, minNeighbours = 3, maxVoid = Infinity) {
    const grid = new Float64Array(rows * cols);
    const dLon = (bounds.east - bounds.west) / cols;
    const dLat = (bounds.north - bounds.south) / rows;

    // Build spatial bins for faster lookup (~2° bins)
    const binSize = 2.0;
    const bins = {};
    pts.forEach((p, i) => {
        const bx = Math.floor(p.lon / binSize);
        const by = Math.floor(p.lat / binSize);
        const key = `${bx},${by}`;
        if (!bins[key]) bins[key] = [];
        bins[key].push(i);
    });

    const searchBins = Math.ceil(searchRadius / binSize);

    for (let r = 0; r < rows; r++) {
        const lat = bounds.south + (r + 0.5) * dLat;
        for (let c = 0; c < cols; c++) {
            const lon = bounds.west + (c + 0.5) * dLon;
            const cosLat = Math.cos(lat * Math.PI / 180);
            let wSum = 0, vSum = 0, nCount = 0, nearest = Infinity;

            const cbx = Math.floor(lon / binSize);
            const cby = Math.floor(lat / binSize);

            for (let by = cby - searchBins; by <= cby + searchBins; by++) {
                for (let bx = cbx - searchBins; bx <= cbx + searchBins; bx++) {
                    const bin = bins[`${bx},${by}`];
                    if (!bin) continue;
                    for (let k = 0; k < bin.length; k++) {
                        const p = pts[bin[k]];
                        const dx = (p.lon - lon) * cosLat;
                        const dy = p.lat - lat;
                        const d = Math.sqrt(dx * dx + dy * dy);
                        if (d > searchRadius) continue;
                        if (d < nearest) nearest = d;
                        if (d < 0.01) { // Very close — near-exact match
                            wSum += 10000; vSum += 10000 * p.val; nCount++; continue;
                        }
                        const w = 1 / Math.pow(d, power);
                        wSum += w;
                        vSum += w * p.val;
                        nCount++;
                    }
                }
            }
            grid[r * cols + c] = (nCount >= minNeighbours && wSum > 0 && nearest <= maxVoid)
                ? vSum / wSum : NaN;
        }
    }
    return grid;
}

/**
 * Smooth a grid using a simple 3×3 box-average filter.
 * Repeated passes produce increasingly smooth contours.
 */
function smoothGrid(grid, cols, rows, passes = 2) {
    let current = grid;
    for (let p = 0; p < passes; p++) {
        const next = new Float64Array(rows * cols);
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                let sum = 0, cnt = 0;
                for (let dr = -1; dr <= 1; dr++) {
                    for (let dc = -1; dc <= 1; dc++) {
                        const rr = r + dr, cc = c + dc;
                        if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
                        const v = current[rr * cols + cc];
                        if (!isNaN(v)) { sum += v; cnt++; }
                    }
                }
                next[r * cols + c] = cnt >= 3 ? sum / cnt : NaN;
            }
        }
        current = next;
    }
    return current;
}

/**
 * Marching Squares contour tracer.
 * Returns an array of polylines [{coords:[[lon,lat],...], value}] for a given level.
 */
function traceContours(grid, cols, rows, bounds, levels) {
    const dLon = (bounds.east - bounds.west) / cols;
    const dLat = (bounds.north - bounds.south) / rows;
    const features = [];

    function gridVal(r, c) {
        if (r < 0 || r >= rows || c < 0 || c >= cols) return NaN;
        return grid[r * cols + c];
    }
    function lerp(v1, v2, level) {
        const t = (level - v1) / (v2 - v1);
        return Math.max(0, Math.min(1, t));
    }
    function lonAt(c) { return bounds.west + (c + 0.5) * dLon; }
    function latAt(r) { return bounds.south + (r + 0.5) * dLat; }

    for (let li = 0; li < levels.length; li++) {
        const level = levels[li];
        // Segment map: collect all contour segments for this level
        const segments = [];

        for (let r = 0; r < rows - 1; r++) {
            for (let c = 0; c < cols - 1; c++) {
                const bl = gridVal(r, c);
                const br = gridVal(r, c + 1);
                const tr = gridVal(r + 1, c + 1);
                const tl = gridVal(r + 1, c);
                if (isNaN(bl) || isNaN(br) || isNaN(tr) || isNaN(tl)) continue;

                // Marching squares case index (4-bit)
                let idx = 0;
                if (bl >= level) idx |= 1;
                if (br >= level) idx |= 2;
                if (tr >= level) idx |= 4;
                if (tl >= level) idx |= 8;
                if (idx === 0 || idx === 15) continue;

                // Edge midpoints with linear interpolation
                const bottom = [lonAt(c) + lerp(bl, br, level) * dLon, latAt(r)];
                const right  = [lonAt(c + 1), latAt(r) + lerp(br, tr, level) * dLat];
                const top    = [lonAt(c) + lerp(tl, tr, level) * dLon, latAt(r + 1)];
                const left   = [lonAt(c), latAt(r) + lerp(bl, tl, level) * dLat];

                const addSeg = (a, b) => segments.push([a, b]);
                switch (idx) {
                    case 1: case 14: addSeg(bottom, left); break;
                    case 2: case 13: addSeg(bottom, right); break;
                    case 3: case 12: addSeg(left, right); break;
                    case 4: case 11: addSeg(right, top); break;
                    case 5: // Saddle: use average to resolve ambiguity
                        if ((bl + br + tr + tl) / 4 >= level) {
                            addSeg(bottom, right); addSeg(left, top);
                        } else {
                            addSeg(bottom, left); addSeg(right, top);
                        }
                        break;
                    case 6: case 9: addSeg(bottom, top); break;
                    case 7: case 8: addSeg(left, top); break;
                    case 10: // Saddle
                        if ((bl + br + tr + tl) / 4 >= level) {
                            addSeg(left, top); addSeg(bottom, right);
                        } else {
                            addSeg(left, bottom); addSeg(right, top);
                        }
                        break;
                }
            }
        }

        // Chain segments into polylines
        if (segments.length === 0) continue;
        const EPS = 1e-8;
        const used = new Uint8Array(segments.length);
        function near(a, b) { return Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS; }

        for (let s = 0; s < segments.length; s++) {
            if (used[s]) continue;
            used[s] = 1;
            const chain = [segments[s][0], segments[s][1]];
            let changed = true;
            while (changed) {
                changed = false;
                for (let t = 0; t < segments.length; t++) {
                    if (used[t]) continue;
                    const seg = segments[t];
                    if (near(chain[chain.length - 1], seg[0])) {
                        chain.push(seg[1]); used[t] = 1; changed = true;
                    } else if (near(chain[chain.length - 1], seg[1])) {
                        chain.push(seg[0]); used[t] = 1; changed = true;
                    } else if (near(chain[0], seg[1])) {
                        chain.unshift(seg[0]); used[t] = 1; changed = true;
                    } else if (near(chain[0], seg[0])) {
                        chain.unshift(seg[1]); used[t] = 1; changed = true;
                    }
                }
            }
            if (chain.length >= 3) {
                features.push({
                    type: 'Feature',
                    geometry: { type: 'LineString', coordinates: chain },
                    properties: { value: level }
                });
            }
        }
    }
    return { type: 'FeatureCollection', features };
}

/**
 * Generate contour GeoJSON from METAR observations.
 * @param {string} field - 'tmpf' | 'dwpf' | 'mslp'
 * @param {number} interval - contour interval (2 for °F, 2 for mb)
 * @returns {Object} GeoJSON FeatureCollection
 */
function generateMetarContours(field, interval) {
    if (!metarGeoJSON || !metarGeoJSON.features || metarGeoJSON.features.length === 0) {
        return { type: 'FeatureCollection', features: [] };
    }
    const cfg = Object.values(SFC_CONTOUR_FIELDS).find(c => c.field === field)
        || { range: [-Infinity, Infinity], qcTol: Infinity };

    // Collect valid observations
    const now = Date.now();
    const pts = [];
    metarGeoJSON.features.forEach(f => {
        const p = f.properties;
        const val = p?.[field];
        const coords = f.geometry?.coordinates;
        if (val == null || isNaN(val) || !coords) return;

        // IEM "currents" holds the LAST report a station made, which for an
        // offline site can be days stale. An analysis is only as current as
        // its oldest anchor point, so drop anything past the age limit.
        const t = Date.parse(p.utc_valid || '');
        if (isFinite(t) && (now - t) > SFC_OB_MAX_AGE_MIN * 60 * 1000) return;

        if (val < cfg.range[0] || val > cfg.range[1]) return;   // gross range check
        pts.push({ lon: coords[0], lat: coords[1], val });
    });
    if (pts.length < 10) return { type: 'FeatureCollection', features: [] };

    // Spatial QC. A global 3-sigma cut was the old approach, but that measures
    // a station against the WHOLE CONUS spread — so it throws away exactly the
    // extremes an analysis exists to show (the core of a hurricane, an Arctic
    // outbreak) while keeping a sensor stuck 15°F off in a uniform air mass.
    // Compare each ob to the median of its nearest neighbours instead, which
    // is what actually distinguishes "bad" from "interesting".
    const qcPts = spatialOutlierFilter(pts, cfg.qcTol);

    // Grid bounds: CONUS — higher resolution for smoother contours
    const bounds = { west: -130, east: -60, south: 23, north: 50 };
    const cols = 280;  // ~0.25° resolution
    const rows = 108;

    // power 2 over a 6° radius, rather than 1.5 over 8°: the old settings let a
    // station ~900 km away pull a grid point, which smeared frontal gradients
    // into mush. maxVoid stops the field being invented offshore.
    let grid = idwGrid(qcPts, bounds, cols, rows, 2, 6, 3, 2.0);

    // Smooth the grid to remove point-source artifacts (bullseye patterns).
    // Two passes, not four — the tighter IDW above no longer needs heavy
    // post-smoothing to look clean, and four passes flattened real gradients.
    grid = smoothGrid(grid, cols, rows, 2);

    // Determine contour levels from data range, snapped to interval
    let minV = Infinity, maxV = -Infinity;
    for (let i = 0; i < grid.length; i++) {
        if (!isNaN(grid[i])) {
            if (grid[i] < minV) minV = grid[i];
            if (grid[i] > maxV) maxV = grid[i];
        }
    }
    if (!isFinite(minV)) return { type: 'FeatureCollection', features: [] };

    const startLevel = Math.ceil(minV / interval) * interval;
    const endLevel = Math.floor(maxV / interval) * interval;
    const levels = [];
    for (let v = startLevel; v <= endLevel; v += interval) levels.push(v);

    // Trace contours
    const geojson = traceContours(grid, cols, rows, bounds, levels);

    // Smooth contour lines and filter short fragments
    geojson.features = geojson.features
        .filter(f => f.geometry.coordinates.length >= 5)  // Drop tiny fragments
        .map(f => {
            f.geometry.coordinates = smoothLineString(f.geometry.coordinates, 2);
            f.properties.value = Math.round(f.properties.value);
            return f;
        });

    return geojson;
}

/**
 * Render METAR-based contours to the map.
 */
function renderContourProduct(sourceId, field, interval, label) {
    if (!metarsLoaded) {
        addLiveLog(`${label}: Waiting for METAR data...`, '#ffaa00');
        return;
    }
    const unit = (SFC_CONTOUR_FIELDS[sourceId] && SFC_CONTOUR_FIELDS[sourceId].unit) || '';
    addLiveLog(`${label}: Generating contours (every ${interval}${unit})...`, '#d0d0d0');

    const geojson = generateMetarContours(field, interval);

    Object.values(maps).forEach(m => {
        if (m.getSource(sourceId)) m.getSource(sourceId).setData(geojson);
    });

    // Update data health timestamp
    const hk = SFC_CONTOUR_FIELDS[sourceId] && SFC_CONTOUR_FIELDS[sourceId].health;
    if (hk) updateHealth(hk);

    addLiveLog(`${label}: ${geojson.features.length} contour lines generated`, '#00ff88');
}

async function fetchWPCIsobars(show) {
    if (!show) { updateSidebarToActivePane(); return; }

    addLiveLog('WPC: Fetching surface isobars...', '#d0d0d0');
    try {
        const ts = new Date().getTime();
        const res = await fetch(`/api/wpc-isobars?ts=${ts}`, {
            cache: 'no-store',
            headers: {
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();

        const geojson = parseIsobarsText(text);
        if (!geojson.features.length) throw new Error('no isobars decoded — format may have changed');

        Object.values(maps).forEach(m => {
            if (m.getSource('wpc-isobars')) m.getSource('wpc-isobars').setData(geojson);
        });

        // The isobar file carries no valid time in its body, but it comes through
        // our own origin so Last-Modified is readable — that is when WPC actually
        // cut the analysis, which is the number worth ageing against.
        const lm = Date.parse(res.headers.get('last-modified') || '');
        updateHealth('wpcIsobars', isFinite(lm) ? lm : undefined);
        addLiveLog(`WPC: ${geojson.features.length} isobar contours loaded`, '#00ff88');
    } catch (e) {
        addLiveLog(`WPC ISOBARS ERROR: ${e.message}`, '#ff3333');
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 8c: WPC FRONTS & PRESSURE CENTERS
// ═══════════════════════════════════════════════════════════════════════════════

function decodeWPCPosition(code) {
    const s = code.trim();
    if (s.length < 4 || s.length > 5 || !/^\d+$/.test(s)) return null;

    const lat = parseInt(s.substring(0, 2));
    const lonRaw = parseInt(s.substring(2));

    if (isNaN(lat) || isNaN(lonRaw)) return null;
    // The unified surface analysis runs east to the Greenwich meridian, so a
    // 30°W floor silently dropped any Atlantic front beyond it. Today's
    // easternmost coded point sits at 31°W — one degree from being cut.
    if (lat < 10 || lat > 80 || lonRaw < 0 || lonRaw > 180) return null;

    return { lat, lon: -lonRaw };
}

// WPC stamps the bulletin "VALID MMDDHHZ" — month, day, analysis hour. It is
// NOT day/hour/minute: "VALID 073021Z" on a bulletin headed "622 PM EDT THU
// JUL 30 2026" is July 30 at 21Z, i.e. the 21Z analysis cut at 2222Z.
// Only the year has to be inferred, and only across a December/January boundary.
function parseWpcValid(text) {
    const m = text.match(/^\s*VALID\s+(\d{2})(\d{2})(\d{2})Z/m);
    if (!m) return null;
    const mo = +m[1], dd = +m[2], hh = +m[3];
    if (mo < 1 || mo > 12 || dd < 1 || dd > 31 || hh > 23) return null;
    const now = new Date();
    let y = now.getUTCFullYear();
    if (mo - 1 > now.getUTCMonth() + 1) y -= 1;   // December bulletin read in January
    const ms = Date.UTC(y, mo - 1, dd, hh, 0);
    return isFinite(ms) ? ms : null;
}

function parseCodedBulletin(text) {
    const frontFeatures = [];
    const centerFeatures = [];
    const lines = text.split('\n');
    const validMs = parseWpcValid(text);

    let currentSection = null;
    let lastFront = null;
    let carryPressure = null;   // pressure whose position sits on the next line

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (!line || line === '$$' || line.startsWith('VALID')) {
            currentSection = null; lastFront = null; carryPressure = null; continue;
        }

        if (/^HIGHS\b/.test(line)) {
            currentSection = 'HIGHS';
            line = line.replace(/^HIGHS\b\s*/, '').trim();
        } else if (/^LOWS\b/.test(line)) {
            currentSection = 'LOWS';
            line = line.replace(/^LOWS\b\s*/, '').trim();
        } else if (/^(COLD|WARM|STNRY|OCFNT|TROF)\b/.test(line)) {
            currentSection = null; carryPressure = null;
        }

        if (currentSection === 'HIGHS' || currentSection === 'LOWS') {
            if (!line) continue;
            // A pressure and its position routinely straddle a line break
            // ("... 1018 \n 4187 1026 ..."), because WPC hard-wraps at 66
            // columns. Scanning line by line dropped every centre split that
            // way — 3 of 35 on a typical bulletin, silently. Carry an unpaired
            // pressure into the next line instead.
            const tokens = (carryPressure != null ? [String(carryPressure)] : [])
                .concat(line.split(/\s+/));
            carryPressure = null;
            for (let t = 0; t < tokens.length; t++) {
                const pressure = parseInt(tokens[t]);
                if (isNaN(pressure) || pressure < 900 || pressure > 1060) continue;
                if (t === tokens.length - 1) { carryPressure = pressure; break; }
                const coords = decodeWPCPosition(tokens[t + 1]);
                if (coords) {
                    centerFeatures.push({
                        type: 'Feature',
                        geometry: { type: 'Point', coordinates: [coords.lon, coords.lat] },
                        properties: {
                            type: currentSection === 'HIGHS' ? 'H' : 'L',
                            pressure
                        }
                    });
                    t++; // Consume the coordinate token
                }
            }
            continue;
        }

        const frontMatch = line.match(/^(COLD|WARM|STNRY|OCFNT|TROF)\s+(WK|MOD|STG)?\s*([\d\s]+)$/);
        if (frontMatch) {
            currentSection = null;
            const frontType = frontMatch[1];
            const strength = frontMatch[2] || '';
            const posCodes = frontMatch[3].trim().split(/\s+/);

            const coords = [];
            for (const code of posCodes) {
                const decoded = decodeWPCPosition(code);
                if (decoded) coords.push([decoded.lon, decoded.lat]);
            }

            if (coords.length > 0) {
                lastFront = {
                    type: 'Feature',
                    geometry: { type: 'LineString', coordinates: coords },
                    properties: { frontType, strength }
                };
                frontFeatures.push(lastFront);
            } else {
                lastFront = null;
            }
            continue;
        }

        if (/^\d{4,5}(\s+\d{4,5})*$/.test(line) && lastFront) {
            const posCodes = line.split(/\s+/);
            for (const code of posCodes) {
                const decoded = decodeWPCPosition(code);
                if (decoded) lastFront.geometry.coordinates.push([decoded.lon, decoded.lat]);
            }
            continue;
        }

        if (!/^(COLD|WARM|STNRY|OCFNT|TROF|HIGHS|LOWS)\b/.test(line)) {
            lastFront = null;
        }
    }

    const validFronts = frontFeatures
        .filter(f => f.geometry.coordinates.length >= 2)
        .map(f => ({
            ...f,
            geometry: {
                ...f.geometry,
                coordinates: smoothLineString(f.geometry.coordinates, 3)
            }
        }));

    return {
        fronts: { type: 'FeatureCollection', features: validFronts },
        centers: { type: 'FeatureCollection', features: centerFeatures },
        validMs
    };
}

async function fetchWPCFronts(show) {
    if (!show) { updateSidebarToActivePane(); return; }

    addLiveLog('WPC: Fetching surface fronts & pressure centers...', '#4488ff');
    try {
        const ts = new Date().getTime();
        const res = await fetch(`/api/wpc-coded-fronts?ts=${ts}`, {
            cache: 'no-store',
            headers: {
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();

        const { fronts, centers, validMs } = parseCodedBulletin(text);
        if (!fronts.features.length && !centers.features.length) {
            throw new Error('bulletin decoded to nothing — format may have changed');
        }

        Object.values(maps).forEach(m => {
            if (m.getSource('wpc-fronts')) m.getSource('wpc-fronts').setData(fronts);
            if (m.getSource('wpc-pressure-centers')) m.getSource('wpc-pressure-centers').setData(centers);
        });

        // Stamp the ANALYSIS time, not the fetch time. Otherwise a bulletin WPC
        // stopped updating still reads "2 min ago" every time we re-pull it, and
        // a stalled surface analysis is exactly the thing you need to notice.
        updateHealth('wpcFronts', validMs || undefined);
        const vTxt = validMs ? new Date(validMs).toISOString().substring(8, 16).replace('T', ' ') + 'Z' : 'unknown';
        addLiveLog(`WPC: ${fronts.features.length} fronts, ${centers.features.length} H/L centers · valid ${vTxt}`, '#4488ff');
    } catch (e) {
        addLiveLog(`WPC FRONTS ERROR: ${e.message}`, '#ff3333');
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 8d: NHC TROPICAL PRODUCTS
// ═══════════════════════════════════════════════════════════════════════════════

const NHC_BASE = 'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather_summary/MapServer';

// ─── Hurricane Hunter reconnaissance (IEM AFOS feeds, CORS-open) ───
// HDOBs (URNT15/URPA15): 30-sec aircraft obs transmitted in 10-min batches
// while a mission is airborne. TCPOD (REPRPD): CARCAH's daily recon tasking.
// VDM (REPNT2/REPPN2): vortex center fixes. All fetched as raw AFOS text.
const AFOS_RETRIEVE = 'https://mesonet.agron.iastate.edu/cgi-bin/afos/retrieve.py';

async function fetchAfos(pil, limit) {
    const res = await fetch(cacheBust(`${AFOS_RETRIEVE}?pil=${pil}&fmt=text&limit=${limit}`));
    if (!res.ok) throw new Error(`AFOS ${pil}: HTTP ${res.status}`);
    const raw = await res.text();
    if (raw.startsWith('ERROR')) return [];
    // Products are separated by \x01; each starts with a byte-count line
    return raw.split('\x01')
        .map(p => p.replace(/^\s*\d+\s*\n/, '').trim())
        .filter(p => p.length > 20);
}

// Decode one HDOB product → { callsign, mission, storm, dateStr, txMs, obs: [...] }
function parseHdob(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    // WMO line: "URNT15 KWBC 172317" → transmission day/time
    const wmo = lines[0]?.match(/^UR\w{2}\d{2}\s+\w{4}\s+(\d{2})(\d{2})(\d{2})/);
    // Header: "AF303 0891A AL91 HDOB 04 20260718" (or "NOAA9 WXWXA TRAIN HDOB ...")
    // [ \t] only — \s would let the match swallow the WMO line above it
    const hdr = text.match(/^(\S+)[ \t]+(\S+)[ \t]+(\S+(?:[ \t]+\S+)*?)[ \t]+HDOB[ \t]+(\d+)[ \t]+(\d{8})[ \t]*$/m);
    if (!hdr) return null;
    const [, callsign, mission, storm, , dateStr] = hdr;
    const y = +dateStr.slice(0, 4), mo = +dateStr.slice(4, 6) - 1, dy = +dateStr.slice(6, 8);
    const obs = [];
    for (const line of lines) {
        const t = line.split(/\s+/);
        if (t.length < 13) continue;
        const m = t[0].match(/^(\d{2})(\d{2})(\d{2})$/);
        const lat = t[1].match(/^(\d{2})(\d{2})([NS])$/);
        const lon = t[2].match(/^(\d{3})(\d{2})([EW])$/);
        if (!m || !lat || !lon) continue;
        const num = (s, div = 1) => /^[+-]?\d+$/.test(s) ? +s / div : null;
        let psfc = num(t[5], 10);
        if (psfc != null) { if (psfc < 500) psfc += 1000; if (psfc < 850 || psfc > 1060) psfc = null; }
        const wind = t[8].match(/^(\d{3})(\d{3})$/);
        obs.push({
            ms: Date.UTC(y, mo, dy, +m[1], +m[2], +m[3]),
            timeStr: `${m[1]}:${m[2]}:${m[3]}`,
            lat: (+lat[1] + lat[2] / 60) * (lat[3] === 'S' ? -1 : 1),
            lon: (+lon[1] + lon[2] / 60) * (lon[3] === 'W' ? -1 : 1),
            psfc,
            temp: num(t[6], 10),
            dp: num(t[7], 10),
            wdir: wind ? +wind[1] : null,
            wspd: wind ? +wind[2] : null,
            peak: num(t[9]),
            sfmr: num(t[10]),
            rain: num(t[11])
        });
    }
    return { callsign, mission, storm, dateStr, wmo, obs };
}

let reconFlights = [];   // cached parsed flights, re-associated when the storm changes

// The HDOB storm-name field is unreliable (often the placeholder "CYCLONE"), so
// tie a flight to a storm by proximity: nearest active system in the same basin
// whose best-track position sits within ~6° (≈360 nm) of the aircraft's latest ob.
function associateFlight(f) {
    let best = null, bestD = Infinity;
    stormIndex.forEach(s => {
        if (s.lat == null || s.lon == null || s.basin !== f.basin) return;
        const d = Math.hypot(s.lat - f.lat, s.lon - f.lon);
        if (d < bestD) { bestD = d; best = s; }
    });
    return bestD <= 6 ? best : null;
}

// IN AIR is reserved for the *selected* storm (full green). If Hurricane Hunters
// are up in a different system, show a dimmed "IN AIR · <id>" so it's clear
// someone's flying — just not your storm.
function updateReconBadge(activeMs, otherLabel, otherMs) {
    const badge = document.getElementById('recon-badge');
    if (!badge) return;
    const now = Date.now();
    if (activeMs && (now - activeMs) < 90 * 60 * 1000) {
        badge.textContent = 'IN AIR';
        badge.className = 'badge green';
        badge.style.opacity = '';
        badge.title = `Hurricane Hunters flying your selected storm — last ob ${Math.round((now - activeMs) / 60000)} min ago`;
    } else if (otherMs && (now - otherMs) < 90 * 60 * 1000) {
        badge.textContent = otherLabel ? `IN AIR · ${otherLabel}` : 'IN AIR · elsewhere';
        badge.className = 'badge green';
        badge.style.opacity = '0.5';
        badge.title = `Hurricane Hunters airborne in ${otherLabel || 'another system'}, not your selected storm`;
    } else {
        badge.textContent = 'RECON';
        badge.className = 'badge blue';
        badge.style.opacity = '';
        badge.title = 'No Hurricane Hunter aircraft currently airborne';
    }
}

// Rebuild the recon layer + badge for the active storm from the cached flights.
// Called after each fetch and whenever the selected storm changes (no re-fetch).
function renderRecon(show) {
    const now = Date.now(), FRESH = 90 * 60 * 1000;
    const features = [];
    let activeMs = 0, activeCalls = [];
    let otherMs = 0, otherLabel = null, otherCall = null;
    reconFlights.forEach(f => {
        const s = associateFlight(f);
        const fresh = (now - f.lastMs) < FRESH;
        if (s && s.id === activeStorm) {
            if (fresh && f.lastMs > activeMs) activeMs = f.lastMs;
            activeCalls.push(f.callsign);
            features.push({
                type: 'Feature', properties: { layerType: 'track' },
                geometry: { type: 'LineString', coordinates: f.obs.map(o => [o.lon, o.lat]) }
            });
            f.obs.forEach((o, i) => features.push({
                type: 'Feature',
                properties: {
                    layerType: 'ob', latest: i === f.obs.length - 1 ? 1 : 0,
                    callsign: f.callsign, storm: f.storm, timeStr: o.timeStr,
                    windMax: Math.max(o.sfmr || 0, o.wspd || 0),
                    flWind: o.wdir != null ? `${String(o.wdir).padStart(3, '0')}° @ ${o.wspd} kt` : null,
                    peak: o.peak, sfmr: o.sfmr, psfc: o.psfc, temp: o.temp, dp: o.dp, rain: o.rain
                },
                geometry: { type: 'Point', coordinates: [o.lon, o.lat] }
            }));
        } else if (fresh && f.lastMs > otherMs) {
            otherMs = f.lastMs;
            otherLabel = s ? s.shortId : (/^(AL|EP|CP)\d{2}$/.test(f.storm) ? f.storm : null);
            otherCall = f.callsign;
        }
    });
    Object.values(maps).forEach(m => {
        if (m.getSource && m.getSource('recon-hdob'))
            m.getSource('recon-hdob').setData({ type: 'FeatureCollection', features });
    });
    updateReconBadge(activeMs, otherLabel, otherMs);
    updateHealth('reconHdob');
    if (show) {
        const activeShort = activeStorm ? stormShortId(activeStorm) : 'the selected storm';
        if (features.length) {
            addLiveLog(`RECON: ${[...new Set(activeCalls)].join(', ')} flying ${activeShort} — ${features.filter(f => f.properties.layerType === 'ob').length} obs plotted (last ${((now - activeMs) / 60000).toFixed(0)} min ago)`, '#7fff9e');
        } else if (otherMs) {
            addLiveLog(`RECON: no aircraft on ${activeShort}; ${otherCall} is flying ${otherLabel || 'another system'}`, '#ffb300');
        } else {
            addLiveLog('RECON: no Hurricane Hunter obs in the last 24 h. Check the TCPOD for upcoming missions.', '#ffb300');
        }
    }
}

async function fetchReconHdob(show) {
    try {
        // ~24 messages/pil ≈ last 4 flight-hours per basin. Tag each product with
        // its basin (AHONT1 = Atlantic, AHOPN1 = East Pacific) for storm matching.
        const [atl, epac] = await Promise.all([
            fetchAfos('AHONT1', 24).catch(() => []),
            fetchAfos('AHOPN1', 12).catch(() => [])
        ]);
        const cutoff = Date.now() - 24 * 3600 * 1000;
        const byAircraft = {};   // basin|callsign|mission -> merged obs
        [...atl.map(p => ['al', p]), ...epac.map(p => ['ep', p])].forEach(([basin, prod]) => {
            const d = parseHdob(prod);
            if (!d || !d.obs.length) return;
            const key = `${basin}|${d.callsign}|${d.mission}`;
            if (!byAircraft[key]) byAircraft[key] = { ...d, basin, obs: [] };
            byAircraft[key].obs.push(...d.obs.filter(o => o.ms > cutoff));
        });
        reconFlights = [];
        Object.values(byAircraft).forEach(ac => {
            if (!ac.obs.length) return;
            const seen = new Set();
            ac.obs = ac.obs.filter(o => !seen.has(o.ms) && seen.add(o.ms)).sort((a, b) => a.ms - b.ms);
            const last = ac.obs[ac.obs.length - 1];
            ac.lastMs = last.ms; ac.lat = last.lat; ac.lon = last.lon;
            reconFlights.push(ac);
        });
        renderRecon(show);
    } catch (e) {
        if (show) addLiveLog(`RECON ERROR: ${e.message}`, '#ff3333');
    }
}

async function openReconText(kind) {
    const panel = document.getElementById('recon-text-panel');
    const title = document.getElementById('recon-text-title');
    const body = document.getElementById('recon-text-body');
    if (!panel || !body) return;
    panel.style.display = 'block';
    title.textContent = kind === 'tcpod' ? 'RECON SCHEDULE — TROPICAL CYCLONE PLAN OF THE DAY' : 'VORTEX DATA MESSAGE (RECON CENTER FIX)';
    body.textContent = 'Loading…';
    try {
        if (kind === 'tcpod') {
            const prods = await fetchAfos('REPRPD', 1);
            body.textContent = prods[0] || 'No Plan of the Day available.';
        } else {
            const [atl, epac] = await Promise.all([
                fetchAfos('REPNT2', 1).catch(() => []),
                fetchAfos('REPPN2', 1).catch(() => [])
            ]);
            const parts = [];
            if (atl[0]) parts.push('════ ATLANTIC ════\n\n' + atl[0]);
            if (epac[0]) parts.push('════ EAST PACIFIC ════\n\n' + epac[0]);
            body.textContent = parts.join('\n\n') || 'No Vortex Data Messages available.';
        }
    } catch (e) {
        body.textContent = `Error: ${e.message}`;
    }
}

function initRecon() {
    document.getElementById('recon-tcpod')?.addEventListener('click', () => openReconText('tcpod'));
    document.getElementById('recon-vdm')?.addEventListener('click', () => openReconText('vdm'));
    document.getElementById('recon-text-close')?.addEventListener('click', () => {
        const p = document.getElementById('recon-text-panel');
        if (p) p.style.display = 'none';
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            const p = document.getElementById('recon-text-panel');
            if (p) p.style.display = 'none';
        }
    });
    // Startup + periodic badge refresh so "IN AIR" shows even before the layer
    // is toggled on — this is the "are the Hurricane Hunters up?" indicator.
    setTimeout(() => fetchReconHdob(false), 8000);
    setInterval(() => fetchReconHdob(false), 15 * 60 * 1000);
}

// ─── NHC official per-storm advisory text (TCP / TCD / TCM / PWS) ───
// CurrentStorms.json (proxied by /api/adeck?nhc=1) gives each active storm its
// AWIPS bin slot (e.g. AT2) — the rotating 1-5 number that can't be derived
// from the annual storm number (EP06 → bin EP1). The bin maps straight to the
// product PILs (TCP/TCD/TCM/PWS + bin), which IEM AFOS serves CORS-open, the
// same path the recon suite already uses.
const NHC_ADV_PRODUCTS = {
    tcp: ['TCP', 'Public Advisory'],
    tcd: ['TCD', 'Forecast Discussion'],
    tcm: ['TCM', 'Forecast / Advisory'],
    pws: ['PWS', 'Wind Speed Probabilities']
};
let nhcAdvStorms = [];
let nhcAdvSel = null;

function nhcAdvAgeStr(iso) {
    const ms = Date.parse(iso || '');
    if (!isFinite(ms)) return '';
    const mins = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (mins < 60) return `${mins}m ago`;
    const h = Math.floor(mins / 60), m = mins % 60;
    return m ? `${h}h ${m}m ago` : `${h}h ago`;
}

function updateNhcAdvInfo() {
    const info = document.getElementById('nhcadv-info');
    if (!info) return;
    const s = nhcAdvStorms.find(x => x.id === activeStorm);
    if (!s) {
        const si = stormIndex.find(x => x.id === activeStorm);
        info.textContent = si && si.invest ? 'Invest — no official advisories yet' : '';
        return;
    }
    const p = s.products.tcp || Object.values(s.products)[0];
    info.textContent = p
        ? `Latest advisory #${(p.adv || '').replace(/^0+/, '') || '?'} · ${nhcAdvAgeStr(p.issued)}`
        : 'No public products yet';
}

async function fetchNhcAdvList() {
    try {
        const res = await fetch('/api/adeck?nhc=1');
        nhcAdvStorms = (await res.json()).storms || [];
    } catch (e) {
        nhcAdvStorms = [];
    }
    rebuildStormMenus();
    // If the panel is open, refresh it for the (possibly changed) advisory number
    const panel = document.getElementById('nhcadv-panel');
    if (panel && panel.style.display === 'block' && panel.dataset.prod) openNhcAdv(panel.dataset.prod, false);
}

async function openNhcAdv(type, announce = true) {
    const panel = document.getElementById('nhcadv-panel');
    const title = document.getElementById('nhcadv-title');
    const meta = document.getElementById('nhcadv-meta');
    const body = document.getElementById('nhcadv-body');
    if (!panel || !body) return;
    if (announce && !nhcAdvStorms.length) await fetchNhcAdvList();
    const [prefix, label] = NHC_ADV_PRODUCTS[type] || [];
    if (!prefix) return;
    const s = nhcAdvStorms.find(x => x.id === activeStorm);
    if (!s) {
        // Active system has no NHC advisories yet (e.g. an invest) — explain in-panel
        const si = stormIndex.find(x => x.id === activeStorm);
        panel.style.display = 'block';
        panel.dataset.prod = type;
        title.textContent = si ? `${si.shortId} — ${label}` : label;
        meta.textContent = '';
        body.textContent = si
            ? `${si.shortId} is an invest — NHC issues no public advisories for it yet. Model guidance, Storm Trends and SHIPS are available; official advisories begin once it’s designated a depression or storm.`
            : 'No active system selected.';
        return;
    }
    panel.style.display = 'block';
    panel.dataset.prod = type;
    title.textContent = `${s.id.toUpperCase()} ${s.name} — ${label}`;
    const pm = s.products[type];
    meta.textContent = pm
        ? `PIL ${prefix}${s.bin} · Advisory #${(pm.adv || '').replace(/^0+/, '') || '?'} · ${nhcAdvAgeStr(pm.issued)}`
        : `PIL ${prefix}${s.bin}`;
    if (announce) body.textContent = 'Loading…';
    try {
        const prods = await fetchAfos(prefix + s.bin, 1);
        body.textContent = prods[0] || `No ${label} available for ${s.name} yet.`;
        if (announce) addLiveLog(`NHC ${label}: ${s.id.toUpperCase()} ${s.name} loaded`, '#00e5ff');
    } catch (e) {
        body.textContent = `Error: ${e.message}`;
    }
}

function initNhcAdv() {
    const sel = document.getElementById('nhcadv-storm-select');
    if (sel) sel.addEventListener('change', () => setActiveStorm(sel.value));
    Object.keys(NHC_ADV_PRODUCTS).forEach(type =>
        document.getElementById('nhcadv-' + type)?.addEventListener('click', () => openNhcAdv(type, true)));
    document.getElementById('nhcadv-close')?.addEventListener('click', () => {
        const p = document.getElementById('nhcadv-panel');
        if (p) { p.style.display = 'none'; delete p.dataset.openedBy; }
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            const p = document.getElementById('nhcadv-panel');
            if (p) p.style.display = 'none';
        }
    });
    setTimeout(fetchNhcAdvList, 9500);
    setInterval(fetchNhcAdvList, 15 * 60 * 1000);
}

// ─── Model track guidance spaghetti (ATCF a-decks via /api/adeck) ───
// Same data behind the UCAR/RAL "hurricanes.ral.ucar.edu" spaghetti plots,
// drawn natively on the map. Early cycle = interpolated guidance available at
// advisory time; Late cycle = the raw synoptic-time model runs; EPS = GEFS
// ensemble members. Each model plots from its own most recent cycle.
const ADECK_MODELS = {
    // tech: [display name, color, line width, sets, fallbackFor?]
    // Sets: "E"/"L" = early/late TRACK spaghetti; "e"/"l" = early/late INTENSITY chart
    // fallbackFor: this tech is ATCF's "previous run" interpolation (the ?2
    // codes, shifted from the 12-hour-old run). It only plots when the 6-hour
    // interp it names is missing, so a stale aid fills a gap instead of laying
    // a second same-colored line over the fresh one.
    OFCL: ['NHC Official Forecast', '#ffffff', 3.5, 'ELel'],
    TVCN: ['Track Consensus', '#00e5ff', 3, 'E'],
    HCCA: ['HCCA Corrected Consensus', '#76ff03', 2.5, 'Ee'],
    IVCN: ['Intensity Consensus', '#00e5ff', 3, 'e'],
    DSHP: ['Decay-SHIPS', '#ff8a65', 2, 'e'],
    LGEM: ['LGEM', '#00e676', 2, 'e'],
    SHIP: ['SHIPS (no decay)', '#ffab91', 2, 'e'],
    AVNI: ['GFS (interp)', '#ff4d4d', 2, 'Ee'],
    AVNO: ['GFS', '#ff4d4d', 2, 'Ll'],
    EMXI: ['ECMWF (interp)', '#ffa500', 2, 'E'],
    EMX:  ['ECMWF', '#ffa500', 2, 'L'],
    UKXI: ['UKMET (interp)', '#40c4ff', 2, 'E'],
    EGRI: ['UKMET (interp)', '#40c4ff', 2, 'E'],
    UKX:  ['UKMET', '#40c4ff', 2, 'L'],
    EGRR: ['UKMET', '#40c4ff', 2, 'L'],
    CMCI: ['Canadian GDPS (interp)', '#ab47bc', 2, 'E'],
    CMC:  ['Canadian GDPS', '#ab47bc', 2, 'L'],
    HFAI: ['HAFS-A (interp)', '#66bb6a', 2, 'Ee'],
    HFSA: ['HAFS-A', '#66bb6a', 2, 'Ll'],
    HFBI: ['HAFS-B (interp)', '#26a69a', 2, 'Ee'],
    HFSB: ['HAFS-B', '#26a69a', 2, 'Ll'],
    HWFI: ['HWRF (interp)', '#9ccc65', 2, 'Ee'],
    HWRF: ['HWRF', '#9ccc65', 2, 'Ll'],
    HMNI: ['HMON (interp)', '#8c9eff', 2, 'Ee'],
    HMON: ['HMON', '#8c9eff', 2, 'Ll'],
    CTCI: ['COAMPS-TC (interp)', '#d4e157', 2, 'Ee'],
    CTCX: ['COAMPS-TC', '#d4e157', 2, 'Ll'],
    // ── AI / machine-learning guidance ──
    // GraphCast ensemble mean is live in the a-decks now; the others are wired
    // and will plot automatically once NHC begins distributing them.
    GDMI: ['GraphCast Ens (Google DeepMind, interp)', '#f06292', 2, 'Ee'],
    GDMN: ['GraphCast Ens (Google DeepMind)', '#f06292', 2, 'Ll'],
    GRPI: ['GraphCast det (interp)', '#ec407a', 2, 'Ee'],
    GRPH: ['GraphCast det', '#ec407a', 2, 'Ll'],
    GENI: ['GenCast (Google, interp)', '#e040fb', 2, 'Ee'],
    GENC: ['GenCast (Google)', '#e040fb', 2, 'Ll'],
    EAII: ['AIFS (ECMWF AI, interp)', '#7c4dff', 2, 'Ee'],
    EAIO: ['AIFS (ECMWF AI)', '#7c4dff', 2, 'Ll'],
    GAII: ['AI-GFS (interp)', '#ff80ab', 2, 'Ee'],
    GAIO: ['AI-GFS', '#ff80ab', 2, 'Ll'],
    EGMI: ['AI-GEFS Ens Mean (interp)', '#b388ff', 2, 'E'],
    EGMN: ['AI-GEFS Ens Mean', '#b388ff', 2, 'L'],
    NNIC: ['Neural-Net Intensity Consensus', '#ea80fc', 2.4, 'e'],
    NNIB: ['Neural-Net Intensity Baseline', '#b39ddb', 1.4, 'e'],
    NVGI: ['NAVGEM (interp)', '#8d6e63', 2, 'E'],
    NVGM: ['NAVGEM', '#8d6e63', 2, 'L'],
    AEMI: ['GFS Ensemble Mean (interp)', '#ffee58', 2.2, 'E'],
    AEMN: ['GFS Ensemble Mean', '#ffee58', 2.2, 'L'],
    CEMI: ['Canadian Ens Mean (interp)', '#ce93d8', 1.6, 'E'],
    CEMN: ['Canadian Ensemble Mean', '#ce93d8', 1.6, 'L'],
    TABD: ['Beta-Advection Deep', '#90a4ae', 1.2, 'E'],
    TABM: ['Beta-Advection Medium', '#78909c', 1.2, 'E'],
    TABS: ['Beta-Advection Shallow', '#607d8b', 1.2, 'E'],
    CLP5: ['CLIPER5 Baseline', '#757575', 1.2, 'E'],
    XTRP: ['Extrapolation', '#616161', 1.2, 'E'],
    // ── Previous-run interpolations (early-cycle gap fillers) ──
    UKX2: ['UKMET (interp, prev run)', '#40c4ff', 2, 'E', 'UKXI'],
    CMC2: ['Canadian GDPS (interp, prev run)', '#ab47bc', 2, 'E', 'CMCI'],
    NVG2: ['NAVGEM (interp, prev run)', '#8d6e63', 2, 'E', 'NVGI'],
    CEM2: ['Canadian Ens Mean (interp, prev run)', '#ce93d8', 1.6, 'E', 'CEMI'],
    HFA2: ['HAFS-A (interp, prev run)', '#66bb6a', 2, 'Ee', 'HFAI'],
    HFB2: ['HAFS-B (interp, prev run)', '#26a69a', 2, 'Ee', 'HFBI'],
    HWF2: ['HWRF (interp, prev run)', '#9ccc65', 2, 'Ee', 'HWFI'],
    HMN2: ['HMON (interp, prev run)', '#8c9eff', 2, 'Ee', 'HMNI'],
    CTC2: ['COAMPS-TC (interp, prev run)', '#d4e157', 2, 'Ee', 'CTCI'],
    GDM2: ['GraphCast Ens (Google DeepMind, interp prev run)', '#f06292', 2, 'Ee', 'GDMI']
};

// AI / machine-learning model techs — marked distinctly so forecasters can tell
// data-driven guidance from physics models at a glance.
const AI_MODELS = new Set(['GDMI', 'GDMN', 'GDM2', 'GRPI', 'GRPH', 'GENI', 'GENC', 'EAII', 'EAIO', 'GAII', 'GAIO', 'EGMI', 'EGMN', 'NNIC', 'NNIB']);
const isAiModel = tech => AI_MODELS.has(tech);

let adeckMode = null;    // 'early' | 'late' | 'eps' (global, like other overlays)
// One active tropical system, shared app-wide. adeckStorm / nhcAdvSel mirror it
// so existing tools keep working; setActiveStorm() is the single writer.
let activeStorm = null;  // canonical selection, e.g. 'al022026'
let adeckStorm = null;   // mirror of activeStorm (model guidance / trends / SHIPS)
let adeckListRaw = [];   // last ?list=1 result (post graduated-invest filter)
let stormIndex = [];     // merged systems: [{id,shortId,label,basin,num,invest,name,class,bin,products,lat,lon}]

function parseAdeckText(text) {
    const rows = [];
    text.split('\n').forEach(ln => {
        const p = ln.split(',').map(s => s.trim());
        if (p.length < 9) return;
        const dtg = p[2], tech = p[4], tau = +p[5];
        const lat = p[6].match(/^(\d+)([NS])$/);
        const lon = p[7].match(/^(\d+)([EW])$/);
        if (dtg.length !== 10 || !tech || !lat || !lon || isNaN(tau)) return;
        const la = (+lat[1] / 10) * (lat[2] === 'S' ? -1 : 1);
        const lo = (+lon[1] / 10) * (lon[2] === 'W' ? -1 : 1);
        if (la === 0 && lo === 0) return;
        rows.push({ dtg, tech, tau, lat: la, lon: lo, vmax: +p[8] || null, mslp: +p[9] || null });
    });
    return rows;
}

function adeckTechMeta(tech, mode) {
    if (mode === 'eps') {
        const ap = tech.match(/^AP(\d{2})$/);
        if (ap) return { name: `GEFS Member ${+ap[1]}`, color: '#4fc3f7', width: 1, opacity: 0.55, label: false };
        if (tech === 'AC00') return { name: 'GEFS Control', color: '#ffffff', width: 1.5, opacity: 0.85, label: true };
        if (tech === 'AEMN' || tech === 'AEMI') return { name: 'GFS Ensemble Mean', color: '#ffee58', width: 2.5, opacity: 1, label: true };
        if (tech === 'OFCL') return { name: 'NHC Official Forecast', color: '#ff3b3b', width: 3, opacity: 1, label: true };
        return null;
    }
    const m = ADECK_MODELS[tech];
    if (!m) return null;
    // Track set flag: early modes need 'E', late modes need 'L'
    const wantEarly = (mode === 'early' || mode === 'ai-early');
    if (!m[3].includes(wantEarly ? 'E' : 'L')) return null;
    // AI sub-tabs show only AI models; the physics tabs exclude them
    const ai = isAiModel(tech);
    if ((mode === 'ai-early' || mode === 'ai-late') !== ai) return null;
    return { name: m[0], color: m[1], width: m[2], opacity: 0.9, label: true, fallbackFor: m[4] || null };
}

// Per tech, the newest cycle that actually holds a DRAWABLE track. Taking the
// newest cycle unconditionally loses any model whose freshest run is a single
// tau-0 stub — routine once a tracker starts losing a weak system, and the
// reason the AI tabs came up empty on AL04 while GraphCast still had a track a
// cycle back. Previous-run interps (the ?2 codes) are then dropped wherever
// their 6-hour counterpart survived, so they fill gaps instead of laying a
// second same-colored line over the fresh one.
function pickAdeckCycles(rows, keep, minPts) {
    const byTech = {};
    rows.forEach(r => {
        if (r.tau < 0 || !keep(r)) return;
        if (!byTech[r.tech]) byTech[r.tech] = {};
        if (!byTech[r.tech][r.dtg]) byTech[r.tech][r.dtg] = new Set();
        byTech[r.tech][r.dtg].add(r.tau);
    });
    const out = {};
    Object.keys(byTech).forEach(tech => {
        const dtg = Object.keys(byTech[tech]).sort().reverse()
            .find(d => byTech[tech][d].size >= minPts);
        if (dtg) out[tech] = dtg;
    });
    Object.keys(out).forEach(tech => {
        const primary = (ADECK_MODELS[tech] || [])[4];
        if (primary && out[primary]) delete out[tech];
    });
    return out;
}

// Say WHY a view came up empty. "No tracks available" is true but useless: the
// two causes look identical on the map and mean different things — the aid
// isn't in NHC's public deck at all, or it is but its runs carry no track.
function adeckEmptyReason(rows, mode) {
    if (mode === 'eps') return 'No GEFS ensemble members in this deck yet';
    const roster = Object.keys(ADECK_MODELS).filter(t => adeckTechMeta(t, mode));
    if (!roster.length) return 'No aids defined for this view';
    const taus = {};
    rows.forEach(r => {
        if (r.tau < 0 || roster.indexOf(r.tech) < 0) return;
        const k = `${r.tech}|${r.dtg}`;
        if (!taus[k]) taus[k] = new Set();
        taus[k].add(r.tau);
    });
    const seen = [...new Set(Object.keys(taus).map(k => k.split('|')[0]))].sort();
    return seen.length
        ? `${seen.join(', ')} in the deck but carrying no track — single-point runs only`
        : `none of the ${roster.length} aids in this view are in NHC's public a-deck for this system`;
}

function buildAdeckFeatures(rows, mode) {
    // Each tech plots from its own newest cycle that holds a track — "latest
    // guidance" even when late-cycle models lag the current advisory cycle.
    const latest = pickAdeckCycles(rows, r => !!adeckTechMeta(r.tech, mode), 2);
    // Newest cycle anywhere in the DECK — not just among the plotted aids, or a
    // view holding one stale track (the AI tabs, most of the season) would call
    // it current. Anything behind it gets its lag stamped on the map label, so
    // a track the fallback pulled from an older run reads as what it is.
    const newestCycle = rows.reduce((a, r) => (r.tau >= 0 && r.dtg > a ? r.dtg : a), '');
    const features = [];
    const models = [];
    Object.keys(latest).sort().forEach(tech => {
        const meta = adeckTechMeta(tech, mode);
        const seen = new Set();
        // Wind-radii rows repeat a tau with the same position — keep the first
        const pts = rows
            .filter(r => r.tech === tech && r.dtg === latest[tech] && r.tau >= 0)
            .filter(r => !seen.has(r.tau) && seen.add(r.tau))
            .sort((a, b) => a.tau - b.tau);
        if (pts.length < 2) return;
        models.push(tech);
        const coords = pts.map(p => [p.lon, p.lat]);
        features.push({
            type: 'Feature',
            properties: { layerType: 'line', tech, color: meta.color, width: meta.width, opacity: meta.opacity },
            geometry: { type: 'LineString', coordinates: coords }
        });
        const dtg = latest[tech];
        const initMs = Date.UTC(+dtg.slice(0, 4), +dtg.slice(4, 6) - 1, +dtg.slice(6, 8), +dtg.slice(8, 10));
        pts.forEach(p => {
            const v = new Date(initMs + p.tau * 3600 * 1000);
            features.push({
                type: 'Feature',
                properties: {
                    layerType: 'pt', tech, name: meta.name, color: meta.color,
                    tau: p.tau, cycle: dtg, major: p.tau % 24 === 0 ? 1 : 0,
                    valid: `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][v.getUTCDay()]} ${String(v.getUTCDate()).padStart(2, '0')}/${String(v.getUTCHours()).padStart(2, '0')}Z`,
                    vmax: p.vmax, mslp: p.mslp && p.mslp > 800 ? p.mslp : null
                },
                geometry: { type: 'Point', coordinates: [p.lon, p.lat] }
            });
        });
        if (meta.label) {
            const lagH = newestCycle ? Math.round((adeckDtgMs(newestCycle) - adeckDtgMs(dtg)) / 3600000) : 0;
            features.push({
                type: 'Feature',
                properties: {
                    layerType: 'end', tech, color: meta.color,
                    // Only past one cycle: late-cycle aids sit 6 h behind the
                    // interps by definition, and stamping every one of them is
                    // noise. 12 h+ is where a track is materially misplaced.
                    lbl: tech + (isAiModel(tech) ? ' ✦' : '') + (lagH > 6 ? ` -${lagH}h` : '')
                },
                geometry: { type: 'Point', coordinates: coords[coords.length - 1] }
            });
        }
    });
    return { features, models, cycles: latest };
}

const adeckDtgMs = dtg =>
    Date.UTC(+dtg.slice(0, 4), +dtg.slice(4, 6) - 1, +dtg.slice(6, 8), +dtg.slice(8, 10));

const adeckAgeStr = ms => {
    const h = (Date.now() - ms) / 3600000;
    return h < 1 ? `${Math.round(h * 60)} min ago` : `${h.toFixed(1)} h ago`;
};

// ─── Intensity guidance chart (vmax time series from the same a-deck) ───
function buildIntensitySeries(rows, mode) {
    const flag = mode === 'early' ? 'e' : 'l';
    const wanted = t => { const m = ADECK_MODELS[t]; return m && m[3].includes(flag); };
    const latest = pickAdeckCycles(rows, r => !!r.vmax && wanted(r.tech), 2);
    const series = [];
    Object.keys(latest).sort().forEach(tech => {
        const m = ADECK_MODELS[tech];
        const seen = new Set();
        const pts = rows
            .filter(r => r.tech === tech && r.dtg === latest[tech] && r.tau >= 0 && r.vmax)
            .filter(r => !seen.has(r.tau) && seen.add(r.tau))
            .sort((a, b) => a.tau - b.tau)
            .map(r => ({ tau: r.tau, v: r.vmax }));
        if (pts.length >= 2) series.push({ tech, name: m[0], color: m[1], wide: m[2] >= 3, pts, dtg: latest[tech] });
    });
    return series;
}

const SS_THRESHOLDS = [[34, 'TS'], [64, 'C1'], [83, 'C2'], [96, 'C3'], [113, 'C4'], [137, 'C5']];

function drawIntensityChart(canvas, series) {
    const cssW = 660, cssH = 400;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = cssW * dpr; canvas.height = cssH * dpr;
    canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    if (!series.length) {
        ctx.fillStyle = '#8b97a3'; ctx.font = '12px "Roboto Mono",monospace';
        ctx.textAlign = 'center';
        ctx.fillText('No intensity guidance available for this system yet.', cssW / 2, cssH / 2);
        return;
    }
    const mL = 42, mR = 150, mT = 12, mB = 30;
    const pw = cssW - mL - mR, ph = cssH - mT - mB;
    const maxTau = Math.max(72, ...series.map(s => s.pts[s.pts.length - 1].tau));
    const xMax = Math.ceil(maxTau / 24) * 24;
    const vTop = Math.max(...series.map(s => Math.max(...s.pts.map(p => p.v))));
    const yMax = Math.max(60, Math.ceil((vTop + 15) / 20) * 20);
    const X = tau => mL + (tau / xMax) * pw;
    const Y = v => mT + ph - (v / yMax) * ph;
    ctx.font = '9px "Roboto Mono",monospace';
    // grid: x every 24 h, y every 20 kt
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let t = 0; t <= xMax; t += 24) {
        ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(X(t), mT); ctx.lineTo(X(t), mT + ph); ctx.stroke();
        ctx.fillStyle = '#8b97a3'; ctx.fillText(`F${t}`, X(t), mT + ph + 6);
    }
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let v = 0; v <= yMax; v += 20) {
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.beginPath(); ctx.moveTo(mL, Y(v)); ctx.lineTo(mL + pw, Y(v)); ctx.stroke();
        ctx.fillStyle = '#8b97a3'; ctx.fillText(`${v}`, mL - 6, Y(v));
    }
    ctx.save(); ctx.translate(12, mT + ph / 2); ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center'; ctx.fillStyle = '#8b97a3'; ctx.fillText('MAX WIND (KT)', 0, 0);
    ctx.restore();
    // Saffir-Simpson thresholds
    SS_THRESHOLDS.forEach(([v, lab]) => {
        if (v > yMax) return;
        ctx.strokeStyle = 'rgba(255,209,102,0.35)'; ctx.setLineDash([5, 4]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(mL, Y(v)); ctx.lineTo(mL + pw, Y(v)); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(255,209,102,0.8)'; ctx.textAlign = 'left';
        ctx.fillText(lab, mL + pw + 4, Y(v));
    });
    // model lines (OFCL/consensus drawn last, on top)
    [...series].sort((a, b) => (a.wide ? 1 : 0) - (b.wide ? 1 : 0)).forEach(s => {
        ctx.strokeStyle = s.color; ctx.lineWidth = s.wide ? 2.6 : 1.5;
        ctx.beginPath();
        s.pts.forEach((p, i) => { i ? ctx.lineTo(X(p.tau), Y(p.v)) : ctx.moveTo(X(p.tau), Y(p.v)); });
        ctx.stroke();
        ctx.fillStyle = s.color;
        s.pts.forEach(p => { ctx.beginPath(); ctx.arc(X(p.tau), Y(p.v), s.wide ? 2.6 : 1.8, 0, Math.PI * 2); ctx.fill(); });
    });
    // legend (right column), ordered by end-point intensity so it reads like the chart
    const legX = mL + pw + 34;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    [...series].sort((a, b) => b.pts[b.pts.length - 1].v - a.pts[a.pts.length - 1].v).forEach((s, i) => {
        const ly = mT + 8 + i * 15;
        ctx.strokeStyle = s.color; ctx.lineWidth = s.wide ? 2.6 : 1.5;
        ctx.beginPath(); ctx.moveTo(legX, ly); ctx.lineTo(legX + 16, ly); ctx.stroke();
        ctx.fillStyle = s.color; ctx.font = `${s.wide ? 'bold ' : ''}9px "Roboto Mono",monospace`;
        ctx.fillText(s.tech + (isAiModel(s.tech) ? ' ✦' : ''), legX + 21, ly);   // ✦ = AI/ML
        ctx.fillStyle = '#8b97a3'; ctx.font = '8px "Roboto Mono",monospace';
        ctx.fillText(`${s.pts[s.pts.length - 1].v} kt`, legX + 62, ly);
    });
}

async function openIntensityChart(mode) {
    const panel = document.getElementById('intensity-panel');
    const title = document.getElementById('intensity-title');
    const note = document.getElementById('intensity-note');
    if (!panel || !title || !note) return;
    await fetchAdeckList();
    if (!adeckStorm) { addLiveLog('INTENSITY: no active systems with model guidance right now', '#ffb300'); return; }
    panel.style.display = 'block';
    const sid = adeckStorm.toUpperCase().slice(0, 4);
    title.textContent = `${sid} — ${mode === 'early' ? 'EARLY CYCLE' : 'LATE CYCLE (EXPERIMENTAL)'} INTENSITY GUIDANCE`;
    note.textContent = 'Loading…';
    try {
        const res = await fetch(`/api/adeck?id=${adeckStorm}`);
        if (!res.ok) throw new Error(`a-deck HTTP ${res.status}`);
        const rows = parseAdeckText(await res.text());
        const series = buildIntensitySeries(rows, mode);
        drawIntensityChart(document.getElementById('intensity-canvas'), series);
        const newest = series.length ? series.map(s => s.dtg).sort().pop() : null;
        const laggards = newest ? series.filter(s => s.dtg !== newest).length : 0;
        const anyAi = series.some(s => isAiModel(s.tech));
        note.textContent = newest
            ? `Newest run ${newest.slice(8, 10)}Z ${newest.slice(6, 8)} (${adeckAgeStr(adeckDtgMs(newest))}) · ${series.length} aids${laggards ? ` · ${laggards} from older runs` : ''} · dashed lines mark TS / Cat 1–5 thresholds${anyAi ? ' · ✦ = AI/ML model' : ''}`
            : 'No intensity guidance available for this system yet.';
        if (newest) updateHealth('adeck', adeckDtgMs(newest));
        if (series.length) addLiveLog(`INTENSITY: ${sid} ${mode}-cycle — ${series.length} aids, newest run ${newest.slice(8, 10)}Z (${adeckAgeStr(adeckDtgMs(newest))}) — ${series.map(s => s.tech).join(', ')}`, '#00e5ff');
    } catch (e) {
        note.textContent = `Error: ${e.message}`;
    }
}

async function fetchAdeck(show) {
    if (!adeckStorm || !adeckMode) return;
    try {
        const res = await fetch(`/api/adeck?id=${adeckStorm}`);
        if (!res.ok) throw new Error(`a-deck HTTP ${res.status}`);
        const rows = parseAdeckText(await res.text());
        const { features, models, cycles } = buildAdeckFeatures(rows, adeckMode);
        const data = { type: 'FeatureCollection', features };
        Object.values(maps).forEach(m => {
            if (m.getSource && m.getSource('adeck')) m.getSource('adeck').setData(data);
        });
        // Freshness: newest cycle among the plotted aids drives the health row
        // (stamped with the RUN time, not the fetch time) and the sidebar readout
        const newestDtg = models.length ? models.map(t => cycles[t]).sort().pop() : null;
        const laggards = models.filter(t => cycles[t] !== newestDtg).length;
        if (newestDtg) updateHealth('adeck', adeckDtgMs(newestDtg));
        const info = document.getElementById('adeck-cycle-info');
        if (info) {
            if (newestDtg) {
                info.innerHTML = `Newest run: <b style="color:#00e5ff;">${newestDtg.slice(8, 10)}Z ${newestDtg.slice(6, 8)} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+newestDtg.slice(4, 6) - 1]}</b> (${adeckAgeStr(adeckDtgMs(newestDtg))}) · ${models.length} aids${laggards ? ` · ${laggards} from older runs` : ''}`;
                info.title = models.map(t => `${t}: ${cycles[t].slice(8, 10)}Z ${cycles[t].slice(6, 8)}`).join('\n');
            } else {
                info.textContent = adeckMode ? `No tracks for this view — ${adeckEmptyReason(rows, adeckMode)}` : '';
                info.title = '';
            }
        }
        if (show) {
            const modeLabel = { early: 'early-cycle', late: 'late-cycle', eps: 'GEFS ensemble', 'ai-early': 'early-cycle AI', 'ai-late': 'late-cycle AI' }[adeckMode];
            addLiveLog(models.length
                ? `GUIDANCE: ${adeckStorm.toUpperCase().slice(0, 4)} ${modeLabel} — ${models.length} tracks, newest run ${newestDtg.slice(8, 10)}Z (${adeckAgeStr(adeckDtgMs(newestDtg))})${laggards ? `, ${laggards} aid(s) still on older runs` : ''} — ${models.join(', ')}`
                : `GUIDANCE: no ${modeLabel} tracks for ${adeckStorm.toUpperCase().slice(0, 4)} — ${adeckEmptyReason(rows, adeckMode)}`,
                models.length ? '#00e5ff' : '#ffb300');
        }
    } catch (e) {
        if (show) addLiveLog(`GUIDANCE ERROR: ${e.message}`, '#ff3333');
    }
}

const stormShortId = id => id.slice(0, 2).toUpperCase() + id.slice(2, 4);   // al022026 → AL02

// Merge the two storm feeds into one index: a-deck ?list=1 (guidance systems,
// invests included, with best-track positions) + CurrentStorms.json ?nhc=1
// (numbered storms with advisory bins/products). Both dropdowns render this
// union so "the active storm" is a single shared choice across the app.
function rebuildStormIndex() {
    const byId = {};
    adeckListRaw.forEach(s => {
        byId[s.id] = {
            id: s.id, shortId: stormShortId(s.id), basin: s.basin.toLowerCase(),
            num: s.num, invest: s.invest,
            lat: s.lat != null ? s.lat : null, lon: s.lon != null ? s.lon : null,
            name: null, class: null, bin: null, products: null
        };
    });
    nhcAdvStorms.forEach(s => {
        const e = byId[s.id] || {
            id: s.id, shortId: stormShortId(s.id), basin: s.id.slice(0, 2),
            num: +s.id.slice(2, 4), invest: +s.id.slice(2, 4) >= 90, lat: null, lon: null
        };
        e.name = s.name; e.class = s.class; e.bin = s.bin; e.products = s.products;
        if (s.lat != null) e.lat = s.lat;     // CurrentStorms position is the advisory fix — prefer it
        if (s.lon != null) e.lon = s.lon;
        byId[s.id] = e;
    });
    stormIndex = Object.values(byId).sort((a, b) =>
        a.basin === b.basin ? a.num - b.num : (a.basin < b.basin ? -1 : 1));
    stormIndex.forEach(e => {
        e.label = e.name ? `${e.shortId} · ${e.name}${e.class ? ` (${e.class})` : ''}`
                         : `${e.shortId} · Invest`;
    });
}

// Repaint both storm dropdowns from the merged index, keeping the active
// selection (or defaulting to the first system). Also refreshes the recon
// association and the advisory freshness line.
function rebuildStormMenus() {
    rebuildStormIndex();
    const selA = document.getElementById('adeck-storm-select');
    const selB = document.getElementById('nhcadv-storm-select');
    if (!stormIndex.length) {
        activeStorm = null;
        if (selA) selA.innerHTML = '<option value="">-- No Active Systems --</option>';
        if (selB) selB.innerHTML = '<option value="">No active systems</option>';
    } else {
        if (!stormIndex.some(e => e.id === activeStorm)) activeStorm = stormIndex[0].id;
        const opts = stormIndex.map(e => `<option value="${e.id}">${e.label}</option>`).join('');
        [selA, selB].forEach(sel => { if (sel) { sel.innerHTML = opts; sel.value = activeStorm; } });
    }
    adeckStorm = activeStorm;
    nhcAdvSel = activeStorm;
    updateNhcAdvInfo();
    renderRecon(false);
}

// The single writer for the shared selection. Mirrors it into the legacy
// globals, syncs both dropdowns, and refreshes every open storm-scoped view.
function setActiveStorm(id) {
    activeStorm = id || null;
    adeckStorm = activeStorm;
    nhcAdvSel = activeStorm;
    const selA = document.getElementById('adeck-storm-select');
    const selB = document.getElementById('nhcadv-storm-select');
    if (selA && selA.value !== (activeStorm || '')) selA.value = activeStorm || '';
    if (selB && selB.value !== (activeStorm || '')) selB.value = activeStorm || '';
    updateNhcAdvInfo();
    if (Object.values(maps).some(m => isLayerVisible(m, 'adeck-lines'))) fetchAdeck(true);
    const ip = document.getElementById('intensity-panel');
    if (ip && ip.style.display === 'block' && ip.dataset.mode) openIntensityChart(ip.dataset.mode);
    const tp = document.getElementById('trends-panel');
    if (tp && tp.style.display === 'block') openTrendsChart(false);
    const sp = document.getElementById('ships-panel');
    if (sp && sp.style.display === 'block') openShipsPanel(false);
    const ap = document.getElementById('nhcadv-panel');
    if (ap && ap.style.display === 'block' && ap.dataset.prod) openNhcAdv(ap.dataset.prod, true);
    renderRecon(false);
    if (Object.values(maps).some(m => isLayerVisible(m, 'nhc-fcst-lines'))) fetchFcstHistory(false);
}

async function fetchAdeckList() {
    try {
        const res = await fetch('/api/adeck?list=1');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const all = (await res.json()).storms || [];
        // Drop invests upgraded to a numbered storm (AL91→AL02): files linger but
        // guidance is frozen. Migrate any current selection to the upgraded system.
        const graduated = {};
        all.forEach(s => { if (s.graduated_to) graduated[s.id] = s.graduated_to; });
        adeckListRaw = all.filter(s => !s.graduated_to);
        if (activeStorm && graduated[activeStorm]) activeStorm = graduated[activeStorm];
    } catch (e) {
        adeckListRaw = [];
    }
    rebuildStormMenus();
}

// ─── Storm Trends: observed intensity history (b-deck + recon VDM fixes) ───
// Best track = NHC's analyzed wind/pressure at each synoptic time through the
// storm's whole life (invests included). Recon vortex fixes overlay the actual
// aircraft measurements between analyses.
function parseBdeck(text) {
    const seen = new Set();
    const pts = [];
    text.split('\n').forEach(ln => {
        const p = ln.split(',').map(s => s.trim());
        if (p.length < 11 || p[4] !== 'BEST') return;
        const dtg = p[2];
        if (dtg.length !== 10 || !dtg.match(/^\d{10}$/) || seen.has(dtg)) return;
        seen.add(dtg);
        const la = p[6].match(/^(\d+)([NS])$/), lo = p[7].match(/^(\d+)([EW])$/);
        pts.push({
            ms: adeckDtgMs(dtg), dtg, vmax: +p[8] || null, mslp: +p[9] || null, type: p[10] || '',
            lat: la ? (+la[1] / 10) * (la[2] === 'S' ? -1 : 1) : null,
            lon: lo ? (+lo[1] / 10) * (lo[2] === 'W' ? -1 : 1) : null
        });
    });
    return pts.sort((a, b) => a.ms - b.ms);
}

// Build the run-to-run forecast-history overlay for the active storm: every past
// OFCL forecast track (faded by age) over the actual best-track traveled path.
async function fetchFcstHistory(show) {
    const setAll = feats => Object.values(maps).forEach(m => {
        if (m.getSource && m.getSource('nhc-fcst-history'))
            m.getSource('nhc-fcst-history').setData({ type: 'FeatureCollection', features: feats });
    });
    if (!activeStorm) { setAll([]); if (show) addLiveLog('FORECAST HISTORY: no active system selected', '#ffb300'); return; }
    const sid = activeStorm;
    try {
        const [fRes, bRes] = await Promise.all([
            fetch(`/api/adeck?fcst=${sid}`),
            fetch(`/api/adeck?btk=${sid}`).catch(() => null)
        ]);
        const ofcl = fRes.ok ? parseAdeckText(await fRes.text()) : [];
        const bpts = (bRes && bRes.ok) ? parseBdeck(await bRes.text()).filter(p => p.lat != null) : [];
        const features = [];

        // Actual traveled path (best track) with fix dots colored by intensity
        if (bpts.length >= 2) features.push({
            type: 'Feature', properties: { kind: 'actual' },
            geometry: { type: 'LineString', coordinates: bpts.map(p => [p.lon, p.lat]) }
        });
        bpts.forEach((p, i) => features.push({
            type: 'Feature',
            properties: { kind: 'fix', mw: p.vmax || 0, latest: i === bpts.length - 1 ? 1 : 0 },
            geometry: { type: 'Point', coordinates: [p.lon, p.lat] }
        }));

        // Past forecast tracks: one OFCL polyline per cycle, faded oldest→newest,
        // anchored at that advisory's fixed (tau 0) position
        const byCycle = {};
        ofcl.forEach(r => {
            if (r.tau < 0) return;
            (byCycle[r.dtg] = byCycle[r.dtg] || {})[r.tau] = r;   // dedupe wind-radii rows by tau
        });
        const cycles = Object.keys(byCycle).sort();
        const N = cycles.length;
        cycles.forEach((dtg, idx) => {
            const pts = Object.values(byCycle[dtg]).sort((a, b) => a.tau - b.tau);
            if (pts.length < 2) return;
            const newest = idx === N - 1;
            const op = +(0.28 + 0.72 * (N > 1 ? idx / (N - 1) : 1)).toFixed(2);
            const color = newest ? '#00e5ff' : '#5fa8c8';
            const coords = pts.map(p => [p.lon, p.lat]);
            features.push({
                type: 'Feature', properties: { kind: 'fcst', op, color, w: newest ? 3 : 1.6 },
                geometry: { type: 'LineString', coordinates: coords }
            });
            features.push({
                type: 'Feature',
                properties: { kind: 'fcstlabel', op: Math.max(op, 0.6), color, lbl: `${+dtg.slice(8, 10)}Z ${+dtg.slice(4, 6)}/${+dtg.slice(6, 8)}` },
                geometry: { type: 'Point', coordinates: coords[coords.length - 1] }
            });
        });

        setAll(features);
        if (show) addLiveLog(`FORECAST HISTORY: ${stormShortId(sid)} — ${N} forecast cycle${N === 1 ? '' : 's'} + ${bpts.length} best-track fixes`, N ? '#00e5ff' : '#ffb300');
    } catch (e) {
        if (show) addLiveLog(`FORECAST HISTORY ERROR: ${e.message}`, '#ff3333');
    }
}

// Decode one URNT12/URPN12 Vortex Data Message → { id, ms, mslp, flWind }
function parseVdm(text) {
    const id = text.match(/VORTEX DATA MESSAGE\s+(\w{2}\d{6})/i);
    const a = text.match(/^A\.\s*(\d{2})\/(\d{2}):?(\d{2})/m);
    if (!id || !a) return null;
    // A. gives day/time only — anchor to the most recent matching UTC day
    const now = new Date();
    let d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), +a[1], +a[2], +a[3]));
    if (d.getTime() > Date.now() + 26 * 3600 * 1000) d = new Date(d.setUTCMonth(d.getUTCMonth() - 1));
    const mslp = text.match(/^D\.\s*(?:EXTRAP\s+)?(\d{3,4})\s*mb/mi);
    const flw = text.match(/MAX FL WIND\s+(\d+)\s*KT/i);
    return {
        id: id[1].toUpperCase(),
        ms: d.getTime(),
        mslp: mslp ? +mslp[1] : null,
        flWind: flw ? +flw[1] : null
    };
}

function trendWord(delta, up, down, eps) {
    if (delta == null) return null;
    return delta <= -eps ? down : delta >= eps ? up : 'STEADY';
}

function drawTrendsChart(canvas, best, vdms) {
    const cssW = 680, cssH = 400;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = cssW * dpr; canvas.height = cssH * dpr;
    canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    if (best.length < 2) {
        ctx.fillStyle = '#8b97a3'; ctx.font = '12px "Roboto Mono",monospace'; ctx.textAlign = 'center';
        ctx.fillText('No best-track history available for this system yet.', cssW / 2, cssH / 2);
        return;
    }
    const mL = 44, mR = 52, mT = 26, mB = 34;
    const pw = cssW - mL - mR, ph = cssH - mT - mB;
    const t0 = best[0].ms, t1 = Math.max(best[best.length - 1].ms, Date.now());
    const X = ms => mL + ((ms - t0) / (t1 - t0)) * pw;
    const winds = best.map(p => p.vmax).filter(v => v != null);
    const yWMax = Math.max(50, Math.ceil((Math.max(...winds) + 15) / 10) * 10);
    const YW = v => mT + ph - (v / yWMax) * ph;
    const presAll = best.map(p => p.mslp).filter(v => v != null)
        .concat(vdms.map(v => v.mslp).filter(v => v != null));
    const pMin = Math.min(...presAll) - 3, pMax = Math.max(...presAll) + 3;
    // Standard axis: low pressure at the BOTTOM, higher pressure toward the top
    const YP = v => mT + ph - ((v - pMin) / (pMax - pMin)) * ph * 0.92 - ph * 0.04;
    ctx.font = '9px "Roboto Mono",monospace';
    // x grid: one line per UTC day
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let d = new Date(t0); d.getTime() <= t1; d = new Date(d.getTime() + 24 * 3600 * 1000)) {
        const dayMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
        if (dayMs < t0) continue;
        ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(X(dayMs), mT); ctx.lineTo(X(dayMs), mT + ph); ctx.stroke();
        ctx.fillStyle = '#8b97a3';
        ctx.fillText(`${String(new Date(dayMs).getUTCDate()).padStart(2, '0')} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][new Date(dayMs).getUTCMonth()]}`, X(dayMs), mT + ph + 6);
    }
    // left axis: wind
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let v = 0; v <= yWMax; v += 10) {
        ctx.fillStyle = '#00e5ff'; ctx.fillText(`${v}`, mL - 6, YW(v));
    }
    // right axis: pressure
    ctx.textAlign = 'left';
    for (let p = Math.ceil(pMin / 2) * 2; p <= pMax; p += 2) {
        ctx.fillStyle = '#ffd166'; ctx.fillText(`${p}`, mL + pw + 6, YP(p));
    }
    ctx.save(); ctx.translate(11, mT + ph / 2); ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center'; ctx.fillStyle = '#00e5ff'; ctx.fillText('WIND (KT)', 0, 0); ctx.restore();
    ctx.save(); ctx.translate(cssW - 8, mT + ph / 2); ctx.rotate(Math.PI / 2);
    ctx.textAlign = 'center'; ctx.fillStyle = '#ffd166'; ctx.fillText('PRESSURE (MB)', 0, 0); ctx.restore();
    // classification change labels along the top
    let lastType = null;
    best.forEach(p => {
        if (p.type && p.type !== lastType) {
            ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
            ctx.font = 'bold 9px "Roboto Mono",monospace';
            ctx.fillText(p.type, X(p.ms), mT - 8);
            ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.setLineDash([2, 3]);
            ctx.beginPath(); ctx.moveTo(X(p.ms), mT - 4); ctx.lineTo(X(p.ms), mT + ph); ctx.stroke();
            ctx.setLineDash([]);
            lastType = p.type;
        }
    });
    ctx.font = '9px "Roboto Mono",monospace';
    // pressure line (yellow)
    ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 2; ctx.beginPath();
    let started = false;
    best.forEach(p => { if (p.mslp == null) return; started ? ctx.lineTo(X(p.ms), YP(p.mslp)) : ctx.moveTo(X(p.ms), YP(p.mslp)); started = true; });
    ctx.stroke();
    ctx.fillStyle = '#ffd166';
    best.forEach(p => { if (p.mslp == null) return; ctx.beginPath(); ctx.arc(X(p.ms), YP(p.mslp), 2.4, 0, Math.PI * 2); ctx.fill(); });
    // wind line (cyan)
    ctx.strokeStyle = '#00e5ff'; ctx.lineWidth = 2; ctx.beginPath();
    started = false;
    best.forEach(p => { if (p.vmax == null) return; started ? ctx.lineTo(X(p.ms), YW(p.vmax)) : ctx.moveTo(X(p.ms), YW(p.vmax)); started = true; });
    ctx.stroke();
    ctx.fillStyle = '#00e5ff';
    best.forEach(p => { if (p.vmax == null) return; ctx.beginPath(); ctx.arc(X(p.ms), YW(p.vmax), 2.4, 0, Math.PI * 2); ctx.fill(); });
    // recon vortex fixes: pressure diamonds (magenta), FL wind crosses
    vdms.forEach(v => {
        if (v.ms < t0 || v.ms > t1) return;
        if (v.mslp != null) {
            const x = X(v.ms), y = YP(v.mslp);
            ctx.fillStyle = '#ff4dd2';
            ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x + 4, y); ctx.lineTo(x, y + 4); ctx.lineTo(x - 4, y); ctx.closePath(); ctx.fill();
        }
        if (v.flWind != null) {
            const x = X(v.ms), y = YW(v.flWind);
            ctx.strokeStyle = '#ff4dd2'; ctx.lineWidth = 1.4;
            ctx.beginPath(); ctx.moveTo(x - 3.5, y - 3.5); ctx.lineTo(x + 3.5, y + 3.5);
            ctx.moveTo(x - 3.5, y + 3.5); ctx.lineTo(x + 3.5, y - 3.5); ctx.stroke();
        }
    });
    // key
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const key = [['— Best-track wind', '#00e5ff'], ['— Best-track pressure', '#ffd166'], ['◆/✕ Recon fix (SLP / FL wind)', '#ff4dd2']];
    key.forEach(([lab, col], i) => {
        ctx.fillStyle = col;
        ctx.fillText(lab, mL + 8 + i * 165, mT + 6);
    });
}

async function openTrendsChart(announce = true) {
    const panel = document.getElementById('trends-panel');
    const title = document.getElementById('trends-title');
    const note = document.getElementById('trends-note');
    const tend = document.getElementById('trends-tendency');
    if (!panel || !title || !note || !tend) return;
    if (announce) await fetchAdeckList();
    if (!adeckStorm) { addLiveLog('TRENDS: no active systems right now', '#ffb300'); return; }
    panel.style.display = 'block';
    const sid = adeckStorm.toUpperCase().slice(0, 4);
    title.textContent = `${sid} — STORM TRENDS (OBSERVED INTENSITY HISTORY)`;
    if (announce) { note.textContent = 'Loading…'; tend.innerHTML = ''; }
    try {
        const [btkRes, atlVdm, epacVdm] = await Promise.all([
            fetch(`/api/adeck?btk=${adeckStorm}`),
            fetchAfos('REPNT2', 30).catch(() => []),
            fetchAfos('REPPN2', 15).catch(() => [])
        ]);
        if (!btkRes.ok) throw new Error(`best track HTTP ${btkRes.status}`);
        const best = parseBdeck(await btkRes.text());
        const stormAtcf = adeckStorm.toUpperCase();   // e.g. AL022026
        const vdms = [...atlVdm, ...epacVdm].map(parseVdm)
            .filter(v => v && v.id === stormAtcf && (v.mslp != null || v.flWind != null))
            .sort((a, b) => a.ms - b.ms);
        drawTrendsChart(document.getElementById('trends-canvas'), best, vdms);
        // Tendencies from the best track: latest vs ~6/12/24 h earlier
        const last = best[best.length - 1];
        const at = hrs => {
            const target = last.ms - hrs * 3600 * 1000;
            return [...best].reverse().find(p => p.ms <= target + 90 * 60 * 1000);
        };
        const chips = [];
        [[6, at(6)], [12, at(12)], [24, at(24)]].forEach(([h, ref]) => {
            if (!ref || ref.ms === last.ms) return;
            const dp = last.mslp != null && ref.mslp != null ? last.mslp - ref.mslp : null;
            const dv = last.vmax != null && ref.vmax != null ? last.vmax - ref.vmax : null;
            const pw = trendWord(dp, 'FILLING', 'DEEPENING', 1);
            const vw = trendWord(dv, 'STRENGTHENING', 'WEAKENING', 5);
            if (dp != null) chips.push(`<span style="color:${dp < 0 ? '#ff6666' : dp > 0 ? '#7fff9e' : '#8b97a3'};">${h}h ΔP ${dp > 0 ? '+' : ''}${dp} mb${pw && pw !== 'STEADY' ? ' ' + pw : ''}</span>`);
            if (dv != null && h !== 6) chips.push(`<span style="color:${dv > 0 ? '#ff6666' : dv < 0 ? '#7fff9e' : '#8b97a3'};">${h}h ΔV ${dv > 0 ? '+' : ''}${dv} kt${vw && vw !== 'STEADY' ? ' ' + vw : ''}</span>`);
        });
        tend.innerHTML = chips.length
            ? `<b style="color:#fff;">NOW: ${last.vmax || '?'} kt / ${last.mslp || '?'} mb (${last.type || '—'})</b> · ` + chips.join(' · ')
            : '';
        note.textContent = `Best track through ${last.dtg.slice(8, 10)}Z ${last.dtg.slice(6, 8)} (${adeckAgeStr(last.ms)}) · ${best.length} analyses` +
            (vdms.length ? ` · ${vdms.length} recon vortex fix${vdms.length > 1 ? 'es' : ''} overlaid` : ' · no recon fixes yet for this system');
        if (announce) addLiveLog(`TRENDS: ${sid} — ${best.length} best-track analyses, now ${last.vmax} kt / ${last.mslp} mb${vdms.length ? `, ${vdms.length} recon fixes` : ''}`, '#00e5ff');
    } catch (e) {
        note.textContent = `Error: ${e.message}`;
    }
}

// ─── SHIPS environmental diagnostics (why the storm may strengthen/weaken) ───
// Parses NHC's SHIPS text: vertical shear, SST, mid-level RH, ocean heat,
// maximum potential intensity, and the rapid-intensification probabilities.
function shipsNumsAfter(text, label) {
    const re = new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+(.+)$', 'm');
    const m = text.match(re);
    if (!m) return [];
    return (m[1].match(/-?\d+\.?\d*/g) || []).map(Number);
}

function parseShips(text) {
    const hdr = text.match(/(\w{2}\d{6})\s+(\d{2})\/(\d{2})\/(\d{2})\s+(\d{2})\s+UTC/);
    const hours = shipsNumsAfter(text, 'TIME (HR)');
    // RI probability matrix: threshold header + consensus row
    const thHdr = text.match(/RI \(kt \/ h\)\s*\|(.+)/);
    const thresholds = thHdr ? thHdr[1].split('|').map(s => s.trim()).filter(Boolean) : [];
    const consLine = text.match(/^\s*Consensus:\s*(.+)$/m);
    const consensus = consLine ? (consLine[1].match(/[\d.]+/g) || []).map(Number) : [];
    // Climo context for the 24-h 30-kt RI threshold (the common headline)
    const climo = {};
    text.replace(/SHIPS Prob RI for (\d+)kt\/\s*(\d+)hr RI threshold=\s*(\d+)% is\s*([\d.]+) times climatological mean \(\s*([\d.]+)%\)/g,
        (_, dv, hr, prob, mult, mean) => { climo[`${dv}/${hr}`] = { prob: +prob, mult: +mult, mean: +mean }; return _; });
    const prelim = text.match(/PRELIM RI PROB[^:]*:\s*([\d.]+)/);
    return {
        id: hdr ? hdr[1] : '',
        initStr: hdr ? `${hdr[2]}/${hdr[3]} ${hdr[5]}Z` : '',
        hours,
        vmax: shipsNumsAfter(text, 'V (KT) NO LAND'),
        vlgem: shipsNumsAfter(text, 'V (KT) LGEM'),
        shear: shipsNumsAfter(text, 'SHEAR (KT)'),
        sst: shipsNumsAfter(text, 'SST (C)'),
        mpi: shipsNumsAfter(text, 'POT. INT. (KT)'),
        rh: shipsNumsAfter(text, '700-500 MB RH'),
        ohc: shipsNumsAfter(text, 'HEAT CONTENT'),
        thresholds, consensus, climo,
        prelimRI: prelim ? +prelim[1] : null
    };
}

// Favorability color for each parameter (green good for intensification → red hostile)
const shipsColor = {
    shear: v => v == null ? '#8b97a3' : v < 10 ? '#00e676' : v < 20 ? '#9ccc65' : v < 30 ? '#ffb300' : '#ff5252',
    sst:   v => v == null ? '#8b97a3' : v >= 29 ? '#00e676' : v >= 28 ? '#9ccc65' : v >= 26.5 ? '#ffb300' : '#ff5252',
    rh:    v => v == null ? '#8b97a3' : v >= 60 ? '#00e676' : v >= 50 ? '#9ccc65' : v >= 40 ? '#ffb300' : '#ff5252',
    ohc:   v => v == null ? '#8b97a3' : v >= 50 ? '#00e676' : v >= 16 ? '#9ccc65' : v > 0 ? '#ffb300' : '#8b97a3',
    plain: () => '#e0e0e0'
};

function shipsAssessment(s) {
    const at0 = arr => arr && arr.length ? arr[0] : null;
    const sh = at0(s.shear), sst = at0(s.sst), rh = at0(s.rh), ohc = at0(s.ohc);
    const mpi = at0(s.mpi), vnow = at0(s.vmax);
    let score = 0; const pros = [], cons = [];
    if (sh != null) { if (sh < 10) { score += 2; pros.push('low shear'); } else if (sh < 20) { score += 1; } else if (sh < 30) { score -= 1; cons.push('elevated shear'); } else { score -= 2; cons.push('high shear'); } }
    if (rh != null) { if (rh >= 60) { score += 1; pros.push('moist mid-levels'); } else if (rh < 40) { score -= 2; cons.push('dry mid-levels'); } else if (rh < 50) { score -= 1; cons.push('marginal moisture'); } }
    if (sst != null) { if (sst >= 29) { score += 1; pros.push('very warm SST'); } else if (sst < 26.5) { score -= 2; cons.push('cool SST'); } }
    if (ohc != null && ohc >= 50) { score += 1; pros.push('high ocean heat'); }
    const headroom = (mpi != null && vnow != null) ? mpi - vnow : null;
    if (headroom != null && headroom < 20) { score -= 2; cons.push('near potential intensity'); }
    const ri24 = s.climo['30/24'] || s.climo['25/24'];
    if (ri24 && ri24.mult >= 2) { score += 1; pros.push('RI odds above normal'); }
    let verdict, color;
    if (score >= 3) { verdict = 'FAVORABLE for strengthening'; color = '#00e676'; }
    else if (score >= 1) { verdict = 'MARGINALLY FAVORABLE'; color = '#9ccc65'; }
    else if (score >= -1) { verdict = 'MIXED / NEAR-STEADY'; color = '#ffb300'; }
    else { verdict = 'HOSTILE — favors weakening'; color = '#ff5252'; }
    return { verdict, color, pros, cons, headroom };
}

// CIRA rapid-intensification / decapitation guidance (ripastbl) — adds the
// decapitation risk, a 2nd independent RI consensus, and structure predictors
function parseRip(text) {
    const riBlock = (text.split(/Probabilities\[%\] of Rapid intensification/)[1] || '').split(/Decapitation/)[0];
    const decapBlock = text.split(/Probabilities\[%\] of Storm Decapitation/)[1] || '';
    const cons = (block, thresh) => {
        const m = block.match(new RegExp(thresh.replace('/', '\\s*/\\s*') + '\\s+[\\d.]+%\\s+[\\d.]+%\\s+([\\d.]+)%'));
        return m ? +m[1] : null;
    };
    const pred = label => {
        const m = text.match(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+([\\d.]+)\\s+(\\w+)'));
        return m ? { val: +m[1], flag: m[2] } : null;
    };
    return {
        ri30_24: cons(riBlock, '30kt / 24h'),
        ri25_24: cons(riBlock, '25kt / 24h'),
        ri45_36: cons(riBlock, '45kt / 36h'),
        decap24: cons(decapBlock, '-30kt / 24h'),
        cold50: pred('CONVECTION <-50C [%]'),
        symmetry: pred('IR CORE SYMMETRY [K]')
    };
}

const RIP_FLAG = { VF: ['very favorable', '#00e676'], F: ['favorable', '#9ccc65'], N: ['neutral', '#c0c0c0'], U: ['unfavorable', '#ffb300'], VU: ['very unfavorable', '#ff5252'] };

function shipsRipBlock(rip) {
    const riColor = v => v == null ? '#8b97a3' : v >= 30 ? '#ff5252' : v >= 15 ? '#ffb300' : v >= 5 ? '#9ccc65' : '#8b97a3';
    // Decapitation = convection sheared off the center → rapid weakening; high is bad
    const dcColor = v => v == null ? '#8b97a3' : v >= 30 ? '#ff5252' : v >= 15 ? '#ffb300' : v >= 5 ? '#ffd166' : '#00e676';
    const stat = (lab, v, col, suf = '%') => v == null ? '' :
        `<span style="display:inline-block;margin-right:16px;"><span style="color:#5a6570;">${lab}:</span> <span style="color:${col(v)};font-weight:600;">${v.toFixed(v < 10 && suf === '%' ? 1 : 0)}${suf}</span></span>`;
    const pred = (lab, p) => !p ? '' :
        `<span style="display:inline-block;margin-right:16px;"><span style="color:#5a6570;">${lab}:</span> <span style="color:${(RIP_FLAG[p.flag] || ['', '#c0c0c0'])[1]};">${p.val}${lab.includes('symmetry') ? ' K' : '%'} (${p.flag})</span></span>`;
    return `
        <div style="border-top:1px solid rgba(255,255,255,0.12);margin-top:8px;padding-top:6px;font-size:10.5px;font-family:'Roboto Mono',monospace;">
            <div style="color:#00e5ff;font-weight:700;margin-bottom:3px;">CIRA RI CONSENSUS &amp; DECAPITATION</div>
            <div style="color:#c0c0c0;line-height:1.8;">
                ${stat('RI 30 kt / 24 h', rip.ri30_24, riColor)}
                ${stat('RI 25 kt / 24 h', rip.ri25_24, riColor)}
                ${stat('RI 45 kt / 36 h', rip.ri45_36, riColor)}
                ${rip.decap24 != null ? `<span style="display:inline-block;margin-right:16px;"><span style="color:#5a6570;">Decapitation 24 h:</span> <span style="color:${dcColor(rip.decap24)};font-weight:600;">${rip.decap24.toFixed(rip.decap24 < 10 ? 1 : 0)}%</span></span>` : ''}
            </div>
            ${(rip.cold50 || rip.symmetry) ? `<div style="color:#c0c0c0;line-height:1.8;margin-top:2px;"><span style="color:#5a6570;">Structure now — </span>${pred('cold cloud &lt;−50°C', rip.cold50)}${pred('IR symmetry', rip.symmetry)}</div>` : ''}
        </div>`;
}

async function openShipsPanel(announce = true) {
    const panel = document.getElementById('ships-panel');
    const title = document.getElementById('ships-title');
    const body = document.getElementById('ships-body');
    const note = document.getElementById('ships-note');
    if (!panel || !body) return;
    if (announce) await fetchAdeckList();
    if (!adeckStorm) { addLiveLog('SHIPS: no active systems right now', '#ffb300'); return; }
    panel.style.display = 'block';
    const sid = adeckStorm.toUpperCase().slice(0, 4);
    title.textContent = `${sid} — SHIPS ENVIRONMENTAL DIAGNOSTICS`;
    if (announce) { body.innerHTML = '<div style="color:#8b97a3;padding:20px;">Loading…</div>'; note.textContent = ''; }
    try {
        const [res, ripRes] = await Promise.all([
            fetch(`/api/adeck?ships=${adeckStorm}`),
            fetch(`/api/adeck?rip=${adeckStorm}`).catch(() => null)
        ]);
        if (!res.ok) throw new Error(res.status === 500 ? 'no SHIPS diagnostics for this system yet' : `HTTP ${res.status}`);
        const s = parseShips(await res.text());
        const a = shipsAssessment(s);
        const rip = (ripRes && ripRes.ok) ? parseRip(await ripRes.text()) : null;
        // pick display columns: 0/12/24/48/72 h where present
        const wantH = [0, 12, 24, 48, 72];
        const cols = wantH.map(h => s.hours.indexOf(h)).filter(i => i >= 0);
        const cell = (arr, i, colFn, dp = 0) => {
            const v = arr && arr[i] != null ? arr[i] : null;
            return `<td style="text-align:right;padding:2px 8px;color:${colFn(v)};">${v == null ? '—' : v.toFixed(dp)}</td>`;
        };
        const rowHtml = (label, arr, colFn, dp = 0, unit = '') =>
            `<tr><td style="padding:2px 8px 2px 0;color:#8b97a3;white-space:nowrap;">${label}${unit ? ` <span style="color:#5a6570;">${unit}</span>` : ''}</td>` +
            cols.map(i => cell(arr, i, colFn, dp)).join('') + '</tr>';
        const hdrCells = cols.map(i => `<th style="text-align:right;padding:2px 8px;color:#00e5ff;font-weight:600;">F${s.hours[i]}</th>`).join('');
        // RI consensus: pick the 24-h/30-kt column if present, else the 25/24
        const riIdx = s.thresholds.findIndex(t => t === '30/24');
        const ri2524 = s.thresholds.findIndex(t => t === '25/24');
        const riCol = riIdx >= 0 ? riIdx : ri2524;
        const ri24val = riCol >= 0 && s.consensus[riCol] != null ? s.consensus[riCol] : null;
        const climoKey = riIdx >= 0 ? '30/24' : '25/24';
        const climoInfo = s.climo[climoKey];
        const riChips = s.thresholds.map((t, i) => {
            const v = s.consensus[i];
            if (v == null) return '';
            const hot = v >= 30 ? '#ff5252' : v >= 15 ? '#ffb300' : v >= 5 ? '#9ccc65' : '#8b97a3';
            return `<span style="display:inline-block;margin:1px 5px 1px 0;"><span style="color:#5a6570;">${t}:</span> <span style="color:${hot};font-weight:600;">${v.toFixed(0)}%</span></span>`;
        }).join('');
        body.innerHTML = `
            <div style="background:${a.color}22;border-left:3px solid ${a.color};padding:5px 9px;margin-bottom:8px;">
                <span style="color:${a.color};font-weight:700;font-size:11px;">${a.verdict}</span>
                ${a.pros.length ? `<span style="color:#9ccc65;font-size:9.5px;"> · +${a.pros.join(', ')}</span>` : ''}
                ${a.cons.length ? `<span style="color:#ff8a80;font-size:9.5px;"> · −${a.cons.join(', ')}</span>` : ''}
            </div>
            <table style="border-collapse:collapse;font-size:10.5px;font-family:'Roboto Mono',monospace;margin-bottom:8px;">
                <tr><th style="text-align:left;padding:2px 8px 2px 0;color:#5a6570;">FORECAST HOUR</th>${hdrCells}</tr>
                ${rowHtml('Vertical shear', s.shear, shipsColor.shear, 0, 'kt')}
                ${rowHtml('Sea-surface temp', s.sst, shipsColor.sst, 1, '°C')}
                ${rowHtml('Mid-level RH', s.rh, shipsColor.rh, 0, '%')}
                ${rowHtml('Ocean heat content', s.ohc, shipsColor.ohc, 0, '')}
                ${rowHtml('Max potential intensity', s.mpi, shipsColor.plain, 0, 'kt')}
                ${rowHtml('SHIPS forecast wind', s.vmax, shipsColor.plain, 0, 'kt')}
            </table>
            <div style="font-size:10.5px;font-family:'Roboto Mono',monospace;">
                <div style="color:#00e5ff;font-weight:700;margin-bottom:3px;">RAPID INTENSIFICATION OUTLOOK ${ri24val != null ? `— <span style="color:${ri24val >= 30 ? '#ff5252' : ri24val >= 15 ? '#ffb300' : '#9ccc65'};">${ri24val.toFixed(0)}% (${climoKey.replace('/', ' kt / ')} h)</span>` : ''}</div>
                <div style="color:#c0c0c0;line-height:1.7;">${riChips}</div>
                ${climoInfo ? `<div style="color:#8b97a3;font-size:9.5px;margin-top:3px;">${climoKey.split('/')[0]}-kt/${climoKey.split('/')[1]}-h RI odds are <b style="color:${climoInfo.mult >= 1.5 ? '#ffb300' : '#c0c0c0'};">${climoInfo.mult.toFixed(1)}×</b> the climatological mean (${climoInfo.mean.toFixed(1)}%)</div>` : ''}
            </div>
            ${rip ? shipsRipBlock(rip) : ''}`;
        note.textContent = `SHIPS (GFS) init ${s.initStr} · shear/SST/RH/OHC = environment; green favors intensification, red hostile${rip ? ' · RI/decap consensus from CIRA' : ''}`;
        if (announce) addLiveLog(`SHIPS: ${sid} — ${a.verdict}; shear ${s.shear[0]} kt, mid-RH ${s.rh[0]}%, 24h RI ${ri24val != null ? ri24val.toFixed(0) + '%' : 'n/a'}`, a.color);
    } catch (e) {
        body.innerHTML = `<div style="color:#ff8a80;padding:16px;">${esc(e.message)}</div>`;
        note.textContent = '';
    }
}

function initAdeck() {
    const sel = document.getElementById('adeck-storm-select');
    if (sel) sel.addEventListener('change', () => setActiveStorm(sel.value));
    document.getElementById('nhc-trends')?.addEventListener('click', () => openTrendsChart(true));
    document.getElementById('nhc-ships')?.addEventListener('click', () => openShipsPanel(true));
    document.getElementById('ships-close')?.addEventListener('click', () => {
        const p = document.getElementById('ships-panel');
        if (p) p.style.display = 'none';
    });
    document.getElementById('trends-close')?.addEventListener('click', () => {
        const p = document.getElementById('trends-panel');
        if (p) p.style.display = 'none';
    });
    document.getElementById('adeck-int-early')?.addEventListener('click', () => {
        const p = document.getElementById('intensity-panel');
        if (p) p.dataset.mode = 'early';
        openIntensityChart('early');
    });
    document.getElementById('adeck-int-late')?.addEventListener('click', () => {
        const p = document.getElementById('intensity-panel');
        if (p) p.dataset.mode = 'late';
        openIntensityChart('late');
    });
    document.getElementById('intensity-close')?.addEventListener('click', () => {
        const p = document.getElementById('intensity-panel');
        if (p) p.style.display = 'none';
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            ['intensity-panel', 'trends-panel', 'ships-panel'].forEach(id => {
                const p = document.getElementById(id);
                if (p) p.style.display = 'none';
            });
        }
    });
    setTimeout(fetchAdeckList, 9000);
    // Every 15 min: refresh the system list (catches invest→TC transitions like
    // AL91→AL02, where a NEW a-deck appears at the first advisory), and once
    // guidance has been used, re-pull the deck so the health row tracks cycles
    setInterval(() => {
        fetchAdeckList();
        if (adeckMode && adeckStorm) fetchAdeck(false);
        const tp = document.getElementById('trends-panel');
        if (tp && tp.style.display === 'block') openTrendsChart(false);
        const sp = document.getElementById('ships-panel');
        if (sp && sp.style.display === 'block') openShipsPanel(false);
    }, 15 * 60 * 1000);
}

// ─── Unified toggle behavior for panel-opening menu items ───
// Map-layer items highlight while on and un-toggle on a second click; these
// entries give every panel-opening item the same contract: highlight while its
// panel is open, second click closes, and any close path (×, Esc) un-highlights.
const PANEL_MENU_ITEMS = [
    { item: 'btn-vad',           panel: 'vad-panel' },
    { item: 'btn-soundings',     panel: 'sounding-modal' },
    { item: 'btn-skewt',         panel: 'skewt-panel' },
    { item: 'btn-spcmeso',       panel: 'spcmeso-panel' },
    { item: 'recon-tcpod',       panel: 'recon-text-panel' },
    { item: 'recon-vdm',         panel: 'recon-text-panel' },
    { item: 'adeck-int-early',   panel: 'intensity-panel' },
    { item: 'adeck-int-late',    panel: 'intensity-panel' },
    { item: 'nhc-trends',        panel: 'trends-panel' },
    { item: 'nhc-ships',         panel: 'ships-panel' },
    { item: 'nhcadv-tcp',        panel: 'nhcadv-panel' },
    { item: 'nhcadv-tcd',        panel: 'nhcadv-panel' },
    { item: 'nhcadv-tcm',        panel: 'nhcadv-panel' },
    { item: 'nhcadv-pws',        panel: 'nhcadv-panel' },
    { item: 'btn-text-products', panel: 'text-panel' },
    { item: 'btn-meteogram',     panel: 'meteogram-panel' },
    { item: 'btn-model-compare', panel: 'model-panel' },
    { item: 'btn-mos',           panel: 'mos-panel' },
    { item: 'nhc-two-atl',       panel: 'text-panel' },
    { item: 'nhc-two-epac',      panel: 'text-panel' }
];

function syncPanelHighlights() {
    PANEL_MENU_ITEMS.forEach(p => {
        const item = document.getElementById(p.item);
        const panel = document.getElementById(p.panel);
        if (!item || !panel) return;
        const on = getComputedStyle(panel).display !== 'none' && panel.dataset.openedBy === p.item;
        item.classList.toggle('active', on);
    });
}

function initPanelToggles() {
    // Document-level CAPTURE handler: runs before each item's own open handler,
    // so a click on an already-active item can close the panel and swallow the
    // click (otherwise the original handler would immediately reopen it).
    document.addEventListener('click', e => {
        const t = e.target instanceof Element ? e.target : null;
        if (!t) return;
        const entry = PANEL_MENU_ITEMS.find(p => t.closest('#' + p.item));
        if (!entry) return;
        const panel = document.getElementById(entry.panel);
        if (!panel) return;
        const isOpen = getComputedStyle(panel).display !== 'none';
        if (isOpen && panel.dataset.openedBy === entry.item) {
            e.stopPropagation();
            panel.style.display = 'none';
            delete panel.dataset.openedBy;
            syncPanelHighlights();
        } else {
            panel.dataset.openedBy = entry.item;
            setTimeout(syncPanelHighlights, 0);
        }
    }, true);
    // Keep highlights honest for every close path (× button, Esc, other code)
    const seen = new Set();
    PANEL_MENU_ITEMS.forEach(p => {
        if (seen.has(p.panel)) return;
        seen.add(p.panel);
        const panel = document.getElementById(p.panel);
        if (panel) new MutationObserver(syncPanelHighlights)
            .observe(panel, { attributes: true, attributeFilter: ['style'] });
    });
    // New model runs arrive continuously through each cycle
    setInterval(() => {
        if (Object.values(maps).some(m => isLayerVisible(m, 'adeck-lines'))) fetchAdeck(false);
    }, 15 * 60 * 1000);
}

// GIS-vs-official advisory cross-check state (see fetchNHCStorms). NOAA's
// tropical MapServer feeds the cone/track; CurrentStorms.json is authoritative.
let nhcGisAdv = {};        // bin -> { adv, advdate, ingestMs } as served by the GIS
let nhcGisStaleBins = {};  // bin -> details, only for storms where GIS is behind
let nhcStormSource = 'noaa';   // 'noaa' = MapServer mirror, 'nhc' = NHC-direct KMZ
const normAdv = a => String(a || '').trim().toLowerCase().replace(/^0+/, '');

// ═══════════════════════════════════════════════════════════════════════════════
// NHC-DIRECT CONE/TRACK (KMZ) — failover source
// ═══════════════════════════════════════════════════════════════════════════════
// NOAA's tropical MapServer only re-serves NHC's advisory graphics, and its ingest
// can stall for a day at a time (observed ~22 h on Jul 21 2026). NHC publishes the
// same cone/track/watch geometry itself as KMZ — CORS-open, no proxy needed, and
// regenerated on every advisory including intermediates. nhc_active.kml is the
// index NHC rewrites each cycle, so it also names the current advisory per storm.
const NHC_KML_INDEX = 'https://www.nhc.noaa.gov/gis/kml/nhc_active.kml';

// A KMZ is a ZIP holding one .kml document. Read the central directory rather
// than the local headers so entries written with a data descriptor still work.
async function unzipKml(buf) {
    const dv = new DataView(buf);
    const td = new TextDecoder();
    let eocd = -1;
    const floor = Math.max(0, buf.byteLength - 65558);
    for (let i = buf.byteLength - 22; i >= floor; i--) {
        if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a KMZ (no zip directory)');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    for (let n = 0; n < count; n++) {
        const nameLen = dv.getUint16(p + 28, true);
        const name = td.decode(new Uint8Array(buf, p + 46, nameLen));
        if (/\.kml$/i.test(name)) {
            const method = dv.getUint16(p + 10, true);
            const compSize = dv.getUint32(p + 20, true);
            const lo = dv.getUint32(p + 42, true);
            // The local header repeats name/extra lengths and its extra field is
            // routinely a different size than the directory's — re-read it here.
            const start = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
            const raw = new Uint8Array(buf, start, compSize);
            if (method === 0) return td.decode(raw);
            if (method !== 8) throw new Error(`unsupported zip method ${method}`);
            const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
            return await new Response(stream).text();
        }
        p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
    }
    throw new Error('no .kml inside KMZ');
}

// "-86.2,28.8,0 -86.8,29.0,0" → [[lon,lat], ...]
const kmlCoords = el => (el && el.textContent || '').trim().split(/\s+/)
    .map(t => t.split(',').map(Number))
    .filter(c => c.length >= 2 && isFinite(c[0]) && isFinite(c[1]))
    .map(c => [c[0], c[1]]);

// <ExtendedData><Data name="x"><value>y</value> → { x: 'y' }
function kmlExtended(pm) {
    const d = {};
    pm.querySelectorAll('ExtendedData > Data').forEach(n => {
        const v = n.querySelector('value');
        d[n.getAttribute('name')] = v ? v.textContent.trim() : '';
    });
    return d;
}

// Forecast-point placemarks carry no ExtendedData — everything is in an HTML
// table inside <description>. Pull the fields the storm popup wants back out.
function parseKmlPointDesc(html) {
    const txt = String(html || '').replace(/<[^>]+>/g, '\n').replace(/&nbsp;/g, ' ');
    const grab = re => { const m = txt.match(re); return m ? m[1].trim() : ''; };
    const tau = txt.match(/(\d+)\s*hr\s*Forecast/i);
    return {
        tau: tau ? +tau[1] : 0,
        valid: grab(/Valid at:\s*([^\n]+)/i),
        maxwind: +grab(/Maximum Wind:\s*(\d+)\s*knots/i) || 0,
        gust: +grab(/Wind Gusts:\s*(\d+)\s*knots/i) || 0,
        mslp: +grab(/Minimum Pressure:\s*(\d+)\s*mb/i) || 0,
        motion: grab(/Motion:\s*([^\n]+?)\s*$/im)
    };
}

// Track-point icon style → ATCF-style class code the popup already understands.
// The x-prefixed icons are the post-tropical variants of each class.
const KML_PT_TYPE = { d: 'TD', s: 'TS', h: 'HU', m: 'HU', l: 'LO' };
function kmlPointType(styleUrl, stormType) {
    const m = String(styleUrl || '').match(/#(x?)([dshml])_point/i);
    if (!m) return stormType || '';
    return m[1] ? 'EX' : (KML_PT_TYPE[m[2].toLowerCase()] || stormType || '');
}

// One KMZ product (CONE | TRACK | WW) → features shaped exactly like the ones
// fetchNHCStorms builds from the MapServer, so layers and popups need no changes.
function kmlToFeatures(kind, kmlText) {
    const doc = new DOMParser().parseFromString(kmlText, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('bad KML');
    const pms = [...doc.querySelectorAll('Placemark')];
    // Storm metadata lives on whichever placemarks have ExtendedData; on TRACK
    // that's the line placemarks, so hoist it once and share it with the points.
    let meta = {};
    pms.forEach(pm => { const e = kmlExtended(pm); if (e.atcfid && !meta.atcfid) meta = e; });
    const name = meta.storm || meta.stormName || '';
    const isPTC = /potential tropical cyclone/i.test(name) ? 1 : 0;
    const base = {
        stormname: name,
        displayname: name.replace(/^Potential Tropical Cyclone\s*/i, 'PTC '),
        stormtype: meta.stormType || '',
        advisnum: meta.advisoryNum || '',
        advdate: meta.advisoryDate || '',
        atcfid: (meta.atcfid || '').toLowerCase(),
        isPTC, src: 'nhc'
    };
    const out = [];
    const push = (geometry, props) => out.push({ type: 'Feature', geometry, properties: { ...base, ...props } });

    pms.forEach(pm => {
        const styleUrl = (pm.querySelector('styleUrl') || {}).textContent || '';
        const poly = pm.querySelector('Polygon');
        const line = pm.querySelector('LineString');
        const point = pm.querySelector('Point');
        if (kind === 'CONE' && poly) {
            const outer = kmlCoords(poly.querySelector('outerBoundaryIs coordinates'));
            const holes = [...pm.querySelectorAll('innerBoundaryIs coordinates')].map(kmlCoords);
            if (outer.length > 2) push({ type: 'Polygon', coordinates: [outer, ...holes.filter(h => h.length > 2)] }, { layerType: 'cone' });
        } else if (kind === 'TRACK' && line) {
            // NHC ships both a 72 h and a 120 h line; keep only the longest so the
            // shorter one doesn't draw a second time on top of it.
            const c = kmlCoords(line);
            if (c.length > 1) push({ type: 'LineString', coordinates: c }, { layerType: 'track', fcstpd: +(kmlExtended(pm).fcstpd || 0) });
        } else if (kind === 'TRACK' && point) {
            const c = kmlCoords(point);
            const d = parseKmlPointDesc((pm.querySelector('description') || {}).textContent);
            if (c.length) push({ type: 'Point', coordinates: c[0] }, {
                layerType: 'point', tau: d.tau, maxwind: d.maxwind, gust: d.gust,
                mslp: d.mslp || 9999, fldatelbl: d.valid, motion: d.motion,
                stormtype: kmlPointType(styleUrl, meta.stormType)
            });
        } else if (kind === 'WW' && line) {
            const c = kmlCoords(line);
            const ww = (styleUrl.match(/#(TWA|TWR|HWA|HWR)/i) || [, ''])[1].toUpperCase();
            if (c.length > 1) push({ type: 'LineString', coordinates: c }, {
                layerType: 'warning', ww,
                wwLabel: ((pm.querySelector('name') || {}).textContent || '').trim()
            });
        }
    });
    if (kind === 'TRACK') {
        // Drop every forecast line except the longest-range one.
        const lines = out.filter(f => f.properties.layerType === 'track');
        if (lines.length > 1) {
            const keep = lines.reduce((a, b) => (b.properties.fcstpd > a.properties.fcstpd ? b : a));
            return out.filter(f => f.properties.layerType !== 'track' || f === keep);
        }
    }
    return out;
}

// Pull every active storm's KMZ straight from NHC and unzip it in the browser.
async function loadNhcKmlDirect() {
    const idxRes = await fetch(cacheBust(NHC_KML_INDEX));
    if (!idxRes.ok) throw new Error(`index HTTP ${idxRes.status}`);
    const idx = await idxRes.text();
    const urls = [...idx.matchAll(/<href>\s*([^<]+?)\s*<\/href>/g)].map(m => m[1])
        .filter(h => /storm_graphics\/api\/[^/]+adv_(CONE|TRACK|WW)\.kmz$/i.test(h));
    if (!urls.length) throw new Error('no storm graphics listed');
    return await Promise.all(urls.map(async url => {
        const res = await fetch(cacheBust(url));
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        return {
            kind: url.match(/adv_(CONE|TRACK|WW)\.kmz$/i)[1].toUpperCase(),
            lm: Date.parse(res.headers.get('last-modified') || '') || 0,
            kml: await unzipKml(await res.arrayBuffer())
        };
    }));
}

// Same products via our own proxy, for networks that can't reach nhc.noaa.gov
// directly. The proxy only fetches and unzips; parsing stays here either way.
async function loadNhcKmlProxied() {
    const res = await fetch('/api/adeck?gis=1');
    if (!res.ok) throw new Error(`proxy HTTP ${res.status}`);
    const json = await res.json();
    if (!json.products || !json.products.length) throw new Error('proxy returned no products');
    return json.products.map(p => ({ kind: p.kind, lm: Date.parse(p.modified || '') || 0, kml: p.kml }));
}

// Current cone/track/watches from NHC itself. Returns the same FeatureCollection
// shape as the MapServer path plus the oldest advisory-file timestamp, which is
// the honest freshness stamp for this source.
async function fetchNhcDirectStorms() {
    let raw;
    try {
        raw = await loadNhcKmlDirect();
    } catch (e) {
        addLiveLog(`NHC: direct KMZ fetch failed (${e.message}); trying proxy...`, '#ffb300');
        raw = await loadNhcKmlProxied();
    }
    const parts = raw.map(r => ({ kind: r.kind, lm: r.lm, feats: kmlToFeatures(r.kind, r.kml) }));

    const features = [];
    let oldest = 0;
    parts.forEach(p => {
        features.push(...p.feats);
        if (p.lm && (!oldest || p.lm < oldest)) oldest = p.lm;
    });
    if (!features.length) throw new Error('no features parsed');

    // Only the CONE product carries the advisory issuance time — share it with the
    // same storm's track/watch features so every popup can show "Issued:".
    const issued = {};
    features.forEach(f => { if (f.properties.advdate) issued[f.properties.atcfid] = f.properties.advdate; });
    features.forEach(f => { if (!f.properties.advdate) f.properties.advdate = issued[f.properties.atcfid] || ''; });

    return { data: { type: 'FeatureCollection', features }, issuedMs: oldest, count: parts.length };
}

// NOAA's tropical MapServer — the primary source. It answers for every storm in
// one round trip and carries ingest timestamps, so it stays primary; when its
// advisory numbers fall behind NHC's, fetchNHCStorms fails over to NHC-direct.
async function fetchNoaaTropicalGis() {
    const combined = { type: 'FeatureCollection', features: [] };

    // Cache-bust so each poll gets the latest advisory, not a cached copy
    const [coneRes, trackRes, pointsRes, warnRes] = await Promise.all([
        fetch(cacheBust(`${NHC_BASE}/7/query?where=1%3D1&outFields=*&f=geojson`)),
        fetch(cacheBust(`${NHC_BASE}/6/query?where=1%3D1&outFields=*&f=geojson`)),
        fetch(cacheBust(`${NHC_BASE}/5/query?where=1%3D1&outFields=*&f=geojson`)),
        fetch(cacheBust(`${NHC_BASE}/8/query?where=1%3D1&outFields=*&f=geojson`))
    ]);

    const [coneData, trackData, pointsData, warnData] = await Promise.all([
        coneRes.json(), trackRes.json(), pointsRes.json(), warnRes.json()
    ]);

    // Flag Potential Tropical Cyclones so they can be labeled/styled distinctly
    const isPTCName = n => /potential tropical cyclone/i.test(n || '');
    const shortName = n => (n || '').replace(/^Potential Tropical Cyclone\s*/i, 'PTC ');

    (coneData.features || []).forEach(f => {
        f.properties.layerType = 'cone';
        f.properties.isPTC = isPTCName(f.properties.STORMNAME || f.properties.stormname) ? 1 : 0;
        combined.features.push(f);
    });
    (trackData.features || []).forEach(f => {
        f.properties.layerType = 'track';
        f.properties.isPTC = isPTCName(f.properties.STORMNAME || f.properties.stormname) ? 1 : 0;
        combined.features.push(f);
    });
    (pointsData.features || []).forEach(f => {
        f.properties.layerType = 'point';
        f.properties.maxwind = f.properties.MAXWIND || f.properties.maxwind || 0;
        f.properties.stormname = f.properties.STORMNAME || f.properties.stormname || 'UNKNOWN';
        f.properties.isPTC = isPTCName(f.properties.stormname) ? 1 : 0;
        f.properties.displayname = shortName(f.properties.stormname);
        combined.features.push(f);
    });
    (warnData.features || []).forEach(f => {
        f.properties.layerType = 'warning';
        f.properties.isPTC = isPTCName(f.properties.STORMNAME || f.properties.stormname) ? 1 : 0;
        combined.features.push(f);
    });

    // Cross-check the GIS service against NHC's authoritative CurrentStorms.json.
    // NOAA's tropical MapServer ingest can stall for many hours (observed ~22 h)
    // and would otherwise keep drawing a day-old cone under a "LIVE" badge.
    nhcGisAdv = {};
    (pointsData.features || []).forEach(f => {
        const a = f.properties;
        const bin = a.binnumber || a.BINNUMBER;
        if (!bin || nhcGisAdv[bin]) return;
        nhcGisAdv[bin] = {
            adv: a.advisnum || a.ADVISNUM || '', advdate: a.advdate || a.ADVDATE || '',
            ingestMs: +(a.idp_ingestdate || a.idp_filedate || 0) || 0
        };
    });
    // Freshness stamp = oldest ingest among storms NHC still lists as active.
    // A dissipated storm can linger in the GIS feed and would otherwise drag
    // the stamp red forever.
    const officialBins = new Set(nhcAdvStorms.map(s => s.bin));
    let oldestIngest = 0;
    Object.entries(nhcGisAdv).forEach(([bin, g]) => {
        if (officialBins.size && !officialBins.has(bin)) return;
        if (g.ingestMs && (!oldestIngest || g.ingestMs < oldestIngest)) oldestIngest = g.ingestMs;
    });
    const stale = {};
    nhcAdvStorms.forEach(s => {
        const g = nhcGisAdv[s.bin];
        const off = (s.products && s.products.tcp) ? s.products.tcp.adv : '';
        if (!g || !off || normAdv(g.adv) === normAdv(off)) return;
        stale[s.bin] = {
            gisAdv: g.adv, gisDate: g.advdate, officialAdv: normAdv(off),
            name: s.name, cls: s.class, issued: s.products.tcp.issued
        };
    });
    const names = [...new Set((pointsData.features || []).map(f => f.properties.STORMNAME || f.properties.stormname).filter(Boolean))];
    return { data: combined, stale, oldestIngest, names };
}

function setNhcStormData(data) {
    Object.values(maps).forEach(m => {
        if (m.getSource('nhc-storms')) m.getSource('nhc-storms').setData(data);
    });
}

function setNhcStormBadge(text, cls, title) {
    const b = document.getElementById('nhc-storms-badge');
    if (!b) return;
    b.textContent = text;
    b.className = `badge ${cls}`;
    b.title = title || '';
}

async function fetchNHCStorms(show) {
    if (!show) { updateSidebarToActivePane(); return; }

    addLiveLog('NHC: Fetching active tropical cyclones...', '#ff6600');
    let noaa = null, noaaErr = '';
    try {
        noaa = await fetchNoaaTropicalGis();
    } catch (e) {
        noaaErr = e.message;
    }

    const staleList = noaa ? Object.values(noaa.stale) : [];
    // Fail over whenever the mirror is behind NHC or unreachable. NHC publishes
    // the same geometry itself, so a stalled mirror should never cost us the cone.
    if (noaa && !staleList.length) {
        nhcGisStaleBins = noaa.stale;
        nhcStormSource = 'noaa';
        setNhcStormData(noaa.data);
        setNhcStormBadge('LIVE', 'red');
        updateHealth('nhcStorms', noaa.oldestIngest || undefined);
        addLiveLog(noaa.names.length
            ? `NHC: Tracking ${noaa.names.length} storm(s): ${noaa.names.join(', ')}`
            : 'NHC: No active tropical cyclones', noaa.names.length ? '#ff6600' : '#888');
        return;
    }

    const why = noaa
        ? `NOAA GIS mirror is behind NHC — ${staleList.map(s => `${s.name}: map adv #${s.gisAdv} (${s.gisDate}), official #${s.officialAdv}`).join('; ')}`
        : `NOAA GIS mirror unreachable (${noaaErr})`;
    addLiveLog(`NHC: ${why}. Failing over to NHC-direct advisory graphics...`, '#ffb300');

    try {
        const direct = await fetchNhcDirectStorms();
        nhcGisStaleBins = {};          // nothing on screen is out of date anymore
        nhcStormSource = 'nhc';
        setNhcStormData(direct.data);
        const advs = [...new Set(direct.data.features.map(f => `${f.properties.stormname} #${f.properties.advisnum}`))];
        setNhcStormBadge('NHC DIRECT', 'green',
            `Cone/track pulled straight from NHC's advisory graphics because the NOAA GIS mirror is behind. Showing ${advs.join(', ')}.`);
        updateHealth('nhcStorms', direct.issuedMs || undefined);
        addLiveLog(`NHC: Using NHC-direct graphics — ${advs.join(', ')}`, '#00cc66');
    } catch (e) {
        // Both sources are gone. Keep whatever the mirror gave us, but say plainly
        // that it is out of date rather than presenting it as current.
        if (noaa) {
            nhcGisStaleBins = noaa.stale;
            nhcStormSource = 'noaa';
            setNhcStormData(noaa.data);
            updateHealth('nhcStorms', noaa.oldestIngest || undefined);
        }
        setNhcStormBadge('STALE', 'orange', `${why}. NHC-direct failover also failed: ${e.message}`);
        addLiveLog(`NHC STORMS ERROR: NHC-direct failover failed (${e.message}). ${noaa ? 'Map is showing the stale mirror.' : 'No cone/track data available.'}`, '#ff3333');
    }
}

async function fetchNHCOutlook(show) {
    if (!show) { updateSidebarToActivePane(); return; }

    addLiveLog('NHC: Fetching tropical outlook areas...', '#ffcc00');
    try {
        const [twoDay, sevenDay] = await Promise.all([
            fetch(cacheBust(`${NHC_BASE}/1/query?where=1%3D1&outFields=*&f=geojson`)).then(r => r.json()),
            fetch(cacheBust(`${NHC_BASE}/3/query?where=1%3D1&outFields=*&f=geojson`)).then(r => r.json())
        ]);

        const combined = { type: 'FeatureCollection', features: [] };
        (sevenDay.features || []).forEach(f => {
            f.properties.basin = f.properties.basin || f.properties.BASIN || '';
            f.properties.prob2day = f.properties.prob2day || f.properties.PROB2DAY || '0%';
            f.properties.prob7day = f.properties.prob7day || f.properties.PROB7DAY || '0%';
            f.properties.risk2day = f.properties.RISK2DAY || f.properties.risk2day || 0;
            f.properties.risk7day = f.properties.RISK7DAY || f.properties.risk7day || 0;
            combined.features.push(f);
        });

        Object.values(maps).forEach(m => {
            if (m.getSource('nhc-outlook')) m.getSource('nhc-outlook').setData(combined);
        });
        updateHealth('nhcOutlook');
        addLiveLog(`NHC: ${combined.features.length} outlook areas loaded`, '#ffcc00');
    } catch (e) {
        addLiveLog(`NHC OUTLOOK ERROR: ${e.message}`, '#ff3333');
    }
}

async function fetchNHCDiscussion(basin) {
    const endpoint = basin === 'atl' ? '/api/nhc-two-atl' : '/api/nhc-two-epac';
    const label = basin === 'atl' ? 'Atlantic' : 'Eastern Pacific';

    addLiveLog(`NHC: Fetching ${label} TWO...`, '#ffcc00');
    try {
        const res = await fetch(endpoint);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();

        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        // Get all <pre> tags - NHC pages may have multiple (English + Spanish link)
        const preTags = doc.querySelectorAll('pre');
        let text = '';

        for (const pre of preTags) {
            const content = pre.textContent.trim();
            // Look for English identifiers: TWOAT, TWOEP (not TWSAT, TWSEP which are Spanish)
            // Also check for "Tropical Weather Outlook" (English) vs "Perspectiva" (Spanish)
            if (content.includes('Tropical Weather Outlook') ||
                content.includes('TWOAT') || content.includes('TWOEP') ||
                content.includes('ABNT20') || content.includes('ABPZ20')) {
                // Verify it's NOT the Spanish version
                if (!content.includes('Perspectiva') && !content.includes('TWSAT') && !content.includes('TWSEP') && !content.includes('ABNT21') && !content.includes('ABPZ21')) {
                    text = content;
                    break;
                }
            }
        }

        // Fallback: use first <pre> tag content, stripping any "en Español" link text
        if (!text && preTags.length > 0) {
            text = preTags[0].textContent.trim();
        }
        if (!text) text = doc.body.textContent.trim();

        // Clean up: remove the "en Español" link text that appears at the top
        text = text.replace(/^en Español\s*/i, '').trim();

        const panel = document.getElementById('text-panel');
        const contentEl = document.getElementById('text-product-content');
        if (panel && contentEl) {
            contentEl.innerHTML = `<div style="font-family:'Courier New',monospace;font-size:12px;color:#ffcc00;line-height:1.6;white-space:pre-wrap;">${text.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`;
            panel.style.display = 'flex';
        }
        addLiveLog(`NHC: ${label} TWO loaded`, '#00ff88');
    } catch (e) {
        addLiveLog(`NHC TWO ERROR: ${e.message}`, '#ff3333');
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 8e: DROUGHT MONITOR
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchDroughtMonitor(show) {
    if (!show) { updateSidebarToActivePane(); return; }

    addLiveLog('DROUGHT: Fetching US Drought Monitor...', '#ff9900');
    try {
        const res = await fetch('/api/drought-monitor');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        if (data.error) throw new Error(data.error);

        const geojson = data.type === 'FeatureCollection' ? data : { type: 'FeatureCollection', features: data.features || [] };

        geojson.features.forEach(f => {
            const dm = f.properties.DM ?? f.properties.dm;
            if (dm != null) f.properties.dm = parseInt(dm);
        });

        Object.values(maps).forEach(m => {
            if (m.getSource('drought-monitor')) m.getSource('drought-monitor').setData(geojson);
        });
        updateHealth('drought');
        addLiveLog(`DROUGHT: ${geojson.features.length} regions loaded`, '#00ff88');
    } catch (e) {
        addLiveLog(`DROUGHT ERROR: ${e.message}`, '#ff3333');
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 9: AQI MONITORS
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchAQI(show) {
    if (!show) {
        updateSidebarToActivePane();
        return;
    }

    addLiveLog('AQI: Fetching AirNow monitor data...', '#00e5ff');
    try {
        // Time filter: only fetch data from the last 2 hours to ensure we get the latest reporting cycle
        // AirNow updates hourly; ValidTime is in epoch ms
        const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
        const timeFilter = encodeURIComponent(`CountryCode='US' AND ValidTime >= ${twoHoursAgo}`);

        let res = await fetch(`https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/Air_Now_Monitor_Data_Public/FeatureServer/0/query?where=${timeFilter}&orderByFields=ValidTime+DESC&outFields=*&f=geojson&outSR=4326&resultRecordCount=8000`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        let data = await res.json();

        // If primary service returns 0 features (backend maintenance/clearing), failover to active mirror
        if (!data || !data.features || data.features.length === 0) {
            addLiveLog('AQI: Primary table empty, failing over to secondary AirNow mirror...', '#ffaa00');
            res = await fetch('https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/Air_Now_Monitors_Ozone_and_PM/FeatureServer/0/query?where=1%3D1&orderByFields=ValidTime+DESC&outFields=*&f=geojson&outSR=4326&resultRecordCount=8000');
            if (res.ok) {
                data = await res.json();
            }
        }

        // Determine the most recent ValidTime in the dataset (latest reporting hour)
        let latestHour = 0;
        (data.features || []).forEach(f => {
            const vt = f.properties?.ValidTime || f.properties?.VALID_TIME || 0;
            if (vt > latestHour) latestHour = vt;
        });

        // Deduplicate: keep only the most recent observation per site
        // Prefer records from the latest hour
        const seenSites = new Set();
        const filtered = {
            type: 'FeatureCollection',
            features: (data.features || []).filter(f => {
                if (!f.geometry || f.geometry.type !== 'Point') return false;
                const coords = f.geometry.coordinates;
                if (!coords || coords.length < 2 || coords[0] === 0 || coords[1] === 0) return false;
                const p = f.properties;
                // Check for raw concentrations (preferred) or fallback to NowCast AQI fields
                const hasOzone = (p.OZONE != null && p.OZONE >= 0) || (p.OZONE_AQI != null && p.OZONE_AQI >= 0);
                const hasPm = (p.PM25 != null && p.PM25 >= 0) || (p.PM25_AQI != null && p.PM25_AQI >= 0);
                if (!hasOzone && !hasPm) return false;
                const site = p.SiteName || p.SITE_NAME || `${coords[0]},${coords[1]}`;
                if (seenSites.has(site)) return false;
                seenSites.add(site);
                return true;
            }).map(f => {
                const p = f.properties;
                // Convert raw hourly concentrations to AQI using EPA breakpoints (NOT NowCast)
                const ozoneRaw = p.OZONE ?? null;
                const pm25Raw = p.PM25 ?? null;
                const ozoneAqi = concToAqi(ozoneRaw, 'ozone');
                const pm25Aqi = concToAqi(pm25Raw, 'pm25');
                const aqi = Math.max(ozoneAqi, pm25Aqi, 0);
                return {
                    type: 'Feature',
                    geometry: f.geometry,
                    properties: {
                        aqi,
                        ozone_aqi: ozoneAqi >= 0 ? ozoneAqi : null,
                        pm25_aqi: pm25Aqi >= 0 ? pm25Aqi : null,
                        ozone_ppb: ozoneRaw,
                        pm25_ugm3: pm25Raw,
                        site_name: p.SiteName || p.SITE_NAME || 'Unknown',
                        valid_time: p.ValidTime || p.VALID_TIME || p.ValidDate || ''
                    }
                };
            })
        };

        // Report the data hour to the user
        const dataHourStr = latestHour ? new Date(latestHour).toISOString().substring(11, 16) + 'Z' : 'unknown';

        Object.values(maps).forEach(m => {
            if (m.getSource('airnow-aqi')) m.getSource('airnow-aqi').setData(filtered);
        });
        updateHealth('aqi');
        addLiveLog(`AQI: ${filtered.features.length} monitors loaded (latest hour: ${dataHourStr})`, '#00ff88');
    } catch (e) {
        addLiveLog(`AQI ERROR: ${e.message}`, '#ff3333');
    }
}

// AirNow issues area AQI forecasts (today + tomorrow) for O3 & PM2.5. Keyless
// ArcGIS service; point-intersect the forecast polygon containing a monitor.
// Returns { today, tomorrow } attribute objects (null per-day if none), or
// null if no forecast area covers the point.
const AQI_FCST_BASE = 'https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/AirNow_National_Air_Quality_Index_(AQI)_Forecast/FeatureServer';
async function fetchAqiForecast(lon, lat) {
    const fields = 'RAName,RAAgency,O3AQI,O3AQICat,PM25AQI,PM25AQICat,MaxAQI,MaxAQICat,ActionDay';
    const q = `geometry=${lon},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects` +
              `&outFields=${fields}&returnGeometry=false&f=json`;
    try {
        const [t0, t1] = await Promise.all([
            fetch(`${AQI_FCST_BASE}/0/query?${q}`).then(r => r.json()),
            fetch(`${AQI_FCST_BASE}/1/query?${q}`).then(r => r.json())
        ]);
        const a0 = t0.features && t0.features[0] ? t0.features[0].attributes : null;
        const a1 = t1.features && t1.features[0] ? t1.features[0].attributes : null;
        if (!a0 && !a1) return null;
        return { today: a0, tomorrow: a1 };
    } catch (e) {
        return null;
    }
}

// One forecast day row (O3 + PM2.5). AirNow uses '-1'/'' when a pollutant
// isn't forecast for the area — show the category alone, or a dash.
function aqiForecastDayHtml(label, a) {
    if (!a) return `<div style="color:#666;">${label}: N/A</div>`;
    const cell = (aqi, cat) => {
        const n = parseInt(aqi, 10);
        if (!isNaN(n) && n >= 0) return `<span style="color:${aqiColor(n)};font-weight:bold;">${n}</span> <span style="color:${aqiColor(n)};">${cat || ''}</span>`;
        return cat ? `<span style="color:${aqiCatColor(cat)};">${cat}</span>` : '<span style="color:#666;">—</span>';
    };
    const action = (a.ActionDay === '1' || a.ActionDay === 1)
        ? ` <span style="color:#ff5252;font-weight:bold;">⚠ ACTION DAY</span>` : '';
    return `<div style="margin-bottom:3px;">
        <span style="color:#cfd8e3;font-weight:bold;">${label}${action}</span>
        <div style="display:grid;grid-template-columns:auto 1fr;gap:1px 8px;margin-left:8px;">
            <span style="color:#888;">O₃:</span><span>${cell(a.O3AQI, a.O3AQICat)}</span>
            <span style="color:#888;">PM2.5:</span><span>${cell(a.PM25AQI, a.PM25AQICat)}</span>
        </div>
    </div>`;
}

function renderAqiForecast(fc) {
    if (!fc || (!fc.today && !fc.tomorrow)) {
        return `<div style="color:#666;font-size:10px;">No AQI forecast issued for this area.</div>`;
    }
    const ra = (fc.today || fc.tomorrow).RAName || '';
    return `<div style="border-top:1px solid #333;margin-top:6px;padding-top:5px;">
        <div style="color:#00e5ff;font-weight:bold;font-size:10px;margin-bottom:3px;">AQI FORECAST${ra ? ` — ${ra}` : ''}</div>
        ${aqiForecastDayHtml('Today', fc.today)}
        ${aqiForecastDayHtml('Tomorrow', fc.tomorrow)}
    </div>`;
}

async function fetchFIRMS(show) {
    if (!show) {
        updateSidebarToActivePane();
        return;
    }
    addLiveLog('FIRMS: Fetching VIIRS + MODIS fire detections...', '#ff6600');
    try {
        // Geographic filter — North America (CONUS + Alaska + Canada + Mexico + Caribbean)
        // Ensures the record limit isn't wasted on distant fires (Africa, S. America, etc.)
        const viirsGeo = encodeURIComponent('latitude > 10 AND latitude < 72 AND longitude > -180 AND longitude < -50');
        const modisGeo = encodeURIComponent('LATITUDE > 10 AND LATITUDE < 72 AND LONGITUDE > -180 AND LONGITUDE < -50');

        const [viirsRes, modisRes] = await Promise.allSettled([
            fetch(`https://services9.arcgis.com/RHVPKKiFTONKtxq3/arcgis/rest/services/Satellite_VIIRS_Thermal_Hotspots_and_Fire_Activity/FeatureServer/0/query?where=esritimeutc+%3E+CURRENT_TIMESTAMP+-+1+AND+${viirsGeo}&outFields=*&f=geojson&outSR=4326&resultRecordCount=10000`).then(r => { if (!r.ok) throw new Error(`VIIRS HTTP ${r.status}`); return r.json(); }),
            fetch(`https://services9.arcgis.com/RHVPKKiFTONKtxq3/arcgis/rest/services/MODIS_Thermal_v1/FeatureServer/0/query?where=ACQ_DATE+%3E+CURRENT_TIMESTAMP+-+2+AND+${modisGeo}&outFields=*&f=geojson&outSR=4326&resultRecordCount=5000`).then(r => { if (!r.ok) throw new Error(`MODIS HTTP ${r.status}`); return r.json(); })
        ]);

        const allFeatures = [];
        let vCount = 0, mCount = 0;

        // ─── Process VIIRS (Suomi-NPP, NOAA-20, NOAA-21) ───
        if (viirsRes.status === 'fulfilled' && viirsRes.value) {
            const feats = (viirsRes.value.features || []).filter(f => f.geometry?.type === 'Point');
            vCount = feats.length;
            feats.forEach(f => {
                const p = f.properties;
                const satName = p.satellite === 'N' ? 'Suomi-NPP' : p.satellite === 'N20' ? 'NOAA-20' : p.satellite === 'N21' ? 'NOAA-21' : `VIIRS (${p.satellite || '?'})`;
                allFeatures.push({
                    type: 'Feature', geometry: f.geometry,
                    properties: {
                        confidence: p.confidence === 'high' ? 90 : p.confidence === 'nominal' ? 50 : 20,
                        bright_ti4: p.bright_ti4 || '', frp: p.frp || '',
                        acq_datetime: p.esritimeutc ? new Date(p.esritimeutc).toISOString() : '',
                        satellite: satName, sensor: 'VIIRS'
                    }
                });
            });
        } else {
            addLiveLog(`FIRMS: VIIRS fetch failed — ${viirsRes.reason?.message || 'unknown error'}`, '#ff9900');
        }

        // ─── Process MODIS (Terra / Aqua) ───
        if (modisRes.status === 'fulfilled' && modisRes.value) {
            const feats = (modisRes.value.features || []).filter(f => f.geometry?.type === 'Point');
            mCount = feats.length;
            feats.forEach(f => {
                const p = f.properties;
                const satName = p.SATELLITE === 'T' ? 'Terra' : p.SATELLITE === 'A' ? 'Aqua' : `MODIS (${p.SATELLITE || '?'})`;
                allFeatures.push({
                    type: 'Feature', geometry: f.geometry,
                    properties: {
                        confidence: typeof p.CONFIDENCE === 'number' ? p.CONFIDENCE : 50,
                        bright_ti4: p.BRIGHTNESS || '', frp: p.FRP || '',
                        acq_datetime: p.ACQ_DATE ? new Date(p.ACQ_DATE).toISOString() : '',
                        satellite: satName, sensor: 'MODIS'
                    }
                });
            });
        } else {
            addLiveLog(`FIRMS: MODIS fetch failed — ${modisRes.reason?.message || 'unknown error'}`, '#ff9900');
        }

        const fc = { type: 'FeatureCollection', features: allFeatures };
        Object.values(maps).forEach(m => {
            if (m.getSource('firms-fires')) m.getSource('firms-fires').setData(fc);
        });
        updateHealth('firms');
        addLiveLog(`FIRMS: ${allFeatures.length} fire detections loaded (VIIRS: ${vCount} + MODIS: ${mCount})`, '#00ff88');
    } catch (e) {
        addLiveLog(`FIRMS ERROR: ${e.message}`, '#ff3333');
    }
}

// ─── NWS River Gauges (NWPS API) ───
let riverGaugeCache = null;
let riverGaugeCacheTime = 0;
const RIVER_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

async function fetchRiverGauges(show, prefetch) {
    if (!show && !prefetch) { updateSidebarToActivePane(); return; }
    addLiveLog('RIVERS: Fetching national river gauge data...', '#00aaff');

    try {
        const now = Date.now();
        let gauges;

        // Use cache if fresh (15 min TTL) and non-empty
        if (riverGaugeCache && riverGaugeCache.length > 0 && (now - riverGaugeCacheTime) < RIVER_CACHE_TTL) {
            gauges = riverGaugeCache;
            addLiveLog(`RIVERS: Using cached data (${gauges.length} gauges)`, '#888');
        } else {
            // Use NOAA EventDriven MapServer — fast (2-3s), has CORS, pre-filtered GeoJSON
            // This replaces the slow NWPS API (60s+) and eliminates need for Vercel proxy
            const gaugeUrl = 'https://mapservices.weather.noaa.gov/eventdriven/rest/services/water/riv_gauges/MapServer/0/query' +
                '?where=status+NOT+IN+(%27out_of_service%27%2C%27not_defined%27%2C%27obs_not_current%27%2C%27%27)' +
                '&outFields=gaugelid,status,waterbody,location,observed,units,latitude,longitude,state' +
                '&f=geojson&resultRecordCount=10000';
            const res = await fetch(gaugeUrl);
            if (!res.ok) throw new Error(`MapServer HTTP ${res.status}`);
            const data = await res.json();

            // Map MapServer fields to our internal format
            gauges = (data.features || []).map(f => {
                const p = f.properties || {};
                return {
                    id: (p.gaugelid || '').toLowerCase(),
                    n: p.location || p.waterbody || p.gaugelid || '',
                    la: p.latitude || f.geometry?.coordinates?.[1] || 0,
                    lo: p.longitude || f.geometry?.coordinates?.[0] || 0,
                    oc: p.status || 'no_flooding',
                    fc: '',  // Forecast not in this endpoint (available in layers 1-15)
                    os: parseFloat(p.observed) || -999,
                    fs: -999,
                    ou: p.units || 'ft'
                };
            }).filter(g => g.la && g.lo);

            riverGaugeCache = gauges;
            riverGaugeCacheTime = now;
        }

        // Build GeoJSON for map
        const features = gauges.map(g => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [g.lo, g.la] },
            properties: {
                id: g.id, name: g.n,
                oc: g.oc, fc: g.fc,
                os: g.os, fs: g.fs,
                ou: g.ou || 'ft'
            }
        }));

        const fc = { type: 'FeatureCollection', features };
        Object.values(maps).forEach(m => {
            if (m.getSource('river-gauges')) m.getSource('river-gauges').setData(fc);
        });

        // Count flooding gauges
        const flooding = gauges.filter(g => ['action', 'minor', 'moderate', 'major'].includes(g.oc));
        const majorCount = gauges.filter(g => g.oc === 'major').length;
        const modCount = gauges.filter(g => g.oc === 'moderate').length;
        const minorCount = gauges.filter(g => g.oc === 'minor').length;
        const actionCount = gauges.filter(g => g.oc === 'action').length;

        updateHealth('riverGauges');
        addLiveLog(`RIVERS: ${features.length} gauges loaded — ${flooding.length} flooding (${majorCount} major, ${modCount} mod, ${minorCount} minor, ${actionCount} action)`, '#00ff88');
    } catch (e) {
        addLiveLog(`RIVERS ERROR: ${e.message}`, '#ff3333');
    }
}

async function showGaugeDetail(gaugeId, lngLat, originalEvent) {
    try {
        const res = await fetch(`https://api.water.noaa.gov/nwps/v1/gauges/${gaugeId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const g = await res.json();

        const obs = g.status?.observed || {};
        const fcst = g.status?.forecast || {};
        const cats = g.flood?.categories || {};
        const images = g.images?.hydrograph || {};

        const catLabel = (cat) => {
            if (!cat) return '--';
            return cat.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        };
        const stageBar = (val, cats) => {
            if (!val || val <= 0) return '';
            const major = cats.major?.stage;
            const moderate = cats.moderate?.stage;
            const minor = cats.minor?.stage;
            const action = cats.action?.stage;
            let color = '#00cc00';
            if (major && val >= major) color = '#ff00ff';
            else if (moderate && val >= moderate) color = '#ff0000';
            else if (minor && val >= minor) color = '#ff8800';
            else if (action && val >= action) color = '#ffff00';
            return color;
        };

        const obsColor = stageBar(obs.primary, cats);
        const fcstColor = stageBar(fcst.primary, cats);

        const locStr = `${Math.abs(g.latitude).toFixed(3)}°${g.latitude >= 0 ? 'N' : 'S'}, ${Math.abs(g.longitude).toFixed(3)}°${g.longitude >= 0 ? 'E' : 'W'}`;
        const wfo = g.wfo?.abbreviation || '';

        let html = `
            <div style="color:#88ccff; font-size:9px; margin-bottom:2px; font-weight:bold;">${esc(g.name || gaugeId)}</div>
            <div style="color:#777; font-size:8px; margin-bottom:6px;">${locStr} | WFO: ${esc(wfo)} | ID: ${esc(g.lid)}</div>
            <table style="border-collapse:collapse; width:100%; margin-bottom:6px;">
                <tr style="color:#00e5ff; font-size:8px; text-transform:uppercase; letter-spacing:0.5px;">
                    <td style="padding:1px 6px 3px 0;"></td>
                    <td style="padding:1px 6px 3px 0;">Stage</td>
                    <td style="padding:1px 0 3px 0;">Category</td>
                </tr>
                <tr>
                    <td style="color:#aaa; padding:2px 6px 2px 0;">Observed</td>
                    <td style="padding:2px 6px; color:${obsColor}; font-weight:bold;">${obs.primary > 0 ? obs.primary + ' ' + (obs.primaryUnit || 'ft') : '--'}</td>
                    <td style="color:${obsColor};">${catLabel(obs.floodCategory)}</td>
                </tr>
                <tr>
                    <td style="color:#aaa; padding:2px 6px 2px 0;">Forecast</td>
                    <td style="padding:2px 6px; color:${fcstColor}; font-weight:bold;">${fcst.primary > 0 ? fcst.primary + ' ' + (fcst.primaryUnit || 'ft') : '--'}</td>
                    <td style="color:${fcstColor};">${catLabel(fcst.floodCategory)}</td>
                </tr>
            </table>`;

        // Flood categories table
        if (cats.action || cats.minor || cats.moderate || cats.major) {
            html += `<div style="border-top:1px solid rgba(0,229,255,0.15); padding-top:4px; margin-bottom:4px;">
                <span style="color:#00e5ff; font-size:8px; text-transform:uppercase; letter-spacing:0.5px;">Flood Stages</span>
            </div>
            <table style="border-collapse:collapse; width:100%; margin-bottom:6px; font-size:9.5px;">`;
            if (cats.action?.stage > 0) html += `<tr><td style="color:#ffff00; padding:1px 6px 1px 0;">Action</td><td>${cats.action.stage} ft</td></tr>`;
            if (cats.minor?.stage > 0) html += `<tr><td style="color:#ff8800; padding:1px 6px 1px 0;">Minor</td><td>${cats.minor.stage} ft</td></tr>`;
            if (cats.moderate?.stage > 0) html += `<tr><td style="color:#ff0000; padding:1px 6px 1px 0;">Moderate</td><td>${cats.moderate.stage} ft</td></tr>`;
            if (cats.major?.stage > 0) html += `<tr><td style="color:#ff00ff; padding:1px 6px 1px 0;">Major</td><td>${cats.major.stage} ft</td></tr>`;
            html += '</table>';
        }

        // Native observed+forecast hydrograph (rendered async from the NWPS stageflow
        // series). Falls back to the AHPS image if the series can't be drawn.
        html += `<div style="border-top:1px solid rgba(0,229,255,0.15); padding-top:4px; margin-bottom:3px;">
                <span style="color:#00e5ff; font-size:8px; text-transform:uppercase; letter-spacing:0.5px;">Hydrograph — Observed + Forecast</span>
            </div>
            <div id="hydro-chart-slot" data-img="${esc(images.default || '')}" style="width:100%; min-height:150px; color:#6b7a88; font-size:10px;">Loading stage/flow series…</div>`;

        // Link to the gauge's official page. This must point at NWPS
        // (water.noaa.gov): the old AHPS site — water.weather.gov/ahps2/ — was
        // retired with the NWPS cutover and no longer resolves at all, so the
        // link failed to connect rather than 404ing. NWPS keys pages by LID.
        const lid = (g.lid || gaugeId || '').toUpperCase();
        html += `<div style="margin-top:4px;"><a href="https://water.noaa.gov/gauges/${encodeURIComponent(lid)}" target="_blank" rel="noopener noreferrer" style="color:#00e5ff; font-size:8px; text-decoration:none;">Open on water.noaa.gov (NWPS) &rarr;</a></div>`;

        const panel = document.getElementById('river-gauge-panel');
        const body = document.getElementById('river-gauge-body');
        if (panel && body) {
            body.innerHTML = html;
            const px = (originalEvent?.pageX || 400) + 15;
            const py = (originalEvent?.pageY || 200) - 100;
            panel.style.left = Math.min(px, window.innerWidth - 480) + 'px';
            panel.style.top = Math.max(10, Math.min(py, window.innerHeight - 500)) + 'px';
            panel.style.display = 'block';
            renderGaugeHydrograph(gaugeId, cats);
        }
    } catch (e) {
        addLiveLog(`GAUGE DETAIL ERROR: ${e.message}`, '#ff3333');
    }
}

// Fetch the NWPS stage/flow series and draw a compact observed+forecast hydrograph
// with flood-category threshold lines. CORS-clean, so no proxy needed.
async function renderGaugeHydrograph(gaugeId, cats) {
    const slot = document.getElementById('hydro-chart-slot');
    if (!slot) return;
    try {
        const res = await fetch(`https://api.water.noaa.gov/nwps/v1/gauges/${encodeURIComponent(gaugeId)}/stageflow`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const sf = await res.json();
        const parse = arr => (arr || [])
            .map(d => ({ t: new Date(d.validTime).getTime(), v: d.primary }))
            .filter(d => isFinite(d.t) && typeof d.v === 'number' && d.v > -900);
        const now = Date.now();
        const obs = parse(sf.observed?.data).filter(d => d.t >= now - 3 * 864e5 && d.t <= now + 36e5);
        const fcst = parse(sf.forecast?.data);
        const unit = sf.observed?.primaryUnits || sf.forecast?.primaryUnits || 'ft';
        if (obs.length < 2 && fcst.length < 2) throw new Error('no series');

        const svg = buildHydrographSVG(obs, fcst, cats, unit, now);
        slot.innerHTML = svg;
        slot.style.color = '';
    } catch (e) {
        // Fall back to the AHPS-rendered image if we have one. The hide-on-error
        // handler is attached rather than inlined so script-src can stay strict.
        const img = slot.getAttribute('data-img');
        if (img) {
            slot.innerHTML = '';
            const el = document.createElement('img');
            el.src = img;
            el.style.cssText = 'width:100%; max-width:420px; border-radius:3px; border:1px solid rgba(0,229,255,0.15);';
            el.addEventListener('error', () => { el.style.display = 'none'; });
            slot.appendChild(el);
        } else {
            slot.innerHTML = `<span style="color:#6b7a88;">Hydrograph unavailable.</span>`;
        }
    }
}

function buildHydrographSVG(obs, fcst, cats, unit, now) {
    const W = 420, H = 158, mL = 34, mR = 10, mT = 10, mB = 20;
    const all = obs.concat(fcst);
    const tMin = Math.min(...all.map(d => d.t));
    const tMax = Math.max(...all.map(d => d.t));
    const thr = ['action', 'minor', 'moderate', 'major']
        .map(k => cats?.[k]?.stage).filter(v => v > 0);
    let vMin = Math.min(...all.map(d => d.v));
    let vMax = Math.max(...all.map(d => d.v), ...thr);
    const pad = (vMax - vMin) * 0.12 || 1;
    vMin -= pad; vMax += pad;
    const x = t => mL + (tMax === tMin ? 0 : (t - tMin) / (tMax - tMin)) * (W - mL - mR);
    const y = v => mT + (1 - (vMax === vMin ? 0.5 : (v - vMin) / (vMax - vMin))) * (H - mT - mB);
    const path = pts => pts.map((d, i) => `${i ? 'L' : 'M'}${x(d.t).toFixed(1)},${y(d.v).toFixed(1)}`).join(' ');

    const thrLines = [['action', '#ffff00'], ['minor', '#ff8800'], ['moderate', '#ff3b3b'], ['major', '#ff2bd0']]
        .map(([k, c]) => {
            const s = cats?.[k]?.stage;
            if (!(s > 0) || s < vMin || s > vMax) return '';
            return `<line x1="${mL}" y1="${y(s).toFixed(1)}" x2="${W - mR}" y2="${y(s).toFixed(1)}" stroke="${c}" stroke-width="0.8" stroke-dasharray="4 3" opacity="0.7"/>
                    <text x="${W - mR}" y="${(y(s) - 2).toFixed(1)}" fill="${c}" font-size="7" text-anchor="end">${k[0].toUpperCase() + k.slice(1)}</text>`;
        }).join('');

    const nowX = x(now);
    const gy0 = mT, gy1 = H - mB;
    const yticks = [vMin + pad, (vMin + vMax) / 2, vMax - pad].map(v =>
        `<text x="${mL - 4}" y="${(y(v) + 3).toFixed(1)}" fill="#6b7a88" font-size="7" text-anchor="end">${v.toFixed(1)}</text>
         <line x1="${mL}" y1="${y(v).toFixed(1)}" x2="${W - mR}" y2="${y(v).toFixed(1)}" stroke="#1e2a35" stroke-width="0.5"/>`).join('');

    const obsPath = obs.length >= 2 ? `<path d="${path(obs)}" fill="none" stroke="#00e5ff" stroke-width="1.6"/>` : '';
    const fcstPath = fcst.length >= 2 ? `<path d="${path(fcst)}" fill="none" stroke="#ffe14d" stroke-width="1.6" stroke-dasharray="5 3"/>` : '';

    return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;background:#0a0f16;border:1px solid rgba(0,229,255,0.15);border-radius:3px;">
        ${yticks}
        ${thrLines}
        <line x1="${nowX.toFixed(1)}" y1="${gy0}" x2="${nowX.toFixed(1)}" y2="${gy1}" stroke="#5c6b78" stroke-width="0.8" stroke-dasharray="2 2"/>
        <text x="${nowX.toFixed(1)}" y="${gy0 + 7}" fill="#8b97a3" font-size="7" text-anchor="middle">now</text>
        ${obsPath}${fcstPath}
        <text x="${mL}" y="${H - 6}" fill="#00e5ff" font-size="7">● Observed</text>
        <text x="${mL + 62}" y="${H - 6}" fill="#ffe14d" font-size="7">╍ Forecast</text>
        <text x="${W - mR}" y="${H - 6}" fill="#6b7a88" font-size="7" text-anchor="end">${unit}</text>
    </svg>`;
}

function aqiCategory(val) {
    if (val <= 50) return 'Good';
    if (val <= 100) return 'Moderate';
    if (val <= 150) return 'USG';
    if (val <= 200) return 'Unhealthy';
    if (val <= 300) return 'Very Unhealthy';
    return 'Hazardous';
}

function aqiColor(val) {
    if (val <= 50) return '#00e400';
    if (val <= 100) return '#ffff00';
    if (val <= 150) return '#ff7e00';
    if (val <= 200) return '#ff0000';
    if (val <= 300) return '#8f3f97';
    return '#7e0023';
}

// Color from an AQI category NAME (for forecasts where only a category is
// given, no numeric AQI). Matches the aqiColor() ramp.
function aqiCatColor(cat) {
    const c = (cat || '').toLowerCase();
    if (c.includes('hazardous')) return '#7e0023';
    if (c.includes('very unhealthy')) return '#8f3f97';
    if (c.includes('sensitive') || c === 'usg') return '#ff7e00';
    if (c.includes('unhealthy')) return '#ff0000';
    if (c.includes('moderate')) return '#ffff00';
    if (c.includes('good')) return '#00e400';
    return '#999';
}

// ─── EPA AQI Breakpoint Conversion (hourly, NOT NowCast) ───
// Converts raw concentration to AQI using EPA breakpoint linear interpolation
// Ozone breakpoints: 8-hour standard (ppb) — used for values < 125 ppb
// PM2.5 breakpoints: 24-hour standard (µg/m³) — 2024 revised breakpoints
function concToAqi(conc, pollutant) {
    if (conc == null || conc < 0) return -1;
    let bp;
    if (pollutant === 'ozone') {
        // Ozone in ppb — EPA 8-hour breakpoints (used for hourly display when < 125 ppb)
        bp = [
            { cLow: 0,   cHigh: 54,  iLow: 0,   iHigh: 50 },
            { cLow: 55,  cHigh: 70,  iLow: 51,  iHigh: 100 },
            { cLow: 71,  cHigh: 85,  iLow: 101, iHigh: 150 },
            { cLow: 86,  cHigh: 105, iLow: 151, iHigh: 200 },
            { cLow: 106, cHigh: 200, iLow: 201, iHigh: 300 }
        ];
    } else if (pollutant === 'pm25') {
        // PM2.5 in µg/m³ — EPA 24-hour breakpoints
        bp = [
            { cLow: 0.0,   cHigh: 9.0,   iLow: 0,   iHigh: 50 },
            { cLow: 9.1,   cHigh: 35.4,  iLow: 51,  iHigh: 100 },
            { cLow: 35.5,  cHigh: 55.4,  iLow: 101, iHigh: 150 },
            { cLow: 55.5,  cHigh: 125.4, iLow: 151, iHigh: 200 },
            { cLow: 125.5, cHigh: 225.4, iLow: 201, iHigh: 300 },
            { cLow: 225.5, cHigh: 325.4, iLow: 301, iHigh: 500 }
        ];
    } else {
        return -1;
    }
    // Truncate to 1 decimal for PM2.5, integer for ozone (EPA convention)
    const c = pollutant === 'pm25' ? Math.floor(conc * 10) / 10 : Math.floor(conc);
    for (const b of bp) {
        if (c >= b.cLow && c <= b.cHigh) {
            return Math.round(((b.iHigh - b.iLow) / (b.cHigh - b.cLow)) * (c - b.cLow) + b.iLow);
        }
    }
    return c > bp[bp.length - 1].cHigh ? 500 : -1; // Beyond scale
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 9b: AVIATION HAZARDS & PROBSEVERE
// ═══════════════════════════════════════════════════════════════════════════════

// Config-driven GeoJSON feed loader — one implementation for every simple
// fetch → filter → setData feed (aviation, ProbSevere, CWA). Each entry gives
// the proxy URL, target map source, health tracker id, log labels, and a
// `pick` function that reduces the raw FeatureCollection to what gets plotted.
const _polyOnly = fs => fs.filter(f => f.geometry &&
    (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'));

// IEM's national NEXRAD storm attribute table — every radar's current SCIT cell
// list in one CORS-open pull. Carries what the per-site STI does not: POSH/POH,
// max hail size, VIL, and the height of max reflectivity. `drct` is the bearing
// the cell is moving FROM (same convention as the L3 product), so the motion
// vector runs out along the reciprocal.
const NEXRAD_ATTR_URL = 'https://mesonet.agron.iastate.edu/geojson/nexrad_attr.py';
const _NATT_VECTOR_MIN_KT = 5;  // below this the reported direction is noise
const _NATT_VECTOR_SECS = 30 * 60;

function _nattPick(fs) {
    const out = [];
    fs.forEach(f => {
        const g = f.geometry, p = f.properties;
        if (!g || g.type !== 'Point' || !p) return;
        const lon = Number(g.coordinates[0]), lat = Number(g.coordinates[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
        const size = Number(p.max_size) || 0;
        // meso arrives as a rank string ('1'..'10') or the sentinel 'NONE'
        const mesoN = /^\d+$/.test(String(p.meso)) ? Number(p.meso) : 0;
        const sknt = Number(p.sknt) || 0;
        const drct = Number(p.drct);
        const toward = Number.isFinite(drct) ? (drct + 180) % 360 : null;
        const id = `${p.nexrad || '?'}-${p.storm_id || '?'}`;
        out.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lon, lat] },
            properties: {
                kind: 'cell', id,
                // Trace values (0.01") are algorithm noise, not a hail report —
                // only size the label once it means something.
                tag: size >= 0.25 ? `${p.storm_id} ${size.toFixed(2)}"` : String(p.storm_id || ''),
                nexrad: p.nexrad || '', storm_id: p.storm_id || '',
                max_size: size, meso_n: mesoN, tvs: (p.tvs && p.tvs !== 'NONE') ? 1 : 0,
                posh: p.posh, poh: p.poh, vil: p.vil, max_dbz: p.max_dbz,
                max_dbz_height: p.max_dbz_height, top: p.top,
                sknt, toward, valid: p.valid || ''
            }
        });
        if (sknt > _NATT_VECTOR_MIN_KT && toward != null) {
            const m = sknt * _KT2MS * _NATT_VECTOR_SECS;
            const th = toward * Math.PI / 180;
            const dLat = (m * Math.cos(th)) / 111320;
            const dLon = (m * Math.sin(th)) / (111320 * Math.cos(lat * Math.PI / 180));
            out.push({
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: [[lon, lat], [lon + dLon, lat + dLat]] },
                properties: { kind: 'vector', id }
            });
        }
    });
    return out;
}

const GEOJSON_FEEDS = {
    // SIGMETs and AIRMETs — one AWC feed carries both, styled by hazard.
    airsigmet: {
        url: '/api/airsigmet', source: 'airsigmet', health: 'airSigmet', tag: 'AVIATION',
        fetching: 'Fetching SIGMETs/AIRMETs...', what: 'SIGMET/AIRMET areas', color: '#ff9e3b',
        pick: _polyOnly
    },
    // Pilot reports (turbulence, icing, sky cover) — CONUS bbox, last 3 hours.
    pireps: {
        url: '/api/pirep', source: 'pireps', health: 'pireps', tag: 'AVIATION',
        fetching: 'Fetching pilot reports...', what: 'PIREPs', color: '#00e5ff',
        pick: fs => fs.filter(f => f.geometry && f.geometry.type === 'Point')
    },
    // CIMSS ProbSevere storm objects — newest MRMS_PROBSEVERE_*.json (~2 min).
    probsevere: {
        url: '/api/probsevere', source: 'probsevere', health: 'probSevere', tag: 'PROBSEVERE',
        fetching: 'Fetching CIMSS storm objects...', what: 'storm objects', color: '#ff3b3b',
        pick: fs => fs.filter(f => f.geometry)
    },
    // Terminal forecasts — one dot per station, prevailing period (timeGroup 0).
    taf: {
        url: '/api/taf', source: 'taf', health: 'taf', tag: 'AVIATION',
        fetching: 'Fetching terminal forecasts (TAF)...', what: 'TAF sites', color: '#33c27a',
        pick: fs => fs.filter(f => f.geometry && f.geometry.type === 'Point' &&
            (f.properties && (f.properties.timeGroup === 0 || f.properties.timeGroup === '0')))
    },
    // Graphical AIRMETs — issuances carry snapshots at forecast hours 0/3/6 and
    // which hours are present rotates with the cycle; keep the nearest-term
    // snapshot present so areas never stack and the layer never comes up empty.
    gairmet: {
        url: '/api/gairmet', source: 'gairmet', health: 'gairmet', tag: 'AVIATION',
        fetching: 'Fetching graphical AIRMETs...', what: 'G-AIRMET areas', color: '#ff9e3b',
        pick: fs => {
            const areas = _polyOnly(fs).filter(f => f.properties);
            if (!areas.length) return areas;
            const hours = areas.map(f => Number(f.properties.forecast)).filter(Number.isFinite);
            const minH = hours.length ? Math.min(...hours) : 0;
            return areas.filter(f => Number(f.properties.forecast) === minH);
        }
    },
    // Center Weather Advisories — short-fuse CWSU aviation warnings (2h shelf life).
    cwa: {
        url: '/api/cwa', source: 'cwa', health: 'cwa', tag: 'AVIATION',
        fetching: 'Fetching Center Weather Advisories...', what: 'CWAs', color: '#ff5ac4',
        pick: _polyOnly
    },
    // National storm attributes — fetched straight from IEM (CORS-open), so no
    // proxy function is spent on it. `count` skips the motion vectors so the log
    // reports cells; `stamp` ages the feed against the table's own build time.
    nexradattr: {
        url: NEXRAD_ATTR_URL, bust: true, source: 'nexrad-attr',
        health: 'nexradAttr', tag: 'SCIT',
        fetching: 'Fetching national storm attributes...', what: 'storm cells', color: '#ff2bd0',
        pick: _nattPick,
        count: fs => fs.filter(f => f.properties.kind === 'cell').length,
        stamp: fc => Date.parse(fc.generated_at) || null
    },
};

async function fetchGeoJsonFeed(key, show) {
    if (!show) { updateSidebarToActivePane(); return; }
    const cfg = GEOJSON_FEEDS[key];
    addLiveLog(`${cfg.tag}: ${cfg.fetching}`, cfg.color);
    try {
        const res = await fetch(cfg.bust ? cacheBust(cfg.url) : cfg.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const fc = await res.json();
        const feats = cfg.pick(fc.features || []);
        const clean = { type: 'FeatureCollection', features: feats };
        Object.values(maps).forEach(m => { if (m.getSource(cfg.source)) m.getSource(cfg.source).setData(clean); });
        updateHealth(cfg.health, cfg.stamp ? cfg.stamp(fc) : null);
        addLiveLog(`${cfg.tag}: ${cfg.count ? cfg.count(feats) : feats.length} ${cfg.what} loaded`, '#00ff88');
    } catch (e) {
        addLiveLog(`${cfg.tag} ${key.toUpperCase()} ERROR: ${e.message}`, '#ff3333');
    }
}

// Thin wrappers keep every existing call site (toggles, auto-refresh) unchanged.
async function fetchAirSigmet(show) { return fetchGeoJsonFeed('airsigmet', show); }
async function fetchPireps(show) { return fetchGeoJsonFeed('pireps', show); }
async function fetchProbSevere(show) { return fetchGeoJsonFeed('probsevere', show); }
async function fetchTaf(show) { return fetchGeoJsonFeed('taf', show); }
async function fetchGairmet(show) { return fetchGeoJsonFeed('gairmet', show); }
async function fetchCwa(show) { return fetchGeoJsonFeed('cwa', show); }
async function fetchNexradAttr(show) { return fetchGeoJsonFeed('nexradattr', show); }

// NDBC marine buoy observations — fixed-width latest_obs.txt (one row per
// station, 'MM' = missing), proxied via /api/ndbc (NDBC sends no CORS header).
// Columns: STN LAT LON YYYY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES PTDY ATMP WTMP DEWP VIS TIDE
async function fetchNdbc(show) {
    if (!show) { updateSidebarToActivePane(); return; }
    addLiveLog('MARINE: Fetching NDBC buoy observations...', '#00b8d4');
    try {
        const res = await fetch('/api/ndbc');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        const num = v => (v === 'MM' || v == null) ? null : parseFloat(v);
        const kt = v => v == null ? null : Math.round(v * 1.94384);          // m/s → kt
        const degF = v => v == null ? null : Math.round(v * 9 / 5 + 32);     // °C → °F
        const ft = v => v == null ? null : Math.round(v * 3.281 * 10) / 10;  // m → ft
        const feats = [];
        text.split('\n').forEach(ln => {
            if (!ln || ln[0] === '#') return;
            const t = ln.trim().split(/\s+/);
            if (t.length < 22) return;
            const lat = parseFloat(t[1]), lon = parseFloat(t[2]);
            if (!isFinite(lat) || !isFinite(lon)) return;
            if (lat < 15 || lat > 62 || lon < -180 || lon > -50) return;   // US waters
            const wdir = num(t[8]), wspd = num(t[9]), gst = num(t[10]), wvht = num(t[11]),
                  dpd = num(t[12]), pres = num(t[15]), atmp = num(t[17]), wtmp = num(t[18]);
            if (wspd == null && wvht == null && atmp == null && wtmp == null) return;  // nothing to show
            const tag = [wtmp != null ? degF(wtmp) + '°' : null,
                         wvht != null ? ft(wvht) + 'ft' : null].filter(Boolean).join(' ');
            feats.push({
                type: 'Feature',
                properties: {
                    id: t[0], obs: `${t[5]}/${t[6]}:${t[7]}Z`,
                    wdir, wspd: kt(wspd), gst: kt(gst), wvht: ft(wvht), dpd,
                    pres, atmp: degF(atmp), wtmp: degF(wtmp), tag
                },
                geometry: { type: 'Point', coordinates: [lon, lat] }
            });
        });
        const fc = { type: 'FeatureCollection', features: feats };
        Object.values(maps).forEach(m => { if (m.getSource('ndbc')) m.getSource('ndbc').setData(fc); });
        updateHealth('ndbc');
        addLiveLog(`MARINE: ${feats.length} NDBC buoys loaded`, '#00ff88');
    } catch (e) {
        addLiveLog(`MARINE NDBC ERROR: ${e.message}`, '#ff3333');
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 10: WARNING WATCHDOG
// ═══════════════════════════════════════════════════════════════════════════════

async function checkNewWarnings() {
    try {
        const res = await fetch('https://api.weather.gov/alerts/active?status=actual');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const alerts = data.features || [];

        // Helper to get severity score for map drawing order (higher score = drawn last/on top)
        function getAlertPriority(event) {
            const e = (event || '').toLowerCase();
            if (e.includes('tornado')) return 100;
            if (e.includes('flash flood')) return 90;
            if (e.includes('severe thunderstorm')) return 80;
            if (e.includes('warning')) return 70;
            if (e.includes('advisory')) return 50;
            if (e.includes('statement')) return 10;
            return 30;
        }

        if (Array.isArray(data.features)) {
            data.features.sort((a, b) => getAlertPriority(a.properties?.event) - getAlertPriority(b.properties?.event));
        }

        // Resolve zone geometries for alerts that have null geometry (e.g. Air Quality Alerts)
        // Uses global zoneGeometryCache to build up coverage across polling cycles
        const nullGeomFeatures = data.features.filter(f => !f.geometry && f.properties?.affectedZones?.length > 0);
        if (nullGeomFeatures.length > 0) {
            // Priority alert types — resolve these zones first (skip marine-only alerts)
            const priorityTypes = ['Air Quality Alert', 'Red Flag Warning', 'Heat Advisory', 'Excessive Heat Warning',
                'Severe Thunderstorm Watch', 'Tornado Watch', 'Flood Watch', 'Wind Advisory', 'High Wind Warning',
                'Fire Weather Watch', 'Dense Fog Advisory', 'Special Weather Statement'];

            // Collect uncached zone URLs, prioritized by alert type
            const priorityZones = new Set();
            const otherZones = new Set();
            nullGeomFeatures.forEach(f => {
                const evt = f.properties?.event || '';
                const isPriority = priorityTypes.some(p => evt.includes(p));
                f.properties.affectedZones.forEach(z => {
                    if (zoneGeometryCache[z]) return; // Already cached
                    if (isPriority) priorityZones.add(z);
                    else otherZones.add(z);
                });
            });

            // Fetch uncached zones: priority first, then others, up to 50 per cycle
            const toFetch = [...priorityZones, ...otherZones].slice(0, 50);
            if (toFetch.length > 0) {
                await Promise.allSettled(
                    toFetch.map(async url => {
                        try {
                            const res = await fetch(url, { headers: { 'Accept': 'application/geo+json' } });
                            if (!res.ok) return;
                            const zoneData = await res.json();
                            if (zoneData.geometry) zoneGeometryCache[url] = zoneData.geometry;
                        } catch (_) {}
                    })
                );
            }

            // Apply ALL cached geometries (from this + previous cycles) to null-geom features
            nullGeomFeatures.forEach(f => {
                const polys = [];
                (f.properties.affectedZones || []).forEach(z => {
                    const geom = zoneGeometryCache[z];
                    if (!geom) return;
                    if (geom.type === 'Polygon') polys.push(geom.coordinates);
                    else if (geom.type === 'MultiPolygon') polys.push(...geom.coordinates);
                });
                if (polys.length > 0) {
                    f.geometry = { type: 'MultiPolygon', coordinates: polys };
                }
            });

            const resolved = nullGeomFeatures.filter(f => f.geometry).length;
            if (resolved > 0) addLiveLog(`WATCHDOG: Resolved ${resolved}/${nullGeomFeatures.length} zone-based alerts (${Object.keys(zoneGeometryCache).length} zones cached)`, '#808000');
        }

        // Filter out features with null geometry (MapLibre can't render them)
        data.features = data.features.filter(f => f.geometry);

        // ─── Enrich features with Impact-Based Warning (IBW) threat levels ───
        // NWS API `parameters` field contains damage threat tags for elevated warnings:
        //   flashFloodDamageThreat: ["Considerable"] or ["Catastrophic"]
        //   tornadoDamageThreat: ["Considerable"] or ["Catastrophic"]
        //   thunderstormDamageThreat: ["Considerable"] or ["Destructive"]
        data.features.forEach(f => {
            const params = f.properties?.parameters || {};
            let threat = '';
            let isEmergency = false;
            let isPDS = false;

            // Extract damage threat from IBW parameters
            if (params.flashFloodDamageThreat?.[0]) threat = params.flashFloodDamageThreat[0];
            else if (params.tornadoDamageThreat?.[0]) threat = params.tornadoDamageThreat[0];
            else if (params.thunderstormDamageThreat?.[0]) threat = params.thunderstormDamageThreat[0];

            const evt = (f.properties?.event || '').toLowerCase();
            const headline = (f.properties?.headline || '').toLowerCase();

            // Tornado Emergency detection
            if (evt.includes('tornado emergency') ||
                headline.includes('tornado emergency') ||
                (evt.includes('tornado') && headline.includes('this is a tornado emergency'))) {
                threat = 'Catastrophic';
                isEmergency = true;
            }

            // Flash Flood Emergency detection
            if (evt.includes('flash flood') &&
                (headline.includes('flash flood emergency') ||
                 headline.includes('this is a flash flood emergency'))) {
                threat = 'Catastrophic';
                isEmergency = true;
            }

            // PDS (Particularly Dangerous Situation) detection
            if (headline.includes('particularly dangerous situation')) {
                if (!threat) threat = 'Considerable';
                isPDS = true;
            }

            f.properties.damageThreat = threat || '';
            f.properties.isEmergency = isEmergency;
            f.properties.isPDS = isPDS;
        });

        const ibwFeatures = data.features.filter(f => f.properties.damageThreat || f.properties.isEmergency || f.properties.isPDS);
        if (ibwFeatures.length !== lastIbwCount) {
            if (ibwFeatures.length > 0) {
                addLiveLog(`WATCHDOG: ${ibwFeatures.length} impact-based warning(s) active`, '#ff6600');
                ibwFeatures.forEach(f => {
                    const p = f.properties;
                    const threat = p.isEmergency ? 'EMERGENCY' : (p.damageThreat || '').toUpperCase() || (p.isPDS ? 'PDS' : '');
                    const area = (p.areaDesc || '').substring(0, 100);
                    addLiveLog(`  ⚠ ${esc(p.event)} [${esc(threat)}] → ${esc(area)}`, p.isEmergency || p.damageThreat === 'Catastrophic' ? '#ff0000' : '#ff6600');
                });
            } else if (lastIbwCount > 0) {
                addLiveLog('WATCHDOG: All impact-based warnings have expired', '#00ff88');
            }
            lastIbwCount = ibwFeatures.length;
        }

        warningsLoaded = true;
        warningsGeoJSON = sortWarningsByPriority(data);

        // Push to all map warning layers
        Object.values(maps).forEach(m => {
            if (m.getSource('nws-warnings')) m.getSource('nws-warnings').setData(warningsGeoJSON);
        });
        applyWarningDisplayModeAll();
        updateHealth('warnings');

        const isFirst = warningsFirstLoad;
        let newCount = 0;

        // Deduplicate: when both original Alert and Update exist, keep only the newest
        // Key by event+area to avoid duplicate ticker entries
        const alertsByKey = new Map();
        alerts.forEach(f => {
            const p = f.properties || {};
            const key = `${p.event}|${(p.areaDesc || '').substring(0, 60)}|${p.senderName}`;
            const existing = alertsByKey.get(key);
            if (!existing || new Date(p.sent) > new Date(existing.properties?.sent)) {
                alertsByKey.set(key, f);
            }
        });

        // Collect new alerts (only deduplicated versions)
        const newAlerts = [];
        alertsByKey.forEach(f => {
            const id = f.properties?.id;
            if (!id || warningsSeen.has(id)) return;
            warningsSeen.add(id);
            newAlerts.push(f);
        });

        // Sort newAlerts by sent time ascending (oldest first)
        newAlerts.sort((a, b) => new Date(a.properties?.sent || 0) - new Date(b.properties?.sent || 0));

        // On first load, keep up to 1000 alerts so all active nationwide alerts are available for filtering
        const toProcess = isFirst ? newAlerts.slice(-1000) : newAlerts;

        // Build all new ticker nodes first (toProcess is oldest→newest), then insert as ONE
        // batch and run applyWatchdogFilter a single time — avoids per-alert reflow/filter
        // churn that made bulk updates (esp. the ~1000-alert first load) janky.
        const newItems = [];
        for (let i = 0; i < toProcess.length; i++) {
            const f = toProcess[i];
            const event = f.properties?.event;
            const area = f.properties?.areaDesc;
            const severity = f.properties?.severity;
            const threat = f.properties?.damageThreat || '';
            const isEmergency = f.properties?.isEmergency || false;
            const isPDS = f.properties?.isPDS || false;
            newItems.push(buildWarningItem(event, area, severity, f.properties));
            if (!isFirst) {
                const threatTag = isEmergency ? ' ⚠ EMERGENCY' : threat === 'Catastrophic' || threat === 'Destructive' ? ` ⚠ ${threat.toUpperCase()}` : threat === 'Considerable' ? ' ⚠ CONSIDERABLE' : isPDS ? ' ⚠ PDS' : '';
                const color = isEmergency || threat === 'Catastrophic' ? '#ff0000' : threat === 'Considerable' || isPDS ? '#ff6600' : severity === 'Extreme' ? '#ff0000' : severity === 'Severe' ? '#ff3333' : '#ffb300';
                addLiveLog(`WATCHDOG: NEW ${esc(event)}${threatTag} → ${esc((area || '').substring(0, 80))}`, color);
                // Only pop a corner toast when the alert matches the active state/WFO
                // filter — nationwide when unfiltered, otherwise only the selected area.
                if (alertMatchesWatchdogFilter(f.properties, area)) alertVizNotify(f, { isEmergency, threat, isPDS });
            }
        }
        if (newItems.length > 0) {
            const list = document.getElementById('latest-warnings-list');
            if (list) {
                const placeholder = list.querySelector('.warning-placeholder');
                if (placeholder) placeholder.remove();
                // Insert newest-on-top: iterate newItems in reverse into a fragment, prepend once
                const frag = document.createDocumentFragment();
                for (let i = newItems.length - 1; i >= 0; i--) frag.appendChild(newItems[i]);
                list.insertBefore(frag, list.firstChild);
                while (list.children.length > 1000) list.lastChild.remove();
                rebuildWfoFilter(); // surface any newly-seen offices in the dropdown
                applyWatchdogFilter();
            }
        }
        newCount = toProcess.length;

        if (!isFirst && newCount > 0) {
            addLiveLog(`WATCHDOG: ${newCount} new alert(s) detected`, '#ffb300');
        }

        // Prune set to prevent memory leak
        if (warningsSeen.size > 1000) {
            warningsSeen = new Set([...warningsSeen].slice(-500));
        }

        if (isFirst) {
            warningsFirstLoad = false;
            addLiveLog(`WATCHDOG: Tracking ${alerts.length} active alerts`, '#ffb300');
        }
    } catch (e) {
        addLiveLog(`WATCHDOG ERROR: ${e.message}`, '#ff3333');
    }
}

async function checkNewWatches() {
    try {
        const res = await fetch('https://mapservices.weather.noaa.gov/eventdriven/rest/services/WWA/watch_warn_adv/MapServer/1/query?where=sig%3D%27A%27&f=geojson&outFields=*');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        watchesLoaded = true;
        watchesGeoJSON = data;

        // Push to all map watch layers
        Object.values(maps).forEach(m => {
            if (m.getSource('nws-watches-vector')) m.getSource('nws-watches-vector').setData(watchesGeoJSON);
        });
        updateHealth('watches');
    } catch (e) {
        addLiveLog(`WATCHES ERROR: Failed to retrieve watch polygon data (${e.message})`, '#ff3333');
    }
}

async function fetchGreatLakes() {
    if (greatLakesLoaded) return;
    try {
        const res = await fetch('https://mapservices.weather.noaa.gov/vector/rest/services/basemaps/NWS_Base_Map/MapServer/3/query?where=1%3D1&outFields=*&f=geojson');
        if (!res.ok) return;
        const data = await res.json();
        greatLakesLoaded = true;
        greatLakesGeoJSON = data;
        Object.values(maps).forEach(m => {
            if (m && m.getSource('great-lakes')) m.getSource('great-lakes').setData(greatLakesGeoJSON);
        });
        addLiveLog('MAP: Great Lakes vector boundaries loaded successfully', '#00bfff');
    } catch (e) {
        // silent fallback
    }
}

const ALL_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','PR','RI','SC','SD','TN','TX','UT','VT','VA','VI','WA','WV','WI','WY','DC','GU','AS','MP'];
const ALL_WFOS = [
    'Aberdeen','Albany','Albuquerque','Amarillo','Anchorage','Atlanta','Austin',
    'Baltimore','Billings','Birmingham','Bismarck','Boise','Brownsville','Buffalo',
    'Burlington','Caribou','Charleston','Cheyenne','Chicago','Cincinnati',
    'Cleveland','Columbia','Corpus Christi','Dallas','Denver','Des Moines',
    'Detroit','Dodge City','Duluth','El Paso','Elko','Eureka','Fairbanks',
    'Flagstaff','Gaylord','Glasgow','Goodland','Grand Forks','Grand Junction','Grand Rapids',
    'Gray','Great Falls','Green Bay','Greenville','Guam','Hanford','Hastings','Honolulu',
    'Houston','Huntsville','Indianapolis','Jackson','Jacksonville','Juneau','Kansas City',
    'Key West','Knoxville','La Crosse','Lake Charles','Las Vegas','Lincoln','Little Rock',
    'Los Angeles','Louisville','Lubbock','Marquette','Medford','Melbourne','Memphis',
    'Miami','Midland','Milwaukee','Minneapolis','Missoula','Mobile',
    'Morristown','Nashville','New Orleans','New York City','Norman','North Platte',
    'Northern Indiana','Omaha','Paducah','Pendleton','Philadelphia','Phoenix',
    'Pittsburgh','Pocatello','Portland','Pueblo','Raleigh',
    'Rapid City','Reno','Riverton','Sacramento','Salt Lake City','San Angelo',
    'San Diego','San Francisco','San Juan','Seattle','Shreveport','Sioux Falls',
    'Spokane','Springfield','St. Louis','State College','Tallahassee','Tampa Bay',
    'Tiyan','Topeka','Tucson','Tulsa','Twin Cities','Upton','Wakefield',
    'Wichita','Wilmington'
];

// Builds a single ticker DOM node WITHOUT touching the list — caller batch-inserts.
// (Avoids per-alert reflow + per-alert applyWatchdogFilter churn on bulk updates.)
// Derive the affected US state codes from an alert's properties (UGC/SAME geocodes
// first, then areaDesc "County, ST" pairs, then the sender's state as a last resort).
// Shared by the ticker's data-state attribute and the AlertViz toast filter so both
// judge location identically.
function deriveAlertStates(props, area) {
    const affectedStates = new Set();
    const ugcCodes = props?.geocode?.UGC || props?.geocode?.SAME || [];
    ugcCodes.forEach(code => {
        const st = code.substring(0, 2);
        if (/^[A-Z]{2}$/.test(st)) affectedStates.add(st);
    });
    if (affectedStates.size === 0 && area) {
        const stMatches = area.match(/,\s*([A-Z]{2})(?:\s*;|$)/g);
        if (stMatches) stMatches.forEach(m => {
            const st = m.replace(/[,;\s]/g, '');
            if (/^[A-Z]{2}$/.test(st)) affectedStates.add(st);
        });
    }
    if (affectedStates.size === 0) {
        const stMatch = (props?.senderName || '').match(/\b([A-Z]{2})$/);
        if (stMatch) affectedStates.add(stMatch[1]);
    }
    return [...affectedStates];
}

// Derive the issuing office (WFO) city name from an alert's senderName, matching the
// ticker's data-wfo attribute (e.g. "NWS Kansas City/Pleasant Hill MO" → "Kansas City").
function deriveAlertWfo(props) {
    const senderName = props?.senderName || '';
    const wfoMatch = senderName.match(/^NWS\s+(.+?)(?:\s+[A-Z]{2})?$/);
    let wfo = wfoMatch ? wfoMatch[1].replace(/\/$/, '').trim() : senderName.replace(/^NWS\s*/, '').trim();
    if (wfo.includes('/')) wfo = wfo.split('/')[0].trim();
    return wfo.replace(/\s+[A-Z]{2}$/, '');
}

// Whether an alert matches the current WATCHDOG state/WFO filter selection. Gates the
// AlertViz corner toasts: with "All states / All WFOs" every new warning notifies; when
// the user narrows to a state or office, only matching warnings pop up.
function alertMatchesWatchdogFilter(props, area) {
    const stateFilter = document.getElementById('watchdog-filter-state')?.value || 'all';
    const wfoFilter = document.getElementById('watchdog-filter-wfo')?.value || 'all';
    if (stateFilter === 'all' && wfoFilter === 'all') return true;
    const matchState = stateFilter === 'all' || deriveAlertStates(props, area).includes(stateFilter);
    const matchWfo = wfoFilter === 'all' ||
        deriveAlertWfo(props).trim().toLowerCase() === wfoFilter.trim().toLowerCase();
    return matchState && matchWfo;
}

function buildWarningItem(event, area, severity, props) {
    const item = document.createElement('div');
    let type = 'advisory';
    const evt = (event || '').toLowerCase();

    if (evt.includes('tornado')) type = 'tornado';
    else if (evt.includes('severe thunderstorm')) type = 'severe';
    else if (evt.includes('flash flood')) type = 'flash-flood';
    else if (evt.includes('gale')) type = 'gale';
    else if (evt.includes('special weather statement')) type = 'sws';
    else if (evt.includes('marine') || evt.includes('small craft')) type = 'marine';
    else if (evt.includes('freeze warning')) type = 'freeze-warning';
    else if (evt.includes('freeze')) type = 'freeze';
    else if (evt.includes('winter') || evt.includes('blizzard')) type = 'winter';
    else if (evt.includes('wind chill')) type = 'cold';
    else if (evt.includes('hurricane') || evt.includes('tropical')) type = 'tropical';
    else if (evt.includes('fire')) type = 'fire';
    else if (evt.includes('flood')) type = 'flood';
    else if (evt.includes('watch')) type = 'watch';
    else if (severity === 'Extreme' || severity === 'Severe') type = 'warning';

    const senderName = props?.senderName || '';
    const wfo = deriveAlertWfo(props);

    // State derived from the AFFECTED AREA (UGC/SAME → areaDesc → sender), not just
    // the sender's location — see deriveAlertStates.
    const affectedStates = deriveAlertStates(props, area);
    const stateStr = affectedStates.join(',');
    const primaryState = affectedStates[0] || '';

    const stateTag = primaryState ? `<span style="color:#00e5ff;font-weight:bold;">[${affectedStates.join('/')}]</span> ` : '';
    item.className = `warning-item ${type}`;
    item.style.cursor = 'pointer';
    item.dataset.state = stateStr;  // Comma-separated for multi-state alerts
    item.dataset.wfo = wfo;
    const time = props?.sent ? new Date(props.sent).toISOString().substring(11, 16) : new Date().toISOString().substring(11, 16);

    // IBW (Impact-Based Warning) threat badge
    const params = props?.parameters || {};
    const threat = params.flashFloodDamageThreat?.[0] || params.tornadoDamageThreat?.[0] || params.thunderstormDamageThreat?.[0] || '';
    const headline = (props?.headline || '').toLowerCase();
    const isEmergency = headline.includes('tornado emergency') || headline.includes('flash flood emergency');
    const isPDS = headline.includes('particularly dangerous situation');
    let ibwBadge = '';
    if (isEmergency) {
        ibwBadge = '<span class="ibw-badge ibw-emergency">⚠ EMERGENCY</span>';
    } else if (threat === 'Catastrophic' || threat === 'Destructive') {
        ibwBadge = `<span class="ibw-badge ibw-catastrophic">⚠ ${esc(threat.toUpperCase())}</span>`;
    } else if (threat === 'Considerable') {
        ibwBadge = '<span class="ibw-badge ibw-considerable">⚠ CONSIDERABLE</span>';
    } else if (isPDS) {
        ibwBadge = '<span class="ibw-badge ibw-pds">⚠ PDS</span>';
    }

    if (ibwBadge) item.classList.add('ibw-enhanced');
    item.innerHTML = `<div class="warning-header">${time}Z — ${esc(event || 'Alert')}${ibwBadge}</div><div>${stateTag}${esc((area || '').substring(0, 120))}</div>`;

    item.addEventListener('click', () => {
        const panel = document.getElementById('text-panel');
        const content = document.getElementById('text-product-content');
        if (!panel || !content) return;
        const desc = esc(props?.description || 'No description available.').replace(/\n/g, '<br>');
        const instr = esc(props?.instruction || '').replace(/\n/g, '<br>');
        const expires = props?.expires ? new Date(props.expires).toUTCString() : 'Unknown';
        content.innerHTML = `<div style="font-family:'Courier New',monospace;font-size:12px;color:#e0e0e0;line-height:1.6;">` +
            `<div style="font-weight:bold;color:${getEventColor(props?.event)};font-size:15px;margin-bottom:6px;">${esc(props?.event || 'Weather Alert')}</div>` +
            `<div style="color:#888;margin-bottom:2px;">${esc(senderName)}</div>` +
            `<div style="margin-bottom:6px;">${esc(props?.headline || '')}</div>` +
            `<div style="color:#ffb300;font-size:11px;margin-bottom:10px;">Expires: ${expires}</div>` +
            `<div style="border-top:1px solid #333;padding-top:8px;white-space:pre-wrap;">${desc}</div>` +
            (instr ? `<div style="border-top:1px solid #333;margin-top:10px;padding-top:8px;color:#00e5ff;white-space:pre-wrap;"><b>PRECAUTIONARY/PREPAREDNESS ACTIONS:</b><br>${instr}</div>` : '') +
            `</div>`;
        panel.style.display = 'flex';
    });
    return item;
}

function applyWatchdogFilter() {
    const stateFilter = document.getElementById('watchdog-filter-state')?.value || 'all';
    const wfoFilter = document.getElementById('watchdog-filter-wfo')?.value || 'all';
    const list = document.getElementById('latest-warnings-list');
    if (!list) return;
    let visibleCount = 0;
    for (const item of list.children) {
        if (!item.classList.contains('warning-item')) continue;
        // State field may contain comma-separated states for multi-state alerts (e.g., "KS,MO")
        const itemStates = (item.dataset.state || '').split(',');
        const matchState = stateFilter === 'all' || itemStates.includes(stateFilter);
        const itemWfoClean = (item.dataset.wfo || '').trim().toLowerCase();
        const filterWfoClean = wfoFilter.trim().toLowerCase();
        const matchWfo = wfoFilter === 'all' || itemWfoClean === filterWfoClean;
        const visible = matchState && matchWfo;
        item.style.display = visible ? '' : 'none';
        if (visible) visibleCount++;
    }
    // Show a message if filter returned no results
    if (visibleCount === 0 && (stateFilter !== 'all' || wfoFilter !== 'all')) {
        if (!list.querySelector('.filter-no-results')) {
            const msg = document.createElement('div');
            msg.className = 'filter-no-results';
            msg.style.cssText = 'font-size:9px;color:#666;text-align:center;padding:8px;font-style:italic;';
            msg.textContent = `No active alerts for ${stateFilter !== 'all' ? stateFilter : wfoFilter}`;
            list.appendChild(msg);
        }
    } else {
        const noRes = list.querySelector('.filter-no-results');
        if (noRes) noRes.remove();
    }
}

// Rebuild the WFO filter dropdown from the COMPLETE static roster PLUS the actual office
// names present in live alerts (item.dataset.wfo). The dynamic part guarantees every office
// currently issuing alerts is selectable with an exact-matching name — including offices the
// static roster lacks or mis-labels (e.g. ILX = "Lincoln"). Dedup case-insensitively; preserve
// the current selection; skip the DOM rebuild when the option set is unchanged.
function rebuildWfoFilter() {
    const sel = document.getElementById('watchdog-filter-wfo');
    if (!sel) return;
    const seen = new Map(); // lowercase key -> display value
    ALL_WFOS.forEach(w => { const k = w.toLowerCase(); if (!seen.has(k)) seen.set(k, w); });
    const list = document.getElementById('latest-warnings-list');
    if (list) {
        for (const item of list.children) {
            if (!item.classList || !item.classList.contains('warning-item')) continue;
            const w = (item.dataset.wfo || '').trim();
            if (w) { const k = w.toLowerCase(); if (!seen.has(k)) seen.set(k, w); }
        }
    }
    const wfos = [...seen.values()].sort((a, b) => a.localeCompare(b));
    const sig = wfos.join('|');
    if (sel.dataset.sig === sig) return; // no change → avoid churn
    sel.dataset.sig = sig;
    const current = sel.value;
    // Build options via DOM (not innerHTML) so feed-derived names can't inject markup
    sel.replaceChildren();
    const allOpt = document.createElement('option');
    allOpt.value = 'all'; allOpt.textContent = 'All WFOs';
    sel.appendChild(allOpt);
    wfos.forEach(w => {
        const opt = document.createElement('option');
        opt.value = w; opt.textContent = w;
        sel.appendChild(opt);
    });
    sel.value = (current === 'all' || wfos.includes(current)) ? current : 'all';
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 11: ANIMATION ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

// Build a master-frame -> stream-frame lookup: for each master time, the newest
// stream frame valid at or before it. Both lists must be sorted oldest-first.
// A master time earlier than the stream's first frame clamps to frame 0 rather
// than rendering nothing, so a pane never goes blank at the head of the loop.
function buildTimeIndex(masterTimes, frameTimes) {
    const table = [];
    let j = 0;
    for (const mt of masterTimes) {
        while (j + 1 < frameTimes.length && frameTimes[j + 1] <= mt) j++;
        table.push(j);
    }
    return table;
}

async function startAnimation() {
    if (isPlaying) return;
    isPlaying = true;

    const activeMap = maps[activePaneId];
    if (!activeMap) { stopAnimation(); return; }

    // Check what is visible across the ACTIVE tab's panes (other tabs keep
    // running live in the background and must not be drawn into this loop).
    const loopMaps = activeTabMapEntries();
    const showSat = loopMaps.some(([pid, m]) => isLayerVisible(m, 'satellite-layer') && paneGoesChannels[pid] !== null);
    const showGibs = loopMaps.some(([pid, m]) => isLayerVisible(m, 'gibs-sat-layer') && paneGibs[pid]);
    const showRad = loopMaps.some(([, m]) =>
        isLayerVisible(m, 'radar-layer') || isLayerVisible(m, 'site-bref-layer') ||
        isLayerVisible(m, 'site-bvel-layer') || isLayerVisible(m, 'site-bdhc-layer') ||
        isLayerVisible(m, 'site-bdsa-layer') || isLayerVisible(m, 'site-boha-layer')
    );
    const showL3 = loopMaps.some(([pid, m]) => isLayerVisible(m, 'radar-l3-layer') && paneL3[pid]);

    const durationMin = parseInt(document.getElementById('loop-duration').value) || 60;
    const stepMin = parseInt(document.getElementById('loop-step').value) || 5;
    let speedMs = parseInt(document.getElementById('loop-speed').value) || 400;
    const holdMs = Math.max(speedMs, 300);
    const playBtn = document.getElementById('play-btn');
    if (playBtn) playBtn.innerHTML = '<i data-lucide="pause"></i>';
    try { lucide.createIcons(); } catch (_) {}

    addLiveLog(`LOOP: Starting ${durationMin}min / ${stepMin}min step (SAT:${showSat} RAD:${showRad} L3:${showL3})`, '#ffb300');

    // ── Capture Visibility Snapshot (for restoration later) ──
    preAnimVisibility = {};
    const layersToSnapshot = [
        'satellite-layer', 'gibs-sat-layer', 'radar-layer',
        'site-bref-layer', 'site-bvel-layer', 'site-bdhc-layer', 'site-bdsa-layer', 'site-boha-layer',
        'radar-l3-layer'
    ];
    loopMaps.forEach(([id, map]) => {
        preAnimVisibility[id] = {};
        layersToSnapshot.forEach(lyr => {
            if (map.getLayer(lyr)) {
                preAnimVisibility[id][lyr] = map.getLayoutProperty(lyr, 'visibility') || 'visible';
            }
        });
    });

    // ── Build timeline of frames ──
    const now = new Date();
    const satFrames = [];
    const radFrames = [];

    // ─── Satellite frames (nowCOAST WMS, 5-min cadence via TIME parameter) ───
    // Find any active channel as reference for timing; per-pane URLs built later
    const refSatChannel = activeGoesChannel || Object.values(paneGoesChannels).find(ch => ch !== null);
    // GIBS satellite loop: use the product's REAL available frame times (no gaps/glitches)
    const gibsPaneForLoop = paneGibs[activePaneId] ? activePaneId
                                                   : Object.keys(paneGibs).find(pid => paneGibs[pid]);
    const gibsProdForLoop = gibsPaneForLoop ? paneGibs[gibsPaneForLoop] : null;
    const gibsBirdForLoop = gibsPaneForLoop ? (paneGibsBird[gibsPaneForLoop] || goesBirdFor(gibsPaneForLoop)) : 'east';
    // nowCOAST's satellite layers are a GOES-East CONUS mosaic — there is no
    // GOES-West equivalent, so a plain channel loop over a West sector would
    // animate the wrong hemisphere. Send those to GIBS instead of faking it.
    // Read the bird off the pane actually showing a channel, not the active one.
    const satPaneForLoop = loopMaps.find(([pid, m]) => isLayerVisible(m, 'satellite-layer') && paneGoesChannels[pid] !== null);
    const satLoopBird = satPaneForLoop ? goesBirdFor(satPaneForLoop[0]) : 'east';
    if (showGibs && gibsProdForLoop) {
        const allTimes = gibsTimesFor(gibsProdForLoop, gibsBirdForLoop);
        const gStep = Math.max(stepMin, 10); // GIBS GOES cadence is 10 min
        let want = Math.min(Math.floor(durationMin / gStep) || 1, 24);
        // take every (gStep/10)-th real frame from the newest `want*stride` window
        const stride = Math.max(1, Math.round(gStep / 10));
        const picked = [];
        for (let i = allTimes.length - 1; i >= 0 && picked.length < want; i -= stride) picked.unshift(allTimes[i]);
        picked.forEach(iso => satFrames.push({
            isoTime: iso, gibs: true, time: new Date(iso),
            label: `SAT ${iso.substring(11, 16)}Z`
        }));
    } else if (showSat && refSatChannel !== null && satLoopBird === 'west') {
        addLiveLog('LOOP: GOES-West channels have no time-stepped source — pick a GIBS product to loop the Pacific', '#ffb300');
    } else if (showSat && refSatChannel !== null) {
        let satStep = Math.max(stepMin, 5); // minimum 5-min steps (nowCOAST cadence)
        // Offset "now" by 7 min to avoid requesting future timestamps that lack data
        const satNow = new Date(now.getTime() - 7 * 60000);
        let count = Math.floor(durationMin / satStep);
        if (count > 24) { satStep = Math.ceil(durationMin / 24 / 5) * 5; count = Math.floor(durationMin / satStep); }
        for (let i = 0; i < count; i++) {
            const d = new Date(satNow.getTime() - (count - 1 - i) * satStep * 60000);
            const isoTime = snapToNowCoastTime(d);
            satFrames.push({
                isoTime: isoTime, // Stored for per-pane URL building
                tileUrl: nowCoastSatUrl(refSatChannel, isoTime), // Reference URL (active pane)
                time: d,
                label: `SAT ${d.toISOString().substring(11, 16)}Z`
            });
        }
    }

    // ─── Radar frames (National or Site-Specific) ───
    if (showRad) {
        if (activeRadarNational) {
            if (durationMin <= 55) {
                // Use IEM pre-rendered frames (fast)
                const iemFrames = RADAR_ANIM_LAYERS.filter(f => f.offsetMin <= durationMin);
                const selected = [];
                for (let offset = 0; offset <= durationMin; offset += stepMin) {
                    const closest = iemFrames.reduce((best, f) =>
                        Math.abs(f.offsetMin - offset) < Math.abs(best.offsetMin - offset) ? f : best, iemFrames[0]);
                    if (!selected.includes(closest)) selected.push(closest);
                }
                selected.sort((a, b) => b.offsetMin - a.offsetMin);
                selected.forEach(f => {
                    const t = new Date(now.getTime() - f.offsetMin * 60000);
                    radFrames.push({
                        tileUrl: iemRadarAnimUrl(f.name),
                        time: t,
                        label: `RAD ${t.toISOString().substring(11, 16)}Z`
                    });
                });
            } else {
                // Use RIDGE archive tiles for longer durations
                for (let offset = 0; offset <= durationMin; offset += stepMin) {
                    const t = new Date(now.getTime() - (durationMin - offset) * 60000);
                    radFrames.push({
                        tileUrl: ridgeRadarUrl(t),
                        time: t,
                        label: `RAD ${t.toISOString().substring(11, 16)}Z`
                    });
                }
            }
        } else {
            // Site-Specific NEXRAD Radar Animation — per-pane URLs built during layer creation
            let radStep = Math.max(stepMin, 5);
            let count = Math.floor(durationMin / radStep);
            if (count > 24) { radStep = Math.ceil(durationMin / 24 / 5) * 5; count = Math.floor(durationMin / radStep); }
            for (let i = 0; i < count; i++) {
                const d = new Date(now.getTime() - (count - 1 - i) * radStep * 60000);
                const isoStr = d.toISOString().replace(/\.\d{3}Z$/, 'Z');
                radFrames.push({
                    isoStr: isoStr, // Stored for per-pane URL building
                    tileUrl: null,  // Built per-pane during layer creation
                    time: d,
                    label: `RAD ${isoStr.substring(11, 16)}Z`
                });
            }
        }
    }

    // ─── NODD L3 frames (SRM / CC / ZDR / KDP) — decoded historical scans ───
    // Each loop pane with an L3 product pulls its own last-K volume scans via
    // /api/radar-l3?offset=N (0 = newest). Frames arrive as georeferenced PNG
    // data-URLs, so each becomes an image source stepped like the other streams.
    animL3Frames = {};
    animL3Count = 0;
    animL3Last = {};
    if (showL3) {
        const l3Want = Math.max(4, Math.min(10, Math.floor(durationMin / 5) || 4));
        const l3Panes = loopMaps.filter(([pid, m]) => isLayerVisible(m, 'radar-l3-layer') && paneL3[pid]);
        addLiveLog(`LOOP: preloading up to ${l3Want} L3 volume scans for ${l3Panes.length} pane(s)…`, '#33c27a');
        await Promise.all(l3Panes.map(async ([pid]) => {
            const { station, product } = paneL3[pid];
            const results = await Promise.all(Array.from({ length: l3Want }, (_, off) =>
                fetch(`/api/radar-l3?station=${station}&product=${product}&offset=${off}&_=${Date.now()}`)
                    .then(r => r.json()).catch(() => null)));
            const seen = new Set();
            animL3Frames[pid] = results
                .filter(d => d && d.success && d.image && d.coordinates)
                .map(d => ({ image: d.image, coordinates: d.coordinates, time: String(d.meta.time),
                    label: `${station} ${product} ${String(d.meta.time).substring(11, 16)}Z` }))
                .sort((a, b) => a.time.localeCompare(b.time))
                .filter(f => !seen.has(f.time) && seen.add(f.time));   // dedupe same volume scan
        }));
        if (!isPlaying) return;   // user hit stop during the preload
        animL3Count = Math.max(0, ...Object.values(animL3Frames).map(f => f.length));
        addLiveLog(`LOOP: L3 frames ready (${animL3Count} scans)`, '#00ff88');
    }

    // ── Master timeline ──
    // The finest-cadence stream sets the timeline; every other stream is then
    // time-matched onto it below. (The L3 branch used to stamp every master
    // frame with `new Date()`, which threw away the scan times the match needs.)
    let masterFrames = satFrames.length >= radFrames.length ? satFrames : radFrames;
    if (animL3Count > masterFrames.length) {
        const longest = Object.values(animL3Frames).find(f => f.length === animL3Count) || [];
        masterFrames = longest.map(f => ({ time: new Date(f.time), label: f.label }));
    }
    const totalFrames = masterFrames.length;

    const masterTimes = masterFrames.map(f => +f.time);
    animSatIndex = buildTimeIndex(masterTimes, satFrames.map(f => +f.time));
    animRadIndex = buildTimeIndex(masterTimes, radFrames.map(f => +f.time));
    animL3Index = {};
    Object.entries(animL3Frames).forEach(([pid, frames]) => {
        animL3Index[pid] = buildTimeIndex(masterTimes, frames.map(f => +new Date(f.time)));
    });

    if (totalFrames === 0) {
        addLiveLog('LOOP: No active products to animate. Enable Radar or Satellite first.', '#ff3333');
        stopAnimation();
        return;
    }

    // ── Pre-create ALL frame layers (multi-layer preload approach) ──
    // Each frame gets its own source+layer pair per-pane with the pane's own GOES channel.
    // Scoped to the active tab so background tabs aren't loaded with anim layers.
    loopMaps.forEach(([paneId, map]) => {
        const paneCh = paneGoesChannels[paneId];
        const hadSatVisible = preAnimVisibility[paneId]?.['satellite-layer'] === 'visible' && paneCh !== null;
        const gibsProd = paneGibs[paneId];
        const hadGibsVisible = preAnimVisibility[paneId]?.['gibs-sat-layer'] === 'visible' && gibsProd;

        // Determine what radar this pane had visible
        const snap = preAnimVisibility[paneId];
        const hadNatRad = snap?.['radar-layer'] === 'visible';
        const hadSiteRad = snap?.['site-bref-layer'] === 'visible' ||
                           snap?.['site-bvel-layer'] === 'visible' ||
                           snap?.['site-bdhc-layer'] === 'visible' ||
                           snap?.['site-bdsa-layer'] === 'visible' ||
                           snap?.['site-boha-layer'] === 'visible';
        const hadAnyRad = hadNatRad || hadSiteRad;

        // Hide live layers only on panes that had them visible
        if (hadSatVisible && map.getLayer('satellite-layer')) {
            map.setLayoutProperty('satellite-layer', 'visibility', 'none');
        }
        if (hadGibsVisible && map.getLayer('gibs-sat-layer')) {
            map.setLayoutProperty('gibs-sat-layer', 'visibility', 'none');
        }
        if (hadAnyRad) {
            ['radar-layer', 'site-bref-layer', 'site-bvel-layer', 'site-bdhc-layer', 'site-bdsa-layer', 'site-boha-layer'].forEach(l => {
                if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', 'none');
            });
        }

        // Create satellite animation layers per pane — GIBS (real frames) or nowCOAST
        if ((hadSatVisible || hadGibsVisible) && satFrames.length > 0) {
            const gp = hadGibsVisible ? GIBS_PRODUCTS[gibsProd] : null;
            const paneBird = paneGibsBird[paneId] || goesBirdFor(paneId);
            for (let i = 0; i < satFrames.length; i++) {
                const srcId = `anim-sat-src-${i}`;
                const lyrId = `anim-sat-lyr-${i}`;
                if (!map.getSource(srcId)) {
                    const satUrl = hadGibsVisible
                        ? gibsTileUrl(gibsProd, satFrames[i].isoTime, paneBird)
                        : nowCoastSatUrl(paneCh, satFrames[i].isoTime);
                    const srcOpts = { type: 'raster', tiles: [satUrl], tileSize: 256 };
                    if (gp) srcOpts.maxzoom = gp.max;
                    map.addSource(srcId, srcOpts);
                    map.addLayer({ id: lyrId, type: 'raster', source: srcId,
                        layout: { visibility: 'visible' },
                        paint: {
                            'raster-opacity': 0.01,
                            'raster-resampling': 'nearest',
                            'raster-fade-duration': 0
                        }
                    }, map.getLayer('radar-layer') ? 'radar-layer' : firstBoundaryLayer(map));
                }
            }
        }

        // NODD L3 (SRM/CC/ZDR/KDP): hide the live image, stack this pane's
        // decoded historical scans as image sources stepped by opacity.
        const paneL3FramesArr = animL3Frames[paneId] || [];
        if (snap?.['radar-l3-layer'] === 'visible' && paneL3FramesArr.length > 0) {
            if (map.getLayer('radar-l3-layer')) map.setLayoutProperty('radar-l3-layer', 'visibility', 'none');
            paneL3FramesArr.forEach((f, i) => {
                const srcId = `anim-l3-src-${i}`;
                const lyrId = `anim-l3-lyr-${i}`;
                if (!map.getSource(srcId)) {
                    map.addSource(srcId, { type: 'image', url: f.image, coordinates: f.coordinates });
                    map.addLayer({ id: lyrId, type: 'raster', source: srcId,
                        layout: { visibility: 'visible' },
                        paint: {
                            'raster-opacity': 0.01,
                            'raster-resampling': 'nearest',
                            'raster-fade-duration': 0
                        }
                    }, firstBoundaryLayer(map));
                }
            });
        }

        // Create radar animation layers ONLY on panes that had radar visible
        // Each pane uses its OWN site and product for per-pane animation
        if (hadAnyRad && radFrames.length > 0) {
            const paneSite = paneRadarSites[paneId] || 'DGX';
            const paneProduct = paneRadarProducts[paneId] || 'sr_bref';
            for (let i = 0; i < radFrames.length; i++) {
                const srcId = `anim-rad-src-${i}`;
                const lyrId = `anim-rad-lyr-${i}`;
                if (!map.getSource(srcId)) {
                    let radUrl;
                    if (hadNatRad) {
                        // National radar — same URL for all panes
                        radUrl = radFrames[i].tileUrl;
                    } else {
                        // Site-specific — use THIS PANE's site + product
                        radUrl = siteRadarAnimUrl(paneSite, paneProduct, radFrames[i].isoStr);
                    }
                    map.addSource(srcId, { type: 'raster', tiles: [radUrl], tileSize: 512 });
                    map.addLayer({ id: lyrId, type: 'raster', source: srcId,
                        layout: { visibility: 'visible' },
                        paint: {
                            'raster-opacity': 0.01,
                            'raster-resampling': 'nearest',
                            'raster-fade-duration': 0
                        }
                    }, firstBoundaryLayer(map));   // keep boundaries above loop frames
                }
            }
        }
    });

    animSatFrames = satFrames;
    animRadFrames = radFrames;
    animLastSi = -1;
    animLastRi = -1;
    animL3Last = {};
    loopDirection = 1;
    animationFrameIndex = 0;
    animationFrames = masterFrames;

    document.getElementById('stop-btn')?.style.setProperty('display', 'inline-flex');
    document.getElementById('step-prev-btn')?.style.setProperty('display', 'inline-flex');
    document.getElementById('step-next-btn')?.style.setProperty('display', 'inline-flex');

    addLiveLog(`LOOP: ${totalFrames} frames preloading (SAT:${satFrames.length} RAD:${radFrames.length})`, '#00ff88');

    // Show the first frame right away so panes aren't blank while loading
    renderCurrentFrame();

    // ── Synchronized start: wait until EVERY loop pane has its frames loaded ──
    // Frame sources are created pane-by-pane, so pane 1's tile requests hit the
    // network first and pane 2+'s queue behind them (browser connection limit).
    // A fixed delay let pane 1 start looping while pane 2 was still downloading,
    // making it appear to "join late" mid-cycle. Poll areTilesLoaded() on all
    // loop panes instead, capped so a stalled tile can't hang the loop.
    const loadWaitStart = Date.now();
    const loadWaitCapMs = satFrames.length > 0 ? 20000 : 12000;
    const waitForAllPanes = () => {
        if (!isPlaying) return;   // user hit stop during the wait
        let allLoaded;
        try {
            allLoaded = loopMaps.every(([, m]) => m.areTilesLoaded());
        } catch (_) { allLoaded = true; }
        const waited = Date.now() - loadWaitStart;
        if (allLoaded || waited > loadWaitCapMs) {
            const secs = (waited / 1000).toFixed(1);
            addLiveLog(allLoaded
                ? `LOOP: all ${loopMaps.length} pane(s) loaded in ${secs}s — rolling`
                : `LOOP: starting after ${secs}s (some frames still loading)`, '#00ff88');
            advanceLoopTick();
        } else {
            animationTimer = setTimeout(waitForAllPanes, 300);
        }
    };
    animationTimer = setTimeout(waitForAllPanes, 800);
}

function advanceLoopTick() {
    if (!isPlaying) return;
    renderCurrentFrame();

    const last = animationFrames.length - 1;
    // The frame just painted. Dwelling on the newest one gives the eye time to
    // read the current data before the loop snaps back to the oldest frame —
    // without it a fast loop reads as a blur with no reference point.
    const atNewest = animationFrameIndex >= last;
    const atOldest = animationFrameIndex <= 0;

    if (document.getElementById('loop-mode')?.value === 'rock') {
        // Rocking: reverse at each end instead of wrapping, so motion stays
        // continuous and you can watch a feature advance and retreat.
        if (atNewest) loopDirection = -1;
        else if (atOldest) loopDirection = 1;
        animationFrameIndex += loopDirection;
    } else {
        animationFrameIndex = atNewest ? 0 : animationFrameIndex + 1;
    }
    animationFrameIndex = Math.max(0, Math.min(animationFrameIndex, last));

    const speedMs = parseInt(document.getElementById('loop-speed').value) || 400;
    const holdMs = Math.max(speedMs, 300);
    const dwellMs = parseInt(document.getElementById('loop-dwell')?.value ?? '0') || 0;
    animationTimer = setTimeout(advanceLoopTick, atNewest ? holdMs + dwellMs : holdMs);
}

function renderCurrentFrame() {
    const totalFrames = animationFrames.length;
    if (totalFrames === 0) return;

    if (animationFrameIndex < 0) animationFrameIndex = totalFrames - 1;
    if (animationFrameIndex >= totalFrames) animationFrameIndex = 0;

    // Toggle satellite frame opacity with 60ms retention buffer to eliminate black-out flicker
    // Non-active frames stay at 0.01 (not 0) to keep MapLibre loading their tiles
    if (animSatFrames.length > 0) {
        const si = animSatIndex[animationFrameIndex] ?? Math.min(animationFrameIndex, animSatFrames.length - 1);
        if (si !== animLastSi) {
            const prevSi = animLastSi;
            Object.values(maps).forEach(m => {
                if (m && m.getLayer(`anim-sat-lyr-${si}`)) {
                    m.setPaintProperty(`anim-sat-lyr-${si}`, 'raster-opacity', 0.8);
                }
                if (prevSi >= 0 && prevSi !== si) {
                    setTimeout(() => {
                        if (m && m.getLayer(`anim-sat-lyr-${prevSi}`)) {
                            m.setPaintProperty(`anim-sat-lyr-${prevSi}`, 'raster-opacity', 0.01);
                        }
                    }, 60);
                }
            });
            animLastSi = si;
        }
    }

    // Toggle radar frame opacity with 60ms retention buffer to eliminate black-out flicker
    if (animRadFrames.length > 0) {
        const ri = animRadIndex[animationFrameIndex] ?? Math.min(animationFrameIndex, animRadFrames.length - 1);
        if (ri !== animLastRi) {
            const prevRi = animLastRi;
            Object.values(maps).forEach(m => {
                if (m && m.getLayer(`anim-rad-lyr-${ri}`)) {
                    m.setPaintProperty(`anim-rad-lyr-${ri}`, 'raster-opacity', 0.9);
                }
                if (prevRi >= 0 && prevRi !== ri) {
                    setTimeout(() => {
                        if (m && m.getLayer(`anim-rad-lyr-${prevRi}`)) {
                            m.setPaintProperty(`anim-rad-lyr-${prevRi}`, 'raster-opacity', 0.01);
                        }
                    }, 60);
                }
            });
            animLastRi = ri;
        }
    }

    // Toggle NODD L3 frame opacity — per-pane frame lists (each pane loops its
    // own product/scans). Volume scans don't line up across sites, so each pane
    // is time-matched independently and tracks its own last-rendered index.
    if (animL3Count > 0) {
        Object.entries(maps).forEach(([pid, m]) => {
            const cnt = (animL3Frames[pid] || []).length;
            if (!m || !cnt) return;
            const table = animL3Index[pid];
            const idx = table
                ? (table[animationFrameIndex] ?? cnt - 1)
                : Math.min(animationFrameIndex, cnt - 1);
            const prevIdx = animL3Last[pid] ?? -1;
            if (idx === prevIdx) return;
            if (m.getLayer(`anim-l3-lyr-${idx}`)) {
                m.setPaintProperty(`anim-l3-lyr-${idx}`, 'raster-opacity', 0.85);
            }
            if (prevIdx >= 0) {
                setTimeout(() => {
                    if (m && m.getLayer(`anim-l3-lyr-${prevIdx}`)) {
                        m.setPaintProperty(`anim-l3-lyr-${prevIdx}`, 'raster-opacity', 0.01);
                    }
                }, 60);
            }
            animL3Last[pid] = idx;
        });
    }

    // Update per-pane labels with each pane's own channel/product info
    const satFrame = animSatFrames.length > 0
        ? animSatFrames[animSatIndex[animationFrameIndex] ?? animSatFrames.length - 1] : null;
    const radFrame = animRadFrames.length > 0
        ? animRadFrames[animRadIndex[animationFrameIndex] ?? animRadFrames.length - 1] : null;
    Object.keys(maps).forEach(paneId => {
        const el = document.getElementById(`radar-ts-${paneId}`);
        if (!el) return;
        const snap = preAnimVisibility[paneId];
        const paneCh = paneGoesChannels[paneId];
        const hadSat = snap?.['satellite-layer'] === 'visible' && paneCh !== null;
        const hadNatRad = snap?.['radar-layer'] === 'visible';
        const hadSiteRad = snap?.['site-bref-layer'] === 'visible' ||
                           snap?.['site-bvel-layer'] === 'visible' ||
                           snap?.['site-bdhc-layer'] === 'visible' ||
                           snap?.['site-bdsa-layer'] === 'visible' ||
                           snap?.['site-boha-layer'] === 'visible';
        const parts = [];
        if (hadSat && satFrame) parts.push(`CH${paneCh} ${satFrame.label.replace('SAT ', '')}`);
        if (hadSiteRad && radFrame) {
            const paneSite = (paneRadarSites[paneId] || 'DGX').toUpperCase();
            const paneProduct = (paneRadarProducts[paneId] || 'sr_bref').toUpperCase().replace('SR_', '');
            const timeStr = radFrame.label.replace('RAD ', '');
            parts.push(`${paneSite} ${paneProduct} ${timeStr}`);
        } else if (hadNatRad && radFrame) {
            parts.push(radFrame.label);
        }
        const paneL3FramesArr = animL3Frames[paneId] || [];
        if (paneL3FramesArr.length) {
            const l3Table = animL3Index[paneId];
            const l3i = l3Table
                ? (l3Table[animationFrameIndex] ?? paneL3FramesArr.length - 1)
                : Math.min(animationFrameIndex, paneL3FramesArr.length - 1);
            parts.push(paneL3FramesArr[l3i].label);
        }
        el.textContent = parts.length > 0 ? `LOOP | ${parts.join(' + ')}` : 'LOOP';
    });
    const layerTimeEl = document.getElementById('val-layer-time');
    if (layerTimeEl) {
        layerTimeEl.textContent = `FRAME ${animationFrameIndex + 1}/${totalFrames}${isPaused ? ' [PAUSED]' : ''}`;
    }

    const progressBar = document.querySelector('.timeline-progress');
    if (progressBar && totalFrames > 0) {
        progressBar.style.width = ((animationFrameIndex + 1) / totalFrames * 100) + '%';
    }
}

function pauseAnimation() {
    if (!isPlaying && !isPaused) return;
    isPlaying = false;
    isPaused = true;
    if (animationTimer) clearTimeout(animationTimer);

    const playBtn = document.getElementById('play-btn');
    if (playBtn) playBtn.innerHTML = '<i data-lucide="play"></i>';
    try { lucide.createIcons(); } catch (_) {}

    renderCurrentFrame();
    addLiveLog(`LOOP: Paused at frame ${animationFrameIndex + 1}`, '#ffb300');
}

function resumeAnimation() {
    if (isPlaying || !isPaused) return;
    isPlaying = true;
    isPaused = false;

    const playBtn = document.getElementById('play-btn');
    if (playBtn) playBtn.innerHTML = '<i data-lucide="pause"></i>';
    try { lucide.createIcons(); } catch (_) {}

    addLiveLog(`LOOP: Resumed from frame ${animationFrameIndex + 1}`, '#00ff88');
    advanceLoopTick();
}

function stepPrevFrame() {
    if (!isPlaying && !isPaused) return;
    if (isPlaying) pauseAnimation();
    animationFrameIndex--;
    if (animationFrameIndex < 0) animationFrameIndex = animationFrames.length - 1;
    renderCurrentFrame();
}

function stepNextFrame() {
    if (!isPlaying && !isPaused) return;
    if (isPlaying) pauseAnimation();
    animationFrameIndex++;
    if (animationFrameIndex >= animationFrames.length) animationFrameIndex = 0;
    renderCurrentFrame();
}

function stopAnimation() {
    if (animationTimer) {
        clearTimeout(animationTimer);
        animationTimer = null;
    }
    isPlaying = false;
    isPaused = false;

    const playBtn = document.getElementById('play-btn');
    if (playBtn) playBtn.innerHTML = '<i data-lucide="play"></i>';
    
    document.getElementById('stop-btn')?.style.setProperty('display', 'none');
    document.getElementById('step-prev-btn')?.style.setProperty('display', 'none');
    document.getElementById('step-next-btn')?.style.setProperty('display', 'none');
    try { lucide.createIcons(); } catch (_) {}

    // Remove all animation sources and layers (anim-sat-lyr-0, anim-sat-src-0, etc.)
    Object.values(maps).forEach(map => {
        const style = map.getStyle();
        if (!style || !style.layers) return;
        // Remove layers first, then sources
        const animLayerIds = style.layers
            .filter(l => l.id.startsWith('anim-'))
            .map(l => l.id);
        animLayerIds.forEach(lid => {
            try { map.removeLayer(lid); } catch (_) {}
        });
        const animSourceIds = Object.keys(style.sources).filter(s => s.startsWith('anim-'));
        animSourceIds.forEach(sid => {
            try { map.removeSource(sid); } catch (_) {}
        });
    });

    animationFrames = [];
    animationFrameIndex = 0;
    animL3Frames = {};
    animL3Count = 0;
    animL3Last = {};
    loopDirection = 1;
    animSatIndex = [];
    animRadIndex = [];
    animL3Index = {};

    // Reset timeline progress bar
    const progressBar = document.querySelector('.timeline-progress');
    if (progressBar) progressBar.style.width = '0%';

    // Reset frame counter to LIVE
    const layerTimeEl = document.getElementById('val-layer-time');
    if (layerTimeEl) layerTimeEl.textContent = 'LIVE';

    // Restore live layers
    restoreLiveLayers();
    refreshTimestampLabel();
    addLiveLog('LOOP: Stopped', '#888');
}

function restoreLiveLayers() {
    // Restore ONLY the panes the loop touched (the snapshot's keys — the loop
    // tab's panes). Panes in other tabs were never altered by startAnimation,
    // so there is nothing to restore there. The old fallback that force-showed
    // radar/satellite on every snapshot-less pane is what painted the national
    // mosaic and default-IR satellite onto other tabs after a loop stopped
    // (`paneGoesChannels[id] !== null` is true for panes that were never
    // assigned a channel at all — undefined !== null).
    Object.entries(preAnimVisibility).forEach(([id, snapshot]) => {
        const map = maps[id];
        if (!map) return;
        Object.entries(snapshot).forEach(([lyr, vis]) => {
            if (map.getLayer(lyr)) map.setLayoutProperty(lyr, 'visibility', vis);
        });
    });
    preAnimVisibility = {};   // spent — never re-apply a stale snapshot
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 12: TIMESTAMPS & LABELS
// ═══════════════════════════════════════════════════════════════════════════════

// Enumerate every active product in a pane as {label, color} for the legend stack.
// Colors mirror each product's map styling so the stack reads at a glance.
function getPaneLegend(paneId) {
    const map = maps[paneId];
    if (!map) return [];
    const site = (paneRadarSites[paneId] || '').toUpperCase();
    const ch = paneGoesChannels[paneId];
    const rows = [];
    // healthId (optional) appends the product's last-refresh time to the label.
    const add = (cond, label, color, healthId) => {
        if (cond) rows.push({ label: label + (healthId ? healthTimeSuffix(healthId) : ''), color });
    };

    // Imagery / base fields
    add(isLayerVisible(map, 'radar-layer'), 'NATL REFLECTIVITY', '#39ff5a', 'radar');
    add(isLayerVisible(map, 'site-bref-layer'), `${site} BREF 0.5°${siteTimeSuffix(site, 'sr_bref')}`, '#39ff5a');
    add(isLayerVisible(map, 'site-bvel-layer'), `${site} VELOCITY 0.5°${siteTimeSuffix(site, 'sr_bvel')}`, '#5ad1ff');
    add(isLayerVisible(map, 'site-bdhc-layer'), `${site} HYDROMETEOR CLASS${siteTimeSuffix(site, 'bdhc')}`, '#ff9a3c');
    add(isLayerVisible(map, 'site-bdsa-layer'), `${site} STORM TOTAL PRECIP${siteTimeSuffix(site, 'bdsa')}`, '#3cff9a');
    add(isLayerVisible(map, 'site-boha-layer'), `${site} ONE-HOUR PRECIP${siteTimeSuffix(site, 'boha')}`, '#3cff9a');
    // WSR-88D operational status, inline under the site radar product row.
    if (SITE_RADAR_VIS_LAYERS.some(l => isLayerVisible(map, l)) && site && !site.includes('NEXRAD')) {
        radarStatusRows(paneRadarSites[paneId]).forEach(r => rows.push(r));
    }
    const sectorKey = goesSectorFor(paneId);
    add(isLayerVisible(map, 'satellite-layer') && ch !== null,
        `${goesSectorLabel(sectorKey).toUpperCase()} CH${ch}${goesChannelTimeSuffix(ch, sectorKey)}`, '#cfd8e3');
    if (isLayerVisible(map, 'gibs-sat-layer') && paneGibs[paneId]) {
        const gt = paneGibsTime[paneId];
        const gtSuffix = (gt && gt.length >= 16) ? ` · ${gt.substring(11, 16)}Z` : '';
        const gName = (GIBS_PRODUCTS[paneGibs[paneId]]?.label || paneGibs[paneId]).toUpperCase();
        const gBird = GOES_BIRDS[paneGibsBird[paneId] || goesBirdFor(paneId)].short;
        rows.push({ label: `${gBird} ${gName}${gtSuffix}`, color: '#9fd0ff' });
    }
    add(isLayerVisible(map, 'lightning-layer'), 'NLDN LIGHTNING', '#ffd23c', 'lightning');
    add(isLayerVisible(map, 'mrms-echotops-layer'), 'MRMS ECHO TOPS', '#9b59ff', 'mrmsEchotops');
    add(isLayerVisible(map, 'mrms-qpe-layer'), 'MRMS QPE', '#39ff5a', 'mrmsQpe');
    // Surface / analysis
    add(isLayerVisible(map, 'metars-temp'), 'METAR OBS', '#39ff5a', 'metar');
    Object.entries(SFC_CONTOUR_FIELDS).forEach(([id, c]) =>
        add(isLayerVisible(map, id + '-line'), `${c.label} ${c.interval}${c.unit}`, c.color, c.health));
    add(isLayerVisible(map, 'wpc-isobars-line'), 'WPC ISOBARS 4mb', '#d0d0d0', 'wpcIsobars');
    add(isLayerVisible(map, 'wpc-fronts-solid'), 'WPC FRONTS', '#4488ff', 'wpcFronts');
    add(isLayerVisible(map, 'wpc-qpf-layer'), 'WPC QPF', '#39ff5a', 'wpcQpf');
    if (isLayerVisible(map, 'radar-l3-layer') && paneL3[paneId]) {
        const l3m = paneL3[paneId].meta || {};
        const l3t = l3m.time;                            // "YYYY-MM-DD HH:MM:SSZ"
        const l3suffix = (l3t && l3t.length >= 16) ? ` · ${l3t.substring(11, 16)}Z` : '';
        // SRM carries the subtracted storm-motion vector — show it like AWIPS.
        const sm = (l3m.product === 'N0S' && l3m.storm_spd > 0)
            ? ` · SM ${Math.round(l3m.storm_dir)}°/${Math.round(l3m.storm_spd)}kt` : '';
        rows.push({ label: `L3 ${l3m.name || paneL3[paneId].product} · ${paneL3[paneId].station}${l3suffix}${sm}`, color: '#33c27a' });
    }
    // Hazards
    add(isLayerVisible(map, 'spc-day1-fill'), 'SPC DAY 1 OUTLOOK', '#ff4d4d', 'spcOutlook');
    add(isLayerVisible(map, 'spc-day2-fill'), 'SPC DAY 2 OUTLOOK', '#ff4d4d', 'spcOutlook');
    add(isLayerVisible(map, 'spc-day3-fill'), 'SPC DAY 3 OUTLOOK', '#ff4d4d', 'spcOutlook');
    [1, 2].forEach(day => {
        ['torn', 'wind', 'hail'].forEach(hz => {
            add(isLayerVisible(map, `spc-prob-${day}-${hz}-fill`),
                `SPC D${day} ${SPC_HAZARD_NAMES[hz].toUpperCase()} PROB`, '#ff884d', 'spcOutlook');
        });
    });
    add(isLayerVisible(map, 'wpc-ero-day1-fill'), 'WPC ERO DAY 1', '#39ff5a', 'wpcEro');
    add(isLayerVisible(map, 'wpc-ero-day2-fill'), 'WPC ERO DAY 2', '#39ff5a', 'wpcEro');
    add(isLayerVisible(map, 'wpc-ero-day3-fill'), 'WPC ERO DAY 3', '#39ff5a', 'wpcEro');
    add(isLayerVisible(map, 'spc-md-fill'), 'SPC MESO DISCUSSIONS', '#ff6a00', 'spcMd');
    add(isLayerVisible(map, 'wpc-mpd-fill'), 'WPC MESO PRECIP DISC', '#33c27a', 'wpcMpd');
    add(isLayerVisible(map, 'spc-lsr-icons'), 'LOCAL STORM REPORTS', '#ff8c00', 'spcLsr');
    add(isLayerVisible(map, 'spc-d48-fill'), 'SPC DAY 4-8 OUTLOOK', '#b87aff', 'spcOutlook');
    add(isLayerVisible(map, 'probsevere-fill'), 'PROBSEVERE (CIMSS)', '#ff9900', 'probSevere');
    add(isLayerVisible(map, 'natt-cell'), 'STORM ATTRIBUTES (SCIT)', '#ff9e3b', 'nexradAttr');
    add(isLayerVisible(map, 'storm-attr-cell'), `${site} STORM TRACKS (STI)`, '#ff2bd0');
    add(isLayerVisible(map, 'meso-circ'), `${site} MESO/TVS (MDA)`, '#ff9e3b');
    add(isLayerVisible(map, 'airsigmet-fill'), 'SIGMETS / AIRMETS', '#ff9e3b', 'airSigmet');
    add(isLayerVisible(map, 'gairmet-fill'), 'G-AIRMET HAZARDS', '#ffd23c', 'gairmet');
    add(isLayerVisible(map, 'pireps-layer'), 'PILOT REPORTS', '#00e5ff', 'pireps');
    add(isLayerVisible(map, 'taf-layer'), 'TAF FLIGHT CATEGORY', '#33c27a', 'taf');
    add(isLayerVisible(map, 'cwa-fill'), 'CENTER WX ADVISORIES', '#ff5ac4', 'cwa');
    add(isLayerVisible(map, 'ndbc-layer'), 'NDBC BUOY OBS', '#00b8d4', 'ndbc');
    add(isLayerVisible(map, 'ndfd-temp-layer'), 'NDFD SFC TEMP FCST', '#ff8c69', 'ndfdTemp');
    add(isLayerVisible(map, 'nws-warnings-only-fill'), 'NWS WARNINGS', '#ff3333', 'warnings');
    add(isLayerVisible(map, 'nws-advis-fill'), 'NWS ADVISORIES', '#ffd23c', 'warnings');
    add(isLayerVisible(map, 'nws-watches-only-fill'), 'NWS WATCHES', '#ffaa00', 'watches');
    add(isLayerVisible(map, 'nhc-track-pts'), 'NHC STORMS', '#ff3333', 'nhcStorms');
    add(isLayerVisible(map, 'nhc-outlook-fill'), 'NHC TROPICAL OUTLOOK', '#ffaa00', 'nhcOutlook');
    // Climate / environment
    add(isLayerVisible(map, 'cpc-temp-layer'), 'CPC TEMP OUTLOOK', '#ff8c69', 'cpcTemp');
    add(isLayerVisible(map, 'cpc-precip-layer'), 'CPC PRECIP OUTLOOK', '#69b3ff', 'cpcPrecip');
    add(isLayerVisible(map, 'drought-fill'), 'US DROUGHT MONITOR', '#d2a679', 'drought');
    add(isLayerVisible(map, 'cpc-drought-layer'), 'CPC DROUGHT OUTLOOK', '#4488ff');
    add(isLayerVisible(map, 'firms-fires-layer'), 'ACTIVE FIRES', '#ff4500', 'firms');
    add(isLayerVisible(map, 'hms-smoke-fill'), 'HMS SMOKE', '#aaaaaa', 'hms');
    [1, 2, 3, 4, 5, 6, 7, 8].forEach(d => {
        add(isLayerVisible(map, `spc-firewx-day${d}-fill`), `SPC D${d} FIRE WX`, '#ff7f00', 'spcFireWx');
    });
    add(isLayerVisible(map, 'airnow-aqi-layer'), 'AIR QUALITY (AQI)', '#39ff5a', 'aqi');
    add(isLayerVisible(map, 'river-gauges-layer'), 'RIVER GAUGES', '#5ad1ff', 'riverGauges');
    add(isLayerVisible(map, 'solar-night-fill'), 'DAY/NIGHT TERMINATOR', '#8893a3', 'solar');
    // Reference overlays
    add(isLayerVisible(map, 'nws-cwa-layer'), 'NWS CWA BOUNDARIES', '#00e5ff');
    return rows;
}

function updatePaneTimestamps(forceLabel = null) {
    Object.keys(maps).forEach(paneId => {
        const el = document.getElementById(`radar-ts-${paneId}`);
        if (!el) return;

        if (forceLabel) {
            el.classList.remove('legend-stack');
            el.textContent = forceLabel;
            return;
        }

        // Populate the site-radar valid time on first display only; thereafter
        // the 5-min tile refresh updates it in step with the rendered scan, so
        // the label never runs ahead of the image.
        const m = maps[paneId];
        const pSite = paneRadarSites[paneId];
        if (m && pSite && !pSite.includes('nexrad') && !siteRadarTimes[pSite.toUpperCase()] &&
            ['site-bref-layer', 'site-bvel-layer', 'site-bdhc-layer', 'site-bdsa-layer', 'site-boha-layer'].some(l => isLayerVisible(m, l))) {
            fetchSiteRadarTimes(pSite);
        }

        const rows = getPaneLegend(paneId);
        if (rows.length === 0) {
            el.classList.remove('legend-stack');
            el.textContent = 'LIVE';
            return;
        }
        el.classList.add('legend-stack');
        el.innerHTML = rows.map(r =>
            `<span class="legend-row" style="border-left-color:${r.color}">${r.label}</span>`
        ).join('');
    });
}

function refreshTimestampLabel() {
    if (isPlaying) return;
    updatePaneTimestamps();
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 13: SKEW-T SOUNDING MODAL
// ═══════════════════════════════════════════════════════════════════════════════

function initSoundingModal() {
    const modal = document.getElementById('sounding-modal');
    if (!modal) return;

    const openBtn = document.getElementById('btn-soundings');
    const closeBtn = document.getElementById('close-sounding-modal');
    const fetchBtn = document.getElementById('fetch-sounding-btn');
    const invertBtn = document.getElementById('invert-sounding-btn');
    const popoutBtn = document.getElementById('popout-sounding-btn');
    const dateInput = document.getElementById('sounding-date-input');
    const img = document.getElementById('sounding-image');

    // Initialize date picker with today's UTC date
    if (dateInput) {
        const now = new Date();
        dateInput.value = now.toISOString().split('T')[0];
    }

    if (openBtn) openBtn.addEventListener('click', () => { modal.style.display = 'flex'; });
    if (closeBtn) closeBtn.addEventListener('click', () => { modal.style.display = 'none'; });

    const stationSelect = document.getElementById('sounding-station-select');
    if (stationSelect) {
        stationSelect.addEventListener('change', () => {
            const val = stationSelect.value;
            const coords = SOUNDING_LOCATIONS[val];
            if (coords) {
                const map = maps[activePaneId];
                if (map) {
                    addLiveLog(`SOUNDING: Flying to ${val} station area`, '#00e5ff');
                    map.flyTo({ center: coords, zoom: 7, speed: 1.2 });
                }
            }
        });
    }

    if (fetchBtn) fetchBtn.addEventListener('click', async () => {
        const station = document.getElementById('sounding-station-select')?.value || 'JAN';
        const time = document.getElementById('sounding-time-select')?.value || 'latest';
        const selectedDate = dateInput?.value; // YYYY-MM-DD

        const placeholder = document.getElementById('sounding-placeholder');
        if (placeholder) placeholder.style.display = 'none';
        if (img) img.style.display = 'none';

        addLiveLog(`SOUNDING: Fetching ${station}...`, '#00e5ff');

        let spcUrl;
        if (time === 'latest') {
            spcUrl = `https://www.spc.noaa.gov/exper/soundings/LATEST/${station}.gif`;
        } else if (selectedDate) {
            const parts = selectedDate.split('-'); // [2026, 05, 15]
            const yymmdd = parts[0].substring(2) + parts[1] + parts[2];
            spcUrl = `https://www.spc.noaa.gov/exper/soundings/${yymmdd}${time}_OBS/${station}.gif`;
        }

        try {
            // Test SPC
            await new Promise((resolve, reject) => {
                const t = new Image();
                t.onload = resolve; t.onerror = reject;
                t.src = spcUrl;
            });
            if (img) {
                img.src = spcUrl;
                img.style.display = 'block';
                img.style.filter = '';
            }
            addLiveLog(`SOUNDING: ${station} loaded from SPC`, '#00ff88');
        } catch {
            // Fallback: UWyo
            const parts = selectedDate?.split('-') || [];
            const yr = parts[0];
            const mo = parts[1];
            const dy = parts[2];
            const hh = (time === 'latest') ? '12' : time;
            const uwyoUrl = `https://weather.uwyo.edu/upperair/images/${yr}${mo}${dy}${hh}.72451.skewt.gif`;
            
            if (img) {
                img.src = uwyoUrl;
                img.style.display = 'block';
                img.style.filter = '';
            }
            addLiveLog(`SOUNDING: SPC unavailable, showing UWyo fallback`, '#ffb300');
        }
    });

    if (popoutBtn && img) {
        popoutBtn.addEventListener('click', () => {
            if (img.src) window.open(img.src, '_blank');
        });
    }

    if (invertBtn && img) {
        invertBtn.addEventListener('click', () => {
            img.style.filter = img.style.filter === 'invert(1)' ? '' : 'invert(1)';
        });
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 14: TEXT PRODUCT BROWSER
// ═══════════════════════════════════════════════════════════════════════════════

function initTextModal() {
    const panel = document.getElementById('text-panel');
    if (!panel) return;

    // Open panel from sidebar button
    const openBtn = document.getElementById('btn-text-products');
    if (openBtn) openBtn.addEventListener('click', () => {
        panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
    });

    const closeBtn = document.getElementById('close-text-panel');
    const fetchBtn = document.getElementById('fetch-text-btn');
    const wfoSelect = document.getElementById('text-wfo-select');
    const productSelect = document.getElementById('text-product-select');
    const versionSelect = document.getElementById('text-version-select');
    const contentEl = document.getElementById('text-product-content');

    if (closeBtn) closeBtn.addEventListener('click', () => { panel.style.display = 'none'; });

    // Draggable header
    const dragHandle = document.getElementById('text-panel-drag');
    if (dragHandle) {
        let dragging = false, startX, startY, origLeft, origTop;
        dragHandle.addEventListener('mousedown', e => {
            if (e.target.closest('.btn-icon')) return;
            dragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = panel.getBoundingClientRect();
            origLeft = rect.left;
            origTop = rect.top;
            e.preventDefault();
        });
        document.addEventListener('mousemove', e => {
            if (!dragging) return;
            panel.style.left = (origLeft + e.clientX - startX) + 'px';
            panel.style.top = (origTop + e.clientY - startY) + 'px';
            panel.style.right = 'auto';
        });
        document.addEventListener('mouseup', () => { dragging = false; });
    }

    // Map national center selections to their NWS issuing office codes
    // Some centers use multiple routing IDs (e.g. WPC uses KWNH for discussions but KWBC for QPF)
    const NATIONAL_CENTER_OFFICES = {
        'NHC': ['KNHC'],
        'SPC': ['KWNS'],
        'CPC': ['KWNC'],
        'WPC': ['KWNH', 'KWBC'],
        'OPC': ['KWBC', 'KWNM'],
        'AWC': ['KKCI']
    };

    function updateProductDropdownForLocation(wfo) {
        if (!productSelect) return;
        const currentVal = productSelect.value;

        if (wfo === 'NHC') {
            productSelect.innerHTML = `
                <optgroup label="Tropical Outlooks & Summaries">
                    <option value="TWO">Tropical Weather Outlook (TWO)</option>
                    <option value="TWD">Tropical Weather Discussion (TWD)</option>
                    <option value="TWS">Tropical Weather Summary (TWS)</option>
                </optgroup>
                <optgroup label="Tropical Cyclone Products">
                    <option value="TCP">Public Advisory (TCP)</option>
                    <option value="TCM">Forecast/Advisory - Marine (TCM)</option>
                    <option value="TCD">Forecast Discussion (TCD)</option>
                    <option value="TCU">Tropical Cyclone Update (TCU)</option>
                    <option value="TCE">Position Estimate (TCE)</option>
                    <option value="TCA">Aviation Advisory (TCA)</option>
                    <option value="TCV">Watch/Warning Breakpoints (TCV)</option>
                    <option value="PWS">Wind Speed Probabilities (PWS)</option>
                    <option value="PSH">Post-Storm Report (PSH)</option>
                </optgroup>
                <optgroup label="Marine">
                    <option value="HSF">High Seas Forecast (HSF)</option>
                    <option value="OFF">Offshore Waters Forecast (OFF)</option>
                </optgroup>
            `;
        } else if (wfo === 'SPC') {
            productSelect.innerHTML = `
                <optgroup label="Convective Outlooks">
                    <option value="SWO">Convective Outlook Narrative (SWO)</option>
                    <option value="PTS">Probabilistic Outlook Points (PTS)</option>
                </optgroup>
                <optgroup label="Watches & Discussions">
                    <option value="SEL">Watch Issuance (SEL)</option>
                    <option value="SAW">Watch Notification - Aviation (SAW)</option>
                    <option value="WOU">Watch Outline Update (WOU)</option>
                    <option value="MCD">Mesoscale Discussion (MCD)</option>
                </optgroup>
                <optgroup label="Fire Weather">
                    <option value="FWD">Fire Weather Outlook Discussion (FWD)</option>
                </optgroup>
                <optgroup label="Summaries & Discussions">
                    <option value="PMD">Prognostic Discussion (PMD)</option>
                    <option value="PWO">Public Severe Weather Outlook (PWO)</option>
                </optgroup>
            `;
        } else if (wfo === 'CPC') {
            productSelect.innerHTML = `
                <optgroup label="Outlooks & Discussions">
                    <option value="PMD">Prognostic Discussion (6-10/8-14/Monthly/Seasonal) (PMD)</option>
                    <option value="SCS">Selected Cities Summary (SCS)</option>
                </optgroup>
                <optgroup label="Climate & Drought">
                    <option value="DGT">Drought Information Statement (DGT)</option>
                    <option value="TPT">Temperature/Precipitation Table (TPT)</option>
                    <option value="HMD">Hydromet Discussion (HMD)</option>
                </optgroup>
            `;
        } else if (wfo === 'WPC') {
            productSelect.innerHTML = `
                <optgroup label="Precipitation Forecasts">
                    <option value="QPF">Quantitative Precipitation Forecast (QPF)</option>
                    <option value="QPS">Quantitative Precipitation Statement (QPS)</option>
                </optgroup>
                <optgroup label="Discussions & Analysis">
                    <option value="PMD">Prognostic Discussion (Short Range/Excessive Rain/Snow) (PMD)</option>
                    <option value="HMD">National Hydromet Discussion (HMD)</option>
                    <option value="SCS">Selected Cities Summary (SCS)</option>
                </optgroup>
            `;
        } else if (wfo === 'OPC') {
            productSelect.innerHTML = `
                <optgroup label="High Seas & Offshore">
                    <option value="HSF">High Seas Forecast (HSF)</option>
                    <option value="OFF">Offshore Waters Forecast (OFF)</option>
                </optgroup>
                <optgroup label="Marine Discussions & Warnings">
                    <option value="PMD">Prognostic Discussion (PMD)</option>
                    <option value="MWS">Marine Weather Statement (MWS)</option>
                    <option value="MWW">Marine Weather Message (MWW)</option>
                </optgroup>
            `;
        } else if (wfo === 'AWC') {
            productSelect.innerHTML = `
                <optgroup label="SIGMETs">
                    <option value="SIG">Convective SIGMET (SIG)</option>
                    <option value="WST">Tropical Cyclone SIGMET (WST)</option>
                    <option value="WSV">Volcanic Activity SIGMET (WSV)</option>
                </optgroup>
                <optgroup label="Forecasts & Advisories">
                    <option value="CFP">Convective Forecast Product (CFP)</option>
                    <option value="TCA">Aviation Tropical Cyclone Advisory (TCA)</option>
                </optgroup>
            `;
        } else {
            productSelect.innerHTML = `
                <optgroup label="Forecasts & Discussions (WFO)">
                    <option value="AFD">Area Forecast Discussion (AFD)</option>
                    <option value="ZFP">Zone Forecast Product (ZFP)</option>
                    <option value="PFM">Point Forecast Matrices (PFM)</option>
                    <option value="AFM">Area Forecast Matrices (AFM)</option>
                    <option value="SFT">State Forecast Product (SFT)</option>
                    <option value="SRF">Surf Zone Forecast (SRF)</option>
                    <option value="CWF">Coastal Waters Forecast (CWF)</option>
                    <option value="OFF">Offshore Waters Forecast (OFF)</option>
                    <option value="NSH">Nearshore Marine Forecast (NSH)</option>
                    <option value="GLF">Great Lakes Marine Forecast (GLF)</option>
                </optgroup>
                <optgroup label="Watches, Warnings & Advisories">
                    <option value="HWO">Hazardous Weather Outlook (HWO)</option>
                    <option value="NOW">Short Term Forecast (NOW)</option>
                    <option value="SPS">Special Weather Statement (SPS)</option>
                    <option value="WSW">Winter Weather Message (WSW)</option>
                    <option value="NPW">Non-Precipitation Weather Message (NPW)</option>
                    <option value="FFA">Flash Flood Watch / Advisory (FFA)</option>
                    <option value="FFW">Flash Flood Warning (FFW)</option>
                    <option value="FLS">Flood Statement (FLS)</option>
                    <option value="FLW">Flood Warning (FLW)</option>
                    <option value="CFW">Coastal Hazard Message (CFW)</option>
                    <option value="MWW">Marine Weather Message (MWW)</option>
                </optgroup>
                <optgroup label="Severe Storms & Local Reports">
                    <option value="LSR">Local Storm Report (LSR)</option>
                    <option value="PNS">Public Information Statement (PNS)</option>
                    <option value="RER">Record Event Report (RER)</option>
                    <option value="MWS">Marine Weather Statement (MWS)</option>
                    <option value="TOR">Tornado Warning (TOR)</option>
                    <option value="SVR">Severe Thunderstorm Warning (SVR)</option>
                    <option value="SMW">Special Marine Warning (SMW)</option>
                </optgroup>
                <optgroup label="Climate & Hydrology">
                    <option value="CLI">Daily Climate Report (CLI)</option>
                    <option value="CLM">Monthly Climate Report (CLM)</option>
                    <option value="RTP">Regional Max/Min Temp & Precip (RTP)</option>
                    <option value="ESF">Hydrologic Outlook / Summary (ESF)</option>
                    <option value="RVA">River Summary / Forecast (RVA)</option>
                    <option value="RVD">Daily River Forecast (RVD)</option>
                </optgroup>
                <optgroup label="Fire Weather">
                    <option value="FWF">Fire Weather Forecast (FWF)</option>
                    <option value="FWS">Fire Weather Summary (FWS)</option>
                    <option value="RFD">Rangeland Fire Danger (RFD)</option>
                </optgroup>
                <optgroup label="Aviation">
                    <option value="TAF">Terminal Aerodrome Forecast (TAF)</option>
                    <option value="FA">Area Aviation Forecast (FA)</option>
                    <option value="SIG">SIGMET (SIG)</option>
                    <option value="AIR">AIRMET (AIR)</option>
                    <option value="CWA">Center Weather Advisory (CWA)</option>
                </optgroup>
            `;
        }
        if (Array.from(productSelect.options).some(o => o.value === currentVal)) {
            productSelect.value = currentVal;
        }
    }

    async function loadVersions() {
        const wfo = wfoSelect?.value;
        const product = productSelect?.value;
        if (!wfo || !product || !versionSelect) return;

        versionSelect.innerHTML = '<option value="">Loading history...</option>';
        try {
            let data = null;
            const nationalCenters = ['NHC', 'SPC', 'CPC', 'WPC', 'OPC', 'AWC'];
            if (nationalCenters.includes(wfo)) {
                const res = await fetch(`https://api.weather.gov/products/types/${product}`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                data = await res.json();
            } else {
                let res = await fetch(`https://api.weather.gov/products/types/${product}/locations/${wfo}`);
                if (res.ok) data = await res.json();
                if (!data || !(data['@graph'] || []).length) {
                    // Some products aren't filed under the WFO code — TAFs, for
                    // example, live under airport IDs (MEM, not MEG), so the
                    // locations/{wfo} lookup comes back EMPTY (not 404) for any
                    // office whose code differs from its airports'. Query by
                    // issuing office instead, which works for all of them.
                    res = await fetch(`https://api.weather.gov/products?type=${product}&office=K${wfo}&limit=25`);
                    if (res.ok) {
                        const byOffice = await res.json();
                        if ((byOffice['@graph'] || []).length) data = byOffice;
                    }
                }
                if (!data) {
                    const res2 = await fetch(`https://api.weather.gov/products/types/${product}`);
                    if (!res2.ok) throw new Error(`HTTP ${res2.status}`);
                    data = await res2.json();
                }
            }
            let products = data['@graph'] || [];

            // Filter by issuing office for national centers
            if (nationalCenters.includes(wfo)) {
                const officeCodes = NATIONAL_CENTER_OFFICES[wfo];
                if (officeCodes && officeCodes.length > 0) {
                    const officeFiltered = products.filter(p => officeCodes.includes(p.issuingOffice));
                    if (officeFiltered.length > 0) products = officeFiltered;
                }
            } else {
                const filtered = products.filter(p => (p.issuingOffice && p.issuingOffice.includes(wfo)) || (p.id && p.id.includes(wfo)) || (p.issuingOffice && p.issuingOffice === `K${wfo}`));
                if (filtered.length > 0) products = filtered;
            }

            // Filter out Spanish-language products
            const englishFiltered = products.filter(p => !p.productName || (!p.productName.includes('Perspectiva') && !p.productName.includes('Resumen') && !p.productName.includes('Aviso') && !p.productName.includes('Boletin')));
            if (englishFiltered.length > 0) products = englishFiltered;

            versionSelect.innerHTML = '';
            if (products.length === 0) {
                const opt = document.createElement('option');
                opt.value = '';   // explicit: an <option> without value returns its TEXT as .value, which FETCH then requested as a URL (the "Error: HTTP 404")
                opt.textContent = '-- No Products Found --';
                versionSelect.appendChild(opt);
                return;
            }

            products.slice(0, 25).forEach((p, i) => {
                const opt = document.createElement('option');
                opt.value = p['@id'] || `https://api.weather.gov/products/${p.id}`;
                const d = new Date(p.issuanceTime);
                const dateStr = d.toLocaleString('en-US', { 
                    month: 'short', day: 'numeric', 
                    hour: '2-digit', minute: '2-digit', second: '2-digit',
                    hour12: true 
                });
                const title = p.productName ? `[${p.productName}] ` : '';
                opt.textContent = (i === 0 ? `[LATEST] ${title}— ${dateStr}` : `Prev ${title}— ${dateStr}`);
                versionSelect.appendChild(opt);
            });
        } catch (e) {
            versionSelect.innerHTML = '<option value="">Error loading history</option>';
            addLiveLog(`TEXT ERROR: ${e.message}`, '#ff3333');
        }
    }

    wfoSelect?.addEventListener('change', () => {
        if (wfoSelect) updateProductDropdownForLocation(wfoSelect.value);
        loadVersions();
    });
    productSelect?.addEventListener('change', loadVersions);

    if (fetchBtn) fetchBtn.addEventListener('click', async () => {
        const url = versionSelect?.value;
        if (!url) return;

        addLiveLog(`TEXT: Fetching selected version...`, '#00e5ff');
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (contentEl) contentEl.textContent = data.productText || 'No text available.';
            addLiveLog(`TEXT: Product loaded`, '#00ff88');
        } catch (e) {
            if (contentEl) contentEl.textContent = `Error: ${e.message}`;
            addLiveLog(`TEXT ERROR: ${e.message}`, '#ff3333');
        }
    });

    // Initial load of versions
    if (wfoSelect) updateProductDropdownForLocation(wfoSelect.value);
    loadVersions();
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 15: PRODUCT SIDEBAR INTERACTION
// ═══════════════════════════════════════════════════════════════════════════════

function isLayerVisible(map, layerId) {
    if (!map || !map.getLayer(layerId)) return false;
    try {
        return map.getLayoutProperty(layerId, 'visibility') === 'visible';
    } catch (e) { return false; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 12b: FORECAST METEOGRAM (NWS hourly gridpoint forecast)
// ═══════════════════════════════════════════════════════════════════════════════

let meteoData = null;       // { allPeriods, placeName, genTime } — last fetch, for re-ranging
let meteoHoverCtx = null;   // geometry + data for the hover crosshair / readout
function meteoHours() {
    const el = document.getElementById('meteogram-hours');
    return el ? (parseInt(el.value, 10) || 48) : 48;
}

// Make each left-sidebar category group collapsible (click the label).
// New users get a lean first view (only the core imagery sections open); any
// section the user has toggled is remembered and overrides that default.
const DEFAULT_EXPANDED_GROUPS = new Set(['NWS WARNINGS', 'RADAR (NEXRAD)', 'Satellite (GOES)']);
function initCollapsibleGroups() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('fxnet_collapsed_groups') || '{}'); } catch (e) { }
    const persist = () => { try { localStorage.setItem('fxnet_collapsed_groups', JSON.stringify(saved)); } catch (e) { } };
    const groups = [...document.querySelectorAll('.product-browser .category-group')];
    groups.forEach(group => {
        const label = group.querySelector('.category-label');
        if (!label) return;
        const key = (label.textContent || '').trim();
        // Explicit user choice wins; otherwise fall back to the default.
        const collapsed = (key in saved) ? saved[key] : !DEFAULT_EXPANDED_GROUPS.has(key);
        group.classList.toggle('collapsed', collapsed);
        label.addEventListener('click', () => {
            group.classList.toggle('collapsed');
            saved[key] = group.classList.contains('collapsed');
            persist();
        });
    });

    const setAll = collapse => {
        groups.forEach(group => {
            const label = group.querySelector('.category-label');
            if (!label) return;
            group.classList.toggle('collapsed', collapse);
            saved[(label.textContent || '').trim()] = collapse;
        });
        persist();
    };
    const expandBtn = document.getElementById('expand-all-groups');
    const collapseBtn = document.getElementById('collapse-all-groups');
    if (expandBtn) expandBtn.addEventListener('click', () => setAll(false));
    if (collapseBtn) collapseBtn.addEventListener('click', () => setAll(true));
}

// Live filter over the product tree. 136 products across 18 mostly-collapsed
// groups is more than is practical to find by scrolling, and unlike the group
// headers this needs no prior knowledge of which category a product lives in.
// Matching is a plain case-insensitive substring test against the product's
// label plus its category name, so "vel" finds Velocity and "trop" finds
// everything under NHC TROPICAL.
function initProductFilter() {
    const input = document.getElementById('product-filter');
    const browser = document.querySelector('.product-browser');
    const clearBtn = document.getElementById('product-filter-clear');
    const emptyMsg = document.getElementById('product-filter-empty');
    if (!input || !browser) return;

    const groups = Array.from(browser.querySelectorAll('.category-group')).map(g => {
        const label = (g.querySelector('.category-label')?.textContent || '').trim();
        return {
            el: g,
            cat: label.toLowerCase(),
            items: Array.from(g.querySelectorAll(':scope > .product-item')).map(el => ({
                el,
                // The label span; the trailing badge (LIVE/NODD/…) is a sibling
                // and is deliberately not part of the match text.
                span: el.querySelector('span'),
                text: (el.querySelector('span')?.textContent || '').trim(),
            })),
        };
    });

    // Cache the original label markup so highlighting can be undone cleanly.
    groups.forEach(g => g.items.forEach(it => { if (it.span) it.span.dataset.orig = it.span.textContent; }));

    const clearHighlight = it => {
        if (it.span && it.span.dataset.orig != null) it.span.textContent = it.span.dataset.orig;
    };

    const apply = q => {
        const query = q.trim().toLowerCase();
        if (clearBtn) clearBtn.style.display = query ? 'block' : 'none';

        if (!query) {
            browser.classList.remove('filtering');
            groups.forEach(g => {
                g.el.classList.remove('filter-hit');
                g.items.forEach(it => { it.el.classList.remove('filter-miss'); clearHighlight(it); });
            });
            if (emptyMsg) emptyMsg.style.display = 'none';
            return;
        }

        browser.classList.add('filtering');
        let total = 0;
        groups.forEach(g => {
            const catMatch = g.cat.includes(query);
            let hits = 0;
            g.items.forEach(it => {
                const hit = catMatch || it.text.toLowerCase().includes(query);
                it.el.classList.toggle('filter-miss', !hit);
                clearHighlight(it);
                if (hit) {
                    hits++;
                    // Highlight the matched run in the label itself.
                    const i = it.text.toLowerCase().indexOf(query);
                    if (i >= 0 && it.span) {
                        it.span.innerHTML =
                            esc(it.text.slice(0, i)) +
                            '<mark>' + esc(it.text.slice(i, i + query.length)) + '</mark>' +
                            esc(it.text.slice(i + query.length));
                    }
                }
            });
            g.el.classList.toggle('filter-hit', hits > 0);
            total += hits;
        });
        if (emptyMsg) emptyMsg.style.display = total ? 'none' : 'block';
    };

    input.addEventListener('input', () => apply(input.value));
    input.addEventListener('keydown', e => {
        if (e.key === 'Escape') { input.value = ''; apply(''); input.blur(); }
    });
    if (clearBtn) clearBtn.addEventListener('click', () => { input.value = ''; apply(''); input.focus(); });
}

// Fold the whole left menu off-screen to give the map full width.
function initSidebarCollapse() {
    const container = document.querySelector('.app-container');
    if (!container) return;

    // Re-fit every map after the slide transition settles.
    const resizeMaps = () => {
        try { Object.values(maps || {}).forEach(m => m && m.resize()); } catch (e) { }
    };

    const setCollapsed = (collapsed, persist = true) => {
        container.classList.toggle('sidebar-collapsed', collapsed);
        if (persist) {
            try { localStorage.setItem('fxnet_sidebar_collapsed', collapsed ? '1' : '0'); } catch (e) { }
        }
        // MapLibre needs a couple of resizes across the 0.22s slide.
        setTimeout(resizeMaps, 60);
        setTimeout(resizeMaps, 260);
    };

    let startCollapsed = false;
    try { startCollapsed = localStorage.getItem('fxnet_sidebar_collapsed') === '1'; } catch (e) { }
    if (startCollapsed) setCollapsed(true, false);

    const collapseBtn = document.getElementById('sidebar-collapse');
    const reopenBtn = document.getElementById('sidebar-reopen');
    if (collapseBtn) collapseBtn.addEventListener('click', () => setCollapsed(true));
    if (reopenBtn) reopenBtn.addEventListener('click', () => setCollapsed(false));

    // Ctrl/Cmd+\ toggles the menu.
    document.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key === '\\') {
            e.preventDefault();
            setCollapsed(!container.classList.contains('sidebar-collapsed'));
        }
    });
}

function initMeteogram() {
    const panel = document.getElementById('meteogram-panel');
    if (!panel) return;
    const openBtn = document.getElementById('btn-meteogram');
    const closeBtn = document.getElementById('close-meteogram-panel');
    const refreshBtn = document.getElementById('meteogram-refresh');
    const hoursSel = document.getElementById('meteogram-hours');
    // Re-range without refetching — just re-render the cached forecast.
    if (hoursSel) hoursSel.addEventListener('change', () => {
        if (meteoData) renderMeteogram(document.getElementById('meteogram-body'), meteoData.allPeriods, meteoData.placeName, meteoData.genTime, meteoHours());
    });

    if (openBtn) openBtn.addEventListener('click', () => {
        const opening = panel.style.display === 'none' || !panel.style.display;
        panel.style.display = opening ? 'flex' : 'none';
        if (opening && !panel.dataset.loaded) loadMeteogram();
    });
    if (closeBtn) closeBtn.addEventListener('click', () => { panel.style.display = 'none'; });
    if (refreshBtn) refreshBtn.addEventListener('click', () => loadMeteogram());

    // ZIP / city search
    const goBtn = document.getElementById('meteogram-go');
    const placeInput = document.getElementById('meteogram-place');
    const runPlaceSearch = async () => {
        const body = document.getElementById('meteogram-body');
        const locEl = document.getElementById('meteogram-loc');
        try {
            if (locEl) locEl.textContent = 'Searching…';
            const g = await geocodePlace(placeInput.value);
            await loadMeteogramAt(g.lat, g.lon, g.label);
            panel.dataset.loaded = '1';
        } catch (e) {
            if (locEl) locEl.textContent = '—';
            if (body) body.innerHTML = `<div style="color:#ffb300;font-size:12px;padding:20px;line-height:1.5;">${esc(e.message)}</div>`;
        }
    };
    if (goBtn) goBtn.addEventListener('click', runPlaceSearch);
    if (placeInput) placeInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); runPlaceSearch(); } });

    // Draggable header (same pattern as the text panel)
    const handle = document.getElementById('meteogram-drag');
    if (handle) {
        let dragging = false, startX, startY, origLeft, origTop;
        handle.addEventListener('mousedown', e => {
            if (e.target.closest('.btn-icon')) return;
            dragging = true; startX = e.clientX; startY = e.clientY;
            const rect = panel.getBoundingClientRect();
            origLeft = rect.left; origTop = rect.top; e.preventDefault();
        });
        document.addEventListener('mousemove', e => {
            if (!dragging) return;
            panel.style.left = (origLeft + e.clientX - startX) + 'px';
            panel.style.top = (origTop + e.clientY - startY) + 'px';
            panel.style.right = 'auto';
        });
        document.addEventListener('mouseup', () => { dragging = false; });
    }
}

// Geocode a ZIP code or city name to a lat/lon (keyless, CORS-enabled):
// 5-digit ZIP → Zippopotam.us, otherwise city name → Open-Meteo geocoding.
async function geocodePlace(qRaw) {
    const q = (qRaw || '').trim();
    if (!q) throw new Error('Enter a ZIP code or city name.');
    if (/^\d{5}$/.test(q)) {
        const r = await fetch(`https://api.zippopotam.us/us/${q}`);
        if (!r.ok) throw new Error(`ZIP ${q} not found.`);
        const j = await r.json();
        const pl = j.places && j.places[0];
        if (!pl) throw new Error(`ZIP ${q} not found.`);
        return { lat: +pl.latitude, lon: +pl.longitude, label: `${pl['place name']}, ${pl['state abbreviation']} ${q}` };
    }
    // Split off a trailing state ("City, ST" or "City ST") so we can query the
    // bare city name and filter results to that state (Open-Meteo admin1 = full name).
    let name = q, stateFull = '';
    if (q.includes(',')) {
        const parts = q.split(',');
        name = parts[0].trim();
        const st = parts[1].trim();
        stateFull = (US_STATE_NAMES[st.toUpperCase()] || st).toLowerCase();
    } else {
        const toks = q.split(/\s+/);
        const last = (toks[toks.length - 1] || '').toUpperCase();
        if (toks.length > 1 && US_STATE_NAMES[last]) {
            stateFull = US_STATE_NAMES[last].toLowerCase();
            name = toks.slice(0, -1).join(' ');
        }
    }
    const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=10&language=en&format=json`);
    if (!r.ok) throw new Error('Geocoding failed.');
    const j = await r.json();
    const results = j.results || [];
    let pool = results.filter(x => x.country_code === 'US');
    if (!pool.length) pool = results;
    let hit;
    if (stateFull) hit = pool.find(x => (x.admin1 || '').toLowerCase() === stateFull) || pool.find(x => (x.admin1 || '').toLowerCase().includes(stateFull));
    hit = hit || pool[0];
    if (!hit) throw new Error(`No match for “${q}”.`);
    return { lat: hit.latitude, lon: hit.longitude, label: `${hit.name}${hit.admin1 ? ', ' + hit.admin1 : ''}` };
}
const US_STATE_NAMES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia', PR: 'Puerto Rico' };

function loadMeteogram() {
    const map = maps[activePaneId] || Object.values(maps)[0];
    if (!map) return;
    const c = map.getCenter();
    return loadMeteogramAt(c.lat, c.lng);
}

async function loadMeteogramAt(latNum, lonNum, presetLabel) {
    const body = document.getElementById('meteogram-body');
    const locEl = document.getElementById('meteogram-loc');
    const panel = document.getElementById('meteogram-panel');
    if (!body) return;
    const lat = (+latNum).toFixed(4), lon = (+lonNum).toFixed(4);

    if (locEl) locEl.textContent = presetLabel ? `Resolving ${presetLabel}…` : 'Resolving location…';
    body.innerHTML = `<div style="color:#6b7a88;font-size:12px;padding:20px;">Fetching NWS hourly forecast for ${presetLabel || (lat + ', ' + lon)}…</div>`;
    try {
        const pRes = await fetch(`https://api.weather.gov/points/${lat},${lon}`, { headers: { 'Accept': 'application/geo+json' } });
        if (!pRes.ok) throw new Error(pRes.status === 404 ? 'NWS point forecasts cover the U.S. and territories only — pan the map over land in the U.S.' : `points ${pRes.status}`);
        const pj = await pRes.json();
        const pp = pj.properties || {};
        const rl = (pp.relativeLocation && pp.relativeLocation.properties) || {};
        const placeName = rl.city ? `${rl.city}, ${rl.state}` : (presetLabel || `${lat}, ${lon}`);
        if (locEl) locEl.textContent = `${placeName} · ${lat}, ${lon} · ${pp.gridId || ''} ${pp.gridX || ''},${pp.gridY || ''}`;

        const hRes = await fetch(pp.forecastHourly, { headers: { 'Accept': 'application/geo+json' } });
        if (!hRes.ok) throw new Error(`hourly ${hRes.status}`);
        const hj = await hRes.json();
        const periods = (hj.properties && hj.properties.periods) || [];
        if (!periods.length) throw new Error('no forecast periods returned');

        meteoData = { allPeriods: periods, placeName, genTime: hj.properties.generatedAt };
        renderMeteogram(body, meteoData.allPeriods, meteoData.placeName, meteoData.genTime, meteoHours());
        panel.dataset.loaded = '1';
    } catch (e) {
        if (locEl) locEl.textContent = '—';
        body.innerHTML = `<div style="color:#ffb300;font-size:12px;padding:20px;line-height:1.5;">Couldn’t load the meteogram.<br><span style="color:#8b97a3;">${esc(e.message)}</span></div>`;
    }
}

// Build a clean 3-panel SVG meteogram (temp/dewpoint, PoP, wind) from the
// NWS hourly forecast periods. Temp is °F; dewpoint comes in °C → convert.
// `hours` = how far out to plot (NWS hourly runs ~156 h).
function renderMeteogram(body, allPeriods, placeName, genTime, hours) {
    const N = Math.min(allPeriods.length, hours || 48);
    const periods = allPeriods.slice(0, N);
    const W = 740, mL = 42, mR = 16, plotW = W - mL - mR;
    const x = i => mL + (N <= 1 ? 0 : i * plotW / (N - 1));
    const dx = N <= 1 ? 0 : plotW / (N - 1);

    // ── data ──
    const temps = periods.map(p => p.temperature);
    let lastDew = null;
    const dews = periods.map(p => {
        const v = p.dewpoint && p.dewpoint.value;
        if (v != null) lastDew = v * 9 / 5 + 32;
        return lastDew;
    });
    const pops = periods.map(p => (p.probabilityOfPrecipitation && p.probabilityOfPrecipitation.value) || 0);
    const winds = periods.map(p => parseInt(p.windSpeed, 10) || 0);
    const dirs = periods.map(p => p.windDirection || '');

    const allT = temps.concat(dews.filter(v => v != null));
    let tLo = Math.floor((Math.min(...allT) - 3) / 5) * 5;
    let tHi = Math.ceil((Math.max(...allT) + 3) / 5) * 5;
    if (tHi === tLo) tHi = tLo + 10;
    const wMax = Math.max(10, Math.ceil(Math.max(...winds) / 5) * 5);

    // ── panel geometry ──
    const panels = {
        temp: { top: 54, h: 122 },
        pop:  { top: 206, h: 84 },
        wind: { top: 320, h: 84 }
    };
    const yScale = (v, lo, hi, P) => P.top + P.h - ((v - lo) / (hi - lo)) * P.h;
    const C = { temp: '#ff5a52', dew: '#33c27a', pop: '#4a9eff', wind: '#00e5ff', grid: '#1b2530', mid: '#2b3a47', axis: '#8b97a3', lab: '#cdd6df' };
    const wd = ds => { const [Y, M, D] = ds.split('-').map(Number); return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Y, M - 1, D).getDay()]; };
    // Thin labels out as the range grows so the time axis stays readable.
    const tickHrs = N <= 48 ? 6 : (N <= 96 ? 12 : 24);

    const svg = [];
    svg.push(`<svg viewBox="0 0 ${W} 470" width="100%" style="font-family:'Consolas','Monaco',monospace;display:block;">`);
    svg.push(`<rect x="0" y="0" width="${W}" height="470" fill="#050505"/>`);

    // Title + legend
    svg.push(`<text x="${mL}" y="18" fill="${C.lab}" font-size="12" font-weight="700">${placeName}</text>`);
    svg.push(`<text x="${mL}" y="31" fill="${C.axis}" font-size="9">NWS hourly forecast · next ${N} h${genTime ? ' · issued ' + genTime.substring(11, 16) + 'Z' : ''}</text>`);
    const leg = [['Temp', C.temp], ['Dewpt', C.dew], ['PoP', C.pop], ['Wind', C.wind]];
    let lx = W - mR;
    leg.slice().reverse().forEach(([t, col]) => {
        lx -= (t.length * 6 + 18);
        svg.push(`<rect x="${lx}" y="11" width="9" height="9" rx="2" fill="${col}"/><text x="${lx + 13}" y="19" fill="${C.axis}" font-size="9">${t}</text>`);
    });

    // Time gridlines + bottom axis (shared)
    const axTop = panels.temp.top, axBot = panels.wind.top + panels.wind.h;
    periods.forEach((p, i) => {
        const hh = parseInt(p.startTime.substr(11, 2), 10);
        if (hh % tickHrs !== 0) return;
        const midnight = hh === 0;
        svg.push(`<line x1="${x(i).toFixed(1)}" y1="${axTop}" x2="${x(i).toFixed(1)}" y2="${axBot}" stroke="${midnight ? C.mid : C.grid}" stroke-width="1"/>`);
        svg.push(`<text x="${x(i).toFixed(1)}" y="${axBot + 14}" fill="${C.axis}" font-size="8.5" text-anchor="middle">${String(hh).padStart(2, '0')}</text>`);
        if (midnight) svg.push(`<text x="${x(i).toFixed(1)}" y="${axBot + 26}" fill="${C.lab}" font-size="8.5" text-anchor="middle" font-weight="700">${wd(p.startTime.substr(0, 10))} ${p.startTime.substr(5, 5)}</text>`);
    });

    // ── helper to draw a panel frame + horizontal gridlines/labels ──
    const drawAxis = (P, lo, hi, step, fmt, title) => {
        svg.push(`<text x="${mL}" y="${P.top - 5}" fill="${C.lab}" font-size="9" font-weight="700">${title}</text>`);
        for (let v = lo; v <= hi + 0.001; v += step) {
            const yy = yScale(v, lo, hi, P).toFixed(1);
            svg.push(`<line x1="${mL}" y1="${yy}" x2="${W - mR}" y2="${yy}" stroke="${C.grid}" stroke-width="1"/>`);
            svg.push(`<text x="${mL - 5}" y="${(+yy + 3)}" fill="${C.axis}" font-size="8.5" text-anchor="end">${fmt(v)}</text>`);
        }
    };
    const poly = (vals, P, lo, hi, col, w) => {
        const pts = vals.map((v, i) => v == null ? null : `${x(i).toFixed(1)},${yScale(v, lo, hi, P).toFixed(1)}`).filter(Boolean).join(' ');
        return `<polyline points="${pts}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linejoin="round"/>`;
    };

    // Temp / dewpoint
    drawAxis(panels.temp, tLo, tHi, (tHi - tLo) > 40 ? 10 : 5, v => `${v}°`, 'TEMP / DEWPOINT (°F)');
    svg.push(poly(dews, panels.temp, tLo, tHi, C.dew, 1.8));
    svg.push(poly(temps, panels.temp, tLo, tHi, C.temp, 2));

    // PoP bars
    drawAxis(panels.pop, 0, 100, 25, v => `${v}`, 'PRECIP PROBABILITY (%)');
    const bw = Math.max(1.5, plotW / N * 0.6);
    pops.forEach((v, i) => {
        if (!v) return;
        const yy = yScale(v, 0, 100, panels.pop);
        svg.push(`<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${yy.toFixed(1)}" width="${bw.toFixed(1)}" height="${(panels.pop.top + panels.pop.h - yy).toFixed(1)}" fill="${C.pop}" opacity="0.65"/>`);
    });

    // Wind speed + direction labels
    drawAxis(panels.wind, 0, wMax, wMax / 2, v => `${v}`, 'WIND (mph)');
    svg.push(poly(winds, panels.wind, 0, wMax, C.wind, 2));
    periods.forEach((p, i) => {
        const hh = parseInt(p.startTime.substr(11, 2), 10);
        if (hh % tickHrs !== 0 || !dirs[i]) return;
        svg.push(`<text x="${x(i).toFixed(1)}" y="${(panels.wind.top + 10)}" fill="${C.axis}" font-size="8" text-anchor="middle">${dirs[i]}</text>`);
    });

    // Hover crosshair + per-series markers (positioned on mousemove)
    svg.push(`<line id="meteo-cross" x1="0" y1="${axTop}" x2="0" y2="${axBot}" stroke="#ffffff" stroke-opacity="0.45" stroke-width="1" stroke-dasharray="3 3" style="display:none"/>`);
    ['temp', 'dew', 'wind', 'pop'].forEach(k => svg.push(`<circle id="meteo-mk-${k}" r="3.2" fill="${C[k] || C.pop}" stroke="#000" stroke-width="0.8" style="display:none"/>`));

    svg.push(`</svg>`);

    body.style.position = 'relative';
    body.innerHTML = `<div id="meteo-readout" style="font-family:'Consolas','Monaco',monospace;font-size:11px;color:#6b7a88;padding:1px 2px 7px;min-height:15px;">Hover the chart for values</div>` + svg.join('');

    // Stash everything the hover handler needs, then wire it up.
    meteoHoverCtx = { N, mL, dx, periods, temps, dews, winds, pops, dirs, tLo, tHi, wMax, panels, wd };
    attachMeteoHover(body.querySelector('svg'));
}

// Crosshair + live readout for the meteogram. Maps the cursor to the nearest
// hour, moves the crosshair + markers, and writes the values to #meteo-readout.
function attachMeteoHover(svg) {
    if (!svg) return;
    const readout = document.getElementById('meteo-readout');
    const cross = svg.querySelector('#meteo-cross');
    const mk = { temp: svg.querySelector('#meteo-mk-temp'), dew: svg.querySelector('#meteo-mk-dew'), wind: svg.querySelector('#meteo-mk-wind'), pop: svg.querySelector('#meteo-mk-pop') };
    const yS = (v, lo, hi, P) => P.top + P.h - ((v - lo) / (hi - lo)) * P.h;
    const hide = () => {
        if (cross) cross.style.display = 'none';
        Object.values(mk).forEach(m => m && (m.style.display = 'none'));
        if (readout) readout.innerHTML = '<span style="color:#6b7a88">Hover the chart for values</span>';
    };
    svg.addEventListener('mousemove', e => {
        const ctx = meteoHoverCtx; if (!ctx || !cross) return;
        const ctm = svg.getScreenCTM(); if (!ctm) return;
        const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
        const loc = pt.matrixTransform(ctm.inverse());
        let i = ctx.dx ? Math.round((loc.x - ctx.mL) / ctx.dx) : 0;
        i = Math.max(0, Math.min(ctx.N - 1, i));
        const px = ctx.mL + i * ctx.dx;
        cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.style.display = '';
        const setMk = (m, v, lo, hi, P) => {
            if (!m) return;
            if (v == null) { m.style.display = 'none'; return; }
            m.setAttribute('cx', px.toFixed(1)); m.setAttribute('cy', yS(v, lo, hi, P).toFixed(1)); m.style.display = '';
        };
        setMk(mk.temp, ctx.temps[i], ctx.tLo, ctx.tHi, ctx.panels.temp);
        setMk(mk.dew, ctx.dews[i], ctx.tLo, ctx.tHi, ctx.panels.temp);
        setMk(mk.wind, ctx.winds[i], 0, ctx.wMax, ctx.panels.wind);
        setMk(mk.pop, ctx.pops[i], 0, 100, ctx.panels.pop);
        if (readout) {
            const p = ctx.periods[i];
            const d = ctx.dews[i] != null ? Math.round(ctx.dews[i]) : '–';
            readout.innerHTML = `<b style="color:#cdd6df">${ctx.wd(p.startTime.substr(0, 10))} ${p.startTime.substr(11, 5)}</b> &nbsp; <span style="color:#ff5a52">${ctx.temps[i]}°F</span> / <span style="color:#33c27a">${d}°F dew</span> &nbsp; <span style="color:#4a9eff">PoP ${ctx.pops[i]}%</span> &nbsp; <span style="color:#00e5ff">${ctx.dirs[i] || ''} ${ctx.winds[i]} mph</span>`;
        }
    });
    svg.addEventListener('mouseleave', hide);
    hide();
}

// Is this sidebar product-item currently showing on pane `pid`'s map? Single
// source of truth shared by the sidebar active-state sync and the per-pane
// workspace snapshot (saveTabs → overlay restore on reload).
function productItemActiveOn(pid, item) {
    const map = maps[pid];
    if (!map) return false;
    const layer = item.getAttribute('data-layer');
    if (!layer) return false;

    let isActive = false;
    if (layer === 'airnow-aqi') isActive = isLayerVisible(map, 'airnow-aqi-layer');
    else if (layer === 'metars') isActive = isLayerVisible(map, 'metars-temp');
    else if (layer === 'radar-l3') isActive = isLayerVisible(map, 'radar-l3-layer') && paneL3[pid] && paneL3[pid].product.charAt(2) === (item.getAttribute('data-l3') || '').charAt(2);
    else if (layer === 'storm-attr') isActive = isLayerVisible(map, 'storm-attr-cell');
    else if (layer === 'nodd-meso') isActive = isLayerVisible(map, 'meso-circ');
    else if (layer === 'radar-ref') isActive = isLayerVisible(map, 'radar-layer') || isLayerVisible(map, 'site-bref-layer');
    else if (layer === 'radar-vel') isActive = isLayerVisible(map, 'site-bvel-layer');
    else if (layer === 'radar-hc') isActive = isLayerVisible(map, 'site-bdhc-layer');
    else if (layer === 'radar-stp') isActive = isLayerVisible(map, 'site-bdsa-layer');
    else if (layer === 'radar-oha') isActive = isLayerVisible(map, 'site-boha-layer');
    else if (layer === 'goes-ch') {
        const ch = parseInt(item.getAttribute('data-channel'));
        isActive = isLayerVisible(map, 'satellite-layer') && paneGoesChannels[pid] === ch;
    }
    else if (layer === 'gibs-sat') isActive = isLayerVisible(map, 'gibs-sat-layer') && paneGibs[pid] === item.getAttribute('data-gibs');
    else if (layer === 'lightning') isActive = isLayerVisible(map, 'lightning-layer');
    else if (layer === 'hms-smoke') isActive = isLayerVisible(map, 'hms-smoke-fill');
    else if (layer === 'firms-fires') isActive = isLayerVisible(map, 'firms-fires-layer');
    else if (layer === 'nws-warnings-only') isActive = isLayerVisible(map, 'nws-warnings-only-fill');
    else if (layer === 'nws-advisories-only') isActive = isLayerVisible(map, 'nws-advis-fill');
    else if (layer === 'nws-watches-only') isActive = isLayerVisible(map, 'nws-watches-only-fill');
    else if (layer === 'nws-wwa') isActive = isLayerVisible(map, 'nws-wwa-wms-layer');
    else if (layer === 'spc-md') isActive = isLayerVisible(map, 'spc-md-fill');
    else if (layer === 'wpc-mpd') isActive = isLayerVisible(map, 'wpc-mpd-fill');
    else if (layer === 'spc-lsr') isActive = isLayerVisible(map, 'spc-lsr-icons');
    else if (layer === 'probsevere') isActive = isLayerVisible(map, 'probsevere-fill');
    else if (layer === 'nexrad-attr') isActive = isLayerVisible(map, 'natt-cell');
    else if (layer === 'airsigmet') isActive = isLayerVisible(map, 'airsigmet-fill');
    else if (layer === 'gairmet') isActive = isLayerVisible(map, 'gairmet-fill');
    else if (layer === 'pireps') isActive = isLayerVisible(map, 'pireps-layer');
    else if (layer === 'taf') isActive = isLayerVisible(map, 'taf-layer');
    else if (layer === 'cwa') isActive = isLayerVisible(map, 'cwa-fill');
    else if (layer === 'ndbc') isActive = isLayerVisible(map, 'ndbc-layer');
    else if (layer === 'spc-d48') isActive = isLayerVisible(map, 'spc-d48-fill');
    else if (layer === 'ndfd-temp') isActive = isLayerVisible(map, 'ndfd-temp-layer');
    else if (layer === 'spc-outlook') {
        const day = item.getAttribute('data-day');
        isActive = isLayerVisible(map, `spc-day${day}-fill`);
    }
    else if (layer === 'spc-prob') {
        const day = item.getAttribute('data-day');
        const hazard = item.getAttribute('data-hazard');
        isActive = isLayerVisible(map, `spc-prob-${day}-${hazard}-fill`);
    }
    else if (layer === 'wpc-ero') {
        const day = item.getAttribute('data-day');
        isActive = isLayerVisible(map, `wpc-ero-day${day}-fill`);
    }
    else if (layer === 'spc-firewx') {
        const day = item.getAttribute('data-day');
        isActive = isLayerVisible(map, `spc-firewx-day${day}-fill`);
    }
    else if (layer === 'overlay-states') isActive = isLayerVisible(map, 'states-layer');
    else if (layer === 'overlay-counties') isActive = isLayerVisible(map, 'counties-layer');
    else if (layer === 'overlay-roads') isActive = isLayerVisible(map, 'esri-roads-layer');
    else if (layer === 'overlay-cities') isActive = isLayerVisible(map, 'esri-labels-layer');
    else if (layer === 'overlay-cwa') isActive = isLayerVisible(map, 'nws-cwa-layer');
    else if (layer === 'river-gauges') isActive = isLayerVisible(map, 'river-gauges-layer');
    else if (layer === 'solar-terminator') isActive = isLayerVisible(map, 'solar-night-fill');
    else if (layer === 'wpc-isobars') isActive = isLayerVisible(map, 'wpc-isobars-line');
    else if (SFC_CONTOUR_FIELDS[layer]) isActive = isLayerVisible(map, layer + '-line');
    else if (layer === 'wpc-fronts') isActive = isLayerVisible(map, 'wpc-fronts-solid');
    else if (layer === 'wpc-qpf') {
        const qpfId = item.getAttribute('data-qpf');
        isActive = isLayerVisible(map, 'wpc-qpf-layer') && paneQpf[pid] === qpfId;
    }
    else if (layer === 'nhc-storms') isActive = isLayerVisible(map, 'nhc-track-pts');
    else if (layer === 'nhc-fcst-history') isActive = isLayerVisible(map, 'nhc-fcst-lines');
    else if (layer === 'nhc-outlook') isActive = isLayerVisible(map, 'nhc-outlook-fill');
    else if (layer === 'recon-hdob') isActive = isLayerVisible(map, 'recon-hdob-pts');
    else if (layer === 'adeck') {
        isActive = isLayerVisible(map, 'adeck-lines') && adeckMode === item.getAttribute('data-adeck');
    }
    else if (layer === 'nhc-two-atl' || layer === 'nhc-two-epac') {
        const tp = document.getElementById('text-panel');
        isActive = !!tp && tp.style.display !== 'none' && tp.dataset.openedBy === layer;
    }
    else if (layer === 'cpc-temp') {
        const period = item.getAttribute('data-period');
        isActive = isLayerVisible(map, 'cpc-temp-layer') && paneCpcTemp[pid] === period;
    }
    else if (layer === 'cpc-precip') {
        const period = item.getAttribute('data-period');
        isActive = isLayerVisible(map, 'cpc-precip-layer') && paneCpcPrecip[pid] === period;
    }
    else if (layer === 'mrms-echotops') isActive = isLayerVisible(map, 'mrms-echotops-layer');
    else if (layer === 'mrms-qpe') {
        const qpePeriod = item.getAttribute('data-qpe');
        isActive = isLayerVisible(map, 'mrms-qpe-layer') && paneMrmsQpe[pid] === qpePeriod;
    }
    else if (layer === 'drought-monitor') isActive = isLayerVisible(map, 'drought-fill');
    else if (layer === 'cpc-drought-outlook') isActive = isLayerVisible(map, 'cpc-drought-layer');

    return isActive;
}

function updateSidebarToActivePane() {
    const map = maps[activePaneId];
    if (!map) return;

    document.querySelectorAll('.product-item').forEach(item => {
        if (!item.getAttribute('data-layer')) return;
        if (productItemActiveOn(activePaneId, item)) item.classList.add('active');
        else item.classList.remove('active');
    });

    const sectorSelect = document.getElementById('goes-sector-select');
    if (sectorSelect) {
        const secKey = goesSectorFor(activePaneId);
        if (sectorSelect.value !== secKey) sectorSelect.value = secKey;
    }

    const site = paneRadarSites[activePaneId] || 'DGX';
    const siteSelect = document.getElementById('radar-site-select');
    if (siteSelect && siteSelect.value !== site) {
        if (Array.from(siteSelect.options).some(o => o.value === site)) {
            siteSelect.value = site;
        }
    }
    const badge = document.getElementById('radar-mode-badge');
    if (badge) {
        if (site.includes('nexrad')) {
            badge.textContent = 'National'; badge.className = 'badge blue';
        } else {
            badge.textContent = site; badge.className = 'badge orange';
        }
    }
    const prod = paneRadarProducts[activePaneId] || 'sr_bref';
    const prodSelect = document.getElementById('radar-product-select');
    if (prodSelect) {
        const prodMapInv = { 'sr_bref': 'N0Q', 'sr_bvel': 'N0V', 'bdhc': 'NET', 'bdsa': 'DSA', 'boha': 'OHA' };
        const selProd = prodMapInv[prod] || 'N0Q';
        if (prodSelect.value !== selProd) prodSelect.value = selProd;
    }

    // Keep the per-pane legend stack in sync with whatever is toggled (no-op while looping)
    if (typeof updateL3TiltControl === 'function') updateL3TiltControl();
    refreshTimestampLabel();
}

// ─── NEXRAD WSR-88D Operational Status (api.weather.gov /radar/stations) ───
// Shows VCP/scan mode, RDA operability, alarms, and Level-II latency for the
// site radar in the active pane. JSON + CORS, no proxy.
const radarStationCache = {};            // { ICAO: { data, _ts } }
const RADAR_STATUS_TTL = 90 * 1000;
const SITE_RADAR_VIS_LAYERS = ['site-bref-layer', 'site-bvel-layer', 'site-bdhc-layer', 'site-bdsa-layer', 'site-boha-layer'];

// Derive precip vs clear-air scan mode from the VCP number.
function vcpMode(vcp) {
    const n = parseInt(String(vcp || '').replace(/\D/g, ''), 10);
    if ([31, 32, 35].includes(n)) return 'Clear Air';
    if ([12, 112, 212, 215, 21, 121, 221].includes(n)) return 'Precipitation';
    return '';
}

async function fetchRadarStatus(icao, force = false) {
    const key = (icao || '').toUpperCase();
    if (!key) return null;
    const cached = radarStationCache[key];
    if (!force && cached && Date.now() - cached._ts < RADAR_STATUS_TTL) return cached.data;
    try {
        const res = await fetch(`https://api.weather.gov/radar/stations/${key}`, { headers: { 'Accept': 'application/geo+json' } });
        if (!res.ok) return null;
        const json = await res.json();
        radarStationCache[key] = { data: json, _ts: Date.now() };
        return json;
    } catch (e) { return null; }
}

// Legend rows (label + left-border color) describing a site's WSR-88D status,
// rendered inline in the pane's bottom-left legend stack. Reads the cache; if a
// site isn't cached yet it kicks off a fetch and re-renders when it lands.
function radarStatusRows(site) {
    const icao = siteWorkspace(site).toUpperCase();
    const cached = radarStationCache[icao];
    if (!cached || !cached.data || !cached.data.properties) {
        fetchRadarStatus(icao).then(() => { if (!isPlaying) refreshTimestampLabel(); });
        return [{ label: `${icao} · checking status…`, color: '#6b7a88' }];
    }
    const p = cached.data.properties;
    const rda = (p.rda && p.rda.properties) || {};
    const lat = (p.latency && p.latency.properties) || p.latency || {};
    const num = v => (v && typeof v === 'object') ? v.value : v;
    const vcp = String(rda.volumeCoveragePattern || '').replace(/\D/g, '');
    const mode = vcpMode(rda.volumeCoveragePattern);
    const oper = rda.operabilityStatus || '';
    const status = rda.status || '';
    const alarm = rda.alarmSummary || '';
    const online = /on-?line/i.test(oper) && (!status || /operate/i.test(status));

    const rows = [];
    const vcpStr = vcp ? `VCP ${vcp}${mode ? ' ' + mode.toUpperCase() : ''}` : '';
    rows.push({ label: `${icao} ${online ? 'ON-LINE' : (oper || 'STATUS?')}${vcpStr ? ' · ' + vcpStr : ''}`, color: online ? '#33c27a' : '#ff5252' });
    if (alarm && !/no alarms/i.test(alarm)) rows.push({ label: `⚠ ${alarm}`, color: '#ffb300' });
    const cur = num(lat.current);
    const l2t = lat.levelTwoLastReceivedTime;
    const l2 = (l2t && l2t.length >= 16) ? l2t.substring(11, 16) + 'Z' : '';
    if ((cur != null && !isNaN(+cur)) || l2) {
        const latStr = (cur != null && !isNaN(+cur)) ? `L2 ${(+cur).toFixed(1)}s` : 'L2';
        rows.push({ label: `${latStr}${l2 ? ' · ' + l2 : ''}`, color: '#6b7a88' });
    }
    return rows;
}

// Periodically refresh the operational status of every site shown in any pane,
// then re-render the legends.
function refreshAllRadarStatus() {
    const sites = new Set();
    Object.entries(maps).forEach(([pid, m]) => {
        const s = paneRadarSites[pid];
        if (s && !s.includes('nexrad') && SITE_RADAR_VIS_LAYERS.some(l => isLayerVisible(m, l))) sites.add(s);
    });
    if (!sites.size) return;
    Promise.all([...sites].map(s => fetchRadarStatus(siteWorkspace(s).toUpperCase(), true)))
        .then(() => { if (!isPlaying) refreshTimestampLabel(); });
}

function persistWatchdogFilter() {
    try {
        localStorage.setItem('fxnet_watchdog_state', document.getElementById('watchdog-filter-state')?.value || 'all');
        localStorage.setItem('fxnet_watchdog_wfo', document.getElementById('watchdog-filter-wfo')?.value || 'all');
    } catch (_) {}
}

function initProductSidebar() {
    const stateFilter = document.getElementById('watchdog-filter-state');
    const wfoFilter = document.getElementById('watchdog-filter-wfo');
    if (stateFilter) {
        ALL_STATES.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s; opt.textContent = s;
            stateFilter.appendChild(opt);
        });
        stateFilter.addEventListener('change', () => {
            if (wfoFilter) wfoFilter.value = 'all';
            persistWatchdogFilter();
            applyWatchdogFilter();
        });
    }
    if (wfoFilter) {
        rebuildWfoFilter(); // seed from static roster; live offices merged in as alerts arrive
        wfoFilter.addEventListener('change', () => {
            if (stateFilter) stateFilter.value = 'all';
            persistWatchdogFilter();
            applyWatchdogFilter();
        });
    }
    // Restore the last-used state/WFO filter (drives both the WATCHDOG list
    // and which warnings raise AlertViz toasts)
    try {
        const st = localStorage.getItem('fxnet_watchdog_state');
        const wfo = localStorage.getItem('fxnet_watchdog_wfo');
        if (stateFilter && st && Array.from(stateFilter.options).some(o => o.value === st)) stateFilter.value = st;
        if (wfoFilter && wfo && Array.from(wfoFilter.options).some(o => o.value === wfo)) wfoFilter.value = wfo;
    } catch (_) {}

    document.querySelectorAll('.product-item').forEach(item => {
        item.addEventListener('click', async () => {
            const layer = item.getAttribute('data-layer');
            if (!layer || !maps[activePaneId]) return;
            const map = maps[activePaneId];

            // ─── SPC Outlooks ───
            if (layer === 'spc-outlook') {
                const day = item.getAttribute('data-day');
                const wasActive = item.classList.contains('active');
                if (!wasActive) {
                    await fetchSPCOutlook(day, true);
                    map.setLayoutProperty(`spc-day${day}-fill`, 'visibility', 'visible');
                    map.setLayoutProperty(`spc-day${day}-line`, 'visibility', 'visible');
                } else {
                    map.setLayoutProperty(`spc-day${day}-fill`, 'visibility', 'none');
                    map.setLayoutProperty(`spc-day${day}-line`, 'visibility', 'none');
                }
                updateSidebarToActivePane();
                return;
            }

            // ─── SPC Probabilistic Hazards (Day 1/2 Tornado/Wind/Hail) ───
            if (layer === 'spc-prob') {
                const day = item.getAttribute('data-day');
                const hazard = item.getAttribute('data-hazard');
                const sid = `spc-prob-${day}-${hazard}`;
                const isActive = !item.classList.contains('active');
                if (isActive) await fetchSPCProb(day, hazard, true);
                const vis = isActive ? 'visible' : 'none';
                map.setLayoutProperty(`${sid}-fill`, 'visibility', vis);
                map.setLayoutProperty(`${sid}-line`, 'visibility', vis);
                ['i1', 'i2', 'i3', 'line'].forEach(suf => {
                    const lid = `spc-sig-${day}-${hazard}-${suf}`;
                    if (map.getLayer(lid)) map.setLayoutProperty(lid, 'visibility', vis);
                });
                updateProbLegend(activePaneId);
                updateSidebarToActivePane();
                return;
            }

            // ─── SPC Fire Weather Outlooks (Day 1/2) ───
            if (layer === 'spc-firewx') {
                const day = item.getAttribute('data-day');
                const sid = `spc-firewx-day${day}`;
                const isActive = !item.classList.contains('active');
                if (isActive) await fetchSPCFireWx(day, true);
                const vis = isActive ? 'visible' : 'none';
                ['fill', 'line', 'dryt'].forEach(suf => {
                    const lid = `${sid}-${suf}`;
                    if (map.getLayer(lid)) map.setLayoutProperty(lid, 'visibility', vis);
                });
                updateFireWxLegend(activePaneId);
                updateSidebarToActivePane();
                return;
            }

            // ─── WPC Excessive Rainfall Outlook (Day 1-3) ───
            if (layer === 'wpc-ero') {
                const day = item.getAttribute('data-day');
                const wasActive = item.classList.contains('active');
                if (!wasActive) {
                    await fetchERO(day, true);
                    map.setLayoutProperty(`wpc-ero-day${day}-fill`, 'visibility', 'visible');
                    map.setLayoutProperty(`wpc-ero-day${day}-line`, 'visibility', 'visible');
                } else {
                    map.setLayoutProperty(`wpc-ero-day${day}-fill`, 'visibility', 'none');
                    map.setLayoutProperty(`wpc-ero-day${day}-line`, 'visibility', 'none');
                }
                updateEroLegend(activePaneId);
                updateSidebarToActivePane();
                return;
            }

            // ─── Mesoscale Discussions ───
            if (layer === 'spc-md') {
                const isActive = !item.classList.contains('active');
                if (isActive) await fetchMesoscaleDiscussions(true);
                map.setLayoutProperty('spc-md-fill', 'visibility', isActive ? 'visible' : 'none');
                map.setLayoutProperty('spc-md-outline', 'visibility', isActive ? 'visible' : 'none');
                updateSidebarToActivePane();
                return;
            }

            // ─── WPC Mesoscale Precipitation Discussions ───
            if (layer === 'wpc-mpd') {
                const isActive = !item.classList.contains('active');
                if (isActive) await fetchMPDs(true);
                map.setLayoutProperty('wpc-mpd-fill', 'visibility', isActive ? 'visible' : 'none');
                map.setLayoutProperty('wpc-mpd-outline', 'visibility', isActive ? 'visible' : 'none');
                updateSidebarToActivePane();
                return;
            }

            // ─── SPC Local Storm Reports ───
            if (layer === 'spc-lsr') {
                const isActive = !item.classList.contains('active');
                if (isActive) await fetchLSRs(true);
                map.setLayoutProperty('spc-lsr-icons', 'visibility', isActive ? 'visible' : 'none');
                map.setLayoutProperty('spc-lsr-mag', 'visibility', isActive ? 'visible' : 'none');
                updateSidebarToActivePane();
                return;
            }

            // ─── National storm attributes (IEM SCIT table, all NEXRADs) ───
            if (layer === 'nexrad-attr') {
                const isActive = !item.classList.contains('active');
                if (isActive) await fetchNexradAttr(true);
                const vis = isActive ? 'visible' : 'none';
                // getLayer guard: clicking a product before the style finishes
                // loading otherwise throws out of the handler
                ['natt-vector', 'natt-cell', 'natt-tvs', 'natt-label']
                    .forEach(l => { if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', vis); });
                updateSidebarToActivePane();
                return;
            }

            // ─── ProbSevere (CIMSS storm objects) ───
            if (layer === 'probsevere') {
                const isActive = !item.classList.contains('active');
                if (isActive) await fetchProbSevere(true);
                const vis = isActive ? 'visible' : 'none';
                ['probsevere-fill', 'probsevere-outline', 'probsevere-label'].forEach(l => map.setLayoutProperty(l, 'visibility', vis));
                updateSidebarToActivePane();
                return;
            }

            // ─── Aviation: SIGMETs / AIRMETs ───
            if (layer === 'airsigmet') {
                const isActive = !item.classList.contains('active');
                if (isActive) await fetchAirSigmet(true);
                const vis = isActive ? 'visible' : 'none';
                ['airsigmet-fill', 'airsigmet-outline', 'airsigmet-label'].forEach(l => map.setLayoutProperty(l, 'visibility', vis));
                updateSidebarToActivePane();
                return;
            }

            // ─── Aviation: PIREPs ───
            if (layer === 'pireps') {
                const isActive = !item.classList.contains('active');
                if (isActive) await fetchPireps(true);
                map.setLayoutProperty('pireps-layer', 'visibility', isActive ? 'visible' : 'none');
                updateSidebarToActivePane();
                return;
            }

            // ─── Aviation: Graphical AIRMETs (G-AIRMET) ───
            if (layer === 'gairmet') {
                const isActive = !item.classList.contains('active');
                if (isActive) await fetchGairmet(true);
                const vis = isActive ? 'visible' : 'none';
                ['gairmet-fill', 'gairmet-outline', 'gairmet-label'].forEach(l => map.setLayoutProperty(l, 'visibility', vis));
                updateSidebarToActivePane();
                return;
            }

            // ─── Aviation: Terminal Forecasts (TAF) ───
            if (layer === 'taf') {
                const isActive = !item.classList.contains('active');
                if (isActive) await fetchTaf(true);
                const vis = isActive ? 'visible' : 'none';
                ['taf-layer', 'taf-label'].forEach(l => map.setLayoutProperty(l, 'visibility', vis));
                updateSidebarToActivePane();
                return;
            }

            // ─── Aviation: Center Weather Advisories (CWA) ───
            if (layer === 'cwa') {
                const isActive = !item.classList.contains('active');
                if (isActive) await fetchCwa(true);
                const vis = isActive ? 'visible' : 'none';
                ['cwa-fill', 'cwa-outline', 'cwa-label'].forEach(l => map.setLayoutProperty(l, 'visibility', vis));
                updateSidebarToActivePane();
                return;
            }

            // ─── Marine: NDBC buoy observations ───
            if (layer === 'ndbc') {
                const isActive = !item.classList.contains('active');
                if (isActive) await fetchNdbc(true);
                const vis = isActive ? 'visible' : 'none';
                ['ndbc-layer', 'ndbc-label'].forEach(l => map.setLayoutProperty(l, 'visibility', vis));
                updateSidebarToActivePane();
                return;
            }

            // ─── SPC Day 4-8 Severe Outlook ───
            if (layer === 'spc-d48') {
                const isActive = !item.classList.contains('active');
                if (isActive) await fetchSPCD48(true);
                const vis = isActive ? 'visible' : 'none';
                ['spc-d48-fill', 'spc-d48-line', 'spc-d48-label'].forEach(l => map.setLayoutProperty(l, 'visibility', vis));
                updateSidebarToActivePane();
                return;
            }

            // ─── NDFD gridded forecast — surface temperature ───
            if (layer === 'ndfd-temp') {
                const isActive = !item.classList.contains('active');
                map.setLayoutProperty('ndfd-temp-layer', 'visibility', isActive ? 'visible' : 'none');
                if (isActive) updateHealth('ndfdTemp');
                updateSidebarToActivePane();
                return;
            }

            // ─── GOES Satellite (per-pane channel) ───
            if (layer === 'goes-ch') {
                const ch = parseInt(item.getAttribute('data-channel'));
                const isAlreadyThisChannel = item.classList.contains('active');

                if (isAlreadyThisChannel) {
                    map.setLayoutProperty('satellite-layer', 'visibility', 'none');
                } else {
                    paneGoesChannels[activePaneId] = ch; // Per-pane tracking
                    activeGoesChannel = ch; // Sync convenience global
                    // Only update THIS pane's satellite source, in its own sector
                    const secKey = goesSectorFor(activePaneId);
                    if (map.getSource('satellite')) map.getSource('satellite').setTiles([goesChannelUrl(ch, secKey)]);
                    map.setLayoutProperty('satellite-layer', 'visibility', 'visible');
                    updateHealth('sat');
                    // Pull this sector's exact image valid time for the legend.
                    fetchIemGoesValid(ch, secKey).then(() => {
                        if (paneGoesChannels[activePaneId] === ch) refreshTimestampLabel();
                    });
                    if (goesSectorDef(secKey).bird === 'east') fetchGoesSatTimes();
                }
                updateSidebarToActivePane();
                refreshTimestampLabel();
                return;
            }

            // ─── GIBS Satellite (per-pane product: GeoColor / IR / RGB composites) ───
            if (layer === 'gibs-sat') {
                const prodKey = item.getAttribute('data-gibs');
                const wasActive = item.classList.contains('active');
                if (wasActive) {
                    clearGibs(activePaneId);
                } else {
                    await loadGibsLive(activePaneId, prodKey);
                }
                updateSidebarToActivePane();
                return;
            }

            // ─── Radar ───
            if (layer === 'radar-l3') {
                const product = item.getAttribute('data-l3');
                const wasActive = item.classList.contains('active');
                if (wasActive) {
                    clearL3Radar(activePaneId);
                } else {
                    let station = (paneRadarSites[activePaneId] || '').toUpperCase();
                    if (!station || station.includes('NEXRAD')) {
                        station = 'DGX';
                        paneRadarSites[activePaneId] = 'DGX';
                        const sel = document.getElementById('radar-site-select');
                        if (sel) sel.value = 'DGX';
                        addLiveLog('L3 NODD: no SITE selected — defaulting to DGX (Jackson MS)', '#ffb300');
                    }
                    await loadL3Radar(activePaneId, station, product);
                }
                updateSidebarToActivePane();
                return;
            }

            // ─── Storm Tracks (STI / NST) ───
            if (layer === 'storm-attr') {
                const isActive = !item.classList.contains('active');
                if (isActive) {
                    let station = (paneRadarSites[activePaneId] || '').toUpperCase();
                    if (!station || station.includes('NEXRAD')) {
                        station = 'DGX';
                        paneRadarSites[activePaneId] = 'DGX';
                        const sel = document.getElementById('radar-site-select');
                        if (sel) sel.value = 'DGX';
                        addLiveLog('STI: no SITE selected — defaulting to DGX (Jackson MS)', '#ffb300');
                    }
                    await fetchStormAttr(activePaneId, station);
                } else {
                    delete paneStormAttr[activePaneId];
                }
                const vis = isActive ? 'visible' : 'none';
                ['storm-attr-track', 'storm-attr-fpos', 'storm-attr-cell', 'storm-attr-label']
                    .forEach(l => map.setLayoutProperty(l, 'visibility', vis));
                updateSidebarToActivePane();
                return;
            }

            // ─── Mesocyclone / TVS markers (MDA / NMD) ───
            if (layer === 'nodd-meso') {
                const isActive = !item.classList.contains('active');
                if (isActive) {
                    let station = (paneRadarSites[activePaneId] || '').toUpperCase();
                    if (!station || station.includes('NEXRAD')) {
                        station = 'DGX';
                        paneRadarSites[activePaneId] = 'DGX';
                        const sel = document.getElementById('radar-site-select');
                        if (sel) sel.value = 'DGX';
                        addLiveLog('MESO: no SITE selected — defaulting to DGX (Jackson MS)', '#ffb300');
                    }
                    await fetchMesoMarkers(activePaneId, station);
                } else {
                    delete paneMeso[activePaneId];
                }
                const vis = isActive ? 'visible' : 'none';
                ['meso-circ', 'meso-tvs', 'meso-label']
                    .forEach(l => map.setLayoutProperty(l, 'visibility', vis));
                updateSidebarToActivePane();
                return;
            }

            if (layer === 'radar-ref') {
                const isActive = !item.classList.contains('active');
                const siteVal = paneRadarSites[activePaneId] || 'DGX';
                const isNational = siteVal.includes('nexrad');

                if (isNational) {
                    activeRadarNational = isActive;
                    map.setLayoutProperty('radar-layer', 'visibility', isActive ? 'visible' : 'none');
                    ['site-bref-layer', 'site-bvel-layer', 'site-bdhc-layer', 'site-bdsa-layer', 'site-boha-layer'].forEach(l => {
                        if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', 'none');
                    });
                } else {
                    activeRadarNational = false;
                    paneRadarProducts[activePaneId] = 'sr_bref';
                    map.setLayoutProperty('radar-layer', 'visibility', 'none');
                    if (isActive && map.getSource('site-bref')) map.getSource('site-bref').setTiles([siteRadarUrl(siteVal, 'sr_bref')]);
                    ['site-bref-layer', 'site-bvel-layer', 'site-bdhc-layer', 'site-bdsa-layer', 'site-boha-layer'].forEach(l => {
                        if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', 'none');
                    });
                    map.setLayoutProperty('site-bref-layer', 'visibility', isActive ? 'visible' : 'none');
                }
                updateSidebarToActivePane();
                updateHealth('radar');
                refreshTimestampLabel();
                updateRadarLegend();
                return;
            }

            if (layer === 'radar-vel') {
                const isActive = !item.classList.contains('active');
                const siteVal = paneRadarSites[activePaneId] || 'DGX';
                if (!siteVal.includes('nexrad')) {
                    paneRadarProducts[activePaneId] = 'sr_bvel';
                    if (map.getSource('site-bvel')) map.getSource('site-bvel').setTiles([siteRadarUrl(siteVal, 'sr_bvel')]);
                    ['site-bref-layer', 'site-bvel-layer', 'site-bdhc-layer', 'site-bdsa-layer', 'site-boha-layer'].forEach(l => {
                        if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', 'none');
                    });
                    map.setLayoutProperty('site-bvel-layer', 'visibility', isActive ? 'visible' : 'none');
                }
                updateSidebarToActivePane();
                updateHealth('radar');
                refreshTimestampLabel();
                updateRadarLegend();
                return;
            }

            if (layer === 'radar-hc') {
                const isActive = !item.classList.contains('active');
                const siteVal = paneRadarSites[activePaneId] || 'DGX';
                if (!siteVal.includes('nexrad')) {
                    paneRadarProducts[activePaneId] = 'bdhc';
                    if (map.getSource('site-bdhc')) map.getSource('site-bdhc').setTiles([siteRadarUrl(siteVal, 'bdhc')]);
                    ['site-bref-layer', 'site-bvel-layer', 'site-bdhc-layer', 'site-bdsa-layer', 'site-boha-layer'].forEach(l => {
                        if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', 'none');
                    });
                    map.setLayoutProperty('site-bdhc-layer', 'visibility', isActive ? 'visible' : 'none');
                }
                updateSidebarToActivePane();
                updateHealth('radar');
                refreshTimestampLabel();
                updateRadarLegend();
                return;
            }

            if (layer === 'radar-stp') {
                const isActive = !item.classList.contains('active');
                const siteVal = paneRadarSites[activePaneId] || 'DGX';
                if (!siteVal.includes('nexrad')) {
                    paneRadarProducts[activePaneId] = 'bdsa';
                    if (map.getSource('site-bdsa')) map.getSource('site-bdsa').setTiles([siteRadarUrl(siteVal, 'bdsa')]);
                    ['site-bref-layer', 'site-bvel-layer', 'site-bdhc-layer', 'site-bdsa-layer', 'site-boha-layer'].forEach(l => {
                        if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', 'none');
                    });
                    map.setLayoutProperty('site-bdsa-layer', 'visibility', isActive ? 'visible' : 'none');
                }
                updateSidebarToActivePane();
                updateHealth('radar');
                refreshTimestampLabel();
                updateRadarLegend();
                return;
            }

            if (layer === 'radar-oha') {
                const isActive = !item.classList.contains('active');
                const siteVal = paneRadarSites[activePaneId] || 'DGX';
                if (!siteVal.includes('nexrad')) {
                    paneRadarProducts[activePaneId] = 'boha';
                    if (map.getSource('site-boha')) map.getSource('site-boha').setTiles([siteRadarUrl(siteVal, 'boha')]);
                    ['site-bref-layer', 'site-bvel-layer', 'site-bdhc-layer', 'site-bdsa-layer', 'site-boha-layer'].forEach(l => {
                        if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', 'none');
                    });
                    map.setLayoutProperty('site-boha-layer', 'visibility', isActive ? 'visible' : 'none');
                }
                updateSidebarToActivePane();
                updateHealth('radar');
                refreshTimestampLabel();
                updateRadarLegend();
                return;
            }

            // ─── METARs ───
            if (layer === 'metars') {
                const isActive = !item.classList.contains('active');
                const vis = isActive ? 'visible' : 'none';
                const metarLayers = ['metars-temp', 'metars-dewp', 'metars-press', 'metars-id', 'metars-city', 'metars-barb'];
                metarLayers.forEach(l => {
                    if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', vis);
                });
                if (isActive) fetchMETARs();
                updateSidebarToActivePane();
                return;
            }

            // ─── Lightning (NLDN strike density) ───
            if (layer === 'lightning') {
                const isActive = !item.classList.contains('active');
                if (isActive && map.getSource('lightning')) map.getSource('lightning').setTiles([cacheBust(lightningUrl())]);
                map.setLayoutProperty('lightning-layer', 'visibility', isActive ? 'visible' : 'none');
                if (isActive) updateHealth('lightning');
                updateSidebarToActivePane();
                return;
            }

            // ─── HMS Smoke ───
            if (layer === 'hms-smoke') {
                const isActive = !item.classList.contains('active');
                if (isActive) await fetchHMSSmoke(true);
                map.setLayoutProperty('hms-smoke-fill', 'visibility', isActive ? 'visible' : 'none');
                map.setLayoutProperty('hms-smoke-outline', 'visibility', isActive ? 'visible' : 'none');
                updateSidebarToActivePane();
                return;
            }

            // ─── AQI ───
            if (layer === 'airnow-aqi') {
                const isActive = !item.classList.contains('active');
                if (isActive) await fetchAQI(true);
                map.setLayoutProperty('airnow-aqi-layer', 'visibility', isActive ? 'visible' : 'none');
                updateSidebarToActivePane();
                return;
            }

            // ─── FIRMS ───
            if (layer === 'firms-fires') {
                const isActive = !item.classList.contains('active');
                if (isActive) fetchFIRMS(true);
                map.setLayoutProperty('firms-fires-layer', 'visibility', isActive ? 'visible' : 'none');
                updateSidebarToActivePane();
                return;
            }

            // ─── River Gauges ───
            if (layer === 'river-gauges') {
                const isActive = !item.classList.contains('active');
                ['river-gauges-layer', 'river-gauges-glow', 'river-gauges-label'].forEach(l => {
                    if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', isActive ? 'visible' : 'none');
                });
                if (isActive) await fetchRiverGauges(true);
                // Hide detail panel on deactivate
                if (!isActive) {
                    const panel = document.getElementById('river-gauge-panel');
                    if (panel) panel.style.display = 'none';
                }
                updateSidebarToActivePane();
                return;
            }

            // ─── Solar Terminator ───
            if (layer === 'solar-terminator') {
                const isActive = !item.classList.contains('active');
                ['solar-night-fill', 'solar-twilight-fill', 'solar-terminator-line'].forEach(l => {
                    if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', isActive ? 'visible' : 'none');
                });
                if (isActive) updateTerminator();
                updateSolarCursor(activePaneId);
                if (isActive) showSolarHint(activePaneId); else hideSolarHint(activePaneId);
                updateSidebarToActivePane();
                return;
            }

            // ─── WPC Isobars ───
            if (layer === 'wpc-isobars') {
                const isActive = !item.classList.contains('active');
                if (isActive) await fetchWPCIsobars(true);
                map.setLayoutProperty('wpc-isobars-line', 'visibility', isActive ? 'visible' : 'none');
                map.setLayoutProperty('wpc-isobars-label', 'visibility', isActive ? 'visible' : 'none');
                updateSidebarToActivePane();
                return;
            }

            // ─── METAR-Contoured Products (Isobars 2mb, Isotherms, Isodrosotherms) ───
            if (SFC_CONTOUR_FIELDS[layer]) {
                const isActive = !item.classList.contains('active');
                if (isActive) {
                    // Ensure METARs are loaded first
                    if (!metarsLoaded) {
                        addLiveLog('CONTOUR: Fetching METARs first...', '#ffaa00');
                        await fetchMETARs();
                    }
                    const config = SFC_CONTOUR_FIELDS[layer];
                    renderContourProduct(layer, config.field, config.interval, config.label);
                }
                map.setLayoutProperty(`${layer}-line`, 'visibility', isActive ? 'visible' : 'none');
                map.setLayoutProperty(`${layer}-label`, 'visibility', isActive ? 'visible' : 'none');
                updateSidebarToActivePane();
                return;
            }

            // ─── WPC Fronts & H/L ───
            if (layer === 'wpc-fronts') {
                const isActive = !item.classList.contains('active');
                if (isActive) await fetchWPCFronts(true);
                ['wpc-fronts-solid', 'wpc-fronts-stnry', 'wpc-fronts-trof', 'wpc-fronts-pips', 'wpc-hl-letter', 'wpc-hl-pressure'].forEach(l => {
                    if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', isActive ? 'visible' : 'none');
                });
                updateSidebarToActivePane();
                return;
            }

            // ─── WPC QPF ───
            if (layer === 'wpc-qpf') {
                const qpfId = item.getAttribute('data-qpf');
                const isAlreadyActive = item.classList.contains('active');

                if (isAlreadyActive) {
                    map.setLayoutProperty('wpc-qpf-layer', 'visibility', 'none');
                    delete paneQpf[activePaneId];
                } else {
                    // Per-pane: retile ONLY this pane's source so other panes
                    // keep their own QPF product (no cross-pane mirroring)
                    paneQpf[activePaneId] = qpfId;
                    if (map.getSource('wpc-qpf')) map.getSource('wpc-qpf').setTiles([qpfWmsUrl(qpfId)]);
                    map.setLayoutProperty('wpc-qpf-layer', 'visibility', 'visible');
                    updateHealth('wpcQpf');
                }
                updateSidebarToActivePane();
                return;
            }

            // ─── MRMS Enhanced Echo Tops ───
            if (layer === 'mrms-echotops') {
                const isActive = !item.classList.contains('active');
                map.setLayoutProperty('mrms-echotops-layer', 'visibility', isActive ? 'visible' : 'none');
                if (isActive) updateHealth('mrmsEchotops');
                updateRadarLegend();
                updateSidebarToActivePane();
                return;
            }

            // ─── MRMS QPE (tile-swap for 1h/24h/48h/72h) ───
            if (layer === 'mrms-qpe') {
                const qpePeriod = item.getAttribute('data-qpe');
                const isAlreadyActive = item.classList.contains('active');

                if (isAlreadyActive) {
                    map.setLayoutProperty('mrms-qpe-layer', 'visibility', 'none');
                    delete paneMrmsQpe[activePaneId];
                } else {
                    // Per-pane: retile ONLY this pane's source (see paneQpf note)
                    paneMrmsQpe[activePaneId] = qpePeriod;
                    if (map.getSource('mrms-qpe')) map.getSource('mrms-qpe').setTiles([mrmsQpeWmsUrl(qpePeriod)]);
                    map.setLayoutProperty('mrms-qpe-layer', 'visibility', 'visible');
                    updateHealth('mrmsQpe');
                }
                updateRadarLegend();
                updateSidebarToActivePane();
                return;
            }

            // ─── Hurricane Hunter recon obs ───
            if (layer === 'recon-hdob') {
                const isActive = !item.classList.contains('active');
                ['recon-hdob-line', 'recon-hdob-pts', 'recon-hdob-labels'].forEach(l => {
                    if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', isActive ? 'visible' : 'none');
                });
                if (isActive) await fetchReconHdob(true);
                updateSidebarToActivePane();
                return;
            }

            // ─── Model track guidance spaghetti (a-deck) ───
            if (layer === 'adeck') {
                const mode = item.getAttribute('data-adeck');
                const isAlreadyActive = item.classList.contains('active');
                if (isAlreadyActive) {
                    ['adeck-lines', 'adeck-pts', 'adeck-labels'].forEach(l => {
                        if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', 'none');
                    });
                    adeckMode = null;
                } else {
                    adeckMode = mode;
                    ['adeck-lines', 'adeck-pts', 'adeck-labels'].forEach(l => {
                        if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', 'visible');
                    });
                    // Always re-check the system list on toggle — a new a-deck
                    // appears the moment an invest is upgraded (selection is kept)
                    await fetchAdeckList();
                    await fetchAdeck(true);
                }
                updateSidebarToActivePane();
                return;
            }

            // ─── NHC Active Storms ───
            if (layer === 'nhc-storms') {
                const isActive = !item.classList.contains('active');
                ['nhc-cone-fill', 'nhc-cone-outline', 'nhc-track-line', 'nhc-track-pts', 'nhc-track-labels', 'nhc-warn-fill', 'nhc-warn-outline'].forEach(l => {
                    if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', isActive ? 'visible' : 'none');
                });
                if (isActive) await fetchNHCStorms(true);
                updateSidebarToActivePane();
                return;
            }

            // ─── Forecast History (run-to-run) for the active storm ───
            if (layer === 'nhc-fcst-history') {
                const isActive = !item.classList.contains('active');
                ['nhc-fcst-actual-line', 'nhc-fcst-lines', 'nhc-fcst-actual-pts', 'nhc-fcst-labels'].forEach(l => {
                    if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', isActive ? 'visible' : 'none');
                });
                if (isActive) await fetchFcstHistory(true);
                updateSidebarToActivePane();
                return;
            }

            // ─── NHC Tropical Outlook ───
            if (layer === 'nhc-outlook') {
                const isActive = !item.classList.contains('active');
                ['nhc-outlook-fill', 'nhc-outlook-outline'].forEach(l => {
                    if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', isActive ? 'visible' : 'none');
                });
                if (isActive) await fetchNHCOutlook(true);
                updateSidebarToActivePane();
                return;
            }

            // ─── NHC Tropical Discussions (opens text panel) ───
            if (layer === 'nhc-two-atl') {
                fetchNHCDiscussion('atl');
                return;
            }
            if (layer === 'nhc-two-epac') {
                fetchNHCDiscussion('epac');
                return;
            }

            // ─── CPC Temperature Outlooks ───
            if (layer === 'cpc-temp') {
                const period = item.getAttribute('data-period');
                const isAlreadyActive = item.classList.contains('active');

                if (isAlreadyActive) {
                    map.setLayoutProperty('cpc-temp-layer', 'visibility', 'none');
                    delete paneCpcTemp[activePaneId];
                } else {
                    // Per-pane: retile ONLY this pane's source (see paneQpf note)
                    paneCpcTemp[activePaneId] = period;
                    const svcMap = { '6-10': 'cpc_6_10_day_outlk', '8-14': 'cpc_8_14_day_outlk', 'monthly': 'cpc_mthly_temp_outlk', 'seasonal': 'cpc_sea_temp_outlk' };
                    const svc = svcMap[period] || svcMap['6-10'];
                    const layerId = (period === '6-10' || period === '8-14') ? '1' : '0';
                    const wmsUrl = `https://mapservices.weather.noaa.gov/vector/services/outlooks/${svc}/MapServer/WMSServer?service=WMS&version=1.1.1&request=GetMap&layers=${layerId}&format=image/png&transparent=true&styles=&srs=EPSG:3857&width=256&height=256&bbox={bbox-epsg-3857}`;
                    if (map.getSource('cpc-temp')) map.getSource('cpc-temp').setTiles([wmsUrl]);
                    map.setLayoutProperty('cpc-temp-layer', 'visibility', 'visible');
                    updateHealth('cpcTemp');
                }
                updateSidebarToActivePane();
                return;
            }

            // ─── CPC Precipitation Outlooks ───
            if (layer === 'cpc-precip') {
                const period = item.getAttribute('data-period');
                const isAlreadyActive = item.classList.contains('active');

                if (isAlreadyActive) {
                    map.setLayoutProperty('cpc-precip-layer', 'visibility', 'none');
                    delete paneCpcPrecip[activePaneId];
                } else {
                    // Per-pane: retile ONLY this pane's source (see paneQpf note)
                    paneCpcPrecip[activePaneId] = period;
                    const svcMap = { '6-10': 'cpc_6_10_day_outlk', '8-14': 'cpc_8_14_day_outlk', 'monthly': 'cpc_mthly_precip_outlk', 'seasonal': 'cpc_sea_precip_outlk' };
                    const svc = svcMap[period] || svcMap['6-10'];
                    const layerId = (period === '6-10' || period === '8-14') ? '0' : '0';
                    const wmsUrl = `https://mapservices.weather.noaa.gov/vector/services/outlooks/${svc}/MapServer/WMSServer?service=WMS&version=1.1.1&request=GetMap&layers=${layerId}&format=image/png&transparent=true&styles=&srs=EPSG:3857&width=256&height=256&bbox={bbox-epsg-3857}`;
                    if (map.getSource('cpc-precip')) map.getSource('cpc-precip').setTiles([wmsUrl]);
                    map.setLayoutProperty('cpc-precip-layer', 'visibility', 'visible');
                    updateHealth('cpcPrecip');
                }
                updateSidebarToActivePane();
                return;
            }

            // ─── US Drought Monitor ───
            if (layer === 'drought-monitor') {
                const isActive = !item.classList.contains('active');
                ['drought-fill', 'drought-outline'].forEach(l => {
                    if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', isActive ? 'visible' : 'none');
                });
                if (isActive) await fetchDroughtMonitor(true);
                updateSidebarToActivePane();
                return;
            }

            // ─── CPC Drought Outlook ───
            if (layer === 'cpc-drought-outlook') {
                const isActive = !item.classList.contains('active');
                if (map.getLayer('cpc-drought-layer')) map.setLayoutProperty('cpc-drought-layer', 'visibility', isActive ? 'visible' : 'none');
                updateSidebarToActivePane();
                return;
            }

            // ─── NWS Warnings Only ───
            if (layer === 'nws-warnings-only') {
                const isActive = !item.classList.contains('active');
                map.setLayoutProperty('nws-warnings-only-fill', 'visibility', isActive ? 'visible' : 'none');
                map.setLayoutProperty('nws-warnings-only-outline', 'visibility', isActive ? 'visible' : 'none');
                // Enhanced IBW layers ride along with warnings
                ['nws-enhanced-fill', 'nws-enhanced-outline', 'nws-enhanced-glow', 'nws-enhanced-label'].forEach(l => {
                    if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', isActive ? 'visible' : 'none');
                });
                // Casing rides along too, but only shows in outline mode.
                applyWarningDisplayMode(map);
                updateSidebarToActivePane();
                return;
            }

            // ─── NWS Advisories & Statements Only ───
            if (layer === 'nws-advisories-only') {
                const isActive = !item.classList.contains('active');
                map.setLayoutProperty('nws-advis-fill', 'visibility', isActive ? 'visible' : 'none');
                map.setLayoutProperty('nws-advis-outline', 'visibility', isActive ? 'visible' : 'none');
                // Casing rides along, but only shows in outline mode.
                applyWarningDisplayMode(map);
                updateSidebarToActivePane();
                return;
            }

            // ─── NWS Watches Only ───
            if (layer === 'nws-watches-only') {
                const isActive = !item.classList.contains('active');
                addLiveLog(`WATCHES CLICK: Switching layer to ${isActive ? 'VISIBLE' : 'HIDDEN'} on Pane ${activePaneId}`, '#00ffff');
                try {
                    map.setLayoutProperty('nws-watches-only-fill', 'visibility', isActive ? 'visible' : 'none');
                    map.setLayoutProperty('nws-watches-only-outline', 'visibility', isActive ? 'visible' : 'none');
                } catch (err) {
                    addLiveLog(`WATCHES ERROR: ${err.message}`, '#ff3333');
                }
                updateSidebarToActivePane();
                return;
            }

            // ─── NWS CWA Boundaries ───
            if (layer === 'overlay-cwa') {
                const isActive = !item.classList.contains('active');
                if (map.getLayer('nws-cwa-layer')) map.setLayoutProperty('nws-cwa-layer', 'visibility', isActive ? 'visible' : 'none');
                if (map.getLayer('nws-cwa-label-layer')) map.setLayoutProperty('nws-cwa-label-layer', 'visibility', isActive ? 'visible' : 'none');
                if (isActive) fetchCWALabels();
                updateSidebarToActivePane();
                return;
            }

            // ─── Overlays (generic toggle) ───
            const overlayMap = {
                'nws-wwa': ['nws-wwa-wms-layer'],
                'overlay-states': ['states-layer'],
                'overlay-counties': ['counties-layer'],
                'overlay-roads': ['esri-roads-layer'],
                'overlay-cities': ['esri-labels-layer'],
                'overlay-hms': ['hms-smoke-fill', 'hms-smoke-outline']
            };

            if (overlayMap[layer]) {
                const isActive = !item.classList.contains('active');
                overlayMap[layer].forEach(l => {
                    if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', isActive ? 'visible' : 'none');
                });
                updateSidebarToActivePane();
                return;
            }
        });
    });
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 15c: MODEL GUIDANCE — MULTI-MODEL COMPARISON & MOS
// ═══════════════════════════════════════════════════════════════════════════════
//
// Deliberately POINT-based, never gridded. A gridded contour overlay was built
// and measured before this was written: Open-Meteo weights its quota per
// location, so a 325-point CONUS grid costs ~325 of the 10,000 daily calls and
// returns HTTP 429 after two renders — roughly 30 map draws per day, unusable.
// One point across five models is ~1 call and 27 KB. There is also no CORS-open
// free gridded WMS for these models (NOAA IDP-GIS publishes no model folder, and
// Unidata's THREDDS serves GFS but sends no Access-Control-Allow-Origin), and
// decoding GRIB client-side is the AWIPS ingest burden this app exists to avoid.
// Point guidance answers the question that actually matters anyway: do the
// models agree, and where does the spread blow up?
//
// Everything here loads ONLY when its panel is opened. No pollers, no map
// layers, no background traffic.

// Open-Meteo model IDs. `ai` marks a machine-learning model rather than a
// physics solver — ECMWF's AIFS is operational, and its disagreement with IFS is
// a genuinely useful signal. NOTE: there is no "AI MOS"; MDL station guidance is
// still classical regression and its successor is NBM, so the AI tag belongs to
// the model, not to the MOS panel.
// HRRR is short-range by design (3 km CONUS, hourly runs, ~48 h) so its trace
// simply ends partway across the chart — that truncation is honest, and where it
// disagrees with the globals inside 48 h is exactly where it earns its keep.
// `runDir` is the Open-Meteo data directory whose static/meta.json publishes the
// cycle this model is currently serving. For the `_seamless` families — which
// splice a high-res domain onto a global one — it names the GLOBAL member, since
// that is the run covering the full length of the chart.
const MODEL_SOURCES = [
    { id: 'gfs_seamless',         label: 'GFS',        org: 'NOAA NCEP', color: '#00e5ff', runDir: 'ncep_gfs013' },
    { id: 'gfs_hrrr',             label: 'HRRR',       org: 'NOAA 3 km', color: '#ff8a3c', shortRange: true, runDir: 'ncep_hrrr_conus' },
    { id: 'ecmwf_ifs025',         label: 'ECMWF IFS',  org: 'ECMWF',     color: '#ff5ad1', runDir: 'ecmwf_ifs025' },
    { id: 'gem_seamless',         label: 'CMC GEM',    org: 'ECCC',      color: '#ffd166', runDir: 'cmc_gem_gdps' },
    { id: 'icon_seamless',        label: 'ICON',       org: 'DWD',       color: '#7cff6b', runDir: 'dwd_icon' },
    { id: 'ecmwf_aifs025_single', label: 'ECMWF AIFS', org: 'ECMWF',     color: '#c08bff', ai: true, runDir: 'ecmwf_aifs025_single' }
];

// ─── Model cycle (initialisation) times ───
// The /v1/forecast response carries no init time — only the valid times — so the
// cycle behind each trace is read from Open-Meteo's per-model meta.json, which is
// CORS-open and ~600 bytes. Cached for the session so re-rendering the chart
// (changing field, range or panel size) costs nothing.
const MODEL_RUNS_TTL = 10 * 60 * 1000;
let _modelRuns = null, _modelRunsAt = 0;

// A published cycle is only believable while the metadata is still tracking the
// data. Open-Meteo's cmc_gem_gdps meta.json is a live example of the failure:
// it has been frozen for weeks while the model itself keeps delivering current
// forecasts, so printing its stated run would put a two-month-old timestamp on
// a trace that is actually today's. Three cycles plus a six-hour grace is well
// past any normal delivery delay, and past it we say nothing rather than lie.
function _modelRunUsable(meta) {
    const init = meta && meta.last_run_initialisation_time;
    if (!init) return false;
    const interval = (meta.update_interval_seconds || 6 * 3600) * 1000;
    const age = Date.now() - init * 1000;
    return age > -3600 * 1000 && age <= 3 * interval + 6 * 3600 * 1000;
}

// Same UTC day → bare hour ("06Z"); otherwise carry the date ("11/18Z").
function _modelRunLabel(initSec) {
    const d = new Date(initSec * 1000), now = new Date();
    const hh = String(d.getUTCHours()).padStart(2, '0') + 'Z';
    return d.getUTCDate() === now.getUTCDate() && d.getUTCMonth() === now.getUTCMonth()
        ? hh : `${String(d.getUTCDate()).padStart(2, '0')}/${hh}`;
}

async function fetchModelRuns() {
    if (_modelRuns && Date.now() - _modelRunsAt < MODEL_RUNS_TTL) return _modelRuns;
    const out = {};
    await Promise.all(MODEL_SOURCES.map(async m => {
        try {
            // meta.json ships Last-Modified and ETag but NO Cache-Control, so
            // browsers apply heuristic freshness and will happily serve the
            // previous cycle for hours. A stale run time is worse than none —
            // it is the one number this feature exists to get right.
            const r = await fetch(cacheBust(`https://api.open-meteo.com/data/${m.runDir}/static/meta.json`));
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const j = await r.json();
            out[m.id] = _modelRunUsable(j)
                ? { ok: true, init: j.last_run_initialisation_time, avail: j.last_run_availability_time }
                : { ok: false, why: 'source has stopped publishing a current cycle time' };
        } catch (e) {
            out[m.id] = { ok: false, why: e.message };
        }
    }));
    _modelRuns = out; _modelRunsAt = Date.now();
    return out;
}

const MODEL_VARS = {
    temperature_2m: { label: 'Temperature', unit: '°F', dec: 0 },
    dewpoint_2m:    { label: 'Dewpoint',    unit: '°F', dec: 0 },
    wind_speed_10m: { label: 'Wind',        unit: 'kt', dec: 0 },
    precipitation:  { label: 'Precip',      unit: 'in', dec: 2 },
    pressure_msl:   { label: 'MSLP',        unit: 'mb', dec: 1 }
};

let modelData = null;   // { times[], series{modelId:{var:[]}}, label, fetched }

async function loadModelCompareAt(latNum, lonNum, presetLabel) {
    const body = document.getElementById('model-body');
    const locEl = document.getElementById('model-loc');
    const panel = document.getElementById('model-panel');
    if (!body) return;
    const lat = (+latNum).toFixed(4), lon = (+lonNum).toFixed(4);
    const label = presetLabel || `${lat}, ${lon}`;
    if (locEl) locEl.textContent = `Loading ${label}…`;
    body.innerHTML = `<div style="color:#6b7a88;font-size:12px;padding:20px;">Pulling ${MODEL_SOURCES.length} models for ${esc(label)}…</div>`;
    try {
        const days = parseInt(document.getElementById('model-days')?.value) || 7;
        const url = 'https://api.open-meteo.com/v1/forecast'
            + `?latitude=${lat}&longitude=${lon}`
            + `&hourly=${Object.keys(MODEL_VARS).join(',')}`
            + `&models=${MODEL_SOURCES.map(m => m.id).join(',')}`
            + `&forecast_days=${days}`
            + '&temperature_unit=fahrenheit&wind_speed_unit=kn&precipitation_unit=inch';
        // Cycle times ride alongside the forecast rather than after it — they are
        // static files on a different path, so a failure there must not cost the
        // chart. runs resolves to {} at worst.
        const [res, runs] = await Promise.all([
            fetch(url),
            fetchModelRuns().catch(() => ({}))
        ]);
        if (res.status === 429) throw new Error('Open-Meteo rate limit reached — wait a minute and try again.');
        if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
        const j = await res.json();
        const h = j.hourly || {};
        const times = (h.time || []).map(t => new Date(t + 'Z').getTime());
        if (!times.length) throw new Error('No forecast returned for this point.');
        // Open-Meteo suffixes every series with its model id when several models
        // are requested; a single-model request would come back unsuffixed.
        const series = {};
        MODEL_SOURCES.forEach(m => {
            series[m.id] = {};
            Object.keys(MODEL_VARS).forEach(v => {
                series[m.id][v] = h[`${v}_${m.id}`] || h[v] || [];
            });
        });
        modelData = { times, series, label, runs: runs || {}, fetched: Date.now() };
        if (panel) panel.dataset.loaded = '1';
        if (locEl) locEl.textContent = `${label} · ${days}-day · fetched ${new Date().toISOString().substring(11, 16)}Z`;
        renderModelCompare();
    } catch (e) {
        modelData = null;
        if (locEl) locEl.textContent = '—';
        body.innerHTML = `<div style="color:#ffb300;font-size:12px;padding:20px;line-height:1.5;">${esc(e.message)}</div>`;
    }
}

function loadModelCompare() {
    const map = maps[activePaneId] || Object.values(maps)[0];
    if (!map) return;
    const c = map.getCenter();
    _modelPoint = null;          // back to following the pane, not a searched place
    return loadModelCompareAt(c.lat, c.lng);
}

function renderModelCompare() {
    const body = document.getElementById('model-body');
    if (!body || !modelData) return;
    const varKey = document.getElementById('model-var')?.value || 'temperature_2m';
    const meta = MODEL_VARS[varKey];
    const active = MODEL_SOURCES.filter(m => modelData.series[m.id]?.[varKey]?.some(v => v != null));
    // The plot lives in its own positioned box so the cursor canvas and the
    // readout can sit on top of it without disturbing the flex column below.
    body.innerHTML = `<div id="model-plot" style="position:relative;">
            <canvas id="model-canvas" style="display:block;"></canvas>
            <canvas id="model-cursor" style="position:absolute;left:0;top:0;pointer-events:none;"></canvas>
            <div id="model-readout" style="position:absolute;display:none;pointer-events:none;z-index:2;
                background:rgba(13,17,23,0.96);border:1px solid rgba(255,255,255,0.18);border-radius:4px;
                padding:6px 8px;font-family:'Roboto Mono',monospace;font-size:10px;line-height:1.55;
                white-space:nowrap;box-shadow:0 4px 16px rgba(0,0,0,0.7);"></div>
        </div>
        <div id="model-legend" style="display:flex;flex-wrap:wrap;gap:10px;padding:8px 2px 2px;font-size:10px;"></div>
        <div id="model-spread" style="font-size:10px;color:#8b97a3;padding:2px;line-height:1.5;"></div>
        <div style="font-size:9px;color:#5b6773;padding:6px 2px 2px;">
            Model data by <b style="color:#8b97a3;">Open-Meteo.com</b> (CC BY 4.0) — GFS/NCEP, IFS &amp; AIFS/ECMWF, GEM/ECCC, ICON/DWD.
        </div>`;
    const legend = document.getElementById('model-legend');
    const runs = modelData.runs || {};
    active.forEach(m => {
        const r = runs[m.id];
        // The cycle sits with the model that produced it — a trace is only worth
        // reading once you know which run it came from, and the runs genuinely
        // differ (HRRR is hourly while IFS is six-hourly and lands ~7 h late).
        let runHTML;
        if (r && r.ok) {
            const ageH = Math.max(0, (Date.now() - r.init * 1000) / 3600000);
            runHTML = `<span style="color:${m.color};font-family:'Roboto Mono',monospace;" `
                + `title="${esc(m.label)} ${esc(m.runDir)} — initialised ${new Date(r.init * 1000).toISOString().replace('T', ' ').substring(0, 16)}Z, `
                + `${ageH.toFixed(1)} h ago">${esc(_modelRunLabel(r.init))}</span>`;
        } else {
            runHTML = `<span style="color:#8a6d3b;font-family:'Roboto Mono',monospace;" `
                + `title="Cycle time unavailable — ${esc((r && r.why) || 'no metadata')}. The forecast itself is current.">run ?</span>`;
        }
        const sw = document.createElement('span');
        sw.style.cssText = 'display:inline-flex;align-items:center;gap:5px;';
        sw.innerHTML = `<span style="width:16px;height:3px;background:${m.color};display:inline-block;"></span>`
            + `<span style="color:#cdd6df;">${esc(m.label)}</span>`
            + (m.ai ? `<span class="badge" style="background:#5b3d8f;color:#fff;font-size:8px;">AI</span>` : '')
            + `<span style="color:#5b6773;">${esc(m.org)}</span>`
            + runHTML;
        legend.appendChild(sw);
    });
    renderModelSpread(varKey, active, meta);
    // Chart last: it sizes itself from whatever height the siblings left behind.
    drawModelChart(document.getElementById('model-canvas'), varKey, active);
    _modelHoverBind();
}

// Mean and worst inter-model spread — the number a forecaster actually wants,
// because agreement is the confidence signal, not any single deterministic run.
function renderModelSpread(varKey, active, meta) {
    const el = document.getElementById('model-spread');
    if (!el || active.length < 2) { if (el) el.textContent = ''; return; }
    let sum = 0, n = 0, worst = 0, worstMs = null;
    modelData.times.forEach((ms, i) => {
        const vals = active.map(m => modelData.series[m.id][varKey][i]).filter(v => v != null);
        if (vals.length < 2) return;
        const spread = Math.max(...vals) - Math.min(...vals);
        sum += spread; n++;
        if (spread > worst) { worst = spread; worstMs = ms; }
    });
    if (!n) { el.textContent = ''; return; }
    const t = worstMs ? new Date(worstMs) : null;
    const when = t ? `${String(t.getUTCDate()).padStart(2, '0')}/${String(t.getUTCHours()).padStart(2, '0')}Z` : '—';
    el.innerHTML = `<b style="color:#cdd6df;">Spread</b> — mean ${(sum / n).toFixed(meta.dec)}${meta.unit}, `
        + `max ${worst.toFixed(meta.dec)}${meta.unit} at ${when} `
        + `<span style="color:#5b6773;">(${active.length} models; wider spread = lower confidence)</span>`;
}

function drawModelChart(canvas, varKey, active) {
    if (!canvas) return;
    const body = document.getElementById('model-body');
    const plot = canvas.parentElement;          // #model-plot, sibling of the text blocks
    const cssW = Math.max(560, (body?.clientWidth || 700) - 8);
    // Grow into whatever the panel gives us — measure the real height of the
    // legend/spread/credit blocks rather than assuming, since the legend wraps
    // to a second line on a narrow panel and not on a maximized one.
    const used = body ? Array.from(body.children).reduce(
        (s, el) => el === plot ? s : s + el.offsetHeight, 0) : 0;
    const cssH = Math.max(240, Math.min(900, (body?.clientHeight || 460) - used - 22));
    const dpr = window.devicePixelRatio || 1;
    canvas.width = cssW * dpr; canvas.height = cssH * dpr;
    canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
    const cur = document.getElementById('model-cursor');
    if (cur) {
        cur.width = cssW * dpr; cur.height = cssH * dpr;
        cur.style.width = cssW + 'px'; cur.style.height = cssH + 'px';
        cur.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    _modelPlot = null;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const meta = MODEL_VARS[varKey];
    const times = modelData.times;
    if (!active.length || times.length < 2) {
        ctx.fillStyle = '#8b97a3'; ctx.font = '12px "Roboto Mono",monospace'; ctx.textAlign = 'center';
        ctx.fillText('No data for this field.', cssW / 2, cssH / 2);
        return;
    }
    const mL = 46, mR = 14, mT = 16, mB = 30;
    const pw = cssW - mL - mR, ph = cssH - mT - mB;
    const t0 = times[0], t1 = times[times.length - 1];
    const X = ms => mL + ((ms - t0) / (t1 - t0)) * pw;
    const all = [];
    active.forEach(m => modelData.series[m.id][varKey].forEach(v => { if (v != null) all.push(v); }));
    let vMin = Math.min(...all), vMax = Math.max(...all);
    if (vMax - vMin < 1e-6) { vMax += 1; vMin -= 1; }
    const pad = (vMax - vMin) * 0.12;
    vMin -= pad; vMax += pad;
    if (varKey === 'precipitation' && vMin < 0) vMin = 0;
    const Y = v => mT + ph - ((v - vMin) / (vMax - vMin)) * ph;
    ctx.font = '9px "Roboto Mono",monospace';
    // y grid + labels
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let i = 0; i <= 5; i++) {
        const v = vMin + (vMax - vMin) * (i / 5);
        ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(mL, Y(v)); ctx.lineTo(mL + pw, Y(v)); ctx.stroke();
        ctx.fillStyle = '#8b97a3'; ctx.fillText(v.toFixed(meta.dec), mL - 6, Y(v));
    }
    // x grid: 00Z day boundaries
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let d = new Date(t0); d.getTime() <= t1; d = new Date(d.getTime() + 864e5)) {
        const dayMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
        if (dayMs < t0) continue;
        ctx.strokeStyle = 'rgba(255,255,255,0.10)';
        ctx.beginPath(); ctx.moveTo(X(dayMs), mT); ctx.lineTo(X(dayMs), mT + ph); ctx.stroke();
        ctx.fillStyle = '#8b97a3';
        ctx.fillText(`${String(new Date(dayMs).getUTCDate()).padStart(2, '0')}/00Z`, X(dayMs), mT + ph + 5);
    }
    // spread envelope behind the lines — the visual form of model disagreement
    if (active.length > 1) {
        const top = [], bot = [];
        times.forEach((ms, i) => {
            const vals = active.map(m => modelData.series[m.id][varKey][i]).filter(v => v != null);
            if (vals.length < 2) return;
            top.push([X(ms), Y(Math.max(...vals))]);
            bot.push([X(ms), Y(Math.min(...vals))]);
        });
        if (top.length > 1) {
            ctx.fillStyle = 'rgba(0,229,255,0.09)';
            ctx.beginPath();
            top.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
            for (let i = bot.length - 1; i >= 0; i--) ctx.lineTo(bot[i][0], bot[i][1]);
            ctx.closePath(); ctx.fill();
        }
    }
    // one line per model
    active.forEach(m => {
        const vals = modelData.series[m.id][varKey];
        ctx.strokeStyle = m.color;
        ctx.lineWidth = m.ai ? 2.2 : 1.8;
        if (m.ai) ctx.setLineDash([6, 3]);   // AI model reads distinctly from the physics runs
        ctx.beginPath();
        let started = false;
        times.forEach((ms, i) => {
            const v = vals[i];
            if (v == null) { started = false; return; }
            started ? ctx.lineTo(X(ms), Y(v)) : ctx.moveTo(X(ms), Y(v));
            started = true;
        });
        ctx.stroke();
        ctx.setLineDash([]);
    });
    // y-axis title
    ctx.save(); ctx.translate(11, mT + ph / 2); ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = '#00e5ff';
    ctx.fillText(`${meta.label.toUpperCase()} (${meta.unit})`, 0, 0); ctx.restore();
    // Hand the scales to the cursor overlay so hovering never recomputes them.
    _modelPlot = { mL, mT, pw, ph, cssW, cssH, t0, t1, vMin, vMax, varKey, active, meta };
}

// ─── Hover readout ───────────────────────────────────────────────────────────
// Six traces converging and crossing is exactly where the eye stops being able
// to read values off a chart, which is the moment you most want the numbers.
// The crosshair snaps to the forecast hour rather than following the pixel, so
// the readout is the model's actual output and not an interpolation of it.
let _modelPlot = null;

function _modelHoverBind() {
    const plot = document.getElementById('model-plot');
    if (!plot) return;
    plot.addEventListener('mousemove', _modelHoverMove);
    plot.addEventListener('mouseleave', _modelHoverHide);
}

function _modelHoverHide() {
    const cur = document.getElementById('model-cursor');
    const out = document.getElementById('model-readout');
    if (cur && _modelPlot) cur.getContext('2d').clearRect(0, 0, _modelPlot.cssW, _modelPlot.cssH);
    if (out) out.style.display = 'none';
}

function _modelHoverMove(e) {
    const P = _modelPlot, cur = document.getElementById('model-cursor'), out = document.getElementById('model-readout');
    if (!P || !cur || !out || !modelData) return;
    const rect = cur.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    if (px < P.mL || px > P.mL + P.pw || py < P.mT || py > P.mT + P.ph) { _modelHoverHide(); return; }

    const times = modelData.times;
    const target = P.t0 + ((px - P.mL) / P.pw) * (P.t1 - P.t0);
    // Uniform hourly spacing makes the index a division; the ±1 sweep keeps it
    // exact if a feed ever comes back with a gap.
    let i = Math.round((target - P.t0) / ((P.t1 - P.t0) / (times.length - 1)));
    i = Math.max(0, Math.min(times.length - 1, i));
    for (const j of [i - 1, i + 1]) {
        if (j >= 0 && j < times.length && Math.abs(times[j] - target) < Math.abs(times[i] - target)) i = j;
    }

    const X = ms => P.mL + ((ms - P.t0) / (P.t1 - P.t0)) * P.pw;
    const Y = v => P.mT + P.ph - ((v - P.vMin) / (P.vMax - P.vMin)) * P.ph;
    const cx = X(times[i]);

    const c = cur.getContext('2d');
    c.clearRect(0, 0, P.cssW, P.cssH);
    c.strokeStyle = 'rgba(255,255,255,0.45)'; c.lineWidth = 1; c.setLineDash([3, 3]);
    c.beginPath(); c.moveTo(cx, P.mT); c.lineTo(cx, P.mT + P.ph); c.stroke();
    c.setLineDash([]);

    const rows = [];
    const vals = [];
    P.active.forEach(m => {
        const v = modelData.series[m.id][P.varKey][i];
        if (v == null) { rows.push({ m, txt: '—', dim: true }); return; }
        vals.push(v);
        c.fillStyle = m.color;
        c.beginPath(); c.arc(cx, Y(v), 3.2, 0, Math.PI * 2); c.fill();
        c.strokeStyle = '#0d1117'; c.lineWidth = 1.2; c.stroke();
        rows.push({ m, txt: `${v.toFixed(P.meta.dec)}${P.meta.unit}` });
    });

    const d = new Date(times[i]);
    const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
    const stamp = `${dow} ${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCHours()).padStart(2, '0')}Z`;
    const hrOut = Math.round((times[i] - Date.now()) / 3600000);
    let html = `<div style="color:#00e5ff;border-bottom:1px solid rgba(255,255,255,0.15);padding-bottom:3px;margin-bottom:3px;">`
        + `${esc(stamp)} <span style="color:#5b6773;">${hrOut >= 0 ? '+' + hrOut : hrOut} h</span></div>`;
    rows.forEach(r => {
        html += `<div style="display:flex;gap:6px;align-items:center;">`
            + `<span style="width:10px;height:3px;background:${r.m.color};display:inline-block;flex:0 0 auto;"></span>`
            + `<span style="color:#8b97a3;flex:1 1 auto;">${esc(r.m.label)}</span>`
            + `<span style="color:${r.dim ? '#5b6773' : '#e6edf3'};">${esc(r.txt)}</span></div>`;
    });
    if (vals.length > 1) {
        html += `<div style="border-top:1px solid rgba(255,255,255,0.15);margin-top:3px;padding-top:3px;display:flex;gap:6px;">`
            + `<span style="color:#8b97a3;flex:1 1 auto;">spread</span>`
            + `<span style="color:#ffd166;">${(Math.max(...vals) - Math.min(...vals)).toFixed(P.meta.dec)}${P.meta.unit}</span></div>`;
    }
    out.innerHTML = html;
    out.style.display = 'block';
    // Flip to the cursor's other side near an edge so the box never leaves the plot.
    const bw = out.offsetWidth, bh = out.offsetHeight;
    out.style.left = (cx + 14 + bw > P.cssW ? Math.max(0, cx - 14 - bw) : cx + 14) + 'px';
    out.style.top = Math.max(0, Math.min(P.cssH - bh, py - bh / 2)) + 'px';
}

// Maximize / restore, mirroring the SPC Mesoanalysis panel. Six traces on a
// 760 px chart is where fine spread stops being readable, so filling the window
// is the difference between seeing that the models diverge and seeing by how much.
let _modelMaximized = false, _modelPrevGeom = null;
function _modelToggleMax() {
    const panel = document.getElementById('model-panel');
    const btn = document.getElementById('model-max');
    if (!panel) return;
    if (!_modelMaximized) {
        _modelPrevGeom = { w: panel.style.width, h: panel.style.height, l: panel.style.left, t: panel.style.top, r: panel.style.right };
        panel.style.left = '8px'; panel.style.top = '8px'; panel.style.right = 'auto';
        panel.style.width = (window.innerWidth - 16) + 'px';
        panel.style.height = (window.innerHeight - 16) + 'px';
        _modelMaximized = true;
        if (btn) btn.title = 'Restore panel size';
    } else {
        const g = _modelPrevGeom || {};
        panel.style.width = g.w || '760px'; panel.style.height = g.h || '580px';
        panel.style.left = g.l || ''; panel.style.top = g.t || ''; panel.style.right = g.r || '';
        _modelMaximized = false;
        if (btn) btn.title = 'Maximize to fill the window';
    }
    if (modelData) renderModelCompare();
}

function initModelCompare() {
    const panel = document.getElementById('model-panel');
    if (!panel) return;
    const openBtn = document.getElementById('btn-model-compare');
    if (openBtn) openBtn.addEventListener('click', () => {
        const opening = panel.style.display === 'none' || !panel.style.display;
        panel.style.display = opening ? 'flex' : 'none';
        if (opening && !panel.dataset.loaded) loadModelCompare();
    });
    document.getElementById('close-model-panel')?.addEventListener('click', () => { panel.style.display = 'none'; });
    document.getElementById('model-refresh')?.addEventListener('click', () => loadModelCompare());
    // Field switch re-renders the cached payload — every variable came down in
    // the same request, so there is nothing to refetch.
    document.getElementById('model-var')?.addEventListener('change', () => { if (modelData) renderModelCompare(); });
    document.getElementById('model-days')?.addEventListener('change', () => { if (modelData) loadModelCompareAt(...modelLastPoint()); });
    const goBtn = document.getElementById('model-go');
    const placeInput = document.getElementById('model-place');
    const runSearch = async () => {
        const locEl = document.getElementById('model-loc');
        try {
            if (locEl) locEl.textContent = 'Searching…';
            const g = await geocodePlace(placeInput.value);
            _modelPoint = [g.lat, g.lon, g.label];
            await loadModelCompareAt(g.lat, g.lon, g.label);
        } catch (e) {
            if (locEl) locEl.textContent = '—';
            const body = document.getElementById('model-body');
            if (body) body.innerHTML = `<div style="color:#ffb300;font-size:12px;padding:20px;">${esc(e.message)}</div>`;
        }
    };
    goBtn?.addEventListener('click', runSearch);
    placeInput?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } });
    document.getElementById('model-max')?.addEventListener('click', _modelToggleMax);
    // Redraw on window resize and after a drag of the panel's own resize grip.
    // The canvas is a fixed-pixel bitmap, so without this it stays the old size
    // and simply sits in the corner of a bigger panel.
    // mouseup fires on every click anywhere in the app, so redraw only when the
    // panel's box actually changed — otherwise this rebuilds the canvas and
    // legend on each click for no reason.
    let _mcT = null, _mcBox = '';
    const refit = () => {
        if (panel.style.display === 'none' || !modelData) return;
        const box = `${panel.clientWidth}x${panel.clientHeight}`;
        if (box === _mcBox) return;
        _mcBox = box;
        clearTimeout(_mcT);
        _mcT = setTimeout(() => renderModelCompare(), 120);
    };
    window.addEventListener('resize', refit);
    document.addEventListener('mouseup', refit);
    makePanelDraggable(panel, 'model-drag');
}

let _modelPoint = null;
function modelLastPoint() {
    if (_modelPoint) return _modelPoint;
    const map = maps[activePaneId] || Object.values(maps)[0];
    const c = map ? map.getCenter() : { lat: 32.3, lng: -90.2 };
    return [c.lat, c.lng, undefined];
}

// ─── MOS guidance (IEM parses the MDL bulletins into JSON) ───
// GFS MOS is NOT being retired. NAM MOS (MET) goes away with NAM itself on
// 2026-10-06 12 UTC alongside SREF/HREF/HiresW, replaced by RRFS/REFS; MDL
// points NAM MOS users at GFS MOS or NBM, and LAMP temporarily switches to a
// GFS MOS input. The panel says so rather than silently serving a dying product.
// `cycleHrs` is the BULLETIN issuance interval, verified by walking IEM's archive
// cycle by cycle — not the interval the underlying model runs at. That gap is the
// usual source of "why is my guidance stale?": the NBM system itself updates
// every hour, but its NBS station bulletin is only cut every 6 hours and NBE
// every 12. The genuinely hourly station product is LAMP, so the panel says so
// rather than leaving you to wonder whether a 06Z run at 13Z is broken.
//
// There is no standalone "HRRR MOS" bulletin and there never has been. HRRR's
// statistical station guidance ships inside LAMP: MDL has melded HRRR into the
// LAMP ceiling/visibility elements since v2.0 (2017-04-03) and extended the
// station guidance to take HRRR input in v2.5 (2023-06-06). So LAV is the HRRR
// MOS, and its convection/lightning rows (CP1/CC1, LP1/LC1 — 1-h probability
// and N/L/M/H potential out to 25 h) are the part worth having on screen.
const MOS_MODELS = [
    { id: 'GFS', label: 'GFS MOS',  sub: 'MAV · 3-hourly out to 72 h', cycleHrs: 6,
      rows: ['tmp', 'dpt', 'cld', 'wdr', 'wsp', 'p06', 'p12', 'q06', 'q12', 't06_1', 't06_2', 't12_1', 'cig', 'vis', 'obv'] },
    { id: 'MEX', label: 'GFS Ext',  sub: 'MEX · 12-hourly out to 192 h', cycleHrs: 12,
      rows: ['n_x', 'tmp', 'dpt', 'cld', 'wsp', 'p12', 'q12', 't12_1', 't12_2'] },
    { id: 'LAV', label: 'LAMP',     sub: 'Localized Aviation MOS · HRRR-melded · hourly', cycleHrs: 1, hrrr: true,
      rows: ['tmp', 'dpt', 'cld', 'wdr', 'wsp', 'p01', 'cig', 'vis', 'obv', 'ccg', 'cvs', 'ppo', 'pco',
             'lp1', 'lc1', 'cp1', 'cc1'] },
    { id: 'NBS', label: 'NBM Short', sub: 'National Blend · 3-hourly out to ~72 h', cycleHrs: 6, nbm: true,
      rows: ['tmp', 'dpt', 'wdr', 'wsp', 'gst', 'sky', 'p06', 'q06', 't06_1', 'cig', 'vis', 'pra', 'psn', 'pzr', 'ppl', 's06'] },
    { id: 'NBE', label: 'NBM Ext',  sub: 'National Blend · 12-hourly, extended', cycleHrs: 12, nbm: true,
      rows: ['n_x', 'tmp', 'dpt', 'wdr', 'wsp', 'gst', 'sky', 'p12', 'q12', 't12_1', 's12'] },
    { id: 'NAM', label: 'NAM MOS',  sub: 'MET · retires 2026-10-06 12 UTC with NAM', cycleHrs: 6, retiring: true,
      rows: ['tmp', 'dpt', 'cld', 'wdr', 'wsp', 'p06', 'p12', 'q06', 'q12', 't06_1', 't12_1', 'cig', 'vis', 'obv'] }
];

// Bulletin row labels, in MDL's own shorthand so the table reads like the real thing.
const MOS_ROW_LABELS = {
    n_x: 'N/X', tmp: 'TMP', dpt: 'DPT', cld: 'CLD', sky: 'SKY', wdr: 'WDR', wsp: 'WSP', gst: 'GST',
    p01: 'P01', p06: 'P06', p12: 'P12', q06: 'Q06', q12: 'Q12',
    t06_1: 'T06', t06_2: 'T06/S', t12_1: 'T12', t12_2: 'T12/S',
    cig: 'CIG', vis: 'VIS', obv: 'OBV', ccg: 'CCG', cvs: 'CVS', ppo: 'PPO', pco: 'PCO',
    pra: 'PRA', psn: 'PSN', pzr: 'PZR', ppl: 'PPL', s06: 'S06', s12: 'S12',
    lp1: 'LP1', lc1: 'LC1', cp1: 'CP1', cc1: 'CC1'
};

let mosCache = {};   // `${station}|${model}` -> { rows, fetched }

// IEM returns MOS times as UTC values but writes them WITHOUT a zone designator
// ("2026-07-28T06:00:00.000", or "2026-07-28 06:00"). A bare date-time is parsed
// as LOCAL by JS, which silently shifted every projection hour by the viewer's
// UTC offset. Force the Z on.
function parseMosUtc(s) {
    if (!s) return NaN;
    return Date.parse(String(s).trim().replace(' ', 'T').replace(/Z$/, '') + 'Z');
}

function mosStationId(raw) {
    const s = (raw || '').trim().toUpperCase();
    // MDL keys MOS by 4-character ICAO. IEM's CONUS ASOS ids are 3 characters
    // (JAN); Alaska/Hawaii/Pacific are already 4 (PANC, PHKO).
    return s.length === 3 ? 'K' + s : s;
}

// Nearest ASOS to the pane centre, taken from the METAR set the app already
// holds — no extra network call, and it degrades to a typed id if METARs are off.
function nearestMosStation() {
    const map = maps[activePaneId] || Object.values(maps)[0];
    if (!map || !metarGeoJSON.features.length) return null;
    const c = map.getCenter();
    let best = null, bestD = Infinity;
    metarGeoJSON.features.forEach(f => {
        const g = f.geometry?.coordinates;
        const id = f.properties?.station;
        if (!g || !id) return;
        const d = (g[0] - c.lng) ** 2 + (g[1] - c.lat) ** 2;
        if (d < bestD) { bestD = d; best = id; }
    });
    return best ? mosStationId(best) : null;
}

async function loadMos(stationRaw, modelId) {
    const body = document.getElementById('mos-body');
    const locEl = document.getElementById('mos-loc');
    if (!body) return;
    const station = mosStationId(stationRaw);
    const def = MOS_MODELS.find(m => m.id === modelId) || MOS_MODELS[0];
    if (!/^[A-Z0-9]{4}$/.test(station)) {
        body.innerHTML = `<div style="color:#ffb300;font-size:12px;padding:20px;">Enter a 3- or 4-character station id (e.g. <b>JAN</b> or <b>KJAN</b>).</div>`;
        return;
    }
    if (locEl) locEl.textContent = `Loading ${station} ${def.label}…`;
    body.innerHTML = `<div style="color:#6b7a88;font-size:12px;padding:20px;">Fetching ${esc(def.label)} for ${esc(station)}…</div>`;
    try {
        const res = await fetch(`https://mesonet.agron.iastate.edu/api/1/mos.json?station=${encodeURIComponent(station)}&model=${encodeURIComponent(def.id)}`);
        if (res.status === 404) throw new Error(`No MOS site ${station}. MOS is issued for airports — try a nearby ICAO id.`);
        if (!res.ok) throw new Error(`IEM HTTP ${res.status}`);
        const j = await res.json();
        const rows = j.data || [];
        if (!rows.length) throw new Error(`${def.label} has no current bulletin for ${station}. It may not be an issuance site for this model.`);
        mosCache[`${station}|${def.id}`] = { rows, fetched: Date.now() };
        renderMosTable(station, def, rows);
        if (locEl) locEl.textContent = `${station} · ${def.label} · run ${rows[0].runtime || '—'}Z`;
    } catch (e) {
        if (locEl) locEl.textContent = '—';
        body.innerHTML = `<div style="color:#ffb300;font-size:12px;padding:20px;line-height:1.5;">${esc(e.message)}</div>`;
    }
}

function renderMosTable(station, def, rows) {
    const body = document.getElementById('mos-body');
    if (!body) return;
    // Only keep rows this bulletin actually carries, so an empty parameter never
    // takes a line — the real bulletins vary by model and by cycle.
    const useRows = def.rows.filter(k => rows.some(r => r[k] !== null && r[k] !== undefined && r[k] !== ''));
    const ftMs = rows.map(r => parseMosUtc(r.ftime_utc || r.ftime));
    const hdr = ftMs.map(ms => isNaN(ms) ? '--' : String(new Date(ms).getUTCHours()).padStart(2, '0'));
    const days = ftMs.map(ms => isNaN(ms) ? '' : String(new Date(ms).getUTCDate()).padStart(2, '0'));
    let lastDay = null;
    const dayCells = days.map(dv => {
        const show = dv !== lastDay; lastDay = dv;
        return show ? dv : '';
    });
    const cell = v => (v === null || v === undefined || v === '') ? '' : String(v).trim();
    // Age the cycle against its own issuance interval, so a 6-hourly bulletin
    // sitting at 06Z mid-morning reads as on-time instead of looking stale.
    const runMs = parseMosUtc(rows[0].runtime_utc || rows[0].runtime);
    let ageNote = '';
    if (!isNaN(runMs)) {
        const ageMin = Math.max(0, Math.round((Date.now() - runMs) / 60000));
        const ageTxt = ageMin < 90 ? `${ageMin} min` : `${(ageMin / 60).toFixed(1)} h`;
        const nextMs = runMs + def.cycleHrs * 3600 * 1000;
        const nextTxt = `${String(new Date(nextMs).getUTCHours()).padStart(2, '0')}Z`;
        const overdue = Date.now() > nextMs + 75 * 60 * 1000;   // allow normal issuance lag
        ageNote = ` · <span style="color:${overdue ? '#ffb300' : '#8b97a3'};">${ageTxt} old`
            + (def.cycleHrs > 1 ? `, issued every ${def.cycleHrs} h, next ~${nextTxt}` : ', issued hourly')
            + `${overdue ? ' — running late' : ''}</span>`;
    }
    let html = `<div style="font-size:10px;color:#8b97a3;padding:0 2px 8px;line-height:1.5;">
            <b style="color:#cdd6df;">${esc(station)}</b> — ${esc(def.label)} <span style="color:#5b6773;">${esc(def.sub)}</span>
            ${def.retiring ? '<span class="badge orange" style="margin-left:6px;">RETIRING</span>' : ''}
            <br>Cycle <b style="color:#cdd6df;">${esc(rows[0].runtime || '—')}Z</b> · ${rows.length} forecast projections${ageNote}
            ${def.nbm ? '<br><span style="color:#5b6773;">The NBM system updates hourly, but this station bulletin is only cut every '
                + def.cycleHrs + ' h. For hourly-updating station guidance use <b style="color:#8b97a3;">LAMP</b>.</span>' : ''}
            ${def.hrrr ? '<br><span style="color:#5b6773;">There is no standalone HRRR MOS. LAMP <b style="color:#8b97a3;">is</b> the HRRR-based '
                + 'station guidance — MDL statistically melds HRRR into the ceiling, visibility and conditional CIG/VIS elements. '
                + 'LP1/LC1 and CP1/CC1 run to 25 h; the rest go further.</span>' : ''}
            ${def.retiring ? '<br><span style="color:#ffb300;">NAM MOS ends 2026-10-06 12 UTC with NAM, SREF, HREF and HiresW. MDL directs users to GFS MOS or NBM.</span>' : ''}
        </div>
        <div style="overflow-x:auto;">
        <table class="mos-table"><thead>
            <tr><th>DAY</th>${dayCells.map(d => `<th>${esc(d)}</th>`).join('')}</tr>
            <tr><th>HR (Z)</th>${hdr.map(h => `<th>${esc(h)}</th>`).join('')}</tr>
        </thead><tbody>`;
    useRows.forEach(k => {
        html += `<tr><th title="${esc(k)}">${esc(MOS_ROW_LABELS[k] || k.toUpperCase())}</th>`
            + rows.map(r => `<td>${esc(cell(r[k]))}</td>`).join('') + '</tr>';
    });
    html += `</tbody></table></div>
        <div style="font-size:9px;color:#5b6773;padding:8px 2px 2px;line-height:1.6;">
            MDL bulletins via Iowa Environmental Mesonet. TMP/DPT °F · WSP/GST kt · WDR degrees ·
            P06/P12 PoP % · Q06/Q12 QPF category · T06/T12 thunder (and severe) % ·
            CIG/VIS/CLD categorical · OBV obstruction to vision ·
            CCG/CVS conditional ceiling/visibility · PPO/PCO precip occurrence % and category ·
            LP1/CP1 1-h lightning and convection probability % · LC1/CC1 their potential (N/L/M/H).
            Convection = at least one lightning flash and/or radar ≥ 40 dBZ in the hour ending at that time.
        </div>`;
    body.innerHTML = html;
}

function initMosPanel() {
    const panel = document.getElementById('mos-panel');
    if (!panel) return;
    const stationInput = document.getElementById('mos-station');
    const modelSel = document.getElementById('mos-model');
    const run = () => loadMos(stationInput?.value, modelSel?.value);
    const openBtn = document.getElementById('btn-mos');
    if (openBtn) openBtn.addEventListener('click', () => {
        const opening = panel.style.display === 'none' || !panel.style.display;
        panel.style.display = opening ? 'flex' : 'none';
        if (opening && !panel.dataset.loaded) {
            const near = nearestMosStation();
            if (near && stationInput) stationInput.value = near;
            panel.dataset.loaded = '1';
            run();
        }
    });
    document.getElementById('close-mos-panel')?.addEventListener('click', () => { panel.style.display = 'none'; });
    document.getElementById('mos-go')?.addEventListener('click', run);
    modelSel?.addEventListener('change', run);
    stationInput?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
    document.getElementById('mos-nearest')?.addEventListener('click', () => {
        const near = nearestMosStation();
        if (!near) {
            const body = document.getElementById('mos-body');
            if (body) body.innerHTML = `<div style="color:#ffb300;font-size:12px;padding:20px;">Turn on METAR observations first — the nearest-station lookup reads that set.</div>`;
            return;
        }
        if (stationInput) stationInput.value = near;
        run();
    });
    makePanelDraggable(panel, 'mos-drag');
}

// Shared drag behaviour for the floating panels (same pattern the text and
// meteogram panels use inline).
function makePanelDraggable(panel, handleId) {
    const handle = document.getElementById(handleId);
    if (!handle) return;
    let dragging = false, startX, startY, origLeft, origTop;
    handle.addEventListener('mousedown', e => {
        if (e.target.closest('.btn-icon')) return;
        dragging = true; startX = e.clientX; startY = e.clientY;
        const rect = panel.getBoundingClientRect();
        origLeft = rect.left; origTop = rect.top; e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
        if (!dragging) return;
        panel.style.left = (origLeft + e.clientX - startX) + 'px';
        panel.style.top = (origTop + e.clientY - startY) + 'px';
        panel.style.right = 'auto'; panel.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 15b: GOES BIRD + SECTOR SELECTOR
// ═══════════════════════════════════════════════════════════════════════════════

// Re-point whatever satellite imagery the pane is already showing at the newly
// chosen bird/sector. Channels swap the IEM tile source in place; GIBS products
// go back through loadGibsLive because a bird change means a different layer.
function applyGoesSector(paneId, sectorKey) {
    const map = maps[paneId];
    if (!map) return;
    paneGoesSector[paneId] = sectorKey;
    const ch = paneGoesChannels[paneId];
    if (ch !== null && ch !== undefined && map.getSource('satellite')) {
        map.getSource('satellite').setTiles([goesChannelUrl(ch, sectorKey)]);
        fetchIemGoesValid(ch, sectorKey).then(() => {
            if (paneId === activePaneId) refreshTimestampLabel();
        });
    }
    if (paneGibs[paneId]) loadGibsLive(paneId, paneGibs[paneId]);
    if (paneId === activePaneId) refreshTimestampLabel();
}

function initGoesSectorSelector() {
    const sel = document.getElementById('goes-sector-select');
    const zoomBtn = document.getElementById('goes-sector-zoom');
    if (sel) {
        sel.addEventListener('change', () => {
            const key = GOES_SECTORS[sel.value] ? sel.value : DEFAULT_GOES_SECTOR;
            applyGoesSector(activePaneId, key);
            addLiveLog(`SECTOR: ${goesSectorLabel(key)}`, '#00e5ff');
            // Mesoscale sectors are small and roam — following them automatically
            // saves hunting for a 1000 km box somewhere on the map.
            if (goesSectorDef(key).floater) zoomToGoesSector(activePaneId, key);
            updateSidebarToActivePane();
            saveTabs();
        });
    }
    if (zoomBtn) {
        zoomBtn.addEventListener('click', () => zoomToGoesSector(activePaneId, goesSectorFor(activePaneId)));
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 16: RADAR SITE SELECTOR
// ═══════════════════════════════════════════════════════════════════════════════

// The five NCEP products are tile templates, so a site change just re-points
// their source URL. Everything else per-site — the NODD Level III overlays
// (SRM/CC/ZDR/KDP), storm tracks, meso/TVS markers and the VAD panel — is a
// fetch keyed to a station, so it has to be re-issued. Without this they stay
// on the previous radar, and because the 120 s poller re-requests whatever
// station is recorded in paneL3/paneStormAttr/paneMeso, it re-affirms the stale
// site every cycle and never self-corrects. Toggling the product off and on was
// the only way out, because that path passes the current site.
function reloadPaneSiteProducts(paneId, site) {
    const m = maps[paneId];
    if (!m) return;
    const st = paneL3[paneId];
    // Keep the product code, which carries the elevation tilt, so switching
    // sites holds your tilt instead of dropping back to the lowest slice.
    if (st && st.station !== site && isLayerVisible(m, 'radar-l3-layer')) {
        loadL3Radar(paneId, site, st.product);
    }
}

function initRadarSiteSelector() {
    const siteSelect = document.getElementById('radar-site-select');
    const productSelect = document.getElementById('radar-product-select');

    if (siteSelect) {
        siteSelect.addEventListener('change', () => {
            const val = siteSelect.value;
            const map = maps[activePaneId];
            if (!map) return;

            if (val.includes('nexrad')) {
                addLiveLog(`RADAR: Switching to National Mosaic`, '#00e5ff');
                // National - zoom out
                map.flyTo({ center: [-96, 38], zoom: 3.8, speed: 1.2 });
            } else {
                const coords = RADAR_LOCATIONS[val];
                if (coords) {
                    addLiveLog(`RADAR: Flying to ${val} radar area`, '#00e5ff');
                    map.flyTo({ center: coords, zoom: 8.5, speed: 1.5, curve: 1 });
                }
            }
            const site = siteSelect.value;
            const isNational = site.includes('nexrad');
            const badge = document.getElementById('radar-mode-badge');
            const refBtn = document.querySelector('[data-layer="radar-ref"]');
            const velBtn = document.querySelector('[data-layer="radar-vel"]');
            const hcBtn = document.querySelector('[data-layer="radar-hc"]');
            const radarActive = refBtn?.classList.contains('active') || velBtn?.classList.contains('active') || hcBtn?.classList.contains('active');

            // Apply the radar site to the synced group only. A PINNED pane is
            // independent: if the active pane is pinned, only IT changes (so you
            // can view, e.g., JAN in a pinned pane while the synced panes stay on
            // HDC); otherwise update every non-pinned pane in the tab.
            const activePinned = paneSyncDisabled.has(activePaneId);
            activeTabMapEntries().forEach(([id, m]) => {
                if (!m) return;
                const applies = activePinned ? (id === activePaneId) : !paneSyncDisabled.has(id);
                if (!applies) return;
                paneRadarSites[id] = site;
                if (!isNational) {
                    if (m.getSource('site-bref')) m.getSource('site-bref').setTiles([siteRadarUrl(site, 'sr_bref')]);
                    if (m.getSource('site-bvel')) m.getSource('site-bvel').setTiles([siteRadarUrl(site, 'sr_bvel')]);
                    if (m.getSource('site-bdhc')) m.getSource('site-bdhc').setTiles([siteRadarUrl(site, 'bdhc')]);
                    if (m.getSource('site-bdsa')) m.getSource('site-bdsa').setTiles([siteRadarUrl(site, 'bdsa')]);
                    if (m.getSource('site-boha')) m.getSource('site-boha').setTiles([siteRadarUrl(site, 'boha')]);
                    // The L3 image source is per-map, so each affected pane
                    // reloads its own overlay.
                    reloadPaneSiteProducts(id, site);
                }
            });

            if (!isNational) {
                // Storm tracks and meso/TVS write into map sources shared by every
                // pane, so they are re-fetched once for the whole tab rather than
                // once per pane — the panes all just moved to the same site.
                if (paneStormAttr[activePaneId] && paneStormAttr[activePaneId].station !== site
                    && isLayerVisible(map, 'storm-attr-cell')) {
                    fetchStormAttr(activePaneId, site);
                }
                if (paneMeso[activePaneId] && paneMeso[activePaneId].station !== site
                    && isLayerVisible(map, 'meso-circ')) {
                    fetchMesoMarkers(activePaneId, site);
                }
                // An open VAD panel follows the active pane's radar.
                const vadPanel = document.getElementById('vad-panel');
                if (vadPanel && vadPanel.style.display !== 'none' && vadPanel.dataset.station !== site) {
                    vadPanel.dataset.station = site;
                    loadVad(site);
                }
            }

            if (isNational) {
                if (badge) { badge.textContent = 'National'; badge.className = 'badge blue'; }
                if (refBtn?.classList.contains('active')) {
                    activeRadarNational = true;
                    ['site-bref-layer', 'site-bvel-layer', 'site-bdhc-layer', 'site-bdsa-layer', 'site-boha-layer'].forEach(l => {
                        if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', 'none');
                    });
                    if (map.getLayer('radar-layer')) map.setLayoutProperty('radar-layer', 'visibility', 'visible');
                }
                addLiveLog(`RADAR [Pane ${activePaneId}]: National mosaic selected`, '#00e5ff');
            } else {
                if (badge) { badge.textContent = site; badge.className = 'badge orange'; }

                if (radarActive) {
                    activeRadarNational = false;
                    const prod = paneRadarProducts[activePaneId] || 'sr_bref';
                    if (map.getLayer('radar-layer')) map.setLayoutProperty('radar-layer', 'visibility', 'none');
                    ['site-bref-layer', 'site-bvel-layer', 'site-bdhc-layer', 'site-bdsa-layer', 'site-boha-layer'].forEach(l => {
                        if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', 'none');
                    });
                    if (prod === 'sr_bref' && map.getLayer('site-bref-layer')) map.setLayoutProperty('site-bref-layer', 'visibility', 'visible');
                    else if (prod === 'sr_bvel' && map.getLayer('site-bvel-layer')) map.setLayoutProperty('site-bvel-layer', 'visibility', 'visible');
                    else if (prod === 'bdhc' && map.getLayer('site-bdhc-layer')) map.setLayoutProperty('site-bdhc-layer', 'visibility', 'visible');
                    else if (prod === 'bdsa' && map.getLayer('site-bdsa-layer')) map.setLayoutProperty('site-bdsa-layer', 'visibility', 'visible');
                    else if (prod === 'boha' && map.getLayer('site-boha-layer')) map.setLayoutProperty('site-boha-layer', 'visibility', 'visible');
                }
                addLiveLog(`RADAR [Pane ${activePaneId}]: Site changed to ${site}`, '#00e5ff');
            }
            updateSidebarToActivePane();
            refreshTimestampLabel();
            updateHealth('radar');
            updateRadarLegend();
        });
    }

    if (productSelect) {
        productSelect.addEventListener('change', () => {
            const product = productSelect.value;
            const map = maps[activePaneId];
            if (!map) return;
            const site = paneRadarSites[activePaneId] || 'DGX';
            if (site.includes('nexrad')) return;

            // Map product select values to NCEP product codes
            const productMap = {
                'N0Q': 'sr_bref',
                'N0V': 'sr_bvel',
                'N0Z': 'sr_bref',
                'NET': 'bdhc',
                'DSA': 'bdsa',
                'OHA': 'boha'
            };

            const ncepProduct = productMap[product] || 'sr_bref';
            paneRadarProducts[activePaneId] = ncepProduct;

            // Toggle the appropriate site-radar layer based on product selection on active map only
            ['site-bref-layer', 'site-bvel-layer', 'site-bdhc-layer', 'site-bdsa-layer', 'site-boha-layer'].forEach(l => {
                if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', 'none');
            });

            const prodSourceMap = {
                'sr_bref': ['site-bref', 'site-bref-layer'],
                'sr_bvel': ['site-bvel', 'site-bvel-layer'],
                'bdhc': ['site-bdhc', 'site-bdhc-layer'],
                'bdsa': ['site-bdsa', 'site-bdsa-layer'],
                'boha': ['site-boha', 'site-boha-layer']
            };
            const mapping = prodSourceMap[ncepProduct] || prodSourceMap['sr_bref'];
            if (map.getSource(mapping[0])) map.getSource(mapping[0]).setTiles([siteRadarUrl(site, ncepProduct)]);
            if (map.getLayer(mapping[1])) map.setLayoutProperty(mapping[1], 'visibility', 'visible');
            updateSidebarToActivePane();
            updateHealth('radar');
            addLiveLog(`RADAR [Pane ${activePaneId}]: Product changed to ${product}`, '#00e5ff');
            refreshTimestampLabel();
            updateRadarLegend();
        });
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 17: CONTEXT MENU
// ═══════════════════════════════════════════════════════════════════════════════

function initContextMenu() {
    const menu = document.getElementById('pane-context-menu');
    if (!menu) return;

    // Dismiss on click elsewhere
    document.addEventListener('click', () => {
        menu.style.display = 'none';
    });

    menu.querySelectorAll('.menu-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            const action = item.getAttribute('data-action');
            const paneId = menu.dataset.pane || activePaneId;
            const map = maps[paneId];
            menu.style.display = 'none';

            if (!map) return;

            switch (action) {
                case 'toggle-radar-domes': {
                    const isVisible = isLayerVisible(map, 'nexrad-sites-layer');
                    const newState = isVisible ? 'none' : 'visible';
                    Object.values(maps).forEach(m => {
                        if (m && m.getLayer('nexrad-sites-layer')) {
                            m.setLayoutProperty('nexrad-sites-layer', 'visibility', newState);
                        }
                    });
                    if (newState === 'visible') {
                        addLiveLog('📡 Tactical Radar Domes Enabled: Click any radar dome icon to jump directly to that site.', '#00ffff');
                    } else {
                        addLiveLog('📡 Tactical Radar Domes Hidden.', '#aaa');
                    }
                    break;
                }
                case 'toggle-sat':
                    toggleMapLayer(map, 'satellite-layer');
                    addLiveLog(`PANE ${paneId}: Satellite toggled`, '#00e5ff');
                    break;
                case 'toggle-metar': {
                    const metarLayers = ['metars-temp', 'metars-dewp', 'metars-press', 'metars-id', 'metars-city'];
                    const currentVis = safeGetVisibility(map, 'metars-temp');
                    const newVis = currentVis === 'visible' ? 'none' : 'visible';
                    metarLayers.forEach(l => { if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', newVis); });
                    if (newVis === 'visible') fetchMETARs();
                    addLiveLog(`PANE ${paneId}: METARs toggled`, '#00ff88');
                    break;
                }
                case 'toggle-counties':
                    toggleMapLayer(map, 'counties-layer');
                    addLiveLog(`PANE ${paneId}: Counties toggled`, '#888');
                    break;
                case 'toggle-warning-outline':
                    warningOutlineMode = !warningOutlineMode;
                    try { localStorage.setItem('fxnet_warn_outline', warningOutlineMode ? '1' : '0'); } catch (e) { }
                    applyWarningDisplayModeAll();
                    updateWarnModeLabel();
                    addLiveLog(`WARNINGS: ${warningOutlineMode ? 'Outline' : 'Filled'} display mode`, '#ffb300');
                    break;
                case 'toggle-cities':
                    toggleMapLayer(map, 'esri-labels-layer');
                    addLiveLog(`PANE ${paneId}: Cities toggled`, '#888');
                    break;
                case 'toggle-roads':
                    toggleMapLayer(map, 'esri-roads-layer');
                    addLiveLog(`PANE ${paneId}: Roads toggled`, '#888');
                    break;
                case 'toggle-sampler':
                    isDataSamplerActive = !isDataSamplerActive;
                    addLiveLog(`DATA SAMPLER: ${isDataSamplerActive ? 'ACTIVATED' : 'DEACTIVATED'}`, isDataSamplerActive ? '#00ffff' : '#ff8888');
                    const samplerBadge = document.getElementById('hud-sampler-readout');
                    if (samplerBadge) samplerBadge.style.display = isDataSamplerActive ? 'flex' : 'none';
                    break;
                case 'sync-all':
                    syncAllPanes(paneId);
                    break;
                case 'toggle-pin':
                    setPaneSync(paneId, !paneSyncDisabled.has(paneId));
                    break;
                case 'clear-pane':
                    clearPane(map, paneId);
                    break;
            }
        });
    });
}

function toggleMapLayer(map, layerId) {
    if (!map.getLayer(layerId)) return;
    const vis = map.getLayoutProperty(layerId, 'visibility');
    map.setLayoutProperty(layerId, 'visibility', vis === 'visible' ? 'none' : 'visible');
}

const NWS_REFLECTIVITY_SCALE = [
    { dbz: 75, label: '75+ dBZ (Extreme / Large Hail)', r: 255, g: 255, b: 255 },
    { dbz: 70, label: '70 dBZ (Destructive Hail / Core)', r: 153, g: 0, b: 255 },
    { dbz: 65, label: '65 dBZ (Severe Hail / Rain)', r: 255, g: 0, b: 255 },
    { dbz: 60, label: '60 dBZ (Intense Core / Rain)', r: 153, g: 0, b: 0 },
    { dbz: 55, label: '55 dBZ (Heavy Severe Rain)', r: 255, g: 0, b: 0 },
    { dbz: 50, label: '50 dBZ (Heavy Rain)', r: 255, g: 85, b: 0 },
    { dbz: 45, label: '45 dBZ (Moderate Rain)', r: 255, g: 170, b: 0 },
    { dbz: 40, label: '40 dBZ (Moderate Rain)', r: 255, g: 255, b: 0 },
    { dbz: 35, label: '35 dBZ (Light to Moderate)', r: 170, g: 255, b: 0 },
    { dbz: 30, label: '30 dBZ (Light Rain)', r: 0, g: 255, b: 0 },
    { dbz: 25, label: '25 dBZ (Light Rain)', r: 0, g: 180, b: 0 },
    { dbz: 20, label: '20 dBZ (Light Rain)', r: 0, g: 120, b: 0 },
    { dbz: 15, label: '15 dBZ (Very Light / Virga)', r: 0, g: 220, b: 220 },
    { dbz: 10, label: '10 dBZ (Very Light / Mist)', r: 0, g: 150, b: 255 },
    { dbz: 5, label: '5 dBZ (Mist / Noise)', r: 0, g: 50, b: 150 }
];

const NWS_VELOCITY_SCALE = [
    { kts: -80, label: '-80+ kts (Extreme Inbound)', r: 0, g: 255, b: 255 },
    { kts: -75, label: '-75 kts (Extreme Inbound)', r: 0, g: 235, b: 240 },
    { kts: -70, label: '-70 kts (Extreme Inbound)', r: 0, g: 215, b: 220 },
    { kts: -65, label: '-65 kts (Severe Inbound)', r: 0, g: 195, b: 200 },
    { kts: -60, label: '-60 kts (Severe Inbound)', r: 0, g: 175, b: 180 },
    { kts: -55, label: '-55 kts (Strong Inbound)', r: 0, g: 255, b: 150 },
    { kts: -50, label: '-50 kts (Strong Inbound)', r: 0, g: 255, b: 100 },
    { kts: -45, label: '-45 kts (Strong Inbound)', r: 0, g: 255, b: 50 },
    { kts: -40, label: '-40 kts (Inbound)', r: 0, g: 255, b: 0 },
    { kts: -35, label: '-35 kts (Inbound)', r: 0, g: 225, b: 0 },
    { kts: -30, label: '-30 kts (Inbound)', r: 0, g: 200, b: 0 },
    { kts: -25, label: '-25 kts (Inbound)', r: 0, g: 175, b: 0 },
    { kts: -20, label: '-20 kts (Inbound)', r: 0, g: 150, b: 0 },
    { kts: -15, label: '-15 kts (Inbound)', r: 0, g: 125, b: 0 },
    { kts: -10, label: '-10 kts (Light Inbound)', r: 0, g: 100, b: 0 },
    { kts: -5,  label: '-5 kts (Light Inbound)', r: 0, g: 75, b: 0 },
    { kts: 0,   label: '0 kts (Zero IsoDop)', r: 128, g: 128, b: 128 },
    { kts: 5,   label: '+5 kts (Light Outbound)', r: 75, g: 0, b: 0 },
    { kts: 10,  label: '+10 kts (Light Outbound)', r: 100, g: 0, b: 0 },
    { kts: 15,  label: '+15 kts (Outbound)', r: 125, g: 0, b: 0 },
    { kts: 20,  label: '+20 kts (Outbound)', r: 150, g: 0, b: 0 },
    { kts: 25,  label: '+25 kts (Outbound)', r: 175, g: 0, b: 0 },
    { kts: 30,  label: '+30 kts (Outbound)', r: 200, g: 0, b: 0 },
    { kts: 35,  label: '+35 kts (Outbound)', r: 225, g: 0, b: 0 },
    { kts: 40,  label: '+40 kts (Outbound)', r: 255, g: 0, b: 0 },
    { kts: 45,  label: '+45 kts (Strong Outbound)', r: 255, g: 50, b: 0 },
    { kts: 50,  label: '+50 kts (Strong Outbound)', r: 255, g: 100, b: 0 },
    { kts: 55,  label: '+55 kts (Strong Outbound)', r: 255, g: 150, b: 0 },
    { kts: 60,  label: '+60 kts (Severe Outbound)', r: 255, g: 180, b: 0 },
    { kts: 65,  label: '+65 kts (Severe Outbound)', r: 255, g: 0, b: 150 },
    { kts: 70,  label: '+70 kts (Extreme Outbound)', r: 255, g: 0, b: 200 },
    { kts: 75,  label: '+75+ kts (Extreme Outbound)', r: 255, g: 0, b: 255 }
];

// NWS Digital Precipitation Accumulation scale (OHA / DSA)
// Colors sampled from NCEP GeoServer WMS legend for kdgx_boha / kdgx_bdsa
const NWS_PRECIP_SCALE = [
    { inches: 15.0, label: '15.00+ in (Catastrophic)',       r: 248, g: 237, b: 237 },
    { inches: 12.0, label: '12.00 in (Extreme)',             r: 213, g: 126, b: 126 },
    { inches: 10.0, label: '10.00 in (Extreme)',             r: 185, g:   0, b:   0 },
    { inches:  8.0, label: '8.00 in (Life-Threatening)',     r: 206, g:   0, b:   0 },
    { inches:  7.0, label: '7.00 in (Major Flooding)',       r: 254, g:   0, b:   0 },
    { inches:  6.0, label: '6.00 in (Significant Flooding)', r: 255, g:  45, b:   0 },
    { inches:  5.0, label: '5.00 in (Heavy)',                r: 255, g:  93, b:   0 },
    { inches:  4.0, label: '4.00 in (Heavy)',                r: 255, g: 140, b:   0 },
    { inches:  3.5, label: '3.50 in (Moderate-Heavy)',       r: 255, g: 177, b:   0 },
    { inches:  3.0, label: '3.00 in (Moderate)',             r: 255, g: 214, b:   2 },
    { inches:  2.5, label: '2.50 in (Moderate)',             r: 255, g: 249, b:   2 },
    { inches:  2.0, label: '2.00 in (Moderate)',             r:   5, g:   0, b: 254 },
    { inches:  1.75,label: '1.75 in (Light-Moderate)',       r:  94, g:  25, b: 188 },
    { inches:  1.50,label: '1.50 in (Light-Moderate)',       r: 176, g:  40, b: 149 },
    { inches:  1.25,label: '1.25 in (Light-Moderate)',       r: 222, g:  16, b: 213 },
    { inches:  1.0, label: '1.00 in (Light)',                r: 244, g:   4, b: 243 },
    { inches:  0.75,label: '0.75 in (Light)',                r:  33, g: 144, b:  32 },
    { inches:  0.50,label: '0.50 in (Light)',                r:   3, g: 252, b:   3 },
    { inches:  0.25,label: '0.25 in (Very Light)',           r:   3, g: 213, b:  92 },
    { inches:  0.10,label: '0.10 in (Trace)',                r:   5, g: 247, b: 250 },
    { inches:  0.01,label: '< 0.10 in (Trace)',              r: 139, g: 139, b: 139 }
];

// ═══ MRMS ENHANCED ECHO TOPS SCALE (kft) ═══
// NCEP GeoServer conus_neet_v18 — 18 echo top height bins
const MRMS_ECHOTOPS_SCALE = [
    { kft: 70, r: 255, g: 255, b: 255 },
    { kft: 65, r: 255, g: 170, b: 255 },
    { kft: 60, r: 255, g:   0, b: 255 },
    { kft: 55, r: 200, g:   0, b: 200 },
    { kft: 50, r: 140, g:   0, b: 255 },
    { kft: 45, r: 255, g:   0, b:   0 },
    { kft: 40, r: 200, g:   0, b:   0 },
    { kft: 35, r: 140, g:   0, b:   0 },
    { kft: 30, r: 255, g: 140, b:   0 },
    { kft: 25, r: 255, g: 200, b:   0 },
    { kft: 20, r: 255, g: 255, b:   0 },
    { kft: 15, r:   0, g: 255, b:   0 },
    { kft: 10, r:   0, g: 180, b:   0 },
    { kft:  5, r:   0, g: 100, b:   0 }
];

// ═══ MRMS QPE SCALE (inches) ═══
// IEM mesonet MRMS radar+gauge QPE color ramp
const MRMS_QPE_SCALE = [
    { inches: 10.0,  r: 255, g: 255, b: 255 },
    { inches:  8.0,  r: 255, g: 170, b: 255 },
    { inches:  6.0,  r: 200, g:   0, b: 200 },
    { inches:  5.0,  r: 140, g:   0, b: 255 },
    { inches:  4.0,  r: 255, g:   0, b:   0 },
    { inches:  3.0,  r: 200, g:   0, b:   0 },
    { inches:  2.5,  r: 255, g:  85, b:   0 },
    { inches:  2.0,  r: 255, g: 170, b:   0 },
    { inches:  1.5,  r: 255, g: 255, b:   0 },
    { inches:  1.0,  r:   0, g: 255, b:   0 },
    { inches:  0.75, r:   0, g: 200, b:   0 },
    { inches:  0.50, r:   0, g: 140, b:   0 },
    { inches:  0.25, r:   0, g: 200, b: 255 },
    { inches:  0.10, r:   0, g: 140, b: 200 },
    { inches:  0.01, r: 100, g: 100, b: 100 }
];

function findClosestColorMatch(r, g, b, scale) {
    let minDist = Infinity;
    let bestMatch = scale[0];
    for (const item of scale) {
        const dist = Math.hypot(r - item.r, g - item.g, b - item.b);
        if (dist < minDist) {
            minDist = dist;
            bestMatch = item;
        }
    }
    return bestMatch;
}

function decodeRadarPixel(r, g, b, product) {
    if (r < 12 && g < 12 && b < 12) return 'No Data';

    // Reverse compositing blend to recover original tile color.
    // Radar layers use raster-opacity 0.9 over ~rgb(20,20,25) basemap.
    const opacity = 0.9;
    const bgR = 20, bgG = 20, bgB = 25;
    r = Math.round(Math.min(255, Math.max(0, (r - bgR * (1 - opacity)) / opacity)));
    g = Math.round(Math.min(255, Math.max(0, (g - bgG * (1 - opacity)) / opacity)));
    b = Math.round(Math.min(255, Math.max(0, (b - bgB * (1 - opacity)) / opacity)));

    // Precipitation accumulation products (inches)
    if (product === 'bdsa' || product === 'boha') {
        const match = findClosestColorMatch(r, g, b, NWS_PRECIP_SCALE);
        const productName = product === 'boha' ? '1hr' : 'Storm Total';
        return `${match.label} (${productName})`;
    }

    if (product === 'sr_bvel') {
        const maxVal = Math.max(r, g, b);
        const minVal = Math.min(r, g, b);
        const chroma = maxVal - minVal;

        // If chroma is very low and values are near mid-grey, it truly is zero isodop
        if (chroma < 20 && Math.abs(r - 128) < 45 && Math.abs(g - 128) < 45 && Math.abs(b - 128) < 45) {
            return '0 kts (Zero IsoDop)';
        }

        let candidates = NWS_VELOCITY_SCALE;
        if (g > r + 15 || b > r + 15) {
            // Unmistakably Inbound (Green/Cyan/Blue spectrum)
            candidates = NWS_VELOCITY_SCALE.filter(item => item.kts < 0);
        } else if (r > g + 15 && r > b + 10) {
            // Unmistakably Outbound (Red/Orange/Yellow spectrum)
            candidates = NWS_VELOCITY_SCALE.filter(item => item.kts > 0);
        }

        const match = findClosestColorMatch(r, g, b, candidates);
        return match.label;
    } else if (product === 'bdhc') {
        if (r > 200 && g < 50 && b > 200) return 'Hail / Heavy Ice';
        if (r > 200 && g === 0 && b === 0) return 'Heavy Rain';
        if (r > 200 && g > 200 && b === 0) return 'Moderate Rain';
        if (g > 200 && r === 0 && b === 0) return 'Light Rain / Snow';
        return 'Hydrometeor Return';
    } else {
        let candidates = NWS_REFLECTIVITY_SCALE;

        if (r > g + 40 && b > g + 40) {
            // Unmistakably Purple / Magenta core (65 - 75 dBZ)
            candidates = NWS_REFLECTIVITY_SCALE.filter(item => item.dbz >= 65);
        } else if (r > g + 30 && b < 100) {
            // Unmistakably Red / Orange heavy core (45 - 60 dBZ)
            candidates = NWS_REFLECTIVITY_SCALE.filter(item => item.dbz >= 45 && item.dbz <= 60);
        } else if (r > 100 && g > 100 && b < 100) {
            // Unmistakably Yellow / Yellow-Green moderate rain (35 - 40 dBZ)
            candidates = NWS_REFLECTIVITY_SCALE.filter(item => item.dbz >= 35 && item.dbz <= 40);
        } else if (g > r + 30 && g > b + 20) {
            // Unmistakably Green light rain (20 - 30 dBZ)
            candidates = NWS_REFLECTIVITY_SCALE.filter(item => item.dbz >= 20 && item.dbz <= 30);
        } else if (b > r + 30) {
            // Unmistakably Blue / Cyan mist/virga (5 - 15 dBZ)
            candidates = NWS_REFLECTIVITY_SCALE.filter(item => item.dbz <= 15);
        }

        const match = findClosestColorMatch(r, g, b, candidates);
        return match.label;
    }
}

function decodeMrmsPixel(r, g, b, product) {
    // Skip transparent / black / very dark pixels (no data)
    if (r < 12 && g < 12 && b < 12) return 'No Data';
    const maxC = Math.max(r, g, b);
    if (maxC < 20) return 'No Data';

    // Reverse the compositing blend to recover original tile color.
    // Displayed = tileColor * opacity + basemap * (1 - opacity)
    // tileColor = (displayed - basemap * (1 - opacity)) / opacity
    // Basemap is approximately rgb(20, 20, 25) and raster-opacity is 0.85.
    const opacity = 0.85;
    const bgR = 20, bgG = 20, bgB = 25;
    const origR = Math.round(Math.min(255, Math.max(0, (r - bgR * (1 - opacity)) / opacity)));
    const origG = Math.round(Math.min(255, Math.max(0, (g - bgG * (1 - opacity)) / opacity)));
    const origB = Math.round(Math.min(255, Math.max(0, (b - bgB * (1 - opacity)) / opacity)));

    if (product === 'echotops') {
        const match = findClosestColorMatch(origR, origG, origB, MRMS_ECHOTOPS_SCALE);
        return `${match.kft} kft`;
    }

    if (product === 'qpe') {
        const match = findClosestColorMatch(origR, origG, origB, MRMS_QPE_SCALE);
        if (match.inches < 0.1) return `< 0.10 in`;
        return `${match.inches.toFixed(2)} in`;
    }

    return 'Unknown';
}

// ═══════════════════════════════════════════════════════════════════════════════
// RADAR COLOR LEGEND
// ═══════════════════════════════════════════════════════════════════════════════

function createRadarLegend(paneId) {
    const paneEl = document.querySelector(`.pane[data-pane="${paneId}"]`);
    if (!paneEl || paneEl.querySelector('.radar-legend')) return;
    const legend = document.createElement('div');
    legend.className = 'radar-legend';
    legend.id = `radar-legend-${paneId}`;
    paneEl.appendChild(legend);
}

// ─── NEXRAD Level III (NODD) overlay ───
// Decoded + rendered server-side (/api/radar-l3) into a transparent, georeferenced
// PNG, dropped onto the pane's map as an image source. Per-pane; keeps the legacy
// IEM/OpenGeo radar fully intact (this is an independent overlay behind its own items).
async function loadL3Radar(paneId, station, product) {
    const map = maps[paneId];
    if (!map) return;
    addLiveLog(`L3 NODD: Loading ${station} ${product}...`, '#33c27a');
    try {
        // Cache-buster so every poll truly re-lists the NODD bucket and lands on
        // the newest volume scan (endpoint sets max-age=30; this defeats any stale
        // browser/edge copy on the 120s refresh).
        const res = await fetch(`/api/radar-l3?station=${station}&product=${product}&_=${Date.now()}`);
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'render failed');
        if (map.getSource('radar-l3')) {
            map.getSource('radar-l3').updateImage({ url: data.image, coordinates: data.coordinates });
        } else {
            map.addSource('radar-l3', { type: 'image', url: data.image, coordinates: data.coordinates });
            map.addLayer({ id: 'radar-l3-layer', type: 'raster', source: 'radar-l3',
                paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 0 } }, firstBoundaryLayer(map));
        }
        map.setLayoutProperty('radar-l3-layer', 'visibility', 'visible');
        paneL3[paneId] = { station, product, meta: data.meta };
        updateHealth('radarL3');
        if (paneId === activePaneId) { refreshTimestampLabel(); updateL3TiltControl(); }
        addLiveLog(`L3 NODD: ${station} ${data.meta.name} @ ${data.meta.time} (el ${data.meta.elevation}°)`, '#00ff88');
    } catch (e) {
        addLiveLog(`L3 NODD ERROR: ${e.message}`, '#ff3333');
    }
}

function clearL3Radar(paneId) {
    const map = maps[paneId];
    if (map && map.getLayer('radar-l3-layer')) map.setLayoutProperty('radar-l3-layer', 'visibility', 'none');
    delete paneL3[paneId];
    if (paneId === activePaneId) { refreshTimestampLabel(); updateL3TiltControl(); }
}

// ─── GIBS live satellite (newest available frame; tiles, browser-direct) ───
async function loadGibsLive(paneId, prodKey) {
    const map = maps[paneId];
    if (!map || !GIBS_PRODUCTS[prodKey]) return;
    const p = GIBS_PRODUCTS[prodKey];
    const prev = paneGibs[paneId];
    const bird = goesBirdFor(paneId);
    const prevBird = paneGibsBird[paneId];
    paneGibs[paneId] = prodKey;
    paneGibsBird[paneId] = bird;
    // Hybrid (iemCh) products take their LIVE frame from the bird's full disk
    // rather than a regional sector: it is the only IEM cache whose footprint
    // matches the full-disk GIBS layer it stands in for, so the live view is not
    // clipped to CONUS the moment you pan offshore.
    const liveSector = `${bird}-fulldisk`;
    // Paint instantly with the newest known frame (cached) or the 'default'
    // keyword, then heal below. NOTE: for slow-cadence visible bands (Red
    // Visible) the 'default' keyword AND the newest raw domain timestamps are
    // often BLANK; /api/gibs-times now drops every unpublished frame, so the
    // refresh below lands on a frame that actually has tiles.
    // Products with iemCh skip GIBS for the live view entirely — IEM's
    // per-channel cache is ~5-10 min behind the scan vs GIBS' ~45-60 min lag.
    const times = gibsTimesFor(prodKey, bird);
    paneGibsTime[paneId] = p.iemCh ? (iemGoesValid[iemValidKey(p.iemCh, liveSector)] || null)
                                   : (times.length ? times[times.length - 1] : null);
    const url = p.iemCh ? cacheBust(goesChannelUrl(p.iemCh, liveSector))
                        : gibsTileUrl(prodKey, times.length ? times[times.length - 1] : 'default', bird);
    // Recreate the source when switching products (maxzoom differs) or birds; else just retile
    if (map.getSource('gibs-sat') && prev === prodKey && prevBird === bird) {
        map.getSource('gibs-sat').setTiles([url]);
    } else {
        if (map.getLayer('gibs-sat-layer')) map.removeLayer('gibs-sat-layer');
        if (map.getSource('gibs-sat')) map.removeSource('gibs-sat');
        map.addSource('gibs-sat', { type: 'raster', tiles: [url], tileSize: 256, maxzoom: p.max });
        map.addLayer({ id: 'gibs-sat-layer', type: 'raster', source: 'gibs-sat',
            layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 0 } },
            firstBoundaryLayer(map));   // keep boundaries above the GIBS imagery
    }
    map.setLayoutProperty('gibs-sat-layer', 'visibility', 'visible');
    updateHealth('gibsSat');
    if (paneId === activePaneId) refreshTimestampLabel();
    addLiveLog(`GIBS: ${p.label} (${GOES_BIRDS[bird].label}) loaded`, '#00e5ff');
    // Always (re)warm the published-frame time list so looping is ready + current.
    // Hybrid (iemCh) products keep their fresher IEM live tiles — only pull the
    // exact IEM valid time for the legend; non-hybrid products heal the live view
    // onto the newest published GIBS frame.
    const stillMine = () => paneGibs[paneId] === prodKey && paneGibsBird[paneId] === bird;
    if (p.iemCh) {
        fetchGibsTimes(prodKey, bird);
        fetchIemGoesValid(p.iemCh, liveSector).then(v => {
            if (v && stillMine()) {
                paneGibsTime[paneId] = v;
                if (paneId === activePaneId) refreshTimestampLabel();
            }
        });
    } else {
        fetchGibsTimes(prodKey, bird).then(t => {
            if (t.length && stillMine() && map.getSource('gibs-sat')) {
                map.getSource('gibs-sat').setTiles([gibsTileUrl(prodKey, t[t.length - 1], bird)]);
                paneGibsTime[paneId] = t[t.length - 1];
                if (paneId === activePaneId) refreshTimestampLabel();
            }
        });
    }
}

function clearGibs(paneId) {
    const map = maps[paneId];
    if (map && map.getLayer('gibs-sat-layer')) map.setLayoutProperty('gibs-sat-layer', 'visibility', 'none');
    delete paneGibs[paneId];
    delete paneGibsTime[paneId];
    delete paneGibsBird[paneId];
    if (paneId === activePaneId) refreshTimestampLabel();
}

// WPC ERO category legend — matches the polygon colors emitted by /api/wpc-ero
// (KML-derived). Sits bottom-left so it doesn't collide with the radar legend.
const ERO_LEGEND_CATS = [
    { label: 'HIGH (≥70%)',     color: '#ee22ee' },
    { label: 'MODERATE (≥40%)', color: '#ee2c2c' },
    { label: 'SLIGHT (≥15%)',   color: '#ffff00' },
    { label: 'MARGINAL (≥5%)',  color: '#00ff00' }
];

function createEroLegend(paneId) {
    const paneEl = document.querySelector(`.pane[data-pane="${paneId}"]`);
    if (!paneEl || paneEl.querySelector('.ero-legend')) return;
    const legend = document.createElement('div');
    legend.className = 'ero-legend';
    legend.id = `ero-legend-${paneId}`;
    legend.style.cssText = 'position:absolute;bottom:32px;left:8px;z-index:12;background:rgba(0,0,0,0.82);border:1px solid rgba(57,255,90,0.3);border-radius:3px;padding:6px 8px;pointer-events:none;display:none;font-family:"Roboto Mono",monospace;';
    paneEl.appendChild(legend);
}

function updateEroLegend(paneId) {
    const pid = paneId || activePaneId;
    const legend = document.getElementById(`ero-legend-${pid}`);
    const m = maps[pid];
    if (!legend || !m) return;
    const days = ['1', '2', '3'].filter(d => isLayerVisible(m, `wpc-ero-day${d}-fill`));
    if (days.length === 0) { legend.style.display = 'none'; return; }
    let html = `<div style="font-size:8px;font-weight:700;color:#39ff5a;letter-spacing:0.8px;text-transform:uppercase;margin-bottom:4px;white-space:nowrap;">WPC ERO — DAY ${days.join(', ')}</div>`;
    ERO_LEGEND_CATS.forEach(c => {
        html += `<div style="display:flex;align-items:center;gap:5px;margin:2px 0;"><span style="width:12px;height:10px;background:${c.color};opacity:0.7;border:1px solid ${c.color};display:inline-block;"></span><span style="font-size:9px;color:#ddd;white-space:nowrap;">${c.label}</span></div>`;
    });
    legend.innerHTML = html;
    legend.style.display = 'block';
}

// Draw SPC-style significant-severe hatching into a canvas tile (seamless 45°).
// Mirrors SPC's Conditional Intensity Groups: 1 = dashed diagonal, 2 = solid
// diagonal, 3 = solid cross-hatch — increasing ink with intensity. Used for both
// the map fill-pattern and the legend swatch so they're pixel-identical.
function drawSpcHatch(ctx, size, intensity) {
    ctx.clearRect(0, 0, size, size);
    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.lineWidth = 1.0;
    ctx.setLineDash(intensity === 1 ? [2.2, 2.6] : []);
    ctx.beginPath(); ctx.moveTo(0, size); ctx.lineTo(size, 0); ctx.stroke();
    if (intensity === 3) { ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(size, size); ctx.stroke(); }
}

// data: URLs of the same patterns for the legend swatches (built once, lazily).
let HATCH_DATA_URLS = null;
function hatchDataUrl(intensity) {
    if (!HATCH_DATA_URLS) {
        HATCH_DATA_URLS = {};
        [1, 2, 3].forEach(n => {
            const sz = 10;
            const cv = document.createElement('canvas');
            cv.width = cv.height = sz;
            drawSpcHatch(cv.getContext('2d'), sz, n);
            HATCH_DATA_URLS[n] = cv.toDataURL();
        });
    }
    return HATCH_DATA_URLS[intensity];
}

// SPC probabilistic outlook legend — built from the actual probability swatches
// in the displayed data (so the colors always match), bottom-right like SPC's own.
function createProbLegend(paneId) {
    const paneEl = document.querySelector(`.pane[data-pane="${paneId}"]`);
    if (!paneEl || paneEl.querySelector('.prob-legend')) return;
    const legend = document.createElement('div');
    legend.className = 'prob-legend';
    legend.id = `prob-legend-${paneId}`;
    legend.style.cssText = 'position:absolute;bottom:32px;right:8px;z-index:12;background:rgba(0,0,0,0.82);border:1px solid rgba(255,154,60,0.35);border-radius:3px;padding:6px 8px;pointer-events:none;display:none;font-family:"Roboto Mono",monospace;';
    paneEl.appendChild(legend);
}

function updateProbLegend(paneId) {
    const pid = paneId || activePaneId;
    const legend = document.getElementById(`prob-legend-${pid}`);
    const m = maps[pid];
    if (!legend || !m) return;

    const visible = [];
    [1, 2].forEach(day => ['torn', 'wind', 'hail'].forEach(hz => {
        if (isLayerVisible(m, `spc-prob-${day}-${hz}-fill`)) visible.push({ day, hz });
    }));
    if (visible.length === 0) { legend.style.display = 'none'; return; }

    // Unique probability swatches (label -> fill) from the live data, low→high.
    const swatches = new Map();
    visible.forEach(({ day, hz }) => {
        const data = spcProbData[`${day}-${hz}`];
        const feats = (data && data.features) ? data.features : [];
        feats.forEach(f => {
            const L = f.properties?.LABEL, fill = f.properties?.fill;
            // Skip the significant feature (black stroke / non-numeric label)
            if (L && fill && !isNaN(parseFloat(L)) && f.properties?.stroke !== '#000000') {
                swatches.set(L, fill);
            }
        });
    });
    const sorted = [...swatches.entries()].sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]));

    const hazSet = [...new Set(visible.map(v => v.hz))];
    const daySet = [...new Set(visible.map(v => v.day))];
    const hazLabel = hazSet.length === 1 ? SPC_HAZARD_NAMES[hazSet[0]].toUpperCase() : 'SEVERE';
    const dayLabel = daySet.length === 1 ? `DAY ${daySet[0]}` : 'DAY 1–2';

    let html = `<div style="font-size:8px;font-weight:700;color:#ff9a3c;letter-spacing:0.8px;text-transform:uppercase;margin-bottom:4px;white-space:nowrap;">SPC ${dayLabel} ${hazLabel} PROB</div>`;
    sorted.forEach(([L, fill]) => {
        const pct = `${Math.round(parseFloat(L) * 100)}%`;
        html += `<div style="display:flex;align-items:center;gap:5px;margin:2px 0;"><span style="width:12px;height:10px;background:${fill};opacity:0.7;border:1px solid ${fill};display:inline-block;"></span><span style="font-size:9px;color:#ddd;">${pct}</span></div>`;
    });
    // Significant-severe Conditional Intensity Groups present in the visible data
    const cigLevels = new Set();
    visible.forEach(({ day, hz }) => {
        const data = spcProbData[`${day}-${hz}`];
        if (!isLayerVisible(m, `spc-sig-${day}-${hz}-line`) || !data || !data.features) return;
        data.features.forEach(f => {
            const mt = /^CIG([123])$/.exec(f.properties?.LABEL || '');
            if (mt) cigLevels.add(parseInt(mt[1]));
        });
    });
    if (cigLevels.size) {
        html += `<div style="border-top:1px solid rgba(255,255,255,0.15);margin-top:3px;padding-top:3px;"><div style="font-size:7.5px;color:#aaa;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px;">Sig Intensity</div>`;
        [1, 2, 3].filter(n => cigLevels.has(n)).forEach(n => {
            html += `<div style="display:flex;align-items:center;gap:5px;margin:2px 0;"><span style="width:14px;height:11px;display:inline-block;background-color:#fff;background-image:url(${hatchDataUrl(n)});background-repeat:repeat;border:1px solid #555;"></span><span style="font-size:9px;color:#ddd;white-space:nowrap;">Intensity ${n}</span></div>`;
        });
        html += `</div>`;
    }
    legend.innerHTML = html;
    legend.style.display = 'block';
}

// On-map key for the SPC fire weather outlook (categories are color-coded and
// not as widely-known as the convective MRGL/SLGT scale, so a swatch helps).
function createFireWxLegend(paneId) {
    const paneEl = document.querySelector(`.pane[data-pane="${paneId}"]`);
    if (!paneEl || paneEl.querySelector('.firewx-legend')) return;
    const legend = document.createElement('div');
    legend.className = 'firewx-legend';
    legend.id = `firewx-legend-${paneId}`;
    legend.style.cssText = 'position:absolute;bottom:32px;left:8px;z-index:12;background:rgba(0,0,0,0.82);border:1px solid rgba(255,127,0,0.4);border-radius:3px;padding:6px 8px;pointer-events:none;display:none;font-family:"Roboto Mono",monospace;';
    paneEl.appendChild(legend);
}

function updateFireWxLegend(paneId) {
    const pid = paneId || activePaneId;
    const legend = document.getElementById(`firewx-legend-${pid}`);
    const m = maps[pid];
    if (!legend || !m) return;

    const days = [1, 2, 3, 4, 5, 6, 7, 8].filter(d => isLayerVisible(m, `spc-firewx-day${d}-fill`));
    if (days.length === 0) { legend.style.display = 'none'; return; }

    // Unique categories present across the visible days, ordered low→high by rank.
    const items = new Map();   // label -> {fill, stroke, kind, rank}
    days.forEach(d => {
        const feats = spcFireWxData[d]?.features || [];
        feats.forEach(f => {
            const p = f.properties || {};
            if (p.label) items.set(p.label, { fill: p.fill, stroke: p.stroke, kind: p.kind, rank: p.rank || 0 });
        });
    });
    if (items.size === 0) { legend.style.display = 'none'; return; }
    const sorted = [...items.entries()].sort((a, b) => a[1].rank - b[1].rank);

    const dayLabel = days.length === 1 ? `DAY ${days[0]}` : `DAY ${days[0]}–${days[days.length - 1]}`;
    let html = `<div style="font-size:8px;font-weight:700;color:#ff9a3c;letter-spacing:0.8px;text-transform:uppercase;margin-bottom:4px;white-space:nowrap;">SPC ${dayLabel} FIRE WX</div>`;
    sorted.forEach(([label, s]) => {
        const swatch = s.kind === 'dryt'
            ? `<span style="width:12px;height:10px;display:inline-block;border:0;border-top:2px dashed ${s.stroke};"></span>`
            : `<span style="width:12px;height:10px;background:${s.fill};opacity:0.7;border:1px solid ${s.stroke};display:inline-block;"></span>`;
        html += `<div style="display:flex;align-items:center;gap:5px;margin:2px 0;">${swatch}<span style="font-size:9px;color:#ddd;white-space:nowrap;">${label}</span></div>`;
    });
    legend.innerHTML = html;
    legend.style.display = 'block';
}

function updateRadarLegend(paneId) {
    const legend = document.getElementById(`radar-legend-${paneId || activePaneId}`);
    if (!legend) return;

    const pid = paneId || activePaneId;
    const prod = paneRadarProducts[pid];

    // Determine which radar layers are visible
    const m = maps[pid];
    if (!m) { legend.classList.remove('visible'); return; }

    const siteRadarLayers = ['site-bref-layer', 'site-bvel-layer', 'site-bdhc-layer', 'site-bdsa-layer', 'site-boha-layer'];
    const mosaicLayer = 'nexrad-layer';
    const anyRadar = siteRadarLayers.some(l => {
        try { return m.getLayoutProperty(l, 'visibility') === 'visible'; } catch { return false; }
    });
    const mosaicVis = (() => { try { return m.getLayoutProperty(mosaicLayer, 'visibility') === 'visible'; } catch { return false; } })();

    // Check MRMS layers
    const mrmsEchotopsVis = isLayerVisible(m, 'mrms-echotops-layer');
    const mrmsQpeVis = isLayerVisible(m, 'mrms-qpe-layer');

    if (!anyRadar && !mosaicVis && !mrmsEchotopsVis && !mrmsQpeVis) {
        legend.classList.remove('visible');
        return;
    }

    // Build legend HTML — MRMS products take priority when visible (they overlay on top)
    let html = '';

    if (mrmsEchotopsVis) {
        html = buildBarLegend('MRMS ECHO TOPS (kft)', MRMS_ECHOTOPS_SCALE.map(s => ({
            color: `rgb(${s.r},${s.g},${s.b})`,
            label: `${s.kft}`
        })));
    } else if (mrmsQpeVis && paneMrmsQpe[pid]) {
        const qpeTitles = { '1h': 'MRMS 1-HR QPE (in)', '24h': 'MRMS 24-HR QPE (in)', '48h': 'MRMS 48-HR QPE (in)', '72h': 'MRMS 72-HR QPE (in)' };
        const title = qpeTitles[paneMrmsQpe[pid]] || 'MRMS QPE (in)';
        html = buildBarLegend(title, MRMS_QPE_SCALE.map(s => ({
            color: `rgb(${s.r},${s.g},${s.b})`,
            label: `${s.inches}`
        })));
    } else {
        // Determine active radar product type
        let activeProd = null;
        if (mosaicVis) activeProd = 'sr_bref'; // mosaic is always reflectivity
        else if (prod) activeProd = prod;
        else {
            // Detect from visible layer
            if (isLayerVisible(m, 'site-bref-layer')) activeProd = 'sr_bref';
            else if (isLayerVisible(m, 'site-bvel-layer')) activeProd = 'sr_bvel';
            else if (isLayerVisible(m, 'site-bdhc-layer')) activeProd = 'bdhc';
            else if (isLayerVisible(m, 'site-bdsa-layer')) activeProd = 'bdsa';
            else if (isLayerVisible(m, 'site-boha-layer')) activeProd = 'boha';
        }

        if (!activeProd) { legend.classList.remove('visible'); return; }

        if (activeProd === 'sr_bref') {
            html = buildBarLegend('BASE REFLECTIVITY (dBZ)', NWS_REFLECTIVITY_SCALE.map(s => ({
                color: `rgb(${s.r},${s.g},${s.b})`,
                label: `${s.dbz}`
            })));
        } else if (activeProd === 'sr_bvel') {
            // Velocity: show a condensed version — outbound top, inbound bottom
            const condensed = [
                { kts: 75, r: 255, g: 0, b: 255 },
                { kts: 60, r: 255, g: 180, b: 0 },
                { kts: 50, r: 255, g: 100, b: 0 },
                { kts: 40, r: 255, g: 0, b: 0 },
                { kts: 30, r: 200, g: 0, b: 0 },
                { kts: 20, r: 150, g: 0, b: 0 },
                { kts: 10, r: 100, g: 0, b: 0 },
                { kts: 0,  r: 128, g: 128, b: 128 },
                { kts: -10, r: 0, g: 100, b: 0 },
                { kts: -20, r: 0, g: 150, b: 0 },
                { kts: -30, r: 0, g: 200, b: 0 },
                { kts: -40, r: 0, g: 255, b: 0 },
                { kts: -50, r: 0, g: 255, b: 100 },
                { kts: -60, r: 0, g: 175, b: 180 },
                { kts: -75, r: 0, g: 235, b: 240 }
            ];
            html = buildBarLegend('BASE VELOCITY (kts)', condensed.map(s => ({
                color: `rgb(${s.r},${s.g},${s.b})`,
                label: s.kts === 0 ? '0' : (s.kts > 0 ? `+${s.kts} OUT` : `${s.kts} IN`)
            })));
        } else if (activeProd === 'bdhc') {
            html = buildCategoryLegend('HYDROMETEOR CLASS', [
                { color: 'rgb(255, 0, 255)', label: 'Hail / Heavy Ice' },
                { color: 'rgb(255, 0, 0)',   label: 'Heavy Rain' },
                { color: 'rgb(255, 255, 0)', label: 'Moderate Rain' },
                { color: 'rgb(0, 255, 0)',   label: 'Light Rain' },
                { color: 'rgb(0, 150, 255)', label: 'Dry Snow' },
                { color: 'rgb(0, 255, 255)', label: 'Wet Snow' },
                { color: 'rgb(180, 180, 180)', label: 'No Echo / Clutter' }
            ]);
        } else if (activeProd === 'bdsa' || activeProd === 'boha') {
            const title = activeProd === 'bdsa' ? 'STORM TOTAL PRECIP (in)' : 'ONE-HOUR PRECIP (in)';
            html = buildBarLegend(title, NWS_PRECIP_SCALE.map(s => ({
                color: `rgb(${s.r},${s.g},${s.b})`,
                label: `${s.inches}`
            })));
        }
    }

    legend.innerHTML = html;
    legend.classList.add('visible');
}

function buildBarLegend(title, items) {
    // items: [{ color, label }] — ordered top-to-bottom (high to low)
    const swatches = items.map(i => `<div class="swatch" style="background:${i.color}"></div>`).join('');
    // Show every other label to keep it compact, always first and last
    const labels = items.map((item, idx) => {
        const show = idx === 0 || idx === items.length - 1 || idx % 2 === 0;
        return `<span>${show ? item.label : ''}</span>`;
    }).join('');
    return `<div class="radar-legend-title">${title}</div>
        <div class="radar-legend-body">
            <div class="radar-legend-bar">${swatches}</div>
            <div class="radar-legend-labels">${labels}</div>
        </div>`;
}

function buildCategoryLegend(title, items) {
    const rows = items.map(i =>
        `<div class="legend-row"><div class="legend-swatch" style="background:${i.color}"></div><span class="legend-label">${i.label}</span></div>`
    ).join('');
    return `<div class="radar-legend-title">${title}</div><div class="radar-legend-rows">${rows}</div>`;
}

function safeGetVisibility(map, layerId) {
    try {
        return map.getLayoutProperty(layerId, 'visibility') || 'none';
    } catch {
        return 'none';
    }
}

function syncAllPanes(sourcePaneId) {
    const sourceMap = maps[sourcePaneId];
    if (!sourceMap) return;
    const center = sourceMap.getCenter();
    const zoom = sourceMap.getZoom();
    const bearing = sourceMap.getBearing();
    const pitch = sourceMap.getPitch();

    const myTab = tabOfPane(sourcePaneId);
    Object.entries(maps).forEach(([id, m]) => {
        // Skip pinned panes — they're intentionally on an independent view.
        if (id !== sourcePaneId && tabOfPane(id) === myTab && !paneSyncDisabled.has(id)) {
            m.jumpTo({ center, zoom, bearing, pitch });
        }
    });
    addLiveLog(`SYNC: Tab panes synced to Pane ${sourcePaneId}`, '#00e5ff');
}

// Pin / unpin a pane from the tab's pan-zoom sync. Pinned = independent view
// (e.g. hold a pane on a GOM hurricane while the radar panes track an inland
// site). Updates the on-pane badge + amber border so it's obvious at a glance.
function setPaneSync(paneId, pinned) {
    const paneEl = document.querySelector(`.pane[data-pane="${paneId}"]`);
    const badge = document.getElementById(`pin-badge-${paneId}`);
    if (pinned) {
        paneSyncDisabled.add(paneId);
        if (paneEl) paneEl.classList.add('pane-unsynced');
        if (badge) badge.style.display = 'block';
        addLiveLog(`PANE ${paneId}: PINNED — independent view (won't pan-sync)`, '#ffb300');
    } else {
        paneSyncDisabled.delete(paneId);
        if (paneEl) paneEl.classList.remove('pane-unsynced');
        if (badge) badge.style.display = 'none';
        // Rejoin the group: snap to a synced sibling's current view, if any.
        const myTab = tabOfPane(paneId);
        const sibling = Object.entries(maps).find(([id]) =>
            id !== paneId && tabOfPane(id) === myTab && !paneSyncDisabled.has(id));
        if (sibling && maps[paneId]) {
            const s = sibling[1];
            isSyncingMaps = true;
            maps[paneId].jumpTo({ center: s.getCenter(), zoom: s.getZoom(), bearing: s.getBearing(), pitch: s.getPitch() });
            isSyncingMaps = false;
        }
        addLiveLog(`PANE ${paneId}: UNPINNED — rejoined pan-sync`, '#00e5ff');
    }
}

function clearPane(map, paneId) {
    const allToggleLayers = [
        'satellite-layer', 'gibs-sat-layer', 'lightning-layer', 'radar-layer',
        'site-bref-layer', 'site-bvel-layer', 'site-bdhc-layer', 'site-bdsa-layer', 'site-boha-layer',
        'radar-l3-layer',
        'spc-outlook-fill', 'spc-outlook-line',
        'spc-day1-fill', 'spc-day1-line', 'spc-day2-fill', 'spc-day2-line', 'spc-day3-fill', 'spc-day3-line',
        'spc-prob-1-torn-fill', 'spc-prob-1-torn-line', 'spc-prob-1-wind-fill', 'spc-prob-1-wind-line', 'spc-prob-1-hail-fill', 'spc-prob-1-hail-line',
        'spc-prob-2-torn-fill', 'spc-prob-2-torn-line', 'spc-prob-2-wind-fill', 'spc-prob-2-wind-line', 'spc-prob-2-hail-fill', 'spc-prob-2-hail-line',
        'spc-sig-1-torn-i1', 'spc-sig-1-torn-i2', 'spc-sig-1-torn-i3', 'spc-sig-1-torn-line',
        'spc-sig-1-wind-i1', 'spc-sig-1-wind-i2', 'spc-sig-1-wind-i3', 'spc-sig-1-wind-line',
        'spc-sig-1-hail-i1', 'spc-sig-1-hail-i2', 'spc-sig-1-hail-i3', 'spc-sig-1-hail-line',
        'spc-sig-2-torn-i1', 'spc-sig-2-torn-i2', 'spc-sig-2-torn-i3', 'spc-sig-2-torn-line',
        'spc-sig-2-wind-i1', 'spc-sig-2-wind-i2', 'spc-sig-2-wind-i3', 'spc-sig-2-wind-line',
        'spc-sig-2-hail-i1', 'spc-sig-2-hail-i2', 'spc-sig-2-hail-i3', 'spc-sig-2-hail-line',
        'wpc-ero-day1-fill', 'wpc-ero-day1-line', 'wpc-ero-day2-fill', 'wpc-ero-day2-line', 'wpc-ero-day3-fill', 'wpc-ero-day3-line',
        'spc-firewx-day1-fill', 'spc-firewx-day1-line', 'spc-firewx-day1-dryt',
        'spc-firewx-day2-fill', 'spc-firewx-day2-line', 'spc-firewx-day2-dryt',
        'spc-firewx-day3-fill', 'spc-firewx-day3-line', 'spc-firewx-day3-dryt',
        'spc-firewx-day4-fill', 'spc-firewx-day4-line', 'spc-firewx-day4-dryt',
        'spc-firewx-day5-fill', 'spc-firewx-day5-line', 'spc-firewx-day5-dryt',
        'spc-firewx-day6-fill', 'spc-firewx-day6-line', 'spc-firewx-day6-dryt',
        'spc-firewx-day7-fill', 'spc-firewx-day7-line', 'spc-firewx-day7-dryt',
        'spc-firewx-day8-fill', 'spc-firewx-day8-line', 'spc-firewx-day8-dryt',
        'spc-md-fill', 'spc-md-outline', 'wpc-mpd-fill', 'wpc-mpd-outline', 'spc-lsr-icons', 'spc-lsr-mag',
        'nws-warnings-only-fill', 'nws-warnings-only-outline', 'nws-warnings-only-casing',
        'nws-advis-fill', 'nws-advis-outline', 'nws-advis-casing',
        'nws-enhanced-fill', 'nws-enhanced-outline', 'nws-enhanced-glow', 'nws-enhanced-label',
        'nws-watches-only-fill', 'nws-watches-only-outline',
        'nws-wwa-wms-layer', 'nws-watches-wms-layer',
        'hms-smoke-fill', 'hms-smoke-outline',
        'airnow-aqi-layer', 'firms-fires-layer',
        'metars-temp', 'metars-dewp', 'metars-press', 'metars-id', 'metars-city', 'metars-barb',
        'wpc-isobars-line', 'wpc-isobars-label',
        'sfc-isobars-2mb-line', 'sfc-isobars-2mb-label',
        'sfc-isotherms-line', 'sfc-isotherms-label',
        'sfc-isodrosotherms-line', 'sfc-isodrosotherms-label',
        'sfc-relh-line', 'sfc-relh-label',
        'sfc-isotachs-line', 'sfc-isotachs-label',
        'sfc-apparent-line', 'sfc-apparent-label',
        'wpc-fronts-solid', 'wpc-fronts-stnry', 'wpc-fronts-trof', 'wpc-fronts-pips',
        'wpc-hl-letter', 'wpc-hl-pressure',
        'wpc-qpf-layer',
        'mrms-echotops-layer', 'mrms-qpe-layer',
        'river-gauges-layer', 'river-gauges-glow', 'river-gauges-label',
        'solar-night-fill', 'solar-twilight-fill', 'solar-terminator-line',
        'nhc-cone-fill', 'nhc-cone-outline', 'nhc-track-line', 'nhc-track-pts', 'nhc-track-labels',
        'nhc-warn-fill', 'nhc-warn-outline', 'nhc-outlook-fill', 'nhc-outlook-outline',
        'nhc-fcst-actual-line', 'nhc-fcst-lines', 'nhc-fcst-actual-pts', 'nhc-fcst-labels',
        'cpc-temp-layer', 'cpc-precip-layer',
        'drought-fill', 'drought-outline', 'cpc-drought-layer',
        'probsevere-fill', 'probsevere-outline', 'probsevere-label',
        'airsigmet-fill', 'airsigmet-outline', 'airsigmet-label', 'pireps-layer',
        'gairmet-fill', 'gairmet-outline', 'gairmet-label', 'taf-layer', 'taf-label',
        'cwa-fill', 'cwa-outline', 'cwa-label', 'ndbc-layer', 'ndbc-label',
        'spc-d48-fill', 'spc-d48-line', 'spc-d48-label',
        'ndfd-temp-layer',
        'storm-attr-track', 'storm-attr-fpos', 'storm-attr-cell', 'storm-attr-label',
        'natt-vector', 'natt-cell', 'natt-tvs', 'natt-label',
        'meso-circ', 'meso-tvs', 'meso-label',
        'nws-cwa-layer', 'nws-cwa-label-layer',
        'recon-hdob-line', 'recon-hdob-pts', 'recon-hdob-labels',
        'adeck-lines', 'adeck-pts', 'adeck-labels'
    ];
    allToggleLayers.forEach(l => {
        if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', 'none');
    });
    paneGoesChannels[paneId] = null;
    if (paneId === activePaneId) activeGoesChannel = null;
    delete paneQpf[paneId];
    delete paneMrmsQpe[paneId];
    delete paneCpcTemp[paneId];
    delete paneCpcPrecip[paneId];
    delete paneL3[paneId];
    delete paneGibs[paneId];
    delete paneGibsBird[paneId];
    updateRadarLegend(paneId);
    updateEroLegend(paneId);
    updateProbLegend(paneId);
    updateFireWxLegend(paneId);
    addLiveLog(`PANE ${paneId}: Cleared`, '#ff3333');
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 18: LAYOUT CONTROLS
// ═══════════════════════════════════════════════════════════════════════════════

function syncLayoutButtons(layout) {
    document.querySelectorAll('.btn-view').forEach(b =>
        b.classList.toggle('active', parseInt(b.getAttribute('data-layout')) === layout));
}

// Reveal `layout` panes within a tab's grid, lazily creating their maps. When
// `sync` is true (layout-button click) the newly revealed panes inherit the
// active pane's radar site/product, matching the original single-grid behavior.
// On a tab switch we pass sync=false so each tab keeps its own per-pane setup.
function applyLayout(tabId, layout, sync) {
    const tab = tabs[tabId];
    if (!tab) return;
    tab.layout = layout;
    const grid = document.getElementById(`pane-grid-${tabId}`);
    if (grid) grid.className = `pane-grid layout-${layout}`;
    if (tabId === activeTabId) syncLayoutButtons(layout);

    const primarySite = paneRadarSites[activePaneId] || 'DGX';
    const primaryProduct = paneRadarProducts[activePaneId] || 'sr_bref';

    (grid ? grid.querySelectorAll('.pane') : []).forEach((p, idx) => {
        const id = p.getAttribute('data-pane');
        if (idx < layout) {
            p.style.display = 'block';
            if (sync && id !== activePaneId) {
                paneRadarSites[id] = primarySite;
                paneRadarProducts[id] = primaryProduct;
                const m = maps[id];
                if (m && m.getSource('site-bref')) {
                    m.getSource('site-bref').setTiles([siteRadarUrl(primarySite, 'sr_bref')]);
                    m.getSource('site-bvel').setTiles([siteRadarUrl(primarySite, 'sr_bvel')]);
                    m.getSource('site-bdhc').setTiles([siteRadarUrl(primarySite, 'bdhc')]);
                }
            }
            if (!maps[id]) initMap(id);
            else setTimeout(() => maps[id].resize(), 50);
        } else {
            p.style.display = 'none';
        }
    });

    setTimeout(() => paneIdsForTab(tabId).forEach(id => maps[id] && maps[id].resize()), 300);
    saveTabs();
}

function initLayoutControls() {
    document.querySelectorAll('.btn-view').forEach(btn => {
        btn.addEventListener('click', () => {
            const layout = parseInt(btn.getAttribute('data-layout'));
            applyLayout(activeTabId, layout, true);
            addLiveLog(`LAYOUT: ${layout}-pane view active`, '#888');
        });
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 18b: WORKSPACE TABS
// ═══════════════════════════════════════════════════════════════════════════════

const TABS_STORAGE_KEY = 'fxnet_tabs_v1';
// Per-pane product setup waiting to be re-applied once that pane's map loads
// (used to restore live layers after a page reload). Keyed by pane id.
const pendingRestore = {};

// Build a tab's pane grid in the DOM (8 panes, namespaced ids `<tabId>-<n>`).
function buildTabGrid(tabId, layout) {
    const container = document.getElementById('tab-grids');
    if (!container || document.getElementById(`pane-grid-${tabId}`)) return;
    const grid = document.createElement('div');
    grid.className = `pane-grid layout-${layout || 1}`;
    grid.id = `pane-grid-${tabId}`;
    grid.dataset.tab = tabId;
    for (let i = 1; i <= TAB_PANE_COUNT; i++) {
        const pid = `${tabId}-${i}`;
        const pane = document.createElement('div');
        pane.className = 'pane' + (i === 1 ? ' active-pane' : '');
        pane.dataset.pane = pid;
        pane.innerHTML =
            `<div class="pane-label">PANE ${i}</div>` +
            `<div class="pane-pin-badge" id="pin-badge-${pid}" style="display:none;">⊘ UNSYNCED</div>` +
            `<div class="radar-timestamp" id="radar-ts-${pid}">LIVE</div>` +
            `<div id="map-${pid}" class="map-container"></div>`;
        grid.appendChild(pane);
    }
    container.appendChild(grid);
}

function renderTabBar() {
    const bar = document.getElementById('tab-bar');
    const add = document.getElementById('tab-add');
    if (!bar || !add) return;
    bar.querySelectorAll('.tab-btn').forEach(b => b.remove());
    const multi = Object.keys(tabs).length > 1;
    Object.values(tabs).forEach(t => {
        const btn = document.createElement('div');
        btn.className = 'tab-btn' + (t.id === activeTabId ? ' active' : '');
        btn.dataset.tab = t.id;
        btn.title = 'Double-click to rename';
        btn.innerHTML = `<span class="tab-name"></span>` +
            (multi ? ` <span class="tab-close" data-close="${t.id}" title="Close tab">×</span>` : '');
        btn.querySelector('.tab-name').textContent = t.name;   // textContent = XSS-safe
        bar.insertBefore(btn, add);
    });
}

function switchTab(tabId) {
    if (!tabs[tabId]) return;
    // A running/paused loop belongs to the tab it was started on — end it
    // cleanly (removes anim frames + restores that tab's live layers) rather
    // than leaving the old tab frozen on a loop frame.
    if ((isPlaying || isPaused) && tabId !== activeTabId) stopAnimation();
    activeTabId = tabId;
    // Show only this tab's grid (revert inline display to the stylesheet's grid)
    document.querySelectorAll('#tab-grids .pane-grid').forEach(g => {
        g.style.display = (g.dataset.tab === tabId) ? '' : 'none';
    });
    // Default the active pane to this tab's first pane
    activePaneId = `${tabId}-1`;
    activeGoesChannel = paneGoesChannels[activePaneId] || null;
    document.querySelectorAll('.pane').forEach(p => p.classList.remove('active-pane'));
    const firstPane = document.querySelector(`.pane[data-pane="${activePaneId}"]`);
    if (firstPane) firstPane.classList.add('active-pane');
    // Reveal the tab's layout (no radar sync) + ensure its maps exist + resize
    applyLayout(tabId, tabs[tabId].layout, false);
    renderTabBar();
    if (typeof updateSidebarToActivePane === 'function') updateSidebarToActivePane();
    if (typeof refreshTimestampLabel === 'function') refreshTimestampLabel();
    saveTabs();
}

function createTab(opts) {
    tabSeq++;
    const id = `t${tabSeq}`;
    tabs[id] = { id, name: (opts && opts.name) || `Tab ${Object.keys(tabs).length + 1}`, layout: 1 };
    buildTabGrid(id, 1);
    switchTab(id);   // inits this tab's pane-1 map via applyLayout
    addLiveLog(`TAB: New workspace "${esc(tabs[id].name)}"`, '#00e5ff');
    return id;
}

function closeTab(tabId) {
    if (!tabs[tabId] || Object.keys(tabs).length <= 1) return;   // never close the last tab
    paneIdsForTab(tabId).forEach(pid => {
        if (maps[pid]) { try { maps[pid].remove(); } catch (_) {} delete maps[pid]; }
        delete cursorMarkers[pid];
        delete paneRadarSites[pid];
        delete paneRadarProducts[pid];
        delete paneGoesChannels[pid];
        delete paneGoesSector[pid];
        delete paneGibs[pid];
        delete paneGibsBird[pid];
        delete paneL3[pid];
        delete pendingRestore[pid];
        paneSyncDisabled.delete(pid);
    });
    document.getElementById(`pane-grid-${tabId}`)?.remove();
    delete tabs[tabId];
    if (activeTabId === tabId) switchTab(Object.keys(tabs)[0]);
    else renderTabBar();
    saveTabs();
    addLiveLog('TAB: Workspace closed', '#888');
}

function startTabRename(tabId) {
    const t = tabs[tabId];
    if (!t) return;
    const nameEl = document.querySelector(`.tab-btn[data-tab="${tabId}"] .tab-name`);
    if (!nameEl) return;
    const input = document.createElement('input');
    input.className = 'tab-rename-input';
    input.value = t.name;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const commit = () => {
        if (done) return;
        done = true;
        t.name = input.value.trim() || t.name;
        renderTabBar();
        saveTabs();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        else if (ev.key === 'Escape') { input.value = t.name; commit(); }
    });
}

// Re-apply a pane's saved product setup once its map has loaded (called from
// initMap's load handler). Self-contained loaders (GIBS, L3) and the site-radar
// layers are restored directly; the per-pane radar site/product state is already
// set from loadTabs() so the sidebar reflects it.
function applyPaneRestore(paneId) {
    const conf = pendingRestore[paneId];
    if (!conf) return;
    const map = maps[paneId];
    if (!map) return;
    // Put the pane back where it was (center/zoom persist per pane)
    if (Array.isArray(conf.view) && conf.view.length === 3) {
        try { map.jumpTo({ center: [conf.view[0], conf.view[1]], zoom: conf.view[2] }); } catch (_) {}
    }
    // Restore the sector before any imagery — it decides both the IEM tile
    // sector and which bird the GIBS product loads.
    if (GOES_SECTORS[conf.goesSector]) paneGoesSector[paneId] = conf.goesSector;
    try {
        if (conf.gibs) {
            loadGibsLive(paneId, conf.gibs);
        } else if (conf.l3 && conf.l3.station && conf.l3.product) {
            loadL3Radar(paneId, conf.l3.station, conf.l3.product);
        } else if (conf.radarVisible && conf.radarProduct) {
            // NEXRAD site radar: show the product's layer + (re)point its tiles
            const layerByProduct = {
                sr_bref: 'site-bref-layer', sr_bvel: 'site-bvel-layer',
                bdhc: 'site-bdhc-layer', bdsa: 'site-bdsa-layer', boha: 'site-boha-layer'
            };
            const lyr = layerByProduct[conf.radarProduct];
            const site = conf.radarSite || 'DGX';
            if (lyr && map.getLayer(lyr)) {
                const srcId = lyr.replace('-layer', '');
                if (map.getSource(srcId)) map.getSource(srcId).setTiles([siteRadarUrl(site, conf.radarProduct)]);
                map.setLayoutProperty(lyr, 'visibility', 'visible');
            }
        } else if (conf.satVisible && conf.goesChannel != null) {
            // IEM single-channel GOES: repoint the satellite source + show it
            if (map.getSource('satellite')) map.getSource('satellite').setTiles([goesChannelUrl(conf.goesChannel, goesSectorFor(paneId))]);
            if (map.getLayer('satellite-layer')) map.setLayoutProperty('satellite-layer', 'visibility', 'visible');
            if (paneId === activePaneId) activeGoesChannel = conf.goesChannel;
        }
    } catch (_) {}
    // Overlay products are re-applied by re-clicking their sidebar items (queue
    // below). The pending conf is kept until that finishes so an early save
    // can't overwrite the snapshot with the half-restored state.
    if (conf.overlays && conf.overlays.length) queueOverlayRestore(paneId, conf.overlays);
    else delete pendingRestore[paneId];
    if (paneId === activePaneId && typeof updateSidebarToActivePane === 'function') {
        updateSidebarToActivePane();
    }
}

// ── Overlay snapshot & restore ───────────────────────────────────────────────
// Overlay products (warnings, outlooks, obs, aviation…) are restored by
// re-clicking their sidebar items so every existing fetch/visibility path is
// reused verbatim (same mechanism as Procedures). Clicks act on the active
// pane, so panes are processed one at a time with activePaneId temporarily
// pointed at the pane being restored.
const _overlayRestoreQueue = [];
let _overlayRestoreBusy = false;

function queueOverlayRestore(paneId, recs) {
    _overlayRestoreQueue.push({ paneId, recs });
    if (!_overlayRestoreBusy) _drainOverlayRestoreQueue();
}

async function _drainOverlayRestoreQueue() {
    _overlayRestoreBusy = true;
    // let setupMapLayers/legends settle after the map 'load' event
    await new Promise(r => setTimeout(r, 500));
    while (_overlayRestoreQueue.length) {
        const { paneId, recs } = _overlayRestoreQueue.shift();
        if (!maps[paneId]) { delete pendingRestore[paneId]; continue; }
        const prevActive = activePaneId;
        let n = 0;
        try {
            activePaneId = paneId;
            updateSidebarToActivePane();   // sync .active classes to THIS pane before clicking
            for (const rec of recs) {
                const item = document.querySelector(_procItemSelector(rec));
                if (item && !item.classList.contains('active')) {
                    item.click();
                    n++;
                    await new Promise(r => setTimeout(r, 150));
                }
            }
        } catch (_) {}
        delete pendingRestore[paneId];
        // hand the active pane back unless the user switched panes mid-restore
        if (activePaneId === paneId) activePaneId = prevActive;
        updateSidebarToActivePane();
        if (n) addLiveLog(`RESTORE: ${n} overlay${n === 1 ? '' : 's'} re-applied on pane ${paneId}`, '#00e5ff');
    }
    _overlayRestoreBusy = false;
}

// Snapshot which overlay products are showing on a pane, as procedure-style
// records ({layer, day, hazard, …}) that restore by re-clicking the item.
// Imagery that applyPaneRestore rebuilds directly (site radar, GOES, GIBS, L3)
// is excluded; 'radar-ref' is kept only for the national mosaic case.
const _OVERLAY_SNAPSHOT_SKIP = new Set(['radar-vel', 'radar-hc', 'radar-stp', 'radar-oha', 'goes-ch', 'gibs-sat', 'radar-l3']);

function capturePaneOverlays(pid) {
    const m = maps[pid];
    if (!m) return [];
    const recs = [];
    document.querySelectorAll('.product-item').forEach(item => {
        const layer = item.getAttribute('data-layer');
        if (!layer || _OVERLAY_SNAPSHOT_SKIP.has(layer)) return;
        if (layer === 'radar-ref' && !isLayerVisible(m, 'radar-layer')) return;
        if (!productItemActiveOn(pid, item)) return;
        const rec = { layer };
        PROC_ATTRS.forEach(k => { const v = item.getAttribute('data-' + k); if (v != null) rec[k] = v; });
        recs.push(rec);
    });
    return recs;
}

function saveTabs() {
    try {
        const data = {
            activeTabId,
            tabSeq,
            tabs: Object.values(tabs).map(t => ({
                id: t.id,
                name: t.name,
                layout: t.layout,
                panes: paneIdsForTab(t.id).reduce((acc, pid) => {
                    // Pane not restored yet (map still loading, or it lives in a
                    // tab that hasn't been visited this session) — carry the
                    // saved setup forward instead of overwriting it with the
                    // empty live state.
                    if (pendingRestore[pid]) { acc[pid] = pendingRestore[pid]; return acc; }
                    const conf = {};
                    const m = maps[pid];
                    if (paneRadarSites[pid]) conf.radarSite = paneRadarSites[pid];
                    if (paneRadarProducts[pid]) conf.radarProduct = paneRadarProducts[pid];
                    if (paneGoesChannels[pid] != null) conf.goesChannel = paneGoesChannels[pid];
                    if (paneGoesSector[pid]) conf.goesSector = paneGoesSector[pid];
                    if (paneGibs[pid]) conf.gibs = paneGibs[pid];
                    if (paneL3[pid]) conf.l3 = paneL3[pid];
                    // Record whether the imagery layers are actually showing, so
                    // we only auto-restore what was visible (not merely selected),
                    // plus the pane's view and its active overlay products.
                    if (m) {
                        conf.radarVisible = ['site-bref-layer', 'site-bvel-layer', 'site-bdhc-layer',
                            'site-bdsa-layer', 'site-boha-layer'].some(l => isLayerVisible(m, l));
                        conf.satVisible = isLayerVisible(m, 'satellite-layer') && paneGoesChannels[pid] != null;
                        try {
                            const c = m.getCenter();
                            conf.view = [+c.lng.toFixed(4), +c.lat.toFixed(4), +m.getZoom().toFixed(2)];
                        } catch (_) {}
                        const overlays = capturePaneOverlays(pid);
                        if (overlays.length) conf.overlays = overlays;
                    }
                    return Object.keys(conf).length ? (acc[pid] = conf, acc) : acc;
                }, {})
            }))
        };
        localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(data));
    } catch (_) {}
}

function loadTabs() {
    try {
        const raw = localStorage.getItem(TABS_STORAGE_KEY);
        if (!raw) return false;
        const data = JSON.parse(raw);
        if (!data || !Array.isArray(data.tabs) || !data.tabs.length) return false;
        tabSeq = data.tabSeq || data.tabs.length;
        data.tabs.forEach(t => {
            tabs[t.id] = { id: t.id, name: t.name || t.id, layout: t.layout || 1 };
            buildTabGrid(t.id, t.layout || 1);
            Object.entries(t.panes || {}).forEach(([pid, conf]) => {
                if (conf.radarSite) paneRadarSites[pid] = conf.radarSite;
                if (conf.radarProduct) paneRadarProducts[pid] = conf.radarProduct;
                if (conf.goesChannel != null) paneGoesChannels[pid] = conf.goesChannel;
                // Defer live-layer/view/overlay restore until the pane's map loads
                if (conf.gibs || conf.l3 || conf.radarVisible || conf.satVisible || conf.view ||
                    (conf.overlays && conf.overlays.length)) pendingRestore[pid] = conf;
            });
        });
        activeTabId = (data.activeTabId && tabs[data.activeTabId]) ? data.activeTabId : Object.keys(tabs)[0];
        return true;
    } catch (_) { return false; }
}

function initTabs() {
    // Restore persisted tabs, or seed the default first tab
    if (!loadTabs()) {
        tabs['t1'] = { id: 't1', name: 'Tab 1', layout: 1 };
        buildTabGrid('t1', 1);
        activeTabId = 't1';
    }
    renderTabBar();

    document.getElementById('tab-add')?.addEventListener('click', () => createTab());
    const bar = document.getElementById('tab-bar');
    // Detect the double-click via timing in the click handler. The native
    // 'dblclick' event can't be used here: each preceding 'click' runs
    // switchTab → renderTabBar, which rebuilds the buttons and detaches the
    // element dblclick would target, so dblclick never reaches this listener.
    let lastTabClick = { id: null, t: 0 };
    bar?.addEventListener('click', e => {
        const close = e.target.closest('.tab-close');
        if (close) { e.stopPropagation(); closeTab(close.getAttribute('data-close')); return; }
        const btn = e.target.closest('.tab-btn');
        if (!btn) return;
        const id = btn.getAttribute('data-tab');
        const now = Date.now();
        const isDouble = (lastTabClick.id === id && now - lastTabClick.t < 400);
        lastTabClick = { id, t: now };
        if (isDouble) {
            // Rename runs after the (already-applied) switch, on the live DOM,
            // so the input is created last and isn't clobbered by a rebuild.
            if (activeTabId !== id) switchTab(id);
            startTabRename(id);
            lastTabClick = { id: null, t: 0 };   // reset so a 3rd click doesn't re-trigger
            return;
        }
        switchTab(id);
    });

    // Activate the saved/active tab (creates its first pane's map)
    switchTab(tabs[activeTabId] ? activeTabId : Object.keys(tabs)[0]);
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 19: UTC CLOCK
// ═══════════════════════════════════════════════════════════════════════════════

function startUTCClock() {
    const el = document.getElementById('val-time');
    if (!el) return;
    function tick() {
        const now = new Date();
        const h = String(now.getUTCHours()).padStart(2, '0');
        const m = String(now.getUTCMinutes()).padStart(2, '0');
        const s = String(now.getUTCSeconds()).padStart(2, '0');
        el.textContent = `${h}:${m}:${s} Z`;
    }
    tick();
    setInterval(tick, 1000);
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 20: AUTO-REFRESH
// ═══════════════════════════════════════════════════════════════════════════════

function startAutoRefresh() {
    // 1. Critical Tactical Data (60 seconds)
    setInterval(() => {
        if (isPlaying) return;
        // Mesoscale Discussions
        const mcdActive = Object.values(maps).some(m => isLayerVisible(m, 'spc-md-fill'));
        if (mcdActive) fetchMesoscaleDiscussions(true);

        const mpdActive = Object.values(maps).some(m => isLayerVisible(m, 'wpc-mpd-fill'));
        if (mpdActive) fetchMPDs(true);

        // ProbSevere storm objects update ~every 2 min; CDN shields upstream for 90s.
        const psActive = Object.values(maps).some(m => isLayerVisible(m, 'probsevere-fill'));
        if (psActive) fetchProbSevere(true);
    }, 60 * 1000);

    // Aviation hazards (SIGMET/AIRMET hourly-ish, PIREPs continuous) and Local
    // Storm Reports (stream continuously during events) — 5 min cadence.
    setInterval(() => {
        if (isPlaying) return;
        if (Object.values(maps).some(m => isLayerVisible(m, 'airsigmet-fill'))) fetchAirSigmet(true);
        if (Object.values(maps).some(m => isLayerVisible(m, 'pireps-layer'))) fetchPireps(true);
        if (Object.values(maps).some(m => isLayerVisible(m, 'gairmet-fill'))) fetchGairmet(true);
        if (Object.values(maps).some(m => isLayerVisible(m, 'taf-layer'))) fetchTaf(true);
        if (Object.values(maps).some(m => isLayerVisible(m, 'cwa-fill'))) fetchCwa(true);
        if (Object.values(maps).some(m => isLayerVisible(m, 'spc-lsr-icons'))) fetchLSRs(true);
        // National SCIT table rebuilds as each radar finishes a volume scan
        // (~4-6 min), so 5 min keeps it within one scan of current.
        if (Object.values(maps).some(m => isLayerVisible(m, 'natt-cell'))) fetchNexradAttr(true);
    }, 5 * 60 * 1000);

    // 2. High Frequency (5 minutes)
    // Site radar — fast poll (60s). NEXRAD volume scans complete every ~4-6 min
    // (≈2 min for the lowest tilt in SAILS/severe mode), so we poll often to show
    // a new scan ASAP. This is cheap: fetchSiteRadarTimes only fetches a small
    // GetCapabilities XML and only reloads tiles when the scan time actually
    // changed (repointSiteRadar fires on prevBref !== times.sr_bref).
    const SITE_RADAR_LAYERS = ['site-bref-layer', 'site-bvel-layer', 'site-bdhc-layer', 'site-bdsa-layer', 'site-boha-layer'];
    setInterval(() => {
        if (isPlaying) return;
        const anySiteRadar = Object.values(maps).some(m => SITE_RADAR_LAYERS.some(l => isLayerVisible(m, l)));
        if (!anySiteRadar) return;
        const sites = new Set();
        Object.entries(maps).forEach(([pid, m]) => {
            const site = paneRadarSites[pid] || 'DGX';
            if (site.includes('nexrad')) return;
            const prodSourceMap = { 'sr_bref': 'site-bref', 'sr_bvel': 'site-bvel', 'bdhc': 'site-bdhc', 'bdsa': 'site-bdsa', 'boha': 'site-boha' };
            const srcName = prodSourceMap[paneRadarProducts[pid] || 'sr_bref'];
            if (srcName && m.getSource(srcName)) sites.add(site);
        });
        // Re-read each scan's valid time, then repoint tiles to that exact scan
        // (only when it changed) so all zoom levels match and the label tracks it.
        sites.forEach(site => fetchSiteRadarTimes(site, true));
        updateHealth('radar');
    }, 60 * 1000);

    // National mosaic — IEM n0q updates ~every 2 min, so refresh at that cadence.
    setInterval(() => {
        if (isPlaying) return;
        if (!activeRadarNational) return;
        const url = cacheBust(nationalRadarUrl());
        Object.values(maps).forEach(m => {
            if (m.getSource('radar')) m.getSource('radar').setTiles([url]);
        });
        updateHealth('radar');
        addLiveLog('AUTO: National radar tiles refreshed', '#444');
    }, 2 * 60 * 1000);

    // NEXRAD operational status for every site shown in a pane (VCP/mode/alarms/latency).
    setInterval(() => { refreshAllRadarStatus(); }, 2 * 60 * 1000);

    setInterval(async () => {
        if (isPlaying) return;

        // METARs refresh + re-generate any visible contour products
        const metarsActive = Object.values(maps).some(m => isLayerVisible(m, 'metars-temp') || isLayerVisible(m, 'metars-barb'));
        const activeContours = Object.entries(SFC_CONTOUR_FIELDS)
            .filter(([id]) => Object.values(maps).some(m => isLayerVisible(m, id + '-line')));

        if (metarsActive || activeContours.length) {
            await fetchMETARs();
            // Re-generate contours from fresh METAR data
            activeContours.forEach(([id, c]) => renderContourProduct(id, c.field, c.interval, c.label));
            if (activeContours.length) addLiveLog('AUTO: Contour products refreshed from new METARs', '#444');
        }

        // Solar terminator refresh
        const terminatorActive = Object.values(maps).some(m => isLayerVisible(m, 'solar-night-fill'));
        if (terminatorActive) updateTerminator();
    }, 5 * 60 * 1000);

    // 3. Satellite — ticks every minute, but each pane only refreshes on its own
    // sector's ABI scan cadence: mesoscale 1 min, CONUS/PACUS 5, full disk 10.
    // A shared 5-minute timer would either starve the 1-minute floaters or hammer
    // full disk twice per scan.
    const lastSatRefresh = {};   // paneId -> ms of the last tile repoint
    setInterval(() => {
        if (isPlaying) return;

        // Satellite refresh — each pane may have its own GOES channel + sector
        let anyRefreshed = false;
        let anyEast = false;
        Object.entries(maps).forEach(([paneId, m]) => {
            const ch = paneGoesChannels[paneId];
            if (ch === null || !m.getSource('satellite') || !isLayerVisible(m, 'satellite-layer')) return;
            const secKey = goesSectorFor(paneId);
            const sec = goesSectorDef(secKey);
            const due = Date.now() - (lastSatRefresh[paneId] || 0) >= sec.cadenceMs;
            if (!due) return;
            lastSatRefresh[paneId] = Date.now();
            m.getSource('satellite').setTiles([cacheBust(goesChannelUrl(ch, secKey))]);
            fetchIemGoesValid(ch, secKey).then(() => {
                if (paneId === activePaneId) refreshTimestampLabel();
            });
            if (sec.bird === 'east') anyEast = true;
            anyRefreshed = true;
        });
        if (anyRefreshed) {
            updateHealth('sat');
            addLiveLog('AUTO: Satellite tiles refreshed', '#444');
            if (anyEast) fetchGoesSatTimes(true).then(() => refreshTimestampLabel());
        }

        // GIBS refresh — advance to the newest published frame so the imagery and
        // its valid-time label stay current. Hybrid (iemCh) products instead
        // re-pull IEM's live per-channel tiles + exact valid time.
        if (Date.now() - (lastSatRefresh._gibs || 0) < 5 * 60 * 1000) return;
        lastSatRefresh._gibs = Date.now();
        Object.entries(maps).forEach(([paneId, m]) => {
            const prodKey = paneGibs[paneId];
            if (!prodKey || !m.getSource('gibs-sat') || !isLayerVisible(m, 'gibs-sat-layer')) return;
            const p = GIBS_PRODUCTS[prodKey];
            const bird = paneGibsBird[paneId] || goesBirdFor(paneId);
            const stillMine = () => paneGibs[paneId] === prodKey && (paneGibsBird[paneId] || 'east') === bird;
            if (p.iemCh) {
                m.getSource('gibs-sat').setTiles([cacheBust(goesChannelUrl(p.iemCh, `${bird}-fulldisk`))]);
                updateHealth('gibsSat');
                fetchIemGoesValid(p.iemCh, `${bird}-fulldisk`).then(v => {
                    if (v && stillMine()) {
                        paneGibsTime[paneId] = v;
                        if (paneId === activePaneId) refreshTimestampLabel();
                    }
                });
                return;
            }
            fetchGibsTimes(prodKey, bird).then(t => {
                if (!t.length || !stillMine() || !m.getSource('gibs-sat')) return;
                const newest = t[t.length - 1];
                if (newest === paneGibsTime[paneId]) return;   // already current
                m.getSource('gibs-sat').setTiles([gibsTileUrl(prodKey, newest, bird)]);
                paneGibsTime[paneId] = newest;
                updateHealth('gibsSat');
                if (paneId === activePaneId) refreshTimestampLabel();
            });
        });
    }, 60 * 1000);

    // Lightning refresh (NLDN nowCOAST updates ~every 5 min; refresh every 5 min when visible)
    setInterval(() => {
        if (isPlaying) return;
        let refreshed = false;
        Object.values(maps).forEach(m => {
            if (m.getSource('lightning') && isLayerVisible(m, 'lightning-layer')) {
                m.getSource('lightning').setTiles([cacheBust(lightningUrl())]);
                refreshed = true;
            }
        });
        if (refreshed) {
            updateHealth('lightning');
            addLiveLog('AUTO: NLDN lightning refreshed', '#444');
        }
    }, 5 * 60 * 1000);

    // MRMS tiles (echo tops / QPE) — the MRMS mosaic regenerates every ~2 min, so
    // a 30-min refresh left severe-weather products badly stale. 5-min tile
    // re-pull is cheap and only runs while the layer is visible.
    setInterval(() => {
        if (isPlaying) return;
        const echotopsActive = Object.values(maps).some(m => isLayerVisible(m, 'mrms-echotops-layer'));
        if (echotopsActive) {
            const etUrl = cacheBust('https://opengeo.ncep.noaa.gov/geoserver/conus/conus_neet_v18/ows?service=wms&version=1.1.1&request=GetMap&layers=conus_neet_v18&format=image/png&transparent=true&styles=&srs=EPSG:3857&width=256&height=256&bbox={bbox-epsg-3857}');
            Object.values(maps).forEach(m => {
                if (m.getSource('mrms-echotops')) m.getSource('mrms-echotops').setTiles([etUrl]);
            });
            updateHealth('mrmsEchotops');
        }
        if (Object.values(paneMrmsQpe).some(Boolean)) {
            // Per-pane refresh: each pane re-pulls its OWN period's tiles
            Object.entries(maps).forEach(([pid, m]) => {
                if (paneMrmsQpe[pid] && m.getSource('mrms-qpe')) {
                    m.getSource('mrms-qpe').setTiles([cacheBust(mrmsQpeWmsUrl(paneMrmsQpe[pid]))]);
                }
            });
            updateHealth('mrmsQpe');
        }
        // Hurricane Hunter obs arrive every ~10 min while a mission is airborne
        if (Object.values(maps).some(m => isLayerVisible(m, 'recon-hdob-pts'))) {
            fetchReconHdob(false);
        }
    }, 5 * 60 * 1000);

    // Dedicated Top-of-Hour AirNow AQI Sync (:12, :27, :42 past the hour)
    setInterval(() => {
        if (isPlaying) return;
        const mins = new Date().getMinutes();
        if (mins === 12 || mins === 27 || mins === 42) {
            const aqiActive = Object.values(maps).some(m => isLayerVisible(m, 'airnow-aqi-layer'));
            if (aqiActive) {
                fetchAQI(true);
                addLiveLog(`AUTO: AirNow AQI refreshed at :${mins}`, '#444');
            }
        }
    }, 60 * 1000);

    // 4. Low Frequency (30 minutes)
    setInterval(() => {
        // HMS Smoke
        const smokeActive = Object.values(maps).some(m => isLayerVisible(m, 'hms-smoke-fill'));
        if (smokeActive) fetchHMSSmoke(true);

        // FIRMS Fires
        const firesActive = Object.values(maps).some(m => isLayerVisible(m, 'firms-fires-layer'));
        if (firesActive) fetchFIRMS(true);

        // SPC Outlooks (Day 1-3)
        [1, 2, 3].forEach(day => {
            const outlookActive = Object.values(maps).some(m => isLayerVisible(m, `spc-day${day}-fill`));
            if (outlookActive) fetchSPCOutlook(day, true);
        });

        // SPC Day 4-8 Severe Outlook
        if (Object.values(maps).some(m => isLayerVisible(m, 'spc-d48-fill'))) fetchSPCD48(true);

        // NDBC buoy observations (hourly obs; 30 min keeps them within one cycle)
        if (Object.values(maps).some(m => isLayerVisible(m, 'ndbc-layer'))) fetchNdbc(true);

        // SPC Probabilistic Hazards (Day 1/2 Tornado/Wind/Hail)
        [1, 2].forEach(day => {
            ['torn', 'wind', 'hail'].forEach(hz => {
                const probActive = Object.values(maps).some(m => isLayerVisible(m, `spc-prob-${day}-${hz}-fill`));
                if (probActive) fetchSPCProb(day, hz, true);
            });
        });

        // WPC Excessive Rainfall Outlooks (Day 1-3)
        [1, 2, 3].forEach(day => {
            const eroActive = Object.values(maps).some(m => isLayerVisible(m, `wpc-ero-day${day}-fill`));
            if (eroActive) fetchERO(day, true);
        });

        // SPC Fire Weather Outlooks (Day 1-8)
        [1, 2, 3, 4, 5, 6, 7, 8].forEach(day => {
            const fwActive = Object.values(maps).some(m => isLayerVisible(m, `spc-firewx-day${day}-fill`));
            if (fwActive) fetchSPCFireWx(day, true);
        });


        // WPC isobars and fronts moved to their own faster poll — see below.

        // NHC tropical (storms + outlook) refreshes on its own faster interval below.

        // River gauges refresh
        const gaugesActive = Object.values(maps).some(m => isLayerVisible(m, 'river-gauges-layer'));
        if (gaugesActive) {
            riverGaugeCacheTime = 0; // Force cache bust
            fetchRiverGauges(true);
        }

        // WPC QPF tile refresh — per-pane, each pane keeps its own product
        if (Object.values(paneQpf).some(Boolean)) {
            Object.entries(maps).forEach(([pid, m]) => {
                if (paneQpf[pid] && m.getSource('wpc-qpf')) {
                    m.getSource('wpc-qpf').setTiles([cacheBust(qpfWmsUrl(paneQpf[pid]))]);
                }
            });
            updateHealth('wpcQpf');
        }

        // NDFD forecast grid tile refresh (grids update ~hourly; previously the
        // tiles were loaded once on toggle and never refreshed)
        const ndfdActive = Object.values(maps).some(m => isLayerVisible(m, 'ndfd-temp-layer'));
        if (ndfdActive) {
            const ndfdUrl = cacheBust(NDFD_TEMP_URL);
            Object.values(maps).forEach(m => {
                if (m.getSource('ndfd-temp')) m.getSource('ndfd-temp').setTiles([ndfdUrl]);
            });
            updateHealth('ndfdTemp');
        }

    }, 30 * 60 * 1000);

    // WPC surface analysis on its own 10-minute poll. The analysis is 3-hourly,
    // but it does not land on the hour — WPC cuts it ~1-1.5 h after valid time,
    // so the arrival moment is unpredictable and a 30-minute poll could sit on
    // the previous analysis for half an hour after the new one was published.
    // Both products are small text files (~21 KB and ~2 KB) and only fetch while
    // their layer is on, so checking three times as often is nearly free.
    setInterval(() => {
        if (Object.values(maps).some(m => isLayerVisible(m, 'wpc-isobars-line'))) fetchWPCIsobars(true);
        if (Object.values(maps).some(m => isLayerVisible(m, 'wpc-fronts-solid'))) fetchWPCFronts(true);
    }, 10 * 60 * 1000);

    // NHC tropical layers refresh faster (5 min) — advisories/intermediate
    // advisories update on short cycles during active storms, and the fetches
    // are tiny cache-busted GeoJSON. Only runs while a tropical layer is on.
    setInterval(() => {
        if (Object.values(maps).some(m => isLayerVisible(m, 'nhc-track-pts'))) fetchNHCStorms(true);
        if (Object.values(maps).some(m => isLayerVisible(m, 'nhc-outlook-fill'))) fetchNHCOutlook(true);
        if (Object.values(maps).some(m => isLayerVisible(m, 'nhc-fcst-lines'))) fetchFcstHistory(false);
    }, 5 * 60 * 1000);
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 21: NOAA SOLAR CALCULATOR & DAY/NIGHT TERMINATOR
// ═══════════════════════════════════════════════════════════════════════════════

// ─── NOAA Solar Position Equations ───
// Reference: NOAA Earth System Research Laboratories
// https://gml.noaa.gov/grad/solcalc/solareqns.PDF

function solarJulianDay(date) {
    const y = date.getUTCFullYear();
    const m = date.getUTCMonth() + 1;
    const d = date.getUTCDate() + (date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600) / 24;
    let A = Math.floor((14 - m) / 12);
    let Y = y + 4800 - A;
    let M = m + 12 * A - 3;
    return d + Math.floor((153 * M + 2) / 5) + 365 * Y + Math.floor(Y / 4) - Math.floor(Y / 100) + Math.floor(Y / 400) - 32045.5;
}

function solarPosition(date) {
    const JD = solarJulianDay(date);
    const T = (JD - 2451545.0) / 36525.0; // Julian centuries from J2000.0
    const L0 = (280.46646 + T * (36000.76983 + 0.0003032 * T)) % 360; // Geometric mean longitude
    const M = (357.52911 + T * (35999.05029 - 0.0001537 * T)) % 360;  // Mean anomaly
    const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);      // Eccentricity
    const Mrad = M * Math.PI / 180;
    const C = (1.914602 - T * (0.004817 + 0.000014 * T)) * Math.sin(Mrad)
            + (0.019993 - 0.000101 * T) * Math.sin(2 * Mrad)
            + 0.000289 * Math.sin(3 * Mrad); // Equation of center
    const sunLon = (L0 + C) % 360; // Sun true longitude
    const omega = 125.04 - 1934.136 * T;
    const lambda = sunLon - 0.00569 - 0.00478 * Math.sin(omega * Math.PI / 180); // Apparent longitude

    // Obliquity of ecliptic
    const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
    const eps = eps0 + 0.00256 * Math.cos(omega * Math.PI / 180);
    const epsRad = eps * Math.PI / 180;
    const lambdaRad = lambda * Math.PI / 180;

    // Declination
    const sinDec = Math.sin(epsRad) * Math.sin(lambdaRad);
    const declination = Math.asin(sinDec) * 180 / Math.PI;

    // Equation of Time (minutes)
    const y2 = Math.tan(epsRad / 2) ** 2;
    const L0rad = L0 * Math.PI / 180;
    const eqTime = 4 * (180 / Math.PI) * (
        y2 * Math.sin(2 * L0rad)
        - 2 * e * Math.sin(Mrad)
        + 4 * e * y2 * Math.sin(Mrad) * Math.cos(2 * L0rad)
        - 0.5 * y2 * y2 * Math.sin(4 * L0rad)
        - 1.25 * e * e * Math.sin(2 * Mrad)
    );

    return { declination, eqTime };
}

function solarHourAngle(lat, dec, elevation) {
    // elevation: degrees below horizon (0 = geometric, 0.833 = standard refraction,
    // 6 = civil twilight, 12 = nautical, 18 = astronomical)
    const latRad = lat * Math.PI / 180;
    const decRad = dec * Math.PI / 180;
    const cosHA = (Math.cos((90 + elevation) * Math.PI / 180) - Math.sin(latRad) * Math.sin(decRad))
                / (Math.cos(latRad) * Math.cos(decRad));
    if (cosHA > 1) return null;  // Sun never rises
    if (cosHA < -1) return null; // Sun never sets (midnight sun)
    return Math.acos(cosHA) * 180 / Math.PI;
}

function computeSolarTable(lat, lon, date, tzName) {
    const { declination, eqTime } = solarPosition(date);

    function timeForElevation(elev) {
        const ha = solarHourAngle(lat, declination, elev);
        if (ha === null) return null;
        const solarNoonMin = 720 - 4 * lon - eqTime; // in UTC minutes
        const riseMin = solarNoonMin - ha * 4;
        const setMin = solarNoonMin + ha * 4;
        return { rise: riseMin, set: setMin };
    }

    const solarNoonMin = 720 - 4 * lon - eqTime;
    const standard = timeForElevation(0.833); // Standard sunrise/sunset (includes refraction)
    const civil = timeForElevation(6);
    const nautical = timeForElevation(12);
    const astronomical = timeForElevation(18);

    function fmtMin(totalMin) {
        if (totalMin == null) return '--:--';
        let m = ((totalMin % 1440) + 1440) % 1440;
        const h = Math.floor(m / 60);
        const min = Math.round(m % 60);
        return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
    }

    function fmtLocal(totalMinUTC) {
        if (totalMinUTC == null) return '--:--';
        // Convert UTC minutes to a Date, then format in the LOCATION's timezone
        const d = new Date(date);
        d.setUTCHours(0, 0, 0, 0);
        d.setUTCMinutes(d.getUTCMinutes() + totalMinUTC);
        if (tzName) {
            // Use Intl to format in the clicked location's actual timezone
            try {
                const parts = new Intl.DateTimeFormat('en-US', {
                    timeZone: tzName, hour: 'numeric', minute: '2-digit', hour12: true
                }).formatToParts(d);
                const hr = parts.find(p => p.type === 'hour')?.value || '';
                const mn = parts.find(p => p.type === 'minute')?.value || '';
                const dp = parts.find(p => p.type === 'dayPeriod')?.value || '';
                return `${hr}:${mn} ${dp}`;
            } catch (_) { /* fall through to browser-local */ }
        }
        // Fallback: browser's local timezone
        const lh = d.getHours();
        const lm = d.getMinutes();
        const ampm = lh >= 12 ? 'PM' : 'AM';
        const h12 = lh === 0 ? 12 : (lh > 12 ? lh - 12 : lh);
        return `${h12}:${String(lm).padStart(2, '0')} ${ampm}`;
    }

    // Resolve short timezone abbreviation for display (e.g., "CDT", "EDT", "MST")
    let tzAbbrev = '';
    if (tzName) {
        try {
            const parts = new Intl.DateTimeFormat('en-US', {
                timeZone: tzName, timeZoneName: 'short'
            }).formatToParts(date);
            tzAbbrev = parts.find(p => p.type === 'timeZoneName')?.value || '';
        } catch (_) {}
    }

    const dayLen = standard ? (standard.set - standard.rise) : null;
    const dayLenStr = dayLen != null ? `${Math.floor(dayLen / 60)}h ${Math.round(dayLen % 60)}m` : 'N/A';

    return {
        solarNoon:    { utc: fmtMin(solarNoonMin), local: fmtLocal(solarNoonMin) },
        sunrise:      { utc: fmtMin(standard?.rise), local: fmtLocal(standard?.rise) },
        sunset:       { utc: fmtMin(standard?.set),  local: fmtLocal(standard?.set) },
        civilDawn:    { utc: fmtMin(civil?.rise),    local: fmtLocal(civil?.rise) },
        civilDusk:    { utc: fmtMin(civil?.set),     local: fmtLocal(civil?.set) },
        nauticalDawn: { utc: fmtMin(nautical?.rise), local: fmtLocal(nautical?.rise) },
        nauticalDusk: { utc: fmtMin(nautical?.set),  local: fmtLocal(nautical?.set) },
        astroDawn:    { utc: fmtMin(astronomical?.rise), local: fmtLocal(astronomical?.rise) },
        astroDusk:    { utc: fmtMin(astronomical?.set),  local: fmtLocal(astronomical?.set) },
        dayLength:    dayLenStr,
        declination:  declination.toFixed(2) + '°',
        tzAbbrev:     tzAbbrev
    };
}

// ─── Day/Night Terminator Polygon Generator ───

function buildTerminatorGeoJSON(now) {
    const { declination, eqTime } = solarPosition(now || new Date());
    const utcMin = (now || new Date()).getUTCHours() * 60 + (now || new Date()).getUTCMinutes();
    const solarNoonLon = -(utcMin - 720 + eqTime) / 4; // Longitude where it's solar noon

    const decRad = declination * Math.PI / 180;
    const features = [];

    // Build terminator line as lat/lon pairs from pole to pole
    // For each longitude, find the latitude where sun is at horizon
    // We'll build the night polygon as one big polygon

    // Civil twilight terminator (sun 6° below horizon)
    function terminatorCoords(elevation) {
        const coords = [];
        for (let lon = -180; lon <= 180; lon += 1) {
            const lonRad = (lon - solarNoonLon) * Math.PI / 180;
            // At this longitude, find lat where solar elevation = -elevation
            // sin(elev) = sin(lat)*sin(dec) + cos(lat)*cos(dec)*cos(hourAngle)
            // hourAngle = (lon - subSolarLon) converted to angle
            const cosHA = Math.cos(lonRad);
            const elevRad = -elevation * Math.PI / 180;
            // sin(elevRad) = sin(lat)*sin(dec) + cos(lat)*cos(dec)*cosHA
            // Let x = sin(lat), y = cos(lat) — solve for lat
            const a = Math.sin(decRad);
            const b = Math.cos(decRad) * cosHA;
            // sin(elev) = a*sin(lat) + b*cos(lat)
            // R*sin(lat + phi) = sin(elev), where R = sqrt(a²+b²), tan(phi) = b/a
            const R = Math.sqrt(a * a + b * b);
            const sinVal = Math.sin(elevRad) / R;
            if (Math.abs(sinVal) > 1) {
                // No solution at this longitude — polar day or night
                coords.push([lon, sinVal > 0 ? -90 : 90]);
                continue;
            }
            const phi = Math.atan2(b, a);
            const lat = (Math.asin(sinVal) - phi) * 180 / Math.PI;
            coords.push([lon, Math.max(-85, Math.min(85, lat))]);
        }
        return coords;
    }

    // Night polygon: area where sun is below horizon (standard rise/set = 0.833°)
    const nightLine = terminatorCoords(0.833);

    // Determine which side is night: check if sub-solar point is north or south
    // Sub-solar latitude = declination
    // Night is on the opposite side of the terminator from the sub-solar point

    // Build polygon: terminator line + close along bottom or top
    const nightPoly = [...nightLine];
    // Check: is the sub-solar point above or below the terminator at lon=solarNoonLon?
    // At solar noon longitude, the terminator lat ≈ ±(90-|dec|)
    // Night is the side AWAY from the sub-solar point
    // If declination > 0 (northern summer), night is on the south side
    // We need to close the polygon on the south (bottom) side
    if (declination >= 0) {
        // Night is south of the terminator line
        nightPoly.push([180, -85]);
        nightPoly.push([-180, -85]);
    } else {
        // Night is north of the terminator line
        nightPoly.push([180, 85]);
        nightPoly.push([-180, 85]);
    }
    nightPoly.push(nightPoly[0]); // Close ring

    features.push({
        type: 'Feature',
        properties: { zone: 'night' },
        geometry: { type: 'Polygon', coordinates: [nightPoly] }
    });

    // Civil twilight band
    const civilLine = terminatorCoords(6);
    const twilightPoly = [];
    // Twilight band is between the night terminator and civil terminator
    if (declination >= 0) {
        // Night is south, so civil twilight extends further south
        twilightPoly.push(...civilLine);
        twilightPoly.push([180, -85]);
        twilightPoly.push([-180, -85]);
    } else {
        twilightPoly.push(...civilLine);
        twilightPoly.push([180, 85]);
        twilightPoly.push([-180, 85]);
    }
    twilightPoly.push(twilightPoly[0]);

    features.push({
        type: 'Feature',
        properties: { zone: 'civil-twilight' },
        geometry: { type: 'Polygon', coordinates: [twilightPoly] }
    });

    return { type: 'FeatureCollection', features };
}

function updateTerminator() {
    const gj = buildTerminatorGeoJSON(new Date());
    Object.values(maps).forEach(m => {
        if (m.getSource('solar-terminator')) {
            m.getSource('solar-terminator').setData(gj);
        }
    });
    updateHealth('solar');
}

// ─── Solar Panel Click Handler ───

// Resolve IANA timezone name for a lat/lon coordinate
// Uses NWS API for US locations, longitude-based fallback for international
const solarTzCache = {};
async function resolveTimezone(lat, lon) {
    const key = `${lat.toFixed(1)},${lon.toFixed(1)}`;
    if (solarTzCache[key]) return solarTzCache[key];

    // Try NWS points API for US/territory locations
    try {
        const res = await fetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, {
            headers: { 'Accept': 'application/geo+json' }
        });
        if (res.ok) {
            const data = await res.json();
            const tz = data.properties?.timeZone;
            if (tz) { solarTzCache[key] = tz; return tz; }
        }
    } catch (_) {}

    // Fallback: estimate IANA timezone from longitude (works globally, approximate)
    const offsetHrs = Math.round(lon / 15);
    const etcTz = `Etc/GMT${offsetHrs <= 0 ? '+' : ''}${-offsetHrs}`;
    try {
        // Validate the Etc/GMT timezone is recognized
        Intl.DateTimeFormat('en-US', { timeZone: etcTz });
        solarTzCache[key] = etcTz;
        return etcTz;
    } catch (_) {}

    return null; // Will fall back to browser timezone
}

// Crosshair cursor while the terminator is active, signalling the map is
// clickable for sun times. Reset to default when the terminator is off.
function updateSolarCursor(paneId) {
    const map = maps[paneId];
    if (!map) return;
    const canvas = map.getCanvas();
    if (!canvas) return;
    canvas.style.cursor = isLayerVisible(map, 'solar-night-fill') ? 'crosshair' : '';
}

// Brief, dismissible hint pill telling the user they can click for sun times.
let solarHintTimers = {};
function showSolarHint(paneId) {
    const paneEl = document.querySelector(`.pane[data-pane="${paneId}"]`);
    if (!paneEl) return;
    let hint = paneEl.querySelector('.solar-hint');
    if (!hint) {
        hint = document.createElement('div');
        hint.className = 'solar-hint';
        hint.innerHTML = '☀ Click anywhere for sunrise / sunset times';
        paneEl.appendChild(hint);
    }
    hint.style.display = 'block';
    requestAnimationFrame(() => hint.classList.add('visible'));
    clearTimeout(solarHintTimers[paneId]);
    solarHintTimers[paneId] = setTimeout(() => hideSolarHint(paneId), 5000);
}
function hideSolarHint(paneId) {
    clearTimeout(solarHintTimers[paneId]);
    const paneEl = document.querySelector(`.pane[data-pane="${paneId}"]`);
    const hint = paneEl && paneEl.querySelector('.solar-hint');
    if (hint) {
        hint.classList.remove('visible');
        setTimeout(() => { if (hint) hint.style.display = 'none'; }, 250);
    }
}

// Attach the solar sun-times click query to a single pane's map. Idempotent
// so it can be called from initMap (new panes) and initSolarClickHandler.
function attachSolarClick(paneId, map) {
    if (map.__solarClickAttached) return;
    map.__solarClickAttached = true;
    {
        map.on('click', async e => {
            // Only trigger when solar terminator is visible
            if (!isLayerVisible(map, 'solar-night-fill')) return;
            hideSolarHint(paneId);

            const lat = e.lngLat.lat;
            const lon = e.lngLat.lng;
            const now = new Date();
            const clickPx = e.originalEvent.pageX;
            const clickPy = e.originalEvent.pageY;

            // Show panel immediately with "loading" while timezone resolves
            const panel = document.getElementById('solar-info-panel');
            const body = document.getElementById('solar-info-body');
            if (!panel || !body) return;

            const locStr = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
            body.innerHTML = `<div style="color:#88ccff; font-size:8.5px;">${locStr}</div><div style="color:#888; font-size:9px; padding:10px 0;">Resolving timezone...</div>`;
            const px = clickPx + 15;
            const py = clickPy - 80;
            panel.style.left = Math.min(px, window.innerWidth - 300) + 'px';
            panel.style.top = Math.max(10, Math.min(py, window.innerHeight - 350)) + 'px';
            panel.style.display = 'block';

            // Resolve timezone for the clicked location
            const tzName = await resolveTimezone(lat, lon);
            const table = computeSolarTable(lat, lon, now, tzName);

            const dateStr = now.toISOString().split('T')[0];
            const localLabel = table.tzAbbrev ? `Local (${table.tzAbbrev})` : 'Local';

            const html = `
                <div style="color:#88ccff; font-size:8.5px; margin-bottom:5px;">${locStr} — ${dateStr}</div>
                <table style="border-collapse:collapse; width:100%;">
                    <tr style="color:#00e5ff; font-size:8px; text-transform:uppercase; letter-spacing:0.5px;">
                        <td style="padding:1px 6px 3px 0;"></td>
                        <td style="padding:1px 6px 3px 0;">UTC</td>
                        <td style="padding:1px 0 3px 0;">${localLabel}</td>
                    </tr>
                    <tr><td style="color:#ffaa00; padding:1px 6px 1px 0;">Astro Dawn</td><td style="padding:1px 6px 1px 0;">${table.astroDawn.utc}Z</td><td>${table.astroDawn.local}</td></tr>
                    <tr><td style="color:#ff8844; padding:1px 6px 1px 0;">Nautical Dawn</td><td style="padding:1px 6px 1px 0;">${table.nauticalDawn.utc}Z</td><td>${table.nauticalDawn.local}</td></tr>
                    <tr><td style="color:#ff6666; padding:1px 6px 1px 0;">Civil Dawn</td><td style="padding:1px 6px 1px 0;">${table.civilDawn.utc}Z</td><td>${table.civilDawn.local}</td></tr>
                    <tr style="background:rgba(255,200,0,0.08);"><td style="color:#ffdd00; padding:2px 6px; font-weight:bold;">Sunrise</td><td style="padding:2px 6px;">${table.sunrise.utc}Z</td><td style="padding:2px 0;">${table.sunrise.local}</td></tr>
                    <tr><td style="color:#ffffff; padding:1px 6px 1px 0;">Solar Noon</td><td style="padding:1px 6px 1px 0;">${table.solarNoon.utc}Z</td><td>${table.solarNoon.local}</td></tr>
                    <tr style="background:rgba(255,100,0,0.08);"><td style="color:#ff8800; padding:2px 6px; font-weight:bold;">Sunset</td><td style="padding:2px 6px;">${table.sunset.utc}Z</td><td style="padding:2px 0;">${table.sunset.local}</td></tr>
                    <tr><td style="color:#ff6666; padding:1px 6px 1px 0;">Civil Dusk</td><td style="padding:1px 6px 1px 0;">${table.civilDusk.utc}Z</td><td>${table.civilDusk.local}</td></tr>
                    <tr><td style="color:#ff8844; padding:1px 6px 1px 0;">Nautical Dusk</td><td style="padding:1px 6px 1px 0;">${table.nauticalDusk.utc}Z</td><td>${table.nauticalDusk.local}</td></tr>
                    <tr><td style="color:#ffaa00; padding:1px 6px 1px 0;">Astro Dusk</td><td style="padding:1px 6px 1px 0;">${table.astroDusk.utc}Z</td><td>${table.astroDusk.local}</td></tr>
                    <tr><td colspan="3" style="border-top:1px solid rgba(0,229,255,0.15); padding-top:4px; margin-top:3px;"></td></tr>
                    <tr><td style="color:#00ff88; padding:1px 6px 1px 0;">Day Length</td><td colspan="2">${table.dayLength}</td></tr>
                    <tr><td style="color:#aaaaaa; padding:1px 6px 1px 0;">Declination</td><td colspan="2">${table.declination}</td></tr>
                </table>`;

            body.innerHTML = html;
        });
    }
}

function initSolarClickHandler() {
    // Attach to maps already created; panes added later attach via initMap().
    Object.entries(maps).forEach(([paneId, map]) => attachSolarClick(paneId, map));

    // Close button
    const closeBtn = document.getElementById('solar-close');
    if (closeBtn) {
        closeBtn.addEventListener('click', e => {
            e.stopPropagation();
            const panel = document.getElementById('solar-info-panel');
            if (panel) panel.style.display = 'none';
        });
    }
    // Close on Escape key
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            const panel = document.getElementById('solar-info-panel');
            if (panel) panel.style.display = 'none';
        }
    });
}

function initRiverGaugePanel() {
    const closeBtn = document.getElementById('river-gauge-close');
    if (closeBtn) {
        closeBtn.addEventListener('click', e => {
            e.stopPropagation();
            const panel = document.getElementById('river-gauge-panel');
            if (panel) panel.style.display = 'none';
        });
    }
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            const panel = document.getElementById('river-gauge-panel');
            if (panel) panel.style.display = 'none';
        }
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 21b: UTILITY HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function setLayerVisibilityAll(layerIds, visibility) {
    Object.values(maps).forEach(m => {
        layerIds.forEach(lid => {
            if (m.getLayer(lid)) m.setLayoutProperty(lid, 'visibility', visibility);
        });
    });
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 22: PLAY/PAUSE BUTTON
// ═══════════════════════════════════════════════════════════════════════════════

function initPlayButton() {
    const playBtn = document.getElementById('play-btn');
    const stopBtn = document.getElementById('stop-btn');
    const prevBtn = document.getElementById('step-prev-btn');
    const nextBtn = document.getElementById('step-next-btn');

    if (playBtn) {
        playBtn.addEventListener('click', () => {
            if (isPlaying) {
                pauseAnimation();
            } else if (isPaused) {
                resumeAnimation();
            } else {
                startAnimation();
            }
        });
    }

    if (stopBtn) stopBtn.addEventListener('click', stopAnimation);
    if (prevBtn) prevBtn.addEventListener('click', stepPrevFrame);
    if (nextBtn) nextBtn.addEventListener('click', stepNextFrame);

    initLoopKeys();
}

// AWIPS D2D is driven from the keyboard during an event — you step frames
// without ever reaching for the mouse. Arrow keys are only claimed while a loop
// is actually running, so with no loop up they still pan the map the way
// MapLibre expects.
function initLoopKeys() {
    const typing = el => {
        if (!el) return false;
        const tag = el.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    };

    document.addEventListener('keydown', e => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (typing(e.target)) return;
        // Don't steal keys from an open modal. Tested by layout rather than by
        // matching the style attribute: the markup writes `display:none;` with
        // no space, so an attribute-substring test silently matches nothing and
        // would treat every hidden modal as open.
        const modalOpen = Array.from(document.querySelectorAll('.modal-overlay'))
            .some(el => el.offsetParent !== null);
        if (modalOpen) return;

        const looping = isPlaying || isPaused;

        switch (e.key) {
            case ' ':
            case 'Spacebar':
                e.preventDefault();
                if (isPlaying) pauseAnimation();
                else if (isPaused) resumeAnimation();
                else startAnimation();
                break;
            case 'ArrowLeft':
                if (!looping) return;
                e.preventDefault();
                stepPrevFrame();
                break;
            case 'ArrowRight':
                if (!looping) return;
                e.preventDefault();
                stepNextFrame();
                break;
            case 'Home':
                if (!looping) return;
                e.preventDefault();
                if (isPlaying) pauseAnimation();
                animationFrameIndex = 0;
                renderCurrentFrame();
                break;
            case 'End':
                if (!looping) return;
                e.preventDefault();
                if (isPlaying) pauseAnimation();
                animationFrameIndex = Math.max(0, animationFrames.length - 1);
                renderCurrentFrame();
                break;
            case 'Escape':
                if (!looping) return;
                stopAnimation();
                break;
            default:
                // 1-8 focus the matching pane in the active tab, like D2D's
                // numbered panel selection. Routed through the pane's own click
                // handler so selection stays in one place, and skipped for panes
                // the current layout isn't showing.
                if (/^[1-8]$/.test(e.key)) {
                    const paneEl = document.querySelector(`.pane[data-pane="${activeTabId}-${e.key}"]`);
                    if (paneEl && paneEl.offsetParent !== null) {
                        e.preventDefault();
                        paneEl.click();
                    }
                }
        }
    });
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 23: HEALTH MONITOR TOGGLE
// ═══════════════════════════════════════════════════════════════════════════════

function initHealthToggle() {
    const btn = document.getElementById('btn-health');
    if (!btn) return;
    btn.addEventListener('click', () => {
        const panel = document.getElementById('data-health-monitor');
        if (!panel) return;
        panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });
}

function initDebugToggle() {
    const btn = document.getElementById('btn-debug');
    if (!btn) return;
    btn.addEventListener('click', () => {
        const logContainer = document.getElementById('log-container');
        if (!logContainer) return;
        logContainer.classList.toggle('collapsed');
        try {
            localStorage.setItem('fxnet_log_open',
                logContainer.classList.contains('collapsed') ? '0' : '1');
        } catch (e) {}
    });
}

// The log panel holds 150px of the sidebar when open, which is most of what the
// product tree has to work with. It ships collapsed; this restores the user's
// choice if they've opened it before.
function restoreLogPanelState() {
    const logContainer = document.getElementById('log-container');
    if (!logContainer) return;
    let open = null;
    try { open = localStorage.getItem('fxnet_log_open'); } catch (e) {}
    if (open === '1') logContainer.classList.remove('collapsed');
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 24: SYNC ALL PANES BUTTON
// ═══════════════════════════════════════════════════════════════════════════════

function initSyncButton() {
    const btn = document.getElementById('btn-sync-all');
    if (!btn) return;
    btn.addEventListener('click', () => {
        syncAllPanes(activePaneId);
    });
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 24b: WHAT'S NEW (user-facing changelog)
// ═══════════════════════════════════════════════════════════════════════════════
// Newest release first. Keep entries high-level + plain-language. Bump the top
// date when you ship something users would notice — a "NEW" dot shows until the
// user opens the panel (tracked in localStorage by the newest release date).
const CHANGELOG = [
    { date: 'Aug 30, 2026 (update 2)', items: [
        '<b>Hardening pass from a full application audit.</b> Five changes, none of them visible on the map, all of them the kind of thing that is easier to do now than after it matters.',
        '<b>The last external script is gone.</b> The Speed Insights client is now self-hosted alongside MapLibre and Lucide, so the Content-Security-Policy\'s <code>script-src</code> is <code>\'self\'</code> and nothing else — the page can no longer load a script from any origin but its own, which is the strongest script policy a site can carry.',
        '<b>Three remaining unescaped paths closed.</b> The SPC Mesoscale Discussion and WPC MPD popups took link and label fields from the upstream KML as-is; they are now escaped, and a link only renders if it is a real https URL. The diagnostic log, which everything writes to, now escapes at the sink — so a feed-supplied storm or product name can never arrive as markup, whichever of its 140 callers passed it. The CSP already contained all of this; now there is nothing for it to contain.',
        '<b>The product browser works from the keyboard.</b> Every product row is now a real button to assistive technology — Tab reaches it, Enter or Space toggles it, its on/off state is announced, and a visible focus ring shows where you are. Reduced-motion settings are honoured (the watchdog pulse goes still).',
        '<b>Pollers pause in a hidden browser tab.</b> Twenty-six refresh timers, from the 15-second warning sweep to the 1-second clock, used to run at full rate in a tab nobody was looking at. They now skip while the tab is hidden and each one fires once the moment you come back, so the display catches up in a single pass. Workspace tabs inside the app are unaffected — panes there stay live as before.',
        '<b>Tropical guidance stopped defeating its own cache.</b> The a-deck function asks Vercel\'s CDN to hold responses for five minutes, and the CDN does — but the client was stamping a unique timestamp on every request, so every poll from every viewer bypassed the cache, ran the function and fetched from NHC. The stamp is gone; freshness is now controlled in exactly one place.'
    ]},
    { date: 'Aug 30, 2026', items: [
        '<b>Fixed: AI model tracks went missing from the tropical guidance tabs.</b> Reported against Invest AL04, where every physics model plotted and <b>Early Cycle AI Models</b> drew nothing at all. The cause was the rule that each aid plots from its own newest cycle — taken literally, with no check that the newest cycle actually holds a track. GraphCast had been losing AL04 for two days, and its 30/12Z interpolated run carried a <i>single</i> point at hour zero. One point is not a line, so the aid was dropped outright — even though its 29/18Z run still had a usable track sitting right there in the same file.',
        'Each aid now falls back to <b>the most recent cycle that actually contains a forecast track</b>, instead of vanishing on a stub. Across the eight systems active today that restores AL04\'s early-cycle AI track and protects every other model from the same failure — it is not an AI-specific fault, it just showed up there first because AI trackers drop weak systems soonest.',
        'A track pulled from an older run is <b>labelled with its lag</b> on the map (<b>GDMI ✦ -18h</b>) so it can never be mistaken for current guidance drawn beside fresh aids. The lag is measured against the newest cycle in the whole deck, not the newest one in the tab, so a view holding a single stale track still reports itself honestly. Routine one-cycle offsets are not stamped, since late-cycle aids sit six hours behind the interpolated ones by definition.',
        '<b>Added the previous-run interpolations</b> — ATCF\'s ?2 aids (GDM2, UKX2, CMC2, CEM2, HFA2, HFB2, HWF2, HMN2, CTC2, NVG2), which are shifted from the 12-hour-old run. Each one only plots when the 6-hour interpolation it stands in for is missing, so it fills a gap rather than laying a second same-coloured line over the fresh track.',
        '<b>An empty tab now says why it is empty</b>, which matters because the two causes look identical on the map and mean opposite things: the aid is not in NHC\'s public deck at all, or it is there but its runs carry no track. AL97 currently shows one of each — early cycle reports that none of the seven AI aids are distributed for it, late cycle reports that GraphCast is present but single-point only.',
        'Worth knowing what is actually out there: <b>GraphCast ensemble mean is the only AI track model NHC distributes publicly</b>. GraphCast deterministic, GenCast, ECMWF AIFS, AI-GFS and AI-GEFS appear in no 2026 a-deck — they stay wired and will plot the day they arrive. The neural-net aids <b>NNIC</b> and <b>NNIB</b> are intensity-only and show on the intensity charts, never as tracks.',
        'The guidance feed also now carries <b>six forecast cycles instead of three</b>, which is what gives the fallback somewhere to reach. It costs less than the old three did — dropping the duplicate 50/64 kt wind-radii rows, the columns nothing reads, and the GEFS members outside the newest three cycles took AL04 from 284 KB down to 195 KB.'
    ]},
    { date: 'Aug 17, 2026', items: [
        '<b>Fixed: single-site products did not follow the SITE selector.</b> Reported against Storm Relative Velocity — you would pick a new radar and SRM kept showing the old one until you unloaded the product and loaded it again. The same fault applied to <b>all four NODD Level III overlays</b> (SRM, CC, ZDR, KDP) and to <b>Storm Tracks</b>, <b>Meso/TVS markers</b> and the <b>VAD Wind Profile</b> panel.',
        'The five NCEP products are tile templates, so changing site just re-points a URL and they follow for free. Everything else per-site is a fetch tied to a station, and the site handler never re-issued it. Worse, the 120-second refresh re-requested whichever station was still on record, so the display re-affirmed the wrong radar every couple of minutes instead of drifting back on its own — which is why toggling the product was the only cure, since that path is the one that passes the current site.',
        'All of them now switch with the selector. <b>Your elevation tilt carries across</b> rather than dropping back to the base slice, re-picking the site you are already on does nothing, and the national mosaic is left alone since no single-site product applies to it.'
    ]},
    { date: 'Aug 12, 2026 (update 2)', items: [
        '<b>Hover the Model Comparison chart for a readout.</b> Six traces converging and crossing is exactly the point where the eye stops being able to read a value off the plot — which is the moment you most want the number. Move the cursor anywhere over the chart and a crosshair drops on the nearest forecast hour with every model\'s value listed beside it, colour-matched to its trace, plus the inter-model spread at that hour.',
        'The crosshair <b>snaps to the forecast hour</b> rather than following the pixel, so what you read is the model\'s actual output and not an interpolation of it. The header line gives the valid time and the lead hour (<b>Sat 15/12Z +70 h</b>), a model that has run out of range shows an em dash rather than a stale last value, and the box flips to the other side of the cursor near the right edge so it never runs off the plot.',
        'Works in every field — temperature, dewpoint, wind, precip and MSLP each carry their own units and precision — and at any panel size, including maximized.'
    ]},
    { date: 'Aug 12, 2026', items: [
        '<b>Model Comparison now shows which run each model came from.</b> The header used to say "run pulled 13:06Z", which was the time <i>you</i> fetched — not the cycle behind any of the traces. Those differ a lot: HRRR runs hourly, GFS and ICON every six hours, and ECMWF IFS lands roughly seven hours after its nominal time. Each legend entry now carries its own cycle in the model\'s colour, so you can see at a glance that you are comparing, say, HRRR 10Z against IFS 06Z against GFS 00Z. Hover any of them for the full initialisation timestamp and how many hours old it is.',
        'Where a cycle can\'t be verified the panel says <b>run ?</b> rather than guessing. That is not hypothetical: the upstream metadata for CMC GEM has been frozen for weeks while the model itself keeps delivering current forecasts, so its stated run time would have put a two-month-old stamp on today\'s data. Anything more than three cycles stale is treated as unverifiable and simply not shown — the forecast is still plotted and still current, only the label is withheld.',
        '<b>The window now maximizes</b>, same as the SPC Mesoanalysis panel — the ⤢ button in the header fills the screen, and clicking again restores the previous size and position. Six traces on a 760 px chart is about where fine spread stops being readable; on a 1280×720 screen the plot goes from 750 px to 1254 px wide and from 353 px to 500 px tall. The chart also re-draws when you drag the panel\'s resize corner or resize the browser, instead of staying its old size in a bigger box.'
    ]},
    { date: 'Aug 11, 2026', items: [
        '<b>New layer: Storm Attributes (SCIT)</b>, under RADAR (NEXRAD). This is every NEXRAD\'s current storm cell table at once — around 700 cells from 60-plus radars in a single national pull, refreshed every 5 minutes.',
        'The existing Storm Tracks (STI) layer decodes one radar at a time, which is the right tool when you are already interrogating a storm. This is the other question: <i>where in the country should I be looking?</i> It also carries fields the single-site table does not — <b>maximum hail size</b>, <b>probability of severe hail (POSH)</b>, <b>probability of hail</b>, <b>VIL</b>, and the <b>height of maximum reflectivity</b>, which is what separates a tall skinny core from a real hail producer.',
        'Cells are coloured on the severe-hail ladder — blue below 0.75", yellow at the 0.75" severe threshold, orange past 1.00", red past 1.75", magenta past 2.50" significant-severe — and sized to match, so a hail threat reads at a glance from a CONUS view. A <b>white ring</b> marks a flagged mesocyclone, a <b>red ▼</b> marks a TVS, and the dashed line off each cell is its <b>30-minute projected position</b> at the reported motion.',
        'Click any cell for the full attribute readout. Labels declutter automatically and the largest hail wins the space, which matters when 700 cells share one screen.'
    ]},
    { date: 'Aug 10, 2026', items: [
        '<b>Fixed: in 4-pane mesoanalysis the bottom two charts were cut off.</b> The panes were sized from the panel\'s <i>width</i> only, so on anything shorter than about a 1000 px-tall screen the second row ran past the bottom of the panel — and because the panel clips rather than scrolls, those two charts were simply gone with no scrollbar to hint at it. Panes are now sized by whichever axis runs out first, so every pane is always fully on screen. Reproduced on a 1440×900 display, where panes 3 and 4 previously ended 206 px below the window.',
        'Scrolling would have been the wrong repair, incidentally — a four-pane comparison you have to scroll through only ever shows you two panes.',
        '<b>Click any chart to enlarge it, click again to go back.</b> Four 4:3 charts sharing one screen are each about 400 px wide on a laptop no matter how the window is arranged — that is arithmetic, not layout. So keep the 4-pane for spotting where the signal is, then blow one up to read it: on a 1280×800 screen that takes a pane from 412 px to 864 px.',
        'Also added a <b>maximize</b> button, and the panel now re-fits itself when you resize the window or drag its corner.'
    ]},
    { date: 'Aug 9, 2026 (update 2)', items: [
        '<b>SPC Mesoanalysis now splits into 1, 2 or 4 panes.</b> Mesoanalysis is a comparison tool — instability only means something next to the shear, and a composite only means something next to the ingredients underneath it. Flipping a single window between fields makes you hold the previous one in your head. Pick the pane count in the header and each pane gets its own parameter dropdown, all locked to the <b>same sector and the same valid time</b>, so what you are comparing is the fields and not the clock. A fresh 4-pane opens on MSL pressure, surface temp/dewpoint, lapse rates and effective SRH; your layout, the four parameters and the sector are all remembered for next time.',
        'The panel resizes itself to keep each chart legible — the mesoanalysis contour labels are small, so panes never shrink below roughly 620 px — and it clamps to your screen rather than growing off the edge.'
    ]},
    { date: 'Aug 9, 2026', items: [
        '<b>The Skew-T now lifts three parcels, not one.</b> A surface parcel is the wrong one to trust in exactly the situations a sounding matters most. Overnight and for elevated convection the air that actually rises starts <i>above</i> the surface, and a surface-based number reads near zero while a real storm threat sits overhead; conversely one overheated surface ob can inflate it. The panel now shows <b>SB</b>, <b>ML</b> (lowest-100 hPa mixed) and <b>MU</b> (most-unstable) side by side, each with its own CAPE, CIN, LCL, LFC, EL and LI. On this morning\'s KILX sounding SB read <b>24 J/kg</b> and MU read <b>2619</b> from a parcel at 949 hPa — the surface-only view called that sounding dead.',
        '<b>Effective-layer kinematics.</b> Fixed 0–1/0–3 km helicity assumes the storm ingests air from a fixed slab, which is why SPC moved to the <b>effective inflow layer</b> (Thompson et al. 2007) — the levels whose parcels actually have enough CAPE and little enough CIN to be ingested. Added effective SRH, effective bulk shear and <b>Bunkers</b> right-mover storm motion, plus the composites those feed: <b>significant tornado (STP)</b> and <b>supercell (SCP)</b>. The fixed layers are still shown alongside, because the difference between them is itself information.',
        '<b>New thermodynamics:</b> <b>DCAPE</b> for downdraft and wet-microburst potential, <b>0–3 km and 700–500 mb lapse rates</b>, freezing and −20 °C levels, and a true <b>wet-bulb zero</b> by Normand\'s construction rather than an approximation.',
        'The kinematics were checked against cases with known answers rather than eyeballed: a semicircle hodograph returns <b>314.2 m²/s²</b> against an analytic πR² of 314.2, a straight-line hodograph with storm motion on the line returns exactly <b>0</b>, and Bunkers deviates exactly <b>7.5 m/s</b> to the right of the mean wind. Everything runs in your browser in about 4 ms and adds no network calls, so it works identically on the observed balloon and on HRRR/GFS forecast soundings.'
    ]},
    { date: 'Jul 31, 2026', items: [
        '<b>WPC fronts: three of every thirty-five pressure centers were being dropped.</b> WPC hard-wraps the coded bulletin at 66 columns, so a pressure and its position regularly land on opposite sides of a line break ("… 1018 ⏎ 4187 …"). The parser read line by line, so every centre split that way vanished silently — on the current bulletin that was 2 highs and 1 low, and which ones are lost changes every cycle. Unpaired pressures now carry across the break. Verified against the raw bulletin: <b>17/17 highs and 18/18 lows</b>, where it had been 15 and 17.',
        '<b>You can now see how old the analysis is.</b> The bulletin\'s own <code>VALID</code> stamp was being discarded, so Data Health aged the fronts against <i>our last fetch</i> — meaning a surface analysis WPC had stopped updating still read as minutes old forever. Fronts are now aged against the analysis valid time, and the isobars against the file\'s Last-Modified (that product carries no time in its body). The legend shows both: <b>WPC FRONTS · 21:00Z</b>, <b>WPC ISOBARS 4mb · 22:22Z</b>.',
        'The staleness thresholds moved from 4 h to 5.5 h to match. That is not a loosening — it is the correction that goes with aging against valid time instead of fetch time. WPC analyses every 3 h and posts 1–1.5 h afterwards, so the current product is legitimately ~4.5 h old just before the next one lands; the old 4 h limit would have flagged a perfectly healthy analysis every single cycle.',
        '<b>Fronts and isobars now refresh every 10 minutes</b> instead of 30. The analysis is 3-hourly but does not arrive on the hour, so a slow poll could sit on the previous one for half an hour after the new one published. Both are small text files and only fetch while their layer is on.',
        'Also: the Atlantic cutoff that silently discarded any coded position east of 30°W has been removed (today\'s bulletin reaches 31°W — one degree from losing data), and a bulletin that decodes to nothing now reports an error instead of quietly blanking the layer.'
    ]},
    { date: 'Jul 30, 2026 (update 2)', items: [
        '<b>Surface analysis accuracy overhaul.</b> The isobars had a real defect: where a station did not report MSLP, the analysis reconstructed one from the altimeter setting. Those are different quantities — the altimeter reduces to sea level through the <i>standard</i> atmosphere, MSLP through the <i>observed</i> one. Measured against the stations reporting both, they differ by <b>2.9 mb on average and up to 20 mb</b> in the mountain West — more than the 2 mb contour interval, so over half the map was being drawn from a number that was not the field being contoured. On the current national set that was <b>1,323 of 2,575 stations</b>. Isobars are now analysed from true MSLP only; sites omit it precisely where sea-level reduction stops being meaningful, which is the same call NWS and WPC make.',
        '<b>Stale observations no longer anchor the analysis.</b> The feed returns each station\'s <i>last</i> report, which for an offline site can be days old — the oldest in the current set was <b>9.5 days</b>. Obs older than 90 minutes are now excluded, so an analysis is as current as it claims to be.',
        '<b>Sharper, honest gradients.</b> Interpolation was letting stations ~900 km away pull a grid point, then smoothing four more times, which flattened fronts into mush. Tightened the influence radius and halved the post-smoothing — the same fields now resolve roughly twice the detail. Contours also stop where the observations do, instead of being invented hundreds of km out over the Gulf, the Atlantic and Canada where there are no ASOS at all.',
        '<b>Better bad-sensor rejection.</b> The old quality check compared each station to the whole-CONUS spread, which throws away exactly the extremes an analysis exists to show — the core of a hurricane, an Arctic outbreak — while happily keeping a sensor stuck 15°F off in a uniform air mass. Each ob is now judged against the median of its own neighbours, which is what actually separates "broken" from "interesting".',
        '<b>Three new fields</b>, all direct observations rather than derived quantities, so they carry no reduction error: <b>Relative Humidity</b> (10%) for fire weather, <b>Isotachs</b> (5 kt) for wind maxima and gradient winds, and <b>Apparent Temperature</b> (4°F) — heat index in summer, wind chill in winter — for heat and cold hazards. All six surface fields refresh together on the METAR cycle and add no new network calls.'
    ]},
    { date: 'Jul 30, 2026', items: [
        '<b>Fixed: Storm Rel Velocity, CC, ZDR and KDP rendered nothing.</b> The NODD Level III products decode server-side and come back as a georeferenced PNG in a data URL. MapLibre loads an image source through <b>fetch()</b> rather than an <code>&lt;img&gt;</code> tag — so as far as the browser\'s Content-Security-Policy is concerned that is a <i>connect</i>, not an <i>image</i>. Our policy allowed <code>data:</code> under <code>img-src</code> but not under <code>connect-src</code>, so the fetch was blocked, the source resolved with no image attached, and the layer drew nothing. Worst of all it failed silently: the product legend and timestamp still appeared, so it looked like a radar with no echoes rather than a broken layer. <code>connect-src</code> now permits <code>data:</code>. This also restores the L3 loop, which draws its frames the same way.'
    ]},
    { date: 'Jul 28, 2026 (update 5)', items: [
        '<b>Fixed: the Skew-T location box would not accept typing.</b> The box sits in the panel header, which is also the drag handle. That handler cancels the mousedown so a drag does not select text — but a cancelled mousedown also means the browser never moves focus, so clicking the box did nothing and keystrokes went nowhere. It was excluding buttons and dropdowns from the drag, just not text inputs. All three draggable panels now share one exclusion list covering inputs, textareas and editable content, so this cannot come back on the next panel that gets a header field.'
    ]},
    { date: 'Jul 28, 2026 (update 4)', items: [
        '<b>Forecast soundings anywhere — not just balloon sites.</b> A radiosonde only goes up from ~57 places, but a model has a profile at <i>every</i> grid point, so there was never a reason to limit HRRR/GFS soundings to the RAOB list. Pick HRRR or GFS in the Skew-T and the site dropdown becomes a location box: type an airport id (<b>KMEM</b>, <b>KGPT</b>), a ZIP, a city, or raw <b>lat,lon</b> — or leave it blank to use the active pane\'s centre. RAOB still uses the fixed dropdown, because that is a real physical constraint. Lookups go cheapest-first: the RAOB table, then the ASOS set already in memory, then IEM station metadata, then geocoding — so the common case costs no network call at all.',
        'Sanity check at Slidell, where both are available: the 12Z balloon read SBCAPE 1447 / CIN −109 / PWAT 1.94 in, and HRRR at 14Z read SBCAPE 1918 / CIN −23 / PWAT 1.79 in — moisture within 8%, with CIN eroding and CAPE building exactly as two hours of July heating should. Gulfport, 85 km east and no balloon within reach, came out at SBCAPE 2922 / PWAT 2.01 in.'
    ]},
    { date: 'Jul 28, 2026 (update 3)', items: [
        '<b>LAMP convection and lightning rows added to MOS Guidance.</b> Short answer to "is there an HRRR MOS": no standalone one exists, and there never has been — HRRR\'s statistical station guidance ships <b>inside LAMP</b>, which MDL melds HRRR into for ceiling, visibility and the conditional CIG/VIS elements. LAMP was already in the panel; it just was not labelled as the HRRR product. It is now, and four rows IEM was already sending are now on screen: <b>LP1/CP1</b> (1-hour lightning and convection probability) and <b>LC1/CC1</b> (their potential, N/L/M/H). Convection means at least one lightning flash and/or radar ≥ 40 dBZ in the hour ending at that time. These run to 25 hours where the aviation elements go further, so the trailing blanks are the bulletin, not a gap.'
    ]},
    { date: 'Jul 28, 2026 (update 2)', items: [
        '<b>HRRR forecast soundings in the Skew-T.</b> The Skew-T panel now takes a source as well as a site: the observed <b>RAOB</b>, or a model forecast sounding from <b>HRRR</b> (3 km, out to 48 h) or <b>GFS</b> (out to 5 days), stepped by forecast hour. Every index the observed sounding produces — SBCAPE, CIN, Lifted Index, PWAT, LCL, LFC, EL, 0–1 and 0–6 km shear, the barbs and the hodograph — is computed identically from the model profile, so you can flip between the balloon and HRRR at the same site and read the difference straight off. The whole run is cached, so scrubbing hours after the first load is free.',
        'Cross-check on the first build: at KJAN the 12Z balloon gave PWAT 1.74 in / SBCAPE 1453, and HRRR at 13Z gave <b>PWAT 1.74 in</b> / SBCAPE 1845 — same moisture, more instability an hour into the heating. That the two paths agree on precipitable water is a decent sign the profile assembly is honest.',
        '<b>HRRR added to Model Comparison</b> alongside GFS, ECMWF IFS, CMC GEM, ICON and AIFS. Its trace simply ends around 48 h because that is the model; inside that window it is the convection-allowing solution, and the spread band now reflects six models rather than five.'
    ]},
    { date: 'Jul 28, 2026', items: [
        '<b>New MODEL GUIDANCE section.</b> Two panels: <b>Model Comparison</b> plots GFS, ECMWF IFS, CMC GEM, ICON and <b>ECMWF AIFS</b> at a point — panel centre or any ZIP/city — for temperature, dewpoint, wind, precip or MSLP out to 7 days. The shaded band is the inter-model spread and the readout gives mean and worst-case disagreement with the hour it peaks, because agreement is the confidence signal, not any one deterministic run. AIFS is ECMWF\'s operational AI model and draws dashed so it reads apart from the physics runs.',
        '<b>MOS Guidance</b> panel with MDL\'s station bulletins laid out the way they\'re issued — parameters down the left, projections across. GFS MOS (MAV), GFS Extended (MEX), <b>LAMP</b> (updated hourly, normally the freshest guidance on the page), NBM Short and Extended, plus NAM MOS flagged <b>RETIRING</b>. <b>Nearest</b> finds the closest ASOS to the panel centre from the METAR set already loaded.',
        '<b>On NAM:</b> NAM MOS ends <b>2026-10-06 12 UTC</b> with NAM, SREF, HREF and HiresW, replaced by RRFS/REFS — pushed back from the original Aug 31 date. <b>GFS MOS is not being retired</b>; MDL points NAM MOS users at GFS MOS or NBM. The panel says so rather than quietly serving a dying product.',
        'Model data is deliberately <b>point-based, never gridded</b>. Gridded contours were built and measured first: without a free CORS-open model WMS, the only workable route rate-limited at roughly 30 map draws per day. A point across five models costs about a thousandth of that. Both panels fetch only when opened — no polling, no map layers, no background traffic.',
        'There is no such thing as AI MOS, in case you were wondering — MDL station guidance is still classical regression and its successor is NBM, statistical blending rather than machine learning. The AI here is the model (AIFS), not the MOS.',
        '<b>Fixed: MOS projection hours were shifted by your timezone offset.</b> IEM returns MOS times as UTC values but writes them with no zone designator ("2026-07-28T06:00:00.000"), and a bare date-time is parsed as <i>local</i> by the browser — so every HR (Z) column was off by the local UTC offset (5 hours on US Central). A 06Z GFS MOS run read 07/10/13… instead of 12/15/18…. Times are now forced to UTC.',
        '<b>Each MOS bulletin now shows its issuance cadence and run age</b> — "7.2 h old, issued every 6 h, next ~12Z" — so an on-time cycle no longer looks stale, and a genuinely late one is flagged amber. Verified cycle by cycle against IEM\'s archive: <b>LAMP is hourly</b>; GFS MOS and NBM Short are 6-hourly (00/06/12/18Z); GFS Extended and NBM Extended are 12-hourly (00/12Z).',
        'The two NBM bulletins now say the quiet part out loud: the <b>NBM system runs hourly, but its station bulletins are only cut every 6 or 12 hours</b>. The hourly station product is <b>LAMP</b> — NBM\'s own hourly bulletin (NBH) exists but no CORS-open source publishes it, so the panel points you at LAMP instead.'
    ]},
    { date: 'Jul 27, 2026', items: [
        '<b>GOES-West is here, and satellite is now organized by sector.</b> A single <b>SECTOR</b> selector at the top of the Satellite group picks the bird and the scan area together: GOES-East gives CONUS, Full Disk, Puerto Rico / Caribbean and both mesoscale floaters; GOES-West adds <b>PACUS, Full Disk, Hawaii, Alaska</b> and its own two floaters. Eleven sectors in total, all sixteen ABI channels on each. It is per-panel, so the eastern Pacific can sit beside the Atlantic in a 2- or 4-pane layout — which is what the Pacific hurricane season actually needs.',
        '<b>One-minute mesoscale imagery.</b> The floater sectors are the fastest imagery GOES produces, and NWS/NHC park them on whatever is active — a hurricane, a severe outbreak, a wildfire. Because they roam, FX-Net reads each sector’s true footprint from the imagery’s own georeferencing and zooms straight to it when you select one. <b>ZOOM</b> does the same on demand for any sector.',
        'Refresh now follows the sector rather than one shared timer: mesoscale re-pulls every minute, CONUS/PACUS every 5, full disk every 10 — matching the rate the instrument actually scans instead of starving the fast sectors or hammering the slow ones. The panel legend names the bird and sector and carries that sector’s exact image valid time.',
        'The <b>GIBS</b> loopable products (GeoColor, Clean IR, Red Visible, Air Mass, Dust, Fire Temp) now follow the selected bird, so Pacific loops animate GOES-West frames on GOES-West’s own publication schedule. Their live view also draws from full disk instead of CONUS, so hybrid products no longer go blank the moment you pan offshore.',
        'Individual channels have no time-stepped GOES-West source, so rather than quietly looping GOES-East imagery over the Pacific, the loop now says so and points you at a GIBS product.',
        '<b>Fixed the dead link in the river gauge panel.</b> “Open on water.weather.gov” pointed at the old AHPS site, which NOAA retired in the NWPS cutover — the host no longer resolves at all, so the link failed to connect rather than returning a 404. It now opens the gauge’s NWPS page at <b>water.noaa.gov</b>, verified against 12 live gauges. The in-panel hydrograph was never affected; it already came from the NWPS API.'
    ]},
    { date: 'Jul 25, 2026', items: [
        '<b>Loops now time-match their products.</b> Streams publish at different cadences, and the loop used to step every one of them by position — so a 10-minute satellite over 5-minute radar ran at double speed and then froze on its newest image while the radar kept playing. For the back half of a 3-hour loop you were looking at current cloud tops over 90-minute-old reflectivity. Each stream is now matched to the master timeline by <b>valid time</b>, showing the frame that was genuinely current at that moment. Measured on a live 3-hour radar + GIBS loop, worst-case mismatch dropped from 151 minutes to 41 — and the 41 is real satellite publication lag, correctly held rather than faked.',
        'Loop controls gained <b>MODE</b> (Forward or Rock, which reverses at each end instead of wrapping) and <b>DWELL</b> (extra hold on the newest frame so the current data registers before the loop restarts).',
        '<b>Keyboard loop control</b>, the way D2D works during an event: <b>Space</b> play/pause, <b>←/→</b> step frames, <b>Home/End</b> jump to oldest/newest, <b>Esc</b> stop, <b>1–8</b> select a panel. Arrow keys are only claimed while a loop is running, so they still pan the map otherwise.',
        '<b>Product filter.</b> A search box above the sidebar tree filters all 136 products by name or category, auto-opening matching groups and highlighting the match — no more hunting through 18 collapsed categories.',
        'The diagnostic log now starts <b>collapsed</b> and remembers your choice. It was holding 150px of sidebar permanently; the product tree now gets roughly three times the room it had.',
        'Hardening: every network call now has a 45-second deadline (a hung upstream used to leave a request pending forever and stack more behind it), the fast warning/watch pollers no longer overlap themselves, feed-supplied text is escaped consistently everywhere it reaches a popup, and the app ships a strict <b>Content-Security-Policy</b>. Server-side, the proxies no longer echo internal error detail to the browser, and a dead unauthenticated logging endpoint was removed.'
    ]},
    { date: 'Jul 21, 2026 (update 2)', items: [
        'Active Storms &amp; Cones no longer depends on NOAA’s mirror staying healthy. When the cross-check finds NOAA’s tropical GIS service behind NHC (or unreachable), FX-Net now <b>automatically fails over to NHC’s own advisory graphics</b> — the same cone, forecast track, and coastal watches/warnings, pulled straight from the National Hurricane Center and regenerated on every advisory including intermediates. The badge reads <b>NHC DIRECT</b> in green, hovering it names the advisories in use, and the popup adds a “Source: NHC advisory graphics (direct)” line. It reverses automatically once NOAA catches up, and dissipated storms lingering in NOAA’s feed drop off while on NHC-direct. Verified live on Jul 21 with NOAA ~22 h stale: the map went from TD Two #5 to Bertha #8A and Fausto #10.',
        'Coastal watch/warning segments are now colored by hazard where the source identifies them — yellow TS Watch, blue TS Warning, pink Hurricane Watch, red Hurricane Warning — instead of all-red.',
        'The storm popup now falls back to NHC’s stated heading (e.g. “NW”) for the current position, where before it showed no Movement line at all because there is no earlier point to difference against.'
    ]},
    { date: 'Jul 21, 2026', items: [
        'Active Storms &amp; Cones now tells you when NOAA’s feed is behind. The cone/track comes from NOAA’s tropical GIS service, which can stall for many hours (it was ~22 h behind on Jul 21, still showing TD Two at advisory #5 when NHC had Bertha at #8A). FX-Net now cross-checks that feed against NHC’s authoritative storm index every refresh: the menu badge flips from LIVE to <b>STALE</b>, Data Health → NHC Storms is stamped with the feed’s own ingest time (so it goes red instead of looking healthy), and clicking a storm shows an OUT OF DATE banner naming the advisory on screen versus NHC’s current one. Everything else — Official Advisories, model guidance, Storm Trends, SHIPS and recon — reads from NHC/ATCF directly and stays current regardless.'
    ]},
    { date: 'Jul 19, 2026 (update 13)', items: [
        'New “Forecast History (run-to-run)” overlay under NHC Tropical. For the active storm it draws the storm’s actual traveled path (best-track, with fix dots colored by intensity) and overlays every past advisory’s official forecast track — newest bright, older ones faded — each anchored at the fixed position it was issued from. So you can see at a glance how the forecast has trended cycle to cycle and where the center has actually gone. Forecast tracks accumulate one per full (6-hourly) advisory, so a just-formed storm starts with one and fills in over time; the actual path is complete back to the invest stage.',
        'The Active Storms popup now shows the advisory issue time and clearly flags intermediate advisories (e.g. #1A) — NHC updates the position and watches on those, but the graphical forecast track/cone only refreshes on the next full advisory, which is why the cone can look “an advisory behind” between full runs.'
    ]},
    { date: 'Jul 19, 2026 (update 12)', items: [
        'The whole NHC section now follows ONE active storm. Picking a system in either storm dropdown (Model Guidance or Official Advisories) selects it everywhere — spaghetti tracks, intensity, Storm Trends, SHIPS, advisories, and recon all switch together. Both dropdowns now list the same union of systems (numbered storms and invests, Atlantic + Pacific).',
        'Recon is now storm-aware. The Hurricane Hunters map layer and the IN AIR badge track the storm you’ve selected, matching each flight to a storm by position (the HDOB storm field is often just a “CYCLONE” placeholder, so proximity is used instead). When aircraft are flying your selected storm the badge is a solid green IN AIR; when they’re airborne in a different system it dims to “IN AIR · AL02” so you can still see someone’s up — just not on your storm. Select an invest with no advisories and the advisory panel explains that official products begin once it’s designated.'
    ]},
    { date: 'Jul 19, 2026 (update 11)', items: [
        'Read NHC’s official text for any active storm. Under NHC Tropical → Official Advisories (per storm), pick a system from the dropdown and open its Public Advisory, Forecast Discussion, Forecast/Advisory, or Wind Speed Probabilities — the full authoritative product, straight from NHC. The dropdown lists every active storm (Atlantic + Pacific) with its current advisory number and age, and it maps each storm to the correct AWIPS product slot automatically (that slot rotates 1–5 through the season and can’t be guessed from the storm number — e.g. EP06 files under bin EP1), so you always get the right storm’s text.'
    ]},
    { date: 'Jul 19, 2026 (update 10)', items: [
        'AI models now have their own sub-tabs. Under Model Guidance → AI / ML Models (✦) there are dedicated Early Cycle AI Models and Late Cycle AI Models track views, so the data-driven guidance (GraphCast now, plus GenCast / AIFS / AI-GFS / AI-GEFS as NHC adds them) plots on its own instead of mixing into the physics spaghetti. The regular Early/Late Cycle Track Guidance are now physics-only. The intensity charts still show everything together with the ✦ marker so you can compare AI vs physics intensity side by side.'
    ]},
    { date: 'Jul 19, 2026 (update 9)', items: [
        'AI / machine-learning guidance is now first-class and clearly marked (✦). Already live in the track spaghetti: GraphCast (Google DeepMind). Added to the intensity charts: the Neural-Net Intensity Consensus (NNIC — NHC’s operational ML intensity model) and its baseline (NNIB). And FX-Net is now wired for the rest of NHC’s AI suite — GraphCast-deterministic, Google GenCast, ECMWF’s AIFS, AI-GFS, and AI-GEFS — so each will appear automatically the moment NHC starts distributing it in the a-decks. AI models carry a ✦ in the intensity legend, on their track end-labels, and in the click popup so you can tell data-driven guidance from the physics models at a glance.'
    ]},
    { date: 'Jul 19, 2026 (update 8)', items: [
        'Invest → tropical cyclone upgrades are now handled cleanly. When an invest is upgraded (AL91 → TD Two/AL02), both files linger in NHC’s archive, so the old invest used to keep showing in the Model Guidance dropdown with data frozen at its last pre-upgrade cycle. FX-Net now detects the upgrade (the invest and the numbered storm sitting on the same position) and removes the superseded invest from the list, automatically moving your selection to the upgraded system. So every product that follows the selector — spaghetti tracks, intensity charts, Storm Trends, SHIPS, and the CIRA RI/decapitation guidance — stays on the live TD Two data with nothing left pointing at the old AL91.'
    ]},
    { date: 'Jul 19, 2026 (update 7)', items: [
        'The Environment / RI (SHIPS) panel now also folds in CIRA’s rapid-intensification guidance: a “CIRA RI Consensus & Decapitation” block adds a second, independent RI probability estimate (30 kt/24 h, 25 kt/24 h, 45 kt/36 h) plus — new and not in SHIPS — the Convective Decapitation probability (odds the convection gets sheared off the low-level center and the storm rapidly weakens/decays), and current structure predictors (cold-cloud fraction &lt;−50 °C, IR core symmetry) that show how organized the storm is right now. Decapitation is the weakening counterpart to RI; green means low decap risk. Pulled straight from CIRA’s realtime product.'
    ]},
    { date: 'Jul 19, 2026 (update 6)', items: [
        'Environment / RI (SHIPS) joins NHC Tropical → Model Guidance: the environmental diagnostics behind the intensity forecast, so you can see whether the atmosphere and ocean favor strengthening. A color-coded table shows vertical wind shear, sea-surface temperature, mid-level humidity, ocean heat content, maximum potential intensity, and the SHIPS forecast wind at 0/12/24/48/72 h (green = favorable for intensification, red = hostile). Below it, the Rapid Intensification Outlook gives the consensus RI probabilities across every threshold, highlights the 24-hour number, and tells you how those odds compare to climatology. A plain-language banner up top reads FAVORABLE / MARGINAL / MIXED / HOSTILE with the specific reasons (e.g. “−high shear, dry mid-levels”). Data straight from NHC’s SHIPS text; follows the storm selector and refreshes every 15 minutes.'
    ]},
    { date: 'Jul 19, 2026 (update 5)', items: [
        'Storm Trends pressure axis flipped to the intuitive orientation: lower pressure values now sit at the bottom and increase going up. A deepening storm shows its pressure line falling toward the bottom while the wind line rises — the two lines cross as it intensifies, and the axis numbers read the way you expect.'
    ]},
    { date: 'Jul 19, 2026 (update 4)', items: [
        'STORM TRENDS joins NHC Tropical → Model Guidance: an observed intensity-history chart for the selected system (invests included) built from NHC’s live best track — wind (cyan, left axis) and central pressure (yellow, right axis) through the storm’s whole life, with classification changes (DB → LO → TD → TS…) marked along the top. Hurricane Hunter vortex fixes overlay in magenta (◆ = measured minimum pressure, ✕ = max flight-level wind) so you can see the aircraft measurements between the 6-hourly analyses. The header line gives the current intensity plus 6/12/24-hour pressure and wind tendencies, labeled DEEPENING / FILLING and STRENGTHENING / WEAKENING (red = intensifying). Auto-refreshes every 15 minutes while open and follows the storm selector.'
    ]},
    { date: 'Jul 19, 2026 (update 3)', items: [
        'Faster pickup when an invest is upgraded (AL91 → TD Two): the Model Guidance storm list now re-checks NHC every 15 minutes instead of hourly, and also re-checks every time you toggle a guidance view or open an intensity chart — so the new system’s a-deck (e.g. AL02) shows in the dropdown the moment models start tracking it. Reference for the tropical section’s cadences: Active Storms & Cones and Outlook Areas refresh every 5 minutes while on; recon HDOBs every 5 minutes visible / 15 in background; guidance tracks every 15 minutes. Note NHC’s own map services only carry a new depression once its FIRST advisory package posts — a webpage announcement alone has no data feed behind it.'
    ]},
    { date: 'Jul 19, 2026 (update 2)', items: [
        'Guidance accuracy audit (verified against the UCAR/RAL reference plots): HMON joins the model set — its raw runs in the late-cycle track and intensity views and its interpolated HMNI aid in the early-cycle views (it was the aid spiking AL91 to 76 kt that our chart was missing). SHIPS (no decay) reclassified from late to early-cycle intensity, where it belongs — the late intensity chart is now purely the raw dynamical runs (HAFS-A/B, HWRF, HMON, COAMPS-TC, GFS, Google DeepMind), matching how UCAR defines the experimental late plot. Reminder on cycle stamps: UCAR renders one frozen plot per init time; FX-Net plots each aid’s own newest run and flags how many are still on older cycles — same a-deck data, never stale.'
    ]},
    { date: 'Jul 19, 2026', items: [
        'Menu items that open panels now behave exactly like map-layer items: the item highlights while its panel is open, clicking it again closes the panel, and closing any other way (× or Esc) un-highlights it. Applies everywhere — VAD Wind Profile, Skew-T Soundings, Interactive Skew-T, SPC Mesoanalysis, Recon Schedule (TCPOD), Vortex Data Message, both Intensity Guidance charts, Text Browser, Forecast Meteogram, and the Atlantic / East Pacific TWO discussions.'
    ]},
    { date: 'Jul 18, 2026 (update 4)', items: [
        'Intensity guidance joins the spaghetti: two new items under NHC Tropical → Model Guidance open a kt-vs-forecast-hour chart built from the same live a-deck — Early Cycle Intensity (Decay-SHIPS, LGEM, the IVCN intensity consensus, HCCA, the interpolated HAFS-A/B, HWRF, COAMPS-TC, GFS and Google DeepMind aids, plus the NHC Official forecast) and Late Cycle Intensity (experimental — the raw synoptic-time runs). Dashed lines mark the TS and Category 1–5 thresholds, the legend is sorted by each model’s end-of-run intensity, and the freshness note shows the newest run time and any aids still on older cycles. Uses the same storm selector as the track spaghetti; Esc or × closes the chart.'
    ]},
    { date: 'Jul 18, 2026 (update 3)', items: [
        'Guidance freshness at a glance: a run-time stamp now sits under the Model Guidance storm selector — newest cycle (e.g. “00Z 19 Jul, 1.2 h ago”), how many aids are plotted, and how many are still on older runs (hover it for every model’s cycle). The Live Log line reports the same when you toggle a view. Data Health (TROPICAL group) gained two rows: Model Guidance, stamped with the model RUN time so it goes amber/red when a newer cycle should exist, and Recon HDOB Feed, refreshed by the background Hurricane Hunter check every 15 minutes.'
    ]},
    { date: 'Jul 18, 2026 (update 2)', items: [
        'Spaghetti models arrive under NHC Tropical → Model Guidance: the real ATCF a-deck tracks (the same data behind the UCAR/RAL guidance plots) drawn natively on the map for any active invest, depression, storm or hurricane. Pick the system from the dropdown, then choose Early Cycle Track Guidance (the interpolated aids available at advisory time — GFS, ECMWF, UKMET, HAFS-A/B, COAMPS-TC, Google DeepMind, consensus TVCN/HCCA and more), Late Cycle (the raw synoptic-time model runs), or GEFS Ensemble Members for the full 31-member EPS spread. Each model draws in its own color with its ID labeled at the end of its track; click any forecast point for the model name, cycle, valid time, and forecast intensity (max wind + category, MSLP). Tracks refresh every 15 minutes as new model runs arrive.'
    ]},
    { date: 'Jul 18, 2026', items: [
        'Hurricane Hunters come to the NHC menu: a live Recon Flight Obs map layer plots the aircraft’s actual track from its 30-second observations (wind-colored points, callsign label on the newest position, click any point for SFMR surface wind / flight-level wind / extrapolated pressure), with an IN AIR badge that turns green whenever a Hurricane Hunter is transmitting. Recon Schedule (TCPOD) shows CARCAH’s daily flight plan — which aircraft fly which storm and when — and Vortex Data Message shows the latest center fix from inside the storm. See the User Guide → Tropical for details.'
    ]},
    { date: 'Jul 10, 2026 (update 3)', items: [
        'Text Browser fix — TAFs (and other airport-filed products) now load for every WFO. TAFs are filed under airport IDs rather than the forecast office code (Memphis’ TAFs live under MEM/TUP/etc., not MEG), so offices whose code doesn’t match an airport showed “No Products Found”. The browser now falls back to querying by issuing office, which works for all 122 WFOs. Also fixed the stray “Error: HTTP 404” that appeared when pressing FETCH PRODUCT with an empty product list.'
    ]},
    { date: 'Jul 10, 2026 (update 2)', items: [
        'New USER GUIDE: a full-screen reference manual for the whole workstation, opened from the USER GUIDE button under What’s New. Larger, readable text; a table of contents to jump straight to any topic (radar tilts, loops, procedures, analysis tools…); and a search box that filters the guide and highlights matches. What’s New stays as the short release log — the deep how-it-works documentation now lives in the guide. The What’s New text also got a small readability bump.'
    ]},
    { date: 'Jul 10, 2026', items: [
        'WPC QPF no longer mirrors across panels: selecting Day 2 QPF in one panel used to silently flip every other panel’s QPF to Day 2 (and vice versa). QPF product choice is now truly per-panel — Day 1 / Day 2 / Day 3 can each live in their own pane, like the ERO products already did. The same cross-panel mirroring was fixed for MRMS QPE periods (1/24/48/72-hr) and the CPC temperature & precipitation outlooks.',
        'Distance/Bearing tool: DOUBLE-CLICK now finishes the line — it freezes on screen with its totals (no more rubber-band segment chasing the cursor off the edge of the pane), the map no longer zooms on that double-click, and the accidental stacked points it used to drop are cleaned up automatically. Click again to start a fresh line; Esc or re-clicking the tool still exits.'
    ]},
    { date: 'Jul 8, 2026', items: [
        'Multi-panel loops now start in sync: in a 2/4-panel loop, panel 2+ no longer joins mid-cycle after panel 1 is already halfway through. Frame imagery downloads pane-by-pane, and the loop used to start on a fixed timer while later panes were still loading. Play now waits until every panel reports its frames loaded (capped at ~12–20s so a slow tile can’t stall it), shows the first frame while loading, and logs when all panes are ready.'
    ]},
    { date: 'Jul 7, 2026 (update 3)', items: [
        'Dual-pol & SRM products now animate: NODD Level III products (Storm Relative Velocity, CC, ZDR, KDP) join the loop. Press play with one active and the workstation pulls that pane’s recent volume scans from the NEXRAD archive (up to 10, decoded on the fly), then steps them in time with any radar/satellite loop. Works per pane — a 4-panel with SRM in one pane and reflectivity in another loops both, each on its own product — and the pane label shows the product and scan time per frame. The loop takes a few seconds to preload while the scans decode.'
    ]},
    { date: 'Jul 7, 2026 (update 2)', items: [
        'Loop fix for multi-tab workspaces: stopping a radar/satellite animation no longer paints the national radar mosaic or a default IR satellite image onto your OTHER tabs. The stop-restore step was touching every pane in every tab instead of only the panes that were actually in the loop — panes that never had a satellite channel assigned were being force-shown the source’s default (IR) imagery. Restore is now strictly scoped to the loop’s own tab.',
        'Switching workspace tabs while a loop is running (or paused) now ends the loop cleanly first — the old tab gets its live layers back instead of being left frozen on an animation frame you’d have to clear manually.'
    ]},
    { date: 'Jul 7, 2026', items: [
        'Radar tilt fix — Storm Relative Velocity: stepping SRM up through the elevation angles now works. The tilt ladder previously asked for products that don’t exist above 0.5° (the native SRM is only made at the lowest cut, and the higher velocity tilts use different product codes than assumed). SRM now derives each tilt from the velocity product actually in the feed — 0.5° → 0.9° → 1.3° → 2.4° — always subtracting the storm motion from the 0.5° header. CC/ZDR/KDP tilt stepping was also corrected to the true lowest four cuts (0.5/0.9/1.3/1.8°; it previously skipped 0.9° and jumped to 2.4/3.4°). If a tilt isn’t in the radar’s current scan strategy, the log now says so plainly instead of failing silently.'
    ]},
    { date: 'Jul 6, 2026 (update 2)', items: [
        'Procedures are now multi-pane: “Save Current Display…” records the pane layout plus every visible pane’s map view, imagery and overlays — so a 4-panel severe setup (outlook / tornado / wind / hail) reloads as all four panels, not just the last one you touched. Loading a procedure switches the tab to the saved layout, clears each pane, and rebuilds it. Bundles saved before this update still load the old way (active pane only) — just re-save them once to upgrade.'
    ]},
    { date: 'Jul 6, 2026', items: [
        'Your workspace now truly saves: reloading the app brings back everything, not just the tab names. Every pane restores its map position and zoom, its radar/satellite imagery, AND all overlay products — warnings, watches, SPC outlooks, METARs, fronts, aviation layers, buoys… exactly as you left them. The snapshot autosaves every 15 seconds and on close.',
        'Multi-tab fix: panes in tabs you hadn\'t visited yet no longer lose their saved setup — the snapshot carries un-visited tabs forward instead of overwriting them.',
        'The NWS Warnings state/WFO filter is remembered across sessions, so AlertViz toasts stay scoped to your area without re-selecting it every time.',
        'Settings backup: two new ANALYSIS TOOLS items export ALL workstation settings (workspaces, procedures, filters, preferences) to a JSON file and import them back — move between browsers/machines or keep a safety copy.'
    ]},
    { date: 'Jul 3, 2026 (evening)', items: [
        'SPC Mesoanalysis — full catalog: the viewer now carries everything on SPC’s own page (~140 parameters in 11 grouped menus): surface analyses and 2-3 hour change fields, upper-air charts for 925/850/700/500/300 mb with frontogenesis at seven levels and jet-circulation dynamics, the complete thermodynamics and wind-shear suites, all composite indices (supercell, sig tornado, SARS hail, derecho, microburst, VTP…), multi-parameter combos, heavy-rain, winter-weather and fire-weather sets, plus the classic/beta indices. Every parameter code was verified live against spc.noaa.gov and labeled with SPC’s official menu name.',
        'Meso / TVS markers (MDA): a new RADAR item plots the NEXRAD Mesocyclone Detection Algorithm output — every detected circulation as an open circle colored by strength rank (yellow → orange → red), with a red ▼ when the TVS flag is set. Click one for strength rank, rotational velocity, base/depth, motion and MSI. Follows the volume-scan refresh like STI.',
        'SPC Mesoanalysis viewer: an SPC-PRODUCTS panel with the hourly RAP-based objective analysis — 11 sectors (all verified against SPC’s own basemaps) and 12 parameters from MSL pressure and CAPE through effective SRH, supercell composite and significant-tornado parameter.',
        'SPC Day 4-8 Severe Outlook: the extended probabilistic outlook joins Days 1-3, all five days merged on one layer with D4-D8 tags; click an area for probability and valid date.',
        'Center Weather Advisories (CWA): short-fuse CWSU aviation warnings as dashed magenta areas under AVIATION, with the raw advisory text on click.',
        'NDBC marine buoys: a SURFACE ANALYSIS item plots ~700 coastal and offshore buoys/C-MAN stations (water temp + wave height labels at zoom; click for wind, waves, pressure, temps).',
        'Freshness pass from tonight’s audit: MRMS Echo Tops/QPE now refresh every 5 min (was 30 — MRMS regenerates every 2), satellite every 5 min (was 10 — matches GOES CONUS scans), LSRs every 5 min during events (was 30), and the NDFD grid re-pulls every 30 min with a Data-Health row (it previously never refreshed after toggle-on).',
        'Under the hood: removed ~300 lines of duplicated code (the local dev server now imports the same Vercel functions it mirrors; the radar decoder’s three copies of block-locate/render plumbing collapsed into shared helpers; the six GeoJSON feed loaders are one config-driven function). Local dev server binds loopback only; production now sends nosniff/frame/referrer security headers; Skew-T ignores stale responses when you switch stations quickly.'
    ]},
    { date: 'Jul 3, 2026', items: [
        'Security hardening: the sounding proxy (/api/raob) now validates the station and WMO id before building an upstream request, and the live-log escapes alert/warning text — closing two low-severity injection paths found in a code audit.',
        'Data Health now covers everything: the monitor gained an AVIATION section (SIGMET/AIRMET, G-AIRMET, PIREPs, TAF) and a ProbSevere row under SPC Products, each with a live red/amber/green freshness dot — so every auto-refreshing feed on the workstation is accounted for.',
        'AlertViz now follows your WATCHDOG filter: with “All states / All WFOs” selected, a new Tornado, Severe Thunderstorm or Flash Flood Warning anywhere still pops a corner toast; but when you narrow the NWS Warnings filter to a state or a single office, only new warnings for that state/WFO pop up — so you get a targeted heads-up instead of nationwide noise.',
        'Graphical AIRMET fix: G-AIRMET areas now display reliably. The AWC feed issues hazard snapshots at forecast hours 0/3/6 and which hours are present rotates with the issuance cycle; the layer previously showed only hour 0 and came up empty whenever that snapshot wasn’t in the current cycle. It now shows the nearest-term snapshot available.',
        'Sharper Storm-Relative Velocity: SRM is now derived on the fly from the super-resolution base velocity (0.25 km range, 0.5° azimuth, 256 levels) with the mean storm motion removed — roughly 8× the detail of the old 16-color product-56 image, so velocity couplets and mesocyclones read cleanly instead of blocky. It matches the official product’s inbound/outbound pattern ~93% and still labels the storm motion it subtracted (e.g. “SM 246°/26 kt”). If a tilt’s base velocity isn’t in the current scan strategy, it falls back to the legacy SRM automatically.',
        'Interactive Skew-T upgrade: soundings now pull the high-resolution BUFR profile (thousands of levels, ~1–2 s radiosonde data) from the University of Wyoming — much smoother, more detailed temperature/dewpoint traces — and fall back to the standard decoded RAOB when high-res isn’t available. The panel header shows the level count and which source it used. CAPE/CIN are now computed with the virtual-temperature correction (the SPC/SHARPpy convention), so instability values line up with the numbers you’d see on an SPC sounding instead of reading systematically low. PWAT was cross-checked to within 0.1 mm of the official value.',
        'Interactive Skew-T (NSHARP-lite): a new SPC-PRODUCTS item, “Interactive Skew-T (RAOB),” opens a live radiosonde sounding for the upper-air site nearest the pane center (pick any of ~55 sites, or an earlier 00/12Z cycle). It draws the temperature and dewpoint traces on a real skew-T/log-P grid with a lifted surface parcel and shaded CAPE, wind barbs up the right margin, and a 0–10 km hodograph — plus computed SBCAPE, SBCIN, Lifted Index, PWAT, LCL/LFC/EL and 0–1 / 0–6 km bulk shear. All the thermodynamics run in your browser.',
        'Graphical AIRMETs (G-AIRMET): the AVIATION group now plots the AWC’s gridded AIRMET hazard areas (turbulence, icing, IFR, mountain obscuration, surface winds, low-level wind shear, freezing level) as color-coded polygons; click one for the hazard, product, forecast hour and cause.',
        'Terminal Forecasts (TAF): airports now plot as dots colored by the current prevailing flight category (VFR/MVFR/IFR/LIFR). Click a site for its wind, visibility, ceiling, sky cover and valid period.',
        'NDFD forecast grid: a “Surface Temperature (°F)” raster under SURFACE ANALYSIS → Forecast Grids overlays the National Digital Forecast Database temperature grid (the one gridded NDFD parameter NWS still serves publicly).',
        'Radar all-tilts: NODD Level III products (SRM, CC, ZDR, KDP) can now be stepped through the lowest four elevation angles. When one is active, an “Elevation tilt” control appears under the NODD list — ▲/▼ moves up/down the volume, and the pane legend shows the actual beam angle.',
        'Storm Tracks (STI): a new NODD item plots the radar’s storm-cell centroids with their ID and max reflectivity, plus each cell’s forecast track (15/30/45/60-minute positions). Click a cell for max dBZ, storm-top height, and movement.',
        'VAD Wind Profile: a new NODD item opens a panel showing the winds aloft over the selected radar as a stack of wind barbs by altitude, alongside a hodograph — quick read on shear and veering without leaving the workstation.'
    ]},
    { date: 'Jul 3, 2026', items: [
        'ProbSevere (CIMSS): NOAA\'s machine-learning storm-object guidance is now a layer under SPC PRODUCTS. Each tracked storm is outlined and labeled with its probability of becoming severe; click it for the Severe / Tornado / Wind / Hail probabilities plus the environment behind them (MUCAPE, effective shear, MESH hail size, VIL, reflectivity and storm motion). Updates about every 2 minutes.',
        'Aviation hazards: a new AVIATION group adds SIGMETs / AIRMETs (convective, turbulence, icing, IFR, mountain obscuration — color-coded by hazard, click for the full text and valid times) and PIREPs (pilot reports; click for the raw report, aircraft, flight level, temperature and wind).',
        'Analysis tools (AWIPS-style interrogation): Distance / Bearing (click two points for great-circle range and heading), Range Rings (25/50/100/150/200 nm around the active radar site or map center), and Storm Motion & ETA (click a storm\'s previous and current position to get its speed and direction, then click any location for its estimated time of arrival).',
        'AlertViz notifications: when a new Tornado, Severe Thunderstorm or Flash Flood Warning is issued, a corner toast pops up (with an optional alert tone) so you don\'t have to be watching the ticker.',
        'Procedures: save the current display — every active layer, the map view and the pane layout — as a named bundle under ANALYSIS TOOLS, and reload it in one click later.',
        'Live river-gauge popups now draw a native observed-plus-forecast hydrograph with the flood-stage thresholds marked, instead of a static image.'
    ]},
    { date: 'Jul 1, 2026', items: [
        'Warnings and Advisories are now separate toggles under NWS WARNINGS — "Active Warnings" shows only true warnings (Tornado, Severe Thunderstorm, Flash Flood, etc.), and a new "Advisories & Statements" item shows advisories, statements, alerts and outlooks on their own — just like Active Watches already worked. Turn on either or both; each gets its own pane-legend row, and clicking an area still pops up the full bulletin. The click-to-query popup now respects the split too: with only Warnings on it lists just the warnings at that spot (no advisories mixed in), and vice-versa.',
        'Much fresher live satellite for Clean IR and Red Visible — the live (non-looping) view of these two products now comes from IEM\'s per-channel GOES-East cache, typically 5–10 minutes behind the actual scan instead of the ~45–60 minute publication lag of the NASA GIBS feed. The pane legend shows the exact image valid time. Loops still run on GIBS timestamped frames (IEM has no time history), so animation quality is unchanged — you get the fresh frame live and the clean loop when animating.',
        'Under-the-hood hardening pass from a full code audit: the map engine (MapLibre) and icon library are now bundled with the app instead of loaded from a third-party CDN, so an outside outage or a bad library release can never take the workstation down.',
        'API responses are now properly cached at the network edge — outlook, drought, river-gauge and MPD layers load noticeably faster on repeat visits, and the app is far gentler on the NOAA source servers.',
        'All alert bulletins, storm-report remarks, and river-gauge popups now render feed text safely (script-injection hardening), and the in-app diagnostics log no longer grows without limit during long sessions.',
    ]},
    { date: 'Jun 27, 2026', items: [
        'Storm Relative Velocity (SRM) added under Radar → NODD (Level III), at the 0.5° tilt like the other site products. This is the true storm-relative product (NEXRAD product 56, the same one AWIPS shows) — base velocity with the storm-motion vector removed — so rotation and mesocyclone couplets stand out. Green is inbound, red is outbound, magenta is range-folded; the pane legend shows the scan time and the storm motion that was subtracted (e.g. “SM 235°/12kt”).',
        'Dual-pol / Level III overlays (SRM, CC, ZDR, KDP) now bypass any browser/edge caching on each refresh, so every 2-minute poll lands on the newest volume scan from the NODD bucket.',
    ]},
    { date: 'Jun 26, 2026', items: [
        'Click any SPC outlook area to read its discussion — like the NHC tropical outlook. Clicking a convective categorical or probabilistic risk area, or a fire weather area (Day 1–8), pops up the category/probability and a “View Full Discussion →” button that loads the official SPC narrative for that day right in the text browser.',
        'SPC Fire Weather Outlooks added under Fire & Smoke — Day 1 through Day 8. Days 1–2 show the full categorical product (Elevated, Critical, Extremely Critical, shaded in SPC’s own colors and outlined, with dry-thunderstorm areas as dashed boundaries); Days 3–8 show the extended Critical Risk areas. A color key shows in the bottom-left of the pane, the pane legend timestamps it, and it refreshes with new issuances.',
        'Corrected NWS region groupings in the SITE and Skew-T station menus so every office sits under its official region. Soundings: Nashville (BNA), Norman (OUN), Fort Worth (FWD) and Albuquerque (ABQ) moved to Southern; Wilmington OH (ILN) to Eastern; Glasgow MT (GGW) to Western; Denver (DNR) and Riverton (RIW) to Central. Radar: the New Mexico sites (ABX, FDX, HDX) moved to Southern. (Paducah, PAH, stays in Central — Kentucky is a Central Region office.)'
    ]},
    { date: 'Jun 25, 2026', items: [
        'Every product in the pane legend now carries a freshness time. Radar and satellite show the imagery valid time; the rest (HMS Smoke, Active Fires, lightning, METARs, surface analysis, SPC/WPC products, warnings, tropical, climate, river gauges, etc.) now show the last time that feed was pulled from the source — so you can tell at a glance how current each layer is.',
        'The Data Health monitor is now organized into collapsible sections that mirror the menu — Radar & Lightning, Satellite, Surface Analysis, Warnings & Watches, SPC Products, WPC Products, Tropical, Climate & Outlooks, Fire & Air, and Hydro & Solar. Each section header carries a status dot (red/amber/green) showing the worst feed inside, click to fold it away, and your choices are remembered.',
        'SPC probabilistic hazard outlooks added under SPC Products — Day 1 and Day 2 Tornado, Wind, and Hail probabilities, in their own sub-sections beneath the convective outlooks. Uses the official SPC probability colors and SPC’s new Conditional Intensity Group hatching for significant-severe areas (Intensity 1 sparse, 2 dense, 3 cross-hatch). A color + intensity key shows in the bottom-right of the pane, and it refreshes with new issuances.',
        'Workspace tabs can be renamed — double-click a tab (e.g. “Tab 1”) and type a name like “Gulf Coast” or “Severe Setup”. (Fixes the double-click that previously did nothing.)',
        'GOES-East satellite now shows the image valid time in the pane legend — both the individual ABI channels (e.g. “GOES-E CH2 SATELLITE · 17:43Z”) and the looping composites (“GOES-E GEOCOLOR · 16:30Z”). The time advances automatically as newer imagery publishes.',
        'Day/Night Terminator is now clearly visible — deeper night shading, a dusk-blue civil-twilight band, and a brighter amber terminator line. When it’s on, the map turns into a sun-times tool: a hint appears, the cursor becomes a crosshair, and clicking anywhere (in any pane) pulls up sunrise/sunset, twilight, solar noon, day length, and declination for that spot.',
        'The whole left menu now folds away horizontally — click the « button in the header (or press Ctrl/⌘+\\) to slide it off-screen and give the map full width; a handle on the left edge brings it back. Your choice is remembered between sessions.',
        'Left sidebar sections are now collapsible — click any category header to fold it away (your choices are remembered), plus Expand all / Collapse all at the top. By default the menu opens lean (Warnings, Radar, and Satellite expanded; the rest one click away).'
    ]},
    { date: 'Jun 24, 2026', items: [
        'Site radar now shows a live WSR-88D status readout — operational state, VCP / scan mode (precip vs clear-air), alarms, and Level-II latency — right in the radar window beneath the product label.',
        'New Forecast Meteogram (NWS Products → Forecast Meteogram): a clean temperature/dewpoint, precip-probability, and wind chart in a draggable window like the Text Browser. Pick a location by ZIP code, city name (“Norman, OK”), or the active pane’s map center; choose a range from 12 h out to ~6.5 days; and hover the chart for an exact hour-by-hour readout with a crosshair.'
    ]},
    { date: 'Jun 18, 2026', items: [
        'Site radar and dual-pol (CC/ZDR/KDP) now show the volume-scan valid time in the pane label (e.g. “HDC BREF 0.5° · 13:18Z”), and it updates as each new scan comes in.',
        'Fixed site radar flickering between the current and previous scan while zooming — all zoom levels now lock to one scan.',
        'Site radar now checks for new volume scans every minute (was 5), so the latest scan appears as soon as it lands.',
        'New “Warnings: Outline” display mode (right-click a pane) — bold severity-colored borders with minimal fill so numerous overlapping warnings stay legible. The most urgent warning (tornado → severe → flash flood) always draws on top.'
    ]},
    { date: 'Jun 17, 2026', items: [
        'Tropical data now refreshes every 5 minutes (was 30) — new NHC advisories show up promptly.',
        'In multi-pane layouts you can view a different radar (WFO) in each pinned pane — e.g. HDC and JAN side by side.',
        'Added this “What’s New” panel.'
    ]},
    { date: 'Jun 16, 2026', items: [
        'Workspace tabs: open independent multi-pane layouts and flip between them instantly.',
        'Pin a pane (right-click) to give it its own view — e.g. hold a storm on satellite while the radar panes pan elsewhere.',
        'Sharper map boundaries: white state / county / coastline lines that read clearly over radar and satellite.',
        'Air Quality: click a monitor to see the Today + Tomorrow ozone and PM2.5 forecast, color-coded by AQI level.',
        'Smoother satellite loops — the Red Visible band no longer flashes blank frames.',
        'Potential Tropical Cyclones (PTC) are now shown distinctly on the tropical layer.'
    ]}
];

function initWhatsNew() {
    const panel = document.getElementById('whats-new');
    const header = document.getElementById('whats-new-header');
    const body = document.getElementById('whats-new-body');
    const dot = document.getElementById('whats-new-dot');
    if (!panel || !header || !body) return;

    body.innerHTML = CHANGELOG.map(rel =>
        `<div class="whats-new-rel"><div class="whats-new-rel-date">${rel.date}</div>` +
        rel.items.map(it => `<div class="whats-new-item">${it}</div>`).join('') +
        `</div>`).join('') +
        `<div class="whats-new-guide-link">Full feature documentation lives in the <a id="whats-new-open-guide">User Guide</a>.</div>`;
    document.getElementById('whats-new-open-guide')?.addEventListener('click', e => {
        e.stopPropagation();
        document.getElementById('user-guide-btn')?.click();
    });

    const latestId = CHANGELOG[0].date;
    let seen = null;
    try { seen = localStorage.getItem('fxnet_whatsnew_seen'); } catch (e) {}

    const setOpen = (open) => {
        body.style.display = open ? 'block' : 'none';
        panel.classList.toggle('open', open);
        if (open) {
            try { localStorage.setItem('fxnet_whatsnew_seen', latestId); } catch (e) {}
            if (dot) dot.style.display = 'none';
        }
    };

    if (dot) dot.style.display = (seen === latestId) ? 'none' : 'inline-block';
    header.addEventListener('click', () => setOpen(body.style.display === 'none'));
    // Auto-expand ONCE when there's an unseen release; collapsed on later loads.
    setOpen(seen !== latestId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 25c: USER GUIDE (full-screen reference manual)
// ═══════════════════════════════════════════════════════════════════════════════
// Task-organized documentation for every workstation feature — the "how does it
// work" companion to What's New's "what changed". Static content, TOC sidebar,
// live search with highlighting. Readable body text by design (field request).

const USER_GUIDE = [
    { id: 'start', title: 'Getting Started', html: `
        <p>FX-Net NextGen is a browser-based forecaster workstation: an interactive map (or several) with live NWS/NOAA data layered on top. Everything is driven from the <b>product sidebar</b> on the left — click a product to turn it on, click it again to turn it off.</p>
        <h3>Finding a product</h3>
        <p>The <b>filter box</b> at the top of the sidebar searches all products by name or category — type “vel” for velocity products, “trop” for everything tropical. Matching groups open automatically regardless of whether they were collapsed, and the matched text is highlighted. Clear the box (or press <b>Esc</b> in it) to return to the full tree.</p>
        <h3>Panels (panes)</h3>
        <ul>
            <li>The layout buttons in the bottom toolbar switch between <b>1, 2, 4, and 8 panel</b> displays.</li>
            <li>One panel is always the <b>active panel</b>, marked with a cyan border. Sidebar clicks, the SITE selector, and the analysis tools apply to the active panel only — click any panel to make it active.</li>
            <li>Panels in a tab <b>pan and zoom together</b>. The pin control in a panel’s corner unlocks that panel to hold an independent view.</li>
            <li>Each panel keeps its own imagery: different radar sites, satellite channels, QPF days, etc. per panel.</li>
        </ul>
        <h3>Radar site selection</h3>
        <p>The <b>SITE selector</b> (top right) switches the active panel between the <b>National Mosaic</b> and any single NEXRAD site. Site-specific products (velocity, dual-pol, tilts) need a site selected.</p>
        <h3>The diagnostic log</h3>
        <p>The <b>DIAGNOSTIC LOG</b> (bottom of the sidebar) narrates what the workstation is doing — data loads, loop status, errors. When something seems stuck, look there first. It starts collapsed so the product tree gets the room; the <b>bug icon</b> in the bottom toolbar or the log's own header opens it, and it stays however you leave it.</p>` },

    { id: 'tabs', title: 'Workspace Tabs & Autosave', html: `
        <p>The tab bar across the top works like browser tabs — each tab is an independent workspace with its own panel layout and products.</p>
        <ul>
            <li><b>+</b> adds a tab, <b>×</b> closes one.</li>
            <li>Panel layout, per-panel imagery, overlays, and map views are all <b>per tab</b>.</li>
            <li>Overlay products you turn on are global to the panel they’re applied to, and stay put when you switch tabs.</li>
        </ul>
        <h3>Autosave</h3>
        <p>Your whole workspace <b>saves automatically every 15 seconds</b> and when the page closes. Reloading the app restores every tab: layouts, map positions and zoom, radar/satellite imagery, and all overlay products — exactly as you left them. There is nothing to press; it just happens.</p>
        <p>To move your setup to another computer or browser, use <b>Export Settings to File…</b> (see <b>Settings Backup</b>).</p>` },

    { id: 'radar', title: 'Radar — NEXRAD, Dual-Pol & MRMS', html: `
        <h3>Reflectivity (National vs SITE)</h3>
        <p><b>Reflectivity</b> shows the national mosaic until you pick a site in the SITE selector — then it switches to that site’s super-resolution base reflectivity. <b>Velocity, Hydrometeor Class, Storm Total Precip,</b> and <b>One-Hour Precip</b> are site products (SITE badge) and follow the selected site.</p>
        <h3>Dual-pol / NODD Level III (multi-tilt)</h3>
        <p>The <b>NODD (Level III)</b> products — <b>Storm Relative Motion, Correlation Coefficient, Differential Reflectivity (ZDR), Specific Differential Phase (KDP)</b> — are decoded straight from the NEXRAD Level III archive for the selected site.</p>
        <ul>
            <li>A <b>tilt stepper</b> appears on the panel: step up/down through elevation angles. CC/ZDR/KDP cover the lowest four cuts (0.5&deg; / 0.9&deg; / 1.3&deg; / 1.8&deg;); SRM steps 0.5&deg; &rarr; 0.9&deg; &rarr; 1.3&deg; &rarr; 2.4&deg;.</li>
            <li>If a tilt isn’t in the radar’s current scan strategy, the log says so plainly.</li>
            <li>The <b>VAD Wind Profile</b> shows the radar-derived wind profile above the site.</li>
            <li><b>Meso/TVS and Hail Index markers</b> plot the radar’s own detected circulations and hail signatures.</li>
        </ul>
        <h3>MRMS (national)</h3>
        <p><b>Echo Tops</b> and <b>QPE</b> (1 / 24 / 48 / 72-hr radar+gauge precip estimates) are national MRMS mosaics. QPE period is <b>per panel</b>. Hovering the map with a site radar or MRMS product up shows a decoded <b>value readout</b> (dBZ, kt, inches) in the bottom toolbar.</p>` },

    { id: 'satellite', title: 'Satellite — GOES & GIBS', html: `
        <h3>Picking a bird and sector</h3>
        <p>The <b>SECTOR</b> selector at the top of the Satellite group chooses both the satellite and the scan area. It is <b>per panel</b>, so you can watch GOES-East CONUS in one panel and the eastern Pacific in another.</p>
        <ul>
            <li><b>GOES-East (75°W)</b> — CONUS, Full Disk, Puerto Rico / Caribbean, Mesoscale 1 &amp; 2</li>
            <li><b>GOES-West (137°W)</b> — PACUS (West CONUS), Full Disk, Hawaii, Alaska, Mesoscale 1 &amp; 2</li>
        </ul>
        <p>Sector sets the refresh rate too, because it is the rate the ABI actually scans: <b>mesoscale every minute</b>, CONUS/PACUS every 5, full disk every 10. The panel legend shows the bird, the sector and the image's exact valid time.</p>
        <h3>Zoom</h3>
        <p><b>ZOOM</b> fits the panel to the selected sector's real coverage, read live from the imagery's own georeferencing. This matters most for the two <b>mesoscale floaters</b>, which NWS and NHC reposition over whatever is active — a hurricane, a severe outbreak, a fire — so their location changes through the day. Choosing a floater zooms to it automatically.</p>
        <h3>Tropical use</h3>
        <p>For the eastern Pacific basin use <b>GOES-West Full Disk</b> or <b>PACUS</b>; for the Atlantic use <b>GOES-East Full Disk</b> or <b>Puerto Rico / Caribbean</b>. When a storm is being watched closely, check whether a mesoscale floater is parked on it — one-minute imagery resolves eye formation and convective bursts that a 10-minute loop misses entirely.</p>
        <h3>Loopable GIBS imagery</h3>
        <p>The <b>Loopable &middot; NASA GIBS</b> products use NASA’s global imagery tiles with real archived frame times, which makes them the smoothest choice for <b>animation loops</b> — no gaps or flicker, and you can pan/zoom mid-loop. They follow the bird you picked in SECTOR, and unlike the channel tiles they cover the full disk including the southern hemisphere.</p>
        <p>Looping the Pacific needs a GIBS product: the individual channels have no time-stepped GOES-West source, so the loop will tell you to switch rather than animate the wrong satellite.</p>` },

    { id: 'loops', title: 'Animation Loops', html: `
        <p>The <b>play button</b> in the bottom toolbar animates whatever the current tab’s panels are showing — radar, satellite, and dual-pol products all loop together, each panel with its own imagery.</p>
        <ul>
            <li><b>DURATION</b> — how far back the loop reaches. <b>STEP</b> — minutes between frames. <b>SPEED</b> — playback rate.</li>
            <li><b>MODE</b> — <i>Forward</i> wraps from the newest frame back to the oldest; <i>Rock</i> reverses direction at each end so motion stays continuous.</li>
            <li><b>DWELL</b> — extra hold on the newest frame before the loop wraps, so the current data registers instead of flashing past.</li>
            <li>The loop <b>waits until every panel has its frames loaded</b>, shows the first frame while loading, then starts all panels in sync (the log announces “rolling”).</li>
            <li><b>Dual-pol/SRM panels</b> preload their last ~10 volume scans from the NEXRAD archive (a few seconds of “preloading” in the log) and step through real scan times.</li>
            <li>Pause, step frame-by-frame with the arrows, or stop to return to live data.</li>
            <li>Loops are <b>scoped to their tab</b> — switching tabs stops the loop and restores live layers.</li>
        </ul>
        <h3>Products stay time-matched</h3>
        <p>Streams publish at different cadences — radar every 5 minutes, GIBS satellite every 10, dual-pol on its own volume-scan schedule. The loop builds a master timeline from the finest-cadence stream and then shows, for every other product, <b>the frame that was actually valid at that time</b>. A 10-minute satellite image simply holds for two radar steps rather than racing ahead.</p>
        <p>When a stream's newest frame is older than the master time — satellite imagery often publishes 30–40 minutes behind — it holds on that newest frame rather than inventing one, and the per-panel label always reports the real time of what you are looking at. If the labels disagree, that difference is genuine publication lag, not drift.</p>
        <h3>Keyboard</h3>
        <p>Loop control is keyboard-first, the way D2D works during an event:</p>
        <ul>
            <li><b>Space</b> — play / pause (starts a loop if none is running).</li>
            <li><b>← / →</b> — step one frame back / forward (pauses first). Claimed only while a loop is up; with no loop running the arrows pan the map as usual.</li>
            <li><b>Home / End</b> — jump to the oldest / newest frame.</li>
            <li><b>Esc</b> — stop the loop and return to live data.</li>
            <li><b>1–8</b> — make that panel active, if the current layout shows it.</li>
        </ul>` },

    { id: 'severe', title: 'Severe Weather — SPC', html: `
        <ul>
            <li><b>Convective Outlooks</b> Day 1–3 categorical risk areas, plus the <b>Day 4–8</b> outlook.</li>
            <li><b>Day 1 / Day 2 Probabilistic</b> — tornado, wind, and hail probability contours.</li>
            <li><b>Watches, Mesoscale Discussions,</b> and <b>Local Storm Reports</b> plot live; click one for its full text.</li>
            <li><b>ProbSevere</b> storm-object polygons show ML-derived severe probabilities per storm.</li>
            <li><b>Skew-T Soundings</b>: SPC’s observed sounding images, or the <b>Interactive Skew-T (RAOB)</b> panel — an NSHARP-style viewer with parcel curves and indices for any upper-air site.</li>
            <li><b>SPC Mesoanalysis</b> opens the hourly mesoanalysis field viewer. Split it into <b>1, 2 or 4 panes</b> to read several parameters over the same sector at the same valid time — each pane picks its own field, and your layout, parameters and sector are remembered. In a multi-pane layout, <b>click any chart to enlarge it</b> and click again to return; the maximize button fills the window.</li>
        </ul>` },

    { id: 'surface', title: 'Surface Analysis & WPC', html: `
        <ul>
            <li><b>METAR Plotted Obs</b> — station model plots; <b>NDBC Buoys</b> — hourly marine obs.</li>
            <li><b>Isobars</b> (WPC 4-mb or live 2-mb), <b>Isotherms, Isodrosotherms,</b> and WPC <b>Fronts &amp; Pressure Centers</b>.</li>
            <li><b>QPF</b> — WPC precipitation forecasts (24-hr Day 1/2/3, 72-hr, 120-hr). The QPF day is <b>per panel</b>, so a 4-panel Day 1 / Day 2 / Day 3 comparison works.</li>
            <li><b>Excessive Rainfall (ERO)</b> Day 1–3 risk areas — click a risk polygon to open the WPC discussion. <b>Mesoscale Precip Discussions</b> plot live.</li>
            <li><b>Forecast Grids (NDFD)</b> — the official forecast temperature grid.</li>
        </ul>` },

    { id: 'hydro', title: 'Rivers, Drought & Climate (CPC)', html: `
        <ul>
            <li><b>River Gauges</b> color-code by flood status — click a gauge for its <b>hydrograph with forecast</b>.</li>
            <li><b>US Drought Monitor</b> polygons and the <b>CPC Drought Outlook</b>.</li>
            <li><b>CPC Climate Outlooks</b> — temperature and precipitation probability outlooks for 6–10 day, 8–14 day, monthly, and seasonal periods. The period is <b>per panel</b>.</li>
        </ul>` },

    { id: 'models', title: 'Model Guidance & MOS', html: `
        <h3>Why this section is point-based</h3>
        <p>AWIPS ingests full model grids into EDEX and contours them locally — that is a data pipeline, not a web page. FX-Net deliberately does <b>not</b> do that. There is no free, CORS-open gridded source for GFS/ECMWF/CMC, and the one workable route (building a coarse grid and contouring it in the browser) was measured at roughly <b>30 map draws per day</b> before rate limits bite. Point guidance costs about a thousandth of that and answers the question that actually decides a forecast: <b>do the models agree?</b></p>
        <p>Both panels fetch <b>only when you open them</b>. Nothing here polls in the background or touches the map.</p>
        <h3>Model Comparison</h3>
        <p>Plots <b>GFS</b> (NCEP), <b>HRRR</b> (NCEP 3 km), <b>ECMWF IFS</b>, <b>CMC GEM</b> (Environment Canada), <b>ICON</b> (DWD) and <b>ECMWF AIFS</b> at a single point — the panel centre, or any ZIP / city you type. Switch between temperature, dewpoint, wind, precip and MSLP; every field arrives in the same request, so changing it redraws instantly with no refetch.</p>
        <ul>
            <li><b>HRRR stops around 48 hours</b> — that is the model, not a gap. Inside that window it is the 3 km convection-allowing solution, and where it parts company with the globals is the interesting part.</li>
            <li><b>AIFS is ECMWF's operational AI model</b> and is drawn dashed so it reads apart from the physics runs. Where it diverges from IFS is worth a look.</li>
            <li>The shaded band is the <b>spread envelope</b> — the min-to-max across all models at each hour. The readout underneath gives mean and worst-case spread with the time it peaks. <b>Wide spread means low confidence</b>, and it usually blows up somewhere past day 4.</li>
        </ul>
        <h3>Forecast soundings (Skew-T)</h3>
        <p>The Skew-T panel takes a <b>source</b> as well as a site: <b>RAOB — observed</b> (the 00Z/12Z balloon) or a <b>model forecast sounding</b> from <b>HRRR</b> or <b>GFS</b> at that site's location. Forecast soundings step by hour — HRRR out to 48 h, GFS to 5 days — and the whole run is cached, so scrubbing through hours costs nothing after the first load.</p>
        <p>Everything downstream is identical to the observed sounding: <b>SBCAPE, CIN, Lifted Index, PWAT, LCL, LFC, EL, 0–1 and 0–6 km shear</b>, the wind barbs and the hodograph are all computed from the profile the same way. That means you can flip between the balloon and HRRR at the same site and read the difference directly — which is the point.</p>
        <h3>MOS Guidance</h3>
        <p>MDL's station bulletins, laid out the way they are issued — parameters down the left, forecast projections across. <b>Nearest</b> picks the closest ASOS to the panel centre (needs METAR obs switched on); otherwise type any ICAO.</p>
        <ul>
            <li><b>GFS MOS (MAV)</b> — short range, 3-hourly to 72 h. The workhorse, and <b>not</b> going away.</li>
            <li><b>GFS Extended (MEX)</b> — 12-hourly to 192 h, with day max/min in the N/X row.</li>
            <li><b>LAMP</b> — Localized Aviation MOS, <b>issued every hour</b>, so it is normally the freshest guidance on the page. Carries conditional ceiling/visibility and the aviation probabilities.</li>
            <li><b>NBM Short / Extended</b> — National Blend of Models, including gusts, sky %, snow and precip-type probabilities.</li>
        </ul>
        <h3>Why a bulletin can look stale when it isn't</h3>
        <p>Each bulletin shows its <b>run age and issuance interval</b> — "7.2 h old, issued every 6 h, next ~12Z" — because the cycle a product is <i>issued</i> on is often slower than the model behind it. The header turns amber only when a cycle is genuinely overdue.</p>
        <p>The clearest example is NBM: the <b>NBM system updates hourly</b>, but its station bulletins are cut every <b>6 hours</b> (NBM Short) or <b>12 hours</b> (NBM Extended), so mid-morning you will correctly see a 06Z run. If you want station guidance that actually refreshes hourly, use <b>LAMP</b>. NBM does publish an hourly bulletin of its own (NBH), but no CORS-open source carries it.</p>
        <ul>
            <li>Hourly — LAMP</li>
            <li>Every 6 h (00/06/12/18Z) — GFS MOS, NBM Short, NAM MOS</li>
            <li>Every 12 h (00/12Z) — GFS Extended, NBM Extended</li>
            <li><b>NAM MOS (MET)</b> — flagged <b>RETIRING</b>. It ends <b>2026-10-06 12 UTC</b> along with NAM, SREF, HREF and HiresW, replaced by RRFS/REFS. MDL directs users to GFS MOS or NBM.</li>
        </ul>
        <p>On the question of AI MOS: there isn't one. MDL station guidance is still classical regression, and its modern successor is NBM — statistical blending, not machine learning. The AI in this section is the <b>model</b> (AIFS), not the MOS.</p>` },

    { id: 'tropical', title: 'Tropical — NHC & Hurricane Hunters', html: `
        <ul>
            <li><b>Active Storms</b> — forecast cones, track points with intensities, and coastal watch/warning segments. Click a point for the decoded advisory; the popup shows the issue time and flags <b>intermediate</b> advisories (e.g. #1A), where NHC updates the position/watches but the graphical track and cone only refresh on the next full (6-hourly) advisory.<br>
                This layer normally comes from NOAA’s tropical GIS service, which sometimes stalls for hours. FX-Net checks it against NHC’s authoritative storm index on every refresh, and if it has fallen behind it <b>automatically switches to NHC’s own advisory graphics</b> — same cone, same track, straight from the source. The badge then reads <b>NHC DIRECT</b> (green, hover it for the advisory numbers in use), <b>Data Health → NHC Storms</b> is stamped with the advisory’s publication time, and the popup adds a green “Source: NHC advisory graphics (direct)” line. Failover also covers a NOAA outage, and it reverses on its own once NOAA catches up.<br>
                Only if <i>both</i> sources fail does the badge go <b>STALE</b> (orange) with an <b>OUT OF DATE</b> banner in the popup naming the advisory on screen versus NHC’s current one. Even then the <b>Official Advisories</b> text, model guidance, Storm Trends, SHIPS and recon stay current — they come from NHC/ATCF directly.<br>
                Coastal watch/warning segments are colored to NHC convention when the source identifies them: <span style="color:#ffff00;">yellow</span> TS Watch, <span style="color:#0080ff;">blue</span> TS Warning, <span style="color:#ff69b4;">pink</span> Hurricane Watch, <span style="color:#ff0000;">red</span> Hurricane Warning.</li>
            <li><b>Forecast History (run-to-run)</b> — for the active storm, the storm’s actual traveled path (best-track, fix dots colored by intensity) with every past advisory’s official forecast track overlaid, newest bright and older ones faded, each anchored at the position it was issued from. Shows how the forecast has trended cycle to cycle and where the center has actually gone. Forecast tracks accumulate one per full advisory (sparse for a new storm, richer over time); the actual path reaches back to the invest stage.</li>
            <li><b>Tropical Weather Outlooks</b> — 7-day formation areas for the Atlantic and East Pacific; click an area for details.</li>
            <li><b>Tropical Discussions</b> open the full NHC text products.</li>
        </ul>
        <p><b>One active storm.</b> The two storm dropdowns (here and under Model Guidance) are the same selection — pick a system in either and everything below follows it: advisories, recon, spaghetti tracks, intensity, Storm Trends, and SHIPS. Both lists show every active system, numbered storms and invests, in both oceans.</p>
        <h3>Official Advisories (per storm)</h3>
        <p>Read NHC’s authoritative text for any active storm. Pick a system from the dropdown — every active Atlantic and Pacific storm is listed with its current advisory number and age — then open a product:</p>
        <ul>
            <li><b>Public Advisory</b> (TCP) — the plain-language advisory: location, intensity, movement, and the watches/warnings in effect.</li>
            <li><b>Forecast Discussion</b> (TCD) — the forecaster’s reasoning behind the track and intensity forecast.</li>
            <li><b>Forecast / Advisory</b> (TCM) — the technical marine advisory: center fix, the full 5-day forecast positions, and wind-radii by quadrant.</li>
            <li><b>Wind Speed Probabilities</b> (PWS) — the chances of 34 / 50 / 64 kt winds at specific locations over the next 5 days.</li>
        </ul>
        <p>FX-Net maps each storm to the correct AWIPS product slot automatically. That slot rotates 1–5 through the season and can’t be inferred from the storm number (e.g. East Pacific storm EP06 files under bin EP1), so the app always pulls the right storm’s text. Switch storms or products from the panel; × or Esc closes it.</p>
        <h3>Hurricane Hunters (Recon)</h3>
        <p>The badge on <b>Recon Flight Obs</b> is tied to your <b>selected storm</b>: solid green <b>IN AIR</b> means a Hurricane Hunter is flying the storm you have selected right now; a dimmed <b>IN AIR · AL02</b> means aircraft are airborne, but in a different system (named on the badge), not your storm; <b>RECON</b> means no one is airborne anywhere. The flight-track layer likewise shows only the selected storm’s mission. (Flights are matched to storms by position, since the HDOB storm field is often a generic placeholder.)</p>
        <ul>
            <li><b>Recon Flight Obs (live)</b> — plots the aircraft’s actual flight track from its 30-second high-density observations (HDOBs, updated every ~10 minutes in flight). Points are colored by wind: cyan &lt;34 kt, yellow 34–49, orange 50–63, red 64+ (the stronger of SFMR surface wind or flight-level wind). The newest position is enlarged and labeled with the callsign and storm ID. Click any point for the decoded observation — flight-level wind, peak wind, SFMR surface wind, extrapolated surface pressure, temperature and dew point.</li>
            <li><b>Recon Schedule (TCPOD)</b> — CARCAH’s daily Tropical Cyclone Plan of the Day: which aircraft fly which systems, takeoff and fix times for the next 24 hours, and the outlook for the following day.</li>
            <li><b>Vortex Data Message</b> — the crew’s center-fix report from inside the storm: fix position, minimum pressure, max winds, and eye character.</li>
        </ul>
        <h3>Model Guidance (Spaghetti)</h3>
        <p>Live ATCF a-deck model tracks drawn directly on the map for any active system — invests included. Pick the system from the dropdown (populated automatically from NHC), then choose a view:</p>
        <ul>
            <li><b>Early Cycle Track Guidance</b> — the interpolated aids available at advisory time: GFS (AVNI), ECMWF (EMXI), UKMET, Canadian, HAFS-A/B, COAMPS-TC, Google DeepMind, ensemble means, beta-advection trackers, and the TVCN / HCCA consensus (wide cyan / green). The NHC Official forecast plots in white when the system is a numbered cyclone.</li>
            <li><b>Late Cycle Track Guidance</b> — the raw synoptic-time runs of the same models, each plotted from its most recent available cycle.</li>
            <li><b>GEFS Ensemble Members (EPS)</b> — all 30 GEFS perturbation members (thin blue) plus the control (white) and ensemble mean (yellow), showing the true spread in the guidance.</li>
            <li><b>AI / ML Models (✦)</b> — data-driven guidance has its own <b>Early Cycle AI Models</b> and <b>Late Cycle AI Models</b> track views (the regular Early/Late Track Guidance are physics-only). GraphCast (Google DeepMind) plots now; GraphCast-deterministic, Google GenCast, ECMWF AIFS, AI-GFS, and AI-GEFS are wired and draw automatically once NHC distributes them. In the intensity charts, the AI aids (NNIC neural-net intensity consensus, NNIB baseline, GraphCast) show alongside the physics models flagged with ✦ so you can compare directly. The ✦ also appears on track end-labels and in the click popup.</li>
            <li><b>Early / Late Cycle Intensity Guidance</b> — a chart of forecast max wind (kt) vs forecast hour from the same a-deck: SHIPS / Decay-SHIPS, LGEM, the IVCN intensity consensus, HCCA, the hurricane-model aids (HAFS-A/B, HWRF, HMON, COAMPS-TC), GFS, Google DeepMind, and the NHC Official forecast. Dashed lines mark the TS / Cat 1–5 thresholds and the legend is sorted by end-of-run intensity. The late-cycle version shows only the raw synoptic-time dynamical runs (experimental). Esc or × closes it. Note: unlike the UCAR plots (one frozen image per init time), each aid here always shows its own newest run — the note below the chart tells you the newest cycle and how many aids are still on older ones.</li>
            <li><b>Storm Trends (Obs History)</b> — the storm’s <i>observed</i> life so far, from NHC’s live best track: wind (cyan) and central pressure (yellow) on a time axis with classification changes (DB → LO → TD → TS…) marked. Hurricane Hunter vortex fixes overlay in magenta (◆ measured min pressure, ✕ max flight-level wind). The header shows current intensity plus 6/12/24-h pressure/wind tendencies — DEEPENING / FILLING, STRENGTHENING / WEAKENING (red = intensifying). Works for invests too, and follows the storm selector.</li>
            <li><b>Environment / RI (SHIPS)</b> — the environmental drivers behind the intensity forecast, from NHC’s SHIPS diagnostics. A color-coded table of vertical shear, SST, mid-level humidity, ocean heat content, maximum potential intensity, and the SHIPS forecast wind across F0–F72 (green favors intensification, red is hostile), a plain-language FAVORABLE / MARGINAL / HOSTILE banner with the reasons, and the Rapid Intensification Outlook — consensus RI probabilities at each threshold with the 24-h odds highlighted and compared to climatology. This is the “is the environment conducive?” read; use it alongside the intensity guidance. A CIRA block below adds a second independent RI consensus, the Convective <b>Decapitation</b> probability (odds the convection gets sheared off the center → rapid weakening — the counterpart to RI), and current structure predictors (cold-cloud fraction, IR core symmetry).</li>
        </ul>
        <p>Every model’s ID is labeled at the end of its track in its color. Click any forecast point for the model name, initialization cycle, valid time, and that model’s forecast intensity — max wind with Saffir-Simpson category and MSLP where available. Tracks refresh every 15 minutes; each aid always shows its latest run.</p>
        <p>The stamp under the storm selector tells you how fresh the plot is: the newest run time and its age, the number of aids plotted, and how many are still on an older cycle (hover for every model’s run). Data Health → TROPICAL tracks the same — the <b>Model Guidance</b> row is stamped with the run time itself, so it turns amber/red when a newer cycle should have arrived, and <b>Recon HDOB Feed</b> confirms the Hurricane Hunter feed is being checked (every 15 minutes in the background).</p>` },

    { id: 'aviation', title: 'Aviation Hazards', html: `
        <ul>
            <li><b>SIGMETs / AIRMETs</b> and <b>G-AIRMET</b> hazard polygons (turbulence, icing, IFR…).</li>
            <li><b>PIREPs</b> — pilot reports plotted with intensity.</li>
            <li><b>TAFs</b> — terminal forecasts as flight-category colored airport dots.</li>
            <li>Click any hazard area, PIREP, or TAF site for the decoded detail.</li>
        </ul>` },

    { id: 'firewx', title: 'Lightning, Fire, Smoke, Air Quality & Solar', html: `
        <ul>
            <li><b>Lightning</b> — NLDN strike density mosaic.</li>
            <li><b>SPC Fire Weather Outlooks</b> (Day 1–8), <b>HMS Smoke</b> plumes, and <b>FIRMS</b> satellite-detected fire points.</li>
            <li><b>AirNow AQI</b> — current air quality observations, synced to the hourly feed.</li>
            <li><b>Solar</b> — day/night terminator shading; click the map for local sunrise/sunset data.</li>
        </ul>` },

    { id: 'tools', title: 'Analysis Tools', html: `
        <h3>Distance / Bearing</h3>
        <p>Click points on the map to build a great-circle line — each point labels the <b>cumulative distance (nm) and bearing</b>. <b>Double-click to finish</b>: the line freezes on screen with its totals. Click again to start a new line; <kbd>Esc</kbd> or re-clicking the tool exits.</p>
        <h3>Range Rings</h3>
        <p>Draws 25 / 50 / 100 / 150 / 200 nm rings around the active radar site (or the map center). Click anywhere to recenter them.</p>
        <h3>Storm Motion &amp; ETA</h3>
        <p>Click a storm’s <b>previous</b> position, then its <b>current</b> position — the tool computes its speed and heading (&Delta;t comes from the loop <b>STEP</b> setting). Then click any town or landmark for its <b>estimated arrival time</b>.</p>
        <h3>Cursor sync &amp; value readout</h3>
        <p>Moving the cursor over one panel shows a matching cursor on the others. With site radar or MRMS up, the bottom toolbar decodes the pixel under the cursor into real units.</p>` },

    { id: 'procedures', title: 'Procedures — Saved Displays', html: `
        <p>Procedures are AWIPS-style saved display bundles. <b>Save Current Display…</b> records the current tab’s <b>entire panel layout</b> — every panel’s map view, imagery, and overlays — under a name you choose.</p>
        <ul>
            <li>Loading a procedure switches the tab to the saved layout and rebuilds every panel.</li>
            <li>An amber <b>1-PANE</b> badge marks bundles saved before multi-panel support; they load the old single-panel way — re-save them once to upgrade.</li>
            <li>Procedures live in your browser. Use <b>Export Settings to File…</b> to carry them to another machine.</li>
        </ul>` },

    { id: 'watchdog', title: 'Watchdog, AlertViz & Text Products', html: `
        <h3>Watchdog</h3>
        <p>The warning ticker under NWS WARNINGS monitors the national alert feed continuously. Filter it by <b>state and WFO</b> — the filter persists across sessions. Click any alert for its full text.</p>
        <h3>AlertViz</h3>
        <p>High-urgency, action-forcing warnings (tornado, PDS…) fire a <b>toast notification</b> the moment they’re issued, with an optional alert tone.</p>
        <h3>Text products</h3>
        <p><b>Text Browser</b> pulls any raw NWS text product by office and category (AFDs, QPF discussions, and dozens more). <b>Forecast Meteogram</b> charts the hourly NWS forecast for any point.</p>` },

    { id: 'settings', title: 'Settings Backup & Shortcuts', html: `
        <h3>Backup / transfer</h3>
        <p><b>Export Settings to File…</b> downloads everything — workspace tabs, procedures, watchdog filters — as one JSON file. <b>Import Settings from File…</b> restores it on any machine and reloads the app. Because all settings live in the browser’s local storage, clearing browser data erases them: export a backup first.</p>
        <h3>Keyboard shortcuts</h3>
        <ul>
            <li><kbd>Ctrl</kbd>+<kbd>\\</kbd> — collapse / expand the product sidebar.</li>
            <li><kbd>Esc</kbd> — exit the active analysis tool, close pop-up panels, close this guide.</li>
        </ul>
        <h3>Getting help</h3>
        <p>The <b>WHAT’S NEW</b> panel lists recent changes; this guide is the permanent reference. Source code and issue reporting live on GitHub (link under the app title).</p>` }
];

function initUserGuide() {
    const overlay = document.getElementById('guide-overlay');
    const toc = document.getElementById('guide-toc');
    const content = document.getElementById('guide-content');
    const search = document.getElementById('guide-search');
    const btn = document.getElementById('user-guide-btn');
    if (!overlay || !toc || !content || !search || !btn) return;

    content.innerHTML = USER_GUIDE.map(s =>
        `<section class="guide-sec" id="guide-sec-${s.id}"><h2>${s.title}</h2>${s.html}</section>`).join('') +
        `<div class="guide-no-results" style="display:none;">No guide sections match that search.</div>`;
    // Pristine copy of each section for resetting search highlights
    content.querySelectorAll('.guide-sec').forEach(sec => { sec.dataset.orig = sec.innerHTML; });

    toc.innerHTML = USER_GUIDE.map(s => `<a data-target="guide-sec-${s.id}">${s.title}</a>`).join('');
    const tocLinks = [...toc.querySelectorAll('a')];
    tocLinks.forEach(a => a.addEventListener('click', () => {
        tocLinks.forEach(x => x.classList.remove('active'));
        a.classList.add('active');
        document.getElementById(a.dataset.target)?.scrollIntoView({ block: 'start' });
    }));

    const escHtml = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const runSearch = q => {
        const secs = [...content.querySelectorAll('.guide-sec')];
        const qlc = q.toLowerCase();
        let shown = 0;
        secs.forEach((sec, i) => {
            sec.innerHTML = sec.dataset.orig;   // reset any previous <mark>s
            const match = !q || sec.textContent.toLowerCase().includes(qlc);
            sec.style.display = match ? '' : 'none';
            if (tocLinks[i]) tocLinks[i].style.display = match ? '' : 'none';
            if (!match) return;
            shown++;
            if (!q) return;
            // Wrap matches in <mark> — text nodes only, so tags stay intact
            const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
            const walker = document.createTreeWalker(sec, NodeFilter.SHOW_TEXT);
            const nodes = [];
            while (walker.nextNode()) nodes.push(walker.currentNode);
            nodes.forEach(n => {
                if (!n.nodeValue.toLowerCase().includes(qlc)) return;
                const span = document.createElement('span');
                span.innerHTML = escHtml(n.nodeValue).replace(rx, m => `<mark>${m}</mark>`);
                n.parentNode.replaceChild(span, n);
            });
        });
        const noRes = content.querySelector('.guide-no-results');
        if (noRes) noRes.style.display = shown ? 'none' : 'block';
    };
    search.addEventListener('input', () => runSearch(search.value.trim()));

    const setOpen = open => {
        overlay.style.display = open ? 'flex' : 'none';
        if (open) {
            search.value = '';
            runSearch('');
            if (tocLinks[0] && !toc.querySelector('a.active')) tocLinks[0].classList.add('active');
            try { lucide.createIcons(); } catch (_) {}
        }
    };
    btn.addEventListener('click', () => setOpen(true));
    document.getElementById('guide-close')?.addEventListener('click', () => setOpen(false));
    overlay.addEventListener('click', e => { if (e.target === overlay) setOpen(false); });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && overlay.style.display !== 'none') setOpen(false);
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 26: INTERROGATION TOOLS (measure / range rings / storm ETA)
// ═══════════════════════════════════════════════════════════════════════════════
// AWIPS-style point interrogation. One shared 'tool-geo'/'tool-pts' overlay per
// pane (created in setupMapLayers); the active mode owns map clicks via the guard
// in the generic click handler. All math is great-circle (nautical miles).

window.interrogationMode = null;          // 'measure' | 'rings' | 'eta' | null
const _measure = { pts: [], map: null, done: false };
const _eta = { pts: [], head: null, speedKt: 0, dirDeg: 0 };
const _EARTH_NM = 3440.065;

function _nm(a, b) {
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(b[1] - a[1]), dLon = toRad(b[0] - a[0]);
    const s = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
    return 2 * _EARTH_NM * Math.asin(Math.min(1, Math.sqrt(s)));
}
function _bearing(a, b) {
    const toRad = d => d * Math.PI / 180, toDeg = r => r * 180 / Math.PI;
    const y = Math.sin(toRad(b[0] - a[0])) * Math.cos(toRad(b[1]));
    const x = Math.cos(toRad(a[1])) * Math.sin(toRad(b[1])) -
        Math.sin(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.cos(toRad(b[0] - a[0]));
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
function _pointAtBearing(center, distNm, brgDeg) {
    const d = distNm / _EARTH_NM, brg = brgDeg * Math.PI / 180;
    const lat1 = center[1] * Math.PI / 180, lon1 = center[0] * Math.PI / 180;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg));
    const lon2 = lon1 + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(lat1),
        Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
    return [lon2 * 180 / Math.PI, lat2 * 180 / Math.PI];
}
function _geoCircle(center, radiusNm, n = 96) {
    const coords = [];
    for (let i = 0; i <= n; i++) coords.push(_pointAtBearing(center, radiusNm, (i / n) * 360));
    return coords;
}
function _setToolData(map, geoFeatures, ptFeatures) {
    if (map && map.getSource('tool-geo')) map.getSource('tool-geo').setData({ type: 'FeatureCollection', features: geoFeatures });
    if (map && map.getSource('tool-pts')) map.getSource('tool-pts').setData({ type: 'FeatureCollection', features: ptFeatures });
}
function _clearAllToolOverlays() { Object.values(maps).forEach(m => _setToolData(m, [], [])); }

function handleToolClick(map, paneId, e) {
    const p = [e.lngLat.lng, e.lngLat.lat];
    if (window.interrogationMode === 'measure') {
        // A finished line stays on screen; the next click starts a fresh one
        if (_measure.map !== map || _measure.done) {
            if (_measure.map && _measure.map !== map) _setToolData(_measure.map, [], []);
            _measure.pts = []; _measure.map = map; _measure.done = false;
        }
        _measure.pts.push(p);
        renderMeasure(map);
    } else if (window.interrogationMode === 'rings') {
        drawRangeRings(map, p);
    } else if (window.interrogationMode === 'eta') {
        handleEtaClick(map, p);
    }
}
function updateMeasurePreview(map, paneId, lngLat) {
    if (_measure.map !== map || _measure.pts.length === 0 || _measure.done) return;
    renderMeasure(map, [lngLat.lng, lngLat.lat]);
}
// Double-click ends the measurement: the line freezes on screen (no more
// rubber-band preview chasing the cursor) and the next single click starts a
// new line. The dblclick is preceded by two click events that each dropped a
// point at ~the same spot, so trailing near-duplicates are trimmed first.
function finishMeasure(map) {
    if (_measure.map !== map || _measure.pts.length === 0 || _measure.done) return;
    while (_measure.pts.length >= 2 &&
           _nm(_measure.pts[_measure.pts.length - 2], _measure.pts[_measure.pts.length - 1]) < 0.2) {
        _measure.pts.pop();
    }
    _measure.done = true;
    renderMeasure(map);
    let total = 0;
    for (let i = 1; i < _measure.pts.length; i++) total += _nm(_measure.pts[i - 1], _measure.pts[i]);
    addLiveLog(`MEASURE: line finished — ${total.toFixed(1)} nm total (${_measure.pts.length} points). Click to start a new line, Esc to exit.`, '#00e5ff');
}
function renderMeasure(map, preview) {
    const pts = preview ? _measure.pts.concat([preview]) : _measure.pts.slice();
    if (pts.length === 0) { _setToolData(map, [], []); return; }
    let cum = 0;
    const ptFeats = pts.map((pt, i) => {
        let label = 'START';
        if (i > 0) {
            cum += _nm(pts[i - 1], pt);
            label = `${cum.toFixed(1)} nm  ·  ${Math.round(_bearing(pts[i - 1], pt))}°`;
        }
        return { type: 'Feature', properties: { label, color: '#00e5ff' }, geometry: { type: 'Point', coordinates: pt } };
    });
    const line = pts.length >= 2
        ? [{ type: 'Feature', properties: { color: '#00e5ff' }, geometry: { type: 'LineString', coordinates: pts } }] : [];
    _setToolData(map, line, ptFeats);
}
function drawRangeRings(map, center) {
    const radii = [25, 50, 100, 150, 200];
    const rings = radii.map(r => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [_geoCircle(center, r)] } }));
    const labels = radii.map(r => ({ type: 'Feature', properties: { label: `${r} nm`, color: '#ffcc00' }, geometry: { type: 'Point', coordinates: _pointAtBearing(center, r, 0) } }));
    labels.push({ type: 'Feature', properties: { label: '', color: '#ffcc00' }, geometry: { type: 'Point', coordinates: center } });
    _setToolData(map, rings, labels);
}
function handleEtaClick(map, p) {
    if (_eta.pts.length < 2) {
        _eta.pts.push(p);
        if (_eta.pts.length === 2) {
            const dt = parseInt(document.getElementById('loop-step')?.value || '5', 10) || 5;   // min between the two positions
            const dist = _nm(_eta.pts[0], _eta.pts[1]);
            _eta.speedKt = dist / (dt / 60);
            _eta.dirDeg = _bearing(_eta.pts[0], _eta.pts[1]);
            _eta.head = _eta.pts[1];
            addLiveLog(`STORM ETA: motion ${Math.round(_eta.dirDeg)}° @ ${Math.round(_eta.speedKt)} kt (Δt ${dt} min from loop STEP). Now click any location for its ETA.`, '#ff9e3b');
        } else {
            addLiveLog('STORM ETA: now click the storm\'s CURRENT position.', '#ff9e3b');
        }
        renderEta(map, null);
    } else {
        renderEta(map, p);   // target click → ETA
    }
}
function renderEta(map, target) {
    const geo = [], pts = [];
    if (_eta.pts[0]) pts.push({ type: 'Feature', properties: { label: 't₀', color: '#ff9e3b' }, geometry: { type: 'Point', coordinates: _eta.pts[0] } });
    if (_eta.pts[1]) {
        geo.push({ type: 'Feature', properties: { color: '#ff9e3b' }, geometry: { type: 'LineString', coordinates: [_eta.pts[0], _eta.pts[1]] } });
        pts.push({ type: 'Feature', properties: { label: `${Math.round(_eta.dirDeg)}° @ ${Math.round(_eta.speedKt)} kt`, color: '#ff9e3b' }, geometry: { type: 'Point', coordinates: _eta.pts[1] } });
    }
    if (target && _eta.head && _eta.speedKt > 0) {
        const d = _nm(_eta.head, target);
        const etaMin = d / _eta.speedKt * 60;
        geo.push({ type: 'Feature', properties: { color: '#ff3b3b' }, geometry: { type: 'LineString', coordinates: [_eta.head, target] } });
        pts.push({ type: 'Feature', properties: { label: `ETA ${Math.round(etaMin)} min  (${d.toFixed(0)} nm)`, color: '#ff3b3b' }, geometry: { type: 'Point', coordinates: target } });
    }
    _setToolData(map, geo, pts);
}
function ringCenterForPane(paneId, map) {
    const site = (paneRadarSites[paneId] || '').toUpperCase();
    if (site && !site.includes('NEXRAD') && RADAR_LOCATIONS[site]) return RADAR_LOCATIONS[site].slice();
    const c = map.getCenter();
    return [c.lng, c.lat];
}
function setInterrogationMode(mode) {
    const newMode = (window.interrogationMode === mode) ? null : mode;
    window.interrogationMode = newMode;
    _measure.pts = []; _measure.map = null; _measure.done = false;
    _eta.pts = []; _eta.head = null; _eta.speedKt = 0; _eta.dirDeg = 0;
    _clearAllToolOverlays();
    [['tool-measure', 'measure'], ['tool-range-rings', 'rings'], ['tool-storm-eta', 'eta']].forEach(([id, md]) => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('active', newMode === md);
    });
    const map = maps[activePaneId];
    if (map) map.getCanvas().style.cursor = newMode ? 'crosshair' : '';
    if (newMode === 'rings' && map) {
        drawRangeRings(map, ringCenterForPane(activePaneId, map));
        addLiveLog('RANGE RINGS: 25 / 50 / 100 / 150 / 200 nm from the active site (click map to recenter).', '#ffcc00');
    } else if (newMode === 'measure') {
        addLiveLog('MEASURE: click points for great-circle range & bearing — DOUBLE-CLICK to finish the line. Esc or re-click the tool to exit.', '#00e5ff');
    } else if (newMode === 'eta') {
        addLiveLog('STORM ETA: click the storm\'s PREVIOUS position, then its CURRENT position (Δt = loop STEP).', '#ff9e3b');
    } else {
        addLiveLog('TOOL: off', '#888');
    }
}
function initInterrogationTools() {
    document.getElementById('tool-measure')?.addEventListener('click', () => setInterrogationMode('measure'));
    document.getElementById('tool-range-rings')?.addEventListener('click', () => setInterrogationMode('rings'));
    document.getElementById('tool-storm-eta')?.addEventListener('click', () => setInterrogationMode('eta'));
    // Esc exits any active tool.
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && window.interrogationMode) setInterrogationMode(window.interrogationMode); });
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 27: ALERTVIZ (new-warning toast + optional tone)
// ═══════════════════════════════════════════════════════════════════════════════
// Fires only for high-urgency, action-forcing warnings as they are issued. Hooked
// off the watchdog's existing new-alert detection (no extra polling).

window.alertVizTone = (localStorage.getItem('fxnet_alertviz_tone') !== '0');

function _geomCentroid(geom) {
    if (!geom) return null;
    let ring = null;
    if (geom.type === 'Polygon') ring = geom.coordinates[0];
    else if (geom.type === 'MultiPolygon') ring = geom.coordinates[0][0];
    if (!ring || !ring.length) return null;
    let x = 0, y = 0;
    ring.forEach(c => { x += c[0]; y += c[1]; });
    return [x / ring.length, y / ring.length];
}
function alertVizQualifies(evt, flags) {
    if (flags && flags.isEmergency) return true;
    return /(Tornado Warning|Severe Thunderstorm Warning|Flash Flood Warning|Tornado Emergency|Flash Flood Emergency)/i.test(evt || '');
}
function _alertTone() {
    if (!window.alertVizTone) return;
    try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        const ac = new Ctx();
        const o = ac.createOscillator(), g = ac.createGain();
        o.type = 'sine'; o.frequency.value = 880;
        g.gain.setValueAtTime(0.0001, ac.currentTime);
        g.gain.exponentialRampToValueAtTime(0.15, ac.currentTime + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.5);
        o.connect(g); g.connect(ac.destination);
        o.start(); o.stop(ac.currentTime + 0.52);
        o.onended = () => ac.close();
    } catch (_) {}
}
function alertVizNotify(f, flags) {
    const p = f.properties || {};
    const evt = p.event || 'Warning';
    if (!alertVizQualifies(evt, flags)) return;

    const container = document.getElementById('alertviz-container');
    if (!container) return;

    const isEmergency = flags && flags.isEmergency;
    let accent = '#ffb300';
    if (/tornado/i.test(evt)) accent = '#ff2b2b';
    else if (/severe thunderstorm/i.test(evt)) accent = '#ff7a1a';
    else if (/flash flood/i.test(evt)) accent = '#2bd4c4';
    if (isEmergency) accent = '#ff0000';

    const area = (p.areaDesc || '').split(';').slice(0, 2).join(';');
    const toast = document.createElement('div');
    toast.className = 'alertviz-toast';
    toast.style.borderLeftColor = accent;
    toast.innerHTML =
        `<div class="alertviz-title" style="color:${accent};">${isEmergency ? '⚠ ' : ''}${esc(evt)}</div>
         <div class="alertviz-area">${esc(area)}</div>
         <div class="alertviz-src">${esc(p.senderName || '')}</div>`;

    const centroid = _geomCentroid(f.geometry);
    toast.addEventListener('click', () => {
        if (centroid && maps[activePaneId]) maps[activePaneId].flyTo({ center: centroid, zoom: 8 });
        toast.remove();
    });
    container.appendChild(toast);
    while (container.children.length > 5) container.firstChild.remove();
    if (isEmergency || /tornado/i.test(evt)) _alertTone();

    const ttl = isEmergency ? 30000 : 14000;
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 400); }, ttl);
}
function initAlertViz() {
    if (!document.getElementById('alertviz-container')) {
        const c = document.createElement('div');
        c.id = 'alertviz-container';
        document.body.appendChild(c);
    }
    const css = `
        #alertviz-container{position:fixed;top:64px;right:14px;z-index:9500;display:flex;flex-direction:column;gap:8px;max-width:320px;pointer-events:none;}
        .alertviz-toast{pointer-events:auto;cursor:pointer;background:rgba(10,14,20,0.96);border:1px solid #1e2a35;border-left:4px solid #ffb300;border-radius:5px;padding:9px 12px;box-shadow:0 6px 22px rgba(0,0,0,0.6);font-family:Inter,sans-serif;transition:opacity .4s;animation:alertviz-in .35s ease;}
        .alertviz-title{font-size:12px;font-weight:800;letter-spacing:.3px;margin-bottom:2px;}
        .alertviz-area{font-size:10.5px;color:#dfe6ee;line-height:1.35;}
        .alertviz-src{font-size:9px;color:#7d8b98;margin-top:3px;}
        @keyframes alertviz-in{from{transform:translateX(24px);opacity:0;}to{transform:translateX(0);opacity:1;}}`;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    addLiveLog(`ALERTVIZ: active (tone ${window.alertVizTone ? 'on' : 'off'})`, '#00ff88');
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 28: PROCEDURES (saved display bundles)
// ═══════════════════════════════════════════════════════════════════════════════
// A "procedure" = the pane layout plus, for every visible pane, that pane's
// view, imagery and overlay products — the same per-pane snapshot the
// workspace autosave uses, loaded back through the same pendingRestore path.
// (v1 bundles, saved before multi-pane capture, recorded only the active
// pane's toggles; they still load through the legacy re-click path.)

const PROC_KEY = 'fxnet_procedures';
const PROC_ATTRS = ['day', 'hazard', 'channel', 'gibs', 'qpf', 'qpe', 'period', 'l3'];

function loadProcStore() {
    try { return JSON.parse(localStorage.getItem(PROC_KEY) || '{}'); } catch (_) { return {}; }
}
function saveProcStore(s) { localStorage.setItem(PROC_KEY, JSON.stringify(s)); }

function captureProcedure() {
    const layout = (tabs[activeTabId] && tabs[activeTabId].layout) || 1;
    const panes = {};
    paneIdsForTab(activeTabId).forEach((pid, idx) => {
        if (idx >= layout) return;                       // only visible panes
        const m = maps[pid];
        if (!m) return;
        const conf = {};
        if (paneRadarSites[pid]) conf.radarSite = paneRadarSites[pid];
        if (paneRadarProducts[pid]) conf.radarProduct = paneRadarProducts[pid];
        if (paneGoesChannels[pid] != null) conf.goesChannel = paneGoesChannels[pid];
        if (paneGibs[pid]) conf.gibs = paneGibs[pid];
        if (paneL3[pid]) conf.l3 = paneL3[pid];
        conf.radarVisible = SITE_RADAR_VIS_LAYERS.some(l => isLayerVisible(m, l));
        conf.satVisible = isLayerVisible(m, 'satellite-layer') && paneGoesChannels[pid] != null;
        try {
            const c = m.getCenter();
            conf.view = [+c.lng.toFixed(4), +c.lat.toFixed(4), +m.getZoom().toFixed(2)];
        } catch (_) {}
        const overlays = capturePaneOverlays(pid);
        if (overlays.length) conf.overlays = overlays;
        panes[idx + 1] = conf;                           // keyed by pane number → loads into any tab
    });
    return { v: 2, layout, panes };
}
// How many products a bundle carries (for the save/load log lines)
function procLayerCount(proc) {
    if (proc && proc.v === 2) {
        return Object.values(proc.panes || {}).reduce((n, c) =>
            n + ((c.overlays || []).length + (c.radarVisible ? 1 : 0) + (c.satVisible ? 1 : 0) + (c.gibs ? 1 : 0) + (c.l3 ? 1 : 0)), 0);
    }
    return (proc && proc.active && proc.active.length) || 0;
}
function _procItemSelector(rec) {
    let s = `.product-item[data-layer="${rec.layer}"]`;
    PROC_ATTRS.forEach(k => { if (rec[k] != null) s += `[data-${k}="${rec[k]}"]`; });
    return s;
}
async function applyProcedure(proc) {
    if (!proc) return;
    if (proc.v !== 2 || !proc.panes) return applyProcedureLegacy(proc);
    const layout = proc.layout || 1;
    // Seed each pane's saved setup first, so panes the layout change is about
    // to create construct directly at their saved view; then reveal the layout.
    paneIdsForTab(activeTabId).forEach((pid, idx) => {
        if (idx >= layout) return;
        const conf = proc.panes[idx + 1];
        if (!conf) return;
        if (conf.radarSite) paneRadarSites[pid] = conf.radarSite;
        if (conf.radarProduct) paneRadarProducts[pid] = conf.radarProduct;
        pendingRestore[pid] = JSON.parse(JSON.stringify(conf));   // keep the stored bundle untouched
    });
    applyLayout(activeTabId, layout, false);
    // Maps that are already up: wipe the current display and re-apply through
    // the same pendingRestore path a page reload uses. Maps still initializing
    // (panes the layout just created) restore from their 'load' handler.
    paneIdsForTab(activeTabId).forEach((pid, idx) => {
        if (idx >= layout) return;
        const m = maps[pid];
        if (!m || !m.getLayer('radar-layer')) return;
        try { clearPane(m, pid); } catch (_) {}
        const conf = proc.panes[idx + 1];
        if (!conf) return;
        if (conf.goesChannel != null) paneGoesChannels[pid] = conf.goesChannel;   // clearPane nulls it
        applyPaneRestore(pid);
    });
    if (typeof updateSidebarToActivePane === 'function') updateSidebarToActivePane();
    addLiveLog(`PROCEDURE: ${layout}-pane display restored`, '#00e5ff');
}
async function applyProcedureLegacy(proc) {
    const map = maps[activePaneId];
    if (!map || !proc) return;
    addLiveLog('PROCEDURE: legacy 1-panel preset — it only holds one panel\'s display. Rebuild your layout and re-save it to capture every panel.', '#ffb300');
    if (proc.site) {
        const sel = document.getElementById('radar-site-select');
        if (sel && Array.from(sel.options).some(o => o.value === proc.site)) {
            sel.value = proc.site;
            sel.dispatchEvent(new Event('change'));
        }
    }
    if (proc.center) map.jumpTo({ center: proc.center, zoom: proc.zoom || map.getZoom() });
    // Turn OFF anything currently on that the procedure doesn't include, then turn ON the rest.
    const want = new Set((proc.active || []).map(_procItemSelector));
    document.querySelectorAll('.product-item.active').forEach(it => {
        if (!it.getAttribute('data-layer')) return;
        const isWanted = [...want].some(sel => it.matches(sel));
        if (!isWanted) it.click();
    });
    for (const rec of (proc.active || [])) {
        const item = document.querySelector(_procItemSelector(rec));
        if (item && !item.classList.contains('active')) { item.click(); await new Promise(r => setTimeout(r, 120)); }
    }
    addLiveLog('PROCEDURE: display restored', '#00e5ff');
}
function renderProcList() {
    const list = document.getElementById('proc-list');
    if (!list) return;
    const store = loadProcStore();
    const names = Object.keys(store).sort();
    list.innerHTML = names.length ? '' : '<div class="proc-empty">No saved procedures yet.</div>';
    names.forEach(name => {
        const row = document.createElement('div');
        row.className = 'proc-row';
        const legacy = !(store[name] && store[name].v === 2 && store[name].panes);
        row.innerHTML = `<span class="proc-name" title="Load this display">${esc(name)}</span>` +
            (legacy ? `<span class="proc-legacy" title="Saved before multi-panel presets, so it holds only one panel. Rebuild your display and use Save Current Display… under this name to upgrade it.">1-PANE</span>` : '') +
            `<span class="proc-del" title="Delete">✕</span>`;
        row.querySelector('.proc-name').addEventListener('click', () => applyProcedure(store[name]));
        row.querySelector('.proc-del').addEventListener('click', e => {
            e.stopPropagation();
            const s = loadProcStore(); delete s[name]; saveProcStore(s); renderProcList();
            addLiveLog(`PROCEDURE: deleted "${esc(name)}"`, '#ff9e3b');
        });
        list.appendChild(row);
    });
}
function initProcedures() {
    const css = `
        #proc-list{margin:2px 0 4px;}
        .proc-row{display:flex;align-items:center;justify-content:space-between;padding:4px 10px;font-size:11px;color:#cdd6df;cursor:default;border-radius:3px;}
        .proc-row:hover{background:#141c26;}
        .proc-name{cursor:pointer;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
        .proc-name:hover{color:#00e5ff;}
        .proc-del{cursor:pointer;color:#ff6666;padding-left:8px;font-size:11px;}
        .proc-legacy{color:#ffb300;border:1px solid #ffb30055;border-radius:3px;padding:0 4px;margin-left:6px;font-size:9px;letter-spacing:.5px;cursor:help;}
        .proc-empty{padding:4px 10px;font-size:10px;color:#5c6b78;font-style:italic;}`;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    document.getElementById('proc-save')?.addEventListener('click', () => {
        const name = (window.prompt('Save current display as… (name):') || '').trim();
        if (!name) return;
        const store = loadProcStore();
        store[name] = captureProcedure();
        saveProcStore(store);
        renderProcList();
        addLiveLog(`PROCEDURE: saved "${esc(name)}" (${store[name].layout || 1}-pane, ${procLayerCount(store[name])} products)`, '#00ff88');
    });
    renderProcList();
    initSettingsBackup();
}

// ── Settings backup (export/import every fxnet_* localStorage key) ──────────
// Everything the workstation persists — workspace tabs, procedures, filters,
// UI prefs — lives in localStorage under an fxnet_ prefix, so a browser
// upgrade, profile wipe or machine change loses it all. These two items dump
// the whole set to a JSON file and load it back (then reload the app).
function initSettingsBackup() {
    document.getElementById('settings-export')?.addEventListener('click', () => {
        try {
            const dump = {};
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith('fxnet_')) dump[k] = localStorage.getItem(k);
            }
            const blob = new Blob([JSON.stringify({ app: 'fxnet-nextgen', exported: new Date().toISOString(), settings: dump }, null, 2)],
                { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `fxnet-settings-${new Date().toISOString().substring(0, 10)}.json`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 5000);
            addLiveLog(`SETTINGS: exported ${Object.keys(dump).length} keys to file`, '#00ff88');
        } catch (e) {
            addLiveLog('SETTINGS: export failed — ' + esc(e.message || String(e)), '#ff5252');
        }
    });
    document.getElementById('settings-import')?.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.addEventListener('change', () => {
            const file = input.files && input.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const data = JSON.parse(reader.result);
                    const settings = (data && data.app === 'fxnet-nextgen' && data.settings) ? data.settings : null;
                    if (!settings) throw new Error('not an FX-Net settings file');
                    let n = 0;
                    Object.entries(settings).forEach(([k, v]) => {
                        if (k.startsWith('fxnet_') && typeof v === 'string') { localStorage.setItem(k, v); n++; }
                    });
                    if (!n) throw new Error('file contained no settings');
                    if (window.confirm(`Imported ${n} settings. Reload the workstation now to apply them?`)) {
                        window.location.reload();
                    }
                } catch (e) {
                    window.alert('Import failed: ' + (e.message || e));
                }
            };
            reader.readAsText(file);
        });
        input.click();
    });
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 29: NEXRAD L3 — STORM TRACKS (STI), ALL-TILTS, VAD WIND PROFILE
// ═══════════════════════════════════════════════════════════════════════════════

const paneStormAttr = {};   // paneId -> { station, meta }
const paneMeso = {};        // paneId -> { station, meta }

// Storm Track Information (STI / product NST): storm cell centroids + forecast
// tracks + attributes, fetched through the existing L3 endpoint (returns GeoJSON).
async function fetchStormAttr(paneId, station) {
    const map = maps[paneId];
    if (!map) return;
    addLiveLog(`STI: Loading ${station} storm tracks...`, '#ff2bd0');
    try {
        const res = await fetch(`/api/radar-l3?station=${station}&product=NST&_=${Date.now()}`);
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'STI failed');
        const feats = [];
        (data.geojson && data.geojson.features || []).forEach(f => {
            const kind = f.properties && f.properties.kind;
            if (kind === 'cell') {
                f.properties.tag = f.properties.dbzm != null ? `${f.properties.id} · ${f.properties.dbzm}dBZ` : f.properties.id;
                feats.push(f);
            } else if (kind === 'forecast') {
                feats.push(f);
                (f.geometry && f.geometry.coordinates || []).slice(1).forEach(c =>
                    feats.push({ type: 'Feature', properties: { kind: 'ftick', id: f.properties.id }, geometry: { type: 'Point', coordinates: c } }));
            }
        });
        const fc = { type: 'FeatureCollection', features: feats };
        Object.values(maps).forEach(m => { if (m.getSource('storm-attr')) m.getSource('storm-attr').setData(fc); });
        paneStormAttr[paneId] = { station, meta: data.meta };
        addLiveLog(`STI: ${data.meta.count} cells @ ${data.meta.time} (${station})`, '#00ff88');
    } catch (e) {
        addLiveLog(`STI ERROR: ${e.message}`, '#ff3333');
    }
}

// Mesocyclone Detection (NMD / MDA): detected circulations + TVS flags from the
// same L3 endpoint. AWIPS-style meso/TVS marker overlay for the radar pane.
async function fetchMesoMarkers(paneId, station) {
    const map = maps[paneId];
    if (!map) return;
    addLiveLog(`MESO: Loading ${station} circulation detections...`, '#ff9e3b');
    try {
        const res = await fetch(`/api/radar-l3?station=${station}&product=NMD&_=${Date.now()}`);
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'NMD failed');
        const fc = data.geojson || { type: 'FeatureCollection', features: [] };
        Object.values(maps).forEach(m => { if (m.getSource('meso-markers')) m.getSource('meso-markers').setData(fc); });
        paneMeso[paneId] = { station, meta: data.meta };
        const tvsCount = fc.features.filter(f => f.properties && f.properties.tvs === 'Y').length;
        addLiveLog(`MESO: ${data.meta.count} circulation(s)${tvsCount ? ` · ${tvsCount} TVS ⚠` : ''} @ ${data.meta.time} (${station})`, tvsCount ? '#ff3333' : '#00ff88');
    } catch (e) {
        addLiveLog(`MESO: ${e.message}`, '#ffb300');
    }
}

// ── All-tilts: step the active pane's L3 product through elevation angles ──
// NODD super-res tilt characters run 0→A→1→B (≈0.5/0.9/1.3/1.8-2.4°), not
// 0→1→2→3 — the API maps each code to the products actually in the bucket.
const L3_TILT_CHARS = ['0', 'A', '1', 'B'];
function l3TiltIndex(product) {
    const i = L3_TILT_CHARS.indexOf((product || '').charAt(1));
    return i < 0 ? 0 : i;   // legacy digit codes (N2C…) normalize on next step
}
function updateL3TiltControl() {
    const ctrl = document.getElementById('l3-tilt-control');
    const label = document.getElementById('l3-tilt-label');
    if (!ctrl || !label) return;
    const st = paneL3[activePaneId];
    const map = maps[activePaneId];
    if (st && map && isLayerVisible(map, 'radar-l3-layer')) {
        ctrl.style.display = 'flex';
        const tilt = l3TiltIndex(st.product);
        const el = st.meta && st.meta.elevation;
        label.textContent = (el != null ? el + '°' : ['0.5°', '0.9°', '1.3°', '1.8°'][tilt]) + ` · T${tilt}`;
    } else {
        ctrl.style.display = 'none';
    }
}
async function stepL3Tilt(delta) {
    const pid = activePaneId;
    const st = paneL3[pid];
    if (!st) return;
    const cur = l3TiltIndex(st.product);
    const next = Math.max(0, Math.min(3, cur + delta));
    if (next === cur) return;
    const newProduct = st.product.charAt(0) + L3_TILT_CHARS[next] + st.product.charAt(2);
    addLiveLog(`L3 TILT: requesting T${next} (${newProduct})…`, '#33c27a');
    await loadL3Radar(pid, st.station, newProduct);
    updateL3TiltControl();
}
function initL3Tilt() {
    document.getElementById('l3-tilt-up')?.addEventListener('click', () => stepL3Tilt(1));
    document.getElementById('l3-tilt-down')?.addEventListener('click', () => stepL3Tilt(-1));
}

// ── VAD Wind Profile (product NVW): wind barbs vs height + hodograph ──
function _vadBarbPaths(cx, cy, dirFrom, spd, len) {
    // Shaft points toward the direction the wind comes FROM (met convention, N=up).
    const a = dirFrom * Math.PI / 180;
    const ux = Math.sin(a), uy = -Math.cos(a);
    const ex = cx + ux * len, ey = cy + uy * len;       // free end
    const bx = -uy, by = ux;                             // perpendicular (barb side)
    const lines = [`M${cx.toFixed(1)},${cy.toFixed(1)} L${ex.toFixed(1)},${ey.toFixed(1)}`];
    const flags = [];
    let s = Math.round(spd / 5) * 5;
    let n50 = Math.floor(s / 50); s -= n50 * 50;
    let n10 = Math.floor(s / 10); s -= n10 * 10;
    let n5 = Math.floor(s / 5);
    let d = 0; const step = 4.6, bl = 9;
    for (let i = 0; i < n50; i++) {
        const p1x = ex - ux * d, p1y = ey - uy * d;
        const p2x = ex - ux * (d + step) + bx * bl, p2y = ey - uy * (d + step) + by * bl;
        const p3x = ex - ux * (d + step), p3y = ey - uy * (d + step);
        flags.push(`M${p1x.toFixed(1)},${p1y.toFixed(1)} L${p2x.toFixed(1)},${p2y.toFixed(1)} L${p3x.toFixed(1)},${p3y.toFixed(1)} Z`);
        d += step + 1.6;
    }
    for (let i = 0; i < n10; i++) {
        const p1x = ex - ux * d, p1y = ey - uy * d;
        lines.push(`M${p1x.toFixed(1)},${p1y.toFixed(1)} L${(p1x + bx * bl).toFixed(1)},${(p1y + by * bl).toFixed(1)}`);
        d += step;
    }
    for (let i = 0; i < n5; i++) {
        if (d === 0) d += step;
        const p1x = ex - ux * d, p1y = ey - uy * d;
        lines.push(`M${p1x.toFixed(1)},${p1y.toFixed(1)} L${(p1x + bx * bl * 0.5).toFixed(1)},${(p1y + by * bl * 0.5).toFixed(1)}`);
        d += step;
    }
    return { lines, flags };
}
function renderVadSVG(prof) {
    if (!prof || prof.length < 2) return '<div style="color:#6b7a88;font-size:12px;padding:16px;">No VAD wind data in range right now (needs echoes/insects aloft). Try again during precip or a well-mixed afternoon.</div>';
    // Levels cluster tightly at low altitude, so space rows EVENLY by level (each
    // labeled with its true height) to keep barbs and labels from overlapping.
    const lv = prof.slice().sort((a, b) => a.alt_ft - b.alt_ft);
    const W = 500, topM = 34, botM = 16, rowH = 18;
    const H = Math.max(300, topM + lv.length * rowH + botM);
    const yFor = i => H - botM - i * rowH;        // i = 0 -> lowest alt at bottom
    // barb column (evenly spaced)
    let barbs = '';
    const bx = 96;
    lv.forEach((p, i) => {
        const y = yFor(i);
        const { lines, flags } = _vadBarbPaths(bx, y, p.dir, p.spd, 22);
        barbs += lines.map(d => `<path d="${d}" stroke="#00e5ff" stroke-width="1.3" fill="none"/>`).join('');
        barbs += flags.map(d => `<path d="${d}" fill="#00e5ff" stroke="#00e5ff" stroke-width="0.6"/>`).join('');
        barbs += `<text x="52" y="${(y + 3).toFixed(1)}" fill="#8b97a3" font-size="8" text-anchor="end">${(p.alt_ft / 1000).toFixed(1)}k</text>`;
        barbs += `<text x="120" y="${(y + 3).toFixed(1)}" fill="#cfcfcf" font-size="8">${String(p.dir).padStart(3, '0')}/${p.spd}</text>`;
    });
    // hodograph
    const hx = 250, hy = 40, hw = 230, hh = 230;
    const hcx = hx + hw / 2, hcy = hy + hh / 2;
    const maxSpd = Math.max(...lv.map(p => p.spd), 20);
    const ringMax = Math.ceil(maxSpd / 10) * 10;
    const sc = (hw / 2 - 10) / ringMax;
    let hodo = `<rect x="${hx}" y="${hy}" width="${hw}" height="${hh}" fill="#0a0f16" stroke="#1e2a35"/>`;
    for (let r = 10; r <= ringMax; r += 10) {
        hodo += `<circle cx="${hcx}" cy="${hcy}" r="${(r * sc).toFixed(1)}" fill="none" stroke="#1e2a35" stroke-width="0.7"/>`;
        hodo += `<text x="${hcx + r * sc}" y="${hcy - 2}" fill="#5c6b78" font-size="7">${r}</text>`;
    }
    hodo += `<line x1="${hcx}" y1="${hy}" x2="${hcx}" y2="${hy + hh}" stroke="#1e2a35" stroke-width="0.6"/>`;
    hodo += `<line x1="${hx}" y1="${hcy}" x2="${hx + hw}" y2="${hcy}" stroke="#1e2a35" stroke-width="0.6"/>`;
    const pts = lv.map(p => {
        const u = -p.spd * Math.sin(p.dir * Math.PI / 180);
        const v = -p.spd * Math.cos(p.dir * Math.PI / 180);
        return [hcx + u * sc, hcy - v * sc];
    });
    hodo += `<polyline points="${pts.map(pt => pt[0].toFixed(1) + ',' + pt[1].toFixed(1)).join(' ')}" fill="none" stroke="#ffe14d" stroke-width="1.8"/>`;
    pts.forEach((pt, i) => { hodo += `<circle cx="${pt[0].toFixed(1)}" cy="${pt[1].toFixed(1)}" r="2" fill="${i === 0 ? '#33c27a' : i === pts.length - 1 ? '#ff3b3b' : '#ffe14d'}"/>`; });
    hodo += `<text x="${hx}" y="${hy - 4}" fill="#8b97a3" font-size="8">Hodograph (kt) — ● sfc  ● top</text>`;
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="background:transparent;">
        <text x="52" y="20" fill="#8b97a3" font-size="8" text-anchor="end">ALT</text>
        <text x="96" y="20" fill="#8b97a3" font-size="8" text-anchor="middle">WIND</text>
        ${barbs}${hodo}
    </svg>`;
}
async function loadVad(station) {
    const meta = document.getElementById('vad-meta');
    const body = document.getElementById('vad-body');
    if (meta) meta.textContent = `Fetching VAD wind profile for ${station}…`;
    try {
        const res = await fetch(`/api/radar-l3?station=${station}&product=NVW&_=${Date.now()}`);
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'VAD failed');
        const prof = data.profile || [];
        if (meta) meta.textContent = `${station} · VAD Wind Profile · ${data.meta.time} · ${prof.length} levels`;
        if (body) body.innerHTML = renderVadSVG(prof);
    } catch (e) {
        if (meta) meta.textContent = `VAD error: ${e.message}`;
        if (body) body.innerHTML = `<div style="color:#ff6666;font-size:11px;padding:16px;">Could not load VAD (${esc(e.message)}). This product needs radar returns aloft over the site.</div>`;
    }
}
function vadStation() {
    let s = (paneRadarSites[activePaneId] || '').toUpperCase();
    if (!s || s.includes('NEXRAD')) {
        s = 'DGX';
        paneRadarSites[activePaneId] = 'DGX';
        const sel = document.getElementById('radar-site-select');
        if (sel) sel.value = 'DGX';
    }
    return s;
}
async function openVadPanel() {
    const panel = document.getElementById('vad-panel');
    if (!panel) return;
    panel.style.display = 'block';
    panel.dataset.station = vadStation();
    await loadVad(panel.dataset.station);
}
function initVadPanel() {
    document.getElementById('btn-vad')?.addEventListener('click', openVadPanel);
    document.getElementById('close-vad-panel')?.addEventListener('click', () => {
        const p = document.getElementById('vad-panel'); if (p) p.style.display = 'none';
    });
    document.getElementById('vad-refresh')?.addEventListener('click', () => {
        const p = document.getElementById('vad-panel');
        loadVad((p && p.dataset.station) || vadStation());
    });
    // simple drag on the header
    const panel = document.getElementById('vad-panel');
    const handle = document.getElementById('vad-drag');
    if (panel && handle) {
        let dx = 0, dy = 0, drag = false;
        handle.style.cursor = 'move';
        handle.addEventListener('mousedown', e => {
            if (e.target.closest(DRAG_IGNORE)) return;
            drag = true; dx = e.clientX - panel.offsetLeft; dy = e.clientY - panel.offsetTop;
            e.preventDefault();
        });
        window.addEventListener('mousemove', e => {
            if (!drag) return;
            panel.style.left = Math.max(0, e.clientX - dx) + 'px';
            panel.style.top = Math.max(0, e.clientY - dy) + 'px';
            panel.style.right = 'auto';
        });
        window.addEventListener('mouseup', () => { drag = false; });
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 30: INTERACTIVE SKEW-T / LOG-P (RAOB, NSHARP-lite)
// ═══════════════════════════════════════════════════════════════════════════════
// Pulls a real radiosonde profile (IEM JSON, CORS-open), renders a skew-T diagram
// with parcel ascent + hodograph in an SVG, and computes surface-based instability
// indices client-side. All math is in JS — negligible runtime weight, no server work.

// Curated US upper-air (RAOB) sites: id -> [lat, lon, wmo]. The WMO number lets
// the /api/raob proxy pull the high-resolution BUFR sounding from Wyoming.
const RAOB_SITES = {
    KOUN: [35.18, -97.44, 72357], KLZK: [34.83, -92.26, 72340], KBMX: [33.10, -86.70, 72230], KFWD: [32.83, -97.30, 72249],
    KJAN: [32.32, -90.08, 72235], KLIX: [30.34, -89.83, 72233], KJAX: [30.48, -81.70, 72206],
    KTBW: [27.70, -82.40, 72210], KMFL: [25.75, -80.38, 72202], KEYW: [24.55, -81.75, 72201], KCRP: [27.77, -97.50, 72251],
    KBRO: [25.90, -97.42, 72250], KDRT: [29.37, -100.92, 72261], KMAF: [31.94, -102.19, 72265], KEPZ: [31.87, -106.70, 72364],
    KABQ: [35.04, -106.62, 72365], KAMA: [35.23, -101.70, 72363], KDDC: [37.76, -99.97, 72451], KTOP: [39.07, -95.62, 72456],
    KOAX: [41.32, -96.37, 72558], KLBF: [41.13, -100.68, 72562], KDNR: [39.77, -104.88, 72469], KRIW: [43.06, -108.48, 72672],
    KBIS: [46.77, -100.75, 72764], KABR: [45.45, -98.41, 72659], KMPX: [44.85, -93.56, 72649], KDVN: [41.61, -90.58, 74455],
    KILX: [40.15, -89.34, 74560], KGRB: [44.50, -88.11, 72645], KDTX: [42.70, -83.47, 72632], KILN: [39.42, -83.82, 72426],
    KBNA: [36.25, -86.57, 72327], KGSO: [36.08, -79.95, 72317], KRNK: [37.20, -80.41, 72318], KIAD: [38.98, -77.47, 72403],
    KWAL: [37.93, -75.48, 72402], KOKX: [40.87, -72.86, 72501], KALB: [42.70, -73.83, 72518], KBUF: [42.94, -78.72, 72528],
    KPIT: [40.53, -80.23, 72520], KGYX: [43.89, -70.25, 74389], KCHH: [41.65, -69.96, 74494], KUNR: [44.07, -103.21, 72662],
    KLKN: [40.87, -115.73, 72582], KSLC: [40.77, -111.95, 72572], KBOI: [43.56, -116.21, 72681], KGGW: [48.21, -106.62, 72768],
    KTFX: [47.46, -111.38, 72776], KOTX: [47.68, -117.63, 72786], KSLE: [44.91, -123.00, 72694], KMFR: [42.37, -122.87, 72597],
    KREV: [39.57, -119.80, 72489], KVEF: [36.05, -115.18, 72388], KNKX: [32.87, -117.15, 72293], KVBG: [34.75, -120.52, 72393],
    KOAK: [37.73, -122.22, 72493], KTUS: [32.23, -110.96, 72274]
};

// ── Thermodynamics (Bolton 1980; pseudoadiabatic parcel). T in °C unless noted K. ──
const _Rd = 287.04, _cpd = 1004, _Lv = 2.5e6, _epsw = 0.622, _gg = 9.81;
function _esat(Tc) { return 6.112 * Math.exp(17.67 * Tc / (Tc + 243.5)); }        // hPa
function _mixr(Tc, p) { const e = _esat(Tc); return _epsw * e / (p - e); }          // kg/kg
function _lclTempK(Tk, Tdk) { return 56 + 1 / (1 / (Tdk - 56) + Math.log(Tk / Tdk) / 800); }
function _moistLapse(Tk, p) {                                                        // dT/dp (K/hPa)
    const ws = _mixr(Tk - 273.15, p);
    const num = _Rd * Tk + _Lv * ws;
    const den = _cpd + (_Lv * _Lv * ws * _epsw) / (_Rd * Tk * Tk);
    return (num / den) / p;
}
function _uv(dir, spd) { const a = dir * Math.PI / 180; return [-spd * Math.sin(a), -spd * Math.cos(a)]; }
const _KT2MS = 0.514444;
// Bolton (1980) eq. 39 equivalent potential temperature — the quantity both the
// most-unstable parcel search and DCAPE's source-level search are ranked on.
function _thetaE(Tc, Tdc, p) {
    const Tk = Tc + 273.15, w = _mixr(Tdc, p);
    const Tl = _lclTempK(Tk, Tdc + 273.15);
    const th = Tk * Math.pow(1000 / p, 0.2854 * (1 - 0.28 * w));
    return th * Math.exp((3.376 / Tl - 0.00254) * 1000 * w * (1 + 0.81 * w));
}
function _dewpFromW(w, p) {                    // inverse of _mixr, for the mixed-layer parcel
    const e = w * p / (_epsw + w);
    if (!(e > 0)) return -80;
    const l = Math.log(e / 6.112);
    return 243.5 * l / (17.67 - l);
}
// Thin a profile to ~dp-hPa spacing. The effective-inflow scan lifts a parcel from
// every candidate level, so it runs on a coarsened copy — a 4000-level BUFR sounding
// would otherwise mean thousands of full lifts for a threshold test that only needs
// to know whether CAPE clears 100 J/kg.
function _coarsen(lv, dp) {
    const out = [lv[0]];
    let last = lv[0].pres;
    for (const l of lv) if (last - l.pres >= dp) { out.push(l); last = l.pres; }
    if (out[out.length - 1] !== lv[lv.length - 1]) out.push(lv[lv.length - 1]);
    return out;
}

// ── Generalized parcel lift ────────────────────────────────────────────────
// The original code lifted only the surface parcel. This takes a start index k
// and an explicit (p0,T0,Td0) — which lets the mixed-layer parcel carry averaged
// properties while still starting at the surface, and lets the most-unstable
// parcel start aloft with everything below it excluded from the integration.
// Virtual-temperature buoyancy throughout (SPC/SHARPpy convention).
function _liftParcel(lv, k, p0, T0c, Td0c) {
    const n = lv.length;
    const T0 = T0c + 273.15, w0 = _mixr(Td0c, p0);
    const Tlcl = _lclTempK(T0, Td0c + 273.15);
    const Plcl = p0 * Math.pow(Tlcl / T0, 1 / 0.2854);
    const TkLcl = T0 * Math.pow(Plcl / p0, 0.2854);
    const Tp = new Array(n).fill(NaN), buoy = new Array(n).fill(NaN);
    const tv = (Tk, w) => Tk * (1 + 0.61 * w);
    let mT = TkLcl, mP = Plcl;
    for (let i = k; i < n; i++) {
        const p = lv[i].pres;
        if (p >= Plcl) { Tp[i] = T0 * Math.pow(p / p0, 0.2854); mT = TkLcl; mP = Plcl; }
        else {
            let Tk = mT, pp = mP;
            while (pp > p) { const dp = Math.max(-2, p - pp); Tk += _moistLapse(Tk, pp) * dp; pp += dp; }
            Tp[i] = Tk; mT = Tk; mP = p;
        }
        const Tev = tv(lv[i].tmpc + 273.15, _mixr(lv[i].dwpc, p));
        buoy[i] = (tv(Tp[i], p >= Plcl ? w0 : _mixr(Tp[i] - 273.15, p)) - Tev) / Tev;
    }
    const pos = [];
    for (let i = k; i < n; i++) if (lv[i].pres <= Plcl + 0.5 && buoy[i] > 0) pos.push(i);
    let cape = 0, cin = 0, lfc = null, el = null, elZ = null;
    if (pos.length) {
        const lfcI = pos[0], elI = pos[pos.length - 1];
        lfc = lv[lfcI].pres; el = lv[elI].pres; elZ = lv[elI].hght;
        for (let i = lfcI + 1; i <= elI; i++) { const dz = lv[i].hght - lv[i - 1].hght; cape += _gg * 0.5 * (Math.max(buoy[i - 1], 0) + Math.max(buoy[i], 0)) * dz; }
        for (let i = k + 1; i <= lfcI; i++) { const dz = lv[i].hght - lv[i - 1].hght; cin += _gg * 0.5 * (Math.min(buoy[i - 1], 0) + Math.min(buoy[i], 0)) * dz; }
    }
    let li = null;
    for (let i = k; i < n; i++) if (Math.abs(lv[i].pres - 500) < 8) { li = (lv[i].tmpc + 273.15) - Tp[i]; break; }
    const lclZ = (_Rd * 0.5 * (T0 + Tlcl) / _gg) * Math.log(p0 / Plcl);
    return { Tp, buoy, Plcl, lclZ, cape, cin, li, lfc, el, elZ };
}
// Mixed-layer parcel: mean theta and mean mixing ratio over the lowest 100 hPa,
// brought back to the surface. Less hostage to one superadiabatic surface reading
// than SB, which is why SPC hangs most severe parameters off it.
function _mlParcel(lv) {
    const p0 = lv[0].pres, ptop = p0 - 100;
    let sth = 0, sw = 0, n = 0;
    for (const l of lv) {
        if (l.pres < ptop) break;
        sth += (l.tmpc + 273.15) * Math.pow(1000 / l.pres, 0.2854);
        sw += _mixr(l.dwpc, l.pres); n++;
    }
    if (!n) return null;
    const Tk = (sth / n) * Math.pow(p0 / 1000, 0.2854);
    return { k: 0, p: p0, T: Tk - 273.15, Td: _dewpFromW(sw / n, p0) };
}
// Most-unstable parcel: highest theta-e in the lowest 300 hPa. This is the one
// that finds elevated convection a surface parcel reports as zero.
function _muParcel(lv) {
    const ptop = lv[0].pres - 300;
    let best = 0, bthe = -1e9;
    for (let i = 0; i < lv.length; i++) {
        if (lv[i].pres < ptop) break;
        const the = _thetaE(lv[i].tmpc, lv[i].dwpc, lv[i].pres);
        if (the > bthe) { bthe = the; best = i; }
    }
    return { k: best, p: lv[best].pres, T: lv[best].tmpc, Td: lv[best].dwpc };
}
// Effective inflow layer (Thompson et al. 2007): the contiguous run of levels whose
// parcels have CAPE >= 100 J/kg and CIN >= -250 J/kg. Replaces fixed 0-1/0-3 km
// layers for storm-relative helicity and is what SPC's STP/SCP are defined on.
function _effInflow(lvC) {
    const p0 = lvC[0].pres, z0 = lvC[0].hght;
    let bot = null, top = null;
    for (let i = 0; i < lvC.length; i++) {
        if (lvC[i].pres < p0 - 400) break;
        const r = _liftParcel(lvC, i, lvC[i].pres, lvC[i].tmpc, lvC[i].dwpc);
        if (r.cape >= 100 && r.cin >= -250) { if (bot === null) bot = i; top = i; }
        else if (bot !== null) break;
    }
    // A single qualifying level is a zero-depth "layer": SRH and shear across it are
    // identically ~0, which reads as "no helicity" rather than "not applicable".
    // SPC shows no effective inflow layer in that case, so neither do we.
    if (bot === null || top <= bot) return null;
    return {
        botZ: lvC[bot].hght - z0, topZ: lvC[top].hght - z0,
        botP: lvC[bot].pres, topP: lvC[top].pres,
        depth: lvC[top].hght - lvC[bot].hght
    };
}
// Bunkers (2000) internal dynamics method — 0-6 km mean wind deviated 7.5 m/s
// orthogonal to the 0-6 km shear vector. Returns m/s components.
function _bunkers(lv) {
    const w = lv.filter(l => l.drct != null && l.sknt != null && l.hght != null);
    if (w.length < 2) return null;
    const z0 = w[0].hght;
    const meanUV = (zlo, zhi) => {
        let su = 0, sv = 0, n = 0;
        for (const l of w) { const z = l.hght - z0; if (z >= zlo && z <= zhi) { const uv = _uv(l.drct, l.sknt); su += uv[0]; sv += uv[1]; n++; } }
        return n ? [su / n * _KT2MS, sv / n * _KT2MS] : null;
    };
    const mean06 = meanUV(0, 6000);
    if (!mean06) return null;
    const low = meanUV(0, 500) || mean06, high = meanUV(5500, 6000) || mean06;
    const sh = [high[0] - low[0], high[1] - low[1]];
    const mag = Math.hypot(sh[0], sh[1]);
    if (!(mag > 0)) return { rm: mean06, lm: mean06, mean: mean06 };
    const D = 7.5;
    return {
        rm: [mean06[0] + D * sh[1] / mag, mean06[1] - D * sh[0] / mag],
        lm: [mean06[0] - D * sh[1] / mag, mean06[1] + D * sh[0] / mag],
        mean: mean06
    };
}
// Storm-relative helicity over an AGL layer, given storm motion C (m/s).
function _srh(lv, zlo, zhi, C) {
    const w = lv.filter(l => l.drct != null && l.sknt != null && l.hght != null);
    if (w.length < 2 || !C) return null;
    const z0 = w[0].hght;
    let s = 0;
    for (let i = 1; i < w.length; i++) {
        const za = w[i - 1].hght - z0, zb = w[i].hght - z0;
        if (zb < zlo || za > zhi) continue;
        const a = _uv(w[i - 1].drct, w[i - 1].sknt), b = _uv(w[i].drct, w[i].sknt);
        const u0 = a[0] * _KT2MS - C[0], v0 = a[1] * _KT2MS - C[1];
        const u1 = b[0] * _KT2MS - C[0], v1 = b[1] * _KT2MS - C[1];
        s += (u1 * v0 - u0 * v1);
    }
    return s;
}
// Bulk shear magnitude (kt) between two AGL heights.
function _bulkShear(lv, zlo, zhi) {
    const w = lv.filter(l => l.drct != null && l.sknt != null && l.hght != null);
    if (w.length < 2) return null;
    const z0 = w[0].hght;
    const at = agl => { let best = w[0], bd = 1e18; for (const l of w) { const d = Math.abs((l.hght - z0) - agl); if (d < bd) { bd = d; best = l; } } return best; };
    const a = _uv(at(zlo).drct, at(zlo).sknt), b = _uv(at(zhi).drct, at(zhi).sknt);
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
}
// DCAPE — lowest-theta-e parcel in the lowest 400 hPa brought down moist-adiabatically
// to the surface. A proxy for downdraft strength / wet-microburst potential.
function _dcape(lv) {
    const ptop = lv[0].pres - 400;
    let src = 0, bthe = 1e9;
    for (let i = 0; i < lv.length; i++) {
        if (lv[i].pres < ptop) break;
        const the = _thetaE(lv[i].tmpc, lv[i].dwpc, lv[i].pres);
        if (the < bthe) { bthe = the; src = i; }
    }
    if (!src) return null;
    // The descending parcel starts SATURATED at the source level's wet-bulb
    // temperature — not its dewpoint. Starting at Td makes the parcel several
    // degrees too cold the whole way down and roughly doubles the answer.
    let Tk = _wetBulb(lv[src].tmpc, lv[src].dwpc, lv[src].pres) + 273.15;
    let pp = lv[src].pres, d = 0;
    for (let i = src - 1; i >= 0; i--) {
        const p = lv[i].pres;
        while (pp < p) { const dp = Math.min(2, p - pp); Tk += _moistLapse(Tk, pp) * dp; pp += dp; }
        const Tenv = lv[i].tmpc + 273.15;
        d += _gg * ((Tenv - Tk) / Tenv) * (lv[i + 1].hght - lv[i].hght);
    }
    return d > 0 ? d : 0;
}
function _lapse(lv, zlo, zhi) {                 // °C/km over an AGL layer
    const z0 = lv[0].hght;
    const at = agl => { let best = lv[0], bd = 1e18; for (const l of lv) { const d = Math.abs((l.hght - z0) - agl); if (d < bd) { bd = d; best = l; } } return best; };
    const a = at(zlo), b = at(zhi);
    const dz = (b.hght - a.hght) / 1000;
    return dz > 0.1 ? (a.tmpc - b.tmpc) / dz : null;
}
function _lapseP(lv, plo, phi) {                // °C/km between two pressure levels
    const at = p => { let best = lv[0], bd = 1e18; for (const l of lv) { const d = Math.abs(l.pres - p); if (d < bd) { bd = d; best = l; } } return best; };
    const a = at(plo), b = at(phi);
    const dz = (b.hght - a.hght) / 1000;
    return dz > 0.1 ? (a.tmpc - b.tmpc) / dz : null;
}
// Wet-bulb temperature by Normand's construction: lift to the LCL, then descend the
// saturated adiabat back to the starting pressure.
function _wetBulb(Tc, Tdc, p) {
    const Tk = Tc + 273.15;
    const Tlcl = _lclTempK(Tk, Tdc + 273.15);
    const Plcl = p * Math.pow(Tlcl / Tk, 1 / 0.2854);
    let T = Tlcl, pp = Plcl;
    while (pp < p) { const dp = Math.min(2, p - pp); T += _moistLapse(T, pp) * dp; pp += dp; }
    return T - 273.15;
}
function _wbzHeight(lv) {                       // lowest AGL crossing of Tw = 0 °C
    const z0 = lv[0].hght;
    let prev = _wetBulb(lv[0].tmpc, lv[0].dwpc, lv[0].pres);
    for (let i = 1; i < lv.length; i++) {
        const tw = _wetBulb(lv[i].tmpc, lv[i].dwpc, lv[i].pres);
        if (prev >= 0 && tw <= 0) {
            const f = prev / (prev - tw || 1);
            return lv[i - 1].hght + f * (lv[i].hght - lv[i - 1].hght) - z0;
        }
        prev = tw;
    }
    return null;
}
function _heightOf(lv, Tc) {                    // first AGL crossing of an isotherm
    const z0 = lv[0].hght;
    for (let i = 1; i < lv.length; i++) {
        if (lv[i - 1].tmpc >= Tc && lv[i].tmpc <= Tc) {
            const f = (lv[i - 1].tmpc - Tc) / (lv[i - 1].tmpc - lv[i].tmpc || 1);
            return lv[i - 1].hght + f * (lv[i].hght - lv[i - 1].hght) - z0;
        }
    }
    return null;
}

function _skewtShear(lv) {
    const w = lv.filter(l => l.drct != null && l.sknt != null && l.hght != null);
    if (w.length < 2) return { shear01: null, shear06: null };
    const z0 = w[0].hght;
    const nearest = agl => { let best = w[0], bd = 1e18; for (const l of w) { const d = Math.abs((l.hght - z0) - agl); if (d < bd) { bd = d; best = l; } } return best; };
    const s = _uv(w[0].drct, w[0].sknt);
    const u1 = _uv(nearest(1000).drct, nearest(1000).sknt);
    const u6 = _uv(nearest(6000).drct, nearest(6000).sknt);
    const mag = (a, b) => Math.round(Math.hypot(a[0] - b[0], a[1] - b[1]));
    return { shear01: mag(s, u1), shear06: mag(s, u6) };
}
function _skewtCompute(lv) {
    const sfc = lv[0];
    const P = lv.map(l => l.pres), Z = lv.map(l => l.hght), Te = lv.map(l => l.tmpc + 273.15);
    // Surface parcel — still the one drawn on the chart and shaded for CAPE.
    const SB = _liftParcel(lv, 0, sfc.pres, sfc.tmpc, sfc.dwpc);
    // Mixed-layer and most-unstable parcels. ML is what the severe composites below
    // key on; MU is what catches elevated convection that SB reports as zero.
    const mlp = _mlParcel(lv), mup = _muParcel(lv);
    const ML = mlp ? _liftParcel(lv, mlp.k, mlp.p, mlp.T, mlp.Td) : null;
    const MU = mup ? _liftParcel(lv, mup.k, mup.p, mup.T, mup.Td) : null;

    let pw = 0; for (let i = 1; i < lv.length; i++) { const w0 = _mixr(lv[i - 1].dwpc, lv[i - 1].pres), w1 = _mixr(lv[i].dwpc, lv[i].pres); pw += 0.5 * (w0 + w1) * (lv[i - 1].pres - lv[i].pres) * 100 / _gg; }

    // ── Kinematics ──
    const bunk = _bunkers(lv);
    const Crm = bunk ? bunk.rm : null;
    const srh01 = _srh(lv, 0, 1000, Crm), srh03 = _srh(lv, 0, 3000, Crm);
    // Effective inflow layer runs on a coarsened profile — see _coarsen.
    const eff = _effInflow(_coarsen(lv, 10));
    let esrh = null, ebwd = null;
    if (eff && Crm) {
        esrh = _srh(lv, eff.botZ, eff.topZ, Crm);
        // Effective bulk wind difference: inflow base to half the depth between the
        // inflow base and the MU equilibrium level (Thompson et al. 2007).
        if (MU && MU.elZ != null) {
            const half = eff.botZ + 0.5 * ((MU.elZ - lv[0].hght) - eff.botZ);
            if (half > eff.botZ) ebwd = _bulkShear(lv, eff.botZ, half);
        }
    }

    // ── Composites (SPC formulations) ──
    let scp = null, stp = null;
    if (MU && esrh != null && ebwd != null) {
        const sh = ebwd * _KT2MS;
        const shT = sh > 20 ? 1 : sh < 10 ? 0 : sh / 20;
        scp = (MU.cape / 1000) * (esrh / 50) * shT;
    }
    if (ML && eff && esrh != null && ebwd != null) {
        const sh = ebwd * _KT2MS;
        const shT = sh > 30 ? 1.5 : sh < 12.5 ? 0 : sh / 20;
        const lclT = ML.lclZ < 1000 ? 1 : ML.lclZ > 2000 ? 0 : (2000 - ML.lclZ) / 1000;
        const cinT = ML.cin > -50 ? 1 : ML.cin < -200 ? 0 : (200 + ML.cin) / 150;
        stp = (ML.cape / 1500) * lclT * (esrh / 150) * shT * cinT;
    }

    return Object.assign({
        P, Z, Te, Tp: SB.Tp, Plcl: SB.Plcl,
        cape: SB.cape, cin: SB.cin, li: SB.li, lclZ: SB.lclZ, lfc: SB.lfc, el: SB.el,
        pw, SB, ML, MU, mlSrc: mlp, muSrc: mup,
        eff, bunkers: bunk, srh01, srh03, esrh, ebwd, scp, stp,
        dcape: _dcape(lv),
        lr03: _lapse(lv, 0, 3000), lr75: _lapseP(lv, 700, 500),
        fzZ: _heightOf(lv, 0), m20Z: _heightOf(lv, -20), wbzZ: _wbzHeight(lv)
    }, _skewtShear(lv));
}

function _ir(k, v, c) { return `<div style="display:flex;justify-content:space-between;"><span style="color:#8b97a3;">${k}</span><span style="color:${c};font-weight:600;">${v}</span></div>`; }
// One-line header summary, shared by the observed and model paths so they can't drift.
function _skewtSummary(D) {
    const p = x => x == null ? '—' : Math.round(x.cape);
    let s = `SB ${p(D.SB)} / ML ${p(D.ML)} / MU ${p(D.MU)} J/kg · CIN ${Math.round(D.cin)}`
        + ` · LI ${D.li != null ? D.li.toFixed(1) : '—'} · PWAT ${(D.pw / 25.4).toFixed(2)} in`;
    if (D.esrh != null) s += ` · ESRH ${Math.round(D.esrh)}`;
    if (D.stp != null) s += ` · STP ${D.stp.toFixed(1)}`;
    return s;
}
function _skewtHodo(wl) {
    const S = 200, cx = S / 2, cy = S / 2;
    const z0 = wl.length ? wl[0].hght : 0;
    const raw = wl.filter(l => (l.hght - z0) <= 10000);
    const hstep = Math.max(1, Math.ceil(raw.length / 120));   // thin dense BUFR winds
    const pts = raw.filter((_, i) => i % hstep === 0 || i === raw.length - 1).map(l => { const uv = _uv(l.drct, l.sknt); return { u: uv[0], v: uv[1] }; });
    const maxS = Math.max(20, ...pts.map(p => Math.hypot(p.u, p.v)));
    const ring = Math.ceil(maxS / 10) * 10;
    const sc = (S / 2 - 12) / ring;
    let g = `<rect x="0" y="0" width="${S}" height="${S}" fill="#0a0f16" stroke="#1e2a35"/>`;
    for (let r = 10; r <= ring; r += 10) { g += `<circle cx="${cx}" cy="${cy}" r="${(r * sc).toFixed(1)}" fill="none" stroke="#1e2a35" stroke-width="0.7"/><text x="${cx + r * sc}" y="${cy - 2}" fill="#5c6b78" font-size="7">${r}</text>`; }
    g += `<line x1="${cx}" y1="0" x2="${cx}" y2="${S}" stroke="#1e2a35" stroke-width="0.6"/><line x1="0" y1="${cy}" x2="${S}" y2="${cy}" stroke="#1e2a35" stroke-width="0.6"/>`;
    const XY = pts.map(p => [cx + p.u * sc, cy - p.v * sc]);
    if (XY.length) g += `<polyline points="${XY.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ')}" fill="none" stroke="#ffe14d" stroke-width="1.8"/>`;
    XY.forEach((p, i) => { const col = i === 0 ? '#33c27a' : i === XY.length - 1 ? '#ff3b3b' : '#ffe14d'; g += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2" fill="${col}"/>`; });
    return `<svg viewBox="0 0 ${S} ${S}" width="200" height="200" style="flex:0 0 auto;"><text x="2" y="9" fill="#8b97a3" font-size="8">Hodograph (kt, 0–10 km) ● sfc ● top</text>${g}</svg>`;
}
function renderSkewT(lv, D) {
    const PL = 46, PT = 16, PW = 372, PH = 520, PB = PT + PH, PR = PL + PW;
    const Ptop = 100, Pbot = 1050, Tmin = -45, Tmax = 45, SKEW = 0.62;
    const yP = p => PT + Math.log(p / Ptop) / Math.log(Pbot / Ptop) * PH;
    const xTP = (Tc, p) => PL + ((Tc - Tmin) / (Tmax - Tmin)) * PW + (PB - yP(p)) * SKEW;
    const poly = a => a.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
    // isobars + labels
    let grid = '';
    [1000, 850, 700, 500, 400, 300, 250, 200, 150, 100].forEach(p => {
        const y = yP(p);
        grid += `<line x1="${PL}" y1="${y.toFixed(1)}" x2="${PR}" y2="${y.toFixed(1)}" stroke="#243040" stroke-width="0.7"/>`;
        grid += `<text x="${PL - 4}" y="${(y + 3).toFixed(1)}" fill="#7f8c99" font-size="8" text-anchor="end">${p}</text>`;
    });
    // isotherms (clipped)
    let iso = '';
    for (let T = -100; T <= 50; T += 10) {
        const x1 = xTP(T, Pbot), y1 = yP(Pbot), x2 = xTP(T, Ptop), y2 = yP(Ptop);
        const c = T === 0 ? '#4a6a55' : '#26333f';
        iso += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${c}" stroke-width="${T === 0 ? 1.1 : 0.6}"/>`;
        if (x1 >= PL - 2 && x1 <= PR + 2) iso += `<text x="${x1.toFixed(1)}" y="${(PB + 11).toFixed(1)}" fill="#6b7a88" font-size="7" text-anchor="middle">${T}</text>`;
    }
    // dry adiabats (faint, clipped)
    let dry = '';
    for (let th = -20; th <= 160; th += 20) {
        let d = '';
        for (let p = Pbot; p >= Ptop; p -= 25) { const Tc = (th + 273.15) * Math.pow(p / 1000, 0.2854) - 273.15; d += (d ? 'L' : 'M') + xTP(Tc, p).toFixed(1) + ',' + yP(p).toFixed(1); }
        dry += `<path d="${d}" fill="none" stroke="#2a2118" stroke-width="0.6"/>`;
    }
    // traces — decimated (dense BUFR profiles are ~4000 levels; ~500 pts is plenty
    // for a smooth curve and keeps the SVG DOM light).
    const step = Math.max(1, Math.ceil(lv.length / 500));
    const keep = [];
    for (let i = 0; i < lv.length; i += step) keep.push(i);
    if (keep[keep.length - 1] !== lv.length - 1) keep.push(lv.length - 1);
    const Ttrace = keep.map(i => [xTP(lv[i].tmpc, lv[i].pres), yP(lv[i].pres)]);
    const Dtrace = keep.map(i => [xTP(lv[i].dwpc, lv[i].pres), yP(lv[i].pres)]);
    const Ptrace = keep.map(i => [xTP(D.Tp[i] - 273.15, lv[i].pres), yP(lv[i].pres)]);
    // CAPE shading (parcel warmer than env, LFC→EL), sampled the same way
    let capeShade = '';
    if (D.lfc && D.el) {
        const idx = keep.filter(i => lv[i].pres <= D.lfc && lv[i].pres >= D.el && D.Tp[i] > D.Te[i]);
        if (idx.length > 1) {
            const up = idx.map(i => [xTP(D.Tp[i] - 273.15, lv[i].pres), yP(lv[i].pres)]);
            const down = idx.slice().reverse().map(i => [xTP(lv[i].tmpc, lv[i].pres), yP(lv[i].pres)]);
            capeShade = `<polygon points="${poly(up.concat(down))}" fill="#ff3b3b" fill-opacity="0.15"/>`;
        }
    }
    // wind barbs at right margin — evenly spaced by screen position (every ~18 px)
    // so dense BUFR profiles show many more levels than a fixed mandatory-level list.
    let barbs = ''; const bx = PR + 22;
    const wl = lv.filter(l => l.drct != null && l.sknt != null);
    const chosen = []; let lastBarbY = Infinity;
    for (const l of wl) {                        // wl is surface-first (descending pressure)
        const y = yP(l.pres);
        if (y < PT || y > PB) continue;
        if (lastBarbY - y >= 18) { chosen.push(l); lastBarbY = y; }
    }
    chosen.forEach(l => {
        const y = yP(l.pres); const bp = _vadBarbPaths(bx, y, l.drct, l.sknt, 17);
        barbs += bp.lines.map(d => `<path d="${d}" stroke="#cfe0ee" stroke-width="1" fill="none"/>`).join('');
        barbs += bp.flags.map(d => `<path d="${d}" fill="#cfe0ee" stroke="#cfe0ee" stroke-width="0.5"/>`).join('');
    });
    const svgW = PR + 46, svgH = PB + 22;
    const skewSVG = `<svg viewBox="0 0 ${svgW} ${svgH}" width="470" style="background:#0a0f16;border:1px solid #1e2a35;flex:0 0 auto;">
        <defs><clipPath id="skewtclip"><rect x="${PL}" y="${PT}" width="${PW}" height="${PH}"/></clipPath></defs>
        ${grid}
        <g clip-path="url(#skewtclip)">${dry}${iso}${capeShade}
            <polyline points="${poly(Dtrace)}" fill="none" stroke="#33c27a" stroke-width="2"/>
            <polyline points="${poly(Ttrace)}" fill="none" stroke="#ff4444" stroke-width="2"/>
            <polyline points="${poly(Ptrace)}" fill="none" stroke="#ffe14d" stroke-width="1.4" stroke-dasharray="4,3"/>
        </g>
        <rect x="${PL}" y="${PT}" width="${PW}" height="${PH}" fill="none" stroke="#2e3d4c" stroke-width="1"/>
        ${barbs}
        <text x="${PL}" y="11" fill="#8b97a3" font-size="8">Skew-T / Log-P (°C) — ▬ T ▬ Td ┈ parcel</text>
    </svg>`;
    const fx = v => v == null ? '—' : Math.round(v);
    const f1 = v => v == null ? '—' : v.toFixed(1);
    // Parcel table — SB / ML / MU side by side, the way NSHARP lays it out. The
    // point of three columns is that they disagree: MU finds elevated instability
    // SB reports as zero, and ML resists a single overheated surface reading.
    const cap = (p, warn) => p == null ? '<td style="text-align:right;color:#5c6b78;">—</td>'
        : `<td style="text-align:right;color:${warn && p.cape > 1000 ? '#ff6a6a' : '#cdd6df'};font-weight:600;">${Math.round(p.cape)}</td>`;
    const cell = (p, f, c) => p == null ? '<td style="text-align:right;color:#5c6b78;">—</td>'
        : `<td style="text-align:right;color:${c || '#cdd6df'};">${f(p)}</td>`;
    const th = t => `<th style="text-align:right;color:#8b97a3;font-weight:600;padding-left:6px;">${t}</th>`;
    const rowLbl = t => `<td style="color:#8b97a3;">${t}</td>`;
    const parcels = [D.SB, D.ML, D.MU];
    const parcelTable = `<table style="width:100%;border-collapse:collapse;font-size:9.5px;line-height:1.7;">
        <tr><td></td>${th('SB')}${th('ML')}${th('MU')}</tr>
        <tr>${rowLbl('CAPE J/kg')}${parcels.map(p => cap(p, true)).join('')}</tr>
        <tr>${rowLbl('CIN J/kg')}${parcels.map(p => cell(p, x => Math.round(x.cin), '#7fbfff')).join('')}</tr>
        <tr>${rowLbl('LCL m AGL')}${parcels.map(p => cell(p, x => Math.round(x.lclZ))).join('')}</tr>
        <tr>${rowLbl('LFC hPa')}${parcels.map(p => cell(p, x => x.lfc ? Math.round(x.lfc) : '—')).join('')}</tr>
        <tr>${rowLbl('EL hPa')}${parcels.map(p => cell(p, x => x.el ? Math.round(x.el) : '—')).join('')}</tr>
        <tr>${rowLbl('LI °C')}${parcels.map(p => cell(p, x => x.li != null ? x.li.toFixed(1) : '—', p && p.li < 0 ? '#ff6a6a' : '#cdd6df')).join('')}</tr>
    </table>`;
    const effTxt = D.eff ? `${Math.round(D.eff.botZ)}–${Math.round(D.eff.topZ)} m` : 'none';
    const bunkTxt = D.bunkers
        ? `${Math.round((270 - Math.atan2(D.bunkers.rm[1], D.bunkers.rm[0]) * 180 / Math.PI + 360) % 360)}° / ${Math.round(Math.hypot(D.bunkers.rm[0], D.bunkers.rm[1]) / _KT2MS)} kt`
        : '—';
    const sect = t => `<div style="color:#8b97a3;text-transform:uppercase;letter-spacing:.5px;font-size:9px;margin:7px 0 2px;border-top:1px solid #23303c;padding-top:5px;">${t}</div>`;
    const idxHTML = `<div style="font-size:10px;color:#cdd6df;font-family:Inter,sans-serif;line-height:1.8;width:100%;">
        <div style="color:#8b97a3;text-transform:uppercase;letter-spacing:.5px;font-size:9px;margin-bottom:2px;">Parcels — surface / mixed-layer / most-unstable</div>
        ${parcelTable}
        ${sect('Kinematics')}
        ${_ir('0–1 / 0–6 km shear', (D.shear01 != null ? D.shear01 : '—') + ' / ' + (D.shear06 != null ? D.shear06 : '—') + ' kt', '#ffd23c')}
        ${_ir('Effective shear', D.ebwd != null ? Math.round(D.ebwd) + ' kt' : '—', '#ffd23c')}
        ${_ir('0–1 / 0–3 km SRH', fx(D.srh01) + ' / ' + fx(D.srh03) + ' m²/s²', '#ffb0f0')}
        ${_ir('Effective SRH', fx(D.esrh) + ' m²/s²', D.esrh > 150 ? '#ff6a6a' : '#ffb0f0')}
        ${_ir('Eff. inflow layer', effTxt, '#cdd6df')}
        ${_ir('Bunkers right', bunkTxt, '#cdd6df')}
        ${sect('Composites')}
        ${_ir('Sig. tornado (eff)', f1(D.stp), D.stp > 1 ? '#ff6a6a' : '#9fd3ff')}
        ${_ir('Supercell (eff)', f1(D.scp), D.scp > 1 ? '#ff6a6a' : '#9fd3ff')}
        ${sect('Thermo')}
        ${_ir('PWAT', (D.pw / 25.4).toFixed(2) + ' in', '#33c27a')}
        ${_ir('DCAPE', fx(D.dcape) + ' J/kg', '#ffa04d')}
        ${_ir('0–3 km lapse', f1(D.lr03) + ' °C/km', '#cdd6df')}
        ${_ir('700–500 lapse', f1(D.lr75) + ' °C/km', D.lr75 > 7 ? '#ff6a6a' : '#cdd6df')}
        ${_ir('Freezing / −20°', fx(D.fzZ) + ' / ' + fx(D.m20Z) + ' m', '#cdd6df')}
        ${_ir('Wet-bulb zero', fx(D.wbzZ) + ' m AGL', '#cdd6df')}
        <div style="margin-top:6px;border-top:1px solid #23303c;padding-top:5px;color:#8b97a3;font-size:9px;">Surface ${lv[0].tmpc.toFixed(1)}° / ${lv[0].dwpc.toFixed(1)}°C @ ${Math.round(lv[0].pres)} hPa${D.muSrc && D.muSrc.k ? ` · MU parcel ${Math.round(D.muSrc.p)} hPa` : ''}</div>
        <div style="color:#5c6b78;font-size:8px;margin-top:3px;">Virtual-temperature CAPE/CIN · effective inflow layer per Thompson et al. 2007 · Bunkers right-mover storm motion. Chart shows the surface parcel.</div>
    </div>`;
    // min-height:0 + overflow-y:auto — in a flex ROW the column stretches to the body
    // height and its own content spills without the body ever registering overflow,
    // so the parameter block silently loses its last rows on a short panel.
    return `${skewSVG}<div style="display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-width:270px;min-height:0;overflow-y:auto;">${_skewtHodo(wl)}${idxHTML}</div>`;
}

// ── Data + panel plumbing ──
function _synopticTimes(n) {
    const out = []; const now = new Date();
    let d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours() >= 12 ? 12 : 0, 0, 0));
    for (let i = 0; i < n; i++) { out.push(d.toISOString().replace(/\.\d+Z$/, 'Z')); d = new Date(d.getTime() - 12 * 3600 * 1000); }
    return out;
}
async function _fetchRaob(station, ts) {
    // /api/raob pulls Wyoming high-res BUFR (by WMO) with an IEM fallback (by ICAO).
    const wmo = (RAOB_SITES[station] && RAOB_SITES[station][2]) || '';
    const url = `/api/raob?station=${encodeURIComponent(station)}&wmo=${encodeURIComponent(wmo)}&ts=${encodeURIComponent(ts)}`;
    const r = await fetch(url);
    if (!r.ok && r.status !== 404) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    return (j && j.success && j.profile && j.profile.length) ? { valid: j.valid, profile: j.profile, source: j.source } : null;
}
function nearestRaob() {
    let c = { lng: -97, lat: 38 };
    try { const m = maps[activePaneId]; if (m) { const cc = m.getCenter(); c = { lng: cc.lng, lat: cc.lat }; } } catch (_) {}
    let best = 'KOUN', bd = 1e18;
    for (const id in RAOB_SITES) { const s = RAOB_SITES[id]; const dx = (s[1] - c.lng) * Math.cos(c.lat * Math.PI / 180), dy = s[0] - c.lat; const d = dx * dx + dy * dy; if (d < bd) { bd = d; best = id; } }
    return best;
}
// Controls inside a panel header must not start a drag: the handler calls
// preventDefault(), and a prevented mousedown means the browser never focuses
// the element — a text box in a header silently refuses to accept typing.
const DRAG_IGNORE = 'button, select, input, textarea, [contenteditable="true"]';

let _skewtSeq = 0;   // drop stale responses when the user switches station/time quickly
async function loadSkewt(station) {
    const seq = ++_skewtSeq;
    const meta = document.getElementById('skewt-meta'), body = document.getElementById('skewt-body');
    const timeSel = document.getElementById('skewt-time');
    if (meta) meta.textContent = `Fetching sounding for ${station}…`;
    const wanted = (timeSel && timeSel.value) ? [timeSel.value] : _synopticTimes(4);
    try {
        let pr = null, used = null;
        for (const ts of wanted) { const p = await _fetchRaob(station, ts); if (p && p.profile && p.profile.filter(l => l.tmpc != null).length > 5) { pr = p; used = ts; break; } }
        if (seq !== _skewtSeq) return;   // a newer request superseded this one
        if (!pr) throw new Error('no data for recent cycles');
        const lv = pr.profile.filter(l => l.pres && l.tmpc != null && l.dwpc != null && l.hght != null).sort((a, b) => b.pres - a.pres);
        if (lv.length < 3) throw new Error('sounding too sparse');
        const D = _skewtCompute(lv);
        const srcLabel = pr.source === 'wyoming' ? 'BUFR hi-res' : 'std raob';
        if (meta) meta.innerHTML = `${station} · ${(pr.valid || used).replace('T', ' ')} · ${lv.length} lvl (${srcLabel}) · ${_skewtSummary(D)}`;
        if (body) body.innerHTML = renderSkewT(lv, D);
    } catch (e) {
        if (seq !== _skewtSeq) return;
        if (meta) meta.textContent = `Skew-T: ${e.message}`;
        if (body) body.innerHTML = `<div style="color:#ff6666;font-size:11px;padding:16px;">Could not load a sounding for ${esc(station)} (${esc(e.message)}). Launches are 00Z & 12Z — try another site or an earlier time.</div>`;
    }
}
// ─── Model forecast soundings ───────────────────────────────────────────────
// The observed-RAOB path and this one converge on the SAME level array
// ({pres,tmpc,dwpc,hght,drct,sknt}), so _skewtCompute and renderSkewT — CAPE,
// CIN, LI, PWAT, the wind barbs, the hodograph — are reused untouched. That is
// the whole reason a forecast sounding is cheap here: only the fetch is new.
// HRRR is the point of the exercise (3 km, hourly runs, convection-allowing);
// GFS is offered alongside it so you can see the mesoscale solution diverge from
// the global one at the same spot.
const SOUNDING_LEVELS = [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100];
const SOUNDING_MODELS = {
    raob:         { label: 'RAOB — observed' },
    gfs_hrrr:     { label: 'HRRR — 3 km forecast', hours: 48 },
    gfs_seamless: { label: 'GFS — global forecast', hours: 120 }
};

// Open-Meteo publishes RH per level, not dewpoint. Alduchov-Eskridge Magnus.
function _dewpointFromRh(tC, rh) {
    if (tC == null || rh == null) return null;
    const a = 17.625, b = 243.04;
    const r = Math.min(100, Math.max(1, rh));
    const al = Math.log(r / 100) + (a * tC) / (b + tC);
    return (b * al) / (a - al);
}

let _modelSndCache = {};   // `${model}|${lat}|${lon}` -> cached run

async function _fetchModelSounding(model, lat, lon) {
    const key = `${model}|${lat.toFixed(2)}|${lon.toFixed(2)}`;
    const hit = _modelSndCache[key];
    if (hit && Date.now() - hit.fetched < 20 * 60 * 1000) return hit;
    const def = SOUNDING_MODELS[model];
    const vars = [];
    SOUNDING_LEVELS.forEach(L => vars.push(
        `temperature_${L}hPa`, `relative_humidity_${L}hPa`, `geopotential_height_${L}hPa`,
        `wind_speed_${L}hPa`, `wind_direction_${L}hPa`));
    vars.push('temperature_2m', 'dewpoint_2m', 'surface_pressure', 'wind_speed_10m', 'wind_direction_10m');
    // The whole run comes down once and is cached, so stepping forecast hours
    // costs nothing — same trick the Model Comparison panel uses for its fields.
    const url = 'https://api.open-meteo.com/v1/forecast'
        + `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
        + `&hourly=${vars.join(',')}&models=${model}`
        + `&forecast_days=${Math.max(1, Math.ceil((def.hours || 48) / 24))}`
        + '&wind_speed_unit=kn';   // °C and hPa are already the defaults the renderer wants
    const res = await fetch(url);
    if (res.status === 429) throw new Error('Open-Meteo rate limit reached — wait a minute and retry');
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
    const j = await res.json();
    const rec = { times: (j.hourly && j.hourly.time) || [], hourly: j.hourly || {}, elevation: j.elevation, fetched: Date.now() };
    if (!rec.times.length) throw new Error('no forecast returned for this point');
    _modelSndCache[key] = rec;
    return rec;
}

// One timestep of a cached run -> the level array the renderer expects.
function _modelSoundingProfile(rec, i) {
    const h = rec.hourly, lv = [];
    const sfcP = h.surface_pressure ? h.surface_pressure[i] : null;
    const sfcT = h.temperature_2m ? h.temperature_2m[i] : null;
    const sfcTd = h.dewpoint_2m ? h.dewpoint_2m[i] : null;
    // A surface parcel is what makes SBCAPE/CIN mean anything, so seed the
    // profile with the 2 m state rather than starting at 1000 hPa.
    if (sfcP != null && sfcT != null && sfcTd != null) {
        lv.push({ pres: sfcP, tmpc: sfcT, dwpc: sfcTd, hght: rec.elevation != null ? rec.elevation : 0,
            drct: h.wind_direction_10m ? h.wind_direction_10m[i] : null,
            sknt: h.wind_speed_10m ? h.wind_speed_10m[i] : null });
    }
    SOUNDING_LEVELS.forEach(L => {
        const t = h[`temperature_${L}hPa`] ? h[`temperature_${L}hPa`][i] : null;
        const rh = h[`relative_humidity_${L}hPa`] ? h[`relative_humidity_${L}hPa`][i] : null;
        const z = h[`geopotential_height_${L}hPa`] ? h[`geopotential_height_${L}hPa`][i] : null;
        if (t == null || rh == null || z == null) return;
        if (sfcP != null && L > sfcP) return;   // level is underground at this point
        lv.push({ pres: L, tmpc: t, dwpc: _dewpointFromRh(t, rh), hght: z,
            drct: h[`wind_direction_${L}hPa`] ? h[`wind_direction_${L}hPa`][i] : null,
            sknt: h[`wind_speed_${L}hPa`] ? h[`wind_speed_${L}hPa`][i] : null });
    });
    return lv.filter(l => l.dwpc != null && isFinite(l.dwpc)).sort((a, b) => b.pres - a.pres);
}

// ─── Where to build a forecast sounding ─────────────────────────────────────
// A model sounding needs a grid point, not a balloon, so it is NOT limited to
// the ~90 radiosonde sites — Memphis, Gulfport and anywhere else are all fair
// game. Resolve whatever was typed, cheapest source first: the RAOB table, then
// the METAR set already in memory (every state's ASOS network, so no network
// call for the common case), then IEM's station metadata for anything else,
// then ZIP/city geocoding. Empty falls back to the active pane's centre.
async function _iemStationPoint(id) {
    try {
        const r = await fetch(`https://mesonet.agron.iastate.edu/api/1/station/${encodeURIComponent(id)}.json`);
        if (!r.ok) return null;
        const j = await r.json();
        const row = (j.data || [])[0];
        if (!row || row.latitude == null || row.longitude == null) return null;
        return { lat: +row.latitude, lon: +row.longitude, label: row.name ? `${id} — ${row.name}` : id };
    } catch (_) { return null; }
}

async function resolveSoundingPoint(qRaw) {
    const q = (qRaw || '').trim();
    if (!q) {
        let c = null;
        try { const m = maps[activePaneId]; if (m) c = m.getCenter(); } catch (_) {}
        if (!c) throw new Error('type an airport id, ZIP, city or lat,lon');
        return { lat: c.lat, lon: c.lng, label: `pane centre ${c.lat.toFixed(2)}, ${c.lng.toFixed(2)}` };
    }
    const ll = q.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    if (ll) return { lat: +ll[1], lon: +ll[2], label: `${(+ll[1]).toFixed(2)}, ${(+ll[2]).toFixed(2)}` };
    const id = q.toUpperCase();
    if (/^[A-Z0-9]{3,4}$/.test(id)) {
        const site = RAOB_SITES[id];
        if (site) return { lat: site[0], lon: site[1], label: id };
        // IEM's CONUS ASOS ids are 3-char, so KMEM is stored as MEM.
        const bare = (id.length === 4 && id[0] === 'K') ? id.slice(1) : id;
        const f = metarGeoJSON.features.find(x => {
            const s = ((x.properties && x.properties.station) || '').toUpperCase();
            return s === id || s === bare;
        });
        const g = f && f.geometry && f.geometry.coordinates;
        if (g) return { lat: g[1], lon: g[0], label: f.properties.name ? `${id} — ${f.properties.name}` : id };
        // A bare 3-char id means the airport to a US forecaster, so try the ICAO
        // form first — IEM also has non-airport networks that reuse those ids
        // (plain "MEM" resolves ~19 km from Memphis International otherwise).
        for (const cand of (id.length === 3 ? ['K' + id, id] : [id])) {
            const meta = await _iemStationPoint(cand);
            if (meta) return meta;
        }
    }
    const gp = await geocodePlace(q);
    return { lat: gp.lat, lon: gp.lon, label: gp.label };
}

// Nearest ASOS to the pane centre — a better default than the nearest balloon
// site now that the forecast sounding is not tied to one.
function nearestSoundingSite() {
    try {
        const m = maps[activePaneId];
        const c = m && m.getCenter();
        if (c && metarGeoJSON.features.length) {
            let best = null, bd = Infinity;
            metarGeoJSON.features.forEach(f => {
                const g = f.geometry && f.geometry.coordinates;
                const id = f.properties && f.properties.station;
                if (!g || !id) return;
                const dx = (g[0] - c.lng) * Math.cos(c.lat * Math.PI / 180), dy = g[1] - c.lat;
                const d = dx * dx + dy * dy;
                if (d < bd) { bd = d; best = id; }
            });
            if (best) return best.length === 3 ? 'K' + best : best;
        }
    } catch (_) {}
    return nearestRaob();
}

async function loadSkewtModel(model, where) {
    const seq = ++_skewtSeq;
    const meta = document.getElementById('skewt-meta'), body = document.getElementById('skewt-body');
    const def = SOUNDING_MODELS[model];
    if (meta) meta.textContent = `Locating ${where || 'pane centre'}…`;
    try {
        const pt = await resolveSoundingPoint(where);
        if (seq !== _skewtSeq) return;
        if (meta) meta.textContent = `Fetching ${def.label} for ${pt.label}…`;
        const rec = await _fetchModelSounding(model, pt.lat, pt.lon);
        if (seq !== _skewtSeq) return;
        // _fillSkewtForecastHours parks the selection on the hour nearest NOW when
        // the list is (re)built; only an explicit user pick survives.
        _fillSkewtForecastHours(rec, def);
        const sel = document.getElementById('skewt-time');
        let i = parseInt(sel && sel.value, 10);
        if (!isFinite(i) || i < 0 || i >= rec.times.length) i = _nearestForecastIndex(rec);
        const lv = _modelSoundingProfile(rec, i);
        if (lv.length < 4) throw new Error('profile too sparse at this hour');
        const D = _skewtCompute(lv);
        const validZ = rec.times[i].replace('T', ' ') + 'Z';
        if (meta) meta.innerHTML = `${esc(pt.label)} · <b style="color:#ffb300;">${esc(def.label)}</b> · valid ${esc(validZ)} · ${lv.length} lvl · ${_skewtSummary(D)}`;
        if (body) body.innerHTML = renderSkewT(lv, D);
    } catch (e) {
        if (seq !== _skewtSeq) return;
        if (meta) meta.textContent = `Skew-T: ${e.message}`;
        if (body) body.innerHTML = `<div style="color:#ff6666;font-size:11px;padding:16px;">Could not build a ${esc(def.label)} sounding for ${esc(where || 'pane centre')} (${esc(e.message)}).</div>`;
    }
}

function _nearestForecastIndex(rec) {
    const now = Date.now();
    let best = 0, bd = Infinity;
    rec.times.forEach((t, i) => {
        const d = Math.abs(Date.parse(t + 'Z') - now);
        if (d < bd) { bd = d; best = i; }
    });
    return best;
}

function _fillSkewtForecastHours(rec, def) {
    const sel = document.getElementById('skewt-time');
    if (!sel) return;
    const keep = sel.dataset.mode === def.label ? sel.value : '';
    sel.innerHTML = '';
    sel.dataset.mode = def.label;
    const now = Date.now();
    rec.times.forEach((t, i) => {
        const ms = Date.parse(t + 'Z');
        const fh = Math.round((ms - now) / 3600000);
        const o = document.createElement('option');
        o.value = String(i);
        o.textContent = `${t.slice(8, 10)}/${t.slice(11, 13)}Z  ${fh >= 0 ? 'F+' + fh : fh + 'h'}`;
        sel.appendChild(o);
    });
    // Open-Meteo returns the whole day including hours already past, which are
    // worth keeping (the model's recent state) but are a poor default.
    if (keep && sel.querySelector(`option[value="${keep}"]`)) sel.value = keep;
    else sel.value = String(_nearestForecastIndex(rec));
}

// RAOB is limited to sites that actually launch balloons, so it keeps the fixed
// dropdown. A model sounding is not, so it gets a free-text location box — swap
// whichever control applies to the chosen source.
function _syncSkewtSourceUI() {
    const src = document.getElementById('skewt-source')?.value || 'raob';
    const stSel = document.getElementById('skewt-station');
    const place = document.getElementById('skewt-place');
    const isRaob = src === 'raob';
    if (stSel) stSel.style.display = isRaob ? '' : 'none';
    if (place) {
        place.style.display = isRaob ? 'none' : '';
        if (!isRaob && !place.value.trim()) place.value = nearestSoundingSite();
    }
}

// Dispatcher — both sources share the time selector and the canvas.
function refreshSkewt() {
    const src = document.getElementById('skewt-source')?.value || 'raob';
    if (src === 'raob') {
        const station = document.getElementById('skewt-station')?.value || nearestRaob();
        _fillSkewtTimes(document.getElementById('skewt-time'), true);
        return loadSkewt(station);
    }
    return loadSkewtModel(src, document.getElementById('skewt-place')?.value || '');
}

let skewtStation = null;
function _fillSkewtStations(sel) {
    if (!sel || sel.options.length) return;
    Object.keys(RAOB_SITES).sort().forEach(id => { const o = document.createElement('option'); o.value = id; o.textContent = id; sel.appendChild(o); });
}
// `force` rebuilds the list — needed when switching back from a model source,
// whose options are forecast-hour indices rather than synoptic timestamps.
function _fillSkewtTimes(sel, force) {
    if (!sel) return;
    if (sel.options.length && !force) return;
    if (force && sel.dataset.mode === 'raob') return;
    sel.innerHTML = '';
    sel.dataset.mode = 'raob';
    const auto = document.createElement('option'); auto.value = ''; auto.textContent = 'Auto (latest)'; sel.appendChild(auto);
    _synopticTimes(6).forEach(ts => { const o = document.createElement('option'); o.value = ts; o.textContent = ts.slice(5, 16).replace('T', ' ') + 'Z'; sel.appendChild(o); });
}
async function openSkewtPanel() {
    const panel = document.getElementById('skewt-panel'); if (!panel) return;
    panel.style.display = 'block';
    const stSel = document.getElementById('skewt-station'), tSel = document.getElementById('skewt-time');
    _fillSkewtStations(stSel); _fillSkewtTimes(tSel);
    skewtStation = nearestRaob();
    if (stSel) stSel.value = skewtStation;
    _syncSkewtSourceUI();
    await refreshSkewt();
}
function initSkewtPanel() {
    document.getElementById('btn-skewt')?.addEventListener('click', openSkewtPanel);
    document.getElementById('close-skewt-panel')?.addEventListener('click', () => { const p = document.getElementById('skewt-panel'); if (p) p.style.display = 'none'; });
    document.getElementById('skewt-refresh')?.addEventListener('click', () => refreshSkewt());
    document.getElementById('skewt-station')?.addEventListener('change', () => refreshSkewt());
    document.getElementById('skewt-time')?.addEventListener('change', () => refreshSkewt());
    // Switching source resets the time list, since synoptic timestamps and
    // forecast-hour indices are not interchangeable.
    document.getElementById('skewt-source')?.addEventListener('change', () => {
        const t = document.getElementById('skewt-time');
        if (t) { t.innerHTML = ''; delete t.dataset.mode; }
        _syncSkewtSourceUI();
        refreshSkewt();
    });
    const placeEl = document.getElementById('skewt-place');
    if (placeEl) {
        placeEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); refreshSkewt(); } });
        placeEl.addEventListener('change', () => refreshSkewt());
    }
    const panel = document.getElementById('skewt-panel'), handle = document.getElementById('skewt-drag');
    if (panel && handle) {
        let dx = 0, dy = 0, drag = false; handle.style.cursor = 'move';
        handle.addEventListener('mousedown', e => { if (e.target.closest(DRAG_IGNORE)) return; drag = true; dx = e.clientX - panel.offsetLeft; dy = e.clientY - panel.offsetTop; e.preventDefault(); });
        window.addEventListener('mousemove', e => { if (!drag) return; panel.style.left = Math.max(0, e.clientX - dx) + 'px'; panel.style.top = Math.max(0, e.clientY - dy) + 'px'; panel.style.right = 'auto'; });
        window.addEventListener('mouseup', () => { drag = false; });
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 31: SPC MESOANALYSIS VIEWER
// ═══════════════════════════════════════════════════════════════════════════════
// SPC's hourly objective mesoscale analysis (RAP-based). The parameter graphics
// are transparent GIFs meant to sit on the sector's county basemap, exactly how
// SPC's own page composites them; both are hot-linked (no proxy needed for <img>).
// Sector regions verified against the actual basemap imagery.

const SPCMESO_SECTORS = [
    ['19', 'National (CONUS)'], ['11', 'Pacific Northwest'], ['12', 'Southwest'],
    ['13', 'N Plains / Upper Midwest'], ['14', 'Central Plains'], ['15', 'Southern Plains'],
    ['20', 'Midwest / MS Valley'], ['21', 'Great Lakes'], ['16', 'Northeast'],
    ['17', 'Mid-Atlantic / TN-OH Valley'], ['18', 'Southeast'],
];
// Complete parameter catalog, mirroring SPC's own menu — every code verified
// live against spc.noaa.gov and labeled with SPC's official display name.
const SPCMESO_PARAMS = [
    ['Surface', [
        ['pmsl', 'MSL Pressure/Wind'], ['ttd', 'Temp/Wind/Dwpt'], ['thet', 'MSL Pressure/Theta-E/Wind'],
        ['mcon', 'Moisture Convergence'], ['thea', 'Theta-E Advection'], ['mxth', 'Mixing Ratio / Theta'],
        ['icon', 'Instantaneous Contraction Rate'], ['trap', 'Fluid Trapping'], ['vtm', 'Velocity Tensor Magnitude'],
        ['dvvr', 'Divergence and Vorticity'], ['def', 'Deformation / Axes of Dilatation'],
        ['pchg', '2-hour Pressure Change'], ['temp_chg', '3-hour Temp Change'], ['dwpt_chg', '3-hour Dwpt Change'],
        ['mixr_chg', '3-hour Mixing Ratio Change'], ['thte_chg', '3-hour Theta-E Change'],
    ]],
    ['Upper Air', [
        ['925mb', '925mb Analysis'], ['850mb', '850mb Analysis'], ['850mb2', '850mb Analysis (v2)'],
        ['700mb', '700mb Analysis'], ['500mb', '500mb Analysis'], ['300mb', '300mb Analysis'],
        ['dlcp', 'Deep Moist Convergence'], ['tadv_925', '925mb Temp Advection'], ['tadv', '850mb Temp Advection'],
        ['7tad', '700mb Temp Advection'], ['sfnt', 'Sfc Frontogenesis'], ['9fnt', '925mb Frontogenesis'],
        ['8fnt', '850mb Frontogenesis'], ['7fnt', '700mb Frontogenesis'], ['925f', '1000-925mb Frontogenesis'],
        ['98ft', '925-850mb Frontogenesis'], ['857f', '850-700mb Frontogenesis'], ['75ft', '700-500mb Frontogenesis'],
        ['vadv', '700-400mb Diff. Vorticity Advection'], ['padv', '400-250mb Pot. Vorticity Advection'],
        ['ddiv', '850-250mb Diff. Divergence'], ['ageo', '300mb Jet Circulation'],
        ['500mb_chg', '12-hour 500mb Height Change'], ['trap_500', 'Fluid Trapping (500mb)'], ['trap_250', 'Fluid Trapping (250mb)'],
    ]],
    ['Thermodynamics', [
        ['sbcp', 'CAPE — Surface-Based'], ['mlcp', 'CAPE — 100mb Mixed-Layer'], ['mucp', 'CAPE — Most-Unstable / LPL Height'],
        ['eltm', 'EL Temp / MUCAPE / MUCIN'], ['ncap', 'CAPE — Normalized'], ['dcape', 'CAPE — Downdraft'],
        ['muli', 'Surface-Based Lifted Index'], ['laps', 'Mid-Level Lapse Rates'], ['lllr', 'Low-Level Lapse Rates'],
        ['maxlr', 'Max 2-6 km AGL Lapse Rate'], ['lclh', 'LCL Height'], ['lfch', 'LFC Height'], ['lfrh', 'LCL-LFC Mean RH'],
        ['sbcp_chg', '3-hr SBCAPE Change'], ['sbcn_chg', '3-hr SBCIN Change'], ['mlcp_chg', '3-hr MLCAPE Change'],
        ['mucp_chg', '3-hr MUCAPE Change'], ['lllr_chg', '3-hr Low-Level LR Change'], ['laps_chg', '6-hr Mid-Level LR Change'],
    ]],
    ['Wind Shear', [
        ['eshr', 'Bulk Shear — Effective'], ['shr1', 'Bulk Shear — Sfc-1km'], ['shr3', 'Bulk Shear — Sfc-3km'],
        ['shr6', 'Bulk Shear — Sfc-6km'], ['shr8', 'Bulk Shear — Sfc-8km'], ['brns', 'BRN Shear'],
        ['effh', 'SR Helicity — Effective'], ['srh5', 'SR Helicity — Sfc-500m'], ['srh1', 'SR Helicity — Sfc-1km'],
        ['srh3', 'SR Helicity — Sfc-3km'], ['llsr', 'SR Wind — Sfc-2km'], ['mlsr', 'SR Wind — 4-6km'],
        ['ulsr', 'SR Wind — 9-11km'], ['alsr', 'SR Wind — Anvil Level'], ['mnwd', '850-300mb Mean Wind'],
        ['xover', '850 and 500mb Winds'], ['shr1_chg', '3-hr Sfc-1km Shear Change'],
        ['srh3_chg', '3-hr Sfc-3km SRH Change'], ['shr6_chg', '3-hr Sfc-6km Shear Change'],
    ]],
    ['Composite Indices', [
        ['scp', 'Supercell Composite'], ['lscp', 'Supercell Composite (left-moving)'],
        ['stpc', 'Sgfnt Tornado (effective layer)'], ['stor', 'Sgfnt Tornado (fixed layer)'],
        ['sigt1', 'Cond. Prob. Sigtor (Eqn 1)'], ['sigt2', 'Cond. Prob. Sigtor (Eqn 2)'],
        ['nstp', 'Non-Supercell Tornado'], ['vtp3', 'Violent Tornado Parameter'],
        ['sigh', 'Sgfnt Hail'], ['sars1', 'SARS Hail Size'], ['sars2', 'SARS Sig. Hail %'],
        ['lghl', 'Large Hail Parameter'], ['dcp', 'Derecho Composite'], ['cbsig', 'Craven/Brooks Sgfnt Severe'],
        ['brn', 'Bulk Richardson Number'], ['mcsm', 'MCS Maintenance'], ['mbcp', 'Microburst Composite'],
        ['desp', 'Enhanced Stretching Potential'], ['ehi1', 'EHI — Sfc-1km'], ['ehi3', 'EHI — Sfc-3km'],
        ['vgp3', 'VGP — Sfc-3km'], ['crit', 'Critical Angle'],
    ]],
    ['Multi-Parameter', [
        ['mlcp_eshr', 'MLCAPE / Effective Shear'], ['cpsh', 'MUCAPE / Effective Shear'],
        ['comp', 'MU LI / 850 & 500mb Winds'], ['lcls', 'LCL Height / Sfc-1km SRH'],
        ['lr3c', 'Sfc-3km Lapse Rate / 3km MLCAPE'], ['3cvr', 'Sfc Vorticity / 3km MLCAPE'],
        ['tdlr', 'Sfc Dwpt / Mid-Level Lapse Rates'], ['hail', 'Hail Parameters'],
        ['qlcs1', 'QLCS 1 (Theta-E diff / MUCAPE / shear)'], ['qlcs2', 'QLCS 2 (Theta-E diff / MLCAPE / shear)'],
    ]],
    ['Heavy Rain', [
        ['pwtr', 'Precipitable Water'], ['pwtr2', 'PW + 850mb Moisture Transport'],
        ['tran', '850mb Moisture Transport'], ['tran_925', '925mb Moisture Transport'],
        ['tran_925-850', '925-850mb Moisture Transport'], ['prop', 'Upwind Propagation Vector'],
        ['peff', 'Precip Potential Placement'], ['mixr', '100mb Mean Mixing Ratio'], ['pw3k', 'PW × 3km RH'],
    ]],
    ['Winter Weather', [
        ['ptyp', 'Precipitation Type'], ['fztp', 'Near-Freezing Sfc Temp'], ['swbt', 'Surface Wet-Bulb Temp'],
        ['mxwb', 'Max Wet-Bulb Temp'], ['fzlv', 'Freezing Level'], ['thck', 'Critical Thicknesses'],
        ['epvl', '800-750mb EPVg'], ['epvm', '650-500mb EPVg'], ['les1', 'Lake Effect Snow 1'],
        ['les2', 'Lake Effect Snow 2'], ['snsq', 'Snow Squall Parameter'], ['dend', 'Dendritic Growth Depth'],
        ['dendrh', 'Dendritic Growth RH'], ['ddrh', 'Dendritic Growth Depth & RH'],
    ]],
    ['Fire Weather', [
        ['sfir', 'Sfc RH / Temp / Wind'], ['fosb', 'Fosberg Index'], ['lhan', 'Low Altitude Haines'],
        ['mhan', 'Mid Altitude Haines'], ['hhan', 'High Altitude Haines'],
        ['lasi', 'Lower Atmos. Severity Index'], ['lfrh2', 'LCL-LFC Mean RH (fire wx)'],
    ]],
    ['Classic / Beta', [
        ['ttot', 'Total Totals'], ['kidx', 'K-Index'], ['show', 'Showalter Index'],
        ['sherbe', 'SHERBE'], ['moshe', 'Modified SHERBE'], ['cwasp', 'CWASP'], ['oprh', 'OPRH'],
        ['ptstpe', 'Prob EF0+ (cond. on RM supercell)'], ['pstpe', 'Prob EF2+ (cond. on RM supercell)'],
        ['pvstpe', 'Prob EF4+ (cond. on RM supercell)'],
    ]],
];

// ── Multi-pane state ───────────────────────────────────────────────────────
// Sector is shared across panes and the parameter is per-pane: the point of
// splitting the window is to read several fields over the SAME ground at the
// same valid time. Four defaults chosen so a fresh 4-pane opens on something
// useful rather than four copies of the same chart.
const SPCMESO_DEFAULT_PANES = ['pmsl', 'ttd', 'laps', 'effh'];
let _spcMesoLayout = 1;
let _spcMesoPanes = SPCMESO_DEFAULT_PANES.slice();

function _spcMesoParamLabel(param) {
    for (const [, params] of SPCMESO_PARAMS) {
        const hit = params.find(p => p[0] === param);
        if (hit) return hit[1];
    }
    return param;
}
function _spcMesoFillParamSelect(sel, value) {
    SPCMESO_PARAMS.forEach(([group, params]) => {
        const og = document.createElement('optgroup'); og.label = group;
        params.forEach(([v, label]) => {
            const o = document.createElement('option'); o.value = v; o.textContent = label; og.appendChild(o);
        });
        sel.appendChild(og);
    });
    if (value) sel.value = value;
}
// Sector rides along with layout/params: restoring four chosen parameters over the
// DEFAULT sector would be a half-restore, and the sector is the one thing every
// pane shares.
function _spcMesoSaveState() {
    try {
        localStorage.setItem('fxnet_spcmeso', JSON.stringify({
            layout: _spcMesoLayout, panes: _spcMesoPanes,
            sector: document.getElementById('spcmeso-sector')?.value || ''
        }));
    } catch (_) {}
}
function _spcMesoRestoreState() {
    try {
        const s = JSON.parse(localStorage.getItem('fxnet_spcmeso') || 'null');
        if (!s) return;
        if ([1, 2, 4].includes(+s.layout)) _spcMesoLayout = +s.layout;
        if (Array.isArray(s.panes)) for (let i = 0; i < 4; i++) if (typeof s.panes[i] === 'string') _spcMesoPanes[i] = s.panes[i];
        const sSel = document.getElementById('spcmeso-sector');
        if (sSel && s.sector && Array.from(sSel.options).some(o => o.value === s.sector)) sSel.value = s.sector;
    } catch (_) {}
}
const _SPCMESO_GAP = 6, _SPCMESO_PAD = 12, _SPCMESO_BAR = 24, _SPCMESO_AR = 1000 / 750;
// Click-to-focus. On a laptop, four 4:3 charts share one screen no matter where
// they live, so each is ~400 px wide however the window is arranged. Focus keeps
// the 4-pane overview for spotting the signal and blows one pane up to read it.
let _spcMesoFocus = null;
function _spcMesoVisibleIdx() {
    return _spcMesoFocus != null ? [_spcMesoFocus] : Array.from({ length: _spcMesoLayout }, (_, i) => i);
}
function _spcMesoDims() {
    const n = _spcMesoVisibleIdx().length;
    return { cols: n === 1 ? 1 : 2, rows: n === 4 ? 2 : 1 };
}
// Grow the panel so each pane keeps a legible image, but never past the viewport —
// the mesoanalysis contour labels are small and unreadable much below ~600 px wide.
function _spcMesoSizePanel() {
    const panel = document.getElementById('spcmeso-panel');
    if (!panel) return;
    const { cols, rows } = _spcMesoDims();
    const cellW = _spcMesoLayout === 1 ? 1000 : _spcMesoLayout === 2 ? 700 : 620;
    const cellH = cellW / _SPCMESO_AR + _SPCMESO_BAR;
    const w = Math.min(cols * cellW + (cols - 1) * _SPCMESO_GAP + 26, window.innerWidth - 40);
    const h = Math.min(rows * cellH + (rows - 1) * _SPCMESO_GAP + 92, window.innerHeight - 40);
    panel.style.width = Math.round(w) + 'px';
    panel.style.height = Math.round(h) + 'px';
    if (panel.offsetLeft + w > window.innerWidth) panel.style.left = Math.max(0, window.innerWidth - w - 10) + 'px';
    if (panel.offsetTop + h > window.innerHeight) panel.style.top = Math.max(0, window.innerHeight - h - 10) + 'px';
}
// Size the panes to fit BOTH dimensions of whatever room the panel actually has.
//
// Sizing from width alone is what clipped the bottom row: .floating-panel is
// overflow:hidden and its body is a flex child that reports its CONTENT height, so
// a 2-row grid happily grew past the panel and was cut off with no scrollbar. And
// scrolling would be the wrong repair anyway — a 4-pane comparison you have to
// scroll through only ever shows you two panes. So the cell is driven by whichever
// axis binds first, and every pane is always on screen.
function _spcMesoFit() {
    const panel = document.getElementById('spcmeso-panel');
    const body = document.getElementById('spcmeso-body');
    const grid = document.getElementById('spcmeso-grid');
    if (!panel || !body || !grid || panel.style.display === 'none') return;
    const { cols, rows } = _spcMesoDims();
    const header = panel.querySelector('.floating-panel-header');
    const meta = document.getElementById('spcmeso-meta');
    const chromeH = (header?.offsetHeight || 46) + (meta?.offsetHeight || 28);
    const availW = panel.clientWidth - _SPCMESO_PAD;
    const availH = panel.clientHeight - chromeH - _SPCMESO_PAD;
    const fromW = (availW - (cols - 1) * _SPCMESO_GAP) / cols;
    const fromH = ((availH - (rows - 1) * _SPCMESO_GAP) / rows - _SPCMESO_BAR) * _SPCMESO_AR;
    const cellW = Math.max(180, Math.floor(Math.min(fromW, fromH)));
    grid.style.gridTemplateColumns = `repeat(${cols}, ${cellW}px)`;
    grid.style.justifyContent = 'center';
    grid.style.alignContent = 'start';
    body.style.maxHeight = Math.max(0, availH + _SPCMESO_PAD) + 'px';
}
// Rebuild the grid. Images are width:100% inside an aspect-locked box so they
// reflow when the layout changes or the user resizes the panel.
function _spcMesoBuildPanes() {
    const grid = document.getElementById('spcmeso-grid');
    if (!grid) return;
    grid.innerHTML = '';
    const multi = _spcMesoLayout > 1;
    for (const i of _spcMesoVisibleIdx()) {
        const pane = document.createElement('div');
        pane.dataset.pane = String(i);
        pane.style.cssText = 'display:flex;flex-direction:column;gap:3px;min-width:0;';
        const sel = document.createElement('select');
        sel.className = 'spcmeso-pane-param';
        sel.dataset.pane = String(i);
        sel.title = 'Parameter for this pane';
        sel.style.cssText = 'background:#000;color:var(--accent-cyan);border:1px solid var(--border);font-size:10px;padding:3px;width:100%;';
        _spcMesoFillParamSelect(sel, _spcMesoPanes[i]);
        sel.addEventListener('change', () => {
            _spcMesoPanes[i] = sel.value;
            _spcMesoSaveState();
            _spcMesoLoadPane(i);
        });
        const box = document.createElement('div');
        box.style.cssText = 'position:relative;width:100%;aspect-ratio:1000/750;background:#fff;'
                          + (multi ? 'cursor:zoom-in;' : '');
        box.innerHTML = `<img class="spcmeso-cnty" alt="" style="position:absolute;inset:0;width:100%;">`
                      + `<img class="spcmeso-img" alt="SPC mesoanalysis" style="position:absolute;inset:0;width:100%;">`;
        if (multi) {
            box.style.cursor = _spcMesoFocus != null ? 'zoom-out' : 'zoom-in';
            box.title = _spcMesoFocus != null ? 'Click to return to all panes' : 'Click to enlarge this pane';
            box.addEventListener('click', () => {
                _spcMesoFocus = _spcMesoFocus != null ? null : i;
                _spcMesoBuildPanes();
                _spcMesoLoad();
            });
        }
        pane.appendChild(sel); pane.appendChild(box);
        grid.appendChild(pane);
    }
    _spcMesoFit();
}
function _spcMesoLoadPane(i) {
    const grid = document.getElementById('spcmeso-grid');
    const pane = grid?.querySelector(`[data-pane="${i}"]`);
    if (!pane) return;
    const sector = document.getElementById('spcmeso-sector')?.value || 's19';
    const param = _spcMesoPanes[i] || 'pmsl';
    const bust = Math.floor(Date.now() / 60000);   // per-minute cache-bust
    const cnty = pane.querySelector('.spcmeso-cnty');
    const img = pane.querySelector('.spcmeso-img');
    if (cnty) cnty.src = `https://www.spc.noaa.gov/exper/mesoanalysis/${sector}/cnty/cnty.gif`;
    if (img) {
        img.src = `https://www.spc.noaa.gov/exper/mesoanalysis/${sector}/${param}/${param}.gif?${bust}`;
        img.alt = _spcMesoParamLabel(param);
    }
}
function _spcMesoLoad() {
    for (const i of _spcMesoVisibleIdx()) _spcMesoLoadPane(i);
    const meta = document.getElementById('spcmeso-meta');
    if (meta) {
        const shown = _spcMesoFocus != null
            ? `${_spcMesoParamLabel(_spcMesoPanes[_spcMesoFocus])} (enlarged — click the chart to return to ${_spcMesoLayout} panes)`
            : _spcMesoLayout === 1
                ? _spcMesoParamLabel(_spcMesoPanes[0])
                : `${_spcMesoLayout} panes — ` + _spcMesoPanes.slice(0, _spcMesoLayout).map(_spcMesoParamLabel).join(' · ');
        meta.textContent = `${shown} — hourly SPC objective analysis (RAP-based), updates ~:25 past the hour. Loaded ${new Date().toISOString().substring(11, 16)}Z.`;
    }
}
function _spcMesoSetLayout(n) {
    _spcMesoLayout = n;
    _spcMesoFocus = null;
    _spcMesoSaveState();
    if (!_spcMesoMaximized) _spcMesoSizePanel();
    _spcMesoBuildPanes();
    _spcMesoLoad();
}
// Maximize: the whole point of 4 panes is room, and on a laptop the auto-sized
// panel still leaves each chart small. Fills the window and restores to the
// previous geometry on the second click.
let _spcMesoMaximized = false, _spcMesoPrevGeom = null;
function _spcMesoToggleMax() {
    const panel = document.getElementById('spcmeso-panel');
    const btn = document.getElementById('spcmeso-max');
    if (!panel) return;
    if (!_spcMesoMaximized) {
        _spcMesoPrevGeom = { w: panel.style.width, h: panel.style.height, l: panel.style.left, t: panel.style.top, r: panel.style.right };
        panel.style.left = '8px'; panel.style.top = '8px'; panel.style.right = 'auto';
        panel.style.width = (window.innerWidth - 16) + 'px';
        panel.style.height = (window.innerHeight - 16) + 'px';
        _spcMesoMaximized = true;
        if (btn) btn.title = 'Restore panel size';
    } else {
        const g = _spcMesoPrevGeom || {};
        panel.style.width = g.w || ''; panel.style.height = g.h || '';
        panel.style.left = g.l || ''; panel.style.top = g.t || ''; panel.style.right = g.r || '';
        _spcMesoMaximized = false;
        if (btn) btn.title = 'Maximize to fill the window';
        if (!g.w) _spcMesoSizePanel();
    }
    _spcMesoFit();
}
function initSpcMesoPanel() {
    const openBtn = document.getElementById('btn-spcmeso');
    const panel = document.getElementById('spcmeso-panel');
    if (!openBtn || !panel) return;
    const sSel = document.getElementById('spcmeso-sector');
    const lSel = document.getElementById('spcmeso-layout');
    if (sSel && !sSel.options.length) SPCMESO_SECTORS.forEach(([v, label]) => {
        const o = document.createElement('option'); o.value = `s${v}`; o.textContent = label; sSel.appendChild(o);
    });
    _spcMesoRestoreState();
    if (lSel) lSel.value = String(_spcMesoLayout);
    _spcMesoBuildPanes();
    openBtn.addEventListener('click', () => {
        panel.style.display = 'block';
        if (!_spcMesoMaximized) _spcMesoSizePanel();
        _spcMesoFit();
        _spcMesoLoad();
    });
    document.getElementById('spcmeso-max')?.addEventListener('click', _spcMesoToggleMax);
    // Re-fit on a browser resize and on a manual panel drag-resize (.floating-panel
    // is resize:both), so panes never end up clipped again.
    window.addEventListener('resize', () => {
        if (panel.style.display === 'none') return;
        if (_spcMesoMaximized) { panel.style.width = (window.innerWidth - 16) + 'px'; panel.style.height = (window.innerHeight - 16) + 'px'; }
        _spcMesoFit();
    });
    // ResizeObserver gives live re-fitting mid-drag, but its delivery is tied to the
    // rendering steps and stops in a backgrounded/throttled tab. A mouseup re-fit is
    // the belt to that braces: whatever happened during the drag, the panes are
    // correct once the user lets go.
    if (window.ResizeObserver) new ResizeObserver(() => _spcMesoFit()).observe(panel);
    document.addEventListener('mouseup', () => { if (panel.style.display !== 'none') _spcMesoFit(); });
    document.getElementById('close-spcmeso-panel')?.addEventListener('click', () => { panel.style.display = 'none'; });
    document.getElementById('spcmeso-refresh')?.addEventListener('click', _spcMesoLoad);
    sSel?.addEventListener('change', () => { _spcMesoSaveState(); _spcMesoLoad(); });
    lSel?.addEventListener('change', () => _spcMesoSetLayout(+lSel.value || 1));
    const handle = document.getElementById('spcmeso-drag');
    if (handle) {
        let dx = 0, dy = 0, drag = false; handle.style.cursor = 'move';
        handle.addEventListener('mousedown', e => { if (e.target.closest(DRAG_IGNORE)) return; drag = true; dx = e.clientX - panel.offsetLeft; dy = e.clientY - panel.offsetTop; e.preventDefault(); });
        window.addEventListener('mousemove', e => { if (!drag) return; panel.style.left = Math.max(0, e.clientX - dx) + 'px'; panel.style.top = Math.max(0, e.clientY - dy) + 'px'; panel.style.right = 'auto'; });
        window.addEventListener('mouseup', () => { drag = false; });
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 25: INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

function init() {
    addLiveLog('FX-Net NextGen initializing...', '#00e5ff');

    // Initialize all health trackers
    for (const [id, config] of Object.entries(HEALTH_THRESHOLDS)) {
        initHealthTracker(id, config.label, config.thresholdMs);
    }

    // Health status check every 10 seconds
    setInterval(checkHealthStatus, 10000);

    // Initialize workspace tabs (restores saved tabs or seeds the first one,
    // and creates the active tab's primary map). Replaces the old initMap('1').
    initLayoutControls();
    initTabs();
    // Persist tab + product setup periodically and on unload
    setInterval(saveTabs, 15000);
    window.addEventListener('beforeunload', saveTabs);

    // Start UTC clock
    startUTCClock();

    // Initialize UI controls
    initProductSidebar();
    initRadarSiteSelector();
    initGoesSectorSelector();
    initPlayButton();
    initContextMenu();
    initWhatsNew();
    initUserGuide();
    initRecon();
    initAdeck();
    initNhcAdv();
    initPanelToggles();
    updateWarnModeLabel();
    initHealthToggle();
    initDebugToggle();
    initSyncButton();
    initSoundingModal();
    initTextModal();
    initMeteogram();
    initModelCompare();
    initMosPanel();
    initCollapsibleGroups();
    initSidebarCollapse();
    initSolarClickHandler();
    initRiverGaugePanel();
    initInterrogationTools();
    initAlertViz();
    initProcedures();
    initL3Tilt();
    initVadPanel();
    initSkewtPanel();
    initSpcMesoPanel();

    // Start warning watchdog (check every 15 seconds for rapid convective updates)
    addLiveLog('WATCHDOG: National feed monitoring active (15s polling)', '#00ff88');
    checkNewWarnings();
    setInterval(() => guardedRefresh('warnings', checkNewWarnings), 15 * 1000);

    // NEXRAD Level III (NODD) — poll for new scans on any pane showing an L3 overlay
    setInterval(() => {
        Object.keys(paneL3).forEach(pid => {
            const st = paneL3[pid];
            if (st && maps[pid] && isLayerVisible(maps[pid], 'radar-l3-layer')) {
                loadL3Radar(pid, st.station, st.product);
            }
        });
        // Storm tracks (STI) and meso/TVS markers follow the volume-scan cadence.
        Object.keys(paneStormAttr).forEach(pid => {
            if (maps[pid] && isLayerVisible(maps[pid], 'storm-attr-cell')) {
                fetchStormAttr(pid, paneStormAttr[pid].station);
            }
        });
        Object.keys(paneMeso).forEach(pid => {
            if (maps[pid] && isLayerVisible(maps[pid], 'meso-circ')) {
                fetchMesoMarkers(pid, paneMeso[pid].station);
            }
        });
        if (!isPlaying) refreshTimestampLabel();   // update L3 time on all panes
    }, 120 * 1000);

    // GIBS satellite — refresh latest frame + warm loop time-list (skip while looping)
    setInterval(() => {
        if (isPlaying) return;
        Object.keys(paneGibs).forEach(pid => {
            const prod = paneGibs[pid];
            if (prod && maps[pid] && isLayerVisible(maps[pid], 'gibs-sat-layer')) {
                loadGibsLive(pid, prod);
            }
        });
    }, 150 * 1000);

    // ─── Enhanced Warning Pulse Animation ───
    // Smoothly oscillates opacity of IBW (Impact-Based Warning) overlay layers
    // to create a pulsing "danger" effect for Considerable/Catastrophic/Emergency polygons
    let enhancedPulsePhase = 0;
    setInterval(() => {
        enhancedPulsePhase = (enhancedPulsePhase + 1) % 60;
        const t = Math.abs(Math.sin(enhancedPulsePhase * Math.PI / 30));
        const fillOp = 0.10 + 0.40 * t;
        const glowOp = 0.15 + 0.50 * t;
        const outlineOp = 0.50 + 0.50 * t;
        Object.values(maps).forEach(m => {
            try {
                if (m.getLayer('nws-enhanced-fill') && m.getLayoutProperty('nws-enhanced-fill', 'visibility') === 'visible')
                    m.setPaintProperty('nws-enhanced-fill', 'fill-opacity', fillOp);
                if (m.getLayer('nws-enhanced-glow') && m.getLayoutProperty('nws-enhanced-glow', 'visibility') === 'visible')
                    m.setPaintProperty('nws-enhanced-glow', 'line-opacity', glowOp);
                if (m.getLayer('nws-enhanced-outline') && m.getLayoutProperty('nws-enhanced-outline', 'visibility') === 'visible')
                    m.setPaintProperty('nws-enhanced-outline', 'line-opacity', outlineOp);
            } catch (_) {}
        });
    }, 50); // ~20fps smooth pulse

    // Start watch vector monitoring simultaneously with warnings (15s polling for zero lag)
    checkNewWatches();
    setInterval(() => guardedRefresh('watches', checkNewWatches), 15 * 1000);

    // Load Great Lakes vector boundaries
    fetchGreatLakes();

    // Start auto-refresh system
    startAutoRefresh();

    // Initial health UI render
    renderHealthUI();

    // Auto-load default products once pane 1 map is ready
    const waitForMap = setInterval(() => {
        if (maps['1']) {
            clearInterval(waitForMap);
            const map = maps['1'];

            // Auto-activate base map (Cities & Boundaries)
            if (map.getLayer('esri-labels-layer')) map.setLayoutProperty('esri-labels-layer', 'visibility', 'visible');
            const cityBtn = document.querySelector('[data-layer="overlay-cities"]');
            if (cityBtn) cityBtn.classList.add('active');

            addLiveLog('MAP: Clean base map loaded by default', '#888');
            refreshTimestampLabel();

            // ─── Pre-fetch commonly used data in background ───
            // Fetches data and pushes to map sources without toggling visibility.
            // Products load instantly when user clicks them in the sidebar.
            addLiveLog('PREFETCH: Loading commonly used datasets in background...', '#888');
            Promise.allSettled([
                fetchRiverGauges(false, true),     // ~200KB via Vercel proxy (CDN cached 15 min)
                fetchMETARs(),                      // ~1-2MB direct from IEM (no Vercel cost)
                fetchSPCOutlook(1, false, true),    // ~50KB direct from SPC (Day 1 — most viewed)
                fetchMesoscaleDiscussions(false, true) // ~20KB direct from NOAA
            ]).then(results => {
                const ok = results.filter(r => r.status === 'fulfilled').length;
                addLiveLog(`PREFETCH: ${ok}/4 datasets cached and ready`, '#00ff88');
            });
        }
    }, 200);

    updateSidebarToActivePane();
    addLiveLog('FX-Net NextGen READY', '#00ff88');
}

// Page-level wiring that used to live in index.html's trailing inline <script>.
// Moved here so script-src can drop 'unsafe-inline' — see boot.js.
function initPageChrome() {
    try { lucide.createIcons(); } catch (_) {}
    if (window.location.protocol === 'file:') {
        const warn = document.getElementById('cors-warning');
        if (warn) warn.style.display = 'block';
    }
    initProductFilter();
    restoreLogPanelState();
    const logHeader = document.getElementById('log-header');
    if (logHeader) {
        logHeader.addEventListener('click', () => {
            logHeader.parentElement.classList.toggle('collapsed');
        });
    }
}

// Boot on DOM ready
document.addEventListener('DOMContentLoaded', () => { init(); initPageChrome(); });
