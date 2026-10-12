// MOS text size: the A−/A+ control steps through a fixed ladder and clamps
// at both ends; anything unknown (bad stored value) falls back to the default.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('./_load').load(['MOS_FONT_STEPS', 'MOS_FONT_DEFAULT', 'mosFontStep']);

test('steps up and down the ladder', () => {
    assert.equal(M.mosFontStep(12, 1), 13);
    assert.equal(M.mosFontStep(14, 1), 16);
    assert.equal(M.mosFontStep(16, -1), 14);
});

test('clamps at the smallest and largest size', () => {
    assert.equal(M.mosFontStep(10, -1), 10);
    assert.equal(M.mosFontStep(24, 1), 24);
});

test('an unknown size resets to the default', () => {
    assert.equal(M.MOS_FONT_DEFAULT, 12);
    assert.equal(M.mosFontStep(15, 1), 12);
    assert.equal(M.mosFontStep(0, -1), 12);
});
