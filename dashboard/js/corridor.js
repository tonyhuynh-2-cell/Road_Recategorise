// corridor.js — interactive selected-corridor assessment with an optional waypoint.
// The result deliberately distinguishes corridor-spatial evidence from road-wide/unavailable inputs.

var corridorState = newCorridorState(false);
var corridorOverlay = L.layerGroup().addTo(map);
var corridorAddressCache = {};
var corridorGeocodeQueue = Promise.resolve();
var corridorGeocodeLast = 0;

function newCorridorState(waypointEnabled) {
    return { roadKey: null, roadKeys: [], roadName: '', points: [], markers: [], waypointEnabled: !!waypointEnabled,
        route: null, routeLayer: null, routeLayers: [], assessment: null, selectedCategory: null };
}

function corridorPointLabels() { return corridorState.waypointEnabled ? ['A', 'W', 'B'] : ['A', 'B']; }

function corridorNextInstruction() {
    var labels = corridorPointLabels(), next = labels[corridorState.points.length];
    if (corridorState.waypointEnabled && corridorState.points.length === 2 && !corridorState.points.some(function(p){return p.pointLabel==='W';})) next='W';
    if (next === 'A') return 'Select the start point on a road.';
    if (next === 'W') return 'Select the waypoint at the road or intersection where the corridor turns.';
    if (next === 'B') return corridorState.waypointEnabled ? 'Select the end point on the connecting road.' : 'Select the end point on the same road.';
    return 'Corridor selected. Clear the selection to start again.';
}

function beginCorridorAssessment() {
    if (!map.hasLayer(corridorOverlay)) corridorOverlay.addTo(map);
    if (corridorState.evidence) showConnections(corridorState.evidence);
    nswView = 'all';
    if (nswLayer) { nswLayer.setStyle(nswStyle); if (!map.hasLayer(nswLayer)) map.addLayer(nswLayer); }
    document.getElementById('road-search').style.display = '';
    document.getElementById('corridor-status').textContent = corridorNextInstruction();
}

function setCorridorVisibility(visible) {
    if (visible) {
        if (!map.hasLayer(corridorOverlay)) corridorOverlay.addTo(map);
        if (corridorState.evidence) showConnections(corridorState.evidence);
        return;
    }
    if (map.hasLayer(corridorOverlay)) map.removeLayer(corridorOverlay);
    if (corridorState.evidence && _lastConnEv === corridorState.evidence) {
        clearConnections();
        _lastConnEv = null;
    }
}

function resetCorridorAssessment(preserveWaypoint) {
    var waypointEnabled = preserveWaypoint === true && corridorState.waypointEnabled;
    corridorOverlay.clearLayers();
    clearConnections();
    _lastConnEv = null;
    corridorState = newCorridorState(waypointEnabled);
    ['a', 'w', 'b'].forEach(function (id) {
        var el = document.getElementById('corridor-point-' + id); if (el) {
            el.querySelector('input').value = '';
            el.querySelector('input').classList.remove('is-coordinates');
            el.classList.remove('is-searching');
        }
    });
    var result = document.getElementById('corridor-result'); if (result) { result.hidden = true; result.innerHTML = ''; }
    var waypointCard = document.getElementById('corridor-point-w'); if (waypointCard) waypointCard.hidden = !waypointEnabled;
    var waypointDot = document.getElementById('corridor-waypoint-dot'); if (waypointDot) waypointDot.hidden = !waypointEnabled;
    var toggle = document.getElementById('corridor-waypoint-toggle'); if (toggle) toggle.textContent = waypointEnabled ? '− Remove waypoint' : '＋ Add waypoint';
    var status = document.getElementById('corridor-status'); if (status) status.textContent = corridorNextInstruction();
}

