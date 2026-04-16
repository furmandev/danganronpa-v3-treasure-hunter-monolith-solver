/**
 * app.js — UI controller: parse, calibrate, solve, step viewer.
 */

let parseResult = null; // from parser.js
let solveResult = null; // from solver.js
let imgData = null; // ImageData of loaded image
let imgElement = null; // Original Image element for drawing
let imgW = 0,
    imgH = 0;
let COLS = 22,
    ROWS = 11;
let currentStep = 0;
let pinned = new Set(); // flat indices that have been manually confirmed
let calHistory = []; // undo stack for calibration steps
let solveStarted = false;
let solveWorker = null;
let selectedImageFile = null;
let selectedImageUrl = null;
let stepAnimationFrame = null;
let isApplyingPerspective = false;
let hasAutoOpenedCropperForCurrentImage = false;
const AUTO_CROP_UNCERTAIN_THRESHOLD = 5;
let perspectiveState = {
    image: null,
    points: [],
    dragIndex: -1,
    display: null,
    srcCanvas: null,
    srcCtx: null,
};

// ---- Status ----
function setStatus(msg, type) {
    const el = document.getElementById("status");
    el.style.display = "block";
    el.className = type || "info";
    el.textContent = msg;
}

function setUploadStatus(msg, kind) {
    const el = document.getElementById("upload-status");
    el.textContent = msg;
    el.className = `upload-status${kind ? ` ${kind}` : ""}`;
}

function setParseEnabled(isEnabled) {
    document.getElementById("btn-parse").disabled = !isEnabled;
}

function getMinConfidenceThreshold() {
    return parseInt(document.getElementById("min-conf").value) / 100;
}

function countUncertainCells(result, minConf) {
    return result.confidences.filter((confidence) => confidence < minConf).length;
}

function maybeAutoOpenCropper(shouldAutoOpen) {
    if (!shouldAutoOpen || hasAutoOpenedCropperForCurrentImage) return;
    hasAutoOpenedCropperForCurrentImage = true;
    setTimeout(() => {
        openPerspectiveModal();
    }, 0);
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    return `${(kb / 1024).toFixed(2)} MB`;
}

function triggerFileSelect() {
    document.getElementById("file-input").click();
}

function clearSelectedImage() {
    closePerspectiveModal();
    selectedImageFile = null;
    hasAutoOpenedCropperForCurrentImage = false;
    if (selectedImageUrl) {
        URL.revokeObjectURL(selectedImageUrl);
        selectedImageUrl = null;
    }

    document.getElementById("file-input").value = "";
    document.getElementById("upload-preview-wrap").style.display = "none";
    document.getElementById("upload-empty").style.display = "block";
    document.getElementById("upload-meta").textContent = "";
    setParseEnabled(false);
    setUploadStatus("No image selected.");
}

function useSelectedImage(file, objectUrl, width, height, onReady) {
    if (selectedImageUrl) URL.revokeObjectURL(selectedImageUrl);
    selectedImageUrl = objectUrl;
    selectedImageFile = file;

    const preview = document.getElementById("upload-preview");
    preview.src = objectUrl;
    const fileName = file.name || "clipboard-image.png";
    document.getElementById("upload-meta").innerHTML =
        `<b>${fileName}</b><br>${width} x ${height} px, ${formatBytes(file.size)}`;
    document.getElementById("upload-empty").style.display = "none";
    document.getElementById("upload-preview-wrap").style.display = "flex";
    setParseEnabled(true);
    setUploadStatus("Image ready to parse.", "ok");
    if (typeof onReady === "function") onReady();
}

function loadImageElement(img, src) {
    return new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Could not load image."));
        img.src = src;
    });
}

function getPerspectiveModal() {
    return document.getElementById("perspective-modal");
}

function setPerspectiveBusy(isBusy, statusText) {
    isApplyingPerspective = isBusy;
    const applyBtn = document.getElementById("perspective-apply");
    const resetBtn = document.getElementById("perspective-reset");
    const cancelBtn = document.getElementById("perspective-cancel");
    const statusEl = document.getElementById("perspective-status");

    if (applyBtn) {
        applyBtn.disabled = isBusy;
        applyBtn.textContent = isBusy ? "Applying..." : "Apply Perspective";
    }
    if (resetBtn) resetBtn.disabled = isBusy;
    if (cancelBtn) cancelBtn.disabled = isBusy;
    if (statusEl) statusEl.textContent = statusText || "";
}

function initPerspectivePoints(width, height) {
    const insetX = width * 0.1;
    const insetY = height * 0.1;
    perspectiveState.points = [
        { x: insetX, y: insetY },
        { x: width - insetX, y: insetY },
        { x: width - insetX, y: height - insetY },
        { x: insetX, y: height - insetY },
    ];
}

function updatePerspectiveDisplay() {
    const canvas = document.getElementById("perspective-canvas");
    const stage = canvas.parentElement;
    const image = perspectiveState.image;
    if (!image || !stage) return;

    const stageWidth = Math.max(320, stage.clientWidth || 320);
    const stageHeight = Math.max(260, stage.clientHeight || 260);
    const scale = Math.min(stageWidth / image.width, stageHeight / image.height);
    const drawW = Math.max(1, Math.round(image.width * scale));
    const drawH = Math.max(1, Math.round(image.height * scale));
    const offsetX = Math.round((stageWidth - drawW) / 2);
    const offsetY = Math.round((stageHeight - drawH) / 2);

    canvas.width = stageWidth;
    canvas.height = stageHeight;
    perspectiveState.display = { scale, drawW, drawH, offsetX, offsetY };
}

