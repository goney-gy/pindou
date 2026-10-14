// 图纸布局 + 绘制（小程序版，移植自 Web 版 js/viewer.js）
// 依赖: ./pattern.js
// 说明: 仅保留 computeLayout / drawSheet 两个纯 Canvas 2D 函数，
//       缩放平移交互由页面层 touch 事件实现；roundRect 用 arcTo 实现，避免依赖环境。
'use strict';

const PinDou = (typeof require === 'function') ? require('./pattern.js') : window.PinDou;

const FONT_STACK = 'PingFang SC, Microsoft YaHei, Noto Sans CJK SC, sans-serif';

/** 兼容各环境的圆角矩形（小程序 Canvas 2D / Web 2D 均可） */
function rr(ctx, x, y, w, h, r) {
  if (typeof r === 'number') r = [r, r, r, r];
  const [tl, tr, br, bl] = [r[0], r[1], r[2], r[3]];
  ctx.beginPath();
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  ctx.arcTo(x + w, y, x + w, y + tr, tr);
  ctx.lineTo(x + w, y + h - br);
  ctx.arcTo(x + w, y + h, x + w - br, y + h, br);
  ctx.lineTo(x + bl, y + h);
  ctx.arcTo(x, y + h, x, y + h - bl, bl);
  ctx.lineTo(x, y + tl);
  ctx.arcTo(x, y, x + tl, y, tl);
  ctx.closePath();
}

/**
 * 计算图纸布局（与导出 PNG 共用同一套规则）
 */
function computeLayout(data, opts, CELL) {
  const N = data.gridSize;
  const { showCoordinates = true, includeStats = true } = opts;
  const axisLabelSize = showCoordinates ? Math.max(30, Math.floor(CELL)) : 0;
  const statsPadding = 20;
  const preCalcWidth = N * CELL + axisLabelSize;
  const preCalcAvailableWidth = preCalcWidth - statsPadding * 2;
  const widthFactor = Math.max(0, preCalcAvailableWidth - 350) / 600;
  const statsFontSize = Math.floor(13 + widthFactor * 10);

  const extraLeftMargin = showCoordinates ? Math.max(20, statsFontSize * 2) : 0;
  const extraRightMargin = showCoordinates ? Math.max(20, statsFontSize * 2) : 0;
  const extraTopMargin = showCoordinates ? Math.max(15, statsFontSize) : 0;
  const extraBottomMargin = showCoordinates ? Math.max(15, statsFontSize) : 0;

  const gridWidth = N * CELL;
  const gridHeight = N * CELL;
  const initialWidth = gridWidth + axisLabelSize + extraLeftMargin;
  const titleBarScale = Math.max(1.0, Math.min(2.0, initialWidth / 1000));
  const titleBarHeight = Math.floor(80 * titleBarScale);
  const titleFontSize = Math.max(28, Math.floor(28 * titleBarScale));

  const colorCounts = PinDou.countColors(data.pixelData);
  const totalBeadCount = Object.values(colorCounts).reduce((s, c) => s + c, 0);
  const colorKeys = PinDou.sortedColorKeys(colorCounts);

  let statsHeight = 0;
  if (includeStats && colorKeys.length > 0) {
    const numColumns = Math.max(1, Math.min(4, Math.floor(preCalcAvailableWidth / 250)));
    const swatchSize = Math.floor(18 + widthFactor * 20);
    const numRows = Math.ceil(colorKeys.length / numColumns);
    const statsRowHeight = Math.max(swatchSize + 8, 25);
    statsHeight = 40 + numRows * statsRowHeight + 40 + statsPadding * 2 + 24;
  }

  const width = gridWidth + axisLabelSize * 2 + extraLeftMargin + extraRightMargin;
  const height = titleBarHeight + gridHeight + axisLabelSize * 2 + statsHeight + extraTopMargin + extraBottomMargin;

  return {
    CELL, N, axisLabelSize, statsPadding, widthFactor, statsFontSize,
    extraLeftMargin, extraRightMargin, extraTopMargin, extraBottomMargin,
    gridWidth, gridHeight, titleBarHeight, titleFontSize,
    colorCounts, totalBeadCount, colorKeys, statsHeight,
    width, height,
    gridX: extraLeftMargin + axisLabelSize,
    gridY: titleBarHeight + extraTopMargin + axisLabelSize,
  };
}

/**
 * 绘制整张图纸
 * @param ctx 已按缩放比例 setTransform 的 2D 上下文
 * @param layout computeLayout 的结果
 * @param data {gridSize, pixelData}
 * @param opts 绘制选项
 */
