"use strict";

const STORAGE_KEY = "visionx.pack-builder.input.v1";
const state = {
  status: null,
  channels: [],
  members: [],
  preview: null,
  previewTimer: null,
  lookupGeneration: 0,
  renderOptions: null,
  renderSourceFile: null,
  renderBusy: false,
  packWorkspace: null,
  packCaptureSession: null,
  packSourceFile: null,
  packPreview: null,
  packBusy: false,
  streamlinedRevisionConfirmation: false,
  streamlinedCaptureSessionId: null,
  expandedWorkspaceAssets: new Set(),
  workspaceQuickLookItems: [],
  workspaceQuickLookIndex: 0,
  workspaceQuickLookReturnFocus: null,
  publicationSelectedPackIds: new Set(),
  publicationSupersedePackIds: new Set(),
  publicationPreview: null,
  publicationBusy: false,
  threadManagement: null,
  threadVerification: null,
  threadBusy: false,
  threadForumInspection: null,
  threadLogo: null,
  serverConfiguration: null,
  serverInspection: null,
  serverPreview: null,
  serverBusy: false,
  serverRouteDrafts: [],
  operatorTools: null,
  exportAudit: null,
  packMaintenance: null,
  packMaintenanceSelectedId: "",
  packMaintenanceAssetIds: [],
  packMaintenanceOrder: [],
  packMaintenanceHeldAssetId: "",
  packMaintenancePreview: null,
  packMaintenanceBusy: false,
  releaseArchive: null,
  releaseDetail: null,
  registryQuery: "",
  registryPackId: "",
  registryPacks: [],
  registryOffset: 0,
  registryLimit: 25,
  registryTotal: 0,
  registryAssets: [],
  registrySelectedAsset: null,
  registrySearchGeneration: 0,
  registrySelectionGeneration: 0,
  registrySearchTimer: null,
  registryBusy: false,
  registryLogo: null,
  registryEditorMode: "add",
  registryChangePreview: null,
  registryChangeBusy: false,
  registryEditorReturnFocus: null,
  registryImportFile: null,
  registryImportPreview: null,
  registryImportBusy: false,
  registryImportReturnFocus: null,
  packAssetSearchGeneration: 0,
  packAssetSearchTimer: null,
  rendererAssetSearchGeneration: 0,
  activeView: "workspace",
  viewActivationGeneration: 0,
};

const qs = (selector) => document.querySelector(selector);
const qsa = (selector) => [...document.querySelectorAll(selector)];

const VIEW_LABELS = Object.freeze({
  workspace: "Workspace",
  threads: "Threads",
  server: "Server",
  packs: "Packs",
  archive: "Archive",
  renderer: "Render",
  registry: "Registry",
});

function requestedViewFromHash() {
  const requested = window.location.hash.replace(/^#/, "");
  return Object.hasOwn(VIEW_LABELS, requested) ? requested : "workspace";
}

function setViewBusy(view, busy) {
  const panel = qs(`[data-view-panel="${view}"]`);
  if (panel === null) return;
  panel.setAttribute("aria-busy", String(busy));
  panel.classList.toggle("view-loading", busy);
}

function updateViewNavigation(view) {
  qsa("[data-view]").forEach((item) => {
    const current = item.dataset.view === view;
    item.tabIndex = current ? 0 : -1;
    if (current) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  qsa("[data-view-panel]").forEach((panel) => { panel.hidden = panel.dataset.viewPanel !== view; });
}

function announceView(view) {
  const label = VIEW_LABELS[view] ?? "Administration";
  qs("#view-status").textContent = `${label} workspace ready.`;
  document.title = `${label} · VisionX Administration`;
}

function setModalIsolation(active) {
  const shell = [qs("#app-header"), qs("#primary-nav"), qs("#app-footer"), ...qsa("#main-content > [data-view-panel]")];
  for (const element of shell) {
    if (element === null) continue;
    element.inert = active;
    if (active) element.setAttribute("aria-hidden", "true");
    else element.removeAttribute("aria-hidden");
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body === undefined ? {} : { "Content-Type": "application/json" }), ...(options.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error?.message ?? `Request failed with HTTP ${response.status}`);
    error.code = payload.error?.code ?? "request_failed";
    error.details = payload.error?.details ?? {};
    throw error;
  }
  return payload.data;
}

function showMessage(text, error = true) {
  const box = qs("#message");
  qs("#message-text").textContent = text;
  box.className = `message${error ? "" : " success"}`;
  box.setAttribute("role", error ? "alert" : "status");
  box.setAttribute("aria-live", error ? "assertive" : "polite");
  box.hidden = false;
  const modalOpen = !qs("#registry-editor").hidden || !qs("#registry-import-dialog").hidden || !qs("#workspace-quick-look").hidden;
  if (error && !modalOpen) requestAnimationFrame(() => box.focus());
}

function clearMessage() {
  const box = qs("#message");
  box.hidden = true;
  qs("#message-text").textContent = "";
}

function packFormValue() {
  return {
    id: qs("#pack-id").value,
    display: qs("#pack-display").value,
    channel: qs("#pack-channel").value,
  };
}

function persistInput() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      pack: packFormValue(),
      members: state.members.map((member) => ({ id: member.id })),
    }));
  } catch {
    // Restricted browser storage must not block the governed in-memory workflow.
  }
}

function restoreInput() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!stored || typeof stored !== "object") return;
    qs("#pack-id").value = typeof stored.pack?.id === "string" ? stored.pack.id : "";
    qs("#pack-display").value = typeof stored.pack?.display === "string" ? stored.pack.display : "";
    qs("#pack-channel").value = typeof stored.pack?.channel === "string" ? stored.pack.channel : "";
    if (Array.isArray(stored.members)) {
      state.members = stored.members
        .filter((member) => typeof member?.id === "string" && member.id.length > 0)
        .map((member) => ({
          id: member.id,
          lookupState: "pending",
          existing: null,
          error: "",
          lookupGeneration: 0,
        }));
    }
  } catch {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* Storage is unavailable. */ }
  }
}

function currentInput() {
  return {
    schemaVersion: 1,
    pack: packFormValue(),
    members: state.members.map((member) => ({ id: member.id })),
  };
}

function derivedToken(token) {
  const parts = token.split(":");
  return parts.length === 2 && parts[0] && parts[1] ? { market: parts[0], symbol: parts[1] } : { market: "—", symbol: "—" };
}

function memberSummary(member) {
  const asset = member.existing;
  if (asset === null) return `${member.id.toUpperCase()} · VERIFYING REGISTRY`;
  return `${asset.displayName} · ${asset.tradingViewSymbol} · ${asset.currency ?? "CURRENCY MISSING"}`;
}

async function resolveMember(index) {
  const member = state.members[index];
  if (!member) return;
  const generation = ++state.lookupGeneration;
  member.lookupGeneration = generation;
  const id = member.id;
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
    member.lookupState = "error";
    member.existing = null;
    member.error = "Select a current Registry Asset.";
    renderMembers();
    schedulePreview();
    return;
  }
  member.lookupState = "loading";
  member.error = "";
  renderMembers();
  try {
    const asset = await api(`/api/v1/assets/${encodeURIComponent(id)}`);
    if (member.lookupGeneration !== generation || state.members[index] !== member || member.id !== id) return;
    member.lookupState = "existing";
    member.existing = asset;
    member.error = asset.currency ? "" : "This Registry Asset has no canonical currency and cannot be used for rendering.";
  } catch (error) {
    if (member.lookupGeneration !== generation || state.members[index] !== member || member.id !== id) return;
    member.lookupState = "error";
    member.existing = null;
    member.error = error.code === "asset_not_found" ? "This Asset is no longer in the Registry." : error.message;
  }
  renderMembers();
  schedulePreview();
}

function addMember(initial = {}) {
  const id = initial.id ?? "";
  if (!id || state.members.some((member) => member.id === id)) {
    if (id) showMessage(`${id.toUpperCase()} is already in this Pack draft.`);
    return;
  }
  state.members.push({ id, lookupState: "pending", existing: null, error: "", lookupGeneration: 0 });
  persistInput();
  renderMembers();
  void resolveMember(state.members.length - 1);
  schedulePreview();
}

function moveMember(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= state.members.length) return;
  const [member] = state.members.splice(index, 1);
  state.members.splice(target, 0, member);
  persistInput();
  renderMembers();
  schedulePreview();
}

function removeMember(index) {
  state.members.splice(index, 1);
  persistInput();
  renderMembers();
  schedulePreview();
}

function renderMembers() {
  const list = qs("#member-list");
  list.textContent = "";
  qs("#empty-members").hidden = state.members.length > 0;
  qs("#member-count").textContent = `${state.members.length} MEMBER${state.members.length === 1 ? "" : "S"}`;
  state.members.forEach((member, index) => {
    const li = document.createElement("li");
    li.className = "member-row registry-member-row";
    li.dataset.memberIndex = String(index);
    const asset = member.existing;
    const status = member.lookupState === "existing" && !member.error ? "REGISTERED" : member.lookupState === "loading" ? "VERIFYING" : "ACTION REQUIRED";
    const statusClass = member.lookupState === "existing" && !member.error ? "valid" : "missing";
    li.innerHTML = `
      <div class="member-summary">
        <span class="member-index">${String(index + 1).padStart(2, "0")}</span>
        <div>
          <strong class="member-primary">${escapeHtml(memberSummary(member))}<span class="member-status ${statusClass}">${status}</span></strong>
          <span class="member-secondary">${escapeHtml(asset ? `ID ${asset.id} · CHANNEL ${asset.logicalChannel.toUpperCase()}` : member.error || "Rechecking exact Registry ID")}</span>
        </div>
        <div class="member-actions" aria-label="Reorder and remove ${escapeHtml(member.id)}">
          <button type="button" data-action="up" aria-label="Move up" ${index === 0 ? "disabled" : ""}>↑</button>
          <button type="button" data-action="down" aria-label="Move down" ${index === state.members.length - 1 ? "disabled" : ""}>↓</button>
          <button type="button" data-action="remove" aria-label="Remove">×</button>
        </div>
      </div>
      ${member.error ? `<p class="field-error" role="alert">${escapeHtml(member.error)}</p>` : ""}`;
    li.querySelector('[data-action="up"]').addEventListener("click", () => moveMember(index, -1));
    li.querySelector('[data-action="down"]').addEventListener("click", () => moveMember(index, 1));
    li.querySelector('[data-action="remove"]').addEventListener("click", () => removeMember(index));
    list.append(li);
  });
}

async function loadPackAssetSearch(query) {
  const generation = ++state.packAssetSearchGeneration;
  const panel = qs("#pack-asset-results");
  if (query.trim().length === 0) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  const result = await api(`/api/v1/assets?q=${encodeURIComponent(query)}&offset=0&limit=12`);
  if (generation !== state.packAssetSearchGeneration) return;
  const available = result.assets.filter((asset) => !state.members.some((member) => member.id === asset.id));
  panel.hidden = false;
  panel.innerHTML = available.length === 0
    ? '<p class="asset-search-empty">NO AVAILABLE REGISTRY ASSETS MATCH.</p>'
    : available.map((asset) => `<button type="button" data-add-pack-asset="${escapeAttribute(asset.id)}"><strong>${escapeHtml(asset.displayName)}</strong><span>${escapeHtml(asset.tradingViewSymbol)} · ${escapeHtml(asset.currency ?? "—")} · ${escapeHtml(asset.logicalChannel.toUpperCase())}</span></button>`).join("");
  qsa("[data-add-pack-asset]").forEach((button) => button.addEventListener("click", () => {
    addMember({ id: button.dataset.addPackAsset });
    qs("#pack-asset-search").value = "";
    panel.hidden = true;
  }));
}

function schedulePackAssetSearch(query) {
  clearTimeout(state.packAssetSearchTimer);
  state.packAssetSearchGeneration += 1;
  state.packAssetSearchTimer = setTimeout(() => void loadPackAssetSearch(query).catch((error) => showMessage(error.message)), 160);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}
