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

// ---- Status ----
function setStatus(msg, type) {
    const el = document.getElementById("status");
    el.style.display = "block";
    el.className = type || "info";
    el.textContent = msg;
}

// ---- Parse ----
function startParse() {
    const fileInput = document.getElementById("file-input");
    if (!fileInput.files.length) {
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
                    setStatus("Parsed! Starting calibration...", "success");
                    document.getElementById("cal-panel").style.display = "block";
                    document.getElementById("sol-panel").style.display = "none";
                    updateBoardText();
                    nextCalibration();
                } catch (err) {
                    setStatus("Parse error: " + err.message, "error");
                    console.error(err);
                }
            }, 50);
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(fileInput.files[0]);
}

// ---- Board Text ----
const COLOR_CSS = {
    1: "#aaa", // gray
    2: "#e87aaf", // pink
    3: "#e8a832", // orange
    4: "#5ba8e8" // blue
};

function updateBoardText() {
    const el = document.getElementById("board-text");
    el.style.display = "block";
    el.innerHTML = "";
    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
            const cid = parseResult.colorIds[r * COLS + c];
            const span = document.createElement("span");
            span.textContent = CCHARS[cid];
            span.style.color = COLOR_CSS[cid] || "#fff";
            span.style.fontWeight = "bold";
            el.appendChild(span);
            if (c < COLS - 1) el.appendChild(document.createTextNode(" "));
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
        document.getElementById("cal-info").textContent = "✅ All cells above confidence threshold!";
        document.getElementById("btn-solve").style.display = "inline-block";
        drawCalCanvas(null);
        return;
    }

    const idx = calQueue[0];
    const r = Math.floor(idx / COLS),
        c = idx % COLS;
    const conf = (parseResult.confidences[idx] * 100).toFixed(0);
    const assigned = CCHARS[parseResult.colorIds[idx]];
    const alt = CCHARS[parseResult.secondBests[idx]];

    document.getElementById("cal-info").innerHTML = `<b>${calQueue.length}</b> cells to review &mdash; ` + `Row ${r + 1}, Col ${c + 1}: ` + `Guess: <b>${assigned}</b>, Alt: <b>${alt}</b>, ` + `Confidence: <b>${conf}%</b>`;
    document.getElementById("btn-solve").style.display = "none";

    drawCalCanvas(idx);
}

function drawCalCanvas(highlightIdx) {
    const canvas = document.getElementById("cal-canvas");
    const ctx = canvas.getContext("2d");

    if (highlightIdx === null) {
        canvas.width = 500;
        canvas.height = 400;
        const ctx2 = canvas.getContext("2d");
        ctx2.fillStyle = "#111";
        ctx2.fillRect(0, 0, 500, 400);
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
    console.log(`[cal] imgElement:`, imgElement, `naturalSize: ${imgElement?.naturalWidth}x${imgElement?.naturalHeight}`);

    // Fixed canvas size so buttons don't jump around
    const CANVAS_W = 500,
        CANVAS_H = 400;
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

function calibrate(colorId) {
    if (!parseResult || calQueue.length === 0) return;

    const idx = calQueue[0];
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
    const maxStates = parseInt(document.getElementById("max-states").value) || 10000;
    setStatus("Solving... this may take a moment.", "info");
    document.getElementById("progress").textContent = "Starting solver...";
    document.getElementById("sol-panel").style.display = "block";

    // Build grid as flat Int8Array
    const grid = new Int8Array(ROWS * COLS);
    for (let i = 0; i < ROWS * COLS; i++) grid[i] = parseResult.colorIds[i];

    // Run solver async to not block UI
    setTimeout(() => {
        try {
            solveResult = solve(grid, ROWS, COLS, maxStates, (explored, bestClear) => {
                document.getElementById("progress").textContent = `${explored} states explored, best: ${bestClear.toFixed(1)}%`;
            });

            const pct = solveResult.clearRate.toFixed(1);
            const steps = solveResult.solution.length;
            setStatus(`Done! Cleared ${pct}% in ${steps} steps.`, "success");
            document.getElementById("progress").textContent = `Cleared ${pct}% in ${steps} steps`;

            currentStep = 0;
            showStep();
        } catch (err) {
            setStatus("Solver error: " + err.message, "error");
            console.error(err);
        }
    }, 50);
}

// ---- Solution Step Viewer ----

const CELL_PX = 40;
const spriteImages = {};
let spritesLoaded = false;

function loadSprites() {
    return new Promise(resolve => {
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
            img.src = `sprites/${i}.png`;
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
    4: "#5ba8e8"
};

function showStep() {
    if (!solveResult) return;
    const total = solveResult.solution.length;
    document.getElementById("step-label").textContent = `Step ${currentStep} / ${total}`;

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
    if (currentStep < total) {
        const [ar, ac] = solveResult.solution[currentStep];
        ctx.strokeStyle = "#f00";
        ctx.lineWidth = 4;
        ctx.strokeRect(ac * CELL_PX, ar * CELL_PX, CELL_PX, CELL_PX);
        ctx.strokeStyle = "#ff0";
        ctx.lineWidth = 2;
        ctx.strokeRect(ac * CELL_PX + 2, ar * CELL_PX + 2, CELL_PX - 4, CELL_PX - 4);

        document.getElementById("sol-info").textContent = `Click the highlighted block at Row ${ar + 1}, Col ${ac + 1}`;
    } else {
        document.getElementById("sol-info").textContent = "Final board state";
    }
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

document.addEventListener("keydown", e => {
    if (e.key === "ArrowLeft") prevStep();
    if (e.key === "ArrowRight") nextStep();
});
