// Loop frame tiles (2026-09-29 blank-loop fix): fetched once, retried on
// failure, and handed to MapLibre WITHOUT cache headers so it never schedules
// the re-request whose failure used to blank a frame for good.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./_load');

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (headers = {}) => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png', ...headers } });
const status = (code) => new Response('nope', { status: code, headers: { 'content-type': 'text/plain' } });

// Each test gets its own loader bound to a scripted fake network. Retry delays
// are shrunk to a few milliseconds so the suite stays fast.
function harness(script) {
    const calls = [];
    const fetch = async (url, init) => {
        calls.push(url);
        if (init && init.signal && init.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const step = script[Math.min(calls.length - 1, script.length - 1)];
        if (step instanceof Error) throw step;
        return typeof step === 'function' ? step(init) : step;
    };
    const api = load(['LOOP_FRAME_SCHEME', 'loopFrameUrl', 'abortableDelay', 'loadLoopFrameTile'],
        { fetch, LOOP_FRAME_RETRY_MS: [5, 10], loopFrameFailures: 0 });
    return { ...api, calls };
}
const URL_HTTPS = 'https://opengeo.ncep.noaa.gov/geoserver/kdgx/ows?layers=kdgx_sr_bref&time=2026-09-29T14:05:00Z';

test('frame URLs switch to the fxframe scheme and the loader maps them back to https', async () => {
    const h = harness([png()]);
    const framed = h.loopFrameUrl(URL_HTTPS);
    assert.equal(framed, URL_HTTPS.replace('https://', 'fxframe://'));
    assert.equal(h.loopFrameUrl('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
    await h.loadLoopFrameTile({ url: framed }, new AbortController());
    assert.deepEqual(h.calls, [URL_HTTPS]);
});

test('a loaded frame carries no cache headers, even when the server sends a 120 s max-age', async () => {
    const h = harness([png({ 'cache-control': 'must-revalidate, max-age=120', expires: 'Tue, 29 Sep 2026 17:22:54 GMT' })]);
    const r = await h.loadLoopFrameTile({ url: h.loopFrameUrl(URL_HTTPS) }, new AbortController());
    assert.ok(r.data instanceof ArrayBuffer && r.data.byteLength === PNG.length);
    // MapLibre only arms its re-request timer when one of these is present.
    assert.deepEqual(Object.keys(r), ['data']);
});

test('a 503 from a struggling server is retried, and the frame still loads', async () => {
    const h = harness([status(503), png()]);
    const r = await h.loadLoopFrameTile({ url: h.loopFrameUrl(URL_HTTPS) }, new AbortController());
    assert.ok(r.data);
    assert.equal(h.calls.length, 2);
});

test('a dropped connection is retried too', async () => {
    const h = harness([new TypeError('Failed to fetch'), status(429), png()]);
    const r = await h.loadLoopFrameTile({ url: h.loopFrameUrl(URL_HTTPS) }, new AbortController());
    assert.ok(r.data);
    assert.equal(h.calls.length, 3);
});

test('after three failed attempts it gives up with the last status', async () => {
    const h = harness([status(503)]);
    await assert.rejects(h.loadLoopFrameTile({ url: h.loopFrameUrl(URL_HTTPS) }, new AbortController()),
        e => e.status === 503);
    assert.equal(h.calls.length, 3);
});

test('a 404 is not retried — it will not fix itself', async () => {
    const h = harness([status(404), png()]);
    await assert.rejects(h.loadLoopFrameTile({ url: h.loopFrameUrl(URL_HTTPS) }, new AbortController()),
        e => e.status === 404);
    assert.equal(h.calls.length, 1);
});

test('a WMS error document returned as HTTP 200 is not treated as an image', async () => {
    const xml = () => new Response('<ServiceExceptionReport/>', { status: 200, headers: { 'content-type': 'application/vnd.ogc.se_xml' } });
    const h = harness([xml(), png()]);
    const r = await h.loadLoopFrameTile({ url: h.loopFrameUrl(URL_HTTPS) }, new AbortController());
    assert.ok(r.data);
    assert.equal(h.calls.length, 2);
});

test('stopping the loop mid-retry cancels at once and sends nothing more', async () => {
    const h = harness([status(503), png()]);
    const ac = new AbortController();
    const p = h.loadLoopFrameTile({ url: h.loopFrameUrl(URL_HTTPS) }, ac);
    await new Promise(r => setImmediate(r));   // first attempt done, now waiting out the backoff
    ac.abort();
    await assert.rejects(p, e => e.name === 'AbortError');
    await new Promise(r => setTimeout(r, 30));
    assert.equal(h.calls.length, 1);
});

test('an abort during the request itself is passed straight back, not retried', async () => {
    const ac = new AbortController();
    const h = harness([() => { ac.abort(); throw new DOMException('Aborted', 'AbortError'); }, png()]);
    await assert.rejects(h.loadLoopFrameTile({ url: h.loopFrameUrl(URL_HTTPS) }, ac), e => e.name === 'AbortError');
    assert.equal(h.calls.length, 1);
});

test('the color IR channels loop on GIBS Clean IR; gray channels stay on nowCOAST', () => {
    const { loopsOnGibsIr } = load(['IR_LOOP_VIA_GIBS', 'loopsOnGibsIr']);
    [13, 14, 15, '13'].forEach(ch => assert.equal(loopsOnGibsIr(ch), true, `CH${ch}`));
    [2, 7, 8, 9, 10, 11, 12, 16, null].forEach(ch => assert.equal(loopsOnGibsIr(ch), false, `CH${ch}`));
});
