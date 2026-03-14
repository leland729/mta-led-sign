#!/usr/bin/env node

/**
 * NYC Subway Sign Server
 * Version : 1.4.1
 * Updated : 2026-03-13
 * Changes : Last.FM panel — 3-line layout (artist/album/track), marquee scroll
 *           with 1s hold, album field added to recent-tracks response.
 *
 * v1.4.0  : Page carousel — multi-widget server endpoints (weather proxy,
 *           Last.FM, SEPTA/MLB/NFL stubs), firmware carousel rewrite with
 *           4-panel scroll and lastfm support, Admin UI lastfm_api_key field
 *           and drag-to-reorder pages.
 *
 * Fetches MTA GTFS-Realtime data, parses protobuf, and serves a JSON API
 * for Matrix Portal S3 devices. Includes Firestore-backed device config
 * and firmware generation.
 *
 * Requires Node >= 18 (uses native fetch — no node-fetch needed).
 *
 * Local dev: run `gcloud auth application-default login` once so the
 * Firebase Admin SDK can reach Firestore without a key file.
 */

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const admin   = require('firebase-admin');
const sharp   = require('sharp');
require('dotenv').config();

const { STATIONS, LINE_CONFIGS } = require('./data/mta-stations');
const generateFirmware            = require('./firmware/template');

// ─── Firebase / Firestore ─────────────────────────────────────────────────────
// Cloud Run: uses the attached service account automatically (ADC).
// Local dev : set GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json
//             OR run `gcloud auth application-default login`.
admin.initializeApp();
const db = admin.firestore();

// ─── Express setup ────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Config ───────────────────────────────────────────────────────────────────
const MTA_API_KEY          = process.env.MTA_API_KEY;
const OPENWEATHER_API_KEY  = process.env.OPENWEATHER_API_KEY;
const LASTFM_API_KEY       = process.env.LASTFM_API_KEY;

// This server's own public URL — injected into generated firmware so devices
// know where to phone home. Override via SERVICE_URL env var if needed.
const SERVICE_URL = process.env.SERVICE_URL || 'https://subway-api-829904256043.us-east1.run.app';

// ─── MTA feed URLs ────────────────────────────────────────────────────────────
const GTFS_FEEDS = {
  'G':       'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g',
  'L':       'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l',
  'ACE':     'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace',
  'BDFM':    'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm',
  'NQRW':    'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw',
  '123456S': 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs',
  // '7' feed no longer exists — 7 train is now in the main gtfs feed (123456S)
  'JZ':      'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz',
};

// Station data: STATIONS lookup + LINE_CONFIGS array live in ./data/mta-stations.js

// ─── In-memory fallback cache ─────────────────────────────────────────────────
const lastGoodData = {};

// ─── GTFS helpers ─────────────────────────────────────────────────────────────

/**
 * Fetch and decode a GTFS-RT protobuf feed.
 * Uses native fetch (Node 18+) with a 10-second abort timeout.
 */
