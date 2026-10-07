// Tide gauges and sea-surface temperature (2026-10-07). The dashboard files
// stamp each gauge in its own local clock, a gauge without a reading carries
// a prediction time, and the SST readout maps a tile pixel back through
// NASA's colormap — each of those is easy to get subtly wrong.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./_load');

const T = load(['usDstActive', 'stationLocalToUtc', '_num', 'tideFloodCategory', 'buildTideFeatures', 'tideStations'], {});
const O = load(['parseGibsRange', 'oceanLegendFrom', 'oceanTilePixel', 'cToF', 'oceanValueText'], {});

test('US daylight time switches on the right Sundays', () => {
    assert.equal(T.usDstActive(Date.UTC(2026, 9, 7, 12)), true);      // early October
    assert.equal(T.usDstActive(Date.UTC(2026, 0, 15, 12)), false);     // January
    assert.equal(T.usDstActive(Date.UTC(2026, 2, 7, 12)), false);      // day before 2nd Sunday (Mar 8)
    assert.equal(T.usDstActive(Date.UTC(2026, 2, 9, 12)), true);
    assert.equal(T.usDstActive(Date.UTC(2026, 10, 1, 12)), false);     // 1st Sunday of Nov, after 2 am
});

test('a gauge\'s local clock converts to UTC, daylight time included', () => {
    // Bay Waveland, CST (-6) observing DST: 07:48 CDT = 12:48Z
    assert.equal(T.stationLocalToUtc('2026-10-07 07:48', -6, true), Date.UTC(2026, 9, 7, 12, 48));
    // Honolulu, no DST: 02:48 HST = 12:48Z
    assert.equal(T.stationLocalToUtc('2026-10-07 02:48', -10, false), Date.UTC(2026, 9, 7, 12, 48));
    // Same CST gauge in January is on standard time
    assert.equal(T.stationLocalToUtc('2026-01-07 06:48', -6, true), Date.UTC(2026, 0, 7, 12, 48));
    assert.equal(T.stationLocalToUtc('n/a', -6, true), 0);
    assert.equal(T.stationLocalToUtc('2026-10-07 07:48', undefined, true), 0);
});

test('flood category: NWS thresholds, with NOS minor filling in', () => {
    const nws = { minor: 1.46, moderate: 2.46, major: 6.96 };
    assert.equal(T.tideFloodCategory(1.25, nws), 0);
    assert.equal(T.tideFloodCategory(1.46, nws), 1);
    assert.equal(T.tideFloodCategory(3.0, nws), 2);
    assert.equal(T.tideFloodCategory(7.2, nws), 3);
    assert.equal(T.tideFloodCategory(2.2, { minor: 1.68, moderate: null, major: null }), 1);
    assert.equal(T.tideFloodCategory(null, nws), 0);
});

const NOW = Date.UTC(2026, 9, 7, 13, 5);
const meta = new Map([
    ['8747437', { lat: 30.3263, lng: -89.3258, tzcorr: -6, observedst: true, state: 'MS' }],
    ['8651370', { lat: 36.18, lng: -75.75, tzcorr: -5, observedst: true, state: 'NC' }],
    ['8760922', { lat: 28.93, lng: -89.41, tzcorr: -6, observedst: true, state: 'LA' }],
    ['9063020', { lat: 42.88, lng: -78.89, tzcorr: -5, observedst: true, state: 'NY' }]
]);
const latest = { stations: [
    { id: '8747437', name: 'Bay Waveland Yacht Club', tidal: true, greatLakes: false, latest_obs: '1.25', latest_pred: '-0.014', last_date_time_stamp: '2026-10-07 07:54', max_72hrs: '1.299' },
    { id: '8651370', name: 'Duck', tidal: true, greatLakes: false, latest_obs: 'n/a', latest_pred: '-2.636', last_date_time_stamp: '2026-10-07 10:00' },
    { id: '8760922', name: 'Pilots Station East, S.W. Pass', tidal: true, greatLakes: false, latest_obs: '2.136', latest_pred: '0.165', last_date_time_stamp: '2026-10-07 07:42' },
    { id: '9063020', name: 'Buffalo', tidal: false, greatLakes: true, latest_obs: '1.0', latest_pred: '', last_date_time_stamp: '2026-10-07 08:54' },
    { id: '0000000', name: 'Unknown gauge', tidal: true, latest_obs: '0.1', latest_pred: '0.0', last_date_time_stamp: '2026-10-07 07:54' }
] };
const flood = {
    '8747437': { minor_MHHW: '1.46', moderate_MHHW: '2.46', major_MHHW: '6.96', nos_minor_MHHW: '1.71', peak_today: { date: '2026-10-07 11:36', value: 0.729, type: 'ofs' } },
    '8760922': { minor_MHHW: null, moderate_MHHW: null, major_MHHW: null, nos_minor_MHHW: '1.68' }
};

