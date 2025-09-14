# WiFi and API Configuration for MTA LED Sign
# Save this as secrets.py on your CIRCUITPY drive

secrets = {
    # WiFi Configuration
    "ssid": "your-network-here,
    "password": "your-password-here",
        # Server configuration
    "server_url": "your server url here",  #ex:http://192.168.1.10:3000
    
    # Display settings - change as needed
    "station_id": "G26",  # Greenpoint Av
    "route": "G",
    "brightness": 0.4,    # 0.0 to 1.0
    
    # Update intervals (seconds)
    "fetch_interval": 15,
    "display_refresh": 1,
    
    # Time zone
    "timezone": "America/New_York"
}

# IMPORTANT NOTES:
# 1. WiFi must be 2.4GHz (Matrix Portal doesn't support 5GHz)
# 2. Don't use special characters in SSID or password if possible
# 3. Make sure there are no extra spaces in the strings
# 4. The API URL should NOT have a trailing slash
# 5. Check that your router doesn't have MAC filtering enabled
