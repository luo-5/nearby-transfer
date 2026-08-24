# @luo-5/cli

Command-line encrypted file transfer for nearby devices on the LAN.

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

# Pair with a device
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