function toggleCorridorWaypoint() {
    var enabling = !corridorState.waypointEnabled;
    // If a two-point route is already complete, retain its endpoints and ask for the waypoint,
    // which will be inserted between them. Otherwise restart with the selected mode.
    if (enabling && corridorState.points.length === 2) {
        corridorState.waypointEnabled = true;
        document.getElementById('corridor-point-w').hidden = false;
        document.getElementById('corridor-waypoint-dot').hidden = false;
        document.getElementById('corridor-waypoint-toggle').textContent = '− Remove waypoint';
        clearCorridorRouteResult();
        document.getElementById('corridor-status').textContent = 'Select the waypoint at the road or intersection where the corridor turns.';
        return;
    }
    corridorState.waypointEnabled = enabling;
    resetCorridorAssessment(true);
}

function clearCorridorRouteResult() {
    (corridorState.routeLayers || []).forEach(function(layer){ corridorOverlay.removeLayer(layer); });
    corridorState.routeLayers = []; corridorState.routeLayer = null; corridorState.route = null; corridorState.assessment = null;
    clearConnections(); _lastConnEv = null; corridorState.evidence = null;
    var result=document.getElementById('corridor-result'); if(result){result.hidden=true;result.innerHTML='';}
}

function corridorRoadClick(feature, layer, e) {
    var key = roadKeyOf(feature.properties);
    if (!key) return;
    var complete = corridorState.points.length === corridorPointLabels().length;
    if (complete) resetCorridorAssessment(true);
    if (!corridorState.waypointEnabled && corridorState.roadKey && corridorState.roadKey !== key) resetCorridorAssessment(true);
    if (!corridorState.roadKey) {
        corridorState.roadKey = key;
        corridorState.roadName = roadName((NSW_AGG || {})[key] || feature.properties);
    }
    var snapped = corridorSnapToRoad(key, e.latlng);
    if (!snapped) return;
    snapped.roadKey = key;
    acceptCorridorPoint(snapped);
}

function acceptCorridorPoint(snapped) {
    var labels = corridorPointLabels(), insertWaypoint = corridorState.waypointEnabled && corridorState.points.length === 2 && !corridorState.points.some(function(p){return p.pointLabel==='W';});
    var label = insertWaypoint ? 'W' : labels[corridorState.points.length];
    snapped.pointLabel = label;
    if (insertWaypoint) corridorState.points.splice(1, 0, snapped); else corridorState.points.push(snapped);
    if (corridorState.roadKeys.indexOf(snapped.roadKey) < 0) corridorState.roadKeys.push(snapped.roadKey);
    var marker = L.circleMarker(snapped.latlng, { pane: 'connPane', renderer: connRenderer, radius: label === 'W' ? 7 : label === 'A' ? 7 : 8,
        color: label === 'A' ? '#292524' : '#fff', weight: label === 'A' ? 3 : 2,
        fillColor: label === 'A' ? '#fff' : label === 'W' ? '#2563eb' : '#dc2626', fillOpacity: 1 })
        .bindTooltip(label, { permanent: true, direction: 'center', className: 'corridor-marker-label' }).addTo(corridorOverlay);
    if (insertWaypoint) corridorState.markers.splice(1, 0, marker); else corridorState.markers.push(marker);
    renderCorridorPoint(label, snapped);
    if (corridorState.points.length === labels.length) finishCorridorAssessment();
    else document.getElementById('corridor-status').textContent = corridorNextInstruction();
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
    var value = el.querySelector('input');
    value.value = 'Finding street address…';
    value.classList.remove('is-coordinates');
    corridorReverseAddress(p.latlng).then(function (address) {
        // Ignore a late response if this endpoint was cleared or replaced.
        var index = corridorState.points.map(function(point){return point.pointLabel;}).indexOf(label);
        if (corridorState.points[index] !== p) return;
        if (address) { p.address = address; value.value = address; value.classList.remove('is-coordinates'); }
        else { value.value = corridorCoordinateText(p.latlng); value.classList.add('is-coordinates'); }
    });
}

function corridorCoordinateText(latlng) { return latlng.lat.toFixed(6) + ', ' + latlng.lng.toFixed(6); }

