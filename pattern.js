// 拼豆图纸核心算法（小程序版，移植自 pindou-pattern skill 的 pattern.js）
// 依赖: ./palette.js（CommonJS）
// 说明: 与 Web 版唯一差异——移除了依赖 DOM 的 drawImageToGrid，
//       「图片 → N×N 像素」的绘制由页面层用 canvas 2d 完成。
'use strict';

const __palette = (typeof require === 'function') ? require('./palette.js') : (window.PinDouPalette || {});
const { PINDOU_PALETTE, PINDOU_BRANDS } = __palette;

const PALETTE = (PINDOU_PALETTE || []).map(([hex, codes]) => ({ hex, codes }));
const BRANDS = PINDOU_BRANDS || ['MARD', 'COCO', '漫漫', '盼盼', '咪小窝'];
const ALL_HEX = PALETTE.map(p => p.hex);
const HEX_MAP = {};
PALETTE.forEach(p => { HEX_MAP[p.hex] = p.codes; });
const BLANK = '#FFFFFF'; // 空格标记（不买豆）

// ---------------- 颜色基础工具 ----------------

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return { r, g, b };
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(x => {
    const h = Math.round(x).toString(16);
    return h.length === 1 ? '0' + h : h;
  }).join('').toUpperCase();
}

// Luma 公式：>0.5 视为浅色背景（黑字），否则白字
function getContrastColor(hex) {
  const { r, g, b } = hexToRgb(hex);
  const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luma > 0.5 ? '#000000' : '#FFFFFF';
}

function rgbDistance(c1, c2) {
  const dr = c1.r - c2.r;
  const dg = c1.g - c2.g;
  const db = c1.b - c2.b;
  return dr * dr + dg * dg + db * db;
}

