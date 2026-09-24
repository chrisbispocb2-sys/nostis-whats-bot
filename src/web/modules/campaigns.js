import { state } from "./state.js";
import { api, accountUrl } from "./api.js";
import { escapeHtml, fileToDataUrl, convertImageToStickerWebp, readImageAsMedia } from "./utils.js";
import { renderCampaignGroupPicker } from "./groups.js";
import {
  icon,
  notify,
  confirmDialog,
  bindModal,
  openModal,
  closeModal,
  flagInvalid,
  setBusy,
  setTabCount,
  emptyState,
} from "./ui.js";

const campaignsListEl = document.getElementById("campaigns-list");
const newCampaignBtn = document.getElementById("new-campaign-btn");
const campaignModal = document.getElementById("campaign-modal");
const campaignModalTitle = document.getElementById("campaign-modal-title");
const campaignNameInput = document.getElementById("campaign-name");
const campaignMessageInput = document.getElementById("campaign-message");
const campaignMessageCount = document.getElementById("campaign-message-count");
const campaignIntervalInput = document.getElementById("campaign-interval");
const campaignMediaFileInput = document.getElementById("campaign-media-file");
const campaignMediaPanel = document.getElementById("campaign-media-panel");
const campaignDropzone = document.getElementById("campaign-dropzone");
const campaignMediaPreview = document.getElementById("campaign-media-preview");
const campaignMediaImg = document.getElementById("campaign-media-img");
const campaignMediaRemoveBtn = document.getElementById("campaign-media-remove");
const campaignStickerSource = document.getElementById("campaign-sticker-source");
const campaignGroupSearch = document.getElementById("campaign-group-search");
const campaignGroupsCountEl = document.getElementById("campaign-groups-count");
const campaignSaveBtn = document.getElementById("campaign-save");

export async function fetchLibraryStickerAsMedia(id) {
  const r = await fetch(accountUrl(`/stickers/${encodeURIComponent(id)}/media`));
  if (!r.ok) throw new Error("Não foi possível carregar a figurinha da galeria.");
  const blob = await r.blob();
  const dataUrl = await fileToDataUrl(blob);
  return { type: "sticker", dataBase64: dataUrl.split(",")[1], mimeType: "image/webp" };
}

export function selectedMediaType() {
  return document.querySelector('input[name="media-type"]:checked').value;
}

/** Mostra/esconde as áreas de mídia conforme o tipo escolhido. */
function applyMediaTypeVisibility(type) {
  campaignMediaPanel.classList.toggle("hidden", type === "none");
  campaignStickerSource.classList.toggle("hidden", type !== "sticker");
  campaignDropzone.querySelector("span").innerHTML =
    type === "sticker"
      ? "<strong>Clique para escolher</strong> ou arraste uma imagem — vira figurinha"
      : "<strong>Clique para escolher</strong> ou arraste uma imagem até aqui";
  if (type === "none") campaignMediaPreview.classList.add("hidden");
}

export function setMediaType(type) {
  document.querySelectorAll('input[name="media-type"]').forEach((r) => {
    r.checked = r.value === type;
  });
  applyMediaTypeVisibility(type);
}

export function mediaMeta(campaign) {
  if (campaign.mediaType === "sticker") return { iconName: "sticker", label: "Figurinha" };
  if (campaign.mediaType === "image") return { iconName: "image", label: "Imagem com legenda" };
  return { iconName: "message", label: "Somente texto" };
}

function updateMessageCount() {
  const n = campaignMessageInput.value.length;
  campaignMessageCount.textContent = `${n} caractere${n === 1 ? "" : "s"}`;
}

