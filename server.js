require('dotenv').config();
const express = require('express');
const path    = require('path');
const axios   = require('axios');

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── Daft county name → internal storedShapeId ───────────────────────────────
// IDs sourced from https://gateway.daft.ie/old/v1/location/classifiedAreas
const COUNTY_ID = {
  dublin:     '1',  meath:      '2',  kildare:    '3',  wicklow:    '4',
  longford:   '5',  offaly:     '6',  westmeath:  '7',  laois:      '8',
  louth:      '9',  carlow:     '10', kilkenny:   '11', waterford:  '12',
  wexford:    '13', kerry:      '14', cork:       '15', clare:      '16',
  limerick:   '17', tipperary:  '18', galway:     '19', mayo:       '20',
  roscommon:  '21', sligo:      '22', leitrim:    '23', donegal:    '24',
  cavan:      '25', monaghan:   '26', antrim:     '27', armagh:     '28',
  tyrone:     '29', fermanagh:  '30', derry:      '31', down:       '32',
};

// ─── Property types to exclude (land-only listings) ──────────────────────────
const LAND_TYPES = new Set(['site', 'land', 'sites']);

// ─── County adjacency map ─────────────────────────────────────────────────────
// Every county lists its land/short-sea neighbours so we always search across borders.
const NEIGHBOURS = {
  dublin:     ['meath','kildare','wicklow'],
  meath:      ['dublin','louth','monaghan','cavan','westmeath','offaly','kildare'],
  kildare:    ['dublin','meath','offaly','laois','carlow','wicklow'],
  wicklow:    ['dublin','kildare','carlow','wexford'],
  longford:   ['westmeath','roscommon','leitrim','cavan'],
  offaly:     ['meath','kildare','laois','tipperary','galway','westmeath'],
  westmeath:  ['meath','longford','roscommon','offaly','cavan'],
  laois:      ['kildare','offaly','tipperary','kilkenny','carlow'],
  louth:      ['meath','monaghan','armagh','down'],
  carlow:     ['kildare','laois','kilkenny','wexford','wicklow'],
  kilkenny:   ['laois','carlow','wexford','waterford','tipperary'],
  waterford:  ['kilkenny','tipperary','cork','wexford'],
  wexford:    ['wicklow','carlow','kilkenny','waterford'],
  kerry:      ['cork','limerick'],
  cork:       ['kerry','limerick','tipperary','waterford'],
  clare:      ['galway','limerick','tipperary'],
  limerick:   ['kerry','cork','tipperary','clare'],
  tipperary:  ['limerick','cork','waterford','kilkenny','laois','offaly','galway','clare'],
  galway:     ['mayo','roscommon','offaly','tipperary','clare'],
  mayo:       ['galway','roscommon','sligo'],
  roscommon:  ['mayo','galway','offaly','westmeath','longford','leitrim','sligo'],
  sligo:      ['mayo','roscommon','leitrim','donegal'],
  leitrim:    ['sligo','roscommon','longford','cavan','fermanagh','donegal'],
  donegal:    ['sligo','leitrim','fermanagh','derry'],
  cavan:      ['meath','westmeath','longford','leitrim','fermanagh','monaghan'],
  monaghan:   ['meath','louth','cavan','armagh','tyrone'],
  antrim:     ['derry','tyrone','armagh','down'],
  armagh:     ['louth','monaghan','tyrone','antrim','down'],
  tyrone:     ['donegal','derry','fermanagh','monaghan','armagh','antrim'],
  fermanagh:  ['donegal','leitrim','cavan','monaghan','tyrone'],
  derry:      ['donegal','tyrone','antrim'],
  down:       ['louth','armagh','antrim'],
};

// ─── Nominatim county string → COUNTY_ID key ─────────────────────────────────
function normaliseCounty(addr = {}) {
  const raw = (addr.county || addr.state_district || addr.state || addr.city || 'dublin')
    .toLowerCase()
    .replace(/^county\s+/, '')
    .replace(/\s+county$/, '')
    .replace(/\s+/g, '_')
    .trim();

  const ALIASES = {
    tipperary_north: 'tipperary', tipperary_south:       'tipperary',
    north_tipperary: 'tipperary', south_tipperary:       'tipperary',
    dun_laoghaire_rathdown: 'dublin', south_dublin:      'dublin',
    fingal:          'dublin',    cork_city:             'cork',
    galway_city:     'galway',    limerick_city:         'limerick',
    waterford_city:  'waterford', londonderry:           'derry',
  };
  return ALIASES[raw] || raw;
}

// ─── Reverse geocode via Nominatim ────────────────────────────────────────────
async function reverseGeocode(lat, lng) {
  const { data } = await axios.get('https://nominatim.openstreetmap.org/reverse', {
    params: { format: 'json', lat, lon: lng, zoom: 8, addressdetails: 1 },
    headers: { 'User-Agent': 'CheapPropertyRadar/1.0' },
    timeout: 8000,
  });
  return data;
}

// ─── Simple cache (5-min TTL) ─────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
const cacheGet = k => { const e = cache.get(k); return e && Date.now() < e.exp ? e.val : null; };
const cacheSet = (k, v) => cache.set(k, { val: v, exp: Date.now() + CACHE_TTL });

// ─── Daft gateway headers ─────────────────────────────────────────────────────
const GATEWAY_HEADERS = {
  'Content-Type': 'application/json',
  'Accept':       'application/json',
  'User-Agent':   'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120',
  'Referer':      'https://www.daft.ie/',
  'Origin':       'https://www.daft.ie',
  'brand':        'daft',
  'platform':     'web',
};

