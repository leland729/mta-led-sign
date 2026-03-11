"""
Improved MTA LED Sign - 64x32 Single Panel
Server calculates minutes - device just displays them
Updates every 30 seconds with better error handling
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

print("MTA Sign - 64x32 Improved Version")
print("=" * 40)

# Configuration
MATRIX_WIDTH = 64
MATRIX_HEIGHT = 32
UPDATE_INTERVAL = 30  # seconds
WEATHER_UPDATE_INTERVAL = 600  # 10 minutes
FORECAST_UPDATE_INTERVAL = 1800  # 30 minutes
VIEW_CYCLE_INTERVAL = 10  # seconds to show each view before switching
MAX_RETRIES = 3
RETRY_DELAY = 5  # seconds between retries

# Colors
BLACK = 0x000000
WHITE = 0xFFFFFF
GREEN = 0x0000FF
ORANGE = 0xFF00AA
YELLOW = 0xFF00AA
RED = 0xEE352E
MTA_BLUE = 0x39A600

# Load configuration from secrets
try:
    from secrets import secrets
    SERVER_URL = secrets.get("api_url", "http://192.168.0.162:3000")
    STATION_ID = secrets.get("station_id", "G26")
    BRIGHTNESS = secrets.get("brightness", 0.4)
    WEATHER_API_KEY = secrets.get("openweather_api_key", "")
    ZIP_CODE = secrets.get("zip_code", "11222")
except ImportError:
    print("Warning: secrets.py not found, using defaults")
    secrets = {"ssid": "WIFI", "password": "PASS"}
    SERVER_URL = "http://192.168.0.162:3000"
    STATION_ID = "G26"
    BRIGHTNESS = 0.4
    WEATHER_API_KEY = ""
    ZIP_CODE = "11222"

# Initialize display
matrixportal = MatrixPortal(
    width=MATRIX_WIDTH,
    height=MATRIX_HEIGHT,
    bit_depth=4
)
matrixportal.display.brightness = BRIGHTNESS

# Load font
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
        self.current_view = "subway"  # "subway" or "weather"
        self._setup_display()
        self._setup_splash()
        matrixportal.display.root_group = self.splash_group  # Boot with splash

    def _setup_display(self):
        """Initialize display elements"""
        # Create subway view group
        self.subway_group = displayio.Group()
        self.subway_group.y = 0

        # North train (top line)
        if has_shapes:
            north_bullet = Circle(5, 9, 4, fill=GREEN)
            self.subway_group.append(north_bullet)

        self.north_route = label.Label(font, text="G", color=WHITE, x=4, y=10)
        self.north_dest = label.Label(font, text="Court Sq", color=WHITE, x=12, y=10)
        self.north_time = label.Label(font, text="--", color=ORANGE, x=50, y=10)
        self.north_min = label.Label(font, text="", color=ORANGE, x=60, y=10)

        self.subway_group.append(self.north_route)
        self.subway_group.append(self.north_dest)
        self.subway_group.append(self.north_time)
        self.subway_group.append(self.north_min)

        # South train (bottom line)
        if has_shapes:
            south_bullet = Circle(5, 22, 4, fill=GREEN)
            self.subway_group.append(south_bullet)

        self.south_route = label.Label(font, text="G", color=WHITE, x=4, y=23)
        self.south_dest = label.Label(font, text="Church Av", color=WHITE, x=12, y=23)
        self.south_time = label.Label(font, text="--", color=ORANGE, x=50, y=23)
        self.south_min = label.Label(font, text="", color=ORANGE, x=60, y=23)

        self.subway_group.append(self.south_route)
        self.subway_group.append(self.south_dest)
        self.subway_group.append(self.south_time)
        self.subway_group.append(self.south_min)

        # Status message
        self.status = label.Label(font, text="", color=WHITE, x=15, y=16)
        self.subway_group.append(self.status)

        # Add subway group to main
        self.main_group.append(self.subway_group)

        # Create weather view group (positioned off-screen below)
        self.weather_group = displayio.Group()
        self.weather_group.y = MATRIX_HEIGHT

        # Weather elements - condition on top (moved down 2 pixels)
        self.weather_condition = label.Label(font, text="", color=WHITE, x=8, y=10)
        self.weather_group.append(self.weather_condition)

        # Current temp (centered middle, moved down 2 pixels)
        self.weather_temp = label.Label(font, text="--F", color=ORANGE, x=24, y=18)
        self.weather_group.append(self.weather_temp)

        # High/Low (bottom, moved down 2 pixels)
        self.weather_high_label = label.Label(font, text="H:", color=WHITE, x=12, y=26)
        self.weather_high = label.Label(font, text="--", color=RED, x=20, y=26)
        self.weather_low_label = label.Label(font, text="L:", color=WHITE, x=36, y=26)
        self.weather_low = label.Label(font, text="--", color=MTA_BLUE, x=44, y=26)

        self.weather_group.append(self.weather_high_label)
        self.weather_group.append(self.weather_high)
        self.weather_group.append(self.weather_low_label)
        self.weather_group.append(self.weather_low)

        # Add weather group to main
        self.main_group.append(self.weather_group)

        # Create forecast view group (positioned off-screen below weather)
        self.forecast_group = displayio.Group()
        self.forecast_group.y = MATRIX_HEIGHT * 2

        # Day 1 forecast (top line)
        self.day1_name = label.Label(font, text="", color=WHITE, x=2, y=9)
        self.day1_high = label.Label(font, text="", color=RED, x=20, y=9)
        self.day1_low = label.Label(font, text="", color=MTA_BLUE, x=32, y=9)
        self.day1_cond = label.Label(font, text="", color=WHITE, x=44, y=9)

        self.forecast_group.append(self.day1_name)
        self.forecast_group.append(self.day1_high)
        self.forecast_group.append(self.day1_low)
        self.forecast_group.append(self.day1_cond)

        # Day 2 forecast (middle line)
        self.day2_name = label.Label(font, text="", color=WHITE, x=2, y=18)
        self.day2_high = label.Label(font, text="", color=RED, x=20, y=18)
        self.day2_low = label.Label(font, text="", color=MTA_BLUE, x=32, y=18)
        self.day2_cond = label.Label(font, text="", color=WHITE, x=44, y=18)

        self.forecast_group.append(self.day2_name)
        self.forecast_group.append(self.day2_high)
        self.forecast_group.append(self.day2_low)
        self.forecast_group.append(self.day2_cond)

        # Day 3 forecast (bottom line)
        self.day3_name = label.Label(font, text="", color=WHITE, x=2, y=27)
        self.day3_high = label.Label(font, text="", color=RED, x=20, y=27)
        self.day3_low = label.Label(font, text="", color=MTA_BLUE, x=32, y=27)
        self.day3_cond = label.Label(font, text="", color=WHITE, x=44, y=27)

        self.forecast_group.append(self.day3_name)
        self.forecast_group.append(self.day3_high)
        self.forecast_group.append(self.day3_low)
        self.forecast_group.append(self.day3_cond)

        # Add forecast group to main
        self.main_group.append(self.forecast_group)

        # Error indicator (always visible)
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
        elif minutes == 1:
            time_label.text = "1"
            time_label.x = 50
            min_label.text = "m"
            time_label.color = ORANGE
        elif minutes < 10:
            time_label.text = str(minutes)
            time_label.x = 50
            min_label.text = "m"
            time_label.color = ORANGE
        else:
            # Double digits - adjust position
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
        
        # Update north train
        north_minutes = data.get('north', {}).get('minutes')
        self.update_train_time(self.north_time, self.north_min, north_minutes)
        
        # Update south train
        south_minutes = data.get('south', {}).get('minutes')
        self.update_train_time(self.south_time, self.south_min, south_minutes, is_south=True)
    
    def show_status(self, message):
        """Show status message"""
        self.status.text = message[:8]  # Limit for 64px width

    def show_error(self, show=True):
        """Show/hide error indicator"""
        if self.error_group:
            self.error_group.hidden = not show

    def _setup_splash(self):
        """Initialize boot splash group — shown during WiFi connect, hidden after first data load"""
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
        """Dismiss splash and reveal main display (data already populated)"""
        matrixportal.display.root_group = self.main_group

    def update_weather(self, weather_data):
        """Update weather display"""
        if not weather_data:
            return

        temp = weather_data.get('temp', '--')
        condition = weather_data.get('condition', '')
        high = weather_data.get('high', '--')
        low = weather_data.get('low', '--')

        # Update condition on top line (limit to fit 64px width)
        self.weather_condition.text = condition[:14]  # ~14 chars fits nicely

        # Update temp in middle
        self.weather_temp.text = f"{temp}F"

        # Update high/low on bottom
        self.weather_high.text = str(high)
        self.weather_low.text = str(low)

    def update_forecast(self, forecast_data):
        """Update 3-day forecast display"""
        if not forecast_data or len(forecast_data) < 3:
            return

        # Day 1
        day1 = forecast_data[0]
        self.day1_name.text = day1.get('day', '')[:3]
        self.day1_high.text = f"H{day1.get('high', '--')}"
        self.day1_low.text = f"L{day1.get('low', '--')}"
        self.day1_cond.text = day1.get('condition', '')[:8]

        # Day 2
        day2 = forecast_data[1]
        self.day2_name.text = day2.get('day', '')[:3]
        self.day2_high.text = f"H{day2.get('high', '--')}"
        self.day2_low.text = f"L{day2.get('low', '--')}"
        self.day2_cond.text = day2.get('condition', '')[:8]

        # Day 3
        day3 = forecast_data[2]
        self.day3_name.text = day3.get('day', '')[:3]
        self.day3_high.text = f"H{day3.get('high', '--')}"
        self.day3_low.text = f"L{day3.get('low', '--')}"
        self.day3_cond.text = day3.get('condition', '')[:8]

    def scroll_to_view(self, view_name):
        """Animate vertical scroll to specified view"""
        if self.current_view == view_name:
            return

        # Determine target positions
        if view_name == "weather":
            subway_target = -MATRIX_HEIGHT
            weather_target = 0
            forecast_target = MATRIX_HEIGHT
        elif view_name == "forecast":
            subway_target = -MATRIX_HEIGHT * 2
            weather_target = -MATRIX_HEIGHT
            forecast_target = 0
        else:  # subway
            subway_target = 0
            weather_target = MATRIX_HEIGHT
            forecast_target = MATRIX_HEIGHT * 2

        # Animate the scroll (8 frames)
        frames = 8
        for i in range(frames + 1):
            progress = i / frames
            self.subway_group.y = int(self.subway_group.y + (subway_target - self.subway_group.y) * progress)
            self.weather_group.y = int(self.weather_group.y + (weather_target - self.weather_group.y) * progress)
            self.forecast_group.y = int(self.forecast_group.y + (forecast_target - self.forecast_group.y) * progress)
            time.sleep(0.08)  # Slower scroll animation

        # Ensure final positions
        self.subway_group.y = subway_target
        self.weather_group.y = weather_target
        self.forecast_group.y = forecast_target
        self.current_view = view_name

class NetworkManager:
    """Handles WiFi connection and HTTP requests"""
    
    def __init__(self):
        self.connected   = False
        self.requests    = None
        self.mac         = None   # set after first successful connect
        self.error_count = 0
        self.last_connect_attempt = 0
        
    def connect(self):
        """Connect to WiFi with retry logic"""
        current_time = time.monotonic()
        
        # Don't retry too frequently
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
                self.mac = ':'.join('{:02x}'.format(b) for b in wifi.radio.mac_address)
                print(f"MAC: {self.mac}")
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
                
                # Force garbage collection after network operation
                gc.collect()
                
                # Debug output
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
            
            # Reset connection after multiple failures
            if self.error_count >= MAX_RETRIES:
                self.connected = False
                print("Resetting connection after multiple failures")

        return None

    def fetch_weather(self):
        """Fetch weather data from OpenWeatherMap API"""
        if not WEATHER_API_KEY:
            print("No weather API key configured")
            return None

        if not self.connected or not self.requests:
            if not self.connect():
                return None

        try:
            url = f"https://api.openweathermap.org/data/2.5/weather?zip={ZIP_CODE},us&appid={WEATHER_API_KEY}&units=imperial"
            print(f"Fetching weather...")

            response = self.requests.get(url, timeout=10)

            if response.status_code == 200:
                data = response.json()
                response.close()

                # Extract weather info
                temp = int(data['main']['temp'])
                condition = data['weather'][0]['description'].upper()
                high = int(data['main']['temp_max'])
                low = int(data['main']['temp_min'])

                weather_data = {
                    'temp': temp,
                    'condition': condition,
                    'high': high,
                    'low': low
                }

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
        """Fetch 3-day weather forecast from OpenWeatherMap API"""
        if not WEATHER_API_KEY:
            print("No weather API key configured")
            return None

        if not self.connected or not self.requests:
            if not self.connect():
                return None

        try:
            # Use 5-day/3-hour forecast API (free tier)
            url = f"https://api.openweathermap.org/data/2.5/forecast?zip={ZIP_CODE},us&appid={WEATHER_API_KEY}&units=imperial"
            print(f"Fetching forecast...")

            response = self.requests.get(url, timeout=15)

            if response.status_code == 200:
                data = response.json()
                response.close()

                # Parse forecast data - aggregate by day
                forecast_list = data.get('list', [])
                if not forecast_list:
                    return None

                # Group forecasts by day
                days = {}

                for item in forecast_list:
                    # Get date from dt_txt field (format: "2024-11-25 12:00:00")
                    dt_txt = item.get('dt_txt', '')
                    if not dt_txt:
                        continue

                    # Extract date part (YYYY-MM-DD)
                    date_str = dt_txt.split(' ')[0]  # "2024-11-25"

                    if date_str not in days:
                        days[date_str] = {
                            'temps': [],
                            'conditions': [],
                            'date_str': date_str
                        }

                    # Collect temps and conditions
                    days[date_str]['temps'].append(item['main']['temp'])
                    days[date_str]['conditions'].append(item['weather'][0]['main'])

                # Build forecast for next 3 days (skip today)
                sorted_days = sorted(days.keys())
                forecast_data = []

                # Day name lookup
                day_names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

                for date_str in sorted_days[1:4]:  # Skip today, get next 3
                    if date_str not in days:
                        continue

                    day_data = days[date_str]

                    # Calculate high/low
                    high = int(max(day_data['temps']))
                    low = int(min(day_data['temps']))

                    # Get most common condition
                    conditions = day_data['conditions']
                    condition = max(set(conditions), key=conditions.count) if conditions else 'Clear'

                    # Calculate day of week from date
                    # Simple algorithm: Use Zeller's congruence (simplified)
                    parts = date_str.split('-')
                    year = int(parts[0])
                    month = int(parts[1])
                    day = int(parts[2])

                    # Adjust for Jan/Feb
                    if month < 3:
                        month += 12
                        year -= 1

                    # Zeller's formula
                    day_of_week = (day + ((13 * (month + 1)) // 5) + year + (year // 4) - (year // 100) + (year // 400)) % 7
                    # Convert Zeller output (0=Sat) to our format (0=Mon)
                    day_index = (day_of_week + 5) % 7
                    day_name = day_names[day_index]

                    forecast_data.append({
                        'day': day_name,
                        'high': high,
                        'low': low,
                        'condition': condition
                    })

                print(f"Forecast: {len(forecast_data)} days")
                gc.collect()
                return forecast_data if len(forecast_data) >= 3 else None

            else:
                print(f"Forecast API error {response.status_code}")
                response.close()

        except Exception as e:
            print(f"Forecast fetch error: {e}")

        return None

    def register_and_fetch_config(self):
        """Register this device with the server and return its Firestore config.

        Creates the Firestore document on first run; bumps last_seen on every
        subsequent boot.  Returns a config dict or None on any failure.
        """
        if not self.connected or not self.requests:
            if not self.connect():
                return None
        if not self.mac:
            return None

        try:
            # Register (idempotent — safe to call on every boot)
            reg_url = f"{SERVER_URL}/api/device/{self.mac}/register"
            print(f"Registering device {self.mac}...")
            resp = self.requests.post(reg_url, timeout=10)
            resp.close()
            gc.collect()

            # Fetch config
            cfg_url = f"{SERVER_URL}/api/device/{self.mac}/config"
            resp = self.requests.get(cfg_url, timeout=10)
            if resp.status_code == 200:
                config = resp.json()
                resp.close()
                gc.collect()
                print(f"Config: station={config.get('station_id')} brightness={config.get('brightness')}")
                return config
            else:
                print(f"Config fetch failed: HTTP {resp.status_code}")
                resp.close()

        except Exception as e:
            print(f"Registration error: {e}")

        return None

# Initialize components
display = TrainDisplay()
network = NetworkManager()

print("Display initialized")

# MAIN PROGRAM
print("\nStarting main program...")

# Initial connection — retry up to 3 times (~15 seconds total)
weather_data = None
forecast_data = None
connected = False

for attempt in range(3):
    display.show_splash("Connecting", "WiFi {}/3".format(attempt + 1))
    print(f"WiFi attempt {attempt + 1}/3")
    if network.connect():
        connected = True
        break
    if attempt < 2:
        time.sleep(RETRY_DELAY)  # wait before next attempt

if connected:
    display.show_splash("Connected!", "Syncing...")

    # Register with server and pull Firestore config.
    # Returned values override the compiled-in defaults above.
    config = network.register_and_fetch_config()
    if config:
        WEATHER_API_KEY     = config.get('openweather_api_key', WEATHER_API_KEY)
        ZIP_CODE            = config.get('zip_code', ZIP_CODE)
        VIEW_CYCLE_INTERVAL = config.get('scroll_speed', VIEW_CYCLE_INTERVAL)
        BRIGHTNESS          = config.get('brightness', BRIGHTNESS)
        matrixportal.display.brightness = BRIGHTNESS
        print("Firestore config applied")

    display.show_splash("Connected!", "Loading...")
    time.sleep(1)

    print("Fetching initial data...")
    initial_data = network.fetch_trains()
    if initial_data:
        display.update(initial_data)
        display.show_error(False)
    else:
        display.show_error(True)

    # Fetch initial weather
    print("Fetching initial weather...")
    weather_data = network.fetch_weather()
    if weather_data:
        display.update_weather(weather_data)

    # Fetch initial forecast
    print("Fetching initial forecast...")
    forecast_data = network.fetch_forecast()
    if forecast_data:
        display.update_forecast(forecast_data)

    display.hide_splash()  # Reveal main display — data already populated
else:
    # All retries failed — launch AP setup mode
    print("WiFi failed after 3 attempts — entering AP setup mode")
    import setup_mode
    setup_mode.run(display)
    # Never reaches here — setup_mode.run() calls microcontroller.reset()

# Main loop
last_update = time.monotonic()
last_weather_update = time.monotonic()
last_forecast_update = time.monotonic()
last_view_cycle = time.monotonic()
current_view_index = 0  # 0=subway, 1=weather, 2=forecast
views = ["subway", "weather", "forecast"]
print(f"Starting main loop - view cycles every {VIEW_CYCLE_INTERVAL}s")

while True:
    current_time = time.monotonic()

    # Time for train update?
    if current_time - last_update >= UPDATE_INTERVAL:
        print(f"\nTrain update cycle at {current_time:.0f}s")

        # Fetch new train data
        train_data = network.fetch_trains()

        if train_data:
            display.update(train_data)
            display.show_error(False)
            print("Trains updated successfully")
        else:
            display.show_error(True)
            print("Failed to fetch train data")

        last_update = current_time
        gc.collect()
        print(f"Free memory: {gc.mem_free()} bytes")

    # Time for weather update?
    if current_time - last_weather_update >= WEATHER_UPDATE_INTERVAL:
        print(f"\nWeather update cycle at {current_time:.0f}s")

        weather_data = network.fetch_weather()

        if weather_data:
            display.update_weather(weather_data)
            print("Weather updated successfully")

        last_weather_update = current_time
        gc.collect()

    # Time for forecast update?
    if current_time - last_forecast_update >= FORECAST_UPDATE_INTERVAL:
        print(f"\nForecast update cycle at {current_time:.0f}s")

        forecast_data = network.fetch_forecast()

        if forecast_data:
            display.update_forecast(forecast_data)
            print("Forecast updated successfully")

        last_forecast_update = current_time
        gc.collect()

    # Time to cycle view?
    if current_time - last_view_cycle >= VIEW_CYCLE_INTERVAL:
        # Cycle through views: subway -> weather -> forecast -> subway
        current_view_index = (current_view_index + 1) % len(views)
        next_view = views[current_view_index]

        print(f"Scrolling to {next_view} view")
        display.scroll_to_view(next_view)

        last_view_cycle = current_time

    # Small delay to prevent busy waiting
    time.sleep(0.2)