function searchCorridorPoint(label) {
    var form = document.getElementById('corridor-point-' + label.toLowerCase());
    var input = form.querySelector('input'), query = input.value.trim();
    if (!query) return false;
    form.classList.add('is-searching');
    var pointDescription = label === 'A' ? 'the start point…' : label === 'W' ? 'the waypoint…' : 'the end point…';
    document.getElementById('corridor-status').textContent = 'Searching for ' + pointDescription;
    corridorForwardGeocode(query).then(function (latlng) {
        if (!latlng) throw new Error('No location found');
        if (label === 'A') resetCorridorAssessment(true);
        else if (!corridorState.roadKey || !corridorState.points.length) throw new Error('Select the start point first');
        var snapped = (label === 'A' || corridorState.waypointEnabled) ? corridorSnapToAnyRoad(latlng) : corridorSnapToRoad(corridorState.roadKey, latlng);
        if (!snapped || snapped.d > 2000) throw new Error(corridorState.waypointEnabled ? 'No matching mapped road found' : 'No matching point found on the selected road');
        snapped.roadKey = roadKeyOf(snapped.layer.feature.properties);
        if (label === 'A') {
            corridorState.roadKey = snapped.roadKey;
            corridorState.roadName = roadName((NSW_AGG || {})[corridorState.roadKey] || snapped.layer.feature.properties);
        }
        if (label === 'B' && corridorState.waypointEnabled && !corridorState.points.some(function(p){return p.pointLabel==='W';})) throw new Error('Select the waypoint before the end point');
        acceptCorridorPoint(snapped);
    }).catch(function (error) {
        document.getElementById('corridor-status').textContent = error.message + '. Try a more specific address or click the map.';
    }).finally(function () { form.classList.remove('is-searching'); });
    return false;
}

function corridorForwardGeocode(query) {
    // Latitude, longitude may be entered directly without an external lookup.
    var match = query.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (match) {
        var lat=+match[1], lon=+match[2];
        return Promise.resolve(lat>=-90 && lat<=90 && lon>=-180 && lon<=180 ? L.latLng(lat,lon) : null);
    }
    var url='https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=au&limit=1&q='+encodeURIComponent(query);
    corridorGeocodeQueue = corridorGeocodeQueue.catch(function(){}).then(function(){
        var wait=Math.max(0,1000-(Date.now()-corridorGeocodeLast));
        return new Promise(function(resolve){setTimeout(resolve,wait);});
    }).then(function(){
        corridorGeocodeLast=Date.now();
        return fetch(url,{headers:{'Accept':'application/json'}}).then(function(response){if(!response.ok)throw new Error('Address search unavailable');return response.json();});
    }).then(function(rows){return rows.length?L.latLng(+rows[0].lat,+rows[0].lon):null;});
    return corridorGeocodeQueue;
}

function corridorSnapToAnyRoad(latlng) {
    var best=null, registry=window.NSW_ROAD_LAYERS||{};
    Object.keys(registry).forEach(function(key){
        var candidate=corridorSnapToRoad(key,latlng);
        if(candidate&&(!best||candidate.d<best.d)){candidate.roadKey=key;best=candidate;}
    });
    return best;
}

// OpenStreetMap Nominatim provides a best-effort reverse lookup. Calls are serialised and cached;
// if street + suburb/locality + postcode are not all present, the UI follows the product rule and
// displays coordinates only rather than presenting a partial address as authoritative.
function corridorReverseAddress(latlng) {
    var cacheKey = latlng.lat.toFixed(6) + ',' + latlng.lng.toFixed(6);
    if (corridorAddressCache[cacheKey] !== undefined) return Promise.resolve(corridorAddressCache[cacheKey]);
    corridorGeocodeQueue = corridorGeocodeQueue.catch(function () {}).then(function () {
        var wait = Math.max(0, 1000 - (Date.now() - corridorGeocodeLast));
        return new Promise(function (resolve) { setTimeout(resolve, wait); });
    }).then(function () {
        corridorGeocodeLast = Date.now();
        var url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&zoom=18&lat=' +
            encodeURIComponent(latlng.lat) + '&lon=' + encodeURIComponent(latlng.lng);
        return fetch(url, { headers: { 'Accept': 'application/json' } }).then(function (response) {
            if (!response.ok) throw new Error('Reverse geocoding unavailable');
            return response.json();
        }).then(function (data) {
            var a = data.address || {};
            var street = [a.house_number, a.road || a.pedestrian || a.residential].filter(Boolean).join(' ');
            var suburb = a.suburb || a.neighbourhood || a.city_district || a.town || a.city || a.village;
            var postcode = a.postcode;
            var complete = street && suburb && postcode ? street + ', ' + suburb + ' NSW ' + postcode : null;
            corridorAddressCache[cacheKey] = complete;
            return complete;
        }).catch(function () { corridorAddressCache[cacheKey] = null; return null; });
    });
    return corridorGeocodeQueue;
}

