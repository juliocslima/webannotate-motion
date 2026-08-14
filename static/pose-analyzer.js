const TASKS_VISION_VERSION = "1.0.1";
const TASKS_VISION_MODULE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/+esm`;
const WASM_ROOT = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`;
const POSE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

const MOTION_LANDMARKS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
let visionModulePromise = null;
let visionFilesetPromise = null;
let poseConnections = null;

async function getVisionModule() {
  if (!visionModulePromise) visionModulePromise = import(TASKS_VISION_MODULE);
  return visionModulePromise;
}

async function getVisionFileset() {
  if (!visionFilesetPromise) {
    visionFilesetPromise = (async () => {
      const { FilesetResolver } = await getVisionModule();
      return FilesetResolver.forVisionTasks(WASM_ROOT);
    })();
  }
  return visionFilesetPromise;
}

export async function createPoseLandmarker() {
  const [{ PoseLandmarker }, vision] = await Promise.all([getVisionModule(), getVisionFileset()]);
  poseConnections = PoseLandmarker.POSE_CONNECTIONS;
  const commonOptions = {
    baseOptions: { modelAssetPath: POSE_MODEL_URL },
    runningMode: "VIDEO",
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputSegmentationMasks: false,
  };

  try {
    return await PoseLandmarker.createFromOptions(vision, {
      ...commonOptions,
      baseOptions: { ...commonOptions.baseOptions, delegate: "GPU" },
    });
  } catch (_) {
    return PoseLandmarker.createFromOptions(vision, commonOptions);
  }
}

function visible(landmark) {
  const visibility = landmark?.visibility ?? 1;
  const presence = landmark?.presence ?? 1;
  return visibility >= 0.45 && presence >= 0.45;
}

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function bodyScale(landmarks) {
  const leftShoulder = landmarks[11];
  const rightShoulder = landmarks[12];
  const leftHip = landmarks[23];
  const rightHip = landmarks[24];
  if (![leftShoulder, rightShoulder, leftHip, rightHip].every(visible)) return 0.2;
  const shoulderMid = midpoint(leftShoulder, rightShoulder);
  const hipMid = midpoint(leftHip, rightHip);
  return Math.max(0.08, distance(shoulderMid, hipMid), distance(leftShoulder, rightShoulder));
}

export function poseFrameConfidence(landmarks) {
  if (!landmarks?.length) return 0;
  const values = MOTION_LANDMARKS
    .map((index) => landmarks[index])
    .filter(Boolean)
    .map((landmark) => Math.min(landmark.visibility ?? 1, landmark.presence ?? 1));
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function poseMotionScore(previous, current) {
  if (!previous?.length || !current?.length) return 0;
  const scale = Math.max(bodyScale(previous), bodyScale(current));
  const displacements = [];
  for (const index of MOTION_LANDMARKS) {
    const before = previous[index];
    const after = current[index];
    if (!visible(before) || !visible(after)) continue;
    displacements.push(distance(before, after) / scale);
  }
  if (displacements.length < 4) return 0;
  return displacements.reduce((sum, value) => sum + value, 0) / displacements.length;
}

export function getPoseConnections() {
  return poseConnections || [];
}

export function drawPoseOverlay(canvas, landmarks, connections = getPoseConnections()) {
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!landmarks?.length) return;

  context.save();
  context.lineWidth = Math.max(2, canvas.width / 320);
  context.strokeStyle = "rgba(77, 226, 176, 0.9)";
  context.fillStyle = "rgba(255, 255, 255, 0.95)";

  for (const connection of connections || []) {
    const startIndex = connection.start ?? connection[0];
    const endIndex = connection.end ?? connection[1];
    const a = landmarks[startIndex];
    const b = landmarks[endIndex];
    if (!visible(a) || !visible(b)) continue;
    context.beginPath();
    context.moveTo(a.x * canvas.width, a.y * canvas.height);
    context.lineTo(b.x * canvas.width, b.y * canvas.height);
    context.stroke();
  }

  for (const index of MOTION_LANDMARKS) {
    const landmark = landmarks[index];
    if (!visible(landmark)) continue;
    context.beginPath();
    context.arc(landmark.x * canvas.width, landmark.y * canvas.height, Math.max(2.5, canvas.width / 220), 0, Math.PI * 2);
    context.fill();
  }
  context.restore();
}

export const poseDependencyInfo = {
  tasksVisionVersion: TASKS_VISION_VERSION,
  modelUrl: POSE_MODEL_URL,
  videoLeavesBrowser: false,
};
