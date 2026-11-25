// Winter precip meteogram: snow ratio, FRAM ice, type sharing, unit and step
// handling for BUFKIT and ECMWF, hourly binning, and the ensemble odds.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('./_load').load(['esc', 'WINTER_MODELS', 'WINTER_SLEET_RATIO', 'WINTER_MIN_RATE', 'MM_IN', 'quantileSorted', 'kucheraRatio',
    'framRatio', 'framIce', 'winterShares', 'winterStep', 'winterFromBufkit', 'winterFromEcmwf', 'isoDurHours', 'winterFromNws',
    'WINTER_KEYS', 'winterBins', 'winterBinNws', 'winterCum', 'winterMeanCum', 'winterLast', 'winterSnow', 'winterSleet', 'winterSpan',
    'winterOdds', 'winterRunMs', 'winterUtc', 'winterView', 'winterHeadline']);
const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);
const H = 3600000, T0 = Date.UTC(2026, 10, 27, 6);

test('Kuchera: 12:1 at -2 C, +1 per degree colder, -2 per degree warmer, never negative', () => {
    assert.equal(M.kucheraRatio(271.16), 12);
    near(M.kucheraRatio(261.16), 22, 1e-9);
    near(M.kucheraRatio(273.16), 8, 1e-9);
    assert.equal(M.kucheraRatio(290), 0);
    assert.equal(M.kucheraRatio(null), null);
});

test('FRAM ratio: published equations, each weighting branch, and both limits', () => {
    // Eq. 7 (Tw <= -0.35, V <= 12): hand calc at 0.05 in/h, -2.5 C, 8 kt.
    const ip = 0.1395 * Math.pow(0.05, -0.541), it = 0.9916875 + 0.0000, iv = 0.0014 * 64 + 0.0027 * 8 + 0.7574;
    near(-0.0071 * -15.625 - 0.1039 * 6.25 - 0.3904 * -2.5 + 0.5545, 0.992, 0.001);   // Fig. 15c reads ~1.0
    near(0.0014 * 676 + 0.0027 * 26 + 0.7574, 1.77, 0.01);                             // Fig. 15b reads ~1.77
    near(M.framRatio(0.05, -2.5, 8), 0.79 * ip + 0.20 * it + 0.01 * iv, 1e-3);
    // Eq. 6: same but 20 kt leans on the wind term.
    near(M.framRatio(0.05, -2.5, 20), 0.73 * ip + 0.01 * it + 0.26 * (0.0014 * 400 + 0.054 + 0.7574), 1e-3);
    // Eq. 5: warmer than -0.35 C.
    near(M.framRatio(0.05, 0, 8), 0.70 * ip + 0.29 * 0.5545 + 0.01 * iv, 1e-6);
    assert.equal(M.framRatio(0.05, -12, 8), M.framRatio(0.05, -7, 8));
    assert.equal(M.framRatio(0.002, -2, 8), M.framRatio(0.02, -2, 8));
    assert.equal(M.framRatio(0.25, 8, 8), 0);
});

test('FRAM ice uses the hourly rate, so 3 h of light rain matches three 1 h steps', () => {
    near(M.framIce(6, 3, -2, 8), 3 * M.framIce(2, 1, -2, 8), 1e-12);
    assert.equal(M.framIce(0, 1, -2, 8), 0);
    assert.equal(M.framIce(2, 1, null, 8), 0);
});

test('type flags: shared equally, and wet with no flag is rain', () => {
    assert.deepEqual({ ...M.winterShares({ WXTS: 1, WXTP: 0, WXTZ: 1, WXTR: 0 }) }, { snow: 0.5, sleet: 0, zr: 0.5, rain: 0 });
    assert.deepEqual({ ...M.winterShares({ WXTS: 0, WXTP: 0, WXTZ: 0, WXTR: 0 }) }, { snow: 0, sleet: 0, zr: 0, rain: 1 });
});

