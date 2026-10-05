import { api, accountUrl } from "./api.js";
import { state } from "./state.js";
import { escapeHtml, linkifyHtml, formatDateTime, formatPhone, formatBRL, relativeTime, avatarHtml, avatarHue, phoneFromJid, fileToDataUrl } from "./utils.js";
import { icon, notify, setBusy, emptyState, confirmDialog, promptDialog, bindModal, openModal, closeModal, isModalOpen } from "./ui.js";
import { registerContextMenuProvider } from "./context-menu.js";

const PAGE_SIZE = 50;
const NEAR_BOTTOM_PX = 100;
const MAX_ATTACHMENT_MB = 16;
// Sem WebSocket conectado, lê com mais frequência; com ele ligado, a leitura periódica
// só é rede de segurança (reconexão, evento perdido), então pode ser bem mais espaçada.
const POLL_MS_NO_SOCKET = 3000;
const POLL_MS_WITH_SOCKET = 15000;
const WS_RECONNECT_MIN_MS = 1000;
const WS_RECONNECT_MAX_MS = 15000;
const SEARCH_DEBOUNCE_MS = 300;

const chatLayoutEl = document.getElementById("chat-layout");
const chatListPaneEl = document.querySelector(".chat-list-pane");
const chatListResizerEl = document.getElementById("chat-list-resizer");
const chatListTitleEl = document.getElementById("chat-list-title");
const chatListSearchInput = document.getElementById("chat-list-search-input");
const chatNavBackBtn = document.getElementById("chat-nav-back");
const chatMarkAllReadBtn = document.getElementById("chat-mark-all-read-btn");
const chatNewFolderBtn = document.getElementById("chat-new-folder-btn");
const chatFolderViewMenuBtn = document.getElementById("chat-folder-view-menu-btn");
const chatListEl = document.getElementById("chat-list");
const chatArchivedToggle = document.getElementById("chat-archived-toggle");
const chatArchivedCount = document.getElementById("chat-archived-count");
const chatArchivedList = document.getElementById("chat-archived-list");
const chatFolderListEl = document.getElementById("chat-folder-list");
const chatNavRowsEl = document.getElementById("chat-nav-rows");
const chatThreadEmptyEl = document.getElementById("chat-thread-empty");
const chatThreadEl = document.getElementById("chat-thread");
const chatBackBtn = document.getElementById("chat-back");
const chatThreadInfoBtn = document.getElementById("chat-thread-info-btn");
const chatThreadAvatarEl = document.getElementById("chat-thread-avatar");
const chatThreadNameEl = document.getElementById("chat-thread-name");
const chatThreadSubEl = document.getElementById("chat-thread-sub");
const chatSearchBtn = document.getElementById("chat-search-btn");
const chatRideBarEl = document.getElementById("chat-ride-bar");
const chatRideTitleEl = document.getElementById("chat-ride-title");
const chatRideDetailEl = document.getElementById("chat-ride-detail");
const chatRideStopBtn = document.getElementById("chat-ride-stop");
const chatRideSetAmountBtn = document.getElementById("chat-ride-set-amount");
const chatRidesEl = document.getElementById("chat-rides");
const chatSearchBar = document.getElementById("chat-search-bar");
const chatSearchInput = document.getElementById("chat-search-input");
const chatSearchCount = document.getElementById("chat-search-count");
const chatSearchPrev = document.getElementById("chat-search-prev");
const chatSearchNext = document.getElementById("chat-search-next");
const chatSearchClose = document.getElementById("chat-search-close");
const chatMessagesEl = document.getElementById("chat-messages");
const chatMessagesListEl = document.getElementById("chat-messages-list");
const chatLoadMoreBtn = document.getElementById("chat-load-more");
const chatScrollBottomBtn = document.getElementById("chat-scroll-bottom");
const chatScrollBottomCount = document.getElementById("chat-scroll-bottom-count");
let newBelowCount = 0; // mensagens que chegaram enquanto a conversa estava rolada pra cima
const chatReplyBar = document.getElementById("chat-reply-bar");
const chatReplyName = document.getElementById("chat-reply-name");
const chatReplyPreview = document.getElementById("chat-reply-preview");
const chatReplyCancel = document.getElementById("chat-reply-cancel");
const chatComposeForm = document.getElementById("chat-compose");
const chatInput = document.getElementById("chat-input");
const chatSendBtn = document.getElementById("chat-send");
const chatAttachInput = document.getElementById("chat-attach-input");
const chatAttachBtn = document.getElementById("chat-attach-btn");
const chatStickerBtn = document.getElementById("chat-sticker-btn");
const chatStickerModal = document.getElementById("chat-sticker-modal");
const chatStickerGrid = document.getElementById("chat-sticker-grid");
const chatAttachmentChip = document.getElementById("chat-attachment-chip");
const chatAttachmentNameEl = document.getElementById("chat-attachment-name");
const chatAttachmentRemoveBtn = document.getElementById("chat-attachment-remove");
const chatAttachmentThumbImg = document.getElementById("chat-attachment-thumb-img");
const chatAttachmentThumbVideo = document.getElementById("chat-attachment-thumb-video");
const chatItemMenuEl = document.getElementById("chat-item-menu");
const chatReactionPickerEl = document.getElementById("chat-reaction-picker");
const chatLightboxEl = document.getElementById("chat-lightbox");
const chatLightboxImg = document.getElementById("chat-lightbox-img");
const chatLightboxClose = document.getElementById("chat-lightbox-close");
const chatLightboxDownload = document.getElementById("chat-lightbox-download");
const forwardModal = document.getElementById("forward-modal");
const forwardSearchInput = document.getElementById("forward-search");
const forwardListEl = document.getElementById("forward-list");

const contactInfoModal = document.getElementById("contact-info-modal");
const contactInfoAvatarEl = document.getElementById("contact-info-avatar");
const contactInfoNameEl = document.getElementById("contact-info-name");
const contactInfoSubEl = document.getElementById("contact-info-sub");
const contactInfoDescEl = document.getElementById("contact-info-desc");
const contactInfoPhoneRow = document.getElementById("contact-info-phone-row");
const contactInfoPhoneEl = document.getElementById("contact-info-phone");
const contactInfoMessageBtn = document.getElementById("contact-info-message");
const contactInfoCopyBtn = document.getElementById("contact-info-copy");
const contactInfoSearchBtn = document.getElementById("contact-info-search");
const contactInfoAddListBtn = document.getElementById("contact-info-add-list");
const contactInfoParticipantsRow = document.getElementById("contact-info-participants-row");
const contactInfoParticipantsCount = document.getElementById("contact-info-participants-count");
const contactInfoMediaSection = document.getElementById("contact-info-media-section");
const contactInfoMediaCount = document.getElementById("contact-info-media-count");
const contactInfoMediaGrid = document.getElementById("contact-info-media-grid");
const contactInfoGroupsSection = document.getElementById("contact-info-groups-section");
const contactInfoGroupsTitle = document.getElementById("contact-info-groups-title");
const contactInfoGroupsList = document.getElementById("contact-info-groups-list");

const groupParticipantsModal = document.getElementById("group-participants-modal");
const groupParticipantsCountEl = document.getElementById("group-participants-count");
const groupParticipantsListEl = document.getElementById("group-participants-list");
const groupParticipantsSearchInput = document.getElementById("group-participants-search");
const groupParticipantsAdminActionsEl = document.getElementById("group-participants-admin-actions");
const groupInviteLinkBtn = document.getElementById("group-invite-link-btn");
const groupAddParticipantBtn = document.getElementById("group-add-participant-btn");
const groupJoinRequestsBtn = document.getElementById("group-join-requests-btn");
const groupJoinRequestsBadge = document.getElementById("group-join-requests-badge");
const groupJoinRequestsModal = document.getElementById("group-join-requests-modal");
const groupJoinRequestsListEl = document.getElementById("group-join-requests-list");

const chatQuickReplyBar = document.getElementById("chat-quick-reply-bar");
const chatQuickReplySettingsBtn = document.getElementById("chat-quick-reply-settings-btn");
const quickReplyModal = document.getElementById("quick-reply-modal");
const qrEnabledInput = document.getElementById("qr-enabled");
const qrChipsSendInput = document.getElementById("qr-chips-send");
const qrVariantSendInput = document.getElementById("qr-variant-send");
const qrVariantsInput = document.getElementById("qr-variants");
const qrChipsListEl = document.getElementById("qr-chips-list");
const qrAddChipBtn = document.getElementById("qr-add-chip");
const qrSaveBtn = document.getElementById("qr-save");
const settingsNavEl = quickReplyModal.querySelector(".modal-settings-nav");
const rideAssistantEnabledInput = document.getElementById("ride-assistant-enabled");
const rideChargeEnabledInput = document.getElementById("ride-charge-enabled");
const rideChargeTriggerSelect = document.getElementById("ride-charge-trigger");
const rideChargeMessageInput = document.getElementById("ride-charge-message");
let rideChargeMessageDefault = "";
const rideVehicleDetailsInput = document.getElementById("ride-vehicle-details");
const rideMessageInputs = [...document.querySelectorAll("[data-ride-message]")]; // um textarea por aviso (campo de Settings no data-ride-message)
let rideMessageDefaults = {};
let activeRides = []; // corridas da Uber em acompanhamento nesta conta
let ridesListHtml = "";

let chats = []; // /chats, mais recente (ou fixada) primeiro
let archivedChats = [];
let folders = []; // listas que você criou (ex.: "Clientes Premium")
let folderChats = []; // conversas da pasta atualmente aberta
let chatListFilter = ""; // pesquisa da LISTA de conversas (nome/número) — não confundir com a busca dentro de uma conversa
let viewingArchived = false;
let currentFolderId = null; // pasta atualmente aberta (substitui a lista principal), ou null
let activeChatJid = null;
let messages = []; // da conversa aberta, mais antiga primeiro (ordem de leitura)
let hasMoreOlder = true;
let loadingMore = false;
let sending = false;
let chatListHtml = "";
let archivedListHtml = "";
let folderListHtml = "";
let messagesKey = ""; // ids + estado (mídia/status/reações) desenhados: só redesenha quando muda
let pendingAttachment = null; // { file, type, mimeType, fileName }
let pendingAttachmentPreviewUrl = null; // URL.createObjectURL da prévia de imagem/vídeo, revogada ao trocar/limpar
let replyTo = null; // mensagem sendo respondida, ou null

// Tempo real (WebSocket): acelera a chegada de mensagens novas sem depender só da leitura periódica
let ws = null;
let wsSocketAccountId = null; // conta a que o socket atual pertence (pra não reconectar sozinho depois de trocar de conta)
let wsConnected = false;
let wsReconnectDelay = WS_RECONNECT_MIN_MS;
let wsReconnectTimer = null;
let pollTimer = null;

// Menu flutuante (fixar/arquivar / ações de mensagem) — só um aberto por vez
let dropdownRun = null;
let dropdownAnchor = null;

// Seletor rápido de emoji (reagir a uma mensagem)
const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
let reactionPickerAnchor = null;
let reactionPickerMessage = null;

// Busca dentro da conversa
let searchResults = [];
let searchIndex = -1;
let searchDebounceTimer = null;

// Encaminhar
let forwardSource = null;

// Som de mensagem nova
const SOUND_MAX_MESSAGE_AGE_MS = 2 * 60_000;
const SOUND_MIN_GAP_MS = 1200; // várias mensagens de uma vez tocam um bip só, não uma rajada
const SOUNDED_IDS_LIMIT = 500;
const soundSockets = new Map(); // conta que NÃO está aberta na tela → socket só pra ouvir as mensagens dela
let audioCtx = null;
let lastSoundAt = 0;
const soundedMessageIds = new Set(); // mensagens que já tocaram (a mesma nunca toca duas vezes)

// Ações rápidas (chips + variantes sorteadas)
let misticConfigured = false; // controla se "Fixar temporariamente" fica clicável no menu da conversa
let quickReplySettings = { enabled: false, chipsSendOnClick: false, replyVariantAlsoSends: false, variants: [], chips: [] };
let variantBag = []; // embaralho sem repetir; quando esvazia, embaralha de novo
let editingChips = []; // só enquanto o modal de configuração está aberto

const PREVIEW_ICONS = { image: "📷", video: "🎥", audio: "🎤", document: "📄", location: "📍", contact: "👤" };

/** Esquece tudo da conta anterior (chamado ao trocar de conta). */
export function resetChat() {
  chats = [];
  archivedChats = [];
  folders = [];
  folderChats = [];
  chatListHtml = "";
  archivedListHtml = "";
  folderListHtml = "";
  chatListEl.innerHTML = "";
  chatArchivedList.innerHTML = "";
  chatFolderListEl.innerHTML = "";
  activeRides = [];
  renderRidesList();
  closeDropdown();
  showMainView();
  closeThread();
  closeRealtime();
  connectRealtime();
  syncSoundSockets();
  quickReplySettings = { enabled: false, chipsSendOnClick: false, replyVariantAlsoSends: false, variants: [], chips: [] };
  variantBag = [];
  renderQuickReplyBar();
  loadQuickReplySettings();
  misticConfigured = false;
  loadMisticStatus();
}

function mediaUrl(m) {
  return accountUrl(`/chats/${encodeURIComponent(m.chatJid)}/media/${encodeURIComponent(m.id)}`);
}

function pictureUrlFor(jid) {
  return accountUrl(`/groups/picture/${encodeURIComponent(jid)}`);
}

/** Zera o contador de não lidas no servidor (chamado ao abrir a conversa, e enquanto ela já está aberta). */
function markRead(jid) {
  api(`/chats/${encodeURIComponent(jid)}/read`, { method: "POST" }).catch(() => {
    // a próxima vez que abrir essa conversa tenta de novo
  });
}

/** Zera o contador de não lidas de todas as conversas de uma vez (botão "marcar todas como lidas"). */
async function markAllRead() {
  try {
    await api("/chats/read-all", { method: "POST" });
    await refreshChat();
    notify.success("Todas as conversas foram marcadas como lidas.", { duration: 2000 });
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível marcar todas como lidas" });
  }
}

function mediaTypeFromMime(mime) {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

function clearAttachment() {
  pendingAttachment = null;
  chatAttachInput.value = "";
  chatAttachmentChip.classList.add("hidden");
  chatAttachmentChip.classList.remove("is-media");
  chatAttachmentThumbImg.classList.add("hidden");
  chatAttachmentThumbImg.removeAttribute("src");
  chatAttachmentThumbVideo.classList.add("hidden");
  chatAttachmentThumbVideo.removeAttribute("src");
  if (pendingAttachmentPreviewUrl) {
    URL.revokeObjectURL(pendingAttachmentPreviewUrl);
    pendingAttachmentPreviewUrl = null;
  }
}

function setAttachment(file) {
  if (file.size > MAX_ATTACHMENT_MB * 1024 * 1024) {
    notify.warning(`Esse arquivo passa de ${MAX_ATTACHMENT_MB} MB. Escolha um menor.`, { title: "Arquivo muito grande" });
    chatAttachInput.value = "";
    return;
  }
  const type = mediaTypeFromMime(file.type || "");
  // imagem colada (Ctrl+V) não vem com nome de arquivo
  const fileName = file.name || (type === "image" ? "imagem-colada.png" : "arquivo");
  pendingAttachment = { file, type, mimeType: file.type || "application/octet-stream", fileName };
  chatAttachmentNameEl.textContent = fileName;
  chatAttachmentChip.classList.remove("hidden");

  if (pendingAttachmentPreviewUrl) {
    URL.revokeObjectURL(pendingAttachmentPreviewUrl);
    pendingAttachmentPreviewUrl = null;
  }
  chatAttachmentThumbImg.classList.add("hidden");
  chatAttachmentThumbVideo.classList.add("hidden");

  // Imagem/vídeo: mostra uma prévia de verdade (igual ao WhatsApp Web), não só o nome do arquivo
  if (type === "image" || type === "video") {
    chatAttachmentChip.classList.add("is-media");
    pendingAttachmentPreviewUrl = URL.createObjectURL(file);
    const thumb = type === "image" ? chatAttachmentThumbImg : chatAttachmentThumbVideo;
    thumb.src = pendingAttachmentPreviewUrl;
    thumb.classList.remove("hidden");
  } else {
    chatAttachmentChip.classList.remove("is-media");
  }
}

/** Cresce a caixa de digitar conforme o texto, até um limite (depois rola por dentro). */
function autoGrowComposeInput() {
  chatInput.style.height = "auto";
  chatInput.style.height = `${chatInput.scrollHeight}px`;
}

/** Cola uma imagem copiada (print, outro app...) direto como anexo, igual ao WhatsApp Web. */
function handleComposePaste(e) {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) {
        e.preventDefault();
        setAttachment(file);
      }
      return;
    }
  }
}

