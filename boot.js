// Boot shims, kept out of index.html so the page can ship a Content-Security-Policy
// with no 'unsafe-inline' in script-src. That is what makes CSP worth having here:
// without inline script allowed, an injected `<img onerror=...>` from a malformed
// or compromised upstream feed cannot execute.
//
// Loaded as a module (it imports the vendored Speed Insights client; pinned 2.0.0,
// self-hosted like MapLibre so script-src can be 'self' alone); module scripts are
// deferred by spec, so the DOM is parsed before this runs.
import { injectSpeedInsights } from './vendor/speed-insights.mjs';

// Vercel Web Analytics queue shim — collects events until /_vercel/insights loads.
window.va = window.va || function () { (window.vaq = window.vaq || []).push(arguments); };

injectSpeedInsights();
