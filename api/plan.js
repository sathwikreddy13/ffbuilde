const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const PLACES_URL = 'https://places.googleapis.com/v1/places:searchNearby';
const OCM_URL = 'https://api.openchargemap.io/v3/poi/';
const CACHE_LIMIT = 240;
const cache = new Map();
let placesBlockedUntil = 0;

const respond = (res, status, body) => {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};
const metres = value => Number(String(value || 0).replace(/[^0-9.]/g, ''));
const asLocation = value => value?.placeId ? { placeId: value.placeId } : { address: value?.label || value };
const label = value => typeof value === 'string' ? value : value.label;
const validPoint = point => Number.isFinite(point?.latitude) && Number.isFinite(point?.longitude);
const cacheKey = point => `${point.latitude.toFixed(3)},${point.longitude.toFixed(3)}`;

function distanceKm(a, b) {
  const toRad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * toRad;
  const dLng = (b.longitude - a.longitude) * toRad;
  const q = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * toRad) * Math.cos(b.latitude * toRad) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(q));
}

function cached(name, ttl, work) {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  return Promise.resolve(work()).then(value => {
    cache.set(name, { at: Date.now(), value });
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    return value;
  });
}

async function fetchWithTimeout(url, options, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function google(url, body, fieldMask) {
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY, 'X-Goog-FieldMask': fieldMask },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const detail = await response.text();
    console.error(JSON.stringify({ service: url.includes('routes.googleapis.com') ? 'Routes API' : 'Places API', status: response.status, detail: detail.slice(0, 350) }));
    const error = Error(response.status === 429 ? 'Station-search quota has been reached. Showing any Open Charge Map results instead.' : response.status === 403 ? 'Google Maps denied this request. Check the server key restrictions and enabled APIs.' : 'Google Maps could not retrieve route or charger data.');
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function decodePolyline(encoded = '') {
  let index = 0, latitude = 0, longitude = 0;
  const points = [];
  while (index < encoded.length) {
    let shift = 0, result = 0, byte;
    do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 31) << shift; shift += 5; } while (byte >= 32);
    latitude += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0; result = 0;
    do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 31) << shift; shift += 5; } while (byte >= 32);
    longitude += result & 1 ? ~(result >> 1) : result >> 1;
    points.push({ latitude: latitude / 1e5, longitude: longitude / 1e5 });
  }
  return points;
}

function routeSamples(leg) {
  const points = decodePolyline(leg.polyline?.encodedPolyline);
  if (points.length < 2) return [leg.startLocation.latLng, leg.endLocation.latLng];
  const lengths = [0];
  for (let index = 1; index < points.length; index++) lengths[index] = lengths[index - 1] + distanceKm(points[index - 1], points[index]);
  const count = Math.min(4, Math.max(2, Math.ceil(metres(leg.distanceMeters) / 250000) + 1));
  return Array.from({ length: count }, (_, index) => {
    const target = lengths.at(-1) * index / (count - 1);
    const nearest = lengths.findIndex(length => length >= target);
    return points[Math.max(0, nearest)];
  });
}

function routePosition(location, leg) {
  const points = decodePolyline(leg.polyline?.encodedPolyline);
  if (points.length < 2) return { routeKm: 0, offRouteKm: 0 };
  const latitudeScale = 111.32;
  const longitudeScale = 111.32 * Math.cos(location.latitude * Math.PI / 180);
  let travelled = 0, best = { offRouteKm: Infinity, routeKm: 0 };
  for (let index = 1; index < points.length; index++) {
    const start = points[index - 1], end = points[index];
    const x = (end.longitude - start.longitude) * longitudeScale, y = (end.latitude - start.latitude) * latitudeScale;
    const px = (location.longitude - start.longitude) * longitudeScale, py = (location.latitude - start.latitude) * latitudeScale;
    const segmentSquared = x * x + y * y;
    const factor = segmentSquared ? Math.max(0, Math.min(1, (px * x + py * y) / segmentSquared)) : 0;
    const projected = { latitude: start.latitude + (end.latitude - start.latitude) * factor, longitude: start.longitude + (end.longitude - start.longitude) * factor };
    const segment = distanceKm(start, end), offRouteKm = distanceKm(location, projected);
    if (offRouteKm < best.offRouteKm) best = { offRouteKm, routeKm: travelled + segment * factor };
    travelled += segment;
  }
  return best;
}

async function googleStations(point) {
  if (Date.now() < placesBlockedUntil) return [];
  return cached(`google:${cacheKey(point)}`, 15 * 60_000, async () => {
    try {
      const data = await google(PLACES_URL, { includedTypes: ['electric_vehicle_charging_station'], maxResultCount: 6, rankPreference: 'DISTANCE', locationRestriction: { circle: { center: point, radius: 8000 } } }, 'places.id,places.displayName,places.formattedAddress,places.location,places.evChargeOptions');
      return (data.places || []).map(place => ({
        id: `google-${place.id}`, name: place.displayName?.text || 'EV charging station', address: place.formattedAddress || '', location: place.location,
        connectors: (place.evChargeOptions?.connectorAggregation || []).map(connector => ({ type: connector.type, powerKw: connector.maxChargeRateKw || null })), source: 'Google Places'
      }));
    } catch (error) {
      if (error.status === 429) placesBlockedUntil = Date.now() + 10 * 60_000;
      return [];
    }
  });
}

function openChargeStation(place) {
  const location = { latitude: place.AddressInfo?.Latitude, longitude: place.AddressInfo?.Longitude };
  return {
    id: `ocm-${place.ID}`, name: place.AddressInfo?.Title || 'EV charging station', location,
    address: [place.AddressInfo?.AddressLine1, place.AddressInfo?.Town, place.AddressInfo?.StateOrProvince].filter(Boolean).join(', '),
    connectors: (place.Connections || []).map(connector => ({ type: connector.ConnectionType?.Title || 'Connector', powerKw: connector.PowerKW || null })),
    source: 'Open Charge Map', validation: 'Open Charge Map', ocmStatus: place.StatusType?.Title || null, access: place.UsageType?.Title || null, lastVerified: place.DateLastVerified || null
  };
}

