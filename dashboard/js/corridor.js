// corridor.js — interactive selected-corridor assessment with an optional waypoint.
// The result deliberately distinguishes corridor-spatial evidence from road-wide/unavailable inputs.

var corridorSavedAssessments = [];
var corridorState = newCorridorState(false, 1);
var corridorOverlay = L.layerGroup().addTo(map);
if (!map.getPane('corridorPointPane')) {
    map.createPane('corridorPointPane');
    map.getPane('corridorPointPane').style.zIndex = 675;
}
var corridorAddressCache = {};
var corridorGeocodeQueue = Promise.resolve();
var corridorGeocodeLast = 0;
var corridorLocalChunks = {};
var corridorLocalRoadLayers = {};
var corridorDeclaredClick = { at: 0, latlng: null };
var corridorPickSequence = 0;

function newCorridorState(waypointEnabled, routeNumber) {
    return { roadKey: null, roadKeys: [], roadName: '', points: [], markers: [], waypointEnabled: !!waypointEnabled,
        route: null, routeLayer: null, routeLayers: [], assessment: null, selectedCategory: null,
        nhvrCoverageType: 'pbs2b', nhvrCoverageVisible: false, nhvrCoverageLayers: [],
        routeNumber: routeNumber || corridorSavedAssessments.length + 1 };
}

function corridorPointLabels() { return corridorState.waypointEnabled ? ['A', 'W', 'B'] : ['A', 'B']; }

