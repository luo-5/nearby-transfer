'use strict';

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'docs', 'migration_audit_log.json');
const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

// Add CHANGE-021
if (!data.changes.find(c => c.id === 'CHANGE-021')) {
  data.changes.push({
    id: 'CHANGE-021',
    timestamp: new Date().toISOString(),
    type: 'UX_AND_EDGE_CASE_FIX',
    description: 'Fixed essential UX and corner-case flaws across Desktop and Android: 1) Implemented receiver-side transfer cancellation in TransferServer.js with active incoming request destruction on user abort; 2) Added [🗑 清除已完成] button in Desktop renderer to batch clean completed/failed/cancelled history records; 3) Implemented Android system hardware/gesture onBackPressed navigation: automatically navigating up NAS directory hierarchy if inside a subfolder, switching back to Transfer tab if on another page, and requiring double-press within 2 seconds to exit the app; 4) Added AtomicBoolean cancellation and pause signals to WebDAV downloads and uploads in WebDavClient.java and MainActivity.java so user can pause and cancel NAS transfers in real-time.',
    rationale: 'Addresses foundational usability and edge-case gaps, ensuring responsive user control and standard mobile navigation behavior.'
  });
}

fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
console.log('[+] migration_audit_log.json updated with CHANGE-021.');