function escapeAttribute(value) { return escapeHtml(value).replace(/`/g, "&#96;"); }

function setPreviewUnavailable(text = "Complete the Pack and member details to see the exact change.") {
  state.preview = null;
  qs("#preview-state").textContent = "WAITING FOR VALID INPUT";
  qs("#preview-content").innerHTML = `<p>${escapeHtml(text)}</p>`;
  qs("#technical-content").textContent = "No validated preview exists.";
  qs("#create-pack").disabled = true;
}

function schedulePreview() {
  clearTimeout(state.previewTimer);
  setPreviewUnavailable();
  state.previewTimer = setTimeout(() => void refreshPreview(), 240);
}

function inputReady() {
  const pack = packFormValue();
  if (!pack.id || !pack.display || !pack.channel || state.members.length === 0) return false;
  return state.members.every((member) =>
    Boolean(member.id && member.lookupState === "existing" && member.existing && !member.error));
}

async function refreshPreview() {
  persistInput();
  if (!inputReady()) return;
  clearMessage();
  qs("#preview-state").textContent = "VALIDATING";
  try {
    const preview = await api("/api/v1/packs/create/preview", { method: "POST", body: JSON.stringify({ input: currentInput() }) });
    state.preview = preview;
    qs("#preview-state").textContent = "CURRENT PREVIEW";
    qs("#preview-content").innerHTML = `
      <h3>CREATE ${escapeHtml(preview.pack.display.toUpperCase())}</h3>
      <p>Reuse ${preview.members.length} current Registry Asset${preview.members.length === 1 ? "" : "s"} in this exact order: ${preview.members.map((member) => escapeHtml(member.symbol)).join(", ")}.</p>
      <div class="preview-counts">
        <span>REGISTRY ASSETS <strong>${preview.counts.registryAssetsBefore} → ${preview.counts.registryAssetsAfter}</strong></span>
        <span>PACKS <strong>${preview.counts.packsBefore} → ${preview.counts.packsAfter}</strong></span>
        <span>MEMBERSHIPS <strong>${preview.counts.packMembershipsBefore} → ${preview.counts.packMembershipsAfter}</strong></span>
      </div>
      <p>Pack creation will not create or modify Asset identity, logos, rendered charts, Releases, or Discord content.</p>`;
    qs("#technical-content").textContent = JSON.stringify({
      previewId: preview.previewId,
      changedPaths: preview.changedPaths,
      sourceState: preview.sourceState,
      technicalEvidence: preview.technicalEvidence,
    }, null, 2);
    qs("#create-pack").disabled = false;
  } catch (error) {
    state.preview = null;
    qs("#preview-state").textContent = "ACTION REQUIRED";
    const memberIndex = Number.isInteger(error.details?.memberIndex) ? error.details.memberIndex : null;
    if (memberIndex !== null && state.members[memberIndex]) {
      state.members[memberIndex].error = error.message;
      renderMembers();
    }

    setPreviewUnavailable(error.message);
  }
}

async function createPack() {
  if (!state.preview) return;
  clearMessage();
  qs("#create-pack").disabled = true;
  qs("#preview-state").textContent = "CREATING PACK";
  try {
    const result = await api("/api/v1/packs/create", {
      method: "POST",
      body: JSON.stringify({ packId: state.preview.pack.id, previewId: state.preview.previewId }),
    });
    localStorage.removeItem(STORAGE_KEY);
    qs("#result-window").hidden = false;
    qs("#result-heading").textContent = `${result.receipt.pack.display.toUpperCase()} CREATED`;
    qs("#result-content").innerHTML = `<p>The ${escapeHtml(result.receipt.pack.display)} Pack was created with ${result.receipt.pack.assetIds.length} existing Registry Assets in canonical order.</p><p>No Asset identity, logo, render, Release, or Discord content was changed.</p>`;
    qs("#preview-state").textContent = "APPLIED";
    qs("#source-state").textContent = "CANONICAL STATE · VERIFIED";
    qs("#inventory-context").textContent = `${result.status.registryAssetCount} ASSETS · ${result.status.packCount} PACKS`;
  } catch (error) {
    const safelyRestored = error.details?.safelyRestored === true;
    const text = error.code === "rollback_verification_failed" || error.code === "rollback_failed"
      ? "VisionX could not prove that both definition files were restored. Stop and recover the working tree from version control before retrying."
      : safelyRestored
        ? "VisionX could not complete the operation and restored both definition files. Nothing was created. Your work has been preserved."
        : error.code?.startsWith("stale_") || error.code === "pack_builder_preview_mismatch"
          ? "Registry or Pack definitions changed after this preview. Your work has been preserved. Review the refreshed result and create the Pack again."
          : error.message;
    showMessage(text);
    await refreshStatus();
    await refreshPreview();
  }
}

async function refreshStatus() {
  state.status = await api("/api/v1/status");
  qs("#source-state").textContent = `CANONICAL STATE · ${state.status.sourceIntegrity.toUpperCase()}`;
  qs("#inventory-context").textContent = `${state.status.registryAssetCount} ASSETS · ${state.status.packCount} PACKS · ${state.status.packMembershipCount} MEMBERSHIPS`;
}

async function loadChannels() {
  const result = await api("/api/v1/channels");
  state.channels = result.logicalChannels;
  const select = qs("#pack-channel");
  const selected = select.value;
  select.innerHTML = '<option value="">SELECT CHANNEL</option>' + state.channels.map((channel) => `<option value="${escapeAttribute(channel)}">${escapeHtml(channel.toUpperCase())}</option>`).join("");
  select.value = selected;
  qs("#channel-status").textContent = selected ? `${selected.toUpperCase()} CONFIGURED` : "SELECT A CHANNEL";
}

function selectedThreadPack() {
  return state.threadManagement?.packs.find((pack) => pack.id === qs("#thread-pack").value) ?? null;
}

function selectedThreadAsset() {
  return selectedThreadPack()?.assets.find((asset) => asset.id === qs("#thread-asset").value) ?? null;
}

function selectedThreadTagIds() {
  return qsa('#thread-tags input[type="checkbox"]:checked').map((input) => input.value);
}

function threadTagLegend() {
  return '<legend><span>20 TAGS MAY BE CONFIGURED FOR THIS FORUM · APPLY UP TO 5 TAGS TO EACH POST</span><strong id="thread-tag-count">0 / 5 SELECTED</strong></legend>';
}

function updateThreadTagCount() {
  const count = selectedThreadTagIds().length;
  const counter = qs("#thread-tag-count");
  if (counter !== null) counter.textContent = `${count} / 5 SELECTED`;
}

function resetThreadProvisioning({ keepForum = false } = {}) {
  if (!keepForum) state.threadForumInspection = null;
  state.threadLogo = null;
  qs("#thread-logo-state").textContent = "LOAD FORUM TO VERIFY REGISTRY LOGO";
  qs("#thread-title").value = "";
  renderThreadTags();
}

function renderThreadTags() {
  const fieldset = qs("#thread-tags");
  const inspection = state.threadForumInspection;
  if (inspection === null) {
    fieldset.innerHTML = `${threadTagLegend()}<p id="thread-tags-empty">INSPECT THE FORUM TO LOAD CURRENT TAGS</p>`;
    updateThreadTagCount();
    return;
  }
  const tags = inspection.forum.availableTags;
  fieldset.innerHTML = threadTagLegend() + (tags.length === 0
    ? '<p id="thread-tags-empty">THIS FORUM HAS NO AVAILABLE TAGS</p>'
    : `<div class="thread-tag-options">${tags.map((tag) => `<label class="thread-tag-option"><input type="checkbox" value="${escapeAttribute(tag.id)}"><span>${escapeHtml(tag.name)}${tag.moderated ? " · MODERATED" : ""}</span></label>`).join("")}</div>`);
  qsa('#thread-tags input[type="checkbox"]').forEach((input) => input.addEventListener("change", () => {
    const selected = selectedThreadTagIds();
    if (selected.length > 5) {
      input.checked = false;
      showMessage("Each Discord forum post may apply at most five tags.");
    }
    updateThreadTagCount();
    updateThreadAdoptButton();
  }));
  updateThreadTagCount();
}

function updateThreadAdoptButton() {
  const threadId = qs("#thread-id").value.trim();
  const asset = selectedThreadAsset();
  const pack = selectedThreadPack();
  const available = state.threadManagement?.adoptionAvailable === true;
  const bound = asset?.bindingState === "bound";
  const currentThreadId = bound ? asset.threadId : null;
  qs("#thread-pack").disabled = state.threadBusy;
  qs("#thread-asset").disabled = state.threadBusy;
  qs("#thread-id").disabled = state.threadBusy || !available;
  qs("#thread-current-id").textContent = currentThreadId ?? "UNBOUND";
  qs("#thread-inspect-binding").disabled = state.threadBusy || !available || !pack?.forumConfigured || !bound;
  qs("#thread-remove-binding").disabled = state.threadBusy || !bound;
  qs("#thread-adopt-button").textContent = bound ? "INSPECT & REPLACE" : "INSPECT & ADOPT";
  qs("#thread-adopt-button").disabled = !(
    !state.threadBusy &&
    available &&
    pack?.forumConfigured &&
    asset !== null &&
    /^[0-9]{17,20}$/.test(threadId) &&
    (!bound || threadId !== currentThreadId)
  );

  const provisioningAvailable = state.threadManagement?.provisioningAvailable === true;
  const inspectionReady = state.threadForumInspection?.packId === pack?.id && state.threadForumInspection?.sessionClosed === true;
  const logoReady = state.threadLogo?.packId === pack?.id && state.threadLogo?.assetId === asset?.id;
  const title = qs("#thread-title").value;
  const tagIds = selectedThreadTagIds();
  qs("#thread-inspect-forum").disabled = state.threadBusy || !provisioningAvailable || !pack?.forumConfigured || asset?.bindingState !== "unbound";
  qs("#thread-title").disabled = state.threadBusy || !provisioningAvailable || !inspectionReady || asset?.bindingState !== "unbound";
  qs("#thread-tags").disabled = state.threadBusy || !provisioningAvailable || !inspectionReady;
  qs("#thread-provision-button").disabled = !(
    !state.threadBusy &&
    provisioningAvailable &&
    inspectionReady &&
    logoReady &&
    asset?.bindingState === "unbound" &&
    title.length > 0 &&
    title === title.trim() &&
    title.length <= 100 &&
    tagIds.length <= 5
  );
  qs("#thread-verify-routing").disabled = !(
    !state.threadBusy &&
    available &&
    pack?.forumConfigured === true &&
    pack?.verificationEligible === true
  );
}

function currentThreadVerification(pack) {
  const verification = state.threadVerification;
  const dashboard = state.threadManagement;
  return verification?.packId === pack?.id &&
    verification?.bindingSourceSha256 === dashboard?.bindingsSourceSha256
    ? verification
    : null;
}

function routingIssueLabel(issue) {
  return issue.replaceAll("_", " ").toUpperCase();
}

function renderThreadManagement() {
  const dashboard = state.threadManagement;
  const pack = selectedThreadPack();
  if (dashboard === null || pack === null) {
    qs("#thread-mode").textContent = "ROUTING UNAVAILABLE";
    qs("#thread-coverage").textContent = "0 / 0";
    qs("#thread-forum").textContent = "NO PACK";
    qs("#thread-gateway").textContent = "UNAVAILABLE";
    qs("#thread-total-context").textContent = "NO THREAD BINDINGS AVAILABLE";
    qs("#thread-asset").innerHTML = '<option value="">SELECT ASSET</option>';
    qs("#thread-current-id").textContent = "UNBOUND";
    qs("#thread-members-body").innerHTML = "";
    qs("#thread-member-count").textContent = "0 ASSETS";
    qs("#thread-provisioning-state").textContent = "SELECT A PACK";
    qs("#thread-readiness-state").textContent = "INCOMPLETE";
    qs("#thread-readiness-bindings").textContent = "0 / 0";
    qs("#thread-readiness-verified").textContent = "0 / 0";
    qs("#thread-readiness-blockers").textContent = "—";
    qs("#thread-readiness-detail").textContent = "COMPLETE EVERY PERSISTENT BINDING BEFORE LIVE VERIFICATION";
    updateThreadAdoptButton();
    return;
  }

  qs("#thread-mode").textContent = dashboard.provisioningAvailable ? "ADOPT & PROVISION" : "ADOPTION ONLY";
  qs("#thread-coverage").textContent = `${pack.boundCount} / ${pack.totalCount}`;
  qs("#thread-forum").textContent = pack.forumConfigured ? "CONFIGURED" : "NOT CONFIGURED";
  qs("#thread-gateway").textContent = dashboard.adoptionAvailable || dashboard.provisioningAvailable ? "AVAILABLE" : "TOKEN REQUIRED";
  qs("#thread-total-context").textContent = `${dashboard.boundCount} OF ${dashboard.totalCount} ASSETS BOUND · ${dashboard.missingCount} MISSING ACROSS ALL PACKS`;
  qs("#thread-member-count").textContent = `${pack.totalCount} ASSET${pack.totalCount === 1 ? "" : "S"}`;

  const verification = currentThreadVerification(pack);
  const blockedCount = verification?.assets.filter((asset) => asset.state === "blocked").length ?? 0;
  qs("#thread-readiness-bindings").textContent = `${pack.boundCount} / ${pack.totalCount}`;
  qs("#thread-readiness-verified").textContent = `${verification?.verifiedCount ?? 0} / ${pack.totalCount}`;
  qs("#thread-readiness-blockers").textContent = pack.missingCount > 0
    ? String(pack.missingCount)
    : verification === null
      ? "—"
      : String(blockedCount + (verification.sessionClosed ? 0 : 1));
  if (!pack.forumConfigured) {
    qs("#thread-readiness-state").textContent = "FORUM NOT CONFIGURED";
    qs("#thread-readiness-detail").textContent = "CONFIGURE THE PACK FORUM BEFORE LIVE VERIFICATION";
  } else if (pack.missingCount > 0) {
    qs("#thread-readiness-state").textContent = "INCOMPLETE";
    qs("#thread-readiness-detail").textContent = `${pack.missingCount} PERSISTENT BINDING${pack.missingCount === 1 ? "" : "S"} REQUIRED BEFORE DISCORD CONTACT`;
  } else if (!dashboard.adoptionAvailable) {
    qs("#thread-readiness-state").textContent = "TOKEN REQUIRED";
    qs("#thread-readiness-detail").textContent = "START ADMIN WITH DISCORD_BOT_TOKEN TO ENABLE READ-ONLY VERIFICATION";
  } else if (verification?.operationallyReady === true) {
    qs("#thread-readiness-state").textContent = "READY";
    qs("#thread-readiness-detail").textContent = "ALL DESTINATIONS EXIST IN THE CONFIGURED FORUM AND ARE ACTIVE AND UNLOCKED";
  } else if (verification !== null && !verification.sessionClosed) {
    qs("#thread-readiness-state").textContent = "SESSION CLOSE FAILED";
    qs("#thread-readiness-detail").textContent = "READINESS WITHHELD · RESTART ADMIN BEFORE ANOTHER DISCORD OPERATION";
  } else if (verification !== null) {
    qs("#thread-readiness-state").textContent = "BLOCKED";
    qs("#thread-readiness-detail").textContent = `${blockedCount} DESTINATION${blockedCount === 1 ? "" : "S"} REQUIRE OPERATOR ACTION`;
  } else {
    qs("#thread-readiness-state").textContent = "UNVERIFIED";
    qs("#thread-readiness-detail").textContent = "ALL BINDINGS ARE PRESENT · LIVE DESTINATIONS HAVE NOT BEEN VERIFIED";
  }

  const priorAssetId = qs("#thread-asset").value;
  const unbound = pack.assets.filter((asset) => asset.bindingState === "unbound");
  qs("#thread-asset").innerHTML = '<option value="">SELECT ASSET</option>' + pack.assets
    .map((asset) => `<option value="${escapeAttribute(asset.id)}">${escapeHtml(asset.id.toUpperCase())} · ${escapeHtml(asset.displayName)} · ${asset.bindingState === "bound" ? "BOUND" : "UNBOUND"}</option>`)
    .join("");
  qs("#thread-asset").value = pack.assets.some((asset) => asset.id === priorAssetId)
    ? priorAssetId
    : unbound[0]?.id ?? pack.assets[0]?.id ?? "";

  qs("#thread-members-body").innerHTML = pack.assets.map((asset) => {
    const live = verification?.assets.find((candidate) => candidate.assetId === asset.id) ?? null;
    const liveClass = asset.bindingState !== "bound" || live === null
      ? "pending"
      : live.state === "ready"
        ? "valid"
        : "blocked";
    const liveLabel = asset.bindingState !== "bound"
      ? "NOT ELIGIBLE"
      : live === null
        ? "UNVERIFIED"
        : live.state === "ready"
          ? "READY"
          : `BLOCKED · ${live.issues.map(routingIssueLabel).join(" · ")}`;
    return `<tr>
    <td>${escapeHtml(asset.id.toUpperCase())} · ${escapeHtml(asset.displayName)}</td>
    <td><span class="workspace-status ${asset.bindingState === "bound" ? "valid" : "pending"}">${asset.bindingState === "bound" ? "BOUND" : "MISSING"}</span></td>
    <td>${escapeHtml(asset.threadId ?? "—")}</td>
    <td><span class="workspace-status ${liveClass}">${escapeHtml(liveLabel)}</span></td>
    <td><button class="outline-action compact-action" type="button" data-manage-thread-asset="${escapeAttribute(asset.id)}">MANAGE</button></td>
  </tr>`;
  }).join("");
  qsa("[data-manage-thread-asset]").forEach((button) => {
    button.addEventListener("click", () => {
      qs("#thread-asset").value = button.dataset.manageThreadAsset;
      const selected = selectedThreadAsset();
      qs("#thread-id").value = selected?.threadId ?? "";
      resetThreadProvisioning({ keepForum: true });
      renderThreadManagement();
      qs("#thread-adoption-heading").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  if (!dashboard.adoptionAvailable) {
    qs("#thread-adoption-state").textContent = "START ADMIN WITH DISCORD_BOT_TOKEN TO ENABLE INSPECTION";
  } else if (!pack.forumConfigured) {
    qs("#thread-adoption-state").textContent = "PACK FORUM IS NOT CONFIGURED";
  } else if (!state.threadBusy) {
    const selected = selectedThreadAsset();
    qs("#thread-adoption-state").textContent = selected?.bindingState === "bound"
      ? `${selected.id.toUpperCase()} CURRENTLY ROUTES TO ${selected.threadId}`
      : "SELECT AN EXISTING THREAD ID TO ADOPT";
  }
  if (!dashboard.provisioningAvailable) {
    qs("#thread-provisioning-state").textContent = "START ADMIN WITH DISCORD_BOT_TOKEN TO ENABLE PROVISIONING";
  } else if (!pack.forumConfigured) {
    qs("#thread-provisioning-state").textContent = "PACK FORUM IS NOT CONFIGURED";
  } else if (unbound.length === 0) {
    qs("#thread-provisioning-state").textContent = "PACK ROUTING COMPLETE";
  } else if (state.threadForumInspection?.packId === pack.id) {
    qs("#thread-provisioning-state").textContent = `${state.threadForumInspection.forum.name.toUpperCase()} · ${state.threadForumInspection.forum.availableTags.length} TAGS INSPECTED`;
  } else if (!state.threadBusy) {
    qs("#thread-provisioning-state").textContent = "INSPECT THE CURRENT FORUM TAGS";
  }
  updateThreadAdoptButton();
}

async function loadThreadManagement() {
  const selectedPackId = qs("#thread-pack").value;
  const priorBindingsSha256 = state.threadManagement?.bindingsSourceSha256 ?? null;
  const dashboard = await api("/api/v1/thread-management");
  state.threadManagement = dashboard;
  if (
    (priorBindingsSha256 !== null && priorBindingsSha256 !== dashboard.bindingsSourceSha256) ||
    (state.threadVerification !== null && state.threadVerification.bindingSourceSha256 !== dashboard.bindingsSourceSha256)
  ) state.threadVerification = null;
  qs("#thread-pack").innerHTML = dashboard.packs
    .map((pack) => `<option value="${escapeAttribute(pack.id)}">${escapeHtml(pack.displayName.toUpperCase())} · ${pack.boundCount}/${pack.totalCount}</option>`)
    .join("");
  qs("#thread-pack").value = dashboard.packs.some((pack) => pack.id === selectedPackId)
    ? selectedPackId
    : dashboard.packs[0]?.id ?? "";
  renderThreadManagement();
}

async function verifyPackRouting() {
  const pack = selectedThreadPack();
  if (
    pack === null ||
    pack.verificationEligible !== true ||
    state.threadBusy ||
    state.threadManagement?.adoptionAvailable !== true
  ) return;

  const confirmed = window.confirm(
    `Inspect all ${pack.totalCount} persistent Discord destinations for ${pack.displayName} in canonical Pack order?\n\n` +
    "Every thread must still exist in the configured forum and be active and unlocked. This is read-only: no Discord content or binding changes, chart publication, or Release creation.",
  );
  if (!confirmed) return;

  clearMessage();
  state.threadBusy = true;
  state.threadVerification = null;
  qs("#thread-readiness-state").textContent = "VERIFYING";
  qs("#thread-readiness-detail").textContent = "INSPECTING CANONICAL PACK DESTINATIONS";
  updateThreadAdoptButton();
  try {
    const result = await api(`/api/v1/thread-management/packs/${encodeURIComponent(pack.id)}/verify`, {
      method: "POST",
      body: JSON.stringify({ confirmation: "verify_pack_routing" }),
    });
    state.threadVerification = result;
    renderThreadManagement();
    const blockedCount = result.assets.filter((asset) => asset.state === "blocked").length;
    showMessage(
      result.operationallyReady
        ? `${pack.displayName} routing is live-verified: ${result.verifiedCount}/${result.totalCount} destinations are current, active, and unlocked. Publication remains disabled.`
        : result.sessionClosed
          ? `${pack.displayName} routing is blocked by ${blockedCount} destination${blockedCount === 1 ? "" : "s"}. Review the per-Asset readiness results.`
          : "Destination inspection completed, but the Discord session did not close cleanly. Readiness is withheld; restart the administration service.",
      !result.operationallyReady,
    );
  } catch (error) {
    qs("#thread-readiness-state").textContent = "VERIFICATION FAILED";
    qs("#thread-readiness-detail").textContent = "NO DISCORD CONTENT OR LOCAL BINDING WAS CHANGED";
    showMessage(error.message);
    await loadThreadManagement().catch(() => undefined);
  } finally {
    state.threadBusy = false;
    updateThreadAdoptButton();
  }
}

async function adoptExistingThread() {
  const pack = selectedThreadPack();
  const asset = selectedThreadAsset();
  const threadId = qs("#thread-id").value.trim();
  const replacing = asset?.bindingState === "bound";
  const currentThreadId = replacing ? asset.threadId : null;
  if (
    pack === null ||
    asset === null ||
    !/^[0-9]{17,20}$/.test(threadId) ||
    (replacing && threadId === currentThreadId) ||
    state.threadBusy ||
    state.threadManagement?.adoptionAvailable !== true
  ) return;

  const confirmed = window.confirm(
    replacing
      ? `Replace ${asset.id.toUpperCase()} binding ${currentThreadId} with Discord thread ${threadId}?\n\n` +
        "VisionX will first verify the replacement post belongs to this Pack forum. Only the local persistent Thread ID will change. Neither Discord post will be edited or deleted."
      : `Adopt Discord thread ${threadId} for ${asset.id.toUpperCase()} in ${pack.displayName}?\n\n` +
        "VisionX will inspect the existing post and verify its parent forum. Discord content, tags, history, archive state, and lock state will not be changed. If verification passes, only the local persistent binding is written.",
  );
  if (!confirmed) return;

  clearMessage();
  state.threadBusy = true;
  qs("#thread-adoption-state").textContent = replacing
    ? "VERIFYING REPLACEMENT DISCORD THREAD"
    : "INSPECTING DISCORD PARENT FORUM";
  updateThreadAdoptButton();
  try {
    const result = await api(replacing
      ? "/api/v1/thread-management/binding/replace"
      : "/api/v1/thread-management/adopt", {
      method: "POST",
      body: JSON.stringify(replacing
        ? {
            packId: pack.id,
            assetId: asset.id,
            currentThreadId,
            nextThreadId: threadId,
            confirmation: "replace_thread_binding",
          }
        : {
            packId: pack.id,
            assetId: asset.id,
            threadId,
            confirmation: "adopt_existing_thread",
          }),
    });
    qs("#thread-id").value = threadId;
    resetThreadProvisioning({ keepForum: true });
    await loadThreadManagement();
    qs("#thread-asset").value = asset.id;
    qs("#thread-id").value = threadId;
    renderThreadManagement();
    qs("#thread-adoption-state").textContent = `${asset.id.toUpperCase()} · ${replacing ? "BINDING REPLACED" : result.outcome === "adopted" ? "BOUND" : "ALREADY BOUND"}`;
    showMessage(
      result.sessionClosed
        ? `${asset.id.toUpperCase()} now routes to existing thread ${threadId}. Discord content was not changed.`
        : `${asset.id.toUpperCase()} now routes to thread ${threadId}, but the Discord session did not close cleanly. Restart the administration service before another Discord operation.`,
      !result.sessionClosed,
    );
  } catch (error) {
    qs("#thread-adoption-state").textContent = replacing ? "REPLACEMENT NOT APPLIED" : "ADOPTION NOT APPLIED";
    showMessage(error.message);
    await loadThreadManagement().catch(() => undefined);
  } finally {
    state.threadBusy = false;
    updateThreadAdoptButton();
  }
}

async function inspectCurrentThreadBinding() {
  const pack = selectedThreadPack();
  const asset = selectedThreadAsset();
  if (
    pack === null ||
    asset?.bindingState !== "bound" ||
    state.threadBusy ||
    state.threadManagement?.adoptionAvailable !== true
  ) return;
  const confirmed = window.confirm(
    `Inspect the current ${asset.id.toUpperCase()} destination ${asset.threadId}?\n\n` +
    "VisionX will verify that the post still belongs to this Pack forum. This is read-only and changes neither Discord nor the local binding.",
  );
  if (!confirmed) return;

  clearMessage();
  state.threadBusy = true;
  qs("#thread-adoption-state").textContent = "INSPECTING CURRENT DISCORD DESTINATION";
  updateThreadAdoptButton();
  try {
    const result = await api("/api/v1/thread-management/binding/inspect", {
      method: "POST",
      body: JSON.stringify({
        packId: pack.id,
        assetId: asset.id,
        threadId: asset.threadId,
        confirmation: "inspect_bound_thread",
      }),
    });
    qs("#thread-adoption-state").textContent = `${asset.id.toUpperCase()} · CURRENT BINDING VERIFIED`;
    showMessage(
      `${asset.id.toUpperCase()} routes to “${result.thread.name}” (${result.thread.threadId}). ` +
      `Archived: ${result.thread.archived ? "yes" : "no"} · Locked: ${result.thread.locked ? "yes" : "no"} · Tags: ${result.thread.appliedTagCount}. ` +
      "Discord content and the local binding were unchanged.",
      !result.sessionClosed,
    );
  } catch (error) {
    qs("#thread-adoption-state").textContent = "CURRENT BINDING INSPECTION FAILED";
    showMessage(error.message);
    await loadThreadManagement().catch(() => undefined);
  } finally {
    state.threadBusy = false;
    updateThreadAdoptButton();
  }
}

async function removeCurrentThreadBinding() {
  const pack = selectedThreadPack();
  const asset = selectedThreadAsset();
  if (pack === null || asset?.bindingState !== "bound" || state.threadBusy) return;
  const confirmed = window.confirm(
    `Remove the local ${asset.id.toUpperCase()} binding to thread ${asset.threadId}?\n\n` +
    "The Discord post, its messages, title, tags, archive state, and lock state will remain exactly as they are. The Asset will become unbound and Pack routing readiness will be incomplete.",
  );
  if (!confirmed) return;

  clearMessage();
  state.threadBusy = true;
  qs("#thread-adoption-state").textContent = "REMOVING LOCAL PERSISTENT BINDING";
  updateThreadAdoptButton();
  try {
    const removedThreadId = asset.threadId;
    await api("/api/v1/thread-management/binding", {
      method: "DELETE",
      body: JSON.stringify({
        packId: pack.id,
        assetId: asset.id,
        currentThreadId: removedThreadId,
        confirmation: "remove_thread_binding",
      }),
    });
    await loadThreadManagement();
    qs("#thread-asset").value = asset.id;
    qs("#thread-id").value = "";
    renderThreadManagement();
    qs("#thread-adoption-state").textContent = `${asset.id.toUpperCase()} · UNBOUND`;
    showMessage(
      `${asset.id.toUpperCase()} no longer has a local persistent route. Discord thread ${removedThreadId} was not contacted, edited, or deleted.`,
      false,
    );
  } catch (error) {
    qs("#thread-adoption-state").textContent = "BINDING REMOVAL NOT APPLIED";
    showMessage(error.message);
    await loadThreadManagement().catch(() => undefined);
  } finally {
    state.threadBusy = false;
    updateThreadAdoptButton();
  }
}

async function inspectThreadForum() {
  const pack = selectedThreadPack();
  const asset = selectedThreadAsset();
  if (
    pack === null || asset === null || asset.bindingState !== "unbound" ||
    !pack.forumConfigured || state.threadBusy || state.threadManagement?.provisioningAvailable !== true
  ) return;
  const confirmed = window.confirm(
    `Inspect the current Discord forum and verify the canonical Registry logo for ${asset.displayName}?\n\n` +
    "The Discord inspection is read-only. The canonical logo is copied only into the local provisioning workspace. No post, binding, chart publication, or Release will be created.",
  );
  if (!confirmed) return;

  clearMessage();
  state.threadBusy = true;
  state.threadForumInspection = null;
  state.threadLogo = null;
  qs("#thread-logo-state").textContent = "VERIFYING CANONICAL REGISTRY LOGO";
  renderThreadTags();
  qs("#thread-provisioning-state").textContent = "INSPECTING CURRENT FORUM TAGS";
  updateThreadAdoptButton();
  try {
    const result = await api(`/api/v1/thread-management/packs/${encodeURIComponent(pack.id)}/forum/inspect`, {
      method: "POST",
      body: JSON.stringify({ confirmation: "inspect_forum_tags" }),
    });
    state.threadForumInspection = result;
    renderThreadTags();
    if (!result.sessionClosed) {
      qs("#thread-logo-state").textContent = "REGISTRY LOGO NOT STAGED";
      qs("#thread-provisioning-state").textContent = "FORUM INSPECTED · SESSION CLOSE FAILED";
      showMessage(
        "The forum was inspected, but the Discord session did not close cleanly. Restart the administration service before provisioning.",
        true,
      );
      return;
    }

    try {
      const logo = await api(
        `/api/v1/thread-management/packs/${encodeURIComponent(pack.id)}/assets/${encodeURIComponent(asset.id)}/provisioning-logo/canonical`,
        { method: "POST", body: "{}" },
      );
      state.threadLogo = logo;
      qs("#thread-logo-state").textContent = `${logo.evidence.width}×${logo.evidence.height} · REGISTRY LOGO VERIFIED`;
      qs("#thread-provisioning-state").textContent = `${result.forum.name.toUpperCase()} · ${result.forum.availableTags.length} TAGS INSPECTED`;
      showMessage(
        `Current tags were loaded from ${result.forum.name}, and ${asset.displayName}'s canonical Registry logo was verified for provisioning. Discord content and local bindings were unchanged.`,
        false,
      );
    } catch (logoError) {
      state.threadLogo = null;
      qs("#thread-logo-state").textContent = logoError.code === "asset_logo_not_found"
        ? "ADD CANONICAL LOGO IN REGISTRY"
        : "REGISTRY LOGO COULD NOT BE VERIFIED";
      qs("#thread-provisioning-state").textContent = `${result.forum.name.toUpperCase()} · TAGS LOADED · LOGO REQUIRED`;
      showMessage(
        logoError.code === "asset_logo_not_found"
          ? `Current tags were loaded from ${result.forum.name}, but ${asset.displayName} has no canonical Registry logo. Add one in Registry before provisioning.`
          : `Current tags were loaded from ${result.forum.name}, but the canonical Registry logo could not be staged: ${logoError.message}`,
        true,
      );
    }
  } catch (error) {
    qs("#thread-logo-state").textContent = "REGISTRY LOGO NOT STAGED";
    qs("#thread-provisioning-state").textContent = "FORUM INSPECTION FAILED";
    showMessage(error.message);
  } finally {
    state.threadBusy = false;
    updateThreadAdoptButton();
  }
}