const prof = (fh, p, flag, t2, levels) => ({ forecast_hour: fh, time: new Date(T0 + fh * H).toISOString(),
    parameters: { P01M: p, T2MS: t2, UWND: 3, VWND: 4, WXTS: 0, WXTP: 0, WXTZ: 0, WXTR: 0, ...(flag ? { [flag]: 1 } : {}) },
    levels: levels || [{ PRES: 1000, TMPC: t2, TMWC: t2 - 1 }, { PRES: 850, TMPC: -4, TMWC: -4 }, { PRES: 300, TMPC: 20, TMWC: 20 }] });

test('BUFKIT: analysis hour and missing precip skipped, 3 h amounts kept as given, Tmax below 500 mb only', () => {
    const w = M.winterFromBufkit({ lat: 1, lon: 2, source: { station: 'KCAR', run_time: new Date(T0).toISOString() },
        profiles: [prof(0, 9, 'WXTS', -3), prof(1, 2.54, 'WXTS', -3), prof(2, null, 'WXTS', -3), prof(5, 5.08, 'WXTP', -3)] });
    assert.equal(w.station, 'KCAR');
    assert.deepEqual(w.steps.map(s => [s.hrs, s.liq]), [[1, 2.54], [3, 5.08]]);
    near(w.steps[0].kuch, 0.1 * (12 + (271.16 - 270.15)), 1e-9);   // warmest is the 2 m -3 C, not the 300 mb level
    assert.equal(w.steps[0].ice, 0);
    near(w.steps[1].sleet, 5.08, 1e-12);
});

test('hourly bins: multi-hour amounts spread, uncovered hours stay null, temperature interpolates', () => {
    const steps = [M.winterStep(T0 + H, 1, 2.54, { snow: 1, sleet: 0, zr: 0, rain: 0 }, 10, 0, 0, 5),
        M.winterStep(T0 + 4 * H, 3, 7.62, { snow: 0, sleet: 1, zr: 0, rain: 0 }, 10, -3, -3, 5)];
    const b = M.winterBins(steps, T0, 6);
    b.liq.slice(0, 4).forEach(x => near(x, 2.54, 1e-9));
    assert.deepEqual(b.liq.slice(4), [null, null]);
    assert.deepEqual(b.t2.slice(0, 4), [0, -1, -2, -3]);
    const snow = M.winterCum(M.winterSnow(b, 'kuchera'));
    near(snow[3], 1, 1e-9);
    assert.equal(snow[5], null);
    near(M.winterLast(M.winterCum(M.winterSleet(b))), 0.6, 1e-9);   // 0.3" liquid at 2:1
    near(M.winterLast(M.winterCum(M.winterSnow(b, '15'))), 1.5, 1e-9);
    assert.deepEqual({ ...M.winterSpan(b) }, { first: 0, last: 3 });
});

test('the model average never drops when a short run ends', () => {
    const m = M.winterMeanCum([[4, 0, null, null], [0, 2, 2, 2]]);
    assert.deepEqual(m, [2, 3, 5, 7]);
});

test('ECMWF: snow from its own SWE, ice codes rejected when too warm, 6 h codes held after F144', () => {
    const base = { wind_speed_10m: [5, 5, 5, 5], temperature_925hPa: [0, 0, 0, 0] };
    const h = { ...base, time: ['2026-11-27T06:00', '2026-11-27T09:00', '2026-11-27T12:00', '2026-11-27T15:00'],
        precipitation: [0, 3, 3, 3], snowfall_water_equivalent: [0, 2, 0, 0], precipitation_type: [0, 7, 3, 3],
        wet_bulb_temperature_2m: [0, 0, 4, -1], temperature_2m: [0, 0, 5, -1] };
    const w = M.winterFromEcmwf(h, T0);
    near(w.steps[0].snow, 2, 1e-9);
    near(w.steps[0].rain, 1, 1e-9);
    assert.equal(w.steps[1].zr, 0);           // "freezing rain" with a 4 C wet bulb is rain
    near(w.steps[2].zr, 3, 1e-9);
    assert.ok(w.steps[2].ice > 0);
    const late = M.winterFromEcmwf({ ...h, time: ['2026-11-27T06:00', '2026-11-27T09:00', '2026-11-27T12:00', '2026-11-27T15:00'],
        precipitation_type: [0, 4, 3, 1], wet_bulb_temperature_2m: [-1, -1, -1, -1], snowfall_water_equivalent: [0, 0, 0, 0] }, T0 - 200 * H);
    near(late.steps[0].zr, 3, 1e-9);          // 09Z takes 12Z's code, not the interpolated 4
});

