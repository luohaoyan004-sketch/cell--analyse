const state = {
  image: null,
  imageName: 'image',
  roiType: 'rect',
  roi: null,
  isDrawing: false,
  activePointerId: null,
  dragStart: null,
  regions: [],
  selectedRegionId: null,
  results: {},
  toolMode: 'draw',
  zoomMode: 'fit',
  zoom: 1,
  viewDirty: true,
  isAnalyzing: false
};

const $ = (id) => document.getElementById(id);
const canvas = $('mainCanvas');
const ctx = canvas.getContext('2d');

const els = {
  serverStatus: $('serverStatus'),
  dropZone: $('dropZone'),
  imageInput: $('imageInput'),
  imageNameHint: $('imageNameHint'),
  imageType: $('imageType'),
  backgroundRadius: $('backgroundRadius'),
  thresholdOffset: $('thresholdOffset'),
  minCellArea: $('minCellArea'),
  maxCellArea: $('maxCellArea'),
  watershedCells: $('watershedCells'),
  scaleUm: $('scaleUm'),
  scalePx: $('scalePx'),
  scaleHint: $('scaleHint'),
  drawModeBtn: $('drawModeBtn'),
  selectModeBtn: $('selectModeBtn'),
  roiRectBtn: $('roiRectBtn'),
  roiCircleBtn: $('roiCircleBtn'),
  gridRows: $('gridRows'),
  gridCols: $('gridCols'),
  makeGridBtn: $('makeGridBtn'),
  analyzeAllBtn: $('analyzeAllBtn'),
  analyzeOneBtn: $('analyzeOneBtn'),
  clearBtn: $('clearBtn'),
  progress: $('progress'),
  progressText: $('progressText'),
  selectedRegion: $('selectedRegion'),
  modeSelect: $('modeSelect'),
  manualCount: $('manualCount'),
  manualMeanArea: $('manualMeanArea'),
  applyManualBtn: $('applyManualBtn'),
  fitViewBtn: $('fitViewBtn'),
  actualSizeBtn: $('actualSizeBtn'),
  zoomOutBtn: $('zoomOutBtn'),
  zoomInBtn: $('zoomInBtn'),
  zoomHint: $('zoomHint'),
  canvasShell: $('canvasShell'),
  appToast: $('appToast'),
  aiTableEmpty: $('aiTableEmpty'),
  totalCount: $('totalCount'),
  totalArea: $('totalArea'),
  meanArea: $('meanArea'),
  coverage: $('coverage'),
  resultTableBody: document.querySelector('#resultTable tbody'),
  exportCsvBtn: $('exportCsvBtn'),
  exportJsonBtn: $('exportJsonBtn'),
  exportPngBtn: $('exportPngBtn'),
  exportJpegBtn: $('exportJpegBtn'),
  exportTiffBtn: $('exportTiffBtn')
};

let toastTimer = null;

function setButtonState(button, enabled, reason = '') {
  if (!button) return;
  button.disabled = !enabled;
  button.title = enabled ? '' : reason;
  button.setAttribute('aria-disabled', String(!enabled));
  if (reason) button.dataset.disabledReason = reason;
  else delete button.dataset.disabledReason;
}

function showNotice(message, type = 'info') {
  if (!message) return;
  const toast = els.appToast || document.getElementById('appToast');
  if (!toast) {
    console.log(message);
    return;
  }
  toast.textContent = message;
  toast.className = `noticeToast ${type}`;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.add('hidden'), 3200);
}

function hasAiResults() {
  return Object.keys(state.results || {}).length > 0;
}

function updateAiActionStates() {
  const hasImage = Boolean(state.image);
  const hasRoi = Boolean(state.roi);
  const validRegions = state.regions.filter(r => r.valid);
  const hasRegions = validRegions.length > 0;
  const selected = selectedRegion();
  const hasSelectedRegion = Boolean(selected && selected.valid);
  const hasResults = hasAiResults();

  setButtonState(els.drawModeBtn, hasImage && !state.isAnalyzing, '请先上传图片');
  setButtonState(els.selectModeBtn, hasRegions && !state.isAnalyzing, '请先生成网格');
  setButtonState(els.roiRectBtn, hasImage && !state.isAnalyzing, '请先上传图片');
  setButtonState(els.roiCircleBtn, hasImage && !state.isAnalyzing, '请先上传图片');
  setButtonState(els.makeGridBtn, hasImage && hasRoi && !state.isAnalyzing, hasImage ? '请先在图上拖动画 ROI' : '请先上传图片');
  setButtonState(els.fitViewBtn, hasImage, '请先上传图片');
  setButtonState(els.actualSizeBtn, hasImage, '请先上传图片');
  setButtonState(els.zoomOutBtn, hasImage, '请先上传图片');
  setButtonState(els.zoomInBtn, hasImage, '请先上传图片');
  setButtonState(els.analyzeAllBtn, hasRegions && !state.isAnalyzing, hasImage ? '请先生成有效网格' : '请先上传图片');
  setButtonState(els.analyzeOneBtn, hasSelectedRegion && !state.isAnalyzing, hasRegions ? '请先选择一个有效区域' : '请先生成网格');
  setButtonState(els.clearBtn, hasResults && !state.isAnalyzing, '暂无可清空的结果');
  setButtonState(els.applyManualBtn, hasSelectedRegion && !state.isAnalyzing, '请先选择一个有效区域');
  setButtonState(els.exportCsvBtn, hasRegions, '请先生成网格');
  setButtonState(els.exportJsonBtn, hasRegions || hasResults, '请先生成网格或分析结果');
  setButtonState(els.exportPngBtn, hasImage, '请先上传图片');
  setButtonState(els.exportJpegBtn, hasImage, '请先上传图片');
  setButtonState(els.exportTiffBtn, hasImage, '请先上传图片');

  [els.modeSelect, els.manualCount, els.manualMeanArea].forEach(el => {
    if (!el) return;
    el.disabled = !hasSelectedRegion || state.isAnalyzing;
  });
  [els.backgroundRadius, els.thresholdOffset, els.minCellArea, els.maxCellArea, els.watershedCells].forEach(el => {
    if (el) el.disabled = state.isAnalyzing;
  });

  if (!state.isAnalyzing) {
    if (!hasImage) els.progressText.textContent = '请先上传图片';
    else if (!hasRoi) els.progressText.textContent = '已上传图片，请在图上拖动画 ROI';
    else if (!hasRegions) els.progressText.textContent = 'ROI 已绘制，请生成网格';
    else if (!hasResults) els.progressText.textContent = '网格已生成，可进行本地分割或手动修正';
  }
}

// init() is called at the end after all modules are defined.

function init() {
  checkServer();
  bindEvents();
  updateScaleHint();
  draw();
  updateAiActionStates();
  initTabs();
  initManualSampling();
}

async function checkServer() {
  try {
    const res = await fetch('/api/health');
    await res.json();
    els.serverStatus.textContent = '本地 ImageJ 风格分割 · TIFF 服务正常';
    els.serverStatus.className = 'status ok';
  } catch (_) {
    els.serverStatus.textContent = '本地分割可用 · TIFF 服务未连接';
    els.serverStatus.className = 'status warn';
  }
}

function bindEvents() {
  els.imageInput.addEventListener('change', loadImage);
  bindDropUpload();
  els.scaleUm.addEventListener('input', () => { updateScaleHint(); recomputeManualDerived(); });
  els.scalePx.addEventListener('input', () => { updateScaleHint(); recomputeManualDerived(); });

  els.drawModeBtn.addEventListener('click', () => setToolMode('draw'));
  els.selectModeBtn.addEventListener('click', () => setToolMode('select'));
  els.roiRectBtn.addEventListener('click', () => setRoiType('rect'));
  els.roiCircleBtn.addEventListener('click', () => setRoiType('circle'));
  els.makeGridBtn.addEventListener('click', makeGrid);
  els.analyzeAllBtn.addEventListener('click', analyzeAllRegions);
  els.analyzeOneBtn.addEventListener('click', analyzeSelectedRegion);
  els.clearBtn.addEventListener('click', clearResults);
  els.applyManualBtn.addEventListener('click', applyManualToSelected);
  els.modeSelect.addEventListener('change', () => {
    const r = selectedRegion();
    if (!r) return;
    const existing = state.results[r.id] || blankResult(r);
    existing.mode = els.modeSelect.value;
    state.results[r.id] = existing;
    updateTableAndSummary();
    draw();
    updateAiActionStates();
  });

  els.exportCsvBtn.addEventListener('click', exportCsv);
  els.exportJsonBtn.addEventListener('click', exportJson);
  els.exportPngBtn.addEventListener('click', () => exportContourImage('png'));
  els.exportJpegBtn.addEventListener('click', () => exportContourImage('jpeg'));
  els.exportTiffBtn.addEventListener('click', () => exportContourImage('tiff'));

  els.fitViewBtn.addEventListener('click', () => setZoom('fit'));
  els.actualSizeBtn.addEventListener('click', () => setZoom(1));
  els.zoomOutBtn.addEventListener('click', () => setZoom(Math.max(0.05, state.zoom * 0.8)));
  els.zoomInBtn.addEventListener('click', () => setZoom(Math.min(4, state.zoom * 1.25)));
  window.addEventListener('resize', updateCanvasZoom);

  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('click', onCanvasClick);
}

