// Forecast History (run to run): per-run colors, interpolated positions at a
// fixed valid time, the shift text, and the trend markers on the map.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('./_load').load([
    'parseAdeckText', 'adeckDtgMs', 'adeckRunLabel', 'esc', 'ssCategory',
    'FCST_RUN_RAMP', 'FCST_NEWEST_COLOR', 'FCST_TREND_TAUS', 'fcstHist', 'fcstHexLerp', 'fcstRunColor', 'fcstCycles',
    'fcstPosAt', 'fcstMiles', 'compass16', 'fcstShiftText', 'fcstShown', 'fcstTrend', 'fcstFocus', 'buildFcstHistoryFeatures',
    'fcstValidText', 'fcstHistoryLegendHtml', 'fcstPointPopupHtml'
]);

// The live Isaias (AL092026) OFCL deck, trimmed to position and wind.
const DECK = [
    ['2026100618', [[0, '221N', '958W', 30], [12, '221N', '950W', 35], [24, '226N', '934W', 45], [48, '242N', '901W', 70], [60, '259N', '888W', 80], [72, '285N', '883W', 85]]],
    ['2026100700', [[0, '220N', '954W', 30], [12, '222N', '942W', 40], [24, '225N', '927W', 50], [48, '243N', '897W', 75], [60, '261N', '887W', 85], [72, '288N', '883W', 85]]],
    ['2026100706', [[0, '218N', '945W', 35], [12, '222N', '929W', 50], [24, '227N', '914W', 65], [48, '255N', '885W', 95], [60, '277N', '877W', 90], [72, '308N', '877W', 75]]],
    ['2026100712', [[0, '220N', '939W', 35], [3, '224N', '936W', 40], [12, '227N', '924W', 50], [24, '234N', '908W', 65], [48, '266N', '881W', 95], [72, '322N', '876W', 45]]]
].flatMap(([dtg, pts]) => pts.flatMap(([tau, la, lo, v]) => [
    `AL, 09, ${dtg}, 03, OFCL, ${tau}, ${la}, ${lo}, ${v}, 1000, TS, 34`,
    `AL, 09, ${dtg}, 03, OFCL, ${tau}, ${la}, ${lo}, ${v}, 1000, TS, 50`   // wind-radii repeat
])).join('\n');
const cycles = M.fcstCycles(M.parseAdeckText(DECK + '\nAL, 09, 2026100712, 03, CARQ, 0, 220N, 939W, 35, 1000'));

test('fcstCycles: one entry per run, oldest first, radii repeats and other aids dropped', () => {
    assert.deepEqual(cycles.map(c => c.dtg), ['2026100618', '2026100700', '2026100706', '2026100712']);
    assert.deepEqual(cycles[3].pts.map(p => p.tau), [0, 3, 12, 24, 48, 72]);
    assert.equal(cycles[0].pts[3].vmax, 70);
});

test('each run gets its own color and the newest is white', () => {
    const cols = cycles.map((c, i) => M.fcstRunColor(i, cycles.length));
    assert.equal(cols[3], '#ffffff');
    assert.equal(cols[0], M.FCST_RUN_RAMP[0]);
    assert.equal(cols[2], M.FCST_RUN_RAMP[M.FCST_RUN_RAMP.length - 1]);
    assert.equal(new Set(cols).size, 4);
    assert.equal(M.fcstRunColor(0, 1), '#ffffff');
    assert.equal(M.fcstHexLerp('#000000', '#ffffff', 0.5), '#808080');
});

test('fcstPosAt interpolates between forecast hours and refuses times outside the run', () => {
    const c = cycles[1];   // 00Z: F048 24.3N 89.7W 75 kt, F060 26.1N 88.7W 85 kt
    const p = M.fcstPosAt(c, c.ms + 54 * 3600000);
    assert.ok(Math.abs(p.lat - 25.2) < 1e-9 && Math.abs(p.lon + 89.2) < 1e-9);
    assert.equal(p.vmax, 80);
    assert.equal(p.exact, false);
    assert.equal(M.fcstPosAt(c, c.ms + 48 * 3600000).exact, true);
    assert.equal(M.fcstPosAt(c, c.ms - 3600000), null);
    assert.equal(M.fcstPosAt(c, c.ms + 73 * 3600000), null);
});

test('shift text: distance rounded to 5 mi and a 16-point direction', () => {
    assert.equal(M.fcstShiftText({ lat: 25, lon: -90 }, { lat: 26, lon: -90 }), '70 mi N');
    assert.equal(M.fcstShiftText({ lat: 25, lon: -90 }, { lat: 25, lon: -91 }), '65 mi W');
    assert.equal(M.fcstShiftText({ lat: 25, lon: -90 }, { lat: 25.05, lon: -90 }), 'same spot');
});

