/**
 * parser.js — Grid detection, color sampling, k-means clustering, calibration.
 * Ported from improved_parser.py
 */

const COLORS = { 1: "Gray", 2: "Pink", 3: "Orange", 4: "Blue" };
const CCHARS = { 1: "G", 2: "P", 3: "O", 4: "B" };

// ---- Grid Line Detection ----

function findPeaks(arr, minDist, minProm) {
    // Simple peak finder: local maxima with minimum distance and prominence
    const peaks = [];
    for (let i = 1; i < arr.length - 1; i++) {
        if (arr[i] > arr[i - 1] && arr[i] > arr[i + 1] && arr[i] >= minProm) {
            if (peaks.length === 0 || i - peaks[peaks.length - 1] >= minDist) {
                peaks.push(i);
            } else if (arr[i] > arr[peaks[peaks.length - 1]]) {
                peaks[peaks.length - 1] = i;
            }
        }
    }
    return peaks;
}

function selectBestPeaks(peaks, targetCount, totalSize) {
    if (peaks.length === targetCount) return peaks;
    if (peaks.length > targetCount) {
        const spacing = totalSize / (targetCount - 1);
        const selected = [];
        const used = new Set();
        for (let t = 0; t < targetCount; t++) {
            const ideal = t * spacing;
            let bestIdx = -1,
                bestDist = Infinity;
            for (let j = 0; j < peaks.length; j++) {
                if (!used.has(j) && Math.abs(peaks[j] - ideal) < bestDist) {
                    bestDist = Math.abs(peaks[j] - ideal);
                    bestIdx = j;
                }
            }
            if (bestIdx >= 0) {
                selected.push(peaks[bestIdx]);
                used.add(bestIdx);
            }
        }
        return selected.sort((a, b) => a - b);
    }
    // Too few: interpolate
    if (peaks.length >= 2) {
        const diffs = [];
        for (let i = 1; i < peaks.length; i++) diffs.push(peaks[i] - peaks[i - 1]);
        diffs.sort((a, b) => a - b);
        const spacing = diffs[Math.floor(diffs.length / 2)];
        while (peaks.length < targetCount) {
            if (peaks[0] - spacing > 0) peaks.unshift(Math.round(peaks[0] - spacing));
            else if (peaks[peaks.length - 1] + spacing < totalSize) peaks.push(Math.round(peaks[peaks.length - 1] + spacing));
            else break;
        }
    }
    return peaks.slice(0, targetCount);
}

