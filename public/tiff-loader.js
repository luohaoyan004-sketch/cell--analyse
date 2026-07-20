/* Browser-side TIFF loader. Uses the vendored UTIF.js decoder and never uploads the source file. */
(function exposeTiffLoader(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TiffLoader = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createTiffLoader() {
  'use strict';

  const MAX_TIFF_BYTES = 300 * 1024 * 1024;
  const MAX_IMAGE_PIXELS = 100 * 1024 * 1024;

  function decodeTiffArrayBuffer(arrayBuffer, decoder) {
    if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength < 8) {
      throw new Error('TIFF 文件为空或内容不完整');
    }
    const header = new Uint8Array(arrayBuffer, 0, 4);
    const littleEndian = header[0] === 0x49 && header[1] === 0x49 && (header[2] === 42 || header[2] === 43) && header[3] === 0;
    const bigEndian = header[0] === 0x4d && header[1] === 0x4d && header[2] === 0 && (header[3] === 42 || header[3] === 43);
    if (!littleEndian && !bigEndian) throw new Error('文件内容不是有效的 TIFF/TIF');
    if (arrayBuffer.byteLength > MAX_TIFF_BYTES) {
      throw new Error('TIFF 文件超过 300 MB，请先裁剪或转换为较小图像');
    }
    const utif = decoder || (typeof globalThis !== 'undefined' ? globalThis.UTIF : null);
    if (!utif?.decode || !utif?.decodeImage || !utif?.toRGBA8) {
      throw new Error('浏览器 TIFF 解码器未加载');
    }

    let ifds;
    try {
      ifds = utif.decode(arrayBuffer);
    } catch (error) {
      throw new Error(`无法读取 TIFF 目录：${error.message || error}`);
    }
    if (!Array.isArray(ifds) || !ifds.length) throw new Error('TIFF 中没有可读取的图像页');

    const imagePages = ifds.filter(ifd => positiveTag(ifd, 256) && positiveTag(ifd, 257));
    const candidates = imagePages.length ? imagePages : ifds;
    let selected = null;
    let lastError = null;
    for (const ifd of candidates) {
      try {
        utif.decodeImage(arrayBuffer, ifd);
        if (Number(ifd.width) > 0 && Number(ifd.height) > 0) {
          selected = ifd;
          break;
        }
      } catch (error) {
        lastError = error;
      }
    }
    if (!selected) throw new Error(`TIFF 图像页解码失败${lastError ? `：${lastError.message || lastError}` : ''}`);

    const width = Math.round(Number(selected.width));
    const height = Math.round(Number(selected.height));
    const pixels = width * height;
    if (!Number.isSafeInteger(pixels) || pixels <= 0 || pixels > MAX_IMAGE_PIXELS) {
      throw new Error(`TIFF 尺寸 ${width} × ${height} 超出浏览器处理范围`);
    }

    let rgba;
    try {
      rgba = new Uint8ClampedArray(utif.toRGBA8(selected));
    } catch (error) {
      throw new Error(`TIFF 像素转换失败：${error.message || error}`);
    }
    if (rgba.length !== pixels * 4) throw new Error('TIFF 解码后的像素数量不正确');
    const normalized = autoContrastGrayscale(rgba);
    return {
      width,
      height,
      rgba,
      pageCount: imagePages.length || ifds.length,
      selectedPage: 1,
      normalized,
      source: 'tiff-browser-utif'
    };
  }

  async function decodeTiffFileToObjectUrl(file, decoder) {
    if (!file?.arrayBuffer) throw new Error('无法读取所选 TIFF 文件');
    const decoded = decodeTiffArrayBuffer(await file.arrayBuffer(), decoder);
    if (typeof document === 'undefined' || typeof URL === 'undefined') {
      throw new Error('当前环境不能生成可显示的 TIFF 图像');
    }
    const canvas = document.createElement('canvas');
    canvas.width = decoded.width;
    canvas.height = decoded.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器无法创建图像画布');
    const imageData = context.createImageData(decoded.width, decoded.height);
    imageData.data.set(decoded.rgba);
    context.putImageData(imageData, 0, 0);
    const blob = await canvasToPngBlob(canvas);
    return { ...decoded, url: URL.createObjectURL(blob) };
  }

  function canvasToPngBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error('TIFF 转换为 PNG 失败'));
      }, 'image/png');
    });
  }

  function positiveTag(ifd, tag) {
    const value = ifd?.[`t${tag}`];
    return Array.isArray(value) || ArrayBuffer.isView(value) ? Number(value[0]) > 0 : Number(value) > 0;
  }

  function autoContrastGrayscale(rgba) {
    const histogram = new Uint32Array(256);
    let opaque = 0;
    let graySamples = 0;
    let samples = 0;
    const sampleStep = Math.max(1, Math.floor((rgba.length / 4) / 10000));
    for (let pixel = 0; pixel < rgba.length / 4; pixel += sampleStep) {
      const index = pixel * 4;
      if (!rgba[index + 3]) continue;
      samples++;
      if (Math.abs(rgba[index] - rgba[index + 1]) <= 1 && Math.abs(rgba[index] - rgba[index + 2]) <= 1) graySamples++;
    }
    if (!samples || graySamples / samples < 0.98) return false;
    for (let index = 0; index < rgba.length; index += 4) {
      if (!rgba[index + 3]) continue;
      histogram[rgba[index]]++;
      opaque++;
    }
    if (!opaque) return false;
    const low = percentileFromHistogram(histogram, opaque, 0.005);
    const high = percentileFromHistogram(histogram, opaque, 0.995);
    if (high <= low || (low <= 5 && high >= 250)) return false;
    const scale = 255 / (high - low);
    for (let index = 0; index < rgba.length; index += 4) {
      if (!rgba[index + 3]) continue;
      const value = Math.max(0, Math.min(255, Math.round((rgba[index] - low) * scale)));
      rgba[index] = value;
      rgba[index + 1] = value;
      rgba[index + 2] = value;
    }
    return true;
  }

  function percentileFromHistogram(histogram, total, fraction) {
    const target = Math.max(1, Math.ceil(total * fraction));
    let running = 0;
    for (let value = 0; value < histogram.length; value++) {
      running += histogram[value];
      if (running >= target) return value;
    }
    return 255;
  }

  return { decodeTiffArrayBuffer, decodeTiffFileToObjectUrl, autoContrastGrayscale };
});
