const state = {
  status: null,
  currentView: "dashboard",
  currentDraft: null,
  savedDraftBytes: null,
  draftAssets: [],
  unsaved: false,
  promotionId: null,
  logicalChannels: [],
};

const qs = (selector) => document.querySelector(selector);
const qsa = (selector) => [...document.querySelectorAll(selector)];

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.headers ?? {}),
    },
  });
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    if (!response.ok) throw new Error(`Request failed with HTTP ${response.status}.`);
    return await response.text();
  }
  const result = await response.json();
  if (!response.ok || result.ok === false) {
    const error = new Error(result.error?.message ?? `Request failed with HTTP ${response.status}.`);
    error.code = result.error?.code;
    error.details = result.error?.details;
    throw error;
  }
  return result.data;
}

function announce(message, isError = false) {
  const element = qs("#global-message");
  element.hidden = false;
  element.className = `message${isError ? " error" : ""}`;
  element.textContent = message;
  window.clearTimeout(announce.timer);
  announce.timer = window.setTimeout(() => { element.hidden = true; }, 6000);
}

function escapeText(value) {
  return String(value ?? "");
}

function setView(view) {
  state.currentView = view;
  qsa("[data-view-panel]").forEach((panel) => { panel.hidden = panel.dataset.viewPanel !== view; });
  qsa("[data-view]").forEach((button) => button.setAttribute("aria-current", button.dataset.view === view ? "page" : "false"));
  qs("#main-content").focus();
  if (view === "dashboard") void loadDashboard();
void loadLogicalChannels();
void updatePromotionOperationUi();
  if (view === "registry") void searchAssets("");
  if (view === "packs") void loadPacks();
  if (view === "drafts") void loadDraftList();
}

async function loadDashboard() {
  try {
    const status = await api("/api/v1/status");
    state.status = status;
    const metrics = [
      ["Registry Assets", status.registryAssetCount],
      ["Live Packs", status.packCount],
      ["Pack memberships", status.packMembershipCount],
      ["Audit gaps", status.auditGapCount],
    ];
    qs("#dashboard-cards").replaceChildren(...metrics.map(([label, value]) => {
      const card = document.createElement("article");
      card.className = "metric";
      const strong = document.createElement("strong"); strong.textContent = String(value);
      const span = document.createElement("span"); span.textContent = label;
      card.append(strong, span);
      return card;
    }));
    const integrity = qs("#source-integrity");
    integrity.replaceChildren();
    for (const [label, value] of [
      ["Canonical state", "Read-only canonical state"],
      ["Source integrity", status.sourceIntegrity],
      ["Registry fingerprint", status.registryFingerprint],
      ["Registry SHA-256", status.registrySourceSha256],
      ["Packs SHA-256", status.packSourceSha256],
      ["Channels SHA-256", status.channelConfigurationSha256],
    ]) {
      const dt = document.createElement("dt"); dt.textContent = label;
      const dd = document.createElement("dd"); dd.textContent = String(value);
      integrity.append(dt, dd);
    }
  } catch (error) { announce(error.message, true); }
}

async function refreshLiveState() {
  try {
    await api("/api/v1/refresh", { method: "POST", body: "{}" });
    await loadDashboard();
    if (state.currentDraft) await loadDraft(state.currentDraft.id);
    announce("Canonical state refreshed and the open draft was revalidated.");
  } catch (error) { announce(error.message, true); }
}

async function searchAssets(query) {
  try {
    const result = await api(`/api/v1/assets?q=${encodeURIComponent(query)}&limit=100`);
    const body = qs("#asset-table-body");
    body.replaceChildren();
    for (const asset of result.assets) {
      const row = document.createElement("tr");
      row.tabIndex = 0;
      row.dataset.assetId = asset.id;
      for (const value of [asset.id, asset.displayName, asset.tradingViewSymbol, asset.logicalChannel, asset.packMembershipCount]) {
        const cell = document.createElement("td"); cell.textContent = String(value); row.append(cell);
      }
      row.addEventListener("click", () => void showAsset(asset.id));
      row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") void showAsset(asset.id); });
      body.append(row);
    }
  } catch (error) { announce(error.message, true); }
}

