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

// ─── Config ───────────────────────────────────────────────────────────────────
const MTA_API_KEY = process.env.MTA_API_KEY;

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
  '7':       'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-7',
};

// ─── Station data ─────────────────────────────────────────────────────────────
// G line — northbound terminus: Court Sq, southbound terminus: Church Av
const G_LINE_STATIONS = [
  { stop_id: 'G20', stop_name: 'Court Sq',               routes: ['G']           },
  { stop_id: 'G21', stop_name: '21 St',                  routes: ['G']           },
  { stop_id: 'G22', stop_name: 'Nassau Av',              routes: ['G']           },
  { stop_id: 'G24', stop_name: 'Metropolitan Av',        routes: ['G', 'L']      },
  { stop_id: 'G26', stop_name: 'Greenpoint Av',          routes: ['G']           },
  { stop_id: 'G28', stop_name: 'Broadway',               routes: ['G']           },
  { stop_id: 'G29', stop_name: 'Flushing Av',            routes: ['G']           },
  { stop_id: 'G30', stop_name: 'Myrtle-Willoughby Avs', routes: ['G']           },
  { stop_id: 'G31', stop_name: 'Bedford-Nostrand Avs',   routes: ['G']           },
  { stop_id: 'G32', stop_name: 'Classon Av',             routes: ['G']           },
  { stop_id: 'G33', stop_name: 'Clinton-Washington Avs', routes: ['G']           },
  { stop_id: 'G34', stop_name: 'Fulton St',              routes: ['G']           },
  { stop_id: 'G35', stop_name: 'Hoyt-Schermerhorn Sts', routes: ['G', 'A', 'C'] },
  { stop_id: 'G36', stop_name: 'Church Av',              routes: ['G']           },
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
        station_id:          req.body.station_id   || 'G26',
        display_name:        req.body.display_name || `Device ${mac.slice(-5)}`,
        modules:             ['mta_subway'],
        brightness:          0.4,   // 0.0–1.0 float for MatrixPortal
        scroll_speed:        10,    // seconds per view panel
        openweather_api_key: '',    // set via Firestore console or admin UI
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
      openweather_api_key, zip_code,
    } = doc.data();

    console.log(`[DEVICE] Config fetched: ${mac} → station ${station_id}`);
    res.json({ station_id, display_name, modules, brightness, scroll_speed, openweather_api_key, zip_code });

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
 * Assemble a complete code.py from device config.
 *
 * All device-specific constants (SERVER_URL, STATION_ID, BRIGHTNESS,
 * WEATHER_API_KEY, ZIP_CODE, VIEW_CYCLE_INTERVAL) are injected at the top.
 * The device's secrets.py only needs to contain ssid + password.
 */
