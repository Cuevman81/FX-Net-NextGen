// Suppress MapLibre tile/image load errors globally (harmless file:// CORS artifacts)
window.addEventListener('error', function(e) {
    const msg = (e.message || '') + ' ' + (e.error?.message || '');
    if (msg.includes('Could not load image') || msg.includes('is not, or is no longer, usable') || msg.includes('supported image type')) {
        e.preventDefault();
        return true;
    }
});

window.diagnosticsLogs = [];
const originalLog = console.log;
const originalError = console.error;

function appendToLiveLog(msg, type = 'info') {
    const entry = `[${new Date().toISOString()}] [${type.toUpperCase()}] ${msg}`;
    window.diagnosticsLogs.push(entry);
    
    // Send directly to the local python server
    fetch('/log', {
        method: 'POST',
        body: entry
    }).catch(e => { /* Ignore errors so we don't infinitely loop log errors */ });
    
    // Attempt to add to DOM if it's ready
    const container = document.getElementById('live-log-entries');
    if (container) {
        const div = document.createElement('div');
        div.textContent = entry;
        div.style.color = type === 'error' ? '#ff4444' : (type === 'warn' ? '#ffaa00' : '#00ff88');
        div.style.marginBottom = '2px';
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
    }
}

console.log = function(...args) {
    originalLog.apply(console, args);
    appendToLiveLog(args.join(' '), 'info');
};

const originalWarn = console.warn;
console.warn = function(...args) {
    originalWarn.apply(console, args);
    appendToLiveLog(args.join(' '), 'warn');
};



console.error = function(...args) {
    const msg = args.join(' ');
    // Filter out redundant MapLibre tile/image errors
    if (msg.includes('NetworkError') || msg.includes('TypeError: NetworkError')) return;
    if (msg.includes('Could not load image')) return;
    if (msg.includes('is not, or is no longer, usable')) return;
    
    originalError.apply(console, args);
    appendToLiveLog(msg, 'error');
};

window.downloadDebugLogs = function() {
    const blob = new Blob([window.diagnosticsLogs.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fxnet_diagnostic_log_${new Date().toISOString().replace(/:/g, '-')}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};
