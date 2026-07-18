from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


JULIUS_ENCOUNTER_ID = (
    "6d4fd363-1ddb-74f8-516f-2fdc861cb736::"
    "6d4fd363-1ddb-74f8-95dd-b53404f1e107"
)
PROMPT_VERSION = "commitment-reconciliation-v2"
ALLOWED_TYPES = {
    "medication_change",
    "lab",
    "referral",
    "follow_up",
    "immunization",
    "non_ehr_action",
}
GENERIC_OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "type": {"type": "string", "enum": sorted(ALLOWED_TYPES)},
                    "description": {"type": "string"},
                    "verbatim_quote": {"type": "string"},
                    "due_window": {"type": ["string", "null"]},
                    "expected_resource": {"type": ["string", "null"]},
                    "classification": {"type": "string", "enum": ["OK", "MISSING", "INCOMPLETE", "WRONG", "NON_EHR_ACTION"]},
                    "current_ehr_state": {"type": "string"},
                    "repair_summary": {"type": "string"},
                    "risk": {"type": "string", "enum": ["HIGH", "ELEVATED", "ROUTINE"]},
                },
                "required": ["type", "description", "verbatim_quote", "due_window", "expected_resource", "classification", "current_ehr_state", "repair_summary", "risk"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["findings"],
    "additionalProperties": False,
}


@dataclass(frozen=True)
class Paths:
    root: Path

    @property
    def dataset(self) -> Path:
        return self.root / "synthetic-ambient-fhir-25" / "synthetic-ambient-fhir-25.json"

    @property
    def runtime(self) -> Path:
        return self.root / ".runtime"

    @property
    def runtime_ehr(self) -> Path:
        return self.runtime / "ehr.json"

    @property
    def audit(self) -> Path:
        return self.runtime / "audit.json"

    @property
    def extraction_cache(self) -> Path:
        return self.runtime / "extraction-cache.json"

    @property
    def analysis_meta(self) -> Path:
        return self.runtime / "analysis-meta.json"

    @property
    def encounter_cache(self) -> Path:
        return self.runtime / "encounters"

    @property
    def seeded_ehr_dir(self) -> Path:
        return self.root / "eval" / "seeded-ehr"

    @property
    def seeding_manifest(self) -> Path:
        return self.root / "eval" / "seeding-manifest.json"


def _read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pending = path.with_suffix(path.suffix + ".tmp")
    with pending.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, ensure_ascii=False)
    pending.replace(path)


class EncounterRepository:
    """Loads the supplied Abridge-style encounter and seeded post-visit EHR."""

    def __init__(self, paths: Paths):
        self.paths = paths

    def get_julius(self) -> dict[str, Any]:
        return self.get(JULIUS_ENCOUNTER_ID)

    def get(self, encounter_id: str) -> dict[str, Any]:
        records = _read_json(self.paths.dataset)
        return next(item for item in records if item["id"] == encounter_id)

    def review_queue(self, limit: int = 25) -> list[dict[str, Any]]:
        records = _read_json(self.paths.dataset)
        others = [item for item in records if item["id"] != JULIUS_ENCOUNTER_ID]
        others.sort(key=lambda item: item["metadata"]["date"], reverse=True)
        return [self.get_julius(), *others[: max(0, limit - 1)]]

    def get_seeded_ehr(self, encounter_id: str = JULIUS_ENCOUNTER_ID) -> dict[str, Any]:
        """Load the disclosed post-visit EHR bundle for an encounter.

        The supplied bundle is preferred. Julius retains a deterministic fallback
        so a public checkout remains runnable without the private fixture archive.
        """
        prefix = encounter_id.split("::", 1)[0][:8]
        supplied = self.paths.seeded_ehr_dir / f"{prefix}-ehr.json"
        if supplied.exists():
            return _read_json(supplied)

        record = self.get(encounter_id)
        ehr = {
            "patient": copy.deepcopy(record["patient_context"]["patient"]),
            "encounter": copy.deepcopy(record["encounter_fhir"]["encounter"]),
            "resources": copy.deepcopy(record["encounter_fhir"]["related_resources"]),
        }

        if encounter_id != JULIUS_ENCOUNTER_ID:
            return ehr

        lisinopril = _medication(ehr, "lisinopril")
        if lisinopril:
            concept = lisinopril["medicationCodeableConcept"]
            concept["text"] = "lisinopril 40 MG Oral Tablet"
            if concept.get("coding"):
                concept["coding"][0]["display"] = "lisinopril 40 MG Oral Tablet"

        _resources(ehr, "ServiceRequest").append({
            "resourceType": "ServiceRequest",
            "id": "planted-dental-referral-001",
            "status": "active",
            "intent": "order",
            "code": {
                "coding": [{
                    "system": "http://snomed.info/sct",
                    "code": "103696004",
                    "display": "Patient referral to dentist",
                }],
                "text": "Referral to dental clinic",
            },
            "subject": {"reference": f"Patient/{ehr['patient']['id']}"},
            "authoredOn": record["metadata"]["date"],
        })
        return ehr


