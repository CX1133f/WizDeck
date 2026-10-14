"""由已导出的 logo 资源生成「可内嵌到单文件 HTML」的版本，并报告体积。

WizDeck 是单文件应用，不能引用外部图片（build.mjs 会直接报错），
所以 logo 必须走 data URI。这里：
  · 竖排组合 → 空状态用（按 2x 输出，保证高分屏清晰）
  · 横排组合 → 顶栏用（图标在左、文字在右）
  · 32px mark → favicon
都用调色板量化压一压体积，再打印每张的 base64 长度，便于判断是否值得内嵌。
"""
import base64
import io
import sys

from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")

mark = Image.open("brand/wizdeck-mark.png").convert("RGBA")
word = Image.open("brand/wizdeck-wordmark.png").convert("RGBA")
lock = Image.open("brand/wizdeck-lockup.png").convert("RGBA")

# ── 横排组合：mark 与 wordmark 按视觉高度对齐 ──────────────────────────
# wordmark 的字高（去掉上下留白后的实际高度）比外框小，这里以 mark 高度的
# 0.62 倍作为文字目标高度，让两者重心看起来齐平。
target_word_h = int(mark.height * 0.62)
wsc = target_word_h / word.height
word_s = word.resize((max(1, int(word.width * wsc)), target_word_h), Image.LANCZOS)

gap = int(mark.height * 0.14)
h = max(mark.height, word_s.height)
horizontal = Image.new("RGBA", (mark.width + gap + word_s.width, h), (0, 0, 0, 0))
horizontal.paste(mark, (0, (h - mark.height) // 2), mark)
horizontal.paste(word_s, (mark.width + gap, (h - word_s.height) // 2), word_s)


def shrink(img, size, quantize=True):
    """等比缩放到目标宽/高内，并做调色板量化以压体积。"""
    w, h = img.size
    sc = min(size[0] / w, size[1] / h, 1.0)
    out = img.resize((max(1, int(w * sc)), max(1, int(h * sc))), Image.LANCZOS)
    if not quantize:
        return out
    # 先转 P 模式（保留 alpha），颜色数压到 200 左右，肉眼几乎无差
    alpha = out.getchannel("A")
    p = out.convert("RGB").quantize(colors=200, method=Image.MEDIANCUT).convert("RGBA")
    p.putalpha(alpha)
    return p


def b64_len(img, name):
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    raw = buf.getvalue()
    b = base64.b64encode(raw).decode("ascii")
    print("  %-22s %-11s png %7d B  →  base64 %7d B" % (name, "%dx%d" % img.size, len(raw), len(b)))
    return b


print("竖排组合（空状态用）：")
lock_small = shrink(lock, (360, 360))
b64_len(lock_small, "lockup-2x")
lock_1x = shrink(lock, (190, 190))
b64_len(lock_1x, "lockup-1x")

print("\n横排组合（顶栏用）：")
h2 = shrink(horizontal, (480, 480))
b64_len(h2, "horizontal-2x")
h1 = shrink(horizontal, (260, 260))
b64_len(h1, "horizontal-1x")

print("\n图标（favicon）：")
for s in (32, 48, 64):
    b64_len(shrink(mark, (s, s)), "mark-%d" % s)

# 保存供集成使用
lock_1x.save("brand/embed-lockup.png", optimize=True)
h1.save("brand/embed-horizontal.png", optimize=True)
shrink(mark, (32, 32)).save("brand/embed-favicon.png", optimize=True)
h2.save("brand/embed-horizontal-2x.png", optimize=True)
lock_small.save("brand/embed-lockup-2x.png", optimize=True)
print("\n已写出 brand/embed-*.png")
