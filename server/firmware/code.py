"""
MTA LED Sign - 64x32 Single Panel
{{HEADER}}

Template: placeholder tokens (e.g. SERVER_URL, BRIGHTNESS) are replaced by
the server when generating device firmware via GET /firmware/:mac.
See server/firmware/template.js.
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

print("MTA Sign - 64x32")
print("=" * 40)

# ── Constants ─────────────────────────────────────────────────────────────────
MATRIX_WIDTH    = 64
MATRIX_HEIGHT   = 32
UPDATE_INTERVAL = 30   # seconds — background refresh for the current MTA page
MAX_RETRIES     = 3
RETRY_DELAY     = 5    # seconds between WiFi retries

# View index for the 4-panel vertical carousel
VIEW_INDEX = {'subway': 0, 'weather': 1, 'forecast': 2, 'lastfm': 3}

# ── Colors ────────────────────────────────────────────────────────────────────
BLACK    = 0x000000
WHITE    = 0xFFFFFF
GREEN    = 0x0000FF
ORANGE   = 0xFF00AA
YELLOW   = 0xFF00AA
RED      = 0xEE352E
MTA_BLUE = 0x39A600

# ── WiFi credentials (written to device by AP setup mode) ─────────────────────
from secrets import secrets  # needs: ssid, password only

# ── Device config (injected by server at firmware generation time) ─────────────
# These are fallback defaults; Firestore config overrides them on every boot.
SERVER_URL          = "{{SERVER_URL}}"
BRIGHTNESS          = {{BRIGHTNESS}}
VIEW_CYCLE_INTERVAL = {{SCROLL_SPEED}}   # seconds each page stays on screen
CFG = {
    "station_id":          "{{STATION_ID}}",
    "openweather_api_key": "",
    "lastfm_api_key":      "",
}

# ── Initialize display ────────────────────────────────────────────────────────
matrixportal = MatrixPortal(
    width=MATRIX_WIDTH,
    height=MATRIX_HEIGHT,
    bit_depth=4
)
matrixportal.display.brightness = BRIGHTNESS

# ── Load font ─────────────────────────────────────────────────────────────────
try:
    font = bitmap_font.load_font("/fonts/tom-thumb.bdf")
    print("Loaded tom-thumb font")
except (OSError, RuntimeError):
    import terminalio
    font = terminalio.FONT
    print("Using terminal font")


# ─────────────────────────────────────────────────────────────────────────────
class TrainDisplay:
    """Manages the 4-panel LED matrix carousel: subway / weather / forecast / lastfm"""

    def __init__(self):
        self.main_group = displayio.Group()
        matrixportal.display.root_group = self.main_group
        self.current_view = "subway"
        self._setup_display()
        self._setup_splash()
        matrixportal.display.root_group = self.splash_group  # Boot with splash

    # ── Setup ─────────────────────────────────────────────────────────────────

    def _setup_display(self):
        """Initialize all four display panel groups."""

        # Panel 0: Subway (y=0 when visible)
        self.subway_group = displayio.Group()
        self.subway_group.y = 0

        if has_shapes:
            self.subway_group.append(Circle(5, 9, 4, fill=GREEN))

        self.north_route = label.Label(font, text="G",         color=WHITE,  x=4,  y=10)
        self.north_dest  = label.Label(font, text="Court Sq",  color=WHITE,  x=12, y=10)
        self.north_time  = label.Label(font, text="--",        color=ORANGE, x=50, y=10)
        self.north_min   = label.Label(font, text="",          color=ORANGE, x=60, y=10)
        self.subway_group.append(self.north_route)
        self.subway_group.append(self.north_dest)
        self.subway_group.append(self.north_time)
        self.subway_group.append(self.north_min)

        if has_shapes:
            self.subway_group.append(Circle(5, 22, 4, fill=GREEN))

        self.south_route = label.Label(font, text="G",         color=WHITE,  x=4,  y=23)
        self.south_dest  = label.Label(font, text="Church Av", color=WHITE,  x=12, y=23)
        self.south_time  = label.Label(font, text="--",        color=ORANGE, x=50, y=23)
        self.south_min   = label.Label(font, text="",          color=ORANGE, x=60, y=23)
        self.subway_group.append(self.south_route)
        self.subway_group.append(self.south_dest)
        self.subway_group.append(self.south_time)
        self.subway_group.append(self.south_min)

        self.status = label.Label(font, text="", color=WHITE, x=15, y=16)
        self.subway_group.append(self.status)
        self.main_group.append(self.subway_group)

        # Panel 1: Current weather (y=MATRIX_HEIGHT initially)
        self.weather_group = displayio.Group()
        self.weather_group.y = MATRIX_HEIGHT

        self.weather_condition  = label.Label(font, text="",    color=WHITE,    x=8,  y=10)
        self.weather_temp       = label.Label(font, text="--F", color=ORANGE,   x=24, y=18)
        self.weather_high_label = label.Label(font, text="H:",  color=WHITE,    x=12, y=26)
        self.weather_high       = label.Label(font, text="--",  color=RED,      x=20, y=26)
        self.weather_low_label  = label.Label(font, text="L:",  color=WHITE,    x=36, y=26)
        self.weather_low        = label.Label(font, text="--",  color=MTA_BLUE, x=44, y=26)
        self.weather_group.append(self.weather_condition)
        self.weather_group.append(self.weather_temp)
        self.weather_group.append(self.weather_high_label)
        self.weather_group.append(self.weather_high)
        self.weather_group.append(self.weather_low_label)
        self.weather_group.append(self.weather_low)
        self.main_group.append(self.weather_group)

        # Panel 2: 3/7-day forecast (y=MATRIX_HEIGHT*2 initially)
        self.forecast_group = displayio.Group()
        self.forecast_group.y = MATRIX_HEIGHT * 2

        self._forecast_rows = []
        for y in [9, 18, 27]:
            name = label.Label(font, text="", color=WHITE,    x=2,  y=y)
            high = label.Label(font, text="", color=RED,      x=20, y=y)
            low  = label.Label(font, text="", color=MTA_BLUE, x=32, y=y)
            cond = label.Label(font, text="", color=WHITE,    x=44, y=y)
            self.forecast_group.append(name)
            self.forecast_group.append(high)
            self.forecast_group.append(low)
            self.forecast_group.append(cond)
            self._forecast_rows.append((name, high, low, cond))
        self.main_group.append(self.forecast_group)

        # Panel 3: Last.FM (y=MATRIX_HEIGHT*3 initially)
        self.lastfm_group = displayio.Group()
        self.lastfm_group.y = MATRIX_HEIGHT * 3

        self.lastfm_line1 = label.Label(font, text="", color=ORANGE, x=2, y=10)
        self.lastfm_line2 = label.Label(font, text="", color=WHITE,  x=2, y=22)
        self.lastfm_group.append(self.lastfm_line1)
        self.lastfm_group.append(self.lastfm_line2)
        self.main_group.append(self.lastfm_group)

        # Error dot (always visible, hidden by default)
        if has_shapes:
            self.error_group = displayio.Group()
            self.error_group.append(Circle(61, 2, 1, fill=RED))
            self.error_group.hidden = True
            self.main_group.append(self.error_group)
        else:
            self.error_group = None

    def _setup_splash(self):
        """Boot splash — shown during WiFi connect."""
        self.splash_group = displayio.Group()
        if has_shapes:
            self.splash_group.append(Circle(10, 16, 5, fill=GREEN))
        self.splash_letter = label.Label(font, text="G",           color=WHITE,  x=8,  y=17)
        self.splash_line1  = label.Label(font, text="Starting...", color=WHITE,  x=20, y=12)
        self.splash_line2  = label.Label(font, text="",            color=ORANGE, x=20, y=21)
        self.splash_group.append(self.splash_letter)
        self.splash_group.append(self.splash_line1)
        self.splash_group.append(self.splash_line2)

    # ── Splash ────────────────────────────────────────────────────────────────

    def show_splash(self, line1="", line2=""):
        self.splash_line1.text = line1[:10]
        self.splash_line2.text = line2[:10]
        matrixportal.display.root_group = self.splash_group

    def hide_splash(self):
        matrixportal.display.root_group = self.main_group

    # ── Helpers ───────────────────────────────────────────────────────────────

    def show_status(self, message):
        self.status.text = message[:8]

    def show_error(self, show=True):
        if self.error_group:
            self.error_group.hidden = not show

    def update_train_time(self, time_label, min_label, minutes):
        if minutes is None:
            time_label.text  = "--"
            time_label.x     = 50
            min_label.text   = ""
            return
        if minutes == 0:
            time_label.text  = "now"
            time_label.x     = 50
            min_label.text   = ""
            time_label.color = YELLOW
        else:
            time_label.text  = str(minutes)
            time_label.x     = 50
            min_label.text   = "m"
            time_label.color = ORANGE
        min_label.color = ORANGE

    # ── Panel update methods ──────────────────────────────────────────────────

    def update(self, data):
        """Update subway panel from /api/next/:stationId response."""
        if not data:
            return
        self.status.text = ""
        north_minutes = (data.get('north') or {}).get('minutes')
        self.update_train_time(self.north_time, self.north_min, north_minutes)
        south_minutes = (data.get('south') or {}).get('minutes')
        self.update_train_time(self.south_time, self.south_min, south_minutes)

    def update_weather(self, data):
        """Update current weather panel from /api/weather?mode=current response."""
        if not data:
            return
        self.weather_condition.text = data.get('description', '')[:14].upper()
        self.weather_temp.text      = f"{data.get('temp', '--')}F"
        self.weather_high.text      = str(data.get('high', '--'))
        self.weather_low.text       = str(data.get('low', '--'))

    def update_forecast(self, data):
        """Update forecast panel from /api/weather?mode=3-day|7-day response."""
        forecast = (data or {}).get('forecast', [])
        if len(forecast) < 3:
            return
        for (name_lbl, high_lbl, low_lbl, cond_lbl), entry in zip(self._forecast_rows, forecast[:3]):
            name_lbl.text = entry.get('date', '')[:3]
            high_lbl.text = f"H{entry.get('high', '--')}"
            low_lbl.text  = f"L{entry.get('low', '--')}"
            cond_lbl.text = entry.get('description', '')[:8]

    def update_lastfm(self, data):
        """Update Last.FM panel from /api/lastfm response."""
        if not data:
            return
        if data.get('mode') == 'nowplaying':
            prefix = "> " if data.get('nowplaying') else "  "
            self.lastfm_line1.text = (prefix + data.get('artist', ''))[:14]
            self.lastfm_line2.text = data.get('track', '')[:14]
        else:  # recent
            tracks = data.get('tracks', [])
            if tracks:
                self.lastfm_line1.text = tracks[0].get('artist', '')[:14]
                self.lastfm_line2.text = tracks[0].get('track', '')[:14]

    def update_page(self, page, data):
        """Dispatch to the right update method and scroll to the right panel."""
        if not data or data.get('error'):
            self.show_error(True)
            return
        self.show_error(False)
        ptype = page.get('type', 'mta')
        if ptype == 'mta':
            self.update(data)
            self.scroll_to_view('subway')
        elif ptype == 'weather':
            mode = page.get('mode', 'current')
            if mode == 'current':
                self.update_weather(data)
                self.scroll_to_view('weather')
            else:
                self.update_forecast(data)
                self.scroll_to_view('forecast')
        elif ptype == 'lastfm':
            self.update_lastfm(data)
            self.scroll_to_view('lastfm')

    # ── Scroll animation ──────────────────────────────────────────────────────

    def scroll_to_view(self, view_name):
        """Animate vertical scroll to the named panel."""
        if self.current_view == view_name:
            return
        target_idx = VIEW_INDEX.get(view_name, 0)
        groups = [self.subway_group, self.weather_group, self.forecast_group, self.lastfm_group]
        # Target y for each group: (group_index - target_index) * panel height
        final = [(i - target_idx) * MATRIX_HEIGHT for i in range(4)]

        frames = 8
        for frame in range(frames + 1):
            t = frame / frames
            for j in range(4):
                grp = groups[j]
                grp.y = int(grp.y + (final[j] - grp.y) * t)
            time.sleep(0.08)

        # Snap to exact positions
        for j in range(4):
            groups[j].y = final[j]
        self.current_view = view_name


# ─────────────────────────────────────────────────────────────────────────────
class NetworkManager:
    """Handles WiFi connection and HTTP requests to the server."""

    def __init__(self):
        self.connected            = False
        self.requests             = None
        self.mac                  = None
        self.error_count          = 0
        self.last_connect_attempt = 0

    def connect(self):
        """Connect to WiFi. Returns True on success."""
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
            if self.mac is None:
                self.mac = ':'.join(f'{b:02x}' for b in wifi.radio.mac_address)
                print(f"MAC: {self.mac}")

            self.connected   = True
            self.error_count = 0
            return True

        except Exception as e:
            print(f"WiFi error: {e}")
            self.connected = False
            return False

    def fetch_page_data(self, page):
        """Fetch live data for one carousel page from the server.

        Routes to the appropriate server endpoint based on page type:
          mta     → /api/next/:stationId
          weather → /api/weather?zip=&mode=
          lastfm  → /api/lastfm?username=&mode=
        """
        if not self.connected or not self.requests:
            if not self.connect():
                return None

        ptype = page.get('type', 'mta')

        try:
            if ptype == 'mta':
                sid = page.get('station_id', CFG['station_id'])
                url = f"{SERVER_URL}/api/next/{sid}"

            elif ptype == 'weather':
                z    = page.get('zip', '')
                mode = page.get('mode', 'current')
                url  = f"{SERVER_URL}/api/weather?zip={z}&mode={mode}"
                if CFG.get('openweather_api_key'):
                    url += f"&key={CFG['openweather_api_key']}"

            elif ptype == 'lastfm':
                user = page.get('username', '')
                mode = page.get('mode', 'nowplaying')
                url  = f"{SERVER_URL}/api/lastfm?username={user}&mode={mode}"
                if CFG.get('lastfm_api_key'):
                    url += f"&key={CFG['lastfm_api_key']}"

            else:
                print(f"Unsupported page type: {ptype}")
                return None

            print(f"Fetch {ptype}: {url}")
            response = self.requests.get(url, timeout=10)

            if response.status_code == 200:
                data = response.json()
                response.close()
                gc.collect()
                self.error_count = 0
                return data
            else:
                print(f"HTTP {response.status_code}")
                response.close()

        except Exception as e:
            print(f"Fetch error: {e}")
            self.error_count += 1
            if self.error_count >= MAX_RETRIES:
                self.connected = False
                print("Resetting connection after multiple failures")

        return None

    def register_and_fetch_config(self):
        """Register with server and return Firestore config dict."""
        if not self.connected or not self.requests:
            if not self.connect():
                return None
        if not self.mac:
            return None

        try:
            reg_url = f"{SERVER_URL}/api/device/{self.mac}/register"
            print(f"Registering {self.mac}...")
            resp = self.requests.post(reg_url, timeout=10)
            resp.close()
            gc.collect()

            cfg_url = f"{SERVER_URL}/api/device/{self.mac}/config"
            resp = self.requests.get(cfg_url, timeout=10)
            if resp.status_code == 200:
                config = resp.json()
                resp.close()
                gc.collect()
                print(f"Config: station={config.get('station_id')} brightness={config.get('brightness')}")
                return config
            else:
                print(f"Config failed: HTTP {resp.status_code}")
                resp.close()

        except Exception as e:
            print(f"Registration error: {e}")

        return None


# ── Initialize ────────────────────────────────────────────────────────────────
display = TrainDisplay()
network = NetworkManager()
print("Display initialized")

# Default single-page carousel — replaced by Firestore config on boot
CAROUSEL = [{'type': 'mta', 'station_id': CFG['station_id']}]

# ── Boot: WiFi + Firestore config ─────────────────────────────────────────────
print("\nStarting main program...")
connected = False

for attempt in range(3):
    display.show_splash("Connecting", f"WiFi {attempt + 1}/3")
    print(f"WiFi attempt {attempt + 1}/3")
    if network.connect():
        connected = True
        break
    if attempt < 2:
        time.sleep(RETRY_DELAY)

if connected:
    display.show_splash("Connected!", "Syncing...")

    config = network.register_and_fetch_config()
    if config:
        CFG['station_id']          = config.get('station_id',          CFG['station_id'])
        CFG['openweather_api_key'] = config.get('openweather_api_key', '')
        CFG['lastfm_api_key']      = config.get('lastfm_api_key',      '')
        VIEW_CYCLE_INTERVAL        = config.get('scroll_speed',         VIEW_CYCLE_INTERVAL)
        BRIGHTNESS                 = config.get('brightness',           BRIGHTNESS)
        matrixportal.display.brightness = BRIGHTNESS

        # Build carousel from pages array; supported types: mta, weather, lastfm
        raw_pages = config.get('pages', [])
        CAROUSEL  = [p for p in raw_pages if p.get('type') in ('mta', 'weather', 'lastfm')]
        if not CAROUSEL:
            CAROUSEL = [{'type': 'mta', 'station_id': CFG['station_id']}]

        print(f"Firestore config applied — {len(CAROUSEL)} page(s) in carousel")

    display.show_splash("Connected!", "Loading...")
    time.sleep(1)

    # Fetch and display the first page
    first = CAROUSEL[0]
    data  = network.fetch_page_data(first)
    display.update_page(first, data)
    display.hide_splash()

else:
    # All WiFi retries failed — launch AP setup mode
    print("WiFi failed — entering AP setup mode")
    import setup_mode
    setup_mode.run(display)
    # setup_mode.run() calls microcontroller.reset() — never reaches here

# ── Main loop ─────────────────────────────────────────────────────────────────
last_update     = time.monotonic()
last_view_cycle = time.monotonic()
carousel_index  = 0
print(f"Main loop — {len(CAROUSEL)} page(s), cycle every {VIEW_CYCLE_INTERVAL}s")

while True:
    current_time = time.monotonic()

    # Background refresh: keep current MTA page data fresh (trains change fast)
    if current_time - last_update >= UPDATE_INTERVAL:
        page = CAROUSEL[carousel_index]
        if page.get('type') == 'mta':
            print("\nBackground MTA refresh")
            data = network.fetch_page_data(page)
            if data and not data.get('error'):
                display.update(data)
                display.show_error(False)
            else:
                display.show_error(True)
        last_update = current_time
        gc.collect()
        print(f"Free mem: {gc.mem_free()} bytes")

    # Advance carousel
    if current_time - last_view_cycle >= VIEW_CYCLE_INTERVAL:
        carousel_index = (carousel_index + 1) % len(CAROUSEL)
        page  = CAROUSEL[carousel_index]
        print(f"\nCarousel → {carousel_index + 1}/{len(CAROUSEL)}: {page.get('type')}")
        data  = network.fetch_page_data(page)
        display.update_page(page, data)
        last_view_cycle = current_time
        gc.collect()

    time.sleep(0.2)
