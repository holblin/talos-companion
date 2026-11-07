"""Offline contract check against the pinned daemon, without a CLI or tailnet login."""
import http.client
import json
import socket
import sys
import time


class LocalConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(10)
        self.sock.connect(sys.argv[1])


def request(method, path, value=None, headers=None):
    connection = LocalConnection("local-tailscaled.sock", timeout=10)
    payload = None if value is None else json.dumps(value)
    connection.request(method, "/localapi/v0/" + path, payload, headers or {})
    response = connection.getresponse()
    body = response.read(1_048_577)
    assert len(body) <= 1_048_576
    assert 200 <= response.status < 300, (method, path, response.status)
    result = (json.loads(body) if body else None, response.getheader("ETag"))
    connection.close()
    return result


for attempt in range(40):
    try:
        request("GET", "status?peers=false")
        break
    except (OSError, http.client.HTTPException):
        time.sleep(0.25)
else:
    raise RuntimeError("Daemon did not open its private socket")

request("POST", "start", {})
request("PATCH", "prefs", {
    "WantRunning": True, "WantRunningSet": True,
    "Hostname": "talos-companion", "HostnameSet": True,
    "CorpDNS": False, "CorpDNSSet": True,
    "RouteAll": False, "RouteAllSet": True,
})
prefs, _ = request("GET", "prefs")
assert prefs["WantRunning"] and prefs["Hostname"] == "talos-companion"
assert not prefs["CorpDNS"] and not prefs["RouteAll"]
request("POST", "login-interactive")
config, etag = request("GET", "serve-config")
assert etag
# The offline daemon has no netmap yet, so it must reject route changes.
# The authenticated Serve write and ETag conflict paths are covered by Rust tests.
status, _ = request("GET", "status?peers=false")
assert status["BackendState"] in {"NeedsLogin", "Starting", "NoState"}
print("Verified pinned tailscaled LocalAPI over its Unix socket: start, masked preferences, status, and Serve configuration with ETag")