/**
 * O painel nunca tem um "nome salvo" de verdade pra um contato — só o nome que a própria pessoa
 * escolhe no WhatsApp — então, igual ao WhatsApp mostraria pra um contato não salvo na sua agenda,
 * o número vem sempre na frente do nome. O nome (pushname) só aparece se não houver telefone algum.
 */
function displayName(c) {
  if (c.isGroup) return c.name || "Grupo sem nome";
  return (c.phone ? formatPhone(c.phone) : null) || c.name || phoneFromJid(c.jid) || c.jid;
}

/** Em grupo, a prévia vem com "~Quem: o que escreveu", igual ao WhatsApp — no privado é só o texto. */
function previewText(c) {
  if (!c.lastMessagePreview) return "";
  if (!c.isGroup) return c.lastMessagePreview;
  const who = c.lastMessageFromMe ? "Você" : c.lastMessageSenderName ? `~${c.lastMessageSenderName}` : null;
  return who ? `${who}: ${c.lastMessagePreview}` : c.lastMessagePreview;
}

function normalizeForSearch(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Filtra a lista de conversas pelo nome OU pelo número (dígitos), igual à busca de conversas do WhatsApp. */
function chatMatchesListFilter(c) {
  if (!chatListFilter) return true;
  // Busca pelo nome que a pessoa usa no WhatsApp mesmo sem ser isso que aparece na lista (você
  // pode lembrar do nome dela e não saber o número de cor).
  if (normalizeForSearch(c.name || "").includes(chatListFilter)) return true;
  const queryDigits = chatListFilter.replace(/\D/g, "");
  if (!queryDigits) return false;
  return (c.phone || phoneFromJid(c.jid)).replace(/\D/g, "").includes(queryDigits);
}

/* ---------- Menu flutuante (fixar/arquivar / ações de mensagem) ---------- */

function closeDropdown() {
  chatItemMenuEl.classList.add("hidden");
  if (dropdownAnchor) dropdownAnchor.classList.remove("is-open");
  dropdownAnchor = null;
  dropdownRun = null;
}

/**
 * `anchor` normalmente é o botão clicado — mas aceita também um DOMRect já capturado
 * (veja `openFolderPicker`): se o botão some do DOM durante um `await` antes de abrir o menu
 * (a lista foi redesenhada nesse meio tempo), reler a posição aqui já dá o retângulo zerado
 * do elemento órfão, e o menu "aparece no cantinho" da tela em vez de perto do clique.
 */
function openDropdown(anchor, items) {
  closeDropdown();
  chatItemMenuEl.innerHTML = items
    .map(
      (it) =>
        `<button type="button" data-action="${it.action}" class="${it.danger ? "is-danger" : ""}" ${it.disabled ? `disabled title="${escapeHtml(it.disabledReason || "")}"` : ""}>${icon(it.icon)}<span>${escapeHtml(it.label)}</span></button>`
    )
    .join("");
  chatItemMenuEl.classList.remove("hidden");

  const isElement = typeof anchor.getBoundingClientRect === "function" && anchor.nodeType === 1;
  const rect = isElement ? anchor.getBoundingClientRect() : anchor;
  const menuRect = chatItemMenuEl.getBoundingClientRect();
  const top = Math.min(rect.bottom + 4, window.innerHeight - menuRect.height - 8);
  const left = Math.max(8, Math.min(rect.right - menuRect.width, window.innerWidth - menuRect.width - 8));
  chatItemMenuEl.style.top = `${Math.max(8, top)}px`;
  chatItemMenuEl.style.left = `${left}px`;

  dropdownRun = (action) => {
    const item = items.find((it) => it.action === action);
    if (item && !item.disabled) item.run();
  };
  if (isElement) {
    dropdownAnchor = anchor;
    anchor.classList.add("is-open");
  }
}

chatItemMenuEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (btn) dropdownRun?.(btn.dataset.action);
  closeDropdown();
});
document.addEventListener("click", (e) => {
  if (chatItemMenuEl.classList.contains("hidden")) return;
  if (chatItemMenuEl.contains(e.target)) return;
  // O próprio botão que abriu o menu dispara "click" no document também (bubbling); sem isso, o
  // menu abre e fecha na mesma hora. Checa o anchor rastreado em vez de uma lista de classes fixas
  // — assim um botão novo que abra dropdown não precisa lembrar de entrar nessa lista.
  if (dropdownAnchor && dropdownAnchor.contains(e.target)) return;
  if (e.target.closest(".chat-list-item-menu-btn, .chat-bubble-action-btn")) return;
  closeDropdown();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDropdown();
});

/* ---------- Seletor rápido de emoji (reagir a uma mensagem) ---------- */

function closeReactionPicker() {
  chatReactionPickerEl.classList.add("hidden");
  reactionPickerAnchor = null;
  reactionPickerMessage = null;
}

function openReactionPicker(anchorBtn, message) {
  closeDropdown();
  closeReactionPicker();

  const myReaction = message.reactions?.find((r) => r.fromMe)?.emoji;
  chatReactionPickerEl.innerHTML = QUICK_REACTIONS.map(
    (e) => `<button type="button" class="${e === myReaction ? "is-active" : ""}" data-emoji="${escapeHtml(e)}" title="${e === myReaction ? "Tirar reação" : "Reagir"}">${e}</button>`
  ).join("");
  chatReactionPickerEl.classList.remove("hidden");

  const rect = anchorBtn.getBoundingClientRect();
  const pickerRect = chatReactionPickerEl.getBoundingClientRect();
  const top = Math.max(8, rect.top - pickerRect.height - 6);
  const left = Math.max(8, Math.min(rect.left - pickerRect.width / 2, window.innerWidth - pickerRect.width - 8));
  chatReactionPickerEl.style.top = `${top}px`;
  chatReactionPickerEl.style.left = `${left}px`;

  reactionPickerAnchor = anchorBtn;
  reactionPickerMessage = message;
}

async function retryMediaDownload(message) {
  try {
    const { message: updated } = await api(`/chats/${encodeURIComponent(message.chatJid)}/messages/${encodeURIComponent(message.id)}/retry-media`, {
      method: "POST",
    });
    mergeMessages([updated]);
    renderMessages();
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível baixar de novo" });
  }
}

async function sendReaction(message, emoji) {
  const chatJid = message.chatJid;
  const myReaction = message.reactions?.find((r) => r.fromMe)?.emoji;
  const toSend = emoji === myReaction ? "" : emoji; // clicar na mesma reação de novo tira ela
  try {
    await api(`/chats/${encodeURIComponent(chatJid)}/messages/${encodeURIComponent(message.id)}/react`, { method: "POST", body: { emoji: toSend } });
    if (chatJid === activeChatJid) {
      const { messages: page } = await api(`/chats/${encodeURIComponent(chatJid)}/messages?limit=${PAGE_SIZE}`);
      mergeMessages(page);
      renderMessages();
    }
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível reagir" });
  }
}

chatReactionPickerEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-emoji]");
  if (btn && reactionPickerMessage) sendReaction(reactionPickerMessage, btn.dataset.emoji);
  closeReactionPicker();
});
document.addEventListener("click", (e) => {
  if (chatReactionPickerEl.classList.contains("hidden")) return;
  if (chatReactionPickerEl.contains(e.target)) return;
  if (reactionPickerAnchor && reactionPickerAnchor.contains(e.target)) return;
  closeReactionPicker();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeReactionPicker();
});

/* ---------- Lista de conversas ---------- */

function chatListItemHtml(c) {
  const active = c.jid === activeChatJid ? "is-active" : "";
  const unread =
    c.unreadCount > 0 && c.jid !== activeChatJid
      ? `<span class="chat-unread-badge">${c.unreadCount > 99 ? "99+" : c.unreadCount}</span>`
      : "";
  const pin = c.pinnedAt ? icon("pin") : "";
  return `
    <li>
      <div class="chat-list-item ${active}" data-jid="${escapeHtml(c.jid)}" role="button" tabindex="0">
        ${avatarHtml(displayName(c), { size: "sm", pictureUrl: pictureUrlFor(c.jid) })}
        <div class="chat-list-item-body">
          <div class="chat-list-item-top">
            <span class="chat-list-item-name">${pin}<span>${escapeHtml(displayName(c))}</span></span>
            <span class="chat-list-item-time">${c.lastMessageAt ? relativeTime(c.lastMessageAt) : ""}</span>
          </div>
          <div class="chat-list-item-bottom">
            <span class="chat-list-item-preview">${escapeHtml(previewText(c))}</span>
            ${unread}
          </div>
        </div>
        <button type="button" class="chat-list-item-menu-btn" data-menu-jid="${escapeHtml(c.jid)}" aria-label="Mais opções">${icon("more")}</button>
      </div>
    </li>`;
}

function renderChatList() {
  const visible = chats.filter(chatMatchesListFilter);
  const html = chats.length
    ? visible.length
      ? visible.map(chatListItemHtml).join("")
      : emptyState({ iconName: "search", title: "Nenhuma conversa encontrada", text: "Tente buscar por outro nome ou número." })
    : emptyState({ iconName: "message", title: "Nenhuma conversa ainda", text: "As mensagens que chegarem (privadas ou de grupo) aparecem aqui, em tempo real." });
  if (html !== chatListHtml) {
    chatListHtml = html;
    chatListEl.innerHTML = html;
  }

  const hasArchived = archivedChats.length > 0;
  chatArchivedToggle.classList.toggle("hidden", !hasArchived);
  chatArchivedCount.textContent = hasArchived ? String(archivedChats.length) : "";

  const visibleArchived = archivedChats.filter(chatMatchesListFilter);
  const archivedHtml = archivedChats.length
    ? visibleArchived.length
      ? visibleArchived.map(chatListItemHtml).join("")
      : emptyState({ iconName: "search", title: "Nenhuma conversa encontrada", text: "Tente buscar por outro nome ou número." })
    : "";
  if (archivedHtml !== archivedListHtml) {
    archivedListHtml = archivedHtml;
    chatArchivedList.innerHTML = archivedHtml;
  }
}

/** As linhas de "entrar" numa pasta (uma por lista criada), abaixo de "Arquivadas". */
function renderFolderRows() {
  chatNavRowsEl.querySelectorAll(".chat-nav-row[data-folder-id]").forEach((el) => el.remove());
  for (const folder of folders) {
    const row = document.createElement("div");
    row.className = "chat-nav-row";
    row.dataset.folderId = folder.id;
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    row.innerHTML = `
      ${icon("folder")}
      <span class="chat-nav-row-label">${escapeHtml(folder.name)}</span>
      <button type="button" class="chat-list-item-menu-btn" data-folder-menu="${escapeHtml(folder.id)}" aria-label="Mais opções">${icon("more")}</button>
      ${icon("chevron-right")}
    `;
    chatNavRowsEl.appendChild(row);
  }
}

function renderFolderChatList() {
  const visible = folderChats.filter(chatMatchesListFilter);
  const html = folderChats.length
    ? visible.length
      ? visible.map(chatListItemHtml).join("")
      : emptyState({ iconName: "search", title: "Nenhuma conversa encontrada", text: "Tente buscar por outro nome ou número." })
    : emptyState({ iconName: "inbox", title: "Nenhuma conversa nesta lista ainda", text: "Adicione pelo menu \"⋮\" de qualquer conversa." });
  if (html !== folderListHtml) {
    folderListHtml = html;
    chatFolderListEl.innerHTML = html;
  }
}

function findChat(jid) {
  return chats.find((c) => c.jid === jid) || archivedChats.find((c) => c.jid === jid) || folderChats.find((c) => c.jid === jid);
}

/* ---------- Navegação entre a lista principal, arquivadas e pastas ---------- */

function clearChatListFilter() {
  chatListFilter = "";
  chatListSearchInput.value = "";
}

function showMainView() {
  viewingArchived = false;
  currentFolderId = null;
  clearChatListFilter();
  chatListEl.classList.remove("hidden");
  chatArchivedList.classList.add("hidden");
  chatFolderListEl.classList.add("hidden");
  chatNavRowsEl.classList.remove("hidden");
  chatNavBackBtn.classList.add("hidden");
  chatListTitleEl.textContent = "Conversas";
  chatFolderViewMenuBtn.classList.add("hidden");
  renderChatList();
}

function showArchivedView() {
  viewingArchived = true;
  currentFolderId = null;
  clearChatListFilter();
  chatListEl.classList.add("hidden");
  chatFolderListEl.classList.add("hidden");
  chatArchivedList.classList.remove("hidden");
  chatNavRowsEl.classList.add("hidden");
  chatNavBackBtn.classList.remove("hidden");
  chatListTitleEl.textContent = "Arquivadas";
  chatFolderViewMenuBtn.classList.add("hidden");
  renderChatList();
}

async function showFolderView(folderId) {
  viewingArchived = false;
  currentFolderId = folderId;
  clearChatListFilter();
  const folder = folders.find((f) => f.id === folderId);
  chatListEl.classList.add("hidden");
  chatArchivedList.classList.add("hidden");
  chatFolderListEl.classList.remove("hidden");
  chatNavRowsEl.classList.add("hidden");
  chatNavBackBtn.classList.remove("hidden");
  chatListTitleEl.textContent = folder ? folder.name : "Lista";
  chatFolderViewMenuBtn.classList.remove("hidden");
  await refreshFolderView();
}

async function refreshFolderView() {
  if (!currentFolderId) return;
  try {
    const { chats: list } = await api(`/folders/${encodeURIComponent(currentFolderId)}/chats`);
    folderChats = list;
    renderFolderChatList();
  } catch (err) {
    console.error("refreshFolderView falhou:", err);
  }
}

/** Ações de uma conversa/grupo na lista (fixar/arquivar/listas) — usadas tanto pelo "⋮" quanto pelo botão direito. */
function buildChatItemMenuItems(chat, anchor) {
  const pinItems = chat.pinnedAt
    ? [{ action: "unpin", icon: "pin", label: "Desafixar conversa", run: () => togglePin(chat, false) }]
    : [
        { action: "pin", icon: "pin", label: "Fixar conversa", run: () => togglePin(chat, true, false) },
        {
          action: "pin-temp",
          icon: "pin",
          label: "Fixar temporariamente",
          disabled: !misticConfigured,
          disabledReason: "Cadastre a MisticPay primeiro (em Configurações) pra usar a fixada temporária.",
          run: () => togglePin(chat, true, true),
        },
      ];
  const items = [
    ...pinItems,
    {
      action: "archive",
      icon: "archive",
      label: chat.archived ? "Desarquivar conversa" : "Arquivar conversa",
      run: () => toggleArchive(chat),
    },
    {
      action: "folders",
      icon: "folder",
      label: "Adicionar a uma lista…",
      run: () => openFolderPicker(anchor, chat),
    },
  ];
  if (currentFolderId) {
    items.push({
      action: "remove-folder",
      icon: "x",
      label: "Remover desta lista",
      run: () => removeFromCurrentFolder(chat),
    });
  }
  return items;
}