async function provisionNewThread() {
  const pack = selectedThreadPack();
  const asset = selectedThreadAsset();
  const inspection = state.threadForumInspection;
  const logo = state.threadLogo;
  const title = qs("#thread-title").value;
  const appliedTagIds = selectedThreadTagIds();
  if (
    pack === null || asset === null || asset.bindingState !== "unbound" ||
    inspection?.packId !== pack.id || inspection.sessionClosed !== true ||
    logo?.packId !== pack.id || logo.assetId !== asset.id || state.threadBusy
  ) return;
  const selectedTagNames = inspection.forum.availableTags
    .filter((tag) => appliedTagIds.includes(tag.id))
    .map((tag) => tag.name);
  const confirmed = window.confirm(
    `Create one new Discord forum post for ${asset.id.toUpperCase()} in ${pack.displayName}?\n\n` +
    `Title: ${title}\nTags: ${selectedTagNames.length === 0 ? "none" : selectedTagNames.join(", ")}\nLogo SHA-256: ${logo.evidence.sha256}\n\n` +
    "VisionX will create the post with this canonical Registry logo as its starter message, then atomically record its persistent binding. This does not publish a chart or create a Release.",
  );
  if (!confirmed) return;

  clearMessage();
  state.threadBusy = true;
  qs("#thread-provisioning-state").textContent = "CREATING AND BINDING DISCORD POST";
  updateThreadAdoptButton();
  try {
    const result = await api("/api/v1/thread-management/provision", {
      method: "POST",
      body: JSON.stringify({
        packId: pack.id,
        assetId: asset.id,
        title,
        appliedTagIds,
        logoSha256: logo.evidence.sha256,
        confirmation: "provision_new_thread",
      }),
    });
    resetThreadProvisioning();
    qs("#thread-id").value = "";
    await loadThreadManagement();
    qs("#thread-provisioning-state").textContent = `${asset.id.toUpperCase()} · POST CREATED & BOUND`;
    showMessage(
      result.sessionClosed
        ? `${asset.id.toUpperCase()} now routes to new Discord thread ${result.thread.threadId}. No chart was published.`
        : `${asset.id.toUpperCase()} was created and bound, but the Discord session did not close cleanly. Restart the administration service before another Discord operation.`,
      !result.sessionClosed,
    );
  } catch (error) {
    const retained = error.details?.retainedThreadId;
    qs("#thread-provisioning-state").textContent = retained ? "RETAINED PROVISIONAL THREAD · ACTION REQUIRED" : "PROVISIONING NOT COMPLETED";
    showMessage(retained ? `${error.message} Retained thread: ${retained}.` : error.message);
    await loadThreadManagement().catch(() => undefined);
  } finally {
    state.threadBusy = false;
    updateThreadAdoptButton();
  }
}

function renderRegistryLogo() {
  const card = qs("#registry-logo-card");
  const image = qs("#registry-logo-image");
  const status = state.registryLogo;
  card.hidden = state.registrySelectedAsset === null;
  if (status?.exists) {
    image.hidden = false;
    image.src = `${status.url}?v=${encodeURIComponent(status.evidence.sha256)}`;
    image.alt = `${state.registrySelectedAsset.displayName} canonical logo`;
    qs("#registry-logo-state").textContent = "CANONICAL LOGO VERIFIED";
    qs("#registry-logo-evidence").textContent = `${status.evidence.width}×${status.evidence.height} · SHA-256 ${status.evidence.sha256.slice(0, 12).toUpperCase()}…`;
    qs("#registry-remove-logo").hidden = false;
  } else {
    image.hidden = true;
    image.removeAttribute("src");
    image.alt = "";
    qs("#registry-logo-state").textContent = "NO CANONICAL LOGO";
    qs("#registry-logo-evidence").textContent = "Upload one PNG here; Packs and downstream thread creation reuse it by stable Asset ID.";
    qs("#registry-remove-logo").hidden = true;
  }
}

function renderRegistryInspector() {
  const asset = state.registrySelectedAsset;
  const facts = qs("#registry-asset-facts");
  const controls = qs("#registry-primary-controls");
  const workflows = qs("#registry-workflow-actions");
  const packChoiceLabel = qs("#registry-pack-choice-label");
  const packChoice = qs("#registry-pack-choice");

  if (asset === null) {
    qs("#registry-inspector-heading").textContent = "SELECT AN ASSET";
    qs("#registry-inspector-state").textContent = "NO SELECTION";
    qs("#registry-inspector-state").className = "workspace-status pending";
    qs("#registry-inspector-guidance").textContent = "Choose MANAGE beside a current result to verify its exact Asset ID and inspect canonical metadata.";
    facts.hidden = true;
    facts.innerHTML = "";
    controls.hidden = true;
    workflows.hidden = true;
    qs("#registry-logo-card").hidden = true;
    return;
  }

  const packs = asset.packIds.length ? asset.packIds.join(", ") : "NONE";
  const renderReady = Boolean(asset.currency && /^[^:]+:[^:]+$/u.test(asset.tradingViewSymbol));
  qs("#registry-inspector-heading").textContent = asset.displayName;
  qs("#registry-inspector-state").textContent = "CURRENT REGISTRY ASSET";
  qs("#registry-inspector-state").className = "workspace-status valid";
  qs("#registry-inspector-guidance").textContent = "This exact current Asset ID was revalidated before editing controls were enabled.";
  facts.hidden = false;
  facts.innerHTML = `
    <dt>DISPLAY NAME</dt><dd>${escapeHtml(asset.displayName)}</dd>
    <dt>TRADINGVIEW</dt><dd>${escapeHtml(asset.tradingViewSymbol)}</dd>
    <dt>CURRENCY</dt><dd>${escapeHtml(asset.currency ?? "MISSING")}</dd>
    <dt>ASSIGNED CHANNEL</dt><dd>${escapeHtml(asset.logicalChannel)}</dd>
    <dt>PACK MEMBERSHIPS</dt><dd>${escapeHtml(packs)}</dd>
    <dt>INTERNAL ID</dt><dd>${escapeHtml(asset.id)}</dd>`;
  controls.hidden = false;
  workflows.hidden = false;
  packChoice.innerHTML = asset.packIds.map((packId) => `<option value="${escapeAttribute(packId)}">${escapeHtml(packId.toUpperCase())}</option>`).join("");
  packChoiceLabel.hidden = asset.packIds.length === 0;
  qs("#registry-open-render").disabled = !renderReady;
  qs("#registry-open-threads").disabled = asset.packIds.length === 0;
  qs("#registry-retire-asset").disabled = asset.packIds.length > 0;
  renderRegistryLogo();
}

async function loadRegistryLogo(assetId) {
  const selectedId = state.registrySelectedAsset?.id;
  state.registryLogo = null;
  renderRegistryLogo();
  const status = await api(`/api/v1/assets/${encodeURIComponent(assetId)}/logo/status`);
  if (state.registrySelectedAsset?.id !== selectedId || selectedId !== assetId) return;
  state.registryLogo = status;
  renderRegistryLogo();
}

async function selectRegistryAsset(assetId) {
  const generation = ++state.registrySelectionGeneration;
  state.registrySelectedAsset = null;
  state.registryLogo = null;
  qs("#registry-inspector-heading").textContent = assetId.toUpperCase();
  qs("#registry-inspector-state").textContent = "VERIFYING CURRENT ID";
  qs("#registry-inspector-state").className = "workspace-status pending";
  qs("#registry-inspector-guidance").textContent = "Rechecking the exact Asset ID against current canonical Registry state.";
  qs("#registry-asset-facts").hidden = true;
  qs("#registry-primary-controls").hidden = true;
  qs("#registry-workflow-actions").hidden = true;
  try {
    const asset = await api(`/api/v1/assets/${encodeURIComponent(assetId)}`);
    if (generation !== state.registrySelectionGeneration) return;
    state.registrySelectedAsset = asset;
    renderRegistryInspector();
    await loadRegistryLogo(asset.id);
  } catch (error) {
    if (generation !== state.registrySelectionGeneration) return;
    state.registrySelectedAsset = null;
    renderRegistryInspector();
    showMessage(error.message);
  }
}

function renderRegistryPackFilters() {
  const container = qs("#registry-pack-filters");
  const options = [{ id: "", displayName: "All Assets", membershipCount: state.status?.registryAssetCount ?? 0 }, ...state.registryPacks];
  container.innerHTML = options.map((pack) => `
    <button class="registry-pack-filter" type="button" data-registry-pack-filter="${escapeAttribute(pack.id)}" aria-pressed="${pack.id === state.registryPackId ? "true" : "false"}">
      ${escapeHtml(pack.displayName.toUpperCase())} · ${pack.membershipCount}
    </button>`).join("");
  qsa("[data-registry-pack-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      const next = button.dataset.registryPackFilter ?? "";
      if (next === state.registryPackId || state.registryBusy) return;
      state.registryPackId = next;
      state.registryOffset = 0;
      renderRegistryPackFilters();
      void loadRegistry({ offset: 0 }).catch((error) => showMessage(error.message));
    });
  });
}

async function loadRegistryPacks() {
  state.registryPacks = await api("/api/v1/packs");
  if (state.registryPackId && !state.registryPacks.some((pack) => pack.id === state.registryPackId)) state.registryPackId = "";
  renderRegistryPackFilters();
}

function renderRegistryResults() {
  const body = qs("#registry-body");
  if (state.registryAssets.length === 0) {
    body.innerHTML = '<tr><td colspan="7">NO CURRENT REGISTRY ASSETS MATCH THIS SEARCH.</td></tr>';
  } else {
    body.innerHTML = state.registryAssets.map((asset) => `<tr>
      <td><strong>${escapeHtml(asset.displayName)}</strong></td>
      <td>${escapeHtml(asset.tradingViewSymbol)}</td>
      <td>${escapeHtml(asset.currency ?? "—")}</td>
      <td>${escapeHtml(asset.logicalChannel)}</td>
      <td>${escapeHtml(asset.packIds.length ? asset.packIds.join(", ") : "—")}</td>
      <td class="secondary-id">${escapeHtml(asset.id)}</td>
      <td><button class="outline-action compact-action" type="button" data-manage-registry-asset="${escapeAttribute(asset.id)}">MANAGE</button></td>
    </tr>`).join("");
  }
  qsa("[data-manage-registry-asset]").forEach((button) => {
    button.addEventListener("click", () => void selectRegistryAsset(button.dataset.manageRegistryAsset));
  });

  const first = state.registryTotal === 0 ? 0 : state.registryOffset + 1;
  const last = Math.min(state.registryOffset + state.registryAssets.length, state.registryTotal);
  const selectedPack = state.registryPacks.find((pack) => pack.id === state.registryPackId);
  qs("#registry-context").textContent = `${state.registryTotal} MATCH${state.registryTotal === 1 ? "" : "ES"}${selectedPack ? ` · ${selectedPack.displayName.toUpperCase()}` : ""}`;
  qs("#registry-page-state").textContent = state.registryTotal === 0 ? "0 RESULTS" : `${first}–${last} OF ${state.registryTotal}`;
  qs("#registry-previous").disabled = state.registryBusy || state.registryOffset === 0;
  qs("#registry-next").disabled = state.registryBusy || state.registryOffset + state.registryAssets.length >= state.registryTotal;
}

async function loadRegistry(options = {}) {
  const query = options.query ?? state.registryQuery;
  const offset = options.offset ?? state.registryOffset;
  const generation = ++state.registrySearchGeneration;
  state.registryQuery = query;
  state.registryOffset = offset;
  state.registryBusy = true;
  qs("#registry-context").textContent = "SEARCHING CURRENT REGISTRY";
  qs("#registry-previous").disabled = true;
  qs("#registry-next").disabled = true;
  try {
    const parameters = new URLSearchParams({ q: query, offset: String(offset), limit: String(state.registryLimit) });
    if (state.registryPackId) parameters.set("pack", state.registryPackId);
    const result = await api(`/api/v1/assets?${parameters.toString()}`);
    if (generation !== state.registrySearchGeneration) return;
    if (result.total > 0 && result.assets.length === 0 && offset >= result.total) {
      const lastOffset = Math.floor((result.total - 1) / state.registryLimit) * state.registryLimit;
      await loadRegistry({ query, offset: lastOffset });
      return;
    }
    state.registryOffset = result.offset;
    state.registryTotal = result.total;
    state.registryAssets = result.assets;
    renderRegistryResults();
  } catch (error) {
    if (generation !== state.registrySearchGeneration) return;
    throw error;
  } finally {
    if (generation === state.registrySearchGeneration) {
      state.registryBusy = false;
      renderRegistryResults();
    }
  }
}

function scheduleRegistrySearch(query) {
  clearTimeout(state.registrySearchTimer);
  state.registryQuery = query;
  state.registryOffset = 0;
  state.registrySearchGeneration += 1;
  qs("#registry-context").textContent = "SEARCH PENDING";
  qs("#registry-previous").disabled = true;
  qs("#registry-next").disabled = true;
  state.registrySearchTimer = setTimeout(() => void loadRegistry({ query, offset: 0 }).catch((error) => showMessage(error.message)), 180);
}

async function refreshRegistryState() {
  if (state.registryBusy) return;
  state.registryBusy = true;
  qs("#registry-context").textContent = "REFRESHING CANONICAL STATE";
  const selectedId = state.registrySelectedAsset?.id ?? null;
  try {
    await api("/api/v1/refresh", { method: "POST" });
    state.renderOptions = null;
    await refreshStatus();
    await loadRegistryPacks();
    await loadRegistry({ query: qs("#registry-search").value, offset: 0 });
    if (selectedId !== null) await selectRegistryAsset(selectedId);
    showMessage("Canonical Registry, Pack, and channel state refreshed. No source file was changed.", false);
  } finally {
    state.registryBusy = false;
  }
}

