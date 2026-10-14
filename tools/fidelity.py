"""量化保真度：把 LibreOffice 渲染的 PPTX 与浏览器渲染基线对齐后比较像素差异。

两者分辨率不同（PPTX 144dpi = 2881px 宽；基线 1920px），所以先缩放到同一尺寸再比。
报告平均绝对误差（MAE）与「基本一致」像素占比，用来客观说明还原度。
"""
import glob
import os
import sys

from PIL import Image, ImageChops

sys.stdout.reconfigure(encoding="utf-8")

BASE = "tmp/verify/render"          # 浏览器基线（1920x1080）
PPTX = "tmp/verify/pptx-render"     # LibreOffice 渲染
SIZE = (960, 540)

print("页 |  MAE(0-255)  | ≤16 像素占比 | ≤32 像素占比")
print("---|--------------|--------------|-------------")
rows = []
for i in range(1, 7):
    b = os.path.join(BASE, "slide-%d.png" % i)
    p = os.path.join(PPTX, "page-%04d.png" % i)
    if not (os.path.exists(b) and os.path.exists(p)):
        print(i, " 缺少文件")
        continue
    bi = Image.open(b).convert("RGB").resize(SIZE, Image.LANCZOS)
    pi = Image.open(p).convert("RGB").resize(SIZE, Image.LANCZOS)
    diff = ImageChops.difference(bi, pi).convert("L")
    hist = diff.histogram()
    total = sum(hist)
    mae = sum(v * c for v, c in enumerate(hist)) / total
    le16 = sum(hist[:17]) / total * 100
    le32 = sum(hist[:33]) / total * 100
    rows.append((i, mae, le16, le32))
    print("%2d |   %8.2f   |   %7.1f%%   |   %7.1f%%" % (i, mae, le16, le32))

if rows:
    print("---|--------------|--------------|-------------")
    print("平均|   %8.2f   |   %7.1f%%   |   %7.1f%%" % (
        sum(r[1] for r in rows) / len(rows),
        sum(r[2] for r in rows) / len(rows),
        sum(r[3] for r in rows) / len(rows)))

# 拼一张并排对比图，便于目视
try:
    tiles = []
    for i in (1, 2, 5):
        b = Image.open(os.path.join(BASE, "slide-%d.png" % i)).convert("RGB").resize(SIZE, Image.LANCZOS)
        p = Image.open(os.path.join(PPTX, "page-%04d.png" % i)).convert("RGB").resize(SIZE, Image.LANCZOS)
        row = Image.new("RGB", (SIZE[0] * 2 + 8, SIZE[1]), (255, 255, 255))
        row.paste(b, (0, 0))
        row.paste(p, (SIZE[0] + 8, 0))
        tiles.append(row)
    sheet = Image.new("RGB", (tiles[0].width, sum(t.height + 8 for t in tiles)), (240, 240, 240))
    y = 0
    for t in tiles:
        sheet.paste(t, (0, y))
        y += t.height + 8
    sheet.save("tmp/verify/compare.png")
    print("\n并排对比图（每行：左=浏览器基线，右=导出 PPTX 渲染）: tmp/verify/compare.png")
except Exception as e:
    print("对比图生成失败:", e)
