const state = {
  encounter: null,
  findings: [],
  summary: null,
  analysis: null,
  audit: null,
  selectedFinding: null,
  queue: [],
  queueSummary: null,
  selectedEncounterId: null,
  reviewFilter: "active",
  evaluation: null,
  activeDocument: "note",
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  }[character]));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload;
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("visible");
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => element.classList.remove("visible"), 3200);
}

function setBusy(button, busy, label = "Working…") {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.innerHTML;
    button.textContent = label;
    button.disabled = true;
  } else {
    button.innerHTML = button.dataset.label || button.innerHTML;
    button.disabled = false;
  }
}

function slug(value) { return value.toLowerCase().replaceAll("_", "-"); }

function setPatientContextVisible(visible) {
  $(".patient-chip").classList.toggle("hidden", !visible);
  $("#encounter-ribbon").classList.toggle("hidden", !visible);
}

function renderEncounter() {
  const { patient, metadata, practitioner } = state.encounter;
  $(".patient-chip .avatar").textContent = patient.initials;
  $("#patient-name").textContent = patient.name;
  $("#patient-meta").textContent = `DOB ${patient.birth_date} · ${patient.location}`;
  $("#encounter-ribbon").innerHTML = `
    <strong>${escapeHtml(metadata.visit_title)}</strong>
    <span class="ribbon-separator"></span>
    <span>${new Date(metadata.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
    <span class="ribbon-separator"></span>
    <span>${escapeHtml(practitioner)}</span>
    <span class="ribbon-separator"></span>
    <span>Encounter ${escapeHtml(metadata.encounter_id.slice(0, 8))}</span>
    <span class="badge ok">SYNTHETIC</span>`;
  $("#encounter-ribbon").classList.add("loaded");
  renderTranscript();
  renderClinicalDocument();
  renderFhir();
}

function renderAnalysisShell() {
  renderQueue();
}

function renderQueue() {
  if (!state.queueSummary) return;
  $("#nav-issue-count").textContent = state.queueSummary.needs_action;
  $("#queue-summary").textContent = `${state.queueSummary.encounters} encounters · ${state.queueSummary.analyzed} analyzed · ${state.queueSummary.needs_action} items need action`;
  $("#review-queue").innerHTML = state.queue.map((row) => {
    const issues = row.summary?.needs_action || 0;
    const highRisk = row.summary?.high_risk || 0;
    const verified = row.summary?.verified || 0;
    const status = row.analyzed
      ? issues
        ? `<span class="queue-status ${highRisk ? "issue" : "action"}"><span class="queue-count">${issues}</span> need action${highRisk ? ` · ${highRisk} high risk` : ""}<b>›</b></span>`
        : `<span class="queue-status clear">all ${verified} verified ✓</span>`
      : '<span class="queue-status pending">not analyzed <b>· analyze</b></span>';
    const visit = row.visit_title.replace(/—/g, "·");
    return `<button class="queue-row ${highRisk ? "has-high-risk" : ""}" data-encounter-id="${escapeHtml(row.id)}">
      <span class="queue-avatar">${escapeHtml(row.initials)}</span>
      <span class="queue-patient"><strong>${escapeHtml(row.name)}</strong><small>${escapeHtml(visit)} · ${new Date(row.date).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</small></span>
      ${status}
    </button>`;
  }).join("");
  $$("[data-encounter-id]").forEach((row) => row.addEventListener("click", () => openPatientReview(row.dataset.encounterId)));
}

async function loadQueue() {
  const payload = await api("/api/review-queue");
  state.queue = payload.encounters;
  state.queueSummary = payload.summary;
  renderQueue();
}

