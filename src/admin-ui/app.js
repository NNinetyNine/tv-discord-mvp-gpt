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
  expandedWorkspaceAssets: new Set(),
  threadManagement: null,
  threadVerification: null,
  threadBusy: false,
  threadForumInspection: null,
  threadLogo: null,
  registryQuery: "",
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
  packAssetSearchGeneration: 0,
  packAssetSearchTimer: null,
  rendererAssetSearchGeneration: 0,
};

const qs = (selector) => document.querySelector(selector);
const qsa = (selector) => [...document.querySelectorAll(selector)];

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
  box.textContent = text;
  box.className = `message${error ? "" : " success"}`;
  box.hidden = false;
  box.focus?.();
}

function clearMessage() { qs("#message").hidden = true; }

function packFormValue() {
  return {
    id: qs("#pack-id").value,
    display: qs("#pack-display").value,
    channel: qs("#pack-channel").value,
  };
}

function persistInput() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    pack: packFormValue(),
    members: state.members.map((member) => ({ id: member.id })),
  }));
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
  } catch { localStorage.removeItem(STORAGE_KEY); }
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
    fieldset.innerHTML = '<legend>UP TO 20 AVAILABLE TAGS · APPLY UP TO 5</legend><p id="thread-tags-empty">INSPECT THE FORUM TO LOAD CURRENT TAGS</p>';
    return;
  }
  const tags = inspection.forum.availableTags;
  fieldset.innerHTML = '<legend>UP TO 20 AVAILABLE TAGS · APPLY UP TO 5</legend>' + (tags.length === 0
    ? '<p id="thread-tags-empty">THIS FORUM HAS NO AVAILABLE TAGS</p>'
    : `<div class="thread-tag-options">${tags.map((tag) => `<label class="thread-tag-option"><input type="checkbox" value="${escapeAttribute(tag.id)}"><span>${escapeHtml(tag.name)}${tag.moderated ? " · MODERATED" : ""}</span></label>`).join("")}</div>`);
  qsa('#thread-tags input[type="checkbox"]').forEach((input) => input.addEventListener("change", () => {
    const selected = selectedThreadTagIds();
    if (selected.length > 5) {
      input.checked = false;
      showMessage("Discord permits at most five applied forum tags.");
    }
    updateThreadAdoptButton();
  }));
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

  const aliases = asset.tradingViewAliases?.length ? asset.tradingViewAliases.join(", ") : "NONE";
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
    <dt>ALIASES</dt><dd>${escapeHtml(aliases)}</dd>
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
  qs("#registry-context").textContent = `${state.registryTotal} MATCH${state.registryTotal === 1 ? "" : "ES"}`;
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
    const result = await api(`/api/v1/assets?q=${encodeURIComponent(query)}&offset=${offset}&limit=${state.registryLimit}`);
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
  resetRegistryChangePreview();
  const returnFocus = state.registryEditorReturnFocus;
  state.registryEditorReturnFocus = null;
  if (restoreFocus && returnFocus?.isConnected) returnFocus.focus();
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
    qs("#registry-review-change").disabled = false;
  }
}

async function applyRegistryChange() {
  const preview = state.registryChangePreview;
  if (!preview || state.registryChangeBusy) return;
  if (!window.confirm(`Apply this ${preview.operation} change for ${preview.asset.displayName}?\n\nThis writes canonical Registry source only.`)) return;
  state.registryChangeBusy = true;
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
  qs("#workspace-preview-caption").textContent = `${asset.displayName} · ${candidate.filename} · SOURCE SHA-256 ${candidate.sourceSha256}`;
  qs("#workspace-preview-receipt").href = state.packPreview.receiptUrl;
  qs("#workspace-accept").textContent = `ACCEPT REVISION ${asset.revisions + 1}`;
  qs("#workspace-review-state").textContent = "AWAITING ACCEPTANCE";
  updateWorkspacePreviewButton();
}

