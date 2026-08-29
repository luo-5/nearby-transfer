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

# Send a file
nearby-transfer send ./report.pdf --to 192.168.1.50

# Receive files
nearby-transfer receive --dir ~/Downloads

# Inspect a pairing candidate (does not persist mutual trust yet)
nearby-transfer pair --to a1b2c3d4e5f60718

# Manage trusted devices
nearby-transfer trust list
nearby-transfer trust remove a1b2c3d4e5f60718
```

## Docker

```bash
docker run --rm -v /host/dir:/data @luo-5/cli send /data/file.txt --to 192.168.1.50
```

## License

MIT
