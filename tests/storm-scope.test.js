// Storm scope: which storm-specific tropical layers draw for the selected
// storm, how each surge map is filtered, and what the badges and key say.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('./_load').load([
    'NHC_TROP_SVC', 'arcExportTiles', 'NHC_INUN_TILES', 'NHC_PEAK_SURGE_TILES', 'BLANK_TILE',
    'inStormScope', 'scopedSurgeTiles', 'surgeBadgeState', 'scopeEmptyNote'
]);

test('a feature is in scope when it is the selected storm, under All, or names none', () => {
    assert.equal(M.inStormScope('al092026', 'selected', 'al092026'), true);
    assert.equal(M.inStormScope('AL092026', 'selected', 'al092026'), true);   // the swath layer is upper-case
    assert.equal(M.inStormScope('ep182026', 'selected', 'al092026'), false);
    assert.equal(M.inStormScope('ep182026', 'all', 'al092026'), true);
    assert.equal(M.inStormScope('ep182026', 'selected', null), true);
    assert.equal(M.inStormScope('', 'selected', 'al092026'), true);
});

test('peak surge filters server-side on the storm; inundation shows only for its own storm', () => {
    const peak = M.scopedSurgeTiles('peak', 'selected', 'al092026', ['al092026'], 123);
    assert.ok(peak.startsWith(M.NHC_PEAK_SURGE_TILES + '&layerDefs='));
    assert.deepEqual(JSON.parse(decodeURIComponent(peak.split('&layerDefs=')[1].split('&_v=')[0])),
        { 1: "idp_subset='al092026'", 2: "idp_subset='al092026'" });
    assert.ok(peak.endsWith('&_v=123'));
    assert.equal(M.scopedSurgeTiles('peak', 'all', 'al092026', [], 5), M.NHC_PEAK_SURGE_TILES + '&_v=5');
    assert.match(M.scopedSurgeTiles('peak', 'selected', "al09'; drop", [], 0), /idp_subset%3D'al09drop'/);   // id is sanitized
    assert.equal(M.scopedSurgeTiles('inun', 'selected', 'al092026', ['al092026'], 7), M.NHC_INUN_TILES + '&_v=7');
    assert.equal(M.scopedSurgeTiles('inun', 'selected', 'ep182026', ['al092026'], 7), M.BLANK_TILE);
    assert.equal(M.scopedSurgeTiles('inun', 'all', 'ep182026', ['al092026'], 7), M.NHC_INUN_TILES + '&_v=7');
});

test('surge badge: issued, issued for another storm, or not issued', () => {
    assert.deepEqual(M.surgeBadgeState(false, [], 'selected', 'al092026'), { text: 'NOT ISSUED', cls: 'gray', other: false });
    assert.deepEqual(M.surgeBadgeState(true, ['al092026'], 'selected', 'al092026'), { text: 'ISSUED', cls: 'red', other: false });
    assert.deepEqual(M.surgeBadgeState(true, ['al092026'], 'selected', 'ep182026'), { text: 'AL09 ONLY', cls: 'gray', other: true });
    assert.deepEqual(M.surgeBadgeState(true, ['al092026'], 'all', 'ep182026'), { text: 'ISSUED', cls: 'red', other: false });
    assert.deepEqual(M.surgeBadgeState(true, [], 'selected', 'ep182026'), { text: 'ISSUED', cls: 'red', other: false });   // names no storm
});

test('the key says so when the scope hides everything', () => {
    const feats = [{ properties: { sid: 'al092026' } }, { properties: { sid: 'ep182026' } }];
    assert.equal(M.scopeEmptyNote(feats, 'selected', 'al092026'), '');
    assert.equal(M.scopeEmptyNote(feats, 'selected', 'al912026'), 'none for AL91 · other storms hidden');
    assert.equal(M.scopeEmptyNote(feats, 'all', 'al912026'), '');
    assert.equal(M.scopeEmptyNote([], 'selected', 'al912026'), '');
});
