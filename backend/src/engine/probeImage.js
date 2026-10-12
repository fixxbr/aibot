// 64x64 PNG, red background with a blue square: lets the probe prove the model saw the image.
import { deflateSync } from 'node:zlib';

let cached;
export function probeImageDataUrl() {
  if (cached) return cached;
  const size = 64;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const r = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      const inner = x >= 16 && x < 48 && y >= 16 && y < 48;
      r.set(inner ? [30, 60, 220] : [220, 30, 30], 1 + x * 3);
    }
    rows.push(r);
  }
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
  cached = `data:image/png;base64,${png.toString('base64')}`;
  return cached;
}