async function showAsset(assetId) {
  try {
    const asset = await api(`/api/v1/assets/${encodeURIComponent(assetId)}`);
    const panel = qs("#asset-detail");
    panel.replaceChildren();
    const heading = document.createElement("h3"); heading.textContent = asset.displayName;
    const list = document.createElement("dl"); list.className = "definition-grid";
    for (const [label, value] of [
      ["Asset ID", asset.id], ["TradingView", asset.tradingViewSymbol], ["Logical channel", asset.logicalChannel],
      ["Pack memberships", asset.packIds.length ? asset.packIds.join(", ") : "None"],
    ]) {
      const dt = document.createElement("dt"); dt.textContent = label;
      const dd = document.createElement("dd"); dd.textContent = value;
      list.append(dt, dd);
    }
    panel.append(heading, list);
  } catch (error) { announce(error.message, true); }
}

async function loadPacks() {
  try {
    const packs = await api("/api/v1/packs");
    const list = qs("#pack-list"); list.replaceChildren();
    for (const pack of packs) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `${pack.displayName} — ${pack.membershipCount} Assets`;
      button.addEventListener("click", () => void showPack(pack.id));
      item.append(button); list.append(item);
    }
  } catch (error) { announce(error.message, true); }
}

async function showPack(packId) {
  try {
    const pack = await api(`/api/v1/packs/${encodeURIComponent(packId)}`);
    const panel = qs("#pack-detail"); panel.replaceChildren();
    const heading = document.createElement("h3"); heading.textContent = pack.displayName;
    const meta = document.createElement("p"); meta.textContent = `${pack.id} · ${pack.logicalChannel} · ${pack.membershipCount} Assets · Live read-only definition`;
    const list = document.createElement("ol"); list.className = "ordered-assets";
    pack.assets.forEach((asset) => {
      const item = document.createElement("li"); item.textContent = `${asset.id} — ${asset.displayName} (${asset.tradingViewSymbol})`; list.append(item);
    });
    panel.append(heading, meta, list);
  } catch (error) { announce(error.message, true); }
}

function draftSnapshot() {
  const description = qs("#draft-description").value;
  const draft = {
    schemaVersion: 1,
    draftType: "visionx.pack-draft",
    id: qs("#draft-id").value,
    displayName: qs("#draft-display-name").value,
    ...(description === "" ? {} : { description }),
    assetIds: [...state.draftAssets],
    revision: state.currentDraft?.revision ?? 1,
  };
  return draft;
}

function setUnsaved(value) {
  state.unsaved = value;
  qs("#unsaved-indicator").hidden = !value;
}

function renderDraftAssets() {
  const list = qs("#draft-assets-list"); list.replaceChildren();
  state.draftAssets.forEach((assetId, index) => {
    const item = document.createElement("li");
    const row = document.createElement("div"); row.className = "asset-row";
    const label = document.createElement("span"); label.textContent = `${index + 1}. ${assetId}`;
    const controls = document.createElement("div"); controls.className = "asset-controls";
    const action = (text, handler, disabled = false) => {
      const button = document.createElement("button"); button.type = "button"; button.textContent = text; button.disabled = disabled; button.addEventListener("click", handler); return button;
    };
    controls.append(
      action("Move up", () => moveDraftAsset(index, index - 1), index === 0),
      action("Move down", () => moveDraftAsset(index, index + 1), index === state.draftAssets.length - 1),
    );
    const position = document.createElement("input"); position.type = "number"; position.min = "1"; position.max = String(state.draftAssets.length); position.value = String(index + 1); position.setAttribute("aria-label", `Move ${assetId} to position`);
    controls.append(position, action("Move", () => moveDraftAsset(index, Number(position.value) - 1)), action("Remove", () => removeDraftAsset(index)));
    row.append(label, controls); item.append(row); list.append(item);
  });
  qs("#draft-asset-count").textContent = `${state.draftAssets.length} Asset${state.draftAssets.length === 1 ? "" : "s"}`;
}

function moveDraftAsset(from, to) {
  if (to < 0 || to >= state.draftAssets.length || from === to) return;
  const next = [...state.draftAssets];
  const [asset] = next.splice(from, 1); next.splice(to, 0, asset);
  state.draftAssets = next; setUnsaved(true); renderDraftAssets();
}
function removeDraftAsset(index) { state.draftAssets.splice(index, 1); state.draftAssets = [...state.draftAssets]; setUnsaved(true); renderDraftAssets(); }
function addDraftAsset(assetId) { if (state.draftAssets.includes(assetId)) return announce(`${assetId} is already in the draft.`, true); state.draftAssets = [...state.draftAssets, assetId]; setUnsaved(true); renderDraftAssets(); }

