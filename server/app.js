#!/usr/bin/env node

/**
 * NYC Subway Sign Server
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
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const admin   = require('firebase-admin');
require('dotenv').config();

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

// ─── MTA config ───────────────────────────────────────────────────────────────
const MTA_API_KEY = process.env.MTA_API_KEY;

const GTFS_FEEDS = {
  'G':       'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g',
  'L':       'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l',
  'ACE':     'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace',
  'BDFM':    'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm',
  'NQRW':    'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw',
  '123456S': 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs',
  '7':       'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-7',
};

// ─── Station data ─────────────────────────────────────────────────────────────
// G line — northbound terminus: Court Sq, southbound terminus: Church Av
const G_LINE_STATIONS = [
  { stop_id: 'G20', stop_name: 'Court Sq',               routes: ['G']      },
  { stop_id: 'G21', stop_name: '21 St',                  routes: ['G']      },
  { stop_id: 'G22', stop_name: 'Nassau Av',              routes: ['G']      },
  { stop_id: 'G24', stop_name: 'Metropolitan Av',        routes: ['G', 'L'] },
  { stop_id: 'G26', stop_name: 'Greenpoint Av',          routes: ['G']      },
  { stop_id: 'G28', stop_name: 'Broadway',               routes: ['G']      },
  { stop_id: 'G29', stop_name: 'Flushing Av',            routes: ['G']      },
  { stop_id: 'G30', stop_name: 'Myrtle-Willoughby Avs', routes: ['G']      },
  { stop_id: 'G31', stop_name: 'Bedford-Nostrand Avs',   routes: ['G']      },
  { stop_id: 'G32', stop_name: 'Classon Av',             routes: ['G']      },
  { stop_id: 'G33', stop_name: 'Clinton-Washington Avs', routes: ['G']      },
  { stop_id: 'G34', stop_name: 'Fulton St',              routes: ['G']      },
  { stop_id: 'G35', stop_name: 'Hoyt-Schermerhorn Sts', routes: ['G', 'A', 'C'] },
  { stop_id: 'G36', stop_name: 'Church Av',              routes: ['G']      },
];

// Build STATIONS lookup keyed by stop_id
const STATIONS = {};
G_LINE_STATIONS.forEach(s => {
  STATIONS[s.stop_id] = {
    ...s,
    feed_group: 'G',
    northDest:  'Court Sq',
    southDest:  'Church Av',
  };
});

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
  res.json(
    Object.values(STATIONS).map(({ stop_id, stop_name, routes }) => ({ stop_id, stop_name, routes }))
  );
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
        station_id:    req.body.station_id   || 'G26',
        display_name:  req.body.display_name || `Device ${mac.slice(-5)}`,
        modules:       ['mta_subway'],
        brightness:    8,
        scroll_speed:  4,
        registered_at: admin.firestore.FieldValue.serverTimestamp(),
        last_seen:     admin.firestore.FieldValue.serverTimestamp(),
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

    const { station_id, display_name, modules, brightness, scroll_speed } = doc.data();
    console.log(`[DEVICE] Config fetched: ${mac} → station ${station_id}`);
    res.json({ station_id, display_name, modules, brightness, scroll_speed });

  } catch (err) {
    console.error('[DEVICE] Config error:', err.message);
    res.status(500).json({ error: 'Could not fetch config' });
  }
});

// ─── Firmware generator ───────────────────────────────────────────────────────

/**
 * GET /firmware/:mac
 *
 * Returns a generated code.py tailored to this device's Firestore config.
 * The device can fetch this on boot and write it to CIRCUITPY if the
 * content hash has changed (self-update flow).
 *
 * TODO: replace the stub template body with real CircuitPython once
 *       the current code.py has been reviewed.
 */
app.get('/firmware/:mac', async (req, res) => {
  const mac    = req.params.mac.toLowerCase();
  const docRef = db.collection('devices').doc(mac);

  try {
    const doc = await docRef.get();
    if (!doc.exists) return res.status(404).json({ error: 'Device not registered' });

    const config   = doc.data();
    const firmware = generateFirmware(config, mac);

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename="code.py"');
    console.log(`[FIRMWARE] Served to ${mac} (station: ${config.station_id})`);
    res.send(firmware);

  } catch (err) {
    console.error('[FIRMWARE] Error:', err.message);
    res.status(500).json({ error: 'Could not generate firmware' });
  }
});

/**
 * Assemble a code.py string from device config.
 *
 * Currently a stub — the config constants are injected correctly but the
 * CircuitPython runtime body is a placeholder.  Replace the section marked
 * TODO once code.py from the test device has been reviewed.
 */
function generateFirmware(config, mac) {
  return `# ============================================================
# Auto-generated by ticker-display firmware generator
# Device : ${mac}
# Station: ${config.station_id} — ${config.display_name}
# Modules: ${config.modules.join(', ')}
# Built  : ${new Date().toISOString()}
# ============================================================

# --- Device config (injected by server) ---
STATION_ID   = "${config.station_id}"
DISPLAY_NAME = "${config.display_name}"
BRIGHTNESS   = ${config.brightness}
SCROLL_SPEED = ${config.scroll_speed}
MODULES      = ${JSON.stringify(config.modules)}

# --- TODO: real CircuitPython runtime goes here ---
# Replace this section with the template derived from code.py
print("Firmware stub loaded for", STATION_ID)
`;
}

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), uptime: process.uptime() });
});

// ─── 404 catch-all ────────────────────────────────────────────────────────────

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚇 Subway Sign Server`);
  console.log(`📡 Port    : ${PORT}`);
  console.log(`🔑 MTA Key : ${MTA_API_KEY ? 'yes' : 'no'}`);
  console.log(`🗄️  Firestore: ${admin.app().options.projectId || '(project from ADC)'}`);
});
