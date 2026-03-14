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

# View index for the 5-panel vertical carousel
VIEW_INDEX = {'subway': 0, 'weather': 1, 'forecast': 2, 'lastfm': 3, 'septa': 4}

# ── Weather icon sprite map ────────────────────────────────────────────────────
# Matches the OWM icon codes in weather_icons.bmp (16×16 tiles, 2 cols × 9 rows).
# Column 0 = day, column 1 = night. Index = (row * 2) + col.
_ICON_MAP = ("01", "02", "03", "04", "09", "10", "11", "13", "50")

def _icon_index(code):
    """Return sprite index for an OWM icon code like '01d' or '10n'."""
    if not code or len(code) < 3:
        return 0
    key = code[:2]
    col = 1 if code[2:3] == 'n' else 0
    for i, k in enumerate(_ICON_MAP):
        if k == key:
            return i * 2 + col
    return 0

# ── Colors ────────────────────────────────────────────────────────────────────
BLACK     = 0x000000
WHITE     = 0xFFFFFF
GRAY      = 0x444444
GREEN     = 0x0000FF
ORANGE    = 0xFF00AA
YELLOW    = 0xFF00AA
RED       = 0xEE352E
MTA_BLUE  = 0x39A600

# MTA line colors — G/B channels swapped to match panel hardware wiring.
# Formula: standard #RRGGBB → stored as #RRBBGG so panel displays correctly.
LINE_COLORS = {
    '1': 0xEE2E35, '2': 0xEE2E35, '3': 0xEE2E35,  # Red
    '4': 0x003C93, '5': 0x003C93, '6': 0x003C93,  # Green
    '7': 0xB9AD33, '7X': 0xB9AD33,                  # Purple (local + express)
    'A': 0x00A639, 'C': 0x00A639, 'E': 0x00A639,  # Blue
    'B': 0xFF1963, 'D': 0xFF1963, 'F': 0xFF1963, 'M': 0xFF1963,  # Orange
    'G': 0x6C45BE,                                  # Lime green
    'J': 0x993366, 'Z': 0x993366,                  # Brown
    'L': 0x5A5A5A,                                  # Gray (darker for contrast)
    'N': 0xFC0ACC, 'Q': 0xFC0ACC, 'R': 0xFC0ACC, 'W': 0xFC0ACC,  # Yellow
    'S': 0x808381,                                  # Dark gray (shuttle)
}

