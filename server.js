/*
  Cell ROI Analyzer - zero-dependency Node server
  - Serves /public files
  - Proxies image-region analysis to OpenAI Responses API
  - Reads OPENAI_API_KEY and OPENAI_MODEL from .env or environment variables
*/

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');

loadDotEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT || 8787);

function isMockMode() {
  const useMock = String(process.env.USE_MOCK || '').toLowerCase() === 'true';
  const hasKey = Boolean(process.env.OPENAI_API_KEY);
  return {
    mock: useMock || !hasKey,
    useMock,
    hasKey,
    reason: useMock ? 'USE_MOCK=true' : (!hasKey ? 'missing OPENAI_API_KEY' : '')
  };
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/api/health') {
      const status = isMockMode();
      return json(res, 200, {
        ok: true,
        model: process.env.OPENAI_MODEL || 'gpt-5.5',
        hasKey: status.hasKey,
        mock: status.mock,
        mockReason: status.reason
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/analyze') {
      const body = await readJson(req, 28 * 1024 * 1024);
      const result = await analyzeRegion(body);
      return json(res, 200, result);
    }
    if (req.method === 'POST' && url.pathname === '/api/convert-tiff') {
      const body = await readBinary(req, 120 * 1024 * 1024);
      const result = convertTiffToPngDataUrl(body);
      return json(res, 200, result);
    }
    if (req.method === 'GET') {
      return serveStatic(url.pathname, res);
    }
    json(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    json(res, 500, { error: err.message || 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Cell ROI Analyzer running at http://localhost:${PORT}`);
});

function serveStatic(requestPath, res) {
  let safePath = decodeURIComponent(requestPath.split('?')[0]);
  if (safePath === '/') safePath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC, safePath));
  if (!filePath.startsWith(PUBLIC)) return json(res, 403, { error: 'Forbidden' });
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return json(res, 404, { error: 'Not found' });
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

function readJson(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (Buffer.byteLength(raw) > maxBytes) {
        reject(new Error('Payload too large. Please reduce image size or crop smaller regions.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (_) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readBinary(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('File too large. Please use a smaller TIFF or convert it to PNG first.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function convertTiffToPngDataUrl(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Empty TIFF upload');
  if (!isTiffBuffer(buffer)) throw new Error('文件内容不是有效的 TIFF/TIF');
  const py = String.raw`
import sys, io, json, base64
from PIL import Image, ImageOps
raw = sys.stdin.buffer.read()
try:
    img = Image.open(io.BytesIO(raw))
    try:
        img.seek(0)
    except Exception:
        pass
    # Normalize common microscopy TIFF formats, including 16-bit grayscale, into viewable 8-bit PNG.
    if img.mode in ('I;16', 'I;16B', 'I;16L', 'I', 'F'):
        # Auto-scale 16-bit / floating grayscale microscopy TIFF into 8-bit display range.
        lo, hi = img.getextrema()
        if isinstance(lo, tuple):
            img = img.convert('RGB')
        elif hi > lo:
            scale = 255.0 / float(hi - lo)
            img = img.point(lambda v: int(max(0, min(255, (float(v) - float(lo)) * scale)))).convert('L')
        else:
            img = img.point(lambda v: 0).convert('L')
    elif img.mode not in ('RGB', 'RGBA', 'L'):
        img = img.convert('RGB')
    # Preserve orientation metadata when present.
    try:
        img = ImageOps.exif_transpose(img)
    except Exception:
        pass
    if img.mode == 'L':
        img = img.convert('RGB')
    elif img.mode == 'RGBA':
        pass
    else:
        img = img.convert('RGB')
    out = io.BytesIO()
    img.save(out, format='PNG')
    payload = {
        'dataUrl': 'data:image/png;base64,' + base64.b64encode(out.getvalue()).decode('ascii'),
        'width': img.width,
        'height': img.height,
        'format': 'png',
        'source': 'tiff-converted'
    }
    print(json.dumps(payload))
except Exception as e:
    print(json.dumps({'error': str(e)}))
    sys.exit(2)
`;
  const runPython = (cmd) => spawnSync(cmd, ['-c', py], { input: buffer, maxBuffer: 180 * 1024 * 1024 });
  let proc = runPython('python3');
  if (proc.error && proc.error.code === 'ENOENT') proc = runPython('python');
  const stdout = proc.stdout ? proc.stdout.toString('utf8').trim() : '';
  const stderr = proc.stderr ? proc.stderr.toString('utf8').trim() : '';
  let parsed;
  try { parsed = stdout ? JSON.parse(stdout) : null; } catch (_) {}
  if (proc.status === 0 && parsed && !parsed.error) return parsed;

  const pythonError = parsed?.error || stderr || proc.error?.message || 'Pillow unavailable';
  try {
    return convertTiffWithSystemTool(buffer);
  } catch (systemError) {
    throw new Error(`TIFF 转换失败：Python/Pillow: ${pythonError}；系统转换器: ${systemError.message}`);
  }
}

function isTiffBuffer(buffer) {
  if (buffer.length < 8) return false;
  const littleEndian = buffer[0] === 0x49 && buffer[1] === 0x49;
  const bigEndian = buffer[0] === 0x4d && buffer[1] === 0x4d;
  if (!littleEndian && !bigEndian) return false;
  const marker = littleEndian ? buffer.readUInt16LE(2) : buffer.readUInt16BE(2);
  return marker === 42 || marker === 43;
}

function convertTiffWithSystemTool(buffer) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cell-roi-tiff-'));
  const inputPath = path.join(tempDir, 'input.tif');
  const outputPath = path.join(tempDir, 'output.png');
  fs.writeFileSync(inputPath, buffer);
  const attempts = process.platform === 'darwin'
    ? [
        { command: 'sips', args: ['-s', 'format', 'png', inputPath, '--out', outputPath] },
        { command: 'magick', args: [`${inputPath}[0]`, outputPath] },
        { command: 'convert', args: [`${inputPath}[0]`, outputPath] }
      ]
    : [
        { command: 'magick', args: [`${inputPath}[0]`, outputPath] },
        { command: 'convert', args: [`${inputPath}[0]`, outputPath] }
      ];
  const errors = [];
  try {
    for (const attempt of attempts) {
      const proc = spawnSync(attempt.command, attempt.args, { maxBuffer: 20 * 1024 * 1024 });
      if (proc.error?.code === 'ENOENT') {
        errors.push(`${attempt.command} 未安装`);
        continue;
      }
      if (proc.status !== 0 || !fs.existsSync(outputPath)) {
        const detail = proc.stderr ? proc.stderr.toString('utf8').trim() : '';
        errors.push(`${attempt.command}: ${detail || `退出码 ${proc.status}`}`);
        continue;
      }
      const png = fs.readFileSync(outputPath);
      const dimensions = pngDimensions(png);
      return {
        dataUrl: `data:image/png;base64,${png.toString('base64')}`,
        width: dimensions.width,
        height: dimensions.height,
        format: 'png',
        source: `tiff-converted-${attempt.command}`
      };
    }
    throw new Error(errors.join('；') || '没有可用的 TIFF 转换器');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function pngDimensions(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) throw new Error('转换器没有生成有效 PNG');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}


async function analyzeRegion(payload) {
  validatePayload(payload);

  const status = isMockMode();
  if (status.mock) {
    return mockAnalyze(payload, status.reason);
  }

  const model = process.env.OPENAI_MODEL || 'gpt-5.5';
  const prompt = buildAnalysisPrompt(payload);
  const responseSchema = buildSchema();

  const apiPayload = {
    model,
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: prompt },
          { type: 'input_image', image_url: payload.imageDataUrl }
        ]
      }
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'cell_region_analysis',
        strict: true,
        schema: responseSchema
      }
    }
  };

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify(apiPayload)
  });

  const raw = await response.text();
  if (!response.ok) {
    let msg = raw;
    try { msg = JSON.parse(raw).error?.message || raw; } catch (_) {}
    throw new Error(`OpenAI API error: ${msg}`);
  }

  let data;
  try { data = JSON.parse(raw); } catch (_) { throw new Error('OpenAI returned non-JSON response'); }

  const text = extractOutputText(data);
  if (!text) throw new Error('No JSON text returned by model');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Model returned invalid JSON: ${text.slice(0, 300)}`);
  }

  return normalizeAnalysis(parsed, payload, model, false);
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Missing payload');
  if (!payload.regionId) throw new Error('Missing regionId');
  if (!payload.imageDataUrl || !payload.imageDataUrl.startsWith('data:image/')) {
    throw new Error('Missing imageDataUrl data URL');
  }
  if (!Number.isFinite(payload.width) || !Number.isFinite(payload.height)) {
    throw new Error('Missing crop width/height');
  }
}

function buildAnalysisPrompt(payload) {
  const pixelSizeUm = Number(payload.pixelSizeUm || 0);
  const areaFactor = pixelSizeUm > 0 ? pixelSizeUm * pixelSizeUm : null;
  const effectiveArea = Math.round(payload.effectiveAreaPixels || payload.width * payload.height);

  return [
    'You are analyzing a CROPPED microscopy image region for adherent cells.',
    'The main target is BRIGHTFIELD microscopy images of spread MRC-5-like fibroblast cells.',
    'This is a quantitative cell segmentation task, not a rough visual guess.',
    '',
    'Goal:',
    '- Identify each individual adherent cell whose centroid lies inside the crop/effective ROI area.',
    '- Estimate each cell centroid, projected 2D spread area, and simplified outer contour polygon.',
    '- Be conservative. Do not invent cells when evidence is weak.',
    '',
    'Visual analysis steps to follow:',
    '1. Mentally correct uneven illumination and ignore background gradient.',
    '2. Ignore dust, scratches, bubbles, debris, scale bars, grid lines, labels, ROI borders, and image-compression artifacts.',
    '3. Identify real cells by coherent cytoplasmic body, elongated/spread fibroblast-like morphology, and consistent cell boundary/halo.',
    '4. Do NOT count tiny dark dots, isolated speckles, pores, dust particles, or texture as cells.',
    '5. If two cells touch but have distinguishable bodies/centers, count them as separate cells.',
    '6. If a large dark object, bubble edge, wall, meniscus, or device boundary appears, ignore it completely unless real cells are visible on it.',
    '7. For cells cut by crop boundaries, count only if the cell centroid is visible inside this crop.',
    '8. Draw contours around the visible cell body footprint, not around brightfield halos or background shadow.',
    '',
    'Numerical consistency rules:',
    '- cell_count must equal cells.length.',
    '- total_cell_area_pixels must equal the sum of area_pixels over cells.',
    '- mean_cell_area_pixels = total_cell_area_pixels / cell_count if cell_count > 0, otherwise 0.',
    '- coverage_percent = total_cell_area_pixels / effective_area_pixels_after_ROI_clip * 100.',
    '- Each contour must use local crop pixel coordinates.',
    '- center_x and center_y must use local crop pixel coordinates.',
    '- If the region contains no reliable cells, return zero cells and explain in warnings.',
    '',
    'Return only valid JSON matching the schema. Do not include markdown or comments.',
    '',
    `region_id: ${payload.regionId}`,
    `image_type: ${payload.imageType || 'brightfield'}`,
    `crop_width_px: ${Math.round(payload.width)}`,
    `crop_height_px: ${Math.round(payload.height)}`,
    `effective_area_pixels_after_ROI_clip: ${effectiveArea}`,
    areaFactor ? `pixel_size_um: ${pixelSizeUm}` : 'pixel_size_um: not provided',
    areaFactor ? `1 pixel area equals ${areaFactor} um^2` : 'Return pixel areas; server will not convert missing scale.'
  ].join('\n');
}

function buildSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['region_id', 'cell_count', 'total_cell_area_pixels', 'mean_cell_area_pixels', 'coverage_percent', 'cells', 'warnings'],
    properties: {
      region_id: { type: 'string' },
      cell_count: { type: 'integer', minimum: 0 },
      total_cell_area_pixels: { type: 'number', minimum: 0 },
      mean_cell_area_pixels: { type: 'number', minimum: 0 },
      coverage_percent: { type: 'number', minimum: 0 },
      warnings: { type: 'array', items: { type: 'string' } },
      cells: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['cell_id', 'center_x', 'center_y', 'area_pixels', 'contour'],
          properties: {
            cell_id: { type: 'integer', minimum: 1 },
            center_x: { type: 'number' },
            center_y: { type: 'number' },
            area_pixels: { type: 'number', minimum: 0 },
            contour: {
              type: 'array',
              items: {
                type: 'array',
                minItems: 2,
                maxItems: 2,
                items: { type: 'number' }
              }
            }
          }
        }
      }
    }
  };
}

function extractOutputText(data) {
  if (typeof data.output_text === 'string') return data.output_text;
  const chunks = [];
  if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (Array.isArray(item.content)) {
        for (const c of item.content) {
          if (typeof c.text === 'string') chunks.push(c.text);
          if (typeof c.output_text === 'string') chunks.push(c.output_text);
        }
      }
    }
  }
  return chunks.join('').trim();
}

function normalizeAnalysis(parsed, payload, model, mock) {
  const pixelSizeUm = Number(payload.pixelSizeUm || 0);
  const areaFactor = pixelSizeUm > 0 ? pixelSizeUm * pixelSizeUm : 0;
  const cells = Array.isArray(parsed.cells) ? parsed.cells.map((cell, idx) => {
    const areaPixels = finite(cell.area_pixels, 0);
    return {
      cell_id: Number.isFinite(cell.cell_id) ? cell.cell_id : idx + 1,
      center_x: finite(cell.center_x, 0),
      center_y: finite(cell.center_y, 0),
      area_pixels: areaPixels,
      area_um2: areaFactor ? areaPixels * areaFactor : null,
      contour: Array.isArray(cell.contour) ? cell.contour
        .filter(p => Array.isArray(p) && p.length >= 2)
        .map(p => [finite(p[0], 0), finite(p[1], 0)]) : []
    };
  }) : [];

  const totalPixels = finite(parsed.total_cell_area_pixels, cells.reduce((s, c) => s + c.area_pixels, 0));
  const count = Number.isFinite(parsed.cell_count) ? parsed.cell_count : cells.length;
  const meanPixels = finite(parsed.mean_cell_area_pixels, count > 0 ? totalPixels / count : 0);
  const effectiveAreaPixels = finite(payload.effectiveAreaPixels, payload.width * payload.height);

  return {
    ok: true,
    mock,
    model,
    region_id: String(parsed.region_id || payload.regionId),
    cell_count: count,
    total_cell_area_pixels: totalPixels,
    mean_cell_area_pixels: meanPixels,
    total_cell_area_um2: areaFactor ? totalPixels * areaFactor : null,
    mean_cell_area_um2: areaFactor ? meanPixels * areaFactor : null,
    coverage_percent: effectiveAreaPixels > 0 ? (totalPixels / effectiveAreaPixels) * 100 : finite(parsed.coverage_percent, 0),
    cells,
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : []
  };
}

function finite(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function mockAnalyze(payload, reason = 'mock mode') {
  const seed = crypto.createHash('md5').update(String(payload.regionId)).digest().readUInt32LE(0);
  const rand = mulberry32(seed);
  const w = Number(payload.width);
  const h = Number(payload.height);
  const n = Math.max(3, Math.min(18, Math.round((w * h) / 45000 + rand() * 8)));
  const cells = [];
  for (let i = 0; i < n; i++) {
    const cx = 20 + rand() * Math.max(20, w - 40);
    const cy = 20 + rand() * Math.max(20, h - 40);
    const rx = 10 + rand() * 24;
    const ry = 7 + rand() * 18;
    const points = [];
    const angle = rand() * Math.PI;
    for (let k = 0; k < 16; k++) {
      const t = (Math.PI * 2 * k) / 16;
      const x0 = Math.cos(t) * rx;
      const y0 = Math.sin(t) * ry;
      points.push([
        Math.max(0, Math.min(w, cx + x0 * Math.cos(angle) - y0 * Math.sin(angle))),
        Math.max(0, Math.min(h, cy + x0 * Math.sin(angle) + y0 * Math.cos(angle)))
      ]);
    }
    cells.push({ cell_id: i + 1, center_x: cx, center_y: cy, area_pixels: Math.PI * rx * ry, contour: points });
  }
  const total = cells.reduce((s, c) => s + c.area_pixels, 0);
  return normalizeAnalysis({
    region_id: payload.regionId,
    cell_count: cells.length,
    total_cell_area_pixels: total,
    mean_cell_area_pixels: total / cells.length,
    coverage_percent: 0,
    cells,
    warnings: [`Mock result: ${reason}. Create .env, set OPENAI_API_KEY, and set USE_MOCK=false to call OpenAI.`]
  }, payload, process.env.OPENAI_MODEL || 'gpt-5.5', true);
}

function mulberry32(a) {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
