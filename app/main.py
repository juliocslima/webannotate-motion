from __future__ import annotations

import csv
import io
import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Literal

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, model_validator

BASE_DIR = Path(__file__).resolve().parent.parent
DB_PATH = BASE_DIR / "data" / "webannotate.db"
STATIC_DIR = BASE_DIR / "static"
SAMPLES_DIR = BASE_DIR / "samples"

app = FastAPI(
    title="WebAnnotate-Motion+ API",
    version="0.3.0",
    description=(
        "API for privacy-preserving, human-in-the-loop temporal video annotation with "
        "frame-difference and browser-side pose analysis. Video bytes remain in the browser; "
        "the server stores only metadata, annotations, review decisions and analysis-run metadata."
    ),
)


@contextmanager
def db() -> Iterator[sqlite3.Connection]:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        yield connection
        connection.commit()
    finally:
        connection.close()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ensure_column(connection: sqlite3.Connection, table: str, column: str, ddl: str) -> None:
    columns = {row["name"] for row in connection.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in columns:
        connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")


def init_db() -> None:
    with db() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                video_name TEXT NOT NULL DEFAULT '',
                duration REAL NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS annotations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL,
                label TEXT NOT NULL,
                start_time REAL NOT NULL,
                end_time REAL NOT NULL,
                source TEXT NOT NULL DEFAULT 'manual',
                confidence REAL,
                notes TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'accepted',
                reviewed_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS analysis_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL,
                method TEXT NOT NULL,
                threshold_mode TEXT NOT NULL DEFAULT 'manual',
                threshold REAL,
                sample_interval REAL NOT NULL,
                sample_count INTEGER NOT NULL DEFAULT 0,
                suggestion_count INTEGER NOT NULL DEFAULT 0,
                detected_frames INTEGER NOT NULL DEFAULT 0,
                mean_detection_confidence REAL,
                temporal_iou REAL,
                temporal_precision REAL,
                temporal_recall REAL,
                temporal_f1 REAL,
                reference_seconds REAL NOT NULL DEFAULT 0,
                predicted_seconds REAL NOT NULL DEFAULT 0,
                analysis_ms REAL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
            );
            """
        )
        # Forward-compatible migration for databases created by v0.1.0.
        _ensure_column(connection, "annotations", "status", "TEXT NOT NULL DEFAULT 'accepted'")
        _ensure_column(connection, "annotations", "reviewed_at", "TEXT")
        # v0.3.0 adds scientific evaluation metadata without invalidating v0.2 databases.
        _ensure_column(connection, "analysis_runs", "detected_frames", "INTEGER NOT NULL DEFAULT 0")
        _ensure_column(connection, "analysis_runs", "mean_detection_confidence", "REAL")
        _ensure_column(connection, "analysis_runs", "temporal_iou", "REAL")
        _ensure_column(connection, "analysis_runs", "temporal_precision", "REAL")
        _ensure_column(connection, "analysis_runs", "temporal_recall", "REAL")
        _ensure_column(connection, "analysis_runs", "temporal_f1", "REAL")
        _ensure_column(connection, "analysis_runs", "reference_seconds", "REAL NOT NULL DEFAULT 0")
        _ensure_column(connection, "analysis_runs", "predicted_seconds", "REAL NOT NULL DEFAULT 0")


AnnotationSource = Literal["manual", "motion-suggestion", "pose-suggestion", "model"]
AnnotationStatus = Literal["suggested", "accepted", "rejected"]
ThresholdMode = Literal["manual", "adaptive"]


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=1000)
    video_name: str = Field(default="", max_length=255)
    duration: float = Field(default=0, ge=0)


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=1000)
    video_name: str | None = Field(default=None, max_length=255)
    duration: float | None = Field(default=None, ge=0)


class AnnotationCreate(BaseModel):
    label: str = Field(min_length=1, max_length=80)
    start_time: float = Field(ge=0)
    end_time: float = Field(gt=0)
    source: AnnotationSource = "manual"
    confidence: float | None = Field(default=None, ge=0, le=1)
    notes: str = Field(default="", max_length=500)
    status: AnnotationStatus | None = None

    @model_validator(mode="after")
    def validate_interval(self) -> "AnnotationCreate":
        if self.end_time <= self.start_time:
            raise ValueError("end_time must be greater than start_time")
        if self.status is None:
            self.status = "suggested" if self.source in {"motion-suggestion", "pose-suggestion", "model"} else "accepted"
        return self


class AnnotationUpdate(BaseModel):
    label: str | None = Field(default=None, min_length=1, max_length=80)
    start_time: float | None = Field(default=None, ge=0)
    end_time: float | None = Field(default=None, gt=0)
    source: AnnotationSource | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)
    notes: str | None = Field(default=None, max_length=500)
    status: AnnotationStatus | None = None


class BulkAnnotations(BaseModel):
    annotations: list[AnnotationCreate] = Field(max_length=1000)


class AnalysisRunCreate(BaseModel):
    method: Literal["frame-difference", "pose", "model"] = "frame-difference"
    threshold_mode: ThresholdMode = "manual"
    threshold: float | None = Field(default=None, ge=0)
    sample_interval: float = Field(gt=0, le=10)
    sample_count: int = Field(default=0, ge=0)
    suggestion_count: int = Field(default=0, ge=0)
    detected_frames: int = Field(default=0, ge=0)
    mean_detection_confidence: float | None = Field(default=None, ge=0, le=1)
    temporal_iou: float | None = Field(default=None, ge=0, le=1)
    temporal_precision: float | None = Field(default=None, ge=0, le=1)
    temporal_recall: float | None = Field(default=None, ge=0, le=1)
    temporal_f1: float | None = Field(default=None, ge=0, le=1)
    reference_seconds: float = Field(default=0, ge=0)
    predicted_seconds: float = Field(default=0, ge=0)
    analysis_ms: float | None = Field(default=None, ge=0)


def annotation_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "project_id": row["project_id"],
        "label": row["label"],
        "start_time": row["start_time"],
        "end_time": row["end_time"],
        "source": row["source"],
        "confidence": row["confidence"],
        "notes": row["notes"],
        "status": row["status"],
        "reviewed_at": row["reviewed_at"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def analysis_run_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "project_id": row["project_id"],
        "method": row["method"],
        "threshold_mode": row["threshold_mode"],
        "threshold": row["threshold"],
        "sample_interval": row["sample_interval"],
        "sample_count": row["sample_count"],
        "suggestion_count": row["suggestion_count"],
        "detected_frames": row["detected_frames"],
        "mean_detection_confidence": row["mean_detection_confidence"],
        "temporal_iou": row["temporal_iou"],
        "temporal_precision": row["temporal_precision"],
        "temporal_recall": row["temporal_recall"],
        "temporal_f1": row["temporal_f1"],
        "reference_seconds": row["reference_seconds"],
        "predicted_seconds": row["predicted_seconds"],
        "analysis_ms": row["analysis_ms"],
        "created_at": row["created_at"],
    }


def project_to_dict(connection: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
    annotations = connection.execute(
        "SELECT * FROM annotations WHERE project_id = ? ORDER BY start_time, end_time",
        (row["id"],),
    ).fetchall()
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "video_name": row["video_name"],
        "duration": row["duration"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "annotations": [annotation_to_dict(item) for item in annotations],
    }


def compute_metrics(connection: sqlite3.Connection, project_id: int) -> dict[str, Any]:
    project = connection.execute("SELECT duration FROM projects WHERE id = ?", (project_id,)).fetchone()
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    annotations = connection.execute(
        "SELECT * FROM annotations WHERE project_id = ? ORDER BY start_time",
        (project_id,),
    ).fetchall()
    runs = connection.execute(
        "SELECT * FROM analysis_runs WHERE project_id = ? ORDER BY created_at DESC",
        (project_id,),
    ).fetchall()

    active = [row for row in annotations if row["status"] != "rejected"]
    suggestions = [row for row in annotations if row["source"] in {"motion-suggestion", "pose-suggestion", "model"}]
    reviewed_suggestions = [row for row in suggestions if row["status"] in {"accepted", "rejected"}]
    accepted_suggestions = [row for row in suggestions if row["status"] == "accepted"]
    pending_suggestions = [row for row in suggestions if row["status"] == "suggested"]
    confidences = [float(row["confidence"]) for row in suggestions if row["confidence"] is not None]

    # Temporal coverage is computed as the union of non-rejected annotation intervals.
    intervals = sorted((float(row["start_time"]), float(row["end_time"])) for row in active)
    union_seconds = 0.0
    if intervals:
        current_start, current_end = intervals[0]
        for start, end in intervals[1:]:
            if start <= current_end:
                current_end = max(current_end, end)
            else:
                union_seconds += current_end - current_start
                current_start, current_end = start, end
        union_seconds += current_end - current_start

    duration = float(project["duration"] or 0)
    coverage_pct = (union_seconds / duration * 100) if duration > 0 else 0.0
    acceptance_rate = (
        len(accepted_suggestions) / len(reviewed_suggestions) * 100 if reviewed_suggestions else None
    )

    last_evaluated_run = next((row for row in runs if row["temporal_f1"] is not None), None)

    return {
        "total_annotations": len(annotations),
        "active_annotations": len(active),
        "manual_annotations": sum(1 for row in annotations if row["source"] == "manual"),
        "motion_suggestions": sum(1 for row in annotations if row["source"] == "motion-suggestion"),
        "pose_suggestions": sum(1 for row in annotations if row["source"] == "pose-suggestion"),
        "suggestions_total": len(suggestions),
        "suggestions_pending": len(pending_suggestions),
        "suggestions_accepted": len(accepted_suggestions),
        "suggestions_rejected": sum(1 for row in suggestions if row["status"] == "rejected"),
        "suggestion_acceptance_rate": round(acceptance_rate, 2) if acceptance_rate is not None else None,
        "average_suggestion_confidence": round(sum(confidences) / len(confidences), 4) if confidences else None,
        "annotated_seconds": round(union_seconds, 3),
        "coverage_percent": round(min(coverage_pct, 100.0), 2),
        "analysis_runs": len(runs),
        "last_analysis": analysis_run_to_dict(runs[0]) if runs else None,
        "last_evaluation": analysis_run_to_dict(last_evaluated_run) if last_evaluated_run else None,
    }


init_db()


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "version": app.version}


@app.get("/api/projects")
def list_projects() -> list[dict[str, Any]]:
    with db() as connection:
        rows = connection.execute("SELECT * FROM projects ORDER BY updated_at DESC").fetchall()
        return [project_to_dict(connection, row) for row in rows]


@app.post("/api/projects", status_code=201)
def create_project(payload: ProjectCreate) -> dict[str, Any]:
    now = utc_now()
    with db() as connection:
        cursor = connection.execute(
            """
            INSERT INTO projects(name, description, video_name, duration, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (payload.name, payload.description, payload.video_name, payload.duration, now, now),
        )
        row = connection.execute("SELECT * FROM projects WHERE id = ?", (cursor.lastrowid,)).fetchone()
        assert row is not None
        return project_to_dict(connection, row)


