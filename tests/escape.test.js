// esc() is the one helper between every feed-supplied string and innerHTML;
// safeHttpsUrl() is the only path by which a feed-supplied link becomes an href.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { esc, safeHttpsUrl } = require('./_load').load(['esc', 'safeHttpsUrl']);

test('esc neutralises every HTML-significant character', () => {
    assert.equal(esc('<img src=x onerror=1>'), '&lt;img src=x onerror=1&gt;');
    assert.equal(esc(`a"b'c&d`), 'a&quot;b&#39;c&amp;d');
    assert.equal(esc(null), '');
    assert.equal(esc(undefined), '');
    assert.equal(esc(42), '42');
});

test('safeHttpsUrl accepts only an https URL', () => {
    assert.equal(safeHttpsUrl('https://www.spc.noaa.gov/products/md/md1234.html'),
        'https://www.spc.noaa.gov/products/md/md1234.html');
    assert.equal(safeHttpsUrl('  https://a.b/c  '), 'https://a.b/c', 'surrounding whitespace is trimmed');
});

test('safeHttpsUrl rejects every other scheme and any attribute breakout', () => {
    for (const bad of [
        'http://x.y/', 'javascript:alert(1)', 'data:text/html,x', 'ftp://x.y/', '//x.y/', '/relative',
        'https://a.b/" onmouseover="x', "https://a.b/' onclick='x", 'https://a.b/<script>', 'https://a.b/c d',
        '', null, undefined
    ]) assert.equal(safeHttpsUrl(bad), '', `should reject ${JSON.stringify(bad)}`);
});

test('safeHttpsUrl escapes the survivor so & in a query string is attribute-safe', () => {
    assert.equal(safeHttpsUrl('https://a.b/c?d=1&e=2'), 'https://a.b/c?d=1&amp;e=2');
});