async function searchDraftAssets() {
  try {
    const query = qs("#draft-asset-search").value;
    const result = await api(`/api/v1/assets?q=${encodeURIComponent(query)}&limit=30`);
    const list = qs("#draft-asset-search-results"); list.replaceChildren();
    result.assets.forEach((asset) => {
      const item = document.createElement("li");
      const button = document.createElement("button"); button.type = "button"; button.textContent = `Add ${asset.id} — ${asset.displayName}`; button.disabled = state.draftAssets.includes(asset.id); button.addEventListener("click", () => addDraftAsset(asset.id));
      item.append(button); list.append(item);
    });
  } catch (error) { announce(error.message, true); }
}

function renderValidation(validation) {
  const box = qs("#draft-validation"); box.className = `validation-summary ${validation.valid ? "valid" : "invalid"}`; box.replaceChildren();
  const heading = document.createElement("h4"); heading.textContent = "Validation result";
  const summary = document.createElement("p"); summary.textContent = validation.valid ? "Draft is valid against the current Registry." : "Draft requires attention before it can be saved.";
  box.append(heading, summary);
  if (validation.errors.length) {
    const h = document.createElement("h5"); h.textContent = "Structural errors"; const ul = document.createElement("ul"); validation.errors.forEach((entry) => { const li = document.createElement("li"); li.textContent = `${entry.code}: ${entry.message}`; ul.append(li); }); box.append(h, ul);
  }
  if (validation.warnings.length) {
    const h = document.createElement("h5"); h.textContent = "Warnings"; const ul = document.createElement("ul"); validation.warnings.forEach((entry) => { const li = document.createElement("li"); li.textContent = `${entry.code}: ${entry.message}`; ul.append(li); }); box.append(h, ul);
  }
}

function populateDraft(record, savedBytes = null) {
  const draft = record.draft;
  state.currentDraft = draft;
  state.draftAssets = [...draft.assetIds];
  state.savedDraftBytes = savedBytes;
  state.promotionId = null;
  qs("#draft-id").value = draft.id; qs("#draft-id").readOnly = draft.revision > 1 || savedBytes !== null;
  qs("#draft-display-name").value = draft.displayName;
  qs("#draft-description").value = draft.description ?? "";
  qs("#draft-revision-state").textContent = `Saved revision ${draft.revision}`;
  setUnsaved(false); renderDraftAssets(); renderValidation(record.validation);
}

function newDraft() {
  populateDraft({ draft: { schemaVersion: 1, draftType: "visionx.pack-draft", id: "", displayName: "", assetIds: [], revision: 1 }, validation: { valid: true, errors: [], warnings: [], structurallyValid: true, registryValid: true, resolvedAssetCount: 0 } });
  qs("#draft-revision-state").textContent = "New unsaved draft · revision 1";
  qs("#draft-id").readOnly = false;
  setUnsaved(true);
}

async function loadDraftList() {
  try {
    const records = await api("/api/v1/pack-drafts");
    const list = qs("#draft-list"); list.replaceChildren();
    for (const record of records) {
      const item = document.createElement("li"); const button = document.createElement("button"); button.type = "button"; button.textContent = `${record.draft.displayName} · r${record.draft.revision}`; button.addEventListener("click", () => void loadDraft(record.draft.id)); item.append(button); list.append(item);
    }
    if (!records.length) { const item = document.createElement("li"); item.textContent = "No saved drafts."; list.append(item); }
  } catch (error) { announce(error.message, true); }
}

async function loadDraft(draftId) {
  try {
    if (state.unsaved && !window.confirm("Discard unsaved changes and reload the saved draft?")) return;
    const [record, exportResponse] = await Promise.all([api(`/api/v1/pack-drafts/${encodeURIComponent(draftId)}`), fetch(`/api/v1/pack-drafts/${encodeURIComponent(draftId)}/export`)]);
    if (!exportResponse.ok) throw new Error("Draft export failed.");
    populateDraft(record, await exportResponse.text()); announce(`Loaded ${draftId} revision ${record.draft.revision}.`);
  } catch (error) { announce(error.message, true); }
}

