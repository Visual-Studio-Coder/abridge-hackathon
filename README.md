# Abridge Missing Order Sentinel

> The visit is not complete when the note is signed. It is complete when every agreed action is represented correctly in the EHR.

Sentinel reconciles commitments made in an ambient clinical conversation against the final FHIR record. It links every finding to an exact transcript quote, classifies discrepancies, proposes FHIR-shaped repairs, requires clinician approval, and records an auditable before/after trail.

## Demo case

The clinician and Julius Renner agree on eight actions. The synthetic post-visit EHR contains:

- a planted lisinopril dose discrepancy: 40 mg instead of 10 mg;
- a planted dental referral missing its gingivitis diagnosis;
- a naturally absent 4–6 week hypertension follow-up;
- four correctly represented actions and one external front-desk handoff.

The planted discrepancies and synthetic source data are disclosed intentionally. Internal partner planning and QA documents remain local-only and are excluded from Git.

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