function openChatItemMenu(btn, chat) {
  openDropdown(btn, buildChatItemMenuItems(chat, btn));
}

async function togglePin(chat, pinned, temporary = false) {
  try {
    await api(`/chats/${encodeURIComponent(chat.jid)}/pin`, { method: "POST", body: { pinned, temporary } });
    await refreshChat();
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível fixar/desafixar" });
  }
}

async function toggleArchive(chat) {
  try {
    await api(`/chats/${encodeURIComponent(chat.jid)}/archive`, { method: "POST", body: { archived: !chat.archived } });
    if (chat.jid === activeChatJid && !chat.archived) closeThread();
    await refreshChat();
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível arquivar/desarquivar" });
  }
}

/* ---------- Listas de conversas (pastas) ---------- */

async function openFolderPicker(anchorBtn, chat) {
  // Captura a posição JÁ, antes do await: a lista pode ser redesenhada enquanto a resposta não
  // chega, e aí o botão original não existe mais no DOM (getBoundingClientRect viraria zero). Aceita
  // também um retângulo já pronto (botão direito manda a posição do cursor, não um elemento de verdade).
  const isElement = typeof anchorBtn.getBoundingClientRect === "function" && anchorBtn.nodeType === 1;
  const anchorRect = isElement ? anchorBtn.getBoundingClientRect() : anchorBtn;

  let memberIds = [];
  try {
    const { folderIds } = await api(`/chats/${encodeURIComponent(chat.jid)}/folders`);
    memberIds = folderIds;
  } catch {
    // segue sem nenhuma marcada
  }

  const items = folders.map((f) => ({
    action: `folder-${f.id}`,
    icon: memberIds.includes(f.id) ? "check" : "folder",
    label: f.name,
    run: () => toggleChatInFolder(f.id, chat, memberIds.includes(f.id)),
  }));
  items.push({ action: "new-folder", icon: "plus", label: "Criar nova lista…", run: () => createFolderAndAdd(chat) });
  openDropdown(anchorRect, items);
}

async function toggleChatInFolder(folderId, chat, isMember) {
  try {
    if (isMember) await api(`/folders/${encodeURIComponent(folderId)}/chats/${encodeURIComponent(chat.jid)}`, { method: "DELETE" });
    else await api(`/folders/${encodeURIComponent(folderId)}/chats`, { method: "POST", body: { chatJid: chat.jid } });
    notify.success(isMember ? "Removida da lista." : "Adicionada à lista.", { duration: 1500 });
    if (currentFolderId === folderId) await refreshFolderView();
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível atualizar a lista" });
  }
}

async function createFolderAndAdd(chat) {
  const name = await promptDialog({ title: "Nova lista de conversas", label: "Nome da lista", placeholder: "Clientes Premium" });
  if (!name) return;
  try {
    const { folder } = await api("/folders", { method: "POST", body: { name } });
    folders.push(folder);
    renderFolderRows();
    if (chat) {
      await api(`/folders/${encodeURIComponent(folder.id)}/chats`, { method: "POST", body: { chatJid: chat.jid } });
      notify.success(`Lista "${folder.name}" criada e conversa adicionada.`, { duration: 2500 });
    } else {
      notify.success(`Lista "${folder.name}" criada.`, { duration: 2000 });
    }
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível criar a lista" });
  }
}

async function removeFromCurrentFolder(chat) {
  if (!currentFolderId) return;
  try {
    await api(`/folders/${encodeURIComponent(currentFolderId)}/chats/${encodeURIComponent(chat.jid)}`, { method: "DELETE" });
    await refreshFolderView();
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível remover da lista" });
  }
}

function openFolderRowMenu(btn, folder) {
  openDropdown(btn, [{ action: "delete", icon: "trash", label: "Excluir lista", danger: true, run: () => deleteFolderConfirm(folder) }]);
}

async function deleteFolderConfirm(folder) {
  const confirmed = await confirmDialog({
    title: `Excluir a lista "${folder.name}"?`,
    message: "As conversas continuam normalmente — só a lista é apagada.",
    confirmText: "Excluir lista",
    tone: "danger",
  });
  if (!confirmed) return;
  try {
    await api(`/folders/${encodeURIComponent(folder.id)}`, { method: "DELETE" });
    folders = folders.filter((f) => f.id !== folder.id);
    renderFolderRows();
    if (currentFolderId === folder.id) showMainView();
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível excluir a lista" });
  }
}

function handleChatListClick(e) {
  const menuBtn = e.target.closest(".chat-list-item-menu-btn[data-menu-jid]");
  if (menuBtn) {
    const chat = findChat(menuBtn.dataset.menuJid);
    if (chat) openChatItemMenu(menuBtn, chat);
    return;
  }
  const item = e.target.closest(".chat-list-item");
  if (item) openChat(item.dataset.jid);
}

function handleChatListKeydown(e) {
  if (e.key !== "Enter" && e.key !== " ") return;
  const item = e.target.closest(".chat-list-item");
  if (!item) return;
  e.preventDefault();
  openChat(item.dataset.jid);
}

function handleNavRowsClick(e) {
  const folderMenuBtn = e.target.closest(".chat-list-item-menu-btn[data-folder-menu]");
  if (folderMenuBtn) {
    const folder = folders.find((f) => f.id === folderMenuBtn.dataset.folderMenu);
    if (folder) openFolderRowMenu(folderMenuBtn, folder);
    return;
  }
  if (e.target.closest("#chat-archived-toggle")) return showArchivedView();
  const folderRow = e.target.closest(".chat-nav-row[data-folder-id]");
  if (folderRow) showFolderView(folderRow.dataset.folderId);
}

/* ---------- Corpo das mensagens ---------- */

function quotedLabel(type) {
  return (
    { image: "Imagem", video: "Vídeo", audio: "Áudio", document: "Documento", sticker: "Figurinha", location: "Localização", contact: "Contato" }[type] ||
    "Mensagem"
  );
}

/** Tarja de "em resposta a..." acima do texto, igual ao WhatsApp. */
function quotedPreviewHtml(q) {
  if (!q) return "";
  const who = q.fromMe ? "Você" : q.pushName || "Contato";
  const text = q.type === "text" ? q.text || "" : `${PREVIEW_ICONS[q.type] || ""} ${quotedLabel(q.type)}`.trim();
  return `<div class="chat-quote"><strong>${escapeHtml(who)}</strong><span>${escapeHtml(text)}</span></div>`;
}

/** Emojis de quem reagiu, como um chip sobre o canto da bolha. */
function reactionsHtml(m) {
  if (!m.reactions?.length) return "";
  const emojis = m.reactions.map((r) => r.emoji).join("");
  const who = m.reactions.map((r) => (r.fromMe ? "Você" : r.pushName || "Alguém")).join(", ");
  return `<span class="chat-bubble-reactions" title="${escapeHtml(who)}">${escapeHtml(emojis)}</span>`;
}

const STATUS_ICONS = { sent: "check", delivered: "check-check", read: "check-check", played: "check-check" };

/** Tique de entrega (só nas suas próprias mensagens): um check, dois checks, ou os dois azuis quando lida. */
function statusHtml(m) {
  if (!m.fromMe || !m.status) return "";
  if (m.status === "error") return `<span class="msg-status msg-status-error" title="Não foi entregue">${icon("alert")}</span>`;
  const iconName = STATUS_ICONS[m.status];
  if (!iconName) return "";
  const read = m.status === "read" || m.status === "played";
  return `<span class="msg-status ${read ? "msg-status-read" : "msg-status-delivered"}" title="${escapeHtml(m.status)}">${icon(iconName)}</span>`;
}

/** Fim do aviso "~Fulano pediu para entrar no grupo" que o servidor grava (ver `join_request` em utils/chat-content.ts). */
const JOIN_REQUEST_SUFFIX = " pediu para entrar no grupo";
/** Como esse aviso era gravado antes (mensagem de texto comum, sem o nome): os antigos continuam no histórico. */
const LEGACY_JOIN_REQUEST_PREFIX = "🔔 Pediu para entrar no grupo";

/** Texto do aviso de pedido de entrada ("~Fulano pediu para entrar no grupo"), ou null se a mensagem não é um. */
function joinRequestNoteText(m, isGroup) {
  if (!isGroup || !m.text) return null;
  if (m.type === "system" && m.text.endsWith(JOIN_REQUEST_SUFFIX)) return m.text;
  if (m.type === "text" && m.text.startsWith(LEGACY_JOIN_REQUEST_PREFIX)) {
    const phone = m.senderJid && m.senderJid.endsWith("@s.whatsapp.net") ? formatPhone(phoneFromJid(m.senderJid)) : "";
    const who = m.pushName ? `~${m.pushName}` : phone || "Alguém";
    return `${who}${JOIN_REQUEST_SUFFIX}`;
  }
  return null;
}

/** Corpo da bolha: mídia de verdade (quando já baixada) ou um texto de espera/legenda. */
function messageBodyHtml(m) {
  if (m.type === "revoked") return `<span class="chat-bubble-revoked">${icon("ban")} Mensagem apagada</span>`;
  if (m.type === "reaction") return `<span class="chat-bubble-media">Reagiu ${escapeHtml(m.reactionEmoji || "")}</span>`;
  if (m.type === "text") return `<span class="chat-bubble-text">${linkifyHtml(m.text || "")}</span>`;
  // Contato e localização nunca têm arquivo de mídia (não são "baixáveis") — mostram o texto de
  // verdade direto, sem cair no estado de "baixando" como as mídias de verdade logo abaixo.
  if (m.type === "contact") return `<span class="chat-bubble-media">${icon("user")} ${escapeHtml(m.text || "Contato")}</span>`;
  if (m.type === "location") return `<span class="chat-bubble-media">${icon("pin")} ${m.text ? `Localização: ${escapeHtml(m.text)}` : "Localização"}</span>`;

  const caption = m.text ? `<div class="chat-bubble-text">${linkifyHtml(m.text)}</div>` : "";

  if (!m.mediaFile) {
    const emoji = PREVIEW_ICONS[m.type] || "";
    const label =
      m.type === "image" ? "Imagem" :
      m.type === "video" ? "Vídeo" :
      m.type === "audio" ? "Áudio" :
      m.type === "document" ? m.mediaFileName || "Documento" :
      m.type === "sticker" ? "Figurinha" :
      // O servidor guarda qual era o tipo (em `text`): ajuda a saber o que falta tratar
      `Mensagem não suportada por aqui ainda${m.text ? ` (tipo: ${m.text})` : ""}`;
    const downloadable = ["image", "video", "audio", "document", "sticker"].includes(m.type);
    if (downloadable && m.mediaDownloadFailed) {
      return `<span class="chat-bubble-media chat-bubble-media-failed">
        ${icon("alert")} ${escapeHtml(label)} (falha ao baixar)
        <button type="button" class="chat-bubble-retry-media-btn" data-action="retry-media" title="Tentar baixar de novo">${icon("refresh")} Tentar de novo</button>
      </span>`;
    }
    const waiting = downloadable ? " (baixando…)" : "";
    return `<span class="chat-bubble-media chat-bubble-pending">${emoji ? emoji + " " : ""}${escapeHtml(label)}${escapeHtml(waiting)}</span>`;
  }

  const url = mediaUrl(m);
  if (m.type === "image") {
    return `<span class="chat-bubble-image-wrap">
        <img class="chat-bubble-image" src="${url}" alt="">
        <button type="button" class="chat-bubble-download-btn" data-action="download-media" title="Baixar imagem" aria-label="Baixar imagem">${icon("download")}</button>
      </span>${caption}`;
  }
  if (m.type === "sticker") return `<img class="chat-bubble-sticker" src="${url}" alt="">`;
  if (m.type === "video") return `<video class="chat-bubble-video" controls src="${url}"></video>${caption}`;
  if (m.type === "audio") return `<audio class="chat-bubble-audio" controls src="${url}"></audio>`;
  if (m.type === "document") {
    return `<a class="chat-bubble-doc" href="${url}" target="_blank" rel="noopener">${icon("inbox")} ${escapeHtml(m.mediaFileName || "Documento")}</a>${caption}`;
  }
  return messageBodyHtml({ ...m, mediaFile: null });
}

function canForward(type) {
  return ["text", "image", "video", "audio", "document", "sticker"].includes(type);
}

/** Nome (e número) de quem mandou, colorido por pessoa — só em grupo, igual ao WhatsApp. */
function senderHtml(m, isGroup) {
  if (m.fromMe || !isGroup) return "";
  // Com identidade oculta (LID) às vezes não dá pra resolver o telefone de verdade — aí é melhor
  // não mostrar nenhum número do que mostrar os dígitos do LID como se fosse um telefone real.
  const phone = m.senderJid && m.senderJid.endsWith("@s.whatsapp.net") ? formatPhone(phoneFromJid(m.senderJid)) : "";
  const label = [m.pushName ? `~ ${m.pushName}` : null, phone].filter(Boolean).join("  ");
  if (!label) return "";
  const hue = avatarHue(m.senderJid || m.pushName || "?");
  return `<span class="chat-bubble-sender" data-h="${hue}" data-jid="${escapeHtml(m.senderJid || "")}">${escapeHtml(label)}</span>`;
}

function messageBubbleHtml(m, isGroup) {
  // Aviso do WhatsApp ("~Xx adicionou ~Isabelli"): linha centralizada, sem bolha nem ações
  // Pedido de entrada no grupo: o mesmo aviso centralizado, só que clicável (abre os pedidos pendentes)
  const joinRequest = joinRequestNoteText(m, isGroup);
  if (joinRequest) {
    return `<div class="chat-system-row" data-id="${escapeHtml(m.id)}" title="${escapeHtml(formatDateTime(m.timestamp))}"><button type="button" class="chat-system-note chat-join-request" title="Abrir os pedidos de entrada pendentes deste grupo">${escapeHtml(joinRequest)}. <strong>Ver pedidos</strong></button></div>`;
  }
  if (m.type === "system") {
    return `<div class="chat-system-row" data-id="${escapeHtml(m.id)}" title="${escapeHtml(formatDateTime(m.timestamp))}"><span class="chat-system-note">${escapeHtml(m.text || "")}</span></div>`;
  }
  const mine = m.fromMe ? "is-mine" : "";
  const sticker = m.type === "sticker" ? "chat-bubble-sticker-wrap" : "";
  const variantBtn =
    quickReplySettings.enabled
      ? `<button type="button" class="chat-bubble-action-btn" data-action="reply-variant" aria-label="Responder com variante" title="Responder com uma variante sorteada">${icon("dice")}</button>`
      : "";
  const actions =
    m.type !== "revoked"
      ? `<div class="chat-bubble-actions">
          <button type="button" class="chat-bubble-action-btn" data-action="react" aria-label="Reagir" title="Reagir com um emoji">${icon("smile")}</button>
          <button type="button" class="chat-bubble-action-btn" data-action="reply" aria-label="Responder" title="Marcar esta mensagem para resposta">${icon("reply")}</button>
          ${variantBtn}
          <button type="button" class="chat-bubble-action-btn" data-action="more" aria-label="Mais opções" title="Mais opções">${icon("more")}</button>
        </div>`
      : "";
  // As ações ficam AO LADO da bolha (não por cima dela): com flexbox, elas entram no mesmo grupo
  // "hoverável" da linha, então o mouse nunca sai da área de hover ao se mover em direção a elas
  // (gavava sumindo antes, quando ficavam fora da bolha flutuando por cima).
  const bubble = `
    <div class="chat-bubble">
      ${senderHtml(m, isGroup)}
      ${quotedPreviewHtml(m.quotedPreview)}
      ${messageBodyHtml(m)}
      <span class="chat-bubble-time">${formatDateTime(m.timestamp)}${statusHtml(m)}</span>
      ${reactionsHtml(m)}
    </div>`;
  return `
    <div class="chat-bubble-row ${mine} ${sticker}" data-id="${escapeHtml(m.id)}">
      ${m.fromMe ? actions + bubble : bubble + actions}
    </div>`;
}

