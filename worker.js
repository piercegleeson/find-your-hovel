const COUNTY_ID = {
  dublin:    '1',  meath:     '2',  kildare:   '3',  wicklow:   '4',
  longford:  '5',  offaly:    '6',  westmeath: '7',  laois:     '8',
  louth:     '9',  carlow:    '10', kilkenny:  '11', waterford: '12',
  wexford:   '13', kerry:     '14', cork:      '15', clare:     '16',
  limerick:  '17', tipperary: '18', galway:    '19', mayo:      '20',
  roscommon: '21', sligo:     '22', leitrim:   '23', donegal:   '24',
  cavan:     '25', monaghan:  '26', antrim:    '27', armagh:    '28',
  tyrone:    '29', fermanagh: '30', derry:     '31', down:      '32',
};

const LAND_TYPES = new Set(['site', 'land', 'sites']);

const NEIGHBOURS = {
  dublin:    ['meath','kildare','wicklow'],
  meath:     ['dublin','louth','monaghan','cavan','westmeath','offaly','kildare'],
  kildare:   ['dublin','meath','offaly','laois','carlow','wicklow'],
  wicklow:   ['dublin','kildare','carlow','wexford'],
  longford:  ['westmeath','roscommon','leitrim','cavan'],
  offaly:    ['meath','kildare','laois','tipperary','galway','westmeath'],
  westmeath: ['meath','longford','roscommon','offaly','cavan'],
  laois:     ['kildare','offaly','tipperary','kilkenny','carlow'],
  louth:     ['meath','monaghan','armagh','down'],
  carlow:    ['kildare','laois','kilkenny','wexford','wicklow'],
  kilkenny:  ['laois','carlow','wexford','waterford','tipperary'],
  waterford: ['kilkenny','tipperary','cork','wexford'],
  wexford:   ['wicklow','carlow','kilkenny','waterford'],
  kerry:     ['cork','limerick'],
  cork:      ['kerry','limerick','tipperary','waterford'],
  clare:     ['galway','limerick','tipperary'],
  limerick:  ['kerry','cork','tipperary','clare'],
  tipperary: ['limerick','cork','waterford','kilkenny','laois','offaly','galway','clare'],
  galway:    ['mayo','roscommon','offaly','tipperary','clare'],
  mayo:      ['galway','roscommon','sligo'],
  roscommon: ['mayo','galway','offaly','westmeath','longford','leitrim','sligo'],
  sligo:     ['mayo','roscommon','leitrim','donegal'],
  leitrim:   ['sligo','roscommon','longford','cavan','fermanagh','donegal'],
  donegal:   ['sligo','leitrim','fermanagh','derry'],
  cavan:     ['meath','westmeath','longford','leitrim','fermanagh','monaghan'],
  monaghan:  ['meath','louth','cavan','armagh','tyrone'],
  antrim:    ['derry','tyrone','armagh','down'],
  armagh:    ['louth','monaghan','tyrone','antrim','down'],
  tyrone:    ['donegal','derry','fermanagh','monaghan','armagh','antrim'],
  fermanagh: ['donegal','leitrim','cavan','monaghan','tyrone'],
  derry:     ['donegal','tyrone','antrim'],
  down:      ['louth','armagh','antrim'],
};

const ALIASES = {
  tipperary_north: 'tipperary', tipperary_south:    'tipperary',
  north_tipperary: 'tipperary', south_tipperary:    'tipperary',
  dun_laoghaire_rathdown: 'dublin', south_dublin:   'dublin',
  fingal:          'dublin',    cork_city:          'cork',
  galway_city:     'galway',    limerick_city:      'limerick',
  waterford_city:  'waterford', londonderry:        'derry',
};

function normaliseCounty(addr = {}) {
  const raw = (addr.county || addr.state_district || addr.state || addr.city || 'dublin')
    .toLowerCase()
    .replace(/^county\s+/, '')
    .replace(/\s+county$/, '')
    .replace(/\s+/g, '_')
    .trim();
  return ALIASES[raw] || raw;
}

function mapListing(raw, county) {
  const l = raw?.listing ?? raw;
  const rawPrice = String(l?.price ?? l?.displayPrice ?? '0');
  const price = parseInt(rawPrice.replace(/^[^0-9€]*/, '').replace(/[^0-9]/g, ''), 10) || 0;
  const coords = l?.point?.coordinates;
  const lat = coords ? coords[1] : parseFloat(l?.latitude ?? l?.lat ?? 0);
  const lng = coords ? coords[0] : parseFloat(l?.longitude ?? l?.lng ?? 0);
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
    bedrooms:     String(l?.numBedrooms  ?? '').replace(/\s*bed.*/i,  '').trim(),
    bathrooms:    String(l?.numBathrooms ?? '').replace(/\s*bath.*/i, '').trim(),
  };
}

async function queryDaft(countyKey, maxPrice = 120000, ctx) {
  const shapeId = COUNTY_ID[countyKey];
  if (!shapeId) throw new Error(`Unknown county: "${countyKey}"`);

  const cacheKey = new Request(`https://cache.internal/daft/${countyKey}/${maxPrice}`);
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached.json();

  const body = {
    section:    'residential-for-sale',
    filters:    [{ name: 'adState', values: ['published'] }],
    ranges:     [{ name: 'salePrice', from: 0, to: maxPrice }],
    paging:     { from: 0, pageSize: 20 },
    geoFilter:  { storedShapeIds: [shapeId], geoSearchType: 'STORED_SHAPES' },
    andFilters: [],
    sort:       'publishDateDesc',
  };

  const res = await fetch('https://gateway.daft.ie/old/v1/listings/search', {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept':       'application/json',
      'User-Agent':   'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120',
      'Referer':      'https://www.daft.ie/',
      'Origin':       'https://www.daft.ie',
      'brand':        'daft',
      'platform':     'web',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Daft API error: ${res.status}`);
  const data = await res.json();
  const properties = (data.listings || []).map(raw => mapListing(raw, countyKey));

  ctx.waitUntil(
    caches.default.put(cacheKey, new Response(JSON.stringify(properties), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=300' },
    }))
  );

  return properties;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

export default {
  async fetch(request, _env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === '/api/properties') {
      const lat = parseFloat(url.searchParams.get('lat'));
      const lng = parseFloat(url.searchParams.get('lng'));
      if (isNaN(lat) || isNaN(lng)) {
        return json({ success: false, error: 'lat and lng are required numbers' }, 400);
      }

      try {
        const geoRes = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=8&addressdetails=1`,
          { headers: { 'User-Agent': 'FindYourHovel/1.0' } }
        );
        const geocode = await geoRes.json();
        const county  = normaliseCounty(geocode.address);
        const displayLocation = geocode.address?.county ?? geocode.address?.state ?? county;

        const countiesToSearch = [county, ...(NEIGHBOURS[county] || [])];

        const results = await Promise.allSettled(
          countiesToSearch.map(c => queryDaft(c, 120000, ctx))
        );

        const seen = new Set();
        const properties = results
          .filter(r => r.status === 'fulfilled')
          .flatMap(r => r.value)
          .filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; })
          .filter(p => !LAND_TYPES.has(p.propertyType.toLowerCase()))
          .sort((a, b) => a.price - b.price);

        return json({
          success: true,
          area: county,
          displayLocation,
          searchedCounties: countiesToSearch,
          coordinates: { lat, lng },
          count: properties.length,
          properties,
        });
      } catch (err) {
        return json({ success: false, error: err.message, properties: [] }, 500);
      }
    }

    return new Response('Not found', { status: 404 });
  },
};
