// trace.js — live learning overlay. Prints the code path behind user actions.

let CODE_TRACE_PAUSED = true;   // start paused — resumes when the user expands the bubble
const CODE_TRACE_POS_KEY = 'codeTracePosition';

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
        feed.insertAdjacentHTML('beforeend', html);
        while (feed.children.length > 24) feed.removeChild(feed.firstElementChild);
        feed.scrollTop = feed.scrollHeight;
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
    if (panel) {
        panel.classList.toggle('ct-collapsed');
        _placeTracePanel(panel.offsetLeft, panel.offsetTop, true);
    }
}

// Bubble mode: the panel starts as a small pill. Clicking it expands to the full trace panel.
// Trace stays PAUSED until the user explicitly hits Resume.
function expandTraceBubble() {
    const panel = _tracePanel();
    if (!panel || !panel.classList.contains('ct-bubble')) return;
    panel.classList.remove('ct-bubble');
}

function collapseTraceBubble() {
    const panel = _tracePanel();
    if (!panel) return;
    // If already in bubble mode, just expand it
    if (panel.classList.contains('ct-bubble')) {
        expandTraceBubble();
        return;
    }
    // Otherwise collapse to bubble and pause
    panel.classList.add('ct-bubble');
    CODE_TRACE_PAUSED = true;
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

function _traceBounds(panel) {
    const parent = panel && panel.parentElement;
    if (!parent) return null;
    const pad = 8;
    const pr = parent.getBoundingClientRect();
    const pw = parent.clientWidth || pr.width;
    const ph = parent.clientHeight || pr.height;
    const maxX = Math.max(pad, pw - panel.offsetWidth - pad);
    const maxY = Math.max(pad, ph - panel.offsetHeight - pad);
    return { pad: pad, maxX: maxX, maxY: maxY };
}

function _placeTracePanel(x, y, save) {
    const panel = _tracePanel();
    const b = _traceBounds(panel);
    if (!panel || !b) return;
    const nx = Math.min(Math.max(x, b.pad), b.maxX);
    const ny = Math.min(Math.max(y, b.pad), b.maxY);
    panel.style.left = nx + 'px';
    panel.style.top = ny + 'px';
    panel.classList.add('ct-moved');
    if (save) {
        try { localStorage.setItem(CODE_TRACE_POS_KEY, JSON.stringify({ x: nx, y: ny })); }
        catch (e) { /* storage unavailable — dragging still works for this page view */ }
    }
}

function _restoreTracePosition() {
    try {
        const pos = JSON.parse(localStorage.getItem(CODE_TRACE_POS_KEY) || 'null');
        if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') _placeTracePanel(pos.x, pos.y, false);
    } catch (e) { /* ignore malformed saved positions */ }
}

function enableTraceDrag() {
    const panel = _tracePanel();
    const head = panel && panel.querySelector('.ct-head');
    if (!panel || !head || !window.PointerEvent) return;
    let drag = null;
    let didDrag = false;   // true if pointer moved during this press — suppresses the expand click
    head.addEventListener('pointerdown', function (ev) {
        if (ev.button !== 0 || ev.target.closest('.ct-actions')) return;
        const pr = panel.parentElement.getBoundingClientRect();
        drag = {
            dx: ev.clientX - pr.left - panel.offsetLeft,
            dy: ev.clientY - pr.top - panel.offsetTop
        };
        didDrag = false;
        panel.classList.add('ct-dragging');
        head.setPointerCapture(ev.pointerId);
        ev.preventDefault();
    });
    head.addEventListener('pointermove', function (ev) {
        if (!drag) return;
        didDrag = true;
        const pr = panel.parentElement.getBoundingClientRect();
        _placeTracePanel(ev.clientX - pr.left - drag.dx, ev.clientY - pr.top - drag.dy, false);
    });
    const finish = function (ev) {
        if (!drag) return;
        drag = null;
        panel.classList.remove('ct-dragging');
        const b = _traceBounds(panel);
        if (b) _placeTracePanel(panel.offsetLeft, panel.offsetTop, true);
        try { head.releasePointerCapture(ev.pointerId); } catch (e) { /* pointer may already be released */ }
    };
    head.addEventListener('pointerup', finish);
    head.addEventListener('pointercancel', finish);
    // Click on the panel (not a drag) expands the bubble
    panel.addEventListener('click', function (ev) {
        if (didDrag) { didDrag = false; return; }   // was a drag, not a click — ignore
        if (!panel.classList.contains('ct-bubble')) return;   // already expanded
        if (ev.target.closest('.ct-actions')) return;   // action button handles itself
        expandTraceBubble();
    });
    window.addEventListener('resize', function () {
        _placeTracePanel(panel.offsetLeft, panel.offsetTop, true);
    });
}

document.addEventListener('DOMContentLoaded', function () {
    const panel = _tracePanel();
    // Start in bubble mode (paused + collapsed as a small pill)
    if (panel) panel.classList.add('ct-bubble');
    _restoreTracePosition();
    enableTraceDrag();
});
