import zlib from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Encode raw 8-bit grayscale/RGB/RGBA pixels as a PNG without extra native libraries.
 */
export function encodePng(
  width: number,
  height: number,
  channels: 1 | 3 | 4,
  pixels: Uint8Array | Uint8ClampedArray | Buffer
): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw Object.assign(new Error("invalid PNG dimensions"), { code: "PNG_DIMENSIONS_INVALID" });
  }
  const stride = width * channels;
  if (pixels.length < stride * height) {
    throw Object.assign(new Error("PNG pixel buffer is shorter than width*height*channels"), { code: "PNG_PIXELS_SHORT" });
  }
  const colorType = channels === 1 ? 0 : channels === 3 ? 2 : 6;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    raw.set(pixels.subarray(y * stride, y * stride + stride), rowStart + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function pngChunk(type: string, data: Buffer) {
  const typeBytes = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBytes, data])) >>> 0, 0);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}
