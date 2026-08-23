/**
 * Chunk-level encryption helpers — a focused re-export of the chunk encrypt/
 * decrypt operations from session.ts, plus the chunk AAD builder, for consumers
 * that only need per-chunk crypto without the session-key derivation.
 *
 * Test vectors for these operations live in test/vectors/chunk-vectors.json.
 */

export { encryptChunk, decryptChunk, buildChunkAad, MAX_CHUNK_BYTES, AUTH_TAG_BYTES, NONCE_BYTES } from './session.js';
export type { ChunkEncryptInput, ChunkDecryptInput, EncryptedChunk, ChunkMetadata } from './session.js';
