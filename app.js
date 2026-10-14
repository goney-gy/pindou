// 拼豆图纸GO —— Web 版应用逻辑（浏览器端）
// 依赖：palette.js / pattern.js / viewer.js（均挂到 window 全局）
'use strict';

const PinDou = window.PinDou;
const { computeLayout, drawSheet } = window.PinDouViewer;

const MAX_DIM = 4096; // 导出 PNG 单边尺寸上限

// ---------------- 状态 ----------------
const state = {
  source: null,            // HTMLImageElement
  fileName: '',
  hasResult: false,
  generating: false,
  gridSize: 32,
  customSize: '',
  sizeChips: [16, 24, 32, 48, 56, 64, 100].map(v => ({ v, label: v + '×' + v })),
  systemChips: [
    { v: 'MARD', label: 'MARD 221色' },
    { v: 'COCO', label: 'COCO' },
    { v: '漫漫', label: '漫漫' },
    { v: '盼盼', label: '盼盼' },
    { v: '咪小窝', label: '咪小窝' },
  ],
  colorSystem: 'MARD',
  matchChips: [
    { v: 'lab', label: 'Lab 感知' },
    { v: 'rgb', label: 'RGB 距离' },
  ],
  match: 'lab',
  maxColorChips: [
    { v: 0, label: '不限' },
    { v: 12, label: '≤12 色' },
    { v: 16, label: '≤16 色' },
    { v: 24, label: '≤24 色' },
    { v: 32, label: '≤32 色' },
    { v: 48, label: '≤48 色' },
  ],
  maxColors: 0,
  opts: { blankWhite: true, showNumbers: true, showCoords: true, showGrid: true, showStats: true, highlight: false },
  viewMode: 'pattern',
  gridInfo: '',
  statsList: [],
  auditText: '',
  audit: null,
};

// ---------------- DOM ----------------
const $ = sel => document.querySelector(sel);
const els = {
  fileInput: $('#fileInput'),
  uploadCard: $('#uploadCard'),
  uploadPreview: $('#uploadPreview'),
  uploadPlaceholder: $('#uploadPlaceholder'),
  chooseBtn: $('#chooseBtn'),
  generateBtn: $('#generateBtn'),
  resultCard: $('#resultCard'),
  actionBar: $('#actionBar'),
  sheetCanvas: $('#sheetCanvas'),
  tabs: $('#tabs'),
  statsList: $('#statsList'),
  auditText: $('#auditText'),
  gridInfo: $('#gridInfo'),
  toast: $('#toast'),
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// ---------------- Toast ----------------
let toastTimer = null;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2200);
}

// ---------------- 图片输入 ----------------
els.fileInput.addEventListener('change', e => {
  const file = e.target.files && e.target.files[0];
  if (file) loadFile(file);
  els.fileInput.value = '';
});

function loadFile(file) {
  if (!file.type.startsWith('image/')) { toast('请选择图片文件'); return; }
  const url = URL.createObjectURL(file);
  loadImage(url, file.name);
}

function loadImage(url, name) {
  const img = new Image();
  img.onload = () => {
    state.source = img;
    state.fileName = name || '图片';
    els.uploadPreview.src = url;
    els.uploadPreview.hidden = false;
    els.uploadPlaceholder.hidden = true;
    state.hasResult = false;
    hideResult();
    if (state.generating) { toast('已更换图片，请重新生成'); }
  };
  img.onerror = () => toast('图片加载失败');
  img.src = url;
}

// 粘贴图片
document.addEventListener('paste', e => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const it of items) {
    if (it.type.startsWith('image/')) {
      const file = it.getAsFile();
      if (file) { loadFile(file); return; }
    }
  }
});

// 拖拽图片
let dragDepth = 0;
document.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
document.addEventListener('dragleave', e => { e.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragging'); });
document.addEventListener('dragover', e => { e.preventDefault(); });
document.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) loadFile(file);
});

// ---------------- 参数交互 ----------------
document.addEventListener('click', e => {
  const chip = e.target.closest('[data-chip]');
  if (!chip) return;
  const group = chip.dataset.group;
  const v = chip.dataset.value;
  const num = Number(v);
  if (group === 'grid') { state.gridSize = num; state.customSize = ''; }
  if (group === 'system') state.colorSystem = v;
  if (group === 'match') state.match = v;
  if (group === 'maxColors') state.maxColors = num;
  renderChips();
  if (state.hasResult) generate();
});

