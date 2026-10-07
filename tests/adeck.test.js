// Model-guidance selection: which cycle each aid plots from, when a
// previous-run interpolation stands in, and why an empty view is empty.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('./_load').load([
    'ADECK_MODELS', 'AI_MODELS', 'isAiModel', 'parseAdeckText', 'adeckTechMeta',
    'pickAdeckCycles', 'adeckEmptyReason', 'buildAdeckFeatures', 'buildIntensitySeries', 'adeckDtgMs',
    'adeckRunLabel', 'adeckRunGroups', 'adeckRunStatus', 'intensityHitTest', 'ssCategory', 'intensityTooltipHtml', 'esc', 'ECMWF_TRACK_MODEL', 'ECMWF_ENS', 'compactTechList'
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

test('every label names its run; the lag is stamped only past one cycle, against the newest cycle in the deck', () => {
    const rows = [...R('AVNI', '2026083012', [0, 6, 12]), ...R('GDMI', '2026082918', [0, 6])];
    const labels = M.buildAdeckFeatures(rows, 'ai-early').features.filter(f => f.properties.layerType === 'end').map(f => f.properties.lbl);
    assert.deepEqual(labels, ['GDMI ✦ 18Z −18h'], 'AVNI is not in this view but still sets the reference cycle');
    const six = [...R('AVNI', '2026083012', [0, 6]), ...R('CMCI', '2026083006', [0, 6])];
    const l6 = M.buildAdeckFeatures(six, 'early').features.filter(f => f.properties.layerType === 'end').map(f => f.properties.lbl).sort();
    assert.deepEqual(l6, ['AVNI 12Z', 'CMCI 06Z'], 'a routine 6 h offset names the run but is not stamped');
});

test('tracks and points carry their run and its lag, so a click can say which run it is', () => {
    const rows = [...R('AVNI', '2026083012', [0, 6, 12]), ...R('CMCI', '2026083006', [0, 6])];
    const { features, newestCycle } = M.buildAdeckFeatures(rows, 'early');
    assert.equal(newestCycle, '2026083012');
    const line = t => features.find(f => f.properties.layerType === 'line' && f.properties.tech === t).properties;
    assert.equal(line('AVNI').cycle, '2026083012');
    assert.equal(line('AVNI').lagH, 0);
    assert.equal(line('CMCI').lagH, 6);
    assert.equal(line('AVNI').maxTau, 12);
    assert.ok(features.filter(f => f.properties.layerType === 'pt' && f.properties.tech === 'CMCI').every(f => f.properties.lagH === 6));
});

test('run labels and the per-run breakdown read newest first', () => {
    assert.equal(M.adeckRunLabel('2026100712'), '12Z Wed Oct 7');
    assert.equal(M.adeckRunLabel(''), '');
    const g = M.adeckRunGroups(['HWRF', 'AVNO', 'AVNI', 'HWFI'], { HWRF: '2026100706', AVNO: '2026100706', AVNI: '2026100712', HWFI: '2026100712' });
    assert.deepEqual(g, [{ dtg: '2026100712', techs: ['AVNI', 'HWFI'] }, { dtg: '2026100706', techs: ['AVNO', 'HWRF'] }]);
});

test('a late-cycle aid one run behind is called normal; anything older is flagged', () => {
    assert.match(M.adeckRunStatus(0, 'early'), /newest run/);
    assert.match(M.adeckRunStatus(6, 'late'), /normal for a late-cycle model/);
    assert.match(M.adeckRunStatus(6, 'eps'), /normal for a late-cycle model/);
    assert.match(M.adeckRunStatus(6, 'early'), /no track in the newer runs/);
    assert.match(M.adeckRunStatus(18, 'late'), /18 h behind.*no track in the newer runs/);
    assert.match(M.adeckRunStatus(6, 'late', 'OFCL'), /official forecast from the latest full advisory/);
});

