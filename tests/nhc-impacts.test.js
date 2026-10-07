// NHC storm-impact layers (2026-10-06): the outlook's development arrow, the
// cycle label on wind chances, and the storm surge products, which exist only
// while surge watches/warnings are up and must re-tile when a new one lands.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./_load');

const geo = load(['nhcSynopticMs', 'nhcSynLabel', 'nhcArrowFeatures', 'NHC_WSP_BANDS', 'nhcWspColorExpr']);

test('the cycle comes from the file name NOAA gives the wind probabilities', () => {
    const ms = geo.nhcSynopticMs('2026100618_wsp34knt120hr_5km');
    assert.equal(ms, Date.UTC(2026, 9, 6, 18));
    assert.equal(geo.nhcSynLabel(ms), '18Z Oct 6');
    assert.equal(geo.nhcSynopticMs(undefined), 0);
    assert.equal(geo.nhcSynLabel(0), '');
});

test('every probability band NOAA labels gets a color, and <5% stays clear', () => {
    const expr = geo.nhcWspColorExpr();
    assert.equal(expr[0], 'match');
    assert.equal(expr.length, 3 + geo.NHC_WSP_BANDS.length * 2);
    assert.equal(expr[expr.length - 1], 'rgba(0,0,0,0)');
    assert.ok(!expr.includes('<5%'));
});

test('a development arrow is the line plus two head strokes meeting at its tip', () => {
    const line = { type: 'LineString', coordinates: [[-90, 25], [-88, 25], [-86, 26]] };
    const out = geo.nhcArrowFeatures(line);
    assert.equal(out.length, 3);
    assert.deepEqual(out[0].coordinates, line.coordinates);
    for (const head of out.slice(1)) {
        assert.deepEqual(head.coordinates[1], [-86, 26]);          // ends at the tip
        assert.ok(head.coordinates[0][0] < -86);                    // trails behind it
    }
    // The two strokes sit on opposite sides of the shaft (cross products differ in sign).
    const side = ([bx, by]) => 2 * (by - 26) - 1 * (bx + 86);
    assert.ok(side(out[1].coordinates[0]) * side(out[2].coordinates[0]) < 0);
});

test('arrows handle multi-part lines and skip anything with no direction', () => {
    const multi = { type: 'MultiLineString', coordinates: [[[-80, 15], [-82, 16]], [[-60, 12], [-62, 13]]] };
    assert.equal(geo.nhcArrowFeatures(multi).length, 6);
    assert.equal(geo.nhcArrowFeatures({ type: 'LineString', coordinates: [[-80, 15]] }).length, 0);
    assert.equal(geo.nhcArrowFeatures({ type: 'LineString', coordinates: [[-80, 15], [-80, 15]] }).length, 1);
    assert.deepEqual(geo.nhcArrowFeatures(null), []);
});

// ─── Storm surge ───
function surgeHarness(script, activeStorm = null) {
    const calls = [], tiles = [], logs = [], labels = [];
    let pendingCleared = 0;
    const badges = {};
    const fetch = async url => {
        calls.push(url);
        const body = script(url, calls.length);
        return { ok: true, json: async () => body };
    };
    const source = { setTiles: t => tiles.push(t[0]), setData: () => {} };
    const ptsSource = { setData: d => labels.push(d.features) };
    const maps = { 'p1': { getSource: id => (id === 'nhc-peak-surge-pts' ? ptsSource : source) } };
    const document = { getElementById: id => (badges[id] = badges[id] || { textContent: '', className: '', title: '' }), querySelectorAll: () => [] };
    const api = load(['NHC_BASE', 'NHC_TROP_SVC', 'arcExportTiles', 'NHC_INUN_TILES', 'NHC_PEAK_SURGE_TILES',
        'stormScope', 'nhcScoped', 'nhcSurgeStorms', 'nhcSurgeTiles', 'BLANK_TILE', 'inStormScope', 'scopedSurgeTiles', 'surgeBadgeState', 'applyStormScope',
        'nhcSurgeStamp', 'nhcLayerGeojson', 'NHC_SURGE', 'setSurgeBadge', 'refreshNhcSurge', 'setPeakSurgeLabels'], {
        fetch, maps, document, cacheBust: u => `${u}&_cb=1`, activeStorm, updateTropLegend: () => {},
        addLiveLog: (msg, color) => logs.push([msg, color]),
        updateHealth: () => {}, _productPendingClear: () => { pendingCleared++; }
    });
    return { ...api, calls, tiles, logs, labels, badges, pending: () => pendingCleared };
}
const none = { features: [] };
const issued = ingest => ({ features: [{ attributes: { name: 'al092026_inundation', binnumber: 'AT4', idp_ingestdate: ingest } }] });