function imagePtToCanvas(pt) {
    const d = perspectiveState.display;
    return {
        x: d.offsetX + pt.x * d.scale,
        y: d.offsetY + pt.y * d.scale,
    };
}

function canvasPtToImage(x, y) {
    const d = perspectiveState.display;
    const img = perspectiveState.image;
    return {
        x: Math.min(img.width, Math.max(0, (x - d.offsetX) / d.scale)),
        y: Math.min(img.height, Math.max(0, (y - d.offsetY) / d.scale)),
    };
}

function renderPerspectiveCanvas() {
    const canvas = document.getElementById("perspective-canvas");
    const ctx = canvas.getContext("2d");
    const d = perspectiveState.display;
    const image = perspectiveState.image;
    if (!ctx || !d || !image) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#0d1117";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, d.offsetX, d.offsetY, d.drawW, d.drawH);

    const pts = perspectiveState.points.map((p) => imagePtToCanvas(p));
    ctx.save();
    ctx.strokeStyle = "rgba(255, 88, 88, 0.98)";
    ctx.fillStyle = "rgba(255, 88, 88, 0.18)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const ARM = 13; // crosshair arm length
        const GAP = 7; // gap around center (= circle radius)
        const R = GAP;

        // Shadow layer for contrast
        ctx.save();
        ctx.strokeStyle = "rgba(0,0,0,0.45)";
        ctx.lineWidth = 4;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(p.x - ARM, p.y);
        ctx.lineTo(p.x - GAP, p.y);
        ctx.moveTo(p.x + GAP, p.y);
        ctx.lineTo(p.x + ARM, p.y);
        ctx.moveTo(p.x, p.y - ARM);
        ctx.lineTo(p.x, p.y - GAP);
        ctx.moveTo(p.x, p.y + GAP);
        ctx.lineTo(p.x, p.y + ARM);
        ctx.stroke();
        ctx.arc(p.x, p.y, R, 0, Math.PI * 2);
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.restore();

        // Outer arms + circle
        ctx.save();
        ctx.strokeStyle = "rgba(255, 75, 75, 0.85)";
        ctx.lineWidth = 2;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(p.x - ARM, p.y);
        ctx.lineTo(p.x - GAP, p.y);
        ctx.moveTo(p.x + GAP, p.y);
        ctx.lineTo(p.x + ARM, p.y);
        ctx.moveTo(p.x, p.y - ARM);
        ctx.lineTo(p.x, p.y - GAP);
        ctx.moveTo(p.x, p.y + GAP);
        ctx.lineTo(p.x, p.y + ARM);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(p.x, p.y, R, 0, Math.PI * 2);
        ctx.stroke();
        // White center dot
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.fill();
        ctx.restore();
    }
    ctx.restore();

    // Spyglass: draw magnifier when dragging a corner
    if (perspectiveState.dragIndex !== -1) {
        const dragPt = pts[perspectiveState.dragIndex];
        const LENS_R = 90; // radius of the magnifier circle on canvas
        const ZOOM = 4; // zoom factor
        const SRC_R = LENS_R / ZOOM; // radius in source image coords

        // Source region in image space
        const imgPt = perspectiveState.points[perspectiveState.dragIndex];
        const sx = d.offsetX + imgPt.x * d.scale - SRC_R;
        const sy = d.offsetY + imgPt.y * d.scale - SRC_R;

        // Position lens near the dragged corner, offset inward so it doesn't cover the handle
        const OFFSET = LENS_R + 24;
        const lensX = Math.min(
            Math.max(dragPt.x + (dragPt.x < canvas.width / 2 ? OFFSET : -OFFSET), LENS_R + 4),
            canvas.width - LENS_R - 4,
        );
        const lensY = Math.min(
            Math.max(dragPt.y + (dragPt.y < canvas.height / 2 ? OFFSET : -OFFSET), LENS_R + 4),
            canvas.height - LENS_R - 4,
        );

        ctx.save();
        ctx.beginPath();
        ctx.arc(lensX, lensY, LENS_R, 0, Math.PI * 2);
        ctx.clip();

        // Draw dark background then zoomed image region
        ctx.fillStyle = "#0d1117";
        ctx.fillRect(lensX - LENS_R, lensY - LENS_R, LENS_R * 2, LENS_R * 2);
        ctx.drawImage(canvas, sx, sy, SRC_R * 2, SRC_R * 2, lensX - LENS_R, lensY - LENS_R, LENS_R * 2, LENS_R * 2);

        ctx.restore();

        // Lens border
        ctx.save();
        ctx.beginPath();
        ctx.arc(lensX, lensY, LENS_R, 0, Math.PI * 2);
        ctx.strokeStyle = "#ff4b4b";
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.restore();
    }
}

