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
| `server/public/index.html` | Admin UI (vanilla JS, no framework) |
| `gtfs_subway/stops.txt` | MTA GTFS static data (Feb 19 2026) — ground truth for stop IDs |
| `.claude/launch.json` | Local preview server config (`node server/app.js`, port 3000) |

## Deployment

**Server:** Google Cloud Run (`us-east1`)
- Deploy: `cd server && gcloud run deploy subway-api --source . --region us-east1`
- URL: `https://subway-api-829904256043.us-east1.run.app`
- Health check: `curl https://subway-api-829904256043.us-east1.run.app/health`

**Environment variables set on Cloud Run:**
- `MTA_API_KEY` — MTA GTFS-RT API key
- `LASTFM_API_KEY` — Last.FM API key
- `OPENWEATHER_API_KEY` — OpenWeather API key

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
| `123456S` | 1, 2, 3, 4, 5, 6, S |
| `7` | 7 |
| `G` | G |
| `L` | L |
| `JZ` | J, Z |

## Station Data Status (as of v1.3.0)
Station stop IDs in `server/app.js` are being corrected against `gtfs_subway/stops.txt`.

**Fixed:**
- G line (`G_LINE_STATIONS`) — corrected all IDs (G22–G36, A42, F20–F27)
- 7 line (`SEVEN_LINE_STATIONS`) — swapped 705/707, fixed cascade shift 708–726, added stop 726
- ACE line (`ACE_LINE_STATIONS`) — removed nonexistent A29, fixed cascade shift A14–A65, fixed H-prefix Rockaway stops, fixed E train Queens stops (now using correct G05, G06, F01, F03, F05–F09, G08–G21)

**Still needs fixing:**
- `BDFM_LINE_STATIONS` — D14 should be `7 Av`, cascade shifts in Manhattan and Brooklyn sections
- `NQRW_LINE_STATIONS` — needs verification
- `LINE_123_STATIONS` — missing stop 108 (207 St), cascade shift, 3-train Brooklyn names wrong
- `LINE_456_STATIONS` — 419=Wall St (not Nevins St), Brooklyn stops wrong
- `JZ_LINE_STATIONS` — J12–J31 all wrong names

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
| SEPTA | Route, Stop | SEPTA API | 🔲 Stub only |
| MLB | Team, Mode (schedule / live score) | TBD | 🔲 Stub only |
| NFL | Team, Mode (schedule / live score) | TBD | 🔲 Stub only |

### Server Endpoints
| Endpoint | Description |
|---|---|
| `GET /api/next/:stationId` | Next MTA trains for a parent stop ID |
| `GET /api/weather?zip=&mode=current\|3-day\|7-day[&key=]` | OpenWeather proxy |
| `GET /api/lastfm?username=&mode=nowplaying\|recent[&key=]` | Last.FM proxy — includes `art_url` in response |
| `GET /api/lastfm/art?url=` | Fetch, resize to 32×32, return raw RGB565 (2048 bytes); G/B swapped for panel hardware |
| `GET /api/septa` | Stub (returns `{ stub: true }`) |
| `GET /api/mlb` | Stub |
| `GET /api/nfl` | Stub |
| `GET /api/device/:mac/config` | Firestore config for device |
| `POST /api/device/:mac/register` | Register/upsert device in Firestore |
| `PATCH /api/device/:mac` | Update device config fields |
| `GET /firmware/:mac` | Generate and download `code.py` for device |

### Firmware Display Panels (4-panel vertical carousel)
| Index | View name | Content |
|---|---|---|
| 0 | `subway` | North + South next trains |
| 1 | `weather` | Current temp, condition, H/L |
| 2 | `forecast` | 3-row day/high/low/condition |
| 3 | `lastfm` | Artist (orange) / Album (gray) / Track (white) — left 32px; right 32px reserved for album art |

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
- **OPENWEATHER_API_KEY**: Set as Cloud Run env var (currently devices pass their own key)
- **SEPTA**: Wire up real SEPTA bus API endpoint
- **MLB / NFL**: Choose data source, wire up endpoints

---

## Known Bugs Fixed
- `STATION_ID` missing from Firestore config override block — device always showed Greenpoint
- `(data.get('north') or {}).get('minutes')` — null-safe fix for null GTFS trains
- A29 doesn't exist in GTFS — was causing "14 St" to return null trains
- `LASTFM_API_KEY` not set on Cloud Run — endpoint returned 503; fixed by setting env var
- Last.FM text scrolled across full 64px display — replaced pixel-scroll with character-windowing (labels fixed at x=2, 7-char window slides)
- Album art wrong colors — panel hardware has G/B channels physically swapped; fixed by swapping G/B in server RGB565 encoding
- Album art required CIRCUITPY write (silently fails when USB-mounted) — replaced with fully in-memory `displayio.Bitmap(32, 32, 65536)` built from raw bytes

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