// sRGB -> CIE Lab（D65），用于感知色差匹配
function rgbToLab({ r, g, b }) {
  const f = x => {
    x /= 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  const [rl, gl, bl] = [f(r), f(g), f(b)];
  let x = (rl * 0.4124 + gl * 0.3576 + bl * 0.1805) / 0.95047;
  let y = rl * 0.2126 + gl * 0.7152 + bl * 0.0722;
  let z = (rl * 0.0193 + gl * 0.1192 + bl * 0.9505) / 1.08883;
  const g2 = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = g2(x); y = g2(y); z = g2(z);
  return { L: 116 * y - 16, a: 500 * (x - y), b: 200 * (y - z) };
}

function labDistance(c1, c2) {
  const dL = c1.L - c2.L;
  const da = c1.a - c2.a;
  const db = c1.b - c2.b;
  return dL * dL + da * da + db * db;
}

/**
 * 在调色板中找最接近的颜色
 * @param hex 目标 HEX 颜色
 * @param palette HEX 数组
 * @param mode 'rgb'（欧氏距离）| 'lab'（感知色差，通常更接近人眼判断）
 */
function findClosestColor(hex, palette = ALL_HEX, mode = 'rgb') {
  if (palette.includes(hex)) return hex;
  const target = hexToRgb(hex);
  if (mode === 'lab') {
    const targetLab = rgbToLab(target);
    let best = palette[0];
    let bestDist = Infinity;
    for (const p of palette) {
      const d = labDistance(targetLab, rgbToLab(hexToRgb(p)));
      if (d < bestDist) { bestDist = d; best = p; }
    }
    return best;
  }
  let best = palette[0];
  let bestDist = Infinity;
  for (const p of palette) {
    const d = rgbDistance(target, hexToRgb(p));
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return best;
}

// ---------------- 色号与统计 ----------------

function getColorKeyByHex(hex, colorSystem) {
  const c = HEX_MAP[hex.toUpperCase()];
  if (!c) return hex;
  const idx = BRANDS.indexOf(colorSystem);
  if (idx > 0 && c[idx]) return c[idx];
  return c[0] || hex; // 默认优先 MARD 代码
}

// 统计各颜色用量，排除 #FFFFFF（空格不买豆子）
function countColors(pixelData) {
  const counts = {};
  for (const color of pixelData) {
    if (color === BLANK) continue;
    const key = color.toUpperCase();
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function sortedColorKeys(counts) {
  // 按色号字典序排序（A01 < B01 < C01 ...）
  return Object.keys(counts).sort((a, b) => {
    const ka = getColorKeyByHex(a, 'MARD');
    const kb = getColorKeyByHex(b, 'MARD');
    return ka.localeCompare(kb, 'en', { numeric: true });
  });
}

/**
 * 色数收敛：把用量最少的颜色合并到视觉最接近的高频色
 * @param pixelData 像素数组（值为调色板内 HEX，#FFFFFF 为空格）
 * @param maxColors 保留的颜色数上限（>=2）
 * @param mode 'rgb' | 'lab'
 */
function limitColors(pixelData, maxColors, mode = 'rgb') {
  const counts = countColors(pixelData);
  const keys = Object.keys(counts);
  if (keys.length <= maxColors) return pixelData;

  const kept = keys.slice().sort((a, b) => counts[b] - counts[a]).slice(0, maxColors);
  const remap = {};
  for (const k of keys) {
    if (kept.includes(k)) { remap[k] = k; continue; }
    remap[k] = findClosestColor(k, kept, mode);
  }
  return pixelData.map(c => (c === BLANK ? c : remap[c] || c));
}

// CSV 物料清单（带 BOM，Excel 打开中文不乱码）
function buildStatsCSV(pixelData, colorSystem) {
  const counts = countColors(pixelData);
  const keys = sortedColorKeys(counts);
  const total = keys.reduce((s, k) => s + counts[k], 0);
  const lines = ['\uFEFF色号,HEX颜色,数量(颗),建议备豆(颗)'];
  for (const k of keys) {
    const spare = Math.ceil(counts[k] * 1.1);
    lines.push(`${getColorKeyByHex(k, colorSystem)},${k},${counts[k]},${spare}`);
  }
  lines.push(`总计,${keys.length} 种,${total},${Math.ceil(total * 1.1)}`);
  return lines.join('\n') + '\n';
}

// ---------------- 图片量化 ----------------

/**
 * 图片像素 -> 调色板 HEX 数组
 * @param imageData 目标网格尺寸的 ImageData（来自页面层 canvas 2d getImageData）
 * @param opts {match, blankWhite, whiteThreshold}
 */
function quantizeImageData(imageData, opts = {}) {
  const { match = 'rgb', blankWhite = false, whiteThreshold = 240 } = opts;
  const { data, width, height } = imageData;
  const pixelData = [];
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (blankWhite && r >= whiteThreshold && g >= whiteThreshold && b >= whiteThreshold) {
      pixelData.push(BLANK);
    } else {
      pixelData.push(findClosestColor(rgbToHex(r, g, b), ALL_HEX, match));
    }
  }
  if (width !== height) throw new Error('量化画布必须为正方形');
  return { gridSize: width, pixelData };
}

// ---------------- 结构检查（4 邻接） ----------------

/**
 * 结构审计：孤立豆（无上下左右 4 邻接）、仅对角接触豆
 * @returns {isolated:[index,...], diagonalOnly:[index,...]}
 */
function auditStructure(pixelData, n) {
  const idx = i => i >= 0 && i < n;
  const cellAt = (r, c) => (idx(r) && idx(c) ? pixelData[r * n + c] : BLANK);
  const isolated = [];
  const diagonalOnly = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const i = r * n + c;
      if (pixelData[i] === BLANK) continue;
      const up = cellAt(r - 1, c), down = cellAt(r + 1, c);
      const left = cellAt(r, c - 1), right = cellAt(r, c + 1);
      const ortho = [up, down, left, right].filter(v => v !== BLANK).length;
      if (ortho === 0) {
        const diag = [cellAt(r - 1, c - 1), cellAt(r - 1, c + 1), cellAt(r + 1, c - 1), cellAt(r + 1, c + 1)]
          .filter(v => v !== BLANK).length;
        if (diag > 0) diagonalOnly.push(i);
        else isolated.push(i);
      }
    }
  }
  return { isolated, diagonalOnly, isolatedCount: isolated.length, diagonalOnlyCount: diagonalOnly.length };
}

const __exports = {
  PALETTE, BRANDS, ALL_HEX, BLANK,
  hexToRgb, rgbToHex, getContrastColor,
  findClosestColor, getColorKeyByHex,
  countColors, sortedColorKeys, limitColors,
  buildStatsCSV, quantizeImageData, auditStructure,
};
if (typeof module !== 'undefined' && module.exports) {
  module.exports = __exports;
} else {
  window.PinDou = __exports;
}