function getCanvasPointerPos(e) {
    const canvas = document.getElementById("perspective-canvas");
    const rect = canvas.getBoundingClientRect();
    return {
        x: ((e.clientX - rect.left) / rect.width) * canvas.width,
        y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
}

function onPerspectivePointerDown(e) {
    const modal = getPerspectiveModal();
    if (!modal || !modal.classList.contains("open") || !perspectiveState.display || isApplyingPerspective) return;
    const canvas = document.getElementById("perspective-canvas");
    const pos = getCanvasPointerPos(e);
    let nearestIdx = -1;
    let bestDist = 28;

    for (let i = 0; i < perspectiveState.points.length; i++) {
        const p = imagePtToCanvas(perspectiveState.points[i]);
        const dist = Math.hypot(p.x - pos.x, p.y - pos.y);
        if (dist < bestDist) {
            bestDist = dist;
            nearestIdx = i;
        }
    }

    if (nearestIdx !== -1) {
        perspectiveState.dragIndex = nearestIdx;
        canvas.setPointerCapture(e.pointerId);
        e.preventDefault();
    }
}

function onPerspectivePointerMove(e) {
    if (perspectiveState.dragIndex === -1 || !perspectiveState.display || isApplyingPerspective) return;
    const pos = getCanvasPointerPos(e);
    perspectiveState.points[perspectiveState.dragIndex] = canvasPtToImage(pos.x, pos.y);
    renderPerspectiveCanvas();
    e.preventDefault();
}

function onPerspectivePointerUp(e) {
    const canvas = document.getElementById("perspective-canvas");
    if (perspectiveState.dragIndex !== -1) {
        perspectiveState.dragIndex = -1;
        if (canvas.hasPointerCapture(e.pointerId)) {
            canvas.releasePointerCapture(e.pointerId);
        }
        renderPerspectiveCanvas(); // hide spyglass
    }
}

async function openPerspectiveModal() {
    if (!selectedImageUrl || !selectedImageFile) {
        setUploadStatus("Select an image before perspective crop.", "error");
        return;
    }
    if (typeof PerspT === "undefined") {
        setUploadStatus("Perspective tool failed to load. Refresh and try again.", "error");
        return;
    }

    const modal = getPerspectiveModal();
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    setPerspectiveBusy(false, "");

    const img = new Image();
    try {
        await loadImageElement(img, selectedImageUrl);
    } catch (err) {
        closePerspectiveModal();
        setUploadStatus("Could not load image for perspective crop.", "error");
        return;
    }

    perspectiveState.image = img;
    perspectiveState.srcCanvas = document.createElement("canvas");
    perspectiveState.srcCanvas.width = img.width;
    perspectiveState.srcCanvas.height = img.height;
    perspectiveState.srcCtx = perspectiveState.srcCanvas.getContext("2d", { willReadFrequently: true });
    perspectiveState.srcCtx.drawImage(img, 0, 0);
    initPerspectivePoints(img.width, img.height);
    updatePerspectiveDisplay();
    renderPerspectiveCanvas();
}

function closePerspectiveModal() {
    if (isApplyingPerspective) return;
    perspectiveState.dragIndex = -1;
    perspectiveState.image = null;
    perspectiveState.points = [];
    perspectiveState.display = null;
    perspectiveState.srcCanvas = null;
    perspectiveState.srcCtx = null;
    const modal = getPerspectiveModal();
    if (!modal) return;
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
}

function resetPerspective() {
    if (!perspectiveState.image || isApplyingPerspective) return;
    initPerspectivePoints(perspectiveState.image.width, perspectiveState.image.height);
    renderPerspectiveCanvas();
}

function sampleBilinear(imageData, width, height, x, y) {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(width - 1, x0 + 1);
    const y1 = Math.min(height - 1, y0 + 1);
    const dx = x - x0;
    const dy = y - y0;

    const i00 = (y0 * width + x0) * 4;
    const i10 = (y0 * width + x1) * 4;
    const i01 = (y1 * width + x0) * 4;
    const i11 = (y1 * width + x1) * 4;

    const out = [0, 0, 0, 0];
    for (let c = 0; c < 4; c++) {
        const top = imageData[i00 + c] * (1 - dx) + imageData[i10 + c] * dx;
        const bottom = imageData[i01 + c] * (1 - dx) + imageData[i11 + c] * dx;
        out[c] = top * (1 - dy) + bottom * dy;
    }
    return out;
}

function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

function applyPerspective() {
    if (!perspectiveState.image || perspectiveState.points.length !== 4 || !selectedImageFile || isApplyingPerspective)
        return;

    setPerspectiveBusy(true, "Applying perspective correction...");
    setUploadStatus("Applying perspective correction...");

    setTimeout(() => {
        try {
            const [p0, p1, p2, p3] = perspectiveState.points;
            const estW = Math.max(32, Math.round((distance(p0, p1) + distance(p3, p2)) / 2));
            const estH = Math.max(32, Math.round((distance(p0, p3) + distance(p1, p2)) / 2));
            const maxDim = 2200;
            const downscale = Math.min(1, maxDim / Math.max(estW, estH));
            const cropW = Math.max(32, Math.round(estW * downscale));
            const cropH = Math.max(32, Math.round(estH * downscale));
            // Add padding so grid lines never land at the image edge
            const PAD = Math.round(Math.max(cropW, cropH) * 0.01);
            const outW = cropW + PAD * 2;
            const outH = cropH + PAD * 2;

            const srcPts = [p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, p3.x, p3.y];
            const dstPts = [PAD, PAD, PAD + cropW - 1, PAD, PAD + cropW - 1, PAD + cropH - 1, PAD, PAD + cropH - 1];
            const perspT = PerspT(srcPts, dstPts);

            const srcData = perspectiveState.srcCtx.getImageData(
                0,
                0,
                perspectiveState.srcCanvas.width,
                perspectiveState.srcCanvas.height,
            );
            const srcBuf = srcData.data;
            const srcW = perspectiveState.srcCanvas.width;
            const srcH = perspectiveState.srcCanvas.height;

            const outCanvas = document.createElement("canvas");
            outCanvas.width = outW;
            outCanvas.height = outH;
            const outCtx = outCanvas.getContext("2d", { willReadFrequently: true });
            const outImage = outCtx.createImageData(outW, outH);
            const outBuf = outImage.data;

            for (let y = 0; y < outH; y++) {
                for (let x = 0; x < outW; x++) {
                    const [sx, sy] = perspT.transformInverse(x, y);
                    const outIdx = (y * outW + x) * 4;
                    if (sx < 0 || sy < 0 || sx >= srcW - 1 || sy >= srcH - 1) {
                        outBuf[outIdx + 0] = 0;
                        outBuf[outIdx + 1] = 0;
                        outBuf[outIdx + 2] = 0;
                        outBuf[outIdx + 3] = 255;
                        continue;
                    }

                    const rgba = sampleBilinear(srcBuf, srcW, srcH, sx, sy);
                    outBuf[outIdx + 0] = rgba[0];
                    outBuf[outIdx + 1] = rgba[1];
                    outBuf[outIdx + 2] = rgba[2];
                    outBuf[outIdx + 3] = rgba[3];
                }
            }

            outCtx.putImageData(outImage, 0, 0);
            const mimeType = selectedImageFile.type || "image/png";
            const extension = mimeType === "image/jpeg" ? ".jpg" : ".png";

            outCanvas.toBlob(
                (blob) => {
                    if (!blob) {
                        setPerspectiveBusy(false, "");
                        setUploadStatus("Could not apply perspective correction. Try again.", "error");
                        return;
                    }
                    const correctedFile = new File(
                        [blob],
                        fileNameWithSuffix(selectedImageFile.name || "image.png", "-perspective", extension),
                        {
                            type: blob.type || mimeType,
                        },
                    );

                    setPerspectiveBusy(false, "");
                    closePerspectiveModal();
                    handleSelectedFile(
                        correctedFile,
                        () => {
                            setUploadStatus("Perspective correction applied. Re-parsing...", "ok");
                            startParse();
                        },
                        { preserveAutoOpenState: true },
                    );
                },
                mimeType,
                0.95,
            );
        } catch (err) {
            setPerspectiveBusy(false, "");
            setUploadStatus("Could not apply perspective correction. Try again.", "error");
            console.error(err);
        }
    }, 0);
}

function fileNameWithSuffix(fileName, suffix, fallbackExt) {
    const dotIdx = fileName.lastIndexOf(".");
    if (dotIdx === -1) return `${fileName}${suffix}${fallbackExt}`;
    return `${fileName.slice(0, dotIdx)}${suffix}${fileName.slice(dotIdx)}`;
}

function handleSelectedFile(file, onReady, options) {
    if (!file) return;

    const { preserveAutoOpenState = false } = options || {};
    if (!preserveAutoOpenState) hasAutoOpenedCropperForCurrentImage = false;

    if (!file.type || !file.type.startsWith("image/")) {
        setUploadStatus("Please select a valid image file.", "error");
        setParseEnabled(false);
        return;
    }

    setUploadStatus("Validating image...");
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
        if (img.width < 200 || img.height < 100) {
            URL.revokeObjectURL(objectUrl);
            setUploadStatus("Image is too small. Please use a full screenshot.", "error");
            setParseEnabled(false);
            return;
        }
        useSelectedImage(file, objectUrl, img.width, img.height, onReady);
    };
    img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        setUploadStatus("Could not read that image. Try another file.", "error");
        setParseEnabled(false);
    };
    img.src = objectUrl;
}