async function saveDraft() {
  try {
    const draft = draftSnapshot();
    let record;
    if (state.savedDraftBytes === null) {
      record = await api("/api/v1/pack-drafts", { method: "POST", body: JSON.stringify({ draft }) });
    } else {
      record = await api(`/api/v1/pack-drafts/${encodeURIComponent(draft.id)}`, { method: "PUT", body: JSON.stringify({ expectedRevision: state.currentDraft.revision, draft }) });
    }
    const exportResponse = await fetch(`/api/v1/pack-drafts/${encodeURIComponent(record.draft.id)}/export`);
    if (!exportResponse.ok) throw new Error("Draft export failed.");
    populateDraft(record, await exportResponse.text()); await loadDraftList(); announce(`Saved revision ${record.draft.revision}.`);
  } catch (error) {
    if (error.code === "draft_revision_conflict") qs("#draft-revision-state").textContent = `Revision conflict: expected ${error.details?.expectedRevision}, actual ${error.details?.actualRevision}`;
    announce(error.message, true);
  }
}

async function validateCurrentDraft() {
  if (!state.currentDraft?.id || state.savedDraftBytes === null) return announce("Save the draft before validating its persisted revision.", true);
  try { renderValidation(await api(`/api/v1/pack-drafts/${encodeURIComponent(state.currentDraft.id)}/validate`, { method: "POST", body: "{}" })); }
  catch (error) { announce(error.message, true); }
}

async function exportCurrentDraft() {
  if (!state.currentDraft?.id || state.savedDraftBytes === null) return announce("Save the draft before exporting canonical bytes.", true);
  try {
    const response = await fetch(`/api/v1/pack-drafts/${encodeURIComponent(state.currentDraft.id)}/export`);
    if (!response.ok) throw new Error("Draft export failed.");
    const blob = await response.blob(); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `${state.currentDraft.id}.json`; link.click(); URL.revokeObjectURL(link.href);
  } catch (error) { announce(error.message, true); }
}

async function deleteCurrentDraft() {
  if (!state.currentDraft?.id || state.savedDraftBytes === null) return announce("No saved draft is loaded.", true);
  if (!window.confirm(`Delete ${state.currentDraft.id} revision ${state.currentDraft.revision}? This does not modify live Packs.`)) return;
  try {
    await api(`/api/v1/pack-drafts/${encodeURIComponent(state.currentDraft.id)}`, { method: "DELETE", body: JSON.stringify({ expectedRevision: state.currentDraft.revision }) });
    newDraft(); state.savedDraftBytes = null; await loadDraftList(); announce("Draft deleted.");
  } catch (error) { announce(error.message, true); }
}

async function loadLogicalChannels() {
  try {
    const result = await api("/api/v1/channels");
    state.logicalChannels = [...result.logicalChannels];
    const select = qs("#promotion-channel");
    const current = select.value;
    select.replaceChildren(new Option("Select explicitly", ""), ...state.logicalChannels.map((channel) => new Option(channel, channel)));
    if (state.logicalChannels.includes(current)) select.value = current;
  } catch (error) { announce(error.message, true); }
}

async function updatePromotionOperationUi() {
  const operation = qs("#promotion-operation").value;
  const create = operation === "create_pack";
  qs("#promotion-channel-field").hidden = !create;
  qs("#promotion-existing-channel-field").hidden = operation !== "replace_pack_assets";
  if (operation === "replace_pack_assets" && state.currentDraft?.id) {
    try {
      const pack = await api(`/api/v1/packs/${encodeURIComponent(state.currentDraft.id)}`);
      qs("#promotion-existing-channel").textContent = pack.logicalChannel;
    } catch { qs("#promotion-existing-channel").textContent = "Pack does not exist"; }
  }
}

function promotionRequestSnapshot() {
  if (!state.currentDraft || state.savedDraftBytes === null) throw new Error("Save the draft before preparing a promotion.");
  const operation = qs("#promotion-operation").value;
  if (operation !== "create_pack" && operation !== "replace_pack_assets") throw new Error("Choose create_pack or replace_pack_assets explicitly.");
  const channel = qs("#promotion-channel").value;
  if (operation === "create_pack" && channel === "") throw new Error("Select a logical Pack channel explicitly.");
  const notes = qs("#promotion-notes").value;
  return {
    schemaVersion: 1,
    requestType: "visionx.pack-draft-promotion-request",
    operation,
    draftId: state.currentDraft.id,
    expectedRevision: state.currentDraft.revision,
    ...(operation === "create_pack" ? { channel } : {}),
    curatorId: qs("#promotion-curator-id").value,
    decidedAt: qs("#promotion-decided-at").value,
    referenceId: qs("#promotion-reference-id").value,
    ...(notes === "" ? {} : { notes }),
  };
}

