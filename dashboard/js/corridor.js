// corridor.js — interactive two-point, selected-corridor assessment.
// The result deliberately distinguishes corridor-spatial evidence from road-wide/unavailable inputs.

var corridorState = { roadKey: null, roadName: '', points: [], markers: [], route: null, routeLayer: null };
var corridorOverlay = L.layerGroup().addTo(map);

function beginCorridorAssessment() {
    nswView = 'all';
    if (nswLayer) { nswLayer.setStyle(nswStyle); if (!map.hasLayer(nswLayer)) map.addLayer(nswLayer); }
    document.getElementById('road-search').style.display = '';
    document.getElementById('corridor-status').textContent = corridorState.points.length === 1
        ? 'Select the second point on the same road.' : corridorState.points.length === 2
            ? 'Corridor selected. Click another road to start again.' : 'Select the first point on a road.';
}

function resetCorridorAssessment() {
    corridorOverlay.clearLayers();
    corridorState = { roadKey: null, roadName: '', points: [], markers: [], route: null, routeLayer: null };
    ['a', 'b'].forEach(function (id) {
        var el = document.getElementById('corridor-point-' + id); if (el) el.querySelector('span').textContent = 'Not selected';
    });
    var result = document.getElementById('corridor-result'); if (result) { result.hidden = true; result.innerHTML = ''; }
    var status = document.getElementById('corridor-status'); if (status) status.textContent = 'Select the first point on a road.';
}

function corridorRoadClick(feature, layer, e) {
    var key = roadKeyOf(feature.properties);
    if (!key) return;
    if (corridorState.points.length === 2 || (corridorState.roadKey && corridorState.roadKey !== key)) resetCorridorAssessment();
    corridorState.roadKey = key;
    corridorState.roadName = roadName((NSW_AGG || {})[key] || feature.properties);
    var snapped = corridorSnapToRoad(key, e.latlng);
    if (!snapped) return;
    corridorState.points.push(snapped);
    var label = corridorState.points.length === 1 ? 'A' : 'B';
    var marker = L.circleMarker(snapped.latlng, { pane: 'connPane', renderer: connRenderer, radius: 7,
        color: '#fff', weight: 2, fillColor: label === 'A' ? '#2563eb' : '#a52b32', fillOpacity: 1 })
        .bindTooltip(label, { permanent: true, direction: 'center', className: 'corridor-marker-label' }).addTo(corridorOverlay);
    corridorState.markers.push(marker);
    renderCorridorPoint(label, snapped);
    if (corridorState.points.length === 1) document.getElementById('corridor-status').textContent = 'Select the second point on the same road.';
    else finishCorridorAssessment();
}

function corridorCoords(geometry) {
    if (!geometry) return [];
    if (geometry.type === 'LineString') return [geometry.coordinates];
    return geometry.type === 'MultiLineString' ? geometry.coordinates : [];
}

function corridorProject(p, a, b) {
    var lat0 = p.lat * Math.PI / 180, sx = Math.cos(lat0);
    var ax = a[0] * sx, ay = a[1], bx = b[0] * sx, by = b[1], px = p.lng * sx, py = p.lat;
    var dx = bx - ax, dy = by - ay, den = dx * dx + dy * dy;
    var t = den ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / den)) : 0;
    var lon = (ax + t * dx) / sx, lat = ay + t * dy;
    return { lon: lon, lat: lat, t: t, d: map.distance(p, L.latLng(lat, lon)) };
}

function corridorSnapToRoad(key, latlng) {
    var layers = (window.NSW_ROAD_LAYERS || {})[key] || [];
    var best = null;
    layers.forEach(function (ly) { corridorCoords(ly.feature.geometry).forEach(function (line) {
        for (var i = 1; i < line.length; i++) {
            var q = corridorProject(latlng, line[i - 1], line[i]);
            if (!best || q.d < best.d) best = { latlng: L.latLng(q.lat, q.lon), d: q.d, layer: ly, line: line, edge: i - 1, t: q.t };
        }
    }); });
    if (!best) return null;
    best.street = (best.layer.feature.properties.road_name || corridorState.roadName || 'Unnamed road').replace(/\b\w/g, function (m) { return m.toUpperCase(); });
    best.locality = corridorNearestLocality(best.latlng);
    return best;
}

