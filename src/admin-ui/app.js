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
    members: state.members.map((member) => ({
      id: member.id,
      display: member.display,
      tradingView: member.tradingView,
      currency: member.currency,
      aliases: member.aliases,
      logoStaged:
        member.logoState === "uploaded",
      logoFileName: member.logoFileName,
    })),
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
      state.members = stored.members.map((member) => ({
        id: typeof member.id === "string" ? member.id : "",
        display: typeof member.display === "string" ? member.display : "",
        tradingView: typeof member.tradingView === "string" ? member.tradingView : "",
        currency: typeof member.currency === "string" ? member.currency : "",
        aliases: typeof member.aliases === "string" ? member.aliases : "",
        lookupState: "pending",
        existing: null,
        error: "",
        lookupGeneration: 0,
        logoState:
          member.logoStaged === true
            ? "uploaded"
            : "required",
        logoFileName:
          typeof member.logoFileName === "string"
            ? member.logoFileName
            : "",
        logoEvidence: null,
        logoError: "",
        logoUploadGeneration: 0,
      }));
    }
  } catch { localStorage.removeItem(STORAGE_KEY); }
}

function parseAliases(value) {
  if (value.trim() === "") return undefined;
  return value.split("\n").filter((entry) => entry.length > 0);
}

function currentInput() {
  return {
    schemaVersion: 1,
    pack: packFormValue(),
    members: state.members.map((member) => member.existing
      ? { id: member.id }
      : {
          id: member.id,
          display: member.display,
          tradingView: member.tradingView,
          currency: member.currency,
          ...(parseAliases(member.aliases) === undefined ? {} : { tradingViewAliases: parseAliases(member.aliases) }),
        }),
  };
}

function derivedToken(token) {
  const parts = token.split(":");
  return parts.length === 2 && parts[0] && parts[1] ? { market: parts[0], symbol: parts[1] } : { market: "—", symbol: "—" };
}

function memberSummary(member) {
  const source = member.existing ?? member;
  const token = source.tradingView || "TRADINGVIEW REQUIRED";
  const currency = source.currency || "CURRENCY REQUIRED";
  const id = (member.id || "NEW ASSET").toUpperCase();
  return `${id} · ${token} · ${currency}`;
}

function resetMemberLogo(member) {
  member.logoState = "required";
  member.logoFileName = "";
  member.logoEvidence = null;
  member.logoError = "";
  member.logoUploadGeneration =
    (member.logoUploadGeneration ?? 0) + 1;
}

function resetMissingAssetLogos() {
  for (const member of state.members) {
    if (!member.existing) resetMemberLogo(member);
  }
}

function memberLogoStatus(member) {
  if (member.logoState === "uploading") {
    return "VALIDATING AND STAGING PNG";
  }
  if (member.logoState === "uploaded") {
    const dimensions = member.logoEvidence
      ? ` · ${member.logoEvidence.width}×${member.logoEvidence.height}`
      : "";
    return `STAGED · ${member.logoFileName || "PNG"}${dimensions}`;
  }
  if (member.logoState === "error") {
    return member.logoError || "LOGO UPLOAD FAILED";
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(
    qs("#pack-id").value,
  )) {
    return "ENTER A VALID PACK ID BEFORE SELECTING A LOGO";
  }
  if (member.lookupState !== "missing") {
    return "CONFIRMING ASSET ID";
  }
  return "SELECT REQUIRED PNG";
}

