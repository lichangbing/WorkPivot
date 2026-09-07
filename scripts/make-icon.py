# -*- coding: utf-8 -*-
"""
M4：生成 WorkPivot 应用图标（可复现脚本，非设计源文件）。
产出：
  assets/logo/icon-512.png          品牌源图（512x512）
  code/apps/desktop/build/icon.ico  多尺寸 ico（16/24/32/48/64/128/256）
  code/apps/desktop/build/icon.png  256x256（托盘用，随包分发）
设计：深蓝圆角方块 + 白色加粗 "W"（占位品牌资产，正式 logo 后续替换）。
运行：python scripts/make-icon.py
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets" / "logo"
DESKTOP_BUILD = ROOT / "code" / "apps" / "desktop" / "build"

SIZE = 512
RADIUS = 100
BG_TOP = (37, 99, 235)    # 蓝上
BG_BOTTOM = (29, 58, 178) # 深蓝下
TEXT = (255, 255, 255)

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# 圆角方块（垂直渐变：逐行覆盖圆角遮罩内区域）
mask = Image.new("L", (SIZE, SIZE), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=RADIUS, fill=255)
grad = Image.new("RGBA", (SIZE, SIZE))
gdraw = ImageDraw.Draw(grad)
for y in range(SIZE):
    t = y / (SIZE - 1)
    color = tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM)) + (255,)
    gdraw.line([(0, y), (SIZE, y)], fill=color)
img.paste(grad, (0, 0), mask)

# 加粗 "W"（Segoe UI Bold / Arial Bold 回退）
font = None
for name in ("segoeuib.ttf", "arialbd.ttf", "arial.ttf"):
    try:
        font = ImageFont.truetype(f"C:/Windows/Fonts/{name}", 300)
        break
    except OSError:
        continue
if font is None:
    font = ImageFont.load_default()
text = "W"
bbox = draw.textbbox((0, 0), text, font=font)
w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
draw.text(((SIZE - w) / 2 - bbox[0], (SIZE - h) / 2 - bbox[1] - 8), text, font=font, fill=TEXT)

ASSETS.mkdir(parents=True, exist_ok=True)
DESKTOP_BUILD.mkdir(parents=True, exist_ok=True)
img.save(ASSETS / "icon-512.png")
img.resize((256, 256), Image.LANCZOS).save(DESKTOP_BUILD / "icon.png")
img.save(
    DESKTOP_BUILD / "icon.ico",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print("图标已生成：", ASSETS / "icon-512.png", DESKTOP_BUILD / "icon.ico", DESKTOP_BUILD / "icon.png")