// 自定义尺寸
const customInput = $('#customInput');
const customApply = $('#customApply');
customInput.addEventListener('input', () => { state.customSize = customInput.value; customApply.classList.toggle('on', !!customInput.value.trim()); });
customApply.addEventListener('click', () => applyCustomSize());
customInput.addEventListener('keydown', e => { if (e.key === 'Enter') applyCustomSize(); });
function applyCustomSize() {
  const v = parseInt(customInput.value, 10);
  if (!v || v < 8 || v > 150) { toast('请输入 8~150 之间的尺寸'); return; }
  state.gridSize = v;
  renderChips();
  if (state.hasResult) generate();
}

// 开关
document.addEventListener('change', e => {
  const sw = e.target.closest('input[type="checkbox"][data-key]');
  if (!sw) return;
  state.opts[sw.dataset.key] = sw.checked;
  if (state.hasResult) generate();
});

// 视图切换
els.tabs.addEventListener('click', e => {
  const tab = e.target.closest('[data-mode]');
  if (!tab) return;
  state.viewMode = tab.dataset.mode;
  renderTabs();
  renderPreview();
});

// ---------------- 渲染控件 ----------------
function renderChips() {
  // 四个组按顺序重渲染
  const groups = [
    { group: 'grid', chips: state.sizeChips, value: state.gridSize },
    { group: 'system', chips: state.systemChips, value: state.colorSystem },
    { group: 'match', chips: state.matchChips, value: state.match },
    { group: 'maxColors', chips: state.maxColorChips, value: state.maxColors },
  ];
  document.querySelectorAll('[data-chips-group]').forEach((gEl, gi) => {
    const { group, chips, value } = groups[gi];
    gEl.innerHTML = '';
    chips.forEach(c => {
      const b = el('button', 'chip' + (String(c.v) === String(value) ? ' chip-active' : ''), c.label);
      b.type = 'button';
      b.dataset.chip = '';
      b.dataset.group = group;
      b.dataset.value = c.v;
      gEl.appendChild(b);
    });
  });
}

function renderTabs() {
  els.tabs.querySelectorAll('[data-mode]').forEach(t => {
    t.classList.toggle('tab-active', t.dataset.mode === state.viewMode);
  });
}

function renderStats() {
  const block = $('#statsBlock');
  block.hidden = !state.statsList.length;
  els.statsList.innerHTML = '';
  state.statsList.forEach(item => {
    const row = el('div', 'stats-item');
    const swatch = el('div', 'swatch');
    swatch.style.background = item.hex;
    const cell = el('div', 'stats-cell');
    cell.appendChild(el('span', 'stats-code', item.code));
    cell.appendChild(el('span', 'stats-count', `${item.count} 颗 · 备 ${item.spare}`));
    row.appendChild(swatch);
    row.appendChild(cell);
    els.statsList.appendChild(row);
  });
}

function showResult() {
  els.resultCard.hidden = false;
  els.actionBar.hidden = false;
}

function hideResult() {
  els.resultCard.hidden = true;
  els.actionBar.hidden = true;
}

// ---------------- 生成 ----------------
function generate() {
  if (!state.source || state.generating) return;
  const n = state.gridSize;
  state.generating = true;
  els.generateBtn.disabled = true;
  els.generateBtn.classList.add('loading');

  // 离屏 canvas：原图 contain 绘制到 N×N 并取像素
  const off = document.createElement('canvas');
  off.width = n; off.height = n;
  const octx = off.getContext('2d', { willReadFrequently: true });
  const img = state.source;
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const s = Math.min(n / iw, n / ih);
  const dw = iw * s, dh = ih * s;
  const dx = (n - dw) / 2, dy = (n - dh) / 2;
  octx.fillStyle = '#FFFFFF';
  octx.fillRect(0, 0, n, n);
  octx.drawImage(img, dx, dy, dw, dh);
  let imageData;
  try {
    imageData = octx.getImageData(0, 0, n, n);
  } catch (err) {
    toast('图片读取失败，请更换图片');
    state.generating = false;
    els.generateBtn.disabled = false;
    els.generateBtn.classList.remove('loading');
    return;
  }

  // 同步处理，避免 UI 卡顿太久，分片到下一帧
  setTimeout(() => {
    try {
      let pixelData = PinDou.quantizeImageData(imageData, {
        match: state.match,
        blankWhite: state.opts.blankWhite,
        whiteThreshold: 240,
      }).pixelData;
      if (state.maxColors > 0) {
        pixelData = PinDou.limitColors(pixelData, state.maxColors, state.match);
      }

      state.result = { gridSize: n, pixelData };
      state.audit = state.opts.highlight ? PinDou.auditStructure(pixelData, n) : null;
      buildStats();
      state.gridInfo = buildGridInfo();
      state.hasResult = true;
      showResult();
      renderStats();
      buildPreview();
      initCanvas();
    } catch (err) {
      toast('生成失败，请重试');
    } finally {
      state.generating = false;
      els.generateBtn.disabled = false;
      els.generateBtn.classList.remove('loading');
    }
  }, 0);
}