async function renderPromotionArtifacts() {
  const list = qs("#promotion-artifacts"); list.replaceChildren();
  if (!state.currentDraft?.id || !state.promotionId) { qs("#promotion-state").textContent = "No promotion artifacts prepared."; return; }
  try {
    const result = await api(`/api/v1/pack-drafts/${encodeURIComponent(state.currentDraft.id)}/promotion/${state.promotionId}/artifacts`);
    qs("#promotion-state").textContent = `Prepared promotion ${state.promotionId.slice(0, 12)}… — canonical Pack source has not changed.`;
    for (const artifact of result.artifacts) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = `/api/v1/pack-drafts/${encodeURIComponent(state.currentDraft.id)}/promotion/${state.promotionId}/artifacts/${encodeURIComponent(artifact.name)}`;
      link.textContent = `Download ${artifact.name} — ${artifact.bytes} bytes — SHA-256 ${artifact.sha256}`;
      item.append(link); list.append(item);
    }
  } catch (error) { announce(error.message, true); }
}

async function createPromotionProposal() {
  try {
    const request = promotionRequestSnapshot();
    const result = await api(`/api/v1/pack-drafts/${encodeURIComponent(state.currentDraft.id)}/promotion/proposal`, { method: "POST", body: JSON.stringify({ request }) });
    state.promotionId = result.promotionId;
    await renderPromotionArtifacts();
    announce("Deterministic Pack proposal prepared. Canonical Pack source has not changed.");
  } catch (error) { announce(error.message, true); }
}

async function createPromotionPlan() {
  if (!state.promotionId || !state.currentDraft?.id) return announce("Create the Pack proposal first.", true);
  try {
    const authorization = JSON.parse(qs("#planning-authorization-json").value);
    await api(`/api/v1/pack-drafts/${encodeURIComponent(state.currentDraft.id)}/promotion/${state.promotionId}/plan`, { method: "POST", body: JSON.stringify({ authorization }) });
    await renderPromotionArtifacts();
    announce("Deterministic Pack application plan prepared. Nothing was applied.");
  } catch (error) { announce(error.message, true); }
}

async function createPromotionSourceChange() {
  if (!state.promotionId || !state.currentDraft?.id) return announce("Prepare the proposal and plan first.", true);
  try {
    await api(`/api/v1/pack-drafts/${encodeURIComponent(state.currentDraft.id)}/promotion/${state.promotionId}/source-change`, { method: "POST", body: "{}" });
    await renderPromotionArtifacts();
    announce("Source patch and receipt prepared for download. Canonical Pack source has not changed.");
  } catch (error) { announce(error.message, true); }
}

qsa("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
qs("#refresh-live-state").addEventListener("click", () => void refreshLiveState());
qs("#asset-search-form").addEventListener("submit", (event) => { event.preventDefault(); void searchAssets(qs("#asset-search").value); });
qs("#new-draft").addEventListener("click", newDraft);
qs("#reload-draft-list").addEventListener("click", () => void loadDraftList());
qs("#draft-asset-search-button").addEventListener("click", () => void searchDraftAssets());
qs("#draft-asset-search").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); void searchDraftAssets(); } });
qs("#save-draft").addEventListener("click", () => void saveDraft());
qs("#reload-draft").addEventListener("click", () => state.currentDraft?.id && void loadDraft(state.currentDraft.id));
qs("#validate-draft").addEventListener("click", () => void validateCurrentDraft());
qs("#export-draft").addEventListener("click", () => void exportCurrentDraft());
qs("#delete-draft").addEventListener("click", () => void deleteCurrentDraft());
qs("#promotion-operation").addEventListener("change", () => void updatePromotionOperationUi());
qs("#create-promotion-proposal").addEventListener("click", () => void createPromotionProposal());
qs("#create-promotion-plan").addEventListener("click", () => void createPromotionPlan());
qs("#create-promotion-source-change").addEventListener("click", () => void createPromotionSourceChange());
qs("#planning-authorization-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (file) qs("#planning-authorization-json").value = await file.text();
});
qsa("#draft-form input, #draft-form textarea").forEach((field) => field.addEventListener("input", () => setUnsaved(true)));
window.addEventListener("beforeunload", (event) => { if (state.unsaved) event.preventDefault(); });

void loadDashboard();
void loadLogicalChannels();
void updatePromotionOperationUi();