function bindDropUpload() {
  if (!els.dropZone) return;
  const stop = (evt) => {
    evt.preventDefault();
    evt.stopPropagation();
  };
  ['dragenter', 'dragover'].forEach(name => {
    els.dropZone.addEventListener(name, (evt) => {
      stop(evt);
      els.dropZone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach(name => {
    els.dropZone.addEventListener(name, (evt) => {
      stop(evt);
      els.dropZone.classList.remove('dragover');
    });
  });
  els.dropZone.addEventListener('drop', (evt) => {
    const file = evt.dataTransfer?.files?.[0];
    if (file) handleImageFile(file);
  });
  els.dropZone.addEventListener('keydown', (evt) => {
    if (evt.key === 'Enter' || evt.key === ' ') {
      evt.preventDefault();
      els.imageInput.click();
    }
  });
}

function setToolMode(mode) {
  state.toolMode = mode;
  els.drawModeBtn.classList.toggle('active', mode === 'draw');
  els.selectModeBtn.classList.toggle('active', mode === 'select');
  document.body.classList.toggle('selecting', mode === 'select');
  if (mode === 'select') {
    els.progressText.textContent = '选择模式：点击图中任意小区域即可修改。';
  } else {
    els.progressText.textContent = '绘制模式：按住鼠标拖动可重新画 ROI。';
  }
  updateAiActionStates();
}

function setZoom(modeOrValue) {
  state.zoomMode = modeOrValue;
  updateCanvasZoom();
}

function updateCanvasZoom() {
  if (!canvas.width || !canvas.height) return;
  let zoom;
  if (state.zoomMode === 'fit') {
    const shell = els.canvasShell;
    const availableW = Math.max(100, shell.clientWidth - 32);
    const availableH = Math.max(100, shell.clientHeight - 32);
    zoom = Math.min(1, availableW / canvas.width, availableH / canvas.height);
    zoom = clamp(zoom, 0.03, 1);
  } else {
    zoom = Number(state.zoomMode) || 1;
  }
  state.zoom = zoom;
  canvas.style.width = `${Math.max(1, Math.round(canvas.width * zoom))}px`;
  canvas.style.height = `${Math.max(1, Math.round(canvas.height * zoom))}px`;
  const modeText = state.zoomMode === 'fit' ? '适应屏幕' : '原图比例';
  els.zoomHint.textContent = state.image
    ? `${modeText} · 当前显示 ${Math.round(zoom * 100)}% · 图像像素 ${canvas.width} × ${canvas.height}`
    : '未加载图片';
}

function setRoiType(type) {
  state.roiType = type;
  els.roiRectBtn.classList.toggle('active', type === 'rect');
  els.roiCircleBtn.classList.toggle('active', type === 'circle');
}

function updateScaleHint() {
  const pxSize = getPixelSizeUm();
  if (!pxSize) {
    els.scaleHint.textContent = '请正确输入 scale bar 实际长度和像素长度。';
  } else {
    els.scaleHint.textContent = `1 pixel = ${pxSize.toFixed(4)} μm；1 pixel² = ${(pxSize * pxSize).toFixed(4)} μm²`;
  }
}

function getPixelSizeUm() {
  const um = Number(els.scaleUm.value);
  const px = Number(els.scalePx.value);
  if (!Number.isFinite(um) || !Number.isFinite(px) || um <= 0 || px <= 0) return 0;
  return um / px;
}

function loadImage(event) {
  const file = event.target.files?.[0];
  if (file) handleImageFile(file);
}

async function handleImageFile(file) {
  if (!isSupportedImageFile(file)) {
    showNotice('请上传图片文件，支持 PNG/JPEG/TIF/TIFF。', 'warn');
    return;
  }
  state.imageName = file.name.replace(/\.[^.]+$/, '') || 'image';
  if (els.imageNameHint) els.imageNameHint.textContent = `正在加载：${file.name}`;
  try {
    const sourceUrl = await imageFileToLoadableUrl(file);
    const revokeAfterLoad = sourceUrl.startsWith('blob:');
    const img = new Image();
    img.onload = () => {
      state.image = img;
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      state.roi = null;
      state.regions = [];
      state.results = {};
      state.selectedRegionId = null;
      clearManualPanel();
      if (revokeAfterLoad) URL.revokeObjectURL(sourceUrl);
      if (els.imageNameHint) els.imageNameHint.textContent = `已选择：${file.name}${isTiffFile(file) ? '（已转换为 PNG 显示）' : ''}`;
      state.zoomMode = 'fit';
      setToolMode('draw');
      draw();
      updateCanvasZoom();
      updateTableAndSummary();
      updateAiActionStates();
      showNotice('图片已加载。现在可以在图上拖动画 ROI。');
    };
    img.onerror = () => showNotice('图片加载失败。该文件可能不是标准图片，或 TIFF 格式无法解析。', 'error');
    img.src = sourceUrl;
  } catch (err) {
    showNotice(err.message || '图片加载失败', 'error');
    if (els.imageNameHint) els.imageNameHint.textContent = '未选择文件';
    updateAiActionStates();
  }
}

function isTiffFile(file) {
  return /\.(tif|tiff)$/i.test(file?.name || '') || /tiff/i.test(file?.type || '');
}

function isSupportedImageFile(file) {
  return Boolean(file) && (file.type.startsWith('image/') || /\.(tif|tiff|png|jpe?g)$/i.test(file.name));
}

async function imageFileToLoadableUrl(file) {
  if (!isTiffFile(file)) return URL.createObjectURL(file);
  const res = await fetch('/api/convert-tiff', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: await file.arrayBuffer()
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.dataUrl) {
    throw new Error(data.error || 'TIFF 转换失败。可以先用 ImageJ/Fiji 导出为 PNG 后再上传。');
  }
  return data.dataUrl;
}

function canvasPoint(evt) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (evt.clientX - rect.left) * (canvas.width / rect.width),
    y: (evt.clientY - rect.top) * (canvas.height / rect.height)
  };
}

function onMouseDown(evt) {
  if (!state.image) return;
  const p = canvasPoint(evt);
  if (state.toolMode === 'select') {
    selectRegionAtPoint(p);
    state.isDrawing = false;
    state.dragStart = null;
    return;
  }
  state.isDrawing = true;
  state.dragStart = p;
}

function onMouseMove(evt) {
  if (!state.isDrawing || !state.dragStart || state.toolMode !== 'draw') return;
  const p = canvasPoint(evt);
  if (Math.hypot(p.x - state.dragStart.x, p.y - state.dragStart.y) < 3) return;
  state.roi = normalizeRoi(state.dragStart, p, state.roiType);
  state.regions = [];
  state.results = {};
  state.selectedRegionId = null;
  draw();
  updateAiActionStates();
}

function onMouseUp(evt) {
  if (!state.isDrawing || state.toolMode !== 'draw') return;
  state.isDrawing = false;
  const p = canvasPoint(evt);
  if (Math.hypot(p.x - state.dragStart.x, p.y - state.dragStart.y) < 3) {
    state.dragStart = null;
    return;
  }
  state.roi = normalizeRoi(state.dragStart, p, state.roiType);
  state.dragStart = null;
  draw();
  updateAiActionStates();
}

function onCanvasClick(evt) {
  if (state.isDrawing || !state.regions.length || state.toolMode !== 'select') return;
  selectRegionAtPoint(canvasPoint(evt));
}

function selectRegionAtPoint(p) {
  const region = state.regions.find(r => r.valid && pointInRegion(p.x, p.y, r) && pointInsideRoi(p.x, p.y));
  if (region) selectRegion(region.id);
}

function normalizeRoi(a, b, type) {
  let x = Math.min(a.x, b.x);
  let y = Math.min(a.y, b.y);
  let w = Math.abs(a.x - b.x);
  let h = Math.abs(a.y - b.y);
  if (type === 'circle') {
    const s = Math.max(w, h);
    if (b.x < a.x) x = a.x - s;
    if (b.y < a.y) y = a.y - s;
    w = s;
    h = s;
  }
  x = clamp(x, 0, canvas.width);
  y = clamp(y, 0, canvas.height);
  w = clamp(w, 1, canvas.width - x);
  h = clamp(h, 1, canvas.height - y);
  return { type, x, y, w, h };
}

function makeGrid() {
  if (!state.roi) {
    showNotice('请先在图上画 ROI。', 'warn');
    return;
  }
  const rows = clampInt(Number(els.gridRows.value), 1, 20);
  const cols = clampInt(Number(els.gridCols.value), 1, 20);
  const regions = [];
  const cellW = state.roi.w / cols;
  const cellH = state.roi.h / rows;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const id = `${letterName(row)}${col + 1}`;
      const r = {
        id,
        row,
        col,
        x: state.roi.x + col * cellW,
        y: state.roi.y + row * cellH,
        w: cellW,
        h: cellH
      };
      r.effectiveAreaPixels = estimateEffectiveArea(r);
      r.valid = r.effectiveAreaPixels > 1;
      regions.push(r);
    }
  }
  state.regions = regions;
  state.results = {};
  state.selectedRegionId = regions.find(r => r.valid)?.id || null;
  setToolMode('select');
  syncManualPanel();
  updateTableAndSummary();
  draw();
  updateAiActionStates();
  showNotice(`已生成 ${rows} × ${cols} 网格，可点击小格查看或修正。`);
}

function letterName(index) {
  let n = index;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

function estimateEffectiveArea(region) {
  if (!state.roi) return 0;
  if (state.roi.type === 'rect') return region.w * region.h;
  const maxSamplesPerAxis = 180;
  const sx = Math.max(3, Math.min(maxSamplesPerAxis, Math.ceil(region.w / 4)));
  const sy = Math.max(3, Math.min(maxSamplesPerAxis, Math.ceil(region.h / 4)));
  let inside = 0;
  const total = sx * sy;
  for (let iy = 0; iy < sy; iy++) {
    for (let ix = 0; ix < sx; ix++) {
      const x = region.x + (ix + 0.5) * region.w / sx;
      const y = region.y + (iy + 0.5) * region.h / sy;
      if (pointInsideRoi(x, y)) inside++;
    }
  }
  return region.w * region.h * (inside / total);
}

function pointInsideRoi(x, y) {
  const roi = state.roi;
  if (!roi) return false;
  if (roi.type === 'rect') {
    return x >= roi.x && x <= roi.x + roi.w && y >= roi.y && y <= roi.y + roi.h;
  }
  const cx = roi.x + roi.w / 2;
  const cy = roi.y + roi.h / 2;
  const radius = roi.w / 2;
  return ((x - cx) ** 2 + (y - cy) ** 2) <= radius ** 2;
}

function pointInRegion(x, y, r) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

function selectRegion(id) {
  state.selectedRegionId = id;
  syncManualPanel();
  updateTableAndSummary();
  draw();
  updateAiActionStates();
}

function selectedRegion() {
  return state.regions.find(r => r.id === state.selectedRegionId) || null;
}

function syncManualPanel() {
  const r = selectedRegion();
  if (!r) return clearManualPanel();
  const res = state.results[r.id] || blankResult(r);
  els.selectedRegion.value = r.id;
  els.modeSelect.value = res.mode || 'imagej';
  els.manualCount.value = Number.isFinite(res.cell_count) ? res.cell_count : '';
  els.manualMeanArea.value = Number.isFinite(res.mean_cell_area_um2) ? round(res.mean_cell_area_um2, 2) : '';
  updateAiActionStates();
}

function clearManualPanel() {
  els.selectedRegion.value = '';
  els.modeSelect.value = 'imagej';
  els.manualCount.value = '';
  els.manualMeanArea.value = '';
  updateAiActionStates();
}

function blankResult(region) {
  return {
    region_id: region.id,
    mode: 'imagej',
    cell_count: 0,
    total_cell_area_um2: 0,
    mean_cell_area_um2: 0,
    coverage_percent: 0,
    cells: [],
    warnings: []
  };
}

async function analyzeAllRegions() {
  if (!state.regions.length) {
    showNotice('请先生成网格。', 'warn');
    return;
  }
  const regions = state.regions.filter(r => r.valid);
  if (!regions.length) {
    showNotice('没有有效区域。', 'warn');
    return;
  }
  state.isAnalyzing = true;
  updateAiActionStates();
  els.progress.max = regions.length;
  els.progress.value = 0;
  let completed = 0;
  els.progressText.textContent = `本地分割中 0/${regions.length}`;
  for (const region of regions) {
    await analyzeRegion(region);
    completed += 1;
    els.progress.value = completed;
    els.progressText.textContent = `本地分割中 ${completed}/${regions.length}`;
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
  state.isAnalyzing = false;
  els.progressText.textContent = '分析完成';
  updateAiActionStates();
  showNotice('全部有效区域分析完成。');
}

async function analyzeSelectedRegion() {
  const r = selectedRegion();
  if (!r) {
    showNotice('请先点击选择一个区域。', 'warn');
    return;
  }
  if (!r.valid) {
    showNotice('这个区域几乎完全在 ROI 外，不能分析。', 'warn');
    return;
  }
  state.isAnalyzing = true;
  updateAiActionStates();
  els.progress.max = 1;
  els.progress.value = 0;
  els.progressText.textContent = `正在分析 ${r.id}…`;
  await analyzeRegion(r);
  state.isAnalyzing = false;
  els.progress.value = 1;
  els.progressText.textContent = `${r.id} 分析完成`;
  updateAiActionStates();
  showNotice(`${r.id} 分析完成。`);
}

async function analyzeRegion(region) {
  try {
    const backgroundRadius = Number(els.backgroundRadius.value);
    const maxCellArea = Number(els.maxCellArea.value);
    const padding = clamp(Math.max(backgroundRadius * 2, Math.sqrt(Math.max(1, maxCellArea) / Math.PI) * 0.5), 16, 160);
    const crop = cropRegion(region, padding);
    if (!window.ImageJSegmentation?.segmentImageData) throw new Error('本地分割模块未加载');
    await new Promise(resolve => requestAnimationFrame(resolve));
    const result = window.ImageJSegmentation.segmentImageData(crop.imageData, {
      imageType: els.imageType.value,
      validMask: crop.validMask,
      backgroundRadius,
      thresholdOffset: Number(els.thresholdOffset.value),
      minArea: Number(els.minCellArea.value),
      maxArea: maxCellArea,
      watershed: Boolean(els.watershedCells.checked)
    });
    const pixelSizeUm = getPixelSizeUm();
    const areaFactor = pixelSizeUm > 0 ? pixelSizeUm * pixelSizeUm : 0;
    const assignedCells = result.cells
      .filter(cell => {
        const globalX = crop.x + cell.center_x;
        const globalY = crop.y + cell.center_y;
        return globalX >= region.x && globalX < region.x + region.w
          && globalY >= region.y && globalY < region.y + region.h
          && pointInsideRoi(globalX, globalY);
      })
      .map((cell, index) => ({
        ...cell,
        cell_id: index + 1,
        center_x: crop.x + cell.center_x - region.x,
        center_y: crop.y + cell.center_y - region.y,
        contour: cell.contour.map(([x, y]) => [crop.x + x - region.x, crop.y + y - region.y]),
        area_um2: areaFactor ? cell.area_pixels * areaFactor : null
      }));
    const totalAreaPixels = assignedCells.reduce((sum, cell) => sum + cell.area_pixels, 0);
    const meanAreaPixels = assignedCells.length ? totalAreaPixels / assignedCells.length : 0;
    const data = {
      ok: true,
      mock: false,
      model: 'imagej-local',
      method: result.method,
      region_id: region.id,
      cell_count: assignedCells.length,
      total_cell_area_pixels: totalAreaPixels,
      mean_cell_area_pixels: meanAreaPixels,
      total_cell_area_um2: areaFactor ? totalAreaPixels * areaFactor : null,
      mean_cell_area_um2: areaFactor ? meanAreaPixels * areaFactor : null,
      coverage_percent: region.effectiveAreaPixels > 0 ? totalAreaPixels / region.effectiveAreaPixels * 100 : 0,
      threshold: result.threshold,
      polarity: result.polarity,
      cells: assignedCells,
      warnings: result.warnings,
      mode: 'imagej'
    };
    state.results[region.id] = data;
    if (!state.selectedRegionId) state.selectedRegionId = region.id;
    syncManualPanel();
    updateTableAndSummary();
    draw();
  } catch (err) {
    state.results[region.id] = {
      ...blankResult(region),
      mode: 'imagej',
      warnings: [err.message]
    };
    showNotice(`${region.id} 分析失败：${err.message}`, 'warn');
    updateTableAndSummary();
    draw();
  }
}

function cropRegion(region, padding = 0) {
  const x0 = Math.max(0, Math.floor(region.x - padding));
  const y0 = Math.max(0, Math.floor(region.y - padding));
  const x1 = Math.min(state.image.naturalWidth, Math.ceil(region.x + region.w + padding));
  const y1 = Math.min(state.image.naturalHeight, Math.ceil(region.y + region.h + padding));
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const octx = off.getContext('2d');
  octx.fillStyle = 'white';
  octx.fillRect(0, 0, w, h);
  octx.save();
  if (state.roi?.type === 'circle') {
    octx.beginPath();
    const cx = state.roi.x + state.roi.w / 2 - x0;
    const cy = state.roi.y + state.roi.h / 2 - y0;
    octx.arc(cx, cy, state.roi.w / 2, 0, Math.PI * 2);
    octx.clip();
  }
  octx.drawImage(state.image, x0, y0, w, h, 0, 0, w, h);
  octx.restore();
  const validMask = new Uint8Array(w * h);
  if (state.roi?.type === 'circle') {
    const cx = state.roi.x + state.roi.w / 2 - x0;
    const cy = state.roi.y + state.roi.h / 2 - y0;
    const radius = state.roi.w / 2;
    const radius2 = radius * radius;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        validMask[y * w + x] = ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= radius2) ? 1 : 0;
      }
    }
  } else {
    validMask.fill(1);
  }
  return { x: x0, y: y0, width: w, height: h, imageData: octx.getImageData(0, 0, w, h), validMask };
}

