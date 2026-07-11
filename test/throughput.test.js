import assert from "node:assert/strict";
import test from "node:test";
import { combineThroughputSamples } from "../src/public/pool.js";
import { windowedThroughputMbps } from "../src/public/tunnel.js";

function constantRateReadings(mbps, totalMs, stepMs) {
  const bytesPerMs = (mbps * 1e6) / 8 / 1000;
  const readings = [];
  for (let tMs = 0; tMs <= totalMs; tMs += stepMs) {
    readings.push({ tMs, bytes: Math.round(bytesPerMs * tMs) });
  }
  return readings;
}

test("windowedThroughputMbps measures a constant-rate transfer", () => {
  const readings = constantRateReadings(25, 3000, 100);
  assert.equal(windowedThroughputMbps(readings), 25);
});

test("windowedThroughputMbps skips a slow-start warm-up period", () => {
  const readings = [];
  let bytes = 0;
  for (let tMs = 0; tMs <= 3000; tMs += 100) {
    const rateMbps = tMs < 500 ? 2 : 100;
    if (tMs > 0) {
      bytes += Math.round((rateMbps * 1e6) / 8 / 1000) * 100;
    }
    readings.push({ tMs, bytes });
  }
  const result = windowedThroughputMbps(readings);
  assert.equal(result, 100);
  assert.ok(result > 10, "warm-up slow section should not drag the rate down toward 2 Mbps");
});

test("windowedThroughputMbps falls back to the full range for a short transfer ending during warm-up", () => {
  const readings = [
    { tMs: 0, bytes: 0 },
    { tMs: 50, bytes: 100000 },
    { tMs: 100, bytes: 250000 },
  ];
  assert.equal(windowedThroughputMbps(readings), 20);
});

test("windowedThroughputMbps returns 0 for insufficient readings", () => {
  assert.equal(windowedThroughputMbps([]), 0);
  assert.equal(windowedThroughputMbps([{ tMs: 0, bytes: 0 }]), 0);
});

test("windowedThroughputMbps returns 0 when bytes never increase", () => {
  const readings = [
    { tMs: 0, bytes: 1000 },
    { tMs: 100, bytes: 1000 },
    { tMs: 200, bytes: 1000 },
    { tMs: 300, bytes: 1000 },
  ];
  assert.equal(windowedThroughputMbps(readings), 0);
});

test("windowedThroughputMbps honors custom warmupMs and measureMs", () => {
  // 50 Mbps for the first 1000ms, then 10 Mbps for the rest, 3000ms total.
  const readings = [];
  let bytes = 0;
  for (let tMs = 0; tMs <= 3000; tMs += 100) {
    const rateMbps = tMs < 1000 ? 50 : 10;
    if (tMs > 0) {
      bytes += Math.round((rateMbps * 1e6) / 8 / 1000) * 100;
    }
    readings.push({ tMs, bytes });
  }
  // Default warmup (400ms) lands inside the fast 50 Mbps section, so the
  // measurement window (2500ms) spans most of the slow section too, pulling
  // the rate down from a pure 50.
  const defaultResult = windowedThroughputMbps(readings);
  assert.notEqual(defaultResult, 50);

  // A custom warmupMs of 1000 skips straight to the slow section, and a
  // custom measureMs of 500 keeps the window entirely inside it.
  const customResult = windowedThroughputMbps(readings, { warmupMs: 1000, measureMs: 500 });
  assert.equal(customResult, 10);
});

test("combineThroughputSamples handles empty, single, and multiple samples", () => {
  assert.deepEqual(combineThroughputSamples([]), { throughputMbps: 0, consistency: 0 });
  assert.deepEqual(combineThroughputSamples([40]), { throughputMbps: 40, consistency: 1 });
  assert.deepEqual(combineThroughputSamples([40, 60]), {
    throughputMbps: 50,
    consistency: Math.round((40 / 60) * 100) / 100,
  });
});

test("combineThroughputSamples filters out non-finite and non-positive values", () => {
  assert.deepEqual(combineThroughputSamples([10, -5, 0, NaN, 30]), {
    throughputMbps: 20,
    consistency: Math.round((10 / 30) * 100) / 100,
  });
  assert.deepEqual(combineThroughputSamples([-1, 0, NaN, Infinity, -Infinity]), {
    throughputMbps: 0,
    consistency: 0,
  });
});