export function renderCampaigns() {
  setTabCount("campaigns-count", state.allCampaigns.length);

  if (state.allCampaigns.length === 0) {
    campaignsListEl.innerHTML = emptyState({
      iconName: "megaphone",
      title: "Nenhuma campanha cadastrada",
      text: "Crie uma campanha para enviar uma propaganda a vários grupos de uma vez, com intervalo entre os envios.",
      cta: { id: "new-campaign", label: "Criar primeira campanha" },
    });
    campaignsListEl.querySelector("[data-empty-cta]")?.addEventListener("click", () => openCampaignModal(null));
    return;
  }

  campaignsListEl.innerHTML = state.allCampaigns
    .map((c, i) => {
      const media = mediaMeta(c);
      const thumb =
        c.mediaType !== "none"
          ? `<img class="camp-thumb" src="${accountUrl(`/campaigns/${encodeURIComponent(c.id)}/media`)}?t=${c.updatedAt}" alt="" loading="lazy">`
          : `<span class="camp-thumb">${icon("megaphone")}</span>`;
      const sending = state.campaignPollTimers.has(c.id);

      return `
      <li class="card campaign-item" data-id="${c.id}" style="--i:${Math.min(i, 8)}">
        <div class="camp-top">
          ${thumb}
          <div class="camp-info">
            <h3 title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</h3>
            <div class="meta" style="margin-top:6px">
              <span class="meta-item">${icon("users")} ${c.groupJids.length} grupo(s)</span>
              <span class="meta-item">${icon(media.iconName)} ${media.label}</span>
              <span class="meta-item">${icon("clock")} ${c.intervalSeconds}s</span>
            </div>
          </div>
        </div>

        ${c.message ? `<div class="card-preview">${escapeHtml(c.message)}</div>` : ""}

        <div class="send-progress" data-progress-for="${c.id}"></div>

        <div class="card-foot">
          <button type="button" class="btn btn-primary btn-sm send-campaign" data-id="${c.id}" ${sending ? "disabled" : ""}>
            ${icon("send")} Enviar agora
          </button>
          <div class="card-actions end">
            <button type="button" class="btn btn-ghost btn-sm edit-campaign" data-id="${c.id}">${icon("pencil")} Editar</button>
            <button type="button" class="icon-btn icon-btn-sm danger delete-campaign" data-id="${c.id}" title="Excluir campanha" aria-label="Excluir campanha">${icon("trash")}</button>
          </div>
        </div>
      </li>`;
    })
    .join("");

  campaignsListEl.querySelectorAll(".send-campaign").forEach((btn) => {
    btn.addEventListener("click", () => sendCampaignNow(btn.dataset.id));
  });
  campaignsListEl.querySelectorAll(".edit-campaign").forEach((btn) => {
    btn.addEventListener("click", () => openCampaignModal(btn.dataset.id));
  });
  campaignsListEl.querySelectorAll(".delete-campaign").forEach((btn) => {
    btn.addEventListener("click", () => deleteCampaign(btn.dataset.id));
  });

  for (const c of state.allCampaigns) {
    if (!state.campaignPollTimers.has(c.id)) checkAndResumePolling(c.id);
  }
}

export async function checkAndResumePolling(id) {
  try {
    const s = await api(`/campaigns/${encodeURIComponent(id)}/status`);
    if (s.status === "sending") pollCampaignStatus(id);
  } catch {
    // silencioso
  }
}

export async function refreshCampaigns() {
  try {
    const { campaigns } = await api("/campaigns");
    state.allCampaigns = campaigns;
    renderCampaigns();
  } catch (err) {
    console.error("refreshCampaigns falhou:", err);
    if (state.allCampaigns.length === 0) {
      campaignsListEl.innerHTML = emptyState({ iconName: "wifi-off", title: "Não foi possível carregar as campanhas", text: err.message });
    }
  }
}

export function openCampaignModal(id) {
  state.editingCampaignId = id ?? null;
  const campaign = id ? state.allCampaigns.find((c) => c.id === id) : null;

  state.campaignHasNewMediaFile = false;
  state.campaignMediaRemoved = false;
  state.campaignPendingGalleryStickerId = null;
  campaignMediaFileInput.value = "";
  state.editingCampaignMedia = campaign ? { mediaType: campaign.mediaType, mediaMimeType: campaign.mediaMimeType } : null;

  campaignModalTitle.textContent = campaign ? "Editar campanha" : "Nova campanha";
  campaignSaveBtn.textContent = campaign ? "Salvar alterações" : "Salvar campanha";
  campaignNameInput.value = campaign ? campaign.name : "";
  campaignMessageInput.value = campaign ? campaign.message : "";
  campaignIntervalInput.value = campaign ? campaign.intervalSeconds : 5;
  [campaignNameInput, campaignMessageInput, campaignIntervalInput].forEach((el) => el.classList.remove("is-invalid"));
  state.campaignSelectedGroups = new Set(campaign ? campaign.groupJids : []);
  updateMessageCount();

  const mediaType = campaign ? campaign.mediaType : "none";
  setMediaType(mediaType);

  if (campaign && mediaType !== "none") {
    campaignMediaImg.src = `${accountUrl(`/campaigns/${encodeURIComponent(campaign.id)}/media`)}?t=${campaign.updatedAt}`;
    campaignMediaPreview.classList.remove("hidden");
  } else {
    campaignMediaPreview.classList.add("hidden");
  }

  campaignGroupSearch.value = "";
  renderCampaignGroupPicker();
  campaignGroupsCountEl.textContent = `${state.campaignSelectedGroups.size} selecionado(s)`;

  openModal(campaignModal);
}

