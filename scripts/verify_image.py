"""Inspect the actual image layer, excluding runtime mounts injected by Docker."""
import json
import sys
import tarfile

with tarfile.open(sys.argv[1]) as image:
    manifest = json.load(image.extractfile("manifest.json"))
    assert len(manifest) == 1
    layers = manifest[0]["Layers"]
    assert len(layers) == 1, f"Expected one layer, found {len(layers)}"
    with tarfile.open(fileobj=image.extractfile(layers[0])) as layer:
        files = []
        for member in layer:
            if member.isdir():
                continue
            assert member.isfile(), f"Unexpected special file: {member.name}"
            name = member.name.removeprefix("./")
            assert name in {"talos-companion", "usr/local/bin/cloudflared", "usr/local/bin/tailscale", "usr/local/bin/tailscaled", "etc/ssl/certs/ca-certificates.crt", "etc/passwd", "etc/group"} or name.startswith("web/"), name
            files.append(name)
        assert "talos-companion" in files
        assert "web/index.html" in files
        assert {"usr/local/bin/cloudflared", "usr/local/bin/tailscale", "usr/local/bin/tailscaled", "etc/ssl/certs/ca-certificates.crt"}.issubset(files)
        print("Verified one layer: Companion, frontend, pinned provider clients and public CA bundle")