# ── SEPTA logo — 22×16 px, RGB565, G/B channels swapped for panel hardware ────
# Source: images/SEPTA.bmp (1563×1153 RGBA) downscaled with Lanczos, centered y=8 on 32px panel
# 3 colors: blue=0x0568 (#0044AE), red=0xE007 (#E63900), white=0xFFFF, off=0x0000
# Built into a displayio.Bitmap in RAM at boot — no BMP file needed on CIRCUITPY.
SEPTA_LOGO = (
    0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
    0x0000, 0x1D09, 0x256A, 0x254A, 0x254A, 0x1528, 0x96D5, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFE19, 0xFA0C, 0xF929, 0xF949, 0xF949, 0xF949, 0xF949, 0xF148, 0x0000,
    0x0000, 0x256A, 0x2509, 0x250A, 0x14E8, 0x96B5, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFDF, 0xFFFF, 0xFF9E, 0xF390, 0xF0C7, 0xF108, 0xF148, 0xF128, 0xF148, 0xF148, 0xE928, 0xF949, 0x0000,
    0x0000, 0x254A, 0x1D09, 0x14E8, 0x9EB5, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFE39, 0xF20B, 0xF0E7, 0xF169, 0xF169, 0xF148, 0xF148, 0xF148, 0xF148, 0xF148, 0xF949, 0x0000,
    0x0000, 0x254A, 0x1D09, 0x9EB5, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFF7D, 0xF3D1, 0xE866, 0xE886, 0xF0E7, 0xF0C7, 0xF0C7, 0xF149, 0xF148, 0xF148, 0xF148, 0xF148, 0xF949, 0x0000,
    0x0000, 0x1529, 0x6E11, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFD56, 0xF3B1, 0xFCB4, 0xFC94, 0xFC73, 0xFC74, 0xF3B1, 0xF0E7, 0xF149, 0xF149, 0xF148, 0xF148, 0xF949, 0x0000,
    0x0000, 0x254A, 0x1D09, 0x9EB6, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFF3D, 0xF3F2, 0xFF9E, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFC94, 0xF0C7, 0xF149, 0xF149, 0xF148, 0xF949, 0x0000,
    0x0000, 0x254A, 0x1D09, 0x14E8, 0x9EB6, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFE9A, 0xF2CE, 0xFEDB, 0xFFFF, 0xFFDF, 0xFFDF, 0xFFFF, 0xFCB4, 0xF0C7, 0xF149, 0xF148, 0xF949, 0x0000,
    0x0000, 0x254A, 0x2509, 0x250A, 0x14E8, 0x9EB5, 0xFFFF, 0xFFFF, 0xFFDF, 0xFFFF, 0xFEBB, 0xF2EE, 0xFEBB, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFCD5, 0xF0C7, 0xF128, 0xF949, 0x0000,
    0x0000, 0x254A, 0x1D09, 0x250A, 0x252A, 0x14E8, 0x9695, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFF1D, 0xFB71, 0xFF1D, 0xFFFF, 0xFFFF, 0xFFDF, 0xFFFF, 0xFCF5, 0xF128, 0xF949, 0x0000,
    0x0000, 0x254A, 0x1D09, 0x1D09, 0x250A, 0x250A, 0x14E8, 0x7E32, 0x96B5, 0x9695, 0x9695, 0x9ED6, 0x8612, 0xB697, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFDF, 0xFFFF, 0xF390, 0xF8E8, 0x0000,
    0x0000, 0x254A, 0x1D09, 0x1D09, 0x1D09, 0x1D09, 0x252A, 0x14E8, 0x0CE8, 0x14E8, 0x0CC7, 0x04A7, 0x6631, 0xE7BD, 0xFFFF, 0xFFFF, 0xFFDF, 0xFFFF, 0xFD36, 0xF128, 0xF949, 0x0000,
    0x0000, 0x254A, 0x1D09, 0x1D09, 0x1D09, 0x1D09, 0x1D09, 0x252A, 0x252A, 0x14E8, 0x356C, 0xBF19, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFDF, 0xFFFF, 0xFD36, 0xF0E7, 0xF128, 0xF949, 0x0000,
    0x0000, 0x256A, 0x1D09, 0x1D09, 0x1D09, 0x1D09, 0x2509, 0x1D09, 0x0CC8, 0x65F0, 0xEFBD, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFD36, 0xF0C7, 0xF148, 0xE948, 0xF949, 0x0000,
    0x0000, 0x1D29, 0x256A, 0x254A, 0x254A, 0x254A, 0x1D4A, 0x35AC, 0xB759, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF, 0xFD16, 0xF8E8, 0xF949, 0xF949, 0xF949, 0xF148, 0x0000,
    0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
)

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
    """Manages the 5-panel LED matrix carousel: subway / weather / forecast / lastfm / septa"""

    def __init__(self):
        self.main_group = displayio.Group()
        self.current_view = "subway"
        self._setup_display()
        self._setup_splash()
        matrixportal.display.root_group = self.splash_group  # Boot with splash

    # ── Setup ─────────────────────────────────────────────────────────────────

    def _setup_display(self):
        """Initialize all four display panel groups."""

        # Panel 0: Subway (y=0 when visible)
        # Layout (32px tall): station name y=6 | north y=16 | south y=26
        self.subway_group = displayio.Group()
        self.subway_group.y = 0

        # Row 0 — station name (full width, no circle)
        self.station_name = label.Label(font, text="", color=ORANGE, x=2, y=6)
        self.subway_group.append(self.station_name)

        # Row 1 — northbound
        self.north_circle = None
        if has_shapes:
            self.north_circle = Circle(5, 16, 4, fill=GREEN)
            self.subway_group.append(self.north_circle)

        self.north_route = label.Label(font, text="",   color=WHITE,  x=4,  y=17)
        self.north_dest  = label.Label(font, text="",   color=WHITE,  x=11, y=17)
        self.north_time  = label.Label(font, text="--", color=ORANGE, x=50, y=17)
        self.north_min   = label.Label(font, text="",   color=ORANGE, x=60, y=17)
        self.subway_group.append(self.north_route)
        self.subway_group.append(self.north_dest)
        self.subway_group.append(self.north_time)
        self.subway_group.append(self.north_min)

        # Row 2 — southbound
        self.south_circle = None
        if has_shapes:
            self.south_circle = Circle(5, 26, 4, fill=GREEN)
            self.subway_group.append(self.south_circle)

        self.south_route = label.Label(font, text="",   color=WHITE,  x=4,  y=27)
        self.south_dest  = label.Label(font, text="",   color=WHITE,  x=11, y=27)
        self.south_time  = label.Label(font, text="--", color=ORANGE, x=50, y=27)
        self.south_min   = label.Label(font, text="",   color=ORANGE, x=60, y=27)
        self.subway_group.append(self.south_route)
        self.subway_group.append(self.south_dest)
        self.subway_group.append(self.south_time)
        self.subway_group.append(self.south_min)

        self.main_group.append(self.subway_group)

        # Panel 1: Current weather (y=MATRIX_HEIGHT initially)
        # Layout: 16×16 icon at x=0,y=8 | temp x=20,y=10 | H/L x=18,y=26
        self.weather_group = displayio.Group()
        self.weather_group.y = MATRIX_HEIGHT

        # Weather icon sprite — loaded from /weather_icons.bmp on CIRCUITPY
        # (G/B pre-swapped panel version). Silently blank if file missing.
        self._weather_icon = None
        try:
            _wbmp = displayio.OnDiskBitmap("/weather_icons.bmp")
            self._weather_icon = displayio.TileGrid(
                _wbmp, pixel_shader=_wbmp.pixel_shader,
                tile_width=16, tile_height=16,
                x=0, y=8
            )
            self.weather_group.append(self._weather_icon)
        except Exception:
            pass  # BMP not on device; icon area stays blank

        self.weather_temp = label.Label(font, text="--F",  color=ORANGE,   x=20, y=10)
        self.weather_high = label.Label(font, text="H:--", color=RED,      x=18, y=26)
        self.weather_low  = label.Label(font, text="L:--", color=MTA_BLUE, x=40, y=26)
        self.weather_group.append(self.weather_temp)
        self.weather_group.append(self.weather_high)
        self.weather_group.append(self.weather_low)
        self.main_group.append(self.weather_group)

        # Panel 2: 3-day forecast (y=MATRIX_HEIGHT*2 initially)
        # Layout per row: day x=2 | [x=14-21: future 8×8 icon] | H:xx x=24 | L:xx x=40
        self.forecast_group = displayio.Group()
        self.forecast_group.y = MATRIX_HEIGHT * 2

        self._forecast_rows = []
        for y in [9, 18, 27]:
            name = label.Label(font, text="",    color=WHITE,    x=2,  y=y)
            high = label.Label(font, text="H:--", color=RED,     x=24, y=y)
            low  = label.Label(font, text="L:--", color=MTA_BLUE, x=40, y=y)
            self.forecast_group.append(name)
            self.forecast_group.append(high)
            self.forecast_group.append(low)
            self._forecast_rows.append((name, high, low))
        self.main_group.append(self.forecast_group)

        # Panel 3: Last.FM — left 32px: artist/album/track; right 32px: album art
        self.lastfm_group = displayio.Group()
        self.lastfm_group.y = MATRIX_HEIGHT * 3

        # Two sub-groups for correct z-order: bg (art) rendered before fg (text)
        self.lastfm_bg = displayio.Group()   # album art — behind text
        self.lastfm_fg = displayio.Group()   # text labels — in front

        self.lastfm_artist = label.Label(font, text="", color=ORANGE, x=2, y=7)
        self.lastfm_album  = label.Label(font, text="", color=GRAY,   x=2, y=16)
        self.lastfm_track  = label.Label(font, text="", color=WHITE,  x=2, y=25)
        self.lastfm_fg.append(self.lastfm_artist)
        self.lastfm_fg.append(self.lastfm_album)
        self.lastfm_fg.append(self.lastfm_track)

        self.lastfm_group.append(self.lastfm_bg)   # art layer first
        self.lastfm_group.append(self.lastfm_fg)   # text layer on top

        # Album art state — managed by load_art()
        self._art_tile = None
        self._art_url  = ''    # URL of the currently-displayed art

        self.main_group.append(self.lastfm_group)

        # Panel 4: SEPTA bus arrivals (y=MATRIX_HEIGHT*4 initially)
        # Layout: SEPTA logo left 22px (blue bg + pixel S) | text starts x=23
        # Text rows: route header y=6 | next arrival y=16 | second arrival y=26
        self.septa_group = displayio.Group()
        self.septa_group.y = MATRIX_HEIGHT * 4

        _logo = self._build_septa_logo()
        if _logo:
            self.septa_group.append(_logo)

        self.septa_header    = label.Label(font, text="Rt --", color=ORANGE, x=23, y=6)
        self.septa_next_lbl  = label.Label(font, text="N:",    color=WHITE,  x=23, y=16)
        self.septa_time1     = label.Label(font, text="--",    color=GRAY,   x=33, y=16)
        self.septa_then_lbl  = label.Label(font, text="T:",    color=WHITE,  x=23, y=26)
        self.septa_time2     = label.Label(font, text="--",    color=GRAY,   x=33, y=26)
        self.septa_group.append(self.septa_header)
        self.septa_group.append(self.septa_next_lbl)
        self.septa_group.append(self.septa_time1)
        self.septa_group.append(self.septa_then_lbl)
        self.septa_group.append(self.septa_time2)
        self.main_group.append(self.septa_group)

        # Scroll state
        self._lfm_texts   = ['', '', '']
        self._lfm_hold    = 0   # ticks remaining before scroll starts
        self._lfm_offsets = [0, 0, 0]  # char-window offset per label
        self._lfm_tick    = 0          # sub-tick counter for advance rate
        self._lfm_window  = 7          # visible chars: 7 (art on) or 14 (art off)

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
        # Lightning bolt icon — 5×7 px, yellow, G/B swapped for panel hardware
        _bolt_pixels = (
            0,0,1,1,0,
            0,1,1,1,0,
            1,1,1,1,0,
            0,1,1,1,1,
            0,0,1,1,1,
            0,0,1,1,0,
            0,0,1,0,0,
        )
        _bm  = displayio.Bitmap(5, 7, 2)
        _pal = displayio.Palette(2)
        _pal[0] = 0x000000
        _pal.make_transparent(0)
        _pal[1] = 0xFF00AA  # yellow — G/B swapped (displays as warm yellow on panel)
        for i, v in enumerate(_bolt_pixels):
            _bm[i % 5, i // 5] = v
        self.splash_group.append(displayio.TileGrid(_bm, pixel_shader=_pal, x=3, y=13))
        self.splash_line1 = label.Label(font, text="Starting...", color=WHITE,  x=20, y=12)
        self.splash_line2 = label.Label(font, text="",            color=ORANGE, x=20, y=21)
        self.splash_group.append(self.splash_line1)
        self.splash_group.append(self.splash_line2)

    def _build_septa_logo(self):
        """Build the 22×16 SEPTA logo TileGrid in RAM from hardcoded RGB565 data.
        No BMP file needed on CIRCUITPY — logo is embedded directly in firmware.
        Centered vertically: y=8 places 16px logo in the middle of the 32px panel.
        """
        try:
            bm = displayio.Bitmap(22, 16, 65536)
            for i, val in enumerate(SEPTA_LOGO):
                bm[i % 22, i // 22] = val
            converter = displayio.ColorConverter(
                input_colorspace=displayio.Colorspace.RGB565)
            return displayio.TileGrid(bm, pixel_shader=converter, x=0, y=8)
        except Exception as e:
            print(f"SEPTA logo: {e}")
            return None

    # ── Splash ────────────────────────────────────────────────────────────────

    def show_splash(self, line1="", line2=""):
        self.splash_line1.text = line1[:10]
        self.splash_line2.text = line2[:10]
        matrixportal.display.root_group = self.splash_group

    def hide_splash(self):
        matrixportal.display.root_group = self.main_group

    # ── Helpers ───────────────────────────────────────────────────────────────

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
        self.station_name.text = data.get('station', '')[:13]
        north = data.get('north') or {}
        south = data.get('south') or {}
        n_route = north.get('route', '')
        s_route = south.get('route', '')
        self.north_route.text = n_route
        self.north_dest.text  = north.get('dest', '')[:8]
        self.south_route.text = s_route
        self.south_dest.text  = south.get('dest', '')[:8]
        DIM = 0x444444  # shown when no train data
        if self.north_circle:
            self.north_circle.fill = LINE_COLORS.get(n_route, DIM)
        if self.south_circle:
            self.south_circle.fill = LINE_COLORS.get(s_route, DIM)
        self.update_train_time(self.north_time, self.north_min, north.get('minutes'))
        self.update_train_time(self.south_time, self.south_min, south.get('minutes'))

    def update_weather(self, data):
        """Update current weather panel from /api/weather?mode=current response."""
        if not data:
            return
        self.weather_temp.text = f"{data.get('temp', '--')}F"
        self.weather_high.text = f"H:{data.get('high', '--')}"
        self.weather_low.text  = f"L:{data.get('low', '--')}"
        if self._weather_icon is not None:
            self._weather_icon[0] = _icon_index(data.get('icon', ''))

    def update_forecast(self, data):
        """Update 3-day forecast panel from /api/weather?mode=3-day response."""
        forecast = (data or {}).get('forecast', [])
        if not forecast:
            return
        for (name_lbl, high_lbl, low_lbl), entry in zip(self._forecast_rows, forecast[:3]):
            name_lbl.text = entry.get('date', '')[:3]
            high_lbl.text = f"H:{entry.get('high', '--')}"
            low_lbl.text  = f"L:{entry.get('low', '--')}"

    def update_lastfm(self, data, show_art=True):
        """Update Last.FM panel (artist / album / track) and reset marquee scroll.

        show_art controls whether the right 32px art zone is active:
          True  → 7-char window (28px), leaves room for art at x=32
          False → 14-char window (56px), text spans full display width

        Returns the art_url for the current track (empty string if show_art=False).
        """
        if not data:
            return ''
        if data.get('mode') == 'nowplaying':
            artist  = data.get('artist',  '')
            album   = data.get('album',   '')
            track   = data.get('track',   '')
            art_url = data.get('art_url', '')
        else:  # recent
            tracks  = data.get('tracks', [])
            t0      = tracks[0] if tracks else {}
            artist  = t0.get('artist',  '')
            album   = t0.get('album',   '')
            track   = t0.get('track',   '')
            art_url = t0.get('art_url', '')

        self._lfm_window        = 7 if show_art else 14
        self._lfm_texts         = [artist, album, track]
        self._lfm_offsets       = [0, 0, 0]
        self._lfm_tick          = 0
        self.lastfm_artist.text = artist[:self._lfm_window]
        self.lastfm_album.text  = album[:self._lfm_window]
        self.lastfm_track.text  = track[:self._lfm_window]
        self.lastfm_artist.x    = 2
        self.lastfm_album.x     = 2
        self.lastfm_track.x     = 2
        self._lfm_hold          = 10   # 10 ticks × 0.1s = 1 second pause
        return art_url if show_art else ''

    def update_septa(self, data):
        """Update SEPTA bus panel from /api/septa response.

        Shows route in the header and next two arrival times.
        Minutes == 0 displays 'Now' in yellow; no data shows '--' in gray.
        """
        if not data:
            return
        route    = data.get('route', '--')
        arrivals = data.get('arrivals', [])
        self.septa_header.text = f"Rt {route}"[:13]

        time_labels = [self.septa_time1, self.septa_time2]
        for i, lbl in enumerate(time_labels):
            if i < len(arrivals):
                mins = arrivals[i].get('minutes')
                if mins is None:
                    lbl.text  = '--'
                    lbl.color = GRAY
                elif mins == 0:
                    lbl.text  = 'Now'
                    lbl.color = YELLOW
                else:
                    lbl.text  = f"{mins}m"
                    lbl.color = ORANGE
            else:
                lbl.text  = '--'
                lbl.color = GRAY

    def load_art(self, art_url, raw_bytes):
        """Build a 32×32 TileGrid in memory from raw RGB565 bytes and show at x=32.

        raw_bytes: 2048-byte buffer of RGB565 big-endian pixels (top-down, row-major)
                   returned by /api/lastfm/art. Pass None to clear without displaying.

        Skips rebuild if art_url matches what is already displayed.
        Removes the existing TileGrid before adding the new one.
        """
        if art_url == self._art_url:
            return   # already showing this art (same track)

        # Remove old TileGrid from the bg layer
        if self._art_tile is not None:
            try:
                self.lastfm_bg.remove(self._art_tile)
            except Exception:
                pass
            self._art_tile = None

        self._art_url = art_url

        if not raw_bytes or not art_url:
            return   # no art — leave right side blank

        # Build a full-color Bitmap directly in RAM from RGB565 bytes.
        # value_count=65536 → 16-bit indices (2 bytes/pixel), no filesystem needed.
        try:
            bm = displayio.Bitmap(32, 32, 65536)
            for i in range(32 * 32):
                bm[i % 32, i // 32] = (raw_bytes[i * 2] << 8) | raw_bytes[i * 2 + 1]
            converter = displayio.ColorConverter(
                input_colorspace=displayio.Colorspace.RGB565)
            tile = displayio.TileGrid(bm, pixel_shader=converter, x=32, y=0)
            self.lastfm_bg.append(tile)
            self._art_tile = tile
            print("Art: displayed in memory")
        except Exception as e:
            print(f"Art: load failed — {e}")

    def update_page(self, page, data):
        """Dispatch to the right update method and scroll to the right panel.

        Returns art_url (str) when the page is lastfm and has album art to fetch,
        otherwise returns ''.
        """
        if not data or data.get('error'):
            self.show_error(True)
            return ''
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
            show_art = page.get('show_art', True)
            art_url  = self.update_lastfm(data, show_art)
            if not show_art:
                self.load_art('', None)   # clear any previously displayed art
            self.scroll_to_view('lastfm')
            return art_url
        elif ptype == 'septa':
            self.update_septa(data)
            self.scroll_to_view('septa')
        return ''

    # ── Scroll animation ──────────────────────────────────────────────────────

    def scroll_to_view(self, view_name):
        """Animate vertical scroll to the named panel."""
        if self.current_view == view_name:
            return
        target_idx = VIEW_INDEX.get(view_name, 0)
        groups = [self.subway_group, self.weather_group, self.forecast_group, self.lastfm_group, self.septa_group]
        # Target y for each group: (group_index - target_index) * panel height
        final = [(i - target_idx) * MATRIX_HEIGHT for i in range(len(groups))]

        frames = 8
        for frame in range(frames + 1):
            t = frame / frames
            for j in range(len(groups)):
                grp = groups[j]
                grp.y = int(grp.y + (final[j] - grp.y) * t)
            time.sleep(0.08)

        # Snap to exact positions
        for j in range(len(groups)):
            groups[j].y = final[j]
        self.current_view = view_name

    def tick_lastfm_scroll(self):
        """Advance character-window marquee for Last.FM labels (left 32px zone).

        Shows up to 7 characters at a time (7×4px = 28px ≤ 30px zone).
        Window advances 1 char every 4 ticks (0.4s); labels stay at x=2 always.
        """
        if self._lfm_hold > 0:
            self._lfm_hold -= 1
            return

        self._lfm_tick += 1
        advance = (self._lfm_tick % 4) == 0

        labels = [self.lastfm_artist, self.lastfm_album, self.lastfm_track]
        wraps  = 0
        for i, (lbl, text) in enumerate(zip(labels, self._lfm_texts)):
            lbl.x = 2
            if not text or len(text) <= self._lfm_window:
                lbl.text = text
                continue
            lbl.text = text[self._lfm_offsets[i]:self._lfm_offsets[i] + self._lfm_window]
            if advance:
                self._lfm_offsets[i] += 1
                if self._lfm_offsets[i] > len(text) - self._lfm_window:
                    self._lfm_offsets[i] = 0
                    wraps += 1
        if wraps:
            self._lfm_hold = 10   # 1s pause before restarting after wrap


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
                # Persist STA MAC so AP mode can use it for the Admin UI deep link
                try:
                    with open('/mac.txt', 'w') as _f:
                        _f.write(self.mac)
                except Exception:
                    pass

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

            elif ptype == 'septa':
                route   = page.get('route', '')
                stop_id = page.get('stop_id', '')
                url     = f"{SERVER_URL}/api/septa?route={route}&stop_id={stop_id}&results=2"

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

    def fetch_art(self, art_url):
        """Fetch 32×32 RGB565 pixels from /api/lastfm/art?url=<art_url>.

        Returns 2048 bytes (raw RGB565 big-endian, top-down) on success, else None.
        No filesystem write — caller passes bytes directly to display.load_art().
        """
        if not self.connected or not self.requests:
            return None
        try:
            url = f"{SERVER_URL}/api/lastfm/art?url={art_url}"
            print(f"Art fetch: {url[:60]}...")
            resp = self.requests.get(url, timeout=15)
            if resp.status_code == 200:
                raw = resp.content
                resp.close()
                gc.collect()
                return raw
            print(f"Art: HTTP {resp.status_code}")
            resp.close()
        except Exception as e:
            print(f"Art fetch error: {e}")
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

        # Build carousel from pages array; supported types: mta, weather, lastfm, septa
        raw_pages = config.get('pages', [])
        CAROUSEL  = [p for p in raw_pages if p.get('type') in ('mta', 'weather', 'lastfm', 'septa')]

        if not CAROUSEL:
            # No pages configured yet — show device code and wait for Admin UI setup
            import microcontroller as _mc
            mac_code = network.mac.replace(':', '')[-4:].upper() if network.mac else '????'
            display.show_splash('Setup Mode', 'Code: ' + mac_code)
            print(f'No pages configured. Device code: {mac_code}')
            while True:
                time.sleep(30)
                try:
                    cfg2 = network.register_and_fetch_config()
                    if cfg2:
                        p2 = [p for p in cfg2.get('pages', [])
                              if p.get('type') in ('mta', 'weather', 'lastfm', 'septa')]
                        if p2:
                            display.show_splash('Ready!', 'Reloading...')
                            time.sleep(1)
                            _mc.reset()
                except Exception as _e:
                    print(f'Setup poll: {_e}')
            # Never reaches here — exits via _mc.reset()

        print(f"Firestore config applied — {len(CAROUSEL)} page(s) in carousel")

    display.show_splash("Connected!", "Loading...")
    time.sleep(1)

    # Fetch and display the first page
    first   = CAROUSEL[0]
    data    = network.fetch_page_data(first)
    art_url = display.update_page(first, data)
    if art_url:
        display.load_art(art_url, network.fetch_art(art_url))
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
last_scroll     = time.monotonic()
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
        page    = CAROUSEL[carousel_index]
        print(f"\nCarousel → {carousel_index + 1}/{len(CAROUSEL)}: {page.get('type')}")
        data    = network.fetch_page_data(page)
        art_url = display.update_page(page, data)
        if art_url:
            display.load_art(art_url, network.fetch_art(art_url))
        else:
            display.load_art('', None)   # clear art when not on a lastfm page
        last_view_cycle = current_time
        gc.collect()

    # Marquee scroll for Last.FM text — 1px every 0.1s ≈ 10px/sec
    if display.current_view == 'lastfm' and current_time - last_scroll >= 0.1:
        display.tick_lastfm_scroll()
        last_scroll = current_time

    time.sleep(0.05)