function extractClipboardImageFile(event) {
    const items = event.clipboardData && event.clipboardData.items ? event.clipboardData.items : [];
    for (const item of items) {
        if (item.type && item.type.startsWith("image/")) {
            return item.getAsFile();
        }
    }
    return null;
}

async function grabImageFromClipboard() {
    showPanel("load-panel");

    if (!navigator.clipboard || !navigator.clipboard.read) {
        setUploadStatus("Clipboard read is not supported here. Use paste (Ctrl+V) instead.", "error");
        return;
    }

    try {
        setUploadStatus("Reading clipboard...");
        const items = await navigator.clipboard.read();
        for (const item of items) {
            for (const type of item.types) {
                if (!type.startsWith("image/")) continue;
                const blob = await item.getType(type);
                const ext = type.split("/")[1] || "png";
                const file = new File([blob], `clipboard-${Date.now()}.${ext}`, { type });
                handleSelectedFile(file);
                return;
            }
        }

        setUploadStatus("Clipboard does not contain an image.", "error");
    } catch (err) {
        setUploadStatus("Could not read clipboard. Allow permission and try again.", "error");
    }
}

function initUploader() {
    const zone = document.getElementById("upload-zone");
    const input = document.getElementById("file-input");
    const perspectiveModal = getPerspectiveModal();
    const perspectiveCanvas = document.getElementById("perspective-canvas");

    zone.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        triggerFileSelect();
    });
    zone.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            triggerFileSelect();
        }
    });

    input.addEventListener("change", () => {
        handleSelectedFile(input.files[0]);
    });

    for (const evt of ["dragenter", "dragover"]) {
        zone.addEventListener(evt, (e) => {
            e.preventDefault();
            zone.classList.add("dragover");
        });
    }
    for (const evt of ["dragleave", "drop"]) {
        zone.addEventListener(evt, (e) => {
            e.preventDefault();
            zone.classList.remove("dragover");
        });
    }

    zone.addEventListener("drop", (e) => {
        const file = e.dataTransfer && e.dataTransfer.files ? e.dataTransfer.files[0] : null;
        handleSelectedFile(file);
    });

    zone.addEventListener("paste", (e) => {
        const file = extractClipboardImageFile(e);
        if (!file) return;
        e.preventDefault();
        handleSelectedFile(file);
    });

    document.addEventListener("paste", (e) => {
        const file = extractClipboardImageFile(e);
        if (!file) return;
        e.preventDefault();
        handleSelectedFile(file);
        showPanel("load-panel");
        setUploadStatus("Pasted image from clipboard. Validating...");
    });

    perspectiveModal.addEventListener("click", (e) => {
        if (e.target === perspectiveModal) {
            closePerspectiveModal();
        }
    });

    perspectiveCanvas.addEventListener("pointerdown", onPerspectivePointerDown);
    perspectiveCanvas.addEventListener("pointermove", onPerspectivePointerMove);
    perspectiveCanvas.addEventListener("pointerup", onPerspectivePointerUp);
    perspectiveCanvas.addEventListener("pointercancel", onPerspectivePointerUp);

    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            closePerspectiveModal();
        }
    });

    window.addEventListener("resize", () => {
        if (perspectiveModal.classList.contains("open") && perspectiveState.image) {
            updatePerspectiveDisplay();
            renderPerspectiveCanvas();
        }
    });

    clearSelectedImage();
}