function swapCorridorPoints() {
    if (corridorState.points.length !== corridorPointLabels().length) return;
    if (corridorState.waypointEnabled) {
        var endPoint=corridorState.points[2], endMarker=corridorState.markers[2];
        corridorState.points[2]=corridorState.points[0]; corridorState.points[0]=endPoint;
        corridorState.markers[2]=corridorState.markers[0]; corridorState.markers[0]=endMarker;
        corridorState.points[0].pointLabel='A'; corridorState.points[1].pointLabel='W'; corridorState.points[2].pointLabel='B';
    } else {
        corridorState.points.reverse(); corridorState.markers.reverse();
        corridorState.points[0].pointLabel='A'; corridorState.points[1].pointLabel='B';
    }
    corridorState.markers[0].setTooltipContent('A').setStyle({ color:'#292524', weight:3, fillColor:'#fff' }).setRadius(7);
    var endIndex=corridorState.points.length-1;
    corridorState.markers[endIndex].setTooltipContent('B').setStyle({ color:'#fff', weight:2, fillColor:'#dc2626' }).setRadius(8);
    renderCorridorPoint('A', corridorState.points[0]);
    if (corridorState.waypointEnabled) renderCorridorPoint('W', corridorState.points[1]);
    renderCorridorPoint('B', corridorState.points[endIndex]);
    finishCorridorAssessment();
}

function corridorGraph(keys, snaps) {
    var nodes = {}, edges = {}, roadNodes = {}, edgeId = 0;
    function nk(c) { return c[0].toFixed(6) + ',' + c[1].toFixed(6); }
    function addNode(c, roadKey) { var k = nk(c); if (!nodes[k]) nodes[k] = c; if (!edges[k]) edges[k] = []; if(roadKey){if(!roadNodes[roadKey])roadNodes[roadKey]={};roadNodes[roadKey][k]=true;} return k; }
    function addEdge(a, b, props, roadKey) { var ak = addNode(a,roadKey), bk = addNode(b,roadKey), w = map.distance([a[1], a[0]], [b[1], b[0]]); edges[ak].push({ to: bk, w: w, p: props }); edges[bk].push({ to: ak, w: w, p: props }); edgeId++; }
    keys.forEach(function(key){ ((window.NSW_ROAD_LAYERS || {})[key] || []).forEach(function (ly) { corridorCoords(ly.feature.geometry).forEach(function (line) {
        var inserts = {};
        snaps.forEach(function (s, si) { if (s.layer === ly && s.line === line) (inserts[s.edge] || (inserts[s.edge] = [])).push({ t: s.t, c: [s.latlng.lng, s.latlng.lat], si: si }); });
        for (var i = 1; i < line.length; i++) {
            var pts = [{ t: 0, c: line[i - 1] }].concat((inserts[i - 1] || []).sort(function(a,b){return a.t-b.t;}), [{ t: 1, c: line[i] }]);
            for (var j = 1; j < pts.length; j++) addEdge(pts[j - 1].c, pts[j].c, ly.feature.properties, key);
        }
    }); }); });
    // Mapped centre-lines from different datasets do not always share an identical vertex. At an
    // explicit waypoint only, bridge a small cartographic gap to a nearby selected road so the
    // user's chosen intersection can be traversed without enabling arbitrary road-to-road jumps.
    if (snaps.length === 3) {
        var waypointKey=nk([snaps[1].latlng.lng,snaps[1].latlng.lat]), waypointCoord=nodes[waypointKey];
        keys.forEach(function(key){
            if(key===snaps[1].roadKey||!waypointCoord)return;
            var nearest=null;
            Object.keys(roadNodes[key]||{}).forEach(function(nodeKey){var c=nodes[nodeKey],d=map.distance([waypointCoord[1],waypointCoord[0]],[c[1],c[0]]);if(!nearest||d<nearest.d)nearest={key:nodeKey,c:c,d:d};});
            if(nearest&&nearest.d<=25&&nearest.key!==waypointKey)addEdge(waypointCoord,nearest.c,snaps[1].layer.feature.properties,snaps[1].roadKey);
        });
    }
    return { nodes: nodes, edges: edges, snapKeys: snaps.map(function(s){return nk([s.latlng.lng,s.latlng.lat]);}) };
}

