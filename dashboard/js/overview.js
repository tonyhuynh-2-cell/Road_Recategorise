// overview.js — Dashboard overview: full-page 3×2 card grid with charts and summary stats.

let _dovInitialized = false;
let _dovMiniMap = null;
let _dovCharts = {};

function showDashboardView() {
    document.querySelector('.container').hidden = true;
    document.getElementById('dashboard-view').hidden = false;
    if (!_dovInitialized) initDashboardOverview();
    else refreshDashboardOverview();
}

function showMapView() {
    document.getElementById('dashboard-view').hidden = true;
    document.querySelector('.container').hidden = false;
    // Leaflet may need a size refresh after being hidden
    if (typeof map !== 'undefined') setTimeout(function () { map.invalidateSize(); }, 100);
}

function initDashboardOverview() {
    _dovInitialized = true;
    // Mini map
    _dovMiniMap = L.map('dov-map-container', {
        zoomControl: false, attributionControl: false, dragging: false,
        scrollWheelZoom: false, doubleClickZoom: false, touchZoom: false
    }).setView([-32.0, 149.5], 5);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(_dovMiniMap);
    // Add a simplified version of the road layer
    if (typeof nswLayer !== 'undefined') {
        // Clone the geojson data to render on the mini map
        var src = nswLayer.toGeoJSON();
        L.geoJSON(src, {
            style: function (f) {
                var v = f.properties._roadStatus || f.properties.status || 'red';
                return { stroke: true, color: ROAD_COLORS[v] || '#a8a29e', weight: 1.2, opacity: 0.8 };
            }
        }).addTo(_dovMiniMap);
    }
    refreshDashboardOverview();
}

function refreshDashboardOverview() {
    var agg = (typeof NSW_AGG !== 'undefined') ? NSW_AGG : {};
    var crit = window.NSW_CRIT || {};
    var zone = window.ZONE || {};

    // Compute stats
    var totalRoads = 0, totalKm = 0, stateCount = 0, regionalCount = 0;
    var green = 0, orange = 0, red = 0;
    var zoneData = { urban: { g: 0, o: 0, r: 0 }, regional: { g: 0, o: 0, r: 0 }, remote: { g: 0, o: 0, r: 0 } };
    var critPassed = { centres: 0, dest: 0, hv: 0, traffic: 0, ldr: 0, two_state: 0 };
    var critTotal = 0;
    var riskRoads = [];

    for (var k in agg) {
        var a = agg[k];
        if (a.admin_class !== 'S' && a.admin_class !== 'R') continue;
        totalRoads++;
        totalKm += a._len || 0;
        if (a.admin_class === 'S') stateCount++; else regionalCount++;

        var c = crit[k];
        var v = (c && c.verdict) || a.status;
        if (v === 'green') green++; else if (v === 'orange') orange++; else red++;

        // Zone
        var z = zone[k] || 'regional';
        var zd = zoneData[z] || zoneData.regional;
        if (v === 'green') zd.g++; else if (v === 'orange') zd.o++; else zd.r++;

        // Criteria pass rates
        if (c && c.opt) {
            critTotal++;
            if (c.opt.centres === true) critPassed.centres++;
            if (c.opt.dest === true) critPassed.dest++;
            if (c.opt.hv === true) critPassed.hv++;
            if (c.opt.traffic === true) critPassed.traffic++;
            if (c.opt.ldr === true) critPassed.ldr++;
            if (c.opt.two_state === true) critPassed.two_state++;
        }

        // Top roads at risk (red, longest)
        if (v === 'red') {
            riskRoads.push({ name: a.road_name || 'Unnamed', cls: a.admin_class, len: a._len || 0, key: k });
        }
    }

    // Populate summary stats
    var set = function (id, val) { var el = document.getElementById(id); if (el) el.textContent = val; };
    set('dov-total-roads', totalRoads.toLocaleString());
    set('dov-total-km', Math.round(totalKm).toLocaleString() + ' km');
    set('dov-state-count', stateCount.toLocaleString());
    set('dov-regional-count', regionalCount.toLocaleString());
    set('dov-segments', (typeof NSW_SEG_TOTAL !== 'undefined' ? NSW_SEG_TOTAL : 0).toLocaleString());

    // Verdict donut
    renderDonut(green, orange, red);

    // Criteria bar
    renderCriteriaBar(critPassed, critTotal);

    // Zone stacked bar
    renderZoneBar(zoneData);

    // Top 10 roads at risk
    riskRoads.sort(function (a, b) { return b.len - a.len; });
    renderRiskList(riskRoads.slice(0, 10));
}

