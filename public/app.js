'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const API_BASE         = 'https://find-your-hovel.pierce-408.workers.dev'; 
const MIN_MOVE_METRES  = 500;   // minimum distance before re-querying
const POLL_INTERVAL_MS = 60_000; // re-query even if stationary (1 min)
const MAX_PRICE        = 120000;

// ── PropertyRadar class ───────────────────────────────────────────────────────
class PropertyRadar {
  constructor() {
    this.map           = null;
    this.userMarker    = null;
    this.markers       = {};       // id → Leaflet marker
    this.seenIds       = new Set();
    this.watchId       = null;
    this.pollTimer     = null;
    this.lastSearchPos = null;
    this.lastSearchAt  = 0;
    this.isTracking    = false;
    this.following     = true;   // pan map to keep user centred
    this.realPos       = null;   // actual GPS position (separate from dragged pin)
    this.searchToken   = 0;      // incremented on each intentional search; stale responses are dropped
    this.audioCtx      = null;
    this.panelOpen     = true;

    this._init();
  }

  // ── Init ────────────────────────────────────────────────────────────────────
  _init() {
    this._initMap();
    this._bindUI();
    this._registerSW();
    this._requestNotificationPermission();
  }

  _initMap() {
    this.map = L.map('map', { zoomControl: true }).setView([53.1424, -7.6921], 7);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19
    }).addTo(this.map);

    // Any manual drag/zoom turns off follow mode
    this.map.on('dragstart', () => this._setFollowing(false));
  }

  _bindUI() {
    document.getElementById('btn-start') .addEventListener('click', () => this.startTracking());
    document.getElementById('btn-stop')  .addEventListener('click', () => this.stopTracking());
    document.getElementById('btn-test')  .addEventListener('click', () => this._testAlert());
    document.getElementById('btn-follow').addEventListener('click', () => this._setFollowing(true));

    // Collapse / expand bottom panel on handle tap
    const handle = document.getElementById('panel-handle');
    const panel  = document.getElementById('bottom-panel');
    handle.addEventListener('click', () => {
      this.panelOpen = !this.panelOpen;
      panel.classList.toggle('collapsed', !this.panelOpen);
    });
  }

  async _registerSW() {
    if (!('serviceWorker' in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      console.log('[SW] Registered, scope:', reg.scope);
    } catch (e) {
      console.warn('[SW] Registration failed:', e);
    }
  }

  async _requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      const result = await Notification.requestPermission();
      console.log('[Notifications]', result);
    }
  }

  // ── Tracking ────────────────────────────────────────────────────────────────
  startTracking() {
    if (!navigator.geolocation) {
      this._setStatus('Geolocation not supported by this browser', 'error');
      return;
    }

    this.isTracking = true;
    this._updateControlState();
    this._setStatus('Acquiring GPS…', 'searching');

    this.watchId = navigator.geolocation.watchPosition(
      pos => this._onPosition(pos),
      err => this._onGeoError(err),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 6000 }
    );

    // Fallback poll: re-query from last known position even if not moving much
    this.pollTimer = setInterval(() => {
      if (this.following && this.lastSearchPos) this._search(this.lastSearchPos);
    }, POLL_INTERVAL_MS);

    document.getElementById('radar-dot').classList.add('active');
  }

  stopTracking() {
    this.isTracking = false;

    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    clearInterval(this.pollTimer);
    this.pollTimer = null;

    document.getElementById('radar-dot').classList.remove('active');
    this._updateControlState();
    this._setStatus('Tracking stopped', 'info');
  }

  // ── Position handling ────────────────────────────────────────────────────────
  _onPosition(pos) {
    const { latitude: lat, longitude: lng, accuracy } = pos.coords;

    // Update / create user location marker
    if (!this.userMarker) {
      const icon = L.divIcon({
        className: 'user-location-icon',
        iconSize: [16, 16],
        iconAnchor: [8, 8]
      });
      this.userMarker = L.marker([lat, lng], { icon, zIndexOffset: 1000, draggable: true })
        .addTo(this.map)
        .bindPopup('<b>You are here</b>');
      this.map.setView([lat, lng], 14);

      this.userMarker.on('dragstart', () => {
        this._setFollowing(false);
        this._setStatus('Drop pin to search that location…', 'searching');
      });
      this.userMarker.on('dragend', () => {
        const { lat, lng } = this.userMarker.getLatLng();
        this._resetResults();
        this._setStatus('Searching pinned location…', 'searching');
        this._search({ lat, lng });
      });
    } else {
      this.realPos = { lat, lng };
      if (this.following) {
        this.userMarker.setLatLng([lat, lng]);
        this.map.panTo([lat, lng], { animate: true, duration: 1 });
      }
    }

    // When pin is manually dragged, GPS updates must not interfere at all
    if (!this.following) {
      console.log('[GPS] following=false, ignoring GPS fix', lat.toFixed(4), lng.toFixed(4));
      return;
    }

    const accStr = accuracy < 1000
      ? `±${Math.round(accuracy)}m`
      : `±${(accuracy / 1000).toFixed(1)}km`;
    this._setStatus(`GPS ${lat.toFixed(4)}, ${lng.toFixed(4)} (${accStr})`, 'info');

    const cur = { lat, lng };
    const movedEnough = !this.lastSearchPos ||
      this._haversine(this.lastSearchPos, cur) >= MIN_MOVE_METRES;
    const staleEnough = (Date.now() - this.lastSearchAt) >= POLL_INTERVAL_MS;

    if (movedEnough || staleEnough) {
      this.lastSearchPos = cur;
      this._search(cur);
    }
  }

  _onGeoError(err) {
    const MSG = {
      1: 'Location permission denied',
      2: 'Position unavailable',
      3: 'GPS timeout — retrying…'
    };
    this._setStatus(MSG[err.code] || `GPS error: ${err.message}`, 'error');
  }

  // ── API search ───────────────────────────────────────────────────────────────
  async _search(pos) {
    const token = ++this.searchToken;
    this.lastSearchAt = Date.now();
    console.log(`[SEARCH] token=${token} lat=${pos.lat.toFixed(4)} lng=${pos.lng.toFixed(4)}`);
    this._setStatus(`Searching near ${pos.lat.toFixed(3)}, ${pos.lng.toFixed(3)}…`, 'searching');

    try {
      const url = `${API_BASE}/api/properties?lat=${pos.lat}&lng=${pos.lng}`;
      const res  = await fetch(url);
      const data = await res.json();

      if (token !== this.searchToken) {
        console.log(`[SEARCH] token=${token} discarded (current=${this.searchToken})`);
        return;
      }

      if (!data.success) throw new Error(data.error || 'Server error');

      const area = data.displayLocation || data.area;
      console.log(`[SEARCH] token=${token} got ${data.count} results for ${area}`);
      this._setStatus(`${data.count} listing${data.count !== 1 ? 's' : ''} in ${area}`, 'success');
      this._processResults(data.properties);

    } catch (err) {
      if (token !== this.searchToken) return;
      this._setStatus(`Search error: ${err.message}`, 'error');
      console.error('[Search]', err);
    }
  }

  // ── Results ─────────────────────────────────────────────────────────────────
  _processResults(properties) {
    const fresh = properties.filter(p => !this.seenIds.has(p.id));
    fresh.forEach(p => {
      this.seenIds.add(p.id);
      this._addMarker(p);
      this._addCard(p);
    });

    document.getElementById('prop-count').textContent = this.seenIds.size;

    if (fresh.length > 0) {
      this._alert(fresh);
      // Expand panel when new results arrive
      if (!this.panelOpen) {
        this.panelOpen = true;
        document.getElementById('bottom-panel').classList.remove('collapsed');
      }
    }
  }

  // ── Map marker ──────────────────────────────────────────────────────────────
  _addMarker(prop) {
    if (!prop.latitude || !prop.longitude) return;

    const priceLabel = prop.price
      ? `€${prop.price >= 1000 ? Math.round(prop.price / 1000) + 'k' : prop.price}`
      : '€?';

    const icon = L.divIcon({
      className: '',
      html: `<div class="price-pin">${priceLabel}</div>`,
      iconSize: [null, null],
      iconAnchor: [0, 30]
    });

    const marker = L.marker([prop.latitude, prop.longitude], { icon })
      .addTo(this.map)
      .bindPopup(this._popupHTML(prop));

    this.markers[prop.id] = marker;
  }

  _popupHTML(prop) {
    const price   = prop.price ? `€${prop.price.toLocaleString('en-IE')}` : 'Price TBC';
    const details = [prop.propertyType, prop.bedrooms && `${prop.bedrooms} bed`, prop.bathrooms && `${prop.bathrooms} bath`]
      .filter(Boolean).join(' · ');
    const img  = prop.thumbnail
      ? `<img src="${prop.thumbnail}" style="width:100%;border-radius:6px;margin-bottom:6px;display:block" loading="lazy">`
      : '';
    const link = prop.url ? `<a href="${prop.url}" target="_blank" rel="noopener" style="display:block;margin-top:6px">View on Daft →</a>` : '';

    return `${img}<strong>${price}</strong><br>
${prop.address || prop.title || 'Address unknown'}<br>
<small style="color:#94a3b8">${details}</small>${link}`;
  }

  // ── Property card ────────────────────────────────────────────────────────────
  _addCard(prop) {
    const list = document.getElementById('property-list');

    // Remove empty-state placeholder on first result
    const empty = list.querySelector('.empty-state');
    if (empty) empty.remove();

    const price   = prop.price ? `€${prop.price.toLocaleString('en-IE')}` : 'Price TBC';
    const details = [prop.propertyType, prop.bedrooms && `${prop.bedrooms} bed`, prop.county]
      .filter(Boolean).join(' · ');

    const card = document.createElement('div');
    card.className = 'property-card new';
    card.dataset.id = prop.id;
    card.innerHTML = `
      <div class="card-row">
        <span class="prop-price">${price}</span>
        ${prop.propertyType ? `<span class="prop-type">${prop.propertyType}</span>` : ''}
      </div>
      <div class="prop-address">${prop.address || prop.title || 'Address unknown'}</div>
      ${details ? `<div class="prop-meta">${details}</div>` : ''}
      ${prop.url ? `<a class="prop-link" href="${prop.url}" target="_blank" rel="noopener">View on Daft →</a>` : ''}
    `;

    // Fly to marker on card tap
    if (prop.latitude && prop.longitude) {
      card.addEventListener('click', e => {
        if (e.target.tagName === 'A') return; // let link open normally
        this.map.flyTo([prop.latitude, prop.longitude], 15, { duration: 1 });
        this.markers[prop.id]?.openPopup();
      });
    }

    list.prepend(card);
    setTimeout(() => card.classList.remove('new'), 4000);
  }

  // ── Alerts ───────────────────────────────────────────────────────────────────
  _alert(props) {
    this._playChime();
    this._sendNotification(props);
    this._flashHeader();
  }

  _playChime() {
    try {
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      // C major chord arpeggio: C5 → E5 → G5
      [523.25, 659.25, 783.99].forEach((freq, i) => {
        const osc  = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();
        osc.connect(gain);
        gain.connect(this.audioCtx.destination);

        osc.type = 'sine';
        osc.frequency.value = freq;

        const t = this.audioCtx.currentTime + i * 0.18;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.25, t + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);

        osc.start(t);
        osc.stop(t + 0.46);
      });
    } catch (e) {
      console.warn('[Audio] Chime failed:', e);
    }
  }

  _sendNotification(props) {
    if (Notification.permission !== 'granted') return;

    const n    = props.length;
    const p    = props[0];
    const price = p.price ? `€${p.price.toLocaleString('en-IE')}` : 'New listing';

    new Notification(`${n} new propert${n > 1 ? 'ies' : 'y'} found!`, {
      body: `${price} — ${p.address || p.title || ''}`,
      icon: '/icons/icon.svg',
      tag:  'property-alert',
      renotify: true,
      silent: false
    });
  }

  _flashHeader() {
    const header = document.getElementById('app-header');
    header.classList.add('flash');
    setTimeout(() => header.classList.remove('flash'), 1200);
  }

  // ── Test ─────────────────────────────────────────────────────────────────────
  _testAlert() {
    const fakeProps = [{
      id: `test-${Date.now()}`,
      price: 87500,
      address: 'Test Property, Main St, Athlone',
      title: 'Test Listing',
      county: 'Westmeath',
      propertyType: 'Cottage',
      bedrooms: '2',
      latitude: 53.4239,
      longitude: -7.9407,
      url: ''
    }];
    this._processResults(fakeProps);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  _resetResults() {
    this.searchToken++;
    console.log(`[RESET] token bumped to ${this.searchToken}`);
    Object.values(this.markers).forEach(m => m.remove());
    this.markers = {};
    this.seenIds.clear();
    document.getElementById('prop-count').textContent = '0';
    // Clear the property list
    const list = document.getElementById('property-list');
    list.innerHTML = '<p class="empty-state">Searching new location…</p>';
  }

  _setFollowing(on) {
    this.following = on;
    const btn = document.getElementById('btn-follow');
    btn.classList.toggle('active', on);
    btn.title = on ? 'Following — tap map to browse freely' : 'Re-centre on your location';
    if (on && this.realPos) {
      this.userMarker.setLatLng([this.realPos.lat, this.realPos.lng]);
      this.map.panTo([this.realPos.lat, this.realPos.lng], { animate: true, duration: 0.5 });
      this._resetResults();
      this._search(this.realPos);
    }
  }

  _setStatus(msg, type = 'info') {
    const el = document.getElementById('status-bar');
    el.textContent = msg;
    el.className   = `status-bar status-${type}`;
  }

  _updateControlState() {
    document.getElementById('btn-start').disabled = this.isTracking;
    document.getElementById('btn-stop') .disabled = !this.isTracking;
  }

  /** Haversine distance in metres between two {lat,lng} points */
  _haversine(a, b) {
    const R  = 6_371_000;
    const φ1 = a.lat * Math.PI / 180;
    const φ2 = b.lat * Math.PI / 180;
    const Δφ = (b.lat - a.lat) * Math.PI / 180;
    const Δλ = (b.lng - a.lng) * Math.PI / 180;
    const x  = Math.sin(Δφ/2) ** 2 +
               Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  window.radar = new PropertyRadar();
});
