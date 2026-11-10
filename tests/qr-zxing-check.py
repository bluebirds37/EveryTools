#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""第三方解码器验证：把我方编码器输出的 QR 矩阵渲染成 PNG，用 zxing-cpp 解码，断言 100% 还原原文。
   用法：python tests/qr-zxing-check.py [矩阵json] [输出json]
   默认输入 /tmp/qr_for_zxing.json，输出 /tmp/qr_zxing_result.json
"""
import json
import sys

import numpy as np
import zxingcpp
from PIL import Image

IN = sys.argv[1] if len(sys.argv) > 1 else "/tmp/qr_for_zxing.json"
OUT = sys.argv[2] if len(sys.argv) > 2 else "/tmp/qr_zxing_result.json"
MODULE = 6
QUIET = 4


def render(matrix):
    n = len(matrix)
    grid = np.array([[int(c) for c in row] for row in matrix], dtype=np.uint8)
    big = np.kron(grid, np.ones((MODULE, MODULE), dtype=np.uint8))
    pad = np.ones((n * MODULE + QUIET * 2 * MODULE, n * MODULE + QUIET * 2 * MODULE), dtype=np.uint8) * 255
    inner = (1 - big) * 255
    off = QUIET * MODULE
    pad[off:off + inner.shape[0], off:off + inner.shape[1]] = inner
    return Image.fromarray(pad.astype(np.uint8), mode="L")


cases = json.load(open(IN))
ok = 0
fails = []
results = []
for i, c in enumerate(cases):
    img = render(c["matrix"])
    found = zxingcpp.read_barcodes(img, try_rotate=True, try_downscale=True, try_invert=True,
                                   text_mode=zxingcpp.TextMode.HRI, binarizer=zxingcpp.Binarizer.LocalAverage,
                                   return_errors=True)
    got = None
    for r in found:
        if r.format.name == "QRCode":
            got = r.text
            break
    good = got == c["text"]
    if good:
        ok += 1
    else:
        fails.append({"i": i, "text": c["text"][:30], "ecc": c["ecc"], "version": c["version"],
                      "detected": len(found), "got": (got or "")[:30]})
    results.append({"i": i, "ok": good})

summary = {"total": len(cases), "ok": ok, "fail": fails}
json.dump(summary, open(OUT, "w"))
print("zxing-cpp decode of MY matrices: %d/%d restored exactly" % (ok, len(cases)))
if fails:
    print("failures:", json.dumps(fails[:8], ensure_ascii=False))
sys.exit(0 if ok == len(cases) else 1)
