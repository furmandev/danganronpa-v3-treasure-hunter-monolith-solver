/**
 * solver.js — A* solver for THM, ported from THM.py
 * All numpy operations replaced with plain JS arrays.
 * Board state is a flat Int8Array of height*width.
 */

function solverCreateState(grid2d, rows, cols) {
    const s = new Int8Array(rows * cols);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) s[r * cols + c] = grid2d[r * cols + c];
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
    // Fast hash for explored set
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s[i]) | 0;
    return h;
}

function adjacent(state, ar, ac, rows, cols) {
    // BFS to find all cells connected to (ar,ac) with same value
    const val = stateGet(state, ar, ac, cols);
    const visited = new Uint8Array(rows * cols);
    const result = [];
    const queue = [[ar, ac]];
    visited[ar * cols + ac] = 1;

    while (queue.length > 0) {
        const [r, c] = queue.shift();
        result.push([r, c]);
        const neighbors = [];
        if (r > 0) neighbors.push([r - 1, c]);
        if (r < rows - 1) neighbors.push([r + 1, c]);
        if (c > 0) neighbors.push([r, c - 1]);
        if (c < cols - 1) neighbors.push([r, c + 1]);
        for (const [nr, nc] of neighbors) {
            const idx = nr * cols + nc;
            if (!visited[idx] && stateGet(state, nr, nc, cols) === val) {
                visited[idx] = 1;
                queue.push([nr, nc]);
            }
        }
    }
    return result;
}

function clickable(state, rows, cols) {
    // Returns list of [r,c] actions (one per connected group of size > 1)
    const visited = new Uint8Array(rows * cols);
    const actions = [];

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const idx = r * cols + c;
            if (visited[idx] || stateGet(state, r, c, cols) === 0) continue;
            const group = adjacent(state, r, c, rows, cols);
            for (const [gr, gc] of group) visited[gr * cols + gc] = 1;
            if (group.length > 1) actions.push(group[0]);
        }
    }
    return actions;
}

function clearable(state, rows, cols) {
    // Count of cells that are part of a group > 1
    const visited = new Uint8Array(rows * cols);
    let count = 0;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const idx = r * cols + c;
            if (visited[idx] || stateGet(state, r, c, cols) === 0) continue;
            const group = adjacent(state, r, c, rows, cols);
            for (const [gr, gc] of group) visited[gr * cols + gc] = 1;
            if (group.length > 1) count += group.length;
        }
    }
    return count;
}

function click(state, ar, ac, rows, cols) {
    // Click on (ar,ac): clear the connected group, increment surrounding cells
    const newState = stateClone(state);
    const val = stateGet(state, ar, ac, cols);
    const group = adjacent(state, ar, ac, rows, cols);

    if (group.length <= 1) return newState; // no-op

    // Find surrounding cells (neighbors of group not in group)
    const groupSet = new Set(group.map(([r, c]) => r * cols + c));
    const surroundSet = new Set();

    for (const [r, c] of group) {
        const neighbors = [];
        if (r > 0) neighbors.push([r - 1, c]);
        if (r < rows - 1) neighbors.push([r + 1, c]);
        if (c > 0) neighbors.push([r, c - 1]);
        if (c < cols - 1) neighbors.push([r, c + 1]);
        for (const [nr, nc] of neighbors) {
            const idx = nr * cols + nc;
            if (!groupSet.has(idx)) surroundSet.add(idx);
        }
    }

    // Increment surrounding (wrap 4 -> 1, skip 0)
    for (const idx of surroundSet) {
        const v = newState[idx];
        if (v > 0) {
            newState[idx] = v === 4 ? 1 : v + 1;
        }
    }

    // Clear group
    for (const [r, c] of group) {
        stateSet(newState, r, c, cols, 0);
    }

    return newState;
}

function solve(initialGrid, rows, cols, maxStates, onProgress) {
    /**
     * A* solver. Returns { solution, states, explored, clearRate }
     * solution = array of [r,c] actions
     * states = array of flat Int8Array board states
     */
    const state0 = new Int8Array(initialGrid);
    const totalCells = rows * cols;

    // Priority queue (simple array, pop highest value)
    const frontier = [];
    const exploredKeys = new Set();

    const startCleared = stateCleared(state0);
    frontier.push({
        state: state0,
        depth: 0,
        parent: null,
        action: null,
        cleared: startCleared,
        value: 0
    });

    let numExplored = 0;
    let bestClear = 0,
        bestNode = null;

    while (frontier.length > 0 && numExplored < maxStates) {
        // Pop highest value node
        let bestIdx = 0;
        for (let i = 1; i < frontier.length; i++) {
            if (frontier[i].value > frontier[bestIdx].value) bestIdx = i;
        }
        const node = frontier.splice(bestIdx, 1)[0];

        // Check if target reached
        if (node.cleared >= 100) {
            return buildResult(node, state0);
        }

        exploredKeys.add(stateKey(node.state));

        const actions = clickable(node.state, rows, cols);
        for (const [ar, ac] of actions) {
            const newState = click(node.state, ar, ac, rows, cols);
            const key = stateKey(newState);

            if (!exploredKeys.has(key)) {
                const cl = stateCleared(newState);
                const H = clearable(newState, rows, cols) + (totalCells - countNonZero(newState));
                const G = node.depth;
                const child = {
                    state: newState,
                    depth: node.depth + 1,
                    parent: node,
                    action: [ar, ac],
                    cleared: cl,
                    value: H + G
                };
                frontier.push(child);
                numExplored++;

                if (cl > bestClear || (cl === bestClear && bestNode && child.depth < bestNode.depth)) {
                    bestClear = cl;
                    bestNode = child;
                }

                if (numExplored % 1000 === 0 && onProgress) {
                    onProgress(numExplored, bestClear);
                }
            }
        }
    }

    // Return best found
    if (!bestNode) {
        return { solution: [], states: [state0], explored: numExplored, clearRate: startCleared };
    }
    return buildResult(bestNode, state0);
}

function buildResult(node, state0) {
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
        states: states,
        explored: 0,
        clearRate: node.cleared
    };
}

function countNonZero(s) {
    let c = 0;
    for (let i = 0; i < s.length; i++) if (s[i] !== 0) c++;
    return c;
}