function showPanel(panelId) {
    document.getElementById("load-panel").style.display = panelId === "load-panel" ? "block" : "none";
    document.getElementById("cal-panel").style.display = panelId === "cal-panel" ? "block" : "none";
    document.getElementById("sol-panel").style.display = panelId === "sol-panel" ? "block" : "none";
}

function setSolvingState(isSolving) {
    document.getElementById("sol-loading").style.display = isSolving ? "flex" : "none";
    document.getElementById("sol-canvas").style.display = isSolving ? "none" : "block";
    document.querySelector(".step-nav").style.display = isSolving ? "none" : "flex";
    document.getElementById("sol-info").style.display = isSolving ? "none" : "block";
}

// ---- Parse ----
function startParse() {
    if (solveWorker) {
        solveWorker.terminate();
        solveWorker = null;
    }

    if (!selectedImageFile) {
        setStatus("Select an image first.", "error");
        return;
    }

    setStatus("Loading image...", "info");
    const reader = new FileReader();
    reader.onload = function (e) {
        const img = new Image();
        img.onload = function () {
            // Draw to offscreen canvas to get pixel data
            const canvas = document.createElement("canvas");
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0);
            imgData = ctx.getImageData(0, 0, img.width, img.height);
            imgElement = img;
            imgW = img.width;
            imgH = img.height;

            setStatus("Parsing grid...", "info");
            setTimeout(() => {
                try {
                    parseResult = parseImage(imgData, imgW, imgH, COLS, ROWS);
                    pinned = new Set();
                    solveStarted = false;

                    const totalCells = ROWS * COLS;
                    const minConf = getMinConfidenceThreshold();
                    const lowCount = countUncertainCells(parseResult, minConf);
                    const shouldAutoOpenCropper = lowCount > AUTO_CROP_UNCERTAIN_THRESHOLD;
                    if (lowCount > totalCells * 0.2) {
                        const pct = Math.round((lowCount / totalCells) * 100);
                        setStatus(
                            `⚠️ ${pct}% of cells couldn't be confidently read. ` +
                                `Try using a higher-resolution photo, or use the perspective tool to straighten and crop the board more tightly.`,
                            "error",
                        );
                        maybeAutoOpenCropper(shouldAutoOpenCropper);
                        return;
                    }

                    setStatus("Parsed! Starting calibration...", "success");
                    showPanel("cal-panel");
                    updateBoardText();
                    nextCalibration();
                    maybeAutoOpenCropper(shouldAutoOpenCropper);
                } catch (err) {
                    setStatus("Parse error: " + err.message, "error");
                    console.error(err);
                }
            }, 50);
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(selectedImageFile);
}

// ---- Board Text ----
const COLOR_CSS = {
    1: "#aaa", // gray
    2: "#e87aaf", // pink
    3: "#e8a832", // orange
    4: "#5ba8e8", // blue
};
const COLOR_NAMES = {
    1: "Gray",
    2: "Pink",
    3: "Orange",
    4: "Blue",
};
const COLOR_BADGE_CLASSES = {
    1: "gray",
    2: "pink",
    3: "orange",
    4: "blue",
};
const COLOR_BUTTON_IDS = {
    1: "cal-btn-gray",
    2: "cal-btn-pink",
    3: "cal-btn-orange",
    4: "cal-btn-blue",
};

function getColorName(colorId) {
    return COLOR_NAMES[colorId] || "Unknown";
}

function updateCalibrationButtons(currentGuessId) {
    for (const [colorId, buttonId] of Object.entries(COLOR_BUTTON_IDS)) {
        const button = document.getElementById(buttonId);
        if (!button) continue;
        const isCurrentGuess = Number(colorId) === currentGuessId;
        button.classList.toggle("current-guess", isCurrentGuess);
        button.setAttribute("aria-pressed", isCurrentGuess ? "true" : "false");
    }

    const skipButton = document.getElementById("cal-btn-skip");
    if (skipButton) {
        skipButton.textContent = currentGuessId ? `Accept ${getColorName(currentGuessId)}` : "Accept Guess";
    }
}

function renderCalibrationInfo(idx) {
    const info = document.getElementById("cal-info");
    if (idx === null || idx === undefined) {
        updateCalibrationButtons(null);
        return;
    }

    const r = Math.floor(idx / COLS);
    const c = idx % COLS;
    const confidence = (parseResult.confidences[idx] * 100).toFixed(0);
    const guessId = parseResult.colorIds[idx];
    const altId = parseResult.secondBests[idx];
    const guessName = getColorName(guessId);
    const altName = getColorName(altId);
    const badgeClass = COLOR_BADGE_CLASSES[guessId] || "";

    info.innerHTML =
        `<div class="cal-summary"><span><b>${calQueue.length}</b> cells to review</span><span>Row <b>${r + 1}</b>, Col <b>${c + 1}</b></span><span>Confidence <b>${confidence}%</b></span></div>` +
        `<div class="cal-current-guess"><span>Current parser guess:</span><span class="guess-chip ${badgeClass}">${guessName}</span><span>My second guess is <b>${altName}</b></span></div>`;

    updateCalibrationButtons(guessId);
}

function updateBoardText() {
    const label = document.getElementById("board-label");
    const el = document.getElementById("board-text");
    label.style.display = "block";
    el.style.display = "block";
    el.innerHTML = "";
    const minConf = parseInt(document.getElementById("min-conf").value) / 100;
    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
            const idx = r * COLS + c;
            const cid = parseResult.colorIds[idx];
            const span = document.createElement("span");
            span.textContent = CCHARS[cid];
            span.style.color = COLOR_CSS[cid] || "#fff";
            span.style.fontWeight = "bold";
            if (!pinned.has(idx) && parseResult.confidences[idx] < minConf) {
                span.classList.add("low-conf");
            }
            el.appendChild(span);
        }
        el.appendChild(document.createTextNode("\n"));
    }
}
// ---- Calibration ----
let calQueue = []; // indices of borderline cells sorted by confidence

