from pathlib import Path

from fastapi.testclient import TestClient

from app import main


def test_project_annotation_review_metrics_and_export(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "test.db")
    main.init_db()

    with TestClient(main.app) as client:
        health = client.get("/api/health")
        assert health.status_code == 200
        assert health.json()["status"] == "ok"
        assert health.json()["version"] == "0.3.0"

        project_response = client.post(
            "/api/projects",
            json={"name": "Demo", "video_name": "demo.mp4", "duration": 10.0},
        )
        assert project_response.status_code == 201
        project = project_response.json()

        manual = client.post(
            f"/api/projects/{project['id']}/annotations",
            json={
                "label": "caminhar",
                "start_time": 1.0,
                "end_time": 2.5,
                "source": "manual",
            },
        )
        assert manual.status_code == 201
        assert manual.json()["status"] == "accepted"

        motion_suggestion = client.post(
            f"/api/projects/{project['id']}/annotations",
            json={
                "label": "movimento",
                "start_time": 3.0,
                "end_time": 5.0,
                "source": "motion-suggestion",
                "confidence": 0.8,
            },
        )
        assert motion_suggestion.status_code == 201
        suggestion_body = motion_suggestion.json()
        assert suggestion_body["status"] == "suggested"

        accepted = client.patch(
            f"/api/annotations/{suggestion_body['id']}",
            json={"status": "accepted", "label": "levantar_mão"},
        )
        assert accepted.status_code == 200
        assert accepted.json()["status"] == "accepted"
        assert accepted.json()["reviewed_at"] is not None

        pose_suggestion = client.post(
            f"/api/projects/{project['id']}/annotations",
            json={
                "label": "movimento_corporal",
                "start_time": 6.0,
                "end_time": 7.0,
                "source": "pose-suggestion",
                "confidence": 0.91,
            },
        )
        assert pose_suggestion.status_code == 201
        assert pose_suggestion.json()["status"] == "suggested"

        analysis_run = client.post(
            f"/api/projects/{project['id']}/analysis-runs",
            json={
                "method": "pose",
                "threshold_mode": "adaptive",
                "threshold": 0.035,
                "sample_interval": 0.5,
                "sample_count": 20,
                "suggestion_count": 1,
                "detected_frames": 18,
                "mean_detection_confidence": 0.92,
                "temporal_iou": 0.75,
                "temporal_precision": 0.8,
                "temporal_recall": 0.9,
                "temporal_f1": 0.8471,
                "reference_seconds": 1.5,
                "predicted_seconds": 1.7,
                "analysis_ms": 125.0,
            },
        )
        assert analysis_run.status_code == 201
        assert analysis_run.json()["detected_frames"] == 18
        assert analysis_run.json()["temporal_f1"] == 0.8471

        runs = client.get(f"/api/projects/{project['id']}/analysis-runs")
        assert runs.status_code == 200
        assert runs.json()[0]["method"] == "pose"

        metrics = client.get(f"/api/projects/{project['id']}/metrics")
        assert metrics.status_code == 200
        body = metrics.json()
        assert body["manual_annotations"] == 1
        assert body["motion_suggestions"] == 1
        assert body["pose_suggestions"] == 1
        assert body["suggestions_accepted"] == 1
        assert body["suggestions_pending"] == 1
        assert body["suggestion_acceptance_rate"] == 100.0
        assert body["analysis_runs"] == 1
        assert body["last_evaluation"]["temporal_iou"] == 0.75
        assert body["coverage_percent"] == 45.0

        json_export = client.get(f"/api/projects/{project['id']}/export?format=json")
        assert json_export.status_code == 200
        exported = json_export.json()
        assert exported["schema_version"] == "0.3"
        assert exported["privacy"]["video_uploaded_to_server"] is False
        assert "MediaPipe Pose Landmarker" in exported["privacy"]["client_side_inference"]
        assert exported["metrics"]["pose_suggestions"] == 1
        assert exported["analysis_runs"][0]["temporal_f1"] == 0.8471

        csv_export = client.get(f"/api/projects/{project['id']}/export?format=csv")
        assert csv_export.status_code == 200
        assert "movimento_corporal" in csv_export.text
        assert "pose-suggestion" in csv_export.text
        assert "status" in csv_export.text


def test_rejects_invalid_interval(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "test.db")
    main.init_db()

    with TestClient(main.app) as client:
        project = client.post("/api/projects", json={"name": "Demo", "duration": 5.0}).json()
        response = client.post(
            f"/api/projects/{project['id']}/annotations",
            json={"label": "erro", "start_time": 3.0, "end_time": 2.0},
        )
        assert response.status_code == 422


def test_migrates_legacy_annotation_and_analysis_tables(tmp_path: Path, monkeypatch) -> None:
    legacy_db = tmp_path / "legacy.db"
    monkeypatch.setattr(main, "DB_PATH", legacy_db)
    with main.db() as connection:
        connection.executescript(
            """
            CREATE TABLE projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                video_name TEXT NOT NULL DEFAULT '',
                duration REAL NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE annotations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL,
                label TEXT NOT NULL,
                start_time REAL NOT NULL,
                end_time REAL NOT NULL,
                source TEXT NOT NULL DEFAULT 'manual',
                confidence REAL,
                notes TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE analysis_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL,
                method TEXT NOT NULL,
                threshold_mode TEXT NOT NULL DEFAULT 'manual',
                threshold REAL,
                sample_interval REAL NOT NULL,
                sample_count INTEGER NOT NULL DEFAULT 0,
                suggestion_count INTEGER NOT NULL DEFAULT 0,
                analysis_ms REAL,
                created_at TEXT NOT NULL
            );
            """
        )
    main.init_db()
    with main.db() as connection:
        annotation_columns = {row["name"] for row in connection.execute("PRAGMA table_info(annotations)").fetchall()}
        analysis_columns = {row["name"] for row in connection.execute("PRAGMA table_info(analysis_runs)").fetchall()}
    assert "status" in annotation_columns
    assert "reviewed_at" in annotation_columns
    for column in {
        "detected_frames",
        "mean_detection_confidence",
        "temporal_iou",
        "temporal_precision",
        "temporal_recall",
        "temporal_f1",
        "reference_seconds",
        "predicted_seconds",
    }:
        assert column in analysis_columns
