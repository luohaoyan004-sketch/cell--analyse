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

function syntheticHaloImage(width, height, diameter, centers) {
  const data = new Uint8ClampedArray(width * height * 4);
  const radius = diameter / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let value = 125 + x * 0.03 + y * 0.02;
      for (const center of centers) {
        const distance = Math.hypot(x - center.x, y - center.y);
        if (distance <= radius * 0.38) value = 225;
        else if (distance <= radius) value = 45;
      }
      // A bright elongated structure with dark sides should not be counted as a round cell.
      if (x > width * 0.3 && x < width * 0.75 && Math.abs(y - height * 0.75) <= 1) value = 220;
      const index = (y * width + x) * 4;
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
      data[index + 3] = 255;
    }
  }
  return { width, height, data };
}

function syntheticSpreadImage(width, height, cells) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let value = 165 + x * 0.04 + y * 0.02;
      for (const cell of cells) {
        const cos = Math.cos(cell.angle || 0);
        const sin = Math.sin(cell.angle || 0);
        const dx = x - cell.x;
        const dy = y - cell.y;
        const rx = dx * cos + dy * sin;
        const ry = -dx * sin + dy * cos;
        const normalized = (rx / cell.radiusX) ** 2 + (ry / cell.radiusY) ** 2;
        if (normalized <= 1) value = 72;
        else if (normalized <= 1.22) value = 225;
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

test('scale-aware mode detects round halo cells and rejects a ridge', () => {
  const centers = [
    { x: 35, y: 32 },
    { x: 70, y: 44 },
    { x: 83, y: 44 }
  ];
  const image = syntheticHaloImage(130, 90, 12, centers);
  const result = segmentImageData(image, {
    imageType: 'brightfield', detectionMode: 'circular_blob', magnification: 4,
    expectedDiameter: 12, minArea: 50, maxArea: 220
  });
  assert.equal(result.method, 'scale_aware_circular_blob');
  assert.equal(result.cell_count, 3);
  assert.ok(result.cells.every(cell => cell.contour.length === 24));
  for (const center of centers) {
    assert.ok(result.cells.some(cell => Math.hypot(cell.center_x - center.x, cell.center_y - center.y) < 3));
  }
});

test('magnification changes the expected circular-cell scale', () => {
  const image = syntheticHaloImage(180, 130, 30, [{ x: 78, y: 55 }]);
  const result = segmentImageData(image, {
    imageType: 'brightfield', detectionMode: 'circular_blob', magnification: 10,
    minArea: 300, maxArea: 1200
  });
  assert.equal(result.magnification, 10);
  assert.equal(result.expectedDiameterPixels, 30);
  assert.equal(result.cell_count, 1);
});

test('spread-cell mode finds elongated dark bodies and estimates contours', () => {
  const centers = [
    { x: 72, y: 68, radiusX: 25, radiusY: 14, angle: 0.35 },
    { x: 132, y: 78, radiusX: 28, radiusY: 15, angle: -0.25 },
    { x: 188, y: 90, radiusX: 24, radiusY: 13, angle: 0.6 }
  ];
  const image = syntheticSpreadImage(270, 170, centers);
  const result = segmentImageData(image, {
    imageType: 'brightfield', detectionMode: 'spread_cell', magnification: 10,
    expectedSpreadDiameter: 30, minArea: 120, maxArea: 4000
  });
  assert.equal(result.method, 'scale_aware_spread_cell');
  assert.equal(result.cell_count, 3);
  assert.ok(result.cells.every(cell => cell.contour.length === 24 && cell.area_pixels > 250));
  for (const center of centers) {
    assert.ok(result.cells.some(cell => Math.hypot(cell.center_x - center.x, cell.center_y - center.y) < 10));
  }
});