function getGrayData(imageData, w, h) {
    // Convert RGBA imageData to grayscale array
    const gray = new Float32Array(w * h);
    const d = imageData.data;
    for (let i = 0; i < w * h; i++) {
        gray[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    }
    return gray;
}

function findGridLines(gray, w, h, cols, rows) {
    // First pass: find rough board area by looking for where brightness is high
    // (blocks are bright, borders/background are dark)
    // Use middle 80% to avoid edge noise
    const marginX = Math.floor(w * 0.02);
    const marginYTop = Math.floor(h * 0.05);
    const marginYBot = Math.floor(h * 0.12); // skip score bar at bottom

    // Compute column profile within board area only
    const colProfile = new Float32Array(w);
    for (let x = 0; x < w; x++) {
        let sum = 0,
            cnt = 0;
        for (let y = marginYTop; y < h - marginYBot; y++) {
            sum += gray[y * w + x];
            cnt++;
        }
        colProfile[x] = cnt > 0 ? sum / cnt : 0;
    }

    // Compute row profile within board area only
    const rowProfile = new Float32Array(h);
    for (let y = 0; y < h; y++) {
        let sum = 0,
            cnt = 0;
        for (let x = marginX; x < w - marginX; x++) {
            sum += gray[y * w + x];
            cnt++;
        }
        rowProfile[y] = cnt > 0 ? sum / cnt : 0;
    }

    // Invert (grid lines are dark = peaks when inverted)
    const colMax = Math.max(...colProfile);
    const colInv = colProfile.map(v => colMax - v);
    const rowMax = Math.max(...rowProfile);
    const rowInv = rowProfile.map(v => rowMax - v);

    let vPeaks = findPeaks(colInv, Math.floor(w / (cols + 6)), 2);
    let hPeaks = findPeaks(rowInv, Math.floor(h / (rows + 6)), 2);

    // Filter out peaks too close to image edges (border artifacts)
    const edgeMarginX = Math.floor(w * 0.01);
    const edgeMarginY = Math.floor(h * 0.02);
    vPeaks = vPeaks.filter(x => x > edgeMarginX && x < w - edgeMarginX);
    hPeaks = hPeaks.filter(y => y > edgeMarginY && y < h - edgeMarginY);

    console.log(`[grid] Raw peaks: ${vPeaks.length} vertical, ${hPeaks.length} horizontal`);
    console.log(`[grid] vPeaks: ${vPeaks.join(",")}`);
    console.log(`[grid] hPeaks: ${hPeaks.join(",")}`);

    vPeaks = selectBestPeaks(vPeaks, cols + 1, w);
    hPeaks = selectBestPeaks(hPeaks, rows + 1, h);

    console.log(`[grid] After select: ${vPeaks.length} vertical, ${hPeaks.length} horizontal`);
    console.log(`[grid] vPeaks: ${vPeaks.join(",")}`);
    console.log(`[grid] hPeaks: ${hPeaks.join(",")}`);
    console.log(`[grid] hPeaks spacing: ${diff(hPeaks).join(",")}`);

    vPeaks = selectBestPeaks(vPeaks, cols + 1, w);
    hPeaks = selectBestPeaks(hPeaks, rows + 1, h);

    // Local refinement
    const vSpacing = vPeaks.length > 1 ? median(diff(vPeaks)) : 80;
    const hSpacing = hPeaks.length > 1 ? median(diff(hPeaks)) : 80;
    const vWindow = Math.max(8, Math.floor(vSpacing * 0.15));
    const hWindow = Math.max(8, Math.floor(hSpacing * 0.15));

    // v_lines[hi][vi] = refined x position
    const vLines = [];
    const hLines = [];

    for (let hi = 0; hi < hPeaks.length; hi++) {
        const yc = hPeaks[hi];
        const bandH = Math.max(5, Math.floor(hSpacing / 6));
        const y1 = Math.max(0, yc - bandH);
        const y2 = Math.min(h, yc + bandH);

        // Average this horizontal strip per column
        const strip = new Float32Array(w);
        for (let x = 0; x < w; x++) {
            let sum = 0,
                cnt = 0;
            for (let y = y1; y < y2; y++) {
                sum += gray[y * w + x];
                cnt++;
            }
            strip[x] = cnt > 0 ? sum / cnt : 0;
        }
        const sMax = Math.max(...strip);
        const stripInv = strip.map(v => sMax - v);

        const row = [];
        for (let vi = 0; vi < vPeaks.length; vi++) {
            const rx = vPeaks[vi];
            const x1 = Math.max(0, rx - vWindow);
            const x2 = Math.min(w, rx + vWindow);
            let bestX = rx,
                bestVal = -1;
            for (let x = x1; x < x2; x++) {
                if (stripInv[x] > bestVal) {
                    bestVal = stripInv[x];
                    bestX = x;
                }
            }
            row.push(bestVal > 2 ? bestX : rx);
        }
        vLines.push(row);
    }

    for (let vi = 0; vi < vPeaks.length; vi++) {
        const xc = vPeaks[vi];
        const bandW = Math.max(5, Math.floor(vSpacing / 6));
        const x1 = Math.max(0, xc - bandW);
        const x2 = Math.min(w, xc + bandW);

        const strip = new Float32Array(h);
        for (let y = 0; y < h; y++) {
            let sum = 0,
                cnt = 0;
            for (let x = x1; x < x2; x++) {
                sum += gray[y * w + x];
                cnt++;
            }
            strip[y] = cnt > 0 ? sum / cnt : 0;
        }
        const sMax = Math.max(...strip);
        const stripInv = strip.map(v => sMax - v);

        for (let hi = 0; hi < hPeaks.length; hi++) {
            if (!hLines[hi]) hLines[hi] = [];
            const ry = hPeaks[hi];
            const y1 = Math.max(0, ry - hWindow);
            const y2 = Math.min(h, ry + hWindow);
            let bestY = ry,
                bestVal = -1;
            for (let y = y1; y < y2; y++) {
                if (stripInv[y] > bestVal) {
                    bestVal = stripInv[y];
                    bestY = y;
                }
            }
            hLines[hi][vi] = bestVal > 2 ? bestY : ry;
        }
    }

    return { vLines, hLines };
}

// ---- Color Sampling ----

function getCellBounds(vLines, hLines, r, c) {
    // Clamp to valid grid indices
    const maxR = vLines.length - 2;
    const maxC = (vLines[0] ? vLines[0].length : 1) - 2;
    r = Math.max(0, Math.min(r, maxR));
    c = Math.max(0, Math.min(c, maxC));

    const xL = Math.round((vLines[r][c] + vLines[r + 1][c]) / 2);
    const xR = Math.round((vLines[r][c + 1] + vLines[r + 1][c + 1]) / 2);
    const yT = Math.round((hLines[r][c] + hLines[r][c + 1]) / 2);
    const yB = Math.round((hLines[r + 1][c] + hLines[r + 1][c + 1]) / 2);
    return {
        xL: Math.min(xL, xR),
        yT: Math.min(yT, yB),
        xR: Math.max(xL, xR),
        yB: Math.max(yT, yB)
    };
}

function sampleCellHSV(imageData, w, vLines, hLines, r, c) {
    const { xL, yT, xR, yB } = getCellBounds(vLines, hLines, r, c);
    const cw = xR - xL,
        ch = yB - yT;
    const mx = Math.floor(cw * 0.25),
        my = Math.floor(ch * 0.25);
    const x1 = xL + mx,
        y1 = yT + my,
        x2 = xR - mx,
        y2 = yB - my;

    let rSum = 0,
        gSum = 0,
        bSum = 0,
        cnt = 0;
    const d = imageData.data;
    for (let y = y1; y < y2; y++) {
        for (let x = x1; x < x2; x++) {
            const i = (y * w + x) * 4;
            rSum += d[i];
            gSum += d[i + 1];
            bSum += d[i + 2];
            cnt++;
        }
    }
    if (cnt === 0) return [0, 0, 0];
    return rgbToHsv(rSum / cnt, gSum / cnt, bSum / cnt);
}

function rgbToHsv(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b),
        min = Math.min(r, g, b);
    const d = max - min;
    let h = 0,
        s = max === 0 ? 0 : d / max,
        v = max;
    if (d !== 0) {
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        else if (max === g) h = ((b - r) / d + 2) / 6;
        else h = ((r - g) / d + 4) / 6;
    }
    // OpenCV scale: H 0-180, S 0-255, V 0-255
    return [h * 180, s * 255, v * 255];
}