COMMITMENT_BLUEPRINTS: list[dict[str, Any]] = [
    {
        "id": "med-lisinopril",
        "type": "medication_change",
        "category": "Medication",
        "description": "Start lisinopril 10 mg once daily",
        "quote": "lisinopril ten milligrams once a day",
        "expected_resource": "MedicationRequest",
        "risk": "HIGH",
        "due_window": None,
    },
    {
        "id": "med-amlodipine",
        "type": "medication_change",
        "category": "Medication",
        "description": "Start amlodipine 2.5 mg once daily",
        "quote": "amlodipine two and a half milligrams once a day",
        "expected_resource": "MedicationRequest",
        "risk": "ROUTINE",
        "due_window": None,
    },
    {
        "id": "med-hctz",
        "type": "medication_change",
        "category": "Medication",
        "description": "Start hydrochlorothiazide 25 mg each morning",
        "quote": "hydrochlorothiazide twenty-five milligrams in the morning",
        "expected_resource": "MedicationRequest",
        "risk": "ROUTINE",
        "due_window": None,
    },
    {
        "id": "med-acetaminophen",
        "type": "medication_change",
        "category": "Medication",
        "description": "Send acetaminophen 325 mg to the pharmacy",
        "quote": "the three-hundred-twenty-five-milligram tablets I am sending to the pharmacy",
        "expected_resource": "MedicationRequest",
        "risk": "ROUTINE",
        "due_window": None,
    },
    {
        "id": "ref-dental",
        "type": "referral",
        "category": "Referral",
        "description": "Refer Julius to the sliding-scale dental clinic for gingivitis",
        "quote": "I am putting in a referral to the dental clinic",
        "expected_resource": "ServiceRequest",
        "risk": "ELEVATED",
        "due_window": None,
    },
    {
        "id": "followup-bp",
        "type": "follow_up",
        "category": "Follow-up",
        "description": "Schedule follow-up in 4–6 weeks with the home blood-pressure log",
        "quote": "I want you back in four to six weeks with the home blood pressure log",
        "expected_resource": "Appointment",
        "risk": "HIGH",
        "due_window": "4–6 weeks after 2025-07-13",
    },
    {
        "id": "imm-flu",
        "type": "immunization",
        "category": "Immunization",
        "description": "Administer the influenza vaccine during the visit",
        "quote": "flu shot. You are due",
        "expected_resource": "Immunization",
        "risk": "ROUTINE",
        "due_window": "During visit",
    },
    {
        "id": "external-housing",
        "type": "non_ehr_action",
        "category": "External",
        "description": "Provide a tenant-rights and county housing hotline packet",
        "quote": "I am having them print it for you before you leave",
        "expected_resource": None,
        "risk": "ROUTINE",
        "due_window": "Before checkout",
    },
]


def _normalized(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().lower())


def _display_name(value: str) -> str:
    """Remove Synthea's numeric name suffixes from clinician-facing labels."""
    return re.sub(r"\s+", " ", re.sub(r"\d+", "", value)).strip()


def _verify_quote(transcript: str, quote: str) -> tuple[int, int]:
    start = transcript.lower().find(quote.lower())
    if start < 0:
        raise ValueError(f"Unverified transcript quote: {quote}")
    return start, start + len(quote)


def _locate_quote(transcript: str, quote: str) -> tuple[int, int]:
    """Locate model evidence while tolerating punctuation-only differences."""
    try:
        return _verify_quote(transcript, quote)
    except ValueError:
        words = re.findall(r"[a-z0-9]+", quote.lower())
        if len(words) < 3:
            raise
        pattern = r"\b" + r"[\W_]+".join(re.escape(word) for word in words) + r"\b"
        match = re.search(pattern, transcript, flags=re.I)
        if not match:
            raise ValueError(f"Unverified transcript quote: {quote}")
        return match.start(), match.end()


def _resources(ehr: dict[str, Any], resource_type: str) -> list[dict[str, Any]]:
    return ehr.setdefault("resources", {}).setdefault(resource_type, [])


def _medication(ehr: dict[str, Any], needle: str) -> dict[str, Any] | None:
    for resource in _resources(ehr, "MedicationRequest"):
        concept = resource.get("medicationCodeableConcept", {})
        display = concept.get("text", "") + " " + " ".join(
            item.get("display", "") for item in concept.get("coding", [])
        )
        if needle.lower() in display.lower():
            return resource
    return None


def _medication_display(resource: dict[str, Any] | None) -> str:
    if not resource:
        return "No MedicationRequest found"
    concept = resource.get("medicationCodeableConcept", {})
    return concept.get("text") or (concept.get("coding") or [{}])[0].get("display", "Unknown medication")