async function uploadMemberLogo(index, file) {
  const member = state.members[index];
  if (!member || !file) return;

  const packId = qs("#pack-id").value;
  if (
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(packId) ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(member.id)
  ) {
    member.logoState = "error";
    member.logoError =
      "Enter valid Pack and Asset IDs before selecting a logo.";
    renderMembers();
    return;
  }

  if (
    file.type &&
    file.type.toLowerCase() !== "image/png"
  ) {
    member.logoState = "error";
    member.logoError =
      "Asset logos must be PNG files.";
    renderMembers();
    return;
  }

  const generation =
    (member.logoUploadGeneration ?? 0) + 1;
  member.logoUploadGeneration = generation;
  member.logoState = "uploading";
  member.logoFileName = file.name;
  member.logoEvidence = null;
  member.logoError = "";

  persistInput();
  renderMembers();
  setPreviewUnavailable(
    `Staging the required logo for ${member.id.toUpperCase()}.`,
  );

  try {
    const staged = await api(
      `/api/v1/packs/create/${encodeURIComponent(packId)}/asset-logos/${encodeURIComponent(member.id)}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "image/png",
        },
        body: file,
      },
    );

    if (
      !state.members.includes(member) ||
      member.logoUploadGeneration !== generation ||
      member.id !== staged.assetId
    ) {
      return;
    }

    member.logoState = "uploaded";
    member.logoFileName = file.name;
    member.logoEvidence = staged.evidence;
    member.logoError = "";
  } catch (error) {
    if (
      !state.members.includes(member) ||
      member.logoUploadGeneration !== generation
    ) {
      return;
    }

    member.logoState = "error";
    member.logoEvidence = null;
    member.logoError = error.message;
  }

  persistInput();
  renderMembers();
  schedulePreview();
}

function updateMember(index, field, value) {
  const member = state.members[index];
  if (!member) return;
  member[field] = value;
  member.error = "";
  if (field === "id") {
    member.lookupState = "pending";
    member.existing = null;
    resetMemberLogo(member);
    void resolveMember(index);
  }
  persistInput();
  renderMembers();
  schedulePreview();
}

function updateMemberDraft(index, field, value) {
  const member = state.members[index];
  if (!member) return;
  member[field] = value;
  member.error = "";
  persistInput();
  clearTimeout(state.previewTimer);
  setPreviewUnavailable();
  qs(`[data-member-index="${index}"] .field-error`)?.remove();
}

function commitMemberDraft() {
  setTimeout(() => {
    renderMembers();
    schedulePreview();
  }, 0);
}

async function resolveMember(index) {
  const member = state.members[index];
  if (!member) return;
  const generation = ++state.lookupGeneration;
  member.lookupGeneration = generation;
  const id = member.id;
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
    member.lookupState = "missing";
    member.existing = null;
    renderMembers();
    schedulePreview();
    return;
  }
  member.lookupState = "loading";
  renderMembers();
  try {
    const asset = await api(`/api/v1/assets/${encodeURIComponent(id)}`);
    if (member.lookupGeneration !== generation || state.members[index] !== member || member.id !== id) return;
    member.lookupState = "existing";
    member.existing = asset;
    member.error = asset.currency ? "" : "This registered Asset has no canonical currency. Complete its Asset metadata before creating the Pack.";
    member.logoState = "not-required";
    member.logoFileName = "";
    member.logoEvidence = null;
    member.logoError = "";
    member.logoUploadGeneration =
      (member.logoUploadGeneration ?? 0) + 1;
  } catch (error) {
    if (member.lookupGeneration !== generation || state.members[index] !== member || member.id !== id) return;
    if (error.code === "asset_not_found") {
      member.lookupState = "missing";
      member.existing = null;
    } else {
      member.lookupState = "error";
      member.error = error.message;
    }
  }
  renderMembers();
  schedulePreview();
}

function addMember(initial = {}) {
  state.members.push({
    id: initial.id ?? "",
    display: initial.display ?? "",
    tradingView: initial.tradingView ?? "",
    currency: initial.currency ?? "",
    aliases: initial.aliases ?? "",
    lookupState: "pending",
    existing: null,
    error: "",
    lookupGeneration: 0,
    logoState: "required",
    logoFileName: "",
    logoEvidence: null,
    logoError: "",
    logoUploadGeneration: 0,
  });
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
  requestAnimationFrame(() => qs(`[data-member-index="${target}"] .member-id`)?.focus());
}

function removeMember(index) {
  state.members.splice(index, 1);
  persistInput();
  renderMembers();
  schedulePreview();
}

function renderMembers() {
  const list = qs("#member-list");
  const activeElement = document.activeElement;
  const activeRow = activeElement?.closest?.("[data-member-index]");
  const activeMemberIndex = activeRow?.dataset.memberIndex ?? null;
  const activeFieldClass = activeElement instanceof HTMLInputElement
    ? [...activeElement.classList].find((className) => className.startsWith("member-")) ?? null
    : null;
  const activeSelection = activeElement instanceof HTMLInputElement
    ? { start: activeElement.selectionStart, end: activeElement.selectionEnd }
    : null;

  list.textContent = "";
  qs("#empty-members").hidden = state.members.length > 0;
  qs("#member-count").textContent = `${state.members.length} MEMBER${state.members.length === 1 ? "" : "S"}`;

  state.members.forEach((member, index) => {
    const li = document.createElement("li");
    li.className = "member-row";
    li.dataset.memberIndex = String(index);
    const source = member.existing ?? member;
    const derived = derivedToken(source.tradingView ?? "");
    const status = member.lookupState === "existing" ? "REGISTERED" : member.lookupState === "loading" ? "CHECKING" : "MISSING ASSET";
    const statusClass = member.lookupState === "existing" && !member.error ? "valid" : "missing";
    const logoDisabled =
      member.lookupState !== "missing" ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(
        qs("#pack-id").value,
      ) ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(
        member.id,
      );
    const logoStatusClass =
      member.logoState === "uploaded"
        ? "valid"
        : member.logoState === "error"
          ? "error"
          : "";
    li.innerHTML = `
      <div class="member-summary">
        <span class="member-index">${String(index + 1).padStart(2, "0")}</span>
        <div>
          <strong class="member-primary">${escapeHtml(memberSummary(member))}<span class="member-status ${statusClass}">${status}</span></strong>
          <span class="member-secondary">${escapeHtml(source.display || "Complete the missing Asset definition below")}</span>
        </div>
        <div class="member-actions" aria-label="Reorder and remove ${escapeHtml(member.id || `member ${index + 1}`)}">
          <button type="button" data-action="up" aria-label="Move up" ${index === 0 ? "disabled" : ""}>↑</button>
          <button type="button" data-action="down" aria-label="Move down" ${index === state.members.length - 1 ? "disabled" : ""}>↓</button>
          <button type="button" data-action="remove" aria-label="Remove">×</button>
        </div>
      </div>
      <div class="member-editor">
        <label><span>ASSET ID</span><input class="member-id" value="${escapeAttribute(member.id)}" autocomplete="off" maxlength="64"></label>
        ${member.existing ? `
          <div class="derived-channel wide"><span>CANONICAL ASSET</span><strong>${escapeHtml(member.existing.display)} · ${escapeHtml(member.existing.tradingView)} · ${escapeHtml(member.existing.currency ?? "CURRENCY MISSING")}</strong></div>
          <div class="derived-facts"><span>MARKET ${escapeHtml(derived.market)}</span><span>SYMBOL ${escapeHtml(derived.symbol)}</span><span>ASSET CHANNEL ${escapeHtml(member.existing.logicalChannel ?? member.existing.channel ?? "—").toUpperCase()}</span></div>
        ` : `
          <label><span>DISPLAY NAME</span><input class="member-display" value="${escapeAttribute(member.display)}" maxlength="96"></label>
          <label><span>TRADINGVIEW TOKEN</span><input class="member-tradingview" value="${escapeAttribute(member.tradingView)}" maxlength="64" placeholder="TVC:DXY"></label>
          <label><span>CURRENCY</span><input class="member-currency" value="${escapeAttribute(member.currency)}" maxlength="8" placeholder="USD"></label>
          <label><span>ALIASES · OPTIONAL · ONE PER LINE</span><input class="member-aliases" value="${escapeAttribute(member.aliases)}" maxlength="512"></label>
          <label class="member-logo">
            <span>ASSET LOGO · PNG · REQUIRED</span>
            <input
              class="member-logo-input"
              type="file"
              accept="image/png"
              ${logoDisabled ? "disabled" : ""}
            >
            <small class="asset-logo-status ${logoStatusClass}">${escapeHtml(memberLogoStatus(member))}</small>
          </label>
          <div class="derived-facts"><span>MARKET ${escapeHtml(derived.market)}</span><span>SYMBOL ${escapeHtml(derived.symbol)}</span><span>ASSET CHANNEL ${escapeHtml(qs("#pack-channel").value || "—").toUpperCase()}</span></div>
        `}
        ${member.error ? `<p class="field-error" role="alert">${escapeHtml(member.error)}</p>` : ""}
      </div>`;
    li.querySelector(".member-id").addEventListener("input", (event) => updateMember(index, "id", event.target.value));
    const bindDraftField = (selector, field) => {
      const input = li.querySelector(selector);
      input?.addEventListener("input", (event) => updateMemberDraft(index, field, event.target.value));
      input?.addEventListener("blur", commitMemberDraft);
    };
    bindDraftField(".member-display", "display");
    bindDraftField(".member-tradingview", "tradingView");
    bindDraftField(".member-currency", "currency");
    bindDraftField(".member-aliases", "aliases");
    li.querySelector(".member-logo-input")
      ?.addEventListener("change", (event) => {
        const file = event.target.files?.[0];
        if (file) void uploadMemberLogo(index, file);
      });
    li.querySelector('[data-action="up"]').addEventListener("click", () => moveMember(index, -1));
    li.querySelector('[data-action="down"]').addEventListener("click", () => moveMember(index, 1));
    li.querySelector('[data-action="remove"]').addEventListener("click", () => removeMember(index));
    list.append(li);
  });

  if (activeMemberIndex !== null && activeFieldClass !== null) {
    const restored = list.querySelector(
      `[data-member-index="${activeMemberIndex}"] .${activeFieldClass}`,
    );
    if (restored instanceof HTMLInputElement) {
      restored.focus();
      if (activeSelection?.start !== null && activeSelection?.end !== null) {
        restored.setSelectionRange(activeSelection.start, activeSelection.end);
      }
    }
  }
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
  return state.members.every((member) => {
    if (!member.id || member.lookupState === "loading" || member.lookupState === "pending" || member.error) return false;
    if (member.existing) return true;
    return Boolean(
      member.display &&
      member.tradingView &&
      member.currency &&
      member.logoState === "uploaded"
    );
  });
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
    const missing = preview.members.filter((member) => !member.existing);
    const existing = preview.members.filter((member) => member.existing);
    qs("#preview-content").innerHTML = `
      <h3>CREATE ${escapeHtml(preview.pack.display.toUpperCase())}</h3>
      ${missing.length ? `<p>Add ${missing.length} Asset${missing.length === 1 ? "" : "s"}:</p><ul class="preview-assets">${missing.map((asset) => `<li>${escapeHtml(asset.symbol)} · ${escapeHtml(asset.tradingView)} · ${escapeHtml(asset.currency)}</li>`).join("")}</ul>` : ""}
      ${existing.length ? `<p>Reuse ${existing.length} registered Asset${existing.length === 1 ? "" : "s"}.</p>` : ""}
      <p>Create the ${escapeHtml(preview.pack.display)} Pack in this exact order: ${preview.members.map((member) => escapeHtml(member.symbol)).join(", ")}.</p>
      <div class="preview-counts">
        <span>REGISTRY ASSETS <strong>${preview.counts.registryAssetsBefore} → ${preview.counts.registryAssetsAfter}</strong></span>
        <span>PACKS <strong>${preview.counts.packsBefore} → ${preview.counts.packsAfter}</strong></span>
        <span>MEMBERSHIPS <strong>${preview.counts.packMembershipsBefore} → ${preview.counts.packMembershipsAfter}</strong></span>
      </div>
      <p>Nothing will be rendered, published, released, or sent to Discord.</p>`;
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

    const assetId =
      typeof error.details?.assetId === "string"
        ? error.details.assetId
        : null;
    const logoMember = assetId === null
      ? null
      : state.members.find(
          (member) => member.id === assetId,
        );
    if (
      logoMember &&
      (
        error.code === "asset_logo_not_found" ||
        error.code === "invalid_asset_logo"
      )
    ) {
      logoMember.logoState =
        error.code === "invalid_asset_logo"
          ? "error"
          : "required";
      logoMember.logoEvidence = null;
      logoMember.logoError = error.message;
      persistInput();
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
    qs("#result-content").innerHTML = `<p>${result.receipt.members.filter((member) => !member.existing).length} Assets were added and the ${escapeHtml(result.receipt.pack.display)} Pack was created with ${result.receipt.pack.assetIds.length} ordered members.</p><p>Nothing was published or sent to Discord.</p>`;
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
  qs("#thread-logo").value = "";
  qs("#thread-logo-state").textContent = "NO STARTER LOGO STAGED";
  qs("#thread-title").value = "";
  renderThreadTags();
}

function renderThreadTags() {
  const fieldset = qs("#thread-tags");
  const inspection = state.threadForumInspection;
  if (inspection === null) {
    fieldset.innerHTML = '<legend>AVAILABLE FORUM TAGS · SELECT UP TO 5</legend><p id="thread-tags-empty">INSPECT THE FORUM TO LOAD CURRENT TAGS</p>';
    return;
  }
  const tags = inspection.forum.availableTags;
  fieldset.innerHTML = '<legend>AVAILABLE FORUM TAGS · SELECT UP TO 5</legend>' + (tags.length === 0
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
  qs("#thread-pack").disabled = state.threadBusy;
  qs("#thread-asset").disabled = state.threadBusy;
  qs("#thread-id").disabled = state.threadBusy || !available;
  qs("#thread-adopt-button").disabled = !(
    !state.threadBusy &&
    available &&
    pack?.forumConfigured &&
    asset?.bindingState === "unbound" &&
    /^[0-9]{17,20}$/.test(threadId)
  );

  const provisioningAvailable = state.threadManagement?.provisioningAvailable === true;
  const inspectionReady = state.threadForumInspection?.packId === pack?.id && state.threadForumInspection?.sessionClosed === true;
  const logoReady = state.threadLogo?.packId === pack?.id && state.threadLogo?.assetId === asset?.id;
  const title = qs("#thread-title").value;
  const tagIds = selectedThreadTagIds();
  qs("#thread-inspect-forum").disabled = state.threadBusy || !provisioningAvailable || !pack?.forumConfigured;
  qs("#thread-title").disabled = state.threadBusy || !provisioningAvailable || !inspectionReady || asset?.bindingState !== "unbound";
  qs("#thread-logo").disabled = state.threadBusy || !provisioningAvailable || !inspectionReady || asset?.bindingState !== "unbound";
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
  qs("#thread-asset").innerHTML = '<option value="">SELECT UNBOUND ASSET</option>' + unbound
    .map((asset) => `<option value="${escapeAttribute(asset.id)}">${escapeHtml(asset.id.toUpperCase())} · ${escapeHtml(asset.displayName)}</option>`)
    .join("");
  qs("#thread-asset").value = unbound.some((asset) => asset.id === priorAssetId)
    ? priorAssetId
    : unbound[0]?.id ?? "";

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
  </tr>`;
  }).join("");

  if (!dashboard.adoptionAvailable) {
    qs("#thread-adoption-state").textContent = "START ADMIN WITH DISCORD_BOT_TOKEN TO ENABLE INSPECTION";
  } else if (!pack.forumConfigured) {
    qs("#thread-adoption-state").textContent = "PACK FORUM IS NOT CONFIGURED";
  } else if (unbound.length === 0) {
    qs("#thread-adoption-state").textContent = "PACK ROUTING COMPLETE";
  } else if (!state.threadBusy) {
    qs("#thread-adoption-state").textContent = "SELECT AN EXISTING THREAD ID";
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
  if (
    pack === null ||
    asset === null ||
    asset.bindingState !== "unbound" ||
    !/^[0-9]{17,20}$/.test(threadId) ||
    state.threadBusy ||
    state.threadManagement?.adoptionAvailable !== true
  ) return;

  const confirmed = window.confirm(
    `Adopt Discord thread ${threadId} for ${asset.id.toUpperCase()} in ${pack.displayName}?\n\n` +
    "VisionX will inspect the existing post and verify its parent forum. Discord content, tags, history, archive state, and lock state will not be changed. If verification passes, only the local persistent binding is written.",
  );
  if (!confirmed) return;

  clearMessage();
  state.threadBusy = true;
  qs("#thread-adoption-state").textContent = "INSPECTING DISCORD PARENT FORUM";
  updateThreadAdoptButton();
  try {
    const result = await api("/api/v1/thread-management/adopt", {
      method: "POST",
      body: JSON.stringify({
        packId: pack.id,
        assetId: asset.id,
        threadId,
        confirmation: "adopt_existing_thread",
      }),
    });
    qs("#thread-id").value = "";
    resetThreadProvisioning();
    await loadThreadManagement();
    qs("#thread-adoption-state").textContent = `${asset.id.toUpperCase()} · ${result.outcome === "adopted" ? "BOUND" : "ALREADY BOUND"}`;
    showMessage(
      result.sessionClosed
        ? `${asset.id.toUpperCase()} now routes to existing thread ${threadId}. Discord content was not changed.`
        : `${asset.id.toUpperCase()} was bound to thread ${threadId}, but the Discord session did not close cleanly. Restart the administration service before another Discord operation.`,
      !result.sessionClosed,
    );
  } catch (error) {
    qs("#thread-adoption-state").textContent = "ADOPTION NOT APPLIED";
    showMessage(error.message);
    await loadThreadManagement().catch(() => undefined);
  } finally {
    state.threadBusy = false;
    updateThreadAdoptButton();
  }
}

async function inspectThreadForum() {
  const pack = selectedThreadPack();
  if (pack === null || !pack.forumConfigured || state.threadBusy || state.threadManagement?.provisioningAvailable !== true) return;
  const confirmed = window.confirm(
    `Inspect the current Discord forum and available tags for ${pack.displayName}?\n\n` +
    "This is a read-only Discord operation. It will not create or edit a post, change a binding, publish a chart, or create a Release.",
  );
  if (!confirmed) return;

  clearMessage();
  state.threadBusy = true;
  state.threadForumInspection = null;
  state.threadLogo = null;
  qs("#thread-logo").value = "";
  qs("#thread-logo-state").textContent = "NO STARTER LOGO STAGED";
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
    qs("#thread-provisioning-state").textContent = result.sessionClosed
      ? `${result.forum.name.toUpperCase()} · ${result.forum.availableTags.length} TAGS INSPECTED`
      : "FORUM INSPECTED · SESSION CLOSE FAILED";
    showMessage(
      result.sessionClosed
        ? `Current tags were loaded from ${result.forum.name}. Discord content and local bindings were unchanged.`
        : "The forum was inspected, but the Discord session did not close cleanly. Restart the administration service before provisioning.",
      !result.sessionClosed,
    );
  } catch (error) {
    qs("#thread-provisioning-state").textContent = "FORUM INSPECTION FAILED";
    showMessage(error.message);
  } finally {
    state.threadBusy = false;
    updateThreadAdoptButton();
  }
}

