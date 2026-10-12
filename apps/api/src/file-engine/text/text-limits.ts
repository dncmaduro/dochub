/** Resource limits for all native text-family engines. */
export const TEXT_LIMITS = {
  maxInputBytes: 16 * 1024 * 1024,
  maxDecodedCharacters: 2_000_000,
  maxLines: 100_000,
  maxEditableBytes: 8 * 1024 * 1024,
  maxSavePayloadBytes: 8 * 1024 * 1024,
  maxStructuredDepth: 100,
  maxStructuredNodes: 50_000,
} as const;

