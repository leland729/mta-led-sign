# MTA LED Sign — Project Context for Claude

## What This Is
A real-time NYC subway departure board built on an Adafruit MatrixPortal S3 (ESP32-S3) driving a 64×32 RGB LED matrix. A Node.js server on Google Cloud Run fetches live MTA GTFS-RT data and serves it to the device over WiFi. An Admin UI (served by the same Node.js app) lets you configure the device via Firestore.

## Architecture

```
[LED Matrix Display]
       ↑
[MatrixPortal S3] —WiFi→ [Cloud Run: server/app.js]
                                    ↑
                          [MTA GTFS-RT feeds]
                          [OpenWeather API]
                          [Last.FM API]
                          [Firestore: device config]
                                    ↑
                          [Admin UI: /public/index.html]
```

## Key Files

| File | Purpose |
|------|---------|
| `server/firmware/code.py` | CircuitPython firmware source — copied to `CIRCUITPY` drive |
| `server/firmware/template.js` | Wraps `code.py` with `{{TOKEN}}` replacement for `/firmware/:mac` |
| `circuitpy/secrets.py` | WiFi credentials (**never commit**) |
| `server/app.js` | Node.js/Express server — GTFS-RT proxy, Admin API, firmware generator |
| `server/data/mta-stations.js` | All MTA station stop IDs + names, verified against `gtfs_subway/stops.txt` |
| `server/public/index.html` | Admin UI (vanilla JS, no framework) |
| `gtfs_subway/stops.txt` | MTA GTFS static data (Feb 19 2026) — ground truth for stop IDs |
| `.claude/launch.json` | Local preview server config (`node server/app.js`, port 3000) |

## Deployment

**Server:** Google Cloud Run (`us-east1`)
- Deploy: `cd server && gcloud run deploy subway-api --source . --region us-east1`
- URL: `https://subway-api-829904256043.us-east1.run.app`
- Health check: `curl https://subway-api-829904256043.us-east1.run.app/health`

**Environment variables set on Cloud Run** (all three confirmed set):
- `MTA_API_KEY` — MTA GTFS-RT API key
- `LASTFM_API_KEY` — Last.FM API key
- `OPENWEATHER_API_KEY` — OpenWeather API key (server-side; devices no longer need their own key)

**⚠️ Always use `--update-env-vars` (not `--set-env-vars`) when adding/changing a single key — `--set-env-vars` replaces ALL env vars and will wipe the others.**

**Device firmware:** Download from Admin UI (Advanced → Download Firmware) and copy `code.py` to the `CIRCUITPY` drive via USB.

## Device Config Flow
1. Admin UI → PATCH `/api/device/:mac` → saved to Firestore
2. Device boots → POST `/api/device/:mac/register` + GET `/api/device/:mac/config` → applies config
3. Firestore keys per device: `display_name`, `station_id`, `zip_code`, `brightness`, `scroll_speed`, `openweather_api_key`, `lastfm_api_key`, `pages[]`

**secrets.py** only holds WiFi credentials (`ssid`, `password`). Never written by the server.

## GTFS Stop ID Format
- Parent stations (use these): `stop_id` where `location_type=1` in `gtfs_subway/stops.txt`
- GTFS-RT queries append `N` or `S` suffix for direction (e.g., `G26N`, `G26S`)
- Ground truth file: `gtfs_subway/stops.txt`

## MTA GTFS-RT Feed Groups
| Feed group key | Lines covered |
|---|---|
| `ACE` | A, C, E |
| `BDFM` | B, D, F, M |
| `NQRW` | N, Q, R, W |
| `123456S` | 1, 2, 3, 4, 5, 6, 7, S |
| `G` | G |
| `L` | L |
| `JZ` | J, Z |

**Note:** The MTA retired the dedicated `gtfs-7` feed — the 7 train is now in the main `gtfs` feed (`123456S`). The 7 line stations use `feed_group: '123456S'` in `mta-stations.js`.

## Station Data Status
All station stop IDs have been corrected against `gtfs_subway/stops.txt` and refactored into `server/data/mta-stations.js` (no longer inline in `app.js`).

**All lines verified and fixed** — including G, 7, ACE, BDFM, NQRW, 123, 456, JZ.

## Page Carousel (v1.4.0+)

Each device has up to **5 pages** that cycle on a global timer (`scroll_speed`). Each page is independently configured with a widget type + its settings.

### Carousel Rules
- Max 5 pages per device
- Global dwell time (`scroll_speed` seconds per page)
- Pages stored as an ordered array in Firestore under the device's document
- Admin UI supports drag-to-reorder pages

### Widget Types

| Widget | Config Fields | Data Source | Status |
|---|---|---|---|
| NYC MTA | Line, Station | MTA GTFS-RT | ✅ Live |
| Weather | Zip code, Mode (current / 3-day / 7-day) | OpenWeather API | ✅ Live |
| Last.FM | Username, Mode (now playing / recent) | Last.FM API | ✅ Live |
| SEPTA | Route, Stop ID | SEPTA GTFS-RT | ✅ Live |
| MLB | Team, Mode (schedule / live score) | TBD | 🔲 Stub only |
| NFL | Team, Mode (schedule / live score) | TBD | 🔲 Stub only |

