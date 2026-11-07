# syntax=docker/dockerfile:1
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
    && mkdir -p /out/web \
    && install -m 755 target/x86_64-unknown-linux-musl/release/talos-companion /out/talos-companion \
    && cp -R web/dist/. /out/web/

# Exactly ONE filesystem layer. Only the static binary and compiled frontend enter this image.
FROM scratch
COPY --from=build /out/ /
ENV DATA_DIR=/data WEB_DIR=/web TMPDIR=/data LISTEN_ADDR=0.0.0.0:8080 S3_LISTEN_ADDR=0.0.0.0:9000
USER 99:100
EXPOSE 8080 9000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD ["/talos-companion", "--healthcheck"]
ENTRYPOINT ["/talos-companion"]