function renderCaptureSession(session) {
  state.packCaptureSession = session;
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
    <p>${pending.length} NEWEST CHART${pending.length === 1 ? "" : "S"} QUEUED FOR REVIEW</p>
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
    showMessage(
      queued === 0
        ? "Scan complete. No newer chart exports were found, so no revisions were created."
        : `Scan complete. ${queued} newest chart${queued === 1 ? "" : "s"} queued; unchanged assets were left untouched.`,
      false,
    );
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

function workspaceRevisionPanel(pack, asset) {
  const pending = pendingCaptureFor(asset.id);
  const history = [...asset.revisionHistory].sort((left, right) => right.revision - left.revision);
  const cards = [];
  if (pending !== null) {
    cards.push(`<article class="workspace-revision-card pending">
      <header><strong>NEXT REVISION · AWAITING CONFIRMATION</strong><span>${escapeHtml(pending.exportedAt)}</span></header>
      <img loading="lazy" src="/api/v1/pack-workspace/previews/${escapeAttribute(pending.previewId)}/publication.png" alt="${escapeAttribute(asset.displayName)} pending Pack render">
      <p>${escapeHtml(pending.filename)} · SOURCE ${escapeHtml(pending.sourceSha256)}</p>
      <div class="workspace-revision-actions">
        <a class="outline-action download-link compact-action" href="/api/v1/pack-workspace/previews/${escapeAttribute(pending.previewId)}/receipt.json" target="_blank" rel="noreferrer">RECEIPT</a>
        <button class="primary-action compact-action" type="button" data-confirm-pending-revision="${escapeAttribute(asset.id)}">REVIEW &amp; CONFIRM</button>
      </div>
    </article>`);
  }
  for (const revision of history) {
    cards.push(`<article class="workspace-revision-card${revision.current ? " current" : ""}">
      <header><strong>REVISION ${revision.revision} · CONFIRMED${revision.current ? " · CURRENT" : ""}</strong><span>${escapeHtml(revision.acceptedAt)}</span></header>
      <img loading="lazy" src="${escapeAttribute(revision.publicationUrl)}" alt="${escapeAttribute(asset.displayName)} revision ${revision.revision} render">
      <p>${escapeHtml(revision.sourceBasename)} · ${escapeHtml(revision.timeframe)} · DATA AS OF ${escapeHtml(revision.dataAsOf)}</p>
      <div class="workspace-revision-actions">
        <a class="outline-action download-link compact-action" href="${escapeAttribute(revision.receiptUrl)}" target="_blank" rel="noreferrer">RECEIPT</a>
        <button class="danger-action compact-action" type="button" data-delete-workspace-revision="${revision.revision}" data-revision-asset="${escapeAttribute(asset.id)}">DELETE REVISION ${revision.revision}</button>
      </div>
    </article>`);
  }
  return `<tr class="workspace-revision-row"><td colspan="6">
    <section class="workspace-revision-panel" aria-label="${escapeAttribute(asset.displayName)} revision history">
      <p class="workspace-revision-summary">${cards.length} REVISION ITEM${cards.length === 1 ? "" : "S"} · ACCEPTANCE IS THE CONFIRMATION GATE</p>
      <div class="workspace-revision-grid">${cards.join("") || "<p class=\"empty-state\">NO REVISION EVIDENCE</p>"}</div>
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
      <td>${escapeHtml(asset.capturedAt ?? "—")}</td>
      <td>${asset.captured ? `<button class="danger-action compact-action" type="button" data-reset-workspace-asset="${escapeAttribute(asset.id)}">RESET</button>` : ""}</td>
    </tr>`;
    return primary + (expanded ? workspaceRevisionPanel(pack, asset) : "");
  }).join("");
  qsa("[data-toggle-workspace-history]").forEach((button) => {
    button.addEventListener("click", () => toggleWorkspaceAssetHistory(button.dataset.toggleWorkspaceHistory));
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

async function activateView(view) {
  qsa("[data-view]").forEach((item) => {
    if (item.dataset.view === view) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  qsa("[data-view-panel]").forEach((panel) => { panel.hidden = panel.dataset.viewPanel !== view; });
  if (view === "workspace") await loadPackWorkspace();
  if (view === "threads") await loadThreadManagement();
  if (view === "registry") await loadRegistry({ query: qs("#registry-search").value, offset: state.registryOffset });
  if (view === "renderer") await loadStandaloneRenderOptions();
}

qsa("[data-view]").forEach((button) => button.addEventListener("click", () => {
  void activateView(button.dataset.view).catch((error) => showMessage(error.message));
}));

qs("#create-pack").addEventListener("click", () => void createPack());
qs("#pack-asset-search").addEventListener("input", (event) => schedulePackAssetSearch(event.target.value));
qs("#registry-search").addEventListener("input", (event) => scheduleRegistrySearch(event.target.value));
qs("#registry-refresh").addEventListener("click", () => void refreshRegistryState().catch((error) => showMessage(error.message)));
qs("#registry-previous").addEventListener("click", () => void loadRegistry({ offset: Math.max(0, state.registryOffset - state.registryLimit) }).catch((error) => showMessage(error.message)));
qs("#registry-next").addEventListener("click", () => void loadRegistry({ offset: state.registryOffset + state.registryLimit }).catch((error) => showMessage(error.message)));
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
    : `${file.name} · ${file.size.toLocaleString()} BYTES`;
  renderPackWorkspace();
});
qs("#workspace-preview-button").addEventListener("click", () => void runPackPreview());
qs("#workspace-start-session").addEventListener("click", () => void startCaptureSession());
qs("#workspace-scan-session").addEventListener("click", () => void scanCaptureSession());
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
    await loadPackWorkspace();
    await loadChannels();
    restoreInput();
    await loadChannels();
    renderMembers();
    await Promise.all(state.members.map((_, index) => resolveMember(index)));
    schedulePreview();
  } catch (error) { showMessage(error.message); }
}

void start();