### Server Endpoints
| Endpoint | Description |
|---|---|
| `GET /api/next/:stationId` | Next MTA trains for a parent stop ID |
| `GET /api/weather?zip=&mode=current\|3-day\|7-day[&key=]` | OpenWeather proxy |
| `GET /api/lastfm?username=&mode=nowplaying\|recent[&key=]` | Last.FM proxy — includes `art_url` in response |
| `GET /api/lastfm/art?url=` | Fetch, resize to 32×32, return raw RGB565 (2048 bytes); G/B swapped for panel hardware |
| `GET /api/septa?route=&stop_id=[&results=2]` | Real-time bus arrivals via SEPTA GTFS-RT TripUpdates (no API key) |
| `GET /api/mlb` | Stub |
| `GET /api/nfl` | Stub |
| `GET /api/device/:mac/config` | Firestore config for device |
| `POST /api/device/:mac/register` | Register/upsert device in Firestore |
| `PATCH /api/device/:mac` | Update device config fields |
| `GET /firmware/:mac` | Generate and download `code.py` for device |

### Firmware Display Panels (5-panel vertical carousel)
| Index | View name | Content |
|---|---|---|
| 0 | `subway` | Station name (top, orange) + North + South next trains |
| 1 | `weather` | Current temp, condition, H/L |
| 2 | `forecast` | 3-row day/high/low/condition |
| 3 | `lastfm` | Artist (orange) / Album (gray) / Track (white) — left 32px; right 32px reserved for album art |
| 4 | `septa` | SEPTA logo (left 22px) + route header + next 2 arrival times |

### SEPTA Panel Notes
- Feed: `https://www3.septa.org/gtfsrt/septa-pa-us/Trip/rtTripUpdates.pb` — same protobuf format as MTA, no API key required
- Stop IDs are already directional (each pole is a unique stop ID — no N/S suffix needed)
- Config fields: `route` (e.g., `"48"`) and `stop_id` (e.g., `"5372"`)
- Layout: pixel-art SEPTA logo in left 22px column; route + next 2 ETAs in right 42px
- Logo loaded from `/septa_11x16.bmp` on the CIRCUITPY drive via `displayio.OnDiskBitmap`; positioned x=0, y=8 (centered vertically in 32px column)
- BMP must have G/B channels pre-swapped for the panel hardware — use `images/septa_11x16_panel.bmp` (auto-generated, correct colors) not `septa_11x16.bmp` (original)
- If the BMP is missing on the device, the logo area is silently blank (try/except)
- Long objects from `gtfs-realtime-bindings` handled: `typeof time === 'object' ? time.low : time`

### Subway Panel Layout (32px tall, 64px wide)
```
y=6   Station Name (orange, max 13 chars, from API response)
y=16  ● L  Brooklyn          2m    ← northbound row
y=26  ● L  8 Av              6m    ← southbound row
```
- Circle: center (5, 16/26), radius 4, filled with MTA line color
- Route letter/number: x=4 (centered in circle), white
- Dest: x=11 (1px gap after circle right edge at x=9), white, max 8 chars
- Time: x=50, orange. "now" when minutes=0 (yellow). Min label "m": x=60
- No-data state: dim gray circle (`0x444444`), blank route/dest, "--" time

### MTA Line Colors (firmware `LINE_COLORS` dict)
Colors are G/B-channel-swapped to compensate for panel hardware wiring (`#RRGGBB` stored as `#RRBBGG`):
| Lines | Standard color | Stored value |
|---|---|---|
| 1, 2, 3 | Red `#EE352E` | `0xEE2E35` |
| 4, 5, 6 | Green `#00933C` | `0x003C93` |
| 7, 7X | Purple `#B933AD` | `0xB9AD33` |
| A, C, E | Blue `#0039A6` | `0x00A639` |
| B, D, F, M | Orange `#FF6319` | `0xFF1963` |
| G | Lime green `#6CBE45` | `0x6C45BE` |
| J, Z | Brown `#996633` | `0x993366` |
| L | Gray (dark) | `0x5A5A5A` |
| N, Q, R, W | Yellow `#FCCC0A` | `0xFC0ACC` |
| S | Dark gray | `0x808381` |

### Direction Labels (`northDest` / `southDest` in `mta-stations.js`)
Max 8 chars. All lines:
| Line | North | South |
|---|---|---|
| G | Ct Sq | Church |
| L | 8 Av | Cnarsi |
| 7 | Hudson | Flushing |
| A/C/E | Uptown | Brooklyn |
| B/D/F/M | Uptown | Brooklyn |
| N/Q/R/W | Queens | Brooklyn |
| 1/2/3 | Uptown | Downtown |
| 4/5/6 | Uptown | Downtown |
| J/Z | Jamaica | Broad |