test('adeckEmptyReason distinguishes "not distributed" from "present but single-point"', () => {
    assert.match(M.adeckEmptyReason([], 'ai-early'), /are in NHC's public a-deck/);
    assert.equal(M.adeckEmptyReason(R('GDMI', '2026083012', [0]), 'ai-early'),
        'GDMI in the deck but carrying no track — single-point runs only');
});

test('adeckDtgMs parses the 10-digit cycle stamp as UTC', () => {
    assert.equal(M.adeckDtgMs('2026083012'), Date.UTC(2026, 7, 30, 12));
});

// ─── Intensity chart hover / click ───
const HIT = {
    legX: 520, keyRows: [{ tech: 'HWRF', y0: 13, y1: 27 }, { tech: 'SHIP', y0: 28, y1: 42 }],
    series: [
        { tech: 'HWRF', pts: [{ tau: 0, v: 35 }, { tau: 24, v: 70 }, { tau: 48, v: 95 }] },
        { tech: 'SHIP', pts: [{ tau: 0, v: 35 }, { tau: 24, v: 55 }] }
    ],
    pts: [
        { tech: 'HWRF', tau: 0, v: 35, x: 42, y: 300 }, { tech: 'HWRF', tau: 24, v: 70, x: 142, y: 200 }, { tech: 'HWRF', tau: 48, v: 95, x: 242, y: 120 },
        { tech: 'SHIP', tau: 0, v: 35, x: 42, y: 300 }, { tech: 'SHIP', tau: 24, v: 55, x: 142, y: 250 }
    ]
};

test('the intensity chart finds the point, then the line, then the key row under the pointer', () => {
    assert.deepEqual(M.intensityHitTest(HIT, 145, 203), { tech: 'HWRF', tau: 24, v: 70 });
    // halfway along HWRF's 24→48 h segment, nearer the 48 h end
    assert.equal(M.intensityHitTest(HIT, 205, 150).tech, 'HWRF');
    assert.equal(M.intensityHitTest(HIT, 205, 150).tau, 48);
    assert.deepEqual(M.intensityHitTest(HIT, 530, 35), { tech: 'SHIP', tau: 24, v: 55, fromKey: true });
    assert.equal(M.intensityHitTest(HIT, 400, 20), null);
    assert.equal(M.intensityHitTest(null, 1, 1), null);
});

test('the intensity readout names the run, its status and the valid time', () => {
    const s = { tech: 'HWRF', name: 'HWRF', color: '#f00', dtg: '2026100706', pts: [{ tau: 0, v: 35 }, { tau: 48, v: 95 }, { tau: 72, v: 90 }] };
    const html = M.intensityTooltipHtml(s, { tech: 'HWRF', tau: 48, v: 95 }, 'late', '2026100712');
    assert.match(html, /Run <b>06Z Wed Oct 7<\/b>/);
    assert.match(html, /6 h behind the newest run · normal for a late-cycle model/);
    assert.match(html, /F048 · valid Fri 06Z/);
    assert.match(html, /Max wind 95 kt \(109 mph\) · Cat 2/);
    assert.match(html, /Peak 95 kt \(Cat 2\) at F048/);
    assert.equal(M.ssCategory(64), 'Cat 1');
    assert.equal(M.ssCategory(30), 'TD');
});

// ─── ECMWF tracks (AIFS, AIFS ENS, ECMWF ENS) ───
test('AIFS is an AI aid in the late-cycle AI view only', () => {
    assert.ok(M.isAiModel('AIFS'));
    assert.ok(M.isAiModel('AF17') && M.isAiModel('AFMN'));
    assert.ok(!M.isAiModel('XE17'));
    assert.ok(M.adeckTechMeta('AIFS', 'ai-late'));
    assert.equal(M.adeckTechMeta('AIFS', 'late'), null);
    assert.equal(M.adeckTechMeta('AIFS', 'ai-early'), null);
});

test('the ECMWF ensemble views draw their own members, control, mean and OFCL — nothing else', () => {
    assert.equal(M.adeckTechMeta('AF07', 'aifs-ens').label, false);
    assert.match(M.adeckTechMeta('AF00', 'aifs-ens').name, /Control/);
    assert.match(M.adeckTechMeta('AFMN', 'aifs-ens').name, /Mean/);
    assert.equal(M.adeckTechMeta('XE07', 'aifs-ens'), null);
    assert.ok(M.adeckTechMeta('XE07', 'ecmwf-ens'));
    assert.ok(M.adeckTechMeta('OFCL', 'ecmwf-ens'));
    assert.equal(M.adeckTechMeta('AVNO', 'ecmwf-ens'), null);
    assert.equal(M.ECMWF_TRACK_MODEL['ai-late'], 'aifs');
    assert.equal(M.ECMWF_TRACK_MODEL.early, undefined);
});

test('ECMWF ensemble rows become one spaghetti line per member', () => {
    const rows = [...R('AF01', '2026100700', [0, 6, 12]), ...R('AF02', '2026100700', [0, 6]), ...R('AFMN', '2026100700', [0, 6, 12]), ...R('AVNI', '2026100712', [0, 6])];
    const { models } = M.buildAdeckFeatures(rows, 'aifs-ens');
    assert.deepEqual(models.sort(), ['AF01', 'AF02', 'AFMN']);
});

test('member lists collapse to a range in the run summary', () => {
    const many = Array.from({ length: 51 }, (_, i) => `AF${String(i).padStart(2, '0')}`);
    assert.equal(M.compactTechList(['AFMN', ...many]), 'AFMN, AF00–AF50 (51 members)');
    assert.equal(M.compactTechList(['AVNO', 'HWRF']), 'AVNO, HWRF');
    assert.equal(M.compactTechList(['AP01', 'AP02']), 'AP01, AP02');
});

test('ECMWF tracks up to two runs behind are called ECMWF\'s latest, not stale', () => {
    assert.match(M.adeckRunStatus(12, 'aifs-ens', 'AF03'), /ECMWF's latest/);
    assert.match(M.adeckRunStatus(6, 'ai-late', 'AIFS'), /ECMWF's latest/);
    assert.match(M.adeckRunStatus(18, 'ecmwf-ens', 'XEMN'), /no track in the newer runs/);
});
