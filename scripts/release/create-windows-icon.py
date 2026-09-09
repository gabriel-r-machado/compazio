from pathlib import Path

from PIL import Image

output = Path("apps/desktop/build/icon.ico")
source = Path("apps/desktop/build/icon.png")
icon = Image.open(source).convert("RGBA")
icon.save(output, sizes=[(size, size) for size in (16, 24, 32, 48, 64, 128, 256)])
