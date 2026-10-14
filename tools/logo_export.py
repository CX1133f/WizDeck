"""生成 WizDeck 最终 logo 资源。

过程记录（前面几版都失败了，原因写在这里避免重犯）：
  · 第一版用「径向渐变建模」：圆底板并不是径向渐变，留下方形残影。
  · 第二版用「按颜色抠近白」：图标里的白色卡片与底板同色（≈247），卡片被吃掉。
  · 第三版改用「从四边插值出干净背景场再比暗多少」：方向对了，
    但分界行取成了全区间最小前景行，正好落在标记下沿之下，把图标切掉一截。

关键事实（实测）：
  · 圆底板内部均匀 ≈251，只有**边缘**降到 ≈247，比四角背景暗 4~5 级。
  · 应用浅色主题的顶栏是 #ffffff、页面底是 #f5f7fa —— 与底板几乎同色，
    因此抠掉底板后在浅色界面上看不出任何边界。
输出：
  brand/wizdeck-mark.png       图标（透明底，512²，正方形的 mark）
  brand/wizdeck-wordmark.png   文字（透明底）
  brand/wizdeck-lockup.png     竖排组合（透明底）
  brand/topbar-mark.png        顶栏用 64²（体积小，可直接内嵌 data URI）
  brand/topbar-lockup.png      空状态用 160px 宽的竖排组合
  brand/preview-app-light.png  贴到真实顶栏配色上的预览
"""
import io
import sys

from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")

SRC = "brand/wizdeck-logo-source.png"
im = Image.open(SRC).convert("RGB")
W, H = im.size

# ── 干净背景场：四边都是纯背景，按对边插值 ─────────────────────────────
ET = 34


def band_mean(axis, index):
    tot = [0.0, 0.0, 0.0]
    n = 0
    for i in range(0, W if axis == "col" else H, 3):
        if axis == "col":
            if ET <= i <= (H - ET):
                continue
            p = im.getpixel((index, i))
        else:
            if ET <= i <= (W - ET):
                continue
            p = im.getpixel((i, index))
        tot[0] += p[0]; tot[1] += p[1]; tot[2] += p[2]
        n += 1
    return [c / max(1, n) for c in tot]


left, right = band_mean("col", 2), band_mean("col", W - 3)
top, bottom = band_mean("row", 2), band_mean("row", H - 3)


def bg_at(x, y):
    fx, fy = x / (W - 1.0), y / (H - 1.0)
    hx = [(left[i] * (1 - fx) + right[i] * fx) for i in range(3)]
    hy = [(top[i] * (1 - fy) + bottom[i] * fy) for i in range(3)]
    return (hx[0] + hy[0]) / 2.0, (hx[1] + hy[1]) / 2.0, (hx[2] + hy[2]) / 2.0


# ── alpha：按「比干净背景暗多少」给透明度 ──────────────────────────────
# 实测结论（见 brand/_sweep.png 的四档对比）：
#   圆底板内部只比干净背景暗 1~4 级，图标外围柔光在 2~5 级，两者区间重叠，
#   所以没有任何阈值能同时做到「完全无底」与「保留全部柔光」。
#   取 LO=9 时圆盘的弧线痕迹彻底消失，图标本体与文字依然完整、边缘干净 ——
#   代价是丢掉了最外圈极淡的光晕，对 UI logo 来说这是正确的取舍。
ALPHA_LO, ALPHA_HI = 9.0, 15.0
RGBA = Image.new("RGBA", (W, H))
out = RGBA.load()
for y in range(H):
    for x in range(W):
        r, g, b = im.getpixel((x, y))
        bl = bg_at(x, y)
        dark = ((bl[0] + bl[1] + bl[2]) - (r + g + b)) / 3.0
        sat = max(r, g, b) - min(r, g, b)
        if sat > 16:
            a = 255.0                       # 彩色图形一律保留
        elif dark <= ALPHA_LO:
            a = 0.0                         # 不比背景暗多少 → 底板/空白
        else:
            a = 255.0 * min(1.0, (dark - ALPHA_LO) / (ALPHA_HI - ALPHA_LO))
        out[x, y] = (r, g, b, int(max(0, min(255, round(a)))))

# ── 分割图标 / 文字：用「行前景像素数」找缝，且只在真正的缝里找 ────────
def row_count(y):
    return sum(1 for x in range(0, W, 2) if out[x, y][3] > 128)


