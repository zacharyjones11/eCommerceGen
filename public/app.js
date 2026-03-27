let cropper = null;
let manualPngBlob = null;

const drop = document.getElementById("drop");
const fileInput = document.getElementById("file");

const autoOut = document.getElementById("autoOut");
const manualImg = document.getElementById("manualImg");

const downloadAuto = document.getElementById("downloadAuto");
const exportManual = document.getElementById("exportManual");
const downloadManual = document.getElementById("downloadManual");

// Optional UI helpers
const processingOverlay = document.getElementById("processingOverlay");
const zoomSlider = document.getElementById("zoomSlider");
const zoomOutBtn = document.getElementById("zoomOutBtn");
const zoomInBtn = document.getElementById("zoomInBtn");
const zoomLabel = document.getElementById("zoomLabel");

// Colour adjustment controls
const satSlider = document.getElementById("satSlider");
const conSlider = document.getElementById("conSlider");
const briSlider = document.getElementById("briSlider");
const satVal = document.getElementById("satVal");
const conVal = document.getElementById("conVal");
const briVal = document.getElementById("briVal");
const resetAdjust = document.getElementById("resetAdjust");

const controlsWide = document.getElementById("controlsWide");
const outSize = document.getElementById("outSize");
const enhanceToggle = document.getElementById("enhanceToggle");

function setControlsVisible(isVisible) {
  if (!controlsWide) return;
  controlsWide.classList.toggle("is-collapsed", !isVisible);
  controlsWide.setAttribute("aria-hidden", String(!isVisible));
}

function setProcessing(isProcessing) {
  if (!processingOverlay) return;
  processingOverlay.classList.toggle("is-visible", isProcessing);
  processingOverlay.setAttribute("aria-hidden", String(!isProcessing));
}

function setZoomUI(z) {
  if (!zoomSlider || !zoomLabel) return;
  const min = parseFloat(zoomSlider.min || "0.1");
  const max = parseFloat(zoomSlider.max || "3");
  const clamped = Math.max(min, Math.min(max, z));
  zoomSlider.value = String(clamped);
  zoomLabel.textContent = `${Math.round(clamped * 100)}%`;
}

function applyZoom(z) {
  if (!cropper) return;
  cropper.zoomTo(z);
  setZoomUI(z);
}

function setDragUI(on) {
  if (!drop) return;
  drop.classList.toggle("dragover", on);
}

function getOutputSize() {
  const v = parseInt(outSize?.value || "1200", 10);
  if (Number.isNaN(v)) return 1200;
  return Math.max(300, Math.min(4000, v)); // clamp
}

function getEnhanceEnabled() {
  return enhanceToggle ? !!enhanceToggle.checked : true;
}

setControlsVisible(false);

if (enhanceToggle) {
  enhanceToggle.addEventListener("change", () => {
    if (!enhanceToggle.checked) {
      if (satSlider) satSlider.value = "100";
      if (conSlider) conSlider.value = "100";
      if (briSlider) briSlider.value = "100";
      applyPreviewFilter();
    }
  });
}

if (drop) {
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    setDragUI(true);
  });

  drop.addEventListener("dragleave", () => setDragUI(false));

  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    setDragUI(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  });
}

if (fileInput) {
  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    if (f) handleFile(f);
  });
}

function b64ToBlob(b64, mime) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: mime });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function getFilterState() {
  return {
    sat: satSlider ? parseFloat(satSlider.value) : 115,
    con: conSlider ? parseFloat(conSlider.value) : 103,
    bri: briSlider ? parseFloat(briSlider.value) : 102
  };
}

function filterCss({ sat, con, bri }) {
  return `saturate(${sat}%) contrast(${con}%) brightness(${bri}%)`;
}

function updateFilterLabels({ sat, con, bri }) {
  if (satVal) satVal.textContent = `${Math.round(sat)}%`;
  if (conVal) conVal.textContent = `${Math.round(con)}%`;
  if (briVal) briVal.textContent = `${Math.round(bri)}%`;
}

function applyPreviewFilter() {
  const st = getFilterState();
  updateFilterLabels(st);

  const css = filterCss(st);

  // Cropper uses multiple cloned <img> elements:
  // - background image in .cropper-canvas
  // - foreground image in .cropper-view-box (inside crop box)
  const imgs = document.querySelectorAll(
    ".cropper-canvas img, .cropper-view-box img, .cropper-modal"
  );

  imgs.forEach((el) => {
    // Apply only to images; modal is included defensively but won't be affected
    el.style.filter = css;
  });

  // Fallback (original image element)
  if (manualImg) manualImg.style.filter = css;
}

