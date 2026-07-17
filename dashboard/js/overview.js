// overview.js — Dashboard overview: full-page 3×2 card grid with charts and summary stats.

let _dovInitialized = false;
let _dovMiniMap = null;
let _dovCharts = {};

function showDashboardView() {
    document.querySelector('.container').hidden = true;
    document.getElementById('dashboard-view').hidden = false;
    // Hide the main map's zoom control (it bleeds through z-index)
    document.querySelectorAll('.leaflet-control-zoom').forEach(function (el) { el.style.display = 'none'; });
    if (!_dovInitialized) initDashboardOverview();
    else refreshDashboardOverview();
    // Leaflet needs a size refresh after the container becomes visible
    if (_dovMiniMap) setTimeout(function () { _dovMiniMap.invalidateSize(); }, 100);
}

function showMapView() {
    document.getElementById('dashboard-view').hidden = true;
    document.querySelector('.container').hidden = false;
    // Restore the main map's zoom control
    document.querySelectorAll('.leaflet-control-zoom').forEach(function (el) { el.style.display = ''; });
    // Leaflet may need a size refresh after being hidden
    if (typeof map !== 'undefined') setTimeout(function () { map.invalidateSize(); }, 100);
}

function initDashboardOverview() {
    _dovInitialized = true;
    // Interactive mini map
    _dovMiniMap = L.map('dov-map-container', {
        zoomControl: true, attributionControl: false
    }).setView([-32.0, 149.5], 5);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(_dovMiniMap);
    // Add road layer with click handlers
    var _dovSelectedLayer = null;
    if (typeof nswLayer !== 'undefined') {
        var src = nswLayer.toGeoJSON();
        L.geoJSON(src, {
            style: function (f) {
                var v = f.properties._roadStatus || f.properties.status || 'red';
                return { stroke: true, color: ROAD_COLORS[v] || '#a8a29e', weight: 1.5, opacity: 0.8 };
            },
            onEachFeature: function (feature, layer) {
                var p = feature.properties;
                var key = (typeof roadKeyOf === 'function') ? roadKeyOf(p) : '';
                if (!key) return;
                layer.on('click', function (e) {
                    L.DomEvent.stopPropagation(e);
                    // Reset previous selection
                    if (_dovSelectedLayer) {
                        var prevV = _dovSelectedLayer.feature.properties._roadStatus || _dovSelectedLayer.feature.properties.status || 'red';
                        _dovSelectedLayer.setStyle({ color: ROAD_COLORS[prevV] || '#a8a29e', weight: 1.5, opacity: 0.8 });
                    }
                    // Highlight this road
                    layer.setStyle({ weight: 5, opacity: 1, color: '#2563eb' });
                    layer.bringToFront();
                    _dovSelectedLayer = layer;
                    // Look up the full aggregated road data
                    var aggData = (typeof NSW_AGG !== 'undefined') ? NSW_AGG[key] : null;
                    var props = aggData ? Object.assign({}, aggData, p) : p;
                    dovShowRoadInfo(props);
                });
                layer.on('mouseover', function () {
                    if (layer !== _dovSelectedLayer) layer.setStyle({ weight: 3, opacity: 1 });
                });
                layer.on('mouseout', function () {
                    if (layer !== _dovSelectedLayer) {
                        var v = feature.properties._roadStatus || feature.properties.status || 'red';
                        layer.setStyle({ weight: 1.5, opacity: 0.8, color: ROAD_COLORS[v] || '#a8a29e' });
                    }
                });
            }
        }).addTo(_dovMiniMap);
    }
    // Click empty map — do nothing (keep road info card if showing)
    _dovMiniMap.on('click', function () { /* no-op: only the back button resets */ });
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
            responsive: true, maintainAspectRatio: false,
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
            responsive: true, maintainAspectRatio: false,
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
            responsive: true, maintainAspectRatio: false,
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

// --- Road info display in the summary card ---

function dovShowRoadInfo(p) {
    var card = document.getElementById('dov-summary');
    if (!card) return;
    var key = roadKeyOf(p);
    var agg = (typeof NSW_AGG !== 'undefined') ? NSW_AGG[key] : null;
    var c = (window.NSW_CRIT || {})[key];
    var nh = (window.NHVR || {})[key] || {};
    var rx = (window.ROAD_EXT || {})[key] || {};
    var ad = (window.ADT || {})[key];
    var z = (window.ZONE || {})[key];
    var evd = (window.NSW_EVID || {})[key] || {};

    var name = (agg && agg.road_name) ? titleCase(agg.road_name) : (p.road_name ? titleCase(p.road_name) : 'Unnamed road');
    var roadId = (p.road_number && String(p.road_number).trim()) ? String(p.road_number).trim() : (agg && agg.road_number ? String(agg.road_number).trim() : '');
    var cls = p.admin_class === 'S' ? 'State Road' : 'Regional Road';
    var verdict = (c && c.verdict) || p._roadStatus || p.status || 'red';
    var verdictLabel = verdict === 'green' ? 'Meets criteria' : verdict === 'orange' ? 'Meets 1 of 2' : 'Does not meet';
    var verdictColor = ROAD_COLORS[verdict] || '#a8a29e';
    var len = agg ? Math.round(agg._len) : '–';
    var zoneLabel = z === 'urban' ? 'Urban' : z === 'remote' ? 'Remote' : 'Regional';
    var isState = p.admin_class === 'S';

    // Mandatory criteria
    var mandHtml = '';
    if (isState) {
        var pbs1 = (c && c.mand) ? c.mand.pbs1 : !!p.has_pbs1;
        var parallel = rx.parallel_state_20;
        mandHtml += '<div class="dov-crit-row ' + (pbs1 ? 'dov-crit-pass' : 'dov-crit-fail') + '">S-09: PBS Level 1 access</div>';
        if (parallel === true) mandHtml += '<div class="dov-crit-row dov-crit-fail">Parallels a State Road (&lt;20km)</div>';
        else if (parallel === false) mandHtml += '<div class="dov-crit-row dov-crit-pass">No parallel State Road</div>';
    } else {
        var bd = nh.bdouble19;
        mandHtml += '<div class="dov-crit-row ' + (bd ? 'dov-crit-pass' : 'dov-crit-fail') + '">R-04: 19m B-double access</div>';
    }
    mandHtml += '<div class="dov-crit-row dov-crit-na">No load limits (assumed)</div>';

    // Optional criteria
    var optHtml = '';
    if (c && c.opt) {
        var opts = [
            ['Connects centres', c.opt.centres],
            ['Connects facilities', c.opt.dest],
            ['Heavy vehicle network', c.opt.hv],
            ['Traffic volume', c.opt.traffic],
            ['Long-distance route', c.opt.ldr],
            ['Links two State Roads', c.opt.two_state]
        ];
        opts.forEach(function (o) {
            if (o[1] === true) optHtml += '<div class="dov-crit-row dov-crit-pass">' + o[0] + '</div>';
            else if (o[1] === false) optHtml += '<div class="dov-crit-row dov-crit-fail">' + o[0] + '</div>';
        });
    }

    // NHVR network membership
    var nhvrHtml = '';
    if (nh.roadtrain === true) nhvrHtml += '<div class="dov-crit-row dov-crit-pass">Road train (32m)</div>';
    if (nh.bdouble19 === true) nhvrHtml += '<div class="dov-crit-row dov-crit-pass">19m B-double</div>';
    if (nh.bypass === true) nhvrHtml += '<div class="dov-crit-row dov-crit-pass">HV bypass route</div>';
    if (!nhvrHtml) nhvrHtml = '<span class="dov-road-faint">No NHVR network flags</span>';

    // Traffic data
    var trafficHtml = '';
    if (ad) {
        trafficHtml = '<span class="dov-road-faint">AADT: ' + ad.aadt.toLocaleString() + ' (' + ad.year + ')' + (ad.hv_pct != null ? ' · ' + ad.hv_pct + '% HV' : '') + '</span>';
    } else {
        trafficHtml = '<span class="dov-road-faint">No traffic data available</span>';
    }

    // Connected centres/facilities (by name, max 5)
    var connHtml = '';
    var centres = (evd.centres || []).slice(0, 4).map(function (e) { return e.name; });
    var facilities = (evd.hospitals || []).concat(evd.dests || []).slice(0, 3).map(function (e) { return e.name; });
    if (centres.length) connHtml += '<div class="dov-conn-group"><span class="dov-conn-label">Centres:</span> ' + centres.join(', ') + '</div>';
    if (facilities.length) connHtml += '<div class="dov-conn-group"><span class="dov-conn-label">Facilities:</span> ' + facilities.join(', ') + '</div>';
    if (!connHtml) connHtml = '<span class="dov-road-faint">No connected entities in data</span>';

    card.innerHTML =
        '<div class="dov-road-header">' +
            '<h3>Selected Road</h3>' +
            '<div class="dov-road-header-actions">' +
                '<button class="dov-view-map-btn" onclick="dovViewOnMap(\'' + key.replace(/'/g, "\\'") + '\')">View on map</button>' +
                '<button class="dov-road-reset" onclick="dovShowSummary()" title="Back to summary">&times;</button>' +
            '</div>' +
        '</div>' +
        '<div class="dov-road-info">' +
            '<div class="dov-road-name">' + name + '</div>' +
            (roadId ? '<div class="dov-road-id">Road ID: ' + roadId + '</div>' : '') +
            '<div class="dov-road-meta">' + cls + ' · ' + zoneLabel + ' zone · ' + len + ' km</div>' +
            '<div class="dov-road-verdict" style="color:' + verdictColor + '">' + verdictLabel + '</div>' +
            '<div class="dov-road-section"><span class="dov-section-title">Mandatory</span>' + mandHtml + '</div>' +
            '<div class="dov-road-section"><span class="dov-section-title">Optional (need &ge;2)</span>' + optHtml + '</div>' +
            '<div class="dov-road-section"><span class="dov-section-title">NHVR Networks</span>' + nhvrHtml + '</div>' +
            '<div class="dov-road-section"><span class="dov-section-title">Traffic</span>' + trafficHtml + '</div>' +
            '<div class="dov-road-section"><span class="dov-section-title">Connects</span>' + connHtml + '</div>' +
        '</div>';
}

function dovShowSummary() {
    var card = document.getElementById('dov-summary');
    if (!card) return;
    card.innerHTML =
        '<h3>Network Summary</h3>' +
        '<div class="dov-stats">' +
            '<div class="dov-stat"><span class="dov-stat-val" id="dov-total-roads">–</span><span class="dov-stat-lbl">Total roads</span></div>' +
            '<div class="dov-stat"><span class="dov-stat-val" id="dov-total-km">–</span><span class="dov-stat-lbl">Total km</span></div>' +
            '<div class="dov-stat"><span class="dov-stat-val" id="dov-state-count">–</span><span class="dov-stat-lbl">State roads</span></div>' +
            '<div class="dov-stat"><span class="dov-stat-val" id="dov-regional-count">–</span><span class="dov-stat-lbl">Regional roads</span></div>' +
            '<div class="dov-stat"><span class="dov-stat-val" id="dov-segments">–</span><span class="dov-stat-lbl">Segments assessed</span></div>' +
        '</div>';
    // Re-populate the stats
    var agg = (typeof NSW_AGG !== 'undefined') ? NSW_AGG : {};
    var crit = window.NSW_CRIT || {};
    var totalRoads = 0, totalKm = 0, stateCount = 0, regionalCount = 0;
    for (var k in agg) {
        var a = agg[k];
        if (a.admin_class !== 'S' && a.admin_class !== 'R') continue;
        totalRoads++; totalKm += a._len || 0;
        if (a.admin_class === 'S') stateCount++; else regionalCount++;
    }
    var set = function (id, val) { var el = document.getElementById(id); if (el) el.textContent = val; };
    set('dov-total-roads', totalRoads.toLocaleString());
    set('dov-total-km', Math.round(totalKm).toLocaleString() + ' km');
    set('dov-state-count', stateCount.toLocaleString());
    set('dov-regional-count', regionalCount.toLocaleString());
    set('dov-segments', (typeof NSW_SEG_TOTAL !== 'undefined' ? NSW_SEG_TOTAL : 0).toLocaleString());
}

// Switch to the main map view with a specific road selected
function dovViewOnMap(key) {
    showMapView();
    // Select the road on the main map
    var layers = (window.NSW_ROAD_LAYERS || {})[key];
    if (layers && layers.length && typeof highlightRoad === 'function' && typeof nswLayer !== 'undefined') {
        highlightRoad(layers, nswLayer);
        // Zoom to it
        try { map.fitBounds(L.featureGroup(layers).getBounds().pad(0.2), { maxZoom: 12 }); } catch (e) {}
        // Show detail
        var agg = (typeof NSW_AGG !== 'undefined') ? NSW_AGG[key] : null;
        if (agg && typeof showRoadDetail === 'function') showRoadDetail(agg, 'nsw');
    }
}