test('trend at the newest run\'s +48 h: every run that reaches it, oldest first', () => {
    const tr = M.fcstTrend(cycles, 48);
    assert.equal(tr.validMs, Date.UTC(2026, 9, 9, 12));
    assert.deepEqual(tr.pts.map(p => [p.dtg, p.tau]), [['2026100618', 66], ['2026100700', 60], ['2026100706', 54], ['2026100712', 48]]);
    assert.deepEqual(tr.pts.map(p => p.vmax), [85, 85, 95, 95]);
    // 18Z Tue had the center near 27.2N 88.6W by then; 12Z Wed has 26.6N 88.1W.
    assert.equal(M.fcstShiftText(tr.pts[0], tr.pts[3]), '50 mi SE');
    assert.equal(M.fcstTrend(cycles, 72).pts.length, 1);   // only the newest reaches 12Z Sat
    assert.deepEqual(M.fcstTrend(cycles, 0).pts, []);
});

test('fcstShown limits to the newest N runs', () => {
    assert.equal(M.fcstShown(cycles, 0).length, 4);
    assert.deepEqual(M.fcstShown(cycles, 2).map(c => c.dtg), ['2026100706', '2026100712']);
    assert.equal(M.fcstShown(cycles, 8).length, 4);
});

test('features: labeled run tracks, focus isolates one run, trend adds markers', () => {
    const st = { cycles, bpts: [{ lat: 21, lon: -96, vmax: 30 }, { lat: 22, lon: -94, vmax: 35 }], show: 0, trendTau: 0 };
    const f = M.buildFcstHistoryFeatures(st, null);
    const lines = f.filter(x => x.properties.kind === 'fcst');
    assert.equal(lines.length, 4);
    assert.equal(lines[3].properties.op, 1);
    assert.ok(lines[0].properties.op < lines[2].properties.op);
    assert.deepEqual(f.filter(x => x.properties.kind === 'fcstlabel').map(x => x.properties.lbl), ['18Z Tue', '00Z Wed', '06Z Wed', '12Z Wed ★']);
    assert.equal(f.filter(x => x.properties.kind === 'fcstpt').length, 24);
    assert.equal(f.filter(x => x.properties.kind === 'actual').length, 1);

    const g = M.buildFcstHistoryFeatures(st, '2026100700');
    const gl = g.filter(x => x.properties.kind === 'fcst');
    assert.deepEqual(gl.map(x => x.properties.op), [0.16, 1, 0.16, 0.16]);

    const t = M.buildFcstHistoryFeatures({ ...st, trendTau: 48 }, null);
    assert.equal(t.filter(x => x.properties.kind === 'trendpt').length, 4);
    assert.equal(t.filter(x => x.properties.kind === 'trendline').length, 1);
    assert.deepEqual(t.filter(x => x.properties.kind === 'trendlabel').map(x => x.properties.lbl), ['18Z 85kt', '00Z 85kt', '06Z 95kt', '12Z 95kt']);
    assert.equal(t.find(x => x.properties.kind === 'trendpt' && x.properties.dtg === '2026100706').properties.interp, 1);
});

test('key lists runs newest first with their age, and trend rows carry wind and shift', () => {
    const head = t => `<h>${t}</h>`;
    const st = { cycles, show: 0, trendTau: 0, pinned: null, timer: null, hover: null, play: null };
    const html = M.fcstHistoryLegendHtml(st, head);
    assert.match(html, /Forecast history · 4 runs/);
    assert.ok(html.indexOf('12Z Wed 7') < html.indexOf('18Z Tue 6'));
    assert.match(html, /newest/);
    assert.match(html, /−18h/);
    assert.match(html, /data-fh="trend" data-v="48"/);
    assert.doesNotMatch(html, /data-fh="trend" data-v="120"/);   // the newest run stops at 72 h here
    const tr = M.fcstHistoryLegendHtml({ ...st, trendTau: 48 }, head);
    assert.match(tr, /Center at/);
    assert.match(tr, /95kt · \d+ mi N/);
});

test('point popup names the run, its age and where the newest run has the storm then', () => {
    const p = { dtg: '2026100700', tau: 48, vmax: 75, color: '#4f7dff' };
    const html = M.fcstPointPopupHtml(p, { cycles });
    assert.match(html, /run 00Z Wed Oct 7/);
    assert.match(html, /12 h older than the newest run/);
    assert.match(html, /F048/);
    assert.match(html, /Cat 1 hurricane/);
    assert.match(html, /Newest run \(12Z\) at this time: <b>50 mi NNE<\/b> of here · 80 kt/);
    assert.match(M.fcstPointPopupHtml({ dtg: '2026100712', tau: 0, vmax: 35, color: '#fff' }, { cycles }), /newest forecast/);
});
