// ═══════════════════════════════════════════════════════════════════════════════
// FX-Net NextGen | Tactical Meteorological Workstation
// (c) 2026 Rodney Cuevas, Meteorologist
// MapLibre GL JS v3.6.2 — Dark AWIPS-like UI
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

// ═══ GLOBAL STATE ═══
const maps = {};
let activePaneId = '1';
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
let paneRadarSites = { '1': 'DGX', '2': 'DGX', '3': 'DGX', '4': 'DGX', '5': 'DGX', '6': 'DGX', '7': 'DGX', '8': 'DGX' };
let paneRadarProducts = { '1': 'sr_bref', '2': 'sr_bref', '3': 'sr_bref', '4': 'sr_bref', '5': 'sr_bref', '6': 'sr_bref', '7': 'sr_bref', '8': 'sr_bref' };
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
let warningsGeoJSON = { type: 'FeatureCollection', features: [] };
let watchesLoaded = false;
let watchesGeoJSON = { type: 'FeatureCollection', features: [] };
let greatLakesLoaded = false;
let greatLakesGeoJSON = { type: 'FeatureCollection', features: [] };
let activeSpcDay = null;
let activeQpfLayer = null;
let activeCpcTempLayer = null;
let activeCpcPrecipLayer = null;
let isSyncingMaps = false;

