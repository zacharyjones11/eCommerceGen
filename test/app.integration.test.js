import test from "node:test";
import assert from "node:assert/strict";
import formAutoContent from "form-auto-content";
import sharp from "sharp";
import { inject } from "light-my-request";

import { createApp } from "../app.js";

async function createTransparentPng({
  width = 24,
  height = 18,
  object = { left: 5, top: 3, width: 10, height: 8, color: { r: 0, g: 180, b: 90, alpha: 255 } }
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

test("GET /index.html serves the UI", async () => {
  const app = createApp();
  const response = await inject(app, {
    method: "GET",
    url: "/index.html"
  });

  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers["content-type"]), /text\/html/);
  assert.match(response.body, /Product Prep/i);
});

test("POST /process rejects multipart requests with no image file", async () => {
  const app = createApp();
  const response = await inject(app, {
    method: "POST",
    url: "/process",
    payload: { size: "1200" }
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), { error: "Please upload a valid image file." });
});

test("POST /process handles a multipart image upload end to end", async () => {
  const source = await createTransparentPng();
  const app = createApp({
    removeBackgroundFn: async (inputBlob) => new Blob([await inputBlob.arrayBuffer()], { type: "image/png" }),
    timeoutMs: 100
  });
  const form = formAutoContent({
    size: "512",
    enhance: "0",
    image: {
      value: source,
      options: {
        filename: "sample.png",
        contentType: "image/png"
      }
    }
  });

  const response = await inject(app, {
    method: "POST",
    url: "/process",
    ...form
  });
  const body = response.json();

  assert.equal(response.statusCode, 200);
  assert.equal(body.outputSize, 512);
  assert.equal(body.enhance, false);
  assert.match(body.enhancedBase64, /^[A-Za-z0-9+/=]+$/);
  assert.match(body.squareBase64, /^[A-Za-z0-9+/=]+$/);

  const squareBuffer = Buffer.from(body.squareBase64, "base64");
  const meta = await sharp(squareBuffer).metadata();
  assert.equal(meta.width, 512);
  assert.equal(meta.height, 512);
});

test("POST /process returns 500 when background removal fails inside the app stack", async () => {
  const source = await createTransparentPng();
  const app = createApp({
    removeBackgroundFn: async () => {
      throw new Error("background service unavailable");
    },
    timeoutMs: 100
  });
  const form = formAutoContent({
    image: {
      value: source,
      options: {
        filename: "sample.png",
        contentType: "image/png"
      }
    }
  });

  const response = await inject(app, {
    method: "POST",
    url: "/process",
    ...form
  });
  const body = response.json();

  assert.equal(response.statusCode, 500);
  assert.equal(body.error, "Processing failed");
  assert.match(body.details, /background service unavailable/);
});
