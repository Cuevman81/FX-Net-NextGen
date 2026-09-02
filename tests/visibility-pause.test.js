// installVisibilityPause patches window.setInterval so pollers skip ticks
// while document.hidden and each skipped callback replays exactly once on
// return. Driven with fake timers and a document whose hidden flag we flip.
'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./_load');

let timers, listeners, window, document;
const tick = () => [...timers.values()].forEach(f => f());
const show = () => { document.hidden = false; (listeners.visibilitychange || []).forEach(f => f()); };

beforeEach(() => {
    timers = new Map(); listeners = {};
    let seq = 0;
    window = {
        setInterval: (fn, ms) => { const id = ++seq; timers.set(id, fn); return id; },
        clearInterval: id => { timers.delete(id); }
    };
    document = { hidden: false, addEventListener: (t, f) => { (listeners[t] ||= []).push(f); } };
    load(['installVisibilityPause'], { window, document });
});

test('visible: every tick runs, extra args are forwarded', () => {
    let a = 0, b = 0;
    window.setInterval(() => a++, 1000);
    window.setInterval((x, y) => { b += x + y; }, 5000, 2, 3);
    tick(); tick();
    assert.deepEqual([a, b], [2, 10]);
});

test('hidden: nothing runs; on return each skipped callback replays exactly once', () => {
    let a = 0; const order = [];
    window.setInterval(() => { a++; order.push('a'); }, 1000);
    window.setInterval(() => order.push('b'), 5000);
    document.hidden = true;
    tick(); tick(); tick();
    assert.equal(a, 0);
    show();
    assert.equal(a, 1, 'three missed ticks replay as one');
    assert.deepEqual(order, ['a', 'b'], 'replay follows registration order');
});

test('a second visibilitychange with nothing missed is a no-op', () => {
    let a = 0;
    window.setInterval(() => a++, 1000);
    show(); show();
    assert.equal(a, 0);
});

test('an interval cleared while hidden is not replayed and is gone from the timer table', () => {
    let a = 0;
    const id = window.setInterval(() => a++, 1000);
    document.hidden = true; tick();
    window.clearInterval(id);
    show();
    assert.equal(a, 0);
    assert.equal(timers.has(id), false);
});

test('normal ticking resumes after a catch-up', () => {
    let a = 0;
    window.setInterval(() => a++, 1000);
    document.hidden = true; tick(); show();
    tick(); tick();
    assert.equal(a, 3);
});

test('non-function callbacks pass straight through to the native timer', () => {
    assert.equal(typeof window.setInterval('noop', 10), 'number');
});