async function stageThreadLogo(file) {
  const pack = selectedThreadPack();
  const asset = selectedThreadAsset();
  if (
    file === null ||
    pack === null ||
    asset === null ||
    asset.bindingState !== "unbound" ||
    state.threadForumInspection?.packId !== pack.id ||
    state.threadForumInspection?.sessionClosed !== true ||
    state.threadBusy
  ) return;

  clearMessage();
  state.threadBusy = true;
  state.threadLogo = null;
  qs("#thread-logo-state").textContent = `VALIDATING ${file.name.toUpperCase()}`;
  updateThreadAdoptButton();
  try {
    const result = await api(
      `/api/v1/thread-management/packs/${encodeURIComponent(pack.id)}/assets/${encodeURIComponent(asset.id)}/provisioning-logo`,
      { method: "PUT", headers: { "Content-Type": "image/png" }, body: file },
    );
    state.threadLogo = result;
    qs("#thread-logo-state").textContent = `${result.evidence.width}×${result.evidence.height} · SHA-256 ${result.evidence.sha256.slice(0, 12).toUpperCase()}…`;
    showMessage(`${asset.id.toUpperCase()} starter logo validated and staged locally. Discord was not contacted.`, false);
  } catch (error) {
    qs("#thread-logo").value = "";
    qs("#thread-logo-state").textContent = "STARTER LOGO REJECTED";
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
    "VisionX will create the post with this logo as its starter message, then atomically record its persistent binding. This does not publish a chart or create a Release.",
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

async function loadRegistry(query = "") {
  const result = await api(`/api/v1/assets?query=${encodeURIComponent(query)}&offset=0&limit=100`);
  const body = qs("#registry-body");
  body.innerHTML = result.assets.map((asset) => `<tr><td>${escapeHtml(asset.id)}</td><td>${escapeHtml(asset.displayName)}</td><td>${escapeHtml(asset.tradingViewSymbol)}</td><td>${escapeHtml(asset.currency ?? "—")}</td><td>${escapeHtml(asset.logicalChannel)}</td></tr>`).join("");
}

function updateRenderButton() {
  const ready = Boolean(
    qs("#renderer-asset").value &&
    qs("#renderer-timeframe").value &&
    state.renderSourceFile &&
    !state.renderBusy
  );
  qs("#render-chart").disabled = !ready;
}

async function loadStandaloneRenderOptions() {
  if (state.renderOptions !== null) return;
  const result = await api("/api/v1/standalone-render/options");
  state.renderOptions = result;
  qs("#renderer-asset").innerHTML = '<option value="">SELECT TICKER</option>' + result.assets
    .map((asset) => `<option value="${escapeAttribute(asset.id)}">${escapeHtml(asset.id.toUpperCase())} · ${escapeHtml(asset.displayName)} · ${escapeHtml(asset.tradingViewSymbol)}</option>`)
    .join("");
  qs("#renderer-timeframe").innerHTML = '<option value="">SELECT TIMEFRAME</option>' + result.timeframes
    .map((timeframe) => `<option value="${escapeAttribute(timeframe)}">${escapeHtml(timeframe)}</option>`)
    .join("");
  qs("#renderer-availability").textContent = `${result.assets.length} RENDERABLE · ${result.unavailableAssetCount} REQUIRE METADATA RECONCILIATION`;
  updateRenderButton();
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

qsa("[data-view]").forEach((button) => button.addEventListener("click", () => {
  qsa("[data-view]").forEach((item) => item.removeAttribute("aria-current"));
  button.setAttribute("aria-current", "page");
  qsa("[data-view-panel]").forEach((panel) => { panel.hidden = panel.dataset.viewPanel !== button.dataset.view; });
  if (button.dataset.view === "workspace") void loadPackWorkspace().catch((error) => showMessage(error.message));
  if (button.dataset.view === "threads") void loadThreadManagement().catch((error) => showMessage(error.message));
  if (button.dataset.view === "registry") void loadRegistry();
  if (button.dataset.view === "renderer") void loadStandaloneRenderOptions().catch((error) => showMessage(error.message));
}));

qs("#add-member").addEventListener("click", () => addMember());
qs("#create-pack").addEventListener("click", () => void createPack());
qs("#registry-search").addEventListener("input", (event) => void loadRegistry(event.target.value));
qs("#renderer-asset").addEventListener("change", resetStandaloneResult);
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
  resetThreadProvisioning({ keepForum: true });
  updateThreadAdoptButton();
});
qs("#thread-id").addEventListener("input", updateThreadAdoptButton);
qs("#thread-adopt-button").addEventListener("click", () => void adoptExistingThread());
qs("#thread-inspect-forum").addEventListener("click", () => void inspectThreadForum());
qs("#thread-title").addEventListener("input", updateThreadAdoptButton);
qs("#thread-logo").addEventListener("change", (event) => void stageThreadLogo(event.target.files?.[0] ?? null));
qs("#thread-provision-button").addEventListener("click", () => void provisionNewThread());
qs("#thread-verify-routing").addEventListener("click", () => void verifyPackRouting());
for (const id of ["#pack-id", "#pack-display", "#pack-channel"]) {
  qs(id).addEventListener("input", () => {
    if (id === "#pack-channel") qs("#channel-status").textContent = qs(id).value ? `${qs(id).value.toUpperCase()} CONFIGURED` : "SELECT A CHANNEL";
    if (id === "#pack-id") resetMissingAssetLogos();
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
