/*
 * ImageJ-inspired, dependency-free cell segmentation for the browser.
 *
 * Pipeline: local background subtraction -> light smoothing -> Otsu threshold
 * -> binary opening/closing -> connected particles -> watershed-like splitting.
 * This is deliberately deterministic and runs locally; no image is uploaded.
 */
(function exposeImageJSegmentation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ImageJSegmentation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createImageJSegmentation() {
  'use strict';

  function segmentImageData(imageData, rawOptions = {}) {
    if (!imageData || !Number.isInteger(imageData.width) || !Number.isInteger(imageData.height) || !imageData.data) {
      throw new Error('无效的图像像素数据');
    }
    const width = imageData.width;
    const height = imageData.height;
    const size = width * height;
    if (imageData.data.length < size * 4) throw new Error('图像像素数据不完整');

    const options = normalizeOptions(rawOptions, width, height);
    const validMask = normalizeMask(rawOptions.validMask, imageData.data, size);
    const validCount = countOnes(validMask);
    if (!validCount) return emptyResult(options, '有效 ROI 为空');

    const gray = rgbaToGray(imageData.data, validMask);
    fillOutsideMask(gray, validMask, histogramMedian(gray, validMask));
    const smoothed = options.smoothRadius > 0
      ? boxBlur(gray, width, height, options.smoothRadius)
      : gray;
    const background = boxBlur(smoothed, width, height, options.backgroundRadius);
    const signal = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      if (!validMask[i]) continue;
      const delta = options.polarity === 'bright'
        ? smoothed[i] - background[i]
        : background[i] - smoothed[i];
      signal[i] = Math.max(0, delta);
    }

    const autoThreshold = otsuThreshold(signal, validMask);
    const threshold = clamp(autoThreshold + options.thresholdOffset, 0, 255);
    let binary = thresholdSignal(signal, validMask, threshold);
    if (options.morphology) {
      binary = dilate(erode(binary, validMask, width, height), validMask, width, height);
      binary = erode(dilate(binary, validMask, width, height), validMask, width, height);
    }

    const allParticles = connectedParticles(binary, width, height)
      .filter(particle => particle.area >= options.minArea);
    const expectedArea = inferExpectedArea(allParticles, options);
    const splitParticles = [];
    let splitCount = 0;
    for (const particle of allParticles) {
      const pieces = options.watershed
        ? splitTouchingParticle(particle, width, height, expectedArea, options.minArea)
        : [particle];
      if (pieces.length > 1) splitCount += pieces.length - 1;
      splitParticles.push(...pieces);
    }

    const accepted = splitParticles
      .filter(particle => particle.area >= options.minArea && particle.area <= options.maxArea)
      .sort((a, b) => a.minY - b.minY || a.minX - b.minX);
    const cells = accepted.map((particle, index) => particleToCell(particle, width, index + 1));
    const totalAreaPixels = cells.reduce((sum, cell) => sum + cell.area_pixels, 0);
    const warnings = [
      `ImageJ 风格本地分割：背景半径 ${options.backgroundRadius}px，Otsu 阈值 ${round(threshold, 1)}`,
      `颗粒筛选：${options.minArea}–${options.maxArea} px²${options.watershed ? `；分水岭拆分 ${splitCount} 个接触区域` : ''}`
    ];
    const rejectedLarge = splitParticles.filter(particle => particle.area > options.maxArea).length;
    if (rejectedLarge) warnings.push(`${rejectedLarge} 个区域超过最大面积，已忽略；可调高“最大面积”复核`);
    if (threshold <= 1) warnings.push('自动阈值很低，图像对比度可能不足；建议调整阈值偏移或背景半径');
    const coverage = validCount > 0 ? totalAreaPixels / validCount * 100 : 0;
    if (coverage > 85) warnings.push('识别覆盖率超过 85%，可能把背景识别为细胞；建议提高阈值偏移');

    return {
      method: 'imagej_local',
      threshold,
      autoThreshold,
      polarity: options.polarity,
      validAreaPixels: validCount,
      expectedAreaPixels: expectedArea,
      cells,
      cell_count: cells.length,
      total_cell_area_pixels: totalAreaPixels,
      mean_cell_area_pixels: cells.length ? totalAreaPixels / cells.length : 0,
      coverage_percent: coverage,
      warnings
    };
  }

  function normalizeOptions(raw, width, height) {
    const minArea = Math.max(1, Math.round(finite(raw.minArea, 80)));
    const maxArea = Math.max(minArea, Math.round(finite(raw.maxArea, Math.max(50000, width * height))));
    const imageType = String(raw.imageType || 'brightfield');
    const requestedPolarity = String(raw.polarity || 'auto');
    const polarity = requestedPolarity === 'bright' || requestedPolarity === 'dark'
      ? requestedPolarity
      : (imageType === 'fluorescence' ? 'bright' : 'dark');
    return {
      minArea,
      maxArea,
      polarity,
      backgroundRadius: clamp(Math.round(finite(raw.backgroundRadius, 24)), 2, 128),
      smoothRadius: clamp(Math.round(finite(raw.smoothRadius, 1)), 0, 4),
      thresholdOffset: clamp(finite(raw.thresholdOffset, 0), -100, 100),
      expectedArea: Math.max(0, finite(raw.expectedArea, 0)),
      morphology: raw.morphology !== false,
      watershed: raw.watershed !== false
    };
  }

  function normalizeMask(rawMask, rgba, size) {
    const mask = new Uint8Array(size);
    if (rawMask && rawMask.length === size) {
      for (let i = 0; i < size; i++) mask[i] = rawMask[i] ? 1 : 0;
      return mask;
    }
    for (let i = 0; i < size; i++) mask[i] = rgba[i * 4 + 3] > 0 ? 1 : 0;
    return mask;
  }

  function rgbaToGray(rgba, mask) {
    const gray = new Float32Array(mask.length);
    for (let i = 0; i < mask.length; i++) {
      const p = i * 4;
      gray[i] = rgba[p] * 0.2126 + rgba[p + 1] * 0.7152 + rgba[p + 2] * 0.0722;
    }
    return gray;
  }

  function histogramMedian(values, mask) {
    const hist = new Uint32Array(256);
    let count = 0;
    for (let i = 0; i < values.length; i++) {
      if (!mask[i]) continue;
      hist[clamp(Math.round(values[i]), 0, 255)]++;
      count++;
    }
    let running = 0;
    const midpoint = count / 2;
    for (let i = 0; i < hist.length; i++) {
      running += hist[i];
      if (running >= midpoint) return i;
    }
    return 0;
  }

  function fillOutsideMask(values, mask, fillValue) {
    for (let i = 0; i < values.length; i++) if (!mask[i]) values[i] = fillValue;
  }

  function boxBlur(input, width, height, radius) {
    const integralWidth = width + 1;
    const integral = new Float64Array(integralWidth * (height + 1));
    for (let y = 0; y < height; y++) {
      let rowSum = 0;
      const srcRow = y * width;
      const integralRow = (y + 1) * integralWidth;
      const previousRow = y * integralWidth;
      for (let x = 0; x < width; x++) {
        rowSum += input[srcRow + x];
        integral[integralRow + x + 1] = integral[previousRow + x + 1] + rowSum;
      }
    }
    const out = new Float32Array(input.length);
    for (let y = 0; y < height; y++) {
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(height - 1, y + radius);
      for (let x = 0; x < width; x++) {
        const x0 = Math.max(0, x - radius);
        const x1 = Math.min(width - 1, x + radius);
        const sum = integral[(y1 + 1) * integralWidth + x1 + 1]
          - integral[y0 * integralWidth + x1 + 1]
          - integral[(y1 + 1) * integralWidth + x0]
          + integral[y0 * integralWidth + x0];
        out[y * width + x] = sum / ((x1 - x0 + 1) * (y1 - y0 + 1));
      }
    }
    return out;
  }

  function otsuThreshold(signal, mask) {
    const hist = new Uint32Array(256);
    let count = 0;
    let sum = 0;
    for (let i = 0; i < signal.length; i++) {
      if (!mask[i]) continue;
      const value = clamp(Math.round(signal[i]), 0, 255);
      hist[value]++;
      count++;
      sum += value;
    }
    if (!count) return 0;
    let backgroundWeight = 0;
    let backgroundSum = 0;
    let bestVariance = -1;
    let bestThreshold = 0;
    for (let threshold = 0; threshold < 256; threshold++) {
      backgroundWeight += hist[threshold];
      if (!backgroundWeight) continue;
      const foregroundWeight = count - backgroundWeight;
      if (!foregroundWeight) break;
      backgroundSum += threshold * hist[threshold];
      const backgroundMean = backgroundSum / backgroundWeight;
      const foregroundMean = (sum - backgroundSum) / foregroundWeight;
      const variance = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2;
      if (variance > bestVariance) {
        bestVariance = variance;
        bestThreshold = threshold;
      }
    }
    return bestThreshold;
  }

  function thresholdSignal(signal, mask, threshold) {
    const out = new Uint8Array(signal.length);
    for (let i = 0; i < signal.length; i++) out[i] = mask[i] && signal[i] > threshold ? 1 : 0;
    return out;
  }

  function erode(input, validMask, width, height) {
    const out = new Uint8Array(input.length);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const index = y * width + x;
        if (!validMask[index] || !input[index]) continue;
        let keep = 1;
        for (let dy = -1; dy <= 1 && keep; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const neighbor = index + dy * width + dx;
            if (!validMask[neighbor] || !input[neighbor]) { keep = 0; break; }
          }
        }
        out[index] = keep;
      }
    }
    return out;
  }

  function dilate(input, validMask, width, height) {
    const out = new Uint8Array(input.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x;
        if (!validMask[index]) continue;
        let hit = 0;
        for (let dy = -1; dy <= 1 && !hit; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx >= 0 && nx < width && input[ny * width + nx]) { hit = 1; break; }
          }
        }
        out[index] = hit;
      }
    }
    return out;
  }

  function connectedParticles(binary, width, height) {
    const visited = new Uint8Array(binary.length);
    const queue = new Int32Array(binary.length);
    const particles = [];
    const neighbors = [-width - 1, -width, -width + 1, -1, 1, width - 1, width, width + 1];
    for (let start = 0; start < binary.length; start++) {
      if (!binary[start] || visited[start]) continue;
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      visited[start] = 1;
      const pixels = [];
      let minX = width, minY = height, maxX = 0, maxY = 0;
      while (head < tail) {
        const index = queue[head++];
        pixels.push(index);
        const x = index % width;
        const y = Math.floor(index / width);
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        for (const delta of neighbors) {
          const next = index + delta;
          if (next < 0 || next >= binary.length || visited[next] || !binary[next]) continue;
          const nx = next % width;
          const ny = Math.floor(next / width);
          if (Math.abs(nx - x) > 1 || Math.abs(ny - y) > 1) continue;
          visited[next] = 1;
          queue[tail++] = next;
        }
      }
      particles.push({ pixels, area: pixels.length, minX, minY, maxX, maxY });
    }
    return particles;
  }

  function inferExpectedArea(particles, options) {
    if (options.expectedArea > 0) return options.expectedArea;
    const areas = particles
      .filter(particle => particle.area <= options.maxArea)
      .map(particle => particle.area)
      .sort((a, b) => a - b);
    if (areas.length < 3) return 0;
    const trimmed = areas.slice(0, Math.max(3, Math.ceil(areas.length * 0.75)));
    return median(trimmed);
  }

  function splitTouchingParticle(particle, width, height, expectedArea, minArea) {
    if (!expectedArea || particle.area < expectedArea * 1.8) return [particle];
    const maxSeeds = Math.min(8, Math.max(1, Math.round(particle.area / expectedArea)));
    if (maxSeeds < 2) return [particle];
    const boxWidth = particle.maxX - particle.minX + 1;
    const boxHeight = particle.maxY - particle.minY + 1;
    const localSize = boxWidth * boxHeight;
    const inside = new Uint8Array(localSize);
    for (const index of particle.pixels) {
      const x = index % width;
      const y = Math.floor(index / width);
      inside[(y - particle.minY) * boxWidth + x - particle.minX] = 1;
    }
    const distance = chamferDistance(inside, boxWidth, boxHeight);
    let maxDistance = 0;
    for (let i = 0; i < distance.length; i++) maxDistance = Math.max(maxDistance, distance[i]);
    if (maxDistance < 2) return [particle];

    const candidates = [];
    for (let y = 1; y < boxHeight - 1; y++) {
      for (let x = 1; x < boxWidth - 1; x++) {
        const index = y * boxWidth + x;
        const value = distance[index];
        if (!inside[index] || value < Math.max(1.5, maxDistance * 0.5)) continue;
        let localMaximum = true;
        for (let dy = -1; dy <= 1 && localMaximum; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (distance[index + dy * boxWidth + dx] > value + 1e-6) { localMaximum = false; break; }
          }
        }
        if (localMaximum) candidates.push({ x, y, value });
      }
    }
    candidates.sort((a, b) => b.value - a.value);
    const seeds = [];
    for (const candidate of candidates) {
      const separated = seeds.every(seed => Math.hypot(candidate.x - seed.x, candidate.y - seed.y) >= Math.max(5, Math.min(candidate.value, seed.value) * 1.8));
      if (separated) seeds.push(candidate);
      if (seeds.length >= maxSeeds) break;
    }
    if (seeds.length < 2) return [particle];

    const groups = seeds.map(() => []);
    for (const globalIndex of particle.pixels) {
      const gx = globalIndex % width;
      const gy = Math.floor(globalIndex / width);
      const x = gx - particle.minX;
      const y = gy - particle.minY;
      let bestSeed = 0;
      let bestScore = Infinity;
      for (let i = 0; i < seeds.length; i++) {
        const dx = x - seeds[i].x;
        const dy = y - seeds[i].y;
        const score = (dx * dx + dy * dy) / Math.max(1, seeds[i].value * seeds[i].value);
        if (score < bestScore) { bestScore = score; bestSeed = i; }
      }
      groups[bestSeed].push(globalIndex);
    }
    if (groups.some(group => group.length < minArea)) return [particle];
    return groups.map(group => particleFromPixels(group, width));
  }

  function chamferDistance(inside, width, height) {
    const infinity = width + height + 10;
    const distance = new Float32Array(inside.length);
    for (let i = 0; i < inside.length; i++) distance[i] = inside[i] ? infinity : 0;
    const diagonal = Math.SQRT2;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (!inside[i]) continue;
        let value = distance[i];
        if (x > 0) value = Math.min(value, distance[i - 1] + 1);
        if (y > 0) value = Math.min(value, distance[i - width] + 1);
        if (x > 0 && y > 0) value = Math.min(value, distance[i - width - 1] + diagonal);
        if (x + 1 < width && y > 0) value = Math.min(value, distance[i - width + 1] + diagonal);
        distance[i] = value;
      }
    }
    for (let y = height - 1; y >= 0; y--) {
      for (let x = width - 1; x >= 0; x--) {
        const i = y * width + x;
        if (!inside[i]) continue;
        let value = distance[i];
        if (x + 1 < width) value = Math.min(value, distance[i + 1] + 1);
        if (y + 1 < height) value = Math.min(value, distance[i + width] + 1);
        if (x + 1 < width && y + 1 < height) value = Math.min(value, distance[i + width + 1] + diagonal);
        if (x > 0 && y + 1 < height) value = Math.min(value, distance[i + width - 1] + diagonal);
        distance[i] = value;
      }
    }
    return distance;
  }

  function particleFromPixels(pixels, width) {
    let minX = width, minY = Infinity, maxX = 0, maxY = 0;
    for (const index of pixels) {
      const x = index % width;
      const y = Math.floor(index / width);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    return { pixels, area: pixels.length, minX, minY, maxX, maxY };
  }

  function particleToCell(particle, width, cellId) {
    let sumX = 0;
    let sumY = 0;
    const membership = new Set(particle.pixels);
    const boundary = [];
    for (const index of particle.pixels) {
      const x = index % width;
      const y = Math.floor(index / width);
      sumX += x + 0.5;
      sumY += y + 0.5;
      if (!membership.has(index - 1) || !membership.has(index + 1) || !membership.has(index - width) || !membership.has(index + width)) {
        boundary.push([x + 0.5, y + 0.5]);
      }
    }
    let contour = convexHull(boundary);
    if (contour.length > 96) {
      const step = Math.ceil(contour.length / 96);
      contour = contour.filter((_, index) => index % step === 0);
    }
    return {
      cell_id: cellId,
      center_x: sumX / particle.area,
      center_y: sumY / particle.area,
      area_pixels: particle.area,
      contour
    };
  }

  function convexHull(points) {
    if (points.length <= 2) return points.slice();
    const sorted = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const point of sorted) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
      lower.push(point);
    }
    const upper = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
      const point = sorted[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
      upper.push(point);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
  }

  function emptyResult(options, warning) {
    return {
      method: 'imagej_local', threshold: 0, autoThreshold: 0, polarity: options.polarity,
      validAreaPixels: 0, expectedAreaPixels: 0, cells: [], cell_count: 0,
      total_cell_area_pixels: 0, mean_cell_area_pixels: 0, coverage_percent: 0,
      warnings: [warning]
    };
  }

  function countOnes(values) {
    let count = 0;
    for (let i = 0; i < values.length; i++) count += values[i] ? 1 : 0;
    return count;
  }

  function median(sortedValues) {
    if (!sortedValues.length) return 0;
    const middle = Math.floor(sortedValues.length / 2);
    return sortedValues.length % 2
      ? sortedValues[middle]
      : (sortedValues[middle - 1] + sortedValues[middle]) / 2;
  }

  function finite(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function round(value, digits) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  }

  return { segmentImageData, otsuThreshold, boxBlur };
});