function bindAdjustmentUI() {
  if (satSlider) satSlider.oninput = applyPreviewFilter;
  if (conSlider) conSlider.oninput = applyPreviewFilter;
  if (briSlider) briSlider.oninput = applyPreviewFilter;

  if (resetAdjust) {
    resetAdjust.onclick = () => {
      if (satSlider) satSlider.value = "115";
      if (conSlider) conSlider.value = "103";
      if (briSlider) briSlider.value = "102";
      applyPreviewFilter();
    };
  }

  applyPreviewFilter();
}

async function handleFile(file) {
  if (downloadAuto) downloadAuto.disabled = true;
  if (exportManual) exportManual.disabled = true;
  if (downloadManual) downloadManual.disabled = true;
  manualPngBlob = null;

  if (autoOut) autoOut.removeAttribute("src");
  if (manualImg) manualImg.removeAttribute("src");
  setControlsVisible(false);
  setProcessing(true);

  const fd = new FormData();
  fd.append("image", file);

  const size = getOutputSize();
  const enhance = getEnhanceEnabled();

  fd.append("size", String(size));
  fd.append("enhance", enhance ? "1" : "0");

  let enhancedBase64, squareBase64;
  try {
    const resp = await fetch("/process", { method: "POST", body: fd });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err?.error || err?.details || "Processing failed");
    }
    ({ enhancedBase64, squareBase64 } = await resp.json());
  } catch (e) {
    setProcessing(false);
    setControlsVisible(false);
    alert(e?.message || "Processing failed. Check server logs.");
    return;
  }

  // Auto output (square)
  const autoBlob = b64ToBlob(squareBase64, "image/png");
  if (autoOut) autoOut.src = URL.createObjectURL(autoBlob);
  if (downloadAuto) {
    downloadAuto.disabled = false;
    downloadAuto.onclick = () => downloadBlob(autoBlob, `product-${size}-square.png`);
  }

  // Manual crop source
  const enhancedBlob = b64ToBlob(enhancedBase64, "image/png");
  if (manualImg) manualImg.src = URL.createObjectURL(enhancedBlob);

  if (cropper) cropper.destroy();
  if (!manualImg) {
    setProcessing(false);
    return;
  }

  cropper = new Cropper(manualImg, {
    aspectRatio: 1,
    viewMode: 0,
    dragMode: "move",
    background: false,
    movable: true,
    zoomable: true,
    zoomOnWheel: true,
    wheelZoomRatio: 0.1,
    responsive: true,
    cropBoxMovable: true,
    cropBoxResizable: true,
    toggleDragModeOnDblclick: false,
    ready() {
      // Start zoomed OUT
      const initialZoom = 0.20;
      this.cropper.zoomTo(initialZoom);
      setZoomUI(initialZoom);

      // Largest visible square crop box
      const canvasData = this.cropper.getCanvasData();
      const boxSize = Math.min(canvasData.width, canvasData.height);
      const left = canvasData.left + (canvasData.width - boxSize) / 2;
      const top = canvasData.top + (canvasData.height - boxSize) / 2;
      this.cropper.setCropBoxData({ left, top, width: boxSize, height: boxSize });

      // Zoom controls
      if (zoomSlider) zoomSlider.oninput = () => applyZoom(parseFloat(zoomSlider.value));
      if (zoomOutBtn) zoomOutBtn.onclick = () => applyZoom((parseFloat(zoomSlider?.value || "1") || 1) * 0.9);
      if (zoomInBtn) zoomInBtn.onclick = () => applyZoom((parseFloat(zoomSlider?.value || "1") || 1) * 1.1);

      // Colour controls
      bindAdjustmentUI();
      applyPreviewFilter();
      setTimeout(applyPreviewFilter, 0);

      // Image is fully ready; expand the global controls panel
      setControlsVisible(true);
    }
  });

  // Manual export
  if (exportManual) {
    exportManual.disabled = false;
    exportManual.onclick = async () => {
      const canvas = cropper.getCroppedCanvas({
        width: size,
        height: size,
        imageSmoothingEnabled: true,
        imageSmoothingQuality: "high",
        fillColor: "rgba(0,0,0,0)"
      });

      // Bake filter into exported PNG
      const st = getFilterState();
      const out = document.createElement("canvas");
      out.width = canvas.width;
      out.height = canvas.height;
      const ctx = out.getContext("2d");
      ctx.clearRect(0, 0, out.width, out.height);
      ctx.filter = filterCss(st);
      ctx.drawImage(canvas, 0, 0);
      ctx.filter = "none";

      manualPngBlob = await new Promise((resolve, reject) => {
        out.toBlob((b) => (b ? resolve(b) : reject(new Error("Failed to export PNG"))), "image/png");
      });

      if (downloadManual) downloadManual.disabled = false;
      alert("Manual crop exported. Now click Download Manual PNG.");
    };
  }

  if (downloadManual) {
    downloadManual.onclick = () => {
      if (!manualPngBlob) return;
      downloadBlob(manualPngBlob, `product-manual-${size}-square.png`);
    };
  }

  setProcessing(false);
}