export function closeCampaignModal() {
  closeModal(campaignModal);
  state.editingCampaignId = null;
  state.editingCampaignMedia = null;
}

export async function saveCampaign() {
  const name = campaignNameInput.value.trim();
  const message = campaignMessageInput.value.trim();
  const intervalSeconds = Math.max(1, Number(campaignIntervalInput.value) || 5);
  const groupJids = [...state.campaignSelectedGroups];
  const mediaType = selectedMediaType();
  const file = campaignMediaFileInput.files[0];

  const keepsExistingMedia =
    state.editingCampaignMedia && state.editingCampaignMedia.mediaType === mediaType && !state.campaignMediaRemoved;
  const hasMediaSource = state.campaignPendingGalleryStickerId || file || keepsExistingMedia;

  if (!name) return flagInvalid(campaignNameInput, "Informe um nome para a campanha.");
  if (!message && mediaType === "none") {
    return flagInvalid(campaignMessageInput, "Escreva uma mensagem ou escolha uma mídia (figurinha/imagem).");
  }
  if (mediaType !== "none" && !hasMediaSource) {
    return notify.warning("Escolha um arquivo, selecione uma figurinha da galeria ou volte para “Sem mídia”.", { title: "Falta a mídia" });
  }
  if (groupJids.length === 0) {
    return notify.warning("Selecione ao menos um grupo de destino para a campanha.", { title: "Nenhum grupo selecionado" });
  }

  const payload = { name, message, groupJids, intervalSeconds };
  const editing = !!state.editingCampaignId;

  setBusy(campaignSaveBtn, true, "Salvando…");
  try {
    if (mediaType === "none") {
      if (state.editingCampaignMedia && state.editingCampaignMedia.mediaType !== "none") payload.removeMedia = true;
    } else if (state.campaignPendingGalleryStickerId) {
      payload.media = await fetchLibraryStickerAsMedia(state.campaignPendingGalleryStickerId);
    } else if (state.campaignHasNewMediaFile && file) {
      payload.media =
        mediaType === "sticker" ? await convertImageToStickerWebp(file) : await readImageAsMedia(file);
    }

    await api(editing ? `/campaigns/${encodeURIComponent(state.editingCampaignId)}` : "/campaigns", {
      method: editing ? "PUT" : "POST",
      body: payload,
    });

    closeCampaignModal();
    await refreshCampaigns();
    notify.success(editing ? "Alterações salvas." : "A campanha está pronta para ser enviada.", {
      title: editing ? "Campanha atualizada" : "Campanha criada",
    });
  } catch (err) {
    console.error("saveCampaign falhou:", err);
    notify.error(err.message, { title: "Não foi possível salvar a campanha" });
  } finally {
    setBusy(campaignSaveBtn, false);
  }
}

export async function deleteCampaign(id) {
  const campaign = state.allCampaigns.find((c) => c.id === id);
  const confirmed = await confirmDialog({
    title: "Excluir esta campanha?",
    message: `“${campaign ? campaign.name : ""}” será removida com a mídia anexada. Essa ação não pode ser desfeita.`,
    confirmText: "Excluir campanha",
    tone: "danger",
  });
  if (!confirmed) return;

  try {
    await api(`/campaigns/${encodeURIComponent(id)}`, { method: "DELETE" });
    notify.success("A campanha foi removida.", { title: "Campanha excluída" });
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível excluir" });
  }
  refreshCampaigns();
}

function setProgress(id, { mode, percent, text }) {
  const el = document.querySelector(`[data-progress-for="${id}"]`);
  if (!el) return;
  el.className = `send-progress is-visible is-${mode}`;
  el.innerHTML = `
    <div class="bar"><span style="width:${percent}%"></span></div>
    <div class="progress-text">${text}</div>`;
}

export async function sendCampaignNow(id) {
  const campaign = state.allCampaigns.find((c) => c.id === id);
  if (!campaign) return;

  const confirmed = await confirmDialog({
    title: "Enviar campanha agora?",
    message: `“${campaign.name}” será enviada para ${campaign.groupJids.length} grupo(s), com ${campaign.intervalSeconds}s de intervalo entre cada um.`,
    confirmText: "Enviar agora",
  });
  if (!confirmed) return;

  const btn = document.querySelector(`.send-campaign[data-id="${id}"]`);
  if (btn) btn.disabled = true;

  try {
    await api(`/campaigns/${encodeURIComponent(id)}/send`, { method: "POST" });
    setProgress(id, { mode: "sending", percent: 2, text: `${icon("send")} Iniciando envio…` });
    pollCampaignStatus(id);
  } catch (err) {
    if (btn) btn.disabled = false;
    notify.error(err.message, { title: "Não foi possível iniciar o envio" });
  }
}