/** Lista de ações de uma mensagem — usada tanto pelo botão "..." quanto pelo menu de botão direito. */
function buildMessageMenuItems(message) {
  const items = [];
  if (message.type !== "revoked") items.push({ action: "reply", icon: "reply", label: "Responder", run: () => startReply(message) });
  if (message.text) items.push({ action: "copy", icon: "copy", label: "Copiar texto", run: () => copyMessageText(message.text) });
  if (canForward(message.type)) items.push({ action: "forward", icon: "forward", label: "Encaminhar", run: () => openForwardModal(message) });
  if (message.type === "sticker" && message.mediaFile) {
    items.push({ action: "save-sticker", icon: "sticker", label: "Salvar figurinha", run: () => saveStickerToLibrary(message) });
  }
  items.push({ action: "delete-me", icon: "trash", label: "Apagar para mim", run: () => deleteForMe(message) });
  if (message.fromMe && message.type !== "revoked") {
    items.push({ action: "delete-everyone", icon: "trash", label: "Apagar para todos", danger: true, run: () => deleteForEveryone(message) });
  }
  return items;
}

function openMessageMenu(btn, message) {
  openDropdown(btn, buildMessageMenuItems(message));
}

async function copyMessageImage(message) {
  try {
    const res = await fetch(mediaUrl(message));
    const blob = await res.blob();
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    notify.success("Imagem copiada.", { duration: 1500 });
  } catch {
    notify.error("Não foi possível copiar a imagem.");
  }
}

function downloadMessageMedia(message) {
  const a = document.createElement("a");
  a.href = mediaUrl(message);
  a.download = message.mediaFileName || `${message.type}-${message.id}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Botão direito em cima de uma mensagem: imagem/figurinha ganham copiar/baixar, além das ações de sempre. */
export function getChatContextMenuItems(target, e) {
  const listItem = target.closest(".chat-list-item");
  if (listItem) {
    const chat = findChat(listItem.dataset.jid);
    if (!chat) return null;
    return buildChatItemMenuItems(chat, { top: e.clientY, bottom: e.clientY, left: e.clientX, right: e.clientX });
  }

  const row = target.closest(".chat-bubble-row");
  if (!row) return null;
  const message = messages.find((m) => m.id === row.dataset.id);
  if (!message) return null;

  const items = [];
  if (target.closest(".chat-bubble-image, .chat-bubble-sticker") && message.mediaFile) {
    items.push({ label: "Copiar imagem", icon: "copy", run: () => copyMessageImage(message) });
    items.push({ label: "Baixar imagem", icon: "download", run: () => downloadMessageMedia(message) });
    items.push({ separator: true });
  }
  items.push(...buildMessageMenuItems(message));
  return items;
}

function startReply(message) {
  replyTo = message;
  chatReplyName.textContent = message.fromMe ? "Você" : message.pushName || "Contato";
  chatReplyPreview.textContent = message.type === "text" ? message.text || "" : quotedLabel(message.type);
  chatReplyBar.classList.remove("hidden");
  chatInput.focus();
}

function cancelReply() {
  replyTo = null;
  chatReplyBar.classList.add("hidden");
}

async function copyMessageText(text) {
  try {
    await navigator.clipboard.writeText(text);
    notify.success("Texto copiado.", { duration: 1500 });
  } catch {
    notify.error("Não foi possível copiar. Selecione e copie à mão.");
  }
}

/* ---------- Figurinhas (biblioteca compartilhada com a coleta automática dos grupos) ---------- */

async function saveStickerToLibrary(message) {
  try {
    const res = await fetch(mediaUrl(message));
    const blob = await res.blob();
    const dataUrl = await fileToDataUrl(blob);
    await api("/stickers", { method: "POST", body: { dataBase64: dataUrl.split(",")[1], sourceName: "Salva do chat" } });
    notify.success("Figurinha salva na sua biblioteca.", { duration: 2000 });
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível salvar a figurinha" });
  }
}

function stickerThumbHtml(s) {
  return `
    <button type="button" class="sticker-thumb" data-id="${escapeHtml(s.id)}" title="${escapeHtml(s.sourceGroupName)}">
      <img src="${accountUrl(`/stickers/${encodeURIComponent(s.id)}/media`)}" alt="" loading="lazy">
    </button>`;
}

function stickerSectionHtml(title, list) {
  if (!list.length) return "";
  return `
    <div class="sticker-section-title">${escapeHtml(title)}</div>
    <div class="sticker-grid">${list.map(stickerThumbHtml).join("")}</div>`;
}

async function openChatStickerPicker() {
  if (!activeChatJid) return;
  chatStickerGrid.innerHTML = Array.from({ length: 8 }, () => `<div class="skeleton-card" style="height:auto;aspect-ratio:1;border-radius:14px"></div>`).join("");
  openModal(chatStickerModal);
  try {
    const { stickers, recentlyUsed } = await api("/stickers");
    if (!stickers.length) {
      chatStickerGrid.innerHTML = emptyState({
        iconName: "sticker",
        title: "Nenhuma figurinha salva ainda",
        text: "Envie uma figurinha pra alguém, ou salve uma que você receber, que ela aparece aqui.",
      });
      return;
    }
    // "Usadas recentemente" primeiro (igual ao WhatsApp), depois a biblioteca inteira.
    chatStickerGrid.innerHTML = stickerSectionHtml("Usadas recentemente", recentlyUsed) + stickerSectionHtml("Todas as figurinhas", stickers);
  } catch (err) {
    chatStickerGrid.innerHTML = emptyState({ iconName: "wifi-off", title: "Falha ao carregar", text: err.message });
  }
}

async function sendStickerFromLibrary(id) {
  if (!activeChatJid || sending) return;
  const jid = activeChatJid;
  closeModal(chatStickerModal);
  sending = true;
  setBusy(chatSendBtn, true);
  try {
    const res = await fetch(accountUrl(`/stickers/${encodeURIComponent(id)}/media`));
    const blob = await res.blob();
    const dataUrl = await fileToDataUrl(blob);
    const body = { media: { type: "sticker", dataBase64: dataUrl.split(",")[1], mimeType: "image/webp" } };
    const { message } = await api(`/chats/${encodeURIComponent(jid)}/messages`, { method: "POST", body });
    mergeMessages([message]);
    renderMessages({ forceScrollBottom: true });
    api(`/stickers/${encodeURIComponent(id)}/use`, { method: "POST" }).catch(() => {});
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível enviar a figurinha" });
  } finally {
    sending = false;
    setBusy(chatSendBtn, false);
  }
}

async function deleteForMe(message) {
  const confirmed = await confirmDialog({
    title: "Apagar esta mensagem?",
    message: "Ela some só do seu histórico aqui no painel — não mexe no WhatsApp de verdade.",
    confirmText: "Apagar",
    tone: "danger",
  });
  if (!confirmed) return;
  try {
    await api(`/chats/${encodeURIComponent(message.chatJid)}/messages/${encodeURIComponent(message.id)}`, { method: "DELETE" });
    messages = messages.filter((m) => m.id !== message.id);
    renderMessages();
    await refreshChat();
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível apagar" });
  }
}

async function deleteForEveryone(message) {
  const confirmed = await confirmDialog({
    title: "Apagar para todos?",
    message: "Vale só pra uma mensagem sua, e só dentro do prazo que o WhatsApp ainda aceitar.",
    confirmText: "Apagar para todos",
    tone: "danger",
  });
  if (!confirmed) return;
  try {
    const { message: updated } = await api(
      `/chats/${encodeURIComponent(message.chatJid)}/messages/${encodeURIComponent(message.id)}/delete-everyone`,
      { method: "POST" }
    );
    mergeMessages([updated]);
    renderMessages();
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível apagar para todos" });
  }
}

/* ---------- Encaminhar ---------- */

function openForwardModal(message) {
  forwardSource = message;
  forwardSearchInput.value = "";
  renderForwardList("");
  openModal(forwardModal);
}

function renderForwardList(filter) {
  const f = normalizeForSearch(filter.trim());
  const fDigits = f.replace(/\D/g, "");
  const list = chats.filter((c) => {
    if (!f) return true;
    if (normalizeForSearch(c.name || "").includes(f)) return true;
    if (!fDigits) return false;
    return (c.phone || phoneFromJid(c.jid)).replace(/\D/g, "").includes(fDigits);
  });
  forwardListEl.innerHTML = list.length
    ? list
        .map(
          (c) => `
      <li class="stack-item" data-jid="${escapeHtml(c.jid)}">
        <div class="stack-main">
          ${avatarHtml(displayName(c), { size: "sm", pictureUrl: pictureUrlFor(c.jid) })}
          <div class="stack-text"><strong>${escapeHtml(displayName(c))}</strong></div>
        </div>
      </li>`
        )
        .join("")
    : emptyState({ iconName: "inbox", title: "Nenhuma conversa encontrada" });
}

forwardSearchInput.addEventListener("input", () => renderForwardList(forwardSearchInput.value));
forwardListEl.addEventListener("click", async (e) => {
  const li = e.target.closest(".stack-item[data-jid]");
  if (!li || !forwardSource) return;
  const to = li.dataset.jid;
  const source = forwardSource;
  try {
    await api(`/chats/${encodeURIComponent(source.chatJid)}/messages/${encodeURIComponent(source.id)}/forward`, {
      method: "POST",
      body: { to },
    });
    notify.success("Mensagem encaminhada.", { duration: 2000 });
    closeModal(forwardModal);
    if (to === activeChatJid) await refreshChat();
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível encaminhar" });
  }
});
bindModal(forwardModal, () => closeModal(forwardModal));

/* ---------- Visualizador de foto ---------- */

/** `downloadName`: nome do arquivo ao clicar em "Baixar" (foto de mensagem leva o nome dela; avatar etc. fica "imagem"). */
function openLightbox(url, downloadName = "imagem") {
  chatLightboxImg.src = url;
  chatLightboxDownload.href = url;
  chatLightboxDownload.download = downloadName;
  chatLightboxEl.classList.remove("hidden");
}

function closeLightbox() {
  chatLightboxEl.classList.add("hidden");
  chatLightboxImg.src = "";
}

chatLightboxClose.addEventListener("click", closeLightbox);
chatLightboxEl.addEventListener("click", (e) => {
  if (e.target === chatLightboxEl) closeLightbox();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !chatLightboxEl.classList.contains("hidden")) closeLightbox();
});

/* ---------- Busca dentro da conversa ---------- */

function updateSearchCount() {
  if (searchResults.length) {
    chatSearchCount.textContent = `${searchIndex + 1} de ${searchResults.length}`;
  } else {
    chatSearchCount.textContent = chatSearchInput.value.trim() ? "Nada encontrado" : "";
  }
}

function openSearch() {
  chatSearchBar.classList.remove("hidden");
  chatSearchInput.value = "";
  searchResults = [];
  searchIndex = -1;
  updateSearchCount();
  chatSearchInput.focus();
}

function closeSearch() {
  chatSearchBar.classList.add("hidden");
  searchResults = [];
  searchIndex = -1;
}

async function jumpToMessage(id, timestamp) {
  if (!messages.some((m) => m.id === id)) {
    try {
      const { messages: page } = await api(`/chats/${encodeURIComponent(activeChatJid)}/messages?before=${timestamp + 1}&limit=${PAGE_SIZE}`);
      if (page.length < PAGE_SIZE) hasMoreOlder = false;
      mergeMessages(page);
      renderMessages();
    } catch {
      return;
    }
  }
  requestAnimationFrame(() => {
    const row = chatMessagesListEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: "center" });
    row.classList.add("chat-message-highlight");
    setTimeout(() => row.classList.remove("chat-message-highlight"), 1600);
  });
}

async function runSearch() {
  const q = chatSearchInput.value.trim();
  if (!q || !activeChatJid) {
    searchResults = [];
    searchIndex = -1;
    updateSearchCount();
    return;
  }
  try {
    const { messages: results } = await api(`/chats/${encodeURIComponent(activeChatJid)}/search?q=${encodeURIComponent(q)}`);
    searchResults = results;
    searchIndex = results.length ? 0 : -1;
    updateSearchCount();
    if (searchIndex >= 0) await jumpToMessage(searchResults[searchIndex].id, searchResults[searchIndex].timestamp);
  } catch {
    // tenta de novo na próxima tecla
  }
}

function goToSearchResult(delta) {
  if (!searchResults.length) return;
  searchIndex = (searchIndex + delta + searchResults.length) % searchResults.length;
  updateSearchCount();
  jumpToMessage(searchResults[searchIndex].id, searchResults[searchIndex].timestamp);
}

chatSearchBtn.addEventListener("click", () => {
  if (chatSearchBar.classList.contains("hidden")) openSearch();
  else closeSearch();
});
chatSearchClose.addEventListener("click", closeSearch);
chatSearchInput.addEventListener("input", () => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
});
chatSearchPrev.addEventListener("click", () => goToSearchResult(-1));
chatSearchNext.addEventListener("click", () => goToSearchResult(1));

/* ---------- Tempo real (WebSocket) ---------- */

function wsUrl(accountId = state.activeAccountId) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${accountUrl("/chats/socket", accountId)}`;
}

/**
 * O som só toca pra mensagem que acabou de chegar de alguém. O mesmo evento de tempo real também
 * carrega atualizações de mensagens antigas (mídia que terminou de baixar ou falhou, a varredura
 * que tenta baixar mídia de novo de tempos em tempos, mensagem apagada, reentrega do WhatsApp) —
 * tocar nelas era o "barulho de mensagem sem mensagem nenhuma ter chegado".
 *
 * `sound` vem do servidor, mensagem a mensagem: é a configuração de som do WhatsApp que recebeu a
 * mensagem (e a conversa não estar arquivada). Antes o painel usava a configuração da conta aberta
 * na tela, que podia não ser a da conta que recebeu.
 */
function shouldPlaySoundFor(message, isNew, sound) {
  if (!sound || !isNew || message.fromMe) return false;
  if (message.type === "reaction" || message.type === "revoked" || message.type === "system") return false;
  // Histórico entregue depois de reconectar: mensagem velha, não é "chegou agora"
  if (Date.now() - message.timestamp > SOUND_MAX_MESSAGE_AGE_MS) return false;
  // A mesma mensagem de grupo chega em cada WhatsApp seu que está no grupo: um bip só
  if (soundedMessageIds.has(message.id)) return false;

  soundedMessageIds.add(message.id);
  if (soundedMessageIds.size > SOUNDED_IDS_LIMIT) soundedMessageIds.delete(soundedMessageIds.values().next().value);
  return true;
}

/**
 * Os outros WhatsApp (os que não estão abertos na tela) também tocam som quando chega mensagem, cada
 * um conforme a configuração dele: um socket por conta, só pra ouvir. Chamado ao trocar de conta e de
 * tempos em tempos (conta nova, conta removida, socket que caiu).
 */
