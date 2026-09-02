// Pulls named top-level declarations out of app.js and evaluates them in an
// isolated context, so the pure logic can be unit-tested without a browser
// and without splitting app.js into modules first. Declarations are found by
// name at column 0 and cut at the first line where bracket depth returns to
// zero — which is how every top-level function/const in app.js is written.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const LINES = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8').split('\n');

function locate(name) {
    const re = new RegExp(`^(?:(?:function|const|let|var)\\s+${name}\\b|\\(function ${name}\\()`);
    const start = LINES.findIndex(l => re.test(l));
    if (start < 0) throw new Error(`tests/_load: "${name}" not found at top level of app.js`);
    let depth = 0;
    for (let i = start; i < LINES.length; i++) {
        for (const ch of LINES[i]) {
            if (ch === '{' || ch === '[' || ch === '(') depth++;
            else if (ch === '}' || ch === ']' || ch === ')') depth--;
        }
        if (depth === 0 && /[;}]\s*$/.test(LINES[i])) return { start, end: i };
    }
    throw new Error(`tests/_load: "${name}" never closes`);
}

// load(['esc', 'safeHttpsUrl']) -> { esc, safeHttpsUrl }
// Names are emitted in app.js order so dependencies resolve. IIFEs (names
// starting with "install") run for their side effects on `globals` and are
// not returned. `globals` become free variables the extracted code can see
// (window, document, ...). Runs in THIS realm, not a fresh vm context, so
// the objects that come back share Object.prototype with the test file and
// deepStrictEqual compares them by value rather than by realm.
function load(names, globals = {}) {
    const spans = names.map(n => ({ n, ...locate(n) })).sort((a, b) => a.start - b.start);
    const src = spans.map(s => LINES.slice(s.start, s.end + 1).join('\n')).join('\n\n');
    const exported = names.filter(n => !n.startsWith('install'));
    const params = Object.keys(globals);
    const code = `(function (${params.join(', ')}) {\n${src}\n;return { ${exported.join(', ')} };\n})`;
    const factory = vm.runInThisContext(code, { filename: 'app.js(extract)' });
    return factory(...params.map(k => globals[k]));
}

module.exports = { load };