function generateFirmware(config, mac) {
  return `"""
MTA LED Sign - 64x32 Single Panel
Auto-generated by subway-sign server — do not edit manually.
Device : ${mac}
Station: ${config.station_id} (${config.display_name})
Built  : ${new Date().toISOString()}
"""

import time
import board
import displayio
import gc
from adafruit_matrixportal.matrixportal import MatrixPortal
from adafruit_display_text import label
from adafruit_bitmap_font import bitmap_font

try:
    from adafruit_display_shapes.circle import Circle
    has_shapes = True
except ImportError:
    has_shapes = False

# ── WiFi credentials (written to device by AP setup mode) ─────────────────────
from secrets import secrets  # needs: ssid, password only

# ── Device config (injected by server at firmware generation time) ─────────────
SERVER_URL           = "${SERVICE_URL}"
STATION_ID           = "${config.station_id}"
BRIGHTNESS           = ${config.brightness}
WEATHER_API_KEY      = "${config.openweather_api_key}"
ZIP_CODE             = "${config.zip_code}"
VIEW_CYCLE_INTERVAL  = ${config.scroll_speed}   # seconds per view panel

print("MTA Sign - 64x32")
print("=" * 40)

# ── Display dimensions ─────────────────────────────────────────────────────────
MATRIX_WIDTH  = 64
MATRIX_HEIGHT = 32

# ── Update intervals ───────────────────────────────────────────────────────────
UPDATE_INTERVAL          = 30    # seconds between train fetches
WEATHER_UPDATE_INTERVAL  = 600   # 10 minutes
FORECAST_UPDATE_INTERVAL = 1800  # 30 minutes
MAX_RETRIES = 3
RETRY_DELAY = 5   # seconds between WiFi retries

# ── Colors ─────────────────────────────────────────────────────────────────────
BLACK    = 0x000000
WHITE    = 0xFFFFFF
GREEN    = 0x0000FF
ORANGE   = 0xFF00AA
YELLOW   = 0xFF00AA
RED      = 0xEE352E
MTA_BLUE = 0x39A600

# ── Initialize display ─────────────────────────────────────────────────────────
matrixportal = MatrixPortal(width=MATRIX_WIDTH, height=MATRIX_HEIGHT, bit_depth=4)
matrixportal.display.brightness = BRIGHTNESS

# ── Load font ──────────────────────────────────────────────────────────────────
try:
    font = bitmap_font.load_font("/fonts/tom-thumb.bdf")
    print("Loaded tom-thumb font")
except (OSError, RuntimeError):
    import terminalio
    font = terminalio.FONT
    print("Using terminal font")


class TrainDisplay:
    """Manages the LED matrix display for train arrivals and weather"""

    def __init__(self):
        self.main_group = displayio.Group()
        matrixportal.display.root_group = self.main_group
        self.current_view = "subway"  # "subway", "weather", or "forecast"
        self._setup_display()
        self._setup_splash()
        matrixportal.display.root_group = self.splash_group  # Boot with splash

    def _setup_display(self):
        """Initialize display elements"""
        # ── Subway view ────────────────────────────────────────────────────────
        self.subway_group = displayio.Group()
        self.subway_group.y = 0

        if has_shapes:
            north_bullet = Circle(5, 9, 4, fill=GREEN)
            self.subway_group.append(north_bullet)

        self.north_route = label.Label(font, text="G", color=WHITE, x=4, y=10)
        self.north_dest  = label.Label(font, text="Court Sq", color=WHITE, x=12, y=10)
        self.north_time  = label.Label(font, text="--", color=ORANGE, x=50, y=10)
        self.north_min   = label.Label(font, text="", color=ORANGE, x=60, y=10)

        self.subway_group.append(self.north_route)
        self.subway_group.append(self.north_dest)
        self.subway_group.append(self.north_time)
        self.subway_group.append(self.north_min)

        if has_shapes:
            south_bullet = Circle(5, 22, 4, fill=GREEN)
            self.subway_group.append(south_bullet)

        self.south_route = label.Label(font, text="G", color=WHITE, x=4, y=23)
        self.south_dest  = label.Label(font, text="Church Av", color=WHITE, x=12, y=23)
        self.south_time  = label.Label(font, text="--", color=ORANGE, x=50, y=23)
        self.south_min   = label.Label(font, text="", color=ORANGE, x=60, y=23)

        self.subway_group.append(self.south_route)
        self.subway_group.append(self.south_dest)
        self.subway_group.append(self.south_time)
        self.subway_group.append(self.south_min)

        self.status = label.Label(font, text="", color=WHITE, x=15, y=16)
        self.subway_group.append(self.status)

        self.main_group.append(self.subway_group)

        # ── Weather view ───────────────────────────────────────────────────────
        self.weather_group = displayio.Group()
        self.weather_group.y = MATRIX_HEIGHT

        self.weather_condition = label.Label(font, text="", color=WHITE, x=8, y=10)
        self.weather_group.append(self.weather_condition)

        self.weather_temp = label.Label(font, text="--F", color=ORANGE, x=24, y=18)
        self.weather_group.append(self.weather_temp)

        self.weather_high_label = label.Label(font, text="H:", color=WHITE, x=12, y=26)
        self.weather_high       = label.Label(font, text="--", color=RED, x=20, y=26)
        self.weather_low_label  = label.Label(font, text="L:", color=WHITE, x=36, y=26)
        self.weather_low        = label.Label(font, text="--", color=MTA_BLUE, x=44, y=26)

        self.weather_group.append(self.weather_high_label)
        self.weather_group.append(self.weather_high)
        self.weather_group.append(self.weather_low_label)
        self.weather_group.append(self.weather_low)

        self.main_group.append(self.weather_group)

        # ── Forecast view ──────────────────────────────────────────────────────
        self.forecast_group = displayio.Group()
        self.forecast_group.y = MATRIX_HEIGHT * 2

        self.day1_name = label.Label(font, text="", color=WHITE, x=2, y=9)
        self.day1_high = label.Label(font, text="", color=RED, x=20, y=9)
        self.day1_low  = label.Label(font, text="", color=MTA_BLUE, x=32, y=9)
        self.day1_cond = label.Label(font, text="", color=WHITE, x=44, y=9)

        self.forecast_group.append(self.day1_name)
        self.forecast_group.append(self.day1_high)
        self.forecast_group.append(self.day1_low)
        self.forecast_group.append(self.day1_cond)

        self.day2_name = label.Label(font, text="", color=WHITE, x=2, y=18)
        self.day2_high = label.Label(font, text="", color=RED, x=20, y=18)
        self.day2_low  = label.Label(font, text="", color=MTA_BLUE, x=32, y=18)
        self.day2_cond = label.Label(font, text="", color=WHITE, x=44, y=18)

        self.forecast_group.append(self.day2_name)
        self.forecast_group.append(self.day2_high)
        self.forecast_group.append(self.day2_low)
        self.forecast_group.append(self.day2_cond)

        self.day3_name = label.Label(font, text="", color=WHITE, x=2, y=27)
        self.day3_high = label.Label(font, text="", color=RED, x=20, y=27)
        self.day3_low  = label.Label(font, text="", color=MTA_BLUE, x=32, y=27)
        self.day3_cond = label.Label(font, text="", color=WHITE, x=44, y=27)

        self.forecast_group.append(self.day3_name)
        self.forecast_group.append(self.day3_high)
        self.forecast_group.append(self.day3_low)
        self.forecast_group.append(self.day3_cond)

        self.main_group.append(self.forecast_group)

        # ── Error indicator (corner dot) ───────────────────────────────────────
        if has_shapes:
            error_dot = Circle(61, 2, 1, fill=RED)
            self.error_group = displayio.Group()
            self.error_group.append(error_dot)
            self.error_group.hidden = True
            self.main_group.append(self.error_group)
        else:
            self.error_group = None

    def update_train_time(self, time_label, min_label, minutes, is_south=False):
        """Update train time display with proper positioning"""
        if minutes is None:
            time_label.text = "--"
            time_label.x = 50
            min_label.text = ""
            return

        if minutes == 0:
            time_label.text = "now"
            time_label.x = 50
            min_label.text = ""
            time_label.color = YELLOW
        else:
            time_label.text = str(minutes)
            time_label.x = 50
            min_label.text = "m"
            time_label.color = ORANGE

        min_label.color = ORANGE

    def update(self, data):
        """Update display with train data"""
        if not data:
            return
        self.status.text = ""
        north_minutes = data.get('north', {}).get('minutes')
        self.update_train_time(self.north_time, self.north_min, north_minutes)
        south_minutes = data.get('south', {}).get('minutes')
        self.update_train_time(self.south_time, self.south_min, south_minutes, is_south=True)

    def show_status(self, message):
        """Show a short status message on the subway view"""
        self.status.text = message[:8]

    def show_error(self, show=True):
        """Show/hide error indicator dot"""
        if self.error_group:
            self.error_group.hidden = not show

    def _setup_splash(self):
        """Initialize boot splash shown during WiFi connect"""
        self.splash_group = displayio.Group()
        if has_shapes:
            self.splash_bullet = Circle(10, 16, 5, fill=GREEN)
            self.splash_group.append(self.splash_bullet)
        self.splash_letter = label.Label(font, text="G", color=WHITE, x=8, y=17)
        self.splash_group.append(self.splash_letter)
        self.splash_line1 = label.Label(font, text="Starting...", color=WHITE, x=20, y=12)
        self.splash_group.append(self.splash_line1)
        self.splash_line2 = label.Label(font, text="", color=ORANGE, x=20, y=21)
        self.splash_group.append(self.splash_line2)

    def show_splash(self, line1="", line2=""):
        """Show boot splash with two status lines"""
        self.splash_line1.text = line1[:10]
        self.splash_line2.text = line2[:10]
        matrixportal.display.root_group = self.splash_group

    def hide_splash(self):
        """Dismiss splash and reveal main display"""
        matrixportal.display.root_group = self.main_group

    def update_weather(self, weather_data):
        """Update weather display"""
        if not weather_data:
            return
        temp      = weather_data.get('temp', '--')
        condition = weather_data.get('condition', '')
        high      = weather_data.get('high', '--')
        low       = weather_data.get('low', '--')

        self.weather_condition.text = condition[:14]
        self.weather_temp.text = f"{temp}F"
        self.weather_high.text = str(high)
        self.weather_low.text  = str(low)

    def update_forecast(self, forecast_data):
        """Update 3-day forecast display"""
        if not forecast_data or len(forecast_data) < 3:
            return

        day1 = forecast_data[0]
        self.day1_name.text = day1.get('day', '')[:3]
        self.day1_high.text = f"H{day1.get('high', '--')}"
        self.day1_low.text  = f"L{day1.get('low', '--')}"
        self.day1_cond.text = day1.get('condition', '')[:8]

        day2 = forecast_data[1]
        self.day2_name.text = day2.get('day', '')[:3]
        self.day2_high.text = f"H{day2.get('high', '--')}"
        self.day2_low.text  = f"L{day2.get('low', '--')}"
        self.day2_cond.text = day2.get('condition', '')[:8]

        day3 = forecast_data[2]
        self.day3_name.text = day3.get('day', '')[:3]
        self.day3_high.text = f"H{day3.get('high', '--')}"
        self.day3_low.text  = f"L{day3.get('low', '--')}"
        self.day3_cond.text = day3.get('condition', '')[:8]

    def scroll_to_view(self, view_name):
        """Animate vertical scroll to specified view"""
        if self.current_view == view_name:
            return

        if view_name == "weather":
            subway_target   = -MATRIX_HEIGHT
            weather_target  = 0
            forecast_target = MATRIX_HEIGHT
        elif view_name == "forecast":
            subway_target   = -MATRIX_HEIGHT * 2
            weather_target  = -MATRIX_HEIGHT
            forecast_target = 0
        else:  # subway
            subway_target   = 0
            weather_target  = MATRIX_HEIGHT
            forecast_target = MATRIX_HEIGHT * 2

        frames = 8
        for i in range(frames + 1):
            progress = i / frames
            self.subway_group.y   = int(self.subway_group.y   + (subway_target   - self.subway_group.y)   * progress)
            self.weather_group.y  = int(self.weather_group.y  + (weather_target  - self.weather_group.y)  * progress)
            self.forecast_group.y = int(self.forecast_group.y + (forecast_target - self.forecast_group.y) * progress)
            time.sleep(0.08)

        self.subway_group.y   = subway_target
        self.weather_group.y  = weather_target
        self.forecast_group.y = forecast_target
        self.current_view = view_name


class NetworkManager:
    """Handles WiFi connection and HTTP requests"""

    def __init__(self):
        self.connected   = False
        self.requests    = None
        self.error_count = 0
        self.last_connect_attempt = 0

    def connect(self):
        """Connect to WiFi using credentials from secrets.py"""
        current_time = time.monotonic()
        if current_time - self.last_connect_attempt < RETRY_DELAY:
            return self.connected
        self.last_connect_attempt = current_time

        try:
            import wifi
            import socketpool
            import ssl
            import adafruit_requests

            print(f"Connecting to {secrets['ssid']}")

            if not wifi.radio.connected:
                wifi.radio.connect(secrets['ssid'], secrets['password'])

            pool = socketpool.SocketPool(wifi.radio)
            self.requests = adafruit_requests.Session(pool, ssl.create_default_context())

            print(f"Connected: {wifi.radio.ipv4_address}")
            self.connected   = True
            self.error_count = 0
            return True

        except Exception as e:
            print(f"WiFi connection error: {e}")
            self.connected = False
            return False

    def fetch_trains(self):
        """Fetch train data from server"""
        if not self.connected or not self.requests:
            if not self.connect():
                return None

        try:
            url = f"{SERVER_URL}/api/next/{STATION_ID}"
            print(f"Fetching: {url}")

            response = self.requests.get(url, timeout=10)

            if response.status_code == 200:
                data = response.json()
                response.close()
                gc.collect()

                n_min = data.get('north', {}).get('minutes', '--')
                s_min = data.get('south', {}).get('minutes', '--')
                print(f"Received: North={n_min}min, South={s_min}min")

                self.error_count = 0
                return data
            else:
                print(f"HTTP error {response.status_code}")
                response.close()

        except Exception as e:
            print(f"Request error: {e}")
            self.error_count += 1
            if self.error_count >= MAX_RETRIES:
                self.connected = False
                print("Resetting connection after multiple failures")

        return None

    def fetch_weather(self):
        """Fetch current weather from OpenWeatherMap"""
        if not WEATHER_API_KEY:
            print("No weather API key configured")
            return None

        if not self.connected or not self.requests:
            if not self.connect():
                return None

        try:
            url = f"https://api.openweathermap.org/data/2.5/weather?zip={ZIP_CODE},us&appid={WEATHER_API_KEY}&units=imperial"
            print("Fetching weather...")

            response = self.requests.get(url, timeout=10)

            if response.status_code == 200:
                data = response.json()
                response.close()

                temp      = int(data['main']['temp'])
                condition = data['weather'][0]['description'].upper()
                high      = int(data['main']['temp_max'])
                low       = int(data['main']['temp_min'])

                weather_data = {'temp': temp, 'condition': condition, 'high': high, 'low': low}
                print(f"Weather: {temp}F, {condition}")
                gc.collect()
                return weather_data
            else:
                print(f"Weather API error {response.status_code}")
                response.close()

        except Exception as e:
            print(f"Weather fetch error: {e}")

        return None

    def fetch_forecast(self):
        """Fetch 3-day forecast from OpenWeatherMap"""
        if not WEATHER_API_KEY:
            print("No weather API key configured")
            return None

        if not self.connected or not self.requests:
            if not self.connect():
                return None

        try:
            url = f"https://api.openweathermap.org/data/2.5/forecast?zip={ZIP_CODE},us&appid={WEATHER_API_KEY}&units=imperial"
            print("Fetching forecast...")

            response = self.requests.get(url, timeout=15)

            if response.status_code == 200:
                data = response.json()
                response.close()

                forecast_list = data.get('list', [])
                if not forecast_list:
                    return None

                # Group forecast entries by calendar day
                days = {}
                for item in forecast_list:
                    dt_txt   = item.get('dt_txt', '')
                    date_str = dt_txt.split(' ')[0]
                    if not date_str:
                        continue
                    if date_str not in days:
                        days[date_str] = {'temps': [], 'conditions': []}
                    days[date_str]['temps'].append(item['main']['temp'])
                    days[date_str]['conditions'].append(item['weather'][0]['main'])

                # Build forecast for the next 3 days (skip today)
                day_names     = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
                sorted_days   = sorted(days.keys())
                forecast_data = []

                for date_str in sorted_days[1:4]:
                    day_data   = days[date_str]
                    high       = int(max(day_data['temps']))
                    low        = int(min(day_data['temps']))
                    conditions = day_data['conditions']
                    condition  = max(set(conditions), key=conditions.count) if conditions else 'Clear'

                    # Zeller's congruence to get day-of-week name
                    parts = date_str.split('-')
                    year  = int(parts[0])
                    month = int(parts[1])
                    day   = int(parts[2])
                    if month < 3:
                        month += 12
                        year  -= 1
                    day_of_week = (day + ((13 * (month + 1)) // 5) + year + (year // 4) - (year // 100) + (year // 400)) % 7
                    day_index   = (day_of_week + 5) % 7
                    day_name    = day_names[day_index]

                    forecast_data.append({'day': day_name, 'high': high, 'low': low, 'condition': condition})

                print(f"Forecast: {len(forecast_data)} days")
                gc.collect()
                return forecast_data if len(forecast_data) >= 3 else None

            else:
                print(f"Forecast API error {response.status_code}")
                response.close()

        except Exception as e:
            print(f"Forecast fetch error: {e}")

        return None


# ── Initialize components ──────────────────────────────────────────────────────
display = TrainDisplay()
network = NetworkManager()

print("Display initialized")
print("\\nStarting main program...")

# ── Initial WiFi connection (3 attempts) ───────────────────────────────────────
weather_data  = None
forecast_data = None
connected     = False

for attempt in range(3):
    display.show_splash("Connecting", "WiFi {}/3".format(attempt + 1))
    print("WiFi attempt {}/3".format(attempt + 1))
    if network.connect():
        connected = True
        break
    if attempt < 2:
        time.sleep(RETRY_DELAY)

if connected:
    display.show_splash("Connected!", "Loading...")
    time.sleep(2)

    initial_data = network.fetch_trains()
    if initial_data:
        display.update(initial_data)
        display.show_error(False)
    else:
        display.show_error(True)

    weather_data = network.fetch_weather()
    if weather_data:
        display.update_weather(weather_data)

    forecast_data = network.fetch_forecast()
    if forecast_data:
        display.update_forecast(forecast_data)

    display.hide_splash()
else:
    # All retries failed — launch AP captive portal for WiFi setup
    print("WiFi failed after 3 attempts — entering AP setup mode")
    import setup_mode
    setup_mode.run(display)
    # setup_mode.run() never returns — calls microcontroller.reset()

# ── Main loop ──────────────────────────────────────────────────────────────────
last_update          = time.monotonic()
last_weather_update  = time.monotonic()
last_forecast_update = time.monotonic()
last_view_cycle      = time.monotonic()
current_view_index   = 0  # 0=subway, 1=weather, 2=forecast
views = ["subway", "weather", "forecast"]

print(f"Main loop — view cycles every {VIEW_CYCLE_INTERVAL}s")

while True:
    current_time = time.monotonic()

    # Train update
    if current_time - last_update >= UPDATE_INTERVAL:
        train_data = network.fetch_trains()
        if train_data:
            display.update(train_data)
            display.show_error(False)
        else:
            display.show_error(True)
        last_update = current_time
        gc.collect()
        print(f"Free memory: {gc.mem_free()} bytes")

    # Weather update
    if current_time - last_weather_update >= WEATHER_UPDATE_INTERVAL:
        weather_data = network.fetch_weather()
        if weather_data:
            display.update_weather(weather_data)
        last_weather_update = current_time
        gc.collect()

    # Forecast update
    if current_time - last_forecast_update >= FORECAST_UPDATE_INTERVAL:
        forecast_data = network.fetch_forecast()
        if forecast_data:
            display.update_forecast(forecast_data)
        last_forecast_update = current_time
        gc.collect()

    # View cycling
    if current_time - last_view_cycle >= VIEW_CYCLE_INTERVAL:
        current_view_index = (current_view_index + 1) % len(views)
        display.scroll_to_view(views[current_view_index])
        last_view_cycle = current_time

    time.sleep(0.2)
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
  console.log(`📡 Port       : ${PORT}`);
  console.log(`🔑 MTA Key    : ${MTA_API_KEY ? 'yes' : 'no'}`);
  console.log(`🌐 Service URL: ${SERVICE_URL}`);
  console.log(`🗄️  Firestore  : ${admin.app().options.projectId || '(project from ADC)'}`);
});
