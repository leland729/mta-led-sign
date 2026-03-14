"""
setup_mode.py — WiFi AP hotspot + credential capture web server.

Called from code.py when all WiFi connection attempts fail.
Starts an open access point named "SubwaySign-Setup", serves a minimal
HTML form at 192.168.4.1, writes new credentials to secrets.py, reboots.

Never returns — always ends with microcontroller.reset().
"""

AP_SSID     = "SubwaySign-Setup"
AP_IP       = "192.168.4.1"
SERVER_PORT = 80

# ---------------------------------------------------------------------------
# HTML responses
# ---------------------------------------------------------------------------

_HTML_FORM = """\
HTTP/1.1 200 OK\r
Content-Type: text/html\r
Connection: close\r
\r
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Subway Sign Setup</title>
  <style>
    body { font-family: sans-serif; max-width: 400px; margin: 40px auto; padding: 0 16px; }
    h2   { color: #333; }
    label { display: block; margin-top: 16px; font-weight: bold; }
    input[type=text], input[type=password] {
      width: 100%; padding: 10px; margin-top: 6px; font-size: 16px;
      border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box;
    }
    input[type=submit] {
      margin-top: 24px; width: 100%; padding: 12px;
      background: #0066cc; color: white; font-size: 16px;
      border: none; border-radius: 4px; cursor: pointer;
    }
  </style>
</head>
<body>
  <h2>&#x1F687; Subway Sign Setup</h2>
  <p>Enter your WiFi credentials to connect this device to your network.</p>
  <form method="POST" action="/">
    <label>Network Name (SSID)
      <input type="text" name="ssid" autocomplete="off" autocorrect="off"
             autocapitalize="none" spellcheck="false" required>
    </label>
    <label>Password
      <input type="password" name="password" autocomplete="off">
    </label>
    <input type="submit" value="Save &amp; Connect">
  </form>
</body>
</html>"""

_HTML_SUCCESS = """\
HTTP/1.1 200 OK\r
Content-Type: text/html\r
Connection: close\r
\r
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Saved</title>
  <style>
    body { font-family: sans-serif; max-width: 400px; margin: 40px auto; padding: 0 16px; }
    .btn {
      display: inline-block; margin-top: 24px; padding: 12px 20px;
      background: #0066cc; color: white; font-size: 16px;
      border-radius: 4px; text-decoration: none;
    }
  </style>
</head>
<body>
  <h2>&#x2705; Credentials Saved</h2>
  <p>Your Subway Sign is restarting and will connect to your network in a moment.</p>
  <p>Once it's online, visit the Admin UI to name your device and configure its display.</p>
  <a class="btn" href="https://subway-api-829904256043.us-east1.run.app">Open Admin UI &rarr;</a>
</body>
</html>"""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _url_decode(s):
    """Decode a URL-encoded string (application/x-www-form-urlencoded)."""
    out = []
    i = 0
    while i < len(s):
        c = s[i]
        if c == '+':
            out.append(' ')
            i += 1
        elif c == '%' and i + 2 < len(s):
            try:
                out.append(chr(int(s[i + 1:i + 3], 16)))
                i += 3
            except ValueError:
                out.append(c)
                i += 1
        else:
            out.append(c)
            i += 1
    return ''.join(out)


def _parse_form(body):
    """Parse URL-encoded form body into a dict."""
    params = {}
    for pair in body.split('&'):
        if '=' in pair:
            k, v = pair.split('=', 1)
            params[_url_decode(k)] = _url_decode(v)
    return params


def _send_all(conn, data):
    """Send all bytes, looping until complete (conn.send may send partial)."""
    if isinstance(data, str):
        data = data.encode('utf-8')
    total_sent = 0
    while total_sent < len(data):
        try:
            sent = conn.send(data[total_sent:])
            if sent == 0:
                break
            total_sent += sent
        except OSError:
            break
    return total_sent


def _recv_request(conn):
    """
    Read a full HTTP request from conn. Returns decoded string or ''.
    CircuitPython's socketpool.Socket uses recv_into(buf) — not recv().
    Sleeps 0.5 s first so the browser has time to fill the TCP buffer.
    """
    import time as _time
    _time.sleep(0.5)
    _buf = bytearray(4096)
    data = b''
    deadline = _time.monotonic() + 8.0
    while _time.monotonic() < deadline:
        try:
            nbytes = conn.recv_into(_buf)
        except Exception:
            _time.sleep(0.05)
            continue

        if nbytes:
            data += bytes(_buf[:nbytes])
            if b'\r\n\r\n' not in data:
                continue
            # For POST: wait until we have the full body
            if data.startswith(b'POST'):
                header_end = data.index(b'\r\n\r\n') + 4
                body = data[header_end:]
                content_length = 0
                for line in data[:header_end].split(b'\r\n'):
                    if line.lower().startswith(b'content-length:'):
                        try:
                            content_length = int(line.split(b':', 1)[1].strip())
                        except ValueError:
                            pass
                if len(body) >= content_length:
                    break
            else:
                break  # GET — headers are enough
        else:
            _time.sleep(0.05)  # no data yet, keep waiting

    return data.decode('utf-8', 'replace')