function corridorShortestPath(g, start, end) {
    var dist = {}, prev = {}, used = {}, q = Object.keys(g.nodes); q.forEach(function(k){dist[k]=Infinity;}); dist[start]=0;
    while (q.length) { q.sort(function(a,b){return dist[a]-dist[b];}); var u=q.shift(); if (!isFinite(dist[u]) || u===end) break; used[u]=true;
        (g.edges[u]||[]).forEach(function(ed){ if (!used[ed.to] && dist[u]+ed.w<dist[ed.to]) { dist[ed.to]=dist[u]+ed.w; prev[ed.to]={from:u,edge:ed}; } }); }
    if (!isFinite(dist[end])) return null;
    var keys=[end], props=[], cur=end; while(cur!==start){ var p=prev[cur]; if(!p)return null; props.push(p.edge.p); cur=p.from; keys.push(cur); } keys.reverse(); props.reverse();
    return { latlngs: keys.map(function(k){var c=g.nodes[k];return [c[1],c[0]];}), props: props, metres: dist[end] };
}

function corridorPointToRouteMetres(item, route) {
    if (item.lat == null || item.lon == null) return Infinity;
    var p=L.latLng(item.lat,item.lon), best=Infinity;
    for(var i=1;i<route.latlngs.length;i++){var a=route.latlngs[i-1],b=route.latlngs[i];var q=corridorProject(p,[a[1],a[0]],[b[1],b[0]]);best=Math.min(best,q.d);}
    return best;
}

function finishCorridorAssessment() {
    var keys=corridorState.waypointEnabled ? corridorState.roadKeys.slice() : [corridorState.roadKey];
    var graph=corridorGraph(keys,corridorState.points), route;
    if (corridorState.waypointEnabled) {
        var firstLeg=corridorShortestPath(graph,graph.snapKeys[0],graph.snapKeys[1]);
        var secondLeg=corridorShortestPath(graph,graph.snapKeys[1],graph.snapKeys[2]);
        if (firstLeg && secondLeg) route={latlngs:firstLeg.latlngs.concat(secondLeg.latlngs.slice(1)),props:firstLeg.props.concat(secondLeg.props),metres:firstLeg.metres+secondLeg.metres};
    } else route=corridorShortestPath(graph,graph.snapKeys[0],graph.snapKeys[1]);
    if (!route) { document.getElementById('corridor-status').textContent = 'The selected roads are not connected in the mapped network at that waypoint. Move the waypoint closer to the intersection or clear the selection and try again.'; return; }
    corridorState.route = route;
    (corridorState.routeLayers || []).forEach(function (layer) { corridorOverlay.removeLayer(layer); });
    var routeBorder = L.polyline(route.latlngs, { pane:'connPane', renderer:connRenderer, color:'#24145f', weight:10, opacity:.95, lineCap:'round', lineJoin:'round' }).addTo(corridorOverlay);
    corridorState.routeLayer = L.polyline(route.latlngs, { pane:'connPane', renderer:connRenderer, color:'#4f2df5', weight:6, opacity:1, lineCap:'round', lineJoin:'round' }).addTo(corridorOverlay);
    corridorState.routeLayers = [routeBorder, corridorState.routeLayer];
    map.fitBounds(corridorState.routeLayer.getBounds().pad(.15), { maxZoom: 14 });
    document.getElementById('corridor-status').textContent = 'Selected corridor assessed from available evidence.';
    renderCorridorAssessment(route);
}

