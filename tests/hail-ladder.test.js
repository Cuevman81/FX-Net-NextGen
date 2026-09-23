// FX-Net's severe-hail ladder (SCIT cells): NWS severe hail is 1.00" or larger
// (SCN 09-52, in effect 2010-01-05) and SPC significant severe hail is 2.00" or
// larger. The popup reads hailTier() and the map reads hailStepExpr(), so both
// are checked, and checked against each other.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HAIL_SEVERE_IN, HAIL_SIG_SEVERE_IN, HAIL_LADDER, hailTier, hailStepExpr } =
    require('./_load').load(['HAIL_SEVERE_IN', 'HAIL_SIG_SEVERE_IN', 'HAIL_LADDER', 'hailTier', 'hailStepExpr']);

// MapLibre `step`: the base output below the first stop, else the output of
// the last stop at or below the input.
function evalStep(expr, value) {
    assert.equal(expr[0], 'step');
    let out = expr[2];
    for (let i = 3; i < expr.length; i += 2) if (value >= expr[i]) out = expr[i + 1];
    return out;
}

const CASES = [
    // size, class, ring colour
    [0.75, 'sub-severe',         '#6ec6ff'],
    [0.99, 'sub-severe',         '#6ec6ff'],
    [1.00, 'severe',             '#ffe14d'],
    [1.99, 'severe',             '#ff3b3b'],
    [2.00, 'significant severe', '#ff2bd0'],
    [2.50, 'significant severe', '#ff2bd0']
];

test('severe starts at 1.00" (NWS) and significant severe at 2.00" (SPC)', () => {
    assert.equal(HAIL_SEVERE_IN, 1.0);
    assert.equal(HAIL_SIG_SEVERE_IN, 2.0);
    assert.equal(HAIL_LADDER.find(t => t.cls === 'severe').min, 1.0);
    assert.equal(HAIL_LADDER.find(t => t.cls === 'significant severe').min, 2.0);
});

test('the popup class and colour at the boundary sizes', () => {
    for (const [size, cls, line] of CASES) {
        assert.equal(hailTier(size).cls, cls, `${size}" class`);
        assert.equal(hailTier(size).line, line, `${size}" colour`);
    }
});

test('the map fill and ring put each boundary size in the same tier as the popup', () => {
    const fill = hailStepExpr('fill'), line = hailStepExpr('line');
    assert.deepEqual(fill.slice(0, 2), ['step', ['get', 'max_size']]);
    for (const [size, , ring] of CASES) {
        assert.equal(evalStep(line, size), ring, `${size}" ring`);
        assert.equal(evalStep(fill, size), hailTier(size).fill, `${size}" fill`);
    }
    // ...and every other size SCIT can report, in hundredths up to 4"
    for (let c = 0; c <= 400; c++) {
        const s = c / 100;
        assert.equal(evalStep(line, s), hailTier(s).line, `${s}"`);
    }
});

test('the ladder ascends from 0, and missing or junk sizes are sub-severe', () => {
    assert.equal(HAIL_LADDER[0].min, 0);
    HAIL_LADDER.slice(1).forEach((t, i) => assert.ok(t.min > HAIL_LADDER[i].min, `tier ${i + 1}`));
    for (const junk of [0, null, undefined, '', 'NONE', NaN]) {
        assert.equal(hailTier(junk).cls, 'sub-severe', JSON.stringify(junk));
    }
});