test('NWS grid: ISO intervals and mm accumulations', () => {
    assert.equal(M.isoDurHours('PT6H'), 6);
    assert.equal(M.isoDurHours('P1DT2H'), 26);
    assert.equal(M.isoDurHours('P2D'), 48);
    const w = M.winterFromNws({ updateTime: '2026-11-27T05:00:00+00:00', snowfallAmount: { values: [{ validTime: '2026-11-27T06:00:00+00:00/PT6H', value: 25.4 }] } });
    const c = M.winterCum(M.winterBinNws(w.snow, T0, 8, M.MM_IN));
    near(c[5], 1, 1e-9);
    assert.equal(c[6], null);
    assert.equal(w.ice.length, 0);
});

test('ensemble odds count members over the window only, at 10:1', () => {
    const h = { time: ['2026-11-27T06:00', '2026-11-27T07:00', '2026-11-27T20:00'],
        snowfall_water_equivalent_mx: [99, 0, 99], snowfall_water_equivalent_member01_mx: [0, 2.54, 0],
        snowfall_water_equivalent_member02_mx: [0, 7.62, 0], snowfall_water_equivalent_member01_zz: [0, 99, 0] };
    const o = M.winterOdds(h, 'mx', T0, 12, [1, 3, 6]);
    assert.equal(o.members, 3);
    near(o.odds[0], 2 / 3, 1e-9);
    near(o.odds[1], 1 / 3, 1e-9);
    assert.equal(o.odds[2], 0);
    near(o.med, 1, 1e-9);
    assert.equal(M.winterOdds({ time: [] }, 'mx', T0, 12, [1]), null);
});

test('run picker lands on each model\'s long-run cycle', () => {
    const at = Date.UTC(2026, 10, 25, 15, 50), g = id => M.WINTER_MODELS.find(m => m.id === id);
    assert.equal(new Date(M.winterRunMs(g('HRRR'), at, 0)).getUTCHours(), 12);
    assert.equal(new Date(M.winterRunMs(g('RAP'), at, 0)).getUTCHours(), 9);    // 15Z is under an hour old
    assert.equal(new Date(M.winterRunMs(g('RAP'), at, 1)).getUTCHours(), 3);
    assert.equal(new Date(M.winterRunMs(g('GFS'), at, 0)).getUTCHours(), 6);
    assert.equal(new Date(M.winterRunMs(g('RAP'), Date.UTC(2026, 10, 25, 1), 0)).toISOString(), '2026-11-24T21:00:00.000Z');
});

test('headline: agreement, range from zero when a wet model lacks a type, dry wording, all hidden', () => {
    const sh = k => ({ snow: 0, sleet: 0, zr: 0, rain: 0, [k]: 1 });
    const run = (k, n) => ({ run: T0, steps: Array.from({ length: n }, (_, i) => M.winterStep(T0 + (i + 1) * H, 1, 2.54, sh(k), 10, -2, -2, 5)) });
    const none = new Set();
    const v = M.winterView({ models: { GFS: run('snow', 12), RRFS: run('sleet', 12), HRRR: run('rain', 12) } }, T0, 12, 'kuchera', none);
    const txt = M.winterHeadline(v);
    assert.match(txt, /^2 of 3 models bring wintry precip, starting Fri 06Z: /);
    assert.match(txt, /0–12\.0" snow/);
    assert.match(txt, /0–2\.40" sleet/);
    assert.doesNotMatch(txt, /ice/);
    assert.match(M.winterHeadline(M.winterView({ models: { GFS: run('rain', 12) } }, T0, 12, 'kuchera', none)), /^No snow, sleet or freezing rain/);
    assert.match(M.winterHeadline(M.winterView({ models: { GFS: run('snow', 12) } }, T0, 12, 'kuchera', new Set(['GFS']))), /hidden/);
});
