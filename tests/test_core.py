from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

import pytest

from sentinel.core import SentinelService


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.fixture()
def service(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> SentinelService:
    dataset_dir = tmp_path / "synthetic-ambient-fhir-25"
    dataset_dir.mkdir()
    shutil.copy(PROJECT_ROOT / "synthetic-ambient-fhir-25" / "synthetic-ambient-fhir-25.json", dataset_dir)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    return SentinelService(tmp_path)


def test_expected_answer_key_classifications(service: SentinelService) -> None:
    result = service.findings()
    findings = {item["id"]: item for item in result["findings"]}

    assert result["summary"] == {
        "commitments": 8,
        "needs_action": 3,
        "verified": 4,
        "external": 1,
        "high_risk": 2,
    }
    assert findings["med-lisinopril"]["classification"] == "WRONG"
    assert "40 MG" in findings["med-lisinopril"]["ehr_evidence"]["current_state"]
    assert findings["ref-dental"]["classification"] == "INCOMPLETE"
    assert findings["followup-bp"]["classification"] == "MISSING"
    assert findings["external-housing"]["classification"] == "NON_EHR_ACTION"

    assert sum(item["classification"] == "OK" for item in findings.values()) == 4
    assert all(item["commitment"]["quote_verified"] for item in findings.values())


def test_all_quote_offsets_point_to_exact_transcript(service: SentinelService) -> None:
    transcript = service.repository.get_julius()["transcript"]
    for finding in service.findings()["findings"]:
        commitment = finding["commitment"]
        actual = transcript[commitment["quote_start"]:commitment["quote_end"]]
        assert actual.lower() == commitment["verbatim_quote"].lower()


def test_approvals_repair_runtime_only_and_create_audit(service: SentinelService) -> None:
    source_dataset_hash = digest(service.paths.dataset)

    service.approve("med-lisinopril")
    service.approve("ref-dental")
    result = service.approve("followup-bp")

    assert result["summary"]["needs_action"] == 0
    assert result["summary"]["verified"] == 7
    assert len(service.audit_log()) == 3

    runtime = json.loads(service.paths.runtime_ehr.read_text())
    lisinopril = next(
        med for med in runtime["resources"]["MedicationRequest"]
        if "lisinopril" in med["medicationCodeableConcept"]["text"].lower()
    )
    assert lisinopril["medicationCodeableConcept"]["text"] == "lisinopril 10 MG Oral Tablet"
    assert runtime["resources"]["ServiceRequest"][0]["reasonCode"][0]["coding"][0]["code"] == "66383009"
    assert runtime["resources"]["Appointment"][0]["status"] == "proposed"

    assert digest(service.paths.dataset) == source_dataset_hash


def test_rejection_does_not_modify_ehr(service: SentinelService) -> None:
    before = digest(service.paths.runtime_ehr)
    result = service.reject("med-lisinopril", "Need pharmacist confirmation")
    assert digest(service.paths.runtime_ehr) == before
    finding = next(item for item in result["findings"] if item["id"] == "med-lisinopril")
    assert finding["classification"] == "WRONG"
    assert finding["workflow_state"] == "REJECTED"


def test_only_external_actions_can_be_manually_completed(service: SentinelService) -> None:
    with pytest.raises(ValueError):
        service.complete_external("med-lisinopril")
    result = service.complete_external("external-housing")
    finding = next(item for item in result["findings"] if item["id"] == "external-housing")
    assert finding["workflow_state"] == "COMPLETE"


def test_reset_restores_seeded_discrepancies(service: SentinelService) -> None:
    service.approve("med-lisinopril")
    assert service.findings()["summary"]["needs_action"] == 2
    service.reset_demo()
    assert service.findings()["summary"]["needs_action"] == 3
    assert service.audit_log() == []


def test_analysis_uses_validated_fallback_without_credentials(service: SentinelService) -> None:
    result = service.analyze()
    assert result["analysis"]["mode"] == "cached"
    assert "not configured" in result["analysis"]["message"]
    assert result["summary"]["commitments"] == 8
