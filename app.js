import express from "express";
import multer from "multer";
import sharp from "sharp";
import { removeBackground } from "@imgly/background-removal-node";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const DEFAULT_BACKGROUND = { r: 255, g: 255, b: 255, alpha: 0 };

export async function enhancePngBuffer(pngBuffer) {
  const rgbaObj = await sharp(pngBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = rgbaObj.info;
  if (channels !== 4) {
    return sharp(pngBuffer)
      .ensureAlpha()
      .modulate({ saturation: 1.1, brightness: 1.02 })
      .sharpen(0.4)
      .png({ compressionLevel: 9 })
      .toBuffer();
  }

  const rgba = rgbaObj.data;
  const pixelCount = width * height;
  const rgb = Buffer.allocUnsafe(pixelCount * 3);
  const alpha = Buffer.allocUnsafe(pixelCount);

  for (let i = 0, j = 0, k = 0; i < rgba.length; i += 4) {
    rgb[j++] = rgba[i];
    rgb[j++] = rgba[i + 1];
    rgb[j++] = rgba[i + 2];
    alpha[k++] = rgba[i + 3];
  }

  const enhancedRgbObj = await sharp(rgb, { raw: { width, height, channels: 3 } })
    .modulate({ saturation: 1.15, brightness: 1.02 })
    .linear(1.03, -1.5)
    .sharpen(0.6)
    .raw()
    .toBuffer({ resolveWithObject: true });

  return sharp(enhancedRgbObj.data, { raw: { width, height, channels: 3 } })
    .joinChannel(alpha, { raw: { width, height, channels: 1 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

export async function findAlphaBBox(pngBuffer, alphaThreshold = 10) {
  const img = sharp(pngBuffer).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  const channels = info.channels;

  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * width * channels;
    for (let x = 0; x < width; x += 1) {
      const idx = rowStart + x * channels;
      const alpha = data[idx + 3];
      if (alpha > alphaThreshold) {
        if (x < left) left = x;
        if (y < top) top = y;
        if (x > right) right = x;
        if (y > bottom) bottom = y;
      }
    }
  }

  if (right === -1) {
    return { left: 0, top: 0, right: width - 1, bottom: height - 1 };
  }

  return { left, top, right, bottom };
}

export async function autoCropSquare(
  pngBuffer,
  {
    paddingRatio = 0.1,
    outputSize = 1200,
    background = DEFAULT_BACKGROUND
  } = {}
) {
  const bbox = await findAlphaBBox(pngBuffer);
  const width = bbox.right - bbox.left + 1;
  const height = bbox.bottom - bbox.top + 1;
  const maxSide = Math.max(width, height);
  const pad = Math.round(maxSide * paddingRatio);

  const cropLeft = Math.max(0, bbox.left - pad);
  const cropTop = Math.max(0, bbox.top - pad);
  const cropWidth = width + pad * 2;
  const cropHeight = height + pad * 2;

  const meta = await sharp(pngBuffer).metadata();
  const imgWidth = meta.width ?? 0;
  const imgHeight = meta.height ?? 0;

  const safeCropWidth = Math.min(cropWidth, imgWidth - cropLeft);
  const safeCropHeight = Math.min(cropHeight, imgHeight - cropTop);

  const cropped = sharp(pngBuffer)
    .extract({ left: cropLeft, top: cropTop, width: safeCropWidth, height: safeCropHeight })
    .ensureAlpha();

  const croppedWidth = safeCropWidth;
  const croppedHeight = safeCropHeight;
  const square = Math.max(croppedWidth, croppedHeight);

  const extendLeft = Math.floor((square - croppedWidth) / 2);
  const extendRight = square - croppedWidth - extendLeft;
  const extendTop = Math.floor((square - croppedHeight) / 2);
  const extendBottom = square - croppedHeight - extendTop;

  const squareBuffer = await cropped
    .extend({ top: extendTop, bottom: extendBottom, left: extendLeft, right: extendRight, background })
    .png({ compressionLevel: 9 })
    .toBuffer();

  return sharp(squareBuffer)
    .resize({ width: outputSize, height: outputSize, fit: "fill", background })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

export function parseProcessOptions(body = {}) {
  const outputSizeRaw = parseInt(body.size || "1200", 10);
  const outputSize = Math.max(300, Math.min(4000, Number.isFinite(outputSizeRaw) ? outputSizeRaw : 1200));
  const enhance = String(body.enhance ?? "1") === "1";

  return { outputSize, enhance };
}

export async function normalizeInputImage(buffer) {
  return sharp(buffer)
    .rotate()
    .resize({ width: 2200, height: 2200, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
}

export function defaultRemovalConfig() {
  return {
    model: "medium",
    output: { format: "image/png", quality: 0.95 }
  };
}

export async function backgroundRemovalToBuffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(await value.arrayBuffer());
}

export function createProcessHandler({
  removeBackgroundFn = removeBackground,
  timeoutMs = 180000,
  now = () => Date.now()
} = {}) {
  return async function processHandler(req, res) {
    const t0 = now();
    try {
      console.log("\n--- /process START ---");

      if (!req.file?.buffer || !req.file.mimetype?.startsWith("image/")) {
        return res.status(400).json({ error: "Please upload a valid image file." });
      }

      const { outputSize, enhance } = parseProcessOptions(req.body);
      console.log("Options:", { outputSize, enhance });

      const inputPng = await normalizeInputImage(req.file.buffer);
      console.log("Stage: normalized+downscaled PNG in", now() - t0, "ms");

      if (!globalThis.Blob) {
        throw new Error("Global Blob is not available in this Node runtime. Please use Node 18+ / 20+.");
      }

      if (typeof res.setTimeout === "function") {
        res.setTimeout(240000, () => {});
      }

      const inputBlob = new Blob([inputPng], { type: "image/png" });
      const bgRemoved = await Promise.race([
        removeBackgroundFn(inputBlob, defaultRemovalConfig()),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Background removal timed out")), timeoutMs))
      ]);
      console.log("Stage: background removed in", now() - t0, "ms");

      const bgRemovedBuf = await backgroundRemovalToBuffer(bgRemoved);
      const enhanced = enhance ? await enhancePngBuffer(bgRemovedBuf) : bgRemovedBuf;
      console.log(`Stage: ${enhance ? "enhanced" : "enhance skipped"} in`, now() - t0, "ms");

      const square = await autoCropSquare(enhanced, { paddingRatio: 0.12, outputSize });
      console.log("Stage: auto-cropped square in", now() - t0, "ms");
      console.log("--- /process END ---\n");

      return res.json({
        enhancedBase64: enhanced.toString("base64"),
        squareBase64: square.toString("base64"),
        outputSize,
        enhance
      });
    } catch (err) {
      console.log("--- /process ERROR after", now() - t0, "ms ---");
      console.error(err);
      return res.status(500).json({ error: "Processing failed", details: String(err?.message || err) });
    }
  };
}

export function createApp(options = {}) {
  const app = express();
  app.use(express.static("public"));
  app.post("/process", upload.single("image"), createProcessHandler(options));
  return app;
}

export function startServer(options = {}) {
  const app = createApp(options);
  const port = process.env.PORT || 3000;

  return app.listen(port, "0.0.0.0", () => {
    console.log(`✅ Product Prep running on http://0.0.0.0:${port}`);
  });
}