class SentinelService:
    def __init__(self, root: Path):
        self.paths = Paths(root)
        self.repository = EncounterRepository(self.paths)
        self._lock = threading.RLock()
        self.ensure_runtime()

    def ensure_runtime(self) -> None:
        with self._lock:
            if not self.paths.runtime_ehr.exists():
                self.reset_demo()

    def reset_demo(self) -> dict[str, Any]:
        with self._lock:
            self.paths.runtime.mkdir(parents=True, exist_ok=True)
            _write_json(self.paths.runtime_ehr, self.repository.get_seeded_ehr())
            _write_json(self.paths.audit, [])
            _write_json(
                self.paths.analysis_meta,
                {"mode": "ready", "message": "Ready to analyze encounter", "analyzed_at": None},
            )
            return {"ok": True, "message": "Seeded EHR restored"}

    def encounter_payload(self, encounter_id: str = JULIUS_ENCOUNTER_ID) -> dict[str, Any]:
        record = self.repository.get(encounter_id)
        patient = record["patient_context"]["patient"]
        name = patient["name"][0]
        initials = "".join(
            part[0]
            for part in [*(name.get("given") or [""])[:1], name.get("family", "")]
            if part
        )[:2].upper()
        return {
            "id": record["id"],
            "patient": {
                "id": patient["id"],
                "name": _display_name(" ".join(name.get("given", []) + [name.get("family", "")]).strip()),
                "initials": initials,
                "birth_date": patient.get("birthDate"),
                "gender": patient.get("gender"),
                "location": ", ".join(
                    part for part in [
                        (patient.get("address") or [{}])[0].get("city"),
                        (patient.get("address") or [{}])[0].get("state"),
                    ] if part
                ),
            },
            "metadata": record["metadata"],
            "practitioner": _display_name(record["encounter_fhir"]["encounter"]["participant"][0]["individual"].get("display", "")),
            "transcript": record["transcript"],
            "note": record["note"],
            "after_visit_summary": record["after_visit_summary"],
            "avs_provenance": record["after_visit_summary_provenance"],
            "ehr": _read_json(self.paths.runtime_ehr) if encounter_id == JULIUS_ENCOUNTER_ID else self.repository.get_seeded_ehr(encounter_id),
        }

    def _generic_cache_path(self, encounter_id: str) -> Path:
        safe = hashlib.sha256(encounter_id.encode()).hexdigest()[:20]
        return self.paths.encounter_cache / f"{safe}.json"

    def _encounter_fingerprint(self, encounter_id: str) -> str:
        record = self.repository.get(encounter_id)
        seeded_ehr = self.repository.get_seeded_ehr(encounter_id)
        return hashlib.sha256(
            (record["transcript"] + json.dumps(seeded_ehr, sort_keys=True) + PROMPT_VERSION).encode()
        ).hexdigest()[:12]

    def review_queue(self) -> dict[str, Any]:
        rows = []
        for record in self.repository.review_queue():
            patient = record["patient_context"]["patient"]
            name = patient["name"][0]
            encounter_id = record["id"]
            if encounter_id == JULIUS_ENCOUNTER_ID:
                result = self.findings()
                analyzed = bool(result["analysis"].get("analyzed_at"))
                summary = result["summary"] if analyzed else None
            else:
                cached = self.generic_findings(encounter_id)
                analyzed = cached is not None
                summary = cached.get("summary") if cached else None
            rows.append({
                "id": encounter_id,
                "name": _display_name(" ".join(name.get("given", []) + [name.get("family", "")]).strip()),
                "initials": "".join(part[0] for part in [*(name.get("given") or [""])[:1], name.get("family", "")] if part)[:2].upper(),
                "visit_title": record["metadata"]["visit_title"],
                "date": record["metadata"]["date"],
                "analyzed": analyzed,
                "summary": summary,
                "demo_patient": encounter_id == JULIUS_ENCOUNTER_ID,
            })
        return {
            "encounters": rows,
            "summary": {
                "encounters": len(rows),
                "analyzed": sum(row["analyzed"] for row in rows),
                "needs_action": sum((row["summary"] or {}).get("needs_action", 0) for row in rows),
            },
        }

    def generic_findings(self, encounter_id: str) -> dict[str, Any] | None:
        if encounter_id == JULIUS_ENCOUNTER_ID:
            return self.findings()
        path = self._generic_cache_path(encounter_id)
        if not path.exists():
            return None
        cached = _read_json(path)
        return cached if cached.get("analysis", {}).get("fingerprint") == self._encounter_fingerprint(encounter_id) else None

    def seeding_manifest(self) -> list[dict[str, Any]]:
        return _read_json(self.paths.seeding_manifest) if self.paths.seeding_manifest.exists() else []

    @staticmethod
    def _finding_resource(finding: dict[str, Any]) -> str | None:
        value = finding.get("ehr_evidence", {}).get("resource_type") or finding.get("commitment", {}).get("expected_resource")
        if not value:
            return None
        for resource_type in ["MedicationRequest", "Immunization", "ServiceRequest", "Appointment", "Observation", "CarePlan", "Task"]:
            if resource_type.lower() in str(value).lower():
                return resource_type
        return str(value)

    def evaluation(self) -> dict[str, Any]:
        rows = []
        total_expected = total_detected = caught = natural_gaps = control_candidates = 0
        clean_controls = clean_controls_clear = analyzed_count = 0
        issue_states = {"MISSING", "WRONG", "INCOMPLETE"}
        for expected_row in self.seeding_manifest():
            encounter_id = expected_row["encounter_id"]
            result = self.generic_findings(encounter_id)
            analyzed = bool(result and result.get("analysis", {}).get("analyzed_at"))
            detections = [item for item in (result or {}).get("findings", []) if item.get("classification") in issue_states] if analyzed else []
            expected = expected_row.get("planted", [])
            used: set[int] = set()
            hits = []
            misses = []
            for plant in expected:
                match = next((
                    index for index, finding in enumerate(detections)
                    if index not in used
                    and finding.get("classification") == plant.get("kind")
                    and self._finding_resource(finding) == plant.get("resource")
                ), None)
                if match is None:
                    misses.append(plant)
                else:
                    used.add(match)
                    hits.append(plant)
            extras = [finding for index, finding in enumerate(detections) if index not in used]
            is_clean = not expected
            if is_clean:
                clean_controls += 1
                if analyzed and not extras:
                    clean_controls_clear += 1
                control_candidates += len(extras)
            else:
                natural_gaps += len(extras)
            if analyzed:
                analyzed_count += 1
            total_expected += len(expected)
            total_detected += len(detections)
            caught += len(hits)
            rows.append({
                "encounter_id": encounter_id,
                "patient": expected_row["patient"],
                "visit_title": expected_row["visit_title"],
                "control": is_clean,
                "analyzed": analyzed,
                "expected": len(expected),
                "detected": len(detections),
                "caught": len(hits),
                "missed": len(misses) if analyzed else None,
                "additional": len(extras),
                "status": "PENDING" if not analyzed else "MISSED" if misses else "ADDITIONAL" if extras else "CLEAR",
            })
        return {
            "summary": {
                "encounters": len(rows),
                "analyzed": analyzed_count,
                "seeded_encounters": sum(not row["control"] for row in rows),
                "clean_controls": clean_controls,
                "expected_discrepancies": total_expected,
                "detected_issues": total_detected,
                "caught": caught,
                "missed": total_expected - caught if analyzed_count == len(rows) else None,
                "natural_gaps": natural_gaps,
                "additional_candidates": natural_gaps + control_candidates,
                "unseeded_control_candidates": control_candidates,
                "clean_controls_clear": clean_controls_clear,
            },
            "rows": rows,
            "disclosure": "The manifest is a disclosed scoring key and is never included in the model prompt. Unseeded findings are candidates for adjudication, not automatically false positives.",
        }

    def analyze_encounter(self, encounter_id: str) -> dict[str, Any]:
        if encounter_id == JULIUS_ENCOUNTER_ID:
            return self.analyze()
        record = self.repository.get(encounter_id)
        seeded_ehr = self.repository.get_seeded_ehr(encounter_id)
        fingerprint = self._encounter_fingerprint(encounter_id)
        cached = self.generic_findings(encounter_id)
        if cached and cached.get("analysis", {}).get("fingerprint") == fingerprint:
            return cached
        if not os.getenv("ANTHROPIC_API_KEY"):
            raise ValueError("ANTHROPIC_API_KEY is required to analyze an uncached encounter")

        compact_resources = []
        for resource_type, resources in seeded_ehr["resources"].items():
            for resource in resources:
                compact_resources.append({
                    "resourceType": resource_type,
                    "id": resource.get("id"),
                    "status": resource.get("status"),
                    "code": resource.get("code"),
                    "medication": resource.get("medicationCodeableConcept"),
                    "reasonCode": resource.get("reasonCode"),
                    "vaccineCode": resource.get("vaccineCode"),
                })

        from anthropic import Anthropic
        prompt = f"""You audit a synthetic post-visit EHR against its ambient conversation.
Return a JSON object with a findings array of explicit clinician commitments. Each item must have:
type, description, verbatim_quote, due_window, expected_resource, classification,
current_ehr_state, repair_summary, risk. Allowed types: {sorted(ALLOWED_TYPES)}.
Allowed classifications: OK, MISSING, INCOMPLETE, WRONG, NON_EHR_ACTION.
Risk: HIGH, ELEVATED, or ROUTINE. Quotes must be exact contiguous transcript text.
Do not invent an issue when the record is adequate.
Keep descriptions, EHR states, and repair summaries concise (25 words or fewer each).

Transcript:\n{record['transcript']}

Clinical note:\n{record['note']}

FHIR resources:\n{json.dumps(compact_resources, ensure_ascii=False)}"""
        client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
        response = client.messages.create(
            model=os.getenv("ANTHROPIC_MODEL", "claude-sonnet-5"),
            max_tokens=12000,
            output_config={"format": {"type": "json_schema", "schema": GENERIC_OUTPUT_SCHEMA}},
            thinking={"type": "disabled"},
            messages=[{"role": "user", "content": prompt}],
        )
        text = "".join(block.text for block in response.content if getattr(block, "type", None) == "text")
        if not text:
            block_types = ", ".join(str(getattr(block, "type", "unknown")) for block in response.content) or "none"
            raise ValueError(f"Claude returned no JSON text (stop={response.stop_reason}; blocks={block_types})")
        extracted = json.loads(text)["findings"]
        if not isinstance(extracted, list):
            raise ValueError("Claude response must be a JSON array")

        category_map = {
            "medication_change": "Medication", "lab": "Lab", "referral": "Referral",
            "follow_up": "Follow-up", "immunization": "Immunization", "non_ehr_action": "External",
        }
        findings = []
        for raw in extracted:
            kind = raw.get("type")
            classification = str(raw.get("classification", "")).upper()
            quote = str(raw.get("verbatim_quote", "")).strip()
            if kind not in ALLOWED_TYPES or classification not in {"OK", "MISSING", "INCOMPLETE", "WRONG", "NON_EHR_ACTION"}:
                continue
            try:
                start, end = _locate_quote(record["transcript"], quote)
            except ValueError:
                continue
            quote = record["transcript"][start:end]
            finding_id = "generic-" + hashlib.sha256(f"{encounter_id}:{quote}".encode()).hexdigest()[:12]
            repair_summary = str(raw.get("repair_summary") or "").strip()
            findings.append({
                "id": finding_id,
                "category": category_map[kind],
                "commitment": {
                    "type": kind,
                    "description": raw.get("description") or quote,
                    "verbatim_quote": quote,
                    "quote_start": start,
                    "quote_end": end,
                    "quote_verified": True,
                    "due_window": raw.get("due_window"),
                    "expected_resource": raw.get("expected_resource"),
                },
                "classification": classification,
                "record_state": classification,
                "workflow_state": "PROPOSED" if classification in {"MISSING", "INCOMPLETE", "WRONG"} else "VERIFIED",
                "risk": str(raw.get("risk") or "ROUTINE").upper(),
                "ehr_evidence": {"resource_type": raw.get("expected_resource"), "resource_id": None, "current_state": raw.get("current_ehr_state") or "No matching structured evidence"},
                "reconciliation_rule": "Claude comparison verified against supplied encounter FHIR",
                "proposed_repair": {"summary": repair_summary, "risk_note": "Requires clinician review", "fhir_resource": {}} if repair_summary and classification in {"MISSING", "INCOMPLETE", "WRONG"} else None,
                "apply_supported": False,
                "last_event": None,
            })
        summary = {
            "commitments": len(findings),
            "needs_action": sum(item["classification"] in {"MISSING", "INCOMPLETE", "WRONG"} for item in findings),
            "verified": sum(item["classification"] == "OK" for item in findings),
            "external": sum(item["classification"] == "NON_EHR_ACTION" for item in findings),
            "high_risk": sum(item["risk"] == "HIGH" and item["classification"] in {"MISSING", "INCOMPLETE", "WRONG"} for item in findings),
        }
        result = {
            "findings": findings,
            "summary": summary,
            "analysis": {
                "mode": "live", "message": "Live Claude reconciliation complete",
                "model": os.getenv("ANTHROPIC_MODEL", "claude-sonnet-5"),
                "analyzed_at": datetime.now(timezone.utc).isoformat(),
                "fingerprint": fingerprint,
            },
        }
        _write_json(self._generic_cache_path(encounter_id), result)
        return result

    def _audits(self) -> list[dict[str, Any]]:
        return _read_json(self.paths.audit) if self.paths.audit.exists() else []

    def _latest_event(self, finding_id: str) -> dict[str, Any] | None:
        events = [event for event in self._audits() if event.get("finding_ref") == finding_id]
        return events[-1] if events else None

    def _base_commitments(self) -> list[dict[str, Any]]:
        transcript = self.repository.get_julius()["transcript"]
        commitments = []
        for blueprint in COMMITMENT_BLUEPRINTS:
            start, end = _verify_quote(transcript, blueprint["quote"])
            item = copy.deepcopy(blueprint)
            item["quote_start"] = start
            item["quote_end"] = end
            item["quote_verified"] = True
            commitments.append(item)
        return commitments

    def _merge_live_extraction(self, extracted: list[dict[str, Any]]) -> list[dict[str, Any]]:
        transcript = self.repository.get_julius()["transcript"]
        mapped: dict[str, dict[str, Any]] = {}
        for raw in extracted:
            kind = raw.get("type")
            if kind not in ALLOWED_TYPES:
                continue
            quote = str(raw.get("verbatim_quote", "")).strip()
            description = str(raw.get("description", "")).strip()
            haystack = _normalized(f"{description} {quote}")
            if "lisinopril" in haystack:
                key = "med-lisinopril"
            elif "amlodipine" in haystack:
                key = "med-amlodipine"
            elif "hydrochlorothiazide" in haystack or "water pill" in haystack:
                key = "med-hctz"
            elif "acetaminophen" in haystack or "tylenol" in haystack:
                key = "med-acetaminophen"
            elif "dental" in haystack or "dentist" in haystack:
                key = "ref-dental"
            elif "four to six weeks" in haystack or "4-6 weeks" in haystack or "blood pressure log" in haystack:
                key = "followup-bp"
            elif "flu" in haystack or "influenza" in haystack:
                key = "imm-flu"
            elif "housing" in haystack or "tenant" in haystack:
                key = "external-housing"
            else:
                continue
            start, end = _verify_quote(transcript, quote)
            raw["quote_start"] = start
            raw["quote_end"] = end
            raw["quote_verified"] = True
            mapped[key] = raw

        if set(mapped) != {item["id"] for item in COMMITMENT_BLUEPRINTS}:
            raise ValueError("Live extraction did not yield all eight validated commitments")

        merged = self._base_commitments()
        for item in merged:
            live = mapped[item["id"]]
            item["description"] = live.get("description") or item["description"]
            item["quote"] = live["verbatim_quote"]
            item["quote_start"] = live["quote_start"]
            item["quote_end"] = live["quote_end"]
            item["due_window"] = live.get("due_window") or item["due_window"]
        return merged

    def _call_claude(self) -> list[dict[str, Any]]:
        from anthropic import Anthropic

        record = self.repository.get_julius()
        client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
        prompt = f"""You are extracting explicit clinician commitments from one synthetic encounter.
Return ONLY a JSON array. Each item must contain: type, description, verbatim_quote,
due_window, expected_resource. Allowed types: {sorted(ALLOWED_TYPES)}.
Only include concrete actions the clinician explicitly promises or orders. Use an exact,
contiguous transcript quote. Split separate medications into separate commitments.

Encounter title: {record['metadata']['visit_title']}
Transcript:\n{record['transcript']}"""
        response = client.messages.create(
            model=os.getenv("ANTHROPIC_MODEL", "claude-sonnet-5"),
            max_tokens=3000,
            messages=[{"role": "user", "content": prompt}],
        )
        text = "".join(block.text for block in response.content if getattr(block, "type", None) == "text")
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.I)
        value = json.loads(text)
        if not isinstance(value, list):
            raise ValueError("Claude response must be a JSON array")
        return value

    def analyze(self) -> dict[str, Any]:
        record = self.repository.get_julius()
        seed = self.repository.get_seeded_ehr()
        fingerprint = hashlib.sha256(
            (record["transcript"] + json.dumps(seed, sort_keys=True) + PROMPT_VERSION).encode()
        ).hexdigest()
        mode = "cached"
        message = "Validated demo cache loaded"
        commitments = self._base_commitments()

        if os.getenv("ANTHROPIC_API_KEY"):
            try:
                commitments = self._merge_live_extraction(self._call_claude())
                _write_json(self.paths.extraction_cache, {"fingerprint": fingerprint, "commitments": commitments})
                mode = "live"
                message = "Claude extraction completed and transcript evidence verified"
            except Exception as exc:  # fallback is a deliberate demo reliability feature
                if self.paths.extraction_cache.exists():
                    cached = _read_json(self.paths.extraction_cache)
                    if cached.get("fingerprint") == fingerprint:
                        commitments = cached["commitments"]
                message = f"Live analysis unavailable; validated cache used ({type(exc).__name__})"
        else:
            message = "ANTHROPIC_API_KEY not configured; validated cache used"

        meta = {
            "mode": mode,
            "message": message,
            "model": os.getenv("ANTHROPIC_MODEL", "claude-sonnet-5"),
            "analyzed_at": datetime.now(timezone.utc).isoformat(),
            "fingerprint": fingerprint[:12],
            "commitments": commitments,
        }
        _write_json(self.paths.analysis_meta, meta)
        findings = self.findings(commitments)
        return {"analysis": {k: v for k, v in meta.items() if k != "commitments"}, **findings}

    def _analysis_commitments(self) -> list[dict[str, Any]]:
        if self.paths.analysis_meta.exists():
            meta = _read_json(self.paths.analysis_meta)
            if meta.get("commitments"):
                return meta["commitments"]
        return self._base_commitments()

    def _reconcile(self, item: dict[str, Any], ehr: dict[str, Any]) -> dict[str, Any]:
        finding_id = item["id"]
        classification = "OK"
        evidence: dict[str, Any]
        repair: dict[str, Any] | None = None
        rule = "Matching FHIR resource found"

        medication_map = {
            "med-lisinopril": ("lisinopril", "10 MG"),
            "med-amlodipine": ("amlodipine", "2.5 MG"),
            "med-hctz": ("hydrochlorothiazide", "25 MG"),
            "med-acetaminophen": ("acetaminophen", "325 MG"),
        }
        if finding_id in medication_map:
            needle, expected = medication_map[finding_id]
            resource = _medication(ehr, needle)
            display = _medication_display(resource)
            evidence = {
                "resource_type": "MedicationRequest",
                "resource_id": resource.get("id") if resource else None,
                "current_state": display,
            }
            if resource is None:
                classification = "MISSING"
                rule = "No matching MedicationRequest exists"
            elif expected.lower() not in display.lower():
                classification = "WRONG"
                rule = f"Medication exists, but expected dose {expected} does not match EHR"
            if finding_id == "med-lisinopril" and classification != "OK":
                corrected = copy.deepcopy(resource) if resource else {"resourceType": "MedicationRequest"}
                if corrected.get("requester", {}).get("display"):
                    corrected["requester"]["display"] = _display_name(corrected["requester"]["display"])
                corrected.setdefault("medicationCodeableConcept", {})["coding"] = [{
                    "system": "http://www.nlm.nih.gov/research/umls/rxnorm",
                    "code": "314076",
                    "display": "lisinopril 10 MG Oral Tablet",
                }]
                corrected["medicationCodeableConcept"]["text"] = "lisinopril 10 MG Oral Tablet"
                repair = {
                    "summary": "Correct lisinopril from 40 mg to 10 mg",
                    "risk_note": "EHR dose is 4× the dose agreed in the encounter.",
                    "fhir_resource": corrected,
                }
        elif finding_id == "ref-dental":
            resources = _resources(ehr, "ServiceRequest")
            resource = next((r for r in resources if "dental" in json.dumps(r).lower() or "dentist" in json.dumps(r).lower()), None)
            evidence = {
                "resource_type": "ServiceRequest",
                "resource_id": resource.get("id") if resource else None,
                "current_state": "Referral exists without diagnosis" if resource and not (resource.get("reasonCode") or resource.get("reasonReference")) else "Referral includes diagnosis",
            }
            if not resource:
                classification = "MISSING"
                rule = "No dental ServiceRequest exists"
            elif not (resource.get("reasonCode") or resource.get("reasonReference")):
                classification = "INCOMPLETE"
                rule = "ServiceRequest exists but has no reasonCode or reasonReference"
                corrected = copy.deepcopy(resource)
                corrected["reasonCode"] = [{
                    "coding": [{
                        "system": "http://snomed.info/sct",
                        "code": "66383009",
                        "display": "Gingivitis (disorder)",
                    }],
                    "text": "Gingivitis",
                }]
                repair = {
                    "summary": "Attach gingivitis diagnosis to dental referral",
                    "risk_note": "Referral may bounce without a documented clinical reason.",
                    "fhir_resource": corrected,
                }
        elif finding_id == "followup-bp":
            appointments = _resources(ehr, "Appointment")
            resource = next((r for r in appointments if "blood" in json.dumps(r).lower() or "hypertension" in json.dumps(r).lower()), None)
            evidence = {
                "resource_type": "Appointment",
                "resource_id": resource.get("id") if resource else None,
                "current_state": "Proposed follow-up represented; scheduling still pending" if resource else "No Appointment or scheduling task found",
            }
            if not resource:
                classification = "MISSING"
                rule = "No Appointment represents the agreed 4–6 week follow-up"
                repair = {
                    "summary": "Create proposed hypertension follow-up in the agreed window",
                    "risk_note": "Three new antihypertensives were started without a represented follow-up.",
                    "fhir_resource": {
                        "resourceType": "Appointment",
                        "id": "sentinel-bp-followup-001",
                        "status": "proposed",
                        "description": "Hypertension follow-up with home blood-pressure log",
                        "created": "2025-07-13T01:49:10-07:00",
                        "requestedPeriod": [{
                            "start": "2025-08-10T09:00:00-07:00",
                            "end": "2025-08-24T17:00:00-07:00",
                        }],
                        "participant": [{
                            "actor": {"reference": f"Patient/{ehr['patient']['id']}", "display": "Julius Renner"},
                            "status": "needs-action",
                        }],
                        "comment": "Bring home BP log; created after clinician approval by Missing Order Sentinel.",
                    },
                }
        elif finding_id == "imm-flu":
            resource = next((r for r in _resources(ehr, "Immunization") if "influenza" in json.dumps(r).lower()), None)
            evidence = {
                "resource_type": "Immunization",
                "resource_id": resource.get("id") if resource else None,
                "current_state": "Completed influenza immunization" if resource else "No completed influenza immunization",
            }
            if not resource or resource.get("status") != "completed":
                classification = "MISSING"
                rule = "No completed influenza Immunization found"
        else:
            classification = "NON_EHR_ACTION"
            evidence = {
                "resource_type": None,
                "resource_id": None,
                "current_state": "Front-desk handoff; not expected in FHIR",
            }
            rule = "Correctly excluded from EHR reconciliation"

        event = self._latest_event(finding_id)
        if event:
            if event["action"] == "REJECTED":
                workflow_state = "REJECTED"
            elif event["action"] == "EXTERNAL_COMPLETED":
                workflow_state = "COMPLETE"
            else:
                workflow_state = "APPLIED"
        elif classification in {"WRONG", "INCOMPLETE", "MISSING"}:
            workflow_state = "PROPOSED"
        elif classification == "NON_EHR_ACTION":
            workflow_state = "MANUAL_CONFIRMATION"
        else:
            workflow_state = "VERIFIED"

        return {
            "id": finding_id,
            "category": item["category"],
            "commitment": {
                "type": item["type"],
                "description": item["description"],
                "verbatim_quote": item["quote"],
                "quote_start": item["quote_start"],
                "quote_end": item["quote_end"],
                "quote_verified": item["quote_verified"],
                "due_window": item["due_window"],
                "expected_resource": item["expected_resource"],
            },
            "classification": classification,
            "record_state": classification,
            "workflow_state": workflow_state,
            "risk": item["risk"],
            "ehr_evidence": evidence,
            "reconciliation_rule": rule,
            "proposed_repair": repair,
            "last_event": event,
            "apply_supported": True,
        }

    def findings(self, commitments: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        ehr = _read_json(self.paths.runtime_ehr)
        items = [self._reconcile(item, ehr) for item in (commitments or self._analysis_commitments())]
        issues = sum(item["classification"] in {"WRONG", "INCOMPLETE", "MISSING"} for item in items)
        return {
            "findings": items,
            "summary": {
                "commitments": len(items),
                "needs_action": issues,
                "verified": sum(item["classification"] == "OK" for item in items),
                "external": sum(item["classification"] == "NON_EHR_ACTION" for item in items),
                "high_risk": sum(item["classification"] in {"WRONG", "INCOMPLETE", "MISSING"} and item["risk"] == "HIGH" for item in items),
            },
            "analysis": {k: v for k, v in _read_json(self.paths.analysis_meta).items() if k != "commitments"},
        }

    def _append_event(self, event: dict[str, Any]) -> dict[str, Any]:
        audit = self._audits()
        event = {
            "id": f"evt-{len(audit) + 1:03d}",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            **event,
        }
        audit.append(event)
        _write_json(self.paths.audit, audit)
        return event

    def approve(self, finding_id: str, approved_by: str = "Dr. Amado Adams") -> dict[str, Any]:
        with self._lock:
            finding = next((item for item in self.findings()["findings"] if item["id"] == finding_id), None)
            if not finding:
                raise KeyError("Finding not found")
            if finding["classification"] not in {"WRONG", "INCOMPLETE", "MISSING"} or not finding["proposed_repair"]:
                raise ValueError("Finding has no applicable EHR repair")
            ehr = _read_json(self.paths.runtime_ehr)
            before: Any = finding["ehr_evidence"]
            repaired = copy.deepcopy(finding["proposed_repair"]["fhir_resource"])
            resource_type = repaired["resourceType"]
            resources = _resources(ehr, resource_type)
            existing_index = next((i for i, resource in enumerate(resources) if resource.get("id") == repaired.get("id")), None)
            if existing_index is None:
                resources.append(repaired)
            else:
                resources[existing_index] = repaired
            _write_json(self.paths.runtime_ehr, ehr)
            event = self._append_event({
                "finding_ref": finding_id,
                "action": "REPAIR_APPLIED",
                "evidence_quote": finding["commitment"]["verbatim_quote"],
                "before": before,
                "after": repaired,
                "approved_by": approved_by,
            })
            return {"event": event, **self.findings()}

    def reject(self, finding_id: str, reason: str, approved_by: str = "Dr. Amado Adams") -> dict[str, Any]:
        with self._lock:
            finding = next((item for item in self.findings()["findings"] if item["id"] == finding_id), None)
            if not finding:
                raise KeyError("Finding not found")
            if finding["classification"] not in {"WRONG", "INCOMPLETE", "MISSING"}:
                raise ValueError("Only unresolved EHR findings can be rejected")
            event = self._append_event({
                "finding_ref": finding_id,
                "action": "REJECTED",
                "evidence_quote": finding["commitment"]["verbatim_quote"],
                "before": finding["ehr_evidence"],
                "after": None,
                "approved_by": approved_by,
                "reason": reason or "Clinician declined the proposed repair",
            })
            return {"event": event, **self.findings()}

    def complete_external(self, finding_id: str, approved_by: str = "Dr. Amado Adams") -> dict[str, Any]:
        with self._lock:
            finding = next((item for item in self.findings()["findings"] if item["id"] == finding_id), None)
            if not finding:
                raise KeyError("Finding not found")
            if finding["classification"] != "NON_EHR_ACTION":
                raise ValueError("Only non-EHR actions can be manually completed")
            event = self._append_event({
                "finding_ref": finding_id,
                "action": "EXTERNAL_COMPLETED",
                "evidence_quote": finding["commitment"]["verbatim_quote"],
                "before": finding["ehr_evidence"],
                "after": {"status": "confirmed complete"},
                "approved_by": approved_by,
            })
            return {"event": event, **self.findings()}

    def audit_log(self) -> list[dict[str, Any]]:
        return list(reversed(self._audits()))
