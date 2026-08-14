"use strict";

const state = {
  projectId: null,
  annotations: [],
  duration: 0,
  videoUrl: null,
  analysisRunning: false,
  editingAnnotationId: null,
  lastMetrics: null,
  poseSamples: [],
  poseModule: null,
};

const elements = {
  projectName: document.querySelector("#projectName"),
  projectDescription: document.querySelector("#projectDescription"),
  saveStatus: document.querySelector("#saveStatus"),
  videoFile: document.querySelector("#videoFile"),
  videoName: document.querySelector("#videoName"),
  video: document.querySelector("#video"),
  poseOverlay: document.querySelector("#poseOverlay"),
  analysisCanvas: document.querySelector("#analysisCanvas"),
  currentTime: document.querySelector("#currentTime"),
  duration: document.querySelector("#duration"),
  newProjectButton: document.querySelector("#newProjectButton"),
  loadSampleButton: document.querySelector("#loadSampleButton"),
  exportJsonButton: document.querySelector("#exportJsonButton"),
  exportCsvButton: document.querySelector("#exportCsvButton"),
  labelInput: document.querySelector("#labelInput"),
  startTimeInput: document.querySelector("#startTimeInput"),
  endTimeInput: document.querySelector("#endTimeInput"),
  markStartButton: document.querySelector("#markStartButton"),
  markEndButton: document.querySelector("#markEndButton"),
  addAnnotationButton: document.querySelector("#addAnnotationButton"),
  cancelEditButton: document.querySelector("#cancelEditButton"),
  annotationFormTitle: document.querySelector("#annotationFormTitle"),
  timeline: document.querySelector("#timeline"),
  timelineEmpty: document.querySelector("#timelineEmpty"),
  playhead: document.querySelector("#playhead"),
  annotationCount: document.querySelector("#annotationCount"),
  annotationTableBody: document.querySelector("#annotationTableBody"),
  analyzerMethodInput: document.querySelector("#analyzerMethodInput"),
  analysisDescription: document.querySelector("#analysisDescription"),
  poseDependencyNote: document.querySelector("#poseDependencyNote"),
  showPoseOverlayInput: document.querySelector("#showPoseOverlayInput"),
  thresholdModeInput: document.querySelector("#thresholdModeInput"),
  thresholdInput: document.querySelector("#thresholdInput"),
  thresholdValue: document.querySelector("#thresholdValue"),
  manualThresholdLabel: document.querySelector("#manualThresholdLabel"),
  sampleIntervalInput: document.querySelector("#sampleIntervalInput"),
  analyzeButton: document.querySelector("#analyzeButton"),
  removeSuggestionsButton: document.querySelector("#removeSuggestionsButton"),
  analysisProgress: document.querySelector("#analysisProgress"),
  analysisProgressBar: document.querySelector("#analysisProgressBar"),
  analysisProgressText: document.querySelector("#analysisProgressText"),
  analysisSummary: document.querySelector("#analysisSummary"),
  statusFilter: document.querySelector("#statusFilter"),
  metricCoverage: document.querySelector("#metricCoverage"),
  metricAnnotatedSeconds: document.querySelector("#metricAnnotatedSeconds"),
  metricPending: document.querySelector("#metricPending"),
  metricAcceptance: document.querySelector("#metricAcceptance"),
  metricConfidence: document.querySelector("#metricConfidence"),
  metricTemporalF1: document.querySelector("#metricTemporalF1"),
  metricTemporalIoU: document.querySelector("#metricTemporalIoU"),
  toast: document.querySelector("#toast"),
};

let toastTimer = null;
let temporalMetricsModulePromise = null;
let poseModulePromise = null;

function getTemporalMetricsModule() {
  if (!temporalMetricsModulePromise) temporalMetricsModulePromise = import("/static/temporal-metrics.js");
  return temporalMetricsModulePromise;
}

async function getPoseModule() {
  if (!poseModulePromise) poseModulePromise = import("/static/pose-analyzer.js");
  state.poseModule = await poseModulePromise;
  return state.poseModule;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "00:00.000";
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60);
  const millis = Math.floor((safe % 1) * 1000);
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function formatPercent(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  return `${Number(value).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;
}

function setStatus(text, className = "") {
  elements.saveStatus.textContent = text;
  elements.saveStatus.className = `status ${className}`.trim();
}

function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast visible${isError ? " error" : ""}`;
  toastTimer = setTimeout(() => {
    elements.toast.className = "toast";
  }, 3200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!response.ok) {
    let message = `Erro ${response.status}`;
    try {
      const body = await response.json();
      message = body.detail || message;
    } catch (_) {
      // Keep fallback message.
    }
    throw new Error(message);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function ensureProject() {
  if (state.projectId) return state.projectId;
  setStatus("Salvando…", "saving");
  const payload = {
    name: elements.projectName.value.trim() || "Projeto sem título",
    description: elements.projectDescription.value.trim(),
    video_name: elements.videoName.dataset.filename || "",
    duration: state.duration,
  };
  const project = await api("/api/projects", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  state.projectId = project.id;
  state.annotations = project.annotations || [];
  setStatus(`Projeto #${project.id} salvo`, "saved");
  updateEnabledState();
  await refreshMetrics();
  return state.projectId;
}

async function saveProjectMetadata() {
  if (!state.projectId) return;
  setStatus("Salvando…", "saving");
  try {
    await api(`/api/projects/${state.projectId}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: elements.projectName.value.trim() || "Projeto sem título",
        description: elements.projectDescription.value.trim(),
        video_name: elements.videoName.dataset.filename || "",
        duration: state.duration,
      }),
    });
    setStatus(`Projeto #${state.projectId} salvo`, "saved");
  } catch (error) {
    setStatus("Falha ao salvar");
    showToast(error.message, true);
  }
}

let saveTimer = null;
function scheduleMetadataSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      if (!state.projectId && (elements.projectName.value.trim() || state.duration > 0)) {
        await ensureProject();
      } else {
        await saveProjectMetadata();
      }
    } catch (error) {
      showToast(error.message, true);
    }
  }, 450);
}

