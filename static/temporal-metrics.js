export function mergeIntervals(intervals, duration = Infinity) {
  const normalized = intervals
    .map((item) => ({
      start: Math.max(0, Number(item.start_time ?? item.start ?? 0)),
      end: Math.min(duration, Number(item.end_time ?? item.end ?? 0)),
    }))
    .filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged = [];
  for (const interval of normalized) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end) {
      previous.end = Math.max(previous.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

export function intervalLength(intervals) {
  return intervals.reduce((sum, item) => sum + (item.end - item.start), 0);
}

export function intersectionLength(left, right) {
  let i = 0;
  let j = 0;
  let total = 0;
  while (i < left.length && j < right.length) {
    const start = Math.max(left[i].start, right[j].start);
    const end = Math.min(left[i].end, right[j].end);
    if (end > start) total += end - start;
    if (left[i].end < right[j].end) i += 1;
    else j += 1;
  }
  return total;
}

export function evaluateTemporal(referenceIntervals, predictedIntervals, duration) {
  const reference = mergeIntervals(referenceIntervals, duration);
  const predicted = mergeIntervals(predictedIntervals, duration);
  const referenceSeconds = intervalLength(reference);
  const predictedSeconds = intervalLength(predicted);

  if (referenceSeconds <= 0) {
    return {
      has_reference: false,
      reference_seconds: 0,
      predicted_seconds: Number(predictedSeconds.toFixed(4)),
      intersection_seconds: 0,
      temporal_iou: null,
      temporal_precision: null,
      temporal_recall: null,
      temporal_f1: null,
    };
  }

  const intersection = intersectionLength(reference, predicted);
  const union = referenceSeconds + predictedSeconds - intersection;
  const precision = predictedSeconds > 0 ? intersection / predictedSeconds : 0;
  const recall = intersection / referenceSeconds;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const iou = union > 0 ? intersection / union : 0;

  return {
    has_reference: true,
    reference_seconds: Number(referenceSeconds.toFixed(4)),
    predicted_seconds: Number(predictedSeconds.toFixed(4)),
    intersection_seconds: Number(intersection.toFixed(4)),
    temporal_iou: Number(iou.toFixed(4)),
    temporal_precision: Number(precision.toFixed(4)),
    temporal_recall: Number(recall.toFixed(4)),
    temporal_f1: Number(f1.toFixed(4)),
  };
}
