// Storm Trends: the recon fix decoder, the "plane on station" test that sets
// the refresh pace, and the header line for the newest fix.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('./_load').load(['esc', 'adeckDtgMs', 'parseVdm', 'reconMissionActive', 'latestReconHtml']);

// NOAA3's 16:48Z fix in Isaias, Oct 7 2026 (trimmed).
const VDM = `URNT12 KWBC 071711
VORTEX DATA MESSAGE  AL092026
A. 07/16:47:51Z
B. 22.47 deg N 093.52 deg W
C. 700 MB 3052 m
D. 997 mb
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
