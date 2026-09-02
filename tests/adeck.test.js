// Model-guidance selection: which cycle each aid plots from, when a
// previous-run interpolation stands in, and why an empty view is empty.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('./_load').load([
    'ADECK_MODELS', 'AI_MODELS', 'isAiModel', 'parseAdeckText', 'adeckTechMeta',
    'pickAdeckCycles', 'adeckEmptyReason', 'buildAdeckFeatures', 'buildIntensitySeries', 'adeckDtgMs'
]);

// rows for one tech / cycle at the given forecast hours
const R = (tech, dtg, taus) => taus.map(t => ({ dtg, tech, tau: t, lat: 20 + t / 100, lon: -60 - t / 100, vmax: 40, mslp: 1005 }));
const cyclesOf = (rows, mode) => M.buildAdeckFeatures(rows, mode).cycles;
const techsOf = (rows, mode) => Object.keys(cyclesOf(rows, mode)).sort();

test('parseAdeckText reads the slimmed 10-field proxy format', () => {
    const rows = M.parseAdeckText('AL,04,2026083012,03,GDMI,0,172N,592W,30,0\nAL,04,2026083012,03,GDMI,6,176N,622W,39,1007\njunk line\n');
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[1], { dtg: '2026083012', tech: 'GDMI', tau: 6, lat: 17.6, lon: -62.2, vmax: 39, mslp: 1007 });
});

test('a tau-0 stub falls back to the newest cycle that holds a track', () => {
    assert.deepEqual(cyclesOf([...R('GDMI', '2026083012', [0]), ...R('GDMI', '2026082918', [0, 6, 12])], 'ai-early'),
        { GDMI: '2026082918' });
});

test('a healthy newest cycle beats an older, longer one', () => {
    assert.deepEqual(cyclesOf([...R('GDMI', '2026083012', [0, 6]), ...R('GDMI', '2026082918', [0, 6, 12, 18])], 'ai-early'),
        { GDMI: '2026083012' });
});

test('a lone point never plots', () => {
    assert.deepEqual(M.buildAdeckFeatures(R('GDMI', '2026083012', [0]), 'ai-early').models, []);
});

test('previous-run interp (?2) is suppressed when its 6-hour primary survived', () => {
    assert.deepEqual(techsOf([...R('GDMI', '2026083012', [0, 6, 12]), ...R('GDM2', '2026083012', [0, 6, 12])], 'ai-early'), ['GDMI']);
    assert.deepEqual(techsOf([...R('UKXI', '2026083012', [0, 6, 12]), ...R('UKX2', '2026083012', [0, 6, 12])], 'early'), ['UKXI']);
});

test('previous-run interp fills the gap when the primary is absent or a stub', () => {
    assert.deepEqual(techsOf(R('GDM2', '2026083012', [0, 6, 12]), 'ai-early'), ['GDM2']);
    assert.deepEqual(techsOf([...R('GDMI', '2026083012', [0]), ...R('GDM2', '2026083012', [0, 6, 12])], 'ai-early'), ['GDM2']);
});

test('GDM2 is an AI aid: on the AI tabs, off the physics tabs', () => {
    assert.equal(M.isAiModel('GDM2'), true);
    assert.ok(M.adeckTechMeta('GDM2', 'ai-early'));
    assert.equal(M.adeckTechMeta('GDM2', 'early'), null);
});

test('every ?2 fallback names a primary that exists in the table', () => {
    for (const [tech, m] of Object.entries(M.ADECK_MODELS)) {
        if (m[4]) assert.ok(M.ADECK_MODELS[m[4]], `${tech} falls back for unknown ${m[4]}`);
    }
});

test('the intensity chart gets the same fallback', () => {
    const s = M.buildIntensitySeries([...R('GDMI', '2026083012', [0]), ...R('GDMI', '2026082918', [0, 6, 12])], 'early');
    assert.deepEqual(s.map(x => `${x.tech}@${x.dtg}`), ['GDMI@2026082918']);
});

test('lag is stamped on the map label only past one cycle, against the newest cycle in the deck', () => {
    const rows = [...R('AVNI', '2026083012', [0, 6, 12]), ...R('GDMI', '2026082918', [0, 6])];
    const labels = M.buildAdeckFeatures(rows, 'ai-early').features.filter(f => f.properties.layerType === 'end').map(f => f.properties.lbl);
    assert.deepEqual(labels, ['GDMI ✦ -18h'], 'AVNI is not in this view but still sets the reference cycle');
    const six = [...R('AVNI', '2026083012', [0, 6]), ...R('CMCI', '2026083006', [0, 6])];
    const l6 = M.buildAdeckFeatures(six, 'early').features.filter(f => f.properties.layerType === 'end').map(f => f.properties.lbl).sort();
    assert.deepEqual(l6, ['AVNI', 'CMCI'], 'a routine 6 h offset is not stamped');
});

test('adeckEmptyReason distinguishes "not distributed" from "present but single-point"', () => {
    assert.match(M.adeckEmptyReason([], 'ai-early'), /are in NHC's public a-deck/);
    assert.equal(M.adeckEmptyReason(R('GDMI', '2026083012', [0]), 'ai-early'),
        'GDMI in the deck but carrying no track — single-point runs only');
});

test('adeckDtgMs parses the 10-digit cycle stamp as UTC', () => {
    assert.equal(M.adeckDtgMs('2026083012'), Date.UTC(2026, 7, 30, 12));
});