def _write_secrets(ssid, password):
    """
    Update ssid and password in /secrets.py, preserving all other keys.
    Creates a minimal secrets.py if the file doesn't exist or is empty.
    """
    try:
        with open('/secrets.py', 'r') as f:
            lines = f.readlines()
        if not lines:
            raise OSError('empty')
        new_lines = []
        for line in lines:
            if '"ssid"' in line and ':' in line:
                new_lines.append('    "ssid": "{}",\n'.format(ssid))
            elif '"password"' in line and ':' in line:
                new_lines.append('    "password": "{}",\n'.format(password))
            else:
                new_lines.append(line)
    except OSError:
        # secrets.py missing or empty — write a minimal template (WiFi only;
        # all other config is fetched from Firestore via the server).
        new_lines = [
            'secrets = {\n',
            '    "ssid": "{}",\n'.format(ssid),
            '    "password": "{}",\n'.format(password),
            '}\n',
        ]

    with open('/secrets.py', 'w') as f:
        f.write(''.join(new_lines))
    print('secrets.py written')


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def run(display=None):
    """
    Start AP mode. Serves a WiFi credential form and writes secrets.py on
    submission. Calls microcontroller.reset() when done — never returns.
    """
    import wifi
    import socketpool
    import time
    import microcontroller

    print('=' * 40)
    print('Entering AP setup mode')
    print('SSID:', AP_SSID)
    print('Navigate to http://' + AP_IP)
    print('=' * 40)

    # Update display if available
    if display is not None:
        try:
            display.show_splash('AP Mode', AP_SSID)
            display.show_error(False)
        except Exception:
            pass

    # Start access point — disconnect station first if needed
    try:
        wifi.radio.disconnect()
    except Exception:
        pass  # Not connected, or method not available — fine either way

    wifi.radio.start_ap(AP_SSID)
    print('AP started:', AP_SSID)

    # Start TCP server
    pool = socketpool.SocketPool(wifi.radio)
    server = pool.socket(pool.AF_INET, pool.SOCK_STREAM)
    server.bind(('', SERVER_PORT))
    server.listen(1)
    server.setblocking(False)
    print('Listening on port', SERVER_PORT)

    while True:
        # Accept incoming connections (non-blocking)
        try:
            conn, addr = server.accept()
        except OSError:
            time.sleep(0.05)
            continue

        print('Connection from', addr)
        time.sleep(0.2)  # give browser time to send request before first recv

        try:
            conn.setblocking(True)
            request = _recv_request(conn)
            print('Request:', request[:80].replace('\r\n', ' '))

            if not request:
                # recv timed out or failed — serve the form anyway so the
                # browser doesn't get stuck in a redirect loop
                print('Empty request — serving form as fallback')
                _send_all(conn, _HTML_FORM)

            elif request.startswith('POST'):
                if '\r\n\r\n' in request:
                    body = request.split('\r\n\r\n', 1)[1]
                    params = _parse_form(body)
                    ssid     = params.get('ssid', '').strip()
                    password = params.get('password', '')
                    if ssid:
                        if display is not None:
                            try: display.show_splash('Saving', '...')
                            except Exception: pass
                        _send_all(conn, _HTML_SUCCESS)
                        conn.close()
                        try:
                            _write_secrets(ssid, password)
                        except Exception as we:
                            print('Write error:', we)
                            if display is not None:
                                try: display.show_splash('AP Error', 'Write err')
                                except Exception: pass
                        print('Rebooting...')
                        time.sleep(2)
                        microcontroller.reset()
                    else:
                        if display is not None:
                            try: display.show_splash('AP Mode', 'No SSID')
                            except Exception: pass
                        _send_all(conn, _HTML_FORM)
                else:
                    if display is not None:
                        try: display.show_splash('AP Mode', 'Bad req')
                        except Exception: pass
                    _send_all(conn, _HTML_FORM)

            else:
                # GET or anything else — serve the form
                _send_all(conn, _HTML_FORM)

        except Exception as e:
            print('Handler error:', e)
        finally:
            try:
                conn.close()
            except Exception:
                pass
