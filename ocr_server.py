#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本地 OCR 代理服务（RapidOCR / PP-OCRv4，完全离线，不上传）
供 pindou-web/index.html 的"本地 OCR 引擎"开关调用。

接口：
  GET  /health                  -> {"ok": true}
  POST /ocr                     -> {"text": "...", "items": [...]}
        body: {"image": "<dataURL 或裸 base64>"}

用法：python ocr_server.py [端口]   （默认 8765）
"""
import base64
import io
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from PIL import Image
from rapidocr_onnxruntime import RapidOCR

_ocr = None


def get_ocr():
    global _ocr
    if _ocr is None:
        _ocr = RapidOCR()
    return _ocr


def _filter_watermark(img):
    """固定识别黑色与白色正文，抹掉浅色水印；自适应触发：浅色干扰(120~205)须成片铺开
    （>=25%，或 >=8% 且白底>=220 占<45%）才判定为水印，散点底纹/抗锯齿浅灰不触发（原图直读准确率更高）。
    黑字(亮度<=90)保留为黑；白字(亮度>=200 且周围暗像素占比>=0.55，即印在深色/彩色块上)转黑；
    其余像素(浅色水印/背景/浅色块)一律置白。"""
    g = np.asarray(img.convert("L"), dtype=np.float32)
    light_pct = ((g >= 120.0) & (g <= 205.0)).mean()
    white_pct = (g >= 220.0).mean()
    if not (light_pct >= 0.25 or (light_pct >= 0.08 and white_pct < 0.45)):
        return img
    H, W = g.shape
    r = 7
    # 积分图求窗口内暗像素(<=140)占比，用于判定白字是否印在深色/彩色块上
    gpad = np.pad((g <= 140.0), (r, r), mode="edge").astype(np.float32)
    pad = np.zeros((H + 2 * r + 1, W + 2 * r + 1), dtype=np.float32)
    pad[1:, 1:] = np.cumsum(np.cumsum(gpad, axis=0), axis=1)
    ii, jj = np.mgrid[0:H, 0:W]
    dwin = (
        pad[ii + 2 * r + 1, jj + 2 * r + 1]
        - pad[ii, jj + 2 * r + 1]
        - pad[ii + 2 * r + 1, jj]
        + pad[ii, jj]
    ) / ((2 * r + 1) ** 2)
    keep = (g <= 90.0) | ((g >= 200.0) & (dwin >= 0.55))
    out = np.where(keep, 0.0, 255.0).astype(np.uint8)
    return Image.merge("RGB", [Image.fromarray(out)] * 3)


def _line_ordered(result):
    """把 RapidOCR 结果(按阅读顺序)聚成行：y 中心容差内视为同行，行内按 x 排序。"""
    items = []
    for box, text, score in result:
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        items.append({
            "text": str(text),
            "score": float(score),
            "box": [float(min(xs)), float(min(ys)), float(max(xs)), float(max(ys))],
        })
    items.sort(key=lambda it: ((it["box"][1] + it["box"][3]) / 2, it["box"][0]))
    lines = []
    tol = 14
    for it in items:
        yc = (it["box"][1] + it["box"][3]) / 2
        if lines and abs(yc - lines[-1]["yc"]) <= tol:
            lines[-1]["items"].append(it)
            n = len(lines[-1]["items"])
            lines[-1]["yc"] = (lines[-1]["yc"] * (n - 1) + yc) / n
        else:
            lines.append({"yc": yc, "items": [it]})
    rows = []
    for ln in lines:
        ln["items"].sort(key=lambda it: it["box"][0])
        parts = []
        prev_right = None
        for x in ln["items"]:
            if prev_right is not None and x["box"][0] - prev_right > 8:  # 块间有明显空隙则加空格，避免粘连成"12D02"
                parts.append(" ")
            parts.append(x["text"])
            prev_right = x["box"][2]
        rows.append("".join(parts))
    return rows, items


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/health"):
            self._send_json(200, {"ok": True, "engine": "rapidocr", "alive": True})
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
            if length <= 0 or length > 20 * 1024 * 1024:
                self._send_json(400, {"error": "bad body size"})
                return
            raw = self.rfile.read(length)
            payload = json.loads(raw.decode("utf-8"))
            b64 = payload.get("image", "")
            if "," in b64 and b64.strip().startswith("data:"):
                b64 = b64.split(",", 1)[1]
            img_bytes = base64.b64decode(b64)
            img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
            # 水印过滤（固定识别黑色/白色正文，抹掉浅色水印）。
            # 请求可传 watermark（>0 开启，0/None 关闭），默认开启
            wm = payload.get("watermark", 1)
            if wm is None:
                wm = 0
            try:
                wm = int(wm)
            except (TypeError, ValueError):
                wm = 1
            if wm > 0:
                img = _filter_watermark(img)
            arr = np.array(img)
            result, _ = get_ocr()(arr)
            if not result:
                self._send_json(200, {"text": "", "items": []})
                return
            rows, items = _line_ordered(result)
            self._send_json(200, {"text": "\n".join(rows), "items": items})
        except Exception as e:  # noqa: BLE001
            self._send_json(500, {"error": str(e)})


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    host = "127.0.0.1"
    srv = ThreadingHTTPServer((host, port), Handler)
    print(f"RapidOCR 服务已启动 http://{host}:{port}  (Ctrl+C 退出)", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()