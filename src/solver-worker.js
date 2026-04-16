/* eslint-env worker */

importScripts("solver.js");

self.onmessage = (event) => {
    const data = event.data || {};

    try {
        const grid = new Int8Array(data.grid || []);
        const rows = data.rows;
        const cols = data.cols;
        const maxStates = data.maxStates;

        const result = solve(grid, rows, cols, maxStates, (explored, bestClear) => {
            self.postMessage({
                type: "progress",
                explored,
                bestClear,
            });
        });

        self.postMessage({
            type: "result",
            result: {
                ...result,
                states: result.states.map((s) => Array.from(s)),
            },
        });
    } catch (err) {
        self.postMessage({
            type: "error",
            message: err && err.message ? err.message : String(err),
        });
    }
};
