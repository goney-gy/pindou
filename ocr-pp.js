/* ocr-pp.js — 浏览器内 PP-OCRv4 推理引擎（onnxruntime-web）
 * 模型: ch_PP-OCRv4_det / ch_ppocr_mobile_v2.0_cls / ch_PP-OCRv4_rec
 * 依赖: onnxruntime-web (CDN), models/ 目录下的 ONNX 模型与 ppocr_keys_v1.txt
 * 用法:
 *   await PPOCR.load();          // 预加载模型（首次较慢）
 *   const lines = await PPOCR.ocr(canvas);  // [{text, box:[x0,y0,x1,y1,x2,y2,x3,y3], score}]
 */
(function () {
  'use strict';
  const BASE = 'models/';
  const DET_LIMIT = 736;        // det 短边限制
  const DET_MAX_SIDE = 2000;    // det 长边上限
  const DET_THRESH = 0.3;       // DB 概率阈值
  const BOX_THRESH = 0.5;       // 文本框平均分阈值
  const UNCLIP = 1.6;           // 文本框膨胀系数
  const CLS_THRESH = 0.9;
  const REC_H = 48, REC_W = 320;

  let detSess = null, clsSess = null, recSess = null;
  let charset = null, loading = null;
  let watermarkTh = 128 / 255;  // 浅色水印过滤阈值（0~1，0 表示关闭）

  // 灰度提取 + 水印过滤（固定识别黑色与白色正文）：
  //   - 自适应：仅当检测到浅色干扰（浅灰水印/底纹，120~205 亮度）占图比例达标时才启用"黑+白保留"，
  //     干净图不做任何二值化，避免误伤细笔画（实测原图直读即 100% 准确）
  //   - 黑字：亮度 <= 90 → 置黑(0)
  //   - 白字：亮度 >= 200 且周围暗像素占比高（确实印在深色/彩色色块上）→ 转黑(0)，统一黑字白底喂识别模型
  //   - 浅色水印/背景：其余像素 → 置白(1)，彻底抹掉
  function canvasToGray(cv) {
    const c = cv.getContext('2d');
    const { width: w, height: h } = cv;
    const d = c.getImageData(0, 0, w, h).data;
    const n = w * h;
    const g = new Float32Array(n);
    for (let i = 0; i < n; i++) g[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) / 255;
    if (watermarkTh > 0) {
      let lightCnt = 0, whiteCnt = 0;
      for (let i = 0; i < n; i++) {
        const v = g[i] * 255;
        if (v >= 120 && v <= 205) lightCnt++;
        else if (v >= 220) whiteCnt++;
      }
      const lightPct = lightCnt / n, whitePct = whiteCnt / n;
      // 触发判定：浅色干扰必须成片铺开（大面积侵占白底）才算水印；
      // 散点底纹/抗锯齿浅灰不影响 OCR，原图直读准确率更高（实测干净图直读 100%）
      const trigger = lightPct >= 0.25 || (lightPct >= 0.08 && whitePct < 0.45);
      if (trigger) {
        // 局部"暗像素占比"：窗口(R=7)内灰度 <= 140 的像素占比，判定白字是否印在深色/彩色块上
        const R = 7, D = 140 / 255;
        const tmp = new Float32Array(n);
        for (let y = 0; y < h; y++) {
          const base = y * w;
          let s = 0, cnt = 0;
          for (let x = -R; x <= R; x++) if (x >= 0 && x < w) { cnt++; if (g[base + x] <= D) s++; }
          for (let x = 0; x < w; x++) {
            tmp[base + x] = s;
            const out = x - R, inX = x + R + 1;
            if (out >= 0) { cnt--; if (g[base + out] <= D) s--; }
            if (inX < w) { cnt++; if (g[base + inX] <= D) s++; }
          }
        }
        for (let x = 0; x < w; x++) {
          let s = 0, cnt = 0;
          for (let yy = -R; yy <= R; yy++) if (yy >= 0 && yy < h) { cnt++; s += tmp[yy * w + x]; }
          for (let y = 0; y < h; y++) {
            const ratio = cnt ? s / cnt : 0;
            const v = g[y * w + x] * 255;
            g[y * w + x] = (v <= 90 || (v >= 200 && ratio >= 0.55)) ? 0 : 1;
            const outY = y - R, inY = y + R + 1;
            if (outY >= 0) { cnt--; s -= tmp[outY * w + x]; }
            if (inY < h) { cnt++; s += tmp[inY * w + x]; }
          }
        }
      }
    }
    return g;
  }

  function resizeCanvas(cv, nw, nh) {
    const c = document.createElement('canvas');
    c.width = Math.round(nw); c.height = Math.round(nh);
    const cc = c.getContext('2d');
    cc.imageSmoothingEnabled = true; cc.imageSmoothingQuality = 'high';
    cc.drawImage(cv, 0, 0, c.width, c.height);
    return c;
  }

  async function loadModels(onProgress) {
    if (!window.ort) throw new Error('onnxruntime-web 未加载，请先加载 ort.min.js');
    // WASM 运行时优先本地 lib/ort/（离线/内网/手机网络均可用）；由 index.html 按实际加载来源指定兜底 CDN
    ort.env.wasm.wasmPaths = window.ORT_WASM_BASE || 'lib/ort/';
    if (detSess && recSess) return true;
    if (loading) return loading;
    const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    const steps = [
      ['det', 'ch_PP-OCRv4_det_infer.onnx', opts],
      ['cls', 'ch_ppocr_mobile_v2.0_cls_infer.onnx', opts],
      ['rec', 'ch_PP-OCRv4_rec_infer.onnx', opts],
    ];
    loading = (async () => {
      for (let i = 0; i < steps.length; i++) {
        const [key, file, o] = steps[i];
        if (onProgress) onProgress(key, i, steps.length);
        const s = await ort.InferenceSession.create(BASE + file, o);
        if (key === 'det') detSess = s;
        else if (key === 'cls') clsSess = s;
        else recSess = s;
      }
      charset = (await fetch(BASE + 'ppocr_keys_v1.txt').then(r => r.text())).split('\n');
      if (onProgress) onProgress('ready', steps.length, steps.length);
      return true;
    })();
    try { return await loading; }
    finally { loading = null; }
  }

  function isReady() { return !!(detSess && clsSess && recSess && charset); }

  /* ---------------- Det ---------------- */
  function detPreprocess(cv) {
    const { width: w, height: h } = cv;
    const minSide = Math.min(w, h), maxSide = Math.max(w, h);
    let scale = Math.min(DET_LIMIT / minSide, DET_MAX_SIDE / maxSide);
    if (scale >= 1 && maxSide * scale > DET_MAX_SIDE) scale = DET_MAX_SIDE / maxSide;
    let rw = Math.max(1, Math.round(w * scale)), rh = Math.max(1, Math.round(h * scale));
    // 对齐 32 倍数（PP-OCR det padding）
    const pw = Math.ceil(rw / 32) * 32, ph = Math.ceil(rh / 32) * 32;
    const resized = resizeCanvas(cv, pw, ph);
    const g = canvasToGray(resized);           // [pw*ph]
    const tensor = new Float32Array(1 * 3 * ph * pw);
    const mean = 0.5, std = 0.5;
    for (let i = 0; i < pw * ph; i++) {
      const v = (g[i] - mean) / std;          // gray 已 /255
      tensor[i] = v;                          // R 通道
      tensor[pw * ph + i] = v;                // G
      tensor[2 * pw * ph + i] = v;            // B
    }
    return { tensor, scale, rw, rh, pw, ph };
  }

  function dbPostprocess(data, dims, scale, rw, rh) {
    // data: 概率图 Float32Array, dims [1,1,ph,pw]
    const ph = dims[dims.length - 2], pw = dims[dims.length - 1];
    const mask = new Uint8Array(pw * ph);
    const score = new Float32Array(pw * ph);
    for (let i = 0; i < pw * ph; i++) { mask[i] = data[i] >= DET_THRESH ? 1 : 0; score[i] = data[i]; }
    // 3x3 dilation 增强连通
    const dil = new Uint8Array(pw * ph);
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < pw && ny < ph && mask[ny * pw + nx]) { m = 1; break; }
      }
      dil[y * pw + x] = m;
    }
    // flood fill 连通域
    const visited = new Uint8Array(pw * ph);
    const comps = [];
    const stack = [];
    for (let i = 0; i < pw * ph; i++) {
      if (dil[i] && !visited[i]) {
        const pts = [];
        let sumS = 0, cnt = 0;
        stack.length = 0; stack.push(i); visited[i] = 1;
        while (stack.length) {
          const p = stack.pop();
          const x = p % pw, y = (p / pw) | 0;
          pts.push(x, y);
          sumS += score[p]; cnt++;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < pw && ny < ph) {
              const np = ny * pw + nx;
              if (dil[np] && !visited[np]) { visited[np] = 1; stack.push(np); }
            }
          }
        }
        if (cnt >= 4) comps.push({ pts, avgS: sumS / cnt });
      }
    }
    const boxes = [];
    for (const c of comps) {
      if (c.avgS < BOX_THRESH) continue;
      const rect = minAreaRect(c.pts);
      if (!rect || rect.w < 3 || rect.h < 3) continue;
      // unclip
      const w = rect.w * UNCLIP, h = rect.h * UNCLIP;
      // 四角点（以中心旋转 angle）
      const cx = rect.cx, cy = rect.cy, a = rect.angle;
      const cos = Math.cos(a), sin = Math.sin(a);
      const corners = [];
      for (const [dx, dy] of [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]) {
        const x = cx + dx * cos - dy * sin, y = cy + dx * sin + dy * cos;
        corners.push([x / scale, y / scale]);
      }
      boxes.push({ box: corners, score: c.avgS });
    }
    return boxes;
  }

  function minAreaRect(flatPts) {
    const n = flatPts.length / 2;
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += flatPts[i * 2]; my += flatPts[i * 2 + 1]; }
    mx /= n; my /= n;
    let a = 0, b = 0, c = 0;
    for (let i = 0; i < n; i++) {
      const dx = flatPts[i * 2] - mx, dy = flatPts[i * 2 + 1] - my;
      a += dx * dx; b += dy * dy; c += dx * dy;
    }
    if (a + b < 1e-6) return null;
    const ang = 0.5 * Math.atan2(2 * c, a - b);
    const cos = Math.cos(ang), sin = Math.sin(ang);
    let minU = 1e9, maxU = -1e9, minV = 1e9, maxV = -1e9;
    for (let i = 0; i < n; i++) {
      const dx = flatPts[i * 2] - mx, dy = flatPts[i * 2 + 1] - my;
      const u = dx * cos + dy * sin, v = -dx * sin + dy * cos;
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (v < minV) minV = v; if (v > maxV) maxV = v;
    }
    return { cx: mx, cy: my, w: maxU - minU, h: maxV - minV, angle: ang };
  }

  /* ---------------- 裁剪与 Cls ---------------- */
  function cropBox(src, box) {
    // box: 4 点 [[x,y]...] → 轴对齐外接框裁剪（图例文本近似水平，足够）
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (const [x, y] of box) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const pad = 2;
    const x0 = Math.max(0, Math.floor(minX) - pad), y0 = Math.max(0, Math.floor(minY) - pad);
    const w = Math.ceil(maxX - minX) + pad * 2, h = Math.ceil(maxY - minY) + pad * 2;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(src, x0, y0, w, h, 0, 0, w, h);
    return c;
  }

  async function runCls(cv) {
    const r = resizeCanvas(cv, 192, 48);
    const g = canvasToGray(r);
    const t = new Float32Array(1 * 3 * 48 * 192);
    for (let i = 0; i < 48 * 192; i++) {
      const v = (g[i] - 0.5) / 0.5;
      t[i] = v; t[48 * 192 + i] = v; t[2 * 48 * 192 + i] = v;
    }
    const feed = {}; feed[clsSess.inputNames[0]] = new ort.Tensor('float32', t, [1, 3, 48, 192]);
    const out = await clsSess.run(feed);
    const d = out[clsSess.outputNames[0]];
    const probs = d.data;
    if (probs.length >= 2 && probs[1] > CLS_THRESH) return 180;
    return 0;
  }

  /* ---------------- Rec ---------------- */
  async function runRec(cv) {
    // 按宽高比缩放到高 48，宽不超过 320，右/下 pad 0
    const { width: w, height: h } = cv;
    const rh = REC_H;
    let rw = Math.max(1, Math.round(w * (rh / h)));
    if (rw > REC_W) { rw = REC_W; }
    const padW = REC_W, padH = REC_H;
    const c = document.createElement('canvas');
    c.width = padW; c.height = padH;
    const cc = c.getContext('2d');
    cc.fillStyle = '#000'; cc.fillRect(0, 0, padW, padH);
    cc.imageSmoothingEnabled = true; cc.imageSmoothingQuality = 'high';
    cc.drawImage(cv, 0, 0, rw, rh);
    const g = canvasToGray(c);
    const t = new Float32Array(1 * 3 * padH * padW);
    for (let i = 0; i < padH * padW; i++) {
      const v = (g[i] - 0.5) / 0.5;
      t[i] = v; t[padH * padW + i] = v; t[2 * padH * padW + i] = v;
    }
    const feed = {}; feed[recSess.inputNames[0]] = new ort.Tensor('float32', t, [1, 3, padH, padW]);
    const out = await recSess.run(feed);
    const name = recSess.outputNames[0];
    return decodeCtc(out[name]);
  }

  function decodeCtc(tensor) {
    const d = tensor.dims;
    const data = tensor.data;
    const seq = d.length === 3 ? d[1] : d[0];
    const vocab = d.length === 3 ? d[2] : d[1];
    let prev = -1, text = '';
    for (let t = 0; t < seq; t++) {
      const off = t * vocab;
      let bi = 0, bv = -Infinity;
      for (let v = 0; v < vocab; v++) {
        const x = data[off + v];
        if (x > bv) { bv = x; bi = v; }
      }
      if (bi !== 0 && bi !== prev) text += charset[bi - 1] || '';
      prev = bi;
    }
    return text;
  }

  /* ---------------- 主流程 ---------------- */
  async function ocr(srcCanvas) {
    if (!isReady()) throw new Error('PP-OCR 模型未加载');
    const { tensor, scale, rw, rh, pw, ph } = detPreprocess(srcCanvas);
    const feed = {}; feed[detSess.inputNames[0]] = new ort.Tensor('float32', tensor, [1, 3, ph, pw]);
    const out = await detSess.run(feed);
    const name = detSess.outputNames[0];
    const prob = out[name];
    const boxes = dbPostprocess(prob.data, prob.dims, scale, rw, rh);
    const lines = [];
    for (const b of boxes) {
      const crop = cropBox(srcCanvas, b.box);
      if (crop.width < 4 || crop.height < 4) continue;
      const rot = await runCls(crop);
      if (rot === 180) {
        const c2 = document.createElement('canvas');
        c2.width = crop.width; c2.height = crop.height;
        const cc = c2.getContext('2d');
        cc.translate(c2.width / 2, c2.height / 2); cc.rotate(Math.PI);
        cc.drawImage(crop, -c2.width / 2, -c2.height / 2);
        crop.width = c2.width; crop.height = c2.height;
        crop.getContext('2d').drawImage(c2, 0, 0);
      }
      const text = await runRec(crop);
      if (text.trim()) lines.push({ text, box: b.box, score: b.score });
    }
    // 按行聚类排序（y 分组，行内 x 排序），保证从左到右从上到下
    lines.sort((a, b) => {
      const ay = (a.box[0][1] + a.box[2][1]) / 2, by = (b.box[0][1] + b.box[2][1]) / 2;
      const ax = (a.box[0][0] + a.box[2][0]) / 2, bx = (b.box[0][0] + b.box[2][0]) / 2;
      if (Math.abs(ay - by) < 14) return ax - bx;
      return ay - by;
    });
    return lines;
  }

  // 设置水印过滤开关：th>0 开启（固定保留黑色/白色正文，抹掉浅色水印），th<=0 关闭不过滤
  function setWatermark(th) {
    watermarkTh = th > 0 ? 1 : 0;
  }

  window.PPOCR = { load: loadModels, ocr, isReady, setWatermark };
})();