### Last.FM Panel Notes
- 3-line layout: artist (orange), album (gray), track (white) — left 32px text zone; right 32px album art
- Text zone is exactly 32px wide; labels are fixed at x=2 and never move
- Long text (>7 chars) scrolls via **character-windowing**: shows a 7-char window (28px) that advances 1 char every 4 ticks (~10px/s equivalent); no pixel-position movement
- 1-second hold before scroll starts; resets on every data refresh
- Album art: `/api/lastfm` response includes `art_url`; firmware calls `/api/lastfm/art?url=` to get a 2048-byte raw RGB565 blob (32×32); displayed as a `displayio.Bitmap` built entirely in RAM (no filesystem write)
- **RGB565 encoding has G/B channels swapped** in `/api/lastfm/art` — the panel hardware has G and B physically swapped (see `GREEN = 0x0000FF` in firmware constants); server compensates: `((r & 0xF8) << 8) | ((b & 0xFC) << 3) | (g >> 3)`
- SSRF guard on `/api/lastfm/art`: only allows URLs from `lastfm.freetls.fastly.net`
- `LASTFM_API_KEY` is set as a Cloud Run env var; devices can also pass `?key=` from their Firestore config

### Firestore Schema
```json
{
  "display_name": "Kitchen Sign",
  "brightness": 0.4,
  "scroll_speed": 15,
  "openweather_api_key": "...",
  "lastfm_api_key": "...",
  "pages": [
    { "type": "mta",     "line": "G",      "station_id": "G26" },
    { "type": "weather", "zip": "10001",   "mode": "3-day" },
    { "type": "lastfm",  "username": "...", "mode": "nowplaying" },
    { "type": "mlb",     "team": "NYM",    "mode": "schedule" },
    { "type": "septa",   "route": "42",    "stop_id": "12345" }
  ]
}
```

### Next Steps
- **MLB / NFL**: Choose data source, wire up endpoints

### Known Issues / Backlog
- **SEPTA logo colors**: BMP loaded via `OnDiskBitmap` uses raw file colors; panel hardware swaps G/B on output. `septa_11x16_panel.bmp` (G/B pre-swapped) must be copied to CIRCUITPY as `septa_11x16.bmp` — easy to get wrong. Consider embedding the logo in firmware (Bitmap + palette) to eliminate the extra file dependency.
- **Weather panel — icon**: Current weather should show a weather icon alongside temp/condition
- **Weather panel — location**: Show city/state/zip on the current weather screen
- **7-day forecast**: Only 3 days display; not enough real estate for 7 days — needs either a condensed layout (heavily abbreviated) or a design decision to cap at 3-day
- **G train dest label**: `'Ct Sq'` should be `'Court Sq'` — dest field can hold ~10 chars, no need to abbreviate
- **Express train route letters**: `7X`, `6X`, etc. display as two characters in the circle — strip the `X` suffix so only the number shows (express vs local isn't meaningful on the sign)

---

## Known Bugs Fixed
- `STATION_ID` missing from Firestore config override block — device always showed Greenpoint
- `(data.get('north') or {}).get('minutes')` — null-safe fix for null GTFS trains
- A29 doesn't exist in GTFS — was causing "14 St" to return null trains
- `LASTFM_API_KEY` not set on Cloud Run — endpoint returned 503; fixed by setting env var
- Last.FM text scrolled across full 64px display — replaced pixel-scroll with character-windowing (labels fixed at x=2, 7-char window slides)
- Album art wrong colors — panel hardware has G/B channels physically swapped; fixed by swapping G/B in server RGB565 encoding
- Album art required CIRCUITPY write (silently fails when USB-mounted) — replaced with fully in-memory `displayio.Bitmap(32, 32, 65536)` built from raw bytes
- MTA `gtfs-7` feed URL returns NoSuchKey — 7 train now served from main `gtfs` feed (`123456S`); `7X` express also added to `LINE_COLORS`
- Subway panel dest labels overflowed into time zone — shortened direction labels, tightened pixel layout
- Subway panel showed no station name — added station name row at top (y=6, orange, from API)
- Circle color defaulted to WHITE when no train data — now falls back to dim gray (`0x444444`)
- L train circle too light (gray-on-gray illegible) — darkened to `0x5A5A5A`
- SEPTA `/api/septa` was a stub — replaced with real GTFS-RT TripUpdates handler using `gtfs-realtime-bindings`; 5th panel added to firmware carousel; `scroll_to_view()` had hardcoded `range(4)` preventing the SEPTA panel from rendering (fixed to `range(len(groups))`)

## CircuitPython Notes
- Uses `adafruit_requests` (not `requests`) — does not support `json=` kwarg; use `json.dumps(data)` + `content_type='application/json'`
- Device MAC address used as Firestore document key
- `matrixportal.display.brightness` must be set after Firestore config is applied
- Free memory ~1.8MB — keep code lean
- Colors on this panel use non-standard channel ordering — calibrated constants are in `code.py`; gray is symmetric so `0x444444` works regardless

## Local Dev
```bash
cd server && npm install
node app.js   # or use preview_start in Claude
```
Admin UI: http://localhost:3000

Firestore won't work locally (no GCP credentials) — expected. GTFS-RT, weather, and Last.FM APIs will work if `MTA_API_KEY` / `OPENWEATHER_API_KEY` / `LASTFM_API_KEY` env vars are set.
