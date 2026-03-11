# secrets.py — WiFi credentials for MTA LED Sign
#
# This is the ONLY file you need on the device.
# All other config (station, brightness, weather API key, etc.)
# is stored in Firestore and fetched from the server at boot.
#
# To install:
#   1. Hold BUTTON_UP while resetting the device (enables USB write access).
#   2. Copy this file to your CIRCUITPY drive as "secrets.py".
#   3. Fill in your WiFi credentials below.
#   4. Reset normally — the device will connect and self-configure.
#
# NOTES:
#   - WiFi must be 2.4 GHz (Matrix Portal S3 does not support 5 GHz).
#   - Avoid special characters in the SSID or password if possible.

secrets = {
    "ssid":     "your-network-name",
    "password": "your-wifi-password",
}
