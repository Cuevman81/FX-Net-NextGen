// Storm Trends: the recon fix decoder, the "plane on station" test that sets
// the refresh pace, and the header line for the newest fix.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('./_load').load(['esc', 'adeckDtgMs', 'parseVdm', 'reconMissionActive', 'latestReconHtml',
    'fcstMiles', 'compass16', 'stormVdms', 'reconFixMotion', 'reconHhmm', 'reconFixFeatures', 'reconFixPopupHtml', 'reconFixLegendHtml']);

// NOAA3's 16:48Z fix in Isaias, Oct 7 2026 (trimmed).
const VDM = `URNT12 KWBC 071711
VORTEX DATA MESSAGE  AL092026
A. 07/16:47:51Z
B. 22.47 deg N 093.52 deg W
C. 700 MB 3052 m
D. 997 mb
F. CLOSED
G. C20
U. NOAA3 0309A ISAIAS OB 04
MAX FL WIND 46 KT 209 / 9 NM 16:49:56Z`;

const v = M.parseVdm(VDM);
const H = 3600000;

test('parseVdm reads pressure, flight-level wind, position and aircraft', () => {
    assert.equal(v.id, 'AL092026');
    assert.equal(v.mslp, 997);
    assert.equal(v.flWind, 46);
    assert.equal(v.lat, 22.47);
    assert.equal(v.lon, -93.52);
    assert.equal(v.aircraft, 'NOAA3');
    assert.equal(new Date(v.ms).getUTCHours(), 16);
});

test('a plane is on station after a recent fix, or with nearby obs in the last 30 min', () => {
    const center = { lat: 22.5, lon: -93.5 };
    assert.equal(M.reconMissionActive([v], [], center, v.ms + 2 * H), true);
    assert.equal(M.reconMissionActive([v], [], center, v.ms + 3 * H), false);
    const near = { ms: 1000 * H, lat: 24, lon: -92 }, far = { ms: 1000 * H, lat: 30, lon: -80 };
    assert.equal(M.reconMissionActive([], [near], center, 1000 * H + 20 * 60000), true);
    assert.equal(M.reconMissionActive([], [near], center, 1000 * H + 40 * 60000), false);
    assert.equal(M.reconMissionActive([], [far], center, 1000 * H + 5 * 60000), false);
    assert.equal(M.reconMissionActive([], [near], null, 1000 * H), false);
});

test('header line compares the newest fix with the last best track', () => {
    const best = [{ dtg: '2026100712', ms: M.adeckDtgMs('2026100712'), mslp: 1002, vmax: 35 }];
    const html = M.latestReconHtml([v], best, v.ms + 25 * 60000);
    assert.match(html, /LATEST RECON/);
    assert.match(html, /16:47Z/);
    assert.match(html, /NOAA3 \(25 min ago\)/);
    assert.match(html, /<b>997 mb<\/b>.*5 mb below the 12Z best track/);
    assert.match(html, /flight-level wind 46 kt/);
    // A fix older than the latest analysis is already folded into it.
    const later = [{ dtg: '2026100718', ms: M.adeckDtgMs('2026100718'), mslp: 997 }];
    assert.equal(M.latestReconHtml([v], later, v.ms + 3 * H), '');
    assert.equal(M.latestReconHtml([], best, v.ms), '');
});

// The two earlier Isaias fixes that morning (Air Force), as raw text.
const vdmText = (day, hh, mm, lat, lon, mb, fl, ac) => `URNT12 KNHC 07${hh}${mm}
VORTEX DATA MESSAGE   AL092026
A. ${day}/${hh}:${mm}:00Z
B. ${lat} deg N 0${lon} deg W
C. 850 mb 1440 m
D. ${mb} mb
F. NA
U. ${ac} 0209A ISAIAS OB 15
MAX FL WIND ${fl} KT 044 / 19 NM 15:02:00Z`;
const PRODS = [VDM, vdmText('07', '14', '56', '22.50', '93.73', 1002, 46, 'AF304'), vdmText('07', '12', '33', '22.40', '93.97', 1004, 43, 'AF304'),
    vdmText('07', '14', '56', '22.50', '93.73', 1002, 46, 'AF304'),                        // resend of the same fix
    vdmText('01', '13', '04', '25.00', '80.00', 1000, 40, 'AF300').replace('AL092026', 'AL052026')];

test('parseVdm reads the eye report, mission and flight level', () => {
    assert.equal(v.eye, 'CLOSED · C20');
    assert.equal(v.mission, '0309A');
    assert.equal(v.level, '700 mb 3052 m');
    assert.equal(M.parseVdm(PRODS[1]).eye, '');
});

test('stormVdms keeps this storm\'s fixes, oldest first, one per fix time', () => {
    const fixes = M.stormVdms(PRODS, 'AL092026', v.ms + 30 * 60000);
    assert.deepEqual(fixes.map(f => f.mslp), [1004, 1002, 997]);
    assert.equal(M.stormVdms(PRODS, 'AL092026', v.ms + 80 * H).length, 0);   // all older than 72 h
});

test('fix motion needs 1.5 h between fixes', () => {
    const [a, b, c] = M.stormVdms(PRODS, 'AL092026', v.ms);
    assert.equal(M.reconFixMotion(a, b), 'ENE at 6 kt');     // 12:33 -> 14:56, about 15 nm
    assert.equal(M.reconFixMotion(b, c), 'E at 6 kt');
    assert.equal(M.reconFixMotion(b, { ...c, ms: b.ms + H }), null);
});

test('map features, popup and key for the fixes', () => {
    const fixes = M.stormVdms(PRODS, 'AL092026', v.ms);
    const f = M.reconFixFeatures(fixes, v.ms + 10 * 60000);
    assert.equal(f.filter(x => x.properties.kind === 'path').length, 1);
    const pts = f.filter(x => x.properties.kind === 'fix');
    assert.deepEqual(pts.map(x => x.properties.lbl), ['12:33Z 1004mb', '14:56Z 1002mb', '16:47Z 997mb']);
    assert.deepEqual(pts.map(x => x.properties.newest), [0, 0, 1]);
    const pop = M.reconFixPopupHtml(fixes, 2, v.ms + 10 * 60000);
    assert.match(pop, /16:47Z/);
    assert.match(pop, /NOAA3 0309A/);
    assert.match(pop, /997 mb/);
    assert.match(pop, /CLOSED · C20/);
    assert.match(pop, /Since the 14:56Z fix \(1\.9 h\):.*-5 mb.*moved E at 6 kt/);
    const key = M.reconFixLegendHtml(fixes, t => `<h>${t}</h>`, v.ms + 10 * 60000);
    assert.match(key, /Recon center fixes · 3/);
    assert.match(key, /newest 16:47Z · 997 mb · FL 46 kt/);
    assert.match(key, /moving E at 6 kt/);
    assert.match(M.reconFixLegendHtml([], t => t, 0), /none for this storm/);
});
