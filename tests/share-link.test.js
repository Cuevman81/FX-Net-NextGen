// Shareable display link: the procedure bundle round-trips through the URL
// fragment unchanged, the encoding is URL-safe, and anything that is not a
// v2 bundle is rejected rather than applied.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./_load');

const { encodeShareState, decodeShareState, shareStateFromHash } =
    load(['encodeShareState', 'decodeShareState', 'shareStateFromHash']);

const PROC = {
    v: 2, layout: 2,
    panes: {
        1: { radarSite: 'DGX', radarProduct: 'sr_bref', radarVisible: true, view: [-90.2, 32.3, 7.5],
             overlays: [{ layer: 'nws-warnings-only' }, { layer: 'spc-outlook', day: '1' }] },
        2: { radarSite: 'nexrad-n0q-900913', goesChannel: 13, satVisible: true, view: [-95, 30, 5] }
    }
};

test('a bundle survives the round trip exactly', () => {
    assert.deepStrictEqual(decodeShareState(encodeShareState(PROC)), PROC);
});

test('the encoding is URL-safe: no +, / or = and nothing outside the fragment charset', () => {
    const enc = encodeShareState(PROC);
    assert.match(enc, /^[A-Za-z0-9_-]+$/);
    // Non-ASCII survives too (a tab name or product label with a dash or degree sign).
    const p = { v: 2, layout: 1, panes: { 1: { note: 'Gulfport — 32°N' } } };
    assert.deepStrictEqual(decodeShareState(encodeShareState(p)), p);
});

test('junk, legacy v1 bundles and non-objects decode to null', () => {
    assert.equal(decodeShareState('not base64!!'), null);
    assert.equal(decodeShareState(''), null);
    assert.equal(decodeShareState(encodeShareState({ site: 'DGX', active: [] })), null);   // v1 shape
    assert.equal(decodeShareState(encodeShareState([1, 2, 3])), null);
    assert.equal(decodeShareState(encodeShareState({ v: 2, panes: 'x' })), null);
});

test('the hash parser finds v= at the start or after & and ignores everything else', () => {
    const enc = encodeShareState(PROC);
    assert.deepStrictEqual(shareStateFromHash(`#v=${enc}`), PROC);
    assert.deepStrictEqual(shareStateFromHash(`#tab=2&v=${enc}`), PROC);
    assert.equal(shareStateFromHash(''), null);
    assert.equal(shareStateFromHash('#v='), null);
    assert.equal(shareStateFromHash('#av=' + enc), null);
});