function updateEnabledState() {
  const videoReady = state.duration > 0 && Number.isFinite(state.duration);
  elements.addAnnotationButton.disabled = !videoReady || state.analysisRunning;
  elements.analyzeButton.disabled = !videoReady || state.analysisRunning;
  elements.exportJsonButton.disabled = !state.projectId;
  elements.exportCsvButton.disabled = !state.projectId;
  elements.removeSuggestionsButton.disabled = !state.annotations.some(
    (item) => item.status === "suggested" && ["motion-suggestion", "pose-suggestion", "model"].includes(item.source),
  ) || state.analysisRunning;
}

function clearPoseOverlay() {
  const context = elements.poseOverlay.getContext("2d");
  context.clearRect(0, 0, elements.poseOverlay.width, elements.poseOverlay.height);
}

function resetPoseState() {
  state.poseSamples = [];
  clearPoseOverlay();
}

function loadVideoUrl(url, name) {
  if (state.videoUrl && state.videoUrl.startsWith("blob:")) URL.revokeObjectURL(state.videoUrl);
  resetPoseState();
  state.videoUrl = url;
  elements.video.src = url;
  elements.videoName.textContent = name;
  elements.videoName.dataset.filename = name;
  elements.video.load();
}

function clearMetrics() {
  elements.metricCoverage.textContent = "0%";
  elements.metricAnnotatedSeconds.textContent = "0,0 s anotados";
  elements.metricPending.textContent = "0";
  elements.metricAcceptance.textContent = "—";
  elements.metricConfidence.textContent = "—";
  elements.metricTemporalF1.textContent = "—";
  elements.metricTemporalIoU.textContent = "—";
}

async function resetProject() {
  if (state.projectId && state.annotations.length > 0) {
    const proceed = window.confirm("Criar um novo projeto? As anotações atuais permanecem salvas no servidor.");
    if (!proceed) return;
  }
  if (state.videoUrl && state.videoUrl.startsWith("blob:")) URL.revokeObjectURL(state.videoUrl);
  state.projectId = null;
  state.annotations = [];
  state.duration = 0;
  state.videoUrl = null;
  state.lastMetrics = null;
  resetPoseState();
  cancelEdit();
  elements.projectName.value = "Demonstração de atividades humanas";
  elements.projectDescription.value = "";
  elements.video.removeAttribute("src");
  elements.video.load();
  elements.videoName.textContent = "Nenhum vídeo carregado";
  elements.videoName.dataset.filename = "";
  elements.currentTime.textContent = formatTime(0);
  elements.duration.textContent = formatTime(0);
  elements.startTimeInput.value = "0";
  elements.endTimeInput.value = "1";
  elements.analysisSummary.hidden = true;
  setStatus("Não salvo");
  clearMetrics();
  renderAnnotations();
  updateEnabledState();
}

