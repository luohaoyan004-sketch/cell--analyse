/* Manual sampling extension: magnification presets + area-only drawing. */
(function () {
  'use strict';

  const PRESETS = {
    '4': { label: '4× 低倍镜', factorFrom10x: 10 / 4 },
    '10': { label: '10× 中倍镜', factorFrom10x: 1 },
    '20': { label: '20× 高倍镜', factorFrom10x: 10 / 20 }
  };

  const AREA_TYPE = 'area';
  const AREA_BUTTON_ID = 'manualAreaOnlyToolBtn';
  const AREA_PANEL_ID = 'manualAreaOnlyPanel';
  const AREA_CHECKBOX_ID = 'showManualAreas';

  function byId(id) {
    return document.getElementById(id);
  }

  function safeCall(fn) {
    try {
      if (typeof fn === 'function') fn();
    } catch (err) {
      console.warn(err);
    }
  }

  function setupManualMagnificationPreset() {
    const scaleHint = byId('manualScaleHint');
    const scaleUm = byId('manualScaleUm');
    const scalePx = byId('manualScalePx');
    if (!scaleHint || !scaleUm || !scalePx || byId('manualMagnificationPanel')) return;

    const panel = document.createElement('div');
    panel.id = 'manualMagnificationPanel';
    panel.className = 'manualExtraPanel';
    panel.innerHTML = `
      <label class="field">
        <span>按倍镜快速计算</span>
        <select id="manualMagnificationSelect">
          <option value="custom" selected>自定义 / 使用 scale bar</option>
          <option value="4">4× 拍摄</option>
          <option value="10">10× 拍摄</option>
          <option value="20">20× 拍摄</option>
        </select>
      </label>
      <label class="field">
        <span>10× 基准像素大小 μm/px</span>
        <input id="manualBase10xPixelSize" type="number" min="0.0001" step="0.0001" value="0.4" />
      </label>
      <p class="hint">说明：倍镜换算默认以 10× = 0.4 μm/px 为基准。不同显微镜/相机请先用 scale bar 校准一次。</p>
    `;
    scaleHint.insertAdjacentElement('afterend', panel);

    const selector = byId('manualMagnificationSelect');
    const base10 = byId('manualBase10xPixelSize');

    function applyPreset() {
      const mag = selector.value;
      if (mag === 'custom') return;
      const base = Number(base10.value || 0);
      if (!Number.isFinite(base) || base <= 0) return;
      const preset = PRESETS[mag];
      const pixelSizeUm = base * preset.factorFrom10x;
      scaleUm.value = '100';
      scalePx.value = String(roundForInput(100 / pixelSizeUm));
      safeCall(window.manualUpdateScaleHint || manualUpdateScaleHint);
      safeCall(window.manualUpdateResults || manualUpdateResults);
      safeCall(window.manualDraw || manualDraw);
      if (typeof showNotice === 'function') {
        showNotice(`${preset.label}：已换算为 1 pixel = ${pixelSizeUm.toFixed(4)} μm。`);
      }
    }

    selector.addEventListener('change', applyPreset);
    base10.addEventListener('input', applyPreset);
    [scaleUm, scalePx].forEach(input => {
      input.addEventListener('input', () => {
        if (selector.value !== 'custom') selector.value = 'custom';
      });
    });
  }

  function roundForInput(value) {
    if (!Number.isFinite(value)) return 0;
    if (value >= 100) return Math.round(value * 100) / 100;
    return Math.round(value * 10000) / 10000;
  }

  function setupAreaOnlyTool() {
    const toolGrid = document.querySelector('#manualPage .toolGrid');
    if (!toolGrid || byId(AREA_BUTTON_ID)) return;

    const btn = document.createElement('button');
    btn.id = AREA_BUTTON_ID;
    btn.className = 'manualTool';
    btn.dataset.manualMode = AREA_TYPE;
    btn.type = 'button';
    btn.textContent = '只算面积轮廓';
    btn.title = '手动画一个闭合轮廓，只统计面积，不参与细胞数量外推';
    btn.addEventListener('click', () => {
      manualSetMode(AREA_TYPE);
      if (typeof showNotice === 'function') showNotice('面积模式：画闭合轮廓后只计算面积，不计算细胞数量。');
    });
    toolGrid.insertBefore(btn, toolGrid.querySelector('[data-manual-mode="select"]'));

    const checkList = document.querySelector('#manualPage .checkList');
    if (checkList && !byId(AREA_CHECKBOX_ID)) {
      const label = document.createElement('label');
      label.innerHTML = `<input id="${AREA_CHECKBOX_ID}" type="checkbox" checked /> 面积区域`;
      checkList.insertBefore(label, byId('showManualLabels')?.parentElement || null);
      byId(AREA_CHECKBOX_ID).addEventListener('change', () => safeCall(window.manualDraw || manualDraw));
    }
  }

  function setupAreaOnlyPanel() {
    if (byId(AREA_PANEL_ID)) return;
    const summary = document.querySelector('#manualPage .workspace .summary');
    if (!summary) return;
    const panel = document.createElement('section');
    panel.id = AREA_PANEL_ID;
    panel.className = 'panel summary manualAreaOnlyPanel';
    panel.innerHTML = `
      <h2>只计算面积 · 手动画轮廓</h2>
      <div class="cards">
        <div><span>面积区域数量</span><strong id="manualAreaOnlyCount">0</strong></div>
        <div><span>面积区域总面积</span><strong id="manualAreaOnlyTotal">0 μm²</strong></div>
        <div><span>平均单区域面积</span><strong id="manualAreaOnlyMean">0 μm²</strong></div>
        <div><span>面积换算</span><strong id="manualAreaOnlyScale">未校准</strong></div>
      </div>
      <p class="hint" id="manualAreaOnlyHint">选择“只算面积轮廓”，手动画出闭合区域即可。</p>
    `;
    summary.insertAdjacentElement('afterend', panel);
  }

  function patchManualFunctions() {
    if (window.__manualAreaExtensionPatched) return;
    window.__manualAreaExtensionPatched = true;

    const originalManualAddObject = manualAddObject;
    manualAddObject = function patchedManualAddObject(type, polygon, note = '', sourcePath = null) {
      if (type !== AREA_TYPE) return originalManualAddObject(type, polygon, note, sourcePath);
      const group = manualCurrentGroup();
      if (!group || !Array.isArray(polygon) || polygon.length < 3) return;
      if (!manualState.nextCounters.area || !Number.isFinite(manualState.nextCounters.area)) manualState.nextCounters.area = 1;
      const localNo = manualState.nextCounters.area++;
      const obj = {
        id: `${group.id}-A${localNo}`,
        type: AREA_TYPE,
        groupId: group.id,
        polygon,
        sourcePath: Array.isArray(sourcePath) ? sourcePath.map(p => ({ x: p.x, y: p.y })) : null,
        createdAt: new Date().toISOString(),
        note: note || '只计算面积：不参与细胞数量和铺展外推'
      };
      manualState.objects.push(obj);
      manualState.selectedObjectId = obj.id;
      manualSetMode(AREA_TYPE);
      manualUpdateResults();
      manualDraw();
    };

    const originalManualDraw = manualDraw;
    manualDraw = function patchedManualDraw() {
      if (!manualCanvas || !manualCtx) return originalManualDraw();
      if (!manualState.image) return originalManualDraw();
      manualCtx.clearRect(0, 0, manualCanvas.width || 1, manualCanvas.height || 1);
      manualCtx.drawImage(manualState.image, 0, 0);
      const showAreas = byId(AREA_CHECKBOX_ID);
      const order = ['target', 'sample', AREA_TYPE, 'stroke', 'cell'];
      for (const type of order) {
        for (const obj of manualState.objects.filter(o => o.type === type)) {
          const visibleType = obj.type === 'stroke' ? obj.roleType : obj.type;
          if (visibleType === 'sample' && !mels.showSamples.checked) continue;
          if (visibleType === 'target' && !mels.showTargets.checked) continue;
          if (visibleType === 'cell' && !mels.showCells.checked) continue;
          if (visibleType === AREA_TYPE && showAreas && !showAreas.checked) continue;
          manualDrawObject(obj);
        }
      }
      if (manualState.currentPath.length >= 2 && manualState.mode !== 'select') manualDrawPreviewPath(manualState.currentPath);
    };

    const originalManualUpdateResults = manualUpdateResults;
    manualUpdateResults = function patchedManualUpdateResults() {
      originalManualUpdateResults();
      updateAreaOnlyPanel();
      relabelAreaRows();
    };

    const originalManualUpdateActionStates = manualUpdateActionStates;
    manualUpdateActionStates = function patchedManualUpdateActionStates() {
      originalManualUpdateActionStates();
      const areaCheck = byId(AREA_CHECKBOX_ID);
      if (areaCheck) areaCheck.disabled = !manualState.image;
    };

    const originalManualExportJson = manualExportJson;
    manualExportJson = function patchedManualExportJson() {
      if (!manualState.objects.length) return originalManualExportJson();
      const payload = {
        mode: 'manual_sampling_estimation_with_area_only',
        image_name: manualState.imageName,
        pixel_size_um: manualPixelSizeUm(),
        groups: manualState.groups,
        objects: manualState.objects,
        stats: manualComputeAllStats(),
        area_only_stats: computeAreaOnlyStats()
      };
      downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `${manualState.imageName}_manual_sampling_project.json`);
    };
  }

  function computeAreaOnlyStats() {
    const px2 = manualPixelAreaUm2();
    const areaObjects = manualState.objects.filter(o => o.type === AREA_TYPE);
    const totalAreaUm2 = areaObjects.reduce((sum, obj) => sum + polygonAreaAbs(obj.polygon) * px2, 0);
    const groups = manualState.groups.map(group => {
      const objects = areaObjects.filter(o => o.groupId === group.id);
      const areaUm2 = objects.reduce((sum, obj) => sum + polygonAreaAbs(obj.polygon) * px2, 0);
      return { group, count: objects.length, areaUm2 };
    });
    return {
      count: areaObjects.length,
      total_area_um2: totalAreaUm2,
      mean_area_um2: areaObjects.length ? totalAreaUm2 / areaObjects.length : 0,
      groups
    };
  }

  function updateAreaOnlyPanel() {
    setupAreaOnlyPanel();
    const stats = computeAreaOnlyStats();
    setText('manualAreaOnlyCount', formatNum(stats.count));
    setText('manualAreaOnlyTotal', `${formatNum(stats.total_area_um2)} μm²`);
    setText('manualAreaOnlyMean', `${formatNum(stats.mean_area_um2)} μm²`);
    const px = manualPixelSizeUm();
    setText('manualAreaOnlyScale', px ? `${px.toFixed(4)} μm/px` : '未校准');
    const usedGroups = stats.groups.filter(g => g.count > 0);
    const hint = usedGroups.length
      ? usedGroups.map(g => `${g.group.name}: ${g.count} 个，${formatNum(g.areaUm2)} μm²`).join('；')
      : '选择“只算面积轮廓”，手动画出闭合区域即可。';
    setText('manualAreaOnlyHint', hint);
  }

  function relabelAreaRows() {
    for (const obj of manualState.objects.filter(o => o.type === AREA_TYPE)) {
      const row = document.querySelector(`#manualObjectTable tbody tr[data-id="${CSS.escape(obj.id)}"]`);
      if (!row) continue;
      if (row.children[2]) row.children[2].textContent = '只算面积轮廓';
      if (row.children[4]) row.children[4].textContent = '只计算该手绘闭合区域面积，不计细胞数';
    }
    const selected = manualSelectedObject();
    if (selected?.type === AREA_TYPE) {
      const g = manualState.groups.find(gr => gr.id === selected.groupId);
      const area = polygonAreaAbs(selected.polygon) * manualPixelAreaUm2();
      const info = `${selected.id} · ${g?.name || selected.groupId} · 只算面积轮廓 · ${formatNum(area)} μm²`;
      const selectedInfo = byId('manualSelectedInfo');
      if (selectedInfo) selectedInfo.value = info;
    }
  }

  function setText(id, text) {
    const el = byId(id);
    if (el) el.textContent = text;
  }

  function injectExtraStyles() {
    if (byId('manualAreaExtraStyle')) return;
    const style = document.createElement('style');
    style.id = 'manualAreaExtraStyle';
    style.textContent = `
      .manualExtraPanel {
        border: 1px solid rgba(148, 163, 184, 0.35);
        border-radius: 14px;
        padding: 12px;
        margin: 10px 0 18px;
        background: rgba(248, 250, 252, 0.82);
      }
      .manualAreaOnlyPanel { border-left: 4px solid #64748b; }
    `;
    document.head.appendChild(style);
  }

  function boot() {
    try {
      injectExtraStyles();
      setupManualMagnificationPreset();
      setupAreaOnlyTool();
      setupAreaOnlyPanel();
      patchManualFunctions();
      safeCall(window.manualUpdateActionStates || manualUpdateActionStates);
      safeCall(window.manualUpdateResults || manualUpdateResults);
      safeCall(window.manualDraw || manualDraw);
    } catch (err) {
      console.error('manual-area-extra failed:', err);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