function renderDonut(g, o, r) {
    var ctx = document.getElementById('dov-donut');
    if (!ctx) return;
    if (_dovCharts.donut) _dovCharts.donut.destroy();
    _dovCharts.donut = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['Meets criteria', 'Meets 1 of 2', 'Does not meet'],
            datasets: [{ data: [g, o, r], backgroundColor: ['#16a34a', '#f59e0b', '#dc2626'], borderWidth: 2, borderColor: '#fff' }]
        },
        options: {
            cutout: '60%',
            plugins: {
                legend: { position: 'bottom', labels: { font: { family: 'IBM Plex Sans', size: 11 }, padding: 14 } },
                tooltip: { callbacks: { label: function (c) { var total = g + o + r; return c.label + ': ' + c.raw + ' (' + Math.round(c.raw / total * 100) + '%)'; } } }
            }
        }
    });
}

function renderCriteriaBar(passed, total) {
    var ctx = document.getElementById('dov-criteria-bar');
    if (!ctx || !total) return;
    if (_dovCharts.criteria) _dovCharts.criteria.destroy();
    var labels = ['Connects centres', 'Connects facilities', 'Heavy vehicle', 'Traffic volume', 'Long-distance route', 'Links 2 State Rds'];
    var data = [passed.centres, passed.dest, passed.hv, passed.traffic, passed.ldr, passed.two_state];
    var pcts = data.map(function (d) { return Math.round(d / total * 100); });
    _dovCharts.criteria = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{ data: pcts, backgroundColor: '#2563eb', borderRadius: 4 }]
        },
        options: {
            indexAxis: 'y',
            scales: { x: { max: 100, ticks: { callback: function (v) { return v + '%'; }, font: { size: 10 } }, grid: { color: '#f5f5f4' } }, y: { ticks: { font: { family: 'IBM Plex Sans', size: 11 } }, grid: { display: false } } },
            plugins: { legend: { display: false }, tooltip: { callbacks: { label: function (c) { return c.raw + '% of roads pass'; } } } }
        }
    });
}

function renderZoneBar(zd) {
    var ctx = document.getElementById('dov-zone-bar');
    if (!ctx) return;
    if (_dovCharts.zone) _dovCharts.zone.destroy();
    _dovCharts.zone = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: ['Urban', 'Regional', 'Remote'],
            datasets: [
                { label: 'Meets', data: [zd.urban.g, zd.regional.g, zd.remote.g], backgroundColor: '#16a34a', borderRadius: 3 },
                { label: 'Meets 1 of 2', data: [zd.urban.o, zd.regional.o, zd.remote.o], backgroundColor: '#f59e0b', borderRadius: 3 },
                { label: 'Does not meet', data: [zd.urban.r, zd.regional.r, zd.remote.r], backgroundColor: '#dc2626', borderRadius: 3 }
            ]
        },
        options: {
            scales: { x: { stacked: true, ticks: { font: { family: 'IBM Plex Sans', size: 11 } }, grid: { display: false } }, y: { stacked: true, ticks: { font: { size: 10 } }, grid: { color: '#f5f5f4' } } },
            plugins: { legend: { position: 'bottom', labels: { font: { family: 'IBM Plex Sans', size: 11 }, padding: 12 } } }
        }
    });
}

function renderRiskList(roads) {
    var el = document.getElementById('dov-risk-list');
    if (!el) return;
    if (!roads.length) { el.innerHTML = '<div class="dov-risk-empty">No roads at risk</div>'; return; }
    var html = '<table class="dov-risk-table"><thead><tr><th>#</th><th>Road</th><th>Type</th><th>Length</th></tr></thead><tbody>';
    roads.forEach(function (r, i) {
        var name = r.name ? (typeof titleCase === 'function' ? titleCase(r.name) : r.name) : 'Unnamed';
        var cls = r.cls === 'S' ? 'State' : 'Regional';
        html += '<tr><td>' + (i + 1) + '</td><td><strong>' + name + '</strong></td><td>' + cls + '</td><td>' + Math.round(r.len) + ' km</td></tr>';
    });
    html += '</tbody></table>';
    el.innerHTML = html;
}