async function addAnnotation(payload) {
  const projectId = await ensureProject();
  const created = await api(`/api/projects/${projectId}/annotations`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  state.annotations.push(created);
  sortAnnotations();
  renderAnnotations();
  await refreshMetrics();
  return created;
}

async function updateAnnotation(id, payload) {
  const updated = await api(`/api/annotations/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  state.annotations = state.annotations.map((item) => (item.id === id ? updated : item));
  sortAnnotations();
  renderAnnotations();
  await refreshMetrics();
  return updated;
}

function sortAnnotations() {
  state.annotations.sort((a, b) => a.start_time - b.start_time || a.end_time - b.end_time);
}

async function handleAnnotationSubmit() {
  const label = elements.labelInput.value.trim();
  const startTime = Number(elements.startTimeInput.value);
  const endTime = Number(elements.endTimeInput.value);
  if (!label) return showToast("Informe um rótulo.", true);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
    return showToast("O fim deve ser maior que o início.", true);
  }
  if (endTime > state.duration + 0.05) return showToast("O segmento ultrapassa a duração do vídeo.", true);

  try {
    if (state.editingAnnotationId) {
      await updateAnnotation(state.editingAnnotationId, {
        label,
        start_time: startTime,
        end_time: endTime,
      });
      showToast("Segmento atualizado.");
      cancelEdit();
    } else {
      await addAnnotation({
        label,
        start_time: startTime,
        end_time: endTime,
        source: "manual",
        confidence: null,
        notes: "",
        status: "accepted",
      });
      elements.startTimeInput.value = endTime.toFixed(3);
      elements.endTimeInput.value = Math.min(state.duration, endTime + 1).toFixed(3);
      showToast("Segmento manual adicionado.");
    }
  } catch (error) {
    showToast(error.message, true);
  }
}

function beginEdit(annotation) {
  state.editingAnnotationId = annotation.id;
  elements.annotationFormTitle.textContent = `Editar segmento #${annotation.id}`;
  elements.addAnnotationButton.textContent = "Atualizar segmento";
  elements.cancelEditButton.hidden = false;
  elements.labelInput.value = annotation.label;
  elements.startTimeInput.value = Number(annotation.start_time).toFixed(3);
  elements.endTimeInput.value = Number(annotation.end_time).toFixed(3);
  seekTo(annotation.start_time);
  elements.labelInput.focus();
}

function cancelEdit() {
  state.editingAnnotationId = null;
  elements.annotationFormTitle.textContent = "Criar segmento";
  elements.addAnnotationButton.textContent = "Adicionar segmento";
  elements.cancelEditButton.hidden = true;
}

async function deleteAnnotation(id) {
  try {
    await api(`/api/annotations/${id}`, { method: "DELETE" });
    state.annotations = state.annotations.filter((item) => item.id !== id);
    if (state.editingAnnotationId === id) cancelEdit();
    renderAnnotations();
    await refreshMetrics();
    showToast("Anotação removida.");
  } catch (error) {
    showToast(error.message, true);
  }
}

async function reviewSuggestion(annotation, status) {
  try {
    await updateAnnotation(annotation.id, { status });
    const label = status === "accepted" ? "Sugestão aceita." : "Sugestão rejeitada.";
    showToast(label);
  } catch (error) {
    showToast(error.message, true);
  }
}

function seekTo(seconds) {
  if (!state.duration) return;
  elements.video.currentTime = Math.min(Math.max(0, seconds), state.duration);
}

function visibleAnnotations() {
  const filter = elements.statusFilter.value;
  if (filter === "all") return state.annotations;
  return state.annotations.filter((item) => item.status === filter);
}

function renderTimeline() {
  elements.timeline.querySelectorAll(".timeline-segment").forEach((node) => node.remove());
  const active = state.annotations.filter((item) => item.status !== "rejected");
  elements.timelineEmpty.hidden = active.length > 0;
  const lanes = [];
  for (const annotation of active) {
    let lane = lanes.findIndex((lastEnd) => lastEnd <= annotation.start_time);
    if (lane === -1) {
      lane = lanes.length;
      lanes.push(annotation.end_time);
    } else {
      lanes[lane] = annotation.end_time;
    }
    const segment = document.createElement("button");
    const pending = annotation.status === "suggested";
    const pose = annotation.source === "pose-suggestion";
    segment.className = `timeline-segment${pending ? " suggestion" : ""}${pose ? " pose" : ""}`;
    segment.style.left = `${(annotation.start_time / state.duration) * 100}%`;
    segment.style.width = `${Math.max(((annotation.end_time - annotation.start_time) / state.duration) * 100, 0.7)}%`;
    segment.style.top = `${10 + lane * 34}px`;
    segment.title = `${annotation.label}: ${formatTime(annotation.start_time)}–${formatTime(annotation.end_time)} · ${statusLabel(annotation.status)}`;
    segment.textContent = annotation.label;
    segment.addEventListener("click", () => seekTo(annotation.start_time));
    elements.timeline.appendChild(segment);
  }
  elements.timeline.style.minHeight = `${Math.max(116, 20 + Math.max(lanes.length, 1) * 34)}px`;
}

function sourceLabel(source) {
  if (source === "motion-suggestion") return "movimento";
  if (source === "pose-suggestion") return "pose";
  if (source === "model") return "modelo";
  return "manual";
}

function statusLabel(status) {
  if (status === "suggested") return "pendente";
  if (status === "rejected") return "rejeitada";
  return "aceita";
}

function confidenceLabel(value) {
  if (value === null || value === undefined) return "—";
  return `${Math.round(Number(value) * 100)}%`;
}

function renderTable() {
  const annotations = visibleAnnotations();
  if (annotations.length === 0) {
    elements.annotationTableBody.innerHTML = '<tr><td colspan="8" class="empty-cell">Nenhuma anotação neste filtro.</td></tr>';
    return;
  }
  elements.annotationTableBody.innerHTML = "";
  for (const annotation of annotations) {
    const row = document.createElement("tr");
    if (annotation.status === "rejected") row.classList.add("rejected-row");
    row.innerHTML = `
      <td><strong>${escapeHtml(annotation.label)}</strong></td>
      <td>${formatTime(annotation.start_time)}</td>
      <td>${formatTime(annotation.end_time)}</td>
      <td>${(annotation.end_time - annotation.start_time).toFixed(3)} s</td>
      <td><span class="source-badge ${escapeHtml(annotation.source)}">${sourceLabel(annotation.source)}</span></td>
      <td><span class="status-badge ${escapeHtml(annotation.status)}">${statusLabel(annotation.status)}</span></td>
      <td>${confidenceLabel(annotation.confidence)}</td>
      <td><div class="row-actions"></div></td>
    `;
    const actions = row.querySelector(".row-actions");

    const seekButton = document.createElement("button");
    seekButton.className = "icon-button";
    seekButton.textContent = "Ir";
    seekButton.addEventListener("click", () => seekTo(annotation.start_time));
    actions.appendChild(seekButton);

    const editButton = document.createElement("button");
    editButton.className = "icon-button";
    editButton.textContent = "Editar";
    editButton.addEventListener("click", () => beginEdit(annotation));
    actions.appendChild(editButton);

    if (annotation.status === "suggested") {
      const acceptButton = document.createElement("button");
      acceptButton.className = "icon-button success";
      acceptButton.textContent = "Aceitar";
      acceptButton.addEventListener("click", () => reviewSuggestion(annotation, "accepted"));
      const rejectButton = document.createElement("button");
      rejectButton.className = "icon-button warning";
      rejectButton.textContent = "Rejeitar";
      rejectButton.addEventListener("click", () => reviewSuggestion(annotation, "rejected"));
      actions.append(acceptButton, rejectButton);
    }

    const deleteButton = document.createElement("button");
    deleteButton.className = "icon-button danger";
    deleteButton.textContent = "Excluir";
    deleteButton.addEventListener("click", () => deleteAnnotation(annotation.id));
    actions.appendChild(deleteButton);
    elements.annotationTableBody.appendChild(row);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderAnnotations() {
  const active = state.annotations.filter((item) => item.status !== "rejected");
  elements.annotationCount.textContent = `${active.length} ${active.length === 1 ? "segmento ativo" : "segmentos ativos"}`;
  renderTimeline();
  renderTable();
  updateEnabledState();
}

async function refreshMetrics() {
  if (!state.projectId) return clearMetrics();
  try {
    const metrics = await api(`/api/projects/${state.projectId}/metrics`);
    state.lastMetrics = metrics;
    elements.metricCoverage.textContent = formatPercent(metrics.coverage_percent);
    elements.metricAnnotatedSeconds.textContent = `${Number(metrics.annotated_seconds).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} s anotados`;
    elements.metricPending.textContent = String(metrics.suggestions_pending);
    elements.metricAcceptance.textContent = formatPercent(metrics.suggestion_acceptance_rate);
    elements.metricConfidence.textContent = metrics.average_suggestion_confidence === null
      ? "—"
      : formatPercent(metrics.average_suggestion_confidence * 100);
    const evaluation = metrics.last_evaluation;
    elements.metricTemporalF1.textContent = evaluation?.temporal_f1 === null || evaluation?.temporal_f1 === undefined
      ? "—"
      : formatPercent(evaluation.temporal_f1 * 100);
    elements.metricTemporalIoU.textContent = evaluation?.temporal_iou === null || evaluation?.temporal_iou === undefined
      ? "—"
      : formatPercent(evaluation.temporal_iou * 100);
  } catch (error) {
    showToast(`Métricas: ${error.message}`, true);
  }
}

function waitForSeek(video) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Tempo esgotado ao posicionar o vídeo."));
    }, 5000);
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Não foi possível ler o vídeo."));
    };
    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

function frameDifference(previous, current) {
  if (!previous) return 0;
  let total = 0;
  for (let i = 0; i < current.length; i += 4) {
    const previousGray = (previous[i] + previous[i + 1] + previous[i + 2]) / 3;
    const currentGray = (current[i] + current[i + 1] + current[i + 2]) / 3;
    total += Math.abs(currentGray - previousGray);
  }
  return total / (current.length / 4);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function robustAdaptiveThreshold(samples, floor) {
  const scores = samples.slice(1).map((sample) => sample.score).filter(Number.isFinite);
  if (!scores.length) return floor;
  const med = median(scores);
  const deviations = scores.map((score) => Math.abs(score - med));
  const mad = median(deviations);
  const sorted = [...scores].sort((a, b) => a - b);
  const p70 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.70))];
  return Math.max(floor, med + 2.5 * mad, p70);
}