// ---- K-Means ----

function kmeans4(data, maxIter) {
    // K-means with k=4, multiple restarts with k-means++ init
    const k = 4,
        n = data.length,
        restarts = 10;
    let bestLabels = null,
        bestCenters = null,
        bestCost = Infinity;

    for (let restart = 0; restart < restarts; restart++) {
        // K-means++ initialization
        const centers = [];
        centers.push([...data[Math.floor(Math.random() * n)]]);

        for (let ci = 1; ci < k; ci++) {
            const dists = new Float32Array(n);
            let totalDist = 0;
            for (let i = 0; i < n; i++) {
                let minD = Infinity;
                for (let j = 0; j < centers.length; j++) {
                    const d = dist3(data[i], centers[j]);
                    if (d < minD) minD = d;
                }
                dists[i] = minD * minD;
                totalDist += dists[i];
            }
            let r = Math.random() * totalDist;
            let picked = false;
            for (let i = 0; i < n; i++) {
                r -= dists[i];
                if (r <= 0) {
                    centers.push([...data[i]]);
                    picked = true;
                    break;
                }
            }
            if (!picked) centers.push([...data[Math.floor(Math.random() * n)]]);
        }

        // Run k-means iterations
        const labels = new Int32Array(n);
        for (let iter = 0; iter < (maxIter || 100); iter++) {
            for (let i = 0; i < n; i++) {
                let bestD = Infinity,
                    bestC = 0;
                for (let c = 0; c < k; c++) {
                    const d = dist3(data[i], centers[c]);
                    if (d < bestD) {
                        bestD = d;
                        bestC = c;
                    }
                }
                labels[i] = bestC;
            }
            const sums = Array.from({ length: k }, () => [0, 0, 0]);
            const counts = new Int32Array(k);
            for (let i = 0; i < n; i++) {
                const c = labels[i];
                sums[c][0] += data[i][0];
                sums[c][1] += data[i][1];
                sums[c][2] += data[i][2];
                counts[c]++;
            }
            let moved = false;
            for (let c = 0; c < k; c++) {
                if (counts[c] === 0) continue;
                const newC = [sums[c][0] / counts[c], sums[c][1] / counts[c], sums[c][2] / counts[c]];
                if (dist3(newC, centers[c]) > 0.01) moved = true;
                centers[c] = newC;
            }
            if (!moved) break;
        }

        // Compute total cost (sum of distances to assigned center)
        let cost = 0;
        for (let i = 0; i < n; i++) {
            cost += dist3(data[i], centers[labels[i]]);
        }
        if (cost < bestCost) {
            bestCost = cost;
            bestLabels = new Int32Array(labels);
            bestCenters = centers.map(c => [...c]);
        }
    }

    return { labels: bestLabels, centers: bestCenters };
}

