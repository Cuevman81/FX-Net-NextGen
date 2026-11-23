// Model Comparison ensembles: the member mean and 10th–90th percentile band
// built from Open-Meteo's ensemble response, and alignment onto the chart's
// time axis by valid time.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('./_load').load(['quantileSorted', 'ensembleStats', 'alignToTimes']);

test('quantileSorted interpolates between members', () => {
    const a = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    assert.equal(M.quantileSorted(a, 0.1), 10);
    assert.equal(M.quantileSorted(a, 0.9), 90);
    assert.equal(M.quantileSorted([1, 2], 0.5), 1.5);
    assert.equal(M.quantileSorted([], 0.5), null);
});

test('ensembleStats uses the control and every member of its own model only', () => {
    const hourly = { time: ['t0', 't1'] };
    hourly.temperature_2m_mx = [50, 60];                              // control
    for (let k = 1; k <= 10; k++) {
        hourly[`temperature_2m_member${String(k).padStart(2, '0')}_mx`] = [50 + k, 60];
    }
    hourly.temperature_2m_member01_other = [999, 999];                 // another ensemble
    hourly.dewpoint_2m_member01_mx = [-40, -40];                       // another field
    const st = M.ensembleStats(hourly, 'mx', 'temperature_2m');
    assert.equal(st.members, 11);
    assert.equal(st.mean[0], 55);                                      // 50..60
    assert.equal(st.lo[0], 51);
    assert.equal(st.hi[0], 59);
    assert.deepEqual([st.mean[1], st.lo[1], st.hi[1]], [60, 60, 60]);
});

test('an hour where under half the members report stays empty', () => {
    const hourly = { time: ['t0'], p_mx: [1] };
    for (let k = 1; k <= 3; k++) hourly[`p_member0${k}_mx`] = [null];
    const st = M.ensembleStats(hourly, 'mx', 'p');
    assert.equal(st.members, 4);
    assert.equal(st.mean[0], null);
    assert.equal(st.lo[0], null);
});

test('alignToTimes matches by valid time, not position', () => {
    assert.deepEqual(M.alignToTimes(['02', '03', '04'], [2, 3, 4], ['01', '02', '03']), [null, 2, 3]);
});