function adaptiveThreshold(samples) {
  return robustAdaptiveThreshold(samples, 0.2);
}

function adaptivePoseThreshold(samples) {
  return robustAdaptiveThreshold(samples, 0.012);
}

function buildMotionSegments(samples, threshold, interval, duration) {
  const raw = [];
  let activeStart = null;
  const scoresAbove = samples.filter((sample) => sample.score >= threshold).map((sample) => sample.score);
  const normalizer = Math.max(threshold * 2, ...scoresAbove, threshold + 1);

  for (const sample of samples) {
    const active = sample.score >= threshold;
    if (active && activeStart === null) activeStart = Math.max(0, sample.time - interval);
    if (!active && activeStart !== null) {
      raw.push({ start: activeStart, end: sample.time });
      activeStart = null;
    }
  }
  if (activeStart !== null) raw.push({ start: activeStart, end: duration });

  const merged = [];
  for (const segment of raw) {
    if (segment.end - segment.start < interval * 0.8) continue;
    const previous = merged.at(-1);
    if (previous && segment.start - previous.end <= interval * 1.5) {
      previous.end = segment.end;
    } else {
      merged.push({ ...segment });
    }
  }

  return merged.map((segment) => {
    const relevant = samples.filter((sample) => sample.time >= segment.start && sample.time <= segment.end);
    const meanScore = relevant.reduce((sum, sample) => sum + sample.score, 0) / Math.max(relevant.length, 1);
    return {
      label: "movimento",
      start_time: Number(segment.start.toFixed(3)),
      end_time: Number(Math.min(segment.end, duration).toFixed(3)),
      source: "motion-suggestion",
      status: "suggested",
      confidence: Number(Math.min(1, meanScore / normalizer).toFixed(3)),
      notes: `Variação média de quadros: ${meanScore.toFixed(2)}; limiar: ${threshold.toFixed(2)}`,
    };
  });
}