function buildGridInfo() {
  const counts = PinDou.countColors(state.result.pixelData);
  const total = Object.values(counts).reduce((s, c) => s + c, 0);
  const keys = PinDou.sortedColorKeys(counts);
  return `${state.result.gridSize}×${state.result.gridSize} 网格 · ${keys.length} 种色号 · ${total} 颗豆`;
}

function buildStats() {
  const counts = PinDou.countColors(state.result.pixelData);
  const keys = PinDou.sortedColorKeys(counts);
  state.statsList = keys.map(k => ({
    hex: k,
    code: PinDou.getColorKeyByHex(k, state.colorSystem),
    count: counts[k],
    spare: Math.ceil(counts[k] * 1.1),
  }));
  const audit = PinDou.auditStructure(state.result.pixelData, state.result.gridSize);
  const parts = [];
  if (audit.isolatedCount) parts.push(`孤立豆 ${audit.isolatedCount} 个（建议补豆加固）`);
  if (audit.diagonalOnlyCount) parts.push(`仅对角接触 ${audit.diagonalOnlyCount} 个（建议增加连接）`);
  state.auditText = parts.join('；');
  els.auditText.hidden = !state.auditText;
  els.auditText.textContent = state.auditText;
}

function buildPreview() {
  const opts = state.opts;
  state.drawOpts = {
    showGrid: opts.showGrid,
    gridInterval: 10,
    showCoordinates: opts.showCoords,
    showCellNumbers: opts.showNumbers,
    includeStats: opts.showStats,
    system: state.colorSystem,
    title: '拼豆图纸',
    watermark: '',
    highlightIsolated: opts.highlight,
  };
  state.layout = computeLayout(state.result, state.drawOpts, 28);
}

// ---------------- Canvas 预览 ----------------
let view = null, fitScale = 1, ctx = null, rafId = null;

function initCanvas() {
  const node = els.sheetCanvas;
  const rect = node.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  node.width = Math.max(1, Math.floor(rect.width * dpr));
  node.height = Math.max(1, Math.floor(rect.height * dpr));
  ctx = node.getContext('2d');
  node.style.width = rect.width + 'px';
  node.style.height = rect.height + 'px';

  const layout = state.layout;
  fitScale = Math.min(node.width / layout.width, node.height / layout.height) * 0.95;
  view = { scale: fitScale, tx: (node.width - layout.width * fitScale) / 2, ty: (node.height - layout.height * fitScale) / 2 };
  renderPreview();
}

function renderPreview() {
  if (!ctx || !state.layout || !view) return;
  const node = els.sheetCanvas, dpr = window.devicePixelRatio || 1;
  const { scale, tx, ty } = view;
  const mode = state.viewMode;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, node.width, node.height);

  let opts = { ...state.drawOpts, includeStats: state.opts.showStats };
  let data = state.result;

  if (mode === 'original') {
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * tx, dpr * ty);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, state.layout.width, state.layout.height);
    if (state.source) ctx.drawImage(state.source, 0, 0, state.layout.width, state.layout.height);
    return;
  }

  if (mode === 'blank') {
    const blankData = {
      gridSize: state.result.gridSize,
      pixelData: state.result.pixelData.map(c => (c === PinDou.BLANK ? PinDou.BLANK : '#F3F4F8')),
    };
    data = blankData;
    opts = { ...opts, showCellNumbers: false, includeStats: false, showCoordinates: false, highlightIsolated: false };
  } else if (mode === 'pattern') {
    if (!state.opts.showNumbers || scale < 2.5) opts = { ...opts, showCellNumbers: false };
  }

  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * tx, dpr * ty);
  const drawOpts = { ...opts, highlightIsolated: state.opts.highlight };
  if (state.audit) {
    drawOpts.isolatedSet = new Set(state.audit.isolated);
    drawOpts.diagonalSet = new Set(state.audit.diagonalOnly);
  }
  drawSheet(ctx, state.layout, data, drawOpts);
}

