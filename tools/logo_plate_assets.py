"""为深色主题生成「带浅色底」的 logo 变体。

深色主题下透明 logo 会散架：图标里的白色卡片与柔和投影本来靠浅色底板衬托，
底板一去，这些近白像素就变成深色背景上的碎块。
所以深色主题改用浅色底的版本 —— 这也正是应用图标的常见处理方式。
"""
import base64
import io
import sys

from PIL import Image, ImageDraw

sys.stdout.reconfigure(encoding="utf-8")

PLATE = (247, 249, 252)          # 与浅色主题底色一致，接缝不可见


def on_plate(img, pad_ratio=0.06, radius_ratio=0.14):
    """把透明 logo 放到浅色圆角底上。"""
    w, h = img.size
    pad = int(max(w, h) * pad_ratio)
    cw, ch = w + pad * 2, h + pad * 2
    canvas = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    plate = Image.new("RGBA", (cw, ch), PLATE + (255,))
    mask = Image.new("L", (cw, ch), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, cw - 1, ch - 1],
                                           radius=int(max(cw, ch) * radius_ratio), fill=255)
    plate.putalpha(mask)
    canvas.alpha_composite(plate)
    canvas.alpha_composite(img, (pad, pad))
    return canvas


def shrink(img, size):
    w, h = img.size
    sc = min(size[0] / w, size[1] / h, 1.0)
    out = img.resize((max(1, int(w * sc)), max(1, int(h * sc))), Image.LANCZOS)
    alpha = out.getchannel("A")
    p = out.convert("RGB").quantize(colors=200, method=Image.MEDIANCUT).convert("RGBA")
    p.putalpha(alpha)
    return p


def save_b64(img, name):
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    raw = buf.getvalue()
    print("  %-26s %-11s png %7d B → base64 %7d B"
          % (name, "%dx%d" % img.size, len(raw), len(base64.b64encode(raw))))
    return img


lock = Image.open("brand/wizdeck-lockup.png").convert("RGBA")
horiz = Image.open("brand/embed-horizontal.png").convert("RGBA")

print("深色主题用的浅色底版本：")
lock_plate = shrink(on_plate(lock), (190, 190))
save_b64(lock_plate, "lockup-plate")
horiz_plate = shrink(on_plate(horiz, pad_ratio=0.05, radius_ratio=0.20), (300, 300))
save_b64(horiz_plate, "horizontal-plate")

lock_plate.save("brand/embed-lockup-plate.png", optimize=True)
horiz_plate.save("brand/embed-horizontal-plate.png", optimize=True)
print("\n已写出 brand/embed-lockup-plate.png 与 brand/embed-horizontal-plate.png")
