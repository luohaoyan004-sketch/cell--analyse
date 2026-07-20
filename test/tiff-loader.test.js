const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { decodeTiffArrayBuffer } = require('../public/tiff-loader.js');

function loadBrowserUtif() {
  const sandbox = { console };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const vendorDir = path.join(__dirname, '..', 'public', 'vendor');
  vm.runInContext(fs.readFileSync(path.join(vendorDir, 'pako_inflate.min.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(vendorDir, 'UTIF.js'), 'utf8'), sandbox);
  return sandbox.UTIF;
}

function createRgbTiff(width, height) {
  const tagCount = 10;
  const ifdOffset = 8;
  const ifdSize = 2 + tagCount * 12 + 4;
  const bitsOffset = ifdOffset + ifdSize;
  const dataOffset = bitsOffset + 6;
  const rgbSize = width * height * 3;
  const buffer = Buffer.alloc(dataOffset + rgbSize);
  buffer.write('II', 0);
  buffer.writeUInt16LE(42, 2);
  buffer.writeUInt32LE(ifdOffset, 4);
  buffer.writeUInt16LE(tagCount, ifdOffset);
  let position = ifdOffset + 2;
  const tag = (id, type, count, value) => {
    buffer.writeUInt16LE(id, position);
    buffer.writeUInt16LE(type, position + 2);
    buffer.writeUInt32LE(count, position + 4);
    buffer.writeUInt32LE(value, position + 8);
    position += 12;
  };
  tag(256, 4, 1, width);
  tag(257, 4, 1, height);
  tag(258, 3, 3, bitsOffset);
  tag(259, 3, 1, 1);
  tag(262, 3, 1, 2);
  tag(273, 4, 1, dataOffset);
  tag(277, 3, 1, 3);
  tag(278, 4, 1, height);
  tag(279, 4, 1, rgbSize);
  tag(284, 3, 1, 1);
  buffer.writeUInt32LE(0, position);
  buffer.writeUInt16LE(8, bitsOffset);
  buffer.writeUInt16LE(8, bitsOffset + 2);
  buffer.writeUInt16LE(8, bitsOffset + 4);
  let pixelOffset = dataOffset;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const insideCell = (x - width / 2) ** 2 + (y - height / 2) ** 2 < 25;
      const value = insideCell ? 50 : 220;
      buffer[pixelOffset++] = value;
      buffer[pixelOffset++] = value;
      buffer[pixelOffset++] = value;
    }
  }
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

test('decodes an uncompressed TIFF entirely in JavaScript', () => {
  const decoded = decodeTiffArrayBuffer(createRgbTiff(32, 20), loadBrowserUtif());
  assert.equal(decoded.width, 32);
  assert.equal(decoded.height, 20);
  assert.equal(decoded.pageCount, 1);
  assert.equal(decoded.rgba.length, 32 * 20 * 4);
  assert.equal(decoded.source, 'tiff-browser-utif');
  assert.equal(decoded.normalized, true);
});

test('rejects non-TIFF data with a useful error', () => {
  const invalid = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
  assert.throws(() => decodeTiffArrayBuffer(invalid, loadBrowserUtif()), /不是有效的 TIFF/);
});
