# WebDAV Method-Set Test Report

**Server:** `src/v2/desktop-library-service.js` (`DesktopLibraryService`)
**Protocol:** HTTPS with a limited WebDAV-compatible method set
**Auth:** application-specific signed session negotiation, then Bearer token, over self-signed TLS

This is a repository test report, not an RFC compliance certification. The service
is intended for Nearby Transfer clients that implement its signed `/api/session`
exchange. A generic WebDAV client cannot directly enter a username and password to
obtain a session.

## Implemented Method Coverage

| Feature | RFC | Status | Notes |
|---------|-----|--------|-------|
| OPTIONS | 4918 §10.1 | Tested subset | Returns `Allow` and `MS-Author-Via`; it does not advertise a DAV compliance class |
| GET | 4918 §10.3 | Tested | Streams via `fs.createReadStream`, with `Accept-Ranges`, `ETag`, and `Last-Modified` |
| HEAD | 4918 §10.4 | Tested | Same metadata as GET without the body |
| PROPFIND | 4918 §9.1 | Tested subset | Depth 0/1 and the properties used by the supported client |
| PUT | 4918 §9.7 | Tested subset | Staged non-overwrite publication with a 50 GiB cap; final commit requires same-filesystem hard-link support |
| DELETE | 4918 §9.6 | Tested subset | Recursive deletion when the share and peer permission both allow writes |
| MKCOL | 4918 §9.3 | Tested subset | Recursive directory creation; 405 if the target exists |
| COPY | 4918 §9.8 | Tested subset | Regular files only; `Destination` is validated, overwrite and cross-share destinations are blocked |
| MOVE | 4918 §9.9 | Tested subset | Regular files only; failed source cleanup retains the published destination, overwrite and cross-share destinations are blocked |
| PROPPATCH | 4918 §9.2 | Not implemented | Properties are read-only; returns 405 |
| LOCK/UNLOCK | 4918 §9.10 | Not implemented | No WebDAV locking support |
| Range / 206 | RFC 7233 | Tested subset | Single byte ranges return 206; multi-range requests are not claimed |

Directory `COPY` and `MOVE` currently return `409`. Publishing a directory tree
without briefly exposing partial contents needs a persistent recovery protocol;
until that exists, clients should create directories with `MKCOL`, transfer files
individually, verify them, and then remove the source directory.

File publication fails closed when the destination filesystem cannot create a hard
link. The service does not fall back to copying directly into the final path because
a process interruption could expose a truncated final file. MOVE additionally parks
the source under an operation-owned cleanup directory, verifies that it is the same
filesystem object as the published destination, and never removes the destination
when source cleanup is incomplete.

## TLS Certificate

| Property | Value |
|----------|-------|
| Algorithm | RSA 2048-bit, SHA256withRSA |
| CN | `NearbyTransferLocal` |
| SAN (Subject Alternative Name) | `DNS:localhost`, `DNS:<hostname>`, `IP:127.0.0.1`, `IP:<all non-internal IPv4>` |
| Basic Constraints | `CA:FALSE` (critical) |
| Key Usage | `digitalSignature`, `keyEncipherment` (critical) |
| Extended Key Usage | `TLS WWW Server Authentication` |
| TLS Min Version | `TLSv1.2` |
| Validity | 10 years |
| Storage | `userData/webdav-cert.pem` + `webdav-key.pem`; POSIX uses mode 0600, while Windows relies on the user-profile directory ACL |

## Security

| Control | Implementation |
|---------|----------------|
| Authentication | Bearer token (24-byte hex), 1-hour TTL, re-checked against trusted-peer store on every request |
| Unauthorized | 401 with `WWW-Authenticate: Bearer realm="NearbyTransferLibrary"` |
| Path traversal | Raw `..` in URL blocked (403); `realpath` containment check (`_isPathWithinShare`) at every resolve site |
| Symlink escape | `realpath` on nearest existing ancestor for not-yet-existing targets; per-entry filtering in PROPFIND |
| Upload size limit | 50 GiB (`MAX_UPLOAD_BYTES`); enforced as Content-Length pre-check (413) and mid-stream byte counter (destroys + unlinks) |
| Reserved filenames | Windows-reserved names, invalid characters, trailing dots/spaces, and non-portable Unicode blocked on all write destinations |
| Read-only shares | 403 on PUT/DELETE/MKCOL/COPY/MOVE when `readOnly: true` |

## Interop Test Suite

Two complementary test harnesses exercise the server without real OS clients:

### Node interop test (`test/webdav-interop-smoke.js`)

Starts a live `DesktopLibraryService`, mints a Bearer token, and issues HTTPS
requests using Node's built-in `https` module. Its assertions cover these
representative scenarios:

| # | Test | Assertions |
|---|------|------------|
| 1 | OPTIONS headers | Allow includes the implemented methods; no DAV compliance class is advertised |
| 2 | PROPFIND root (Depth: 1) | 207, XML, displayname, getcontentlength, getlastmodified, getetag, resourcetype, lists children |
| 3 | PROPFIND subdirectory | 207, lists nested files |
| 4 | PROPFIND Depth: 0 | 207, omits children |
| 5 | GET file and single range | 200/206, content matches, Accept-Ranges, Content-Range, ETag |
| 6 | PUT upload | 201, content round-trips |
| 7 | MKCOL | 201, directory exists on disk |
| 8 | MOVE | 201/204, source gone, destination exists |
| 9 | DELETE | 204, file gone from disk |
| 10 | URL encoding (Chinese filename) | PUT/PROPFIND/GET round-trip; PROPFIND root lists encoded href |
| 11 | Unauthorized | 401, WWW-Authenticate Bearer |
| 12 | Path traversal | 403 |

### Curl interop test (`scripts/interop-webdav.sh`)

Starts the same server via `scripts/webdav-test-server.js`, obtains the test
Bearer token created by that harness, then issues `curl` commands (including
`--path-as-is` for traversal). This verifies the HTTP surface; it does not show
that a generic client can perform the signed session exchange.

Run the cross-platform Node coverage with `npm run test:interop`. On Linux,
macOS, or a Windows environment that supplies Bash and curl, run the additional
curl harness with `npm run test:interop:curl`.

## Client Scope

| Client | Status | Notes |
|--------|--------|-------|
| Nearby Transfer supported client | Supported scope | Performs signed session negotiation, certificate checks, Bearer authentication, and permission-aware requests |
| Test harness / curl | Automated HTTP coverage | Uses a Bearer token supplied by the repository test harness |
| Windows Explorer | Not directly compatible or verified | Cannot perform the application-specific signed session exchange |
| macOS Finder | Not directly compatible or verified | Cannot perform the application-specific signed session exchange |
| iOS Files App | Not verified | No supported WebDAV account-login flow is currently provided |
| rclone / Cyberduck / cadaver | Not directly compatible or verified | Generic credential entry does not create a Nearby Transfer session |

## Future Improvements

- A separately designed app-password or other safe login flow for generic
  third-party WebDAV clients.
- Expanded range-request and interrupted-download interoperability coverage.
- **LOCK/UNLOCK** (DAV class 2) for Office-style exclusive editing.
- **PROPPATCH** for setting custom properties.

Until those items are implemented and tested, documentation and UI should call
this a Nearby Transfer shared-library endpoint rather than a universal WebDAV
mount.