function applyManualToSelected() {
  const r = selectedRegion();
  if (!r) {
    showNotice('请先选择一个区域。', 'warn');
    return;
  }
  const count = Math.max(0, Math.round(Number(els.manualCount.value || 0)));
  const mean = Math.max(0, Number(els.manualMeanArea.value || 0));
  const mode = els.modeSelect.value === 'imagej' ? 'manual_corrected' : els.modeSelect.value;
  const total = count * mean;
  const areaUm2 = regionAreaUm2(r);
  const previous = state.results[r.id] || blankResult(r);
  state.results[r.id] = {
    ...previous,
    mode,
    cell_count: count,
    mean_cell_area_um2: mean,
    total_cell_area_um2: total,
    coverage_percent: areaUm2 > 0 ? (total / areaUm2) * 100 : 0,
    warnings: previous.warnings || []
  };
  els.modeSelect.value = mode;
  updateTableAndSummary();
  draw();
  updateAiActionStates();
  showNotice(`${r.id} 已应用手动修正。`);
}

function recomputeManualDerived() {
  for (const r of state.regions) {
    const res = state.results[r.id];
    if (!res) continue;
    if (res.mode === 'manual_override' || res.mode === 'manual_corrected') {
      const total = Number(res.cell_count || 0) * Number(res.mean_cell_area_um2 || 0);
      res.total_cell_area_um2 = total;
      const areaUm2 = regionAreaUm2(r);
      res.coverage_percent = areaUm2 > 0 ? (total / areaUm2) * 100 : 0;
    }
  }
  updateTableAndSummary();
}

function regionAreaUm2(region) {
  const px = getPixelSizeUm();
  return px ? region.effectiveAreaPixels * px * px : 0;
}

function clearResults() {
  state.results = {};
  els.progress.value = 0;
  els.progressText.textContent = '结果已清空';
  syncManualPanel();
  updateTableAndSummary();
  draw();
  updateAiActionStates();
  showNotice('结果已清空。');
}

function updateTableAndSummary() {
  const pixelSize = getPixelSizeUm();
  const tableRows = [];
  let totalCount = 0;
  let totalArea = 0;
  let totalEffectiveArea = 0;

  for (const r of state.regions) {
    if (!r.valid) continue;
    const res = state.results[r.id] || blankResult(r);
    const count = Number(res.cell_count || 0);
    const totalUm2 = Number.isFinite(res.total_cell_area_um2) && res.total_cell_area_um2 !== null
      ? Number(res.total_cell_area_um2)
      : Number(res.total_cell_area_pixels || 0) * pixelSize * pixelSize;
    const meanUm2 = count > 0 ? totalUm2 / count : Number(res.mean_cell_area_um2 || 0);
    const effectiveUm2 = regionAreaUm2(r);
    const cov = effectiveUm2 > 0 ? (totalUm2 / effectiveUm2) * 100 : 0;

    totalCount += count;
    totalArea += totalUm2;
    totalEffectiveArea += effectiveUm2;

    tableRows.push({ r, res, count, totalUm2, meanUm2, cov });
  }

  const overallMean = totalCount > 0 ? totalArea / totalCount : 0;
  const overallCov = totalEffectiveArea > 0 ? totalArea / totalEffectiveArea * 100 : 0;

  els.totalCount.textContent = String(totalCount);
  els.totalArea.textContent = `${formatNum(totalArea)} μm²`;
  els.meanArea.textContent = `${formatNum(overallMean)} μm²`;
  els.coverage.textContent = `${formatNum(overallCov)}%`;

  els.resultTableBody.innerHTML = tableRows.map(({ r, res, count, totalUm2, meanUm2, cov }) => {
    const mode = res.mode || 'imagej';
    const badgeClass = mode === 'manual_override' ? 'override' : (mode === 'manual_corrected' ? 'manual' : '');
    const modeLabel = mode === 'manual_override' ? '手动覆盖' : (mode === 'manual_corrected' ? '手动修正' : 'ImageJ风格');
    const warnings = (res.warnings || []).join('；');
    return `<tr class="${r.id === state.selectedRegionId ? 'selected' : ''}" data-id="${r.id}">
      <td>${r.id}</td>
      <td><span class="badge ${badgeClass}">${modeLabel}</span></td>
      <td>${count}</td>
      <td>${formatNum(totalUm2)}</td>
      <td>${formatNum(meanUm2)}</td>
      <td>${formatNum(cov)}%</td>
      <td>${escapeHtml(warnings)}</td>
    </tr>`;
  }).join('');

  document.querySelectorAll('#resultTable tbody tr').forEach(tr => {
    tr.addEventListener('click', () => selectRegion(tr.dataset.id));
  });
  if (els.aiTableEmpty) {
    els.aiTableEmpty.classList.toggle('hidden', tableRows.length > 0);
  }
  updateAiActionStates();
}

function draw() {
  ctx.clearRect(0, 0, canvas.width || 1, canvas.height || 1);
  if (!state.image) {
    canvas.width = 1200;
    canvas.height = 720;
    ctx.fillStyle = '#0b1020';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#e5e7eb';
    ctx.font = '28px system-ui';
    ctx.fillText('请先上传显微镜图片', 430, 330);
    updateCanvasZoom();
    return;
  }

  ctx.drawImage(state.image, 0, 0);
  drawRoi();
  drawGrid();
  drawContoursOnMain();
}

function drawRoi() {
  if (!state.roi) return;
  ctx.save();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#2563eb';
  ctx.setLineDash([10, 8]);
  pathRoi(ctx, state.roi);
  ctx.stroke();
  ctx.restore();
}

function drawGrid() {
  if (!state.regions.length) return;
  ctx.save();
  ctx.lineWidth = 2;
  ctx.font = '16px system-ui';
  ctx.textBaseline = 'top';
  for (const r of state.regions) {
    if (!r.valid) continue;
    ctx.strokeStyle = r.id === state.selectedRegionId ? '#f97316' : '#22c55e';
    ctx.fillStyle = r.id === state.selectedRegionId ? 'rgba(249, 115, 22, 0.16)' : 'rgba(34, 197, 94, 0.08)';
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#111827';
    ctx.lineWidth = 4;
    ctx.strokeText(r.id, r.x + 7, r.y + 6);
    ctx.fillText(r.id, r.x + 7, r.y + 6);
  }
  ctx.restore();
}

function drawContoursOnMain() {
  ctx.save();
  ctx.lineWidth = 2;
  ctx.font = '14px system-ui';
  for (const r of state.regions) {
    const res = state.results[r.id];
    if (!res?.cells?.length) continue;
    for (const cell of res.cells) {
      if (Array.isArray(cell.contour) && cell.contour.length >= 3) {
        ctx.strokeStyle = '#ef4444';
        ctx.beginPath();
        cell.contour.forEach(([x, y], i) => {
          const gx = r.x + x;
          const gy = r.y + y;
          if (i === 0) ctx.moveTo(gx, gy); else ctx.lineTo(gx, gy);
        });
        ctx.closePath();
        ctx.stroke();
      }
      ctx.fillStyle = '#ef4444';
      ctx.fillText(String(cell.cell_id), r.x + cell.center_x + 3, r.y + cell.center_y + 3);
    }
  }
  ctx.restore();
}

function pathRoi(c, roi) {
  c.beginPath();
  if (roi.type === 'rect') c.rect(roi.x, roi.y, roi.w, roi.h);
  else c.arc(roi.x + roi.w / 2, roi.y + roi.h / 2, roi.w / 2, 0, Math.PI * 2);
}

