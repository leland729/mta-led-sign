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
                          [Firestore: device config]
                                    ↑
                          [Admin UI: /public/index.html]
```

## Key Files

| File | Purpose |
|------|---------|
| `circuitpy/code.py` | CircuitPython firmware — runs on the device |
| `circuitpy/secrets.py` | WiFi credentials + optional api_url override (**never commit**) |
| `server/app.js` | Node.js/Express server — GTFS-RT proxy, Admin API, firmware generator |
| `server/public/index.html` | Admin UI (vanilla JS, no framework) |
| `gtfs_subway/stops.txt` | MTA GTFS static data (Feb 19 2026) — ground truth for stop IDs |
| `.claude/launch.json` | Local preview server config (`node server/app.js`, port 3000) |

## Deployment

**Server:** Google Cloud Run (`us-east1`)
- Deploy: `cd server && gcloud run deploy subway-api --source . --region us-east1`
- URL: `https://subway-api-336mpuaosa-ue.a.run.app` (also `https://subway-api-829904256043.us-east1.run.app`)
- Health check: `curl https://subway-api-336mpuaosa-ue.a.run.app/health`

**Device firmware:** Must be manually copied to the `CIRCUITPY` drive (USB mount).
- The device is read-only when USB is connected in normal mode
- AP mode (hold button on boot) allows editing files via browser

## Device Config Flow
1. Admin UI → POST `/api/device/:mac` → saved to Firestore
2. Device boots → GET `/api/device/:mac/config` → applies config from Firestore
3. Config keys in Firestore: `station_id`, `zip_code`, `openweather_api_key`, `scroll_speed`, `brightness`

**secrets.py** only holds WiFi credentials (`ssid`, `password`) and optionally `api_url`. It is never written by the server — the device is read-only over WiFi.

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

## Known Bugs Fixed
- `STATION_ID` was missing from Firestore config override block in both `code.py` and the firmware template in `app.js` — device always showed Greenpoint regardless of Admin UI setting
- `(data.get('north') or {}).get('minutes')` — null-safe fix for when GTFS returns null trains
- A29 doesn't exist in GTFS — was causing "14 St" to return null trains

## CircuitPython Notes
- Uses `adafruit_requests` (not `requests`) — does not support `json=` kwarg, use `json.dumps(data)` + `content_type='application/json'`
- Device MAC address used as Firestore document key
- `matrixportal.display.brightness` must be set after Firestore config is applied
- Free memory ~1.8MB — keep code lean

## Local Dev
```bash
cd server && npm install
node app.js   # or use preview_start in Claude
```
Admin UI: http://localhost:3000

Firestore won't work locally (no GCP credentials) — expected. GTFS-RT and weather API will work if MTA_API_KEY / OPENWEATHER_API_KEY env vars are set.