async function fetchGTFS(feedGroup = 'G') {
  const url = GTFS_FEEDS[feedGroup];
  if (!url) throw new Error(`Unknown feed group: ${feedGroup}`);

  const headers = {};
  if (MTA_API_KEY) headers['x-api-key'] = MTA_API_KEY;

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 10000);

  try {
    console.log(`[FETCH] ${feedGroup} feed at ${new Date().toLocaleTimeString()}`);
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    const feed   = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);
    console.log(`[FETCH] Got ${feed.entity?.length || 0} entities`);
    return feed;
  } catch (err) {
    console.error(`[FETCH] Error:`, err.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Return the soonest upcoming train at a given stop/direction,
 * or null if none found.
 */
function getNextTrain(feed, stationId, direction) {
  if (!feed?.entity) return null;

  const stopId  = stationId + direction;
  const now     = Math.floor(Date.now() / 1000);
  let nextTrain = null;
  let minTime   = Infinity;

  for (const entity of feed.entity) {
    if (!entity.tripUpdate) continue;
    for (const stop of entity.tripUpdate.stopTimeUpdate || []) {
      if (stop.stopId === stopId) {
        const time = stop.arrival?.time || stop.departure?.time;
        if (time && time > now && time < minTime) {
          minTime   = time;
          nextTrain = {
            route:   entity.tripUpdate.trip.routeId || 'G',
            minutes: Math.max(0, Math.round((time - now) / 60)),
          };
        }
      }
    }
  }

  return nextTrain;
}

// ─── MTA routes ───────────────────────────────────────────────────────────────

/**
 * GET /api/next/:stationId
 * Returns next northbound + southbound train for a station.
 * Falls back to last known good data if MTA feed is empty.
 */
app.get('/api/next/:stationId', async (req, res) => {
  const { stationId } = req.params;
  const station = STATIONS[stationId];
  if (!station) return res.status(404).json({ error: 'Unknown station' });

  try {
    const feed = await fetchGTFS(station.feed_group);

    if (feed?.entity?.length) {
      const northTrain = getNextTrain(feed, stationId, 'N');
      const southTrain = getNextTrain(feed, stationId, 'S');

      const data = {
        station: station.stop_name,
        north:   northTrain ? { dest: station.northDest, minutes: northTrain.minutes, route: northTrain.route } : null,
        south:   southTrain ? { dest: station.southDest, minutes: southTrain.minutes, route: southTrain.route } : null,
        time:    new Date().toISOString(),
      };

      lastGoodData[stationId] = data;
      console.log(`[API] ${stationId}: N=${northTrain?.minutes ?? '--'}min  S=${southTrain?.minutes ?? '--'}min`);
      return res.json(data);
    }

    console.log('[API] MTA returned empty — using last known data');
    return res.json(lastGoodData[stationId] || {
      station: station.stop_name,
      north: null,
      south: null,
      time:  new Date().toISOString(),
    });

  } catch (err) {
    console.error('[API] Error:', err.message);
    res.status(500).json({ error: 'Service unavailable', north: null, south: null });
  }
});

/**
 * GET /api/stations
 * Returns the full list of known stations.
 */
app.get('/api/stations', (req, res) => {
  // Return every station in its canonical line group (LINE_CONFIGS order),
  // so the UI dropdown can filter by line without losing shared stations.
  const all = [];
  LINE_CONFIGS.forEach(({ stations, line_group }) => {
    stations.forEach(s => all.push({ stop_id: s.stop_id, stop_name: s.stop_name, routes: s.routes, line_group }));
  });
  res.json(all);
});

/**
 * GET /api/time
 * Returns current server time for device clock sync.
 */
app.get('/api/time', (req, res) => {
  res.json({ timestamp: Math.floor(Date.now() / 1000), iso: new Date().toISOString() });
});

// ─── Device config routes ─────────────────────────────────────────────────────

/**
 * POST /api/device/:mac/register
 *
 * Called by the device after AP-mode setup completes.
 * Creates a Firestore doc with defaults if this MAC hasn't been seen before.
 * MAC should be lowercase with colons (e.g. aa:bb:cc:dd:ee:ff).
 *
 * Optional body fields: { station_id, display_name }
 *
 * Returns: { registered: bool, config: {...} }
 */
app.post('/api/device/:mac/register', async (req, res) => {
  const mac    = req.params.mac.toLowerCase();
  const docRef = db.collection('devices').doc(mac);

  try {
    const doc = await docRef.get();

    if (!doc.exists) {
      const defaults = {
        station_id:          req.body.station_id   || 'G26',
        display_name:        req.body.display_name || `Device ${mac.slice(-5)}`,
        modules:             ['mta_subway'],
        brightness:          0.4,   // 0.0–1.0 float for MatrixPortal
        scroll_speed:        10,    // seconds per view panel
        openweather_api_key: '',    // set via Firestore console or admin UI
        lastfm_api_key:      '',
        zip_code:            '11222',
        registered_at:       admin.firestore.FieldValue.serverTimestamp(),
        last_seen:           admin.firestore.FieldValue.serverTimestamp(),
      };
      await docRef.set(defaults);
      console.log(`[DEVICE] Registered new device: ${mac}`);
      return res.status(201).json({ registered: true, config: defaults });
    }

    await docRef.update({ last_seen: admin.firestore.FieldValue.serverTimestamp() });
    console.log(`[DEVICE] Re-registered existing device: ${mac}`);
    return res.json({ registered: false, config: doc.data() });

  } catch (err) {
    console.error('[DEVICE] Register error:', err.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

/**
 * GET /api/device/:mac/config
 *
 * Called by the device on every boot to fetch its saved configuration.
 * Returns 404 if the device hasn't registered yet.
 * Also bumps last_seen on every call.
 */
app.get('/api/device/:mac/config', async (req, res) => {
  const mac    = req.params.mac.toLowerCase();
  const docRef = db.collection('devices').doc(mac);

  try {
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Device not registered' });

    await docRef.update({ last_seen: admin.firestore.FieldValue.serverTimestamp() });

    const {
      station_id, display_name, modules,
      brightness, scroll_speed,
      openweather_api_key, zip_code, pages, lastfm_api_key,
    } = doc.data();

    console.log(`[DEVICE] Config fetched: ${mac} → station ${station_id}`);
    res.json({ station_id, display_name, modules, brightness, scroll_speed, openweather_api_key, zip_code, pages: pages || [], lastfm_api_key: lastfm_api_key || '' });

  } catch (err) {
    console.error('[DEVICE] Config error:', err.message);
    res.status(500).json({ error: 'Could not fetch config' });
  }
});

/**
 * GET /api/devices
 * Returns all registered devices sorted by last_seen (for the admin UI).
 */
app.get('/api/devices', async (req, res) => {
  try {
    const snapshot = await db.collection('devices').orderBy('last_seen', 'desc').get();
    const devices  = [];
    snapshot.forEach(doc => {
      const d = doc.data();
      devices.push({
        mac:                 doc.id,
        display_name:        d.display_name,
        station_id:          d.station_id,
        brightness:          d.brightness,
        scroll_speed:        d.scroll_speed,
        openweather_api_key: d.openweather_api_key,
        zip_code:            d.zip_code,
        modules:             d.modules,
        pages:               d.pages || [],
        lastfm_api_key:      d.lastfm_api_key || '',
        last_seen:     d.last_seen?.toDate?.()?.toISOString() ?? null,
        registered_at: d.registered_at?.toDate?.()?.toISOString() ?? null,
      });
    });
    res.json(devices);
  } catch (err) {
    console.error('[ADMIN] List devices error:', err.message);
    res.status(500).json({ error: 'Could not list devices' });
  }
});

/**
 * PATCH /api/device/:mac/config
 * Update one or more config fields for a device (admin UI save).
 * Only whitelisted fields are accepted — internal fields cannot be touched.
 */
app.patch('/api/device/:mac/config', async (req, res) => {
  const mac    = req.params.mac.toLowerCase();
  const docRef = db.collection('devices').doc(mac);

  const ALLOWED = ['display_name', 'station_id', 'brightness', 'scroll_speed', 'openweather_api_key', 'zip_code', 'pages', 'lastfm_api_key'];
  const updates = {};
  for (const key of ALLOWED) {
    if (key in req.body) updates[key] = req.body[key];
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  try {
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Device not found' });

    await docRef.update(updates);
    console.log(`[ADMIN] Updated ${mac}: ${Object.keys(updates).join(', ')}`);
    res.json({ ok: true, updated: Object.keys(updates) });
  } catch (err) {
    console.error('[ADMIN] Update error:', err.message);
    res.status(500).json({ error: 'Update failed' });
  }
});

// ─── Widget data routes ───────────────────────────────────────────────────────

/**
 * GET /api/weather?zip=10001&mode=current|3-day[&key=xxx]
 * Proxies OpenWeather API. Uses OPENWEATHER_API_KEY env var, or ?key= param.
 * Note: 7-day mode is deprecated — treated as 3-day for backward compatibility.
 */
app.get('/api/weather', async (req, res) => {
  const { zip, mode = 'current', key } = req.query;
  if (!zip) return res.status(400).json({ error: 'zip is required' });

  const apiKey = OPENWEATHER_API_KEY || key;
  if (!apiKey) return res.status(503).json({ error: 'Weather API key not configured' });

  try {
    if (mode === 'current') {
      const url = `https://api.openweathermap.org/data/2.5/weather?zip=${encodeURIComponent(zip)},us&appid=${apiKey}&units=imperial`;
      const r = await fetch(url);
      if (!r.ok) return res.status(r.status).json({ error: `OpenWeather error ${r.status}` });
      const d = await r.json();
      return res.json({
        mode:        'current',
        city:        d.name,
        temp:        Math.round(d.main.temp),
        feels_like:  Math.round(d.main.feels_like),
        description: d.weather[0]?.description || '',
        icon:        d.weather[0]?.icon || '',
        humidity:    d.main.humidity,
        high:        Math.round(d.main.temp_max),
        low:         Math.round(d.main.temp_min),
      });
    }

    // 3-day forecast (7-day deprecated, treated as 3-day)
    const url = `https://api.openweathermap.org/data/2.5/forecast?zip=${encodeURIComponent(zip)},us&appid=${apiKey}&units=imperial&cnt=24`;
    const r = await fetch(url);
    if (!r.ok) return res.status(r.status).json({ error: `OpenWeather error ${r.status}` });
    const d = await r.json();

    // Group slots by day, tracking daily high/low
    const byDay = {};
    for (const slot of d.list) {
      const day = new Date(slot.dt * 1000).toLocaleDateString('en-US', { weekday: 'short' });
      if (!byDay[day]) {
        byDay[day] = { high: slot.main.temp_max, low: slot.main.temp_min, icon: slot.weather[0]?.icon || '' };
      } else {
        byDay[day].high = Math.max(byDay[day].high, slot.main.temp_max);
        byDay[day].low  = Math.min(byDay[day].low,  slot.main.temp_min);
      }
    }

    const forecast = Object.entries(byDay).slice(0, 3).map(([date, v]) => ({
      date,
      high: Math.round(v.high),
      low:  Math.round(v.low),
      icon: v.icon,
    }));

    return res.json({ mode: '3-day', city: d.city.name, forecast });

  } catch (err) {
    console.error('[WEATHER] Error:', err.message);
    res.status(500).json({ error: 'Weather unavailable' });
  }
});

/**
 * GET /api/lastfm?username=xxx&mode=nowplaying|recent[&key=xxx]
 * Proxies Last.FM API. Uses LASTFM_API_KEY env var, or ?key= param.
 */
app.get('/api/lastfm', async (req, res) => {
  const { username, mode = 'nowplaying', key } = req.query;
  if (!username) return res.status(400).json({ error: 'username is required' });

  const apiKey = LASTFM_API_KEY || key;
  if (!apiKey) return res.status(503).json({ error: 'Last.FM API key not configured' });

  try {
    const url = `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${encodeURIComponent(username)}&api_key=${apiKey}&format=json&limit=5`;
    const r = await fetch(url);
    if (!r.ok) return res.status(r.status).json({ error: `Last.FM error ${r.status}` });
    const d = await r.json();

    if (d.error) return res.status(400).json({ error: d.message || 'Last.FM error' });

    const tracks = d.recenttracks?.track || [];

    // Extract the best available album art URL from a track object.
    // Last.FM returns an `image` array: [small, medium, large, extralarge, mega].
    // We prefer 'large' (174×174) for quality when downscaling to 32×32.
    // Returns '' if all images are missing or are the Last.FM placeholder.
    function getArtUrl(track) {
      const images = track?.image || [];
      const SIZES  = ['large', 'extralarge', 'mega', 'medium', 'small'];
      for (const size of SIZES) {
        const img = images.find(i => i.size === size);
        const url = img?.['#text'] || '';
        // Last.FM returns a specific "no image" path when art is unavailable
        if (url && !url.includes('2a96cbd8b46e442fc41c2b86b821562f')) return url;
      }
      return '';
    }

    if (mode === 'nowplaying') {
      const current   = Array.isArray(tracks) ? tracks[0] : tracks;
      const isPlaying = current?.['@attr']?.nowplaying === 'true';
      return res.json({
        mode:       'nowplaying',
        nowplaying: isPlaying,
        artist:     current?.artist?.['#text'] || '',
        track:      current?.name || '',
        album:      current?.album?.['#text'] || '',
        art_url:    getArtUrl(current),
      });
    }

    // recent — exclude the currently-playing track (has no date)
    const recent = (Array.isArray(tracks) ? tracks : [tracks])
      .filter(t => !t['@attr']?.nowplaying)
      .slice(0, 5)
      .map(t => ({
        artist:    t.artist?.['#text'] || '',
        track:     t.name || '',
        album:     t.album?.['#text'] || '',
        played_at: t.date?.['#text'] || '',
        art_url:   getArtUrl(t),
      }));

    return res.json({ mode: 'recent', tracks: recent });

  } catch (err) {
    console.error('[LASTFM] Error:', err.message);
    res.status(500).json({ error: 'Last.FM unavailable' });
  }
});

/**
 * GET /api/lastfm/art?url=<last.fm-image-url>
 *
 * Fetches a Last.FM album art image and returns it resized to 32×32 as an
 * uncompressed 24-bit BMP, ready for CircuitPython's displayio.OnDiskBitmap.
 *
 * The device saves this file to /art.bmp on CIRCUITPY and displays it in the
 * right 32px of the Last.FM panel as a TileGrid.
 *
 * Cache-Control: 1 hour — album art rarely changes mid-listen.
 */
app.get('/api/lastfm/art', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url is required' });

  // Only allow Last.FM image CDN URLs to prevent SSRF
  const ALLOWED_HOST = 'lastfm.freetls.fastly.net';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  if (parsed.hostname !== ALLOWED_HOST) {
    return res.status(400).json({ error: 'URL must be a Last.FM image' });
  }

  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return res.status(r.status).json({ error: `Upstream error ${r.status}` });

    const buffer = Buffer.from(await r.arrayBuffer());

    // Resize to 32×32 and output raw RGB bytes (top-down, R G B order).
    // The device will build a displayio.Bitmap in memory — no filesystem write needed.
    const rgb = await sharp(buffer)
      .resize(32, 32, { fit: 'cover', position: 'centre' })
      .raw()
      .toBuffer();

    // Pack as RGB565 big-endian (2 bytes/pixel × 1024 pixels = 2048 bytes).
    // Big-endian makes parsing trivial in CircuitPython: (b[0] << 8) | b[1].
    //
    // This display's RGB matrix has G and B channels physically swapped relative
    // to what displayio expects (hence GREEN = 0x0000FF in firmware constants).
    // The ColorConverter outputs standard (R, G, B); hardware renders (R, B, G).
    // Compensate by encoding with G and B swapped so the visual result is correct.
    const W = 32, H = 32;
    const out = Buffer.alloc(W * H * 2);
    for (let i = 0; i < W * H; i++) {
      const r = rgb[i * 3];
      const g = rgb[i * 3 + 1];
      const b = rgb[i * 3 + 2];
      // Swap g↔b: put B in the 6-bit G field, G in the 5-bit B field
      const val = ((r & 0xF8) << 8) | ((b & 0xFC) << 3) | (g >> 3);
      out[i * 2]     = (val >> 8) & 0xFF;
      out[i * 2 + 1] = val & 0xFF;
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(out);
    console.log(`[ART] Served 32×32 RGB565 for ${parsed.pathname} (${out.length} bytes)`);
  } catch (err) {
    console.error('[ART] Error:', err.message);
    res.status(500).json({ error: 'Could not fetch album art' });
  }
});

/**
 * GET /api/septa?route=48&stop_id=5372&results=2
 * Real-time bus arrivals via SEPTA GTFS-RT TripUpdates feed (no API key required).
 */
const SEPTA_GTFS_RT = 'https://www3.septa.org/gtfsrt/septa-pa-us/Trip/rtTripUpdates.pb';

app.get('/api/septa', async (req, res) => {
  const { route = '', stop_id = '', results = '2' } = req.query;
  if (!route || !stop_id) return res.status(400).json({ error: 'route and stop_id required' });

  const cacheKey = `septa:${route}:${stop_id}`;

  try {
    console.log(`[SEPTA] Fetching TripUpdates for route=${route} stop=${stop_id}`);
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 10000);

    let feed;
    try {
      const response = await fetch(SEPTA_GTFS_RT, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);
      console.log(`[SEPTA] Got ${feed.entity?.length || 0} entities`);
    } finally {
      clearTimeout(timeout);
    }

    const now      = Math.floor(Date.now() / 1000);
    const arrivals = [];

    for (const entity of feed.entity || []) {
      if (!entity.tripUpdate) continue;
      if (entity.tripUpdate.trip.routeId !== route) continue;

      for (const stop of entity.tripUpdate.stopTimeUpdate || []) {
        if (stop.stopId !== stop_id) continue;

        const raw  = stop.arrival?.time ?? stop.departure?.time;
        if (!raw) continue;
        // gtfs-realtime-bindings returns Long objects for int64 fields
        const secs = (typeof raw === 'object') ? raw.low : raw;
        if (secs <= now) continue;

        arrivals.push({ minutes: Math.max(0, Math.round((secs - now) / 60)) });
        break; // one match per trip
      }
    }

    arrivals.sort((a, b) => a.minutes - b.minutes);
    const limit = Math.max(1, parseInt(results, 10) || 2);
    const data  = { route, stop_id, arrivals: arrivals.slice(0, limit) };
    lastGoodData[cacheKey] = data;
    console.log(`[SEPTA] route=${route} stop=${stop_id}: ${arrivals.length} arrivals found`);
    return res.json(data);

  } catch (err) {
    console.error('[SEPTA] Error:', err.message);
    if (lastGoodData[cacheKey]) {
      console.log('[SEPTA] Returning cached data');
      return res.json(lastGoodData[cacheKey]);
    }
    return res.status(502).json({ error: 'SEPTA feed unavailable', detail: err.message });
  }
});

/**
 * GET /api/mlb?team=NYM&mode=schedule|live
 * Stub — real MLB integration TBD.
 */
app.get('/api/mlb', (req, res) => {
  const { team = '', mode = 'schedule' } = req.query;
  res.json({ stub: true, team, mode, games: [] });
});

/**
 * GET /api/nfl?team=NYG&mode=schedule|live
 * Stub — real NFL integration TBD.
 */
app.get('/api/nfl', (req, res) => {
  const { team = '', mode = 'schedule' } = req.query;
  res.json({ stub: true, team, mode, games: [] });
});

// ─── Firmware generator ───────────────────────────────────────────────────────

/**
 * GET /firmware/:mac
 *
 * Returns a generated code.py tailored to this device's Firestore config.
 * The device can fetch this on boot and write it to CIRCUITPY if the
 * content hash has changed (self-update flow).
 */
app.get('/firmware/:mac', async (req, res) => {
  const mac    = req.params.mac.toLowerCase();
  const docRef = db.collection('devices').doc(mac);

  try {
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Device not registered' });

    const config   = doc.data();
    const firmware = generateFirmware(config, mac, SERVICE_URL);

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename="code.py"');
    console.log(`[FIRMWARE] Served to ${mac} (station: ${config.station_id})`);
    res.send(firmware);

  } catch (err) {
    console.error('[FIRMWARE] Error:', err.message);
    res.status(500).json({ error: 'Could not generate firmware' });
  }
});


// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), uptime: process.uptime() });
});

// ─── 404 catch-all ────────────────────────────────────────────────────────────

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚇 Subway Sign Server`);
  console.log(`📡 Port       : ${PORT}`);
  console.log(`🔑 MTA Key    : ${MTA_API_KEY ? 'yes' : 'no'}`);
  console.log(`🌐 Service URL: ${SERVICE_URL}`);
  console.log(`🗄️  Firestore  : ${admin.app().options.projectId || '(project from ADC)'}`);
});