function syncSoundSockets() {
  const wanted = new Set(state.accounts.map((a) => a.id).filter((id) => id !== state.activeAccountId));

  for (const [id, socket] of soundSockets) {
    if (wanted.has(id)) continue;
    soundSockets.delete(id);
    socket.close();
  }

  for (const id of wanted) {
    if (soundSockets.has(id)) continue;
    let socket;
    try {
      socket = new WebSocket(wsUrl(id));
    } catch {
      continue;
    }
    soundSockets.set(id, socket);
    socket.addEventListener("message", (e) => {
      if (soundSockets.get(id) !== socket) return; // conta que virou a da tela (ou saiu): o socket principal cuida
      try {
        const data = JSON.parse(e.data);
        if (data.type === "chat-message" && shouldPlaySoundFor(data.message, data.isNew === true, data.sound === true)) playNotificationSound();
      } catch {
        // mensagem que não era pra gente entender: ignora
      }
    });
    const drop = () => {
      if (soundSockets.get(id) === socket) soundSockets.delete(id); // a próxima sincronização abre de novo
    };
    socket.addEventListener("close", drop);
    socket.addEventListener("error", drop);
  }
}

/** Mensagem nova, enviada, ou que acabou de ganhar mídia: atualiza a conversa aberta na hora. */
function handleRealtimeMessage(message, isNew, sound) {
  if (shouldPlaySoundFor(message, isNew, sound)) playNotificationSound();

  if (message.chatJid === activeChatJid) {
    if (message.type === "reaction") {
      // a reação chega anexada à mensagem alvo (não como linha própria): relê a página carregada
      // pra pegar o estado já calculado, em vez de tentar reproduzir essa lógica aqui também
      api(`/chats/${encodeURIComponent(activeChatJid)}/messages?limit=${PAGE_SIZE}`)
        .then(({ messages: page }) => {
          mergeMessages(page);
          renderMessages();
        })
        .catch(() => {});
    } else {
      // Chegou mensagem enquanto você lia mais acima: o botão de descer mostra quantas tem lá embaixo
      if (isNew && !message.fromMe && message.type !== "system" && !isNearBottom()) newBelowCount++;
      mergeMessages([message]);
      renderMessages();
      if (!message.fromMe) markRead(message.chatJid); // você está olhando essa conversa agora
    }
  }
  refreshChatList();
}

function handleRealtimeDeleted(chatJid, id) {
  if (chatJid === activeChatJid && messages.some((m) => m.id === id)) {
    messages = messages.filter((m) => m.id !== id);
    renderMessages();
  }
}

function connectRealtime() {
  if (!state.activeAccountId) return;
  wsSocketAccountId = state.activeAccountId;
  clearTimeout(wsReconnectTimer);

  let socket;
  try {
    socket = ws = new WebSocket(wsUrl());
  } catch {
    scheduleReconnect();
    return;
  }

  ws.addEventListener("open", () => {
    wsConnected = true;
    wsReconnectDelay = WS_RECONNECT_MIN_MS;
  });

  ws.addEventListener("message", (e) => {
    // Socket da conta anterior ainda fechando depois de uma troca de conta: o que chegar por ele
    // não é desta tela
    if (ws !== socket) return;
    try {
      const data = JSON.parse(e.data);
      if (data.type === "chat-message") handleRealtimeMessage(data.message, data.isNew === true, data.sound === true);
      else if (data.type === "chat-message-deleted") handleRealtimeDeleted(data.chatJid, data.id);
    } catch {
      // mensagem que não era pra gente entender: ignora
    }
  });

  const onDown = () => {
    wsConnected = false;
    if (wsSocketAccountId === state.activeAccountId) scheduleReconnect();
  };
  ws.addEventListener("close", onDown);
  ws.addEventListener("error", onDown);
}

function scheduleReconnect() {
  clearTimeout(wsReconnectTimer);
  wsReconnectTimer = setTimeout(connectRealtime, wsReconnectDelay);
  wsReconnectDelay = Math.min(WS_RECONNECT_MAX_MS, wsReconnectDelay * 2);
}

function closeRealtime() {
  clearTimeout(wsReconnectTimer);
  wsReconnectDelay = WS_RECONNECT_MIN_MS;
  wsConnected = false;
  wsSocketAccountId = null;
  if (ws) {
    const socket = ws;
    ws = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.close();
  }
}

/** Leitura periódica (rede de segurança): mais espaçada quando o tempo real está funcionando. */
function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    syncSoundSockets();
    if (!document.hidden) await refreshChat();
    schedulePoll();
  }, wsConnected ? POLL_MS_WITH_SOCKET : POLL_MS_NO_SOCKET);
}

/* ---------- Mensagens da conversa aberta ---------- */

function mergeMessages(batch) {
  const byId = new Map(messages.map((m) => [m.id, m]));
  for (const m of batch) byId.set(m.id, m);
  messages = [...byId.values()].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
}

function renderMessages({ forceScrollBottom = false } = {}) {
  const key = messages
    .map((m) => `${m.id}:${m.mediaFile ?? ""}:${m.mediaDownloadFailed ? 1 : 0}:${m.status ?? ""}:${m.type}:${(m.reactions || []).map((r) => r.emoji).join("")}`)
    .join("|");
  if (key === messagesKey && !forceScrollBottom) return;

  const wasNearBottom = chatMessagesEl.scrollHeight - chatMessagesEl.scrollTop - chatMessagesEl.clientHeight < NEAR_BOTTOM_PX;
  messagesKey = key;

  const chat = findChat(activeChatJid);
  const isGroup = chat ? chat.isGroup : (activeChatJid || "").endsWith("@g.us");

  chatMessagesListEl.innerHTML = messages.length
    ? messages.map((m) => messageBubbleHtml(m, isGroup)).join("")
    : `<div class="empty-state"><span class="empty-icon">${icon("message")}</span><h3>Nenhuma mensagem ainda</h3></div>`;

  chatLoadMoreBtn.classList.toggle("hidden", !hasMoreOlder);

  if (forceScrollBottom || wasNearBottom) chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  updateScrollBottomButton();
}

/* ---------- Botão "descer até o fim" (aparece quando a conversa foi rolada pra cima) ---------- */

function isNearBottom() {
  return chatMessagesEl.scrollHeight - chatMessagesEl.scrollTop - chatMessagesEl.clientHeight < NEAR_BOTTOM_PX;
}

function updateScrollBottomButton() {
  const away = !!activeChatJid && !isNearBottom();
  if (!away) newBelowCount = 0; // já está vendo o fim: nada "novo lá embaixo"
  chatScrollBottomBtn.classList.toggle("hidden", !away);
  chatScrollBottomCount.classList.toggle("hidden", newBelowCount === 0);
  chatScrollBottomCount.textContent = newBelowCount > 99 ? "99+" : String(newBelowCount);
}

chatMessagesEl.addEventListener("scroll", updateScrollBottomButton, { passive: true });
chatScrollBottomBtn.addEventListener("click", () => {
  chatMessagesEl.scrollTo({ top: chatMessagesEl.scrollHeight, behavior: "smooth" });
});

function paintThreadHeader() {
  const chat = findChat(activeChatJid);
  const name = chat ? displayName(chat) : phoneFromJid(activeChatJid);
  chatThreadAvatarEl.innerHTML = avatarHtml(name, { size: "lg", pictureUrl: pictureUrlFor(activeChatJid) });
  chatThreadNameEl.textContent = name;
  // Pro privado, o nome já é o número (ver displayName); a legenda mostra o nome do WhatsApp dela,
  // se tiver, igual ao modal de "dados do contato".
  chatThreadSubEl.textContent = chat?.isGroup ? "Grupo" : chat?.name && chat.phone ? `~${chat.name}` : "";
  renderQuickReplyBar();
}

function closeThread() {
  activeChatJid = null;
  messages = [];
  messagesKey = "";
  hasMoreOlder = true;
  clearAttachment();
  cancelReply();
  closeSearch();
  hideRideBar();
  chatThreadEl.classList.add("hidden");
  chatThreadEmptyEl.classList.remove("hidden");
  chatLayoutEl.classList.remove("is-showing-thread");
  renderChatList();
  renderQuickReplyBar();
}

async function openChat(jid) {
  if (jid === activeChatJid) return;
  activeChatJid = jid;
  messages = [];
  messagesKey = "";
  hasMoreOlder = true;
  clearAttachment();
  cancelReply();
  closeSearch();
  newBelowCount = 0;
  chatScrollBottomBtn.classList.add("hidden");
  hideRideBar(); // a faixa era da conversa anterior; a desta é lida logo abaixo
  void refreshRideBar();

  // Zera o badge na hora (não espera a próxima leitura) e avisa o servidor
  const chat = findChat(jid);
  if (chat) chat.unreadCount = 0;
  markRead(jid);

  chatThreadEmptyEl.classList.add("hidden");
  chatThreadEl.classList.remove("hidden");
  chatLayoutEl.classList.add("is-showing-thread");
  paintThreadHeader();
  renderChatList();
  chatMessagesListEl.innerHTML = `<div class="empty-state"><span class="spinner"></span></div>`;

  try {
    const { messages: page } = await api(`/chats/${encodeURIComponent(jid)}/messages?limit=${PAGE_SIZE}`);
    if (jid !== activeChatJid) return; // trocou de conversa enquanto carregava
    if (page.length < PAGE_SIZE) hasMoreOlder = false;
    mergeMessages(page);
    renderMessages({ forceScrollBottom: true });
  } catch (err) {
    chatMessagesListEl.innerHTML = emptyState({ iconName: "wifi-off", title: "Não foi possível carregar as mensagens", text: err.message });
  }
}

async function loadOlderMessages() {
  if (!activeChatJid || loadingMore || !hasMoreOlder || messages.length === 0) return;
  loadingMore = true;
  setBusy(chatLoadMoreBtn, true);
  const jid = activeChatJid;
  try {
    const oldest = messages[0];
    const { messages: older } = await api(`/chats/${encodeURIComponent(jid)}/messages?before=${oldest.timestamp}&limit=${PAGE_SIZE}`);
    if (jid !== activeChatJid) return;
    if (older.length < PAGE_SIZE) hasMoreOlder = false;

    const prevHeight = chatMessagesEl.scrollHeight;
    mergeMessages(older);
    renderMessages();
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight - prevHeight;
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível carregar mensagens antigas" });
  } finally {
    loadingMore = false;
    setBusy(chatLoadMoreBtn, false);
  }
}

/* ---------- Assistente de corrida: faixa com a situação da corrida acompanhada nessa conversa ---------- */

function rideTitle(trip) {
  if (!trip) return "Abrindo o acompanhamento da corrida…";
  switch (trip.phase) {
    case "near_pickup":
      return "Motorista chegando · uns 2 min";
    case "near_pickup_1min":
      return "Motorista chegando · menos de 1 min";
    case "arrived_pickup":
      return "Motorista no local de partida";
    case "in_progress":
      return "Corrida em andamento";
    default:
      return trip.etaSeconds != null ? `Motorista a caminho · uns ${Math.max(1, Math.ceil(trip.etaSeconds / 60))} min` : "Acompanhando a corrida · aguardando motorista";
  }
}

function rideDetail(trip) {
  if (!trip) return "";
  return [
    trip.vehicleDescription,
    trip.vehiclePlate,
    trip.driverName,
    trip.agreedAmountCents != null ? `combinado ${formatBRL(trip.agreedAmountCents / 100)}` : "sem valor combinado (não cobra sozinho)",
    trip.lastCheckedAt ? null : "ainda sem resposta da Uber",
  ]
    .filter(Boolean)
    .join(" · ");
}

function hideRideBar() {
  chatRideBarEl.classList.add("hidden");
}

/**
 * Em que pé está a corrida, pra cor da bolinha e a ordem na barra: "waiting" = ainda não embarcou,
 * "unpaid" = embarcou mas ainda não pagou, "paid" = embarcou e já pagou (só falta a corrida terminar).
 */
function rideStage(trip) {
  if (trip.phase !== "in_progress" && trip.phase !== "finished") return "waiting";
  return trip.paid ? "paid" : "unpaid";
}

const RIDE_STAGE_ORDER = { waiting: 0, unpaid: 1, paid: 2 };

/** O que cabe na bolinha da corrida com a barra recolhida: minutos até o motorista chegar, alfinete se já chegou, "R$" se falta pagar, check se pagou. */
function rideChipHtml(trip) {
  const stage = rideStage(trip);
  if (stage === "paid") return icon("check");
  if (stage === "unpaid") return "R$";
  if (trip.phase === "arrived_pickup") return icon("pin");
  if (trip.phase === "near_pickup_1min") return "1m";
  if (trip.phase === "near_pickup") return "2m";
  return trip.etaSeconds != null ? `${Math.max(1, Math.ceil(trip.etaSeconds / 60))}m` : icon("car");
}

/**
 * Corridas em acompanhamento de todas as conversas da conta, numa barra estreita à esquerda da lista:
 * só uma bolinha por corrida, que abre mostrando cliente, situação e valor ao passar o mouse (clicar
 * abre a conversa). A corrida fica até terminar de vez, mudando de cor e descendo conforme avança.
 */
