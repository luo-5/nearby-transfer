'use strict';

const { BaseProtocolDriver, PROTOCOLS, CATEGORIES } = require('../protocol-types');
const fs = require('fs');

class TurboParallelDriver extends BaseProtocolDriver {
  constructor(concurrency = 4) {
    super(PROTOCOLS.TURBO_PARALLEL, 'Turbo Parallel Multi-Stream', CATEGORIES.FAST, 55910);
    this.concurrency = concurrency;
    this.capabilities = {
      parallelStreams: concurrency,
      highThroughput: true,
      gigabitOptimized: true,
      adaptiveChunking: true
    };
  }

  calculateSlices(fileSize, numStreams = this.concurrency) {
    if (fileSize <= 0) return [];
    const actualStreams = Math.min(numStreams, Math.max(1, Math.floor(fileSize / (1024 * 1024))));
    const sliceSize = Math.ceil(fileSize / actualStreams);
    const slices = [];
    for (let i = 0; i < actualStreams; i++) {
      const start = i * sliceSize;
      const end = Math.min(fileSize, start + sliceSize);
      slices.push({ index: i, start, end, size: end - start, status: 'pending' });
    }
    return slices;
  }

  async sendFile(peer, filePath, options = {}) {
    const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : { size: options.fileSize || 0 };
    const slices = this.calculateSlices(stat.size, options.streams || this.concurrency);
    return {
      ok: true,
      protocol: this.id,
      streams: slices.length,
      slices,
      targetPeer: peer.id || peer.ip,
      speedMultiplier: Math.min(4.0, slices.length * 0.85)
    };
  }

  async receiveFile(session, targetDir, options = {}) {
    return {
      ok: true,
      protocol: this.id,
      concurrency: this.concurrency,
      reassemblyBuffer: 'in-memory-sliding',
      targetDir
    };
  }
}

module.exports = { TurboParallelDriver };
