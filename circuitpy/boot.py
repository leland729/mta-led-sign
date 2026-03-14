"""
boot.py — runs before code.py on every power-up/reset.

Storage remount strategy:
  - Normal boot (BUTTON_UP not held): remount filesystem so device code can
    write files. This is required for setup_mode.py to save secrets.py.
    USB drag-and-drop writes are disabled in this mode.
  - BUTTON_UP held on power-up: skip remount, USB host keeps write access.
    Use this during development to copy files via USB.
"""
import storage

try:
    import board
    import digitalio
    btn = digitalio.DigitalInOut(board.BUTTON_UP)
    btn.direction = digitalio.Direction.INPUT
    btn.pull = digitalio.Pull.UP
    button_held = not btn.value  # active low — True if held
    btn.deinit()
except Exception:
    button_held = False  # if button check fails, default to device write access

if not button_held:
    storage.remount("/", readonly=False)