function renderRidesList() {
  const html = activeRides.length
    ? `<div class="chat-rides-panel">
        <div class="chat-rides-head"><span class="chat-ride-chip">${icon("car")}</span><span class="chat-rides-head-label">Corridas</span><span class="chat-nav-count">${activeRides.length}</span></div>
        <div class="chat-rides-items">${activeRides
          .map((trip) => {
            const who = (trip.phone ? formatPhone(trip.phone) : null) || trip.name || phoneFromJid(trip.chatJid) || trip.chatJid;
            const amount = trip.agreedAmountCents != null ? formatBRL(trip.agreedAmountCents / 100) : "sem valor";
            const status = `${rideTitle(trip)} · ${amount} · ${trip.paid ? "pago" : "não pago"}`;
            // Clicar na corrida abre a página dela na Uber (mapa e situação ao vivo); o botão ao lado abre a conversa
            const link = `https://trip.uber.com/${encodeURIComponent(trip.shareToken || "")}`;
            return `<div class="chat-ride-item">
            <a class="chat-ride-row ${trip.chatJid === activeChatJid ? "is-active" : ""} ${trip.paid ? "is-paid" : ""}" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer" data-stage="${rideStage(trip)}" title="Abrir a corrida na Uber" aria-label="${escapeHtml(`${who} — ${status} — abrir a corrida na Uber`)}">
              <span class="chat-ride-chip">${rideChipHtml(trip)}</span>
              <span class="chat-ride-row-text">
                <span class="chat-ride-row-name">${escapeHtml(who)}</span>
                <span class="chat-ride-row-status">${escapeHtml(status)}</span>
              </span>
            </a>
            <button type="button" class="icon-btn chat-ride-chat-btn" data-ride-jid="${escapeHtml(trip.chatJid)}" title="Abrir a conversa" aria-label="${escapeHtml(`Abrir a conversa com ${who}`)}">${icon("message")}</button>
            </div>`;
          })
          .join("")}</div>
        <div class="chat-rides-legend" aria-hidden="true">
          <span data-stage="waiting">Ainda não embarcou</span>
          <span data-stage="unpaid">Embarcou, falta pagar</span>
          <span data-stage="paid">Pago, corrida em andamento</span>
        </div>
      </div>`
    : "";
  if (html === ridesListHtml) return;
  ridesListHtml = html;
  chatRidesEl.innerHTML = html;
  chatRidesEl.classList.toggle("hidden", !activeRides.length);
}

async function refreshRidesList() {
  try {
    const { trips } = await api("/chats/uber-trips");
    // Quem ainda não embarcou fica em cima; depois quem embarcou e falta pagar; por último quem já pagou.
    // Dentro de cada grupo, a corrida mais antiga primeiro (a ordem em que o servidor manda).
    activeRides = trips
      .map((trip, index) => ({ trip, index }))
      .sort((a, b) => RIDE_STAGE_ORDER[rideStage(a.trip)] - RIDE_STAGE_ORDER[rideStage(b.trip)] || a.index - b.index)
      .map(({ trip }) => trip);
  } catch {
    activeRides = []; // assistente não liberado pra este usuário, ou leitura falhou
  }
  renderRidesList();
}

chatRidesEl.addEventListener("click", (e) => {
  const row = e.target.closest("[data-ride-jid]");
  if (row) switchToChat(row.dataset.rideJid);
});

/** Corrida que começou sem valor (link mandado pelo celular sem "chama ?"): informa o valor pra cobrança automática sair. */
async function setRideAmount() {
  const jid = activeChatJid;
  if (!jid) return;
  const amount = await promptDialog({
    title: "Valor combinado da corrida",
    message: "Com o valor definido, a cobrança automática sai no momento configurado (ou agora mesmo, se esse momento já passou).",
    label: "Valor combinado (R$)",
    placeholder: "35,00",
    confirmText: "Definir",
  });
  if (!amount) return;
  try {
    await api(`/chats/${encodeURIComponent(jid)}/uber-trip`, { method: "POST", body: { agreedAmount: amount } });
    void refreshRideBar();
    void refreshRidesList();
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível definir o valor" });
  }
}

chatRideSetAmountBtn.addEventListener("click", setRideAmount);

/** Mostra (ou esconde) a faixa da corrida da conversa aberta. Chamado ao abrir a conversa e a cada leitura periódica. */
async function refreshRideBar() {
  const jid = activeChatJid;
  if (!jid || jid.endsWith("@g.us")) return hideRideBar();
  try {
    const { tracking, trip } = await api(`/chats/${encodeURIComponent(jid)}/uber-trip`);
    if (jid !== activeChatJid) return; // trocou de conversa enquanto lia
    if (!tracking) return hideRideBar();
    chatRideTitleEl.textContent = rideTitle(trip);
    chatRideDetailEl.textContent = rideDetail(trip);
    chatRideSetAmountBtn.classList.toggle("hidden", !trip || trip.agreedAmountCents != null);
    chatRideBarEl.classList.remove("hidden");
  } catch {
    if (jid === activeChatJid) hideRideBar(); // assistente não liberado pra este usuário, ou leitura falhou
  }
}

async function stopRideTracking() {
  const jid = activeChatJid;
  if (!jid) return;
  const ok = await confirmDialog({
    title: "Parar de acompanhar essa corrida?",
    message: "O cliente não vai mais receber os avisos automáticos (motorista chegando, chegou, corrida iniciada) nem a cobrança automática dessa corrida.",
    confirmText: "Parar",
  });
  if (!ok) return;
  try {
    await api(`/chats/${encodeURIComponent(jid)}/uber-trip`, { method: "DELETE" });
    if (jid === activeChatJid) hideRideBar();
    void refreshRidesList();
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível parar o acompanhamento" });
  }
}

chatRideStopBtn.addEventListener("click", stopRideTracking);

const UBER_TRIP_LINK_PATTERN =/(?:trip\.uber\.com\/[A-Za-z0-9]+|m\.uber\.com\/go\/share\?\S*share_token=[A-Za-z0-9]+)/i;

/**
 * Se o texto mandado tinha um link de viagem da Uber, começa a acompanhar a corrida — avisa o
 * cliente quando o motorista estiver a 2 min (já cobrando), quando chegar e quando embarcar. O valor
 * combinado o próprio servidor tenta achar sozinho (pelo "NN,NN chama ?" que você já mandou nessa
 * conversa); só pergunta na tela se não achar nenhum.
 */
async function maybeStartUberTripTracking(jid, text) {
  const match = text.match(UBER_TRIP_LINK_PATTERN);
  if (!match) return;

  let amount;
  try {
    await api(`/chats/${encodeURIComponent(jid)}/uber-trip`, { method: "POST", body: { link: match[0] } });
    notify.success("Vou cobrar e avisar o cliente sozinho conforme a corrida avançar.", { title: "Acompanhando a corrida" });
    void refreshRideBar();
    return;
  } catch (err) {
    if (!err.needsAmount) return notify.error(err.message, { title: "Não foi possível acompanhar essa corrida" });
    amount = await promptDialog({
      title: "Acompanhar essa corrida?",
      message: "Esse é um link de viagem da Uber. Não achei nenhum \"chama ?\" recente nessa conversa pra pegar o valor sozinho — informe o valor combinado.",
      label: "Valor combinado (R$)",
      placeholder: "35,00",
      confirmText: "Acompanhar",
    });
    if (!amount) return;
  }

  try {
    await api(`/chats/${encodeURIComponent(jid)}/uber-trip`, { method: "POST", body: { link: match[0], agreedAmount: amount } });
    notify.success("Vou cobrar e avisar o cliente sozinho conforme a corrida avançar.", { title: "Acompanhando a corrida" });
    void refreshRideBar();
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível acompanhar essa corrida" });
  }
}

async function sendMessage() {
  const text = chatInput.value.trim();
  const attachment = pendingAttachment;
  if (!text && !attachment) return;
  if (!activeChatJid || sending) return;
  const jid = activeChatJid;
  const quotedId = replyTo?.id;
  sending = true;
  setBusy(chatSendBtn, true);
  chatAttachBtn.disabled = true;
  try {
    const body = { text, quotedId };
    if (attachment) {
      const dataUrl = await fileToDataUrl(attachment.file);
      body.media = { type: attachment.type, dataBase64: dataUrl.split(",")[1], mimeType: attachment.mimeType, fileName: attachment.fileName };
    }

    const { message } = await api(`/chats/${encodeURIComponent(jid)}/messages`, { method: "POST", body });
    chatInput.value = "";
    autoGrowComposeInput();
    clearAttachment();
    cancelReply();
    if (jid === activeChatJid) {
      mergeMessages([message]);
      renderMessages({ forceScrollBottom: true });
    }
    await refreshChat();
    if (text) void maybeStartUberTripTracking(jid, text);
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível enviar" });
  } finally {
    sending = false;
    setBusy(chatSendBtn, false);
    chatAttachBtn.disabled = false;
    chatInput.focus();
  }
}

/** Lê conversas, arquivadas e listas, sem mexer na conversa aberta. */
async function refreshChatList() {
  try {
    const [{ chats: list }, { chats: archived }, { folders: folderList }] = await Promise.all([
      api("/chats"),
      api("/chats/archived"),
      api("/folders"),
    ]);
    chats = list;
    archivedChats = archived;
    const foldersChanged = folderList.length !== folders.length || folderList.some((f, i) => f.id !== folders[i]?.id || f.name !== folders[i]?.name);
    folders = folderList;
    if (foldersChanged) renderFolderRows();
    renderChatList();
    void refreshRidesList();
    if (activeChatJid) paintThreadHeader();
    if (currentFolderId) await refreshFolderView();
  } catch (err) {
    console.error("refreshChatList falhou:", err);
  }
}

/** Lê as conversas e, se uma estiver aberta, as mensagens dela (chamado a cada poucos segundos). */
export async function refreshChat() {
  await refreshChatList();
  if (!activeChatJid) return;
  void refreshRideBar();
  try {
    const { messages: page } = await api(`/chats/${encodeURIComponent(activeChatJid)}/messages?limit=${PAGE_SIZE}`);
    mergeMessages(page);
    renderMessages();
    markRead(activeChatJid); // rede de segurança: mantém zerado enquanto a conversa está aberta
  } catch (err) {
    console.error("refreshChat falhou:", err);
  }
}

/* ---------- Divisor redimensionável da lista (igual ao da lista de grupos) ---------- */

const CHAT_LIST_WIDTH_KEY = "brinzy-chat-list-width";
const DEFAULT_CHAT_LIST_WIDTH = 300;
const MIN_CHAT_LIST_WIDTH = 240;
const MAX_CHAT_LIST_WIDTH = 520;

function applyChatListWidth(width) {
  const clamped = Math.min(MAX_CHAT_LIST_WIDTH, Math.max(MIN_CHAT_LIST_WIDTH, Math.round(width)));
  chatLayoutEl.style.setProperty("--chat-list-width", `${clamped}px`);
  chatListResizerEl.setAttribute("aria-valuenow", String(clamped));
  return clamped;
}

function saveChatListWidth(width) {
  try {
    localStorage.setItem(CHAT_LIST_WIDTH_KEY, String(width));
  } catch {
    // localStorage indisponível
  }
}

function initChatListResizer() {
  chatListResizerEl.setAttribute("aria-valuemin", String(MIN_CHAT_LIST_WIDTH));
  chatListResizerEl.setAttribute("aria-valuemax", String(MAX_CHAT_LIST_WIDTH));
  try {
    const saved = Number(localStorage.getItem(CHAT_LIST_WIDTH_KEY));
    applyChatListWidth(saved || DEFAULT_CHAT_LIST_WIDTH);
  } catch {
    applyChatListWidth(DEFAULT_CHAT_LIST_WIDTH);
  }

  chatListResizerEl.addEventListener("pointerdown", (e) => {
    chatListResizerEl.setPointerCapture(e.pointerId);
    chatListResizerEl.classList.add("dragging");
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  chatListResizerEl.addEventListener("pointermove", (e) => {
    if (!chatListResizerEl.hasPointerCapture(e.pointerId)) return;
    const rect = chatLayoutEl.getBoundingClientRect();
    applyChatListWidth(e.clientX - rect.left);
  });
  const stopDragging = (e) => {
    if (!chatListResizerEl.classList.contains("dragging")) return;
    chatListResizerEl.classList.remove("dragging");
    document.body.style.userSelect = "";
    if (chatListResizerEl.hasPointerCapture(e.pointerId)) chatListResizerEl.releasePointerCapture(e.pointerId);
    saveChatListWidth(chatListPaneEl.getBoundingClientRect().width);
  };
  chatListResizerEl.addEventListener("pointerup", stopDragging);
  chatListResizerEl.addEventListener("pointercancel", stopDragging);
  chatListResizerEl.addEventListener("dblclick", () => {
    applyChatListWidth(DEFAULT_CHAT_LIST_WIDTH);
    saveChatListWidth(DEFAULT_CHAT_LIST_WIDTH);
  });
  chatListResizerEl.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const current = Number(chatListResizerEl.getAttribute("aria-valuenow")) || DEFAULT_CHAT_LIST_WIDTH;
    const next = applyChatListWidth(current + (e.key === "ArrowRight" ? 20 : -20));
    saveChatListWidth(next);
  });
}

/* ---------- Dados do contato (clicar no nome do topo, ou no nome de alguém num grupo) ---------- */

let contactInfoRequestId = 0; // evita que uma resposta de rede atrasada sobrescreva o modal depois de trocar de pessoa
let currentParticipantsGroupJid = null;
let currentParticipantsMeta = null;
let participantsFilter = "";

function contactInfoMediaThumbHtml(m) {
  const url = mediaUrl(m);
  if (m.type === "image" || m.type === "sticker") {
    return `<div class="contact-info-media-thumb" data-url="${escapeHtml(url)}"><img src="${url}" alt="" loading="lazy"></div>`;
  }
  if (m.type === "video") {
    return `<a class="contact-info-media-thumb" href="${url}" target="_blank" rel="noopener">${icon("play")}</a>`;
  }
  return `<a class="contact-info-media-thumb" href="${url}" target="_blank" rel="noopener" title="${escapeHtml(m.mediaFileName || "Documento")}">${icon("paperclip")}</a>`;
}

function renderContactInfoMedia(media) {
  contactInfoMediaSection.classList.toggle("hidden", media.length === 0);
  if (!media.length) return;
  contactInfoMediaCount.textContent = String(media.length);
  contactInfoMediaGrid.innerHTML = media.slice(0, 8).map(contactInfoMediaThumbHtml).join("");
}

function renderContactInfoGroupsInCommon(groups) {
  contactInfoGroupsSection.classList.toggle("hidden", groups.length === 0);
  if (!groups.length) return;
  contactInfoGroupsTitle.textContent = groups.length === 1 ? "1 grupo em comum" : `${groups.length} grupos em comum`;
  contactInfoGroupsList.innerHTML = groups
    .map(
      (g) => `
    <button type="button" class="contact-info-group-item" data-jid="${escapeHtml(g.jid)}">
      ${avatarHtml(displayName(g), { pictureUrl: pictureUrlFor(g.jid) })}
      <strong>${escapeHtml(displayName(g))}</strong>
    </button>`
    )
    .join("");
}

function adminRank(p) {
  return p.isSuperAdmin ? 2 : p.isAdmin ? 1 : 0;
}

function participantMatchesFilter(p) {
  if (!participantsFilter) return true;
  const label = normalizeForSearch(p.name || "");
  if (label.includes(participantsFilter)) return true;
  const queryDigits = participantsFilter.replace(/\D/g, "");
  return queryDigits.length > 0 && (p.phone || "").includes(queryDigits);
}

function participantRowHtml(p) {
  const label = p.isSelf ? "Você" : p.name || (p.phone ? formatPhone(p.phone) : null) || p.jid;
  const phoneLabel = p.phone ? formatPhone(p.phone) : "";
  const badge = adminRank(p) > 0 ? `<span class="badge badge-primary">Admin do grupo</span>` : "";
  // "Chamar no privado" não precisa ser admin — só as outras ações (promover/remover) exigem
  const menuBtn = !p.isSelf
    ? `<button type="button" class="icon-btn icon-btn-sm participant-menu-btn" data-jid="${escapeHtml(p.jid)}" aria-label="Mais opções">${icon("more")}</button>`
    : "";
  return `
    <li class="stack-item" data-jid="${escapeHtml(p.jid)}">
      <div class="stack-main">
        ${avatarHtml(label, { size: "sm", pictureUrl: pictureUrlFor(p.jid) })}
        <div class="stack-text">
          <strong>${escapeHtml(label)}</strong>
          ${phoneLabel && phoneLabel !== label ? `<span class="sub">${escapeHtml(phoneLabel)}</span>` : ""}
        </div>
      </div>
      ${badge}
      ${menuBtn}
    </li>`;
}

function renderParticipantsList() {
  if (!currentParticipantsMeta) return;
  const sorted = [...currentParticipantsMeta.participants]
    .filter(participantMatchesFilter)
    .sort((a, b) => adminRank(b) - adminRank(a));
  groupParticipantsListEl.innerHTML = sorted.length
    ? sorted.map((p) => participantRowHtml(p)).join("")
    : emptyState({ iconName: "search", title: "Ninguém encontrado", text: "Tente buscar por outro nome ou número." });
}

function openGroupParticipantsModal(groupJid, meta) {
  currentParticipantsGroupJid = groupJid;
  currentParticipantsMeta = meta;
  participantsFilter = "";
  groupParticipantsSearchInput.value = "";
  groupParticipantsCountEl.textContent = `${meta.memberCount} membros`;
  groupParticipantsAdminActionsEl.classList.toggle("hidden", !meta.selfIsAdmin);
  renderParticipantsList();
  openModal(groupParticipantsModal);
  if (meta.selfIsAdmin) refreshJoinRequestsBadge(groupJid);
}

/** Atualiza o número no botão "Pedidos pendentes" (sem abrir o modal da lista). */
async function refreshJoinRequestsBadge(groupJid) {
  try {
    const { requests } = await api(`/groups/${encodeURIComponent(groupJid)}/join-requests`);
    if (currentParticipantsGroupJid !== groupJid) return; // trocou de grupo enquanto buscava
    groupJoinRequestsBadge.textContent = String(requests.length);
    groupJoinRequestsBadge.classList.toggle("hidden", requests.length === 0);
  } catch {
    groupJoinRequestsBadge.classList.add("hidden");
  }
}

function joinRequestRowHtml(r) {
  const label = r.jid.endsWith("@s.whatsapp.net") ? formatPhone(r.jid.split("@")[0]) : r.jid;
  return `
    <li class="stack-item" data-jid="${escapeHtml(r.jid)}">
      <div class="stack-main">
        ${avatarHtml(label, { size: "sm", pictureUrl: pictureUrlFor(r.jid) })}
        <div class="stack-text">
          <strong>${escapeHtml(label)}</strong>
          ${r.requestedAt ? `<span class="sub">${relativeTime(r.requestedAt)}</span>` : ""}
        </div>
      </div>
      <div class="card-actions">
        <button type="button" class="icon-btn icon-btn-sm danger" data-act="reject" data-jid="${escapeHtml(r.jid)}" title="Recusar" aria-label="Recusar">${icon("x")}</button>
        <button type="button" class="icon-btn icon-btn-sm" data-act="approve" data-jid="${escapeHtml(r.jid)}" title="Aprovar" aria-label="Aprovar">${icon("check")}</button>
      </div>
    </li>`;
}

async function openGroupJoinRequestsModal() {
  const groupJid = currentParticipantsGroupJid;
  if (!groupJid) return;
  groupJoinRequestsListEl.innerHTML = `<li class="empty-state"><span class="spinner"></span></li>`;
  openModal(groupJoinRequestsModal);
  await loadGroupJoinRequests(groupJid);
}

/**
 * Abre os pedidos pendentes do grupo da conversa aberta direto (clique no aviso "pediu para entrar"),
 * sem precisar passar por Dados do grupo › Participantes › Pedidos pendentes.
 */
async function openJoinRequestsForActiveGroup() {
  const groupJid = activeChatJid;
  if (!groupJid || !groupJid.endsWith("@g.us")) return;
  if (currentParticipantsGroupJid !== groupJid) {
    // A lista de participantes guardada era de outro grupo: esquece (aprovar um pedido relê a deste)
    currentParticipantsGroupJid = groupJid;
    currentParticipantsMeta = null;
  }
  await openGroupJoinRequestsModal();
}

async function loadGroupJoinRequests(groupJid) {
  try {
    const { requests } = await api(`/groups/${encodeURIComponent(groupJid)}/join-requests`);
    if (currentParticipantsGroupJid !== groupJid) return;
    groupJoinRequestsListEl.innerHTML = requests.length
      ? requests.map(joinRequestRowHtml).join("")
      : emptyState({ iconName: "check-circle", title: "Nenhum pedido pendente" });
    groupJoinRequestsBadge.textContent = String(requests.length);
    groupJoinRequestsBadge.classList.toggle("hidden", requests.length === 0);
  } catch (err) {
    groupJoinRequestsListEl.innerHTML = emptyState({ iconName: "wifi-off", title: "Não foi possível carregar os pedidos", text: err.message });
  }
}

async function respondJoinRequest(groupJid, jid, action, btn) {
  setBusy(btn, true);
  try {
    await api(`/groups/${encodeURIComponent(groupJid)}/join-requests`, { method: "POST", body: { jids: [jid], action } });
    notify.success(action === "approve" ? "Pedido aprovado." : "Pedido recusado.", { duration: 2000 });
    await loadGroupJoinRequests(groupJid);
    const meta = await api(`/groups/metadata/${encodeURIComponent(groupJid)}`);
    if (currentParticipantsGroupJid === groupJid) {
      currentParticipantsMeta = meta;
      groupParticipantsCountEl.textContent = `${meta.memberCount} membros`;
      renderParticipantsList();
    }
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível responder" });
    setBusy(btn, false);
  }
}

async function openInviteLinkMenu(btn) {
  const groupJid = currentParticipantsGroupJid;
  if (!groupJid) return;
  openDropdown(btn, [
    { action: "copy", icon: "copy", label: "Copiar link", run: () => copyGroupInviteLink(groupJid) },
    { action: "new", icon: "refresh", label: "Gerar novo link", run: () => regenerateGroupInviteLink(groupJid) },
  ]);
}

async function copyGroupInviteLink(groupJid) {
  try {
    const { link } = await api(`/groups/${encodeURIComponent(groupJid)}/invite`);
    await navigator.clipboard.writeText(link);
    notify.success(link, { title: "Link copiado", duration: 4000 });
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível buscar o link" });
  }
}

async function regenerateGroupInviteLink(groupJid) {
  const confirmed = await confirmDialog({
    title: "Gerar um novo link de convite?",
    message: "O link antigo para de funcionar — quem já tinha esse link não consegue mais entrar com ele.",
    confirmText: "Gerar novo link",
    tone: "danger",
  });
  if (!confirmed) return;
  try {
    const { link } = await api(`/groups/${encodeURIComponent(groupJid)}/invite`, { method: "POST" });
    await navigator.clipboard.writeText(link);
    notify.success(link, { title: "Novo link gerado e copiado", duration: 4000 });
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível gerar um novo link" });
  }
}

async function addParticipantToGroup() {
  const groupJid = currentParticipantsGroupJid;
  if (!groupJid) return;
  const phone = await promptDialog({
    title: "Adicionar participante",
    message: "Número de WhatsApp da pessoa, com DDI e DDD (ex.: 55 11 99999-9999).",
    label: "Número",
    placeholder: "5511999999999",
    confirmText: "Adicionar",
  });
  if (!phone) return;
  const digits = phone.replace(/\D/g, "");
  if (!digits) return;
  try {
    await api(`/groups/${encodeURIComponent(groupJid)}/participants/${encodeURIComponent(`${digits}@s.whatsapp.net`)}`, {
      method: "POST",
      body: { action: "add" },
    });
    notify.success("Participante adicionado.", { duration: 2000 });
    const meta = await api(`/groups/metadata/${encodeURIComponent(groupJid)}`);
    if (currentParticipantsGroupJid === groupJid) {
      currentParticipantsMeta = meta;
      groupParticipantsCountEl.textContent = `${meta.memberCount} membros`;
      renderParticipantsList();
    }
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível adicionar" });
  }
}

function openParticipantActionMenu(btn, participant) {
  const items = [
    { action: "message", icon: "message", label: "Chamar no privado", run: () => switchToChat(participant.phone ? `${participant.phone}@s.whatsapp.net` : participant.jid) },
  ];
  // Promover/rebaixar/remover exigem ser admin do grupo — "Chamar no privado" vale pra qualquer um
  if (currentParticipantsMeta?.selfIsAdmin) {
    if (adminRank(participant) > 0) {
      items.push({ action: "demote", icon: "user", label: "Rebaixar de admin", run: () => performParticipantAction(participant.jid, "demote") });
    } else {
      items.push({ action: "promote", icon: "user", label: "Promover a admin", run: () => performParticipantAction(participant.jid, "promote") });
    }
    items.push({ action: "remove", icon: "x", label: "Remover do grupo", danger: true, run: () => performParticipantAction(participant.jid, "remove") });
  }
  openDropdown(btn, items);
}

async function performParticipantAction(participantJid, action) {
  const groupJid = currentParticipantsGroupJid;
  try {
    await api(`/groups/${encodeURIComponent(groupJid)}/participants/${encodeURIComponent(participantJid)}`, { method: "POST", body: { action } });
    notify.success(
      action === "remove" ? "Participante removido." : action === "promote" ? "Participante promovido a admin." : "Participante rebaixado de admin.",
      { duration: 2000 }
    );
    const meta = await api(`/groups/metadata/${encodeURIComponent(groupJid)}`);
    if (currentParticipantsGroupJid === groupJid) {
      currentParticipantsMeta = meta;
      groupParticipantsCountEl.textContent = `${meta.memberCount} membros`;
      renderParticipantsList();
    }
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível fazer essa alteração" });
  }
}

/**
 * Igual ao "ver dados" do WhatsApp: pro privado, o número vem em destaque como título e o nome do
 * WhatsApp da pessoa (quando a gente souber) vem como legenda "~nome" embaixo — nunca o contrário,
 * porque o painel não tem conceito de "nome salvo" separado do nome que a própria pessoa usa.
 */
function applyContactInfoPhone(jid, phone, presetName) {
  contactInfoNameEl.textContent = phone || presetName || "Contato";
  contactInfoAvatarEl.innerHTML = avatarHtml(presetName || phone || jid, { size: "xl", pictureUrl: pictureUrlFor(jid) });
  contactInfoSubEl.textContent = phone && presetName ? `~${presetName}` : "";
  contactInfoSubEl.classList.toggle("hidden", !contactInfoSubEl.textContent);
  contactInfoPhoneRow.classList.toggle("hidden", !phone);
  contactInfoPhoneEl.textContent = phone;
  contactInfoCopyBtn.closest(".contact-info-action").classList.toggle("hidden", !phone);
  contactInfoCopyBtn.onclick = () => copyMessageText(phone);
}

/** Fecha modais abertos por cima e troca pra essa conversa (ex.: "grupo em comum", "Chamar no privado"). */
function switchToChat(jid) {
  if (isModalOpen(contactInfoModal)) closeModal(contactInfoModal);
  if (isModalOpen(groupParticipantsModal)) closeModal(groupParticipantsModal);
  showMainView();
  openChat(jid);
}

function openContactInfo({ jid, isGroup, presetName }) {
  const requestId = ++contactInfoRequestId;
  const chat = findChat(jid);
  // A lista de conversas já chega com o telefone pronto (resolvido no servidor); usa isso na hora
  // pra não piscar "Carregando…" à toa — a rede só é chamada quando o painel ainda não sabe.
  const seedPhone = !isGroup && chat?.phone ? formatPhone(chat.phone) : "";
  const initialHeading = isGroup ? presetName || "Grupo sem nome" : seedPhone || presetName || "Carregando…";
  const avatarLabel = isGroup ? initialHeading : presetName || seedPhone || jid;

  contactInfoAvatarEl.innerHTML = avatarHtml(avatarLabel, { size: "xl", pictureUrl: pictureUrlFor(jid) });
  contactInfoNameEl.textContent = initialHeading;
  contactInfoSubEl.textContent = isGroup ? "Grupo" : seedPhone && presetName ? `~${presetName}` : "";
  contactInfoSubEl.classList.toggle("hidden", !contactInfoSubEl.textContent);
  contactInfoDescEl.classList.add("hidden");
  contactInfoDescEl.textContent = "";

  // "Chamar no privado": só faz sentido pra uma pessoa (não pro grupo em si) — útil tanto ao abrir
  // pelos dados de alguém quanto ao clicar no nome dela dentro de uma mensagem de grupo.
  contactInfoMessageBtn.classList.toggle("hidden", isGroup);
  if (!isGroup) contactInfoMessageBtn.onclick = () => switchToChat(jid);

  contactInfoPhoneRow.classList.toggle("hidden", !seedPhone);
  contactInfoPhoneEl.textContent = seedPhone;
  contactInfoCopyBtn.closest(".contact-info-action").classList.toggle("hidden", !seedPhone);
  if (seedPhone) contactInfoCopyBtn.onclick = () => copyMessageText(seedPhone);
  contactInfoSearchBtn.onclick = () => {
    closeModal(contactInfoModal);
    if (activeChatJid) openSearch();
  };

  contactInfoAddListBtn.classList.toggle("hidden", !chat);
  if (chat) {
    contactInfoAddListBtn.onclick = () => {
      closeModal(contactInfoModal);
      openFolderPicker(contactInfoAddListBtn, chat);
    };
  }

  contactInfoParticipantsRow.classList.add("hidden");
  contactInfoParticipantsRow.onclick = null;
  contactInfoMediaSection.classList.add("hidden");
  contactInfoGroupsSection.classList.add("hidden");

  openModal(contactInfoModal);

  api(`/chats/${encodeURIComponent(jid)}/media`)
    .then(({ messages: media }) => {
      if (requestId === contactInfoRequestId) renderContactInfoMedia(media);
    })
    .catch(() => {});

  if (!isGroup) {
    // Mesmo já tendo o seedPhone, confirma com o servidor: cobre o caso de abrir pelo nome de
    // alguém num grupo (sem chat conhecido ainda) ou de o painel ainda não ter resolvido nada.
    if (!seedPhone) {
      api(`/chats/${encodeURIComponent(jid)}/identity`)
        .then(({ phone: rawPhone }) => {
          if (requestId !== contactInfoRequestId) return;
          applyContactInfoPhone(jid, rawPhone ? formatPhone(rawPhone) : "", presetName);
        })
        .catch(() => {});
    }

    api(`/chats/${encodeURIComponent(jid)}/groups-in-common`)
      .then(({ chats: groups }) => {
        if (requestId === contactInfoRequestId) renderContactInfoGroupsInCommon(groups);
      })
      .catch(() => {});
  }

  if (isGroup) {
    api(`/groups/metadata/${encodeURIComponent(jid)}`)
      .then((meta) => {
        if (requestId !== contactInfoRequestId) return;
        contactInfoSubEl.textContent = `Grupo · ${meta.memberCount} membros`;
        contactInfoSubEl.classList.remove("hidden");
        if (meta.description) {
          contactInfoDescEl.textContent = meta.description;
          contactInfoDescEl.classList.remove("hidden");
        }
        contactInfoParticipantsCount.textContent = `${meta.memberCount} membros`;
        contactInfoParticipantsRow.onclick = () => openGroupParticipantsModal(jid, meta);
        contactInfoParticipantsRow.classList.remove("hidden");
      })
      .catch(() => {
        // sem conexão com o WhatsApp agora, ou sem permissão pra ver: fica só com "Grupo" mesmo
      });
  }
}

/** Nome mais recente de quem mandou essa mensagem num grupo (pelo histórico já carregado). */
function pushNameFor(senderJid) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].senderJid === senderJid && messages[i].pushName) return messages[i].pushName;
  }
  return null;
}

/* ---------- Ações rápidas: chips de texto pronto + variantes sorteadas ---------- */

async function loadMisticStatus() {
  try {
    const cfg = await api("/mistic/config");
    misticConfigured = !!cfg.configured;
  } catch (err) {
    console.error("loadMisticStatus falhou:", err);
  }
}

/** Bip curto (duas notas) tocado quando chega mensagem de alguém (quem decide se toca é `shouldPlaySoundFor`). */
function playNotificationSound() {
  if (Date.now() - lastSoundAt < SOUND_MIN_GAP_MS) return;
  lastSoundAt = Date.now();
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();

    const now = audioCtx.currentTime;
    const notes = [
      { freq: 880, start: 0, duration: 0.11 },
      { freq: 1318.51, start: 0.1, duration: 0.18 },
    ];
    for (const { freq, start, duration } of notes) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + start);
      gain.gain.linearRampToValueAtTime(0.18, now + start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + duration);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now + start);
      osc.stop(now + start + duration + 0.02);
    }
  } catch (err) {
    console.error("playNotificationSound falhou:", err);
  }
}

async function loadQuickReplySettings() {
  try {
    quickReplySettings = await api("/chat-quick-replies");
  } catch (err) {
    console.error("loadQuickReplySettings falhou:", err);
  }
  variantBag = [];
  renderQuickReplyBar();
  messagesKey = ""; // força redesenhar: o botão de "responder com variante" pode ter mudado
  renderMessages();
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Sorteia uma variante sem repetir até passar por todas (embaralha de novo quando esvazia). */
function pickVariant() {
  const list = quickReplySettings.variants.filter(Boolean);
  if (!list.length) return "";
  if (!variantBag.length) variantBag = shuffle([...list]);
  return variantBag.pop();
}

function fillCompose(text) {
  chatInput.value = text;
  autoGrowComposeInput();
  chatInput.focus();
}

function handleQuickReplyChipClick(chip) {
  const text = chip.type === "random" ? pickVariant() : chip.value;
  if (!text) {
    notify.warning("Cadastre variantes de resposta nas configurações de ações rápidas.", { title: "Nenhuma variante cadastrada" });
    return;
  }
  if (quickReplySettings.chipsSendOnClick) {
    chatInput.value = text;
    sendMessage();
  } else {
    fillCompose(text);
  }
}

function renderQuickReplyBar() {
  const show = quickReplySettings.enabled && quickReplySettings.chips.length > 0 && !!activeChatJid;
  chatQuickReplyBar.classList.toggle("hidden", !show);
  if (!show) return;
  chatQuickReplyBar.innerHTML = quickReplySettings.chips
    .map((c) => `<button type="button" class="chat-quick-reply-chip ${c.highlight ? "is-highlight" : ""}" data-chip-id="${escapeHtml(c.id)}">${escapeHtml(c.label)}</button>`)
    .join("");
}

/** Marca a mensagem citada e já preenche (ou envia) uma variante sorteada, igual ao botão de dado do print. */
function startReplyWithVariant(message) {
  const text = pickVariant();
  if (!text) {
    notify.warning("Cadastre variantes de resposta nas configurações de ações rápidas.", { title: "Nenhuma variante cadastrada" });
    return;
  }
  startReply(message);
  chatInput.value = text;
  autoGrowComposeInput();
  if (quickReplySettings.replyVariantAlsoSends) sendMessage();
}

/* ---------- Configuração das ações rápidas (modal) ---------- */

function qrChipRowHtml(chip, index) {
  return `
    <div class="qr-chip-row" data-index="${index}">
      <input type="text" class="input qr-chip-label" value="${escapeHtml(chip.label)}" maxlength="40" placeholder="Nome do botão">
      <select class="input qr-chip-type">
        <option value="fixed" ${chip.type === "fixed" ? "selected" : ""}>Texto fixo</option>
        <option value="random" ${chip.type === "random" ? "selected" : ""}>Aleatório (variantes)</option>
      </select>
      <input type="text" class="input qr-chip-value" value="${escapeHtml(chip.value)}" maxlength="1000" placeholder="Texto que o chip digita" ${chip.type === "random" ? "disabled" : ""}>
      <label class="qr-chip-row-highlight"><input type="checkbox" class="qr-chip-highlight" ${chip.highlight ? "checked" : ""}> Destacar</label>
      <button type="button" class="icon-btn icon-btn-sm qr-chip-delete" aria-label="Remover chip">${icon("trash")}</button>
    </div>`;
}

function renderChipRows() {
  qrChipsListEl.innerHTML = editingChips.map(qrChipRowHtml).join("");
}

/** Troca qual seção aparece no card do meio (menu lateral do modal de configurações). */
function selectSettingsPanel(name) {
  settingsNavEl.querySelectorAll(".modal-settings-nav-item").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.settingsPanel === name);
  });
  quickReplyModal.querySelectorAll(".modal-settings-panel").forEach((panel) => {
    panel.classList.toggle("hidden", panel.id !== `settings-panel-${name}`);
  });
}

async function openQuickReplySettingsModal() {
  let generalSettings;
  try {
    [quickReplySettings, generalSettings] = await Promise.all([api("/chat-quick-replies"), api("/settings")]);
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível carregar as configurações" });
    return;
  }
  qrEnabledInput.checked = quickReplySettings.enabled;
  qrChipsSendInput.checked = quickReplySettings.chipsSendOnClick;
  qrVariantSendInput.checked = quickReplySettings.replyVariantAlsoSends;
  qrVariantsInput.value = quickReplySettings.variants.join("\n");
  editingChips = quickReplySettings.chips.map((c) => ({ ...c }));
  renderChipRows();
  rideAssistantEnabledInput.checked = generalSettings.rideAssistantEnabled;
  rideChargeEnabledInput.checked = generalSettings.rideAutoChargeEnabled;
  rideChargeTriggerSelect.value = generalSettings.rideChargeTrigger;
  rideChargeMessageDefault = generalSettings.defaults?.rideChargeMessage ?? "";
  rideChargeMessageInput.value = generalSettings.rideChargeMessage || rideChargeMessageDefault;
  rideVehicleDetailsInput.checked = generalSettings.rideVehicleDetailsEnabled !== false;
  rideMessageDefaults = generalSettings.defaults ?? {};
  for (const input of rideMessageInputs) {
    const key = input.dataset.rideMessage;
    input.value = generalSettings[key] || rideMessageDefaults[key] || "";
  }
  selectSettingsPanel("quick-replies");
  openModal(quickReplyModal);
}

async function saveQuickReplySettings() {
  const body = {
    enabled: qrEnabledInput.checked,
    chipsSendOnClick: qrChipsSendInput.checked,
    replyVariantAlsoSends: qrVariantSendInput.checked,
    variants: qrVariantsInput.value.split("\n").map((s) => s.trim()).filter(Boolean),
    chips: editingChips,
  };
  setBusy(qrSaveBtn, true, "Salvando…");
  try {
    [quickReplySettings] = await Promise.all([
      api("/chat-quick-replies", { method: "PUT", body }),
      api("/settings", {
        method: "PUT",
        body: {
          rideAssistantEnabled: rideAssistantEnabledInput.checked,
          rideAutoChargeEnabled: rideChargeEnabledInput.checked,
          rideChargeTrigger: rideChargeTriggerSelect.value,
          rideChargeMessage: rideChargeMessageInput.value,
          rideVehicleDetailsEnabled: rideVehicleDetailsInput.checked,
          ...Object.fromEntries(rideMessageInputs.map((input) => [input.dataset.rideMessage, input.value])),
        },
      }),
    ]);
    variantBag = [];
    renderQuickReplyBar();
    messagesKey = "";
    renderMessages();
    closeModal(quickReplyModal);
    notify.success("Configurações atualizadas.", { duration: 2000 });
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível salvar" });
  } finally {
    setBusy(qrSaveBtn, false);
  }
}

export function initChat() {
  registerContextMenuProvider(getChatContextMenuItems);
  chatListEl.addEventListener("click", handleChatListClick);
  chatArchivedList.addEventListener("click", handleChatListClick);
  chatFolderListEl.addEventListener("click", handleChatListClick);
  chatListEl.addEventListener("keydown", handleChatListKeydown);
  chatArchivedList.addEventListener("keydown", handleChatListKeydown);
  chatFolderListEl.addEventListener("keydown", handleChatListKeydown);

  chatNavRowsEl.addEventListener("click", handleNavRowsClick);
  chatNavBackBtn.addEventListener("click", showMainView);
  chatMarkAllReadBtn.addEventListener("click", markAllRead);
  chatNewFolderBtn.addEventListener("click", () => createFolderAndAdd(null));
  chatFolderViewMenuBtn.addEventListener("click", () => {
    if (!currentFolderId) return;
    const folder = folders.find((f) => f.id === currentFolderId);
    if (folder) openFolderRowMenu(chatFolderViewMenuBtn, folder);
  });

  chatListSearchInput.addEventListener("input", () => {
    chatListFilter = normalizeForSearch(chatListSearchInput.value.trim());
    if (currentFolderId) renderFolderChatList();
    else renderChatList();
  });

  chatBackBtn.addEventListener("click", closeThread);
  chatLoadMoreBtn.addEventListener("click", loadOlderMessages);

  chatMessagesListEl.addEventListener("click", (e) => {
    const retryBtn = e.target.closest(".chat-bubble-retry-media-btn");
    if (retryBtn) {
      const id = retryBtn.closest(".chat-bubble-row")?.dataset.id;
      const message = messages.find((m) => m.id === id);
      if (message) void retryMediaDownload(message);
      return;
    }

    if (e.target.closest(".chat-join-request")) return void openJoinRequestsForActiveGroup();

    if (e.target.closest('[data-action="download-media"]')) {
      const id = e.target.closest(".chat-bubble-row")?.dataset.id;
      const message = messages.find((m) => m.id === id);
      if (message) downloadMessageMedia(message);
      return;
    }

    const img = e.target.closest(".chat-bubble-image");
    if (img) {
      const message = messages.find((m) => m.id === img.closest(".chat-bubble-row")?.dataset.id);
      return openLightbox(img.src, message ? message.mediaFileName || `imagem-${message.id}` : undefined);
    }

    const senderEl = e.target.closest(".chat-bubble-sender");
    if (senderEl) {
      const jid = senderEl.dataset.jid;
      if (jid) openContactInfo({ jid, isGroup: false, presetName: pushNameFor(jid) });
      return;
    }

    const actionBtn = e.target.closest(".chat-bubble-action-btn");
    if (actionBtn) {
      const id = actionBtn.closest(".chat-bubble-row")?.dataset.id;
      const message = messages.find((m) => m.id === id);
      if (!message) return;
      if (actionBtn.dataset.action === "react") openReactionPicker(actionBtn, message);
      else if (actionBtn.dataset.action === "reply") startReply(message);
      else if (actionBtn.dataset.action === "reply-variant") startReplyWithVariant(message);
      else openMessageMenu(actionBtn, message);
    }
  });

  chatReplyCancel.addEventListener("click", cancelReply);

  chatThreadInfoBtn.addEventListener("click", () => {
    if (!activeChatJid) return;
    const chat = findChat(activeChatJid);
    const presetName = chat ? (chat.isGroup ? displayName(chat) : chat.name) : null;
    openContactInfo({ jid: activeChatJid, isGroup: !!chat?.isGroup, presetName });
  });
  chatThreadAvatarEl.addEventListener("click", (e) => {
    // Só amplia se tiver foto de verdade (não dá pra ampliar um avatar de iniciais) — sem foto,
    // deixa o clique continuar normal e abrir os dados do contato (comportamento de antes).
    const img = chatThreadAvatarEl.querySelector("img");
    if (img) {
      e.stopPropagation();
      openLightbox(img.src);
    }
  });
  bindModal(contactInfoModal, () => closeModal(contactInfoModal));
  contactInfoAvatarEl.addEventListener("click", () => {
    const img = contactInfoAvatarEl.querySelector("img");
    if (img) openLightbox(img.src);
  });

  contactInfoMediaGrid.addEventListener("click", (e) => {
    const thumb = e.target.closest(".contact-info-media-thumb[data-url]");
    if (thumb) openLightbox(thumb.dataset.url);
  });
  contactInfoGroupsList.addEventListener("click", (e) => {
    const btn = e.target.closest(".contact-info-group-item");
    if (!btn) return;
    goToPrivateChat(btn.dataset.jid);
  });

  bindModal(groupParticipantsModal, () => closeModal(groupParticipantsModal));
  groupParticipantsSearchInput.addEventListener("input", () => {
    participantsFilter = normalizeForSearch(groupParticipantsSearchInput.value.trim());
    renderParticipantsList();
  });
  groupParticipantsListEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".participant-menu-btn");
    if (!btn) return;
    const participant = currentParticipantsMeta?.participants.find((p) => p.jid === btn.dataset.jid);
    if (participant) openParticipantActionMenu(btn, participant);
  });
  groupInviteLinkBtn.addEventListener("click", () => openInviteLinkMenu(groupInviteLinkBtn));
  groupAddParticipantBtn.addEventListener("click", addParticipantToGroup);
  groupJoinRequestsBtn.addEventListener("click", openGroupJoinRequestsModal);
  bindModal(groupJoinRequestsModal, () => closeModal(groupJoinRequestsModal));
  groupJoinRequestsListEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn || !currentParticipantsGroupJid) return;
    respondJoinRequest(currentParticipantsGroupJid, btn.dataset.jid, btn.dataset.act, btn);
  });

  chatQuickReplyBar.addEventListener("click", (e) => {
    const btn = e.target.closest(".chat-quick-reply-chip");
    if (!btn) return;
    const chip = quickReplySettings.chips.find((c) => c.id === btn.dataset.chipId);
    if (chip) handleQuickReplyChipClick(chip);
  });

  document.addEventListener("mistic-config-changed", loadMisticStatus);

  chatQuickReplySettingsBtn.addEventListener("click", openQuickReplySettingsModal);
  qrSaveBtn.addEventListener("click", saveQuickReplySettings);
  settingsNavEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".modal-settings-nav-item");
    if (btn) selectSettingsPanel(btn.dataset.settingsPanel);
  });
  document.getElementById("settings-panel-ride-assistant").addEventListener("click", (e) => {
    if (e.target.closest("[data-ride-charge-reset]")) rideChargeMessageInput.value = rideChargeMessageDefault;
    const resetBtn = e.target.closest("[data-ride-message-reset]");
    if (resetBtn) {
      const key = resetBtn.dataset.rideMessageReset;
      const input = rideMessageInputs.find((i) => i.dataset.rideMessage === key);
      if (input) input.value = rideMessageDefaults[key] || "";
    }
  });
  qrAddChipBtn.addEventListener("click", () => {
    editingChips.push({ id: "", label: "", type: "fixed", value: "", highlight: false }); // id vazio: o servidor gera um de verdade ao salvar
    renderChipRows();
  });
  qrChipsListEl.addEventListener("click", (e) => {
    const delBtn = e.target.closest(".qr-chip-delete");
    if (!delBtn) return;
    const index = Number(delBtn.closest(".qr-chip-row").dataset.index);
    editingChips.splice(index, 1);
    renderChipRows();
  });
  qrChipsListEl.addEventListener("input", (e) => {
    const row = e.target.closest(".qr-chip-row");
    if (!row) return;
    const chip = editingChips[Number(row.dataset.index)];
    if (!chip) return;
    if (e.target.classList.contains("qr-chip-label")) chip.label = e.target.value;
    else if (e.target.classList.contains("qr-chip-value")) chip.value = e.target.value;
  });
  qrChipsListEl.addEventListener("change", (e) => {
    const row = e.target.closest(".qr-chip-row");
    if (!row) return;
    const chip = editingChips[Number(row.dataset.index)];
    if (!chip) return;
    if (e.target.classList.contains("qr-chip-type")) {
      chip.type = e.target.value;
      renderChipRows(); // desabilita/habilita o campo de valor
    } else if (e.target.classList.contains("qr-chip-highlight")) {
      chip.highlight = e.target.checked;
    }
  });
  bindModal(quickReplyModal, () => closeModal(quickReplyModal));

  chatStickerBtn.addEventListener("click", openChatStickerPicker);
  chatStickerGrid.addEventListener("click", (e) => {
    const btn = e.target.closest(".sticker-thumb");
    if (btn) sendStickerFromLibrary(btn.dataset.id);
  });
  bindModal(chatStickerModal, () => closeModal(chatStickerModal));

  chatAttachBtn.addEventListener("click", () => chatAttachInput.click());
  chatAttachInput.addEventListener("change", () => {
    const file = chatAttachInput.files?.[0];
    if (file) setAttachment(file);
  });
  chatAttachmentRemoveBtn.addEventListener("click", clearAttachment);

  chatInput.addEventListener("input", autoGrowComposeInput);
  chatInput.addEventListener("paste", handleComposePaste);
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      chatComposeForm.requestSubmit();
    }
  });

  chatComposeForm.addEventListener("submit", (e) => {
    e.preventDefault();
    sendMessage();
  });

  initChatListResizer();
  schedulePoll();
}