@app.get("/api/projects/{project_id}")
def get_project(project_id: int) -> dict[str, Any]:
    with db() as connection:
        row = connection.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Project not found")
        return project_to_dict(connection, row)


@app.patch("/api/projects/{project_id}")
def update_project(project_id: int, payload: ProjectUpdate) -> dict[str, Any]:
    values = payload.model_dump(exclude_none=True)
    if not values:
        return get_project(project_id)
    values["updated_at"] = utc_now()
    assignments = ", ".join(f"{key} = ?" for key in values)
    with db() as connection:
        exists = connection.execute("SELECT id FROM projects WHERE id = ?", (project_id,)).fetchone()
        if exists is None:
            raise HTTPException(status_code=404, detail="Project not found")
        connection.execute(
            f"UPDATE projects SET {assignments} WHERE id = ?",
            (*values.values(), project_id),
        )
        row = connection.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        assert row is not None
        return project_to_dict(connection, row)


@app.delete("/api/projects/{project_id}", status_code=204)
def delete_project(project_id: int) -> Response:
    with db() as connection:
        cursor = connection.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Project not found")
    return Response(status_code=204)


@app.post("/api/projects/{project_id}/annotations", status_code=201)
def create_annotation(project_id: int, payload: AnnotationCreate) -> dict[str, Any]:
    now = utc_now()
    with db() as connection:
        project = connection.execute("SELECT duration FROM projects WHERE id = ?", (project_id,)).fetchone()
        if project is None:
            raise HTTPException(status_code=404, detail="Project not found")
        if project["duration"] and payload.end_time > project["duration"] + 0.05:
            raise HTTPException(status_code=422, detail="Annotation exceeds video duration")
        reviewed_at = now if payload.status in {"accepted", "rejected"} and payload.source != "manual" else None
        cursor = connection.execute(
            """
            INSERT INTO annotations(
                project_id, label, start_time, end_time, source, confidence, notes,
                status, reviewed_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                project_id,
                payload.label,
                payload.start_time,
                payload.end_time,
                payload.source,
                payload.confidence,
                payload.notes,
                payload.status,
                reviewed_at,
                now,
                now,
            ),
        )
        connection.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (now, project_id))
        row = connection.execute("SELECT * FROM annotations WHERE id = ?", (cursor.lastrowid,)).fetchone()
        assert row is not None
        return annotation_to_dict(row)


@app.post("/api/projects/{project_id}/annotations/bulk", status_code=201)
def bulk_create_annotations(project_id: int, payload: BulkAnnotations) -> list[dict[str, Any]]:
    now = utc_now()
    created_ids: list[int] = []
    with db() as connection:
        project = connection.execute("SELECT duration FROM projects WHERE id = ?", (project_id,)).fetchone()
        if project is None:
            raise HTTPException(status_code=404, detail="Project not found")
        for annotation in payload.annotations:
            if project["duration"] and annotation.end_time > project["duration"] + 0.05:
                raise HTTPException(status_code=422, detail="An annotation exceeds video duration")
            reviewed_at = (
                now
                if annotation.status in {"accepted", "rejected"} and annotation.source != "manual"
                else None
            )
            cursor = connection.execute(
                """
                INSERT INTO annotations(
                    project_id, label, start_time, end_time, source, confidence, notes,
                    status, reviewed_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    project_id,
                    annotation.label,
                    annotation.start_time,
                    annotation.end_time,
                    annotation.source,
                    annotation.confidence,
                    annotation.notes,
                    annotation.status,
                    reviewed_at,
                    now,
                    now,
                ),
            )
            created_ids.append(int(cursor.lastrowid))
        connection.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (now, project_id))
        if not created_ids:
            return []
        placeholders = ",".join("?" for _ in created_ids)
        rows = connection.execute(
            f"SELECT * FROM annotations WHERE id IN ({placeholders}) ORDER BY start_time",
            created_ids,
        ).fetchall()
        return [annotation_to_dict(row) for row in rows]


