const cache = new Map();
const CACHE_LIMIT = 180;
const respond = (res, status, body) => { res.status(status).setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };

async function fetchWithTimeout(url, options, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return respond(res, 405, { error: 'Method not allowed.' });
  const query = String(req.query?.q || '').trim().replace(/\s+/g, ' ');
  if (query.length < 2) return respond(res, 200, { suggestions: [] });
  if (query.length > 180) return respond(res, 400, { error: 'Location query is too long.' });
  if (!process.env.GOOGLE_MAPS_API_KEY) return respond(res, 500, { error: 'Google Maps is not configured yet.' });
  const cacheKey = query.toLowerCase();
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < 60 * 60_000) return respond(res, 200, hit.value);
  try {
    const response = await fetchWithTimeout('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY, 'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.text' },
      body: JSON.stringify({ input: query, includedRegionCodes: ['IN'], languageCode: 'en' })
    });
    if (!response.ok) throw Error(response.status === 429 ? 'Suggestions are busy. Type a little more and try again.' : 'Location suggestions are unavailable right now.');
    const data = await response.json();
    const value = { suggestions: (data.suggestions || []).map(item => ({ placeId: item.placePrediction?.placeId, label: item.placePrediction?.text?.text })).filter(item => item.placeId && item.label).slice(0, 5) };
    cache.set(cacheKey, { at: Date.now(), value });
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    return respond(res, 200, value);
  } catch (error) { return respond(res, 502, { error: error.message || 'Location suggestions are unavailable right now.' }); }
}
