import { BadRequestException } from '@nestjs/common';

export interface NormalizedNodeName {
  name: string;
  normalizedName: string;
}

/** Validates a logical display name; it is never a filesystem path. */
export function normalizeNodeName(value: string): NormalizedNodeName {
  const name = value.trim().normalize('NFC');
  let containsControlCharacter = false;
  for (let index = 0; index < name.length; index += 1) {
    const codePoint = name.charCodeAt(index);
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      containsControlCharacter = true;
      break;
    }
  }
  if (
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    Array.from(name).length > 255 ||
    name.includes('/') ||
    name.includes('\\') ||
    containsControlCharacter
  ) {
    throw new BadRequestException('Invalid node name');
  }
  return { name, normalizedName: name.toLowerCase() };
}