@app.patch("/api/annotations/{annotation_id}")
def update_annotation(annotation_id: int, payload: AnnotationUpdate) -> dict[str, Any]:
    values = payload.model_dump(exclude_none=True)
    with db() as connection:
        current = connection.execute("SELECT * FROM annotations WHERE id = ?", (annotation_id,)).fetchone()
        if current is None:
            raise HTTPException(status_code=404, detail="Annotation not found")
        start_time = values.get("start_time", current["start_time"])
        end_time = values.get("end_time", current["end_time"])
        if end_time <= start_time:
            raise HTTPException(status_code=422, detail="end_time must be greater than start_time")
        project = connection.execute("SELECT duration FROM projects WHERE id = ?", (current["project_id"],)).fetchone()
        if project and project["duration"] and end_time > project["duration"] + 0.05:
            raise HTTPException(status_code=422, detail="Annotation exceeds video duration")
        if not values:
            return annotation_to_dict(current)

        now = utc_now()
        if "status" in values and values["status"] in {"accepted", "rejected"}:
            values["reviewed_at"] = now
        elif "status" in values and values["status"] == "suggested":
            values["reviewed_at"] = None
        values["updated_at"] = now
        assignments = ", ".join(f"{key} = ?" for key in values)
        connection.execute(
            f"UPDATE annotations SET {assignments} WHERE id = ?",
            (*values.values(), annotation_id),
        )
        connection.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (now, current["project_id"]))
        row = connection.execute("SELECT * FROM annotations WHERE id = ?", (annotation_id,)).fetchone()
        assert row is not None
        return annotation_to_dict(row)


