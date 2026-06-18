// ═══════════════════════════════════════════════════════════════════════════════
// FX-Net NextGen | Tactical Meteorological Workstation
// (c) 2026 Rodney Cuevas, Meteorologist
// MapLibre GL JS v3.6.2 — Dark AWIPS-like UI
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

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
let preAnimVisibility = {}; // Stores layer visibility before loop starts
// Default radar mode = National Mosaic so "Reflectivity" shows CONUS, not a distant single site.
// (A real site code here switches that pane to single-site products via the SITE selector.)
let paneRadarSites = { '1': 'nexrad-n0q-900913', '2': 'nexrad-n0q-900913', '3': 'nexrad-n0q-900913', '4': 'nexrad-n0q-900913', '5': 'nexrad-n0q-900913', '6': 'nexrad-n0q-900913', '7': 'nexrad-n0q-900913', '8': 'nexrad-n0q-900913' };
let paneRadarProducts = { '1': 'sr_bref', '2': 'sr_bref', '3': 'sr_bref', '4': 'sr_bref', '5': 'sr_bref', '6': 'sr_bref', '7': 'sr_bref', '8': 'sr_bref' };
// NEXRAD Level III (NODD) overlay state, per pane: { station, product, meta }
let paneL3 = {};
// NASA GIBS satellite product active per pane (product key) or undefined
let paneGibs = {};
let activeGoesChannel = null; // Convenience: always mirrors paneGoesChannels[activePaneId]
let paneGoesChannels = { '1': null, '2': null, '3': null, '4': null, '5': null, '6': null, '7': null, '8': null };
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
const zoneGeometryCache = {};  // Global cache for NWS zone polygons (persists across polling cycles)
let watchesLoaded = false;
let watchesGeoJSON = { type: 'FeatureCollection', features: [] };
let greatLakesLoaded = false;
let greatLakesGeoJSON = { type: 'FeatureCollection', features: [] };
let activeSpcDay = null;
let activeQpfLayer = null;
let activeMrmsQpe = null;
let activeCpcTempLayer = null;
let activeCpcPrecipLayer = null;
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
    wpcIsobars: { label: 'WPC Isobars',   thresholdMs: 4 * 60 * 60 * 1000 },
    wpcFronts:  { label: 'WPC Fronts/HL', thresholdMs: 4 * 60 * 60 * 1000 },
    wpcQpf:     { label: 'WPC QPF',       thresholdMs: 8 * 60 * 60 * 1000 },
    radarL3:    { label: 'NODD Dual-Pol', thresholdMs: 15 * 60 * 1000 },
    gibsSat:    { label: 'GIBS Satellite', thresholdMs: 60 * 60 * 1000 },
    wpcEro:     { label: 'WPC ERO',       thresholdMs: 12 * 60 * 60 * 1000 },
    nhcStorms:  { label: 'NHC Storms',    thresholdMs: 60 * 60 * 1000 },
    nhcOutlook: { label: 'NHC Outlook',   thresholdMs: 6 * 60 * 60 * 1000 },
    spcOutlook: { label: 'SPC Outlooks',   thresholdMs: 60 * 60 * 1000 },
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
    sfcIsodrosotherms:{ label: 'Isodrosotherms',     thresholdMs: 15 * 60 * 1000 }
};

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

// ═══ IEM GOES SATELLITE ANIMATION OFFSETS ═══
// IEM pre-renders GOES-East tiles at fixed time offsets (5-min cadence up to 1hr, then 30/60min)
// Pattern: goes_east_ch{NN}-900913-m{MM}m  (current = live tile, no offset suffix)
const SAT_ANIM_OFFSETS = [
    { offset: 'current', offsetMin: 0 },
    { offset: 'm05m',    offsetMin: 5 },
    { offset: 'm10m',    offsetMin: 10 },
    { offset: 'm15m',    offsetMin: 15 },
    { offset: 'm20m',    offsetMin: 20 },
    { offset: 'm25m',    offsetMin: 25 },
    { offset: 'm30m',    offsetMin: 30 },
    { offset: 'm35m',    offsetMin: 35 },
    { offset: 'm40m',    offsetMin: 40 },
    { offset: 'm45m',    offsetMin: 45 },
    { offset: 'm50m',    offsetMin: 50 },
    { offset: 'm55m',    offsetMin: 55 },
    { offset: 'm60m',    offsetMin: 60 },
    { offset: 'm90m',    offsetMin: 90 },
    { offset: 'm120m',   offsetMin: 120 }
];

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

function goesChannelUrl(ch) {
    // IEM tile cache — individual per-channel GOES-East imagery
    // (nowCOAST only has category-based layers so all visible channels look identical there)
    const pad = String(ch).padStart(2, '0');
    return `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/goes_east_conus_ch${pad}/{z}/{x}/{y}.png`;
}

