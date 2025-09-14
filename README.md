# MTA LED Sign

A real-time NYC subway arrival display using a 64x32 LED matrix and live MTA data. Shows upcoming G train arrivals with authentic MTA styling.

## Features

- **Real-time arrivals** from MTA GTFS-Realtime feeds
- **Authentic MTA design** with blue backgrounds and proper typography
- **Automatic updates** every 30 seconds
- **Network resilience** with error handling and reconnection logic
- **Low memory footprint** optimized for microcontroller hardware
- **Easy configuration** via web interface

## Hardware Requirements

### LED Display
- **64x32 RGB LED Matrix Panel** (HUB75 interface)
- **Adafruit MatrixPortal S3** (ESP32-S3 based)
- **5V Power Supply** (4A recommended for full brightness)
- **USB-C Cable** for programming and auxiliary power

### Power Setup
**Important**: The MatrixPortal S3 requires both USB-C power AND external 5V power for proper LED panel operation. USB-C alone will result in incorrect colors and dim display.

## Software Architecture

### CircuitPython Device (`circuitpy/`)
- Connects to WiFi and fetches JSON data from local server
- Displays arrival times with MTA-style formatting
- Handles network errors and automatic reconnection
- Optimized for 64x32 pixel display constraints

### Node.js Server (`server/`)
- Fetches MTA GTFS-Realtime protobuf data
- Parses binary transit feeds and extracts G train arrivals
- Serves simplified JSON API for CircuitPython devices
- Runs on Raspberry Pi or any Node.js environment

## Quick Start

### 1. Set Up the Server

```bash
cd server/
npm install
cp .env.example .env
# Edit .env and add your MTA_API_KEY (optional - works without)
npm start
```

Server runs on `http://localhost:3000`

### 2. Configure Your Device

1. Install CircuitPython 9.x on your MatrixPortal S3
2. Copy all files from `circuitpy/` to your CIRCUITPY drive
3. Install required libraries (see `circuitpy/lib/dependencies`)
4. Edit `secrets.py` with your WiFi credentials:

```python
secrets = {
    "ssid": "YOUR_WIFI_NETWORK",
    "password": "YOUR_WIFI_PASSWORD",
    "server_url": "http://192.168.1.100:3000",  # Your server IP
    "station_id": "G26",  # Greenpoint Av
    "brightness": 0.4
}
```

### 3. Hardware Assembly

1. Connect MatrixPortal S3 to LED panel via HUB75 connector
2. Connect 5V external power to LED panel power input
3. Connect USB-C to MatrixPortal S3 for programming/auxiliary power
4. Both power connections are required for proper operation

## LED Panel Compatibility

Some 64x32 LED panels have swapped color channels. If your display shows incorrect colors:

```python
# In your CircuitPython code, try these color mappings:
GREEN = 0x0000FF    # Blue input → Green output  
YELLOW = 0xFF00AA   # Red + Blue input → Yellow output
MTA_BLUE = 0x39A600 # Green input → Blue output
```

The project includes automatic color calibration guidance in the setup process.

## Supported Stations

Currently configured for G train stations:

- **G26** - Greenpoint Av
- **G22** - Nassau Av  
- **G24** - Metropolitan Av/Grand St
- **G20** - Court Sq

## API Documentation

### GET `/api/next/{stationId}`

Returns next arrivals for both directions:

```json
{
  "station": "Greenpoint Av",
  "north": {
    "dest": "Court Sq",
    "minutes": 6,
    "route": "G"
  },
  "south": {
    "dest": "Church Av", 
    "minutes": 8,
    "route": "G"
  },
  "time": "2025-01-15T10:30:00Z"
}
```

### GET `/health`

Server health check endpoint.

## Configuration Options

### CircuitPython (`secrets.py`)
- `ssid/password` - WiFi credentials  
- `server_url` - Your Node.js server address
- `station_id` - MTA station identifier
- `brightness` - LED brightness (0.0-1.0)

### Server (`.env`)
- `MTA_API_KEY` - Optional MTA API key for higher rate limits
- `PORT` - Server port (default: 3000)

## Development

### Adding New Stations

1. Find the MTA station ID from [GTFS static data](http://web.mta.info/developers/data/nyct/subway/google_transit.zip)
2. Add station configuration to `server/app.js`:

```javascript
STATIONS['G28'] = {
  name: 'Broadway',
  northDest: 'Court Sq', 
  southDest: 'Church Av'
};
```

### Customizing Display

The CircuitPython code uses a modular design:
- `TrainDisplay` class handles LED matrix rendering
- `NetworkManager` class handles MTA data fetching  
- Colors and fonts can be easily modified

## Deployment

### Production Server (Raspberry Pi)

```bash
# Install PM2 for process management
npm install -g pm2

# Start with ecosystem file
pm2 start ecosystem.config.js

# Set up auto-restart on boot
pm2 startup
pm2 save
```

The included `ecosystem.config.js` optimizes for Raspberry Pi memory constraints.

## Troubleshooting

### Display Issues
- **No display**: Check both power connections (USB-C + 5V external)
- **Wrong colors**: See LED Panel Compatibility section above
- **Dim display**: Increase brightness in `secrets.py` or check 5V power supply

### Network Issues  
- **WiFi connection fails**: Ensure 2.4GHz network (5GHz not supported)
- **Can't reach server**: Check firewall settings and IP address
- **No train data**: MTA API may be down or station ID incorrect

### Memory Issues
- **Device resets**: Some library combinations exceed memory limits
- Use the minimal library set documented in `circuitpy/lib/dependencies`

## Contributing

1. Fork the repository
2. Create a feature branch
3. Test on actual hardware
4. Submit a pull request with clear description

## License

MIT License - see LICENSE file for details.

## Acknowledgments

- **MTA** for providing real-time transit data
- **Adafruit** for CircuitPython and MatrixPortal hardware
- **GTFS-Realtime** specification and community tools