function exportCsv() {
  if (!state.regions.some(r => r.valid)) {
    showNotice('请先生成网格，再导出 CSV。', 'warn');
    return;
  }
  const rows = [
    ['region_id', 'mode', 'cell_count', 'total_cell_area_um2', 'mean_cell_area_um2', 'coverage_percent', 'effective_area_um2', 'warnings']
  ];
  for (const r of state.regions.filter(r => r.valid)) {
    const res = state.results[r.id] || blankResult(r);
    const count = Number(res.cell_count || 0);
    const total = Number(res.total_cell_area_um2 || 0);
    const mean = count > 0 ? total / count : Number(res.mean_cell_area_um2 || 0);
    rows.push([
      r.id,
      res.mode || 'imagej',
      count,
      total,
      mean,
      Number(res.coverage_percent || 0),
      regionAreaUm2(r),
      (res.warnings || []).join('; ')
    ]);
  }
  const csv = rows.map(row => row.map(csvCell).join(',')).join('\n');
  downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${state.imageName}_cell_results.csv`);
}

function exportJson() {
  if (!state.regions.length && !hasAiResults()) {
    showNotice('暂无可导出的分区分析项目。', 'warn');
    return;
  }
  const payload = {
    image_name: state.imageName,
    image_type: els.imageType.value,
    segmentation: {
      method: 'imagej_local',
      background_radius_px: Number(els.backgroundRadius.value),
      threshold_offset: Number(els.thresholdOffset.value),
      min_cell_area_px2: Number(els.minCellArea.value),
      max_cell_area_px2: Number(els.maxCellArea.value),
      watershed: Boolean(els.watershedCells.checked)
    },
    pixel_size_um: getPixelSizeUm(),
    roi: state.roi,
    regions: state.regions,
    results: state.results,
    summary: getSummaryObject()
  };
  downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `${state.imageName}_cell_results.json`);
}

function getSummaryObject() {
  let totalCount = 0;
  let totalArea = 0;
  let totalEffectiveArea = 0;
  for (const r of state.regions.filter(r => r.valid)) {
    const res = state.results[r.id] || blankResult(r);
    totalCount += Number(res.cell_count || 0);
    totalArea += Number(res.total_cell_area_um2 || 0);
    totalEffectiveArea += regionAreaUm2(r);
  }
  return {
    total_cell_count: totalCount,
    total_cell_area_um2: totalArea,
    mean_cell_area_um2: totalCount > 0 ? totalArea / totalCount : 0,
    coverage_percent: totalEffectiveArea > 0 ? totalArea / totalEffectiveArea * 100 : 0
  };
}

function exportContourImage(format) {
  if (!state.image) {
    showNotice('请先上传图片。', 'warn');
    return;
  }
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const o = out.getContext('2d');
  o.fillStyle = 'white';
  o.fillRect(0, 0, out.width, out.height);
  o.strokeStyle = 'black';
  o.fillStyle = 'black';
  o.lineWidth = Math.max(2, Math.round(out.width / 1200));
  o.font = `${Math.max(12, Math.round(out.width / 110))}px Arial`;

  let globalId = 1;
  for (const r of state.regions) {
    const res = state.results[r.id];
    if (!res?.cells?.length) continue;
    for (const cell of res.cells) {
      if (Array.isArray(cell.contour) && cell.contour.length >= 3) {
        o.beginPath();
        cell.contour.forEach(([x, y], i) => {
          const gx = r.x + x;
          const gy = r.y + y;
          if (i === 0) o.moveTo(gx, gy); else o.lineTo(gx, gy);
        });
        o.closePath();
        o.stroke();
      }
      o.fillText(String(globalId++), r.x + cell.center_x + 4, r.y + cell.center_y + 4);
    }
  }

  if (format === 'png') {
    out.toBlob(blob => downloadBlob(blob, `${state.imageName}_contours_numbered.png`), 'image/png');
  } else if (format === 'jpeg') {
    out.toBlob(blob => downloadBlob(blob, `${state.imageName}_contours_numbered.jpg`), 'image/jpeg', 0.96);
  } else if (format === 'tiff') {
    const blob = canvasToTiffBlob(out);
    downloadBlob(blob, `${state.imageName}_contours_numbered.tif`);
  }
}

function canvasToTiffBlob(c) {
  const w = c.width;
  const h = c.height;
  const img = c.getContext('2d').getImageData(0, 0, w, h).data;
  const rgbSize = w * h * 3;
  const numTags = 10;
  const ifdOffset = 8;
  const ifdSize = 2 + numTags * 12 + 4;
  const bitsOffset = ifdOffset + ifdSize;
  const dataOffset = bitsOffset + 6;
  const buffer = new ArrayBuffer(dataOffset + rgbSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  bytes[0] = 0x49; bytes[1] = 0x49; // little-endian II
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOffset, true);
  view.setUint16(ifdOffset, numTags, true);

  let p = ifdOffset + 2;
  function tag(id, type, count, value) {
    view.setUint16(p, id, true);
    view.setUint16(p + 2, type, true);
    view.setUint32(p + 4, count, true);
    view.setUint32(p + 8, value, true);
    p += 12;
  }
  tag(256, 4, 1, w);              // ImageWidth LONG
  tag(257, 4, 1, h);              // ImageLength LONG
  tag(258, 3, 3, bitsOffset);     // BitsPerSample SHORT[3]
  tag(259, 3, 1, 1);              // Compression none
  tag(262, 3, 1, 2);              // Photometric RGB
  tag(273, 4, 1, dataOffset);     // StripOffsets
  tag(277, 3, 1, 3);              // SamplesPerPixel
  tag(278, 4, 1, h);              // RowsPerStrip
  tag(279, 4, 1, rgbSize);        // StripByteCounts
  tag(284, 3, 1, 1);              // PlanarConfiguration chunky
  view.setUint32(p, 0, true);     // next IFD

  view.setUint16(bitsOffset, 8, true);
  view.setUint16(bitsOffset + 2, 8, true);
  view.setUint16(bitsOffset + 4, 8, true);

  let j = dataOffset;
  for (let i = 0; i < img.length; i += 4) {
    bytes[j++] = img[i];
    bytes[j++] = img[i + 1];
    bytes[j++] = img[i + 2];
  }
  return new Blob([buffer], { type: 'image/tiff' });
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function csvCell(value) {
  const s = String(value ?? '');
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function clampInt(value, min, max) { return Math.max(min, Math.min(max, Math.round(value || min))); }
function round(n, digits) { return Math.round(n * 10 ** digits) / 10 ** digits; }
function formatNum(n) { return Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 }); }
function escapeHtml(s) { return String(s).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])); }

/* -----------------------------
   Page tabs
----------------------------- */
function initTabs() {
  const aiTab = $('aiTabBtn');
  const manualTab = $('manualTabBtn');
  const aiPage = $('aiPage');
  const manualPage = $('manualPage');
  if (!aiTab || !manualTab || !aiPage || !manualPage) return;

  aiTab.addEventListener('click', () => {
    aiTab.classList.add('active');
    manualTab.classList.remove('active');
    aiPage.classList.remove('hidden');
    aiPage.classList.add('activePage');
    manualPage.classList.add('hidden');
    manualPage.classList.remove('activePage');
    window.scrollTo(0, 0);
    const controls = aiPage.querySelector('.controls');
    if (controls) controls.scrollTop = 0;
    updateCanvasZoom();
    updateAiActionStates();
  });

  manualTab.addEventListener('click', () => {
    manualTab.classList.add('active');
    aiTab.classList.remove('active');
    manualPage.classList.remove('hidden');
    manualPage.classList.add('activePage');
    aiPage.classList.add('hidden');
    aiPage.classList.remove('activePage');
    window.scrollTo(0, 0);
    const controls = manualPage.querySelector('.controls');
    if (controls) controls.scrollTop = 0;
    manualUpdateCanvasZoom();
    manualDraw();
    manualUpdateActionStates();
  });
}

/* -----------------------------
   Manual sampling estimation page
----------------------------- */
const manualColors = ['#ef4444', '#2563eb', '#22c55e', '#f59e0b', '#a855f7', '#06b6d4', '#ec4899', '#84cc16'];
// v8: 画布和导出图片默认不显示编号/文字标签，避免遮挡细胞边界。
const MANUAL_SHOW_CANVAS_TEXT = false;

const manualState = {
  image: null,
  imageName: 'image',
  groups: [
    { id: 'G1', color: manualColors[0], name: '高密度区域' },
    { id: 'G2', color: manualColors[1], name: '中密度区域' },
    { id: 'G3', color: manualColors[2], name: '低密度区域' }
  ],
  currentGroupId: 'G1',
  objects: [],
  selectedObjectId: null,
  mode: 'sample',
  shape: 'free',
  isDrawing: false,
  activePointerId: null,
  dragStart: null,
  currentPath: [],
  zoomMode: 'fit',
  zoom: 1,
  nextCounters: { sample: 1, cell: 1, target: 1, stroke: 1 }
};

let manualCanvas;
let manualCtx;
let mels;

function initManualSampling() {
  manualCanvas = $('manualCanvas');
  if (!manualCanvas) return;
  manualCtx = manualCanvas.getContext('2d');
  mels = {
    imageInput: $('manualImageInput'),
    dropZone: $('manualDropZone'),
    imageNameHint: $('manualImageNameHint'),
    scaleUm: $('manualScaleUm'),
    scalePx: $('manualScalePx'),
    scaleHint: $('manualScaleHint'),
    groupSelect: $('manualGroupSelect'),
    groupName: $('manualGroupName'),
    addGroupBtn: $('manualAddGroupBtn'),
    applyGroupNameBtn: $('manualApplyGroupNameBtn'),
    shapeSelect: $('manualShapeSelect'),
    fitBtn: $('manualFitBtn'),
    actualBtn: $('manualActualBtn'),
    zoomOutBtn: $('manualZoomOutBtn'),
    zoomInBtn: $('manualZoomInBtn'),
    zoomHint: $('manualZoomHint'),
    canvasShell: $('manualCanvasShell'),
    showSamples: $('showManualSamples'),
    showTargets: $('showManualTargets'),
    showCells: $('showManualCells'),
    showLabels: $('showManualLabels'),
    undoBtn: $('manualUndoBtn'),
    deleteBtn: $('manualDeleteBtn'),
    clearGroupBtn: $('manualClearGroupBtn'),
    clearAllBtn: $('manualClearAllBtn'),
    selectedInfo: $('manualSelectedInfo'),
    exportCsvBtn: $('manualExportCsvBtn'),
    exportJsonBtn: $('manualExportJsonBtn'),
    exportAnnotatedPngBtn: $('manualExportAnnotatedPngBtn'),
    exportContourPngBtn: $('manualExportContourPngBtn'),
    exportTiffBtn: $('manualExportTiffBtn'),
    totalCount: $('manualTotalCount'),
    totalSpread: $('manualTotalSpread'),
    meanSpread: $('manualMeanSpread'),
    coverage: $('manualCoverage'),
    qcHint: $('manualQcHint'),
    groupTableBody: document.querySelector('#manualGroupTable tbody'),
    objectTableBody: document.querySelector('#manualObjectTable tbody'),
    objectEmpty: $('manualObjectEmpty')
  };

  bindManualEvents();
  manualSyncGroupSelect();
  manualUpdateScaleHint();
  manualDraw();
  manualUpdateResults();
  manualUpdateActionStates();
}

function bindManualEvents() {
  mels.imageInput.addEventListener('change', (evt) => {
    const file = evt.target.files?.[0];
    if (file) manualHandleImageFile(file);
  });
  manualBindDropUpload();
  mels.scaleUm.addEventListener('input', () => { manualUpdateScaleHint(); manualUpdateResults(); manualDraw(); });
  mels.scalePx.addEventListener('input', () => { manualUpdateScaleHint(); manualUpdateResults(); manualDraw(); });
  mels.groupSelect.addEventListener('change', () => {
    manualState.currentGroupId = mels.groupSelect.value;
    const g = manualCurrentGroup();
    mels.groupName.value = g?.name || '';
    manualUpdateToolButtons();
    manualDraw();
    manualUpdateResults();
  });
  mels.groupName.addEventListener('keydown', (evt) => {
    if (evt.key === 'Enter') manualApplyGroupName();
  });
  mels.applyGroupNameBtn.addEventListener('click', manualApplyGroupName);
  mels.addGroupBtn.addEventListener('click', manualAddGroup);
  mels.shapeSelect.addEventListener('change', () => { manualState.shape = mels.shapeSelect.value; });

  document.querySelectorAll('.manualTool').forEach(btn => {
    btn.addEventListener('click', () => manualSetMode(btn.dataset.manualMode));
  });

  mels.fitBtn.addEventListener('click', () => manualSetZoom('fit'));
  mels.actualBtn.addEventListener('click', () => manualSetZoom(1));
  mels.zoomOutBtn.addEventListener('click', () => manualSetZoom(Math.max(0.05, manualState.zoom * 0.8)));
  mels.zoomInBtn.addEventListener('click', () => manualSetZoom(Math.min(5, manualState.zoom * 1.25)));
  window.addEventListener('resize', manualUpdateCanvasZoom);

  [mels.showSamples, mels.showTargets, mels.showCells, mels.showLabels].forEach(el => el.addEventListener('change', manualDraw));
  mels.undoBtn.addEventListener('click', manualUndo);
  mels.deleteBtn.addEventListener('click', manualDeleteSelected);
  mels.clearGroupBtn.addEventListener('click', manualClearCurrentGroup);
  mels.clearAllBtn.addEventListener('click', manualClearAll);
  mels.exportCsvBtn.addEventListener('click', manualExportCsv);
  mels.exportJsonBtn.addEventListener('click', manualExportJson);
  mels.exportAnnotatedPngBtn.addEventListener('click', () => manualExportImage('annotated_png'));
  mels.exportContourPngBtn.addEventListener('click', () => manualExportImage('contour_png'));
  mels.exportTiffBtn.addEventListener('click', () => manualExportImage('contour_tiff'));

  manualCanvas.addEventListener('pointerdown', manualOnPointerDown);
  manualCanvas.addEventListener('pointermove', manualOnPointerMove);
  manualCanvas.addEventListener('pointerup', manualOnPointerUp);
  manualCanvas.addEventListener('pointercancel', manualOnPointerCancel);
  manualCanvas.addEventListener('pointerleave', manualOnPointerCancel);
}

function manualBindDropUpload() {
  const stop = (evt) => { evt.preventDefault(); evt.stopPropagation(); };
  ['dragenter', 'dragover'].forEach(name => {
    mels.dropZone.addEventListener(name, (evt) => {
      stop(evt);
      mels.dropZone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach(name => {
    mels.dropZone.addEventListener(name, (evt) => {
      stop(evt);
      mels.dropZone.classList.remove('dragover');
    });
  });
  mels.dropZone.addEventListener('drop', (evt) => {
    const file = evt.dataTransfer?.files?.[0];
    if (file) manualHandleImageFile(file);
  });
  mels.dropZone.addEventListener('keydown', (evt) => {
    if (evt.key === 'Enter' || evt.key === ' ') {
      evt.preventDefault();
      mels.imageInput.click();
    }
  });
}

async function manualHandleImageFile(file) {
  if (!isSupportedImageFile(file)) {
    showNotice('请上传图片文件，支持 PNG/JPEG/TIF/TIFF。', 'warn');
    return;
  }
  manualState.imageName = file.name.replace(/\.[^.]+$/, '') || 'image';
  mels.imageNameHint.textContent = `正在加载：${file.name}`;
  try {
    const sourceUrl = await imageFileToLoadableUrl(file);
    const revokeAfterLoad = sourceUrl.startsWith('blob:');
    const img = new Image();
    img.onload = () => {
      manualState.image = img;
      manualCanvas.width = img.naturalWidth;
      manualCanvas.height = img.naturalHeight;
      manualState.objects = [];
      manualState.selectedObjectId = null;
      manualState.nextCounters = { sample: 1, cell: 1, target: 1, stroke: 1 };
      if (revokeAfterLoad) URL.revokeObjectURL(sourceUrl);
      mels.imageNameHint.textContent = `已选择：${file.name}${isTiffFile(file) ? '（已转换为 PNG 显示）' : ''}`;
      manualState.zoomMode = 'fit';
      manualSetMode('sample');
      manualDraw();
      manualUpdateCanvasZoom();
      manualUpdateResults();
      manualUpdateActionStates();
      showNotice('图片已加载。可以开始画小样本区域。');
    };
    img.onerror = () => showNotice('图片加载失败。该文件可能不是标准图片，或 TIFF 格式无法解析。', 'error');
    img.src = sourceUrl;
  } catch (err) {
    showNotice(err.message || '图片加载失败', 'error');
    mels.imageNameHint.textContent = '未选择文件';
    manualUpdateActionStates();
  }
}

function manualCurrentGroup() {
  return manualState.groups.find(g => g.id === manualState.currentGroupId) || manualState.groups[0];
}

function manualSyncGroupSelect() {
  mels.groupSelect.innerHTML = manualState.groups.map(g => {
    const label = `${manualColorName(g.color)} · ${escapeHtml(g.name)}`;
    return `<option value="${g.id}">${label}</option>`;
  }).join('');
  mels.groupSelect.value = manualState.currentGroupId;
  mels.groupName.value = manualCurrentGroup()?.name || '';
}

function manualColorName(color) {
  const map = {
    '#ef4444': '红色', '#2563eb': '蓝色', '#22c55e': '绿色', '#f59e0b': '黄色',
    '#a855f7': '紫色', '#06b6d4': '青色', '#ec4899': '粉色', '#84cc16': '浅绿'
  };
  return map[color] || color;
}

function manualAddGroup() {
  const idx = manualState.groups.length;
  const color = manualColors[idx % manualColors.length];
  const id = `G${idx + 1}`;
  manualState.groups.push({ id, color, name: `密度区域 ${idx + 1}` });
  manualState.currentGroupId = id;
  manualSyncGroupSelect();
  manualUpdateResults();
  manualDraw();
}

function manualApplyGroupName() {
  const g = manualCurrentGroup();
  if (!g) return;
  g.name = mels.groupName.value.trim() || g.name;
  manualSyncGroupSelect();
  manualUpdateResults();
  manualDraw();
}

function manualSetMode(mode) {
  manualState.mode = mode;
  if (mode === 'cell') {
    manualState.shape = 'free';
    if (mels?.shapeSelect) mels.shapeSelect.value = 'free';
  }
  manualUpdateToolButtons();
  document.body.classList.toggle('manualSelecting', mode === 'select');
  if (mels?.shapeSelect) {
    mels.shapeSelect.disabled = mode === 'cell';
    mels.shapeSelect.title = mode === 'cell' ? '细胞轮廓使用自由画笔：默认保留开放线；首尾靠近或两端接触边界时才形成高亮闭合区域' : '';
  }
  manualUpdateActionStates();
}

function manualUpdateToolButtons() {
  const hasImage = Boolean(manualState.image);
  document.querySelectorAll('.manualTool').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.manualMode === manualState.mode);
    setButtonState(btn, hasImage, '请先上传图片');
  });
}

function manualUpdateActionStates() {
  if (!mels) return;
  const hasImage = Boolean(manualState.image);
  const hasObjects = manualState.objects.length > 0;
  const selected = manualSelectedObject();
  const group = manualCurrentGroup();
  const hasCurrentGroupObjects = Boolean(group && manualState.objects.some(o => o.groupId === group.id));

  manualUpdateToolButtons();
  setButtonState(mels.fitBtn, hasImage, '请先上传图片');
  setButtonState(mels.actualBtn, hasImage, '请先上传图片');
  setButtonState(mels.zoomOutBtn, hasImage, '请先上传图片');
  setButtonState(mels.zoomInBtn, hasImage, '请先上传图片');
  setButtonState(mels.undoBtn, hasObjects, '暂无可撤销的标注');
  setButtonState(mels.deleteBtn, Boolean(selected), '请先在选择/修改模式下点击对象');
  setButtonState(mels.clearGroupBtn, hasCurrentGroupObjects, '当前颜色组暂无标注');
  setButtonState(mels.clearAllBtn, hasObjects, '暂无标注');
  setButtonState(mels.exportCsvBtn, hasObjects, '请先完成至少一个标注对象');
  setButtonState(mels.exportJsonBtn, hasObjects, '请先完成至少一个标注对象');
  setButtonState(mels.exportAnnotatedPngBtn, hasImage && hasObjects, hasImage ? '请先完成至少一个标注对象' : '请先上传图片');
  setButtonState(mels.exportContourPngBtn, hasImage && hasObjects, hasImage ? '请先完成至少一个标注对象' : '请先上传图片');
  setButtonState(mels.exportTiffBtn, hasImage && hasObjects, hasImage ? '请先完成至少一个标注对象' : '请先上传图片');

  if (mels.shapeSelect) {
    const cellMode = manualState.mode === 'cell';
    mels.shapeSelect.disabled = !hasImage || cellMode;
    mels.shapeSelect.title = !hasImage
      ? '请先上传图片'
      : (cellMode ? '细胞轮廓使用自由画笔' : '');
  }

  [mels.showSamples, mels.showTargets, mels.showCells, mels.showLabels].forEach(el => {
    if (el) el.disabled = !hasImage;
  });

  if (mels.objectEmpty) {
    mels.objectEmpty.classList.toggle('hidden', hasObjects);
  }
}

function manualSetZoom(modeOrValue) {
  manualState.zoomMode = modeOrValue;
  manualUpdateCanvasZoom();
}

function manualUpdateCanvasZoom() {
  if (!manualCanvas || !manualCanvas.width || !manualCanvas.height) return;
  let zoom;
  if (manualState.zoomMode === 'fit') {
    const availableW = Math.max(100, mels.canvasShell.clientWidth - 32);
    const availableH = Math.max(100, mels.canvasShell.clientHeight - 32);
    zoom = Math.min(1, availableW / manualCanvas.width, availableH / manualCanvas.height);
    zoom = clamp(zoom, 0.03, 1);
  } else {
    zoom = Number(manualState.zoomMode) || 1;
  }
  manualState.zoom = zoom;
  manualCanvas.style.width = `${Math.max(1, Math.round(manualCanvas.width * zoom))}px`;
  manualCanvas.style.height = `${Math.max(1, Math.round(manualCanvas.height * zoom))}px`;
  const modeText = manualState.zoomMode === 'fit' ? '适应屏幕' : '原图比例';
  mels.zoomHint.textContent = manualState.image
    ? `${modeText} · 当前显示 ${Math.round(zoom * 100)}% · 图像像素 ${manualCanvas.width} × ${manualCanvas.height}`
    : '未加载图片';
}

function manualUpdateScaleHint() {
  const pxSize = manualPixelSizeUm();
  if (!pxSize) mels.scaleHint.textContent = '请正确输入 scale bar 实际长度和像素长度。';
  else mels.scaleHint.textContent = `1 pixel = ${pxSize.toFixed(4)} μm；1 pixel² = ${(pxSize * pxSize).toFixed(4)} μm²`;
}

function manualPixelSizeUm() {
  const um = Number(mels.scaleUm.value);
  const px = Number(mels.scalePx.value);
  if (!Number.isFinite(um) || !Number.isFinite(px) || um <= 0 || px <= 0) return 0;
  return um / px;
}

function manualCanvasPoint(evt) {
  const rect = manualCanvas.getBoundingClientRect();
  return {
    x: (evt.clientX - rect.left) * (manualCanvas.width / rect.width),
    y: (evt.clientY - rect.top) * (manualCanvas.height / rect.height)
  };
}

function manualActiveShape() {
  // 细胞轮廓默认强制使用自由画笔，因为细胞边界通常不规则。
  if (manualState.mode === 'cell') return 'free';
  return manualState.shape || 'free';
}

function manualOnPointerDown(evt) {
  if (!manualState.image) return;
  evt.preventDefault();
  const p = manualCanvasPoint(evt);
  if (manualState.mode === 'select') {
    manualSelectObjectAtPoint(p);
    manualState.isDrawing = false;
    return;
  }
  manualState.isDrawing = true;
  manualState.activePointerId = evt.pointerId;
  manualState.dragStart = p;
  manualState.currentPath = [p];
  try { manualCanvas.setPointerCapture(evt.pointerId); } catch (_) {}
}

function manualOnPointerMove(evt) {
  if (!manualState.isDrawing || !manualState.image || manualState.mode === 'select') return;
  if (manualState.activePointerId !== null && evt.pointerId !== manualState.activePointerId) return;
  evt.preventDefault();
  const shape = manualActiveShape();

  if (shape === 'free') {
    // 使用 coalesced pointer events 可以让触控板/手写笔轨迹更像真正画笔，减少断点。
    const events = typeof evt.getCoalescedEvents === 'function' ? evt.getCoalescedEvents() : [evt];
    for (const e of events) {
      const p = manualCanvasPoint(e);
      manualAddFreehandPoint(p);
    }
  } else {
    const p = manualCanvasPoint(evt);
    manualState.currentPath = manualShapeToPolygon(manualState.dragStart, p, shape);
  }
  manualDraw();
}

function manualOnPointerUp(evt) {
  if (!manualState.isDrawing || manualState.mode === 'select') return;
  if (manualState.activePointerId !== null && evt.pointerId !== manualState.activePointerId) return;
  evt.preventDefault();
  const shape = manualActiveShape();
  const p = manualCanvasPoint(evt);

  if (shape === 'free') {
    manualAddFreehandPoint(p, true);
  } else {
    manualState.currentPath = manualShapeToPolygon(manualState.dragStart, p, shape);
  }

  let pts = shape === 'free'
    ? manualFinalizeFreehandPath(manualState.currentPath)
    : manualSimplifyPolygon(manualState.currentPath, 0);

  pts = pts.map(pt => ({ x: clamp(pt.x, 0, manualCanvas.width), y: clamp(pt.y, 0, manualCanvas.height) }));

  const drawingMode = manualState.mode;
  manualState.isDrawing = false;
  manualState.activePointerId = null;
  manualState.currentPath = [];
  manualState.dragStart = null;
  try { manualCanvas.releasePointerCapture(evt.pointerId); } catch (_) {}

  if (shape !== 'free') {
    const minArea = drawingMode === 'cell' ? 3 : 10;
    if (!pts || pts.length < 3 || polygonAreaAbs(pts) < minArea) {
      manualDraw();
      return;
    }
    manualAddObject(drawingMode, pts, '规则图形闭合', null);
    return;
  }

  // 自由手绘模式：默认保存为开放线条，不强制闭合。
  // v6: 开放线不会消失，并始终以连续实线显示完整路径；后续新画的线如果端点接近旧开放线端点，会自动拼接补充。
  // 拼接后再判断是否闭合/是否与边界融合。
  if (!pts || pts.length < 2) {
    manualDraw();
    return;
  }

  const mergeResult = manualMaybeMergeWithOpenStrokes(pts, drawingMode);
  pts = mergeResult.points || pts;

  const closedPolygon = manualPathToClosedPolygon(pts, drawingMode);
  if (closedPolygon) {
    manualAddObject(drawingMode, closedPolygon, '首尾严格闭合，高亮计入统计', pts);
    return;
  }

  const fused = manualTryBoundaryFusion(pts, drawingMode);
  if (fused?.polygon) {
    manualAddObject(drawingMode, fused.polygon, `边界融合闭合，高亮计入统计`, pts);
    return;
  }

  // 没有闭合，也没有与边界融合：保留为普通开放线，不计算面积、不计入细胞数。
  manualAddOpenStroke(drawingMode, pts, '开放线：未闭合，完整路径保留显示，未计入面积和细胞数量');
}

function manualOnPointerCancel(evt) {
  if (!manualState.isDrawing) return;
  manualState.isDrawing = false;
  manualState.activePointerId = null;
  manualState.currentPath = [];
  manualState.dragStart = null;
  try { manualCanvas.releasePointerCapture(evt.pointerId); } catch (_) {}
  manualDraw();
}

function manualAddFreehandPoint(p, force = false) {
  const last = manualState.currentPath[manualState.currentPath.length - 1];
  // 距离阈值越小，越接近“画画”的轨迹。细胞轮廓使用更细采样。
  const minDist = manualState.mode === 'cell' ? 0.75 : 1.25;
  if (force || !last || Math.hypot(p.x - last.x, p.y - last.y) >= minDist) {
    manualState.currentPath.push(p);
  }
}

function manualFinalizeFreehandPath(points) {
  if (!Array.isArray(points) || points.length < 2) return [];
  let pts = points.map(pt => ({ x: pt.x, y: pt.y }));
  pts = manualRemoveNearDuplicatePoints(pts, manualState.mode === 'cell' ? 0.6 : 1.0);
  // 很长的轨迹才轻微压缩；细胞轮廓保留更多点，避免把不规则边界变成粗糙多边形。
  const maxPoints = manualState.mode === 'cell' ? 1800 : 1200;
  if (pts.length > maxPoints) {
    const step = Math.ceil(pts.length / maxPoints);
    pts = pts.filter((_, i) => i % step === 0);
  }
  // 这里仅清理自由画笔轨迹，不自动闭合；是否闭合由 pointerup 阶段判断。
  return pts;
}

function manualRemoveNearDuplicatePoints(points, minDistance) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= minDistance) out.push(p);
  }
  if (out.length > 3) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) < minDistance) out.pop();
  }
  return out;
}

function manualShapeToPolygon(a, b, shape) {
  if (!a || !b) return [];
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(a.x - b.x);
  const h = Math.abs(a.y - b.y);
  if (w < 2 || h < 2) return [];
  if (shape === 'rect') return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rx = w / 2;
  const ry = h / 2;
  const pts = [];
  for (let i = 0; i < 48; i++) {
    const t = Math.PI * 2 * i / 48;
    pts.push({ x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry });
  }
  return pts;
}

function manualSimplifyPolygon(points, minDistance = 2, maxPoints = 1200) {
  if (!Array.isArray(points) || points.length < 3) return [];
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= minDistance) out.push(p);
  }
  if (out.length > 3) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) < minDistance) out.pop();
  }
  // v4: 不再强行压缩到 300 个点。细胞边界需要保留完整手绘轨迹。
  if (out.length > maxPoints) {
    const step = Math.ceil(out.length / maxPoints);
    return out.filter((_, i) => i % step === 0);
  }
  return out;
}

function manualCloseThresholdPx() {
  // v5: 闭合阈值进一步收紧。
  // 坐标在原图像素空间里；这里等价于屏幕上约 3.5 px 的距离，并限制最大值，
  // 避免“稍微靠近就自动闭合”。如果需要闭合，请把终点真正画回起点附近。
  return clamp(3.5 / Math.max(manualState.zoom || 1, 0.05), 2.5, 10);
}

function manualBoundaryThresholdPx() {
  // v5: 边界融合同样收紧，必须真的画到样本/图片边界附近。
  return clamp(4.5 / Math.max(manualState.zoom || 1, 0.05), 3, 14);
}

function manualStrokeMergeThresholdPx() {
  // 开放线后续补画时，端点吸附/合并阈值可以比闭合稍宽一点，
  // 便于把分段手绘线连接起来，但仍然需要明显接近端点。
  return clamp(7 / Math.max(manualState.zoom || 1, 0.05), 4, 18);
}

function manualPathLength(points) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return len;
}

function manualPathBounds(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points || []) {
    if (!p) continue;
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX)) return { width: 0, height: 0, diag: 0 };
  const width = maxX - minX;
  const height = maxY - minY;
  return { minX, minY, maxX, maxY, width, height, diag: Math.hypot(width, height) };
}

function manualFindClosureStartIndex(points, type) {
  if (!Array.isArray(points) || points.length < 6) return -1;
  const threshold = manualCloseThresholdPx();
  const last = points[points.length - 1];
  const minArea = type === 'cell' ? 3 : 10;

  // 先检查标准首尾闭合。这里不再用 threshold * 6 的过强路径长度要求，
  // 因为很小的细胞轮廓可能路径本来就短。
  const first = points[0];
  if (Math.hypot(first.x - last.x, first.y - last.y) <= threshold) {
    const trial = manualSimplifyPolygon(points.slice(0, -1), type === 'cell' ? 0.25 : 0.6, type === 'cell' ? 2600 : 1600);
    if (trial.length >= 3 && polygonAreaAbs(trial) >= minArea) return 0;
  }

  // 如果用户画了一圈后略微越过起点，允许终点闭合到前面轨迹上的某个早期点。
  // 这可以解决“小圈明明闭合但没有识别”的情况。
  // 只搜索前 35% 的轨迹，避免一条随便交叉的线被错误闭合。
  const maxIndex = Math.max(1, Math.floor(points.length * 0.35));
  let best = { index: -1, dist: Infinity, area: 0 };
  for (let i = 0; i <= maxIndex; i++) {
    const d = Math.hypot(points[i].x - last.x, points[i].y - last.y);
    if (d > threshold) continue;
    const candidate = points.slice(i, -1);
    const cleaned = manualSimplifyPolygon(candidate, type === 'cell' ? 0.25 : 0.6, type === 'cell' ? 2600 : 1600);
    const area = cleaned.length >= 3 ? polygonAreaAbs(cleaned) : 0;
    if (area >= minArea && d < best.dist) best = { index: i, dist: d, area };
  }
  return best.index;
}

function manualIsPathClosed(points) {
  return manualFindClosureStartIndex(points, manualState.mode || 'cell') >= 0;
}

function manualPathToClosedPolygon(points, type) {
  const startIndex = manualFindClosureStartIndex(points, type);
  if (startIndex < 0) return null;
  let pts = points.slice(startIndex);
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (Math.hypot(first.x - last.x, first.y - last.y) <= manualCloseThresholdPx()) pts = pts.slice(0, -1);
  const cleaned = manualSimplifyPolygon(pts, type === 'cell' ? 0.25 : 0.6, type === 'cell' ? 2600 : 1600);
  const minArea = type === 'cell' ? 3 : 10;
  if (cleaned.length < 3 || polygonAreaAbs(cleaned) < minArea) return null;
  return cleaned;
}

function manualMaybeMergeWithOpenStrokes(newPoints, roleType) {
  if (!Array.isArray(newPoints) || newPoints.length < 2) {
    return { points: newPoints || [], mergedIds: [] };
  }
  const groupId = manualState.currentGroupId;
  const threshold = manualStrokeMergeThresholdPx();
  let merged = newPoints.map(p => ({ x: p.x, y: p.y }));
  const mergedIds = [];
  const used = new Set();

  const endpointDistance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const connectStart = (candidate) => {
    const pts = candidate.points || [];
    if (pts.length < 2) return null;
    const curStart = merged[0];
    const cStart = pts[0];
    const cEnd = pts[pts.length - 1];
    const dToEnd = endpointDistance(curStart, cEnd);
    const dToStart = endpointDistance(curStart, cStart);
    if (dToEnd <= threshold && dToEnd <= dToStart) return pts.concat(merged.slice(1));
    if (dToStart <= threshold) return pts.slice().reverse().concat(merged.slice(1));
    return null;
  };
  const connectEnd = (candidate) => {
    const pts = candidate.points || [];
    if (pts.length < 2) return null;
    const curEnd = merged[merged.length - 1];
    const cStart = pts[0];
    const cEnd = pts[pts.length - 1];
    const dToStart = endpointDistance(curEnd, cStart);
    const dToEnd = endpointDistance(curEnd, cEnd);
    if (dToStart <= threshold && dToStart <= dToEnd) return merged.concat(pts.slice(1));
    if (dToEnd <= threshold) return merged.concat(pts.slice().reverse().slice(1));
    return null;
  };

  // 允许一笔新线把之前的一条或多条开放线续起来。循环直到两端都没有可吸附的开放线。
  let changed = true;
  while (changed) {
    changed = false;
    const candidates = manualState.objects.filter(o =>
      o.type === 'stroke' &&
      o.groupId === groupId &&
      o.roleType === roleType &&
      !used.has(o.id) &&
      Array.isArray(o.points) &&
      o.points.length >= 2
    );

    let best = null;
    for (const obj of candidates) {
      const startJoin = connectStart(obj);
      if (startJoin) {
        const d = Math.min(
          endpointDistance(merged[0], obj.points[0]),
          endpointDistance(merged[0], obj.points[obj.points.length - 1])
        );
        if (!best || d < best.d) best = { obj, points: startJoin, d };
      }
      const endJoin = connectEnd(obj);
      if (endJoin) {
        const d = Math.min(
          endpointDistance(merged[merged.length - 1], obj.points[0]),
          endpointDistance(merged[merged.length - 1], obj.points[obj.points.length - 1])
        );
        if (!best || d < best.d) best = { obj, points: endJoin, d };
      }
    }

    if (best) {
      used.add(best.obj.id);
      mergedIds.push(best.obj.id);
      merged = manualRemoveNearDuplicatePoints(best.points, roleType === 'cell' ? 0.35 : 0.7);
      changed = true;
    }
  }

  if (mergedIds.length) {
    manualState.objects = manualState.objects.filter(o => !mergedIds.includes(o.id));
  }
  return { points: merged, mergedIds };
}

function manualTryBoundaryFusion(strokePoints, type) {
  if (!Array.isArray(strokePoints) || strokePoints.length < 2) return null;
  const candidates = manualBoundaryCandidates(type, strokePoints);
  const threshold = manualBoundaryThresholdPx();
  let best = null;

  // 1) 首尾接触同一个边界：手绘线 + 该边界的一段 => 闭合区域。
  for (const candidate of candidates) {
    const startLoc = nearestPointOnPolygonBoundary(strokePoints[0], candidate.polygon);
    const endLoc = nearestPointOnPolygonBoundary(strokePoints[strokePoints.length - 1], candidate.polygon);
    if (!startLoc || !endLoc || startLoc.distance > threshold || endLoc.distance > threshold) continue;

    const boundaryA = boundaryPathBetween(candidate.polygon, endLoc, startLoc, 1);
    const boundaryB = boundaryPathBetween(candidate.polygon, endLoc, startLoc, -1);
    const polyA = manualCleanCandidatePolygon([...strokePoints, ...boundaryA], type);
    const polyB = manualCleanCandidatePolygon([...strokePoints, ...boundaryB], type);
    const valid = [polyA, polyB].filter(poly => poly && poly.length >= 3 && polygonAreaAbs(poly) >= (type === 'cell' ? 3 : 10));
    if (!valid.length) continue;

    // 一条线连接同一边界两点时通常会产生两个候选区域。
    // 自动选择较小区域，避免把整个样本区域都当成一个细胞。
    valid.sort((a, b) => polygonAreaAbs(a) - polygonAreaAbs(b));
    const chosen = valid[0];
    const area = polygonAreaAbs(chosen);
    if (!best || area < best.area) best = { polygon: chosen, boundaryLabel: candidate.label, area, fusionType: 'same-boundary' };
  }

  // 2) v9: 首尾分别接触两个不同边界，例如“一端碰小样本区域边界，另一端碰已有细胞边界”。
  // 如果这两个边界本身也相接/非常接近，就用：手绘线 + 边界B的一段 + 边界A的一段 => 闭合区域。
  // 这适合相邻细胞共享边界、细胞贴着样本区域边缘等情况。
  const mixed = manualTryMixedBoundaryFusion(strokePoints, type, candidates, threshold);
  if (mixed?.polygon && (!best || mixed.area < best.area)) best = mixed;

  return best;
}

function manualTryMixedBoundaryFusion(strokePoints, type, candidates, threshold) {
  if (!Array.isArray(candidates) || candidates.length < 2) return null;
  const start = strokePoints[0];
  const end = strokePoints[strokePoints.length - 1];
  const minArea = type === 'cell' ? 3 : 10;
  const contactThreshold = manualMixedBoundaryContactThresholdPx();
  let best = null;

  for (let i = 0; i < candidates.length; i++) {
    for (let j = 0; j < candidates.length; j++) {
      if (i === j) continue;
      const startBoundary = candidates[i];
      const endBoundary = candidates[j];

      // 避免用图片边界 + 图片边界、或者两个很大的无关边界造成误闭合。
      // 但允许 sample + cell、sample + image、cell + image 等真实边界组合。
      if (startBoundary.kind === 'image' && endBoundary.kind === 'image') continue;

      const startLoc = nearestPointOnPolygonBoundary(start, startBoundary.polygon);
      const endLoc = nearestPointOnPolygonBoundary(end, endBoundary.polygon);
      if (!startLoc || !endLoc || startLoc.distance > threshold || endLoc.distance > threshold) continue;

      const bridge = closestBoundaryContact(startBoundary.polygon, endBoundary.polygon, contactThreshold);
      if (!bridge) continue;

      // 四种组合：沿 endBoundary 顺/逆方向走到连接点，再沿 startBoundary 顺/逆方向走回起点。
      const endToBridgeA = boundaryPathBetween(endBoundary.polygon, endLoc, bridge.locB, 1);
      const endToBridgeB = boundaryPathBetween(endBoundary.polygon, endLoc, bridge.locB, -1);
      const bridgeToStartA = boundaryPathBetween(startBoundary.polygon, bridge.locA, startLoc, 1);
      const bridgeToStartB = boundaryPathBetween(startBoundary.polygon, bridge.locA, startLoc, -1);

      const candidatesPoly = [];
      for (const endArc of [endToBridgeA, endToBridgeB]) {
        for (const startArc of [bridgeToStartA, bridgeToStartB]) {
          // 如果两个边界不是完全接触，中间补一小段 bridge.locB -> bridge.locA。
          const bridgeSegment = Math.hypot(bridge.locA.x - bridge.locB.x, bridge.locA.y - bridge.locB.y) > 0.5
            ? [{ x: bridge.locA.x, y: bridge.locA.y }]
            : [];
          const poly = manualCleanCandidatePolygon([...strokePoints, ...endArc, ...bridgeSegment, ...startArc], type);
          if (poly && poly.length >= 3 && polygonAreaAbs(poly) >= minArea) candidatesPoly.push(poly);
        }
      }

      if (!candidatesPoly.length) continue;
      candidatesPoly.sort((a, b) => polygonAreaAbs(a) - polygonAreaAbs(b));
      const chosen = candidatesPoly[0];
      const area = polygonAreaAbs(chosen);
      if (!best || area < best.area) {
        best = {
          polygon: chosen,
          boundaryLabel: `${startBoundary.label} + ${endBoundary.label}`,
          area,
          fusionType: 'mixed-boundary'
        };
      }
    }
  }

  return best;
}

function manualMixedBoundaryContactThresholdPx() {
  // 两个已有边界之间的“接触/共享边界”判断可以比端点吸附稍宽一点，
  // 因为手绘和显示缩放会造成 1–数 px 偏差；但不能太宽，避免把无关区域误连。
  return clamp(7 / Math.max(manualState.zoom || 1, 0.05), 4, 24);
}

function closestBoundaryContact(polyA, polyB, threshold) {
  if (!Array.isArray(polyA) || !Array.isArray(polyB) || polyA.length < 2 || polyB.length < 2) return null;
  let best = null;

  // A 顶点投影到 B。
  for (let i = 0; i < polyA.length; i++) {
    const aPt = polyA[i];
    const locB = nearestPointOnPolygonBoundary(aPt, polyB);
    if (!locB) continue;
    const d = locB.distance;
    if (d <= threshold && (!best || d < best.distance)) {
      best = { locA: { x: aPt.x, y: aPt.y, edgeIndex: i, distance: 0 }, locB, distance: d };
    }
  }

  // B 顶点投影到 A。
  for (let j = 0; j < polyB.length; j++) {
    const bPt = polyB[j];
    const locA = nearestPointOnPolygonBoundary(bPt, polyA);
    if (!locA) continue;
    const d = locA.distance;
    if (d <= threshold && (!best || d < best.distance)) {
      best = { locA, locB: { x: bPt.x, y: bPt.y, edgeIndex: j, distance: 0 }, distance: d };
    }
  }

  return best;
}

function manualBoundaryCandidates(type, strokePoints) {
  const candidates = [];
  const groupId = manualState.currentGroupId;
  const start = strokePoints[0];
  const end = strokePoints[strokePoints.length - 1];
  const mid = strokePoints[Math.floor(strokePoints.length / 2)];

  if (type === 'cell') {
    // v8: 细胞开放线优先尝试与当前颜色组的小样本区域边界融合。
    // 只要首尾端点靠近同一个小样本区域边界，就可以用“手绘线 + 样本边界的一段”形成闭合区域。
    // 不再要求线条中点/端点必须位于样本内部，因为用户经常沿着样本边缘勾勒细胞。
    const samples = manualState.objects.filter(o => o.type === 'sample' && o.groupId === groupId);
    for (const sample of samples) {
      candidates.push({ label: '小样本区域', polygon: sample.polygon, kind: 'sample' });
    }

    // v7: 如果新画的开放线两端都接触到另一个已高亮细胞的边界，
    // 系统也会使用“手绘线 + 该细胞边界的一段”自动融合成新的封闭区域。
    // 这适合相邻细胞共享边界时，只补画外侧轮廓的情况。
    const cells = manualState.objects.filter(o => o.type === 'cell' && o.groupId === groupId);
    for (const cell of cells) {
      candidates.push({ label: `${cell.id} 细胞`, polygon: cell.polygon, kind: 'cell' });
    }
  }

  // 所有模式均允许与图片边界融合。
  if (manualCanvas?.width && manualCanvas?.height) {
    candidates.push({ label: '图片', polygon: manualImageBoundaryPolygon(), kind: 'image' });
  }

  return candidates;
}

function manualImageBoundaryPolygon() {
  const w = manualCanvas.width;
  const h = manualCanvas.height;
  return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
}

function manualCleanCandidatePolygon(points, type) {
  if (!Array.isArray(points)) return null;
  let cleaned = points
    .filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y))
    .map(p => ({ x: clamp(p.x, 0, manualCanvas.width), y: clamp(p.y, 0, manualCanvas.height) }));
  cleaned = manualRemoveNearDuplicatePoints(cleaned, type === 'cell' ? 0.5 : 1.0);
  if (cleaned.length > 900) {
    const step = Math.ceil(cleaned.length / 900);
    cleaned = cleaned.filter((_, i) => i % step === 0);
  }
  return cleaned.length >= 3 ? cleaned : null;
}

function nearestPointOnPolygonBoundary(point, polygon) {
  if (!point || !Array.isArray(polygon) || polygon.length < 2) return null;
  let best = null;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const proj = projectPointToSegment(point, a, b);
    const d = Math.hypot(point.x - proj.x, point.y - proj.y);
    if (!best || d < best.distance) best = { ...proj, edgeIndex: i, distance: d };
  }
  return best;
}

function projectPointToSegment(p, a, b) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 <= 1e-12) return { x: a.x, y: a.y, t: 0 };
  const t = clamp(((p.x - a.x) * vx + (p.y - a.y) * vy) / len2, 0, 1);
  return { x: a.x + vx * t, y: a.y + vy * t, t };
}

function boundaryPathBetween(polygon, fromLoc, toLoc, direction = 1) {
  const n = polygon.length;
  if (n < 2) return [];
  const path = [{ x: fromLoc.x, y: fromLoc.y }];
  let edge = fromLoc.edgeIndex;

  if (direction >= 0) {
    // 从 fromLoc 所在边的终点开始，沿 polygon 正方向走到 toLoc。
    let guard = 0;
    while (guard++ < n + 2) {
      const nextVertexIndex = (edge + 1) % n;
      if (edge === toLoc.edgeIndex) {
        path.push({ x: toLoc.x, y: toLoc.y });
        break;
      }
      path.push({ x: polygon[nextVertexIndex].x, y: polygon[nextVertexIndex].y });
      edge = nextVertexIndex;
    }
  } else {
    // 沿 polygon 反方向走。
    let guard = 0;
    while (guard++ < n + 2) {
      const currentVertexIndex = edge;
      if (edge === toLoc.edgeIndex) {
        path.push({ x: toLoc.x, y: toLoc.y });
        break;
      }
      path.push({ x: polygon[currentVertexIndex].x, y: polygon[currentVertexIndex].y });
      edge = (edge - 1 + n) % n;
    }
  }
  return path;
}

function pointToPolylineDistance(point, points) {
  if (!point || !Array.isArray(points) || points.length < 2) return Infinity;
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const proj = projectPointToSegment(point, points[i], points[i + 1]);
    const d = Math.hypot(point.x - proj.x, point.y - proj.y);
    if (d < best) best = d;
  }
  return best;
}

function openPathCentroid(points) {
  if (!Array.isArray(points) || points.length === 0) return { x: 0, y: 0 };
  return points.reduce((acc, p) => ({ x: acc.x + p.x / points.length, y: acc.y + p.y / points.length }), { x: 0, y: 0 });
}

function manualAddObject(type, polygon, note = '', sourcePath = null) {
  const group = manualCurrentGroup();
  if (!group) return;
  const localNo = manualState.nextCounters[type]++;
  const prefix = type === 'sample' ? 'S' : (type === 'target' ? 'T' : 'C');
  const obj = {
    id: `${group.id}-${prefix}${localNo}`,
    type,
    groupId: group.id,
    polygon,
    // v4: 保存完整手绘轨迹，用于显示原始笔迹；面积计算仍用闭合 polygon。
    sourcePath: Array.isArray(sourcePath) ? sourcePath.map(p => ({ x: p.x, y: p.y })) : null,
    createdAt: new Date().toISOString(),
    note
  };
  manualState.objects.push(obj);
  manualState.selectedObjectId = obj.id;
  manualSetMode(type === 'cell' ? 'cell' : manualState.mode);
  manualUpdateResults();
  manualDraw();
}

function manualAddOpenStroke(roleType, points, note = '') {
  const group = manualCurrentGroup();
  if (!group) return;
  const localNo = manualState.nextCounters.stroke++;
  const obj = {
    id: `${group.id}-L${localNo}`,
    type: 'stroke',
    roleType,
    groupId: group.id,
    points,
    createdAt: new Date().toISOString(),
    note
  };
  manualState.objects.push(obj);
  manualState.selectedObjectId = obj.id;
  manualUpdateResults();
  manualDraw();
}

function manualSelectObjectAtPoint(p) {
  const hitThreshold = manualBoundaryThresholdPx();
  for (let i = manualState.objects.length - 1; i >= 0; i--) {
    const obj = manualState.objects[i];
    if (obj.type === 'stroke') {
      if (pointToPolylineDistance(p, obj.points) <= hitThreshold) {
        manualState.selectedObjectId = obj.id;
        manualUpdateResults();
        manualDraw();
        return;
      }
    } else if (pointInPolygon(p, obj.polygon)) {
      manualState.selectedObjectId = obj.id;
      manualUpdateResults();
      manualDraw();
      return;
    }
  }
  manualState.selectedObjectId = null;
  manualUpdateResults();
  manualDraw();
}

function manualSelectedObject() {
  return manualState.objects.find(o => o.id === manualState.selectedObjectId) || null;
}

function manualUndo() {
  const obj = manualState.objects.pop();
  if (obj && manualState.selectedObjectId === obj.id) manualState.selectedObjectId = null;
  manualUpdateResults();
  manualDraw();
}

function manualDeleteSelected() {
  const obj = manualSelectedObject();
  if (!obj) {
    showNotice('请先在“选择/修改”模式下点击一个对象。', 'warn');
    return;
  }
  manualState.objects = manualState.objects.filter(o => o.id !== obj.id);
  manualState.selectedObjectId = null;
  manualUpdateResults();
  manualDraw();
  showNotice(`${obj.id} 已删除。`);
}

function manualClearCurrentGroup() {
  const g = manualCurrentGroup();
  if (!g) return;
  if (!manualState.objects.some(o => o.groupId === g.id)) {
    showNotice('当前颜色组暂无标注。', 'warn');
    return;
  }
  if (!confirm(`确定清空 ${g.name} 的全部标注吗？`)) return;
  manualState.objects = manualState.objects.filter(o => o.groupId !== g.id);
  manualState.selectedObjectId = null;
  manualUpdateResults();
  manualDraw();
  showNotice(`${g.name} 的标注已清空。`);
}

function manualClearAll() {
  if (!manualState.objects.length) {
    showNotice('暂无标注可清空。', 'warn');
    return;
  }
  if (!confirm('确定清空全部颜色组的所有标注吗？')) return;
  manualState.objects = [];
  manualState.selectedObjectId = null;
  manualState.nextCounters = { sample: 1, cell: 1, target: 1, stroke: 1 };
  manualUpdateResults();
  manualDraw();
  showNotice('全部标注已清空。');
}

function manualDraw() {
  if (!manualCanvas || !manualCtx) return;
  manualCtx.clearRect(0, 0, manualCanvas.width || 1, manualCanvas.height || 1);
  if (!manualState.image) {
    manualCanvas.width = 1200;
    manualCanvas.height = 720;
    manualCtx.fillStyle = '#0b1020';
    manualCtx.fillRect(0, 0, manualCanvas.width, manualCanvas.height);
    manualCtx.fillStyle = '#e5e7eb';
    manualCtx.font = '28px system-ui';
    manualCtx.fillText('请先上传显微镜图片', 430, 330);
    manualUpdateCanvasZoom();
    return;
  }

  manualCtx.drawImage(manualState.image, 0, 0);
  const order = ['target', 'sample', 'stroke', 'cell'];
  for (const type of order) {
    for (const obj of manualState.objects.filter(o => o.type === type)) {
      const visibleType = obj.type === 'stroke' ? obj.roleType : obj.type;
      if (visibleType === 'sample' && !mels.showSamples.checked) continue;
      if (visibleType === 'target' && !mels.showTargets.checked) continue;
      if (visibleType === 'cell' && !mels.showCells.checked) continue;
      manualDrawObject(obj);
    }
  }
  if (manualState.currentPath.length >= 2 && manualState.mode !== 'select') {
    manualDrawPreviewPath(manualState.currentPath);
  }
}

function manualDrawObject(obj) {
  const g = manualState.groups.find(gr => gr.id === obj.groupId);
  const color = g?.color || '#ef4444';
  const selected = obj.id === manualState.selectedObjectId;
  manualCtx.save();

  if (obj.type === 'stroke') {
    manualCtx.lineWidth = selected ? 4 : 2.6;
    manualCtx.strokeStyle = selected ? '#ffffff' : color;
    // v6: 开放线用连续实线显示完整路径，不再用虚线，避免看起来像一段一段断开的线。
    manualCtx.setLineDash([]);
    drawOpenPath(manualCtx, obj.points || []);
    manualCtx.stroke();
    // 端点用小圆点标出，方便后续继续从端点附近补画连接。
    manualDrawStrokeEndpoints(obj.points || [], color, selected);
    if (selected) {
      manualCtx.strokeStyle = color;
      manualCtx.lineWidth = 2;
      drawOpenPath(manualCtx, obj.points || []);
      manualCtx.stroke();
    }
    if (false && mels.showLabels.checked) {
      const c = openPathCentroid(obj.points || []);
      manualCtx.font = `${Math.max(12, Math.round(manualCanvas.width / 110))}px Arial`;
      manualCtx.textBaseline = 'top';
      manualCtx.lineWidth = 4;
      manualCtx.strokeStyle = '#111827';
      manualCtx.fillStyle = '#ffffff';
      manualCtx.strokeText(`${obj.id} 开放线`, c.x + 4, c.y + 4);
      manualCtx.fillText(`${obj.id} 开放线`, c.x + 4, c.y + 4);
    }
    manualCtx.restore();
    return;
  }

  manualCtx.lineWidth = selected ? 4 : (obj.type === 'cell' ? 2 : 3);
  manualCtx.strokeStyle = selected ? '#ffffff' : color;
  manualCtx.fillStyle = obj.type === 'cell' ? transparentColor(color, 0.22) : transparentColor(color, obj.type === 'target' ? 0.11 : 0.08);
  if (obj.type === 'sample') manualCtx.setLineDash([10, 8]);
  if (obj.type === 'target') manualCtx.setLineDash([]);
  if (obj.type === 'cell') manualCtx.setLineDash([]);
  drawPolygon(manualCtx, obj.polygon);
  // 闭合之后自动半透明高亮。细胞轮廓也填充，方便确认该区域已计入面积。
  manualCtx.fill();
  manualCtx.stroke();
  // v4: 对自由手绘形成的闭合区域，额外显示完整原始画线轨迹，避免只看到被简化/融合后的部分轮廓。
  if (Array.isArray(obj.sourcePath) && obj.sourcePath.length >= 2) {
    manualCtx.setLineDash([]);
    manualCtx.strokeStyle = color;
    manualCtx.lineWidth = obj.type === 'cell' ? 2.5 : 3;
    drawOpenPath(manualCtx, obj.sourcePath);
    manualCtx.stroke();
  }
  if (selected) {
    manualCtx.strokeStyle = color;
    manualCtx.lineWidth = 2;
    drawPolygon(manualCtx, obj.polygon);
    manualCtx.stroke();
  }
  if (false && mels.showLabels.checked) {
    const c = polygonCentroid(obj.polygon);
    manualCtx.font = `${Math.max(12, Math.round(manualCanvas.width / 110))}px Arial`;
    manualCtx.textBaseline = 'top';
    manualCtx.lineWidth = 4;
    manualCtx.strokeStyle = '#111827';
    manualCtx.fillStyle = '#ffffff';
    manualCtx.strokeText(obj.id, c.x + 4, c.y + 4);
    manualCtx.fillText(obj.id, c.x + 4, c.y + 4);
  }
  manualCtx.restore();
}


function manualDrawStrokeEndpoints(points, color, selected = false) {
  if (!Array.isArray(points) || points.length < 2) return;
  const first = points[0];
  const last = points[points.length - 1];
  const r = Math.max(3, Math.min(8, manualCanvas.width / 250));
  manualCtx.save();
  manualCtx.setLineDash([]);
  manualCtx.fillStyle = selected ? '#ffffff' : color;
  manualCtx.strokeStyle = selected ? color : '#ffffff';
  manualCtx.lineWidth = Math.max(1.5, r / 2.5);
  for (const p of [first, last]) {
    manualCtx.beginPath();
    manualCtx.arc(p.x, p.y, r, 0, Math.PI * 2);
    manualCtx.fill();
    manualCtx.stroke();
  }
  manualCtx.restore();
}

function drawOpenPath(c, points) {
  c.beginPath();
  points.forEach((p, i) => i === 0 ? c.moveTo(p.x, p.y) : c.lineTo(p.x, p.y));
}

function manualDrawPreviewPath(points) {
  const g = manualCurrentGroup();
  const color = g?.color || '#ef4444';
  const shape = manualActiveShape();
  manualCtx.save();
  manualCtx.strokeStyle = color;
  manualCtx.lineWidth = manualState.mode === 'cell' ? 2 : 3;
  manualCtx.fillStyle = transparentColor(color, manualState.mode === 'cell' ? 0.18 : 0.08);

  if (shape === 'free') {
    manualCtx.setLineDash([]);
    drawOpenPath(manualCtx, points);
    manualCtx.stroke();

    // 绘制中如果首尾已经接近，则给出闭合高亮预览；否则仅显示画笔线条。
    if (manualIsPathClosed(points)) {
      const poly = manualPathToClosedPolygon(points, manualState.mode);
      if (poly) {
        drawPolygon(manualCtx, poly);
        manualCtx.fill();
        manualCtx.stroke();
      }
    }
  } else {
    manualCtx.setLineDash([6, 6]);
    drawPolygon(manualCtx, points);
    if (points.length > 2) manualCtx.fill();
    manualCtx.stroke();
  }
  manualCtx.restore();
}

function drawPolygon(c, points) {
  c.beginPath();
  points.forEach((p, i) => i === 0 ? c.moveTo(p.x, p.y) : c.lineTo(p.x, p.y));
  c.closePath();
}

function manualUpdateResults() {
  const stats = manualComputeAllStats();
  const totalCount = stats.summary.totalPredictedCount;
  const totalSpread = stats.summary.totalPredictedSpreadUm2;
  const totalTargetArea = stats.summary.totalTargetAreaUm2;
  const mean = totalCount > 0 ? totalSpread / totalCount : 0;
  const cov = totalTargetArea > 0 ? totalSpread / totalTargetArea * 100 : 0;

  mels.totalCount.textContent = formatNum(totalCount);
  mels.totalSpread.textContent = `${formatNum(totalSpread)} μm²`;
  mels.meanSpread.textContent = `${formatNum(mean)} μm²`;
  mels.coverage.textContent = `${formatNum(cov)}%`;

  mels.groupTableBody.innerHTML = stats.groups.map(gs => {
    const g = gs.group;
    const warnings = gs.warnings.join('；');
    return `<tr>
      <td><span class="colorDot" style="background:${g.color}"></span>${manualColorName(g.color)}</td>
      <td>${escapeHtml(g.name)}</td>
      <td>${gs.sampleCount}</td>
      <td>${gs.sampleCellCount}</td>
      <td>${formatNum(gs.densityCellsPerMm2)}</td>
      <td>${formatNum(gs.coveragePercent)}%</td>
      <td>${formatNum(gs.targetAreaUm2)}</td>
      <td>${formatNum(gs.predictedCellCount)}</td>
      <td>${formatNum(gs.predictedSpreadUm2)}</td>
      <td>${escapeHtml(warnings)}</td>
    </tr>`;
  }).join('');

  const px2 = manualPixelAreaUm2();
  mels.objectTableBody.innerHTML = manualState.objects.map(obj => {
    const g = manualState.groups.find(gr => gr.id === obj.groupId);
    const area = obj.type === 'stroke' ? 0 : polygonAreaAbs(obj.polygon) * px2;
    const typeLabel = obj.type === 'sample' ? '小样本区域' : (obj.type === 'target' ? '整体推算区域' : (obj.type === 'cell' ? '细胞轮廓' : '开放线条'));
    const selected = obj.id === manualState.selectedObjectId ? 'selected' : '';
    return `<tr class="${selected}" data-id="${obj.id}">
      <td>${obj.id}</td>
      <td><span class="colorDot" style="background:${g?.color || '#999'}"></span>${escapeHtml(g?.name || obj.groupId)}</td>
      <td>${typeLabel}</td>
      <td>${obj.type === 'stroke' ? '-' : formatNum(area)}</td>
      <td>${obj.type === 'cell' ? '高亮闭合区域 = 一个细胞' : (obj.type === 'stroke' ? '开放线：不计面积、不计数' : '')}</td>
    </tr>`;
  }).join('');
  document.querySelectorAll('#manualObjectTable tbody tr').forEach(tr => {
    tr.addEventListener('click', () => {
      manualState.selectedObjectId = tr.dataset.id;
      manualUpdateResults();
      manualDraw();
      manualUpdateActionStates();
    });
  });

  const selected = manualSelectedObject();
  if (selected) {
    const g = manualState.groups.find(gr => gr.id === selected.groupId);
    const typeLabel = selected.type === 'sample' ? '小样本区域' : (selected.type === 'target' ? '整体推算区域' : (selected.type === 'cell' ? '细胞轮廓' : '开放线条'));
    mels.selectedInfo.value = `${selected.id} · ${g?.name || selected.groupId} · ${typeLabel}${selected.note ? ' · ' + selected.note : ''}`;
  } else {
    mels.selectedInfo.value = '';
  }

  const qc = [];
  for (const gs of stats.groups) qc.push(...gs.warnings.map(w => `${gs.group.name}: ${w}`));
  if (stats.overlapWarnings.length) qc.push(...stats.overlapWarnings);
  mels.qcHint.textContent = qc.length
    ? `质量提示：${qc.join('；')}`
    : '建议每种颜色至少标注 2–3 个样本区域。';
  manualUpdateActionStates();
}

function manualComputeAllStats() {
  const px2 = manualPixelAreaUm2();
  const groupStats = manualState.groups.map(group => manualComputeGroupStats(group, px2));
  const summary = groupStats.reduce((acc, gs) => {
    acc.totalPredictedCount += gs.predictedCellCount;
    acc.totalPredictedSpreadUm2 += gs.predictedSpreadUm2;
    acc.totalTargetAreaUm2 += gs.targetAreaUm2;
    return acc;
  }, { totalPredictedCount: 0, totalPredictedSpreadUm2: 0, totalTargetAreaUm2: 0 });
  const overlapWarnings = manualCheckTargetOverlap();
  return { groups: groupStats, summary, overlapWarnings };
}

function manualComputeGroupStats(group, px2) {
  const objs = manualState.objects.filter(o => o.groupId === group.id);
  const samples = objs.filter(o => o.type === 'sample');
  const targets = objs.filter(o => o.type === 'target');
  const allCells = objs.filter(o => o.type === 'cell');
  const sampleAreaPx = samples.reduce((s, o) => s + polygonAreaAbs(o.polygon), 0);
  const targetAreaPx = targets.reduce((s, o) => s + polygonAreaAbs(o.polygon), 0);

  const sampleCells = allCells.filter(cell => samples.some(sample => pointInPolygon(polygonCentroid(cell.polygon), sample.polygon)));
  const cellSpreadPx = sampleCells.reduce((s, c) => s + polygonAreaAbs(c.polygon), 0);
  const sampleAreaUm2 = sampleAreaPx * px2;
  const targetAreaUm2 = targetAreaPx * px2;
  const cellSpreadUm2 = cellSpreadPx * px2;
  const sampleAreaMm2 = sampleAreaUm2 / 1e6;
  const targetAreaMm2 = targetAreaUm2 / 1e6;
  const densityCellsPerMm2 = sampleAreaMm2 > 0 ? sampleCells.length / sampleAreaMm2 : 0;
  const coverage = sampleAreaUm2 > 0 ? cellSpreadUm2 / sampleAreaUm2 : 0;
  const meanCellAreaUm2 = sampleCells.length > 0 ? cellSpreadUm2 / sampleCells.length : 0;
  const predictedCellCount = densityCellsPerMm2 * targetAreaMm2;
  const predictedSpreadUm2 = coverage * targetAreaUm2;

  const warnings = [];
  if (targets.length > 0 && samples.length === 0) warnings.push('有整体区域但没有样本区域，无法可靠外推');
  if (samples.length > 0 && sampleCells.length === 0) warnings.push('样本区域内没有细胞轮廓');
  if (samples.length === 1) warnings.push('只有 1 个样本，建议增加 2–3 个');
  if (targets.length === 0 && samples.length > 0) warnings.push('没有整体推算区域');

  return {
    group,
    sampleCount: samples.length,
    targetCount: targets.length,
    sampleCellCount: sampleCells.length,
    sampleAreaUm2,
    targetAreaUm2,
    sampleSpreadUm2: cellSpreadUm2,
    meanCellAreaUm2,
    densityCellsPerMm2,
    coveragePercent: coverage * 100,
    predictedCellCount,
    predictedSpreadUm2,
    warnings
  };
}

function manualCheckTargetOverlap() {
  const targets = manualState.objects.filter(o => o.type === 'target');
  const warnings = [];
  for (let i = 0; i < targets.length; i++) {
    for (let j = i + 1; j < targets.length; j++) {
      if (targets[i].groupId === targets[j].groupId) continue;
      if (polygonLikelyOverlaps(targets[i].polygon, targets[j].polygon)) {
        warnings.push(`${targets[i].id} 与 ${targets[j].id} 可能重叠，会导致重复计算`);
      }
    }
  }
  return warnings;
}

function polygonLikelyOverlaps(a, b) {
  const ca = polygonCentroid(a);
  const cb = polygonCentroid(b);
  if (pointInPolygon(ca, b) || pointInPolygon(cb, a)) return true;
  // Sample a few vertices; enough for warning-level detection.
  for (let i = 0; i < a.length; i += Math.max(1, Math.floor(a.length / 12))) if (pointInPolygon(a[i], b)) return true;
  for (let i = 0; i < b.length; i += Math.max(1, Math.floor(b.length / 12))) if (pointInPolygon(b[i], a)) return true;
  return false;
}

function manualPixelAreaUm2() {
  const px = manualPixelSizeUm();
  return px ? px * px : 0;
}

function polygonAreaAbs(points) {
  return Math.abs(polygonSignedArea(points));
}

function polygonSignedArea(points) {
  if (!Array.isArray(points) || points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    sum += p.x * q.y - q.x * p.y;
  }
  return sum / 2;
}

function polygonCentroid(points) {
  if (!Array.isArray(points) || points.length === 0) return { x: 0, y: 0 };
  const a = polygonSignedArea(points);
  if (Math.abs(a) < 1e-6) {
    return points.reduce((acc, p) => ({ x: acc.x + p.x / points.length, y: acc.y + p.y / points.length }), { x: 0, y: 0 });
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    const cross = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

function pointInPolygon(point, polygon) {
  if (!point || !Array.isArray(polygon) || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    const intersect = ((yi > point.y) !== (yj > point.y)) &&
      (point.x < (xj - xi) * (point.y - yi) / ((yj - yi) || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function transparentColor(hex, alpha) {
  const h = hex.replace('#', '');
  const bigint = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function manualExportCsv() {
  if (!manualState.objects.length) {
    showNotice('请先完成至少一个标注对象，再导出 CSV。', 'warn');
    return;
  }
  const stats = manualComputeAllStats();
  const rows = [
    ['type', 'group_id', 'group_name', 'sample_count', 'target_count', 'sample_cell_count', 'sample_area_um2', 'sample_spread_um2', 'mean_cell_area_um2', 'density_cells_per_mm2', 'coverage_percent', 'target_area_um2', 'predicted_cell_count', 'predicted_spread_um2', 'warnings']
  ];
  for (const gs of stats.groups) {
    rows.push([
      'group_summary', gs.group.id, gs.group.name, gs.sampleCount, gs.targetCount, gs.sampleCellCount,
      gs.sampleAreaUm2, gs.sampleSpreadUm2, gs.meanCellAreaUm2, gs.densityCellsPerMm2, gs.coveragePercent,
      gs.targetAreaUm2, gs.predictedCellCount, gs.predictedSpreadUm2, gs.warnings.join('; ')
    ]);
  }
  rows.push([]);
  rows.push(['object_id', 'object_type', 'group_id', 'group_name', 'area_um2', 'centroid_x_px', 'centroid_y_px', 'point_count']);
  const px2 = manualPixelAreaUm2();
  for (const obj of manualState.objects) {
    const g = manualState.groups.find(gr => gr.id === obj.groupId);
    const c = obj.type === 'stroke' ? openPathCentroid(obj.points) : polygonCentroid(obj.polygon);
    const area = obj.type === 'stroke' ? 0 : polygonAreaAbs(obj.polygon) * px2;
    const pointCount = obj.type === 'stroke' ? (obj.points?.length || 0) : obj.polygon.length;
    rows.push([obj.id, obj.type, obj.groupId, g?.name || '', area, c.x, c.y, pointCount]);
  }
  const csv = rows.map(row => row.map(csvCell).join(',')).join('\n');
  downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${manualState.imageName}_manual_sampling_results.csv`);
}