function buildPoseSegments(samples, threshold, interval, duration) {
  const raw = [];
  let activeStart = null;
  const activeScores = samples.filter((sample) => sample.score >= threshold).map((sample) => sample.score);
  const normalizer = Math.max(threshold * 2.5, ...activeScores, threshold + 0.02);

  for (const sample of samples) {
    const active = Boolean(sample.landmarks?.length) && sample.score >= threshold;
    if (active && activeStart === null) activeStart = Math.max(0, sample.time - interval);
    if (!active && activeStart !== null) {
      raw.push({ start: activeStart, end: sample.time });
      activeStart = null;
    }
  }
  if (activeStart !== null) raw.push({ start: activeStart, end: duration });

  const merged = [];
  for (const segment of raw) {
    if (segment.end - segment.start < interval * 0.8) continue;
    const previous = merged.at(-1);
    if (previous && segment.start - previous.end <= interval * 1.5) previous.end = segment.end;
    else merged.push({ ...segment });
  }

  return merged.map((segment) => {
    const relevant = samples.filter((sample) => sample.time >= segment.start && sample.time <= segment.end && sample.landmarks?.length);
    const meanScore = relevant.reduce((sum, sample) => sum + sample.score, 0) / Math.max(relevant.length, 1);
    const meanPoseConfidence = relevant.reduce((sum, sample) => sum + (sample.poseConfidence || 0), 0) / Math.max(relevant.length, 1);
    const activityStrength = Math.min(1, meanScore / normalizer);
    const confidence = Math.min(1, 0.65 * meanPoseConfidence + 0.35 * activityStrength);
    return {
      label: "movimento_corporal",
      start_time: Number(segment.start.toFixed(3)),
      end_time: Number(Math.min(segment.end, duration).toFixed(3)),
      source: "pose-suggestion",
      status: "suggested",
      confidence: Number(confidence.toFixed(3)),
      notes: `Deslocamento corporal normalizado: ${meanScore.toFixed(4)}; limiar: ${threshold.toFixed(4)}; confiança de pose: ${(meanPoseConfidence * 100).toFixed(1)}%`,
    };
  });
}

async function evaluateSuggestions(suggestions) {
  const { evaluateTemporal } = await getTemporalMetricsModule();
  const reference = state.annotations.filter((item) => item.source === "manual" && item.status === "accepted");
  return evaluateTemporal(reference, suggestions, state.duration);
}

function evaluationSummary(evaluation) {
  if (!evaluation.has_reference) return "sem referência manual para avaliação temporal";
  return `F1 ${formatPercent(evaluation.temporal_f1 * 100)} · IoU ${formatPercent(evaluation.temporal_iou * 100)} · P ${formatPercent(evaluation.temporal_precision * 100)} · R ${formatPercent(evaluation.temporal_recall * 100)}`;
}

function nearestPoseSample(time) {
  if (!state.poseSamples.length) return null;
  let best = state.poseSamples[0];
  let bestDistance = Math.abs(best.time - time);
  for (const sample of state.poseSamples) {
    const currentDistance = Math.abs(sample.time - time);
    if (currentDistance < bestDistance) {
      best = sample;
      bestDistance = currentDistance;
    }
  }
  return best;
}

function renderPoseForCurrentTime() {
  if (!elements.showPoseOverlayInput.checked || !state.poseModule || !state.poseSamples.length) {
    clearPoseOverlay();
    return;
  }
  const sample = nearestPoseSample(elements.video.currentTime);
  if (sample?.landmarks?.length) state.poseModule.drawPoseOverlay(elements.poseOverlay, sample.landmarks);
  else clearPoseOverlay();
}

