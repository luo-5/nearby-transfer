/**
 * @luo-5/localsend-adapter — LocalSend protocol interop adapter for Nearby Transfer.
 *
 * Implements the LocalSend v2 protocol so Nearby Transfer can discover and
 * exchange files with LocalSend apps on the LAN. Provides:
 * - LocalSendDiscovery: UDP multicast announce/listen on 224.0.0.167:53317
 * - LocalSendReceiver: HTTP server (receive files from LocalSend senders)
 * - LocalSendSender: HTTP client (send files to LocalSend receivers)
 */

export * from './types.js';
export * from './discovery.js';
export * from './receiver.js';
export * from './sender.js';