function corridorNearestLocality(latlng) {
    var best = null;
    (window.NSW_TOWNS_NAMED || []).forEach(function (t) {
        var d = map.distance(latlng, L.latLng(t.pt[1], t.pt[0]));
        if (!best || d < best.d) best = { name: t.name, d: d };
    });
    return best && best.d <= 25000 ? best.name : 'Locality unavailable';
}

function renderCorridorPoint(label, p) {
    var el = document.getElementById('corridor-point-' + label.toLowerCase());
    el.querySelector('span').textContent = p.street + '\n' + p.locality + '\n' + p.latlng.lat.toFixed(6) + ', ' + p.latlng.lng.toFixed(6);
}

function corridorGraph(key, snaps) {
    var nodes = {}, edges = {}, edgeId = 0;
    function nk(c) { return c[0].toFixed(6) + ',' + c[1].toFixed(6); }
    function addNode(c) { var k = nk(c); if (!nodes[k]) nodes[k] = c; if (!edges[k]) edges[k] = []; return k; }
    function addEdge(a, b, props) { var ak = addNode(a), bk = addNode(b), w = map.distance([a[1], a[0]], [b[1], b[0]]); edges[ak].push({ to: bk, w: w, p: props }); edges[bk].push({ to: ak, w: w, p: props }); edgeId++; }
    ((window.NSW_ROAD_LAYERS || {})[key] || []).forEach(function (ly) { corridorCoords(ly.feature.geometry).forEach(function (line) {
        var inserts = {};
        snaps.forEach(function (s, si) { if (s.layer === ly && s.line === line) (inserts[s.edge] || (inserts[s.edge] = [])).push({ t: s.t, c: [s.latlng.lng, s.latlng.lat], si: si }); });
        for (var i = 1; i < line.length; i++) {
            var pts = [{ t: 0, c: line[i - 1] }].concat((inserts[i - 1] || []).sort(function(a,b){return a.t-b.t;}), [{ t: 1, c: line[i] }]);
            for (var j = 1; j < pts.length; j++) addEdge(pts[j - 1].c, pts[j].c, ly.feature.properties);
        }
    }); });
    return { nodes: nodes, edges: edges, start: nk([snaps[0].latlng.lng, snaps[0].latlng.lat]), end: nk([snaps[1].latlng.lng, snaps[1].latlng.lat]) };
}

function corridorShortestPath(g) {
    var dist = {}, prev = {}, used = {}, q = Object.keys(g.nodes); q.forEach(function(k){dist[k]=Infinity;}); dist[g.start]=0;
    while (q.length) { q.sort(function(a,b){return dist[a]-dist[b];}); var u=q.shift(); if (!isFinite(dist[u]) || u===g.end) break; used[u]=true;
        (g.edges[u]||[]).forEach(function(ed){ if (!used[ed.to] && dist[u]+ed.w<dist[ed.to]) { dist[ed.to]=dist[u]+ed.w; prev[ed.to]={from:u,edge:ed}; } }); }
    if (!isFinite(dist[g.end])) return null;
    var keys=[g.end], props=[], cur=g.end; while(cur!==g.start){ var p=prev[cur]; if(!p)return null; props.push(p.edge.p); cur=p.from; keys.push(cur); } keys.reverse(); props.reverse();
    return { latlngs: keys.map(function(k){var c=g.nodes[k];return [c[1],c[0]];}), props: props, metres: dist[g.end] };
}

function corridorPointToRouteMetres(item, route) {
    if (item.lat == null || item.lon == null) return Infinity;
    var p=L.latLng(item.lat,item.lon), best=Infinity;
    for(var i=1;i<route.latlngs.length;i++){var a=route.latlngs[i-1],b=route.latlngs[i];var q=corridorProject(p,[a[1],a[0]],[b[1],b[0]]);best=Math.min(best,q.d);}
    return best;
}

