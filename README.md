# Abridge Missing Order Sentinel

> The visit is not complete when the note is signed. It is complete when every agreed action is represented correctly in the EHR.

Sentinel reconciles commitments made in an ambient clinical conversation against the final FHIR record. It links every finding to an exact transcript quote, classifies discrepancies, proposes FHIR-shaped repairs, requires clinician approval, and records an auditable before/after trail.

## Demo case

The clinician and Julius Renner agree on eight actions. The synthetic post-visit EHR contains:

- a planted lisinopril dose discrepancy: 40 mg instead of 10 mg;
- a planted dental referral missing its gingivitis diagnosis;
- a naturally absent 4–6 week hypertension follow-up;
- four correctly represented actions and one external front-desk handoff.

The planted discrepancies and synthetic source data are disclosed intentionally. The public [seeding manifest](partner-provided-docs/seeded-stuff/seeding-manifest.json) is used only as a post-analysis scoring key and is never included in Claude's prompt. Other partner planning and QA documents remain local-only.

## Batch evaluation

The supplied validation distribution contains 25 encounters: 14 encounters with 18 disclosed discrepancies and 11 unmodified controls. The end-of-day worklist can analyze every encounter and reports expected versus detected results, seeded misses, and additional evidence-linked candidates.

“Unmodified” does not mean clinically gap-free: several original records contain transcript-supported follow-ups or handoffs that are naturally absent from FHIR. Findings outside the manifest are therefore shown as candidates for separate adjudication rather than automatically labeled false positives.

The repository loads the supplied `{patient-prefix}-ehr.json` bundle for each encounter when the local fixture archive is present. Julius retains a deterministic fallback so the core demo remains runnable without the private archive.

## Run locally

```bash
uv sync
uv run flask --app app run
```

Open `http://127.0.0.1:5000`.

Claude extraction runs when `ANTHROPIC_API_KEY` is available. Otherwise the app transparently uses its validated Julius extraction cache. Override the default model with `ANTHROPIC_MODEL`.

```bash
ANTHROPIC_API_KEY=... uv run flask --app app run
```

## Verify

```bash
uv run pytest
```

The app writes only to `.runtime/`. Resetting the demo restores the seeded EHR and clears the runtime audit log; the supplied Abridge dataset and partner fixtures are never modified.

## Safety boundary

This is a synthetic hackathon prototype. FHIR write-back is simulated. Applying a repair means the agreed action is represented in the working record; it does not claim that a prescription was dispensed, an appointment was booked, or care was completed in the real world.
