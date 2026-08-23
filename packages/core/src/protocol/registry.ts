/**
 * Protocol engine: registry of 7 protocol drivers with hot-switching.
 * Ported from src/protocols/protocol-engine.js.
 *
 * The v2-stream driver is fully implemented; the other 6 (turbo-parallel,
 * quic-udp, smb-share, webdav-sync, v1-classic, ftps-secure) are registered
 * as experimental stubs in the core package. The desktop app can override
 * them with full implementations.
 */

import { PROTOCOLS, CATEGORIES, BaseProtocolDriver, type ProtocolDriverStatus, type ProtocolId } from './types.js';

/** Experimental stub driver for protocols not yet fully ported to core. */
class ExperimentalDriver extends BaseProtocolDriver {
  constructor(id: string, name: string, category: string, defaultPort: number) {
    super(id, name, category, defaultPort);
  }
}

/** v2-stream driver: delegates to the core transfer layer. */
class V2StreamDriver extends BaseProtocolDriver {
  constructor() {
    super(PROTOCOLS.V2_STREAM, 'V2 Stream', CATEGORIES.STANDARD, 0);
  }
}

class TurboParallelDriver extends ExperimentalDriver {
  constructor() { super(PROTOCOLS.TURBO_PARALLEL, 'Turbo Parallel', CATEGORIES.FAST, 0); }
}
class QuicUdpDriver extends ExperimentalDriver {
  constructor() { super(PROTOCOLS.QUIC_UDP, 'QUIC UDP', CATEGORIES.FAST, 0); }
}
class SmbShareDriver extends ExperimentalDriver {
  constructor() { super(PROTOCOLS.SMB_SHARE, 'SMB Share', CATEGORIES.SYSTEM, 445); }
}
class WebDavSyncDriver extends ExperimentalDriver {
  constructor() { super(PROTOCOLS.WEBDAV_SYNC, 'WebDAV Sync', CATEGORIES.SYSTEM, 443); }
}
class V1ClassicDriver extends ExperimentalDriver {
  constructor() { super(PROTOCOLS.V1_CLASSIC, 'V1 Classic', CATEGORIES.STANDARD, 0); }
}
class FtpsSecureDriver extends ExperimentalDriver {
  constructor() { super(PROTOCOLS.FTPS_SECURE, 'FTPS Secure', CATEGORIES.SYSTEM, 990); }
}

export interface ProtocolListEntry extends ProtocolDriverStatus {
  isCurrent: boolean;
}

export interface ProtocolSwitchResult {
  ok: boolean;
  previous: string;
  active: string;
  driverStatus: ProtocolDriverStatus;
}

export class ProtocolEngine {
  private drivers = new Map<string, BaseProtocolDriver>();
  private activeProtocol: string;

  constructor(defaultProtocol: string = PROTOCOLS.V2_STREAM) {
    this.activeProtocol = defaultProtocol;
    this.registerDefaultDrivers();
  }

  private registerDefaultDrivers(): void {
    this.register(new V2StreamDriver());
    this.register(new TurboParallelDriver());
    this.register(new QuicUdpDriver());
    this.register(new SmbShareDriver());
    this.register(new WebDavSyncDriver());
    this.register(new V1ClassicDriver());
    this.register(new FtpsSecureDriver());
  }

  register(driver: BaseProtocolDriver): this {
    if (!driver || !driver.id) throw new Error('Invalid protocol driver');
    this.drivers.set(driver.id, driver);
    return this;
  }

  get(protocolId: string): BaseProtocolDriver | undefined {
    return this.drivers.get(protocolId);
  }

  listProtocols(category: string | null = null): ProtocolListEntry[] {
    const list: ProtocolListEntry[] = [];
    for (const driver of this.drivers.values()) {
      if (!category || driver.category === category) {
        list.push({ ...driver.getStatus(), isCurrent: driver.id === this.activeProtocol });
      }
    }
    return list;
  }

  async setActiveProtocol(protocolId: string): Promise<ProtocolSwitchResult> {
    if (!this.drivers.has(protocolId)) throw new Error(`Unsupported protocol: ${protocolId}`);
    const previous = this.activeProtocol;
    this.activeProtocol = protocolId;
    const driver = this.drivers.get(protocolId)!;
    await driver.init();
    return { ok: true, previous, active: this.activeProtocol, driverStatus: driver.getStatus() };
  }

  getActiveDriver(): BaseProtocolDriver {
    return this.drivers.get(this.activeProtocol) ?? this.drivers.get(PROTOCOLS.V2_STREAM)!;
  }

  get activeProtocolId(): string {
    return this.activeProtocol;
  }

  async sendFile(peer: unknown, filePath: string, options: Record<string, unknown> = {}): Promise<unknown> {
    return this.getActiveDriver().sendFile(peer, filePath, options);
  }

  async receiveFile(session: unknown, targetDir: string, options: Record<string, unknown> = {}): Promise<unknown> {
    return this.getActiveDriver().receiveFile(session, targetDir, options);
  }
}

export { PROTOCOLS, CATEGORIES, BaseProtocolDriver };
export type { ProtocolId };