function suggestedAssetId(tradingView) {
  const token = tradingView.split(":").at(-1) ?? "";
  return token.toLocaleLowerCase("en-US").replace(/[^a-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 64);
}

function resetRegistryChangePreview() {
  state.registryChangePreview = null;
  qs("#registry-change-preview").hidden = true;
  qs("#registry-change-summary").innerHTML = "";
  qs("#registry-change-technical").textContent = "";
  qs("#registry-apply-change").disabled = true;
}

async function populateRegistryChannelOptions() {
  if (state.channels.length === 0) await loadChannels();
  const select = qs("#registry-field-channel");
  const selected = select.value;
  select.innerHTML = '<option value="">SELECT CHANNEL</option>' + state.channels.map((channel) => `<option value="${escapeAttribute(channel)}">${escapeHtml(channel.toUpperCase())}</option>`).join("");
  select.value = selected;
}

function registryEditorFocusableElements() {
  return qsa("#registry-editor button, #registry-editor input, #registry-editor select, #registry-editor summary")
    .filter((element) => !element.disabled && !element.hidden && element.getAttribute("aria-hidden") !== "true" && element.offsetParent !== null);
}

function handleRegistryEditorKeydown(event) {
  const editor = qs("#registry-editor");
  if (editor.hidden) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeRegistryEditor();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = registryEditorFocusableElements();
  if (focusable.length === 0) {
    event.preventDefault();
    editor.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

async function openRegistryEditor(mode) {
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  try {
    state.registryEditorMode = mode;
    state.registryChangeBusy = false;
    qs("#registry-editor").setAttribute("aria-busy", "false");
    resetRegistryChangePreview();
    await populateRegistryChannelOptions();
    const asset = mode === "edit" ? state.registrySelectedAsset : null;
    if (mode === "edit" && asset === null) throw new Error("Select a current Registry Asset before editing metadata.");
    qs("#registry-editor-heading").textContent = mode === "edit" ? `EDIT ${asset.displayName.toUpperCase()}` : "ADD ASSET";
    qs("#registry-editor-guidance").textContent = mode === "edit"
      ? "The stable Asset ID cannot change. Review the exact metadata source change before applying it."
      : "Create one canonical Asset. Pack membership and logos are managed separately after creation.";
    qs("#registry-field-id").value = asset?.id ?? "";
    qs("#registry-field-id").dataset.suggestedId = asset?.id ?? "";
    qs("#registry-field-id").disabled = mode === "edit";
    qs("#registry-field-display").value = asset?.displayName ?? "";
    qs("#registry-field-tradingview").value = asset?.tradingViewSymbol ?? "";
    qs("#registry-field-currency").value = asset?.currency ?? "";
    qs("#registry-field-channel").value = asset?.logicalChannel ?? "";
    state.registryEditorReturnFocus = returnFocus;
    qs("#registry-editor-backdrop").hidden = false;
    qs("#registry-editor").hidden = false;
    document.body.classList.add("registry-editor-open");
    setModalIsolation(true);
    requestAnimationFrame(() => {
      if (!qs("#registry-editor").hidden) qs("#registry-field-display").focus();
    });
  } catch (error) {
    closeRegistryEditor({ restoreFocus: false });
    throw error;
  }
}

function closeRegistryEditor(options = {}) {
  const restoreFocus = options.restoreFocus !== false;
  qs("#registry-editor").hidden = true;
  qs("#registry-editor-backdrop").hidden = true;
  document.body.classList.remove("registry-editor-open");
  setModalIsolation(false);
  resetRegistryChangePreview();
  const returnFocus = state.registryEditorReturnFocus;
  state.registryEditorReturnFocus = null;
  if (restoreFocus && returnFocus?.isConnected) returnFocus.focus();
}

function resetRegistryImportPreview() {
  state.registryImportPreview = null;
  qs("#registry-import-preview").hidden = true;
  qs("#registry-import-summary").innerHTML = "";
  qs("#registry-import-issues").hidden = true;
  qs("#registry-import-issues").innerHTML = "";
  qs("#registry-import-body").innerHTML = "";
  qs("#registry-import-technical").textContent = "";
  qs("#registry-apply-import").disabled = true;
}

function registryImportFocusableElements() {
  return qsa("#registry-import-dialog button, #registry-import-dialog input, #registry-import-dialog summary")
    .filter((element) => !element.disabled && !element.hidden && element.getAttribute("aria-hidden") !== "true" && element.offsetParent !== null);
}

function handleRegistryImportKeydown(event) {
  const dialog = qs("#registry-import-dialog");
  if (dialog.hidden) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeRegistryImport();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = registryImportFocusableElements();
  if (focusable.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function openRegistryImport() {
  state.registryImportReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  state.registryImportFile = null;
  state.registryImportBusy = false;
  qs("#registry-import-dialog").setAttribute("aria-busy", "false");
  qs("#registry-import-file").value = "";
  qs("#registry-import-file-state").textContent = "SELECT A UTF-8 CSV FILE";
  qs("#registry-review-import").disabled = true;
  resetRegistryImportPreview();
  qs("#registry-import-backdrop").hidden = false;
  qs("#registry-import-dialog").hidden = false;
  document.body.classList.add("registry-editor-open");
  setModalIsolation(true);
  requestAnimationFrame(() => qs("#registry-import-file").focus());
}

function closeRegistryImport(options = {}) {
  const restoreFocus = options.restoreFocus !== false;
  qs("#registry-import-dialog").hidden = true;
  qs("#registry-import-backdrop").hidden = true;
  document.body.classList.remove("registry-editor-open");
  setModalIsolation(false);
  resetRegistryImportPreview();
  state.registryImportFile = null;
  const returnFocus = state.registryImportReturnFocus;
  state.registryImportReturnFocus = null;
  if (restoreFocus && returnFocus?.isConnected) returnFocus.focus();
}

function setRegistryImportFile(file) {
  state.registryImportFile = file;
  resetRegistryImportPreview();
  const valid = file !== null && file.size > 0 && file.size <= 2 * 1024 * 1024;
  qs("#registry-review-import").disabled = !valid;
  qs("#registry-import-file-state").textContent = file === null
    ? "SELECT A UTF-8 CSV FILE"
    : `${file.name} · ${file.size.toLocaleString()} BYTES${file.size > 2 * 1024 * 1024 ? " · EXCEEDS 2 MB LIMIT" : ""}`;
}

function renderRegistryImportPreview() {
  const preview = state.registryImportPreview;
  if (preview === null) return resetRegistryImportPreview();
  qs("#registry-import-preview").hidden = false;
  qs("#registry-import-preview-title").textContent = preview.valid ? "CSV READY TO APPLY" : "CSV REQUIRES CORRECTION";
  qs("#registry-import-summary").innerHTML = preview.valid
    ? `<p><strong>${preview.additionCount} NEW ASSET${preview.additionCount === 1 ? "" : "S"}</strong> validated from ${escapeHtml(preview.fileName)}. ${preview.packMembershipCount} Pack membership${preview.packMembershipCount === 1 ? "" : "s"} will be appended.</p><p>The Registry and Packs source files will be replaced as one rollback-protected transaction. No chart, Release, thread, or Discord operation occurs.</p>`
    : `<p><strong>${preview.issues.length} BLOCKING ISSUE${preview.issues.length === 1 ? "" : "S"}</strong> found in ${escapeHtml(preview.fileName)}. Nothing can be applied until every issue is corrected.</p>`;
  const issues = qs("#registry-import-issues");
  issues.hidden = preview.issues.length === 0;
  issues.innerHTML = preview.issues.length === 0 ? "" : `<ul>${preview.issues.map((entry) => `<li>${entry.rowNumber ? `ROW ${entry.rowNumber}${entry.field ? ` · ${escapeHtml(entry.field.toUpperCase())}` : ""}: ` : ""}${escapeHtml(entry.message)}</li>`).join("")}</ul>`;
  qs("#registry-import-body").innerHTML = preview.rows.length === 0
    ? '<tr><td colspan="7">NO ASSET ROWS AVAILABLE.</td></tr>'
    : preview.rows.map((row) => `<tr>
      <td>${row.rowNumber}</td>
      <td><strong>${escapeHtml(row.displayName || "—")}</strong></td>
      <td>${escapeHtml(row.tradingViewSymbol || "—")}</td>
      <td>${escapeHtml(row.currency || "—")}</td>
      <td>${escapeHtml(row.channel || "—")}</td>
      <td>${escapeHtml(row.packIds.length ? row.packIds.join(", ") : "—")}</td>
      <td class="secondary-id">${escapeHtml(row.id || "—")}</td>
    </tr>`).join("");
  qs("#registry-import-technical").textContent = JSON.stringify({ previewId: preview.previewId, sourceState: preview.sourceState, effects: preview.effects }, null, 2);
  qs("#registry-apply-import").disabled = !preview.valid;
}

async function reviewRegistryCsvImport() {
  const file = state.registryImportFile;
  if (file === null || state.registryImportBusy) return;
  state.registryImportBusy = true;
  qs("#registry-import-dialog").setAttribute("aria-busy", "true");
  qs("#registry-review-import").disabled = true;
  resetRegistryImportPreview();
  try {
    const preview = await api(`/api/v1/registry/csv-import/preview?filename=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "Content-Type": "text/csv" },
      body: file,
    });
    state.registryImportPreview = preview;
    renderRegistryImportPreview();
  } catch (error) {
    showMessage(error.message);
  } finally {
    state.registryImportBusy = false;
    qs("#registry-import-dialog").setAttribute("aria-busy", "false");
    const selected = state.registryImportFile;
    qs("#registry-review-import").disabled = selected === null || selected.size < 1 || selected.size > 2 * 1024 * 1024;
  }
}

async function applyRegistryCsvImportFromUi() {
  const preview = state.registryImportPreview;
  if (preview === null || !preview.valid || state.registryImportBusy) return;
  if (!window.confirm(`Import ${preview.additionCount} new Registry Asset${preview.additionCount === 1 ? "" : "s"}?\n\n${preview.packMembershipCount} Pack membership${preview.packMembershipCount === 1 ? "" : "s"} will also be appended. The operation is atomic and does not contact Discord.`)) return;
  state.registryImportBusy = true;
  qs("#registry-import-dialog").setAttribute("aria-busy", "true");
  qs("#registry-apply-import").disabled = true;
  try {
    const result = await api(`/api/v1/registry/csv-import/${encodeURIComponent(preview.previewId)}/apply`, {
      method: "POST",
      body: JSON.stringify({ confirmation: "APPLY REGISTRY CSV IMPORT" }),
    });
    await refreshStatus();
    state.registryPackId = "";
    await loadRegistryPacks();
    qs("#registry-search").value = "";
    await loadRegistry({ query: "", offset: 0 });
    closeRegistryImport();
    showMessage(`${result.importedAssetCount} Registry Asset${result.importedAssetCount === 1 ? "" : "s"} imported successfully. No Discord operation occurred.`, false);
  } catch (error) {
    showMessage(error.message);
    resetRegistryImportPreview();
    await refreshRegistryState().catch(() => undefined);
  } finally {
    state.registryImportBusy = false;
    qs("#registry-import-dialog").setAttribute("aria-busy", "false");
    qs("#registry-apply-import").disabled = !state.registryImportPreview?.valid;
  }
}

function downloadRegistryCsvTemplate() {
  const csv = "id,display_name,tradingview_symbol,currency,channel,pack_ids\nnew_asset,New Asset,NASDAQ:NEWASSET,USD,stocks,stocks\n";
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "visionx-registry-import-template.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function registryChangeValue() {
  return {
    operation: state.registryEditorMode === "edit" ? "update" : "add",
    asset: {
      id: qs("#registry-field-id").value,
      displayName: qs("#registry-field-display").value,
      tradingViewSymbol: qs("#registry-field-tradingview").value,
      currency: qs("#registry-field-currency").value.toUpperCase(),
      channel: qs("#registry-field-channel").value,
    },
  };
}

async function reviewRegistryChange() {
  if (state.registryChangeBusy) return;
  state.registryChangeBusy = true;
  qs("#registry-editor").setAttribute("aria-busy", "true");
  resetRegistryChangePreview();
  qs("#registry-review-change").disabled = true;
  try {
    const preview = await api("/api/v1/registry/asset-changes/preview", {
      method: "POST",
      body: JSON.stringify({ change: registryChangeValue() }),
    });
    state.registryChangePreview = preview;
    qs("#registry-change-preview").hidden = false;
    qs("#registry-change-title").textContent = preview.operation === "add" ? "ADD REGISTRY ASSET" : "UPDATE REGISTRY ASSET";
    qs("#registry-change-summary").innerHTML = `
      <p><strong>${escapeHtml(preview.asset.displayName)}</strong></p>
      <dl class="registry-asset-facts">
        ${preview.previous ? `<dt>DISPLAY</dt><dd>${escapeHtml(preview.previous.displayName)} → ${escapeHtml(preview.asset.displayName)}</dd>` : `<dt>DISPLAY</dt><dd>${escapeHtml(preview.asset.displayName)}</dd>`}
        ${preview.previous ? `<dt>TRADINGVIEW</dt><dd>${escapeHtml(preview.previous.tradingViewSymbol)} → ${escapeHtml(preview.asset.tradingViewSymbol)}</dd>` : `<dt>TRADINGVIEW</dt><dd>${escapeHtml(preview.asset.tradingViewSymbol)}</dd>`}
        ${preview.previous ? `<dt>CURRENCY</dt><dd>${escapeHtml(preview.previous.currency ?? "—")} → ${escapeHtml(preview.asset.currency ?? "—")}</dd>` : `<dt>CURRENCY</dt><dd>${escapeHtml(preview.asset.currency ?? "—")}</dd>`}
        ${preview.previous ? `<dt>CHANNEL</dt><dd>${escapeHtml(preview.previous.logicalChannel)} → ${escapeHtml(preview.asset.logicalChannel)}</dd>` : `<dt>CHANNEL</dt><dd>${escapeHtml(preview.asset.logicalChannel)}</dd>`}
        <dt>INTERNAL ID</dt><dd>${escapeHtml(preview.asset.id)} · IMMUTABLE</dd>
      </dl>
      <p>No Pack membership, logo, chart, Release, or Discord content changes in this operation.</p>`;
    qs("#registry-change-technical").textContent = JSON.stringify({ changeId: preview.changeId, sourceState: preview.sourceState, effects: preview.effects }, null, 2);
    qs("#registry-apply-change").disabled = false;
  } catch (error) {
    showMessage(error.message);
  } finally {
    state.registryChangeBusy = false;
    qs("#registry-editor").setAttribute("aria-busy", "false");
    qs("#registry-review-change").disabled = false;
  }
}

async function applyRegistryChange() {
  const preview = state.registryChangePreview;
  if (!preview || state.registryChangeBusy) return;
  if (!window.confirm(`Apply this ${preview.operation} change for ${preview.asset.displayName}?\n\nThis writes canonical Registry source only.`)) return;
  state.registryChangeBusy = true;
  qs("#registry-editor").setAttribute("aria-busy", "true");
  qs("#registry-apply-change").disabled = true;
  try {
    await api(`/api/v1/registry/asset-changes/${encodeURIComponent(preview.changeId)}/apply`, {
      method: "POST",
      body: JSON.stringify({ confirmation: "APPLY REGISTRY ASSET CHANGE" }),
    });
    await refreshStatus();
    await loadRegistry({ query: "", offset: 0 });
    closeRegistryEditor();
    await selectRegistryAsset(preview.asset.id);
    showMessage(`${preview.asset.displayName} is now current in Registry. No Pack, render, Release, or Discord operation occurred.`, false);
  } catch (error) {
    showMessage(error.message);
    await refreshRegistryState().catch(() => undefined);
  } finally {
    state.registryChangeBusy = false;
    qs("#registry-editor").setAttribute("aria-busy", "false");
  }
}

async function storeRegistryLogo(file) {
  const asset = state.registrySelectedAsset;
  if (!asset || !file) return;
  if (!window.confirm(`Store ${file.name} as the canonical logo for ${asset.displayName}?`)) {
    qs("#registry-logo-input").value = "";
    return;
  }
  const expected = state.registryLogo?.evidence?.sha256 ?? "";
  try {
    const query = new URLSearchParams({ expectedSha256: expected, confirmation: "STORE REGISTRY ASSET LOGO" });
    state.registryLogo = await api(`/api/v1/assets/${encodeURIComponent(asset.id)}/logo?${query.toString()}`, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: file,
    });
    renderRegistryLogo();
    showMessage(`${asset.displayName} canonical logo was stored and verified.`, false);
  } catch (error) {
    showMessage(error.message);
    await loadRegistryLogo(asset.id).catch(() => undefined);
  } finally {
    qs("#registry-logo-input").value = "";
  }
}

async function removeRegistryLogo() {
  const asset = state.registrySelectedAsset;
  const sha256 = state.registryLogo?.evidence?.sha256;
  if (!asset || !sha256) return;
  if (!window.confirm(`Remove the canonical logo for ${asset.displayName}?\n\nThis does not alter Registry metadata or any Discord post.`)) return;
  try {
    await api(`/api/v1/assets/${encodeURIComponent(asset.id)}/logo`, {
      method: "DELETE",
      body: JSON.stringify({ expectedSha256: sha256, confirmation: "REMOVE REGISTRY ASSET LOGO" }),
    });
    state.registryLogo = { exists: false, evidence: null, url: null };
    renderRegistryLogo();
    showMessage(`${asset.displayName} canonical logo was removed.`, false);
  } catch (error) {
    showMessage(error.message);
    await loadRegistryLogo(asset.id).catch(() => undefined);
  }
}

async function retireRegistryAssetFromUi() {
  const asset = state.registrySelectedAsset;
  if (!asset) return;
  try {
    const preview = await api(`/api/v1/assets/${encodeURIComponent(asset.id)}/retirement-preview`, { method: "POST", body: "{}" });
    if (preview.blockingPackIds.length || preview.blockingThreadRoutes.length) {
      showMessage(`Retirement is blocked. Remove ${asset.id.toUpperCase()} from Packs (${preview.blockingPackIds.join(", ") || "none"}) and Thread routes (${preview.blockingThreadRoutes.join(", ") || "none"}) first.`);
      return;
    }
    const phrase = `RETIRE ${asset.id.toUpperCase()}`;
    const typed = window.prompt(`Type ${phrase} to retire ${asset.displayName}.\n\nThe canonical logo is retained for recovery.`);
    if (typed !== phrase) return;
    await api(`/api/v1/assets/${encodeURIComponent(asset.id)}/retire`, {
      method: "POST",
      body: JSON.stringify({ previewId: preview.previewId, confirmation: typed }),
    });
    state.registrySelectedAsset = null;
    state.registryLogo = null;
    renderRegistryInspector();
    await refreshStatus();
    await loadRegistry({ query: qs("#registry-search").value, offset: 0 });
    showMessage(`${asset.displayName} was retired from Registry. Its canonical logo was retained for recovery.`, false);
  } catch (error) {
    showMessage(error.message);
  }
}

function useRegistryAssetInPack() {
  const asset = state.registrySelectedAsset;
  if (asset === null) return;
  addMember({ id: asset.id });
  void activateView("packs").then(() => qs("#membership-heading").scrollIntoView({ behavior: "smooth", block: "start" }));
}

async function openRegistryAssetInRender() {
  const asset = state.registrySelectedAsset;
  if (asset === null) return;
  await activateView("renderer");
  const renderAsset = state.renderOptions?.assets.find((entry) => entry.id === asset.id);
  if (!renderAsset) {
    showMessage(`${asset.id.toUpperCase()} requires canonical TradingView and currency metadata before rendering.`);
    return;
  }
  selectRendererAsset(renderAsset);
  qs("#renderer-heading").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function openRegistryAssetThreads() {
  const asset = state.registrySelectedAsset;
  const packId = qs("#registry-pack-choice").value;
  if (asset === null || !packId) return;
  await activateView("threads");
  qs("#thread-pack").value = packId;
  resetThreadProvisioning();
  renderThreadManagement();
  if (![...qs("#thread-asset").options].some((option) => option.value === asset.id)) {
    showMessage(`${asset.id.toUpperCase()} is no longer a member of Pack ${packId.toUpperCase()}. Refresh the Registry selection.`);
    return;
  }
  qs("#thread-asset").value = asset.id;
  qs("#thread-id").value = selectedThreadAsset()?.threadId ?? "";
  resetThreadProvisioning({ keepForum: true });
  renderThreadManagement();
  qs("#thread-adoption-heading").scrollIntoView({ behavior: "smooth", block: "start" });
}

function selectedRendererAsset() {
  const assetId = qs("#renderer-asset").value;
  return state.renderOptions?.assets.find((asset) => asset.id === assetId) ?? null;
}

function rendererIssueLabel(issue) {
  const labels = {
    unqualified_market_symbol: "QUALIFIED TRADINGVIEW SYMBOL REQUIRED",
    missing_publication_currency: "CURRENCY REQUIRED",
    invalid_publication_currency: "CURRENCY INVALID",
    market_symbol_mismatch: "TRADINGVIEW IDENTITY CONFLICT",
    unknown_pack_asset: "PACK MEMBERSHIP INVALID",
    duplicate_pack_asset: "DUPLICATE PACK MEMBERSHIP",
  };
  return labels[issue] ?? issue.replaceAll("_", " ").toUpperCase();
}

function updateRenderButton() {
  const selected = selectedRendererAsset();
  const ready = Boolean(
    selected?.renderReady &&
    qs("#renderer-timeframe").value &&
    state.renderSourceFile &&
    !state.renderBusy
  );
  qs("#render-chart").disabled = !ready;
}

function selectRendererAsset(asset) {
  qs("#renderer-asset").value = asset.id;
  qs("#renderer-asset-search").value = asset.displayName;
  const summary = qs("#renderer-selected-asset");
  const currency = asset.currency ?? "CURRENCY MISSING";
  summary.textContent = asset.renderReady
    ? `${asset.displayName} · ${asset.tradingViewSymbol} · ${currency} · READY TO RENDER`
    : `${asset.displayName} · ${asset.tradingViewSymbol} · ${currency} · ${asset.reconciliationIssues.map(rendererIssueLabel).join(" · ")}`;
  summary.className = `selected-asset-summary ${asset.renderReady ? "ready" : "reconciliation"}`;
  qs("#renderer-open-registry").hidden = asset.renderReady;
  qs("#renderer-asset-results").hidden = true;
  resetStandaloneResult();
}

function renderRendererAssetSearch(query) {
  const panel = qs("#renderer-asset-results");
  const terms = query.trim().toLocaleLowerCase("en-US").split(/\s+/u).filter(Boolean);
  if (terms.length === 0) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  const matches = (state.renderOptions?.assets ?? []).filter((asset) => {
    const haystack = [asset.id, asset.displayName, asset.tradingViewSymbol, asset.currency ?? "", asset.logicalChannel]
      .join(" ").toLocaleLowerCase("en-US");
    return terms.every((term) => haystack.includes(term));
  }).slice(0, 16);
  panel.hidden = false;
  panel.innerHTML = matches.length === 0
    ? '<p class="asset-search-empty">NO REGISTRY ASSETS MATCH.</p>'
    : matches.map((asset) => {
        const readiness = asset.renderReady ? "READY TO RENDER" : asset.reconciliationIssues.map(rendererIssueLabel).join(" · ");
        return `<button type="button" data-renderer-asset="${escapeAttribute(asset.id)}" data-render-ready="${asset.renderReady}"><strong>${escapeHtml(asset.displayName)}</strong><span>${escapeHtml(asset.tradingViewSymbol)} · ${escapeHtml(asset.currency ?? "CURRENCY MISSING")} · ${escapeHtml(asset.logicalChannel.toUpperCase())}</span><span class="asset-search-readiness">${escapeHtml(readiness)}</span></button>`;
      }).join("");
  qsa("[data-renderer-asset]").forEach((button) => button.addEventListener("click", () => {
    const asset = state.renderOptions.assets.find((entry) => entry.id === button.dataset.rendererAsset);
    if (asset) selectRendererAsset(asset);
  }));
}

async function loadStandaloneRenderOptions() {
  if (state.renderOptions !== null) return;
  const result = await api("/api/v1/standalone-render/options");
  state.renderOptions = result;
  qs("#renderer-timeframe").innerHTML = '<option value="">SELECT TIMEFRAME</option>' + result.timeframes
    .map((timeframe) => `<option value="${escapeAttribute(timeframe)}">${escapeHtml(timeframe)}</option>`)
    .join("");
  qs("#renderer-availability").textContent = `${result.assets.length} REGISTRY ASSETS · ${result.renderableAssetCount} RENDER READY · ${result.reconciliationRequiredCount} REQUIRE METADATA RECONCILIATION`;
  updateRenderButton();
}

async function openSelectedRendererAssetInRegistry() {
  const asset = selectedRendererAsset();
  if (asset === null) return;
  await activateView("registry");
  qs("#registry-search").value = asset.id;
  await loadRegistry({ query: asset.id, offset: 0 });
  await selectRegistryAsset(asset.id);
  qs("#registry-inspector").scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetStandaloneResult() {
  qs("#renderer-result").hidden = true;
  qs("#renderer-image").removeAttribute("src");
  updateRenderButton();
}

async function runStandaloneRender() {
  const assetId = qs("#renderer-asset").value;
  const timeframe = qs("#renderer-timeframe").value;
  const file = state.renderSourceFile;
  if (!assetId || !timeframe || !file || state.renderBusy) return;

  clearMessage();
  state.renderBusy = true;
  qs("#renderer-state").textContent = "RENDERING LOCAL ARTIFACT";
  updateRenderButton();
  try {
    const query = new URLSearchParams({ assetId, timeframe, filename: file.name });
    const result = await api(`/api/v1/standalone-renders?${query.toString()}`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: file,
    });
    const downloadStem = `${file.name.replace(/\.png$/iu, "")}-VSX`;
    qs("#renderer-result").hidden = false;
    qs("#renderer-result-heading").textContent = `${result.asset.id.toUpperCase()} RENDER COMPLETE`;
    qs("#renderer-result-context").textContent = `${result.timeframe} · DATA AS OF ${result.dataAsOf}`;
    qs("#renderer-image").src = result.publicationUrl;
    qs("#renderer-caption").textContent = `${result.asset.displayName} · ${result.asset.tradingViewSymbol} · SHA-256 ${result.outputSha256}`;
    qs("#download-publication").href = result.publicationUrl;
    qs("#download-publication").download = `${downloadStem}.png`;
    qs("#download-receipt").href = result.receiptUrl;
    qs("#download-receipt").download = `${downloadStem}.receipt.json`;
    qs("#renderer-state").textContent = "LOCAL RENDER COMPLETE";
  } catch (error) {
    qs("#renderer-state").textContent = "ACTION REQUIRED";
    showMessage(error.message);
  } finally {
    state.renderBusy = false;
    updateRenderButton();
  }
}

function publicationBlockerLabel(blocker) {
  switch (blocker.code) {
    case "pack_incomplete":
      return `MISSING ${blocker.missingAssetIds.map((id) => id.toUpperCase()).join(", ")}`;
    case "missing_staged_images":
      return `STAGING MISSING FOR ${blocker.missingAssetIds.map((id) => id.toUpperCase()).join(", ")}`;
    case "channel_unresolved":
      return "PACK FORUM CHANNEL IS NOT CONFIGURED";
    case "asset_threads_unresolved":
      return `THREAD ROUTES MISSING FOR ${blocker.missingAssetIds.map((id) => id.toUpperCase()).join(", ")}`;
    case "interrupted_release_exists":
      return `INTERRUPTED RELEASE ${blocker.releaseId} · ${blocker.postedCount}/${blocker.totalCount} POSTED`;
    case "published_release_cleanup_required":
      return `PUBLISHED RELEASE ${blocker.releaseId} STILL MATCHES THE ACTIVE PACK WORKSPACE · LOCAL RESET REPAIR REQUIRED`;
    case "capture_session_not_ready": {
      const reasons = {
        downloads_folder_not_configured: "DOWNLOADS FOLDER IS NOT CONFIGURED",
        session_not_started: "ANALYSIS SESSION HAS NOT BEEN STARTED",
        assets_missing: `SESSION MISSING ${blocker.missingAssetIds.map((id) => id.toUpperCase()).join(", ")}`,
        previews_pending: `${blocker.pendingCount} SESSION PREVIEW${blocker.pendingCount === 1 ? "" : "S"} AWAITING ACCEPTANCE`,
        export_window_exceeded: `SESSION EXPORT WINDOW ${blocker.exportSpanMinutes} MIN EXCEEDS ${blocker.maxSpanMinutes} MIN`,
        ready: "CAPTURE SESSION STATE CHANGED",
      };
      return reasons[blocker.reason] ?? "CAPTURE SESSION IS NOT PUBLICATION READY";
    }
    case "discord_unavailable":
      return "DISCORD BOT TOKEN IS NOT AVAILABLE TO THIS ADMINISTRATION PROCESS";
    default:
      return "UNKNOWN PUBLICATION BLOCKER";
  }
}

function publicationPackLabel(pack) {
  if (pack.publication.state === "interrupted") return "INTERRUPTED";
  return pack.publication.ready ? "READY" : "BLOCKED";
}

function clearPublicationPreview() {
  state.publicationPreview = null;
  qs("#publication-preview").hidden = true;
  qs("#publication-preview-packs").innerHTML = "";
  qs("#publication-confirmation").value = "";
  qs("#publication-confirmation").placeholder = "REVIEW PACKS FIRST";
  qs("#publication-apply").disabled = true;
}

function updatePublicationApplyButton() {
  const preview = state.publicationPreview;
  qs("#publication-apply").disabled = state.publicationBusy || preview === null || !preview.valid ||
    qs("#publication-confirmation").value !== preview.confirmation;
}

function renderPublicationQueue() {
  const workspace = state.packWorkspace;
  if (workspace === null) return;
  const currentIds = new Set(workspace.packs.map((pack) => pack.id));
  state.publicationSelectedPackIds = new Set([...state.publicationSelectedPackIds].filter((id) => currentIds.has(id)));
  state.publicationSupersedePackIds = new Set([...state.publicationSupersedePackIds].filter((id) => currentIds.has(id)));

  qs("#workspace-publish-state").textContent = workspace.publicationInProgress
    ? "PUBLICATION IN PROGRESS"
    : workspace.publishAvailable
      ? "PUBLICATION AVAILABLE"
      : "DISCORD DISABLED";
  qs("#publication-pack-pills").innerHTML = workspace.packs.map((pack) => {
    const selected = state.publicationSelectedPackIds.has(pack.id);
    const supersede = state.publicationSupersedePackIds.has(pack.id);
    const interrupted = pack.publication.interruptedRelease !== null;
    return `<span class="publication-pack-item">
      <button class="publication-pack-pill ${pack.publication.state}${selected ? " selected" : ""}" type="button" data-publication-pack="${escapeAttribute(pack.id)}" aria-pressed="${selected}"${state.publicationBusy ? " disabled" : ""}>
        <strong>${escapeHtml(pack.displayName.toUpperCase())}</strong><span>${escapeHtml(publicationPackLabel(pack))}</span>
      </button>
      ${interrupted ? `<button class="publication-policy-pill${supersede ? " selected" : ""}" type="button" data-publication-supersede="${escapeAttribute(pack.id)}" aria-pressed="${supersede}"${state.publicationBusy ? " disabled" : ""}>${supersede ? "SUPERSEDE SELECTED" : "ALLOW SUPERSEDE"}</button>
      <button class="publication-resume-pill" type="button" data-publication-resume="${escapeAttribute(pack.id)}"${state.publicationBusy ? " disabled" : ""}>RESUME</button>` : ""}
    </span>`;
  }).join("");

  const selectedPacks = workspace.packs.filter((pack) => state.publicationSelectedPackIds.has(pack.id));
  const readySelected = selectedPacks.filter((pack) => pack.publication.ready || state.publicationSupersedePackIds.has(pack.id));
  qs("#publication-selection-state").textContent = selectedPacks.length === 0
    ? "NO PACKS SELECTED"
    : `${selectedPacks.length} SELECTED · ${readySelected.length} POTENTIALLY READY`;
  qs("#publication-guidance").textContent = !workspace.publishAvailable
    ? "START ADMINISTRATION WITH A DISCORD BOT TOKEN TO ENABLE PUBLISHING"
    : selectedPacks.length === 0
      ? "SELECT PACKS TO BUILD ONE GOVERNED PUBLICATION OPERATION"
      : `${selectedPacks.map((pack) => pack.displayName.toUpperCase()).join(" · ")} · REVIEW ALL TOGETHER BEFORE DISCORD`;
  qs("#publication-review").disabled = state.publicationBusy || selectedPacks.length === 0;

  qsa("[data-publication-pack]").forEach((button) => button.addEventListener("click", () => {
    const packId = button.dataset.publicationPack;
    if (state.publicationSelectedPackIds.has(packId)) {
      state.publicationSelectedPackIds.delete(packId);
      state.publicationSupersedePackIds.delete(packId);
    } else {
      state.publicationSelectedPackIds.add(packId);
    }
    clearPublicationPreview();
    renderPublicationQueue();
  }));
  qsa("[data-publication-supersede]").forEach((button) => button.addEventListener("click", () => {
    const packId = button.dataset.publicationSupersede;
    state.publicationSelectedPackIds.add(packId);
    if (state.publicationSupersedePackIds.has(packId)) state.publicationSupersedePackIds.delete(packId);
    else state.publicationSupersedePackIds.add(packId);
    clearPublicationPreview();
    renderPublicationQueue();
  }));
  qsa("[data-publication-resume]").forEach((button) => button.addEventListener("click", () => {
    void resumeInterruptedPublication(button.dataset.publicationResume);
  }));
  updatePublicationApplyButton();
}

function renderPublicationPreview(preview) {
  state.publicationPreview = preview;
  qs("#publication-preview").hidden = false;
  qs("#publication-preview-heading").textContent = `${preview.selectedPackIds.length} PACK${preview.selectedPackIds.length === 1 ? "" : "S"} REVIEWED`;
  qs("#publication-preview-state").className = `workspace-status ${preview.valid ? "valid" : "blocked"}`;
  qs("#publication-preview-state").textContent = preview.valid ? "READY TO CONFIRM" : "BLOCKED";
  qs("#publication-preview-packs").innerHTML = preview.packs.map((pack) => {
    const blockers = pack.publication.blockers;
    return `<article class="publication-preview-card ${pack.publication.ready ? "ready" : "blocked"}">
      <div><h4>${escapeHtml(pack.displayName.toUpperCase())} · ${pack.action === "supersede" ? "FRESH SUPERSESSION" : "PUBLISH"}</h4>
      <p>${pack.publication.capturedCount}/${pack.publication.totalCount} CAPTURED · ${pack.publication.stagedCount}/${pack.publication.totalCount} STAGED · ${pack.publication.resolvedThreadCount}/${pack.publication.totalCount} ROUTED</p>
      ${blockers.length === 0 ? "" : `<ul class="publication-blockers">${blockers.map((blocker) => `<li>${escapeHtml(publicationBlockerLabel(blocker))}</li>`).join("")}</ul>`}</div>
      <span class="workspace-status ${pack.publication.ready ? "valid" : "blocked"}">${pack.publication.ready ? "READY" : "BLOCKED"}</span>
    </article>`;
  }).join("");
  qs("#publication-confirmation").value = "";
  qs("#publication-confirmation").placeholder = preview.valid ? preview.confirmation : "RESOLVE EVERY BLOCKER";
  qs("#publication-confirmation").disabled = !preview.valid || state.publicationBusy;
  updatePublicationApplyButton();
}

async function reviewPackPublication() {
  if (state.publicationBusy || state.publicationSelectedPackIds.size === 0) return;
  clearMessage();
  state.publicationBusy = true;
  renderPublicationQueue();
  qs("#publication-guidance").textContent = "REVALIDATING EVERY SELECTED PACK";
  try {
    const preview = await api("/api/v1/pack-workspace/publication/preview", {
      method: "POST",
      body: JSON.stringify({
        packIds: [...state.publicationSelectedPackIds],
        supersedePackIds: [...state.publicationSupersedePackIds],
      }),
    });
    renderPublicationPreview(preview);
    qs("#publication-guidance").textContent = preview.valid
      ? `TYPE ${preview.confirmation} TO ENABLE THE ONE PUBLICATION ACTION`
      : "PUBLICATION REMAINS DISABLED UNTIL EVERY SELECTED PACK BLOCKER IS RESOLVED";
  } catch (error) {
    clearPublicationPreview();
    showMessage(error.message);
  } finally {
    state.publicationBusy = false;
    renderPublicationQueue();
  }
}

async function applyPackPublication() {
  const preview = state.publicationPreview;
  if (preview === null || !preview.valid || state.publicationBusy || qs("#publication-confirmation").value !== preview.confirmation) return;
  clearMessage();
  state.publicationBusy = true;
  qs("#publication-result").hidden = true;
  renderPublicationQueue();
  updatePublicationApplyButton();
  try {
    const result = await api(`/api/v1/pack-workspace/publication/${encodeURIComponent(preview.previewId)}`, {
      method: "POST",
      body: JSON.stringify({ confirmation: preview.confirmation }),
    });
    const publishedNames = result.published.map((item) => item.packId.toUpperCase());
    const resultPanel = qs("#publication-result");
    resultPanel.hidden = false;
    resultPanel.className = `publication-result${result.outcome === "published" ? "" : " error"}`;
    resultPanel.innerHTML = `<h3>${escapeHtml(result.outcome.replaceAll("_", " ").toUpperCase())}</h3>
      <p>${publishedNames.length === 0 ? "NO PACKS COMPLETED" : `PUBLISHED: ${escapeHtml(publishedNames.join(" · "))}`}</p>
      ${result.failed === null ? "" : `<p>FAILED AT ${escapeHtml(result.failed.packId.toUpperCase())}: ${escapeHtml(result.failed.outcome.replaceAll("_", " ").toUpperCase())}${typeof result.failed.detail === "string" ? ` · ${escapeHtml(result.failed.detail)}` : ""}</p>`}
      ${result.notAttemptedPackIds.length === 0 ? "" : `<p>NOT ATTEMPTED: ${escapeHtml(result.notAttemptedPackIds.map((id) => id.toUpperCase()).join(" · "))}</p>`}
      ${result.cleanupWarnings.length === 0 ? "" : `<p>LOCAL CLEANUP WARNINGS: ${escapeHtml(result.cleanupWarnings.map((warning) => `${warning.packId.toUpperCase()} ${warning.code.replaceAll("_", " ").toUpperCase()}`).join(" · "))}</p>`}`;
    state.publicationSelectedPackIds.clear();
    state.publicationSupersedePackIds.clear();
    clearPublicationPreview();
    await loadPackWorkspace();
    showMessage(
      result.outcome === "published"
        ? `${result.published.length} selected Pack${result.published.length === 1 ? " was" : "s were"} published and archived. Unselected Packs were untouched.`
        : "The combined operation did not fully complete. Review the exact published, failed, and unattempted Pack results before retrying.",
      result.outcome !== "published",
    );
  } catch (error) {
    showMessage(error.message);
    await loadPackWorkspace().catch(() => undefined);
  } finally {
    state.publicationBusy = false;
    renderPublicationQueue();
  }
}

async function resumeInterruptedPublication(packId) {
  if (!packId || state.publicationBusy) return;
  const confirmation = `RESUME ${packId.toUpperCase()}`;
  if (!window.confirm(`Resume the interrupted ${packId.toUpperCase()} Release?\n\nVisionX will post only analyses that do not already have a recorded Discord message, using archive custody. It will never duplicate recorded posts.`)) return;
  state.publicationBusy = true;
  renderPublicationQueue();
  try {
    const response = await api("/api/v1/pack-workspace/publication/resume", {
      method: "POST",
      body: JSON.stringify({ packId, confirmation }),
    });
    if (!response.result.ok) {
      showMessage(`Resume did not complete: ${response.result.outcome.replaceAll("_", " ")}.`);
    } else if (response.cleanupWarnings.length > 0) {
      showMessage(`${packId.toUpperCase()} Release ${response.result.releaseId} completed, but local staging, capture-session, or revision cleanup needs review.`);
    } else {
      showMessage(`${packId.toUpperCase()} Release ${response.result.releaseId} was completed without duplicating recorded posts.`, false);
    }
    state.publicationSelectedPackIds.delete(packId);
    state.publicationSupersedePackIds.delete(packId);
    clearPublicationPreview();
    await loadPackWorkspace();
  } catch (error) {
    showMessage(error.message);
  } finally {
    state.publicationBusy = false;
    renderPublicationQueue();
  }
}

function selectedWorkspacePack() {
  return state.packWorkspace?.packs.find((pack) => pack.id === qs("#workspace-pack").value) ?? null;
}

function selectedWorkspaceAsset() {
  return selectedWorkspacePack()?.assets.find((asset) => asset.id === qs("#workspace-asset").value) ?? null;
}

function updateWorkspacePreviewButton() {
  const asset = selectedWorkspaceAsset();
  const pack = selectedWorkspacePack();
  const locked = state.packBusy || state.packPreview !== null;
  qs("#workspace-pack").disabled = locked;
  qs("#workspace-asset").disabled = locked;
  qs("#workspace-source").disabled = locked;
  qs("#workspace-preview-button").disabled = !(
    asset?.renderReady && state.packSourceFile && !locked
  );
  qs("#workspace-accept").disabled = state.packBusy || state.packPreview === null;
  qs("#workspace-discard").disabled = state.packBusy || state.packPreview === null;
  qs("#workspace-reset-pack").hidden = locked || pack === null || pack.capturedCount === 0;
  qs("#workspace-start-session").disabled = locked || pack === null || !state.packCaptureSession?.configured;
  qs("#workspace-scan-session").disabled = locked || pack === null || !state.packCaptureSession?.active;
  const streamlined = qs("#workspace-streamlined-confirmation");
  streamlined.checked = state.streamlinedRevisionConfirmation;
  streamlined.disabled = locked || pack === null || !state.packCaptureSession?.active;
  qsa("[data-reset-workspace-asset]").forEach((button) => { button.hidden = locked; });
  qsa("[data-delete-workspace-revision]").forEach((button) => { button.disabled = locked; });
}

function captureSessionReason(session) {
  const labels = {
    downloads_folder_not_configured: "DOWNLOADS FOLDER NOT CONFIGURED",
    session_not_started: "START A SESSION BEFORE DOWNLOADING",
    assets_missing: `${session.missingAssetIds.length} ASSET${session.missingAssetIds.length === 1 ? "" : "S"} MISSING FROM THIS SESSION`,
    previews_pending: `${session.pendingCount} PREVIEW${session.pendingCount === 1 ? "" : "S"} AWAITING ACCEPTANCE`,
    export_window_exceeded: `EXPORT WINDOW ${session.exportSpanMinutes} MIN EXCEEDS ${session.maxSpanMinutes} MIN`,
    ready: "ALL REQUIRED ASSETS ACCEPTED FROM ONE CURRENT SESSION",
  };
  return labels[session.readinessReason] ?? "SESSION BLOCKED";
}

function reviewQueuedCapture(assetId) {
  const pack = selectedWorkspacePack();
  const session = state.packCaptureSession;
  const asset = pack?.assets.find((candidate) => candidate.id === assetId) ?? null;
  const candidate = session?.candidates.find((item) => item.assetId === assetId && item.state === "pending") ?? null;
  if (pack === null || asset === null || candidate === null || state.packBusy || state.packPreview !== null) return;
  const dateMatch = /_(\d{4}-\d{2}-\d{2})_\d{2}-\d{2}-\d{2}\.png$/iu.exec(candidate.filename);
  state.packPreview = {
    previewId: candidate.previewId,
    packId: pack.id,
    asset,
    timeframe: pack.timeframe,
    dataAsOf: dateMatch?.[1] ?? candidate.exportedAt.slice(0, 10),
    sourceBasename: candidate.filename,
    outputSha256: candidate.sourceSha256,
    nextRevision: asset.revisions + 1,
    publicationUrl: `/api/v1/pack-workspace/previews/${candidate.previewId}/publication.png`,
    receiptUrl: `/api/v1/pack-workspace/previews/${candidate.previewId}/receipt.json`,
  };
  qs("#workspace-preview").hidden = false;
  qs("#workspace-preview-heading").textContent = `${asset.id.toUpperCase()} REVISION ${asset.revisions + 1} READY`;
  qs("#workspace-preview-context").textContent = `${pack.timeframe} · EXPORTED ${candidate.exportedAt}`;
  qs("#workspace-preview-image").src = state.packPreview.publicationUrl;
  qs("#workspace-preview-caption").textContent = `${asset.displayName} · SOURCE SHA-256 ${candidate.sourceSha256}`;
  qs("#workspace-preview-receipt").href = state.packPreview.receiptUrl;
  qs("#workspace-accept").textContent = `ACCEPT REVISION ${asset.revisions + 1}`;
  qs("#workspace-review-state").textContent = "AWAITING ACCEPTANCE";
  updateWorkspacePreviewButton();
}

function renderCaptureSession(session) {
  const sessionIdentity = session.active ? session.sessionId : null;
  if (state.streamlinedCaptureSessionId !== sessionIdentity) {
    state.streamlinedCaptureSessionId = sessionIdentity;
    state.streamlinedRevisionConfirmation = false;
  }
  state.packCaptureSession = session;
  qs("#workspace-streamlined-confirmation").checked = state.streamlinedRevisionConfirmation;
  qs("#workspace-downloads-folder").textContent = session.downloadsFolder ?? "NOT CONFIGURED";
  qs("#workspace-session-started").textContent = session.startedAt ?? "NOT STARTED";
  qs("#workspace-session-progress").textContent = `${session.acceptedCount} ACCEPTED · ${session.pendingCount} PENDING`;
  qs("#workspace-session-readiness").textContent = session.publishReady ? "READY" : "BLOCKED";
  qs("#workspace-session-state").textContent = session.active ? `SESSION ${session.sessionId.slice(0, 8).toUpperCase()}` : "NO ACTIVE SESSION";
  qs("#workspace-session-guidance").textContent = captureSessionReason(session);
  const pending = session.candidates.filter((candidate) => candidate.state === "pending");
  const results = qs("#workspace-scan-results");
  results.hidden = pending.length === 0;
  results.innerHTML = pending.length === 0 ? "" : `
    <p>${pending.length} CHANGED ASSET${pending.length === 1 ? "" : "S"} ${state.streamlinedRevisionConfirmation ? "READY FOR AUTOMATIC ACCEPTANCE" : "QUEUED FOR REVIEW"}</p>
    <ul>${pending.map((candidate) => `<li><button class="outline-action" type="button" data-review-scanned-asset="${escapeAttribute(candidate.assetId)}">${escapeHtml(candidate.assetId.toUpperCase())} · REVIEW</button></li>`).join("")}</ul>
  `;
  qsa("[data-review-scanned-asset]").forEach((button) => {
    button.addEventListener("click", () => reviewQueuedCapture(button.dataset.reviewScannedAsset));
  });
  renderPackWorkspace();
  updateWorkspacePreviewButton();
}

async function loadCaptureSession() {
  const pack = selectedWorkspacePack();
  if (pack === null) return;
  const query = new URLSearchParams({ packId: pack.id });
  renderCaptureSession(await api(`/api/v1/pack-workspace/capture-session?${query.toString()}`));
}

async function startCaptureSession() {
  const pack = selectedWorkspacePack();
  if (pack === null || state.packBusy || !state.packCaptureSession?.configured) return;
  if (!window.confirm(`Start a new ${pack.displayName} capture session now? Only charts downloaded or changed after this baseline will be eligible.`)) return;
  state.packBusy = true;
  updateWorkspacePreviewButton();
  try {
    const result = await api("/api/v1/pack-workspace/capture-session/start", {
      method: "POST",
      body: JSON.stringify({ packId: pack.id }),
    });
    renderCaptureSession(result.session);
    showMessage(`New ${pack.displayName} capture session started. Download the current TradingView charts, then scan the folder.`, false);
  } catch (error) {
    showMessage(error.message);
  } finally {
    state.packBusy = false;
    updateWorkspacePreviewButton();
  }
}

async function acceptStreamlinedCaptureCandidates(candidates) {
  const accepted = [];
  const failed = [];
  for (const candidate of candidates) {
    try {
      const result = await api(`/api/v1/pack-workspace/previews/${encodeURIComponent(candidate.previewId)}/accept`, {
        method: "POST",
        body: "{}",
      });
      accepted.push(Object.freeze({ assetId: result.assetId, revision: result.revisions }));
    } catch (error) {
      failed.push(Object.freeze({ assetId: candidate.assetId, message: error.message }));
    }
  }
  await loadPackWorkspace();
  return Object.freeze({ accepted: Object.freeze(accepted), failed: Object.freeze(failed) });
}

async function scanCaptureSession() {
  const pack = selectedWorkspacePack();
  if (pack === null || state.packBusy || !state.packCaptureSession?.active) return;
  state.packBusy = true;
  qs("#workspace-session-state").textContent = "SCANNING & RENDERING";
  updateWorkspacePreviewButton();
  try {
    const result = await api("/api/v1/pack-workspace/capture-session/scan", {
      method: "POST",
      body: JSON.stringify({ packId: pack.id }),
    });
    renderCaptureSession(result.session);
    const queued = result.scan.queued.length;
    if (queued > 0 && state.streamlinedRevisionConfirmation) {
      qs("#workspace-session-state").textContent = "VERIFYING & STAGING CHANGED ASSETS";
      const accepted = await acceptStreamlinedCaptureCandidates(result.scan.queued);
      if (accepted.failed.length > 0) {
        showMessage(`${accepted.accepted.length} changed Asset${accepted.accepted.length === 1 ? " was" : "s were"} accepted; ${accepted.failed.length} require manual review. ${accepted.failed.map((item) => `${item.assetId.toUpperCase()}: ${item.message}`).join(" ")}`);
      } else {
        showMessage(`${accepted.accepted.length} changed Asset${accepted.accepted.length === 1 ? " was" : "s were"} verified and staged automatically. Unchanged Assets were left untouched. Nothing was sent to Discord.`, false);
      }
    } else {
      showMessage(
        queued === 0
          ? "Synchronization complete. No newer or changed chart exports were found, so no revisions were created."
          : `Synchronization complete. ${queued} changed Asset${queued === 1 ? " is" : "s are"} queued for review; unchanged Assets were left untouched.`,
        false,
      );
    }
  } catch (error) {
    showMessage(error.message);
    await loadCaptureSession().catch(() => undefined);
  } finally {
    state.packBusy = false;
    updateWorkspacePreviewButton();
  }
}

function workspaceAssetStatus(asset) {
  if (asset.captured && !asset.artifactReady) return "STAGED ARTIFACT MISSING";
  if (asset.captured) return "CURRENT ANALYSIS";
  if (!asset.renderReady) return "METADATA REQUIRED";
  return "REQUIRED";
}

function pendingCaptureFor(assetId) {
  return state.packCaptureSession?.candidates.find((candidate) =>
    candidate.assetId === assetId && candidate.state === "pending"
  ) ?? null;
}

function workspaceQuickLookItems(pack) {
  if (pack === null) return [];
  const items = [];
  for (const asset of pack.assets) {
    const pending = pendingCaptureFor(asset.id);
    if (pending !== null) {
      items.push(Object.freeze({
        key: `${asset.id}:pending`,
        assetId: asset.id,
        heading: `${asset.id.toUpperCase()} · NEXT REVISION`,
        imageUrl: `/api/v1/pack-workspace/previews/${pending.previewId}/publication.png`,
        receiptUrl: `/api/v1/pack-workspace/previews/${pending.previewId}/receipt.json`,
        alt: `${asset.displayName} pending Pack render`,
        caption: `${asset.displayName} · AWAITING CONFIRMATION · EXPORTED ${pending.exportedAt} · SOURCE SHA-256 ${pending.sourceSha256}`,
      }));
    }
    for (const revision of [...asset.revisionHistory].sort((left, right) => right.revision - left.revision)) {
      items.push(Object.freeze({
        key: `${asset.id}:${revision.revision}`,
        assetId: asset.id,
        heading: `${asset.id.toUpperCase()} · REVISION ${revision.revision}${revision.current ? " · CURRENT" : ""}`,
        imageUrl: revision.publicationUrl,
        receiptUrl: revision.receiptUrl,
        alt: `${asset.displayName} revision ${revision.revision} render`,
        caption: `${asset.displayName} · ${revision.timeframe} · DATA AS OF ${revision.dataAsOf} · ACCEPTED ${revision.acceptedAt}`,
      }));
    }
  }
  return items;
}

function renderWorkspaceQuickLook() {
  const item = state.workspaceQuickLookItems[state.workspaceQuickLookIndex] ?? null;
  if (item === null) return;
  qs("#workspace-quick-look-heading").textContent = item.heading;
  qs("#workspace-quick-look-image").src = item.imageUrl;
  qs("#workspace-quick-look-image").alt = item.alt;
  qs("#workspace-quick-look-caption").textContent = item.caption;
  qs("#workspace-quick-look-receipt").href = item.receiptUrl;
  qs("#workspace-quick-look-position").textContent = `${state.workspaceQuickLookIndex + 1} OF ${state.workspaceQuickLookItems.length}`;
  qs("#workspace-quick-look-previous").disabled = state.workspaceQuickLookItems.length < 2;
  qs("#workspace-quick-look-next").disabled = state.workspaceQuickLookItems.length < 2;
}

function openWorkspaceQuickLook(key, trigger = null) {
  const items = workspaceQuickLookItems(selectedWorkspacePack());
  const index = items.findIndex((item) => item.key === key);
  if (index < 0) return;
  state.workspaceQuickLookItems = items;
  state.workspaceQuickLookIndex = index;
  state.workspaceQuickLookReturnFocus = trigger instanceof HTMLElement ? trigger : document.activeElement;
  qs("#workspace-quick-look-backdrop").hidden = false;
  qs("#workspace-quick-look").hidden = false;
  document.body.classList.add("registry-editor-open");
  setModalIsolation(true);
  renderWorkspaceQuickLook();
  requestAnimationFrame(() => qs("#workspace-quick-look").focus());
}

function closeWorkspaceQuickLook() {
  if (qs("#workspace-quick-look").hidden) return;
  qs("#workspace-quick-look").hidden = true;
  qs("#workspace-quick-look-backdrop").hidden = true;
  qs("#workspace-quick-look-image").removeAttribute("src");
  document.body.classList.remove("registry-editor-open");
  setModalIsolation(false);
  const target = state.workspaceQuickLookReturnFocus;
  state.workspaceQuickLookItems = [];
  state.workspaceQuickLookIndex = 0;
  state.workspaceQuickLookReturnFocus = null;
  if (target instanceof HTMLElement && document.contains(target)) target.focus();
}

function moveWorkspaceQuickLook(delta) {
  const count = state.workspaceQuickLookItems.length;
  if (count < 2) return;
  state.workspaceQuickLookIndex = (state.workspaceQuickLookIndex + delta + count) % count;
  renderWorkspaceQuickLook();
}

function handleWorkspaceQuickLookKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeWorkspaceQuickLook();
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    moveWorkspaceQuickLook(-1);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    moveWorkspaceQuickLook(1);
  } else if (event.key === "Tab") {
    const focusable = qsa('#workspace-quick-look a[href], #workspace-quick-look button:not([disabled])')
      .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
    if (focusable.length === 0) {
      event.preventDefault();
      qs("#workspace-quick-look").focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
}

function workspaceRevisionPanel(pack, asset) {
  const pending = pendingCaptureFor(asset.id);
  const history = [...asset.revisionHistory].sort((left, right) => right.revision - left.revision);
  const cards = [];
  if (pending !== null) {
    cards.push(`<article class="workspace-revision-card pending">
      <header><strong>NEXT REVISION · AWAITING CONFIRMATION</strong><span>${escapeHtml(pending.exportedAt)}</span></header>
      <img loading="lazy" src="/api/v1/pack-workspace/previews/${escapeAttribute(pending.previewId)}/publication.png" alt="${escapeAttribute(asset.displayName)} pending Pack render">
      <p>SOURCE SHA-256 ${escapeHtml(pending.sourceSha256)}</p>
      <div class="workspace-revision-actions">
        <button class="outline-action compact-action" type="button" data-workspace-quick-look="${escapeAttribute(`${asset.id}:pending`)}">QUICK LOOK</button>
        <a class="outline-action download-link compact-action" href="/api/v1/pack-workspace/previews/${escapeAttribute(pending.previewId)}/receipt.json" target="_blank" rel="noreferrer">RECEIPT</a>
        <button class="primary-action compact-action" type="button" data-confirm-pending-revision="${escapeAttribute(asset.id)}">REVIEW &amp; CONFIRM</button>
      </div>
    </article>`);
  }
  for (const revision of history) {
    cards.push(`<article class="workspace-revision-card${revision.current ? " current" : ""}">
      <header><strong>REVISION ${revision.revision} · CONFIRMED${revision.current ? " · CURRENT" : ""}</strong><span>${escapeHtml(revision.acceptedAt)}</span></header>
      <img loading="lazy" src="${escapeAttribute(revision.publicationUrl)}" alt="${escapeAttribute(asset.displayName)} revision ${revision.revision} render">
      <p>${escapeHtml(revision.timeframe)} · DATA AS OF ${escapeHtml(revision.dataAsOf)}</p>
      <div class="workspace-revision-actions">
        <button class="outline-action compact-action" type="button" data-workspace-quick-look="${escapeAttribute(`${asset.id}:${revision.revision}`)}">QUICK LOOK</button>
        <a class="outline-action download-link compact-action" href="${escapeAttribute(revision.receiptUrl)}" target="_blank" rel="noreferrer">RECEIPT</a>
        <button class="danger-action compact-action" type="button" data-delete-workspace-revision="${revision.revision}" data-revision-asset="${escapeAttribute(asset.id)}">DELETE REVISION ${revision.revision}</button>
      </div>
    </article>`);
  }
  return `<tr class="workspace-revision-row"><td colspan="5">
    <section class="workspace-revision-panel" aria-label="${escapeAttribute(asset.displayName)} revision history">
      <p class="workspace-revision-summary">${cards.length} REVISION ITEM${cards.length === 1 ? "" : "S"} · ROUTINE ACCEPTANCE MAY BE STREAMLINED FOR THIS CAPTURE SESSION ONLY</p>
      <div class="workspace-revision-grid">${cards.join("") || '<p class="empty-state">NO REVISION EVIDENCE</p>'}</div>
    </section>
  </td></tr>`;
}

function toggleWorkspaceAssetHistory(assetId) {
  const pack = selectedWorkspacePack();
  if (pack === null || !pack.assets.some((asset) => asset.id === assetId)) return;
  if (state.expandedWorkspaceAssets.has(assetId)) state.expandedWorkspaceAssets.delete(assetId);
  else state.expandedWorkspaceAssets.add(assetId);
  renderPackWorkspace();
}

async function deleteWorkspaceRevision(assetId, revision) {
  const pack = selectedWorkspacePack();
  const asset = pack?.assets.find((candidate) => candidate.id === assetId) ?? null;
  if (pack === null || asset === null || !Number.isSafeInteger(revision) || state.packBusy || state.packPreview !== null) return;
  const target = asset.revisionHistory.find((candidate) => candidate.revision === revision);
  if (target === undefined) return;
  const consequence = target.current
    ? asset.revisionHistory.some((candidate) => candidate.revision < revision)
      ? "The prior confirmed revision will become current and be restored to staging."
      : "The Asset will return to Remaining Required."
    : "The current staged Analysis will not change.";
  if (!window.confirm(`Delete ${asset.id.toUpperCase()} revision ${revision}?\n\nOnly this revision will be removed. ${consequence} The Archive is not affected.`)) return;

  clearMessage();
  state.packBusy = true;
  qs("#workspace-review-state").textContent = `DELETING ${asset.id.toUpperCase()} REVISION ${revision}`;
  updateWorkspacePreviewButton();
  try {
    const result = await api(
      `/api/v1/pack-workspace/packs/${encodeURIComponent(pack.id)}/assets/${encodeURIComponent(asset.id)}/revisions/${revision}`,
      {
        method: "DELETE",
        body: JSON.stringify({
          confirmation: "delete_revision",
          expectedCurrentRevision: asset.revisions,
        }),
      },
    );
    await loadPackWorkspace();
    qs("#workspace-review-state").textContent = `${asset.id.toUpperCase()} REVISION ${revision} DELETED`;
    showMessage(
      result.restoredRevision === null
        ? `${asset.id.toUpperCase()} revision ${revision} was deleted. The Asset is now Remaining Required.`
        : `${asset.id.toUpperCase()} revision ${revision} was deleted. Current revision: ${result.currentRevision}.`,
      false,
    );
  } catch (error) {
    qs("#workspace-review-state").textContent = "REVISION DELETE NOT APPLIED";
    showMessage(error.message);
    await loadPackWorkspace().catch(() => undefined);
  } finally {
    state.packBusy = false;
    updateWorkspacePreviewButton();
  }
}

function renderPackWorkspace() {
  const pack = selectedWorkspacePack();
  if (pack === null) {
    qs("#workspace-timeframe").textContent = "—";
    qs("#workspace-progress").textContent = "0 / 0";
    qs("#workspace-state").textContent = "NO PACK";
    qs("#workspace-progress-fill").style.width = "0%";
    qs("#workspace-remaining").textContent = "NO PACK SELECTED";
    qs("#workspace-asset").innerHTML = '<option value="">SELECT ASSET</option>';
    qs("#workspace-members-body").innerHTML = "";
    qs("#workspace-member-count").textContent = "0 ASSETS";
    updateWorkspacePreviewButton();
    return;
  }

  const priorAssetId = qs("#workspace-asset").value;
  qs("#workspace-timeframe").textContent = pack.timeframe;
  qs("#workspace-progress").textContent = `${pack.capturedCount} / ${pack.totalCount}`;
  qs("#workspace-state").textContent = pack.state.toUpperCase();
  qs("#workspace-progress-fill").style.width = `${pack.totalCount === 0 ? 0 : Math.round((pack.capturedCount / pack.totalCount) * 100)}%`;
  qs("#workspace-remaining").textContent = pack.remainingRequiredAssetIds.length === 0
    ? "COMPLETE · ALL REQUIRED ASSETS CAPTURED"
    : `${pack.remainingRequiredAssetIds.length} REMAINING · ${pack.remainingRequiredAssetIds.map((id) => id.toUpperCase()).join(" · ")}`;
  qs("#workspace-member-count").textContent = `${pack.totalCount} ASSET${pack.totalCount === 1 ? "" : "S"}`;

  qs("#workspace-asset").innerHTML = '<option value="">SELECT ASSET</option>' + pack.assets
    .map((asset) => `<option value="${escapeAttribute(asset.id)}"${asset.renderReady ? "" : " disabled"}>${escapeHtml(asset.id.toUpperCase())} · ${escapeHtml(asset.displayName)}${asset.renderReady ? "" : " · METADATA REQUIRED"}</option>`)
    .join("");
  const selectable = pack.assets.filter((asset) => asset.renderReady);
  qs("#workspace-asset").value = selectable.some((asset) => asset.id === priorAssetId)
    ? priorAssetId
    : selectable[0]?.id ?? "";

  qs("#workspace-members-body").innerHTML = pack.assets.map((asset) => {
    const status = workspaceAssetStatus(asset);
    const className = status === "CURRENT ANALYSIS" ? "valid" : status === "REQUIRED" ? "pending" : "blocked";
    const pending = pendingCaptureFor(asset.id);
    const expandable = asset.revisionHistory.length > 0 || pending !== null;
    const expanded = state.expandedWorkspaceAssets.has(asset.id);
    const primary = `<tr>
      <td><span class="workspace-asset-name">${escapeHtml(asset.id.toUpperCase())} · ${escapeHtml(asset.displayName)}</span>${expandable ? `<button class="workspace-preview-pill" type="button" data-toggle-workspace-history="${escapeAttribute(asset.id)}" aria-expanded="${expanded}">${expanded ? "HIDE" : "PREVIEW"}${pending === null ? "" : " · PENDING"}</button>` : ""}</td>
      <td>${escapeHtml(asset.tradingViewSymbol || "—")}</td>
      <td><span class="workspace-status ${className}">${escapeHtml(status)}</span></td>
      <td>${asset.revisions > 0 ? `REV ${asset.revisions}` : "—"}${asset.revisionHistory.length > 0 ? ` · ${asset.revisionHistory.length} KEPT` : ""}</td>
      <td>${asset.captured ? `<button class="danger-action compact-action" type="button" data-reset-workspace-asset="${escapeAttribute(asset.id)}">RESET</button>` : ""}</td>
    </tr>`;
    return primary + (expanded ? workspaceRevisionPanel(pack, asset) : "");
  }).join("");
  qsa("[data-toggle-workspace-history]").forEach((button) => {
    button.addEventListener("click", () => toggleWorkspaceAssetHistory(button.dataset.toggleWorkspaceHistory));
  });
  qsa("[data-workspace-quick-look]").forEach((button) => {
    button.addEventListener("click", () => openWorkspaceQuickLook(button.dataset.workspaceQuickLook, button));
  });
  qsa("[data-confirm-pending-revision]").forEach((button) => {
    button.addEventListener("click", () => reviewQueuedCapture(button.dataset.confirmPendingRevision));
  });
  qsa("[data-delete-workspace-revision]").forEach((button) => {
    button.addEventListener("click", () => void deleteWorkspaceRevision(
      button.dataset.revisionAsset,
      Number(button.dataset.deleteWorkspaceRevision),
    ));
  });
  qsa("[data-reset-workspace-asset]").forEach((button) => {
    button.addEventListener("click", () => void resetWorkspaceAsset(button.dataset.resetWorkspaceAsset));
  });

  const asset = selectedWorkspaceAsset();
  if (state.packPreview === null && !state.packBusy) {
    qs("#workspace-review-state").textContent = asset === null
      ? "SELECT AN ASSET"
      : state.packSourceFile === null
        ? `${asset.id.toUpperCase()} · ${pack.timeframe} · SELECT PNG`
        : `${asset.id.toUpperCase()} · ${pack.timeframe} · READY`;
  }
  updateWorkspacePreviewButton();
}

async function loadPackWorkspace() {
  const selectedPackId = qs("#workspace-pack").value;
  const result = await api("/api/v1/pack-workspace");
  state.packWorkspace = result;
  qs("#workspace-pack").innerHTML = result.packs
    .map((pack) => `<option value="${escapeAttribute(pack.id)}">${escapeHtml(pack.displayName.toUpperCase())} · ${pack.capturedCount}/${pack.totalCount}</option>`)
    .join("");
  qs("#workspace-pack").value = result.packs.some((pack) => pack.id === selectedPackId)
    ? selectedPackId
    : result.packs[0]?.id ?? "";
  renderPackWorkspace();
  renderPublicationQueue();
  await loadCaptureSession();
}

function clearPackPreviewView() {
  state.packPreview = null;
  qs("#workspace-preview").hidden = true;
  qs("#workspace-preview-image").removeAttribute("src");
  qs("#workspace-preview-receipt").removeAttribute("href");
  renderPackWorkspace();
}

async function runPackPreview() {
  const pack = selectedWorkspacePack();
  const asset = selectedWorkspaceAsset();
  const file = state.packSourceFile;
  if (pack === null || asset === null || !asset.renderReady || file === null || state.packBusy || state.packPreview !== null) return;

  clearMessage();
  state.packBusy = true;
  qs("#workspace-review-state").textContent = "RENDERING REVIEW ARTIFACT";
  updateWorkspacePreviewButton();
  try {
    const query = new URLSearchParams({ packId: pack.id, assetId: asset.id, filename: file.name });
    const result = await api(`/api/v1/pack-workspace/previews?${query.toString()}`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: file,
    });
    state.packPreview = result;
    qs("#workspace-preview").hidden = false;
    qs("#workspace-preview-heading").textContent = `${result.asset.id.toUpperCase()} REVISION ${result.nextRevision} READY`;
    qs("#workspace-preview-context").textContent = `${result.timeframe} · DATA AS OF ${result.dataAsOf}`;
    qs("#workspace-preview-image").src = result.publicationUrl;
    qs("#workspace-preview-caption").textContent = `${result.asset.displayName} · ${result.asset.tradingViewSymbol} · SHA-256 ${result.outputSha256}`;
    qs("#workspace-preview-receipt").href = result.receiptUrl;
    qs("#workspace-accept").textContent = `ACCEPT REVISION ${result.nextRevision}`;
    qs("#workspace-review-state").textContent = "AWAITING ACCEPTANCE";
  } catch (error) {
    qs("#workspace-review-state").textContent = "ACTION REQUIRED";
    showMessage(error.message);
  } finally {
    state.packBusy = false;
    updateWorkspacePreviewButton();
  }
}

async function acceptPackPreview() {
  const preview = state.packPreview;
  if (preview === null || state.packBusy) return;
  clearMessage();
  state.packBusy = true;
  qs("#workspace-review-state").textContent = "VERIFYING & STAGING";
  updateWorkspacePreviewButton();
  try {
    const result = await api(`/api/v1/pack-workspace/previews/${encodeURIComponent(preview.previewId)}/accept`, { method: "POST", body: "{}" });
    const assetId = result.assetId;
    const revision = result.revisions;
    clearPackPreviewView();
    state.packSourceFile = null;
    qs("#workspace-source").value = "";
    qs("#workspace-file-state").textContent = "SELECT A TRADINGVIEW PNG EXPORT";
    await loadPackWorkspace();
    qs("#workspace-review-state").textContent = `${assetId.toUpperCase()} · REV ${revision} ACCEPTED`;
    showMessage(`${assetId.toUpperCase()} revision ${revision} is staged. ${result.capturedCount} of ${result.totalCount} Pack analyses are complete. Nothing was sent to Discord.`, false);
  } catch (error) {
    qs("#workspace-review-state").textContent = "ACCEPTANCE FAILED";
    showMessage(error.message);
  } finally {
    state.packBusy = false;
    updateWorkspacePreviewButton();
  }
}

async function discardPackPreview() {
  const preview = state.packPreview;
  if (preview === null || state.packBusy) return;
  clearMessage();
  state.packBusy = true;
  qs("#workspace-review-state").textContent = "DISCARDING PREVIEW";
  updateWorkspacePreviewButton();
  try {
    await api(`/api/v1/pack-workspace/previews/${encodeURIComponent(preview.previewId)}`, { method: "DELETE" });
    clearPackPreviewView();
    qs("#workspace-review-state").textContent = "PREVIEW DISCARDED · READY TO RENDER";
    showMessage("The preview was discarded. Pack progress and staging were not changed.", false);
  } catch (error) {
    qs("#workspace-review-state").textContent = "ACTION REQUIRED";
    showMessage(error.message);
  } finally {
    state.packBusy = false;
    updateWorkspacePreviewButton();
  }
}

async function resetWorkspaceAsset(assetId) {
  const pack = selectedWorkspacePack();
  const asset = pack?.assets.find((candidate) => candidate.id === assetId) ?? null;
  if (pack === null || asset === null || !asset.captured || state.packBusy || state.packPreview !== null) return;
  const confirmed = window.confirm(
    `Reset ${asset.id.toUpperCase()} in ${pack.displayName}?\n\n` +
    `This discards its current Analysis and all ${asset.revisions} revision${asset.revisions === 1 ? "" : "s"}, then returns the Asset to Remaining Required. The Archive is not affected.`,
  );
  if (!confirmed) return;

  clearMessage();
  state.packBusy = true;
  qs("#workspace-review-state").textContent = `RESETTING ${asset.id.toUpperCase()}`;
  updateWorkspacePreviewButton();
  try {
    const result = await api(
      `/api/v1/pack-workspace/packs/${encodeURIComponent(pack.id)}/assets/${encodeURIComponent(asset.id)}/reset`,
      {
        method: "POST",
        body: JSON.stringify({ confirmation: "reset_asset", expectedRevisions: asset.revisions }),
      },
    );
    await loadPackWorkspace();
    qs("#workspace-review-state").textContent = `${asset.id.toUpperCase()} RESET`;
    showMessage(
      result.stagingCleared
        ? `${asset.id.toUpperCase()} was reset and returned to Remaining Required. The Archive was untouched.`
        : `${asset.id.toUpperCase()} was reset, but its staged-file cleanup could not be verified. Do not publish until storage is inspected.`,
      !result.stagingCleared,
    );
  } catch (error) {
    qs("#workspace-review-state").textContent = "RESET NOT APPLIED";
    showMessage(error.message);
    await loadPackWorkspace().catch(() => undefined);
  } finally {
    state.packBusy = false;
    updateWorkspacePreviewButton();
  }
}

async function resetWorkspacePack() {
  const pack = selectedWorkspacePack();
  if (pack === null || pack.capturedCount === 0 || state.packBusy || state.packPreview !== null) return;
  const capturedAssetIds = pack.assets.filter((asset) => asset.captured).map((asset) => asset.id);
  const confirmed = window.confirm(
    `Reset the ${pack.displayName} Pack?\n\n` +
    `This discards ${capturedAssetIds.length} current Analys${capturedAssetIds.length === 1 ? "is" : "es"} (${capturedAssetIds.map((id) => id.toUpperCase()).join(", ")}) and returns the Pack to Empty. The Archive is not affected.`,
  );
  if (!confirmed) return;

  clearMessage();
  state.packBusy = true;
  qs("#workspace-review-state").textContent = `RESETTING ${pack.displayName.toUpperCase()}`;
  updateWorkspacePreviewButton();
  try {
    const result = await api(`/api/v1/pack-workspace/packs/${encodeURIComponent(pack.id)}/reset`, {
      method: "POST",
      body: JSON.stringify({ confirmation: "reset_pack", expectedCapturedAssetIds: capturedAssetIds }),
    });
    await loadPackWorkspace();
    qs("#workspace-review-state").textContent = `${pack.displayName.toUpperCase()} RESET`;
    showMessage(
      result.stagingCleared
        ? `${pack.displayName} was reset to Empty. ${result.resetAssetIds.length} current Analyses were discarded; the Archive was untouched.`
        : `${pack.displayName} was reset to Empty, but staged-file cleanup could not be verified. Do not publish until storage is inspected.`,
      !result.stagingCleared,
    );
  } catch (error) {
    qs("#workspace-review-state").textContent = "RESET NOT APPLIED";
    showMessage(error.message);
    await loadPackWorkspace().catch(() => undefined);
  } finally {
    state.packBusy = false;
    updateWorkspacePreviewButton();
  }
}

function serverRouteValues() {
  return Object.fromEntries(state.serverRouteDrafts.map((route) => [route.logicalChannel, route.channelId.trim()]));
}

function serverInspectionFor(logicalChannel, channelId) {
  const inspection = state.serverInspection?.routes?.find((route) => route.logicalChannel === logicalChannel) ?? null;
  return inspection?.channelId === channelId ? inspection : null;
}

function clearServerInspection() {
  state.serverInspection = null;
  clearServerPreview();
  qs("#server-guild").textContent = "NOT TESTED";
  qs("#server-bot-identity").textContent = "BOT IDENTITY NOT TESTED";
}

function routeRemovalBlocker(route) {
  const parts = [];
  if (route.packIds.length > 0) parts.push(`${route.packIds.length} Pack${route.packIds.length === 1 ? "" : "s"}`);
  if (route.registryAssetCount > 0) parts.push(`${route.registryAssetCount} Registry Asset${route.registryAssetCount === 1 ? "" : "s"}`);
  if (route.boundThreadCount > 0) parts.push(`${route.boundThreadCount} thread binding${route.boundThreadCount === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

function renderServerConfiguration() {
  const configuration = state.serverConfiguration;
  if (configuration === null) return;
  qs("#server-credential").textContent = configuration.credential.configured ? "CONFIGURED · VALUE HIDDEN" : "NOT CONFIGURED";
  qs("#server-webhooks").textContent = configuration.webhooks.used ? "IN USE" : "NOT USED";
  qs("#server-readiness").textContent = state.serverInspection === null
    ? configuration.connectionTestAvailable ? "READY FOR LIVE TEST" : "BOT TOKEN REQUIRED"
    : state.serverInspection.operationallyReady ? "SERVER READY" : "SERVER BLOCKED";
  qs("#server-test-current").disabled = state.serverBusy || !configuration.connectionTestAvailable;
  qs("#server-review-configuration").disabled = state.serverBusy;
  qs("#server-review-migration").disabled = state.serverBusy;
  qs("#server-add-route").disabled = state.serverBusy;
  qs("#server-new-route-name").disabled = state.serverBusy;
  qs("#server-new-route-channel").disabled = state.serverBusy;
  qs("#server-route-count").textContent = `${state.serverRouteDrafts.length} ROUTE${state.serverRouteDrafts.length === 1 ? "" : "S"}`;
  qs("#server-guild").textContent = state.serverInspection?.guild?.name?.toUpperCase() ?? "NOT TESTED";
  qs("#server-bot-identity").textContent = state.serverInspection === null
    ? "BOT IDENTITY NOT TESTED"
    : `${state.serverInspection.bot.username} · ${state.serverInspection.bot.userId}`;

  qs("#server-routes-body").innerHTML = state.serverRouteDrafts.map((route) => {
    const inspection = serverInspectionFor(route.logicalChannel, route.channelId.trim());
    const tagNames = inspection?.facts?.availableTags?.map((tag) => tag.name).join(", ") ?? "";
    const testState = inspection === null
      ? "NOT TESTED"
      : inspection.state === "ready"
        ? `${inspection.facts.channelName} · ${inspection.facts.availableTagCount} TAGS${tagNames.length === 0 ? "" : ` · ${tagNames}`}`
        : inspection.issues.join(" ");
    const testClass = inspection === null ? "pending" : inspection.state === "ready" ? "valid" : "blocked";
    const removalBlocker = routeRemovalBlocker(route);
    return `<tr>
      <td><strong>${escapeHtml(route.logicalChannel.toUpperCase())}</strong>${route.isNew ? '<span class="table-secondary">NEW ROUTE</span>' : ""}</td>
      <td><input data-server-route="${escapeAttribute(route.logicalChannel)}" inputmode="numeric" autocomplete="off" maxlength="20" value="${escapeAttribute(route.channelId)}" placeholder="DISCORD CHANNEL ID"></td>
      <td>${route.packIds.length === 0 ? "—" : escapeHtml(route.packIds.map((id) => id.toUpperCase()).join(" · "))}</td>
      <td>${route.registryAssetCount}</td>
      <td>${route.boundThreadCount}</td>
      <td><span class="workspace-status ${testClass}" title="${escapeAttribute(testState)}">${escapeHtml(testState)}</span></td>
      <td><button class="danger-action compact-action" type="button" data-remove-server-route="${escapeAttribute(route.logicalChannel)}"${state.serverBusy || removalBlocker ? " disabled" : ""}${removalBlocker ? ` title="USED BY ${escapeAttribute(removalBlocker)}"` : ""}>REMOVE</button>${removalBlocker ? `<span class="table-secondary">${escapeHtml(removalBlocker)}</span>` : ""}</td>
    </tr>`;
  }).join("");
  qsa("[data-server-route]").forEach((input) => input.addEventListener("input", () => {
    const route = state.serverRouteDrafts.find((entry) => entry.logicalChannel === input.dataset.serverRoute);
    if (route !== undefined) route.channelId = input.value;
    clearServerInspection();
    qs("#server-readiness").textContent = configuration.connectionTestAvailable ? "READY FOR LIVE TEST" : "BOT TOKEN REQUIRED";
    qsa("#server-routes-body .workspace-status").forEach((status) => {
      status.className = "workspace-status pending";
      status.textContent = "NOT TESTED";
      status.title = "NOT TESTED";
    });
  }));
  qsa("[data-remove-server-route]").forEach((button) => button.addEventListener("click", () => {
    const route = state.serverRouteDrafts.find((entry) => entry.logicalChannel === button.dataset.removeServerRoute);
    if (route === undefined) return;
    const blocker = routeRemovalBlocker(route);
    if (blocker) {
      showMessage(`Route ${route.logicalChannel.toUpperCase()} cannot be removed because it is used by ${blocker}. Reassign those dependencies first.`);
      return;
    }
    state.serverRouteDrafts = state.serverRouteDrafts.filter((entry) => entry.logicalChannel !== route.logicalChannel);
    clearServerInspection();
    renderServerConfiguration();
  }));
}

function resetServerRouteDrafts() {
  const configuration = state.serverConfiguration;
  if (configuration === null) return;
  state.serverRouteDrafts = configuration.routes.map((route) => ({
    logicalChannel: route.logicalChannel,
    channelId: route.channelId ?? "",
    packIds: [...route.packIds],
    registryAssetCount: route.registryAssetCount,
    boundThreadCount: route.boundThreadCount,
    isNew: false,
  }));
  qs("#server-new-route-name").value = "";
  qs("#server-new-route-channel").value = "";
  clearServerInspection();
  renderServerConfiguration();
}

function addServerRouteDraft() {
  const logicalChannel = qs("#server-new-route-name").value.trim();
  const channelId = qs("#server-new-route-channel").value.trim();
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(logicalChannel)) {
    showMessage("A logical route must be a lowercase stable name of 1 to 64 letters, numbers, underscores, or hyphens, beginning with a letter.");
    return;
  }
  if (!/^[0-9]{17,20}$/u.test(channelId)) {
    showMessage("Discord Channel ID must be one 17- to 20-digit snowflake.");
    return;
  }
  if (state.serverRouteDrafts.some((route) => route.logicalChannel === logicalChannel)) {
    showMessage(`Logical route ${logicalChannel.toUpperCase()} already exists.`);
    return;
  }
  if (state.serverRouteDrafts.some((route) => route.channelId === channelId)) {
    showMessage("That Discord Channel ID is already assigned to another logical route.");
    return;
  }
  state.serverRouteDrafts.push({
    logicalChannel,
    channelId,
    packIds: [],
    registryAssetCount: 0,
    boundThreadCount: 0,
    isNew: true,
  });
  state.serverRouteDrafts.sort((left, right) => left.logicalChannel.localeCompare(right.logicalChannel, "en"));
  qs("#server-new-route-name").value = "";
  qs("#server-new-route-channel").value = "";
  clearServerInspection();
  renderServerConfiguration();
}

async function loadServerConfiguration() {
  state.serverConfiguration = await api("/api/v1/server-configuration");
  resetServerRouteDrafts();
}

async function testCurrentServer() {
  if (state.serverBusy) return;
  clearMessage();
  state.serverBusy = true;
  renderServerConfiguration();
  qs("#server-readiness").textContent = "TESTING BOT, GUILD & FORUMS";
  try {
    state.serverInspection = await api("/api/v1/server-configuration/test", { method: "POST", body: "{}" });
    qs("#server-readiness").textContent = state.serverInspection.operationallyReady ? "SERVER READY" : "SERVER BLOCKED";
    showMessage(
      state.serverInspection.operationallyReady
        ? `Discord server test passed for ${state.serverInspection.routes.length} routes in ${state.serverInspection.guild.name}.`
        : "Discord server test completed with route or permission blockers. Review the live-test column.",
      !state.serverInspection.operationallyReady,
    );
  } catch (error) {
    state.serverInspection = null;
    showMessage(error.message);
  } finally {
    state.serverBusy = false;
    renderServerConfiguration();
  }
}

function clearServerPreview() {
  state.serverPreview = null;
  qs("#server-preview").hidden = true;
  qs("#server-confirmation").value = "";
  qs("#server-apply").disabled = true;
}

function renderServerPreview() {
  const preview = state.serverPreview;
  if (preview === null) {
    clearServerPreview();
    return;
  }
  qs("#server-preview").hidden = false;
  qs("#server-preview-heading").textContent = preview.mode === "migration" ? "SERVER MIGRATION REVIEW" : "SERVER CONFIGURATION REVIEW";
  qs("#server-preview-state").textContent = preview.valid ? "READY FOR CONFIRMATION" : "BLOCKED";
  qs("#server-preview-state").className = `workspace-status ${preview.valid ? "valid" : "blocked"}`;
  qs("#server-preview-summary").innerHTML = `<p><strong>${preview.changedRouteCount}</strong> ROUTE${preview.changedRouteCount === 1 ? "" : "S"} CHANGE · <strong>${preview.affectedPackIds.length}</strong> AFFECTED PACK${preview.affectedPackIds.length === 1 ? "" : "S"} · <strong>${preview.bindingsToReestablish}</strong> THREAD BINDING${preview.bindingsToReestablish === 1 ? "" : "S"} TO RE-ESTABLISH</p>
    <p>${preview.mode === "migration" ? "Exact before-and-after installation evidence will be preserved before the rollback-protected route and binding transaction." : "No thread bindings may depend on a normal route change."}</p>`;
  const issues = qs("#server-preview-issues");
  issues.hidden = preview.issues.length === 0;
  issues.innerHTML = preview.issues.length === 0 ? "" : `<ul>${preview.issues.map((issue) => `<li>${escapeHtml(issue.message)}</li>`).join("")}</ul>`;
  qs("#server-preview-routes").innerHTML = preview.routes.map((route) => {
    const inspection = route.inspection;
    const facts = inspection?.facts;
    const roles = facts?.roleNames?.length ? facts.roleNames.join(", ") : "NO BOT ROLES REPORTED";
    const tags = facts?.availableTags?.length
      ? facts.availableTags.map((tag) => `${tag.name}${tag.moderated ? " (MODERATED)" : ""}`).join(", ")
      : "NO AVAILABLE TAGS";
    const permission = inspection === null ? "NOT TESTED" : inspection.state === "ready" ? "PERMISSIONS READY" : inspection.issues.join(" ");
    const permissionFacts = facts === undefined || facts === null
      ? "REQUIRED PERMISSIONS NOT TESTED"
      : Object.entries(facts.permissions).map(([name, allowed]) => `${name}: ${allowed ? "YES" : "NO"}`).join(" · ");
    return `<article class="server-preview-route ${route.changed ? "changed" : ""}">
      <header><strong>${escapeHtml(route.logicalChannel.toUpperCase())}</strong><span>${route.changed ? "CHANGED" : "UNCHANGED"}</span></header>
      <p>${escapeHtml(route.currentChannelId ?? "UNCONFIGURED")} → ${escapeHtml(route.nextChannelId ?? "UNCONFIGURED")}</p>
      <p>${facts === undefined || facts === null ? escapeHtml(permission) : `${escapeHtml(facts.guildName)} · ${escapeHtml(facts.channelName)} · ${facts.availableTagCount} TAGS · ${escapeHtml(permission)}`}</p>
      <p>AVAILABLE TAGS · ${escapeHtml(tags)}</p>
      <p>BOT ROLES · ${escapeHtml(roles)}</p>
      <p>REQUIRED PERMISSIONS · ${escapeHtml(permissionFacts)}</p>
    </article>`;
  }).join("");
  qs("#server-confirmation").placeholder = preview.confirmation;
  qs("#server-apply").textContent = preview.mode === "migration" ? "APPLY SERVER MIGRATION" : "APPLY SERVER CONFIGURATION";
  updateServerApplyButton();
}

function updateServerApplyButton() {
  const preview = state.serverPreview;
  qs("#server-apply").disabled = state.serverBusy || preview === null || !preview.valid || qs("#server-confirmation").value !== preview.confirmation;
}

async function reviewServerChange(mode) {
  if (state.serverBusy) return;
  clearMessage();
  state.serverBusy = true;
  state.serverInspection = null;
  clearServerPreview();
  renderServerConfiguration();
  qs("#server-readiness").textContent = mode === "migration" ? "VALIDATING MIGRATION" : "VALIDATING CONFIGURATION";
  try {
    state.serverPreview = await api(mode === "migration" ? "/api/v1/server-migration/preview" : "/api/v1/server-configuration/preview", {
      method: "POST",
      body: JSON.stringify({ routes: serverRouteValues() }),
    });
    renderServerPreview();
    if (!state.serverPreview.valid) showMessage("The server change is blocked. Review every issue before applying.");
  } catch (error) {
    showMessage(error.message);
  } finally {
    state.serverBusy = false;
    renderServerConfiguration();
    updateServerApplyButton();
  }
}

async function applyServerChange() {
  const preview = state.serverPreview;
  if (preview === null || !preview.valid || state.serverBusy || qs("#server-confirmation").value !== preview.confirmation) return;
  clearMessage();
  state.serverBusy = true;
  renderServerConfiguration();
  qs("#server-readiness").textContent = preview.mode === "migration" ? "APPLYING SERVER MIGRATION" : "APPLYING SERVER CONFIGURATION";
  updateServerApplyButton();
  try {
    const result = await api(`/api/v1/server-configuration/previews/${encodeURIComponent(preview.previewId)}/apply`, {
      method: "POST",
      body: JSON.stringify({ confirmation: preview.confirmation }),
    });
    clearServerPreview();
    state.serverInspection = null;
    await Promise.all([
      loadServerConfiguration(),
      loadChannels(),
      ...(state.packMaintenance === null ? [] : [loadPackMaintenance()]),
    ]);
    showMessage(
      result.mode === "migration"
        ? `Server migration applied. ${result.bindingsToReestablish} affected thread binding${result.bindingsToReestablish === 1 ? "" : "s"} must now be re-established. Backup identity: ${result.backupId}.`
        : "Server configuration applied. No Discord content or credentials changed.",
      false,
    );
  } catch (error) {
    showMessage(error.message);
  } finally {
    state.serverBusy = false;
    renderServerConfiguration();
  }
}


function formatTimestamp(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : String(value);
}

function renderOperatorTools() {
  const tools = state.operatorTools;
  if (tools === null) return;
  qs("#operator-status-assets").textContent = String(tools.status.registryAssetCount);
  qs("#operator-status-packs").textContent = String(tools.status.packCount);
  qs("#operator-status-gaps").textContent = String(tools.marketIdentityAudit.gapCount);
  qs("#operator-status-releases").textContent = String(tools.archive.releaseCount);
  qs("#operator-audit-state").textContent = tools.marketIdentityAudit.ok ? "CANONICAL AUDIT CLEAR" : `${tools.marketIdentityAudit.gapCount} RECONCILIATION GAPS`;
  const gaps = tools.marketIdentityAudit.gaps;
  qs("#operator-identity-gaps").innerHTML = gaps.length === 0
    ? '<p class="empty-state">NO MARKET IDENTITY OR CURRENCY GAPS.</p>'
    : `<ul>${gaps.slice(0, 100).map((gap) => `<li><strong>${escapeHtml(gap.assetId.toUpperCase())}</strong> · ${escapeHtml(gap.issue.replaceAll("_", " ").toUpperCase())}${gap.packId ? ` · PACK ${escapeHtml(gap.packId.toUpperCase())}` : ""}</li>`).join("")}</ul>${gaps.length > 100 ? `<p>${gaps.length - 100} MORE GAPS NOT SHOWN.</p>` : ""}`;
  qs("#operator-run-export-audit").disabled = !tools.exportAudit.available;
  if (!tools.exportAudit.available) qs("#operator-export-audit-state").textContent = "DOWNLOADS FOLDER NOT CONFIGURED";
}

async function loadOperatorTools() {
  state.operatorTools = await api("/api/v1/operator-tools");
  renderOperatorTools();
}

async function runExportAudit() {
  if (state.operatorTools?.exportAudit.available !== true) return;
  qs("#operator-run-export-audit").disabled = true;
  qs("#operator-export-audit-state").textContent = "SCANNING EXPORTS";
  try {
    state.exportAudit = await api("/api/v1/operator-tools/export-audit", { method: "POST", body: "{}" });
    const audit = state.exportAudit;
    qs("#operator-export-audit-state").textContent = `${audit.scannedCount} FILES · ${audit.unresolvedCount} UNRESOLVED · ${audit.duplicateGroupCount} DUPLICATE GROUPS`;
    const results = qs("#operator-export-audit-results");
    results.hidden = false;
    results.innerHTML = `<p><strong>${audit.resolvedCount}</strong> RESOLVED · <strong>${audit.unresolvedCount}</strong> UNRESOLVED · <strong>${audit.duplicateGroupCount}</strong> DUPLICATE GROUPS</p>
      ${audit.unknown.length ? `<h3>UNKNOWN SYMBOLS</h3><ul>${audit.unknown.map((entry) => `<li>${escapeHtml(entry.file)} · ${escapeHtml(entry.symbol)}</li>`).join("")}</ul>` : ""}
      ${audit.unparseable.length ? `<h3>UNPARSEABLE FILENAMES</h3><ul>${audit.unparseable.map((entry) => `<li>${escapeHtml(entry.file)}</li>`).join("")}</ul>` : ""}
      ${audit.duplicates.length ? `<h3>DUPLICATE IDENTITIES</h3><ul>${audit.duplicates.map((group) => `<li>${escapeHtml(group.label)} · ${escapeHtml(group.files.join(", "))}</li>`).join("")}</ul>` : ""}`;
    showMessage("Downloads-folder audit completed without changing Registry, Workspace, staging, or Discord.", false);
  } catch (error) {
    showMessage(error.message);
    qs("#operator-export-audit-state").textContent = "AUDIT FAILED";
  } finally {
    qs("#operator-run-export-audit").disabled = state.operatorTools?.exportAudit.available !== true;
  }
}

function currentMaintenancePack() {
  return state.packMaintenance?.packs.find((pack) => pack.id === state.packMaintenanceSelectedId) ?? null;
}

function clearPackMaintenancePreview() {
  state.packMaintenancePreview = null;
  qs("#pack-maintenance-preview").hidden = true;
  qs("#pack-maintenance-confirmation").value = "";
  qs("#pack-maintenance-apply").disabled = true;
}

function setMaintenancePack(packId) {
  const pack = state.packMaintenance?.packs.find((entry) => entry.id === packId) ?? null;
  state.packMaintenanceSelectedId = pack?.id ?? "";
  state.packMaintenanceAssetIds = pack ? [...pack.assetIds] : [];
  state.packMaintenanceOrder = state.packMaintenance ? state.packMaintenance.packs.map((entry) => entry.id) : [];
  state.packMaintenanceHeldAssetId = "";
  if (pack) {
    qs("#pack-maintenance-display").value = pack.displayName;
    qs("#pack-maintenance-channel").value = pack.logicalChannel;
  } else {
    qs("#pack-maintenance-display").value = "";
    qs("#pack-maintenance-channel").value = "";
  }
  clearPackMaintenancePreview();
  renderPackMaintenance();
}

function maintenanceAsset(assetId) {
  const pack = currentMaintenancePack();
  return pack?.assets.find((asset) => asset.id === assetId) ?? state.packMaintenance?.heldAssets.find((asset) => asset.id === assetId) ?? null;
}

function moveMaintenanceMember(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= state.packMaintenanceAssetIds.length) return;
  const [id] = state.packMaintenanceAssetIds.splice(index, 1);
  state.packMaintenanceAssetIds.splice(target, 0, id);
  clearPackMaintenancePreview();
  renderPackMaintenance();
}

function removeMaintenanceMember(index) {
  if (state.packMaintenanceAssetIds.length <= 1) {
    showMessage("A Pack must retain at least one Asset.");
    return;
  }
  state.packMaintenanceAssetIds.splice(index, 1);
  clearPackMaintenancePreview();
  renderPackMaintenance();
}

function moveMaintenancePack(delta) {
  const index = state.packMaintenanceOrder.indexOf(state.packMaintenanceSelectedId);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= state.packMaintenanceOrder.length) return;
  const [id] = state.packMaintenanceOrder.splice(index, 1);
  state.packMaintenanceOrder.splice(target, 0, id);
  clearPackMaintenancePreview();
  renderPackMaintenance();
}

function renderPackMaintenance() {
  const data = state.packMaintenance;
  const select = qs("#pack-maintenance-pack");
  if (data === null) return;
  select.innerHTML = data.packs.map((pack) => `<option value="${escapeAttribute(pack.id)}">${escapeHtml(pack.displayName)} · ${escapeHtml(pack.id.toUpperCase())}</option>`).join("");
  select.value = state.packMaintenanceSelectedId;
  const pack = currentMaintenancePack();
  const disabled = pack === null || state.packMaintenanceBusy;
  for (const id of ["#pack-maintenance-display", "#pack-maintenance-channel", "#pack-maintenance-pack-up", "#pack-maintenance-pack-down", "#pack-maintenance-review", "#pack-maintenance-delete"]) qs(id).disabled = disabled;
  if (pack === null) return;
  qs("#pack-maintenance-state").textContent = `${data.packs.length} CURRENT PACKS`;
  qs("#pack-maintenance-workspace").textContent = `${pack.state.toUpperCase()} · ${pack.capturedCount} CAPTURED`;
  qs("#pack-maintenance-bindings").textContent = String(pack.boundThreadCount);
  qs("#pack-maintenance-releases").textContent = String(pack.releaseCount);
  const orderIndex = state.packMaintenanceOrder.indexOf(pack.id);
  qs("#pack-maintenance-order").textContent = `PACK ORDER ${orderIndex + 1} / ${state.packMaintenanceOrder.length}`;
  qs("#pack-maintenance-pack-up").disabled = disabled || orderIndex <= 0;
  qs("#pack-maintenance-pack-down").disabled = disabled || orderIndex < 0 || orderIndex >= state.packMaintenanceOrder.length - 1;

  const held = data.heldAssets.filter((asset) => !state.packMaintenanceAssetIds.includes(asset.id));
  const heldSelect = qs("#pack-maintenance-held-asset");
  heldSelect.innerHTML = '<option value="">SELECT HELD ASSET</option>' + held.map((asset) => `<option value="${escapeAttribute(asset.id)}">${escapeHtml(asset.displayName)} · ${escapeHtml(asset.tradingViewSymbol)}</option>`).join("");
  heldSelect.value = held.some((asset) => asset.id === state.packMaintenanceHeldAssetId) ? state.packMaintenanceHeldAssetId : "";
  state.packMaintenanceHeldAssetId = heldSelect.value;
  qs("#pack-maintenance-add-asset").disabled = disabled || held.length === 0 || !state.packMaintenanceHeldAssetId;

  const list = qs("#pack-maintenance-members");
  list.innerHTML = state.packMaintenanceAssetIds.map((assetId, index) => {
    const asset = maintenanceAsset(assetId);
    return `<li class="member-row"><div class="member-summary"><span class="member-index">${String(index + 1).padStart(2, "0")}</span><div><strong>${escapeHtml(asset?.displayName ?? assetId.toUpperCase())}</strong><span class="member-secondary">${escapeHtml(asset?.tradingViewSymbol ?? assetId)}</span></div><div class="member-actions"><button type="button" data-maintenance-up="${index}" ${index === 0 ? "disabled" : ""}>↑</button><button type="button" data-maintenance-down="${index}" ${index === state.packMaintenanceAssetIds.length - 1 ? "disabled" : ""}>↓</button><button type="button" data-maintenance-remove="${index}" ${state.packMaintenanceAssetIds.length === 1 ? "disabled" : ""}>×</button></div></div></li>`;
  }).join("");
  qsa("[data-maintenance-up]").forEach((button) => button.addEventListener("click", () => moveMaintenanceMember(Number(button.dataset.maintenanceUp), -1)));
  qsa("[data-maintenance-down]").forEach((button) => button.addEventListener("click", () => moveMaintenanceMember(Number(button.dataset.maintenanceDown), 1)));
  qsa("[data-maintenance-remove]").forEach((button) => button.addEventListener("click", () => removeMaintenanceMember(Number(button.dataset.maintenanceRemove))));
}

async function loadPackMaintenance() {
  state.packMaintenance = await api("/api/v1/packs/maintenance");
  const selected = state.packMaintenance.packs.some((pack) => pack.id === state.packMaintenanceSelectedId)
    ? state.packMaintenanceSelectedId
    : state.packMaintenance.packs[0]?.id ?? "";
  setMaintenancePack(selected);
}

function renderPackMaintenancePreview() {
  const preview = state.packMaintenancePreview;
  if (preview === null) return clearPackMaintenancePreview();
  qs("#pack-maintenance-preview").hidden = false;
  qs("#pack-maintenance-preview-state").textContent = preview.ready ? "READY FOR CONFIRMATION" : "BLOCKED";
  qs("#pack-maintenance-preview-state").className = `workspace-status ${preview.ready ? "valid" : "blocked"}`;
  qs("#pack-maintenance-preview-summary").innerHTML = `<p><strong>${escapeHtml(preview.operation.toUpperCase())}</strong> · ${escapeHtml(preview.packDisplayName)} · ${preview.changes.length} CHANGE${preview.changes.length === 1 ? "" : "S"}</p><ul>${preview.changes.map((change) => `<li>${escapeHtml(change.field.replaceAll("Name", " name").replaceAll("Order", " order").toUpperCase())}: ${escapeHtml(JSON.stringify(change.before))} → ${escapeHtml(JSON.stringify(change.after))}</li>`).join("")}</ul>`;
  const blockers = qs("#pack-maintenance-preview-blockers");
  blockers.hidden = preview.blockers.length === 0;
  blockers.innerHTML = preview.blockers.length ? `<ul>${preview.blockers.map((blocker) => `<li>${escapeHtml(blocker.detail)}</li>`).join("")}</ul>` : "";
  qs("#pack-maintenance-confirmation").placeholder = preview.confirmation;
  qs("#pack-maintenance-apply").textContent = preview.operation === "delete" ? "DELETE PACK" : "APPLY PACK CHANGE";
  updatePackMaintenanceApply();
}

function updatePackMaintenanceApply() {
  const preview = state.packMaintenancePreview;
  qs("#pack-maintenance-apply").disabled = state.packMaintenanceBusy || preview === null || !preview.ready || qs("#pack-maintenance-confirmation").value !== preview.confirmation;
}

async function reviewPackMaintenance(operation) {
  const pack = currentMaintenancePack();
  if (pack === null || state.packMaintenanceBusy) return;
  clearMessage();
  state.packMaintenanceBusy = true;
  clearPackMaintenancePreview();
  renderPackMaintenance();
  try {
    const change = operation === "delete" ? { operation: "delete", packId: pack.id } : {
      operation: "update",
      packId: pack.id,
      displayName: qs("#pack-maintenance-display").value,
      logicalChannel: qs("#pack-maintenance-channel").value,
      assetIds: [...state.packMaintenanceAssetIds],
      packOrder: [...state.packMaintenanceOrder],
    };
    state.packMaintenancePreview = await api("/api/v1/packs/maintenance/preview", { method: "POST", body: JSON.stringify({ change }) });
    renderPackMaintenancePreview();
    if (!state.packMaintenancePreview.ready) showMessage("The Pack change is blocked. Resolve every listed blocker before applying it.");
  } catch (error) {
    showMessage(error.message);
  } finally {
    state.packMaintenanceBusy = false;
    renderPackMaintenance();
    updatePackMaintenanceApply();
  }
}

async function applyPackMaintenance() {
  const preview = state.packMaintenancePreview;
  if (preview === null || !preview.ready || state.packMaintenanceBusy || qs("#pack-maintenance-confirmation").value !== preview.confirmation) return;
  clearMessage();
  state.packMaintenanceBusy = true;
  updatePackMaintenanceApply();
  try {
    await api(`/api/v1/packs/maintenance/${encodeURIComponent(preview.previewId)}/apply`, { method: "POST", body: JSON.stringify({ confirmation: preview.confirmation }) });
    state.packMaintenancePreview = null;
    await Promise.all([loadPackMaintenance(), loadPackWorkspace(), refreshStatus()]);
    showMessage(preview.operation === "delete" ? `Pack ${preview.packId.toUpperCase()} was deleted. Historical Releases were preserved.` : `Pack ${preview.packId.toUpperCase()} was updated.`, false);
  } catch (error) {
    showMessage(error.message);
  } finally {
    state.packMaintenanceBusy = false;
    renderPackMaintenance();
  }
}

function renderReleaseArchive() {
  const archive = state.releaseArchive;
  if (archive === null) return;
  qs("#archive-state").textContent = `${archive.releaseCount} RELEASE${archive.releaseCount === 1 ? "" : "S"}`;
  qs("#archive-total").textContent = String(archive.releaseCount);
  qs("#archive-published").textContent = String(archive.publishedCount);
  qs("#archive-interrupted").textContent = String(archive.interruptedCount);
  const empty = archive.releaseCount === 0;
  qs("#archive-empty-state").hidden = !empty;
  qs("#archive-table-wrap").hidden = empty;
  qs("#archive-detail").hidden = empty || state.releaseDetail === null;
  const filter = qs("#archive-pack-filter");
  filter.disabled = empty;
  const current = filter.value;
  const packIds = [...new Set(archive.releases.map((release) => release.packId))];
  filter.innerHTML = '<option value="">ALL PACKS</option>' + packIds.map((id) => `<option value="${escapeAttribute(id)}">${escapeHtml(id.toUpperCase())}</option>`).join("");
  filter.value = packIds.includes(current) ? current : "";
  if (empty) {
    qs("#archive-body").innerHTML = "";
    return;
  }
  const visible = archive.releases.filter((release) => !filter.value || release.packId === filter.value);
  qs("#archive-body").innerHTML = visible.length === 0 ? '<tr><td colspan="7">NO RELEASES MATCH THIS FILTER.</td></tr>' : visible.map((release) => `<tr><td><strong>${escapeHtml(release.packDisplayName)}</strong><span class="table-secondary">${escapeHtml(release.packId)}${release.packCurrent ? "" : " · HISTORICAL PACK"}</span></td><td>${escapeHtml(release.releaseId)}</td><td><span class="workspace-status ${release.state === "published" ? "valid" : "blocked"}">${escapeHtml(release.state.toUpperCase())}</span></td><td>${escapeHtml(formatTimestamp(release.startedAt))}</td><td>${escapeHtml(formatTimestamp(release.publishedAt))}</td><td>${release.postedCount} / ${release.analysisCount}</td><td><button class="outline-action compact-action" type="button" data-open-release="${escapeAttribute(release.packId)}|${escapeAttribute(release.releaseId)}">OPEN</button></td></tr>`).join("");
  qsa("[data-open-release]").forEach((button) => button.addEventListener("click", () => {
    const [packId, releaseId] = button.dataset.openRelease.split("|");
    void openReleaseDetail(packId, releaseId);
  }));
}

async function loadReleaseArchive() {
  state.releaseArchive = await api("/api/v1/releases");
  renderReleaseArchive();
}

async function openReleaseDetail(packId, releaseId) {
  clearMessage();
  try {
    state.releaseDetail = await api(`/api/v1/releases/${encodeURIComponent(packId)}/${encodeURIComponent(releaseId)}`);
    const detail = state.releaseDetail;
    qs("#archive-detail").hidden = false;
    qs("#archive-detail-heading").textContent = `${detail.packDisplayName} · ${detail.releaseId}`;
    qs("#archive-record-download").href = detail.recordUrl;
    qs("#archive-record-download").setAttribute("download", `${detail.releaseId}-release.json`);
    qs("#archive-detail-facts").innerHTML = `<div><strong>STATE</strong><span>${escapeHtml(detail.state.toUpperCase())}</span></div><div><strong>STARTED</strong><span>${escapeHtml(formatTimestamp(detail.startedAt))}</span></div><div><strong>PUBLISHED</strong><span>${escapeHtml(formatTimestamp(detail.publishedAt))}</span></div><div><strong>DESTINATION</strong><span>${escapeHtml(detail.destinationId)}</span></div>`;
    qs("#archive-analyses").innerHTML = detail.analyses.map((analysis) => `<article><img src="${escapeAttribute(analysis.imageUrl)}" alt="${escapeAttribute(analysis.displayName)} archived chart"><div><strong>${escapeHtml(analysis.displayName)}</strong><span>${escapeHtml(analysis.assetId.toUpperCase())} · ${escapeHtml(formatTimestamp(analysis.capturedAt))}</span><span>${analysis.discordMessageId ? `MESSAGE ${escapeHtml(analysis.discordMessageId)}` : "NOT POSTED"}</span><a class="outline-action compact-action download-link" href="${escapeAttribute(analysis.imageUrl)}" download="${escapeAttribute(analysis.imageFile)}">DOWNLOAD PNG</a></div></article>`).join("");
    qs("#archive-detail").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) { showMessage(error.message); }
}

async function activateView(view, options = {}) {
  const nextView = Object.hasOwn(VIEW_LABELS, view) ? view : "workspace";
  const changed = state.activeView !== nextView;
  const generation = ++state.viewActivationGeneration;
  state.activeView = nextView;
  if (changed) clearMessage();
  updateViewNavigation(nextView);

  const nextHash = `#${nextView}`;
  const historyMode = options.historyMode ?? "push";
  if (historyMode === "push" && window.location.hash !== nextHash) {
    window.history.pushState({ view: nextView }, "", nextHash);
  } else if (historyMode === "replace" || !Object.hasOwn(VIEW_LABELS, window.location.hash.replace(/^#/, ""))) {
    window.history.replaceState({ view: nextView }, "", nextHash);
  }

  setViewBusy(nextView, true);
  let loaded = false;
  try {
    if (nextView === "workspace") await loadPackWorkspace();
    if (nextView === "threads") await loadThreadManagement();
    if (nextView === "server") await Promise.all([loadServerConfiguration(), loadOperatorTools()]);
    if (nextView === "packs") await loadPackMaintenance();
    if (nextView === "archive") await loadReleaseArchive();
    if (nextView === "registry") {
      await loadRegistryPacks();
      await loadRegistry({ query: qs("#registry-search").value, offset: state.registryOffset });
    }
    if (nextView === "renderer") await loadStandaloneRenderOptions();
    loaded = true;
  } finally {
    setViewBusy(nextView, false);
    if (generation === state.viewActivationGeneration) {
      if (loaded) announceView(nextView);
      else qs("#view-status").textContent = `${VIEW_LABELS[nextView]} workspace failed to load.`;
      if (loaded && options.focusPanel === true) {
        const panel = qs(`[data-view-panel="${nextView}"]`);
        panel?.focus({ preventScroll: true });
        panel?.scrollIntoView({ block: "start" });
      }
    }
  }
}

function handlePrimaryNavigationKeydown(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const buttons = qsa("[data-view]");
  const currentIndex = buttons.indexOf(event.currentTarget);
  if (currentIndex < 0) return;
  event.preventDefault();
  const nextIndex = event.key === "Home"
    ? 0
    : event.key === "End"
      ? buttons.length - 1
      : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
  const next = buttons[nextIndex];
  next.focus();
  next.scrollIntoView({ block: "nearest", inline: "nearest" });
  void activateView(next.dataset.view, { historyMode: "push" }).catch((error) => showMessage(error.message));
}

qsa("[data-view]").forEach((button) => {
  button.addEventListener("click", () => {
    void activateView(button.dataset.view, { historyMode: "push" }).catch((error) => showMessage(error.message));
  });
  button.addEventListener("keydown", handlePrimaryNavigationKeydown);
});

window.addEventListener("hashchange", () => {
  void activateView(requestedViewFromHash(), { focusPanel: true }).catch((error) => showMessage(error.message));
});

qs("#message-dismiss").addEventListener("click", clearMessage);

qs("#create-pack").addEventListener("click", () => void createPack());
qs("#pack-asset-search").addEventListener("input", (event) => schedulePackAssetSearch(event.target.value));
qs("#registry-search").addEventListener("input", (event) => scheduleRegistrySearch(event.target.value));
qs("#registry-refresh").addEventListener("click", () => void refreshRegistryState().catch((error) => showMessage(error.message)));
qs("#registry-previous").addEventListener("click", () => void loadRegistry({ offset: Math.max(0, state.registryOffset - state.registryLimit) }).catch((error) => showMessage(error.message)));
qs("#registry-next").addEventListener("click", () => void loadRegistry({ offset: state.registryOffset + state.registryLimit }).catch((error) => showMessage(error.message)));
qs("#registry-import-csv").addEventListener("click", openRegistryImport);
qs("#registry-import-close").addEventListener("click", closeRegistryImport);
qs("#registry-import-cancel").addEventListener("click", closeRegistryImport);
qs("#registry-import-backdrop").addEventListener("click", closeRegistryImport);
qs("#registry-import-dialog").addEventListener("keydown", handleRegistryImportKeydown);
qs("#registry-import-file").addEventListener("change", (event) => setRegistryImportFile(event.target.files?.[0] ?? null));
qs("#registry-review-import").addEventListener("click", () => void reviewRegistryCsvImport());
qs("#registry-apply-import").addEventListener("click", () => void applyRegistryCsvImportFromUi());
qs("#registry-download-template").addEventListener("click", downloadRegistryCsvTemplate);
qs("#registry-add-asset").addEventListener("click", () => void openRegistryEditor("add").catch((error) => showMessage(error.message)));
qs("#registry-edit-asset").addEventListener("click", () => void openRegistryEditor("edit").catch((error) => showMessage(error.message)));
qs("#registry-editor-close").addEventListener("click", closeRegistryEditor);
qs("#registry-editor-cancel").addEventListener("click", closeRegistryEditor);
qs("#registry-editor-backdrop").addEventListener("click", closeRegistryEditor);
qs("#registry-editor").addEventListener("keydown", handleRegistryEditorKeydown);
qs("#registry-review-change").addEventListener("click", () => void reviewRegistryChange());
qs("#registry-apply-change").addEventListener("click", () => void applyRegistryChange());
qs("#registry-logo-input").addEventListener("change", (event) => void storeRegistryLogo(event.target.files?.[0] ?? null));
qs("#registry-remove-logo").addEventListener("click", () => void removeRegistryLogo());
qs("#registry-retire-asset").addEventListener("click", () => void retireRegistryAssetFromUi());
for (const id of ["#registry-field-display", "#registry-field-tradingview", "#registry-field-currency", "#registry-field-channel", "#registry-field-id"]) {
  qs(id).addEventListener("input", () => {
    if (id === "#registry-field-tradingview" && state.registryEditorMode === "add") {
      const currentId = qs("#registry-field-id").value.trim();
      if (!currentId || currentId === qs("#registry-field-id").dataset.suggestedId) {
        const nextId = suggestedAssetId(qs(id).value);
        qs("#registry-field-id").value = nextId;
        qs("#registry-field-id").dataset.suggestedId = nextId;
      }
    }
    resetRegistryChangePreview();
  });
}
qs("#registry-use-in-pack").addEventListener("click", useRegistryAssetInPack);
qs("#registry-open-render").addEventListener("click", () => void openRegistryAssetInRender().catch((error) => showMessage(error.message)));
qs("#registry-open-threads").addEventListener("click", () => void openRegistryAssetThreads().catch((error) => showMessage(error.message)));
qs("#renderer-asset-search").addEventListener("input", (event) => {
  qs("#renderer-asset").value = "";
  qs("#renderer-selected-asset").textContent = "NO ASSET SELECTED";
  qs("#renderer-selected-asset").className = "selected-asset-summary";
  qs("#renderer-open-registry").hidden = true;
  renderRendererAssetSearch(event.target.value);
  resetStandaloneResult();
});
qs("#renderer-open-registry").addEventListener("click", () => void openSelectedRendererAssetInRegistry().catch((error) => showMessage(error.message)));
qs("#renderer-timeframe").addEventListener("change", resetStandaloneResult);
qs("#renderer-source").addEventListener("change", (event) => {
  const file = event.target.files?.[0] ?? null;
  state.renderSourceFile = file;
  qs("#renderer-file-state").textContent = file === null
    ? "SELECT A TRADINGVIEW PNG EXPORT"
    : `${file.name} · ${file.size.toLocaleString()} BYTES`;
  resetStandaloneResult();
});
qs("#render-chart").addEventListener("click", () => void runStandaloneRender());
qs("#publication-review").addEventListener("click", () => void reviewPackPublication());
qs("#publication-confirmation").addEventListener("input", updatePublicationApplyButton);
qs("#publication-apply").addEventListener("click", () => void applyPackPublication());
qs("#workspace-pack").addEventListener("change", () => {
  clearPackPreviewView();
  state.packSourceFile = null;
  qs("#workspace-source").value = "";
  qs("#workspace-file-state").textContent = "SELECT A TRADINGVIEW PNG EXPORT";
  renderPackWorkspace();
  void loadCaptureSession().catch((error) => showMessage(error.message));
});
qs("#workspace-asset").addEventListener("change", renderPackWorkspace);
qs("#workspace-source").addEventListener("change", (event) => {
  const file = event.target.files?.[0] ?? null;
  state.packSourceFile = file;
  qs("#workspace-file-state").textContent = file === null
    ? "SELECT A TRADINGVIEW PNG EXPORT"
    : `PNG SELECTED · ${file.size.toLocaleString()} BYTES`;
  renderPackWorkspace();
});
qs("#workspace-preview-button").addEventListener("click", () => void runPackPreview());
qs("#workspace-start-session").addEventListener("click", () => void startCaptureSession());
qs("#workspace-scan-session").addEventListener("click", () => void scanCaptureSession());
qs("#workspace-streamlined-confirmation").addEventListener("change", (event) => {
  state.streamlinedRevisionConfirmation = event.target.checked;
  if (state.packCaptureSession !== null) renderCaptureSession(state.packCaptureSession);
  showMessage(
    state.streamlinedRevisionConfirmation
      ? "Routine validated revision acceptance is streamlined for this capture session only. Publishing, deletion, reset, Discord, Server, Registry, and Pack changes still require explicit confirmation."
      : "Routine revision confirmations are explicit again for this capture session.",
    false,
  );
});
qs("#workspace-quick-look-close").addEventListener("click", closeWorkspaceQuickLook);
qs("#workspace-quick-look-backdrop").addEventListener("click", closeWorkspaceQuickLook);
qs("#workspace-quick-look-previous").addEventListener("click", () => moveWorkspaceQuickLook(-1));
qs("#workspace-quick-look-next").addEventListener("click", () => moveWorkspaceQuickLook(1));
qs("#workspace-quick-look").addEventListener("keydown", handleWorkspaceQuickLookKeydown);
qs("#workspace-accept").addEventListener("click", () => void acceptPackPreview());
qs("#workspace-discard").addEventListener("click", () => void discardPackPreview());
qs("#workspace-reset-pack").addEventListener("click", () => void resetWorkspacePack());
qs("#thread-pack").addEventListener("change", () => {
  qs("#thread-id").value = "";
  state.threadVerification = null;
  resetThreadProvisioning();
  renderThreadManagement();
});
qs("#thread-asset").addEventListener("change", () => {
  qs("#thread-id").value = selectedThreadAsset()?.threadId ?? "";
  resetThreadProvisioning({ keepForum: true });
  renderThreadManagement();
});
qs("#thread-id").addEventListener("input", updateThreadAdoptButton);
qs("#thread-inspect-binding").addEventListener("click", () => void inspectCurrentThreadBinding());
qs("#thread-adopt-button").addEventListener("click", () => void adoptExistingThread());
qs("#thread-remove-binding").addEventListener("click", () => void removeCurrentThreadBinding());
qs("#thread-inspect-forum").addEventListener("click", () => void inspectThreadForum());
qs("#thread-title").addEventListener("input", updateThreadAdoptButton);
qs("#thread-provision-button").addEventListener("click", () => void provisionNewThread());
qs("#thread-verify-routing").addEventListener("click", () => void verifyPackRouting());
qs("#server-test-current").addEventListener("click", () => void testCurrentServer());
qs("#server-reset-routes").addEventListener("click", resetServerRouteDrafts);
qs("#server-add-route").addEventListener("click", addServerRouteDraft);
qs("#server-review-configuration").addEventListener("click", () => void reviewServerChange("configuration"));
qs("#server-review-migration").addEventListener("click", () => void reviewServerChange("migration"));
qs("#server-confirmation").addEventListener("input", updateServerApplyButton);
qs("#server-apply").addEventListener("click", () => void applyServerChange());
qs("#operator-run-export-audit").addEventListener("click", () => void runExportAudit());
qs("#pack-maintenance-pack").addEventListener("change", (event) => setMaintenancePack(event.target.value));
for (const id of ["#pack-maintenance-display", "#pack-maintenance-channel"]) {
  qs(id).addEventListener("input", clearPackMaintenancePreview);
}
qs("#pack-maintenance-pack-up").addEventListener("click", () => moveMaintenancePack(-1));
qs("#pack-maintenance-pack-down").addEventListener("click", () => moveMaintenancePack(1));
qs("#pack-maintenance-held-asset").addEventListener("change", (event) => {
  state.packMaintenanceHeldAssetId = event.target.value;
  qs("#pack-maintenance-add-asset").disabled = state.packMaintenanceBusy || !state.packMaintenanceHeldAssetId;
});
qs("#pack-maintenance-add-asset").addEventListener("click", () => {
  const assetId = state.packMaintenanceHeldAssetId;
  if (!assetId || state.packMaintenanceAssetIds.includes(assetId)) return;
  state.packMaintenanceAssetIds.push(assetId);
  state.packMaintenanceHeldAssetId = "";
  clearPackMaintenancePreview();
  renderPackMaintenance();
});
qs("#pack-maintenance-review").addEventListener("click", () => void reviewPackMaintenance("update"));
qs("#pack-maintenance-delete").addEventListener("click", () => void reviewPackMaintenance("delete"));
qs("#pack-maintenance-confirmation").addEventListener("input", updatePackMaintenanceApply);
qs("#pack-maintenance-apply").addEventListener("click", () => void applyPackMaintenance());
qs("#archive-pack-filter").addEventListener("change", renderReleaseArchive);
for (const id of ["#pack-id", "#pack-display", "#pack-channel"]) {
  qs(id).addEventListener("input", () => {
    if (id === "#pack-channel") qs("#channel-status").textContent = qs(id).value ? `${qs(id).value.toUpperCase()} CONFIGURED` : "SELECT A CHANNEL";
    persistInput();
    renderMembers();
    schedulePreview();
  });
}

async function start() {
  try {
    await refreshStatus();
    await loadChannels();
    restoreInput();
    await loadChannels();
    renderMembers();
    await Promise.all(state.members.map((_, index) => resolveMember(index)));
    schedulePreview();
    await activateView(requestedViewFromHash(), { historyMode: "replace" });
  } catch (error) {
    setViewBusy(state.activeView, false);
    showMessage(error.message);
  }
}

void start();
