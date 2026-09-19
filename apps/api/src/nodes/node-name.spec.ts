import { BadRequestException } from '@nestjs/common';
import { normalizeNodeName } from './node-name.js';

describe('normalizeNodeName', () => {
  it('trims and NFC-normalizes the display name while preserving internal whitespace and case', () => {
    expect(normalizeNodeName('  Re\u0301port  Q1.PDF  ')).toEqual({
      name: 'Réport  Q1.PDF',
      normalizedName: 'réport  q1.pdf',
    });
  });

  it.each([
    '',
    '   ',
    '.',
    '..',
    'folder/name',
    'folder\\name',
    'bad\u0000name',
    'bad\nname',
  ])('rejects an invalid logical name', (value) => {
    expect(() => normalizeNodeName(value)).toThrow(BadRequestException);
  });

  it('rejects names longer than 255 characters', () => {
    expect(() => normalizeNodeName('a'.repeat(256))).toThrow(
      BadRequestException,
    );
  });
});
