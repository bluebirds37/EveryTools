#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 python-qrcode 参考矩阵（强制掩码 + 自动掩码两组），供 node 逐模块比对。"""
import json
import sys

import qrcode
import qrcode.util as u
from qrcode import constants as C

ECC = {"L": C.ERROR_CORRECT_L, "M": C.ERROR_CORRECT_M, "Q": C.ERROR_CORRECT_Q, "H": C.ERROR_CORRECT_H}
MNAME = {u.MODE_NUMBER: "numeric", u.MODE_ALPHA_NUM: "alphanumeric", u.MODE_8BIT_BYTE: "byte"}

CASES = [
    ("HELLO WORLD", "Q", 2), ("HELLO WORLD", "M", 5), ("HELLO WORLD", "H", 0), ("HELLO WORLD", "L", 7),
    ("012345678", "L", 4), ("01234567890123456789", "H", 1), ("3.14159265", "H", 7),
    ("AB-012/CD", "M", 3), ("$123.45", "Q", 6), ("https://example.com/a?b=1&c=2", "M", 0),
    ("中文测试内容", "L", 1), ("WIFI:T:WPA;S:我的网络;P:p@ss:word;H:true;;", "Q", 3),
    ("BEGIN:VCARD\nVERSION:3.0\nN:张;三\nTEL;CELL:13800138000\nEND:VCARD", "H", 5),
    ("A" * 300, "M", 2), ("1" * 700, "Q", 4), ("http://a.cn/x 你好", "H", 6),
    ("MECARD:N:Li;TEL:13900001111;;", "L", 1), ("SMSTO:10086:查询", "M", 7),
]


def build(text, ecc, mask):
    qr = qrcode.QRCode(version=None, error_correction=ECC[ecc], box_size=1, border=0, mask_pattern=mask)
    qr.add_data(u.QRData(text.encode("utf-8")))
    qr.make(fit=True)
    m = qr.get_matrix()
    return {
        "text": text,
        "ecc": ecc,
        "mask": qr.best_mask_pattern() if mask is None else mask,
        "version": qr.version,
        "mode": MNAME.get(qr.data_list[0].mode, str(qr.data_list[0].mode)),
        "matrix": ["".join("1" if c else "0" for c in row) for row in m],
    }


forced, auto = [], []
for text, ecc, mask in CASES:
    try:
        forced.append(build(text, ecc, mask))
        auto.append(build(text, ecc, None))
    except Exception as exc:
        print("skip", repr(text[:16]), ecc, repr(exc), file=sys.stderr)

json.dump(forced, open("/tmp/qr_ref_full.json", "w"))
json.dump(auto, open("/tmp/qr_ref_auto.json", "w"))
print("forced=%d auto=%d" % (len(forced), len(auto)))