test('gauges join metadata, anomaly and flood status; Great Lakes and unknown gauges drop out', () => {
    const feats = T.buildTideFeatures(meta, latest, flood, NOW);
    assert.deepEqual(feats.map(f => f.properties.id).sort(), ['8651370', '8747437', '8760922']);
    const bw = feats.find(f => f.properties.id === '8747437').properties;
    assert.equal(bw.anom, 1.26);
    assert.equal(bw.label, '+1.3');
    assert.equal(bw.cat, 0);
    assert.equal(T.tideStations['8747437'].thr.src, 'NWS');
    assert.equal(T.tideStations['8747437'].peakToday.model, true);
    assert.equal(T.tideStations['8747437'].peakToday.ms, Date.UTC(2026, 9, 7, 16, 36));
    const sw = feats.find(f => f.properties.id === '8760922').properties;
    assert.equal(sw.cat, 1);                                   // over NOS minor 1.68
    assert.equal(T.tideStations['8760922'].thr.src, 'NOS');
});

test('a gauge with no reading is offline, not "fresh" at its prediction time', () => {
    const feats = T.buildTideFeatures(meta, latest, flood, NOW);
    const duck = feats.find(f => f.properties.id === '8651370').properties;
    assert.equal(duck.stale, 1);
    assert.equal(duck.anom, -999);
    assert.equal(duck.label, '');
    assert.equal(T.tideStations['8651370'].obsMs, 0);
});

test('an old reading goes grey', () => {
    const old = { stations: [{ ...latest.stations[0], last_date_time_stamp: '2026-10-07 05:30' }] };
    const [f] = T.buildTideFeatures(meta, old, flood, NOW);
    assert.equal(f.properties.stale, 1);
    assert.equal(f.properties.cat, 0);
});

test('GIBS colormap ranges parse, open ends included', () => {
    assert.deepEqual(O.parseGibsRange('[26.40,26.55)'), [26.4, 26.55]);
    assert.deepEqual(O.parseGibsRange('[-INF,0.00)'), [-Infinity, 0]);
    assert.deepEqual(O.parseGibsRange('[3.0,+INF)'), [3, Infinity]);
    assert.equal(O.parseGibsRange('nodata'), null);
});

test('the SST legend spans the finite classes and places stops by value', () => {
    const cmap = new Map([['43,0,26', [-Infinity, 0]], ['0,0,255', [0, 16]], ['255,0,0', [16, 32]], ['9,9,9', [32, Infinity]]]);
    const lg = O.oceanLegendFrom(cmap);
    assert.equal(lg.lo, 0);
    assert.equal(lg.hi, 32);
    assert.match(lg.css, /rgb\(0,0,255\) 0\.0%/);
    assert.match(lg.css, /rgb\(255,0,0\) 50\.0%/);
});

test('the cursor lands on the right zoom-7 tile and pixel', () => {
    const p = O.oceanTilePixel(-88.5, 26.5);
    assert.deepEqual([p.tx, p.ty], [32, 54]);
    assert.ok(p.px >= 0 && p.px < 256 && p.py >= 0 && p.py < 256);
    assert.equal(O.oceanTilePixel(180, 0).tx, 0);              // wraps the antimeridian
});

test('readout text: SST in °C and °F, anomalies as signed differences', () => {
    assert.equal(O.oceanValueText('sst', [29.25, 29.4]), '29.3°C / 85°F');
    assert.equal(O.oceanValueText('sst', null), 'land / no data');
    assert.equal(O.oceanValueText('anom', [0.5, 0.6]), '+0.6°C (+1.0°F)');
    assert.equal(O.oceanValueText('anom', [-1.1, -1.0]), '−1.1°C (−1.9°F)');
    assert.equal(O.oceanValueText('anom', [3, Infinity]), 'above +3.0°C (+5.4°F)');
});
