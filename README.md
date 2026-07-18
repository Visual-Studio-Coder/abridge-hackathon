# Abridge Missing Order Sentinel

> The visit is not complete when the note is signed. It is complete when every agreed action is represented correctly in the EHR.

Sentinel reconciles commitments made in an ambient clinical conversation against the final FHIR record. It links every finding to an exact transcript quote, classifies discrepancies, proposes FHIR-shaped repairs, requires clinician approval, and records an auditable before/after trail.

Before a finding reaches the clinician, a second adversarial Claude pass attempts to reject it. Confirmed findings retain a clinician-readable safety rationale, downgraded findings carry a lower risk, and rejected findings remain inspectable in a collapsed suppression queue. The audit is batched once per encounter, cached with the analysis fingerprint, and fails open so an unavailable reviewer cannot block the demo. Neither analysis pass receives the evaluation manifest.

## Demo case

The clinician and Julius Renner agree on eight actions. The synthetic post-visit EHR contains:

- a planted lisinopril dose discrepancy: 40 mg instead of 10 mg;
- a planted dental referral missing its gingivitis diagnosis;
- a naturally absent 4–6 week hypertension follow-up;
- four correctly represented actions and one external front-desk handoff.

We derived a 25-encounter validation set by deterministically seeding the Abridge-provided synthetic dataset. The public [evaluation manifest](eval/seeding-manifest.json) is used only as a post-analysis scoring key and is never included in Claude's prompt. Internal partner planning documents remain local-only.

## Batch evaluation

Our derived validation distribution contains 25 encounters: 14 encounters with 18 disclosed discrepancies and 11 unmodified controls. The end-of-day worklist can analyze every encounter and reports expected versus detected results, seeded misses, and additional evidence-linked candidates.

“Unmodified” does not mean clinically gap-free: several original records contain transcript-supported follow-ups or handoffs that are naturally absent from FHIR. Findings outside the manifest are therefore shown as candidates for separate adjudication rather than automatically labeled false positives.

Scoring is resource-based: if the agent identifies the seeded resource as `WRONG`, `INCOMPLETE`, or `MISSING`, the discrepancy counts as caught. Any difference from the manifest's seeded classification is reported explicitly in the evaluation table rather than scored as a miss.

The repository includes and loads every derived `{patient-prefix}-ehr.json` bundle from [`eval/seeded-ehr`](eval/seeded-ehr), so a public clone can reproduce the complete batch evaluation. The original Abridge dataset remains unchanged.

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
