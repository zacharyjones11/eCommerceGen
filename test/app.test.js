import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import sharp from "sharp";

import {
  autoCropSquare,
  backgroundRemovalToBuffer,
  createProcessHandler,
  createApp,
  defaultRemovalConfig,
  enhancePngBuffer,
  findAlphaBBox,
  normalizeInputImage,
  parseProcessOptions,
  startServer
} from "../app.js";

async function createTransparentPng({
  width = 10,
  height = 10,
  object = { left: 2, top: 3, width: 4, height: 2, color: { r: 220, g: 60, b: 40, alpha: 255 } }
} = {}) {
  const channels = 4;
  const data = Buffer.alloc(width * height * channels, 0);

  for (let y = object.top; y < object.top + object.height; y += 1) {
    for (let x = object.left; x < object.left + object.width; x += 1) {
      const idx = (y * width + x) * channels;
      data[idx] = object.color.r;
      data[idx + 1] = object.color.g;
      data[idx + 2] = object.color.b;
      data[idx + 3] = object.color.alpha;
    }
  }

  return sharp(data, { raw: { width, height, channels } }).png().toBuffer();
}

async function createSolidPng(width, height, color = { r: 20, g: 120, b: 200, alpha: 255 }) {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: color
    }
  })
    .png()
    .toBuffer();
}