// ---------------- 缩放平移（鼠标 + 触控） ----------------
const canvasWrap = $('#canvasWrap');

canvasWrap.addEventListener('wheel', e => {
  e.preventDefault();
  if (!view) return;
  const rect = canvasWrap.getBoundingClientRect();
  const px = e.clientX - rect.left, py = e.clientY - rect.top;
  const ratio = Math.exp(-e.deltaY * 0.001);
  zoomAt(px, py, ratio);
}, { passive: false });

function zoomAt(px, py, ratio) {
  const newScale = Math.max(fitScale * 0.2, Math.min(fitScale * 25, view.scale * ratio));
  const k = newScale / view.scale;
  view.tx = px - (px - view.tx) * k;
  view.ty = py - (py - view.ty) * k;
  view.scale = newScale;
  scheduleRender();
}

// Pointer Events：统一鼠标/触控
let pointers = new Map();
let lastPinchDist = 0;

canvasWrap.addEventListener('pointerdown', e => {
  canvasWrap.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  lastPinchDist = 0;
});

canvasWrap.addEventListener('pointermove', e => {
  if (!view) return;
  const prev = pointers.get(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1 && prev) {
    // 单指/鼠标拖拽平移
    if (e.pointerType === 'mouse' && e.buttons !== 1) { pointers.delete(e.pointerId); return; }
    view.tx += (e.clientX - prev.x) * (window.devicePixelRatio || 1);
    view.ty += (e.clientY - prev.y) * (window.devicePixelRatio || 1);
    scheduleRender();
  } else if (pointers.size >= 2) {
    // 双指缩放，以两指中点为锚
    const pts = Array.from(pointers.values());
    const a = pts[0], b = pts[1];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const rect = canvasWrap.getBoundingClientRect();
    const midX = a.x + (b.x - a.x) / 2, midY = a.y + (b.y - a.y) / 2;
    if (lastPinchDist > 0) {
      zoomAt(midX - rect.left, midY - rect.top, dist / lastPinchDist);
    }
    lastPinchDist = dist;
  }
});

function clearPointer(e) {
  pointers.delete(e.pointerId);
  lastPinchDist = 0;
}
canvasWrap.addEventListener('pointerup', clearPointer);
canvasWrap.addEventListener('pointercancel', clearPointer);
canvasWrap.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') pointers.delete(e.pointerId); });

function scheduleRender() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => { rafId = null; renderPreview(); });
}

window.addEventListener('resize', () => { if (state.hasResult) initCanvas(); });

// ---------------- 导出 PNG ----------------
function exportPng() {
  if (!state.result) return;
  const opts = { ...state.drawOpts, showCellNumbers: true };
  const CELL = 30;
  const layout = computeLayout(state.result, opts, CELL);
  let scale = 1;
  const maxDim = Math.max(layout.width, layout.height);
  if (maxDim > MAX_DIM) scale = MAX_DIM / maxDim;

  const W = Math.round(layout.width * scale);
  const H = Math.round(layout.height * scale);
  const off = document.createElement('canvas');
  off.width = W; off.height = H;
  const octx = off.getContext('2d');
  octx.setTransform(scale, 0, 0, scale, 0, 0);
  const drawOpts = { ...opts };
  if (state.audit) {
    drawOpts.highlightIsolated = state.opts.highlight;
    drawOpts.isolatedSet = new Set(state.audit.isolated);
    drawOpts.diagonalSet = new Set(state.audit.diagonalOnly);
  }
  drawSheet(octx, layout, state.result, drawOpts);

  off.toBlob(blob => {
    if (!blob) { toast('导出失败'); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `拼豆图纸_${state.result.gridSize}x${state.result.gridSize}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('图纸已导出');
  }, 'image/png');
}

// ---------------- 导出 CSV ----------------
function exportCsv() {
  if (!state.result) return;
  const csv = PinDou.buildStatsCSV(state.result.pixelData, state.colorSystem);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `拼豆清单_${state.result.gridSize}x${state.result.gridSize}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('物料清单已导出');
}

// ---------------- 事件绑定 ----------------
els.chooseBtn.addEventListener('click', () => els.fileInput.click());
els.uploadCard.addEventListener('click', () => els.fileInput.click());
els.generateBtn.addEventListener('click', () => generate());
document.querySelectorAll('[data-action="png"]').forEach(b => b.addEventListener('click', exportPng));
document.querySelectorAll('[data-action="csv"]').forEach(b => b.addEventListener('click', exportCsv));

// 初次渲染控件
renderChips();
