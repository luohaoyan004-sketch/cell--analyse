/*
 * ImageJ-inspired, dependency-free cell segmentation for the browser.
 *
 * Pipelines:
 * - scale-aware circular-cell mode: Difference-of-Gaussians-style response
 *   -> local maxima -> radial ring validation -> non-maximum suppression.
 * - particle mode: local background subtraction -> Otsu threshold -> morphology
 *   -> connected particles -> watershed-like splitting.
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
    if (options.detectionMode === 'circular_blob') {
      return detectCircularCells(gray, validMask, width, height, options, validCount);
    }
    if (options.detectionMode === 'spread_cell') {
      return detectSpreadCells(gray, validMask, width, height, options, validCount);
    }
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
    const magnification = [4, 10, 20].includes(Number(raw.magnification))
      ? Number(raw.magnification)
      : 4;
    const presetDiameter = { 4: 12, 10: 30, 20: 60 }[magnification];
    return {
      minArea,
      maxArea,
      polarity,
      detectionMode: raw.detectionMode === 'circular_blob' || raw.detectionMode === 'spread_cell'
        ? raw.detectionMode
        : 'particle',
      magnification,
      expectedDiameter: clamp(finite(raw.expectedDiameter, presetDiameter), 6, 160),
      expectedSpreadDiameter: clamp(finite(raw.expectedSpreadDiameter, { 4: 22, 10: 55, 20: 110 }[magnification]), 12, 220),
      backgroundRadius: clamp(Math.round(finite(raw.backgroundRadius, 24)), 2, 128),
      smoothRadius: clamp(Math.round(finite(raw.smoothRadius, 1)), 0, 4),
      thresholdOffset: clamp(finite(raw.thresholdOffset, 0), -100, 100),
      expectedArea: Math.max(0, finite(raw.expectedArea, 0)),
      morphology: raw.morphology !== false,
      watershed: raw.watershed !== false
    };
  }

  /**
   * Detect round brightfield cells by their bright centre/dark halo signature.
   *
   * This follows the scale-space principle used by LoG/DoG blob detectors, but
   * uses integral-image box filters so a multi-megapixel TIFF remains practical
   * in a browser. Radial validation rejects ridges, scratches and well edges;
   * NMS ensures one centre is returned per cell, including cells in clusters.
   */
  function detectCircularCells(gray, validMask, width, height, options, validCount) {
    const scaleFactors = [0.68, 0.84, 1, 1.18];
    const candidates = [];
    const scaleSummaries = [];

    for (const scaleFactor of scaleFactors) {
      const diameter = options.expectedDiameter * scaleFactor;
      const innerRadius = Math.max(1, Math.round(diameter * 0.22));
      const outerRadius = Math.max(innerRadius + 2, Math.round(diameter * 0.75));
      const inner = boxBlur(gray, width, height, innerRadius);
      const outer = boxBlur(gray, width, height, outerRadius);
      const response = new Float32Array(gray.length);
      for (let i = 0; i < response.length; i++) {
        if (validMask[i]) response[i] = inner[i] - outer[i];
      }

      const stats = robustLocationScale(response, validMask);
      const threshold = stats.median + stats.sigma * 8.5 + options.thresholdOffset * 0.2;
      const margin = Math.max(3, Math.ceil(diameter * 0.9));
      const hessianStep = Math.max(1, Math.round(diameter * 0.24));
      const minRingContrast = Math.max(1.5, stats.sigma * 1.4);
      const minRecovery = Math.max(0.75, stats.sigma * 0.65);
      let localMaximumCount = 0;

      for (let y = margin; y < height - margin; y++) {
        for (let x = margin; x < width - margin; x++) {
          const index = y * width + x;
          const value = response[index];
          if (!validMask[index] || value <= threshold || !isLocalMaximum(response, validMask, width, index)) continue;
          localMaximumCount++;
          const blobness = hessianBlobness(response, width, x, y, hessianStep);
          if (blobness < 0.18) continue;
          const radial = radialRingEvidence(gray, validMask, width, height, x, y, diameter, minRingContrast, minRecovery);
          const roundEnough = radial.coverage >= 0.62 && blobness >= 0.35;
          const partlyOccludedButIsotropic = radial.coverage >= 0.5 && blobness >= 0.7;
          if (!roundEnough && !partlyOccludedButIsotropic) continue;

          const radius = diameter / 2;
          const area = Math.PI * radius * radius;
          if (area < options.minArea || area > options.maxArea) continue;
          candidates.push({
            x: x + 0.5,
            y: y + 0.5,
            radius,
            area,
            response: value,
            blobness,
            radialCoverage: radial.coverage,
            confidence: value / Math.max(0.5, threshold) + blobness * 1.5 + radial.coverage * 1.5
          });
        }
      }
      scaleSummaries.push({ diameter, threshold, localMaximumCount });
    }

    candidates.sort((a, b) => b.confidence - a.confidence || b.response - a.response);
    const accepted = [];
    for (const candidate of candidates) {
      const separated = accepted.every(other => {
        const minDistance = Math.min(candidate.radius, other.radius) * 1.15;
        return Math.hypot(candidate.x - other.x, candidate.y - other.y) >= minDistance;
      });
      if (separated) accepted.push(candidate);
    }
    accepted.sort((a, b) => a.y - b.y || a.x - b.x);

    const cells = accepted.map((candidate, index) => circularCandidateToCell(candidate, index + 1));
    const totalAreaPixels = cells.reduce((sum, cell) => sum + cell.area_pixels, 0);
    const meanThreshold = scaleSummaries.reduce((sum, item) => sum + item.threshold, 0) / scaleSummaries.length;
    const warnings = [
      `尺度感知圆细胞识别：${options.magnification}×，预计直径 ${round(options.expectedDiameter, 1)}px`,
      `多尺度 DoG/LoG 式检测 + 径向环形校验 + 非极大值抑制；候选 ${candidates.length} 个，保留 ${cells.length} 个`
    ];
    if (!cells.length) warnings.push('没有找到符合当前倍镜尺度的圆形细胞；请核对倍镜或降低阈值偏移');
    const coverage = validCount > 0 ? totalAreaPixels / validCount * 100 : 0;

    return {
      method: 'scale_aware_circular_blob',
      threshold: meanThreshold,
      autoThreshold: meanThreshold - options.thresholdOffset * 0.2,
      polarity: 'bright-centre-dark-halo',
      magnification: options.magnification,
      expectedDiameterPixels: options.expectedDiameter,
      validAreaPixels: validCount,
      expectedAreaPixels: Math.PI * (options.expectedDiameter / 2) ** 2,
      cells,
      cell_count: cells.length,
      total_cell_area_pixels: totalAreaPixels,
      mean_cell_area_pixels: cells.length ? totalAreaPixels / cells.length : 0,
      coverage_percent: coverage,
      warnings
    };
  }

  function robustLocationScale(values, mask) {
    const sample = [];
    const stride = Math.max(1, Math.floor(values.length / 50000));
    for (let i = 0; i < values.length; i += stride) {
      if (mask[i] && Number.isFinite(values[i])) sample.push(values[i]);
    }
    if (!sample.length) return { median: 0, sigma: 1 };
    sample.sort((a, b) => a - b);
    const center = median(sample);
    const deviations = sample.map(value => Math.abs(value - center)).sort((a, b) => a - b);
    return { median: center, sigma: Math.max(0.25, median(deviations) * 1.4826) };
  }

  function isLocalMaximum(values, mask, width, index) {
    const center = values[index];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const neighbor = index + dy * width + dx;
        if (!mask[neighbor]) continue;
        if (values[neighbor] > center || (values[neighbor] === center && neighbor < index)) return false;
      }
    }
    return true;
  }

  function hessianBlobness(response, width, x, y, step) {
    const center = response[y * width + x];
    const dxx = response[y * width + x + step] + response[y * width + x - step] - 2 * center;
    const dyy = response[(y + step) * width + x] + response[(y - step) * width + x] - 2 * center;
    const dxy = (
      response[(y + step) * width + x + step] - response[(y + step) * width + x - step]
      - response[(y - step) * width + x + step] + response[(y - step) * width + x - step]
    ) / 4;
    const trace = dxx + dyy;
    const determinant = dxx * dyy - dxy * dxy;
    const discriminant = Math.sqrt(Math.max(0, trace * trace / 4 - determinant));
    const first = trace / 2 - discriminant;
    const second = trace / 2 + discriminant;
    if (first >= 0 || second >= 0) return 0;
    return Math.min(Math.abs(first), Math.abs(second)) / Math.max(1e-6, Math.abs(first), Math.abs(second));
  }

  function radialRingEvidence(gray, validMask, width, height, x, y, diameter, minContrast, minRecovery) {
    const angles = 16;
    let validDirections = 0;
    let supportedDirections = 0;
    for (let angleIndex = 0; angleIndex < angles; angleIndex++) {
      const angle = angleIndex / angles * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const core = sampleNearest(gray, validMask, width, height, x + cos * diameter * 0.12, y + sin * diameter * 0.12);
      const ringA = sampleNearest(gray, validMask, width, height, x + cos * diameter * 0.34, y + sin * diameter * 0.34);
      const ringB = sampleNearest(gray, validMask, width, height, x + cos * diameter * 0.44, y + sin * diameter * 0.44);
      const ringC = sampleNearest(gray, validMask, width, height, x + cos * diameter * 0.54, y + sin * diameter * 0.54);
      const outerA = sampleNearest(gray, validMask, width, height, x + cos * diameter * 0.72, y + sin * diameter * 0.72);
      const outerB = sampleNearest(gray, validMask, width, height, x + cos * diameter * 0.88, y + sin * diameter * 0.88);
      if ([core, ringA, ringB, ringC, outerA, outerB].some(value => value === null)) continue;
      validDirections++;
      const ring = Math.min(ringA, ringB, ringC);
      const outer = (outerA + outerB) / 2;
      if (core - ring >= minContrast
        && outer - ring >= minRecovery
        && core - outer >= minRecovery * 0.5) supportedDirections++;
    }
    return { coverage: validDirections ? supportedDirections / validDirections : 0 };
  }

  function sampleNearest(values, mask, width, height, x, y) {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= width || py >= height) return null;
    const index = py * width + px;
    return mask[index] ? values[index] : null;
  }

  function circularCandidateToCell(candidate, cellId) {
    const contour = [];
    for (let index = 0; index < 24; index++) {
      const angle = index / 24 * Math.PI * 2;
      contour.push([
        candidate.x + Math.cos(angle) * candidate.radius,
        candidate.y + Math.sin(angle) * candidate.radius
      ]);
    }
    return {
      cell_id: cellId,
      center_x: candidate.x,
      center_y: candidate.y,
      area_pixels: candidate.area,
      contour,
      confidence: clamp(candidate.confidence / 5, 0, 1),
      blobness: candidate.blobness,
      radial_coverage: candidate.radialCoverage
    };
  }

  /**
   * Detect spread adherent cells by locating broad dark cell-body basins, then
   * validating that each seed is surrounded by microscopy edges. Approximate
   * contours expand toward strong edges and stop at neighbouring seed Voronoi
   * boundaries, which prevents dense colonies from collapsing into one region.
   */
  function detectSpreadCells(gray, validMask, width, height, options, validCount) {
    const diameter = options.expectedSpreadDiameter;
    const innerRadius = Math.max(2, Math.round(diameter * 0.12));
    const outerRadius = Math.max(innerRadius + 3, Math.round(diameter * 0.5));
    const inner = boxBlur(gray, width, height, innerRadius);
    const outer = boxBlur(gray, width, height, outerRadius);
    const basinImage = boxBlur(gray, width, height, Math.max(1, Math.round(diameter * 0.04)));
    const response = new Float32Array(gray.length);
    for (let index = 0; index < response.length; index++) {
      if (validMask[index]) response[index] = outer[index] - inner[index];
    }

    const responseStats = robustLocationScale(response, validMask);
    const threshold = responseStats.median + responseStats.sigma * 3 + options.thresholdOffset * 0.2;
    const margin = Math.max(4, Math.ceil(diameter * 1.75));
    const rawSeeds = [];
    for (let y = margin; y < height - margin; y++) {
      for (let x = margin; x < width - margin; x++) {
        const index = y * width + x;
        if (!validMask[index] || response[index] <= threshold || !isLocalMaximum(response, validMask, width, index)) continue;
        rawSeeds.push({ x: x + 0.5, y: y + 0.5, response: response[index] });
      }
    }
    rawSeeds.sort((a, b) => b.response - a.response);
    const separatedSeeds = suppressNearbySeeds(
      rawSeeds,
      diameter * 0.55,
      basinImage,
      width,
      diameter * 1.7
    );

    const gradient = sobelMagnitude(gray, width, height);
    const gradientStats = robustLocationScale(gradient, validMask);
    const edgeThreshold = gradientStats.median + gradientStats.sigma * 3;
    const texture = localStandardDeviation(gray, width, height, Math.max(3, Math.round(diameter * 0.27)));
    const textureThreshold = Math.max(6, robustLocationScale(texture, validMask).median * 1.15);
    const acceptedSeeds = [];
    for (const seed of separatedSeeds) {
      const index = Math.floor(seed.y) * width + Math.floor(seed.x);
      const edgeCoverage = radialEdgeCoverage(
        gradient, validMask, width, height, seed.x, seed.y, diameter, edgeThreshold
      );
      const localTexture = texture[index];
      const edgeSupported = edgeCoverage >= 0.42;
      const texturedPartialEdge = edgeCoverage >= 0.3 && localTexture >= textureThreshold;
      if (!edgeSupported && !texturedPartialEdge) continue;
      acceptedSeeds.push({
        ...seed,
        edgeCoverage,
        texture: localTexture,
        confidence: seed.response / Math.max(0.5, threshold)
          + edgeCoverage * 1.5
          + Math.min(1, localTexture / Math.max(1, textureThreshold))
      });
    }

    acceptedSeeds.sort((a, b) => a.y - b.y || a.x - b.x);
    const cells = [];
    for (const seed of acceptedSeeds) {
      const cell = spreadSeedToCell(seed, acceptedSeeds, gradient, validMask, width, height, diameter, edgeThreshold, cells.length + 1);
      if (cell.area_pixels >= options.minArea && cell.area_pixels <= options.maxArea) cells.push(cell);
    }
    cells.forEach((cell, index) => { cell.cell_id = index + 1; });
    const totalAreaPixels = cells.reduce((sum, cell) => sum + cell.area_pixels, 0);
    const coverage = validCount > 0 ? totalAreaPixels / validCount * 100 : 0;
    const warnings = [
      `铺展贴壁细胞识别：${options.magnification}×，预计短轴 ${round(diameter, 1)}px`,
      `暗胞体种子 + 径向边缘支持 + 邻近中心约束轮廓；种子 ${separatedSeeds.length} 个，保留 ${cells.length} 个`
    ];
    if (!cells.length) warnings.push('没有找到可靠的铺展细胞中心；请核对倍镜、ROI 或降低阈值偏移');
    if (coverage > 90) warnings.push('估算轮廓覆盖率过高；建议提高阈值偏移或缩小 ROI 到培养区域');

    return {
      method: 'scale_aware_spread_cell',
      threshold,
      autoThreshold: threshold - options.thresholdOffset * 0.2,
      polarity: 'dark-cell-body-with-edge',
      magnification: options.magnification,
      expectedDiameterPixels: diameter,
      validAreaPixels: validCount,
      expectedAreaPixels: Math.PI * (diameter / 2) ** 2,
      cells,
      cell_count: cells.length,
      total_cell_area_pixels: totalAreaPixels,
      mean_cell_area_pixels: cells.length ? totalAreaPixels / cells.length : 0,
      coverage_percent: coverage,
      warnings
    };
  }

  function suppressNearbySeeds(sortedSeeds, minimumDistance, basinImage, width, sameBasinDistance = minimumDistance) {
    const clusters = [];
    const distanceSquared = minimumDistance * minimumDistance;
    const sameBasinDistanceSquared = sameBasinDistance * sameBasinDistance;
    for (const seed of sortedSeeds) {
      const cluster = clusters.find(candidate => candidate.members.some(other => {
        const dx = seed.x - other.x;
        const dy = seed.y - other.y;
        const squaredDistance = dx * dx + dy * dy;
        if (squaredDistance < distanceSquared) return true;
        if (!basinImage || squaredDistance >= sameBasinDistanceSquared) return false;

        // An elongated cell can create several maxima along the same dark body.
        // Merge them only when the smoothed intensity stays in the same dark
        // body. Light smoothing bridges small nuclear highlights, while any
        // bright sample along the line keeps touching cells apart.
        const seedIndex = Math.floor(seed.y) * width + Math.floor(seed.x);
        const otherIndex = Math.floor(other.y) * width + Math.floor(other.x);
        const basinCeiling = Math.max(basinImage[seedIndex], basinImage[otherIndex]) + 18;
        let darkSamples = 0;
        for (const fraction of [0.25, 0.5, 0.75]) {
          const sampleX = Math.round(seed.x + (other.x - seed.x) * fraction);
          const sampleY = Math.round(seed.y + (other.y - seed.y) * fraction);
          if (basinImage[sampleY * width + sampleX] <= basinCeiling) darkSamples += 1;
        }
        return darkSamples === 3;
      }));
      if (cluster) cluster.members.push(seed);
      else clusters.push({ members: [seed] });
    }
    return clusters.map(cluster => {
      const weightSum = cluster.members.reduce((sum, member) => sum + Math.max(0.01, member.response), 0);
      return {
        x: cluster.members.reduce((sum, member) => sum + member.x * Math.max(0.01, member.response), 0) / weightSum,
        y: cluster.members.reduce((sum, member) => sum + member.y * Math.max(0.01, member.response), 0) / weightSum,
        response: Math.max(...cluster.members.map(member => member.response))
      };
    });
  }

  function sobelMagnitude(gray, width, height) {
    const smoothed = boxBlur(gray, width, height, 2);
    const gradient = new Float32Array(gray.length);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const top = (y - 1) * width + x;
        const middle = y * width + x;
        const bottom = (y + 1) * width + x;
        const gx = -smoothed[top - 1] + smoothed[top + 1]
          - 2 * smoothed[middle - 1] + 2 * smoothed[middle + 1]
          - smoothed[bottom - 1] + smoothed[bottom + 1];
        const gy = -smoothed[top - 1] - 2 * smoothed[top] - smoothed[top + 1]
          + smoothed[bottom - 1] + 2 * smoothed[bottom] + smoothed[bottom + 1];
        gradient[middle] = Math.hypot(gx, gy) / 8;
      }
    }
    return gradient;
  }

  function localStandardDeviation(gray, width, height, radius) {
    const squared = new Float32Array(gray.length);
    for (let index = 0; index < gray.length; index++) squared[index] = gray[index] * gray[index];
    const mean = boxBlur(gray, width, height, radius);
    const meanSquared = boxBlur(squared, width, height, radius);
    const deviation = new Float32Array(gray.length);
    for (let index = 0; index < gray.length; index++) {
      deviation[index] = Math.sqrt(Math.max(0, meanSquared[index] - mean[index] * mean[index]));
    }
    return deviation;
  }

  function radialEdgeCoverage(gradient, validMask, width, height, x, y, diameter, threshold) {
    const angles = 24;
    let validDirections = 0;
    let supportedDirections = 0;
    for (let angleIndex = 0; angleIndex < angles; angleIndex++) {
      const angle = angleIndex / angles * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      let maximum = 0;
      let validSamples = 0;
      for (let step = 0; step < 12; step++) {
        const radius = diameter * (0.25 + step / 11 * 0.85);
        const value = sampleNearest(gradient, validMask, width, height, x + cos * radius, y + sin * radius);
        if (value === null) continue;
        validSamples++;
        maximum = Math.max(maximum, value);
      }
      if (!validSamples) continue;
      validDirections++;
      if (maximum >= threshold) supportedDirections++;
    }
    return validDirections ? supportedDirections / validDirections : 0;
  }

  function spreadSeedToCell(seed, seeds, gradient, validMask, width, height, diameter, edgeThreshold, cellId) {
    const angles = 24;
    let radii = [];
    for (let angleIndex = 0; angleIndex < angles; angleIndex++) {
      const angle = angleIndex / angles * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const minimumRadius = diameter * 0.28;
      let maximumRadius = diameter * 1.7;
      for (const other of seeds) {
        if (other === seed) continue;
        const dx = other.x - seed.x;
        const dy = other.y - seed.y;
        const projection = dx * cos + dy * sin;
        if (projection <= 0) continue;
        const boundary = (dx * dx + dy * dy) / (2 * projection);
        maximumRadius = Math.min(maximumRadius, boundary * 0.92);
      }
      maximumRadius = Math.max(minimumRadius, maximumRadius);
      let bestRadius = Math.min(maximumRadius, diameter * 0.58);
      let bestScore = -Infinity;
      const steps = 20;
      for (let step = 0; step < steps; step++) {
        const radius = minimumRadius + step / (steps - 1) * (maximumRadius - minimumRadius);
        const value = sampleNearest(gradient, validMask, width, height, seed.x + cos * radius, seed.y + sin * radius);
        if (value === null) continue;
        const score = value * (0.8 + radius / Math.max(1, maximumRadius) * 0.2);
        if (score > bestScore) { bestScore = score; bestRadius = radius; }
      }
      if (bestScore < edgeThreshold * 0.7) bestRadius = Math.min(maximumRadius, diameter * 0.58);
      radii.push(bestRadius);
    }
    for (let pass = 0; pass < 2; pass++) {
      radii = radii.map((radius, index) => (
        radii[(index + radii.length - 1) % radii.length] + radius * 2 + radii[(index + 1) % radii.length]
      ) / 4);
    }
    const contour = radii.map((radius, index) => {
      const angle = index / radii.length * Math.PI * 2;
      return [seed.x + Math.cos(angle) * radius, seed.y + Math.sin(angle) * radius];
    });
    const area = polygonArea(contour);
    return {
      cell_id: cellId,
      center_x: seed.x,
      center_y: seed.y,
      area_pixels: area,
      contour,
      confidence: clamp(seed.confidence / 4, 0, 1),
      edge_coverage: seed.edgeCoverage
    };
  }

  function polygonArea(points) {
    let area = 0;
    for (let index = 0; index < points.length; index++) {
      const next = points[(index + 1) % points.length];
      area += points[index][0] * next[1] - next[0] * points[index][1];
    }
    return Math.abs(area) / 2;
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
