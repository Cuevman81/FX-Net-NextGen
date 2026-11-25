// GFS must be the global model. Open-Meteo's gfs_seamless is HRRR for the first
// ~58 h over the lower 48, which drew HRRR twice and hid the HRRR/GFS difference.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('./_load').load(['MODEL_SOURCES', 'SOUNDING_MODELS']);

test('GFS is gfs_global in Model Comparison and the forecast sounding', () => {
    assert.equal(M.MODEL_SOURCES.find(m => m.label === 'GFS').id, 'gfs_global');
    assert.ok(!M.MODEL_SOURCES.some(m => m.id === 'gfs_seamless'));
    assert.ok('gfs_global' in M.SOUNDING_MODELS && !('gfs_seamless' in M.SOUNDING_MODELS));
});

test('every sounding source in the menu exists', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const sel = html.slice(html.indexOf('id="skewt-source"'));
    const ids = [...sel.slice(0, sel.indexOf('</select>')).matchAll(/value="(gfs_[a-z]+)"/g)].map(m => m[1]);
    assert.ok(ids.length >= 2);
    ids.forEach(id => assert.ok(id in M.SOUNDING_MODELS, id));
});