function renderCorridorAssessment(route) {
    var routeKeys=[];
    route.props.forEach(function(p){var key=roadKeyOf(p);if(key&&routeKeys.indexOf(key)<0)routeKeys.push(key);});
    if (!routeKeys.length) routeKeys=corridorState.roadKeys.length?corridorState.roadKeys.slice():[corridorState.roadKey];
    var evidenceSets=routeKeys.map(function(key){return (window.NSW_EVID||{})[key]||{};});
    var ev={centres:[],hospitals:[],dests:[],employment:[]};
    evidenceSets.forEach(function(item){['centres','hospitals','dests','employment'].forEach(function(type){ev[type]=ev[type].concat(item[type]||[]);});});
    var k=routeKeys[0]||corridorState.roadKey, crit=(window.NSW_CRIT||{})[k]||{}, unique={};
    var routeNames=routeKeys.map(function(key){return roadName((NSW_AGG||{})[key]||{})||key;}).filter(function(name,index,items){return items.indexOf(name)===index;});
    corridorState.roadName=routeNames.join(' → ')||corridorState.roadName;
    var urbanArea=crit.area==='urban';
    var centres=(ev.centres||[]).filter(function(x){return corridorPointToRouteMetres(x,route)<=2200;}).filter(function(x){var n=String(x.name||'').toLowerCase();if(unique[n])return false;unique[n]=1;return true;});
    var hospitals=(ev.hospitals||[]).filter(function(x){return corridorPointToRouteMetres(x,route)<=2200;});
    var dests=(ev.dests||[]).filter(function(x){return corridorPointToRouteMetres(x,route)<=2200;});
    var employment=(ev.employment||[]).filter(function(x){return x.size_qualifies && corridorPointToRouteMetres(x,route)<=2200;});
    var facilities=[].concat(hospitals,dests,employment);
    var pbs1=route.props.length && route.props.every(function(p){return p.has_pbs1===1 || p.pbs1_coverage>0.8;});
    var bd=route.props.length && route.props.every(function(p){return p.has_bdouble===1 || p.bdouble_coverage>=0.8;});
    var pbs2b=route.props.length && route.props.some(function(p){return p.has_pbs2b===1;});
    var centrePass=centres.length>=2, destPass=facilities.length>=1 && centres.length>=1, ldr=route.metres>=25000 && centrePass;
    var trafficKnown=crit.opt && crit.opt.traffic!==null && crit.opt.traffic!==undefined;
    // A declared-road traffic count is not corridor-specific, so disclose it but never count it in
    // the selected-line result. A future point/section traffic import can replace this limitation.
    var stateOpts=(centrePass?1:0)+(destPass?1:0)+(!urbanArea&&ldr?1:0);
    var regOpts=(centrePass?1:0)+(destPass?1:0);
    var asState=xverdict(stateOpts,pbs1), asReg=xverdict(regOpts,bd);
    var nltn=route.props.some(function(p){return p._nltn===true;});
    var natMet=(nltn?1:0)+(centrePass?1:0)+(facilities.length?1:0), asNat=pbs2b?(natMet>=2?'green':natMet===1?'orange':'red'):'red';
    corridorState.evidence = { centres: centres, hospitals: hospitals, dests: dests, employment: employment };
    // Reuse the overview map's evidence rings and labels, but only with items spatially associated
    // with this selected corridor. Whole-road evidence outside the selection is excluded.
    showConnections(corridorState.evidence);
    var nationalCriteria = [
        criterion('S-06', 'mandatory', 'PBS Level 2B access', pbs2b, 'Mandatory vehicle-access gate'),
        criterion('S-01', 'optional', 'National Land Transport Network', nltn, 'Selected geometry on NLTN'),
        criterion('S-02 · S-03', 'optional', 'Connects qualifying centres', centrePass, corridorCentreSummary(centres)),
        criterion('S-04 · S-05', 'optional', 'Connects ports, airports, intermodals or other facilities', facilities.length > 0, corridorFacilitySummary(facilities))
    ];
    var stateCriteria = [
        criterion('S-09', 'mandatory', 'PBS Level 1 access', pbs1, 'Mandatory vehicle-access gate'),
        criterion('Unnumbered', 'mandatory', 'No load limits on structures', null, 'Data unavailable'),
        criterion('Unnumbered', 'mandatory', 'Does not closely parallel a State Road', null, 'Not recalculated for selected corridor'),
        criterion(urbanArea ? 'S-10' : 'S-07', 'optional', 'Connects qualifying population centres', centrePass, corridorCentreSummary(centres)),
        criterion(urbanArea ? 'S-11' : 'S-08', 'optional', 'Connects a qualifying facility to a centre', destPass, corridorFacilitySummary(facilities)),
        criterion('Unnumbered', 'optional', 'Traffic volume and heavy-vehicle percentage', null, 'No corridor-specific count')
    ];
    if (!urbanArea) stateCriteria.push(criterion('Unnumbered', 'optional', 'Long-distance rural connection', ldr, (route.metres/1000).toFixed(2)+' km selected'));
    var regionalCriteria = [
        criterion('R-04', 'mandatory', '19 m B-double access', bd, 'Mandatory vehicle-access gate'),
        criterion('Unnumbered', 'mandatory', 'No load limits on structures', null, 'Data unavailable'),
        criterion(urbanArea ? 'R-05' : 'R-01', 'optional', 'Connects qualifying population centres', centrePass, corridorCentreSummary(centres)),
        criterion(urbanArea ? 'R-06' : 'R-02', 'optional', 'Connects a qualifying facility to a centre', destPass, corridorFacilitySummary(facilities)),
        criterion('Unnumbered', 'optional', 'Traffic volume and heavy-vehicle percentage', null, 'No corridor-specific count')
    ];
    if (!urbanArea) {
        regionalCriteria.push(criterion('R-03', 'optional', 'Road-train access', null, 'Not available at selected-corridor resolution'));
        regionalCriteria.push(criterion('Unnumbered', 'optional', 'Connects two State Roads', null, 'Not recalculated for selected corridor'));
    }
    corridorState.assessment = {
        national: { verdict: asNat, gate: pbs2b, optional: natMet, label: 'Nationally Significant', criteria: nationalCriteria },
        state: { verdict: asState, gate: pbs1, optional: stateOpts, label: 'State', criteria: stateCriteria },
        regional: { verdict: asReg, gate: bd, optional: regOpts, label: 'Regional', criteria: regionalCriteria }
    };
    corridorState.selectedCategory = null;
    var result=document.getElementById('corridor-result'); result.hidden=false;
    result.innerHTML='<div class="corridor-result-card"><h3>Test selected corridor</h3><div class="corridor-test-buttons">'+
      '<button class="corridor-test-btn" data-corridor-category="national" onclick="selectCorridorCategory(\'national\')">Test as Nationally Significant</button>'+
      '<button class="corridor-test-btn" data-corridor-category="state" onclick="selectCorridorCategory(\'state\')">Test as State Road</button>'+
      '<button class="corridor-test-btn" data-corridor-category="regional" onclick="selectCorridorCategory(\'regional\')">Test as Regional Road</button></div>'+
      '<div class="corridor-test-outcome" id="corridor-test-outcome"><strong>Choose a category to test</strong><span>'+corridorState.roadName+' · '+(route.metres/1000).toFixed(2)+' km selected</span></div>'+
      '<div class="corridor-criteria-list" id="corridor-criteria-list"></div></div>'+
      '<div class="corridor-result-card"><h3>Selected-corridor evidence</h3><div class="corridor-grid">'+
      metric('PBS Level 1',pbs1?'Pass':'Not demonstrated')+metric('19 m B-double',bd?'Pass':'Not demonstrated')+
      metric('Centres nearby',String(centres.length))+metric('Facilities nearby',String(facilities.length))+
      metric('Selected length',(route.metres/1000).toFixed(2)+' km')+metric('Traffic',trafficKnown?'Road-wide only':'Not available')+'</div>'+
      '<div class="corridor-evidence-names"><b>Centres shown on map:</b> '+corridorCentreSummary(centres)+'<br><b>Facilities shown on map:</b> '+corridorFacilitySummary(facilities)+'</div>'+
      '<div class="corridor-warning">Traffic'+(trafficKnown?' is inherited from the declared-road record, not measured specifically for this corridor.':' is unavailable and has not been assumed to pass.')+' “Connects” is currently approximated from evidence within 2.2 km of the selected mapped line; this result is decision support, not an official recategorisation.</div></div>';
}

