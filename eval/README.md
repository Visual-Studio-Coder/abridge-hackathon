# Team-derived evaluation set

We created this validation set from the 25 synthetic encounters supplied for the Abridge hackathon. Abridge did not provide these seeded EHR bundles or the evaluation manifest.

The set contains:

- 25 derived post-visit EHR bundles in `seeded-ehr/`;
- 18 disclosed discrepancies across 14 encounters;
- 11 unmodified controls; and
- `seeding-manifest.json`, the post-analysis scoring key.

The agent receives the encounter transcript and derived EHR bundle. It never receives the manifest. After analysis, Sentinel compares detected discrepancies with the manifest and reports seeded catches, seeded misses, and additional evidence-linked candidates separately.

All records are synthetic. The source dataset under `synthetic-ambient-fhir-25/` is never modified.
