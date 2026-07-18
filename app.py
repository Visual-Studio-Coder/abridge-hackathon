from __future__ import annotations

from pathlib import Path

from flask import Flask, jsonify, render_template, request
from dotenv import load_dotenv

from sentinel.core import SentinelService


ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")
app = Flask(__name__)
service = SentinelService(ROOT)


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/health")
def health():
    return jsonify({"ok": True, "service": "Missing Order Sentinel"})


@app.get("/api/encounter")
def encounter():
    return jsonify(service.encounter_payload())


@app.get("/api/encounters/<path:encounter_id>")
def encounter_by_id(encounter_id: str):
    return jsonify(service.encounter_payload(encounter_id))


@app.get("/api/review-queue")
def review_queue():
    return jsonify(service.review_queue())


@app.get("/api/encounters/<path:encounter_id>/findings")
def encounter_findings(encounter_id: str):
    result = service.generic_findings(encounter_id)
    return jsonify(result or {"findings": [], "summary": None, "analysis": None})


@app.post("/api/encounters/<path:encounter_id>/analyze")
def analyze_encounter(encounter_id: str):
    return jsonify(service.analyze_encounter(encounter_id))


@app.post("/api/analyze")
def analyze():
    return jsonify(service.analyze())


@app.get("/api/findings")
def findings():
    return jsonify(service.findings())


@app.post("/api/findings/<finding_id>/approve")
def approve(finding_id: str):
    payload = request.get_json(silent=True) or {}
    return jsonify(service.approve(finding_id, payload.get("approved_by", "Dr. Amado Adams")))


@app.post("/api/findings/<finding_id>/reject")
def reject(finding_id: str):
    payload = request.get_json(silent=True) or {}
    return jsonify(service.reject(finding_id, payload.get("reason", ""), payload.get("approved_by", "Dr. Amado Adams")))


@app.post("/api/findings/<finding_id>/complete-external")
def complete_external(finding_id: str):
    payload = request.get_json(silent=True) or {}
    return jsonify(service.complete_external(finding_id, payload.get("approved_by", "Dr. Amado Adams")))


@app.get("/api/audit")
def audit():
    return jsonify({"events": service.audit_log()})


@app.post("/api/demo/reset")
def reset():
    return jsonify(service.reset_demo())


@app.errorhandler(KeyError)
@app.errorhandler(ValueError)
def handle_bad_request(error):
    return jsonify({"error": str(error)}), 400


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
