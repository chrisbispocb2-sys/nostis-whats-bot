import { state } from "./state.js";
import { api, accountUrl } from "./api.js";
import { escapeHtml } from "./utils.js";
import { icon, notify, confirmDialog, bindModal, openModal, closeModal, emptyState } from "./ui.js";

const stickerGalleryModal = document.getElementById("sticker-gallery-modal");
const stickerGalleryGrid = document.getElementById("sticker-gallery-grid");
const pickFromGalleryBtn = document.getElementById("campaign-pick-from-gallery-btn");

const campaignMediaFileInput = document.getElementById("campaign-media-file");
const campaignMediaPreview = document.getElementById("campaign-media-preview");
const campaignMediaImg = document.getElementById("campaign-media-img");

export async function openStickerGallery() {
  stickerGalleryGrid.innerHTML = Array.from({ length: 8 }, () => `<div class="skeleton-card" style="height:auto;aspect-ratio:1;border-radius:14px"></div>`).join("");
  openModal(stickerGalleryModal);

  try {
    const { stickers } = await api("/stickers");

    if (stickers.length === 0) {
      stickerGalleryGrid.innerHTML = emptyState({
        iconName: "sticker",
        title: "Nenhuma figurinha coletada ainda",
        text: "Elas aparecem aqui conforme circulam nos grupos do bot.",
      });
      return;
    }

    stickerGalleryGrid.innerHTML = stickers
      .map(
        (s) => `
        <div class="sticker-thumb-wrap">
          <button type="button" class="sticker-thumb" data-id="${s.id}" title="Visto em: ${escapeHtml(s.sourceGroupName)}">
            <img src="${accountUrl(`/stickers/${encodeURIComponent(s.id)}/media`)}" alt="Figurinha vista em ${escapeHtml(s.sourceGroupName)}" loading="lazy">
          </button>
          <button type="button" class="sticker-thumb-delete" data-id="${s.id}" title="Remover da galeria" aria-label="Remover da galeria">${icon("x")}</button>
        </div>`
      )
      .join("");

    stickerGalleryGrid.querySelectorAll(".sticker-thumb").forEach((btn) => {
      btn.addEventListener("click", () => selectGallerySticker(btn.dataset.id));
    });
    stickerGalleryGrid.querySelectorAll(".sticker-thumb-delete").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteGallerySticker(btn.dataset.id);
      });
    });
  } catch (err) {
    console.error("openStickerGallery falhou:", err);
    stickerGalleryGrid.innerHTML = emptyState({ iconName: "wifi-off", title: "Falha ao carregar a galeria", text: err.message });
  }
}

export function selectGallerySticker(id) {
  state.campaignPendingGalleryStickerId = id;
  state.campaignHasNewMediaFile = false;
  state.campaignMediaRemoved = false;
  campaignMediaFileInput.value = "";
  campaignMediaImg.src = accountUrl(`/stickers/${encodeURIComponent(id)}/media`);
  campaignMediaPreview.classList.remove("hidden");
  closeModal(stickerGalleryModal);
  notify.success("A figurinha será usada nesta campanha.", { title: "Figurinha escolhida", duration: 2200 });
}

export async function deleteGallerySticker(id) {
  const confirmed = await confirmDialog({
    title: "Remover figurinha da galeria?",
    message: "Ela some da galeria, mas continua nos grupos onde já foi enviada.",
    confirmText: "Remover",
    tone: "danger",
  });
  if (!confirmed) return;

  try {
    await api(`/stickers/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível remover" });
    return;
  }

  if (state.campaignPendingGalleryStickerId === id) {
    state.campaignPendingGalleryStickerId = null;
    campaignMediaPreview.classList.add("hidden");
  }
  notify.success("A figurinha foi removida da galeria.", { duration: 2200 });
  openStickerGallery();
}

export function initStickers() {
  pickFromGalleryBtn.addEventListener("click", openStickerGallery);
  bindModal(stickerGalleryModal, () => closeModal(stickerGalleryModal));
}