function manualExportJson() {
  if (!manualState.objects.length) {
    showNotice('请先完成至少一个标注对象，再导出项目 JSON。', 'warn');
    return;
  }
  const payload = {
    mode: 'manual_sampling_estimation',
    image_name: manualState.imageName,
    pixel_size_um: manualPixelSizeUm(),
    groups: manualState.groups,
    objects: manualState.objects,
    stats: manualComputeAllStats()
  };
  downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `${manualState.imageName}_manual_sampling_project.json`);
}

function manualExportImage(kind) {
  if (!manualState.image) {
    showNotice('请先上传图片。', 'warn');
    return;
  }
  if (!manualState.objects.length) {
    showNotice('请先完成至少一个标注对象，再导出图片。', 'warn');
    return;
  }
  const out = document.createElement('canvas');
  out.width = manualCanvas.width;
  out.height = manualCanvas.height;
  const o = out.getContext('2d');
  if (kind === 'annotated_png') {
    o.drawImage(manualState.image, 0, 0);
  } else {
    o.fillStyle = 'white';
    o.fillRect(0, 0, out.width, out.height);
  }

  for (const obj of manualState.objects) {
    const g = manualState.groups.find(gr => gr.id === obj.groupId);
    const color = kind === 'annotated_png' ? (g?.color || '#ef4444') : 'black';
    o.save();
    o.lineWidth = Math.max(2, Math.round(out.width / 1200));
    o.strokeStyle = color;
    o.fillStyle = color;
    if (obj.type === 'sample') o.setLineDash([10, 8]);
    if (obj.type === 'stroke') {
      // v6: 导出的开放线也保持连续实线，显示完整路径。
      o.setLineDash([]);
      drawOpenPath(o, obj.points || []);
      o.stroke();
      // v8: 导出图片不叠加文字，避免遮挡视野。
    } else {
      drawPolygon(o, obj.polygon);
      o.stroke();
      if (Array.isArray(obj.sourcePath) && obj.sourcePath.length >= 2) {
        drawOpenPath(o, obj.sourcePath);
        o.stroke();
      }
      // v8: 导出图片不叠加文字，避免遮挡视野。
    }
    o.restore();
  }

  if (kind === 'contour_tiff') {
    downloadBlob(canvasToTiffBlob(out), `${manualState.imageName}_manual_contours.tif`);
  } else if (kind === 'contour_png') {
    out.toBlob(blob => downloadBlob(blob, `${manualState.imageName}_manual_contours.png`), 'image/png');
  } else {
    out.toBlob(blob => downloadBlob(blob, `${manualState.imageName}_manual_annotated.png`), 'image/png');
  }
}

// Start app after both modules are defined.
init();