function dist3(a, b) {
    return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

// ---- Cluster to Color ID Mapping ----

function assignClusterIds(centers, hsvRaw) {
    // centers[i] = weighted HSV center, hsvRaw[i] = unweighted HSV center
    // Gray = lowest saturation, then sort remaining by hue: orange < blue < pink
    const sats = hsvRaw.map(c => c[1]);
    const grayIdx = sats.indexOf(Math.min(...sats));
    const remaining = [0, 1, 2, 3].filter(i => i !== grayIdx);
    remaining.sort((a, b) => hsvRaw[a][0] - hsvRaw[b][0]);
    // lowest hue = orange, mid = blue, highest = pink
    const mapping = {};
    mapping[grayIdx] = 1;
    mapping[remaining[0]] = 3; // orange
    mapping[remaining[1]] = 4; // blue
    mapping[remaining[2]] = 2; // pink
    return mapping;
}

// ---- Classification with Confidence ----

function classifyAll(weighted, centers) {
    const n = weighted.length;
    const colorIds = new Int32Array(n);
    const confidences = new Float32Array(n);
    const secondBests = new Int32Array(n);

    for (let i = 0; i < n; i++) {
        const dists = centers.map(c => dist3(weighted[i], c));
        const order = [0, 1, 2, 3].sort((a, b) => dists[a] - dists[b]);
        colorIds[i] = order[0] + 1; // 1-indexed
        secondBests[i] = order[1] + 1;
        const d1 = dists[order[0]],
            d2 = dists[order[1]];
        confidences[i] = d2 > 0 ? (d2 - d1) / d2 : 0;
    }
    return { colorIds, confidences, secondBests };
}

function computeCenters(weighted, colorIds) {
    const centers = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0]
    ];
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < weighted.length; i++) {
        const c = colorIds[i] - 1;
        centers[c][0] += weighted[i][0];
        centers[c][1] += weighted[i][1];
        centers[c][2] += weighted[i][2];
        counts[c]++;
    }
    for (let c = 0; c < 4; c++) {
        if (counts[c] > 0) {
            centers[c][0] /= counts[c];
            centers[c][1] /= counts[c];
            centers[c][2] /= counts[c];
        }
    }
    return centers;
}

// ---- Full Parse Pipeline ----

function parseImage(imageData, w, h, cols, rows) {
    const gray = getGrayData(imageData, w, h);
    const { vLines, hLines } = findGridLines(gray, w, h, cols, rows);

    // Sample all cells in HSV
    const cellHSV = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            cellHSV.push(sampleCellHSV(imageData, w, vLines, hLines, r, c));
        }
    }

    // Weight for clustering
    const weighted = cellHSV.map(([h, s, v]) => [h * 2, s * 1, v * 0.3]);

    // K-means
    const km = kmeans4(weighted, 50);

    // Get raw HSV centers per cluster
    const rawCenters = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0]
    ];
    const rawCounts = [0, 0, 0, 0];
    for (let i = 0; i < cellHSV.length; i++) {
        const c = km.labels[i];
        rawCenters[c][0] += cellHSV[i][0];
        rawCenters[c][1] += cellHSV[i][1];
        rawCenters[c][2] += cellHSV[i][2];
        rawCounts[c]++;
    }
    for (let c = 0; c < 4; c++) {
        if (rawCounts[c] > 0) {
            rawCenters[c][0] /= rawCounts[c];
            rawCenters[c][1] /= rawCounts[c];
            rawCenters[c][2] /= rawCounts[c];
        }
    }

    const clusterMap = assignClusterIds(km.centers, rawCenters);

    // Map labels to color IDs
    const colorIds = new Int32Array(cellHSV.length);
    for (let i = 0; i < cellHSV.length; i++) {
        colorIds[i] = clusterMap[km.labels[i]];
    }

    // Compute centers and classify with confidence
    let centers = computeCenters(weighted, colorIds);
    const result = classifyAll(weighted, centers);

    return {
        vLines,
        hLines,
        cellHSV,
        weighted,
        colorIds: result.colorIds,
        confidences: result.confidences,
        secondBests: result.secondBests,
        centers
    };
}

// ---- Helpers ----

function diff(arr) {
    const d = [];
    for (let i = 1; i < arr.length; i++) d.push(arr[i] - arr[i - 1]);
    return d;
}

function median(arr) {
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
