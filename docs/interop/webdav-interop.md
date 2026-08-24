# WebDAV Interoperability Report

**Server:** `src/v2/desktop-library-service.js` (`DesktopLibraryService`)
**Protocol:** HTTPS WebDAV, RFC 4918 class 1
**Auth:** Bearer token (trusted-peer session) + self-signed TLS

## Compliance Summary

| Feature | RFC | Status | Notes |
|---------|-----|--------|-------|
| OPTIONS | 4918 §10.1 | ✅ | Returns `Allow`, `DAV: 1`, `MS-Author-Via: DAV` |
| GET | 4918 §10.3 | ✅ | Streams via `fs.createReadStream`, `Accept-Ranges`, `ETag`, `Last-Modified` |
| HEAD | 4918 §10.4 | ✅ | Same as GET without body |
| PROPFIND | 4918 §9.1 | ✅ | Depth: 0/1 support; returns `displayname`, `getcontentlength`, `getlastmodified`, `getetag`, `resourcetype` |
| PUT | 4918 §9.7 | ✅ | Content-Length and chunked; exclusive-create (`flags:'wx'`, 412 on overwrite); 50 GiB cap (413) |
| DELETE | 4918 §9.6 | ✅ | Recursive; 204 on success |
| MKCOL | 4918 §9.3 | ✅ | Recursive mkdir; 405 if exists |
| COPY | 4918 §9.8 | ✅ | `Destination` + `Overwrite` headers; symlink-escape check on destination |
| MOVE | 4918 §9.9 | ✅ | `Destination` + `Overwrite` headers; cross-share blocked |
| PROPPATCH | 4918 §9.2 | ❌ | Not implemented (props are read-only; returns 405) |
| LOCK/UNLOCK | 4918 §9.10 | ❌ | Not implemented (DAV class 1, not class 2) |
| Range / 206 | 7233 | ❌ | `Accept-Ranges: bytes` advertised but no partial-content implementation |

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
| Storage | `userData/webdav-cert.pem` + `webdav-key.pem` (mode 0600) |

## Security

| Control | Implementation |
|---------|----------------|
| Authentication | Bearer token (24-byte hex), 1-hour TTL, re-checked against trusted-peer store on every request |
| Unauthorized | 401 with `WWW-Authenticate: Bearer realm="NearbyTransferLibrary"` |
| Path traversal | Raw `..` in URL blocked (403); `realpath` containment check (`_isPathWithinShare`) at every resolve site |
| Symlink escape | `realpath` on nearest existing ancestor for not-yet-existing targets; per-entry filtering in PROPFIND |
| Upload size limit | 50 GiB (`MAX_UPLOAD_BYTES`); enforced as Content-Length pre-check (413) and mid-stream byte counter (destroys + unlinks) |
| Reserved filenames | CON/PRN/AUX/NUL/COM1-9/LPT1-9 and Windows-invalid chars blocked on PUT/MKCOL |
| Read-only shares | 403 on PUT/DELETE/MKCOL/COPY/MOVE when `readOnly: true` |

## Interop Test Suite

Two complementary test harnesses exercise the server without real OS clients:

### Node interop test (`test/webdav-interop-smoke.js`)

Starts a live `DesktopLibraryService`, mints a Bearer token, and issues HTTPS
requests using Node's built-in `https` module. **36 assertions** across 12
scenarios:

| # | Test | Assertions |
|---|------|------------|
| 1 | OPTIONS headers | Allow includes MKCOL/DELETE/COPY/MOVE; DAV is class 1 only |
| 2 | PROPFIND root (Depth: 1) | 207, XML, displayname, getcontentlength, getlastmodified, getetag, resourcetype, lists children |
| 3 | PROPFIND subdirectory | 207, lists nested files |
| 4 | PROPFIND Depth: 0 | 207, omits children |
| 5 | GET file | 200, content matches, Accept-Ranges, ETag |
| 6 | PUT upload | 201, content round-trips |
| 7 | MKCOL | 201, directory exists on disk |
| 8 | MOVE | 201/204, source gone, destination exists |
| 9 | DELETE | 204, file gone from disk |
| 10 | URL encoding (Chinese filename) | PUT/PROPFIND/GET round-trip; PROPFIND root lists encoded href |
| 11 | Unauthorized | 401, WWW-Authenticate Bearer |
| 12 | Path traversal | 403 |

### Curl interop test (`scripts/interop-webdav.sh`)

Starts the same server via `scripts/webdav-test-server.js`, then issues real
`curl` commands (including `--path-as-is` for traversal). **26 assertions**
covering the same 12 scenarios.

Run both: `npm run test:interop`

## Known Client Quirks (manual testing notes)

| Client | Status | Notes |
|--------|--------|-------|
| Windows Explorer | ✅ (tested in M3.1 design) | Requires self-signed cert import; `MS-Author-Via: DAV` header helps Office/WebDAV redirector |
| macOS Finder | ✅ (tested in M3.1 design) | `Go > Connect to Server` with `https://host:port/share` |
| iOS Files App | ✅ (via SMB Docker sidecar) | Use SMB sidecar, not WebDAV, for iOS |
| curl | ✅ | Fully tested by `scripts/interop-webdav.sh` |
| rclone webdav | ✅ (expected) | Standard WebDAV client; class-1 compliant |
| cyberduck | ✅ (expected) | Bearer auth requires custom header — may need Basic auth addition for generic clients |

## Future Improvements

- **Basic auth** (RFC 7617) for generic third-party WebDAV clients that don't
  support Bearer tokens (cyberduck, cadaver, rclone).
- **Range/206 partial content** for resumable downloads.
- **LOCK/UNLOCK** (DAV class 2) for Office-style exclusive editing.
- **PROPPATCH** for setting custom properties.
