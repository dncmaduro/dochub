import { TEXT_LIMITS } from './text-limits.js';

export interface TextPatchRequest {
  expectedRevision: string;
  content: string;
}

export class TextEditValidationError extends Error {
  readonly expected = true;
  constructor(message: string) {
    super(message);
    this.name = 'TextEditValidationError';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function parseTextPatchRequest(input: unknown): TextPatchRequest {
  if (!record(input) || typeof input.expectedRevision !== 'string' || !input.expectedRevision || typeof input.content !== 'string') {
    throw new TextEditValidationError('Invalid text save request.');
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    throw new TextEditValidationError('Invalid text save request.');
  }
  if (serialized.length > TEXT_LIMITS.maxSavePayloadBytes) throw new TextEditValidationError('Text save request is too large.');
  if (input.expectedRevision.length > 256) throw new TextEditValidationError('Invalid expected revision.');
  if (input.content.length > TEXT_LIMITS.maxDecodedCharacters || Buffer.byteLength(input.content, 'utf8') > TEXT_LIMITS.maxEditableBytes) {
    throw new TextEditValidationError('Edited text is too large.');
  }
  return { expectedRevision: input.expectedRevision, content: input.content };
}