async function openChargeStations(point) {
  if (!process.env.OPENCHARGEMAP_API_KEY) return [];
  return cached(`ocm:${cacheKey(point)}`, 24 * 60 * 60_000, async () => {
    try {
      const url = new URL(OCM_URL);
      url.search = new URLSearchParams({ output: 'json', latitude: point.latitude, longitude: point.longitude, distance: '8', distanceunit: 'KM', maxresults: '12', key: process.env.OPENCHARGEMAP_API_KEY });
      const response = await fetchWithTimeout(url, {}, 9000);
      return response.ok ? (await response.json()).map(openChargeStation).filter(station => validPoint(station.location)) : [];
    } catch { return []; }
  });
}

function mergeStations(stations) {
  const merged = [];
  for (const station of stations.filter(station => validPoint(station.location))) {
    const existing = merged.find(candidate => distanceKm(candidate.location, station.location) < 0.3);
    if (!existing) { merged.push(station); continue; }
    if (!existing.connectors.length && station.connectors.length) existing.connectors = station.connectors;
    if (station.source === 'Open Charge Map') Object.assign(existing, { validation: 'Verified against Open Charge Map', ocmStatus: station.ocmStatus, access: station.access, lastVerified: station.lastVerified });
  }
  return merged;
}

function selectStops(legs, rangeKm) {
  const bufferKm = rangeKm * 0.15, plan = [];
  let batteryKm = rangeKm;
  for (const leg of legs) {
    const lengthKm = leg.distanceMeters / 1000;
    let positionKm = 0, candidates = [...leg.stations].sort((a, b) => a.routeKm - b.routeKm), selectedStops = [], warning = null;
    while (lengthKm - positionKm > batteryKm - bufferKm) {
      const reachable = candidates.filter(station => station.routeKm >= positionKm - 0.5 && station.routeKm <= positionKm + batteryKm - bufferKm);
      if (!reachable.length) { warning = `No listed charger could be reached while preserving the ${Math.round(bufferKm)} km buffer.`; break; }
      const station = reachable.at(-1), travelledKm = Math.max(0, station.routeKm - positionKm);
      batteryKm = Math.max(0, batteryKm - travelledKm);
      selectedStops.push({ ...station, arrivalRangeKm: Math.round(batteryKm) });
      batteryKm = rangeKm;
      positionKm = Math.max(positionKm, station.routeKm + 0.5);
      candidates = candidates.filter(candidate => candidate.id !== station.id);
      if (selectedStops.length > 5) { warning = 'More than five charge stops would be required on this leg.'; break; }
    }
    batteryKm = Math.max(0, batteryKm - (lengthKm - positionKm));
    plan.push({ ...leg, selectedStops, needsCharge: selectedStops.length > 0 || Boolean(warning), arrivalRangeKm: Math.round(batteryKm), warning });
  }
  return plan;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return respond(res, 405, { error: 'Method not allowed.' });
  if (!process.env.GOOGLE_MAPS_API_KEY) return respond(res, 500, { error: 'Google Maps is not configured yet.' });
  const { start, stops, range, model } = req.body || {};
  const usableRange = Number(range);
  if (!start?.label || !Array.isArray(stops) || !stops.length || stops.length > 8 || !Number.isFinite(usableRange) || usableRange < 100 || usableRange > 1_000) return respond(res, 400, { error: 'Enter a start, one to eight stops, and a usable range between 100 and 1,000 km.' });
  if (String(model || '').length > 100 || [start, ...stops].some(place => !place?.label || String(place.label).length > 180)) return respond(res, 400, { error: 'One of the trip details is invalid.' });
  try {
    const route = [start, ...stops, start];
    const result = await google(ROUTES_URL, { origin: asLocation(start), destination: asLocation(start), intermediates: stops.map(asLocation), travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE' }, 'routes.distanceMeters,routes.legs.distanceMeters,routes.legs.duration,routes.legs.startLocation,routes.legs.endLocation,routes.legs.polyline.encodedPolyline');
    const routeData = result.routes?.[0];
    if (!routeData?.legs?.length) throw Error('No driveable route was found.');
    const providerWarnings = [];
    const rawLegs = await Promise.all(routeData.legs.map(async (routeLeg, index) => {
      const sampleResults = await Promise.all(routeSamples(routeLeg).map(async point => {
        const [google, ocm] = await Promise.all([googleStations(point), openChargeStations(point)]);
        return [...google, ...ocm];
      }));
      const stations = mergeStations(sampleResults.flat()).map(station => ({ ...station, ...routePosition(station.location, routeLeg) })).filter(station => station.offRouteKm <= 10).sort((a, b) => a.routeKm - b.routeKm).slice(0, 30);
      if (!stations.length) providerWarnings.push(`No station records were returned near ${label(route[index])} → ${label(route[index + 1])}.`);
      return { from: label(route[index]), to: label(route[index + 1]), distanceMeters: metres(routeLeg.distanceMeters), durationSeconds: metres(routeLeg.duration), stations };
    }));
    return respond(res, 200, { route: route.map(label), model, totalMeters: metres(routeData.distanceMeters), rangeKm: usableRange, bufferKm: Math.round(usableRange * 0.15), providerWarnings, legs: selectStops(rawLegs, usableRange) });
  } catch (error) { return respond(res, error.status === 403 ? 403 : 502, { error: error.message || 'Unable to build this route.' }); }
}