function drawSheet(ctx, layout, data, opts) {
  const N = layout.N, CELL = layout.CELL;
  const {
    showGrid = true, gridInterval = 10, showCoordinates = true,
    showCellNumbers = true, gridLineColor = '#555555', includeStats = true,
    system = 'MARD', title = '拼豆图纸', watermark = '',
    highlightIsolated = false, isolatedSet = null, diagonalSet = null,
    originalImage = null, showOriginal = false,
  } = opts;
  const { pixelData } = data;
  const {
    axisLabelSize, statsPadding, statsFontSize, titleBarHeight, titleFontSize,
    extraLeftMargin, extraTopMargin, gridX, gridY, gridWidth, gridHeight,
    colorCounts, totalBeadCount, colorKeys,
  } = layout;
  const W = layout.width, H = layout.height;
  const mainTitleFontSize = Math.max(20, Math.floor(titleFontSize * 0.8));
  const subTitleFontSize = Math.max(12, Math.floor(titleFontSize * 0.45));
  const cellFontSize = Math.max(8, Math.floor(CELL * 0.4));

  // 白底
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, W, H);

  // 深色标题栏 + 品牌渐变块
  ctx.fillStyle = '#1F2937';
  ctx.fillRect(0, 0, W, titleBarHeight);
  const brandBlockWidth = titleBarHeight * 0.8;
  const grad = ctx.createLinearGradient(0, 0, brandBlockWidth, titleBarHeight);
  grad.addColorStop(0, '#6366F1');
  grad.addColorStop(1, '#8B5CF6');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, brandBlockWidth, titleBarHeight);

  // 3×3 拼豆 Logo
  const logoSize = titleBarHeight * 0.4;
  const beadSize = logoSize / 4;
  const beadSpacing = beadSize * 1.2;
  const logoCX = brandBlockWidth / 2;
  const logoCY = titleBarHeight / 2;
  ctx.fillStyle = '#FFFFFF';
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const bx = logoCX - logoSize / 2 + col * beadSpacing;
      const by = logoCY - logoSize / 2 + row * beadSpacing;
      rr(ctx, bx, by, beadSize, beadSize, beadSize * 0.2);
      ctx.fill();
    }
  }

  // 标题 + 副标题
  const titleStartX = brandBlockWidth + titleBarHeight * 0.3;
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `bold ${mainTitleFontSize}px ${FONT_STACK}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const titleText = watermark ? `${title}（${watermark}）` : title;
  ctx.fillText(titleText, titleStartX, titleBarHeight * 0.4);
  ctx.font = `${subTitleFontSize}px ${FONT_STACK}`;
  ctx.globalAlpha = 0.8;
  ctx.fillText(`${N}×${N} 网格 · ${system} 色号`, titleStartX, titleBarHeight * 0.65);
  ctx.globalAlpha = 1;

  // 坐标轴（四周浅灰条 + 1 基编号，标第 1/最后/每 interval 格）
  if (showCoordinates) {
    const stripTopY = titleBarHeight + extraTopMargin;
    const stripBottomY = gridY + gridHeight;
    ctx.fillStyle = '#F5F5F5';
    ctx.fillRect(gridX, stripTopY, gridWidth, axisLabelSize);
    ctx.fillRect(gridX, stripBottomY, gridWidth, axisLabelSize);
    ctx.fillRect(extraLeftMargin, gridY, axisLabelSize, gridHeight);
    ctx.fillRect(gridX + gridWidth, gridY, axisLabelSize, gridHeight);

    ctx.fillStyle = '#333333';
    ctx.font = `14px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < N; i++) {
      if ((i + 1) % gridInterval === 0 || i === 0 || i === N - 1) {
        const x = gridX + i * CELL + CELL / 2;
        ctx.fillText(String(i + 1), x, stripTopY + axisLabelSize / 2);
        ctx.fillText(String(i + 1), x, stripBottomY + axisLabelSize / 2);
      }
    }
    for (let j = 0; j < N; j++) {
      if ((j + 1) % gridInterval === 0 || j === 0 || j === N - 1) {
        const y = gridY + j * CELL + CELL / 2;
        ctx.fillText(String(j + 1), extraLeftMargin + axisLabelSize / 2, y);
        ctx.fillText(String(j + 1), gridX + gridWidth + axisLabelSize / 2, y);
      }
    }
  }

  // 色块（+ 格内色号；白格留空）
  if (showOriginal && originalImage) {
    ctx.drawImage(originalImage, gridX, gridY, gridWidth, gridHeight);
  } else {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const color = pixelData[j * N + i];
        if (color === PinDou.BLANK) continue;
        const x = gridX + i * CELL;
        const y = gridY + j * CELL;
        ctx.fillStyle = color;
        ctx.fillRect(x, y, CELL, CELL);
        if (showCellNumbers) {
          ctx.fillStyle = PinDou.getContrastColor(color);
          ctx.font = `bold ${cellFontSize}px ${FONT_STACK}`;
          ctx.fillText(PinDou.getColorKeyByHex(color, system), x + CELL / 2, y + CELL / 2);
        }
      }
    }
  }

  // 结构问题标记（孤立豆红圈、仅对角橙圈）
  if (highlightIsolated && !showOriginal) {
    const ring = (index, color) => {
      const r = Math.floor(index / N), c = index % N;
      const x = gridX + c * CELL + CELL / 2;
      const y = gridY + r * CELL + CELL / 2;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(2, CELL * 0.12);
      ctx.beginPath();
      ctx.arc(x, y, CELL * 0.38, 0, Math.PI * 2);
      ctx.stroke();
    };
    if (isolatedSet) isolatedSet.forEach(i => ring(i, '#E11D48'));
    if (diagonalSet) diagonalSet.forEach(i => ring(i, '#F59E0B'));
  }

  // 每格浅灰细线
  ctx.strokeStyle = '#DDDDDD';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  for (let i = 0; i <= N; i++) {
    const x = gridX + i * CELL;
    ctx.moveTo(x, gridY);
    ctx.lineTo(x, gridY + gridHeight);
  }
  for (let j = 0; j <= N; j++) {
    const y = gridY + j * CELL;
    ctx.moveTo(gridX, y);
    ctx.lineTo(gridX + gridWidth, y);
  }
  ctx.stroke();

  // 每隔 interval 格加重线
  if (showGrid) {
    ctx.strokeStyle = gridLineColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = gridInterval; i < N; i += gridInterval) {
      const x = gridX + i * CELL;
      ctx.moveTo(x, gridY);
      ctx.lineTo(x, gridY + gridHeight);
    }
    for (let j = gridInterval; j < N; j += gridInterval) {
      const y = gridY + j * CELL;
      ctx.moveTo(gridX, y);
      ctx.lineTo(gridX + gridWidth, y);
    }
    ctx.stroke();
  }

  // 外边框
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(gridX, gridY, gridWidth, gridHeight);

  // 色号统计区
  if (includeStats && colorKeys.length > 0) {
    const statsTopMargin = 24;
    const statsY = titleBarHeight + extraTopMargin + N * CELL + axisLabelSize * 2 + statsPadding + statsTopMargin;
    const availableStatsWidth = W - statsPadding * 2;
    const numColumns = Math.max(1, Math.min(4, Math.floor(availableStatsWidth / 250)));
    const swatchSize = Math.floor(18 + layout.widthFactor * 20);
    const itemWidth = Math.floor(availableStatsWidth / numColumns);
    const titleHeight = 30;
    const statsRowHeight = Math.max(swatchSize + 8, 25);

    ctx.fillStyle = '#333333';
    ctx.font = `bold ${Math.max(16, statsFontSize)}px ${FONT_STACK}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('色号统计', statsPadding, statsY + 15);
    ctx.strokeStyle = '#DDDDDD';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(statsPadding, statsY + 20);
    ctx.lineTo(W - statsPadding, statsY + 20);
    ctx.stroke();

    ctx.textBaseline = 'middle';
    colorKeys.forEach((key, index) => {
      const rowIndex = Math.floor(index / numColumns);
      const colIndex = index % numColumns;
      const itemX = statsPadding + colIndex * itemWidth;
      const rowY = statsY + titleHeight + rowIndex * statsRowHeight + swatchSize / 2;
      const count = colorCounts[key];

      ctx.fillStyle = key;
      ctx.fillRect(itemX, rowY - swatchSize / 2, swatchSize, swatchSize);
      ctx.strokeStyle = '#CCCCCC';
      ctx.lineWidth = 1;
      ctx.strokeRect(itemX, rowY - swatchSize / 2, swatchSize, swatchSize);

      ctx.fillStyle = '#333333';
      ctx.font = `${statsFontSize}px ${FONT_STACK}`;
      ctx.textAlign = 'left';
      ctx.fillText(PinDou.getColorKeyByHex(key, system), itemX + swatchSize + 5, rowY);

      const countX = numColumns === 1 ? W - statsPadding : itemX + itemWidth - 10;
      ctx.textAlign = 'right';
      ctx.fillText(`${count} 颗`, countX, rowY);
    });

    const numRows = Math.ceil(colorKeys.length / numColumns);
    const totalY = statsY + titleHeight + numRows * statsRowHeight + 10;
    ctx.font = `bold ${statsFontSize}px ${FONT_STACK}`;
    ctx.textAlign = 'right';
    ctx.fillText(`总计: ${totalBeadCount} 颗`, W - statsPadding, totalY);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computeLayout, drawSheet };
} else {
  window.PinDouViewer = { computeLayout, drawSheet };
}
