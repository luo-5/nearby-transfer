/**
 * LocalSend protocol type definitions.
 */

export const LOCALSEND_MULTICAST_ADDRESS = '224.0.0.167';
export const LOCALSEND_PORT = 53317;
export const LOCALSEND_API_PREFIX = '/api/localsend/v2';
export const LOCALSEND_PROTOCOL_VERSION = '2.0';

export type LocalSendDeviceType = 'mobile' | 'desktop' | 'web' | 'headless' | 'server';
export type LocalSendProtocol = 'http' | 'https';

export interface LocalSendDeviceInfo {
  alias: string;
  version: string;
  deviceModel: string;
  deviceType: LocalSendDeviceType;
  fingerprint: string;
  port: number;
  protocol: LocalSendProtocol;
  download: boolean;
  announce: boolean;
}

export interface LocalSendFileMetadata {
  id: string;
  fileName: string;
  size: number;
  fileType: string;
  sha256?: string;
  preview?: string;
  metadata?: Record<string, unknown>;
}

export interface LocalSendPrepareUploadRequest {
  info: LocalSendDeviceInfo;
  files: Record<string, LocalSendFileMetadata>;
}

export interface LocalSendPrepareUploadResponse {
  sessionId: string;
  files: Record<string, string>;
}

export interface LocalSendPrepareDownloadResponse {
  info: LocalSendDeviceInfo;
  sessionId: string;
  files: Record<string, LocalSendFileMetadata>;
}

/** A LocalSend device discovered on the LAN. */
export interface LocalSendDevice {
  fingerprint: string;
  alias: string;
  host: string;
  port: number;
  protocol: LocalSendProtocol;
  deviceType: LocalSendDeviceType;
  deviceModel: string;
  version: string;
  download: boolean;
}