async function decodePng(buffer) {
  return sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

function createMockResponse() {
  return {
    statusCode: 200,
    payload: undefined,
    timeoutMs: undefined,
    setTimeout(ms) {
      this.timeoutMs = ms;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.payload = body;
      return this;
    }
  };
}

test("parseProcessOptions applies defaults and clamps values", () => {
  assert.deepEqual(parseProcessOptions(), { outputSize: 1200, enhance: true });
  assert.deepEqual(parseProcessOptions({ size: "250", enhance: "0" }), { outputSize: 300, enhance: false });
  assert.deepEqual(parseProcessOptions({ size: "9000", enhance: "1" }), { outputSize: 4000, enhance: true });
  assert.deepEqual(parseProcessOptions({ size: "invalid" }), { outputSize: 1200, enhance: true });
});

test("findAlphaBBox returns the visible object bounds", async () => {
  const png = await createTransparentPng();
  const bbox = await findAlphaBBox(png);

  assert.deepEqual(bbox, { left: 2, top: 3, right: 5, bottom: 4 });
});

test("findAlphaBBox falls back to the full image when no alpha is visible", async () => {
  const png = await sharp({
    create: {
      width: 6,
      height: 4,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .png()
    .toBuffer();

  const bbox = await findAlphaBBox(png);
  assert.deepEqual(bbox, { left: 0, top: 0, right: 5, bottom: 3 });
});

test("autoCropSquare returns a square PNG with the requested size", async () => {
  const png = await createTransparentPng({
    width: 20,
    height: 12,
    object: { left: 6, top: 2, width: 5, height: 8, color: { r: 255, g: 0, b: 0, alpha: 255 } }
  });

  const square = await autoCropSquare(png, { outputSize: 64, paddingRatio: 0 });
  const meta = await sharp(square).metadata();
  assert.equal(meta.width, 64);
  assert.equal(meta.height, 64);

  const decoded = await decodePng(square);
  const topLeftAlpha = decoded.data[3];
  assert.equal(topLeftAlpha, 0);
});

test("normalizeInputImage keeps images within the maximum dimensions", async () => {
  const large = await createSolidPng(3000, 1500);
  const normalized = await normalizeInputImage(large);
  const meta = await sharp(normalized).metadata();

  assert.equal(meta.format, "png");
  assert.equal(meta.width, 2200);
  assert.equal(meta.height, 1100);
});

test("enhancePngBuffer returns a PNG with the same dimensions", async () => {
  const png = await createTransparentPng({
    width: 8,
    height: 7,
    object: { left: 1, top: 1, width: 4, height: 4, color: { r: 60, g: 140, b: 220, alpha: 255 } }
  });

  const enhanced = await enhancePngBuffer(png);
  const meta = await sharp(enhanced).metadata();

  assert.equal(meta.format, "png");
  assert.equal(meta.width, 8);
  assert.equal(meta.height, 7);
});

test("backgroundRemovalToBuffer handles Blob-like results", async () => {
  const original = Buffer.from("hello");
  const blob = new Blob([original], { type: "application/octet-stream" });

  const result = await backgroundRemovalToBuffer(blob);
  assert.deepEqual(result, original);
});

test("backgroundRemovalToBuffer returns Buffers unchanged", async () => {
  const original = Buffer.from("already-a-buffer");
  const result = await backgroundRemovalToBuffer(original);

  assert.strictEqual(result, original);
});

test("defaultRemovalConfig matches the expected model settings", () => {
  assert.deepEqual(defaultRemovalConfig(), {
    model: "medium",
    output: { format: "image/png", quality: 0.95 }
  });
});

test("createApp wires static middleware and the process route", () => {
  const app = createApp();
  const middlewareNames = app._router.stack.map((layer) => layer.name);
  const processRoute = app._router.stack.find((layer) => layer.route?.path === "/process");

  assert.ok(middlewareNames.includes("serveStatic"));
  assert.equal(processRoute?.route?.methods?.post, true);
});

test("createProcessHandler rejects requests without an image", async () => {
  const handler = createProcessHandler();
  const res = createMockResponse();

  await handler({ body: { size: "1200" } }, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.payload, { error: "Please upload a valid image file." });
});

test("createProcessHandler returns processed image payloads", async () => {
  const source = await createTransparentPng({
    width: 24,
    height: 18,
    object: { left: 5, top: 3, width: 10, height: 8, color: { r: 0, g: 180, b: 90, alpha: 255 } }
  });

  const handler = createProcessHandler({
    removeBackgroundFn: async (inputBlob) => new Blob([await inputBlob.arrayBuffer()], { type: "image/png" }),
    timeoutMs: 100
  });
  const res = createMockResponse();

  await handler(
    {
      body: { size: "512", enhance: "0" },
      file: { buffer: source, mimetype: "image/png" }
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.timeoutMs, 240000);
  assert.equal(res.payload.outputSize, 512);
  assert.equal(res.payload.enhance, false);
  assert.match(res.payload.enhancedBase64, /^[A-Za-z0-9+/=]+$/);
  assert.match(res.payload.squareBase64, /^[A-Za-z0-9+/=]+$/);

  const squareBuffer = Buffer.from(res.payload.squareBase64, "base64");
  const meta = await sharp(squareBuffer).metadata();
  assert.equal(meta.width, 512);
  assert.equal(meta.height, 512);
});

test("createProcessHandler returns 500 when background removal fails", async () => {
  const source = await createSolidPng(12, 12);
  const handler = createProcessHandler({
    removeBackgroundFn: async () => {
      throw new Error("background service unavailable");
    },
    timeoutMs: 100
  });
  const res = createMockResponse();

  await handler(
    {
      body: {},
      file: { buffer: source, mimetype: "image/png" }
    },
    res
  );

  assert.equal(res.statusCode, 500);
  assert.equal(res.payload.error, "Processing failed");
  assert.match(res.payload.details, /background service unavailable/);
});

test("createProcessHandler returns 500 when Blob is unavailable", async () => {
  const originalBlob = globalThis.Blob;
  const source = await createSolidPng(12, 12);
  const handler = createProcessHandler({
    removeBackgroundFn: async () => {
      throw new Error("should not be called");
    }
  });
  const res = createMockResponse();

  try {
    globalThis.Blob = undefined;

    await handler(
      {
        body: {},
        file: { buffer: source, mimetype: "image/png" }
      },
      res
    );
  } finally {
    globalThis.Blob = originalBlob;
  }

  assert.equal(res.statusCode, 500);
  assert.equal(res.payload.error, "Processing failed");
  assert.match(res.payload.details, /Global Blob is not available/);
});

test("startServer binds the app on the configured host and port", () => {
  const originalListen = express.application.listen;
  const originalPort = process.env.PORT;
  const fakeServer = { close() {} };
  let receivedArgs;

  express.application.listen = function patchedListen(...args) {
    receivedArgs = args;
    const callback = args[2];
    callback();
    return fakeServer;
  };

  process.env.PORT = "4567";

  try {
    const server = startServer();
    assert.strictEqual(server, fakeServer);
    assert.deepEqual(receivedArgs.slice(0, 2), ["4567", "0.0.0.0"]);
    assert.equal(typeof receivedArgs[2], "function");
  } finally {
    express.application.listen = originalListen;
    if (originalPort === undefined) {
      delete process.env.PORT;
    } else {
      process.env.PORT = originalPort;
    }
  }
});