function nextCalibration() {
    const minConf = parseInt(document.getElementById("min-conf").value) / 100;

    // Find borderline cells
    calQueue = [];
    for (let i = 0; i < ROWS * COLS; i++) {
        if (!pinned.has(i) && parseResult.confidences[i] < minConf) {
            calQueue.push(i);
        }
    }
    calQueue.sort((a, b) => parseResult.confidences[a] - parseResult.confidences[b]);

    if (calQueue.length === 0) {
        document.getElementById("cal-info").textContent = "✅ All cells above confidence threshold! Starting solver...";
        document.getElementById("btn-solve").style.display = "none";
        updateCalibrationButtons(null);
        drawCalCanvas(null);

        if (!solveStarted) {
            solveStarted = true;
            setStatus("Calibration complete. Running solver...", "info");
            setTimeout(() => startSolve(), 50);
        }
        return;
    }

    const idx = calQueue[0];
    renderCalibrationInfo(idx);
    document.getElementById("btn-solve").style.display = "none";

    drawCalCanvas(idx);
}

function drawCalCanvas(highlightIdx) {
    const canvas = document.getElementById("cal-canvas");
    const ctx = canvas.getContext("2d");

    if (highlightIdx === null) {
        const maxWidth = Math.min(window.innerWidth - 40, 500);
        const canvasW = maxWidth;
        const canvasH = Math.round(maxWidth * (400 / 500));
        canvas.width = canvasW;
        canvas.height = canvasH;
        const ctx2 = canvas.getContext("2d");
        ctx2.fillStyle = "#111";
        ctx2.fillRect(0, 0, canvasW, canvasH);
        return;
    }

    const r = Math.floor(highlightIdx / COLS),
        c = highlightIdx % COLS;
    const { vLines, hLines } = parseResult;

    // Crop around the cell with 2-cell padding
    // getCellBounds(r,c) needs vLines[r+1] and hLines[r+1], so max valid r is ROWS-1, c is COLS-1
    const pad = 2;
    const rMin = Math.max(0, r - pad),
        rMax = Math.min(ROWS - 1, r + pad);
    const cMin = Math.max(0, c - pad),
        cMax = Math.min(COLS - 1, c + pad);

    const bTL = getCellBounds(vLines, hLines, rMin, cMin);
    const bBR = getCellBounds(vLines, hLines, rMax, cMax);
    const cropX = Math.max(0, Math.min(bTL.xL, bBR.xL) - 5);
    const cropY = Math.max(0, Math.min(bTL.yT, bBR.yT) - 5);
    const cropR = Math.min(imgW, Math.max(bTL.xR, bBR.xR) + 5);
    const cropB = Math.min(imgH, Math.max(bTL.yB, bBR.yB) + 5);
    const cropW = Math.max(10, cropR - cropX);
    const cropH = Math.max(10, cropB - cropY);

    console.log(`[cal] cell r=${r} c=${c}, idx=${highlightIdx}`);
    console.log(`[cal] bTL=`, bTL, `bBR=`, bBR);
    console.log(`[cal] crop: x=${cropX} y=${cropY} w=${cropW} h=${cropH}`);
    console.log(
        `[cal] imgElement:`,
        imgElement,
        `naturalSize: ${imgElement?.naturalWidth}x${imgElement?.naturalHeight}`,
    );

    // Responsive canvas size: scale down on mobile, keep 500x400 on desktop
    // Aspect ratio is 500:400 = 1.25:1
    const maxWidth = Math.min(window.innerWidth - 40, 500); // 40px margin for padding/borders
    const CANVAS_W = maxWidth;
    const CANVAS_H = Math.round(maxWidth * (400 / 500)); // Maintain 1.25:1 aspect ratio
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;

    // Fill black background
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    // Scale crop to fit canvas
    const scale = Math.min(CANVAS_W / Math.max(cropW, 1), CANVAS_H / Math.max(cropH, 1));
    const drawW = Math.round(cropW * scale);
    const drawH = Math.round(cropH * scale);
    const offsetX = Math.round((CANVAS_W - drawW) / 2);
    const offsetY = Math.round((CANVAS_H - drawH) / 2);

    console.log(`[cal] scale=${scale.toFixed(2)} drawW=${drawW} drawH=${drawH} offset=${offsetX},${offsetY}`);

    // Draw cropped region
    ctx.imageSmoothingEnabled = false;
    try {
        ctx.drawImage(imgElement, cropX, cropY, cropW, cropH, offsetX, offsetY, drawW, drawH);
        console.log(`[cal] drawImage succeeded`);
    } catch (e) {
        console.error(`[cal] drawImage FAILED:`, e);
    }

    // Highlight the target cell
    const cellB = getCellBounds(vLines, hLines, r, c);
    const hx = offsetX + (cellB.xL - cropX) * scale;
    const hy = offsetY + (cellB.yT - cropY) * scale;
    const hw = (cellB.xR - cellB.xL) * scale;
    const hh = (cellB.yB - cellB.yT) * scale;

    ctx.strokeStyle = "#ff0";
    ctx.lineWidth = 4;
    ctx.strokeRect(hx, hy, hw, hh);
    ctx.strokeStyle = "#f00";
    ctx.lineWidth = 2;
    ctx.strokeRect(hx, hy, hw, hh);
}

