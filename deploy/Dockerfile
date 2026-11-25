FROM rust:1-bookworm AS cli
RUN apt-get update && apt-get install -y --no-install-recommends libdbus-1-dev pkg-config && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git libdbus-1-3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY control-plane/package*.json ./
RUN npm ci
COPY control-plane/tsconfig.json ./
COPY control-plane/src ./src
COPY --from=cli /build/target/release/bettergit /usr/local/bin/bettergit
USER node
CMD ["./node_modules/.bin/tsx", "src/server.ts"]