function selectCorridorCategory(category) {
    var assessment = corridorState.assessment && corridorState.assessment[category];
    if (!assessment) return;
    corridorState.selectedCategory = category;
    document.querySelectorAll('[data-corridor-category]').forEach(function (button) {
        button.classList.toggle('active', button.getAttribute('data-corridor-category') === category);
    });
    var outcome = document.getElementById('corridor-test-outcome');
    if (!outcome) return;
    var verdictLabel = assessment.verdict === 'green' ? 'Passes criteria'
        : assessment.verdict === 'orange' ? 'Passes one criterion'
            : 'Does not meet criteria';
    var gateLabel = assessment.gate ? 'Mandatory vehicle-access gate demonstrated' : 'Mandatory vehicle-access gate not demonstrated';
    outcome.setAttribute('data-verdict', assessment.verdict);
    outcome.innerHTML = '<strong>' + assessment.label + ': ' + verdictLabel + '</strong><span>' +
        gateLabel + ' · ' + assessment.optional + ' qualifying criterion' + (assessment.optional === 1 ? '' : 's') +
        ' · ' + (corridorState.route.metres / 1000).toFixed(2) + ' km selected</span>';
    var list = document.getElementById('corridor-criteria-list');
    if (list) {
        list.innerHTML = corridorCriteriaSection('Mandatory criteria', assessment.criteria.filter(function(item){ return item.group === 'mandatory'; })) +
            corridorCriteriaSection(category === 'national' ? 'Optional / qualifying criteria' : 'Optional criteria', assessment.criteria.filter(function(item){ return item.group === 'optional'; }));
    }
}