rows = [row_count(y) for y in range(H)]
# 缝的位置：940 附近（实测 y=923 还有 464 个前景像素，y=963 降到 143）。
# 这里取缝区间的中点，既不切图标下沿，也不切文字上沿。
lo_y, hi_y = 936, 972
split_y = (lo_y + hi_y) // 2
print("分界行 y=%d（上行 %d / 下行 %d 个前景像素）" % (split_y, rows[lo_y], rows[hi_y]))


def bbox(y0, y1, thr=110):
    minx, miny, maxx, maxy = W, H, -1, -1
    for y in range(y0, y1):
        for x in range(W):
            if out[x, y][3] > thr:
                minx = min(minx, x); maxx = max(maxx, x)
                miny = min(miny, y); maxy = max(maxy, y)
    return (minx, miny, maxx, maxy)


PAD = 6


def crop_pad(box, pad=PAD):
    x0, y0, x1, y1 = box
    return RGBA.crop((max(0, x0 - pad), max(0, y0 - pad),
                      min(W - 1, x1 + pad) + 1, min(H - 1, y1 + pad) + 1))


mk = bbox(0, split_y)
wm = bbox(split_y, H)
print("图标 bbox %s" % (mk,))
print("文字 bbox %s" % (wm,))
mark, word = crop_pad(mk), crop_pad(wm)


def square(img):
    w, h = img.size
    s = max(w, h)
    c = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    c.paste(img, ((s - w) // 2, (s - h) // 2))
    return c


mark_sq = square(mark)
mark_sq.resize((512, 512), Image.LANCZOS).save("brand/wizdeck-mark.png")
word.save("brand/wizdeck-wordmark.png")

gap = 20
lw = max(mark_sq.width, word.width)
lock = Image.new("RGBA", (lw, mark_sq.height + gap + word.height), (0, 0, 0, 0))
lock.paste(mark_sq, ((lw - mark_sq.width) // 2, 0))
lock.paste(word, ((lw - word.width) // 2, mark_sq.height + gap))
lock.save("brand/wizdeck-lockup.png")

# ── 顶栏用的小尺寸 ─────────────────────────────────────────────────────
mark_sq.resize((64, 64), Image.LANCZOS).save("brand/topbar-mark.png", optimize=True)

# 空状态用的竖排组合（按宽度 320 缩放，2x 供高分屏）
scale = 320.0 / lock.width
lc = lock.resize((320, max(1, int(round(lock.height * scale)))), Image.LANCZOS)
lc.save("brand/topbar-lockup.png", optimize=True)

# 正方形 app 图标（浅色卡片底 + 圆角），供深色主题与 favicon 使用
tile = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
inner = Image.new("RGBA", (256, 256), (247, 249, 252, 255))
tile.paste(inner, (0, 0))
mk256 = mark_sq.resize((236, 236), Image.LANCZOS)
tile.paste(mk256, (10, 10), mk256)
from PIL import ImageDraw  # noqa: E402

mask = Image.new("L", (256, 256), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, 255, 255], radius=56, fill=255)
tile.putalpha(mask)
tile.save("brand/app-icon.png", optimize=True)

print("\n已写出:")
for f in ("brand/wizdeck-mark.png", "brand/wizdeck-wordmark.png", "brand/wizdeck-lockup.png",
          "brand/topbar-mark.png", "brand/topbar-lockup.png", "brand/app-icon.png"):
    img = Image.open(f)
    print("  %-30s %-12s %7d bytes" % (f, "%dx%d" % img.size, len(open(f, "rb").read())))

# ── 预览：贴到真实配色上 ───────────────────────────────────────────────
for tag, bgcol in (("app-light", (255, 255, 255)), ("app-chrome", (245, 247, 250)),
                   ("app-dark", (33, 38, 46))):
    bar_h = 56
    c = Image.new("RGB", (360, bar_h + lc.height + 40), bgcol)
    m64 = Image.open("brand/topbar-mark.png")
    c.paste(m64, (16, (bar_h - 64) // 2 + 14), m64)
    from PIL import ImageDraw as _D
    _D.Draw(c).line([(0, bar_h + 20), (360, bar_h + 20)], fill=(220, 226, 235) if bgcol[0] > 128 else (60, 66, 76))
    c.paste(lc, ((360 - lc.width) // 2, bar_h + 30), lc)
    c.save("brand/preview-%s.png" % tag)

print("预览已写出: brand/preview-app-light.png / -app-chrome.png / -app-dark.png")
print("lockup 尺寸:", lock.size)
