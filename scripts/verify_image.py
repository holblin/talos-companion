"""Verify both runtime layers and the exact connector selection in a docker save archive."""
import json
import sys
import tarfile

providers = {
    "both": {"usr/local/bin/cloudflared", "usr/local/bin/tailscaled"},
    "cloudflare": {"usr/local/bin/cloudflared"},
    "tailscale": {"usr/local/bin/tailscaled"},
    "minimal": set(),
}
variant = sys.argv[2] if len(sys.argv) > 2 else "both"
runtime_files = providers[variant] | {"etc/ssl/certs/ca-certificates.crt", "etc/passwd", "etc/group"}

with tarfile.open(sys.argv[1]) as image:
    manifest = json.load(image.extractfile("manifest.json"))
    assert len(manifest) == 1
    config = json.load(image.extractfile(manifest[0]["Config"]))
    assert config["os"] == "linux" and config["architecture"] == "amd64"
    assert config["config"]["User"] == "99:100"
    assert config["config"]["Entrypoint"] == ["/talos-companion"]
    layers = manifest[0]["Layers"]
    assert len(layers) == 2, f"Expected two layers, found {len(layers)}"
    for index, path in enumerate(layers):
        with tarfile.open(fileobj=image.extractfile(path)) as layer:
            files = set()
            for member in layer:
                if member.isdir():
                    continue
                assert member.isfile(), f"Unexpected special file: {member.name}"
                name = member.name.removeprefix("./")
                assert (name in runtime_files if index == 0 else name == "talos-companion" or name.startswith("web/")), name
                files.add(name)
            if index == 0:
                assert files == runtime_files, files
            else:
                assert {"talos-companion", "web/index.html"}.issubset(files)
    print(f"Verified {variant}: connector/certificate layer + application/frontend layer; no Tailscale CLI")
