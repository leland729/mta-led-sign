"""
boot.py — runs before code.py on every power-up/reset.

Storage remount strategy:
  - Normal boot (BUTTON_UP not held): remount filesystem so device code can
    write files. This is required for setup_mode.py to save secrets.py.
    USB drag-and-drop writes are disabled in this mode.
  - BUTTON_UP held on power-up: skip remount, USB host keeps write access.
    Use this during development to copy files via USB.
"""
import board
import digitalio
import storage

btn = digitalio.DigitalInOut(board.BUTTON_UP)
btn.direction = digitalio.Direction.INPUT
btn.pull = digitalio.Pull.UP

if btn.value:  # not pressed (active low) — normal boot
    storage.remount("/", readonly=False)
# else: button held → USB keeps write access

btn.deinit()
