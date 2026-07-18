const state = {
  encounter: null,
  findings: [],
  summary: null,
  analysis: null,
  selectedFinding: null,
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

function renderEncounter() {
  const { patient, metadata, practitioner } = state.encounter;
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
  const analyzed = Boolean(state.analysis?.analyzed_at);
  $("#analysis-ready").classList.toggle("hidden", analyzed);
  $("#analysis-results").classList.toggle("hidden", !analyzed);
  if (analyzed) renderFindings();
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
    const items = state.findings.filter((finding) => finding.category === category);
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

function openRepair(id) {
  const finding = state.findings.find((item) => item.id === id);
  if (!finding) return;
  state.selectedFinding = finding;
  $("#dialog-title").textContent = finding.proposed_repair.summary;
  $("#dialog-body").innerHTML = `
    <div class="repair-content">
      <div class="repair-alert"><strong>${finding.risk} RISK</strong><span>${escapeHtml(finding.proposed_repair.risk_note)}</span></div>
      <div class="evidence-label">Conversation evidence · verified</div>
      <blockquote class="quote-block">“${escapeHtml(finding.commitment.verbatim_quote)}”</blockquote>
      <div class="compare-grid">
        <div class="compare-pane"><label>Current EHR state</label><pre>${escapeHtml(JSON.stringify(finding.ehr_evidence, null, 2))}</pre></div>
        <div class="compare-pane after"><label>Proposed FHIR repair</label><pre>${escapeHtml(JSON.stringify(finding.proposed_repair.fhir_resource, null, 2))}</pre></div>
      </div>
      <p class="subtle" style="margin-top:14px">Approval updates only the simulated working EHR. It does not claim real-world completion.</p>
    </div>`;
  $("#repair-dialog").showModal();
}

async function approveSelected() {
  if (!state.selectedFinding) return;
  const button = $("#approve-repair");
  setBusy(button, true, "Applying…");
  try {
    const payload = await api(`/api/findings/${state.selectedFinding.id}/approve`, { method: "POST", body: "{}" });
    updateFindingState(payload);
    $("#repair-dialog").close();
    toast("Repair applied to the simulated FHIR record");
    await refreshEncounterAndAudit();
  } catch (error) { toast(error.message); }
  finally { setBusy(button, false); }
}

async function rejectSelected() {
  if (!state.selectedFinding) return;
  const reason = window.prompt("Optional reason for rejecting this repair:", "Clinician review required");
  if (reason === null) return;
  try {
    const payload = await api(`/api/findings/${state.selectedFinding.id}/reject`, { method: "POST", body: JSON.stringify({ reason }) });
    updateFindingState(payload);
    $("#repair-dialog").close();
    toast("Repair rejected and audit event recorded");
    await renderAudit();
  } catch (error) { toast(error.message); }
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
  renderFindings();
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
  await renderAudit();
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
}

async function resetDemo() {
  if (!window.confirm("Restore the seeded EHR and clear the audit trail?")) return;
  const button = $("#reset-demo");
  setBusy(button, true, "Resetting…");
  try {
    await api("/api/demo/reset", { method: "POST", body: "{}" });
    const [encounter, findings] = await Promise.all([api("/api/encounter"), api("/api/findings")]);
    state.encounter = encounter;
    state.findings = findings.findings;
    state.summary = findings.summary;
    state.analysis = findings.analysis;
    renderEncounter();
    renderAnalysisShell();
    await renderAudit();
    toast("Demo restored to the seeded EHR state");
  } catch (error) { toast(error.message); }
  finally { setBusy(button, false); }
}

async function init() {
  setupNavigation();
  $("#run-analysis").addEventListener("click", (event) => runAnalysis(event.currentTarget));
  $("#rerun-analysis").addEventListener("click", (event) => runAnalysis(event.currentTarget));
  $("#approve-repair").addEventListener("click", approveSelected);
  $("#reject-repair").addEventListener("click", rejectSelected);
  $("#reset-demo").addEventListener("click", resetDemo);
  $("#toggle-raw").addEventListener("click", (event) => {
    const raw = $("#fhir-raw");
    raw.classList.toggle("hidden");
    event.currentTarget.textContent = raw.classList.contains("hidden") ? "View raw JSON" : "Hide raw JSON";
  });

  try {
    const [encounter, findings] = await Promise.all([api("/api/encounter"), api("/api/findings")]);
    state.encounter = encounter;
    state.findings = findings.findings;
    state.summary = findings.summary;
    state.analysis = findings.analysis;
    renderEncounter();
    renderAnalysisShell();
    await renderAudit();
  } catch (error) {
    toast(`Unable to load encounter: ${error.message}`);
  }
}

document.addEventListener("DOMContentLoaded", init);