function corridorNextInstruction() {
    var labels = corridorPointLabels(), next = labels[corridorState.points.length];
    if (corridorState.waypointEnabled && corridorState.points.length === 2 && !corridorState.points.some(function(p){return p.pointLabel==='W';})) next='W';
    if (next === 'A') return 'Select the start point on a road.';
    if (next === 'W') return 'Select the waypoint at the road or intersection where the corridor turns.';
    if (next === 'B') return corridorState.waypointEnabled ? 'Select the end point. The route will pass through the waypoint.' : 'Select the end point. The shortest available road route will be assessed.';
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

function resetCorridorAssessment(preserveWaypoint, preserveSaved) {
    corridorPickSequence++; // cancel any asynchronous local-road pick still in flight
    var waypointEnabled = preserveWaypoint === true && corridorState.waypointEnabled;
    if (preserveSaved === true) {
        (corridorState.markers || []).concat(corridorState.routeLayers || [], corridorState.nhvrCoverageLayers || []).forEach(function(layer){corridorOverlay.removeLayer(layer);});
    } else {
        corridorOverlay.clearLayers();
        corridorSavedAssessments = [];
    }
    clearConnections();
    _lastConnEv = null;
    corridorState = newCorridorState(waypointEnabled, corridorSavedAssessments.length + 1);
    ['a', 'w', 'b'].forEach(function (id) {
        var el = document.getElementById('corridor-point-' + id); if (el) {
            el.querySelector('input').value = '';
            el.querySelector('input').classList.remove('is-coordinates');
            el.querySelector('.corridor-point-coordinates').textContent = '';
            el.classList.remove('is-searching');
        }
    });
    var result = document.getElementById('corridor-result'); if (result) { result.hidden = true; result.innerHTML = ''; }
    var waypointCard = document.getElementById('corridor-point-w'); if (waypointCard) waypointCard.hidden = !waypointEnabled;
    var waypointDot = document.getElementById('corridor-waypoint-dot'); if (waypointDot) waypointDot.hidden = !waypointEnabled;
    var toggle = document.getElementById('corridor-waypoint-toggle'); if (toggle) toggle.textContent = waypointEnabled ? '− Remove waypoint' : '＋ Add waypoint';
    var status = document.getElementById('corridor-status'); if (status) status.textContent = corridorNextInstruction();
    renderSavedCorridorAssessments();
    renderMapLegend();
}

function startAnotherCorridorAssessment() {
    if (!corridorState.route || !corridorState.assessment) return;
    corridorPickSequence++;
    corridorState.markers.forEach(function(marker,index){
        if(marker.dragging)marker.dragging.disable();
        var point=corridorState.points[index];
        marker.setIcon(corridorMarkerIcon(point&&point.pointLabel||'',true));
        marker.setTooltipContent('Retained route '+corridorState.routeNumber+' point '+(point&&point.pointLabel||''));
    });
    corridorSavedAssessments.push(corridorState);
    clearConnections(); _lastConnEv = null;
    corridorState = newCorridorState(false, corridorSavedAssessments.length + 1);
    ['a', 'w', 'b'].forEach(function(id){
        var el=document.getElementById('corridor-point-'+id); if(!el)return;
        el.querySelector('input').value=''; el.querySelector('input').classList.remove('is-coordinates'); el.classList.remove('is-searching');
        el.querySelector('.corridor-point-coordinates').textContent='';
    });
    document.getElementById('corridor-point-w').hidden=true;
    document.getElementById('corridor-waypoint-dot').hidden=true;
    document.getElementById('corridor-waypoint-toggle').textContent='＋ Add waypoint';
    var result=document.getElementById('corridor-result'); result.hidden=true; result.innerHTML='';
    document.getElementById('corridor-status').textContent='Route '+corridorState.routeNumber+': '+corridorNextInstruction();
    renderSavedCorridorAssessments();
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
    resetCorridorAssessment(true, true);
}

function clearCorridorRouteResult() {
    (corridorState.routeLayers || []).concat(corridorState.nhvrCoverageLayers || []).forEach(function(layer){ corridorOverlay.removeLayer(layer); });
    corridorState.routeLayers = []; corridorState.routeLayer = null; corridorState.route = null; corridorState.assessment = null;
    corridorState.nhvrCoverageLayers = []; corridorState.nhvrCoverageVisible = false;
    clearConnections(); _lastConnEv = null; corridorState.evidence = null;
    var result=document.getElementById('corridor-result'); if(result){result.hidden=true;result.innerHTML='';}
    renderMapLegend();
}

function corridorRoadLayers(key) {
    return ((window.NSW_ROAD_LAYERS || {})[key] || []).concat(corridorLocalRoadLayers[key] || []);
}

function corridorRoadProperties(key) {
    var declared = (window.NSW_AGG || {})[key];
    if (declared) return declared;
    var local = (corridorLocalRoadLayers[key] || [])[0];
    return local && local.feature ? local.feature.properties : {};
}

function corridorRoadDisplayName(properties) {
    if (properties && properties._corridorLocal) return properties.name || properties.road_name || 'Unnamed local road';
    return roadName(properties || {});
}

function corridorLocalChunkKeys(latlng) {
    var meta = window.LOCAL_ROAD_MANIFEST, geometry = meta && meta.geometry;
    if (!geometry) return [];
    var step = +geometry.chunk_degrees || 0.25;
    var allowed = window._STATEWIDE_LOCAL_KEYSET ||
        (window._STATEWIDE_LOCAL_KEYSET = new Set(geometry.chunks || []));
    var cx = Math.floor(latlng.lng / step), cy = Math.floor(latlng.lat / step), keys = [];
    // Include neighbouring tiles so snapping remains reliable along chunk boundaries.
    for (var x = cx - 1; x <= cx + 1; x++) for (var y = cy - 1; y <= cy + 1; y++) {
        var key = x + '_' + y;
        if (allowed.has(key)) keys.push(key);
    }
    return keys;
}

function corridorLocalChunkKeysForPoints(points) {
    var meta = window.LOCAL_ROAD_MANIFEST, geometry = meta && meta.geometry;
    if (!geometry || !points.length) return [];
    var step = +geometry.chunk_degrees || 0.25;
    var allowed = window._STATEWIDE_LOCAL_KEYSET ||
        (window._STATEWIDE_LOCAL_KEYSET = new Set(geometry.chunks || []));
    var envelope=corridorRouteEnvelope(points);
    var x0 = Math.floor(envelope.west / step);
    var x1 = Math.floor(envelope.east / step);
    var y0 = Math.floor(envelope.south / step);
    var y1 = Math.floor(envelope.north / step);
    var keys = [];
    for (var x = x0; x <= x1; x++) for (var y = y0; y <= y1; y++) {
        var key = x + '_' + y;
        if (allowed.has(key)) keys.push(key);
    }
    return keys;
}

function corridorRegisterLocalGeoJSON(geojson) {
    (geojson.features || []).forEach(function (feature) {
        if (!feature.geometry || !feature.properties || !feature.properties.id) return;
        var p = Object.assign({}, feature.properties);
        p._corridorLocal = true;
        p.road_unit = p.id;
        p.road_name = p.name && p.name !== 'Unnamed local-road segment' ? p.name : 'Unnamed local road';
        p.admin_class = 'L';
        p.has_pbs1 = p.pbs1 === true ? 1 : 0;
        p.has_bdouble = p.bdouble === true ? 1 : 0;
        // Local-road catalogue records carry the NHVR road-train result inside the Regional
        // option group. Copy the tri-state value onto the routed feature so a selected corridor
        // can measure it in the same length-weighted pass as PBS and B-double access.
        p.roadtrain = p.regional_options && typeof p.regional_options.road_train === 'boolean'
            ? p.regional_options.road_train : null;
        var adapted = { type: 'Feature', properties: p, geometry: feature.geometry };
        var virtualLayer = { feature: adapted };
        (corridorLocalRoadLayers[p.road_unit] || (corridorLocalRoadLayers[p.road_unit] = [])).push(virtualLayer);
    });
}

function corridorLoadLocalChunkKeys(keys) {
    if (!window.LOCAL_ROAD_MANIFEST || typeof fetchGzipJson !== 'function') return Promise.resolve();
    var directory = window.LOCAL_ROAD_MANIFEST.geometry.directory || 'data/local_road_chunks';
    return Promise.all(keys.map(function (key) {
        if (corridorLocalChunks[key]) return corridorLocalChunks[key];
        corridorLocalChunks[key] = fetchGzipJson(directory + '/' + key + '.geojson.gz?v=' + Date.now())
            .then(function (geojson) { corridorRegisterLocalGeoJSON(geojson); return geojson; })
            .catch(function () { delete corridorLocalChunks[key]; return null; });
        return corridorLocalChunks[key];
    }));
}

function corridorLoadLocalRoadsNear(latlng) {
    return corridorLoadLocalChunkKeys(corridorLocalChunkKeys(latlng));
}

function corridorPrepareSelectedLocalRoads() {
    // A route may start and finish on declared roads but need local-road links between them, so load
    // every local-road chunk in the padded point envelope rather than only the endpoint road units.
    return corridorLoadLocalChunkKeys(corridorLocalChunkKeysForPoints(corridorState.points));
}

function corridorRoadClick(feature, layer, e) {
    var key = roadKeyOf(feature.properties);
    if (!key) return;
    corridorDeclaredClick = { at: Date.now(), latlng: e.latlng };
    var complete = corridorState.points.length === corridorPointLabels().length;
    if (complete) {
        document.getElementById('corridor-status').textContent='This route is complete. Choose “Assess another route” to retain it and start a new one.';
        return;
    }
    if (!corridorState.roadKey) {
        corridorState.roadKey = key;
        corridorState.roadName = corridorRoadDisplayName((NSW_AGG || {})[key] || feature.properties);
    }
    var snapped = corridorSnapToRoad(key, e.latlng);
    if (!snapped) return;
    snapped.roadKey = key;
    acceptCorridorPoint(snapped);
}

function corridorClickTolerance(latlng) {
    var point = map.latLngToContainerPoint(latlng);
    var edge = map.containerPointToLatLng(point.add([18, 0]));
    return Math.max(50, Math.min(600, map.distance(latlng, edge)));
}

function corridorAcceptMapClick(e) {
    if (currentTab !== 'corridor') return;
    // A declared road layer handles its own click first; ignore the bubbled map click from that event.
    if (Date.now() - corridorDeclaredClick.at < 150 && corridorDeclaredClick.latlng &&
        map.distance(e.latlng, corridorDeclaredClick.latlng) < 5) return;
    var sequence = ++corridorPickSequence;
    var status = document.getElementById('corridor-status');
    if (status) status.textContent = 'Finding the nearest mapped road…';
    corridorLoadLocalRoadsNear(e.latlng).then(function () {
        if (sequence !== corridorPickSequence || currentTab !== 'corridor') return;
        var complete = corridorState.points.length === corridorPointLabels().length;
        if (complete) {
            if (status) status.textContent='This route is complete. Choose “Assess another route” to retain it and start a new one.';
            return;
        }
        var snapped;
        snapped = corridorSnapToAnyRoad(e.latlng);
        if (!snapped || snapped.d > corridorClickTolerance(e.latlng)) {
            if (status) status.textContent = 'No mapped road found near that point. Zoom in and click closer to a road.';
            return;
        }
        if (!corridorState.roadKey) {
            corridorState.roadKey = snapped.roadKey;
            corridorState.roadName = corridorRoadDisplayName(corridorRoadProperties(snapped.roadKey));
        }
        acceptCorridorPoint(snapped);
    });
}
map.on('click', corridorAcceptMapClick);

function acceptCorridorPoint(snapped) {
    var labels = corridorPointLabels(), insertWaypoint = corridorState.waypointEnabled && corridorState.points.length === 2 && !corridorState.points.some(function(p){return p.pointLabel==='W';});
    var label = insertWaypoint ? 'W' : labels[corridorState.points.length];
    snapped.pointLabel = label;
    if (insertWaypoint) corridorState.points.splice(1, 0, snapped); else corridorState.points.push(snapped);
    if (corridorState.roadKeys.indexOf(snapped.roadKey) < 0) corridorState.roadKeys.push(snapped.roadKey);
    var marker = L.marker(snapped.latlng, { pane:'corridorPointPane', draggable:true, keyboard:true,
        title:'Drag route point '+label+' to fine-tune the corridor', alt:'Route point '+label,
        icon:corridorMarkerIcon(label,false) })
        .bindTooltip('Drag point '+label+' to fine-tune the route', {direction:'top',offset:[0,-9],className:'corridor-drag-help'}).addTo(corridorOverlay);
    marker.on('dragstart',function(){corridorBeginPointDrag(marker);});
    marker.on('dragend',function(){corridorFinishPointDrag(marker);});
    if (insertWaypoint) corridorState.markers.splice(1, 0, marker); else corridorState.markers.push(marker);
    renderCorridorPoint(label, snapped);
    if (corridorState.points.length === labels.length) corridorReassessCurrentRoute();
    else document.getElementById('corridor-status').textContent = corridorNextInstruction();
}

function corridorMarkerIcon(label,locked) {
    var safeLabel=label==='A'||label==='B'||label==='W'?label:'';
    return L.divIcon({className:'corridor-drag-marker corridor-drag-marker-'+safeLabel.toLowerCase()+(locked?' is-locked':''),
        html:'<span>'+safeLabel+'</span>',iconSize:[24,24],iconAnchor:[12,12],tooltipAnchor:[0,-10]});
}

function corridorReassessCurrentRoute() {
    if(corridorState.points.length!==corridorPointLabels().length){
        document.getElementById('corridor-status').textContent=corridorNextInstruction();
        return;
    }
    var selectedPoints=corridorState.points.slice();
    document.getElementById('corridor-status').textContent='Loading the selected road corridor…';
    corridorPrepareSelectedLocalRoads().then(function(){
        // Ignore completion from a route that was cleared, dragged again or replaced while loading.
        if(corridorState.points.length===selectedPoints.length&&corridorState.points.every(function(p,i){return p===selectedPoints[i];}))
            finishCorridorAssessment();
    });
}

function corridorBeginPointDrag(marker) {
    var index=corridorState.markers.indexOf(marker);
    if(index<0)return;
    marker._corridorDragOrigin=marker.getLatLng();
    clearCorridorRouteResult();
    var point=corridorState.points[index];
    document.getElementById('corridor-status').textContent='Moving point '+(point&&point.pointLabel||'')+'… release it near the intended road.';
}

function corridorFinishPointDrag(marker) {
    var index=corridorState.markers.indexOf(marker);
    if(index<0)return;
    var originalPoint=corridorState.points[index],requested=marker.getLatLng(),sequence=++corridorPickSequence;
    document.getElementById('corridor-status').textContent='Snapping the moved point to the nearest mapped road…';
    corridorLoadLocalRoadsNear(requested).then(function(){
        if(sequence!==corridorPickSequence||currentTab!=='corridor'||corridorState.markers[index]!==marker)return;
        var snapped=corridorSnapToAnyRoad(requested);
        if(!snapped||snapped.d>corridorClickTolerance(requested)){
            marker.setLatLng(originalPoint.latlng);
            renderCorridorPoint(originalPoint.pointLabel,originalPoint);
            document.getElementById('corridor-status').textContent='No mapped road was found near the dropped point. It has been returned to its previous position.';
            corridorReassessCurrentRoute();
            return;
        }
        snapped.pointLabel=originalPoint.pointLabel;
        corridorState.points[index]=snapped;
        marker.setLatLng(snapped.latlng).setIcon(corridorMarkerIcon(snapped.pointLabel,false));
        marker.setTooltipContent('Drag point '+snapped.pointLabel+' to fine-tune the route');
        corridorState.roadKeys=[];
        corridorState.points.forEach(function(point){if(point.roadKey&&corridorState.roadKeys.indexOf(point.roadKey)<0)corridorState.roadKeys.push(point.roadKey);});
        corridorState.roadKey=corridorState.points[0]&&corridorState.points[0].roadKey||null;
        corridorState.roadName=corridorState.roadKey?corridorRoadDisplayName(corridorRoadProperties(corridorState.roadKey)):'';
        renderCorridorPoint(snapped.pointLabel,snapped);
        corridorReassessCurrentRoute();
    });
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
    var layers = corridorRoadLayers(key);
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
    var value = el.querySelector('input'), coordinates = el.querySelector('.corridor-point-coordinates');
    value.value = 'Finding street address…';
    value.classList.remove('is-coordinates');
    coordinates.textContent = '(Lat ' + p.latlng.lat.toFixed(6) + ', Lon ' + p.latlng.lng.toFixed(6) + ')';
    corridorReverseAddress(p.latlng).then(function (address) {
        // Ignore a late response if this endpoint was cleared or replaced.
        var index = corridorState.points.map(function(point){return point.pointLabel;}).indexOf(label);
        if (corridorState.points[index] !== p) return;
        if (address) { p.address = address; value.value = address; value.classList.remove('is-coordinates'); }
        else { value.value = [p.street, p.locality].filter(Boolean).join(', ') || 'Unnamed mapped road'; value.classList.remove('is-coordinates'); }
    });
}

function corridorCoordinateText(latlng) { return latlng.lat.toFixed(6) + ', ' + latlng.lng.toFixed(6); }

function searchCorridorPoint(label) {
    var form = document.getElementById('corridor-point-' + label.toLowerCase());
    var input = form.querySelector('input'), query = input.value.trim();
    if (!query) return false;
    if (label === 'A' && corridorState.route) {
        document.getElementById('corridor-status').textContent='This route is complete. Choose “Assess another route” to retain it and start a new one.';
        return false;
    }
    form.classList.add('is-searching');
    var pointDescription = label === 'A' ? 'the start point…' : label === 'W' ? 'the waypoint…' : 'the end point…';
    document.getElementById('corridor-status').textContent = 'Searching for ' + pointDescription;
    corridorForwardGeocode(query).then(function (latlng) {
        if (!latlng) throw new Error('No location found');
        if (label === 'A') resetCorridorAssessment(true, true);
        else if (!corridorState.roadKey || !corridorState.points.length) throw new Error('Select the start point first');
        return corridorLoadLocalRoadsNear(latlng).then(function () { return latlng; });
    }).then(function (latlng) {
        var snapped = corridorSnapToAnyRoad(latlng);
        if (!snapped || snapped.d > 2000) throw new Error('No matching mapped road found');
        if (label === 'A') {
            corridorState.roadKey = snapped.roadKey;
            corridorState.roadName = corridorRoadDisplayName(corridorRoadProperties(snapped.roadKey));
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
    var keys = Object.keys(registry).concat(Object.keys(corridorLocalRoadLayers));
    keys.forEach(function(key){
        var candidate=corridorSnapToRoad(key,latlng);
        if(candidate&&(!best||candidate.d<best.d)){candidate.roadKey=key;best=candidate;}
    });
    return best;
}

function corridorSnapToDeclaredRoad(latlng) {
    var best=null,registry=window.NSW_ROAD_LAYERS||{};
    Object.keys(registry).forEach(function(key){var candidate=corridorSnapToRoad(key,latlng);if(candidate&&(!best||candidate.d<best.d)){candidate.roadKey=key;best=candidate;}});
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
    var endIndex=corridorState.points.length-1;
    corridorState.markers.forEach(function(marker,index){
        var label=corridorState.points[index].pointLabel;
        marker.setIcon(corridorMarkerIcon(label,false)).setTooltipContent('Drag point '+label+' to fine-tune the route');
    });
    renderCorridorPoint('A', corridorState.points[0]);
    if (corridorState.waypointEnabled) renderCorridorPoint('W', corridorState.points[1]);
    renderCorridorPoint('B', corridorState.points[endIndex]);
    finishCorridorAssessment();
}

function corridorRouteEnvelope(points) {
    var lats=points.map(function(p){return p.latlng.lat;}), lngs=points.map(function(p){return p.latlng.lng;});
    var south=Math.min.apply(null,lats),north=Math.max.apply(null,lats),west=Math.min.apply(null,lngs),east=Math.max.apply(null,lngs);
    // A shortest road route can legitimately arc well outside the straight endpoint rectangle
    // (Dubbo–Newcastle via the Golden Highway is a good example), so retain a generous search belt.
    var latPad=Math.max(.35,(north-south)*.5),lngPad=Math.max(.35,(east-west)*.25);
    return {south:south-latPad,north:north+latPad,west:west-lngPad,east:east+lngPad};
}

function corridorGeometryTouchesEnvelope(geometry, envelope) {
    return corridorCoords(geometry).some(function(line){return line.some(function(c){return c[0]>=envelope.west&&c[0]<=envelope.east&&c[1]>=envelope.south&&c[1]<=envelope.north;});});
}

function corridorNetworkKeys(points) {
    var envelope=corridorRouteEnvelope(points), seen={}, keys=[];
    [window.NSW_ROAD_LAYERS||{},corridorLocalRoadLayers].forEach(function(registry){Object.keys(registry).forEach(function(key){
        if(seen[key])return;
        if((registry[key]||[]).some(function(layer){return layer.feature&&corridorGeometryTouchesEnvelope(layer.feature.geometry,envelope);})){seen[key]=true;keys.push(key);}
    });});
    points.forEach(function(point){if(point.roadKey&&!seen[point.roadKey]){seen[point.roadKey]=true;keys.push(point.roadKey);}});
    return keys;
}

function corridorGraph(keys, snaps) {
    var nodes={},edges={},buckets={},nextNode=0,toleranceMetres=12,grid=.00012;
    var graphSnaps=snaps.slice(),accessPairs=[];
    snaps.forEach(function(snap,index){
        var access=corridorSnapToDeclaredRoad(snap.latlng);
        if(access&&access.d<=2000&&access.roadKey!==snap.roadKey){graphSnaps.push(access);accessPairs.push({original:index,access:graphSnaps.length-1});}
    });
    function bucket(c){return Math.floor(c[0]/grid)+','+Math.floor(c[1]/grid);}
    function nearbyNode(c){
        var bx=Math.floor(c[0]/grid),by=Math.floor(c[1]/grid),best=null;
        for(var x=bx-1;x<=bx+1;x++)for(var y=by-1;y<=by+1;y++)(buckets[x+','+y]||[]).forEach(function(id){
            var d=map.distance([c[1],c[0]],[nodes[id][1],nodes[id][0]]);if(d<=toleranceMetres&&(!best||d<best.d))best={id:id,d:d};
        });
        return best&&best.id;
    }
    function addNode(c){var existing=nearbyNode(c);if(existing)return existing;var id='n'+nextNode++;nodes[id]=c;edges[id]=[];(buckets[bucket(c)]||(buckets[bucket(c)]=[])).push(id);return id;}
    function addEdge(a,b,props,roadKey){var ak=addNode(a),bk=addNode(b);if(ak===bk)return;var w=map.distance([a[1],a[0]],[b[1],b[0]]);edges[ak].push({to:bk,w:w,p:props,roadKey:roadKey});edges[bk].push({to:ak,w:w,p:props,roadKey:roadKey});}
    keys.forEach(function(key){corridorRoadLayers(key).forEach(function(ly){corridorCoords(ly.feature.geometry).forEach(function(line){
        var inserts={};
        graphSnaps.forEach(function(s){if(s.layer===ly&&s.line===line)(inserts[s.edge]||(inserts[s.edge]=[])).push({t:s.t,c:[s.latlng.lng,s.latlng.lat]});});
        for(var i=1;i<line.length;i++){
            var pts=[{t:0,c:line[i-1]}].concat((inserts[i-1]||[]).sort(function(a,b){return a.t-b.t;}),[{t:1,c:line[i]}]);
            for(var j=1;j<pts.length;j++)addEdge(pts[j-1].c,pts[j].c,ly.feature.properties,key);
        }
    });});});
    var graphSnapKeys=graphSnaps.map(function(s){return addNode([s.latlng.lng,s.latlng.lat]);});
    accessPairs.forEach(function(pair){
        var original=graphSnaps[pair.original],access=graphSnaps[pair.access],a=graphSnapKeys[pair.original],b=graphSnapKeys[pair.access];
        if(a===b)return;
        var w=map.distance(original.latlng,access.latlng),props=Object.assign({},original.layer.feature.properties,{_corridorConnector:true});
        edges[a].push({to:b,w:w,p:props,roadKey:original.roadKey});edges[b].push({to:a,w:w,p:props,roadKey:original.roadKey});
    });
    return {nodes:nodes,edges:edges,snapKeys:graphSnapKeys.slice(0,snaps.length)};
}

function corridorHeapPush(heap,item){heap.push(item);var i=heap.length-1;while(i){var p=(i-1)>>1;if(heap[p].d<=item.d)break;heap[i]=heap[p];i=p;}heap[i]=item;}
function corridorHeapPop(heap){if(!heap.length)return null;var root=heap[0],last=heap.pop();if(heap.length){var i=0;while(true){var l=i*2+1,r=l+1,c=l;if(l>=heap.length)break;if(r<heap.length&&heap[r].d<heap[l].d)c=r;if(heap[c].d>=last.d)break;heap[i]=heap[c];i=c;}heap[i]=last;}return root;}

function corridorShortestPath(g,start,end){
    var dist={},prev={},done={},heap=[];dist[start]=0;corridorHeapPush(heap,{id:start,d:0});
    while(heap.length){var current=corridorHeapPop(heap),u=current.id;if(done[u]||current.d!==dist[u])continue;done[u]=true;if(u===end)break;
        (g.edges[u]||[]).forEach(function(edge){var nd=current.d+edge.w;if(nd<(dist[edge.to]===undefined?Infinity:dist[edge.to])){dist[edge.to]=nd;prev[edge.to]={from:u,edge:edge};corridorHeapPush(heap,{id:edge.to,d:nd});}});
    }
    if(dist[end]===undefined)return null;
    var nodeKeys=[end],props=[],segmentMetres=[],roadKeys=[],cur=end;
    while(cur!==start){var step=prev[cur];if(!step)return null;props.push(step.edge.p);segmentMetres.push(step.edge.w);roadKeys.push(step.edge.roadKey);cur=step.from;nodeKeys.push(cur);}
    nodeKeys.reverse();props.reverse();segmentMetres.reverse();roadKeys.reverse();
    return {latlngs:nodeKeys.map(function(key){var c=g.nodes[key];return [c[1],c[0]];}),props:props,segmentMetres:segmentMetres,roadKeys:roadKeys,metres:dist[end]};
}

function corridorPointToRouteMetres(item, route) {
    if (item.lat == null || item.lon == null) return Infinity;
    var p=L.latLng(item.lat,item.lon), best=Infinity;
    for(var i=1;i<route.latlngs.length;i++){var a=route.latlngs[i-1],b=route.latlngs[i];var q=corridorProject(p,[a[1],a[0]],[b[1],b[0]]);best=Math.min(best,q.d);}
    return best;
}

function finishCorridorAssessment() {
    var keys=corridorNetworkKeys(corridorState.points);
    var graph=corridorGraph(keys,corridorState.points), route;
    if (corridorState.waypointEnabled) {
        var firstLeg=corridorShortestPath(graph,graph.snapKeys[0],graph.snapKeys[1]);
        var secondLeg=corridorShortestPath(graph,graph.snapKeys[1],graph.snapKeys[2]);
        if (firstLeg && secondLeg) route={latlngs:firstLeg.latlngs.concat(secondLeg.latlngs.slice(1)),props:firstLeg.props.concat(secondLeg.props),
            segmentMetres:firstLeg.segmentMetres.concat(secondLeg.segmentMetres),roadKeys:firstLeg.roadKeys.concat(secondLeg.roadKeys),metres:firstLeg.metres+secondLeg.metres};
    } else route=corridorShortestPath(graph,graph.snapKeys[0],graph.snapKeys[1]);
    if (!route) { document.getElementById('corridor-status').textContent = corridorState.waypointEnabled
        ? 'No connected road route was found through that waypoint. Move the waypoint closer to a mapped intersection or try another point.'
        : 'No continuous route was found in the available road data. Try moving an endpoint closer to a mapped road or add a waypoint.'; return; }
    corridorState.route = route;
    (corridorState.routeLayers || []).concat(corridorState.nhvrCoverageLayers || []).forEach(function (layer) { corridorOverlay.removeLayer(layer); });
    corridorState.nhvrCoverageLayers = [];
    corridorState.nhvrCoverageVisible = false;
    var routeStyle=corridorRouteStyle(corridorState.routeNumber);
    var routeBorder = L.polyline(route.latlngs, { pane:'connPane', renderer:connRenderer, color:routeStyle.border, weight:10, opacity:.95, lineCap:'round', lineJoin:'round' }).addTo(corridorOverlay);
    corridorState.routeLayer = L.polyline(route.latlngs, { pane:'connPane', renderer:connRenderer, color:routeStyle.line, weight:6, opacity:1, lineCap:'round', lineJoin:'round' })
        .bindTooltip('Route '+corridorState.routeNumber, {sticky:true, className:'corridor-route-tooltip'}).addTo(corridorOverlay);
    corridorState.routeLayers = [routeBorder, corridorState.routeLayer];
    map.fitBounds(corridorState.routeLayer.getBounds().pad(.15), { maxZoom: 14 });
    document.getElementById('corridor-status').textContent = 'Route '+corridorState.routeNumber+' assessed from available evidence.';
    renderCorridorAssessment(route);
    renderMapLegend();
}

function corridorNhvrSegmentValue(route, type, properties, index) {
    var p=properties||{}, key=(route.roadKeys||[])[index]||roadKeyOf(p), nhvr=key&&(window.NHVR||{})[key];
    if (p._corridorConnector) return null;
    if (type==='pbs2b') {
        if (p.has_pbs2b===0||p.has_pbs2b===1) return p.has_pbs2b===1;
        if (typeof p.pbs2b==='boolean') return p.pbs2b;
        if (typeof p.pbs2b_coverage==='number') return p.pbs2b_coverage>.8;
        return null;
    }
    if (type==='pbs1') {
        if (p.has_pbs1===0||p.has_pbs1===1) return p.has_pbs1===1;
        if (typeof p.pbs1==='boolean') return p.pbs1;
        if (typeof p.pbs1_coverage==='number') return p.pbs1_coverage>.8;
        return nhvr&&typeof nhvr.pbs1==='boolean'?nhvr.pbs1:null;
    }
    if (type==='bdouble') {
        if (p.has_bdouble===0||p.has_bdouble===1) return p.has_bdouble===1;
        if (typeof p.bdouble==='boolean') return p.bdouble;
        if (typeof p.bdouble_coverage==='number') return p.bdouble_coverage>=.8;
        return nhvr&&typeof nhvr.bdouble19==='boolean'?nhvr.bdouble19:null;
    }
    if (type==='roadtrain') {
        if (typeof p.roadtrain==='boolean') return p.roadtrain;
        return nhvr&&typeof nhvr.roadtrain==='boolean'?nhvr.roadtrain:null;
    }
    return null;
}

function corridorNhvrCoverageStats(state, type) {
    var route=state&&state.route, stats={covered:0,outside:0,unknown:0,total:0};
    if(!route)return stats;
    route.props.forEach(function(p,index){
        var metres=(route.segmentMetres||[])[index]||0, value=corridorNhvrSegmentValue(route,type,p,index);
        stats.total+=metres;
        if(value===true)stats.covered+=metres;
        else if(value===false)stats.outside+=metres;
        else stats.unknown+=metres;
    });
    return stats;
}

function corridorNhvrCoverageSummary(stats) {
    function percent(value){return stats.total?Math.round(value/stats.total*100):0;}
    return '<span class="corridor-coverage-stat covered"><b>'+percent(stats.covered)+'%</b> covered</span>'+
        '<span class="corridor-coverage-stat outside"><b>'+percent(stats.outside)+'%</b> outside</span>'+
        '<span class="corridor-coverage-stat unknown"><b>'+percent(stats.unknown)+'%</b> unknown</span>';
}

function corridorNhvrCoverageControlHTML(state) {
    var routeNumber=state.routeNumber, type=state.nhvrCoverageType||'pbs2b', stats=corridorNhvrCoverageStats(state,type);
    var options=[['pbs2b','PBS Level 2B · S-06'],['pbs1','PBS Level 1 · S-09'],['bdouble','19 m B-double · R-04'],['roadtrain','Road train · R-03']];
    return '<div class="corridor-result-card corridor-coverage-card"><div class="corridor-coverage-heading"><div><h3>NHVR coverage</h3><p>Show where this route is covered by an NHVR vehicle-access check.</p></div>'+
        '<label class="corridor-coverage-switch"><input id="corridor-coverage-toggle-'+routeNumber+'" type="checkbox" '+(state.nhvrCoverageVisible?'checked ':'')+'onchange="updateCorridorNhvrCoverage('+routeNumber+')"><span></span><em>Show on map</em></label></div>'+
        '<label class="corridor-coverage-select-label" for="corridor-coverage-type-'+routeNumber+'">Network check</label><select id="corridor-coverage-type-'+routeNumber+'" class="corridor-coverage-select" onchange="updateCorridorNhvrCoverage('+routeNumber+')">'+
        options.map(function(item){return '<option value="'+item[0]+'"'+(item[0]===type?' selected':'')+'>'+item[1]+'</option>';}).join('')+'</select>'+
        '<div id="corridor-coverage-summary-'+routeNumber+'" class="corridor-coverage-summary">'+corridorNhvrCoverageSummary(stats)+'</div>'+
        '<div class="corridor-coverage-note">Green is covered, red is confirmed outside the selected NHVR network, and dashed grey has no corridor-level result (including connector gaps).</div></div>';
}

function corridorStateForRoute(routeNumber) {
    if(corridorState.routeNumber===routeNumber)return corridorState;
    return corridorSavedAssessments.find(function(item){return item.routeNumber===routeNumber;})||null;
}

function corridorClearNhvrCoverage(state) {
    (state.nhvrCoverageLayers||[]).forEach(function(layer){corridorOverlay.removeLayer(layer);});
    state.nhvrCoverageLayers=[];
}

function corridorNhvrTypeLabel(type) {
    return {pbs2b:'PBS Level 2B',pbs1:'PBS Level 1',bdouble:'19 m B-double',roadtrain:'Road train'}[type]||'NHVR access';
}

function updateCorridorNhvrCoverage(routeNumber) {
    var state=corridorStateForRoute(routeNumber), toggle=document.getElementById('corridor-coverage-toggle-'+routeNumber), select=document.getElementById('corridor-coverage-type-'+routeNumber);
    if(!state||!state.route||!toggle||!select)return;
    corridorClearNhvrCoverage(state);
    state.nhvrCoverageType=select.value;
    state.nhvrCoverageVisible=toggle.checked;
    var stats=corridorNhvrCoverageStats(state,state.nhvrCoverageType), summary=document.getElementById('corridor-coverage-summary-'+routeNumber);
    if(summary)summary.innerHTML=corridorNhvrCoverageSummary(stats);
    if(state.nhvrCoverageVisible){
        var route=state.route, groups=[], current=null;
        route.props.forEach(function(p,index){
            var value=corridorNhvrSegmentValue(route,state.nhvrCoverageType,p,index);
            var key=(route.roadKeys||[])[index]||roadKeyOf(p)||'', name=corridorRoadDisplayName(p)||'Mapped road';
            if(!current||current.value!==value||current.key!==key){
                current={value:value,key:key,name:name,latlngs:[route.latlngs[index],route.latlngs[index+1]]};groups.push(current);
            }else current.latlngs.push(route.latlngs[index+1]);
        });
        groups.forEach(function(group){
            var colour=group.value===true?'#16a34a':group.value===false?'#dc2626':'#78716c';
            var status=group.value===true?'Covered':group.value===false?'Outside network':'No corridor-level result';
            var layer=L.polyline(group.latlngs,{pane:'connPane',renderer:connRenderer,color:colour,weight:8,opacity:.96,
                dashArray:group.value===null?'6 7':null,lineCap:'round',lineJoin:'round'})
                .bindTooltip(corridorNhvrTypeLabel(state.nhvrCoverageType)+' · '+status+'<br>'+group.name,{sticky:true,className:'corridor-route-tooltip'}).addTo(corridorOverlay);
            state.nhvrCoverageLayers.push(layer);
        });
    }
    renderMapLegend();
}

function corridorHasVisibleNhvrCoverage() {
    return [corridorState].concat(corridorSavedAssessments).some(function(state){return state.nhvrCoverageVisible&&(state.nhvrCoverageLayers||[]).length;});
}

function renderCorridorAssessment(route) {
    var routeKeys=[];
    (route.roadKeys||[]).forEach(function(key){if(key&&routeKeys.indexOf(key)<0)routeKeys.push(key);});
    route.props.forEach(function(p){var key=roadKeyOf(p);if(key&&routeKeys.indexOf(key)<0)routeKeys.push(key);});
    if (!routeKeys.length) routeKeys=corridorState.roadKeys.length?corridorState.roadKeys.slice():[corridorState.roadKey];
    var evidenceSets=routeKeys.map(function(key){return (window.NSW_EVID||{})[key]||{};});
    var ev={centres:[],hospitals:[],dests:[],employment:[]};
    evidenceSets.forEach(function(item){['centres','hospitals','dests','employment'].forEach(function(type){ev[type]=ev[type].concat(item[type]||[]);});});
    var k=routeKeys[0]||corridorState.roadKey, firstProps=corridorRoadProperties(k);
    var routeCriteria=routeKeys.map(function(key){var props=corridorRoadProperties(key);return (window.NSW_CRIT||{})[key]||{area:props.zone,opt:{traffic:null}};});
    var crit=routeCriteria[0]||{ area:firstProps.zone, opt:{ traffic:null } }, unique={};
    var routeNames=routeKeys.map(function(key){return corridorRoadDisplayName(corridorRoadProperties(key))||key;}).filter(function(name,index,items){return items.indexOf(name)===index;});
    corridorState.roadName=(routeNames.length>6?routeNames.slice(0,6).join(' → ')+' → +'+(routeNames.length-6)+' more roads':routeNames.join(' → '))||corridorState.roadName;
    var hasUrban=routeCriteria.some(function(item){return item.area==='urban';});
    var hasRural=routeCriteria.some(function(item){return item.area==='rural';});
    var urbanArea=hasUrban&&!hasRural, mixedArea=hasUrban&&hasRural;
    var centres=(ev.centres||[]).filter(function(x){return corridorPointToRouteMetres(x,route)<=2200;}).filter(function(x){var n=String(x.name||'').toLowerCase();if(unique[n])return false;unique[n]=1;return true;});
    var hospitals=(ev.hospitals||[]).filter(function(x){return corridorPointToRouteMetres(x,route)<=2200;});
    var dests=(ev.dests||[]).filter(function(x){return corridorPointToRouteMetres(x,route)<=2200;});
    var employment=(ev.employment||[]).filter(function(x){return x.size_qualifies && corridorPointToRouteMetres(x,route)<=2200;});
    var facilities=[].concat(hospitals,dests,employment);
    function routeCoverage(test){var covered=0,total=0;route.props.forEach(function(p,i){var metres=(route.segmentMetres||[])[i]||0;total+=metres;if(test(p,i))covered+=metres;});return total?covered/total:0;}
    var pbs1Coverage=routeCoverage(function(p){return !p._corridorConnector&&(p.has_pbs1===1||p.pbs1===true||p.pbs1_coverage>0.8);});
    var bdCoverage=routeCoverage(function(p){return !p._corridorConnector&&(p.has_bdouble===1||p.bdouble===true||p.bdouble_coverage>=0.8);});
    var pbs2bCoverage=routeCoverage(function(p){return !p._corridorConnector&&(p.has_pbs2b===1||p.pbs2b===true||p.pbs2b_coverage>0.8);});
    var nltnCoverage=routeCoverage(function(p){return !p._corridorConnector&&p._nltn===true;});
    // R-03 uses the same tri-state segment lookup as the optional map coverage overlay. Keep
    // unknown evidence separate from a confirmed network miss: an incomplete import must not be
    // presented to a council as a definitive fail.
    var roadTrainMetres={approved:0,rejected:0,unknown:0,total:0};
    route.props.forEach(function(p,i){
        var metres=(route.segmentMetres||[])[i]||0, value=corridorNhvrSegmentValue(route,'roadtrain',p,i);
        roadTrainMetres.total+=metres;
        if (value===true) roadTrainMetres.approved+=metres;
        else if (value===false) roadTrainMetres.rejected+=metres;
        else roadTrainMetres.unknown+=metres;
    });
    var roadTrainCoverage=roadTrainMetres.total?roadTrainMetres.approved/roadTrainMetres.total:0;
    var roadTrainRejectedCoverage=roadTrainMetres.total?roadTrainMetres.rejected/roadTrainMetres.total:0;
    var roadTrainUnknownCoverage=roadTrainMetres.total?roadTrainMetres.unknown/roadTrainMetres.total:0;
    var roadTrain=roadTrainCoverage>=.99 ? true : roadTrainRejectedCoverage>.01 ? false : null;
    var connectorMetres=0;route.props.forEach(function(p,i){if(p._corridorConnector)connectorMetres+=(route.segmentMetres||[])[i]||0;});
    var pbs1=pbs1Coverage>=.99,bd=bdCoverage>=.99,pbs2b=pbs2bCoverage>=.99;
    var centrePass=centres.length>=2, destPass=facilities.length>=1 && centres.length>=1, ldr=route.metres>=25000 && centrePass;
    var trafficKnown=routeCriteria.some(function(item){return item.opt&&item.opt.traffic!==null&&item.opt.traffic!==undefined;});
    // A declared-road traffic count is not corridor-specific, so disclose it but never count it in
    // the selected-line result. A future point/section traffic import can replace this limitation.
    var stateOpts=(centrePass?1:0)+(destPass?1:0)+((hasRural||!hasUrban)&&ldr?1:0);
    var regOpts=(centrePass?1:0)+(destPass?1:0)+((hasRural||!hasUrban)&&roadTrain===true?1:0);
    var asState=xverdict(stateOpts,pbs1), asReg=xverdict(regOpts,bd);
    var nltn=nltnCoverage>=.99;
    var natMet=(nltn?1:0)+(centrePass?1:0)+(facilities.length?1:0), asNat=pbs2b?(natMet>=2?'green':natMet===1?'orange':'red'):'red';
    corridorState.evidence = { centres: centres, hospitals: hospitals, dests: dests, employment: employment };
    // Reuse the overview map's evidence rings and labels, but only with items spatially associated
    // with this selected corridor. Whole-road evidence outside the selection is excluded.
    if (currentTab==='corridor') showConnections(corridorState.evidence);
    var nationalCriteria = [
        criterion('S-06', 'mandatory', 'PBS Level 2B access', pbs2b, corridorCoverageText(pbs2bCoverage)),
        criterion('S-01', 'optional', 'National Land Transport Network', nltn, corridorCoverageText(nltnCoverage)),
        criterion('S-02 · S-03', 'optional', 'Connects qualifying centres', centrePass, corridorCentreSummary(centres)),
        criterion('S-04 · S-05', 'optional', 'Connects ports, airports, intermodals or other facilities', facilities.length > 0, corridorFacilitySummary(facilities))
    ];
    var stateCriteria = [
        criterion('S-09', 'mandatory', 'PBS Level 1 access', pbs1, corridorCoverageText(pbs1Coverage)),
        criterion('Unnumbered', 'mandatory', 'No load limits on structures', null, 'Data unavailable'),
        criterion('Unnumbered', 'mandatory', 'Does not closely parallel a State Road', null, 'Not recalculated for selected corridor'),
        criterion(mixedArea?'S-07 · S-10':urbanArea?'S-10':'S-07', 'optional', 'Connects qualifying population centres', centrePass, corridorCentreSummary(centres)),
        criterion(mixedArea?'S-08 · S-11':urbanArea?'S-11':'S-08', 'optional', 'Connects a qualifying facility to a centre', destPass, corridorFacilitySummary(facilities)),
        criterion('Unnumbered', 'optional', 'Traffic volume and heavy-vehicle percentage', null, 'No corridor-specific count')
    ];
    if (hasRural||!hasUrban) stateCriteria.push(criterion('Unnumbered', 'optional', 'Long-distance rural connection', ldr, (route.metres/1000).toFixed(2)+' km selected'));
    var regionalCriteria = [
        criterion('R-04', 'mandatory', '19 m B-double access', bd, corridorCoverageText(bdCoverage)),
        criterion('Unnumbered', 'mandatory', 'No load limits on structures', null, 'Data unavailable'),
        criterion(mixedArea?'R-01 · R-05':urbanArea?'R-05':'R-01', 'optional', 'Connects qualifying population centres', centrePass, corridorCentreSummary(centres)),
        criterion(mixedArea?'R-02 · R-06':urbanArea?'R-06':'R-02', 'optional', 'Connects a qualifying facility to a centre', destPass, corridorFacilitySummary(facilities)),
        criterion('Unnumbered', 'optional', 'Traffic volume and heavy-vehicle percentage', null, 'No corridor-specific count')
    ];
    if (hasRural||!hasUrban) {
        regionalCriteria.push(criterion('R-03', 'optional', 'Road-train access', roadTrain,
            corridorRoadTrainCoverageText(roadTrainCoverage,roadTrainRejectedCoverage,roadTrainUnknownCoverage)));
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
      corridorNhvrCoverageControlHTML(corridorState)+
      '<div class="corridor-result-card"><h3>Selected-corridor evidence</h3><div class="corridor-grid">'+
      metric('PBS Level 1',Math.round(pbs1Coverage*100)+'% coverage')+metric('19 m B-double',Math.round(bdCoverage*100)+'% coverage')+
      metric('Road train',Math.round(roadTrainCoverage*100)+'% coverage')+
      metric('Centres nearby',String(centres.length))+metric('Facilities nearby',String(facilities.length))+
      metric('Selected length',(route.metres/1000).toFixed(2)+' km')+metric('Traffic',trafficKnown?'Road-wide only':'Not available')+'</div>'+
      '<div class="corridor-evidence-names"><b>Centres shown on map:</b> '+corridorCentreSummary(centres)+'<br><b>Facilities shown on map:</b> '+corridorFacilitySummary(facilities)+'</div>'+
      '<div class="corridor-warning">'+(connectorMetres?'The route contains '+(connectorMetres/1000).toFixed(2)+' km of endpoint access links where the local and declared datasets do not join; those links are not assumed to have NLTN or vehicle-access evidence. ':'')+'Traffic'+(trafficKnown?' is inherited from the declared-road record, not measured specifically for this corridor.':' is unavailable and has not been assumed to pass.')+' “Connects” is currently approximated from evidence within 2.2 km of the selected mapped line; this result is decision support, not an official recategorisation.</div></div>'+
      '<button type="button" class="corridor-another" onclick="startAnotherCorridorAssessment()">＋ Assess another route</button>';
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
        gateLabel + ' · ' + assessment.optional + ' qualifying ' + (assessment.optional === 1 ? 'criterion' : 'criteria') +
        ' · ' + (corridorState.route.metres / 1000).toFixed(2) + ' km selected</span>';
    var list = document.getElementById('corridor-criteria-list');
    if (list) {
        list.innerHTML = corridorCriteriaSection('Mandatory criteria', assessment.criteria.filter(function(item){ return item.group === 'mandatory'; })) +
            corridorCriteriaSection(category === 'national' ? 'Optional / qualifying criteria' : 'Optional criteria', assessment.criteria.filter(function(item){ return item.group === 'optional'; }));
    }
}

function corridorRouteStyle(routeNumber) {
    var palette=[
        {line:'#4f2df5',border:'#24145f'}, {line:'#0284c7',border:'#0c4a6e'},
        {line:'#16a34a',border:'#14532d'}, {line:'#ea580c',border:'#7c2d12'},
        {line:'#c026d3',border:'#701a75'}, {line:'#ca8a04',border:'#713f12'}
    ];
    return palette[(Math.max(1,routeNumber)-1)%palette.length];
}

function corridorAssessmentDisplay(state, category) {
    var assessment=state.assessment&&state.assessment[category];
    if (!assessment) return null;
    var verdictLabel=assessment.verdict==='green'?'Passes criteria':assessment.verdict==='orange'?'Passes one criterion':'Does not meet criteria';
    var gateLabel=assessment.gate?'Mandatory vehicle-access gate demonstrated':'Mandatory vehicle-access gate not demonstrated';
    return {
        verdict:assessment.verdict,
        outcome:'<strong>'+assessment.label+': '+verdictLabel+'</strong><span>'+gateLabel+' · '+assessment.optional+' qualifying '+(assessment.optional===1?'criterion':'criteria')+' · '+(state.route.metres/1000).toFixed(2)+' km selected</span>',
        criteria:corridorCriteriaSection('Mandatory criteria',assessment.criteria.filter(function(item){return item.group==='mandatory';}))+
            corridorCriteriaSection(category==='national'?'Optional / qualifying criteria':'Optional criteria',assessment.criteria.filter(function(item){return item.group==='optional';}))
    };
}

function selectSavedCorridorCategory(routeNumber,category) {
    var state=corridorSavedAssessments.find(function(item){return item.routeNumber===routeNumber;});
    if (!state)return;
    state.selectedCategory=category;
    renderSavedCorridorAssessments();
}

function focusSavedCorridorRoute(routeNumber) {
    var state=corridorSavedAssessments.find(function(item){return item.routeNumber===routeNumber;});
    if (!state||!state.routeLayer)return;
    map.fitBounds(state.routeLayer.getBounds().pad(.15),{maxZoom:14});
    if(currentTab==='corridor'&&state.evidence)showConnections(state.evidence);
}

function renderSavedCorridorAssessments() {
    var container=document.getElementById('corridor-saved-results');
    if(!container)return;
    container.hidden=!corridorSavedAssessments.length;
    if(!corridorSavedAssessments.length){container.innerHTML='';return;}
    container.innerHTML='<div class="corridor-saved-heading">Retained route assessments</div>'+corridorSavedAssessments.map(function(state){
        var style=corridorRouteStyle(state.routeNumber), selected=state.selectedCategory, display=selected&&corridorAssessmentDisplay(state,selected);
        var categories=[['national','Nationally Significant'],['state','State Road'],['regional','Regional Road']];
        return '<article class="corridor-saved-card" style="--corridor-route-color:'+style.line+'"><div class="corridor-saved-title"><span>Route '+state.routeNumber+'</span><button type="button" onclick="focusSavedCorridorRoute('+state.routeNumber+')">Show on map</button></div>'+
            '<strong class="corridor-saved-name">'+state.roadName+'</strong><small>'+(state.route.metres/1000).toFixed(2)+' km selected</small>'+
            '<div class="corridor-test-buttons">'+categories.map(function(item){return '<button class="corridor-test-btn'+(selected===item[0]?' active':'')+'" type="button" onclick="selectSavedCorridorCategory('+state.routeNumber+',\''+item[0]+'\')">Test as '+item[1]+'</button>';}).join('')+'</div>'+
            (display?'<div class="corridor-test-outcome" data-verdict="'+display.verdict+'">'+display.outcome+'</div><div class="corridor-criteria-list">'+display.criteria+'</div>':'<div class="corridor-test-outcome"><strong>Choose a category to test</strong><span>This retained route remains independent of later routes.</span></div>')+
            corridorNhvrCoverageControlHTML(state)+'</article>';
    }).join('');
}

function metric(label,value){return '<div class="corridor-metric">'+label+'<strong>'+value+'</strong></div>';}
function criterion(id, group, name, passed, detail) { return { id:id, group:group, name:name, passed:passed, detail:detail }; }
function corridorCoverageText(value) { return Math.round(value*100)+'% of selected route demonstrated'; }
function corridorRoadTrainCoverageText(approved,rejected,unknown) {
    var parts=[Math.round(approved*100)+'% of selected route on the NHVR road-train network'];
    if (rejected>.001) parts.push(Math.round(rejected*100)+'% confirmed outside it');
    if (unknown>.001) parts.push(Math.round(unknown*100)+'% has no corridor-level NHVR result');
    return parts.join(' · ');
}
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
