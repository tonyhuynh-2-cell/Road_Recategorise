// trace.js — live learning overlay. Prints the code path behind user actions.

let CODE_TRACE_PAUSED = false;

function _traceEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
}

function _tracePanel() { return document.getElementById('code-trace'); }

function traceCode(title, explanation, code, context) {
    if (CODE_TRACE_PAUSED) return;
    const panel = _tracePanel();
    const feed = document.getElementById('code-trace-feed');
    const count = document.getElementById('code-trace-count');
    const now = new Date();
    const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const meta = context ? '<div class="ct-meta">' + _traceEsc(context) + '</div>' : '';
    const html =
        '<article class="ct-entry">' +
        '<div class="ct-entry-head"><span>' + _traceEsc(title) + '</span><time>' + time + '</time></div>' +
        '<p>' + _traceEsc(explanation) + '</p>' + meta +
        '<pre><code>' + _traceEsc(code).trim() + '</code></pre>' +
        '</article>';
    if (feed) {
        feed.insertAdjacentHTML('afterbegin', html);
        while (feed.children.length > 24) feed.removeChild(feed.lastElementChild);
    }
    if (count && feed) count.textContent = feed.children.length;
    if (panel) panel.classList.add('ct-has-entries');
    if (window.console && console.groupCollapsed) {
        console.groupCollapsed('[Code trace] ' + title);
        console.log(explanation);
        if (context) console.log(context);
        console.log(code);
        console.groupEnd();
    }
}

function toggleCodeTrace() {
    const panel = _tracePanel();
    if (panel) panel.classList.toggle('ct-collapsed');
}

function clearCodeTrace() {
    const feed = document.getElementById('code-trace-feed');
    const count = document.getElementById('code-trace-count');
    if (feed) feed.innerHTML = '';
    if (count) count.textContent = '0';
}

function pauseCodeTrace(btn) {
    CODE_TRACE_PAUSED = !CODE_TRACE_PAUSED;
    if (btn) btn.textContent = CODE_TRACE_PAUSED ? 'Resume' : 'Pause';
}

document.addEventListener('DOMContentLoaded', function () {
    traceCode(
        'Trace ready',
        'This panel will print the key JavaScript path whenever you use the dashboard.',
        "traceCode('Action name', 'Plain-English explanation', 'small code snippet');",
        'Tip: use Pause/Clear/Collapse if the feed gets busy.'
    );
});
