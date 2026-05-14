/**
 * Unit tests for `src/utils/mime.ts:sniffContentType` — lifted at
 * v0.4-M31 IMPL from byte-identical inline copies in `commands/item/
 * upload.ts` + `commands/update/upload.ts`. The lift catches the
 * 2-consumer trigger + adds full branch coverage on the extension
 * table (which the upload integration tests only hit one row of:
 * `'png'` via `screenshot.png`).
 */
import { describe, expect, it } from 'vitest';
import { sniffContentType } from '../../../src/utils/mime.js';

describe('sniffContentType', () => {
  it.each([
    ['screenshot.png', 'image/png'],
    ['photo.jpg', 'image/jpeg'],
    ['photo.JPEG', 'image/jpeg'],
    ['anim.gif', 'image/gif'],
    ['icon.webp', 'image/webp'],
    ['logo.svg', 'image/svg+xml'],
    ['report.pdf', 'application/pdf'],
    ['data.json', 'application/json'],
    ['notes.txt', 'text/plain'],
    ['app.log', 'text/plain'],
    ['readme.md', 'text/plain'],
    ['rows.csv', 'text/csv'],
    ['index.html', 'text/html'],
    ['archive.zip', 'application/zip'],
    ['backup.gz', 'application/gzip'],
    ['demo.mp4', 'video/mp4'],
    ['clip.mov', 'video/quicktime'],
    ['theme.mp3', 'audio/mpeg'],
  ])('maps %j → %j', (filename, expected) => {
    expect(sniffContentType(filename)).toBe(expected);
  });

  it('falls back to application/octet-stream for unknown extensions', () => {
    expect(sniffContentType('mystery.xyz')).toBe('application/octet-stream');
  });

  it('falls back to application/octet-stream for files with no extension', () => {
    expect(sniffContentType('Makefile')).toBe('application/octet-stream');
  });

  it('falls back to application/octet-stream for empty string', () => {
    expect(sniffContentType('')).toBe('application/octet-stream');
  });

  it('handles a trailing dot (empty extension) as octet-stream', () => {
    expect(sniffContentType('weird.')).toBe('application/octet-stream');
  });

  it('uses the LAST dot for extension extraction (multi-dot filenames)', () => {
    expect(sniffContentType('archive.tar.gz')).toBe('application/gzip');
    expect(sniffContentType('photo.backup.png')).toBe('image/png');
  });

  it('lower-cases the extension before matching', () => {
    expect(sniffContentType('SCREENSHOT.PNG')).toBe('image/png');
    expect(sniffContentType('Report.PDF')).toBe('application/pdf');
  });
});