@app.delete("/api/annotations/{annotation_id}", status_code=204)
def delete_annotation(annotation_id: int) -> Response:
    with db() as connection:
        row = connection.execute("SELECT project_id FROM annotations WHERE id = ?", (annotation_id,)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Annotation not found")
        connection.execute("DELETE FROM annotations WHERE id = ?", (annotation_id,))
        connection.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (utc_now(), row["project_id"]))
    return Response(status_code=204)


@app.post("/api/projects/{project_id}/analysis-runs", status_code=201)
def create_analysis_run(project_id: int, payload: AnalysisRunCreate) -> dict[str, Any]:
    with db() as connection:
        exists = connection.execute("SELECT id FROM projects WHERE id = ?", (project_id,)).fetchone()
        if exists is None:
            raise HTTPException(status_code=404, detail="Project not found")
        cursor = connection.execute(
            """
            INSERT INTO analysis_runs(
                project_id, method, threshold_mode, threshold, sample_interval,
                sample_count, suggestion_count, detected_frames, mean_detection_confidence,
                temporal_iou, temporal_precision, temporal_recall, temporal_f1,
                reference_seconds, predicted_seconds, analysis_ms, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                project_id,
                payload.method,
                payload.threshold_mode,
                payload.threshold,
                payload.sample_interval,
                payload.sample_count,
                payload.suggestion_count,
                payload.detected_frames,
                payload.mean_detection_confidence,
                payload.temporal_iou,
                payload.temporal_precision,
                payload.temporal_recall,
                payload.temporal_f1,
                payload.reference_seconds,
                payload.predicted_seconds,
                payload.analysis_ms,
                utc_now(),
            ),
        )
        row = connection.execute("SELECT * FROM analysis_runs WHERE id = ?", (cursor.lastrowid,)).fetchone()
        assert row is not None
        return analysis_run_to_dict(row)


@app.get("/api/projects/{project_id}/analysis-runs")
def list_analysis_runs(project_id: int) -> list[dict[str, Any]]:
    with db() as connection:
        exists = connection.execute("SELECT id FROM projects WHERE id = ?", (project_id,)).fetchone()
        if exists is None:
            raise HTTPException(status_code=404, detail="Project not found")
        rows = connection.execute(
            "SELECT * FROM analysis_runs WHERE project_id = ? ORDER BY created_at DESC",
            (project_id,),
        ).fetchall()
        return [analysis_run_to_dict(row) for row in rows]


@app.get("/api/projects/{project_id}/metrics")
def get_metrics(project_id: int) -> dict[str, Any]:
    with db() as connection:
        return compute_metrics(connection, project_id)


@app.get("/api/projects/{project_id}/export")
def export_project(
    project_id: int,
    format: Literal["json", "csv"] = Query(default="json"),
) -> Response:
    project = get_project(project_id)
    with db() as connection:
        metrics = compute_metrics(connection, project_id)
        runs = connection.execute(
            "SELECT * FROM analysis_runs WHERE project_id = ? ORDER BY created_at",
            (project_id,),
        ).fetchall()

    safe_name = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in project["name"]).strip("_") or "project"
    if format == "json":
        package = {
            **project,
            "metrics": metrics,
            "analysis_runs": [analysis_run_to_dict(row) for row in runs],
            "privacy": {
                "video_uploaded_to_server": False,
                "server_stores": ["video metadata", "temporal annotations", "review decisions", "analysis metadata"],
                "client_side_inference": ["frame difference", "MediaPipe Pose Landmarker"],
            },
            "schema_version": "0.3",
        }
        content = json.dumps(package, ensure_ascii=False, indent=2)
        return Response(
            content=content,
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="{safe_name}.json"'},
        )

    output = io.StringIO()
    writer = csv.DictWriter(
        output,
        fieldnames=[
            "id",
            "label",
            "start_time",
            "end_time",
            "duration",
            "source",
            "status",
            "confidence",
            "notes",
            "reviewed_at",
        ],
    )
    writer.writeheader()
    for annotation in project["annotations"]:
        writer.writerow(
            {
                "id": annotation["id"],
                "label": annotation["label"],
                "start_time": annotation["start_time"],
                "end_time": annotation["end_time"],
                "duration": round(annotation["end_time"] - annotation["start_time"], 3),
                "source": annotation["source"],
                "status": annotation["status"],
                "confidence": annotation["confidence"],
                "notes": annotation["notes"],
                "reviewed_at": annotation["reviewed_at"],
            }
        )
    return Response(
        content=output.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{safe_name}.csv"'},
    )


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
app.mount("/samples", StaticFiles(directory=SAMPLES_DIR), name="samples")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")