function finishCorridorAssessment() {
    var route = corridorShortestPath(corridorGraph(corridorState.roadKey, corridorState.points));
    if (!route) { document.getElementById('corridor-status').textContent = 'Those points are on disconnected mapped sections. Clear the selection and choose two points on one continuous corridor.'; return; }
    corridorState.route = route;
    corridorState.routeLayer = L.polyline(route.latlngs, { pane:'connPane', renderer:connRenderer, color:'#a52b32', weight:7, opacity:1, lineCap:'round' }).addTo(corridorOverlay);
    map.fitBounds(corridorState.routeLayer.getBounds().pad(.15), { maxZoom: 14 });
    document.getElementById('corridor-status').textContent = 'Selected corridor assessed from available evidence.';
    renderCorridorAssessment(route);
}

function renderCorridorAssessment(route) {
    var k=corridorState.roadKey, ev=(window.NSW_EVID||{})[k]||{}, crit=(window.NSW_CRIT||{})[k]||{}, unique={};
    var centres=(ev.centres||[]).filter(function(x){return corridorPointToRouteMetres(x,route)<=2200;}).filter(function(x){var n=String(x.name||'').toLowerCase();if(unique[n])return false;unique[n]=1;return true;});
    var facilities=[].concat(ev.hospitals||[],ev.dests||[],(ev.employment||[]).filter(function(x){return x.size_qualifies;})).filter(function(x){return corridorPointToRouteMetres(x,route)<=2200;});
    var pbs1=route.props.length && route.props.every(function(p){return p.has_pbs1===1 || p.pbs1_coverage>0.8;});
    var bd=route.props.length && route.props.every(function(p){return p.has_bdouble===1 || p.bdouble_coverage>=0.8;});
    var pbs2b=route.props.length && route.props.some(function(p){return p.has_pbs2b===1;});
    var centrePass=centres.length>=2, destPass=facilities.length>=1 && centres.length>=1, ldr=route.metres>=25000 && centrePass;
    var traffic=crit.opt && crit.opt.traffic===true; var trafficKnown=crit.opt && crit.opt.traffic!==null && crit.opt.traffic!==undefined;
    var stateOpts=(centrePass?1:0)+(destPass?1:0)+(ldr?1:0)+(traffic?1:0);
    var regOpts=(centrePass?1:0)+(destPass?1:0);
    var asState=xverdict(stateOpts,pbs1), asReg=xverdict(regOpts,bd);
    var natMet=(pbs2b?1:0)+(centrePass?1:0)+(facilities.length?1:0), asNat=pbs2b?(natMet>=2?'green':natMet===1?'orange':'red'):'red';
    var cat=asNat==='green'?'Nationally Significant':asState==='green'?'State':asReg==='green'?'Regional':(asReg==='orange'||asState==='orange')?'Likely Regional':'Local / insufficient evidence';
    var result=document.getElementById('corridor-result'); result.hidden=false;
    result.innerHTML='<div class="corridor-result-card"><h3>Indicative best fit</h3><div class="corridor-category">'+cat+'<small>'+corridorState.roadName+' · '+(route.metres/1000).toFixed(2)+' km selected</small></div></div>'+
      '<div class="corridor-result-card"><h3>Selected-corridor evidence</h3><div class="corridor-grid">'+
      metric('PBS Level 1',pbs1?'Pass':'Not demonstrated')+metric('19 m B-double',bd?'Pass':'Not demonstrated')+
      metric('Centres nearby',String(centres.length))+metric('Facilities nearby',String(facilities.length))+
      metric('State test',asState)+metric('Regional test',asReg)+'</div>'+
      '<div class="corridor-warning">Traffic'+(trafficKnown?' is inherited from the declared-road record, not measured specifically for this corridor.':' is unavailable and has not been assumed to pass.')+' “Connects” is currently approximated from evidence within 2.2 km of the selected mapped line; this result is decision support, not an official recategorisation.</div></div>';
}

function metric(label,value){return '<div class="corridor-metric">'+label+'<strong>'+value+'</strong></div>';}
