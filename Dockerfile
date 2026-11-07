# syntax=docker/dockerfile:1
FROM tailscale/tailscale@sha256:ed6480b33c6eb67c9cbd203ed42b9fb57e361986725b6856def71b7a3d9e276c AS tailscale
FROM cloudflare/cloudflared@sha256:4955524aeaa379e154023d5a027c250f7b35041a2e7e950cf13f144bc9b9c5ba AS cloudflare
FROM debian:trixie-slim AS build
ARG MISE_VERSION=2026.10.25
ARG MISE_SHA256=3c4d4abd8950e722543aa2ffe58dd9ee84430fc03c8a94d318f64b279229d8ff
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl xz-utils build-essential musl-tools pkg-config git \
    && rm -rf /var/lib/apt/lists/*
RUN curl --fail --location --retry 3 \
    "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-x64.tar.xz" \
    --output /tmp/mise.tar.xz \
    && echo "${MISE_SHA256}  /tmp/mise.tar.xz" | sha256sum --check - \
    && tar -xJf /tmp/mise.tar.xz -C /tmp \
    && install /tmp/mise/bin/mise /usr/local/bin/mise
ENV MISE_YES=1
WORKDIR /src
COPY mise.toml mise.lock ./
RUN mise trust && mise install && mise exec -- rustup target add x86_64-unknown-linux-musl
COPY web/package.json web/package-lock.json ./web/
COPY web/scripts ./web/scripts
RUN mise exec -- npm ci --prefix web
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY web ./web
RUN mise run web:build \
    && mise exec -- cargo build --release --locked --target x86_64-unknown-linux-musl \
    && mkdir -p /out/web /out/data /out/etc \
    && chown 99:100 /out/data && chmod 700 /out/data \
    && printf 'companion:x:99:100:Companion:/data:/sbin/nologin\n' > /out/etc/passwd \
    && printf 'users:x:100:\n' > /out/etc/group \
    && install -m 755 target/x86_64-unknown-linux-musl/release/talos-companion /out/talos-companion \
    && cp -R web/dist/. /out/web/

# Bundle official clients into the same flattened runtime. No extra container,
# permissions, published ports, or state mount are required for browser setup.
COPY --from=cloudflare /usr/local/bin/cloudflared /out/usr/local/bin/cloudflared
COPY --from=cloudflare /etc/ssl/certs/ca-certificates.crt /out/etc/ssl/certs/ca-certificates.crt
COPY --from=tailscale /usr/local/bin/tailscale /out/usr/local/bin/tailscale
COPY --from=tailscale /usr/local/bin/tailscaled /out/usr/local/bin/tailscaled

FROM scratch
COPY --from=build /out/ /
ENV DATA_DIR=/data WEB_DIR=/web TMPDIR=/data LISTEN_ADDR=0.0.0.0:8080 S3_LISTEN_ADDR=0.0.0.0:9000 NO_AUTOUPDATE=true
USER 99:100
EXPOSE 8080 9000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD ["/talos-companion", "--healthcheck"]
ENTRYPOINT ["/talos-companion"]