// ─── Query Daft gateway API ───────────────────────────────────────────────────
async function queryDaft(countyKey, maxPrice = 120000) {
  const cacheKey = `${countyKey}-${maxPrice}`;
  const cached   = cacheGet(cacheKey);
  if (cached) { console.log(`[CACHE] hit for ${cacheKey}`); return cached; }

  const shapeId = COUNTY_ID[countyKey];
  if (!shapeId) throw new Error(`Unknown county: "${countyKey}"`);

  const body = {
    section:    'residential-for-sale',
    filters:    [{ name: 'adState', values: ['published'] }],
    ranges:     [{ name: 'salePrice', from: 0, to: maxPrice }],
    paging:     { from: 0, pageSize: 20 },
    geoFilter:  { storedShapeIds: [shapeId], geoSearchType: 'STORED_SHAPES' },
    andFilters: [],
    sort:       'publishDateDesc',
  };

  console.log(`[API] county=${countyKey} (id=${shapeId}) maxPrice=€${maxPrice.toLocaleString()}`);

  const { data } = await axios.post(
    'https://gateway.daft.ie/old/v1/listings/search',
    body,
    { headers: GATEWAY_HEADERS, timeout: 15000 }
  );

  const properties = (data.listings || []).map(raw => mapListing(raw, countyKey));
  console.log(`[API] ${data.paging?.totalResults ?? '?'} total matches, returned ${properties.length}`);

  cacheSet(cacheKey, properties);
  return properties;
}

// ─── Normalise a Daft listing to our shape ────────────────────────────────────
// Confirmed schema:  raw.listing holds the data
// price  = "€60,000" or "AMV: €90,000"
// point  = { type:'Point', coordinates:[lng, lat] }  (GeoJSON — lng first)
// numBedrooms / numBathrooms = "2 Bed" / "1 Bath"
function mapListing(raw, county) {
  const l = raw?.listing ?? raw;

  // Parse price: strip leading label ("AMV: "), euro sign, commas
  const rawPrice = String(l?.price ?? l?.displayPrice ?? '0');
  const price    = parseInt(rawPrice.replace(/^[^0-9€]*/, '').replace(/[^0-9]/g, ''), 10) || 0;

  // GeoJSON coordinates = [longitude, latitude]
  const coords = l?.point?.coordinates;
  const lat    = coords ? coords[1] : parseFloat(l?.latitude  ?? l?.lat ?? 0);
  const lng    = coords ? coords[0] : parseFloat(l?.longitude ?? l?.lng ?? 0);

  const seoPath = l?.seoFriendlyPath ?? l?.path ?? '';

  return {
    id:           String(l?.id ?? Math.random()),
    title:        l?.title ?? l?.seoTitle ?? '',
    price,
    address:      l?.title ?? l?.seoTitle ?? '',
    county,
    latitude:     lat,
    longitude:    lng,
    url:          seoPath ? `https://www.daft.ie${seoPath}` : 'https://www.daft.ie',
    thumbnail:    l?.media?.images?.[0]?.size720x480 ?? '',
    propertyType: l?.propertyType ?? '',
    bedrooms:     String(l?.numBedrooms  ?? '').replace(/\s*bed.*/i, '').trim(),
    bathrooms:    String(l?.numBathrooms ?? '').replace(/\s*bath.*/i, '').trim(),
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/properties', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ success: false, error: 'lat and lng are required numbers' });
  }

  try {
    const geocode       = await reverseGeocode(lat, lng);
    const county        = normaliseCounty(geocode.address);
    const displayLocation = geocode.address?.county ?? geocode.address?.state ?? county;

    const countiesToSearch = [county, ...(NEIGHBOURS[county] || [])];
    console.log(`[REQUEST] lat=${lat} lng=${lng} → ${county} + ${countiesToSearch.length - 1} neighbours`);

    // Query all counties in parallel, ignore individual failures
    const results = await Promise.allSettled(countiesToSearch.map(c => queryDaft(c)));
    const seen = new Set();
    const properties = results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value)
      .filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; })
      .filter(p => !LAND_TYPES.has(p.propertyType.toLowerCase()))
      .sort((a, b) => a.price - b.price);

    res.json({
      success: true,
      area: county,
      displayLocation,
      searchedCounties: countiesToSearch,
      coordinates: { lat, lng },
      count: properties.length,
      properties,
    });
  } catch (err) {
    console.error('[ERROR]', err.message);
    res.status(500).json({ success: false, error: err.message, properties: [] });
  }
});

// Manual test: /api/test?county=roscommon
app.get('/api/test', async (req, res) => {
  const county = (req.query.county || 'roscommon').toLowerCase();
  try {
    const countiesToSearch = [county, ...(NEIGHBOURS[county] || [])];
    const results = await Promise.allSettled(countiesToSearch.map(c => queryDaft(c)));
    const seen = new Set();
    const properties = results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value)
      .filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; })
      .filter(p => !LAND_TYPES.has(p.propertyType.toLowerCase()))
      .sort((a, b) => a.price - b.price);
    res.json({ success: true, county, searchedCounties: countiesToSearch, count: properties.length, sample: properties.slice(0, 5) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), mode: 'gateway-api' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nCheapPropertyRadar → http://localhost:${PORT}`);
  console.log(`Test: http://localhost:${PORT}/api/test?county=roscommon\n`);
});