function updateUndoButton() {
    const btn = document.getElementById("btn-undo-cal");
    if (btn) btn.style.display = calHistory.length > 0 ? "" : "none";
}

function undoCalibration() {
    if (calHistory.length === 0) return;
    const snap = calHistory.pop();
    parseResult.colorIds = snap.colorIds;
    parseResult.confidences = snap.confidences;
    parseResult.secondBests = snap.secondBests;
    parseResult.centers = snap.centers;
    pinned = snap.pinned;
    calQueue = snap.calQueue;
    updateBoardText();
    updateUndoButton();
    if (calQueue.length > 0) {
        drawCalCanvas(calQueue[0]);
        renderCalibrationInfo(calQueue[0]);
    }
}

function calibrate(colorId) {
    if (!parseResult || calQueue.length === 0) return;

    const idx = calQueue[0];
    // Save snapshot for undo
    calHistory.push({
        colorIds: parseResult.colorIds.slice(),
        confidences: parseResult.confidences.slice(),
        secondBests: parseResult.secondBests ? parseResult.secondBests.slice() : [],
        centers: JSON.parse(JSON.stringify(parseResult.centers)),
        pinned: new Set(pinned),
        calQueue: calQueue.slice(),
    });
    updateUndoButton();
    if (colorId === 0) {
        // Accept current guess
        pinned.add(idx);
    } else {
        // Set correction
        parseResult.colorIds[idx] = colorId;
        pinned.add(idx);

        // Recompute centers from all current labels
        parseResult.centers = computeCenters(parseResult.weighted, parseResult.colorIds);

        // Re-classify non-pinned cells
        const { colorIds, confidences, secondBests } = classifyAll(parseResult.weighted, parseResult.centers);
        for (let i = 0; i < ROWS * COLS; i++) {
            if (!pinned.has(i)) {
                parseResult.colorIds[i] = colorIds[i];
            }
        }
        // Update confidences for all
        const fresh = classifyAll(parseResult.weighted, parseResult.centers);
        parseResult.confidences = fresh.confidences;
        parseResult.secondBests = fresh.secondBests;
    }

    updateBoardText();
    nextCalibration();
}

// ---- Solve ----
function startSolve() {
    if (!parseResult) return;

    const maxStates = parseInt(document.getElementById("max-states").value) || 10000;
    setStatus("Solving... this may take a moment.", "info");
    document.getElementById("progress").textContent = "Running solver (0 states explored)...";
    showPanel("sol-panel");
    setSolvingState(true);

    // Build grid as flat Int8Array
    const grid = new Int8Array(ROWS * COLS);
    for (let i = 0; i < ROWS * COLS; i++) grid[i] = parseResult.colorIds[i];

    if (solveWorker) {
        solveWorker.terminate();
        solveWorker = null;
    }

    solveWorker = new Worker("src/solver-worker.js");
    solveWorker.onmessage = (event) => {
        const data = event.data || {};

        if (data.type === "progress") {
            document.getElementById("progress").textContent =
                `${data.explored} states explored, best: ${data.bestClear.toFixed(1)}%`;
            return;
        }

        if (data.type === "result") {
            solveResult = data.result;
            solveResult.states = solveResult.states.map((s) => (s instanceof Int8Array ? s : new Int8Array(s)));

            const pct = solveResult.clearRate.toFixed(1);
            const steps = solveResult.solution.length;
            setStatus(`Solved! We can clear ${pct}% of the board in ${steps} steps:`, "success");
            document.getElementById("progress").textContent =
                `Solved! We can clear ${pct}% of the board in ${steps} steps:`;
            setSolvingState(false);

            currentStep = 0;
            showStep();

            solveWorker.terminate();
            solveWorker = null;
            return;
        }

        if (data.type === "error") {
            setStatus("Solver error: " + data.message, "error");
            setSolvingState(false);
            if (solveWorker) {
                solveWorker.terminate();
                solveWorker = null;
            }
        }
    };

    solveWorker.onerror = () => {
        setStatus("Solver error: Worker failed to execute.", "error");
        setSolvingState(false);
        if (solveWorker) {
            solveWorker.terminate();
            solveWorker = null;
        }
    };

    solveWorker.postMessage({
        grid: Array.from(grid),
        rows: ROWS,
        cols: COLS,
        maxStates,
    });
}

// ---- Solution Step Viewer ----

const CELL_PX = 40;
const spriteImages = {};
let spritesLoaded = false;

function loadSprites() {
    return new Promise((resolve) => {
        let loaded = 0;
        for (let i = 0; i <= 4; i++) {
            const img = new Image();
            img.onload = () => {
                loaded++;
                if (loaded === 5) {
                    spritesLoaded = true;
                    resolve();
                }
            };
            img.onerror = () => {
                loaded++;
                if (loaded === 5) resolve();
            };
            img.src = `src/sprites/${i}.png`;
            spriteImages[i] = img;
        }
    });
}

