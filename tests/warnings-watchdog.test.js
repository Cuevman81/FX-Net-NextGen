// Warning watchdog cost (GitHub issue #4): zone outlines are simplified once
// when cached, GeometryCollection zones are no longer dropped, and an
// unchanged cycle is recognised so it skips re-sending data to the map.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('./_load').load(['ZONE_SIMPLIFY_DEG', 'simplifyRing', 'zonePolygons', 'warningsSignature']);

// A 1°x1° square whose edges carry 200 points of sub-tolerance wiggle.
function wigglySquare(x0, y0, size, n, amp) {
    const ring = [];
    const edge = (ax, ay, bx, by) => {
        for (let i = 0; i < n; i++) {
            const t = i / n, w = i === 0 ? 0 : (i % 2 ? amp : -amp);   // corners sit exactly on the square
            ring.push([ax + (bx - ax) * t + (ay === by ? 0 : w), ay + (by - ay) * t + (ax === bx ? 0 : w)]);
        }
    };
    edge(x0, y0, x0 + size, y0); edge(x0 + size, y0, x0 + size, y0 + size);
    edge(x0 + size, y0 + size, x0, y0 + size); edge(x0, y0 + size, x0, y0);
    ring.push([x0, y0]);
    return ring;
}

test('simplifyRing removes sub-tolerance wiggle and keeps the corners and closure', () => {
    const ring = wigglySquare(-90, 30, 1, 50, 0.0002);
    const s = M.simplifyRing(ring, M.ZONE_SIMPLIFY_DEG);
    assert.ok(ring.length > 200);
    assert.ok(s.length <= 6, `kept ${s.length}`);
    assert.deepEqual(s[0], s[s.length - 1]);
    for (const c of [[-89, 30], [-89, 31], [-90, 31]]) {
        assert.ok(s.some(p => Math.hypot(p[0] - c[0], p[1] - c[1]) < 0.001), `corner ${c}`);
    }
});

test('simplifyRing keeps detail larger than the tolerance', () => {
    const ring = wigglySquare(-90, 30, 1, 50, 0.01);
    assert.ok(M.simplifyRing(ring, M.ZONE_SIMPLIFY_DEG).length > 150);
});

test('zonePolygons flattens Polygon, MultiPolygon and GeometryCollection', () => {
    const sq = (x, y) => [[[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]]];
    assert.equal(M.zonePolygons({ type: 'Polygon', coordinates: sq(0, 0) }, M.ZONE_SIMPLIFY_DEG).length, 1);
    assert.equal(M.zonePolygons({ type: 'MultiPolygon', coordinates: [sq(0, 0), sq(5, 5)] }, M.ZONE_SIMPLIFY_DEG).length, 2);
    const gc = { type: 'GeometryCollection', geometries: [
        { type: 'MultiPolygon', coordinates: [sq(0, 0), sq(5, 5)] },
        { type: 'Polygon', coordinates: sq(9, 9) }
    ] };
    assert.equal(M.zonePolygons(gc, M.ZONE_SIMPLIFY_DEG).length, 3);
    assert.deepEqual(M.zonePolygons(null, M.ZONE_SIMPLIFY_DEG), []);
});

test('zonePolygons drops islets smaller than the tolerance but never the whole zone', () => {
    const big = [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]];
    const islet = [[[3, 3], [3.0001, 3], [3.0001, 3.0001], [3.00005, 3.00012], [3, 3.0001], [3, 3]]];
    const out = M.zonePolygons({ type: 'MultiPolygon', coordinates: [big, islet] }, 0.001);
    assert.equal(out.length, 1);
    const alone = M.zonePolygons({ type: 'Polygon', coordinates: islet }, 0.001);
    assert.equal(alone.length, 1);   // kept unsimplified rather than vanishing
});

test('warningsSignature changes on a new issuance or more resolved zones, not otherwise', () => {
    const f = (id, sent, n) => ({ properties: { id, sent, expires: 'x' }, geometry: { type: 'MultiPolygon', coordinates: new Array(n).fill([]) } });
    const a = M.warningsSignature([f('A', '1', 2), f('B', '1', 1)]);
    assert.equal(a, M.warningsSignature([f('A', '1', 2), f('B', '1', 1)]));
    assert.notEqual(a, M.warningsSignature([f('A', '2', 2), f('B', '1', 1)]));
    assert.notEqual(a, M.warningsSignature([f('A', '1', 3), f('B', '1', 1)]));
    assert.notEqual(a, M.warningsSignature([f('A', '1', 2)]));
});
