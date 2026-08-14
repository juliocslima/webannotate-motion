import assert from "node:assert/strict";
import { evaluateTemporal } from "../static/temporal-metrics.js";

const metrics = evaluateTemporal(
  [{ start_time: 1, end_time: 3 }],
  [{ start_time: 2, end_time: 4 }],
  10,
);

assert.equal(metrics.has_reference, true);
assert.equal(metrics.reference_seconds, 2);
assert.equal(metrics.predicted_seconds, 2);
assert.equal(metrics.intersection_seconds, 1);
assert.equal(metrics.temporal_precision, 0.5);
assert.equal(metrics.temporal_recall, 0.5);
assert.equal(metrics.temporal_f1, 0.5);
assert.equal(metrics.temporal_iou, 0.3333);

const noReference = evaluateTemporal([], [{ start_time: 1, end_time: 2 }], 10);
assert.equal(noReference.has_reference, false);
assert.equal(noReference.temporal_f1, null);

console.log("temporal metrics: ok");