function iemSatAnimUrl(channel, offsetEntry) {
    const pad = String(channel).padStart(2, '0');
    if (offsetEntry.offset === 'current') {
        return goesChannelUrl(channel); // current frame = live tile
    }
    return `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/goes_east_ch${pad}-900913-${offsetEntry.offset}/{z}/{x}/{y}.png`;
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

// ─── NASA GIBS GOES-East (web-mercator WMTS tiles, real time-stamped frames) ───
// Browser-direct (CORS *), no proxy/render. Gives clean looping (real 10-min
// frames) AND smooth panning (tiles), incl. the GeoColor/composite products that
// the per-channel IEM tiles + category-based nowCOAST loop never animated cleanly.
const GIBS_PRODUCTS = {
    GeoColor: { layer: 'GOES-East_ABI_GeoColor',            tms: 'GoogleMapsCompatible_Level7', max: 7, label: 'GeoColor' },
    CleanIR:  { layer: 'GOES-East_ABI_Band13_Clean_Infrared', tms: 'GoogleMapsCompatible_Level6', max: 6, label: 'Clean IR (Band 13)' },
    RedVis:   { layer: 'GOES-East_ABI_Band2_Red_Visible_1km', tms: 'GoogleMapsCompatible_Level7', max: 7, label: 'Red Visible' },
    AirMass:  { layer: 'GOES-East_ABI_Air_Mass',            tms: 'GoogleMapsCompatible_Level6', max: 6, label: 'Air Mass RGB' },
    Dust:     { layer: 'GOES-East_ABI_Dust',                tms: 'GoogleMapsCompatible_Level7', max: 7, label: 'Dust RGB' },
    FireTemp: { layer: 'GOES-East_ABI_FireTemp',            tms: 'GoogleMapsCompatible_Level7', max: 7, label: 'Fire Temp RGB' }
};

function gibsTileUrl(prodKey, isoTime) {
    const p = GIBS_PRODUCTS[prodKey];
    // WMTS REST: .../{layer}/default/{time}/{TileMatrixSet}/{z}/{y}/{x}.png
    return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${p.layer}/default/${isoTime || 'default'}/${p.tms}/{z}/{y}/{x}.png`;
}

// Cache of recent real frame times per product (filled from /api/gibs-times)
const gibsTimesCache = {};
async function fetchGibsTimes(prodKey) {
    const p = GIBS_PRODUCTS[prodKey];
    try {
        const res = await fetch(`/api/gibs-times?layer=${p.layer}&tms=${p.tms}&n=40`);
        const data = await res.json();
        if (data.times && data.times.length) gibsTimesCache[prodKey] = data.times;
        return gibsTimesCache[prodKey] || [];
    } catch (e) {
        return gibsTimesCache[prodKey] || [];
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

function siteRadarUrl(site, product) {
    let s = site.toLowerCase();


    let prefix = 'k';
    if (['abc','acg','aec','ahg','aih','akc','apd','gua','hki','hkm','hmo','hwa'].includes(s)) prefix = 'p';

    let layerProd = product;
    // 5-minute cache stability window (300,000 ms): guarantees all zoom levels requested within a 5-minute block pull from consistent cached scans to prevent GPU texture hiccuping during zoom transitions
    const tsWindow = Math.floor(Date.now() / 300000);
    if (s === 'jua' || s === 'sju') { return `https://opengeo.ncep.noaa.gov/geoserver/tjua/ows?service=wms&version=1.3.0&request=GetMap&layers=tjua_${layerProd}&crs=EPSG:3857&bbox={bbox-epsg-3857}&width=512&height=512&format=image/png&transparent=true&tiled=false&ts=${tsWindow}`; }
    return `https://opengeo.ncep.noaa.gov/geoserver/${prefix}${s}/ows?service=wms&version=1.3.0&request=GetMap&layers=${prefix}${s}_${layerProd}&crs=EPSG:3857&bbox={bbox-epsg-3857}&width=512&height=512&format=image/png&transparent=true&tiled=false&ts=${tsWindow}`;
}

function siteRadarAnimUrl(site, product, isoTimeStr) {
    return siteRadarUrl(site, product) + `&time=${isoTimeStr}`;
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
async function fetchSiteRadarTimes(site) {
    if (!site || site.includes('nexrad')) return;
    const key = site.toUpperCase();
    const cached = siteRadarTimes[key];
    if (cached && Date.now() - cached._ts < SITE_TIME_TTL) return;   // throttle
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
        siteRadarTimes[key] = times;
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
    d.innerHTML = `<span style="color:#444">[${ts}]</span> <span style="color:${color}">${msg}</span>`;
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

function updateHealth(id) {
    if (!healthTrackers[id]) return;
    healthTrackers[id].status = 'LIVE';
    healthTrackers[id].lastUpdate = Date.now();
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

function renderHealthUI() {
    const container = document.getElementById('health-rows-container');
    if (!container) return;
    container.innerHTML = '';
    for (const [id, t] of Object.entries(healthTrackers)) {
        const row = document.createElement('div');
        row.className = 'health-row';
        const statusClass = t.status === 'LIVE' ? 'live' : (t.status === 'STALE' ? 'stale' : '');
        const statusColor = t.status === 'LIVE' ? '#00ff88' : (t.status === 'STALE' ? '#ffb300' : (t.status === 'FAIL' ? '#ff3333' : '#666'));
        const timeStr = t.lastUpdate > 0 ? new Date(t.lastUpdate).toISOString().substring(11, 16) + 'Z' : '--:--';
        row.innerHTML = `<span>${t.label}</span><span class="health-status" style="color:${statusColor};font-weight:bold;">${t.status} ${timeStr}</span>`;
        container.appendChild(row);
    }
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
        center: [-90.18, 32.30],
        zoom: 6,
        preserveDrawingBuffer: true
    });

    // Suppress harmless MapLibre tile errors
    map.on('error', e => {
        const msg = e?.error?.message || '';
        if (msg.includes('image') || msg.includes('usable') || msg.includes('supported')) return;
    });

    maps[paneId] = map;

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
                        } else if (mrmsQpeVis && activeMrmsQpe) {
                            const readout = decodeMrmsPixel(data[0], data[1], data[2], 'qpe');
                            const periodLabels = { '1h': '1-HR', '24h': '24-HR', '48h': '48-HR', '72h': '72-HR' };
                            const pLabel = periodLabels[activeMrmsQpe] || 'QPE';
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

    // ─── Layer 3: Satellite (GOES-East) ───
    map.addSource('satellite', {
        type: 'raster',
        tiles: [goesChannelUrl(13)],
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

    // 6a: Warnings & Advisories Layer (Broadened)
    // ── Official NWS WWA Color Table (https://www.weather.gov/help-map) ──
    const nwsWwaFilter = ['all',
        ['any',
            ['in', 'Warning', ['get', 'event']],
            ['in', 'Emergency', ['get', 'event']],
            ['in', 'Statement', ['get', 'event']],
            ['in', 'Advisory', ['get', 'event']],
            ['in', 'Alert', ['get', 'event']],
            ['in', 'Outlook', ['get', 'event']]
        ],
        ['!', ['in', 'Watch', ['get', 'event']]]  // Watches have their own dedicated layer
    ];
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
    const contourProducts = [
        { id: 'sfc-isobars-2mb',       color: '#d0d0d0', field: 'value' },
        { id: 'sfc-isotherms',         color: '#ff4444', field: 'value' },
        { id: 'sfc-isodrosotherms',    color: '#44cc44', field: 'value' }
    ];
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
        paint: { 'line-color': '#ff0000', 'line-width': 2 }
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
    // Civil twilight band (lighter shading)
    map.addLayer({
        id: 'solar-twilight-fill', type: 'fill', source: 'solar-terminator',
        filter: ['==', ['get', 'zone'], 'civil-twilight'],
        layout: { visibility: 'none' },
        paint: { 'fill-color': '#000022', 'fill-opacity': 0.2 }
    });
    // Night polygon (darker shading)
    map.addLayer({
        id: 'solar-night-fill', type: 'fill', source: 'solar-terminator',
        filter: ['==', ['get', 'zone'], 'night'],
        layout: { visibility: 'none' },
        paint: { 'fill-color': '#000011', 'fill-opacity': 0.45 }
    });
    // Terminator edge line
    map.addLayer({
        id: 'solar-terminator-line', type: 'line', source: 'solar-terminator',
        filter: ['==', ['get', 'zone'], 'night'],
        layout: { visibility: 'none' },
        paint: { 'line-color': '#ffaa00', 'line-width': 1.5, 'line-opacity': 0.7 }
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
            <div style="font-weight:bold;color:#00e5ff;font-size:13px;margin-bottom:2px;">${p.station || ''} — ${p.name || 'Unknown'}${p.state ? ', ' + p.state : ''}</div>
            <div style="color:#666;font-size:10px;margin-bottom:6px;">${validTimeLocal} (${validTimeUTC})</div>
            <div style="display:grid;grid-template-columns:auto 1fr;gap:2px 10px;">
                <span style="color:#888;">Temp:</span><span style="color:#ff4444;">${p.tmpf != null ? Math.round(p.tmpf) + '°F' : 'M'}</span>
                <span style="color:#888;">Dewpoint:</span><span style="color:#00cc88;">${p.dwpf != null ? Math.round(p.dwpf) + '°F' : 'M'}</span>
                <span style="color:#888;">RH:</span><span>${p.relh != null ? Math.round(p.relh) + '%' : 'M'}</span>
                <span style="color:#888;">Wind:</span><span>${windDir} ${windSpd}${gustTxt}</span>
                <span style="color:#888;">Visibility:</span><span>${p.vsby != null ? p.vsby + ' mi' : 'M'}</span>
                <span style="color:#888;">Altimeter:</span><span>${p.alti != null ? p.alti.toFixed(2) + ' inHg (' + Math.round(p.alti * 33.8639) + ' mb)' : 'M'}</span>
                <span style="color:#888;">Sky:</span><span>${sky}</span>
                ${wx ? `<span style="color:#888;">Wx:</span><span style="color:#ffb300;">${wx}</span>` : ''}
                ${p.feel != null ? `<span style="color:#888;">Feels Like:</span><span>${Math.round(p.feel)}°F</span>` : ''}
            </div>
            ${p.raw ? `<div style="border-top:1px solid #333;margin-top:6px;padding-top:4px;color:#888;font-size:10px;word-break:break-all;">${p.raw}</div>` : ''}
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
            <div style="font-weight:bold;color:${aqiColor(overall)};font-size:13px;margin-bottom:4px;">${p.site_name || 'Monitor'}</div>
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
            <div style="font-weight:bold;color:#ff6600;font-size:13px;margin-bottom:4px;">🔥 ${sensor} Fire Detection</div>
            <div style="color:#aaa;margin-bottom:2px;">Satellite: <b>${satellite}</b></div>
            <div style="color:#888;margin-bottom:6px;">${dt ? new Date(dt).toUTCString() : 'Recent'}</div>
            <div><span style="color:#888;">Confidence:</span> ${confLabel} (${conf}%)</div>
            <div><span style="color:#888;">Brightness:</span> ${bright}K</div>
            <div><span style="color:#888;">FRP:</span> ${frp} MW</div>
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
                    const stormId = p.binnumber || p.BINNUMBER || '';
                    const pts = (src._data.features || [])
                        .filter(f => f.properties.layerType === 'point' && (f.properties.binnumber || f.properties.BINNUMBER) === stormId)
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

        const validTime = p.fldatelbl || p.FLDATELBL || p.datelbl || p.DATELBL || '';
        const html = `<div style="font-family:Inter,sans-serif;font-size:11px;color:#e0e0e0;background:#0d1117;padding:8px;border-radius:4px;max-width:300px;">
            <div style="font-weight:bold;color:#ff6600;font-size:14px;margin-bottom:2px;">${name}${ptcTag}</div>
            <div style="color:#888;font-size:10px;margin-bottom:6px;">${tauLabel}${validTime ? ' — ' + validTime : ''}</div>
            <div style="display:grid;grid-template-columns:auto 1fr;gap:2px 10px;">
                <span style="color:#888;">Classification:</span><span style="color:#ffcc00;">${cat}</span>
                <span style="color:#888;">Max Wind:</span><span>${wind} kt${gust > 0 ? ' (gusts ' + Math.round(gust) + ' kt)' : ''}</span>
                ${mslp ? `<span style="color:#888;">Min Pressure:</span><span>${mslp}</span>` : ''}
                ${movement ? `<span style="color:#888;">Movement:</span><span>${movement}</span>` : ''}
                <span style="color:#888;">Advisory:</span><span>#${p.ADVISNUM || p.advisnum || 'N/A'}</span>
            </div>
        </div>`;
        popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
    });
    map.on('mouseenter', 'nhc-track-pts', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'nhc-track-pts', () => { map.getCanvas().style.cursor = ''; });

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
    map.on('click', async e => {
        const warningsActive = isLayerVisible(map, 'nws-warnings-only-fill') || isLayerVisible(map, 'nws-wwa-wms-layer');
        const watchesActive = isLayerVisible(map, 'nws-watches-only-fill') || isLayerVisible(map, 'nws-watches-wms-layer') || isLayerVisible(map, 'nws-wwa-wms-layer');
        if (!warningsActive && !watchesActive) return;

        // Ensure we didn't click on a METAR or FIRMS or MD icon
        const otherFeats = map.queryRenderedFeatures(e.point, { layers: ['metars-temp', 'firms-fires-layer', 'spc-md-fill', 'wpc-mpd-fill', 'spc-lsr-icons', 'airnow-aqi-layer', 'drought-fill', 'nhc-track-pts', 'nhc-outlook-fill', 'nexrad-sites-layer', 'river-gauges-layer'] });
        if (otherFeats.length > 0) return;

        const lat = e.lngLat.lat.toFixed(4);
        const lng = e.lngLat.lng.toFixed(4);
        try {
            addLiveLog(`QUERY: Fetching alert data for [${lat}, ${lng}]...`, '#ffff00');
            const res = await fetch(`https://api.weather.gov/alerts/active?point=${lat},${lng}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const rawFeatures = data.features || [];
            
            // Filter features based on what layers are turned on
            const features = rawFeatures.filter(f => {
                const eventName = f.properties?.event || '';
                const isWatch = eventName.includes('Watch');
                if (isWatch && !watchesActive) return false;
                if (!isWatch && !warningsActive) return false;
                return true;
            });

            if (features.length === 0) {
                addLiveLog(`QUERY: No active alerts for visible layers at this location.`, '#00e5ff');
                return;
            }

            let combinedHtml = `<div style="font-family:Inter,sans-serif;font-size:11px;color:#e0e0e0;background:#0d1117;padding:10px;border-radius:4px;max-width:440px;max-height:450px;overflow-y:auto;">`;
            
            features.forEach((f, idx) => {
                const p = f.properties || {};
                const desc = (p.description || '').replace(/\n/g, '<br>');
                const instr = (p.instruction || '').replace(/\n/g, '<br>');
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
                    <div style="font-weight:bold;color:${evtColor};font-size:14px;margin-bottom:4px;">${p.event || 'Weather Alert'}${threatBadge}</div>
                    <div style="color:#888;margin-bottom:4px;">${p.senderName || ''}</div>
                    <div style="margin-bottom:6px;font-weight:bold;color:#fff;">${p.headline || ''}</div>
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
        const mcdLink = p.popupinfo || '';

        const html = `<div style="font-family:Inter,sans-serif;font-size:11px;color:#e0e0e0;background:#0d1117;padding:8px;border-radius:4px;max-width:300px;">
            <div style="font-weight:bold;color:#ff3333;font-size:13px;margin-bottom:4px;">Mesoscale Discussion ${mcdNum}</div>
            <div style="color:#888;margin-bottom:8px;">${mcdInfo}</div>
            <a href="${mcdLink}" target="_blank" style="display:inline-block;background:#333;color:white;padding:4px 8px;border-radius:2px;text-decoration:none;font-size:10px;">VIEW FULL DISCUSSION →</a>
        </div>`;
        new maplibregl.Popup().setLngLat(e.lngLat).setHTML(html).addTo(map);
    });

    // WPC Mesoscale Precipitation Discussion click → popup w/ details + full discussion link
    map.on('click', 'wpc-mpd-fill', e => {
        if (!e.features || !e.features[0]) return;
        const p = e.features[0].properties;
        const fmtZ = s => (s && s.length >= 12) ? `${s.slice(4,6)}/${s.slice(6,8)} ${s.slice(8,10)}:${s.slice(10,12)}Z` : (s || '');
        const link = p.link || '';
        const html = `<div style="font-family:Inter,sans-serif;font-size:11px;color:#e0e0e0;background:#0d1117;padding:8px;border-radius:4px;max-width:320px;">
            <div style="font-weight:bold;color:#33c27a;font-size:13px;margin-bottom:4px;">WPC Mesoscale Precip Discussion #${p.num || '?'}</div>
            <div style="color:#cfcfcf;margin-bottom:6px;">${p.concern || ''}</div>
            <div style="color:#888;margin-bottom:8px;">Valid ${fmtZ(p.issue)} – ${fmtZ(p.expire)}</div>
            ${link ? `<a href="${link}" target="_blank" style="display:inline-block;background:#333;color:white;padding:4px 8px;border-radius:2px;text-decoration:none;font-size:10px;">VIEW FULL DISCUSSION →</a>` : ''}
        </div>`;
        new maplibregl.Popup().setLngLat(e.lngLat).setHTML(html).addTo(map);
    });
    map.on('mouseenter', 'wpc-mpd-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'wpc-mpd-fill', () => { map.getCanvas().style.cursor = ''; });

    // SPC LSR click
    map.on('click', 'spc-lsr-icons', e => {
        if (!e.features || !e.features[0]) return;
        const p = e.features[0].properties;
        const coord = e.features[0].geometry.coordinates;
        const timeStr = p.valid ? new Date(p.valid).toUTCString() : 'Recent';
        const mag = p.magnitude && p.unit ? `<div><span style="color:#888;">Magnitude:</span> ${p.magnitude} ${p.unit}</div>` : (p.magnitude ? `<div><span style="color:#888;">Magnitude:</span> ${p.magnitude}</div>` : '');
        const typeColors = {
            'TORNADO': '#ff0000', 'HAIL': '#00cc00', 'TSTM WND GST': '#3399ff',
            'TSTM WND DMG': '#3399ff', 'FLASH FLOOD': '#00cccc', 'FLOOD': '#008888',
            'SNOW': '#cc88ff', 'RAIN': '#0088aa', 'MARINE TSTM WIND': '#6666cc'
        };
        const color = typeColors[p.lsrType] || '#ff9900';
        const html = `<div style="font-family:Inter,sans-serif;font-size:11px;color:#e0e0e0;background:#0d1117;padding:8px;border-radius:4px;max-width:320px;">
            <div style="font-weight:bold;color:${color};font-size:13px;margin-bottom:2px;">${p.icon || '⚡'} ${p.lsrType}</div>
            <div style="color:#aaa;margin-bottom:2px;">${p.city}, ${p.county} Co., ${p.state}</div>
            <div style="color:#888;margin-bottom:6px;">${timeStr} — WFO: ${p.wfo}</div>
            ${mag}
            <div style="color:#888;margin-bottom:4px;"><span style="color:#888;">Source:</span> ${p.source}</div>
            ${p.remark ? `<div style="color:#ccc;font-style:italic;margin-top:4px;border-top:1px solid #333;padding-top:4px;">${p.remark}</div>` : ''}
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
 * @returns {Float64Array} grid[row * cols + col]
 */
function idwGrid(pts, bounds, cols, rows, power = 1.5, searchRadius = 8, minNeighbours = 3) {
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
            let wSum = 0, vSum = 0, nCount = 0;

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
            grid[r * cols + c] = (nCount >= minNeighbours && wSum > 0) ? vSum / wSum : NaN;
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

    // Collect valid observations
    const pts = [];
    metarGeoJSON.features.forEach(f => {
        const p = f.properties;
        let val = p?.[field];
        const coords = f.geometry?.coordinates;

        // For pressure: prefer mslp, fall back to alti converted to mb
        if (field === 'mslp') {
            if (val == null || isNaN(val)) {
                // Convert altimeter (inHg) to mb
                if (p?.alti != null && !isNaN(p.alti)) {
                    val = p.alti * 33.8639;
                } else {
                    return;
                }
            }
            if (val < 950 || val > 1070) return;  // Bad pressure values
        }

        // Filter obviously bad temperature/dewpoint values
        if (field === 'tmpf' && (val < -60 || val > 140)) return;
        if (field === 'dwpf' && (val < -60 || val > 100)) return;

        if (val != null && !isNaN(val) && coords) {
            pts.push({ lon: coords[0], lat: coords[1], val });
        }
    });
    if (pts.length < 10) return { type: 'FeatureCollection', features: [] };

    // Remove statistical outliers (> 3 sigma from mean) for all fields
    const mean = pts.reduce((s, p) => s + p.val, 0) / pts.length;
    const std = Math.sqrt(pts.reduce((s, p) => s + (p.val - mean) ** 2, 0) / pts.length);
    if (std > 0) {
        const filtered = pts.filter(p => Math.abs(p.val - mean) <= 3 * std);
        pts.length = 0;
        pts.push(...filtered);
    }

    // Grid bounds: CONUS — higher resolution for smoother contours
    const bounds = { west: -130, east: -60, south: 23, north: 50 };
    const cols = 280;  // ~0.25° resolution
    const rows = 108;

    // Generate IDW grid (power=1.5 for smoother blending, 8° search radius)
    let grid = idwGrid(pts, bounds, cols, rows, 1.5, 8, 3);

    // Smooth the grid to remove point-source artifacts (bullseye patterns)
    grid = smoothGrid(grid, cols, rows, 4);

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
    addLiveLog(`${label}: Generating contours (every ${interval}${field === 'mslp' ? 'mb' : '°F'})...`, '#d0d0d0');

    const geojson = generateMetarContours(field, interval);

    Object.values(maps).forEach(m => {
        if (m.getSource(sourceId)) m.getSource(sourceId).setData(geojson);
    });

    // Update data health timestamp
    const healthMap = {
        'sfc-isobars-2mb': 'sfcIsobars2mb',
        'sfc-isotherms': 'sfcIsotherms',
        'sfc-isodrosotherms': 'sfcIsodrosotherms'
    };
    if (healthMap[sourceId]) updateHealth(healthMap[sourceId]);

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

        Object.values(maps).forEach(m => {
            if (m.getSource('wpc-isobars')) m.getSource('wpc-isobars').setData(geojson);
        });

        updateHealth('wpcIsobars');
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
    if (lat < 10 || lat > 80 || lonRaw < 30 || lonRaw > 180) return null;

    return { lat, lon: -lonRaw };
}

function parseCodedBulletin(text) {
    const frontFeatures = [];
    const centerFeatures = [];
    const lines = text.split('\n');

    let currentSection = null;
    let lastFront = null;

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (!line || line === '$$' || line.startsWith('VALID')) {
            currentSection = null; lastFront = null; continue;
        }

        if (/^HIGHS\b/.test(line)) {
            currentSection = 'HIGHS';
            line = line.replace(/^HIGHS\b\s*/, '').trim();
        } else if (/^LOWS\b/.test(line)) {
            currentSection = 'LOWS';
            line = line.replace(/^LOWS\b\s*/, '').trim();
        } else if (/^(COLD|WARM|STNRY|OCFNT|TROF)\b/.test(line)) {
            currentSection = null;
        }

        if (currentSection === 'HIGHS' || currentSection === 'LOWS') {
            if (!line) continue;
            const tokens = line.split(/\s+/);
            for (let t = 0; t < tokens.length - 1; t++) {
                const pressure = parseInt(tokens[t]);
                if (!isNaN(pressure) && pressure >= 900 && pressure <= 1060 && tokens[t + 1]) {
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
        centers: { type: 'FeatureCollection', features: centerFeatures }
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

        const { fronts, centers } = parseCodedBulletin(text);

        Object.values(maps).forEach(m => {
            if (m.getSource('wpc-fronts')) m.getSource('wpc-fronts').setData(fronts);
            if (m.getSource('wpc-pressure-centers')) m.getSource('wpc-pressure-centers').setData(centers);
        });

        updateHealth('wpcFronts');
        addLiveLog(`WPC: ${fronts.features.length} fronts, ${centers.features.length} H/L centers loaded`, '#4488ff');
    } catch (e) {
        addLiveLog(`WPC FRONTS ERROR: ${e.message}`, '#ff3333');
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 8d: NHC TROPICAL PRODUCTS
// ═══════════════════════════════════════════════════════════════════════════════

const NHC_BASE = 'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather_summary/MapServer';

async function fetchNHCStorms(show) {
    if (!show) { updateSidebarToActivePane(); return; }

    addLiveLog('NHC: Fetching active tropical cyclones...', '#ff6600');
    try {
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

        Object.values(maps).forEach(m => {
            if (m.getSource('nhc-storms')) m.getSource('nhc-storms').setData(combined);
        });
        updateHealth('nhcStorms');

        const stormNames = [...new Set((pointsData.features || []).map(f => f.properties.STORMNAME || f.properties.stormname).filter(Boolean))];
        if (stormNames.length > 0) {
            addLiveLog(`NHC: Tracking ${stormNames.length} storm(s): ${stormNames.join(', ')}`, '#ff6600');
        } else {
            addLiveLog('NHC: No active tropical cyclones', '#888');
        }
    } catch (e) {
        addLiveLog(`NHC STORMS ERROR: ${e.message}`, '#ff3333');
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
            <div style="color:#88ccff; font-size:9px; margin-bottom:2px; font-weight:bold;">${g.name || gaugeId}</div>
            <div style="color:#777; font-size:8px; margin-bottom:6px;">${locStr} | WFO: ${wfo} | ID: ${g.lid}</div>
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

        // Hydrograph image
        if (images.default) {
            html += `<div style="border-top:1px solid rgba(0,229,255,0.15); padding-top:4px; margin-bottom:3px;">
                <span style="color:#00e5ff; font-size:8px; text-transform:uppercase; letter-spacing:0.5px;">Hydrograph</span>
            </div>
            <img src="${images.default}" style="width:100%; max-width:420px; border-radius:3px; border:1px solid rgba(0,229,255,0.15);" onerror="this.style.display='none'" />`;
        }

        // Link to water.weather.gov
        html += `<div style="margin-top:4px;"><a href="https://water.weather.gov/ahps2/hydrograph.php?gage=${gaugeId.toLowerCase()}&wfo=${wfo.toLowerCase()}" target="_blank" style="color:#00e5ff; font-size:8px; text-decoration:none;">Open on water.weather.gov &rarr;</a></div>`;

        const panel = document.getElementById('river-gauge-panel');
        const body = document.getElementById('river-gauge-body');
        if (panel && body) {
            body.innerHTML = html;
            const px = (originalEvent?.pageX || 400) + 15;
            const py = (originalEvent?.pageY || 200) - 100;
            panel.style.left = Math.min(px, window.innerWidth - 480) + 'px';
            panel.style.top = Math.max(10, Math.min(py, window.innerHeight - 500)) + 'px';
            panel.style.display = 'block';
        }
    } catch (e) {
        addLiveLog(`GAUGE DETAIL ERROR: ${e.message}`, '#ff3333');
    }
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
                    addLiveLog(`  ⚠ ${p.event} [${threat}] → ${area}`, p.isEmergency || p.damageThreat === 'Catastrophic' ? '#ff0000' : '#ff6600');
                });
            } else if (lastIbwCount > 0) {
                addLiveLog('WATCHDOG: All impact-based warnings have expired', '#00ff88');
            }
            lastIbwCount = ibwFeatures.length;
        }

        warningsLoaded = true;
        warningsGeoJSON = data;

        // Push to all map warning layers
        Object.values(maps).forEach(m => {
            if (m.getSource('nws-warnings')) m.getSource('nws-warnings').setData(warningsGeoJSON);
        });
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
                addLiveLog(`WATCHDOG: NEW ${event}${threatTag} → ${(area || '').substring(0, 80)}`, color);
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

    // Extract WFO city name from senderName (e.g., "NWS Omaha/Valley NE" → "Omaha")
    const wfoMatch = senderName.match(/^NWS\s+(.+?)(?:\s+[A-Z]{2})?$/);
    let wfo = wfoMatch ? wfoMatch[1].replace(/\/$/, '').trim() : senderName.replace(/^NWS\s*/, '').trim();
    // Take first city before "/" (e.g., "Kansas City/Pleasant Hill" → "Kansas City")
    if (wfo.includes('/')) wfo = wfo.split('/')[0].trim();
    // Strip trailing state abbreviation (e.g., "Baltimore MD" → "Baltimore")
    wfo = wfo.replace(/\s+[A-Z]{2}$/, '');

    // Extract state from the AFFECTED AREA, not the sender's location
    // Use UGC geocodes (e.g., "NEZ024") or parse areaDesc (e.g., "Douglas, KS; Johnson, KS")
    const affectedStates = new Set();
    const ugcCodes = props?.geocode?.UGC || props?.geocode?.SAME || [];
    ugcCodes.forEach(code => {
        const st = code.substring(0, 2);
        if (/^[A-Z]{2}$/.test(st)) affectedStates.add(st);
    });
    // Fallback: parse state codes from areaDesc (format: "County, ST; County, ST")
    if (affectedStates.size === 0 && area) {
        const stMatches = area.match(/,\s*([A-Z]{2})(?:\s*;|$)/g);
        if (stMatches) stMatches.forEach(m => {
            const st = m.replace(/[,;\s]/g, '');
            if (/^[A-Z]{2}$/.test(st)) affectedStates.add(st);
        });
    }
    // Last fallback: sender state
    if (affectedStates.size === 0) {
        const stMatch = senderName.match(/\b([A-Z]{2})$/);
        if (stMatch) affectedStates.add(stMatch[1]);
    }
    const stateStr = [...affectedStates].join(',');
    const primaryState = [...affectedStates][0] || '';

    const stateTag = primaryState ? `<span style="color:#00e5ff;font-weight:bold;">[${[...affectedStates].join('/')}]</span> ` : '';
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
        ibwBadge = `<span class="ibw-badge ibw-catastrophic">⚠ ${threat.toUpperCase()}</span>`;
    } else if (threat === 'Considerable') {
        ibwBadge = '<span class="ibw-badge ibw-considerable">⚠ CONSIDERABLE</span>';
    } else if (isPDS) {
        ibwBadge = '<span class="ibw-badge ibw-pds">⚠ PDS</span>';
    }

    if (ibwBadge) item.classList.add('ibw-enhanced');
    item.innerHTML = `<div class="warning-header">${time}Z — ${event || 'Alert'}${ibwBadge}</div><div>${stateTag}${(area || '').substring(0, 120)}</div>`;

    item.addEventListener('click', () => {
        const panel = document.getElementById('text-panel');
        const content = document.getElementById('text-product-content');
        if (!panel || !content) return;
        const desc = (props?.description || 'No description available.').replace(/\n/g, '<br>');
        const instr = (props?.instruction || '').replace(/\n/g, '<br>');
        const expires = props?.expires ? new Date(props.expires).toUTCString() : 'Unknown';
        content.innerHTML = `<div style="font-family:'Courier New',monospace;font-size:12px;color:#e0e0e0;line-height:1.6;">` +
            `<div style="font-weight:bold;color:${getEventColor(props?.event)};font-size:15px;margin-bottom:6px;">${props?.event || 'Weather Alert'}</div>` +
            `<div style="color:#888;margin-bottom:2px;">${senderName}</div>` +
            `<div style="margin-bottom:6px;">${props?.headline || ''}</div>` +
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

function startAnimation() {
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

    const durationMin = parseInt(document.getElementById('loop-duration').value) || 60;
    const stepMin = parseInt(document.getElementById('loop-step').value) || 5;
    let speedMs = parseInt(document.getElementById('loop-speed').value) || 400;
    const holdMs = Math.max(speedMs, 300);
    const playBtn = document.getElementById('play-btn');
    if (playBtn) playBtn.innerHTML = '<i data-lucide="pause"></i>';
    try { lucide.createIcons(); } catch (_) {}

    addLiveLog(`LOOP: Starting ${durationMin}min / ${stepMin}min step (SAT:${showSat} RAD:${showRad})`, '#ffb300');

    // ── Capture Visibility Snapshot (for restoration later) ──
    preAnimVisibility = {};
    const layersToSnapshot = [
        'satellite-layer', 'gibs-sat-layer', 'radar-layer',
        'site-bref-layer', 'site-bvel-layer', 'site-bdhc-layer', 'site-bdsa-layer', 'site-boha-layer'
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
    const gibsProdForLoop = paneGibs[activePaneId] || Object.values(paneGibs).find(Boolean);
    if (showGibs && gibsProdForLoop) {
        const allTimes = gibsTimesCache[gibsProdForLoop] || [];
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

    const masterFrames = satFrames.length >= radFrames.length ? satFrames : radFrames;
    const totalFrames = masterFrames.length;

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
            for (let i = 0; i < satFrames.length; i++) {
                const srcId = `anim-sat-src-${i}`;
                const lyrId = `anim-sat-lyr-${i}`;
                if (!map.getSource(srcId)) {
                    const satUrl = hadGibsVisible
                        ? gibsTileUrl(gibsProd, satFrames[i].isoTime)
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
    animationFrameIndex = 0;
    animationFrames = masterFrames;

    document.getElementById('stop-btn')?.style.setProperty('display', 'inline-flex');
    document.getElementById('step-prev-btn')?.style.setProperty('display', 'inline-flex');
    document.getElementById('step-next-btn')?.style.setProperty('display', 'inline-flex');

    addLiveLog(`LOOP: ${totalFrames} frames preloading (SAT:${satFrames.length} RAD:${radFrames.length})`, '#00ff88');

    // ── Wait briefly for initial tiles to start loading, then begin animation ──
    // Radar uses IEM cached tiles (fast ~800ms), satellite uses nowCOAST WMS (slower ~4s)
    const preloadDelay = satFrames.length > 0 ? 4000 : 800;

    animationTimer = setTimeout(advanceLoopTick, preloadDelay);
}

function advanceLoopTick() {
    if (!isPlaying) return;
    renderCurrentFrame();
    animationFrameIndex++;
    if (animationFrameIndex >= animationFrames.length) animationFrameIndex = 0;

    let speedMs = parseInt(document.getElementById('loop-speed').value) || 400;
    const holdMs = Math.max(speedMs, 300);
    animationTimer = setTimeout(advanceLoopTick, holdMs);
}

function renderCurrentFrame() {
    const totalFrames = animationFrames.length;
    if (totalFrames === 0) return;

    if (animationFrameIndex < 0) animationFrameIndex = totalFrames - 1;
    if (animationFrameIndex >= totalFrames) animationFrameIndex = 0;

    // Toggle satellite frame opacity with 60ms retention buffer to eliminate black-out flicker
    // Non-active frames stay at 0.01 (not 0) to keep MapLibre loading their tiles
    if (animSatFrames.length > 0) {
        const si = Math.min(animationFrameIndex, animSatFrames.length - 1);
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
        const ri = Math.min(animationFrameIndex, animRadFrames.length - 1);
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

    // Update per-pane labels with each pane's own channel/product info
    const satFrame = animSatFrames.length > 0 ? animSatFrames[Math.min(animationFrameIndex, animSatFrames.length - 1)] : null;
    const radFrame = animRadFrames.length > 0 ? animRadFrames[Math.min(animationFrameIndex, animRadFrames.length - 1)] : null;
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
    Object.entries(maps).forEach(([id, map]) => {
        const snapshot = preAnimVisibility[id];
        if (snapshot) {
            Object.entries(snapshot).forEach(([lyr, vis]) => {
                if (map.getLayer(lyr)) map.setLayoutProperty(lyr, 'visibility', vis);
            });
        } else {
            // Fallback to basic logic if no snapshot (rare)
            if (activeRadarNational && map.getLayer('radar-layer')) map.setLayoutProperty('radar-layer', 'visibility', 'visible');
            if (paneGoesChannels[id] !== null && map.getLayer('satellite-layer')) map.setLayoutProperty('satellite-layer', 'visibility', 'visible');
        }
    });
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
    const add = (cond, label, color) => { if (cond) rows.push({ label, color }); };

    // Imagery / base fields
    add(isLayerVisible(map, 'radar-layer'), 'NATL REFLECTIVITY', '#39ff5a');
    add(isLayerVisible(map, 'site-bref-layer'), `${site} BREF 0.5°${siteTimeSuffix(site, 'sr_bref')}`, '#39ff5a');
    add(isLayerVisible(map, 'site-bvel-layer'), `${site} VELOCITY 0.5°${siteTimeSuffix(site, 'sr_bvel')}`, '#5ad1ff');
    add(isLayerVisible(map, 'site-bdhc-layer'), `${site} HYDROMETEOR CLASS${siteTimeSuffix(site, 'bdhc')}`, '#ff9a3c');
    add(isLayerVisible(map, 'site-bdsa-layer'), `${site} STORM TOTAL PRECIP${siteTimeSuffix(site, 'bdsa')}`, '#3cff9a');
    add(isLayerVisible(map, 'site-boha-layer'), `${site} ONE-HOUR PRECIP${siteTimeSuffix(site, 'boha')}`, '#3cff9a');
    add(isLayerVisible(map, 'satellite-layer') && ch !== null, `GOES-E CH${ch} SATELLITE`, '#cfd8e3');
    if (isLayerVisible(map, 'gibs-sat-layer') && paneGibs[paneId]) {
        rows.push({ label: `GOES-E ${GIBS_PRODUCTS[paneGibs[paneId]]?.label || paneGibs[paneId]} (GIBS)`, color: '#9fd0ff' });
    }
    add(isLayerVisible(map, 'lightning-layer'), 'NLDN LIGHTNING', '#ffd23c');
    add(isLayerVisible(map, 'mrms-echotops-layer'), 'MRMS ECHO TOPS', '#9b59ff');
    add(isLayerVisible(map, 'mrms-qpe-layer'), 'MRMS QPE', '#39ff5a');
    // Surface / analysis
    add(isLayerVisible(map, 'metars-temp'), 'METAR OBS', '#39ff5a');
    add(isLayerVisible(map, 'sfc-isobars-2mb-line'), 'ISOBARS 2mb', '#d0d0d0');
    add(isLayerVisible(map, 'sfc-isotherms-line'), 'ISOTHERMS 2°F', '#ff4444');
    add(isLayerVisible(map, 'sfc-isodrosotherms-line'), 'ISODROSOTHERMS 2°F', '#44cc44');
    add(isLayerVisible(map, 'wpc-isobars-line'), 'WPC ISOBARS 4mb', '#d0d0d0');
    add(isLayerVisible(map, 'wpc-fronts-solid'), 'WPC FRONTS', '#4488ff');
    add(isLayerVisible(map, 'wpc-qpf-layer'), 'WPC QPF', '#39ff5a');
    if (isLayerVisible(map, 'radar-l3-layer') && paneL3[paneId]) {
        rows.push({ label: `L3 ${paneL3[paneId].meta?.name || paneL3[paneId].product} · ${paneL3[paneId].station}`, color: '#33c27a' });
    }
    // Hazards
    add(isLayerVisible(map, 'spc-day1-fill'), 'SPC DAY 1 OUTLOOK', '#ff4d4d');
    add(isLayerVisible(map, 'spc-day2-fill'), 'SPC DAY 2 OUTLOOK', '#ff4d4d');
    add(isLayerVisible(map, 'spc-day3-fill'), 'SPC DAY 3 OUTLOOK', '#ff4d4d');
    add(isLayerVisible(map, 'wpc-ero-day1-fill'), 'WPC ERO DAY 1', '#39ff5a');
    add(isLayerVisible(map, 'wpc-ero-day2-fill'), 'WPC ERO DAY 2', '#39ff5a');
    add(isLayerVisible(map, 'wpc-ero-day3-fill'), 'WPC ERO DAY 3', '#39ff5a');
    add(isLayerVisible(map, 'spc-md-fill'), 'SPC MESO DISCUSSIONS', '#ff6a00');
    add(isLayerVisible(map, 'wpc-mpd-fill'), 'WPC MESO PRECIP DISC', '#33c27a');
    add(isLayerVisible(map, 'spc-lsr-icons'), 'LOCAL STORM REPORTS', '#ff8c00');
    add(isLayerVisible(map, 'nws-warnings-only-fill'), 'NWS WARNINGS', '#ff3333');
    add(isLayerVisible(map, 'nws-watches-only-fill'), 'NWS WATCHES', '#ffaa00');
    add(isLayerVisible(map, 'nhc-track-pts'), 'NHC STORMS', '#ff3333');
    add(isLayerVisible(map, 'nhc-outlook-fill'), 'NHC TROPICAL OUTLOOK', '#ffaa00');
    // Climate / environment
    add(isLayerVisible(map, 'cpc-temp-layer'), 'CPC TEMP OUTLOOK', '#ff8c69');
    add(isLayerVisible(map, 'cpc-precip-layer'), 'CPC PRECIP OUTLOOK', '#69b3ff');
    add(isLayerVisible(map, 'drought-fill'), 'US DROUGHT MONITOR', '#d2a679');
    add(isLayerVisible(map, 'cpc-drought-layer'), 'CPC DROUGHT OUTLOOK', '#4488ff');
    add(isLayerVisible(map, 'firms-fires-layer'), 'ACTIVE FIRES', '#ff4500');
    add(isLayerVisible(map, 'hms-smoke-fill'), 'HMS SMOKE', '#aaaaaa');
    add(isLayerVisible(map, 'airnow-aqi-layer'), 'AIR QUALITY (AQI)', '#39ff5a');
    add(isLayerVisible(map, 'river-gauges-layer'), 'RIVER GAUGES', '#5ad1ff');
    add(isLayerVisible(map, 'solar-night-fill'), 'DAY/NIGHT TERMINATOR', '#8893a3');
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

        // Keep the site-radar valid time current (throttled; re-renders on load)
        const m = maps[paneId];
        const pSite = paneRadarSites[paneId];
        if (m && pSite && !pSite.includes('nexrad') &&
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
            let res;
            const nationalCenters = ['NHC', 'SPC', 'CPC', 'WPC', 'OPC', 'AWC'];
            if (nationalCenters.includes(wfo)) {
                res = await fetch(`https://api.weather.gov/products/types/${product}`);
            } else {
                res = await fetch(`https://api.weather.gov/products/types/${product}/locations/${wfo}`);
                if (!res.ok) {
                    res = await fetch(`https://api.weather.gov/products/types/${product}`);
                }
            }

            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
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
                opt.textContent = '-- No Products Found --';
                versionSelect.appendChild(opt);
                return;
            }

            products.slice(0, 25).forEach((p, i) => {
                const opt = document.createElement('option');
                opt.value = p['@id'] || p.id;
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

function updateSidebarToActivePane() {
    const map = maps[activePaneId];
    if (!map) return;

    document.querySelectorAll('.product-item').forEach(item => {
        const layer = item.getAttribute('data-layer');
        if (!layer) return;

        let isActive = false;
        if (layer === 'airnow-aqi') isActive = isLayerVisible(map, 'airnow-aqi-layer');
        else if (layer === 'metars') isActive = isLayerVisible(map, 'metars-temp');
        else if (layer === 'radar-l3') isActive = isLayerVisible(map, 'radar-l3-layer') && paneL3[activePaneId] && paneL3[activePaneId].product === item.getAttribute('data-l3');
        else if (layer === 'radar-ref') isActive = isLayerVisible(map, 'radar-layer') || isLayerVisible(map, 'site-bref-layer');
        else if (layer === 'radar-vel') isActive = isLayerVisible(map, 'site-bvel-layer');
        else if (layer === 'radar-hc') isActive = isLayerVisible(map, 'site-bdhc-layer');
        else if (layer === 'radar-stp') isActive = isLayerVisible(map, 'site-bdsa-layer');
        else if (layer === 'radar-oha') isActive = isLayerVisible(map, 'site-boha-layer');
        else if (layer === 'goes-ch') {
            const ch = parseInt(item.getAttribute('data-channel'));
            isActive = isLayerVisible(map, 'satellite-layer') && paneGoesChannels[activePaneId] === ch;
        }
        else if (layer === 'gibs-sat') isActive = isLayerVisible(map, 'gibs-sat-layer') && paneGibs[activePaneId] === item.getAttribute('data-gibs');
        else if (layer === 'lightning') isActive = isLayerVisible(map, 'lightning-layer');
        else if (layer === 'hms-smoke') isActive = isLayerVisible(map, 'hms-smoke-fill');
        else if (layer === 'firms-fires') isActive = isLayerVisible(map, 'firms-fires-layer');
        else if (layer === 'nws-warnings-only') isActive = isLayerVisible(map, 'nws-warnings-only-fill');
        else if (layer === 'nws-watches-only') isActive = isLayerVisible(map, 'nws-watches-only-fill');
        else if (layer === 'nws-wwa') isActive = isLayerVisible(map, 'nws-wwa-wms-layer');
        else if (layer === 'spc-md') isActive = isLayerVisible(map, 'spc-md-fill');
        else if (layer === 'wpc-mpd') isActive = isLayerVisible(map, 'wpc-mpd-fill');
        else if (layer === 'spc-lsr') isActive = isLayerVisible(map, 'spc-lsr-icons');
        else if (layer === 'spc-outlook') {
            const day = item.getAttribute('data-day');
            isActive = isLayerVisible(map, `spc-day${day}-fill`);
        }
        else if (layer === 'wpc-ero') {
            const day = item.getAttribute('data-day');
            isActive = isLayerVisible(map, `wpc-ero-day${day}-fill`);
        }
        else if (layer === 'overlay-states') isActive = isLayerVisible(map, 'states-layer');
        else if (layer === 'overlay-counties') isActive = isLayerVisible(map, 'counties-layer');
        else if (layer === 'overlay-roads') isActive = isLayerVisible(map, 'esri-roads-layer');
        else if (layer === 'overlay-cities') isActive = isLayerVisible(map, 'esri-labels-layer');
        else if (layer === 'overlay-cwa') isActive = isLayerVisible(map, 'nws-cwa-layer');
        else if (layer === 'river-gauges') isActive = isLayerVisible(map, 'river-gauges-layer');
        else if (layer === 'solar-terminator') isActive = isLayerVisible(map, 'solar-night-fill');
        else if (layer === 'wpc-isobars') isActive = isLayerVisible(map, 'wpc-isobars-line');
        else if (layer === 'sfc-isobars-2mb') isActive = isLayerVisible(map, 'sfc-isobars-2mb-line');
        else if (layer === 'sfc-isotherms') isActive = isLayerVisible(map, 'sfc-isotherms-line');
        else if (layer === 'sfc-isodrosotherms') isActive = isLayerVisible(map, 'sfc-isodrosotherms-line');
        else if (layer === 'wpc-fronts') isActive = isLayerVisible(map, 'wpc-fronts-solid');
        else if (layer === 'wpc-qpf') {
            const qpfId = item.getAttribute('data-qpf');
            isActive = isLayerVisible(map, 'wpc-qpf-layer') && activeQpfLayer === qpfId;
        }
        else if (layer === 'nhc-storms') isActive = isLayerVisible(map, 'nhc-track-pts');
        else if (layer === 'nhc-outlook') isActive = isLayerVisible(map, 'nhc-outlook-fill');
        else if (layer === 'cpc-temp') {
            const period = item.getAttribute('data-period');
            isActive = isLayerVisible(map, 'cpc-temp-layer') && activeCpcTempLayer === period;
        }
        else if (layer === 'cpc-precip') {
            const period = item.getAttribute('data-period');
            isActive = isLayerVisible(map, 'cpc-precip-layer') && activeCpcPrecipLayer === period;
        }
        else if (layer === 'mrms-echotops') isActive = isLayerVisible(map, 'mrms-echotops-layer');
        else if (layer === 'mrms-qpe') {
            const qpePeriod = item.getAttribute('data-qpe');
            isActive = isLayerVisible(map, 'mrms-qpe-layer') && activeMrmsQpe === qpePeriod;
        }
        else if (layer === 'drought-monitor') isActive = isLayerVisible(map, 'drought-fill');
        else if (layer === 'cpc-drought-outlook') isActive = isLayerVisible(map, 'cpc-drought-layer');

        if (isActive) item.classList.add('active');
        else item.classList.remove('active');
    });

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
    refreshTimestampLabel();
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
            applyWatchdogFilter();
        });
    }
    if (wfoFilter) {
        rebuildWfoFilter(); // seed from static roster; live offices merged in as alerts arrive
        wfoFilter.addEventListener('change', () => {
            if (stateFilter) stateFilter.value = 'all';
            applyWatchdogFilter();
        });
    }

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

            // ─── GOES Satellite (per-pane channel) ───
            if (layer === 'goes-ch') {
                const ch = parseInt(item.getAttribute('data-channel'));
                const isAlreadyThisChannel = item.classList.contains('active');

                if (isAlreadyThisChannel) {
                    map.setLayoutProperty('satellite-layer', 'visibility', 'none');
                } else {
                    paneGoesChannels[activePaneId] = ch; // Per-pane tracking
                    activeGoesChannel = ch; // Sync convenience global
                    // Only update THIS pane's satellite source
                    if (map.getSource('satellite')) map.getSource('satellite').setTiles([goesChannelUrl(ch)]);
                    map.setLayoutProperty('satellite-layer', 'visibility', 'visible');
                    updateHealth('sat');
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
            if (layer === 'sfc-isobars-2mb' || layer === 'sfc-isotherms' || layer === 'sfc-isodrosotherms') {
                const isActive = !item.classList.contains('active');
                if (isActive) {
                    // Ensure METARs are loaded first
                    if (!metarsLoaded) {
                        addLiveLog('CONTOUR: Fetching METARs first...', '#ffaa00');
                        await fetchMETARs();
                    }
                    const config = {
                        'sfc-isobars-2mb':    { field: 'mslp', interval: 2, label: 'ISOBARS 2mb' },
                        'sfc-isotherms':      { field: 'tmpf', interval: 2, label: 'ISOTHERMS' },
                        'sfc-isodrosotherms': { field: 'dwpf', interval: 2, label: 'ISODROSOTHERMS' }
                    }[layer];
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
                    activeQpfLayer = null;
                } else {
                    activeQpfLayer = qpfId;
                    const wmsUrl = `https://mapservices.weather.noaa.gov/vector/rest/services/precip/wpc_qpf/MapServer/export?bbox={bbox-epsg-3857}&bboxSR=102100&layers=show:${qpfId}&size=512,512&imageSR=102100&format=png32&transparent=true&f=image`;
                    Object.values(maps).forEach(m => {
                        if (m.getSource('wpc-qpf')) m.getSource('wpc-qpf').setTiles([wmsUrl]);
                    });
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
                    activeMrmsQpe = null;
                } else {
                    activeMrmsQpe = qpePeriod;
                    const layerMap = { '1h': 'mrms_p1h', '24h': 'mrms_p24h', '48h': 'mrms_p48h', '72h': 'mrms_p72h' };
                    const wmsLayer = layerMap[qpePeriod] || 'mrms_p1h';
                    const wmsUrl = `https://mesonet.agron.iastate.edu/cgi-bin/wms/us/mrms_nn.cgi?service=WMS&version=1.1.1&request=GetMap&layers=${wmsLayer}&format=image/png&transparent=true&styles=&srs=EPSG:3857&width=256&height=256&bbox={bbox-epsg-3857}`;
                    Object.values(maps).forEach(m => {
                        if (m.getSource('mrms-qpe')) m.getSource('mrms-qpe').setTiles([wmsUrl]);
                    });
                    map.setLayoutProperty('mrms-qpe-layer', 'visibility', 'visible');
                    updateHealth('mrmsQpe');
                }
                updateRadarLegend();
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
                    activeCpcTempLayer = null;
                } else {
                    activeCpcTempLayer = period;
                    const svcMap = { '6-10': 'cpc_6_10_day_outlk', '8-14': 'cpc_8_14_day_outlk', 'monthly': 'cpc_mthly_temp_outlk', 'seasonal': 'cpc_sea_temp_outlk' };
                    const svc = svcMap[period] || svcMap['6-10'];
                    const layerId = (period === '6-10' || period === '8-14') ? '1' : '0';
                    const wmsUrl = `https://mapservices.weather.noaa.gov/vector/services/outlooks/${svc}/MapServer/WMSServer?service=WMS&version=1.1.1&request=GetMap&layers=${layerId}&format=image/png&transparent=true&styles=&srs=EPSG:3857&width=256&height=256&bbox={bbox-epsg-3857}`;
                    Object.values(maps).forEach(m => {
                        if (m.getSource('cpc-temp')) m.getSource('cpc-temp').setTiles([wmsUrl]);
                    });
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
                    activeCpcPrecipLayer = null;
                } else {
                    activeCpcPrecipLayer = period;
                    const svcMap = { '6-10': 'cpc_6_10_day_outlk', '8-14': 'cpc_8_14_day_outlk', 'monthly': 'cpc_mthly_precip_outlk', 'seasonal': 'cpc_sea_precip_outlk' };
                    const svc = svcMap[period] || svcMap['6-10'];
                    const layerId = (period === '6-10' || period === '8-14') ? '0' : '0';
                    const wmsUrl = `https://mapservices.weather.noaa.gov/vector/services/outlooks/${svc}/MapServer/WMSServer?service=WMS&version=1.1.1&request=GetMap&layers=${layerId}&format=image/png&transparent=true&styles=&srs=EPSG:3857&width=256&height=256&bbox={bbox-epsg-3857}`;
                    Object.values(maps).forEach(m => {
                        if (m.getSource('cpc-precip')) m.getSource('cpc-precip').setTiles([wmsUrl]);
                    });
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
// SECTION 16: RADAR SITE SELECTOR
// ═══════════════════════════════════════════════════════════════════════════════

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
                }
            });

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
        const res = await fetch(`/api/radar-l3?station=${station}&product=${product}`);
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
        if (paneId === activePaneId) refreshTimestampLabel();
        addLiveLog(`L3 NODD: ${station} ${data.meta.name} @ ${data.meta.time} (el ${data.meta.elevation}°)`, '#00ff88');
    } catch (e) {
        addLiveLog(`L3 NODD ERROR: ${e.message}`, '#ff3333');
    }
}

function clearL3Radar(paneId) {
    const map = maps[paneId];
    if (map && map.getLayer('radar-l3-layer')) map.setLayoutProperty('radar-l3-layer', 'visibility', 'none');
    delete paneL3[paneId];
    if (paneId === activePaneId) refreshTimestampLabel();
}

// ─── GIBS live satellite (newest available frame; tiles, browser-direct) ───
async function loadGibsLive(paneId, prodKey) {
    const map = maps[paneId];
    if (!map || !GIBS_PRODUCTS[prodKey]) return;
    const p = GIBS_PRODUCTS[prodKey];
    const prev = paneGibs[paneId];
    paneGibs[paneId] = prodKey;
    // Paint instantly with the newest known frame (cached) or the 'default'
    // keyword, then heal below. NOTE: for slow-cadence visible bands (Red
    // Visible) the 'default' keyword AND the newest raw domain timestamps are
    // often BLANK; /api/gibs-times now drops every unpublished frame, so the
    // refresh below lands on a frame that actually has tiles.
    const times = gibsTimesCache[prodKey] || [];
    const url = gibsTileUrl(prodKey, times.length ? times[times.length - 1] : 'default');
    // Recreate the source when switching products (maxzoom differs); else just retile
    if (map.getSource('gibs-sat') && prev === prodKey) {
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
    addLiveLog(`GIBS: ${p.label} (GOES-East) loaded`, '#00e5ff');
    // Always (re)warm the published-frame time list so the live view heals to a
    // real frame and looping is ready + current.
    fetchGibsTimes(prodKey).then(t => {
        if (t.length && paneGibs[paneId] === prodKey && map.getSource('gibs-sat')) {
            map.getSource('gibs-sat').setTiles([gibsTileUrl(prodKey, t[t.length - 1])]);
        }
    });
}

function clearGibs(paneId) {
    const map = maps[paneId];
    if (map && map.getLayer('gibs-sat-layer')) map.setLayoutProperty('gibs-sat-layer', 'visibility', 'none');
    delete paneGibs[paneId];
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
    } else if (mrmsQpeVis && activeMrmsQpe) {
        const qpeTitles = { '1h': 'MRMS 1-HR QPE (in)', '24h': 'MRMS 24-HR QPE (in)', '48h': 'MRMS 48-HR QPE (in)', '72h': 'MRMS 72-HR QPE (in)' };
        const title = qpeTitles[activeMrmsQpe] || 'MRMS QPE (in)';
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
        'wpc-ero-day1-fill', 'wpc-ero-day1-line', 'wpc-ero-day2-fill', 'wpc-ero-day2-line', 'wpc-ero-day3-fill', 'wpc-ero-day3-line',
        'spc-md-fill', 'spc-md-outline', 'wpc-mpd-fill', 'wpc-mpd-outline', 'spc-lsr-icons', 'spc-lsr-mag',
        'nws-warnings-only-fill', 'nws-warnings-only-outline',
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
        'wpc-fronts-solid', 'wpc-fronts-stnry', 'wpc-fronts-trof', 'wpc-fronts-pips',
        'wpc-hl-letter', 'wpc-hl-pressure',
        'wpc-qpf-layer',
        'mrms-echotops-layer', 'mrms-qpe-layer',
        'river-gauges-layer', 'river-gauges-glow', 'river-gauges-label',
        'solar-night-fill', 'solar-twilight-fill', 'solar-terminator-line',
        'nhc-cone-fill', 'nhc-cone-outline', 'nhc-track-line', 'nhc-track-pts', 'nhc-track-labels',
        'nhc-warn-fill', 'nhc-warn-outline', 'nhc-outlook-fill', 'nhc-outlook-outline',
        'cpc-temp-layer', 'cpc-precip-layer',
        'drought-fill', 'drought-outline', 'cpc-drought-layer',
        'nws-cwa-layer', 'nws-cwa-label-layer'
    ];
    allToggleLayers.forEach(l => {
        if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', 'none');
    });
    paneGoesChannels[paneId] = null;
    if (paneId === activePaneId) activeGoesChannel = null;
    activeQpfLayer = null;
    activeMrmsQpe = null;
    activeCpcTempLayer = null;
    activeCpcPrecipLayer = null;
    delete paneL3[paneId];
    delete paneGibs[paneId];
    updateRadarLegend(paneId);
    updateEroLegend(paneId);
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
    addLiveLog(`TAB: New workspace "${tabs[id].name}"`, '#00e5ff');
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
        delete paneGibs[pid];
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
    delete pendingRestore[paneId];
    const map = maps[paneId];
    if (!map) return;
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
            if (map.getSource('satellite')) map.getSource('satellite').setTiles([goesChannelUrl(conf.goesChannel)]);
            if (map.getLayer('satellite-layer')) map.setLayoutProperty('satellite-layer', 'visibility', 'visible');
            if (paneId === activePaneId) activeGoesChannel = conf.goesChannel;
        }
    } catch (_) {}
    if (paneId === activePaneId && typeof updateSidebarToActivePane === 'function') {
        updateSidebarToActivePane();
    }
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
                    const conf = {};
                    const m = maps[pid];
                    if (paneRadarSites[pid]) conf.radarSite = paneRadarSites[pid];
                    if (paneRadarProducts[pid]) conf.radarProduct = paneRadarProducts[pid];
                    if (paneGoesChannels[pid] != null) conf.goesChannel = paneGoesChannels[pid];
                    if (paneGibs[pid]) conf.gibs = paneGibs[pid];
                    if (paneL3[pid]) conf.l3 = paneL3[pid];
                    // Record whether the imagery layers are actually showing, so
                    // we only auto-restore what was visible (not merely selected).
                    if (m) {
                        conf.radarVisible = ['site-bref-layer', 'site-bvel-layer', 'site-bdhc-layer',
                            'site-bdsa-layer', 'site-boha-layer'].some(l => isLayerVisible(m, l));
                        conf.satVisible = isLayerVisible(m, 'satellite-layer') && paneGoesChannels[pid] != null;
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
                // Defer live-layer restore until the pane's map loads
                if (conf.gibs || conf.l3 || conf.radarVisible || conf.satVisible) pendingRestore[pid] = conf;
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
    bar?.addEventListener('click', e => {
        const close = e.target.closest('.tab-close');
        if (close) { e.stopPropagation(); closeTab(close.getAttribute('data-close')); return; }
        const btn = e.target.closest('.tab-btn');
        if (btn) switchTab(btn.getAttribute('data-tab'));
    });
    bar?.addEventListener('dblclick', e => {
        const btn = e.target.closest('.tab-btn');
        if (btn) startTabRename(btn.getAttribute('data-tab'));
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
        // Mesoscale Discussions
        const mcdActive = Object.values(maps).some(m => isLayerVisible(m, 'spc-md-fill'));
        if (mcdActive) fetchMesoscaleDiscussions(true);

        const mpdActive = Object.values(maps).some(m => isLayerVisible(m, 'wpc-mpd-fill'));
        if (mpdActive) fetchMPDs(true);
    }, 60 * 1000);

    // 2. High Frequency (5 minutes)
    setInterval(async () => {
        if (isPlaying) return;
        
        // Radar refresh — national mosaic
        if (activeRadarNational) {
            const url = cacheBust(nationalRadarUrl());
            Object.values(maps).forEach(m => {
                if (m.getSource('radar')) m.getSource('radar').setTiles([url]);
            });
            updateHealth('radar');
            addLiveLog('AUTO: National radar tiles refreshed', '#444');
        }

        // Radar refresh — site-specific products
        const siteRadarLayers = ['site-bref-layer', 'site-bvel-layer', 'site-bdhc-layer', 'site-bdsa-layer', 'site-boha-layer'];
        const anySiteRadar = Object.values(maps).some(m => siteRadarLayers.some(l => isLayerVisible(m, l)));
        if (anySiteRadar) {
            Object.entries(maps).forEach(([pid, m]) => {
                const site = paneRadarSites[pid] || 'DGX';
                if (site.includes('nexrad')) return;
                const prod = paneRadarProducts[pid] || 'sr_bref';
                const prodSourceMap = { 'sr_bref': 'site-bref', 'sr_bvel': 'site-bvel', 'bdhc': 'site-bdhc', 'bdsa': 'site-bdsa', 'boha': 'site-boha' };
                const srcName = prodSourceMap[prod];
                if (srcName && m.getSource(srcName)) {
                    m.getSource(srcName).setTiles([siteRadarUrl(site, prod)]);
                }
            });
            updateHealth('radar');
            addLiveLog('AUTO: Site radar tiles refreshed', '#444');
        }
        
        // METARs refresh + re-generate any visible contour products
        const metarsActive = Object.values(maps).some(m => isLayerVisible(m, 'metars-temp') || isLayerVisible(m, 'metars-barb'));
        const isobars2mbActive = Object.values(maps).some(m => isLayerVisible(m, 'sfc-isobars-2mb-line'));
        const isothermsActive = Object.values(maps).some(m => isLayerVisible(m, 'sfc-isotherms-line'));
        const isodrosActive = Object.values(maps).some(m => isLayerVisible(m, 'sfc-isodrosotherms-line'));
        const anyContourActive = isobars2mbActive || isothermsActive || isodrosActive;

        if (metarsActive || anyContourActive) {
            await fetchMETARs();
            // Re-generate contours from fresh METAR data
            if (isobars2mbActive) renderContourProduct('sfc-isobars-2mb', 'mslp', 2, 'ISOBARS 2mb');
            if (isothermsActive) renderContourProduct('sfc-isotherms', 'tmpf', 2, 'ISOTHERMS');
            if (isodrosActive) renderContourProduct('sfc-isodrosotherms', 'dwpf', 2, 'ISODROSOTHERMS');
            if (anyContourActive) addLiveLog('AUTO: Contour products refreshed from new METARs', '#444');
        }

        // Solar terminator refresh
        const terminatorActive = Object.values(maps).some(m => isLayerVisible(m, 'solar-night-fill'));
        if (terminatorActive) updateTerminator();
    }, 5 * 60 * 1000);

    // 3. Standard Frequency (10 minutes)
    setInterval(() => {
        if (isPlaying) return;
        
        // Satellite refresh — each pane may have its own GOES channel
        let anyRefreshed = false;
        Object.entries(maps).forEach(([paneId, m]) => {
            const ch = paneGoesChannels[paneId];
            if (ch !== null && m.getSource('satellite') && isLayerVisible(m, 'satellite-layer')) {
                m.getSource('satellite').setTiles([cacheBust(goesChannelUrl(ch))]);
                anyRefreshed = true;
            }
        });
        if (anyRefreshed) {
            updateHealth('sat');
            addLiveLog('AUTO: Satellite tiles refreshed', '#444');
        }
    }, 10 * 60 * 1000);

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

        // WPC Excessive Rainfall Outlooks (Day 1-3)
        [1, 2, 3].forEach(day => {
            const eroActive = Object.values(maps).some(m => isLayerVisible(m, `wpc-ero-day${day}-fill`));
            if (eroActive) fetchERO(day, true);
        });


        // SPC Local Storm Reports
        const lsrActive = Object.values(maps).some(m => isLayerVisible(m, 'spc-lsr-icons'));
        if (lsrActive) fetchLSRs(true);

        // WPC Isobars
        const isobarsActive = Object.values(maps).some(m => isLayerVisible(m, 'wpc-isobars-line'));
        if (isobarsActive) fetchWPCIsobars(true);

        // WPC Fronts
        const frontsActive = Object.values(maps).some(m => isLayerVisible(m, 'wpc-fronts-solid'));
        if (frontsActive) fetchWPCFronts(true);

        // NHC tropical (storms + outlook) refreshes on its own faster interval below.

        // River gauges refresh
        const gaugesActive = Object.values(maps).some(m => isLayerVisible(m, 'river-gauges-layer'));
        if (gaugesActive) {
            riverGaugeCacheTime = 0; // Force cache bust
            fetchRiverGauges(true);
        }

        // MRMS Echo Tops tile refresh
        const echotopsActive = Object.values(maps).some(m => isLayerVisible(m, 'mrms-echotops-layer'));
        if (echotopsActive) {
            const etUrl = cacheBust('https://opengeo.ncep.noaa.gov/geoserver/conus/conus_neet_v18/ows?service=wms&version=1.1.1&request=GetMap&layers=conus_neet_v18&format=image/png&transparent=true&styles=&srs=EPSG:3857&width=256&height=256&bbox={bbox-epsg-3857}');
            Object.values(maps).forEach(m => {
                if (m.getSource('mrms-echotops')) m.getSource('mrms-echotops').setTiles([etUrl]);
            });
            updateHealth('mrmsEchotops');
        }

        // MRMS QPE tile refresh
        if (activeMrmsQpe) {
            const layerMap = { '1h': 'mrms_p1h', '24h': 'mrms_p24h', '48h': 'mrms_p48h', '72h': 'mrms_p72h' };
            const wmsLayer = layerMap[activeMrmsQpe] || 'mrms_p1h';
            const qpeUrl = cacheBust(`https://mesonet.agron.iastate.edu/cgi-bin/wms/us/mrms_nn.cgi?service=WMS&version=1.1.1&request=GetMap&layers=${wmsLayer}&format=image/png&transparent=true&styles=&srs=EPSG:3857&width=256&height=256&bbox={bbox-epsg-3857}`);
            Object.values(maps).forEach(m => {
                if (m.getSource('mrms-qpe')) m.getSource('mrms-qpe').setTiles([qpeUrl]);
            });
            updateHealth('mrmsQpe');
        }

        // WPC QPF tile refresh
        if (activeQpfLayer) {
            const wmsUrl = cacheBust(`https://mapservices.weather.noaa.gov/vector/rest/services/precip/wpc_qpf/MapServer/export?bbox={bbox-epsg-3857}&bboxSR=102100&layers=show:${activeQpfLayer}&size=512,512&imageSR=102100&format=png32&transparent=true&f=image`);
            Object.values(maps).forEach(m => {
                if (m.getSource('wpc-qpf')) m.getSource('wpc-qpf').setTiles([wmsUrl]);
            });
            updateHealth('wpcQpf');
        }

    }, 30 * 60 * 1000);

    // NHC tropical layers refresh faster (5 min) — advisories/intermediate
    // advisories update on short cycles during active storms, and the fetches
    // are tiny cache-busted GeoJSON. Only runs while a tropical layer is on.
    setInterval(() => {
        if (Object.values(maps).some(m => isLayerVisible(m, 'nhc-track-pts'))) fetchNHCStorms(true);
        if (Object.values(maps).some(m => isLayerVisible(m, 'nhc-outlook-fill'))) fetchNHCOutlook(true);
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

function initSolarClickHandler() {
    Object.entries(maps).forEach(([paneId, map]) => {
        map.on('click', async e => {
            // Only trigger when solar terminator is visible
            if (!isLayerVisible(map, 'solar-night-fill')) return;

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
    });

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
    });
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
        `</div>`).join('');

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
    initPlayButton();
    initContextMenu();
    initWhatsNew();
    initHealthToggle();
    initDebugToggle();
    initSyncButton();
    initSoundingModal();
    initTextModal();
    initSolarClickHandler();
    initRiverGaugePanel();

    // Start warning watchdog (check every 15 seconds for rapid convective updates)
    addLiveLog('WATCHDOG: National feed monitoring active (15s polling)', '#00ff88');
    checkNewWarnings();
    setInterval(checkNewWarnings, 15 * 1000);

    // NEXRAD Level III (NODD) — poll for new scans on any pane showing an L3 overlay
    setInterval(() => {
        Object.keys(paneL3).forEach(pid => {
            const st = paneL3[pid];
            if (st && maps[pid] && isLayerVisible(maps[pid], 'radar-l3-layer')) {
                loadL3Radar(pid, st.station, st.product);
            }
        });
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
    setInterval(checkNewWatches, 15 * 1000);

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

// Boot on DOM ready
document.addEventListener('DOMContentLoaded', init);