// ═══ DATA HEALTH SYSTEM ═══
const healthTrackers = {};
const HEALTH_THRESHOLDS = {
    radar:    { label: 'NEXRAD Radar',    thresholdMs: 5 * 60 * 1000 },
    sat:      { label: 'GOES Satellite',  thresholdMs: 10 * 60 * 1000 },
    metar:    { label: 'METAR Obs',       thresholdMs: 30 * 60 * 1000 },
    warnings: { label: 'NWS Warnings',    thresholdMs: 15 * 60 * 1000 },
    watches:  { label: 'NWS Watches',     thresholdMs: 15 * 60 * 1000 },
    hms:      { label: 'HMS Smoke',       thresholdMs: 4 * 60 * 60 * 1000 },
    aqi:      { label: 'AirNow AQI',      thresholdMs: 2 * 60 * 60 * 1000 },
    firms:    { label: 'FIRMS Fires',     thresholdMs: 4 * 60 * 60 * 1000 },
    wpcIsobars: { label: 'WPC Isobars',   thresholdMs: 4 * 60 * 60 * 1000 },
    wpcFronts:  { label: 'WPC Fronts/HL', thresholdMs: 4 * 60 * 60 * 1000 },
    wpcQpf:     { label: 'WPC QPF',       thresholdMs: 8 * 60 * 60 * 1000 },
    nhcStorms:  { label: 'NHC Storms',    thresholdMs: 60 * 60 * 1000 },
    nhcOutlook: { label: 'NHC Outlook',   thresholdMs: 6 * 60 * 60 * 1000 },
    cpcTemp:    { label: 'CPC Temp',      thresholdMs: 24 * 60 * 60 * 1000 },
    cpcPrecip:  { label: 'CPC Precip',    thresholdMs: 24 * 60 * 60 * 1000 },
    drought:    { label: 'Drought Monitor', thresholdMs: 7 * 24 * 60 * 60 * 1000 }
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

                        const prod = paneRadarProducts[paneId] || 'sr_bref';
                        const readout = decodeRadarPixel(data[0], data[1], data[2], prod);
                        const valSamplerEl = document.getElementById('val-sampler');
                        if (valSamplerEl) valSamplerEl.innerText = `${paneRadarSites[paneId] || 'DGX'} ${prod.toUpperCase()}: ${readout}`;
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
        isSyncingMaps = true;
        const center = map.getCenter();
        const zoom = map.getZoom();
        const bearing = map.getBearing();
        const pitch = map.getPitch();
        Object.entries(maps).forEach(([id, m]) => {
            if (String(id) !== String(paneId) && m) {
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
    map.addSource('coastlines', {
        type: 'geojson',
        data: 'https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_coastline.geojson'
    });
    map.addLayer({
        id: 'coastlines-layer',
        type: 'line',
        source: 'coastlines',
        layout: { visibility: 'visible' },
        paint: {
            'line-color': '#888888',
            'line-width': 1.2,
            'line-opacity': 0.8
        }
    });

    map.addSource('international-borders', {
        type: 'geojson',
        data: 'https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0/ne_50m_admin_0_boundary_lines_land.geojson'
    });
    map.addLayer({
        id: 'international-borders-layer',
        type: 'line',
        source: 'international-borders',
        layout: { visibility: 'visible' },
        paint: {
            'line-color': '#888888',
            'line-width': 1.2,
            'line-dasharray': [2, 2],
            'line-opacity': 0.8
        }
    });

    // ─── Layer 1: State Boundaries (visible by default) ───
    map.addSource('states', {
        type: 'raster',
        tiles: ['https://mesonet.agron.iastate.edu/cgi-bin/wms/us/states.cgi?VERSION=1.1.1&SERVICE=WMS&REQUEST=GetMap&LAYERS=usstates&FORMAT=image/png&TRANSPARENT=true&STYLES=&SRS=EPSG:3857&WIDTH=256&HEIGHT=256&BBOX={bbox-epsg-3857}'],
        tileSize: 256
    });
    map.addLayer({ id: 'states-layer', type: 'raster', source: 'states', layout: { visibility: 'visible' }, paint: { 'raster-opacity': 0.9 } });


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

    // ─── Layer 3: Satellite (GOES-East) ───
    map.addSource('satellite', {
        type: 'raster',
        tiles: [goesChannelUrl(13)],
        tileSize: 256
    });
    map.addLayer({ id: 'satellite-layer', type: 'raster', source: 'satellite', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.8 } });

    // ─── Layer 4: National Radar (IEM mosaic) ───
    map.addSource('radar', {
        type: 'raster',
        tiles: [nationalRadarUrl()],
        tileSize: 256
    });
    map.addLayer({ id: 'radar-layer', type: 'raster', source: 'radar', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.9, 'raster-resampling': 'linear', 'raster-fade-duration': 150 } });

    // ─── Layer 4b: Site-Specific Radar (NCEP OpenGeo WMS) ───
    const defaultSite = (paneRadarSites[paneId] || 'dgx').toLowerCase();
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
    map.addLayer({
        id: 'nws-warnings-only-fill', type: 'fill', source: 'nws-warnings',
        layout: { visibility: 'none' },
        filter: ['any', 
            ['in', 'Warning', ['get', 'event']], 
            ['in', 'Emergency', ['get', 'event']],
            ['in', 'Statement', ['get', 'event']],
            ['in', 'Advisory', ['get', 'event']]
        ],
        paint: {
            'fill-color': ['case',
                ['in', 'Tornado', ['get', 'event']], '#ff0000',
                ['in', 'Severe Thunderstorm', ['get', 'event']], '#ffa500',
                ['in', 'Flash Flood', ['get', 'event']], '#8b0000',
                ['in', 'Flood Advisory', ['get', 'event']], '#00ff7f',
                ['in', 'Small Stream', ['get', 'event']], '#00ff7f',
                ['in', 'Flood', ['get', 'event']], '#008b00',
                ['in', 'Freeze Warning', ['get', 'event']], '#483d8b',
                ['in', 'Freeze', ['get', 'event']], '#00bfff',
                ['in', 'Winter Storm', ['get', 'event']], '#ff69b4',
                ['in', 'Blizzard', ['get', 'event']], '#ff4500',
                ['in', 'Wind Chill', ['get', 'event']], '#afeeee',
                ['in', 'Cold', ['get', 'event']], '#0000ff',
                ['in', 'Statement', ['get', 'event']], '#00ffff',
                '#ff0000'
            ],
            'fill-opacity': ['case',
                ['in', 'Tornado', ['get', 'event']], 0.65,
                ['in', 'Severe Thunderstorm', ['get', 'event']], 0.5,
                ['in', 'Flash Flood', ['get', 'event']], 0.5,
                ['in', 'Statement', ['get', 'event']], 0.25,
                0.35
            ]
        }
    });
    map.addLayer({
        id: 'nws-warnings-only-outline', type: 'line', source: 'nws-warnings',
        layout: { visibility: 'none' },
        filter: ['any', 
            ['in', 'Warning', ['get', 'event']], 
            ['in', 'Emergency', ['get', 'event']],
            ['in', 'Statement', ['get', 'event']],
            ['in', 'Advisory', ['get', 'event']]
        ],
        paint: {
            'line-color': ['case',
                ['in', 'Tornado', ['get', 'event']], '#ffffff',
                ['in', 'Severe Thunderstorm', ['get', 'event']], '#ffffff',
                ['in', 'Flash Flood', ['get', 'event']], '#ffffff',
                ['in', 'Freeze Warning', ['get', 'event']], '#00ffff',
                ['in', 'Freeze', ['get', 'event']], '#00ffff',
                ['in', 'Winter Storm', ['get', 'event']], '#ffffff',
                ['in', 'Statement', ['get', 'event']], '#00ffff',
                '#dddddd'
            ],
            'line-width': ['case',
                ['in', 'Tornado', ['get', 'event']], 4.0,
                ['in', 'Severe Thunderstorm', ['get', 'event']], 3.0,
                ['in', 'Flash Flood', ['get', 'event']], 3.0,
                ['in', 'Statement', ['get', 'event']], 1.5,
                2.0
            ]
        }
    });

    // 6b: Watches Layer (High-fidelity vector polygons from NOAA REST MapServer)
    map.addLayer({
        id: 'nws-watches-only-fill', type: 'fill', source: 'nws-watches-vector',
        layout: { visibility: 'none' },
        filter: ['in', 'Watch', ['get', 'prod_type']],
        paint: {
            'fill-color': ['match', ['get', 'prod_type'],
                'Tornado Watch', '#ffff00',
                'Severe Thunderstorm Watch', '#db7093',
                'Flood Watch', '#2e8b57',
                'Fire Weather Watch', '#cda528',
                'Winter Storm Watch', '#4682b4',
                'Freeze Watch', '#00bfff',
                'Wind Chill Watch', '#5f9ea0',
                'Extreme Cold Watch', '#0000ff',
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
                'Tornado Watch', '#ffff00',
                'Severe Thunderstorm Watch', '#db7093',
                'Flood Watch', '#2e8b57',
                'Fire Weather Watch', '#cda528',
                'Winter Storm Watch', '#4682b4',
                'Freeze Watch', '#00bfff',
                'Wind Chill Watch', '#5f9ea0',
                'Extreme Cold Watch', '#0000ff',
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
        paint: { 'line-color': '#ff6600', 'line-width': 1.5 }
    });
    map.addLayer({
        id: 'nhc-track-line', type: 'line', source: 'nhc-storms',
        filter: ['==', ['get', 'layerType'], 'track'],
        layout: { visibility: 'none' },
        paint: { 'line-color': '#ffcc00', 'line-width': 2, 'line-dasharray': [4, 2] }
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
            'text-field': ['concat', ['get', 'stormname'], '\n', ['to-string', ['get', 'maxwind']], ' kt'],
            'text-font': ['Noto Sans Bold'],
            'text-size': 10,
            'text-offset': [0, 1.5],
            'text-allow-overlap': true
        },
        paint: { 'text-color': '#ffcc00', 'text-halo-color': '#000', 'text-halo-width': 1.5 }
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
            'fill-color': ['step', ['coalesce', ['get', 'risk2day'], 0],
                '#ffff00', 40, '#ff9900', 70, '#ff0000'],
            'fill-opacity': 0.25
        }
    });
    map.addLayer({
        id: 'nhc-outlook-outline', type: 'line', source: 'nhc-outlook',
        layout: { visibility: 'none' },
        paint: { 'line-color': '#ffcc00', 'line-width': 1.5, 'line-dasharray': [4, 2] }
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

    // Altimeter/Pressure (cyan, upper-right)
    map.addLayer({
        id: 'metars-press', type: 'symbol', source: 'metars', minzoom: 7,
        layout: {
            'text-field': ['case', ['has', 'alti'], ['to-string', ['round', ['*', 100, ['get', 'alti']]]], ''],
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
                <span style="color:#888;">Altimeter:</span><span>${p.alti != null ? p.alti.toFixed(2) + ' inHg' : 'M'}</span>
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
        const ozTxt = p.ozone_aqi != null && p.ozone_aqi !== 'null' ? `${p.ozone_aqi} (${aqiCategory(+p.ozone_aqi)})` : 'N/A';
        const pmTxt = p.pm25_aqi != null && p.pm25_aqi !== 'null' ? `${p.pm25_aqi} (${aqiCategory(+p.pm25_aqi)})` : 'N/A';
        const overall = p.aqi || 0;
        const validStr = p.valid_time ? new Date(p.valid_time).toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, month: 'short', day: 'numeric' }) : 'Unknown';
        const html = `<div style="font-family:Inter,sans-serif;font-size:11px;color:#e0e0e0;background:#0d1117;padding:8px;border-radius:4px;">
            <div style="font-weight:bold;color:${aqiColor(overall)};font-size:13px;margin-bottom:4px;">${p.site_name || 'Monitor'}</div>
            <div style="color:#888;margin-bottom:6px;">${validStr}</div>
            <div style="display:flex;gap:12px;margin-bottom:4px;">
                <div><span style="color:#888;">Ozone:</span> <span style="color:${p.ozone_aqi > 0 ? aqiColor(+p.ozone_aqi) : '#666'}">${ozTxt}</span></div>
            </div>
            <div style="display:flex;gap:12px;margin-bottom:4px;">
                <div><span style="color:#888;">PM2.5:</span> <span style="color:${p.pm25_aqi > 0 ? aqiColor(+p.pm25_aqi) : '#666'}">${pmTxt}</span></div>
            </div>
            <div style="border-top:1px solid #333;padding-top:4px;margin-top:4px;">
                <span style="color:#888;">Overall AQI:</span> <span style="font-weight:bold;color:${aqiColor(overall)}">${overall} — ${aqiCategory(overall)}</span>
            </div>
        </div>`;
        popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
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
        const bright = p.bright_ti4 || p.brightness || 'N/A';
        const frp = p.frp || 'N/A';
        const html = `<div style="font-family:Inter,sans-serif;font-size:11px;color:#e0e0e0;background:#0d1117;padding:8px;border-radius:4px;">
            <div style="font-weight:bold;color:#ff6600;font-size:13px;margin-bottom:4px;">🔥 VIIRS Fire Detection</div>
            <div style="color:#888;margin-bottom:6px;">${dt ? new Date(dt).toUTCString() : 'Recent'}</div>
            <div><span style="color:#888;">Confidence:</span> ${conf}</div>
            <div><span style="color:#888;">Brightness:</span> ${bright}K</div>
            <div><span style="color:#888;">FRP:</span> ${frp} MW</div>
            <div style="color:#555;margin-top:4px;">${coord ? coord[1].toFixed(4) + '°N, ' + Math.abs(coord[0]).toFixed(4) + '°W' : ''}</div>
        </div>`;
        popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
    });
    map.on('mouseenter', 'firms-fires-layer', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'firms-fires-layer', () => { map.getCanvas().style.cursor = ''; });

    // NHC Storm point click
    map.on('click', 'nhc-track-pts', e => {
        if (!e.features || !e.features[0]) return;
        const p = e.features[0].properties;
        const name = p.stormname || p.STORMNAME || 'Unknown';
        const wind = p.maxwind || p.MAXWIND || 'N/A';
        const mslp = p.MSLP || p.mslp || 'N/A';
        const cat = wind >= 137 ? 'CAT 5' : wind >= 113 ? 'CAT 4' : wind >= 96 ? 'CAT 3' : wind >= 83 ? 'CAT 2' : wind >= 64 ? 'CAT 1' : wind >= 34 ? 'TS' : 'TD';
        const html = `<div style="font-family:Inter,sans-serif;font-size:11px;color:#e0e0e0;background:#0d1117;padding:8px;border-radius:4px;max-width:280px;">
            <div style="font-weight:bold;color:#ff6600;font-size:14px;margin-bottom:4px;">${name}</div>
            <div><span style="color:#888;">Classification:</span> <span style="color:#ffcc00;">${cat}</span></div>
            <div><span style="color:#888;">Max Wind:</span> ${wind} kt</div>
            <div><span style="color:#888;">Min Pressure:</span> ${mslp} mb</div>
            <div><span style="color:#888;">Advisory:</span> ${p.ADVISNUM || p.advisnum || 'N/A'}</div>
        </div>`;
        popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
    });
    map.on('mouseenter', 'nhc-track-pts', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'nhc-track-pts', () => { map.getCanvas().style.cursor = ''; });

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
        const otherFeats = map.queryRenderedFeatures(e.point, { layers: ['metars-temp', 'firms-fires-layer', 'spc-md-fill', 'airnow-aqi-layer', 'drought-fill', 'nhc-track-pts', 'nexrad-sites-layer'] });
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
                if (idx > 0) combinedHtml += `<hr style="border:0;border-top:1px solid #333;margin:12px 0;">`;
                combinedHtml += `
                    <div style="font-weight:bold;color:${evtColor};font-size:14px;margin-bottom:4px;">${p.event || 'Weather Alert'}</div>
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

async function fetchSPCOutlook(day, show) {
    if (!show) {
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
        updateSidebarToActivePane();
        addLiveLog(`SPC: Day ${day} Outlook loaded (${data.features?.length || 0} areas)`, '#ffff00');
    } catch (e) {
        addLiveLog(`SPC ERROR: ${e.message}`, '#ff3333');
    }
}

async function fetchMesoscaleDiscussions(show) {
    if (!show) {
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
        updateSidebarToActivePane();
        
        if (realFeatures.length > 0) {
            addLiveLog(`SPC: ${realFeatures.length} Mesoscale Discussion(s) active`, '#ff3333');
        } else {
            addLiveLog('SPC: No active Mesoscale Discussions found', '#888');
        }
    } catch (e) {
        addLiveLog(`SPC MD ERROR: ${e.message}`, '#ff3333');
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

        const [coneRes, trackRes, pointsRes, warnRes] = await Promise.all([
            fetch(`${NHC_BASE}/7/query?where=1%3D1&outFields=*&f=geojson`),
            fetch(`${NHC_BASE}/6/query?where=1%3D1&outFields=*&f=geojson`),
            fetch(`${NHC_BASE}/5/query?where=1%3D1&outFields=*&f=geojson`),
            fetch(`${NHC_BASE}/8/query?where=1%3D1&outFields=*&f=geojson`)
        ]);

        const [coneData, trackData, pointsData, warnData] = await Promise.all([
            coneRes.json(), trackRes.json(), pointsRes.json(), warnRes.json()
        ]);

        (coneData.features || []).forEach(f => {
            f.properties.layerType = 'cone';
            combined.features.push(f);
        });
        (trackData.features || []).forEach(f => {
            f.properties.layerType = 'track';
            combined.features.push(f);
        });
        (pointsData.features || []).forEach(f => {
            f.properties.layerType = 'point';
            f.properties.maxwind = f.properties.MAXWIND || f.properties.maxwind || 0;
            f.properties.stormname = f.properties.STORMNAME || f.properties.stormname || 'UNKNOWN';
            combined.features.push(f);
        });
        (warnData.features || []).forEach(f => {
            f.properties.layerType = 'warning';
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
            fetch(`${NHC_BASE}/1/query?where=1%3D1&outFields=*&f=geojson`).then(r => r.json()),
            fetch(`${NHC_BASE}/3/query?where=1%3D1&outFields=*&f=geojson`).then(r => r.json())
        ]);

        const combined = { type: 'FeatureCollection', features: [] };
        (sevenDay.features || []).forEach(f => {
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
        let res = await fetch('https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/Air_Now_Monitor_Data_Public/FeatureServer/0/query?where=CountryCode%3D%27US%27&orderByFields=ValidTime%20DESC&outFields=*&f=geojson&outSR=4326&resultRecordCount=5000');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        let data = await res.json();

        // If primary service returns 0 features (backend maintenance/clearing), failover to active mirror
        if (!data || !data.features || data.features.length === 0) {
            addLiveLog('AQI: Primary table empty, failing over to secondary AirNow mirror...', '#ffaa00');
            res = await fetch('https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/Air_Now_Monitors_Ozone_and_PM/FeatureServer/0/query?where=1%3D1&orderByFields=ValidTime%20DESC&outFields=*&f=geojson&outSR=4326&resultRecordCount=5000');
            if (res.ok) {
                data = await res.json();
            }
        }

        const seenSites = new Set();
        const filtered = {
            type: 'FeatureCollection',
            features: (data.features || []).filter(f => {
                if (!f.geometry || f.geometry.type !== 'Point') return false;
                const coords = f.geometry.coordinates;
                if (!coords || coords.length < 2 || coords[0] === 0 || coords[1] === 0) return false;
                const p = f.properties;
                const oz = p.OZONE_AQI ?? -1;
                const pm = p.PM25_AQI ?? -1;
                if (oz < 0 && pm < 0) return false;
                const site = p.SiteName || p.SITE_NAME || `${coords[0]},${coords[1]}`;
                if (seenSites.has(site)) return false;
                seenSites.add(site);
                return true;
            }).map(f => {
                const p = f.properties;
                const ozoneAqi = p.OZONE_AQI ?? -1;
                const pm25Aqi = p.PM25_AQI ?? -1;
                const aqi = Math.max(ozoneAqi, pm25Aqi, 0);
                return {
                    type: 'Feature',
                    geometry: f.geometry,
                    properties: {
                        aqi,
                        ozone_aqi: ozoneAqi >= 0 ? ozoneAqi : null,
                        pm25_aqi: pm25Aqi >= 0 ? pm25Aqi : null,
                        site_name: p.SiteName || p.SITE_NAME || 'Unknown',
                        valid_time: p.ValidTime || p.VALID_TIME || p.ValidDate || ''
                    }
                };
            })
        };

        Object.values(maps).forEach(m => {
            if (m.getSource('airnow-aqi')) m.getSource('airnow-aqi').setData(filtered);
        });
        updateHealth('aqi');
        addLiveLog(`AQI: ${filtered.features.length} monitors loaded`, '#00ff88');
    } catch (e) {
        addLiveLog(`AQI ERROR: ${e.message}`, '#ff3333');
    }
}

async function fetchFIRMS(show) {
    if (!show) {
        updateSidebarToActivePane();
        return;
    }
    addLiveLog('FIRMS: Fetching VIIRS fire detections...', '#ff6600');
    try {
        const res = await fetch('https://services9.arcgis.com/RHVPKKiFTONKtxq3/arcgis/rest/services/Satellite_VIIRS_Thermal_Hotspots_and_Fire_Activity/FeatureServer/0/query?where=esritimeutc+%3E+CURRENT_TIMESTAMP+-+2&outFields=*&f=geojson&outSR=4326&resultRecordCount=10000');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const fc = {
            type: 'FeatureCollection',
            features: (data.features || []).filter(f => f.geometry && f.geometry.type === 'Point').map(f => {
                const p = f.properties;
                const dt = p.esritimeutc ? new Date(p.esritimeutc).toISOString() : '';
                return {
                    type: 'Feature',
                    geometry: f.geometry,
                    properties: {
                        confidence: p.confidence === 'high' ? 90 : p.confidence === 'nominal' ? 50 : 20,
                        bright_ti4: p.bright_ti4 || p.brightness || '',
                        frp: p.frp || '',
                        acq_datetime: dt,
                        satellite: p.satellite || 'VIIRS'
                    }
                };
            })
        };
        Object.values(maps).forEach(m => {
            if (m.getSource('firms-fires')) m.getSource('firms-fires').setData(fc);
        });
        updateHealth('firms');
        addLiveLog(`FIRMS: ${fc.features.length} fire detections loaded`, '#00ff88');
    } catch (e) {
        addLiveLog(`FIRMS ERROR: ${e.message}`, '#ff3333');
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

        // Process forward so that when we prepend, the absolute newest alert ends up exactly on top
        for (let i = 0; i < toProcess.length; i++) {
            const f = toProcess[i];
            const event = f.properties?.event;
            const area = f.properties?.areaDesc;
            const severity = f.properties?.severity;
            addWarningToTicker(event, area, severity, f.properties);
            if (!isFirst) {
                const color = severity === 'Extreme' ? '#ff0000' : severity === 'Severe' ? '#ff3333' : '#ffb300';
                addLiveLog(`WATCHDOG: NEW ${event} → ${(area || '').substring(0, 80)}`, color);
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
    'Key West','Knoxville','La Crosse','Lake Charles','Las Vegas','Little Rock',
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

function addWarningToTicker(event, area, severity, props) {
    const list = document.getElementById('latest-warnings-list');
    if (!list) return;
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
    item.innerHTML = `<div class="warning-header">${time}Z — ${event || 'Alert'}</div><div>${stateTag}${(area || '').substring(0, 120)}</div>`;

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
    if (list.querySelector('.warning-placeholder')) list.innerHTML = '';
    list.prepend(item);
    while (list.children.length > 1000) list.lastChild.remove();
    applyWatchdogFilter();
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


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 11: ANIMATION ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

function startAnimation() {
    if (isPlaying) return;
    isPlaying = true;

    const activeMap = maps[activePaneId];
    if (!activeMap) { stopAnimation(); return; }

    // Check what is actually visible on the active pane
    const showSat = isLayerVisible(activeMap, 'satellite-layer');
    const showSiteBref = isLayerVisible(activeMap, 'site-bref-layer');
    const showSiteBvel = isLayerVisible(activeMap, 'site-bvel-layer');
    const showSiteBdhc = isLayerVisible(activeMap, 'site-bdhc-layer');
    const showSiteRad = showSiteBref || showSiteBvel || showSiteBdhc;
    const showRad = isLayerVisible(activeMap, 'radar-layer') || showSiteRad;

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
        'satellite-layer', 'radar-layer', 
        'site-bref-layer', 'site-bvel-layer', 'site-bdhc-layer'
    ];
    Object.entries(maps).forEach(([id, map]) => {
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
    if (showSat && activeGoesChannel !== null) {
        let satStep = Math.max(stepMin, 5); // minimum 5-min steps (nowCOAST cadence)
        // Offset "now" by 7 min to avoid requesting future timestamps that lack data
        const satNow = new Date(now.getTime() - 7 * 60000);
        let count = Math.floor(durationMin / satStep);
        if (count > 24) { satStep = Math.ceil(durationMin / 24 / 5) * 5; count = Math.floor(durationMin / satStep); }
        for (let i = 0; i < count; i++) {
            const d = new Date(satNow.getTime() - (count - 1 - i) * satStep * 60000);
            const isoTime = snapToNowCoastTime(d);
            satFrames.push({
                tileUrl: nowCoastSatUrl(activeGoesChannel, isoTime),
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
            // Site-Specific NEXRAD Radar Animation
            let siteProduct = 'sr_bref';
            if (showSiteBvel) siteProduct = 'sr_bvel';
            else if (showSiteBdhc) siteProduct = 'bdhc';
            const siteVal = paneRadarSites[activePaneId] || document.getElementById('radar-site-select')?.value || 'DGX';

            let radStep = Math.max(stepMin, 5);
            let count = Math.floor(durationMin / radStep);
            if (count > 24) { radStep = Math.ceil(durationMin / 24 / 5) * 5; count = Math.floor(durationMin / radStep); }
            for (let i = 0; i < count; i++) {
                const d = new Date(now.getTime() - (count - 1 - i) * radStep * 60000);
                const isoStr = d.toISOString().replace(/\.\d{3}Z$/, 'Z');
                radFrames.push({
                    tileUrl: siteRadarAnimUrl(siteVal, siteProduct, isoStr),
                    time: d,
                    label: `${siteVal.toUpperCase()} ${siteProduct.toUpperCase().replace('SR_','')} ${isoStr.substring(11, 16)}Z`
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
    // Each frame gets its own source+layer pair with visibility:visible, raster-opacity:0
    // MapLibre fetches tiles for opacity-0 layers, enabling instant frame switching
    Object.values(maps).forEach(map => {
        // Hide live layers
        if (satFrames.length > 0 && map.getLayer('satellite-layer')) {
            map.setLayoutProperty('satellite-layer', 'visibility', 'none');
        }
        if (radFrames.length > 0) {
            if (map.getLayer('radar-layer')) map.setLayoutProperty('radar-layer', 'visibility', 'none');
            if (map.getLayer('site-bref-layer')) map.setLayoutProperty('site-bref-layer', 'visibility', 'none');
            if (map.getLayer('site-bvel-layer')) map.setLayoutProperty('site-bvel-layer', 'visibility', 'none');
            if (map.getLayer('site-bdhc-layer')) map.setLayoutProperty('site-bdhc-layer', 'visibility', 'none');
        }

        // Create satellite animation layers
        // Use opacity 0.01 (not 0) to force MapLibre to actually fetch tiles
        for (let i = 0; i < satFrames.length; i++) {
            const srcId = `anim-sat-src-${i}`;
            const lyrId = `anim-sat-lyr-${i}`;
            if (!map.getSource(srcId)) {
                map.addSource(srcId, { type: 'raster', tiles: [satFrames[i].tileUrl], tileSize: 256 });
                map.addLayer({ id: lyrId, type: 'raster', source: srcId,
                    layout: { visibility: 'visible' },
                    paint: {
                        'raster-opacity': 0.01,
                        'raster-resampling': 'nearest',
                        'raster-fade-duration': 0
                    }
                }, 'radar-layer');
            }
        }

        // Create radar animation layers
        for (let i = 0; i < radFrames.length; i++) {
            const srcId = `anim-rad-src-${i}`;
            const lyrId = `anim-rad-lyr-${i}`;
            if (!map.getSource(srcId)) {
                map.addSource(srcId, { type: 'raster', tiles: [radFrames[i].tileUrl], tileSize: 512 });
                map.addLayer({ id: lyrId, type: 'raster', source: srcId,
                    layout: { visibility: 'visible' },
                    paint: {
                        'raster-opacity': 0.01,
                        'raster-resampling': 'nearest',
                        'raster-fade-duration': 0
                    }
                });
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

    // Update labels and progress
    const labels = [];
    if (animSatFrames.length > 0) labels.push(animSatFrames[Math.min(animationFrameIndex, animSatFrames.length - 1)].label);
    if (animRadFrames.length > 0) labels.push(animRadFrames[Math.min(animationFrameIndex, animRadFrames.length - 1)].label);

    updatePaneTimestamps(`LOOP | ${labels.join(' + ')}`);
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

function updatePaneTimestamps(forceLabel = null) {
    Object.keys(maps).forEach(paneId => {
        const el = document.getElementById(`radar-ts-${paneId}`);
        if (!el) return;

        if (forceLabel) {
            el.textContent = forceLabel;
            return;
        }

        const map = maps[paneId];
        const site = (paneRadarSites[paneId] || 'DGX').toUpperCase();
        let label = 'LIVE';
        if (isLayerVisible(map, 'site-bref-layer')) {
            label = `${site} BREF | VCP 212 | Tilt 1 (0.5°)`;
        } else if (isLayerVisible(map, 'site-bvel-layer')) {
            label = `${site} BVEL | VCP 212 | Tilt 1 (0.5°)`;
        } else if (isLayerVisible(map, 'site-bdhc-layer')) {
            label = `${site} BDHC | VCP 212 | Tilt 1 (0.5°)`;
        } else if (isLayerVisible(map, 'radar-layer')) {
            label = 'NATL RADAR MOSAIC';
        } else if (isLayerVisible(map, 'satellite-layer')) {
            label = `GOES-16 CH ${paneGoesChannels[paneId] || 1}`;
        }

        el.textContent = label;
    });
}

function getActiveProductLabel(paneId) {
    const map = maps[paneId];
    if (!map) return 'LIVE';

    const parts = [];
    
    // Check Satellite
    if (isLayerVisible(map, 'satellite-layer') && paneGoesChannels[paneId] !== null) {
        parts.push(`GOES Ch${paneGoesChannels[paneId]}`);
    }

    // Check Radar
    if (isLayerVisible(map, 'radar-layer')) parts.push('Radar REF');
    else if (isLayerVisible(map, 'site-bref-layer')) parts.push('Site BREF');
    
    if (isLayerVisible(map, 'site-bvel-layer')) parts.push('Site BVEL');
    if (isLayerVisible(map, 'site-bdhc-layer')) parts.push('Site BDHC');

    // Check METARs
    if (isLayerVisible(map, 'metars-temp') && latestMetarTime) {
        const localTimeStr = latestMetarTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short' });
        parts.push(`METAR (${localTimeStr})`);
    }
    
    // Check AQI
    if (isLayerVisible(map, 'airnow-aqi-layer')) parts.push('AQI');

    if (parts.length === 0) return 'LIVE';
    return parts.join(' + ') + ' | LIVE';
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
        else if (layer === 'radar-ref') isActive = isLayerVisible(map, 'radar-layer') || isLayerVisible(map, 'site-bref-layer');
        else if (layer === 'radar-vel') isActive = isLayerVisible(map, 'site-bvel-layer');
        else if (layer === 'radar-hc') isActive = isLayerVisible(map, 'site-bdhc-layer');
        else if (layer === 'goes-ch') {
            const ch = parseInt(item.getAttribute('data-channel'));
            isActive = isLayerVisible(map, 'satellite-layer') && paneGoesChannels[activePaneId] === ch;
        }
        else if (layer === 'hms-smoke') isActive = isLayerVisible(map, 'hms-smoke-fill');
        else if (layer === 'firms-fires') isActive = isLayerVisible(map, 'firms-fires-layer');
        else if (layer === 'nws-warnings-only') isActive = isLayerVisible(map, 'nws-warnings-only-fill');
        else if (layer === 'nws-watches-only') isActive = isLayerVisible(map, 'nws-watches-only-fill');
        else if (layer === 'nws-wwa') isActive = isLayerVisible(map, 'nws-wwa-wms-layer');
        else if (layer === 'spc-md') isActive = isLayerVisible(map, 'spc-md-fill');
        else if (layer === 'spc-outlook') {
            const day = item.getAttribute('data-day');
            isActive = isLayerVisible(map, `spc-day${day}-fill`);
        }
        else if (layer === 'overlay-states') isActive = isLayerVisible(map, 'states-layer');
        else if (layer === 'overlay-counties') isActive = isLayerVisible(map, 'counties-layer');
        else if (layer === 'overlay-roads') isActive = isLayerVisible(map, 'esri-roads-layer');
        else if (layer === 'overlay-cities') isActive = isLayerVisible(map, 'esri-labels-layer');
        else if (layer === 'wpc-isobars') isActive = isLayerVisible(map, 'wpc-isobars-line');
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
        const prodMapInv = { 'sr_bref': 'N0Q', 'sr_bvel': 'N0V', 'bdhc': 'NET' };
        const selProd = prodMapInv[prod] || 'N0Q';
        if (prodSelect.value !== selProd) prodSelect.value = selProd;
    }
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
        ALL_WFOS.forEach(w => {
            const opt = document.createElement('option');
            opt.value = w; opt.textContent = w;
            wfoFilter.appendChild(opt);
        });
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

            // ─── Mesoscale Discussions ───
            if (layer === 'spc-md') {
                const isActive = !item.classList.contains('active');
                if (isActive) await fetchMesoscaleDiscussions(true);
                map.setLayoutProperty('spc-md-fill', 'visibility', isActive ? 'visible' : 'none');
                map.setLayoutProperty('spc-md-outline', 'visibility', isActive ? 'visible' : 'none');
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

            // ─── Radar ───
            if (layer === 'radar-ref') {
                const isActive = !item.classList.contains('active');
                const siteVal = paneRadarSites[activePaneId] || 'DGX';
                const isNational = siteVal.includes('nexrad');

                if (isNational) {
                    activeRadarNational = isActive; // UPDATE GLOBAL FLAG FOR LOOPING
                    map.setLayoutProperty('radar-layer', 'visibility', isActive ? 'visible' : 'none');
                    map.setLayoutProperty('site-bref-layer', 'visibility', 'none');
                } else {
                    activeRadarNational = false; // Disable national if site selected
                    paneRadarProducts[activePaneId] = 'sr_bref';
                    map.setLayoutProperty('radar-layer', 'visibility', 'none');
                    if (isActive && map.getSource('site-bref')) map.getSource('site-bref').setTiles([siteRadarUrl(siteVal, 'sr_bref')]);
                    map.setLayoutProperty('site-bref-layer', 'visibility', isActive ? 'visible' : 'none');
                    if (isActive && map.getLayer('site-bvel-layer')) map.setLayoutProperty('site-bvel-layer', 'visibility', 'none');
                    if (isActive && map.getLayer('site-bdhc-layer')) map.setLayoutProperty('site-bdhc-layer', 'visibility', 'none');
                }
                updateSidebarToActivePane();
                refreshTimestampLabel();
                return;
            }

            if (layer === 'radar-vel') {
                const isActive = !item.classList.contains('active');
                const siteVal = paneRadarSites[activePaneId] || 'DGX';
                if (!siteVal.includes('nexrad')) {
                    paneRadarProducts[activePaneId] = 'sr_bvel';
                    if (map.getSource('site-bvel')) map.getSource('site-bvel').setTiles([siteRadarUrl(siteVal, 'sr_bvel')]);
                    map.setLayoutProperty('site-bvel-layer', 'visibility', isActive ? 'visible' : 'none');
                    if (isActive && map.getLayer('site-bref-layer')) map.setLayoutProperty('site-bref-layer', 'visibility', 'none');
                    if (isActive && map.getLayer('site-bdhc-layer')) map.setLayoutProperty('site-bdhc-layer', 'visibility', 'none');
                }
                updateSidebarToActivePane();
                refreshTimestampLabel();
                return;
            }

            if (layer === 'radar-hc') {
                const isActive = !item.classList.contains('active');
                const siteVal = paneRadarSites[activePaneId] || 'DGX';
                if (!siteVal.includes('nexrad')) {
                    paneRadarProducts[activePaneId] = 'bdhc';
                    if (map.getSource('site-bdhc')) map.getSource('site-bdhc').setTiles([siteRadarUrl(siteVal, 'bdhc')]);
                    map.setLayoutProperty('site-bdhc-layer', 'visibility', isActive ? 'visible' : 'none');
                    if (isActive && map.getLayer('site-bref-layer')) map.setLayoutProperty('site-bref-layer', 'visibility', 'none');
                    if (isActive && map.getLayer('site-bvel-layer')) map.setLayoutProperty('site-bvel-layer', 'visibility', 'none');
                }
                updateSidebarToActivePane();
                refreshTimestampLabel();
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

            // ─── WPC Isobars ───
            if (layer === 'wpc-isobars') {
                const isActive = !item.classList.contains('active');
                if (isActive) await fetchWPCIsobars(true);
                map.setLayoutProperty('wpc-isobars-line', 'visibility', isActive ? 'visible' : 'none');
                map.setLayoutProperty('wpc-isobars-label', 'visibility', isActive ? 'visible' : 'none');
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

            // Sync radar site across all active map panes
            Object.entries(maps).forEach(([id, m]) => {
                if (m) {
                    paneRadarSites[id] = site;
                    if (!isNational) {
                        if (m.getSource('site-bref')) m.getSource('site-bref').setTiles([siteRadarUrl(site, 'sr_bref')]);
                        if (m.getSource('site-bvel')) m.getSource('site-bvel').setTiles([siteRadarUrl(site, 'sr_bvel')]);
                        if (m.getSource('site-bdhc')) m.getSource('site-bdhc').setTiles([siteRadarUrl(site, 'bdhc')]);
                    }
                }
            });

            if (isNational) {
                if (badge) { badge.textContent = 'National'; badge.className = 'badge blue'; }
                if (refBtn?.classList.contains('active')) {
                    activeRadarNational = true;
                    if (map.getLayer('site-bref-layer')) map.setLayoutProperty('site-bref-layer', 'visibility', 'none');
                    if (map.getLayer('site-bvel-layer')) map.setLayoutProperty('site-bvel-layer', 'visibility', 'none');
                    if (map.getLayer('site-bdhc-layer')) map.setLayoutProperty('site-bdhc-layer', 'visibility', 'none');
                    if (map.getLayer('radar-layer')) map.setLayoutProperty('radar-layer', 'visibility', 'visible');
                }
                addLiveLog(`RADAR [Pane ${activePaneId}]: National mosaic selected`, '#00e5ff');
            } else {
                if (badge) { badge.textContent = site; badge.className = 'badge orange'; }

                if (radarActive) {
                    activeRadarNational = false;
                    const prod = paneRadarProducts[activePaneId] || 'sr_bref';
                    if (map.getLayer('radar-layer')) map.setLayoutProperty('radar-layer', 'visibility', 'none');
                    ['site-bref-layer', 'site-bvel-layer', 'site-bdhc-layer'].forEach(l => {
                        if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', 'none');
                    });
                    if (prod === 'sr_bref' && map.getLayer('site-bref-layer')) map.setLayoutProperty('site-bref-layer', 'visibility', 'visible');
                    else if (prod === 'sr_bvel' && map.getLayer('site-bvel-layer')) map.setLayoutProperty('site-bvel-layer', 'visibility', 'visible');
                    else if (prod === 'bdhc' && map.getLayer('site-bdhc-layer')) map.setLayoutProperty('site-bdhc-layer', 'visibility', 'visible');
                }
                addLiveLog(`RADAR [Pane ${activePaneId}]: Site changed to ${site}`, '#00e5ff');
            }
            updateSidebarToActivePane();
            updateHealth('radar');
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
                'NET': 'bdhc'
            };

            const ncepProduct = productMap[product] || 'sr_bref';
            paneRadarProducts[activePaneId] = ncepProduct;

            // Toggle the appropriate site-radar layer based on product selection on active map only
            ['site-bref-layer', 'site-bvel-layer', 'site-bdhc-layer'].forEach(l => {
                if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', 'none');
            });

            if (ncepProduct === 'sr_bref') {
                activeSiteRadar = { bref: true, bvel: false, bdhc: false };
                if (map.getSource('site-bref')) map.getSource('site-bref').setTiles([siteRadarUrl(site, 'sr_bref')]);
                if (map.getLayer('site-bref-layer')) map.setLayoutProperty('site-bref-layer', 'visibility', 'visible');
            } else if (ncepProduct === 'sr_bvel') {
                activeSiteRadar = { bref: false, bvel: true, bdhc: false };
                if (map.getSource('site-bvel')) map.getSource('site-bvel').setTiles([siteRadarUrl(site, 'sr_bvel')]);
                if (map.getLayer('site-bvel-layer')) map.setLayoutProperty('site-bvel-layer', 'visibility', 'visible');
            } else if (ncepProduct === 'bdhc') {
                activeSiteRadar = { bref: false, bvel: false, bdhc: true };
                if (map.getSource('site-bdhc')) map.getSource('site-bdhc').setTiles([siteRadarUrl(site, 'bdhc')]);
                if (map.getLayer('site-bdhc-layer')) map.setLayoutProperty('site-bdhc-layer', 'visibility', 'visible');
            }
            updateSidebarToActivePane();
            updateHealth('radar');
            addLiveLog(`RADAR [Pane ${activePaneId}]: Product changed to ${product}`, '#00e5ff');
            refreshTimestampLabel();
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
                    addLiveLog(`RADAR SAMPLER: ${isDataSamplerActive ? 'ACTIVATED' : 'DEACTIVATED'}`, isDataSamplerActive ? '#00ffff' : '#ff8888');
                    const samplerBadge = document.getElementById('hud-sampler-readout');
                    if (samplerBadge) samplerBadge.style.display = isDataSamplerActive ? 'flex' : 'none';
                    break;
                case 'sync-all':
                    syncAllPanes(paneId);
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
    if (r < 12 && g < 12 && b < 12) return 'No Echo / < 5 dBZ';

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

    Object.entries(maps).forEach(([id, m]) => {
        if (id !== sourcePaneId) {
            m.jumpTo({ center, zoom, bearing, pitch });
        }
    });
    addLiveLog(`SYNC: All panes synced to Pane ${sourcePaneId}`, '#00e5ff');
}

function clearPane(map, paneId) {
    const allToggleLayers = [
        'satellite-layer', 'radar-layer',
        'site-bref-layer', 'site-bvel-layer', 'site-bdhc-layer',
        'spc-outlook-fill', 'spc-outlook-line',
        'spc-md-fill', 'spc-md-outline',
        'nws-warnings-only-fill', 'nws-warnings-only-outline',
        'nws-watches-only-fill', 'nws-watches-only-outline',
        'nws-wwa-wms-layer', 'nws-watches-wms-layer',
        'hms-smoke-fill', 'hms-smoke-outline',
        'airnow-aqi-layer', 'firms-fires-layer',
        'metars-temp', 'metars-dewp', 'metars-press', 'metars-id', 'metars-city', 'metars-barb',
        'wpc-isobars-line', 'wpc-isobars-label',
        'wpc-fronts-solid', 'wpc-fronts-stnry', 'wpc-fronts-trof', 'wpc-fronts-pips',
        'wpc-hl-letter', 'wpc-hl-pressure',
        'wpc-qpf-layer',
        'nhc-cone-fill', 'nhc-cone-outline', 'nhc-track-line', 'nhc-track-pts', 'nhc-track-labels',
        'nhc-warn-fill', 'nhc-warn-outline', 'nhc-outlook-fill', 'nhc-outlook-outline',
        'cpc-temp-layer', 'cpc-precip-layer',
        'drought-fill', 'drought-outline', 'cpc-drought-layer'
    ];
    allToggleLayers.forEach(l => {
        if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', 'none');
    });
    paneGoesChannels[paneId] = null;
    if (paneId === activePaneId) activeGoesChannel = null;
    activeQpfLayer = null;
    activeCpcTempLayer = null;
    activeCpcPrecipLayer = null;
    addLiveLog(`PANE ${paneId}: Cleared`, '#ff3333');
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 18: LAYOUT CONTROLS
// ═══════════════════════════════════════════════════════════════════════════════

function initLayoutControls() {
    document.querySelectorAll('.btn-view').forEach(btn => {
        btn.addEventListener('click', () => {
            const layout = parseInt(btn.getAttribute('data-layout'));
            document.querySelectorAll('.btn-view').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            const grid = document.getElementById('pane-grid');
            if (grid) grid.className = `pane-grid layout-${layout}`;

            const primarySite = paneRadarSites[activePaneId] || 'DGX';
            const primaryProduct = paneRadarProducts[activePaneId] || 'sr_bref';

            document.querySelectorAll('.pane').forEach((p, idx) => {
                const id = p.getAttribute('data-pane');
                if (idx < layout) {
                    p.style.display = 'block';

                    // Synchronize radar site and product across all revealed panes to match active pane
                    if (id !== activePaneId) {
                        paneRadarSites[id] = primarySite;
                        paneRadarProducts[id] = primaryProduct;
                        const m = maps[id];
                        if (m && m.getSource('site-bref')) {
                            m.getSource('site-bref').setTiles([siteRadarUrl(primarySite, 'sr_bref')]);
                            m.getSource('site-bvel').setTiles([siteRadarUrl(primarySite, 'sr_bvel')]);
                            m.getSource('site-bdhc').setTiles([siteRadarUrl(primarySite, 'bdhc')]);
                        }
                    }

                    if (!maps[id]) {
                        initMap(id);
                    } else {
                        // Ensure existing maps resize to new grid dimensions
                        setTimeout(() => maps[id].resize(), 50);
                    }
                } else {
                    p.style.display = 'none';
                }
            });

            // Global final resize pass
            setTimeout(() => {
                Object.values(maps).forEach(m => m.resize());
            }, 300);

            addLiveLog(`LAYOUT: ${layout}-pane view active`, '#888');
        });
    });
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
    }, 60 * 1000);

    // 2. High Frequency (5 minutes)
    setInterval(() => {
        if (isPlaying) return;
        
        // Radar refresh
        if (activeRadarNational) {
            const url = cacheBust(nationalRadarUrl());
            Object.values(maps).forEach(m => {
                if (m.getSource('radar')) m.getSource('radar').setTiles([url]);
            });
            updateHealth('radar');
            addLiveLog('AUTO: Radar tiles refreshed', '#444');
        }
        
        // METARs refresh
        const metarsActive = Object.values(maps).some(m => isLayerVisible(m, 'metars-temp') || isLayerVisible(m, 'metars-barb'));
        if (metarsActive) fetchMETARs();
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

        // WPC Isobars
        const isobarsActive = Object.values(maps).some(m => isLayerVisible(m, 'wpc-isobars-line'));
        if (isobarsActive) fetchWPCIsobars(true);

        // WPC Fronts
        const frontsActive = Object.values(maps).some(m => isLayerVisible(m, 'wpc-fronts-solid'));
        if (frontsActive) fetchWPCFronts(true);

        // NHC Storms
        const nhcActive = Object.values(maps).some(m => isLayerVisible(m, 'nhc-track-pts'));
        if (nhcActive) fetchNHCStorms(true);

        // NHC Outlook
        const nhcOutlookActive = Object.values(maps).some(m => isLayerVisible(m, 'nhc-outlook-fill'));
        if (nhcOutlookActive) fetchNHCOutlook(true);

        // WPC QPF tile refresh
        if (activeQpfLayer) {
            const wmsUrl = cacheBust(`https://mapservices.weather.noaa.gov/vector/rest/services/precip/wpc_qpf/MapServer/export?bbox={bbox-epsg-3857}&bboxSR=102100&layers=show:${activeQpfLayer}&size=512,512&imageSR=102100&format=png32&transparent=true&f=image`);
            Object.values(maps).forEach(m => {
                if (m.getSource('wpc-qpf')) m.getSource('wpc-qpf').setTiles([wmsUrl]);
            });
            updateHealth('wpcQpf');
        }

    }, 30 * 60 * 1000);
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 21: UTILITY HELPERS
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

    // Initialize primary map (Pane 1)
    initMap('1');

    // Start UTC clock
    startUTCClock();

    // Initialize UI controls
    initProductSidebar();
    initRadarSiteSelector();
    initPlayButton();
    initLayoutControls();
    initContextMenu();
    initHealthToggle();
    initDebugToggle();
    initSyncButton();
    initSoundingModal();
    initTextModal();

    // Start warning watchdog (check every 15 seconds for rapid convective updates)
    addLiveLog('WATCHDOG: National feed monitoring active (15s polling)', '#00ff88');
    checkNewWarnings();
    setInterval(checkNewWarnings, 15 * 1000);

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
        }
    }, 200);

    updateSidebarToActivePane();
    addLiveLog('FX-Net NextGen READY', '#00ff88');
}

// Boot on DOM ready
document.addEventListener('DOMContentLoaded', init);
