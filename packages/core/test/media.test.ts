import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  avatarSrc,
  chatMessageSchema,
  imageExtension,
  imageResponseHeaders,
  sniffImage,
} from '../src/index.js';

/**
 * The images uploaded into the panel: the format and the dimensions are read
 * from the bytes, and nothing else gets through.
 */

function bytes(...parts: Array<number[] | string>): Uint8Array {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === 'string') out.push(...[...part].map((char) => char.charCodeAt(0)));
    else out.push(...part);
  }
  while (out.length < 40) out.push(0);
  return Uint8Array.from(out);
}

const u32be = (value: number) => [
  (value >>> 24) & 255,
  (value >>> 16) & 255,
  (value >>> 8) & 255,
  value & 255,
];
const u16le = (value: number) => [value & 255, (value >>> 8) & 255];
const u24le = (value: number) => [value & 255, (value >>> 8) & 255, (value >>> 16) & 255];
const u16be = (value: number) => [(value >>> 8) & 255, value & 255];

const PNG = bytes(
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  u32be(13),
  'IHDR',
  u32be(640),
  u32be(480),
);

describe('formats reconnus', () => {
  it('PNG', () => {
    assert.deepEqual(sniffImage(PNG), { contentType: 'image/png', width: 640, height: 480 });
  });

  it('GIF', () => {
    assert.deepEqual(sniffImage(bytes('GIF89a', u16le(320), u16le(200))), {
      contentType: 'image/gif',
      width: 320,
      height: 200,
    });
  });

  it('JPEG, skipping the segments that precede the dimensions', () => {
    const app0 = [
      0xff,
      0xe0,
      ...u16be(16),
      ...'JFIF'.split('').map((c) => c.charCodeAt(0)),
      0,
      1,
      1,
      0,
      0,
      1,
      0,
      1,
      0,
      0,
    ];
    const sof0 = [0xff, 0xc0, ...u16be(17), 8, ...u16be(1080), ...u16be(1920), 3];
    assert.deepEqual(sniffImage(bytes([0xff, 0xd8], app0, sof0)), {
      contentType: 'image/jpeg',
      width: 1920,
      height: 1080,
    });
    // DHT (0xC4) is in the SOF range without being one.
    const dht = [0xff, 0xc4, ...u16be(4), 0, 0];
    assert.equal(sniffImage(bytes([0xff, 0xd8], dht, sof0))?.width, 1920);
  });

  it('WebP, sous ses trois formes', () => {
    const riff = (chunk: string, body: number[]) =>
      bytes('RIFF', [0, 0, 0, 0], 'WEBP', chunk, body);
    assert.deepEqual(
      sniffImage(riff('VP8X', [10, 0, 0, 0, 0, 0, 0, 0, ...u24le(1023), ...u24le(767)])),
      {
        contentType: 'image/webp',
        width: 1024,
        height: 768,
      },
    );
    // Lossy VP8: start code 9d 01 2a, dimensions on 14 bits.
    assert.deepEqual(
      sniffImage(
        riff('VP8 ', [0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(800), ...u16le(600)]),
      ),
      { contentType: 'image/webp', width: 800, height: 600 },
    );
    // Lossless VP8L: (width-1, height-1) on 14 bits each, one after the other.
    const packed = (256 - 1) | ((128 - 1) << 14);
    assert.deepEqual(
      sniffImage(
        riff('VP8L', [
          0,
          0,
          0,
          0,
          0x2f,
          packed & 255,
          (packed >>> 8) & 255,
          (packed >>> 16) & 255,
          (packed >>> 24) & 255,
        ]),
      ),
      { contentType: 'image/webp', width: 256, height: 128 },
    );
  });
});

describe('what does not get through', () => {
  it('no SVG, no HTML, no truncated file', () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const html = new TextEncoder().encode(
      '<!doctype html><html><body>bonjour, ceci est une page</body></html>',
    );
    assert.equal(sniffImage(svg), null);
    assert.equal(sniffImage(html), null);
    assert.equal(sniffImage(PNG.subarray(0, 20)), null);
    assert.equal(sniffImage(new Uint8Array(0)), null);
  });

  it('no zero or absurd dimensions — a decompression bomb', () => {
    const png = (width: number, height: number) =>
      bytes(
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        u32be(13),
        'IHDR',
        u32be(width),
        u32be(height),
      );
    assert.equal(sniffImage(png(0, 10)), null);
    assert.equal(sniffImage(png(100_000, 100_000)), null);
    assert.equal(sniffImage(png(12_000, 12_000))?.width, 12_000);
  });

  it('a JPEG whose segments lie', () => {
    assert.equal(sniffImage(bytes([0xff, 0xd8, 0xff, 0xe0, 0, 1])), null);
    assert.equal(sniffImage(bytes([0xff, 0xd8, 0x00, 0x00])), null);
  });
});

describe('photos de profil', () => {
  it('only a URL written by the panel is shown', () => {
    const ours = '/api/users/aB3_x-9/avatar?v=0123456789ab';
    assert.equal(avatarSrc(ours), ours);
    for (const other of [
      'https://tracker.example/pixel.gif',
      '//tracker.example/a.png',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      '/api/users/x/avatar',
      '/api/users/x/avatar?v=0123456789ab&x=1',
      '/api/users/../../admin/avatar?v=0123456789ab',
      null,
      undefined,
      '',
    ]) {
      assert.equal(avatarSrc(other), null, String(other));
    }
  });
});

describe('servir une image', () => {
  it('rendered, never interpreted', () => {
    const headers = imageResponseHeaders({
      contentType: 'image/webp',
      bytes: 42,
      filename: 'a"; b.webp',
      immutable: true,
    });
    assert.equal(headers['x-content-type-options'], 'nosniff');
    assert.match(headers['content-security-policy'] ?? '', /sandbox/);
    assert.match(headers['cache-control'] ?? '', /^private, .*immutable/);
    assert.equal(headers['content-disposition'], 'inline; filename="a___b.webp"');
    assert.equal(imageExtension('image/jpeg'), 'jpg');
    assert.equal(
      imageResponseHeaders({
        contentType: 'image/png',
        bytes: 1,
        filename: 'a.png',
        immutable: false,
      })['cache-control'],
      'private, no-cache',
    );
  });

  it('a message from before images reads back without an attachment', () => {
    const parsed = chatMessageSchema.parse({
      id: '0b6b8f2c-3a55-4d7e-9a0e-2f4d6c8e1a3b',
      channel: 'general',
      authorId: null,
      authorName: null,
      body: 'bonjour',
      mentions: [],
      replyTo: null,
      reactions: [],
      createdAt: new Date().toISOString(),
    });
    assert.deepEqual(parsed.attachments, []);
  });
});