test('no surge map yet: says so plainly, greys the badge, and draws nothing', async () => {
    const h = surgeHarness(() => none);
    await h.refreshNhcSurge('inun', true);
    assert.equal(h.badges['nhc-surge-inun-badge'].textContent, 'NOT ISSUED');
    assert.match(h.badges['nhc-surge-inun-badge'].className, /gray/);
    assert.equal(h.tiles.length, 0);
    assert.match(h.logs[0][0], /has not issued/);
    assert.notEqual(h.logs[0][1], '#ff3333');                  // not shown as a failure
    assert.equal(h.pending(), 1);                              // the row stops spinning
});

test('a surge map re-tiles once per new product, not on every poll', async () => {
    let ingest = 1000;
    const h = surgeHarness(() => issued(ingest));
    await h.refreshNhcSurge('inun', false);
    await h.refreshNhcSurge('inun', false);                    // same product: no re-tile
    assert.equal(h.tiles.length, 1);
    assert.match(h.tiles[0], /show:24,28/);
    assert.match(h.tiles[0], /&_v=1000$/);
    assert.equal(h.badges['nhc-surge-inun-badge'].textContent, 'ISSUED');
    ingest = 2000;                                             // next advisory
    await h.refreshNhcSurge('inun', false);
    assert.equal(h.tiles.length, 2);
    assert.match(h.tiles[1], /&_v=2000$/);
});

test('when NHC withdraws the surge map, the old one comes off the map', async () => {
    let body = issued(1000);
    const h = surgeHarness(() => body);
    await h.refreshNhcSurge('inun', false);
    body = none;
    await h.refreshNhcSurge('inun', false);
    assert.equal(h.tiles.length, 2);
    assert.doesNotMatch(h.tiles[1], /_v=/);
    assert.equal(h.nhcSurgeStamp.inun, null);
    assert.equal(h.badges['nhc-surge-inun-badge'].textContent, 'NOT ISSUED');
});

test('peak surge brings its range labels, skipping unnamed points', async () => {
    const h = surgeHarness(url => /PeakStormSurge\/MapServer\/0\//.test(url)
        ? { type: 'FeatureCollection', features: [
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-89, 30] }, properties: { name: '7-11 ft' } },
            { type: 'Feature', geometry: { type: 'Point', coordinates: [-88, 30] }, properties: { name: ' ' } }] }
        : { features: [{ attributes: { idp_source: 'al092026_peaksurge', idp_ingestdate: 5 } }] });
    await h.refreshNhcSurge('peak', true);
    assert.match(h.tiles[0], /NHC_PeakStormSurge\/MapServer\/export/);
    assert.equal(h.labels.length, 1);
    assert.deepEqual(h.labels[0].map(f => f.properties.name), ['7-11 ft']);
    assert.match(h.logs.at(-1)[0], /Peak Storm Surge graphic loaded \(al092026_peaksurge\)/);
});

test('with a storm selected, a surge map issued for another storm stays off and says whose it is', async () => {
    const h = surgeHarness(() => ({ features: [{ attributes: { name: 'ISAIAS_2026_adv04', idp_subset: 'al092026', idp_ingestdate: 9 } }] }), 'ep182026');
    await h.refreshNhcSurge('inun', true);
    assert.equal(h.tiles.at(-1), h.BLANK_TILE);
    assert.equal(h.badges['nhc-surge-inun-badge'].textContent, 'AL09 ONLY');
    assert.match(h.logs.at(-1)[0], /issued for AL09, not the selected storm/);
    const own = surgeHarness(() => ({ features: [{ attributes: { name: 'ISAIAS_2026_adv04', idp_subset: 'al092026', idp_ingestdate: 9 } }] }), 'al092026');
    await own.refreshNhcSurge('inun', false);
    assert.match(own.tiles.at(-1), /show:24,28.*&_v=9$/);
    assert.equal(own.badges['nhc-surge-inun-badge'].textContent, 'ISSUED');
});
