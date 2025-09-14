# MTA LED Sign Server

Node.js/Express server that fetches MTA GTFS-Realtime data and serves JSON endpoints for CircuitPython LED subway signs.

## Quick Start

### 1. Install Dependencies

```bash
cd Server
npm install
```

### 2. Get MTA API Key

1. Visit https://api.mta.info/
2. Sign up for a free account
3. Create an API key

### 3. Configure Environment

```bash
cp .env.example .env
# Edit .env and add your MTA_API_KEY
```

### 4. Start Server

```bash
npm start
```

Server runs on http://localhost:8080

### 5. Configure Your Device

1. Open http://localhost:8080/config in your browser
2. Enter your WiFi credentials and settings
3. Copy the generated `secrets.py` content
4. Save it as `secrets.py` on your CircuitPython device

## API Endpoints

### Station Information

**GET /api/station**
Returns all supported stations:
```json
{
  "G30": {
    "stop_id": "G30",
    "stop_name": "Greenpoint Av",
    "stop_lat": 40.731352,
    "stop_lon": -73.954449
  }
}
```

**GET /api/station/:id**
Returns specific station details including platform stop IDs.

### Schedule Data

**GET /api/schedule/:stationId**
Returns arrivals for both directions:
```json
{
  "N": [
    {
      "routeId": "G",
      "arrivalTime": 1672531200,
      "delay": 0,
      "tripId": "123456"
    }
  ],
  "S": [...]
}
```

**GET /api/schedule/:stationId/:route/:direction**
Returns filtered arrivals for specific route and direction.

### Utility Endpoints

**GET /config**
Web-based configuration page for generating CircuitPython secrets.py

**GET /status**
Server health check and cache status.

## Supported Stations

Currently configured for G train stations:

- **G30** - Greenpoint Av
- **G29** - Nassau Av  
- **G26** - Metropolitan Av/Grand St
- **G22** - Court Sq

## Architecture

### Data Flow
1. Server fetches GTFS-RT protobuf data from MTA API every 20 seconds
2. Parses binary data using gtfs-realtime-bindings
3. Caches parsed data to reduce API calls
4. Serves filtered JSON to CircuitPython devices

### Feed Mapping
G train uses the **L feed group** according to MTA documentation:
```javascript
const ROUTE_FEED_MAP = {
  'G': 'l'  // G train is in the L feed group
};
```

### Error Handling
- Returns cached data if MTA API is unreachable
- Graceful degradation during network issues
- Detailed error logging for debugging

## Adding New Stations

1. Find the parent station ID from MTA GTFS static data
2. Add to `STATIONS` object in `app.js`:
```javascript
'G28': {
  name: 'Your Station Name',
  lat: 40.123456,
  lon: -73.123456,
  northbound: 'G28N',
  southbound: 'G28S'
}
```

## Environment Variables

- `MTA_API_KEY` - Required for real-time data
- `PORT` - Server port (default: 8080)

## Cache Behavior

- **Cache Duration:** 20 seconds
- **Stale Data:** Returns cached data if MTA API fails
- **Memory Usage:** Minimal - only caches parsed feed objects

## GTFS-RT Details

The server uses the MTA's GTFS-Realtime feeds:
- **URL Format:** `https://api-endpoint.mta.info/Dataservice/mtagtfsrt/gtfs-{feed}`
- **Feed Groups:** Each route belongs to a specific feed (G train = L feed)
- **Data Format:** Protocol Buffers, parsed with gtfs-realtime-bindings
- **Update Frequency:** MTA updates feeds every 30 seconds

## Development

### Debug Mode
```bash
node app.js
```

### Testing Endpoints
```bash
# Check server status
curl http://localhost:8080/status

# Get station list
curl http://localhost:8080/api/station

# Get Greenpoint Av schedule
curl http://localhost:8080/api/schedule/G30
```

### Without MTA API Key
Server will start but return empty arrays for schedule requests. Use for development/testing the device without real data.

## Production Deployment

1. Use a process manager like PM2
2. Set up reverse proxy (nginx) for HTTPS
3. Configure firewall to allow device access
4. Monitor logs for API quota usage

## Troubleshooting

### No arrival data
- Check MTA_API_KEY is valid and set in .env
- G train service may be suspended (nights/weekends)
- Check server logs for GTFS-RT fetch errors

### Device can't connect
- Ensure server IP is correct in secrets.py
- Check firewall allows port 8080
- Verify device and server on same network

### Performance issues
- Monitor cache hit rate in /status endpoint
- Increase CACHE_DURATION if needed
- Check MTA API rate limits