function renderEvaluation() {
  if (!state.evaluation) return;
  const summary = state.evaluation.summary;
  const pending = summary.encounters - summary.analyzed;
  const metrics = [
    ["Seeded discrepancies", summary.expected_discrepancies, "across 14 encounters"],
    ["Caught", `${summary.caught}/${summary.expected_discrepancies}`, pending ? `${pending} encounters pending` : `${summary.missed || 0} seeded misses`],
    ["Unmodified controls", summary.clean_controls, "no deliberate mutation"],
    ["Additional candidates", summary.additional_candidates, "separate adjudication queue"],
  ];
  $("#evaluation-metrics").innerHTML = metrics.map(([label, value, detail]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small></div>`).join("");
  $("#evaluation-rows").innerHTML = state.evaluation.rows.map((row) => `<tr>
    <td><strong>${escapeHtml(row.patient)}</strong><small>${escapeHtml(row.visit_title)}</small></td>
    <td><span class="eval-set ${row.control ? "control" : "seeded"}">${row.control ? "UNMODIFIED" : "SEEDED"}</span></td>
    <td>${row.expected}</td><td>${row.analyzed ? row.detected : "—"}</td><td>${row.analyzed ? row.caught : "—"}</td>
    <td><span class="eval-status ${slug(row.status)}">${escapeHtml(row.status)}</span>${(row.classification_variants || []).map((variant) => `<small class="eval-classification-note">${escapeHtml(variant.resource)}: classified as ${escapeHtml(variant.classified_as)}, seeded as ${escapeHtml(variant.seeded_as)}</small>`).join("")}</td>
  </tr>`).join("");
}

async function loadEvaluation() {
  state.evaluation = await api("/api/evaluation");
  renderEvaluation();
}

async function openPatientReview(encounterId) {
  state.selectedEncounterId = encounterId;
  state.reviewFilter = "active";
  const row = state.queue.find((item) => item.id === encounterId);
  state.encounter = await api(`/api/encounters/${encodeURIComponent(encounterId)}`);
  $("#review-patient-name").textContent = row?.name || state.encounter.patient.name;
  const analyzeButton = $("#rerun-analysis");
  analyzeButton.classList.remove("hidden");
  analyzeButton.textContent = row?.analyzed ? "Re-run analysis" : "Analyze patient";
  $("#queue-view").classList.add("hidden");
  $("#patient-review").classList.remove("hidden");
  setPatientContextVisible(true);
  const payload = await api(`/api/encounters/${encodeURIComponent(encounterId)}/findings`);
  if (payload.findings?.length) {
    state.findings = payload.findings;
    state.summary = payload.summary;
    state.analysis = payload.analysis;
    state.audit = payload.audit || null;
    renderEncounter();
    renderLinkedReview();
  } else {
    state.findings = [];
    state.summary = null;
    state.analysis = null;
    state.audit = null;
    renderEncounter();
    renderUnanalyzedReview();
  }
}

function renderUnanalyzedReview() {
  renderLinkedTranscript([]);
  $("#review-analysis-status").innerHTML = '<span class="status-dot pending-dot"></span>This encounter has not been analyzed yet.';
  $("#linked-findings").innerHTML = '<div class="linked-empty"><strong>Ready for background reconciliation</strong><p>The encounter loader is generic. Julius is the validated cached demo patient.</p></div>';
  $("#verified-rollup-label").textContent = "No verified items yet";
  $("#verified-rollup-content").innerHTML = "";
  $("#suppressed-rollup").classList.add("hidden");
  $("#suppressed-rollup-content").innerHTML = "";
  $("#compact-audit").textContent = "No analysis or actions recorded for this encounter.";
}

function renderLinkedReview() {
  renderLinkedTranscript(state.findings);
  const suppressed = state.findings.filter((item) => item.auditor?.verdict === "REJECTED");
  const visible = state.findings.filter((item) => item.auditor?.verdict !== "REJECTED");
  const completedStates = ["APPLIED", "COMPLETE", "REJECTED", "ACCEPTED_FOR_FOLLOWUP"];
  const completed = visible.filter((item) => completedStates.includes(item.workflow_state));
  const issues = visible.filter((item) => ["WRONG", "INCOMPLETE", "MISSING"].includes(item.classification) && !completedStates.includes(item.workflow_state));
  const verified = visible.filter((item) => item.classification === "OK");
  const external = visible.filter((item) => item.classification === "NON_EHR_ACTION");
  const confirmed = visible.filter((item) => item.auditor?.verdict === "CONFIRMED").length;
  const downgraded = visible.filter((item) => item.auditor?.verdict === "DOWNGRADED").length;
  const auditCopy = state.audit?.status === "complete"
    ? `${visible.length} findings · ${confirmed} confirmed${downgraded ? ` · ${downgraded} downgraded` : ""} · ${suppressed.length} suppressed`
    : `${visible.length} findings · audit unavailable`;
  $("#review-analysis-status").innerHTML = `<span class="status-dot ${state.audit?.status === "complete" ? "" : "pending-dot"}"></span>${state.analysis?.mode === "live" ? "Live Claude analysis" : "Validated cache"} · ${auditCopy}`;
  $("#active-findings-count").textContent = issues.length;
  $("#completed-findings-count").textContent = completed.length;
  $$('[data-review-filter]').forEach((button) => button.classList.toggle('active', button.dataset.reviewFilter === state.reviewFilter));
  if (state.reviewFilter === "completed") {
    $("#linked-findings").innerHTML = completed.length ? completed.map(completedFindingCard).join("") : '<div class="linked-empty"><strong>No completed reviews yet</strong><p>Approved or rejected actions will remain reversible here.</p></div>';
  } else {
    $("#linked-findings").innerHTML = issues.length ? issues.map(linkedFindingCard).join("") : '<div class="linked-empty success"><strong>All EHR discrepancies resolved</strong><p>Completed actions remain available in the Completed tab.</p></div>';
  }
  $("#suppressed-rollup").classList.toggle("hidden", !suppressed.length);
  $("#suppressed-rollup-label").textContent = `Suppressed by auditor (${suppressed.length})`;
  $("#suppressed-rollup-content").innerHTML = suppressed.map((item) => `<article class="linked-finding suppressed-finding" data-linked-finding="${item.id}"><strong>${escapeHtml(item.classification)} · ${escapeHtml(item.category)}</strong><h3>${escapeHtml(item.commitment.description)}</h3><p>✕ Auditor: ${escapeHtml(item.auditor.reasoning)}</p></article>`).join("");
  $("#verified-rollup-label").textContent = `${verified.length} items verified correct · ${external.length} non-EHR action`;
  $("#verified-rollup-content").innerHTML = [...verified, ...external].map((item) => `<button data-linked-finding="${item.id}"><span>✓</span>${escapeHtml(item.commitment.description)}</button>`).join("");
  $$('[data-linked-finding]').forEach((card) => card.addEventListener('click', (event) => {
    if (event.target.closest('[data-review]')) return;
    highlightEvidence(card.dataset.linkedFinding);
  }));
  $$('[data-review]').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    openRepair(button.dataset.review);
  }));
  $$('[data-undo]').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    undoFinding(button.dataset.undo);
  }));
  renderCompactAudit();
}

function completedFindingCard(finding) {
  const actionLabel = finding.workflow_state === "REJECTED" ? "Rejected" : finding.workflow_state === "COMPLETE" ? "Completed" : finding.workflow_state === "ACCEPTED_FOR_FOLLOWUP" ? "Accepted for follow-up" : "Repair applied";
  const detail = finding.last_event?.repair_summary || finding.last_event?.reason || finding.commitment.description;
  return `<article class="linked-finding completed-finding" data-linked-finding="${finding.id}">
    <div class="linked-finding-top"><strong>✓ ${escapeHtml(actionLabel)} · ${escapeHtml(finding.category)}</strong><span>${escapeHtml(finding.last_event?.approved_by || "Clinician reviewed")}</span></div>
    <h3>${escapeHtml(finding.commitment.description)}</h3>
    <p>${escapeHtml(detail)}</p>
    <div class="linked-card-actions"><button class="button button-quiet undo-button" data-undo="${finding.id}">Undo</button><span>${escapeHtml(finding.workflow_state.replaceAll("_", " "))}</span></div>
  </article>`;
}

function linkedFindingCard(finding) {
  const applied = finding.workflow_state === "APPLIED";
  const canApply = finding.proposed_repair && finding.apply_supported !== false;
  const canReview = Boolean(finding.proposed_repair);
  const auditor = finding.auditor || {};
  const auditorCopy = auditor.status === "complete"
    ? `${auditor.verdict === "DOWNGRADED" ? "↓" : "✓"} Auditor: ${auditor.verdict.toLowerCase()} — ${auditor.reasoning}`
    : `○ Auditor: ${auditor.reasoning || "audit unavailable"}`;
  return `<article class="linked-finding ${slug(finding.classification)} ${applied ? "is-applied" : ""}" data-linked-finding="${finding.id}">
    <div class="linked-finding-top"><strong>${escapeHtml(finding.classification)} · ${escapeHtml(finding.category)}</strong><span>${escapeHtml(finding.risk)} RISK · quote verified ✓</span></div>
    <h3>${escapeHtml(finding.commitment.description)}</h3>
    <p>${escapeHtml(finding.ehr_evidence.current_state)}</p>
    ${finding.proposed_repair ? `<p class="repair-copy"><b>Repair:</b> ${escapeHtml(finding.proposed_repair.summary)}</p>` : ""}
    <p class="auditor-line ${escapeHtml((auditor.verdict || "unavailable").toLowerCase())}">${escapeHtml(auditorCopy)}</p>
    <div class="linked-card-actions">${canReview ? `<button class="button ${canApply ? "button-primary" : "button-secondary"}" data-review="${finding.id}">${canApply ? "Review & approve" : "Review suggestion"}</button>` : ""}<span>${finding.proposed_repair && !canApply ? "SUGGESTED ACTION · " : ""}${escapeHtml(finding.workflow_state.replaceAll("_", " "))}</span></div>
  </article>`;
}

function renderLinkedTranscript(findings) {
  const byQuote = new Map(findings.map((finding) => [finding.commitment.verbatim_quote.toLowerCase(), finding.id]));
  $("#linked-transcript").innerHTML = state.encounter.transcript.split("\n").filter(Boolean).map((line) => {
    const match = line.match(/^(DR|PT|NURSE|FAMILY):\s*(.*)$/);
    const speaker = match ? match[1] : "—";
    let text = escapeHtml(match ? match[2] : line);
    byQuote.forEach((id, quote) => {
      const original = findings.find((item) => item.id === id).commitment.verbatim_quote;
      const escaped = escapeHtml(original);
      text = text.replace(escaped, `<mark class="linked-mark" data-evidence-for="${id}">${escaped}</mark>`);
    });
    return `<div class="linked-utterance ${speaker === "DR" ? "doctor" : "patient"}"><span>${speaker}</span><p>${text}</p></div>`;
  }).join("");
}

function highlightEvidence(findingId) {
  $$('.linked-finding').forEach((card) => card.classList.toggle('selected', card.dataset.linkedFinding === findingId));
  $$('.linked-mark').forEach((mark) => mark.classList.toggle('active', mark.dataset.evidenceFor === findingId));
  const mark = $(`[data-evidence-for="${findingId}"]`);
  if (mark) mark.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function renderCompactAudit() {
  const payload = await api('/api/audit');
  $("#compact-audit").innerHTML = payload.events.length ? payload.events.slice(0, 3).map((event) => `<div><time>${new Date(event.timestamp).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'})}</time><b>${escapeHtml(event.action.replaceAll('_', ' '))}</b><span>${escapeHtml(event.finding_ref)} · approved by ${escapeHtml(event.approved_by)}</span></div>`).join('') : 'No actions taken in this review.';
}

function renderStats() {
  const cards = [
    ["Commitments captured", state.summary.commitments, "Evidence-linked actions", ""],
    ["Needs clinician review", state.summary.needs_action, `${state.summary.high_risk} high-risk`, state.summary.needs_action ? "alert" : ""],
    ["Verified in EHR", state.summary.verified, "No intervention needed", ""],
    ["External handoffs", state.summary.external, "Manual confirmation only", ""],
  ];
  $("#summary-stats").innerHTML = cards.map(([label, value, detail, kind]) => `
    <div class="stat-card ${kind}"><span>${label}</span><strong>${value}</strong><small>${detail}</small></div>`).join("");
}

function renderFindings() {
  renderStats();
  $("#nav-issue-count").textContent = state.summary.needs_action;
  $("#analysis-copy").textContent = state.analysis.mode === "live" ? "Live Claude analysis verified" : "Validated analysis cache";
  $("#analysis-detail").textContent = `${state.analysis.message} · ${state.analysis.model || "claude-sonnet-5"} · trace ${state.analysis.fingerprint || "ready"}`;

  const categories = ["Medication", "Referral", "Follow-up", "Immunization", "External"];
  $("#findings-list").innerHTML = categories.map((category) => {
    const items = state.findings.filter((finding) => finding.category === category && finding.auditor?.verdict !== "REJECTED");
    if (!items.length) return "";
    return `<section class="finding-group"><h3>${category}<span class="group-count">${items.length}</span></h3>${items.map(findingCard).join("")}</section>`;
  }).join("");

  $$("[data-review]").forEach((button) => button.addEventListener("click", () => openRepair(button.dataset.review)));
  $$("[data-complete-external]").forEach((button) => button.addEventListener("click", () => completeExternal(button.dataset.completeExternal)));
}

function findingCard(finding) {
  const issue = ["WRONG", "INCOMPLETE", "MISSING"].includes(finding.classification);
  const external = finding.classification === "NON_EHR_ACTION";
  const applied = finding.workflow_state === "APPLIED";
  const visualClass = applied ? "applied" : issue ? "issue" : external ? "external" : "verified";
  const statusIcon = applied || finding.classification === "OK" || finding.workflow_state === "COMPLETE" ? "✓" : external ? "○" : "!";
  const action = issue && finding.proposed_repair
    ? `<button class="button button-secondary" data-review="${finding.id}">Review repair</button>`
    : external && finding.workflow_state !== "COMPLETE"
      ? `<button class="button button-secondary" data-complete-external="${finding.id}">Confirm complete</button>`
      : `<span class="badge ${finding.workflow_state === "APPLIED" ? "ok" : ""}">${finding.workflow_state.replaceAll("_", " ")}</span>`;
  return `
    <article class="finding-card ${visualClass}">
      <div class="check-state" aria-label="${escapeHtml(finding.workflow_state)}">${statusIcon}</div>
      <div class="finding-main">
        <h3>${escapeHtml(finding.commitment.description)}</h3>
        <div class="finding-meta">
          <span class="badge ${slug(finding.classification)}">${finding.classification.replaceAll("_", " ")}</span>
          ${finding.risk === "HIGH" ? '<span class="badge high">HIGH RISK</span>' : ""}
          ${finding.commitment.due_window ? `<span class="due">Due ${escapeHtml(finding.commitment.due_window)}</span>` : ""}
        </div>
      </div>
      <div class="evidence-cell">
        <div class="evidence-label">EHR evidence</div>
        <p>${escapeHtml(finding.ehr_evidence.current_state)}</p>
      </div>
      <div class="finding-actions">${action}</div>
      <details class="trace">
        <summary>Show AI trace and source evidence</summary>
        <div class="trace-grid">
          <div class="trace-step"><strong>1 · Extracted commitment</strong><span>“${escapeHtml(finding.commitment.verbatim_quote)}”</span></div>
          <div class="trace-step"><strong>2 · Evidence verified</strong><span>Exact transcript match at characters ${finding.commitment.quote_start}–${finding.commitment.quote_end}</span></div>
          <div class="trace-step"><strong>3 · Reconciled</strong><span>${escapeHtml(finding.reconciliation_rule)}</span></div>
        </div>
      </details>
    </article>`;
}

function renderInlineRepairDiff(before, after) {
  const container = $("#repair-inline-diff");
  const beforeTokens = String(before || "").match(/\s+|[^\s]+/g) || [];
  const afterTokens = String(after || "").match(/\s+|[^\s]+/g) || [];
  let prefix = 0;
  while (prefix < beforeTokens.length && prefix < afterTokens.length && beforeTokens[prefix] === afterTokens[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < beforeTokens.length - prefix && suffix < afterTokens.length - prefix
    && beforeTokens[beforeTokens.length - 1 - suffix] === afterTokens[afterTokens.length - 1 - suffix]
  ) suffix += 1;

  const commonBefore = beforeTokens.slice(0, prefix).join("");
  const removed = beforeTokens.slice(prefix, beforeTokens.length - suffix).join("");
  const added = afterTokens.slice(prefix, afterTokens.length - suffix).join("");
  const commonAfter = suffix ? afterTokens.slice(afterTokens.length - suffix).join("") : "";
  container.replaceChildren();
  if (commonBefore) container.append(document.createTextNode(commonBefore));
  if (removed) {
    const deleted = document.createElement("del");
    deleted.textContent = removed;
    container.append(deleted);
  }
  if (removed && added) {
    const arrow = document.createElement("span");
    arrow.className = "change-arrow";
    arrow.textContent = "→";
    arrow.setAttribute("aria-hidden", "true");
    container.append(arrow);
  }
  if (added) {
    const inserted = document.createElement("ins");
    inserted.textContent = added;
    container.append(inserted);
  }
  if (commonAfter) container.append(document.createTextNode(commonAfter));
}

function openRepair(id) {
  const finding = state.findings.find((item) => item.id === id);
  if (!finding) return;
  state.selectedFinding = finding;
  const appliesToEhr = finding.apply_supported !== false;
  $("#dialog-title").textContent = finding.proposed_repair.summary;
  const resource = finding.proposed_repair.fhir_resource;
  let editableFields = "";
  let diffLabel = finding.ehr_evidence.resource_type || "Follow-up action";
  let beforeValue = finding.ehr_evidence.current_state;
  let diffField = "repair_summary";
  if (finding.id === "med-lisinopril") {
    editableFields = `<label class="repair-field"><span>Corrected medication order</span><input name="medication_text" value="${escapeHtml(resource.medicationCodeableConcept?.text || "")}" required></label>`;
    diffLabel = "Medication order";
    diffField = "medication_text";
  } else if (finding.id === "ref-dental") {
    editableFields = `<label class="repair-field"><span>Referral diagnosis</span><input name="diagnosis_text" value="${escapeHtml(resource.reasonCode?.[0]?.text || "Gingivitis")}" required></label>`;
    diffLabel = "Referral diagnosis";
    beforeValue = "No diagnosis attached";
    diffField = "diagnosis_text";
  } else if (finding.id === "followup-bp") {
    editableFields = `<div class="repair-field-row"><label class="repair-field"><span>Window starts</span><input type="date" name="start_date" value="${escapeHtml(resource.requestedPeriod?.[0]?.start?.slice(0, 10) || "")}" required></label><label class="repair-field"><span>Window ends</span><input type="date" name="end_date" value="${escapeHtml(resource.requestedPeriod?.[0]?.end?.slice(0, 10) || "")}" required></label></div><label class="repair-field"><span>Visit reason</span><input name="description" value="${escapeHtml(resource.description || "")}" required></label><label class="repair-field"><span>Scheduling note</span><textarea name="comment" rows="2">${escapeHtml(resource.comment || "")}</textarea></label>`;
    diffLabel = "Follow-up window";
    beforeValue = "No appointment represented";
    diffField = "date_window";
  }
  $("#dialog-body").innerHTML = `
    <div class="repair-content">
      <div class="repair-alert"><strong>${finding.risk} RISK</strong><span>${escapeHtml(finding.proposed_repair.risk_note)}</span></div>
      <div class="evidence-label">Conversation evidence · verified</div>
      <blockquote class="quote-block">“${escapeHtml(finding.commitment.verbatim_quote)}”</blockquote>
      <section class="live-change-preview" aria-live="polite">
        <span class="change-preview-label">${escapeHtml(diffLabel)}</span>
        <div class="change-values" id="repair-inline-diff"></div>
      </section>
      <section class="repair-form-card"><div class="repair-form-heading"><span>${appliesToEhr ? "Proposed correction" : "Suggested follow-up"}</span><small>Editable before acceptance</small></div>${editableFields}<label class="repair-field"><span>Action summary</span><textarea name="repair_summary" rows="2" required>${escapeHtml(finding.proposed_repair.summary)}</textarea></label></section>
      <section id="rejection-panel" class="rejection-panel hidden"><label class="repair-field"><span>Reason for rejection</span><textarea name="rejection_reason" rows="2" placeholder="Optional clinical rationale"></textarea></label><small>This decision will move to Completed and can be undone.</small></section>
      <p class="subtle" style="margin-top:14px">${appliesToEhr ? "Approval updates only the simulated working EHR. It does not claim real-world completion." : "Acceptance adds this suggestion to the reviewed follow-up queue; it does not write to the EHR or claim completion."}</p>
    </div>`;
  $("#approve-repair").textContent = appliesToEhr ? "Approve & apply repair" : "Accept for follow-up";
  $("#reject-repair").textContent = "Reject";
  const repairForm = $("#dialog-body").closest("form");
  const updateChangePreview = () => {
    let value = "";
    if (diffField === "date_window") {
      const start = repairForm.elements.start_date?.value;
      const end = repairForm.elements.end_date?.value;
      const displayDate = (date) => date ? new Date(`${date}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—";
      value = `${displayDate(start)} – ${displayDate(end)}`;
    } else {
      value = repairForm.elements[diffField]?.value || "—";
    }
    renderInlineRepairDiff(beforeValue, value);
  };
  $$('input, textarea', repairForm).forEach((field) => field.addEventListener('input', updateChangePreview));
  updateChangePreview();
  $("#repair-dialog").showModal();
}

async function approveSelected() {
  if (!state.selectedFinding) return;
  const button = $("#approve-repair");
  setBusy(button, true, "Applying…");
  try {
    const fields = new FormData($("#dialog-body").closest("form"));
    const edits = Object.fromEntries(fields.entries());
    const isGeneric = state.selectedFinding.apply_supported === false;
    const endpoint = isGeneric
      ? `/api/encounters/${encodeURIComponent(state.selectedEncounterId)}/findings/${state.selectedFinding.id}/accept-suggestion`
      : `/api/findings/${state.selectedFinding.id}/approve`;
    const payload = await api(endpoint, { method: "POST", body: JSON.stringify({ edits }) });
    updateFindingState(payload);
    state.reviewFilter = "completed";
    renderLinkedReview();
    $("#repair-dialog").close();
    toast(isGeneric ? "Suggestion accepted for follow-up" : "Repair applied to the simulated FHIR record");
    await refreshEncounterAndAudit();
  } catch (error) { toast(error.message); }
  finally { setBusy(button, false); }
}

async function undoFinding(id) {
  if (!window.confirm("Undo this clinician decision and restore the prior chart state?")) return;
  try {
    const finding = state.findings.find((item) => item.id === id);
    const endpoint = finding?.apply_supported === false
      ? `/api/encounters/${encodeURIComponent(state.selectedEncounterId)}/findings/${id}/undo-suggestion`
      : `/api/findings/${id}/undo`;
    const payload = await api(endpoint, { method: "POST", body: "{}" });
    updateFindingState(payload);
    state.reviewFilter = "active";
    renderLinkedReview();
    toast("Action undone · prior chart state restored");
    await refreshEncounterAndAudit();
  } catch (error) { toast(error.message); }
}

async function rejectSelected() {
  if (!state.selectedFinding) return;
  const panel = $("#rejection-panel");
  if (panel.classList.contains("hidden")) {
    panel.classList.remove("hidden");
    $("#reject-repair").textContent = "Confirm rejection";
    panel.querySelector("textarea").focus();
    return;
  }
  const reason = panel.querySelector("textarea").value.trim();
  const button = $("#reject-repair");
  setBusy(button, true, "Rejecting…");
  try {
    const isGeneric = state.selectedFinding.apply_supported === false;
    const endpoint = isGeneric
      ? `/api/encounters/${encodeURIComponent(state.selectedEncounterId)}/findings/${state.selectedFinding.id}/reject-suggestion`
      : `/api/findings/${state.selectedFinding.id}/reject`;
    const payload = await api(endpoint, { method: "POST", body: JSON.stringify({ reason }) });
    updateFindingState(payload);
    state.reviewFilter = "completed";
    renderLinkedReview();
    $("#repair-dialog").close();
    toast(isGeneric ? "Suggestion rejected and moved to Completed" : "Repair rejected and audit event recorded");
    await renderAudit();
  } catch (error) { toast(error.message); }
  finally { setBusy(button, false); }
}

async function completeExternal(id) {
  try {
    const payload = await api(`/api/findings/${id}/complete-external`, { method: "POST", body: "{}" });
    updateFindingState(payload);
    toast("External handoff confirmed");
    await renderAudit();
  } catch (error) { toast(error.message); }
}

function updateFindingState(payload) {
  state.findings = payload.findings;
  state.summary = payload.summary;
  state.analysis = payload.analysis;
  state.audit = payload.audit || null;
  if (!$("#patient-review").classList.contains("hidden")) renderLinkedReview();
  else renderQueue();
}

async function runAnalysis(button) {
  setBusy(button, true, "Reconciling…");
  try {
    const payload = await api("/api/analyze", { method: "POST", body: "{}" });
    updateFindingState(payload);
    renderAnalysisShell();
    toast(payload.analysis.mode === "live" ? "Live Claude analysis complete" : "Validated fallback analysis loaded");
  } catch (error) { toast(error.message); }
  finally { setBusy(button, false); }
}

async function runSelectedAnalysis(button) {
  if (!state.selectedEncounterId) return;
  setBusy(button, true, "Reconciling…");
  try {
    const payload = await api(`/api/encounters/${encodeURIComponent(state.selectedEncounterId)}/analyze`, { method: "POST", body: "{}" });
    state.findings = payload.findings;
    state.summary = payload.summary;
    state.analysis = payload.analysis;
    state.audit = payload.audit || null;
    renderLinkedReview();
    await loadQueue();
    await loadEvaluation();
    button.dataset.label = "Re-run analysis";
    toast(payload.analysis.mode === "live" ? "Live Claude reconciliation complete" : "Validated cache loaded");
  } catch (error) { toast(error.message); }
  finally { setBusy(button, false); }
}

async function analyzeAll(button) {
  const pending = state.queue.filter((row) => !row.analyzed || row.audit_status !== "complete");
  if (!pending.length) {
    toast("Every encounter in today’s worklist is already analyzed");
    return;
  }
  setBusy(button, true, `Analyzing 0/${pending.length}…`);
  let completed = 0;
  let failed = 0;
  for (const row of pending) {
    button.textContent = `Analyzing ${completed + failed + 1}/${pending.length}…`;
    try {
      await api(`/api/encounters/${encodeURIComponent(row.id)}/analyze`, { method: "POST", body: "{}" });
      completed += 1;
    } catch (_error) {
      failed += 1;
    }
  }
  await loadQueue();
  await loadEvaluation();
  setBusy(button, false);
  toast(failed ? `${completed} encounters analyzed · ${failed} need retry` : `${completed} encounters analyzed with Claude`);
}

function renderTranscript() {
  const quotes = state.findings.map((finding) => finding.commitment.verbatim_quote).filter(Boolean);
  const lines = state.encounter.transcript.split("\n").filter(Boolean);
  $("#transcript-content").innerHTML = lines.map((line) => {
    const match = line.match(/^(DR|PT|NURSE|FAMILY):\s*(.*)$/);
    const speaker = match ? match[1] : "—";
    let text = escapeHtml(match ? match[2] : line);
    quotes.forEach((quote) => {
      const escaped = escapeHtml(quote);
      text = text.replace(escaped, `<mark>${escaped}</mark>`);
    });
    return `<div class="utterance ${speaker === "DR" ? "doctor" : "patient"}"><span class="speaker">${speaker}</span><p>${text}</p></div>`;
  }).join("");
}

function renderMarkdown(value) {
  const safe = escapeHtml(value);
  return safe.split("\n").map((line) => {
    if (line.startsWith("### ")) return `<h3>${line.slice(4)}</h3>`;
    if (line.startsWith("**") && line.endsWith("**")) return `<h2>${line.slice(2, -2)}</h2>`;
    if (line.startsWith("- ")) return `<li>${line.slice(2)}</li>`;
    if (line.startsWith("• ")) return `<li>${line.slice(2)}</li>`;
    if (!line.trim()) return "";
    return `<p>${line.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</p>`;
  }).join("").replace(/(<li>.*?<\/li>)+/gs, (list) => `<ul>${list}</ul>`);
}

function renderClinicalDocument() {
  const value = state.activeDocument === "note" ? state.encounter.note : state.encounter.after_visit_summary;
  $("#clinical-document").innerHTML = renderMarkdown(value);
}

function resourceLabel(resource) {
  return resource.medicationCodeableConcept?.text
    || resource.code?.text
    || resource.vaccineCode?.text
    || resource.description
    || resource.type?.[0]?.text
    || resource.resourceType;
}

function resourceStatus(resource) {
  return resource.status || resource.clinicalStatus?.coding?.[0]?.code || resource.intent || "recorded";
}

function renderFhir() {
  const ehr = state.encounter.ehr;
  const groups = Object.entries(ehr.resources || {});
  $("#fhir-summary").innerHTML = groups.map(([type, resources]) => `
    <section class="resource-group">
      <div class="resource-heading"><h3>${escapeHtml(type)}</h3><span class="resource-count">${resources.length} resource${resources.length === 1 ? "" : "s"}</span></div>
      <table class="resource-table"><thead><tr><th>Resource ID</th><th>Clinical content</th><th>Status</th></tr></thead>
      <tbody>${resources.map((resource) => `<tr><td><code>${escapeHtml(resource.id || "generated")}</code></td><td>${escapeHtml(resourceLabel(resource))}</td><td>${escapeHtml(resourceStatus(resource))}</td></tr>`).join("")}</tbody></table>
    </section>`).join("");
  $("#fhir-raw code").textContent = JSON.stringify(ehr, null, 2);
}

async function renderAudit() {
  const payload = await api("/api/audit");
  const element = $("#audit-list");
  if (!payload.events.length) {
    element.innerHTML = '<div class="audit-empty"><strong>No actions recorded yet</strong><p>Clinician approvals, rejections, and external confirmations will appear here.</p></div>';
    return;
  }
  element.innerHTML = payload.events.map((event) => `
    <article class="audit-event">
      <time class="audit-time">${new Date(event.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}</time>
      <div class="audit-rail"><span class="audit-node">✓</span></div>
      <div class="audit-body">
        <h3>${escapeHtml(event.action.replaceAll("_", " "))} · ${escapeHtml(event.finding_ref)}</h3>
        <p>Approved by ${escapeHtml(event.approved_by)} · Evidence: “${escapeHtml(event.evidence_quote)}”</p>
        <div class="audit-diff"><div class="diff-pane"><strong>Before</strong><code>${escapeHtml(JSON.stringify(event.before))}</code></div><div class="diff-pane"><strong>After</strong><code>${escapeHtml(JSON.stringify(event.after))}</code></div></div>
      </div>
    </article>`).join("");
}

async function refreshEncounterAndAudit() {
  state.encounter = await api("/api/encounter");
  renderFhir();
  if (!$("#patient-review").classList.contains("hidden")) renderLinkedReview();
  await renderAudit();
  await loadQueue();
  await loadEvaluation();
}

function setupNavigation() {
  $$(".nav-item").forEach((button) => button.addEventListener("click", async () => {
    $$(".nav-item").forEach((item) => item.classList.toggle("active", item === button));
    $$(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `tab-${button.dataset.tab}`));
    $("#page-title").textContent = $(`#tab-${button.dataset.tab}`).dataset.title;
    if (button.dataset.tab === "audit") await renderAudit();
  }));
  $$(".subtab").forEach((button) => button.addEventListener("click", () => {
    $$(".subtab").forEach((item) => item.classList.toggle("active", item === button));
    state.activeDocument = button.dataset.doc;
    renderClinicalDocument();
  }));
  $$('[data-review-filter]').forEach((button) => button.addEventListener('click', () => {
    state.reviewFilter = button.dataset.reviewFilter;
    renderLinkedReview();
  }));
}

async function resetDemo() {
  if (!window.confirm("Restore the seeded EHR and clear approvals and the audit trail? Cached analysis will be preserved.")) return;
  const button = $("#reset-demo");
  setBusy(button, true, "Resetting…");
  try {
    const reset = await api("/api/demo/reset", { method: "POST", body: "{}" });
    const [encounter, findings] = await Promise.all([api("/api/encounter"), api("/api/findings")]);
    state.encounter = encounter;
    state.findings = findings.findings;
    state.summary = findings.summary;
    state.analysis = findings.analysis;
    state.audit = findings.audit || null;
    renderEncounter();
    await loadQueue();
    await loadEvaluation();
    $("#patient-review").classList.add("hidden");
    $("#queue-view").classList.remove("hidden");
    setPatientContextVisible(false);
    await renderAudit();
    toast(reset.analysis_preserved ? "Approvals cleared · cached analysis preserved" : "Demo restored to the seeded EHR state");
  } catch (error) { toast(error.message); }
  finally { setBusy(button, false); }
}

async function init() {
  setupNavigation();
  $("#rerun-analysis").addEventListener("click", (event) => runSelectedAnalysis(event.currentTarget));
  $("#back-to-queue").addEventListener("click", () => { $("#patient-review").classList.add("hidden"); $("#queue-view").classList.remove("hidden"); setPatientContextVisible(false); });
  $("#analyze-all").addEventListener("click", (event) => analyzeAll(event.currentTarget));
  $("#approve-repair").addEventListener("click", approveSelected);
  $("#reject-repair").addEventListener("click", rejectSelected);
  $("#reset-demo").addEventListener("click", resetDemo);
  $("#toggle-raw").addEventListener("click", (event) => {
    const raw = $("#fhir-raw");
    raw.classList.toggle("hidden");
    event.currentTarget.textContent = raw.classList.contains("hidden") ? "View raw JSON" : "Hide raw JSON";
  });

  try {
    const [encounter, findings, queue, evaluation] = await Promise.all([api("/api/encounter"), api("/api/findings"), api("/api/review-queue"), api("/api/evaluation")]);
    state.encounter = encounter;
    state.findings = findings.findings;
    state.summary = findings.summary;
    state.analysis = findings.analysis;
    state.audit = findings.audit || null;
    state.queue = queue.encounters;
    state.queueSummary = queue.summary;
    state.evaluation = evaluation;
    renderEncounter();
    renderAnalysisShell();
    setPatientContextVisible(false);
    renderEvaluation();
    await renderAudit();
  } catch (error) {
    toast(`Unable to load encounter: ${error.message}`);
  }
}

document.addEventListener("DOMContentLoaded", init);