function metric(label,value){return '<div class="corridor-metric">'+label+'<strong>'+value+'</strong></div>';}
function criterion(id, group, name, passed, detail) { return { id:id, group:group, name:name, passed:passed, detail:detail }; }
function corridorCentreSummary(items) { return items.length ? items.map(function(x){return x.name;}).join(', ') : 'None identified near selected corridor'; }
function corridorFacilitySummary(items) { return items.length ? items.map(function(x){return x.name;}).join(', ') : 'None identified near selected corridor'; }
function corridorCriteriaSection(title, items) {
    if (!items.length) return '';
    return '<section class="corridor-criteria-section"><h4>'+title+'</h4>'+items.map(corridorCriterionHTML).join('')+'</section>';
}
function corridorCriterionHTML(item) {
    var state = item.passed === true ? 'pass' : item.passed === false ? 'fail' : 'unknown';
    var icon = state === 'pass' ? '✓' : state === 'fail' ? '×' : '?';
    var label = state === 'pass' ? 'Pass' : state === 'fail' ? 'Fail' : 'Not assessed';
    return '<div class="corridor-criterion '+state+'"><span class="corridor-criterion-icon">'+icon+'</span><span class="corridor-criterion-name"><span class="corridor-criterion-id">'+item.id+'</span>'+item.name+'<small>'+item.detail+'</small></span><span class="corridor-criterion-status">'+label+'</span></div>';
}
