import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, "../..");
const sourcePath = resolve(repoRoot, "apps/desktop/src/v2/renderer/ui/compazio-mark-image.ts");
const pngPath = resolve(repoRoot, "apps/desktop/build/icon.png");
const icoPath = resolve(repoRoot, "apps/desktop/build/icon.ico");

const source = await readFile(sourcePath, "utf8");
const base64 = source.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/)?.[1];
if (!base64) throw new Error(`Embedded Compazio mark not found in ${sourcePath}`);
const mark = Buffer.from(base64, "base64");

const sizes = [256, 128, 64, 48, 32, 16];
const pngImages = await Promise.all(
  sizes.map((size) =>
    sharp(mark)
      .resize(size, size, { fit: "contain", kernel: sharp.kernel.lanczos3 })
      .png()
      .toBuffer()
  )
);

await writeFile(pngPath, pngImages[0]);
await writeFile(icoPath, createPngIco(sizes, pngImages));
function createPngIco(iconSizes, images) {
  const headerSize = 6;
  const entrySize = 16;
  const directorySize = headerSize + entrySize * images.length;
  const header = Buffer.alloc(directorySize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let imageOffset = directorySize;
  images.forEach((image, index) => {
    const size = iconSizes[index];
    const entryOffset = headerSize + index * entrySize;
    header.writeUInt8(size === 256 ? 0 : size, entryOffset);
    header.writeUInt8(size === 256 ? 0 : size, entryOffset + 1);
    header.writeUInt8(0, entryOffset + 2);
    header.writeUInt8(0, entryOffset + 3);
    header.writeUInt16LE(1, entryOffset + 4);
    header.writeUInt16LE(32, entryOffset + 6);
    header.writeUInt32LE(image.length, entryOffset + 8);
    header.writeUInt32LE(imageOffset, entryOffset + 12);
    imageOffset += image.length;
  });

  return Buffer.concat([header, ...images]);
}
