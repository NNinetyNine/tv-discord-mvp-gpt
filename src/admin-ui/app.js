"use strict";

const STORAGE_KEY = "visionx.pack-builder.input.v1";
const state = {
  status: null,
  channels: [],
  members: [],
  preview: null,
  previewTimer: null,
  lookupGeneration: 0,
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

function updateMember(index, field, value) {
  const member = state.members[index];
  if (!member) return;
  member[field] = value;
  member.error = "";
  if (field === "id") {
    member.lookupState = "pending";
    member.existing = null;
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
    return Boolean(member.display && member.tradingView && member.currency);
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

async function loadRegistry(query = "") {
  const result = await api(`/api/v1/assets?query=${encodeURIComponent(query)}&offset=0&limit=100`);
  const body = qs("#registry-body");
  body.innerHTML = result.assets.map((asset) => `<tr><td>${escapeHtml(asset.id)}</td><td>${escapeHtml(asset.displayName)}</td><td>${escapeHtml(asset.tradingViewSymbol)}</td><td>${escapeHtml(asset.currency ?? "—")}</td><td>${escapeHtml(asset.logicalChannel)}</td></tr>`).join("");
}

qsa("[data-view]").forEach((button) => button.addEventListener("click", () => {
  qsa("[data-view]").forEach((item) => item.removeAttribute("aria-current"));
  button.setAttribute("aria-current", "page");
  qsa("[data-view-panel]").forEach((panel) => { panel.hidden = panel.dataset.viewPanel !== button.dataset.view; });
  if (button.dataset.view === "registry") void loadRegistry();
}));

qs("#add-member").addEventListener("click", () => addMember());
qs("#create-pack").addEventListener("click", () => void createPack());
qs("#registry-search").addEventListener("input", (event) => void loadRegistry(event.target.value));
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
  } catch (error) { showMessage(error.message); }
}

void start();
