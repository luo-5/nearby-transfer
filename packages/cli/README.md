# @luo-5/cli

Command-line encrypted file transfer for nearby devices on the LAN.

> **Developer preview:** the package contains working discovery and transfer
> components, but the `pair` command does not yet complete and persist a mutual
> pairing. `send` and `sync` fail closed unless a matching trusted signing key is
> already provisioned. Do not treat the CLI as a production pairing workflow.
> Follow the repository [capability matrix](https://github.com/luo-5/nearby-transfer/blob/main/docs/capabilities.md)
> for the current boundary.

## Install

```bash
npm install -g @luo-5/cli
```

## Usage

```bash
# List devices on the LAN
nearby-transfer devices

# Receive files
nearby-transfer receive --dir ~/Downloads

# Inspect or remove already provisioned trust records
nearby-transfer trust list
nearby-transfer trust remove a1b2c3d4e5f60718
```

`pair`, `send`, and `sync` are developer-preview commands. `pair` currently
inspects a candidate but does not persist mutual trust; consequently there is
no supported first-use CLI path for `send` or `sync` yet. Those commands fail
closed unless a compatible client has already provisioned the matching trust
record.

## Docker

```bash
docker run --rm --network host \
  -v nearby-transfer-config:/config \
  ghcr.io/luo-5/nearby-transfer-cli:<version> \
  devices --data-dir /config
```

Host networking is required for multicast discovery and is supported by Docker
Engine on Linux. Docker Desktop networking differs by platform. Sending also
requires a separately provisioned trust record, as described above; pin a
released image version instead of using `latest`.

## License

MIT
