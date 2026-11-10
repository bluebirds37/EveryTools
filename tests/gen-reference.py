#!/usr/bin/env python3
"""
生成 packageQr 自测用的权威参考数据（reference fixtures）。

依赖：python-qrcode（隔离 venv 即可，无需 Pillow）
    /tmp/qrtest/bin/python tests/gen-reference.py

输出到 tests/reference/：
  qr_rs_blocks.json    40 版本 x 4 等级的 ECC 每块码字数 / 分块数 / 数据码字总数
  qr_ref_matrix.jsonl  强制掩码下的参考矩阵（逐行 '0'/'1' 字符串）
  qr_codewords.json    分块交织后的最终码字序列
  qr_auto_mask.json    自动掩码选择结果（等级 + 掩码号）
"""
import json
import os
import sys

from qrcode import base
from qrcode.constants import (
    ERROR_CORRECT_H,
    ERROR_CORRECT_L,
    ERROR_CORRECT_M,
    ERROR_CORRECT_Q,
)
from qrcode.main import QRCode
from qrcode.util import (
    MODE_8BIT_BYTE,
    MODE_ALPHA_NUM,
    MODE_NUMBER,
    QRData,
    create_data,
    lost_point,
)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "reference")
LEVELS = {"L": ERROR_CORRECT_L, "M": ERROR_CORRECT_M, "Q": ERROR_CORRECT_Q, "H": ERROR_CORRECT_H}
ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:"


def pick_mode(raw):
    """与 JS 侧 qr-bitstream.pickMode 一致：numeric > alphanumeric > byte（单段编码）"""
    text = raw.decode("utf-8")
    if text.isdigit():
        return MODE_NUMBER
    if all(c in ALNUM for c in text):
        return MODE_ALPHA_NUM
    return MODE_8BIT_BYTE


def qdata(text):
    raw = text.encode("utf-8")
    return QRData(raw, mode=pick_mode(raw))

TEXTS = [
    "HELLO WORLD",
    "0123456789",
    "3.14159265358979",
    "QWERTYUIOP1234567890ASDFGHJKL:",
    "中文测试二维码生成",
    "https://example.com/a/very/long/path?query=value&x=1#fragment-anchor-test",
    'WIFI:S:MyHomeNetwork;T:WPA;P:p@ssw0rd-1234567890;;',
    "BEGIN:VCARD\nVERSION:3.0\nN:张;三\nTEL;TYPE=CELL:13800138000\nEND:VCARD",
    "https://qr.weixin.qq.com/cgi-bin/qrcode.fw?p=1&s=abcdefg&long=1234567890",
    "日常工具箱 MiniProgram 通用二维码 版本 40 支持测试 utf8 编码",
]


def raw_modules(version):
    result = (16 * version + 128) * version + 64
    if version >= 2:
        num_align = version // 7 + 2
        result -= (25 * num_align - 10) * num_align - 55
        if version >= 7:
            result -= 36
    return result


def build_rs_blocks():
    ecc = {k: [-1] for k in LEVELS}
    blocks = {k: [-1] for k in LEVELS}
    data = {k: [0] for k in LEVELS}
    for version in range(1, 41):
        for name, level in LEVELS.items():
            rs = base.rs_blocks(version, level)
            ecc_set = {b.total_count - b.data_count for b in rs}
            if len(ecc_set) != 1:
                sys.exit("ecc per block not uniform: %s v%s" % (name, version))
            ecc[name].append(ecc_set.pop())
            blocks[name].append(len(rs))
            data[name].append(sum(b.data_count for b in rs))
    # 结构性自检：总码字 = 数据 + ECC，且与 ISO 模块数公式吻合
    for name in LEVELS:
        for version in range(1, 41):
            total = raw_modules(version) // 8
            if total - ecc[name][version] * blocks[name][version] != data[name][version]:
                sys.exit("table inconsistent: %s v%s" % (name, version))
    return {"ecc": ecc, "blocks": blocks, "data": data}


def build_matrix(text, ecc_name, mask):
    qr = QRCode(version=None, error_correction=LEVELS[ecc_name], mask_pattern=mask)
    qr.add_data(qdata(text))
    qr.make(fit=True)
    rows = "".join("".join("1" if cell else "0" for cell in row) + "\n" for row in qr.modules)
    return {
        "text": text,
        "ecc": ecc_name,
        "mask": mask,
        "version": qr.version,
        "size": len(qr.modules),
        "matrix": rows,
    }


def build_codewords(text, ecc_name, mask):
    qr = QRCode(version=None, error_correction=LEVELS[ecc_name], mask_pattern=mask)
    qr.add_data(qdata(text))
    qr.make(fit=True)
    codewords = create_data(qr.version, LEVELS[ecc_name], qr.data_list)
    return {
        "text": text,
        "ecc": ecc_name,
        "mask": mask,
        "version": qr.version,
        "codewords": list(codewords),
    }


def penalty_table():
    """
    对每个样例的 8 个强制掩码矩阵，记录 python-qrcode 自己的 lost_point。
    JS 侧用同一批 (text, ecc, mask) 重新编码后比对惩罚值与自动掩码选择。
    """
    rows = []
    for text in TEXTS:
        for ecc_name in ("L", "M", "Q", "H"):
            points = []
            for mask in range(8):
                qr = QRCode(version=None, error_correction=LEVELS[ecc_name], mask_pattern=mask)
                qr.add_data(qdata(text))
                qr.make(fit=True)
                points.append({"mask": mask, "lostPoint": lost_point(qr.modules), "version": qr.version})
            best = min(points, key=lambda p: (p["lostPoint"], p["mask"]))
            rows.append({"text": text, "ecc": ecc_name, "points": points, "best": best})
    return rows


def main():
    if not os.path.isdir(OUT):
        os.makedirs(OUT)

    with open(os.path.join(OUT, "qr_rs_blocks.json"), "w") as fh:
        json.dump(build_rs_blocks(), fh)

    with open(os.path.join(OUT, "qr_ref_matrix.jsonl"), "w") as fh:
        count = 0
        for text in TEXTS:
            for ecc_name in ("L", "M", "Q", "H"):
                for mask in (0, 2, 5, 7):
                    item = build_matrix(text, ecc_name, mask)
                    if item["size"] > 89:
                        continue
                    fh.write(json.dumps(item) + "\n")
                    count += 1
        print("reference matrices:", count)

    samples = [("HELLO WORLD", "Q", 2), ("0123456789", "L", 4), ("中文测试二维码生成", "H", 1)]
    cw = []
    for text, ecc_name, mask in samples:
        entry = build_codewords(text, ecc_name, mask)
        entry["text"] = text
        cw.append(entry)
    with open(os.path.join(OUT, "qr_codewords.json"), "w") as fh:
        json.dump(cw, fh)

    with open(os.path.join(OUT, "qr_penalty.json"), "w") as fh:
        json.dump(penalty_table(), fh)

    print("fixtures written to", OUT)


if __name__ == "__main__":
    main()
