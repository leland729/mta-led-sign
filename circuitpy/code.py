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
    SERVER_URL = secrets.get("server_url", "http://192.168.0.162:3000")
    STATION_ID = secrets.get("station_id", "G26")
    BRIGHTNESS = secrets.get("brightness", 0.4)
except ImportError:
    print("Warning: secrets.py not found, using defaults")
    secrets = {"ssid": "WIFI", "password": "PASS"}
    SERVER_URL = "http://192.168.0.162:3000"
    STATION_ID = "G26"
    BRIGHTNESS = 0.4

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
    """Manages the LED matrix display for train arrivals"""
    
    def __init__(self):
        self.main_group = displayio.Group()
        matrixportal.display.root_group = self.main_group
        self._setup_display()
    
    def _setup_display(self):
        """Initialize display elements"""
        # North train (top line)
        self.north_group = displayio.Group()
        
        if has_shapes:
            north_bullet = Circle(5, 9, 4, fill=GREEN)
            self.north_group.append(north_bullet)
        
        self.north_route = label.Label(font, text="G", color=WHITE, x=4, y=10)
        self.north_dest = label.Label(font, text="Court Sq", color=WHITE, x=12, y=10)
        self.north_time = label.Label(font, text="--", color=ORANGE, x=50, y=10)
        self.north_min = label.Label(font, text="", color=ORANGE, x=60, y=10)
        
        self.north_group.append(self.north_route)
        self.north_group.append(self.north_dest)
        self.north_group.append(self.north_time)
        self.north_group.append(self.north_min)
        self.main_group.append(self.north_group)
        
        # South train (bottom line)
        self.south_group = displayio.Group()
        
        if has_shapes:
            south_bullet = Circle(5, 22, 4, fill=GREEN)
            self.south_group.append(south_bullet)
        
        self.south_route = label.Label(font, text="G", color=WHITE, x=4, y=23)
        self.south_dest = label.Label(font, text="Church Av", color=WHITE, x=12, y=23)
        self.south_time = label.Label(font, text="--", color=ORANGE, x=50, y=23)
        self.south_min = label.Label(font, text="", color=ORANGE, x=60, y=23)
        
        self.south_group.append(self.south_route)
        self.south_group.append(self.south_dest)
        self.south_group.append(self.south_time)
        self.south_group.append(self.south_min)
        self.main_group.append(self.south_group)
        
        # Status message
        self.status = label.Label(font, text="", color=WHITE, x=15, y=16)
        self.main_group.append(self.status)
        
        # Error indicator
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
            time_label.text = "Now"
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

class NetworkManager:
    """Handles WiFi connection and HTTP requests"""
    
    def __init__(self):
        self.connected = False
        self.requests = None
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
            self.connected = True
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

# Initialize components
display = TrainDisplay()
network = NetworkManager()

print("Display initialized")

# MAIN PROGRAM
print("\nStarting main program...")

# Initial connection and data fetch
display.show_status("WiFi..")
if network.connect():
    time.sleep(2)  # Allow network to stabilize
    
    print("Fetching initial data...")
    initial_data = network.fetch_trains()
    if initial_data:
        display.update(initial_data)
        display.show_error(False)
    else:
        display.show_error(True)
else:
    display.show_status("No WiFi")
    display.show_error(True)

# Main loop
last_update = time.monotonic()
print(f"Starting main loop - updating every {UPDATE_INTERVAL} seconds")

while True:
    current_time = time.monotonic()
    
    # Time for update?
    if current_time - last_update >= UPDATE_INTERVAL:
        print(f"\nUpdate cycle at {current_time:.0f}s")
        
        # Fetch new data
        train_data = network.fetch_trains()
        
        if train_data:
            display.update(train_data)
            display.show_error(False)
            print("Display updated successfully")
        else:
            display.show_error(True)
            print("Failed to fetch data")
        
        last_update = current_time
        
        # Aggressive garbage collection after update
        gc.collect()
        print(f"Free memory: {gc.mem_free()} bytes")
    
    # Small delay to prevent busy waiting
    time.sleep(0.2)
