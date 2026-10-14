import { state } from "./state.js";
import { escapeHtml } from "./utils.js";
import { icon, isModalOpen } from "./ui.js";
import { openSettingsModal } from "./settings.js";
import { openQuickReplySettingsModal } from "./chat.js";
import { selectAccount } from "./accounts.js";

/**
 * "Multi telas": mostra vários WhatsApps lado a lado na área de Conversas. Cada fração é um
 * <iframe> do próprio painel em modo embutido (?screen=<conta>), que roda scoped àquela conta e
 * estilo celular (lista → conversa com botão de voltar). Assim cada fração tem o chat completo da
 * conta, sem precisar reescrever o chat (que é singleton) pra multi-instância.
 */

const gridEl = document.getElementById("multiscreen-grid");
const chatLayoutEl = document.getElementById("chat-layout");
const tabChatBtn = document.getElementById("tab-chat");
const settingsModal = document.getElementById("settings-modal");
const quickReplyModal = document.getElementById("quick-reply-modal");

/** Contas abertas no multi telas, na ordem em que foram abertas. */
const openScreens = [];

export function isMultiScreenActive() {
  return openScreens.length > 0;
}

export function addScreen(accountId) {
  if (!accountId) return;
  if (!openScreens.includes(accountId)) openScreens.push(accountId);
  tabChatBtn?.click(); // garante que a aba Conversas está aberta
  render();
}

export function removeScreen(accountId) {
  const i = openScreens.indexOf(accountId);
  if (i === -1) return;
  openScreens.splice(i, 1);
  render();
}

function nameOf(accountId) {
  return state.accounts.find((a) => a.id === accountId)?.name || accountId;
}

function render() {
  // Some contas podem ter sido removidas do sistema: tira-as do multi telas.
  if (state.accounts.length) {
    for (let i = openScreens.length - 1; i >= 0; i--) {
      if (!state.accounts.some((a) => a.id === openScreens[i])) openScreens.splice(i, 1);
    }
  }

  const active = openScreens.length > 0;
  gridEl.classList.toggle("hidden", !active);
  if (chatLayoutEl) chatLayoutEl.classList.toggle("hidden", active);
  if (!active) {
    gridEl.innerHTML = "";
    return;
  }

  // Reconciliação: remove frações fechadas, cria as novas — SEM reparent (mover um iframe no DOM
  // o recarrega), então os iframes que já existem ficam intactos.
  for (const pane of [...gridEl.children]) {
    if (!openScreens.includes(pane.dataset.account)) pane.remove();
  }
  for (const id of openScreens) {
    let pane = gridEl.querySelector(`.multiscreen-pane[data-account="${CSS.escape(id)}"]`);
    if (!pane) {
      pane = document.createElement("div");
      pane.className = "multiscreen-pane";
      pane.dataset.account = id;
      pane.innerHTML = `
        <div class="multiscreen-pane-head">
          <span class="multiscreen-pane-name">${escapeHtml(nameOf(id))}</span>
          <button type="button" class="icon-btn icon-btn-sm multiscreen-pane-close" title="Fechar esta tela" aria-label="Fechar esta tela">${icon("x")}</button>
        </div>
        <iframe class="multiscreen-frame" src="/?screen=${encodeURIComponent(id)}" title="${escapeHtml(nameOf(id))}"></iframe>`;
      gridEl.appendChild(pane);
    } else {
      // Atualiza o nome caso tenha mudado (não recarrega o iframe)
      const nameEl = pane.querySelector(".multiscreen-pane-name");
      if (nameEl) nameEl.textContent = nameOf(id);
    }
  }
}

/** Abre o modal certo (geral/MisticPay ou ações rápidas/assistente) e diz se abriu de fato. */
async function openSettingsModalFor(which) {
  const modal = which === "zap" ? quickReplyModal : settingsModal;
  try {
    if (which === "zap") await openQuickReplySettingsModal();
    else await openSettingsModal();
  } catch {
    return false;
  }
  return isModalOpen(modal);
}

/**
 * Abre a configuração de UMA conta a partir do menu de 3 pontinhos.
 * @param {"account"|"zap"} which "account" = geral + MisticPay · "zap" = ações rápidas + assistente
 *
 * - No multi telas (conta diferente da ativa): abre **por cima**, sem sair. Aponta o painel pai pra
 *   aquela conta só enquanto o modal está aberto (as frações são iframes independentes, então isso
 *   não mexe nelas) e restaura ao fechar.
 * - Fora do multi telas: troca pra aquela conta de verdade e abre a configuração (sem "piscar"
 *   dados de uma conta na tela de outra).
 */
export async function openAccountSettings(accountId, which) {
  if (isMultiScreenActive() && accountId !== state.activeAccountId) {
    const modal = which === "zap" ? quickReplyModal : settingsModal;
    const prev = state.activeAccountId;
    state.activeAccountId = accountId;
    if (!(await openSettingsModalFor(which))) {
      state.activeAccountId = prev;
      return;
    }
    const obs = new MutationObserver(() => {
      if (modal.classList.contains("hidden")) {
        state.activeAccountId = prev;
        obs.disconnect();
      }
    });
    obs.observe(modal, { attributes: true, attributeFilter: ["class"] });
    return;
  }

  if (accountId !== state.activeAccountId) await selectAccount(accountId);
  await openSettingsModalFor(which);
}

export function initMultiScreen() {
  gridEl.addEventListener("click", (e) => {
    const closeBtn = e.target.closest(".multiscreen-pane-close");
    if (closeBtn) {
      const pane = closeBtn.closest(".multiscreen-pane");
      if (pane) removeScreen(pane.dataset.account);
    }
  });
}