async function analyzeMotion() {
  if (state.analysisRunning || !state.duration) return;
  state.analysisRunning = true;
  updateEnabledState();
  elements.analysisProgress.hidden = false;
  elements.analysisSummary.hidden = true;
  elements.analysisProgressBar.style.width = "0%";
  elements.analysisProgressText.textContent = "Preparando análise…";

  const video = elements.video;
  const canvas = elements.analysisCanvas;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const interval = Number(elements.sampleIntervalInput.value);
  const thresholdMode = elements.thresholdModeInput.value;
  const originalTime = video.currentTime;
  const wasPaused = video.paused;
  const startedAt = performance.now();
  video.pause();

  try {
    await ensureProject();
    const samples = [];
    let previousFrame = null;
    const totalSteps = Math.max(1, Math.floor(state.duration / interval) + 1);

    for (let step = 0; step < totalSteps; step += 1) {
      const time = Math.min(state.duration - 0.001, step * interval);
      if (time < 0) break;
      if (Math.abs(video.currentTime - time) > 0.002) {
        video.currentTime = time;
        await waitForSeek(video);
      } else {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const frame = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const copiedFrame = new Uint8ClampedArray(frame);
      const score = frameDifference(previousFrame, copiedFrame);
      samples.push({ time, score });
      previousFrame = copiedFrame;
      const progress = ((step + 1) / totalSteps) * 100;
      elements.analysisProgressBar.style.width = `${progress}%`;
      elements.analysisProgressText.textContent = `Analisando ${step + 1} de ${totalSteps} quadros…`;
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }

    const threshold = thresholdMode === "adaptive" ? adaptiveThreshold(samples) : Number(elements.thresholdInput.value);
    const suggestions = buildMotionSegments(samples, threshold, interval, state.duration);
    const evaluation = await evaluateSuggestions(suggestions);
    const analysisMs = performance.now() - startedAt;

    let created = [];
    if (suggestions.length > 0) {
      created = await api(`/api/projects/${state.projectId}/annotations/bulk`, {
        method: "POST",
        body: JSON.stringify({ annotations: suggestions }),
      });
      state.annotations.push(...created);
      sortAnnotations();
    }

    await api(`/api/projects/${state.projectId}/analysis-runs`, {
      method: "POST",
      body: JSON.stringify({
        method: "frame-difference",
        threshold_mode: thresholdMode,
        threshold: Number(threshold.toFixed(4)),
        sample_interval: interval,
        sample_count: samples.length,
        suggestion_count: created.length,
        detected_frames: 0,
        mean_detection_confidence: null,
        temporal_iou: evaluation.temporal_iou,
        temporal_precision: evaluation.temporal_precision,
        temporal_recall: evaluation.temporal_recall,
        temporal_f1: evaluation.temporal_f1,
        reference_seconds: evaluation.reference_seconds,
        predicted_seconds: evaluation.predicted_seconds,
        analysis_ms: Number(analysisMs.toFixed(2)),
      }),
    });

    renderAnnotations();
    await refreshMetrics();
    elements.analysisSummary.hidden = false;
    elements.analysisSummary.innerHTML = `
      <strong>Análise concluída:</strong>
      ${created.length} ${created.length === 1 ? "sugestão" : "sugestões"} ·
      limiar ${threshold.toFixed(2)} (${thresholdMode === "adaptive" ? "adaptativo" : "manual"}) ·
      ${samples.length} quadros amostrados · ${(analysisMs / 1000).toFixed(2)} s ·
      ${evaluationSummary(evaluation)}.
    `;
    if (created.length === 0) {
      showToast("Nenhum intervalo de movimento foi sugerido para este limiar.");
    } else {
      showToast(`${created.length} sugestões adicionadas para revisão humana.`);
    }
  } catch (error) {
    showToast(error.message, true);
  } finally {
    video.currentTime = Math.min(originalTime, state.duration || 0);
    if (!wasPaused) video.play().catch(() => {});
    state.analysisRunning = false;
    elements.analysisProgressText.textContent = "Análise concluída.";
    setTimeout(() => { elements.analysisProgress.hidden = true; }, 900);
    updateEnabledState();
  }
}


async function analyzePose() {
  if (state.analysisRunning || !state.duration) return;
  state.analysisRunning = true;
  updateEnabledState();
  elements.analysisProgress.hidden = false;
  elements.analysisSummary.hidden = true;
  elements.analysisProgressBar.style.width = "0%";
  elements.analysisProgressText.textContent = "Carregando MediaPipe Pose Landmarker…";

  const video = elements.video;
  const interval = Number(elements.sampleIntervalInput.value);
  const thresholdMode = elements.thresholdModeInput.value;
  const originalTime = video.currentTime;
  const wasPaused = video.paused;
  const startedAt = performance.now();
  let poseLandmarker = null;
  video.pause();

  try {
    await ensureProject();
    const poseModule = await getPoseModule();
    poseLandmarker = await poseModule.createPoseLandmarker();
    const samples = [];
    let previousLandmarks = null;
    const totalSteps = Math.max(1, Math.floor(state.duration / interval) + 1);

    for (let step = 0; step < totalSteps; step += 1) {
      const time = Math.min(state.duration - 0.001, step * interval);
      if (time < 0) break;
      if (Math.abs(video.currentTime - time) > 0.002) {
        video.currentTime = time;
        await waitForSeek(video);
      } else {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }

      const result = poseLandmarker.detectForVideo(video, Math.round(time * 1000));
      const landmarks = result.landmarks?.[0] || null;
      const poseConfidence = landmarks ? poseModule.poseFrameConfidence(landmarks) : 0;
      const score = landmarks && previousLandmarks ? poseModule.poseMotionScore(previousLandmarks, landmarks) : 0;
      samples.push({ time, score, poseConfidence, landmarks });
      previousLandmarks = landmarks || null;

      if (elements.showPoseOverlayInput.checked && landmarks) poseModule.drawPoseOverlay(elements.poseOverlay, landmarks);
      else if (!landmarks) clearPoseOverlay();

      const progress = ((step + 1) / totalSteps) * 100;
      elements.analysisProgressBar.style.width = `${progress}%`;
      elements.analysisProgressText.textContent = `Estimando pose ${step + 1} de ${totalSteps} quadros…`;
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }

    const threshold = thresholdMode === "adaptive" ? adaptivePoseThreshold(samples) : Number(elements.thresholdInput.value);
    const suggestions = buildPoseSegments(samples, threshold, interval, state.duration);
    const evaluation = await evaluateSuggestions(suggestions);
    const detected = samples.filter((sample) => sample.landmarks?.length);
    const meanDetectionConfidence = detected.length
      ? detected.reduce((sum, sample) => sum + sample.poseConfidence, 0) / detected.length
      : null;
    const analysisMs = performance.now() - startedAt;

    let created = [];
    if (suggestions.length > 0) {
      created = await api(`/api/projects/${state.projectId}/annotations/bulk`, {
        method: "POST",
        body: JSON.stringify({ annotations: suggestions }),
      });
      state.annotations.push(...created);
      sortAnnotations();
    }

    await api(`/api/projects/${state.projectId}/analysis-runs`, {
      method: "POST",
      body: JSON.stringify({
        method: "pose",
        threshold_mode: thresholdMode,
        threshold: Number(threshold.toFixed(6)),
        sample_interval: interval,
        sample_count: samples.length,
        suggestion_count: created.length,
        detected_frames: detected.length,
        mean_detection_confidence: meanDetectionConfidence === null ? null : Number(meanDetectionConfidence.toFixed(4)),
        temporal_iou: evaluation.temporal_iou,
        temporal_precision: evaluation.temporal_precision,
        temporal_recall: evaluation.temporal_recall,
        temporal_f1: evaluation.temporal_f1,
        reference_seconds: evaluation.reference_seconds,
        predicted_seconds: evaluation.predicted_seconds,
        analysis_ms: Number(analysisMs.toFixed(2)),
      }),
    });

    state.poseSamples = detected;
    renderAnnotations();
    await refreshMetrics();
    elements.analysisSummary.hidden = false;
    elements.analysisSummary.innerHTML = `
      <strong>Análise por pose concluída:</strong>
      ${created.length} ${created.length === 1 ? "sugestão" : "sugestões"} ·
      ${detected.length}/${samples.length} quadros com pose ·
      confiança média ${meanDetectionConfidence === null ? "—" : formatPercent(meanDetectionConfidence * 100)} ·
      limiar ${threshold.toFixed(4)} (${thresholdMode === "adaptive" ? "adaptativo" : "manual"}) ·
      ${(analysisMs / 1000).toFixed(2)} s · ${evaluationSummary(evaluation)}.
    `;
    renderPoseForCurrentTime();
    showToast(created.length ? `${created.length} sugestões por pose adicionadas para revisão.` : "Nenhum intervalo corporal foi sugerido.");
  } catch (error) {
    showToast(`Pose: ${error.message}`, true);
  } finally {
    try { poseLandmarker?.close?.(); } catch (_) { /* no-op */ }
    video.currentTime = Math.min(originalTime, state.duration || 0);
    if (!wasPaused) video.play().catch(() => {});
    state.analysisRunning = false;
    elements.analysisProgressText.textContent = "Análise concluída.";
    setTimeout(() => { elements.analysisProgress.hidden = true; }, 900);
    updateEnabledState();
  }
}

async function analyzeSelectedMethod() {
  if (elements.analyzerMethodInput.value === "pose") return analyzePose();
  resetPoseState();
  return analyzeMotion();
}

async function removePendingSuggestions() {
  const suggestions = state.annotations.filter(
    (item) => item.status === "suggested" && ["motion-suggestion", "pose-suggestion", "model"].includes(item.source),
  );
  if (suggestions.length === 0) return;
  const proceed = window.confirm(`Remover ${suggestions.length} sugestões ainda não revisadas?`);
  if (!proceed) return;
  try {
    await Promise.all(suggestions.map((item) => api(`/api/annotations/${item.id}`, { method: "DELETE" })));
    const ids = new Set(suggestions.map((item) => item.id));
    state.annotations = state.annotations.filter((item) => !ids.has(item.id));
    renderAnnotations();
    await refreshMetrics();
    showToast("Sugestões pendentes removidas.");
  } catch (error) {
    showToast(error.message, true);
  }
}

function exportProject(format) {
  if (!state.projectId) return;
  window.location.href = `/api/projects/${state.projectId}/export?format=${format}`;
}

function toggleThresholdMode() {
  const isManual = elements.thresholdModeInput.value === "manual";
  elements.thresholdInput.disabled = !isManual;
  elements.manualThresholdLabel.classList.toggle("is-disabled", !isManual);
}

function configureAnalyzer() {
  const pose = elements.analyzerMethodInput.value === "pose";
  if (pose) {
    elements.thresholdInput.min = "0.005";
    elements.thresholdInput.max = "0.25";
    elements.thresholdInput.step = "0.005";
    elements.thresholdInput.value = "0.04";
    elements.thresholdValue.textContent = "0,040";
    elements.analyzeButton.textContent = "Analisar pose";
    elements.analysisDescription.textContent = "O analisador de pose estima landmarks corporais no navegador e mede o deslocamento das principais articulações normalizado pela escala do corpo.";
    elements.poseDependencyNote.hidden = false;
    elements.showPoseOverlayInput.closest("label").hidden = false;
  } else {
    elements.thresholdInput.min = "0.2";
    elements.thresholdInput.max = "20";
    elements.thresholdInput.step = "0.1";
    elements.thresholdInput.value = "0.5";
    elements.thresholdValue.textContent = "0,5";
    elements.analyzeButton.textContent = "Analisar movimento";
    elements.analysisDescription.textContent = "O baseline compara quadros reduzidos no navegador e usa a variação visual para sugerir intervalos de movimento.";
    elements.poseDependencyNote.hidden = true;
    elements.showPoseOverlayInput.closest("label").hidden = true;
    clearPoseOverlay();
  }
  toggleThresholdMode();
}

elements.videoFile.addEventListener("change", (event) => {
  const [file] = event.target.files;
  if (!file) return;
  loadVideoUrl(URL.createObjectURL(file), file.name);
});

elements.loadSampleButton.addEventListener("click", () => {
  loadVideoUrl("/samples/motion_demo.mp4", "motion_demo.mp4");
});

elements.video.addEventListener("loadedmetadata", async () => {
  state.duration = elements.video.duration;
  elements.poseOverlay.width = elements.video.videoWidth || 640;
  elements.poseOverlay.height = elements.video.videoHeight || 360;
  elements.duration.textContent = formatTime(state.duration);
  elements.endTimeInput.value = Math.min(1, state.duration).toFixed(3);
  updateEnabledState();
  try {
    await ensureProject();
    await saveProjectMetadata();
  } catch (error) {
    showToast(error.message, true);
  }
});

elements.video.addEventListener("timeupdate", () => {
  elements.currentTime.textContent = formatTime(elements.video.currentTime);
  const percentage = state.duration ? (elements.video.currentTime / state.duration) * 100 : 0;
  elements.playhead.style.left = `${percentage}%`;
  renderPoseForCurrentTime();
});

elements.video.addEventListener("error", () => showToast("O navegador não conseguiu abrir este vídeo.", true));

elements.projectName.addEventListener("input", scheduleMetadataSave);
elements.projectDescription.addEventListener("input", scheduleMetadataSave);
elements.newProjectButton.addEventListener("click", resetProject);
elements.markStartButton.addEventListener("click", () => { elements.startTimeInput.value = elements.video.currentTime.toFixed(3); });
elements.markEndButton.addEventListener("click", () => { elements.endTimeInput.value = elements.video.currentTime.toFixed(3); });
elements.addAnnotationButton.addEventListener("click", handleAnnotationSubmit);
elements.cancelEditButton.addEventListener("click", cancelEdit);
elements.thresholdInput.addEventListener("input", () => { elements.thresholdValue.textContent = elements.thresholdInput.value.replace(".", ","); });
elements.thresholdModeInput.addEventListener("change", toggleThresholdMode);
elements.analyzerMethodInput.addEventListener("change", configureAnalyzer);
elements.showPoseOverlayInput.addEventListener("change", renderPoseForCurrentTime);
elements.analyzeButton.addEventListener("click", analyzeSelectedMethod);
elements.removeSuggestionsButton.addEventListener("click", removePendingSuggestions);
elements.exportJsonButton.addEventListener("click", () => exportProject("json"));
elements.exportCsvButton.addEventListener("click", () => exportProject("csv"));
elements.statusFilter.addEventListener("change", renderTable);

document.addEventListener("keydown", (event) => {
  const tag = document.activeElement?.tagName;
  if (["INPUT", "SELECT", "TEXTAREA"].includes(tag)) return;
  if (event.code === "Space") {
    event.preventDefault();
    if (elements.video.paused) elements.video.play().catch(() => {});
    else elements.video.pause();
  } else if (event.key.toLowerCase() === "i") {
    elements.startTimeInput.value = elements.video.currentTime.toFixed(3);
    showToast("Início marcado.");
  } else if (event.key.toLowerCase() === "o") {
    elements.endTimeInput.value = elements.video.currentTime.toFixed(3);
    showToast("Fim marcado.");
  }
});

configureAnalyzer();
renderAnnotations();
clearMetrics();
updateEnabledState();