export function pollCampaignStatus(id) {
  if (state.campaignPollTimers.has(id)) return;

  const stop = (timer) => {
    clearInterval(timer);
    state.campaignPollTimers.delete(id);
    const btn = document.querySelector(`.send-campaign[data-id="${id}"]`);
    if (btn) btn.disabled = false;
  };

  const timer = setInterval(async () => {
    try {
      const s = await api(`/campaigns/${encodeURIComponent(id)}/status`);
      const btn = document.querySelector(`.send-campaign[data-id="${id}"]`);

      if (s.status === "sending") {
        if (btn) btn.disabled = true;
        const percent = s.total > 0 ? Math.max(2, Math.round((s.sent / s.total) * 100)) : 2;
        setProgress(id, { mode: "sending", percent, text: `${icon("send")} Enviando… ${s.sent}/${s.total}` });
      }

      if (s.status === "done") {
        stop(timer);
        const failed = s.results.filter((res) => !res.ok);
        const campaign = state.allCampaigns.find((c) => c.id === id);
        const label = campaign ? `“${campaign.name}”` : "A campanha";

        if (failed.length === 0) {
          setProgress(id, { mode: "ok", percent: 100, text: `${icon("check-circle")} Enviado para todos os ${s.total} grupos.` });
          notify.success(`${label} chegou em todos os ${s.total} grupos.`, { title: "Envio concluído" });
        } else {
          const names = failed.map((f) => escapeHtml(f.groupName)).join(", ");
          setProgress(id, {
            mode: "warn",
            percent: Math.round(((s.total - failed.length) / s.total) * 100),
            text: `${icon("alert")} Enviado para ${s.total - failed.length}/${s.total}. Falhou em: ${names}`,
          });
          notify.warning(`${label}: ${s.total - failed.length} de ${s.total} grupos. Falhou em ${failed.map((f) => f.groupName).join(", ")}.`, {
            title: "Envio concluído com falhas",
            duration: 9000,
          });
        }
      }
    } catch (err) {
      console.error("poll de status falhou:", err);
    }
  }, 1000);

  state.campaignPollTimers.set(id, timer);
}

export function initCampaigns() {
  campaignMessageInput.addEventListener("input", updateMessageCount);

  document.querySelectorAll('input[name="media-type"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      const type = selectedMediaType();
      applyMediaTypeVisibility(type);
      campaignMediaFileInput.value = "";
      state.campaignHasNewMediaFile = false;
      state.campaignPendingGalleryStickerId = null;
      if (type === "none") {
        state.campaignMediaRemoved = true;
      } else if (!state.editingCampaignMedia || state.editingCampaignMedia.mediaType !== type) {
        campaignMediaPreview.classList.add("hidden");
      }
    });
  });

  campaignMediaFileInput.addEventListener("change", async () => {
    const file = campaignMediaFileInput.files[0];
    if (!file) return;
    state.campaignHasNewMediaFile = true;
    state.campaignMediaRemoved = false;
    state.campaignPendingGalleryStickerId = null;
    campaignMediaImg.src = await fileToDataUrl(file);
    campaignMediaPreview.classList.remove("hidden");
  });

  // Arrastar e soltar uma imagem na área de upload
  ["dragenter", "dragover"].forEach((evt) =>
    campaignDropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      campaignDropzone.classList.add("is-over");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    campaignDropzone.addEventListener(evt, () => campaignDropzone.classList.remove("is-over"))
  );
  campaignDropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith("image/"));
    if (!file) return notify.warning("Solte um arquivo de imagem (PNG, JPG, WEBP…).", { title: "Arquivo não suportado" });
    const dt = new DataTransfer();
    dt.items.add(file);
    campaignMediaFileInput.files = dt.files;
    campaignMediaFileInput.dispatchEvent(new Event("change"));
  });

  campaignMediaRemoveBtn.addEventListener("click", () => {
    campaignMediaFileInput.value = "";
    campaignMediaPreview.classList.add("hidden");
    state.campaignHasNewMediaFile = false;
    state.campaignMediaRemoved = true;
    state.campaignPendingGalleryStickerId = null;
    setMediaType("none");
  });

  newCampaignBtn.addEventListener("click", () => openCampaignModal(null));
  campaignSaveBtn.addEventListener("click", saveCampaign);
  bindModal(campaignModal, closeCampaignModal);
}
