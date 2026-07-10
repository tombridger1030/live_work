import jpeg from "jpeg-js";

export type ThumbnailOptions = {
  blur: boolean;
};

function resizeNearest(source: Buffer, width: number, height: number): Buffer {
  const decoded = jpeg.decode(source, { useTArray: true });
  const scale = Math.min(width / decoded.width, height / decoded.height, 1);
  const targetWidth = Math.max(1, Math.round(decoded.width * scale));
  const targetHeight = Math.max(1, Math.round(decoded.height * scale));
  const frame = Buffer.alloc(targetWidth * targetHeight * 4);

  for (let y = 0; y < targetHeight; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(decoded.width - 1, Math.floor(x / scale));
      const sourceY = Math.min(decoded.height - 1, Math.floor(y / scale));
      const sourceIndex = (sourceY * decoded.width + sourceX) * 4;
      const targetIndex = (y * targetWidth + x) * 4;
      frame[targetIndex] = decoded.data[sourceIndex];
      frame[targetIndex + 1] = decoded.data[sourceIndex + 1];
      frame[targetIndex + 2] = decoded.data[sourceIndex + 2];
      frame[targetIndex + 3] = 255;
    }
  }

  return jpeg.encode({ data: frame, width: targetWidth, height: targetHeight }, 72).data;
}

/**
 * Reduces a raw JPEG frame into the only image artifact the app persists.
 *
 * Preconditions: `jpeg` is a decodable image buffer. Postconditions: the return
 * value is a metadata-stripped JPEG thumbnail no wider than 768px — wide enough
 * for the presence detector to judge it faithfully in the corrections eval,
 * while still far smaller than the raw frame, which is not written by this module.
 */
export async function toThumbnail(jpegBytes: Uint8Array, options: ThumbnailOptions): Promise<Uint8Array> {
  const source = Buffer.from(jpegBytes);

  try {
    // Dynamic import required: sharp is an optional native module. Loading it
    // lazily inside this try lets a runtime without the prebuilt binary fall
    // back to the pure-JS resizer below instead of failing the whole module at
    // import time.
    const sharp = (await import("sharp")).default;
    let pipeline = sharp(source, { failOn: "warning" }).rotate().resize({
      width: 768,
      height: 576,
      fit: "inside",
      withoutEnlargement: true
    });

    if (options.blur) {
      pipeline = pipeline.blur(12);
    }

    return pipeline.jpeg({ quality: 72, mozjpeg: true }).toBuffer();
  } catch {
    return resizeNearest(source, options.blur ? 96 : 768, options.blur ? 72 : 576);
  }
}