// Preload sprites on page load
loadSprites();

const FALLBACK_COLORS = {
    0: "#222",
    1: "#b0b0b0",
    2: "#e87aaf",
    3: "#e8a832",
    4: "#5ba8e8",
};

function getSolutionActionGroup(state, action) {
    if (!state || !action) return [];

    const [ar, ac] = action;
    const idx = ar * COLS + ac;
    if (idx < 0 || idx >= state.length || state[idx] === 0) return [];

    return adjacent(state, ar, ac, ROWS, COLS);
}

function drawSolutionActionGroup(ctx, group, timestamp) {
    if (!group.length) return;

    const pulse = (Math.sin(timestamp / 420) + 1) / 2;
    const groupSet = new Set(group.map(([r, c]) => `${r},${c}`));

    ctx.save();
    ctx.fillStyle = `rgba(255, 255, 180, ${0.1 + pulse * 0.1})`;
    for (const [r, c] of group) {
        ctx.fillRect(c * CELL_PX + 1, r * CELL_PX + 1, CELL_PX - 2, CELL_PX - 2);
    }
    ctx.restore();

    ctx.save();
    ctx.shadowColor = `rgba(255, 70, 70, ${0.55 + pulse * 0.35})`;
    ctx.shadowBlur = 10 + pulse * 16;
    ctx.strokeStyle = `rgba(255, 60, 60, ${0.75 + pulse * 0.25})`;
    ctx.lineWidth = 4 + pulse * 3;
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (const [r, c] of group) {
        const x = c * CELL_PX;
        const y = r * CELL_PX;
        if (!groupSet.has(`${r - 1},${c}`)) {
            ctx.moveTo(x, y);
            ctx.lineTo(x + CELL_PX, y);
        }
        if (!groupSet.has(`${r + 1},${c}`)) {
            ctx.moveTo(x, y + CELL_PX);
            ctx.lineTo(x + CELL_PX, y + CELL_PX);
        }
        if (!groupSet.has(`${r},${c - 1}`)) {
            ctx.moveTo(x, y);
            ctx.lineTo(x, y + CELL_PX);
        }
        if (!groupSet.has(`${r},${c + 1}`)) {
            ctx.moveTo(x + CELL_PX, y);
            ctx.lineTo(x + CELL_PX, y + CELL_PX);
        }
    }
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = `rgba(255, 245, 140, ${0.8 + (1 - pulse) * 0.2})`;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (const [r, c] of group) {
        const x = c * CELL_PX + 1.5;
        const y = r * CELL_PX + 1.5;
        const size = CELL_PX - 3;
        if (!groupSet.has(`${r - 1},${c}`)) {
            ctx.moveTo(x, y);
            ctx.lineTo(x + size, y);
        }
        if (!groupSet.has(`${r + 1},${c}`)) {
            ctx.moveTo(x, y + size);
            ctx.lineTo(x + size, y + size);
        }
        if (!groupSet.has(`${r},${c - 1}`)) {
            ctx.moveTo(x, y);
            ctx.lineTo(x, y + size);
        }
        if (!groupSet.has(`${r},${c + 1}`)) {
            ctx.moveTo(x + size, y);
            ctx.lineTo(x + size, y + size);
        }
    }
    ctx.stroke();
    ctx.restore();
}

function cancelStepAnimation() {
    if (stepAnimationFrame !== null) {
        cancelAnimationFrame(stepAnimationFrame);
        stepAnimationFrame = null;
    }
}

function drawSolutionStep(timestamp = 0) {
    if (!solveResult) return;
    const total = solveResult.states.length;
    document.getElementById("step-label").textContent = `Step ${currentStep + 1} / ${total}`;

    const state = solveResult.states[currentStep];
    const canvas = document.getElementById("sol-canvas");
    canvas.width = COLS * CELL_PX;
    canvas.height = ROWS * CELL_PX;
    const ctx = canvas.getContext("2d");

    // Draw cells using sprites
    ctx.imageSmoothingEnabled = true;
    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
            const v = state[r * COLS + c];
            const sprite = spriteImages[v];
            if (sprite && sprite.complete && sprite.naturalWidth > 0) {
                ctx.drawImage(sprite, c * CELL_PX, r * CELL_PX, CELL_PX, CELL_PX);
            } else {
                ctx.fillStyle = FALLBACK_COLORS[v] || "#222";
                ctx.fillRect(c * CELL_PX, r * CELL_PX, CELL_PX, CELL_PX);
            }
        }
    }

    // Highlight action
    if (currentStep < solveResult.solution.length) {
        const action = solveResult.solution[currentStep];
        const [ar, ac] = action;
        const group = getSolutionActionGroup(state, action);

        drawSolutionActionGroup(ctx, group, timestamp);
        document.getElementById("sol-info").textContent =
            `Click any highlighted block in this group (for example Row ${ar + 1}, Col ${ac + 1})`;
        stepAnimationFrame = requestAnimationFrame(drawSolutionStep);
    } else {
        document.getElementById("sol-info").textContent = "Final board state";
        stepAnimationFrame = null;
    }
}

function showStep() {
    cancelStepAnimation();
    drawSolutionStep(performance.now());
}

function prevStep() {
    if (currentStep > 0) {
        currentStep--;
        showStep();
    }
}

function nextStep() {
    if (solveResult && currentStep < solveResult.solution.length) {
        currentStep++;
        showStep();
    }
}

document.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") prevStep();
    if (e.key === "ArrowRight") nextStep();
});

showPanel("load-panel");
initUploader();
