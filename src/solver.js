/**
 * solver.js — Heuristic search solver for THM.
 * Prioritizes states that clear the most board while preserving future moves.
 * Board state is a flat Int8Array of height*width.
 */

function solverCreateState(grid2d, rows, cols) {
    const s = new Int8Array(rows * cols);
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) s[r * cols + c] = grid2d[r * cols + c];
    }
    return s;
}

function stateGet(s, r, c, cols) {
    return s[r * cols + c];
}

function stateSet(s, r, c, cols, v) {
    s[r * cols + c] = v;
}

function stateCleared(s) {
    let cleared = 0;
    for (let i = 0; i < s.length; i++) if (s[i] === 0) cleared++;
    return (cleared / s.length) * 100;
}

function stateEqual(a, b) {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

function stateClone(s) {
    return new Int8Array(s);
}

function stateKey(s) {
    // Pack 3 base-5 cells per character to reduce key size and Map overhead.
    const chars = new Array(Math.ceil(s.length / 3));
    let out = 0;
    for (let i = 0; i < s.length; i += 3) {
        const a = s[i] || 0;
        const b = s[i + 1] || 0;
        const c = s[i + 2] || 0;
        chars[out++] = String.fromCharCode(35 + a + b * 5 + c * 25);
    }
    return chars.join("");
}

function adjacent(state, ar, ac, rows, cols) {
    // BFS to find all cells connected to (ar,ac) with same value
    const val = stateGet(state, ar, ac, cols);
    const visited = new Uint8Array(rows * cols);
    const result = [];
    const queue = [[ar, ac]];
    visited[ar * cols + ac] = 1;

    let head = 0;
    while (head < queue.length) {
        const [r, c] = queue[head++];
        result.push([r, c]);

        if (r > 0) {
            const idx = (r - 1) * cols + c;
            if (!visited[idx] && stateGet(state, r - 1, c, cols) === val) {
                visited[idx] = 1;
                queue.push([r - 1, c]);
            }
        }
        if (r < rows - 1) {
            const idx = (r + 1) * cols + c;
            if (!visited[idx] && stateGet(state, r + 1, c, cols) === val) {
                visited[idx] = 1;
                queue.push([r + 1, c]);
            }
        }
        if (c > 0) {
            const idx = r * cols + (c - 1);
            if (!visited[idx] && stateGet(state, r, c - 1, cols) === val) {
                visited[idx] = 1;
                queue.push([r, c - 1]);
            }
        }
        if (c < cols - 1) {
            const idx = r * cols + (c + 1);
            if (!visited[idx] && stateGet(state, r, c + 1, cols) === val) {
                visited[idx] = 1;
                queue.push([r, c + 1]);
            }
        }
    }

    return result;
}

function clickable(state, rows, cols) {
    // Returns list of [r,c] actions (one per connected group of size > 1)
    return analyzeState(state, rows, cols, new Map(), null).actions.map((entry) => entry.action);
}

function clearable(state, rows, cols) {
    // Count of cells that are part of a group > 1
    return analyzeState(state, rows, cols, new Map(), null).clearableCount;
}

function click(state, ar, ac, rows, cols, groupOverride, scratch) {
    // Click on (ar,ac): clear the connected group, increment surrounding cells
    const newState = stateClone(state);
    const group = groupOverride || adjacent(state, ar, ac, rows, cols);

    if (group.length <= 1) return newState;

    const useFlatGroup = typeof group[0] === "number";

    if (scratch) {
        let mark = scratch.mark + 1;
        if (mark === 0xffffffff) {
            scratch.groupMark.fill(0);
            scratch.surroundMark.fill(0);
            mark = 1;
        }
        scratch.mark = mark;

        let surroundCount = 0;
        if (useFlatGroup) {
            for (let i = 0; i < group.length; i++) scratch.groupMark[group[i]] = mark;

            for (let i = 0; i < group.length; i++) {
                const idx = group[i];
                const r = Math.floor(idx / cols);
                const c = idx % cols;

                if (r > 0) {
                    const n = idx - cols;
                    if (scratch.groupMark[n] !== mark && scratch.surroundMark[n] !== mark) {
                        scratch.surroundMark[n] = mark;
                        scratch.surroundList[surroundCount++] = n;
                    }
                }
                if (r < rows - 1) {
                    const n = idx + cols;
                    if (scratch.groupMark[n] !== mark && scratch.surroundMark[n] !== mark) {
                        scratch.surroundMark[n] = mark;
                        scratch.surroundList[surroundCount++] = n;
                    }
                }
                if (c > 0) {
                    const n = idx - 1;
                    if (scratch.groupMark[n] !== mark && scratch.surroundMark[n] !== mark) {
                        scratch.surroundMark[n] = mark;
                        scratch.surroundList[surroundCount++] = n;
                    }
                }
                if (c < cols - 1) {
                    const n = idx + 1;
                    if (scratch.groupMark[n] !== mark && scratch.surroundMark[n] !== mark) {
                        scratch.surroundMark[n] = mark;
                        scratch.surroundList[surroundCount++] = n;
                    }
                }
            }

            for (let i = 0; i < surroundCount; i++) {
                const idx = scratch.surroundList[i];
                const v = newState[idx];
                if (v > 0) newState[idx] = v === 4 ? 1 : v + 1;
            }

            for (let i = 0; i < group.length; i++) newState[group[i]] = 0;
            return newState;
        }
    }

    if (useFlatGroup) {
        const groupMask = new Uint8Array(rows * cols);
        const surroundMask = new Uint8Array(rows * cols);
        const surroundList = [];

        for (let i = 0; i < group.length; i++) groupMask[group[i]] = 1;

        for (let i = 0; i < group.length; i++) {
            const idx = group[i];
            const r = Math.floor(idx / cols);
            const c = idx % cols;

            if (r > 0) {
                const n = idx - cols;
                if (!groupMask[n] && !surroundMask[n]) {
                    surroundMask[n] = 1;
                    surroundList.push(n);
                }
            }
            if (r < rows - 1) {
                const n = idx + cols;
                if (!groupMask[n] && !surroundMask[n]) {
                    surroundMask[n] = 1;
                    surroundList.push(n);
                }
            }
            if (c > 0) {
                const n = idx - 1;
                if (!groupMask[n] && !surroundMask[n]) {
                    surroundMask[n] = 1;
                    surroundList.push(n);
                }
            }
            if (c < cols - 1) {
                const n = idx + 1;
                if (!groupMask[n] && !surroundMask[n]) {
                    surroundMask[n] = 1;
                    surroundList.push(n);
                }
            }
        }

        for (let i = 0; i < surroundList.length; i++) {
            const idx = surroundList[i];
            const v = newState[idx];
            if (v > 0) newState[idx] = v === 4 ? 1 : v + 1;
        }

        for (let i = 0; i < group.length; i++) newState[group[i]] = 0;
        return newState;
    }

    const groupSet = new Set(group.map(([r, c]) => r * cols + c));
    const surroundSet = new Set();

    for (const [r, c] of group) {
        if (r > 0) {
            const idx = (r - 1) * cols + c;
            if (!groupSet.has(idx)) surroundSet.add(idx);
        }
        if (r < rows - 1) {
            const idx = (r + 1) * cols + c;
            if (!groupSet.has(idx)) surroundSet.add(idx);
        }
        if (c > 0) {
            const idx = r * cols + (c - 1);
            if (!groupSet.has(idx)) surroundSet.add(idx);
        }
        if (c < cols - 1) {
            const idx = r * cols + (c + 1);
            if (!groupSet.has(idx)) surroundSet.add(idx);
        }
    }

    for (const idx of surroundSet) {
        const v = newState[idx];
        if (v > 0) newState[idx] = v === 4 ? 1 : v + 1;
    }

    for (const [r, c] of group) stateSet(newState, r, c, cols, 0);
    return newState;
}

function analyzeState(state, rows, cols, cache, temp) {
    const key = stateKey(state);
    const cached = cache.get(key);
    if (cached) return cached;

    const totalCells = rows * cols;
    let visited;
    let visitMark;
    let queue;

    if (temp) {
        visitMark = ++temp.visitMark;
        if (visitMark === 0xffffffff) {
            temp.visited.fill(0);
            visitMark = 1;
        }
        temp.visitMark = visitMark;
        visited = temp.visited;
        queue = temp.queue;
    } else {
        visited = new Uint32Array(totalCells);
        visitMark = 1;
        queue = new Int32Array(totalCells);
    }

    const actions = [];
    let nonZeroCount = 0;
    let clearableCount = 0;
    let singletonCount = 0;
    let largestGroup = 0;

    for (let startIdx = 0; startIdx < totalCells; startIdx++) {
        if (visited[startIdx] === visitMark || state[startIdx] === 0) continue;

        const cellValue = state[startIdx];
        const groupIndices = [];
        let head = 0;
        let tail = 0;
        queue[tail++] = startIdx;
        visited[startIdx] = visitMark;

        while (head < tail) {
            const idx = queue[head++];
            const gr = Math.floor(idx / cols);
            const gc = idx % cols;
            groupIndices.push(idx);

            if (gr > 0) {
                const nextIdx = idx - cols;
                if (visited[nextIdx] !== visitMark && state[nextIdx] === cellValue) {
                    visited[nextIdx] = visitMark;
                    queue[tail++] = nextIdx;
                }
            }
            if (gr < rows - 1) {
                const nextIdx = idx + cols;
                if (visited[nextIdx] !== visitMark && state[nextIdx] === cellValue) {
                    visited[nextIdx] = visitMark;
                    queue[tail++] = nextIdx;
                }
            }
            if (gc > 0) {
                const nextIdx = idx - 1;
                if (visited[nextIdx] !== visitMark && state[nextIdx] === cellValue) {
                    visited[nextIdx] = visitMark;
                    queue[tail++] = nextIdx;
                }
            }
            if (gc < cols - 1) {
                const nextIdx = idx + 1;
                if (visited[nextIdx] !== visitMark && state[nextIdx] === cellValue) {
                    visited[nextIdx] = visitMark;
                    queue[tail++] = nextIdx;
                }
            }
        }

        const groupSize = groupIndices.length;
        nonZeroCount += groupSize;
        if (groupSize > largestGroup) largestGroup = groupSize;

        if (groupSize > 1) {
            clearableCount += groupSize;
            const actionIndex = groupIndices[0];
            actions.push({
                action: [Math.floor(actionIndex / cols), actionIndex % cols],
                actionIndex,
                groupIndices,
                groupSize,
            });
        } else {
            singletonCount += 1;
        }
    }

    const clearedCount = state.length - nonZeroCount;
    const analysis = {
        key,
        actions,
        actionCount: actions.length,
        clearableCount,
        clearedCount,
        clearRate: (clearedCount / state.length) * 100,
        largestGroup,
        nonZeroCount,
        singletonCount,
    };
    cache.set(key, analysis);
    return analysis;
}

function createSolveScratch(totalCells) {
    return {
        visited: new Uint32Array(totalCells),
        queue: new Int32Array(totalCells),
        visitMark: 0,
        groupMark: new Uint32Array(totalCells),
        surroundMark: new Uint32Array(totalCells),
        surroundList: new Int32Array(totalCells),
        mark: 0,
    };
}

function scoreAnalysis(analysis, depth) {
    // Match solver-old scoring: H + G where H = clearable + cleared, G = depth.
    return analysis.clearableCount + analysis.clearedCount + depth;
}

function compareAnalysisQuality(a, b) {
    if (a.clearedCount !== b.clearedCount) return a.clearedCount - b.clearedCount;
    if (a.clearableCount !== b.clearableCount) return a.clearableCount - b.clearableCount;
    if (a.singletonCount !== b.singletonCount) return b.singletonCount - a.singletonCount;
    if (a.largestGroup !== b.largestGroup) return a.largestGroup - b.largestGroup;
    if (a.nonZeroCount !== b.nonZeroCount) return b.nonZeroCount - a.nonZeroCount;
    return b.actionCount - a.actionCount;
}

function compareNodes(a, b) {
    // Keep ordering equivalent to solver-old's "pop max value" behavior.
    if (a.value !== b.value) return a.value - b.value;
    return 0;
}

function isBetterResultNode(candidate, bestNode) {
    if (!bestNode) return true;

    const qualityDiff = compareAnalysisQuality(candidate.analysis, bestNode.analysis);
    if (qualityDiff !== 0) return qualityDiff > 0;

    return candidate.depth < bestNode.depth;
}

function heapPush(heap, item) {
    heap.push(item);
    let idx = heap.length - 1;

    while (idx > 0) {
        const parentIdx = Math.floor((idx - 1) / 2);
        if (compareNodes(heap[idx], heap[parentIdx]) <= 0) break;
        [heap[idx], heap[parentIdx]] = [heap[parentIdx], heap[idx]];
        idx = parentIdx;
    }
}

function heapPop(heap) {
    if (heap.length === 0) return null;

    const top = heap[0];
    const tail = heap.pop();
    if (heap.length === 0) return top;

    heap[0] = tail;
    let idx = 0;

    while (true) {
        const left = idx * 2 + 1;
        const right = left + 1;
        let bestIdx = idx;

        if (left < heap.length && compareNodes(heap[left], heap[bestIdx]) > 0) bestIdx = left;
        if (right < heap.length && compareNodes(heap[right], heap[bestIdx]) > 0) bestIdx = right;
        if (bestIdx === idx) break;

        [heap[idx], heap[bestIdx]] = [heap[bestIdx], heap[idx]];
        idx = bestIdx;
    }

    return top;
}

function solve(initialGrid, rows, cols, maxStates, onProgress) {
    /**
     * Heuristic best-first solver. Returns { solution, states, explored, clearRate }
     * solution = array of [r,c] actions
     * states = array of flat Int8Array board states
     */
    const state0 = new Int8Array(initialGrid);
    const totalCells = rows * cols;
    const analysisCache = new Map();
    const frontier = [];
    const exploredKeys = new Set();
    const scratch = createSolveScratch(totalCells);

    const startAnalysis = analyzeState(state0, rows, cols, analysisCache, scratch);
    const startNode = {
        state: state0,
        depth: 0,
        parent: null,
        action: null,
        analysis: startAnalysis,
        value: scoreAnalysis(startAnalysis, 0),
    };

    heapPush(frontier, startNode);

    let numExplored = 0;
    let bestNode = startNode;

    while (frontier.length > 0 && numExplored < maxStates) {
        const node = heapPop(frontier);
        if (!node) break;

        if (exploredKeys.has(node.analysis.key)) continue;
        exploredKeys.add(node.analysis.key);

        if (isBetterResultNode(node, bestNode)) bestNode = node;
        if (node.analysis.clearedCount >= totalCells) {
            return buildResult(node, state0, numExplored);
        }

        for (const actionInfo of node.analysis.actions) {
            if (numExplored >= maxStates) break;

            const [ar, ac] = actionInfo.action;
            const childDepth = node.depth + 1;
            const newState = click(node.state, ar, ac, rows, cols, actionInfo.groupIndices, scratch);
            const childAnalysis = analyzeState(newState, rows, cols, analysisCache, scratch);

            if (exploredKeys.has(childAnalysis.key)) continue;
            numExplored++;

            const child = {
                state: newState,
                depth: childDepth,
                parent: node,
                action: [ar, ac],
                analysis: childAnalysis,
                value: scoreAnalysis(childAnalysis, childDepth),
            };

            if (isBetterResultNode(child, bestNode)) bestNode = child;
            heapPush(frontier, child);
        }

        if (numExplored % 1000 === 0 && onProgress) {
            onProgress(numExplored, bestNode.analysis.clearRate);
        }
    }

    if (onProgress) onProgress(numExplored, bestNode.analysis.clearRate);
    return buildResult(bestNode, state0, numExplored);
}

function buildResult(node, state0, exploredCount) {
    const actions = [];
    const states = [];
    let n = node;

    while (n.parent !== null) {
        actions.push(n.action);
        states.push(n.state);
        n = n.parent;
    }

    states.push(state0);
    actions.reverse();
    states.reverse();

    return {
        solution: actions,
        states,
        explored: exploredCount,
        clearRate: node.analysis.clearRate,
    };
}