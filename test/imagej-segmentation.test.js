const test = require('node:test');
const assert = require('node:assert/strict');
const { segmentImageData } = require('../public/imagej-segmentation.js');

function syntheticImage(width, height, background, circles) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let value = typeof background === 'function' ? background(x, y) : background;
      for (const circle of circles) {
        if ((x - circle.x) ** 2 + (y - circle.y) ** 2 <= circle.radius ** 2) value = circle.value;
      }
      const index = (y * width + x) * 4;
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
      data[index + 3] = 255;
    }
  }
  return { width, height, data };
}

test('detects dark cells over uneven brightfield background', () => {
  const image = syntheticImage(160, 100, x => 190 + x * 0.2, [
    { x: 42, y: 48, radius: 11, value: 55 },
    { x: 116, y: 55, radius: 10, value: 65 }
  ]);
  const result = segmentImageData(image, {
    imageType: 'brightfield', backgroundRadius: 22, minArea: 120, maxArea: 1000, watershed: false
  });
  assert.equal(result.cell_count, 2);
  assert.ok(result.cells.every(cell => cell.contour.length >= 8));
  assert.ok(result.total_cell_area_pixels > 500);
});

test('uses bright polarity for fluorescence images', () => {
  const image = syntheticImage(150, 90, 12, [
    { x: 40, y: 42, radius: 9, value: 225 },
    { x: 105, y: 48, radius: 12, value: 240 }
  ]);
  const result = segmentImageData(image, {
    imageType: 'fluorescence', backgroundRadius: 20, minArea: 100, maxArea: 1000, watershed: false
  });
  assert.equal(result.polarity, 'bright');
  assert.equal(result.cell_count, 2);
});

test('honors ROI mask and particle size filter', () => {
  const width = 120;
  const height = 80;
  const image = syntheticImage(width, height, 210, [
    { x: 28, y: 40, radius: 9, value: 45 },
    { x: 92, y: 40, radius: 9, value: 45 },
    { x: 55, y: 15, radius: 2, value: 20 }
  ]);
  const validMask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width / 2; x++) validMask[y * width + x] = 1;
  }
  const result = segmentImageData(image, {
    imageType: 'brightfield', validMask, backgroundRadius: 18, minArea: 80, maxArea: 1000, watershed: false
  });
  assert.equal(result.cell_count, 1);
  assert.ok(result.cells[0].center_x < width / 2);
});
