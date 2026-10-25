/**
 * The email editor's image tools, done in the browser on a canvas: shrinking an upload to email
 * size, "Auto-enhance" (a levels stretch that lifts flat, dull photos) and "Crop to banner" (the
 * centre at 2:1). Each result is uploaded as a new image, so the original stays as it was.
 * Only uploaded images (/mi/<id>, same origin) can be refined; a canvas can't read pixels from
 * another site's image.
 */

export const EMAIL_IMAGE_WIDTH = 1200;
const MAX_CHARS = 1_400_000;

export interface EditedImage {
  dataUrl: string;
  width: number;
  height: number;
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("That image couldn't be opened"));
    i.src = src;
  });
}

function toJpeg(c: HTMLCanvasElement): EditedImage {
  let q = 0.85;
  let dataUrl = c.toDataURL("image/jpeg", q);
  while (dataUrl.length > MAX_CHARS && q > 0.45) {
    q -= 0.1;
    dataUrl = c.toDataURL("image/jpeg", q);
  }
  return { dataUrl, width: c.width, height: c.height };
}

function canvasFor(img: HTMLImageElement, sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight): HTMLCanvasElement {
  const scale = Math.min(1, EMAIL_IMAGE_WIDTH / sw, 1600 / sh);
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(sw * scale));
  c.height = Math.max(1, Math.round(sh * scale));
  const g = c.getContext("2d")!;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

/** A picked file as an email-sized JPEG (at most 1200px wide). */
export async function fileToEmailImage(file: File): Promise<EditedImage> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error("Use a JPEG, PNG or WebP image");
  const url = URL.createObjectURL(file);
  try {
    return toJpeg(canvasFor(await loadImage(url)));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Stretches each color channel so its darkest 0.5% becomes black and brightest 0.5% white. */
export function enhance(img: HTMLImageElement): EditedImage {
  const c = canvasFor(img);
  const g = c.getContext("2d")!;
  const data = g.getImageData(0, 0, c.width, c.height);
  const px = data.data;
  const n = px.length / 4;
  const lo: number[] = [];
  const hi: number[] = [];
  for (let ch = 0; ch < 3; ch++) {
    const hist = new Array<number>(256).fill(0);
    for (let i = ch; i < px.length; i += 4) hist[px[i]]++;
    let sum = 0;
    let a = 0;
    while (a < 255 && (sum += hist[a]) < n * 0.005) a++;
    sum = 0;
    let b = 255;
    while (b > 0 && (sum += hist[b]) < n * 0.005) b--;
    lo.push(a);
    hi.push(b - a < 32 ? a + 255 : b);
  }
  for (let i = 0; i < px.length; i += 4)
    for (let ch = 0; ch < 3; ch++) px[i + ch] = Math.max(0, Math.min(255, Math.round(((px[i + ch] - lo[ch]) * 255) / (hi[ch] - lo[ch]))));
  g.putImageData(data, 0, 0);
  return toJpeg(c);
}

/** The centre of the image at 2:1, the shape of an email's header. */
export function cropBanner(img: HTMLImageElement): EditedImage {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const [sw, sh] = w / h > 2 ? [h * 2, h] : [w, w / 2];
  return toJpeg(canvasFor(img, (w - sw) / 2, (h - sh) / 2, sw, sh));
}
