import { state, resetAccountState } from "./state.js";
import { api, accountUrl } from "./api.js";
import { escapeHtml, avatarHtml } from "./utils.js";
import {
  notify,
  confirmDialog,
  promptDialog,
  bindModal,
  openModal,
  closeModal,
  isModalOpen,
  flagInvalid,
  setBusy,
} from "./ui.js";

const ACCOUNT_KEY = "brinzy-active-account";
const DEFAULT_ACCOUNT_ID = "default";

const layoutEl = document.querySelector(".layout");
const listEl = document.getElementById("account-list");
const addBtn = document.getElementById("add-account-btn");
const manageBtn = document.getElementById("account-manage-btn");

const modal = document.getElementById("account-modal");
const modalSub = document.getElementById("account-modal-sub");
const nameInput = document.getElementById("account-name-input");
const renameBtn = document.getElementById("account-rename-btn");
const connEl = document.getElementById("account-conn");
const connTitleEl = document.getElementById("account-conn-title");
const connSubEl = document.getElementById("account-conn-sub");
const qrBox = document.getElementById("account-qr-box");
const qrFrame = qrBox.querySelector(".qr-frame");
const qrImg = document.getElementById("account-qr-img");
const logoutBtn = document.getElementById("account-logout-btn");
const removeBtn = document.getElementById("account-remove-btn");
const actionsHint = document.getElementById("account-actions-hint");

let onSwitch = async () => {};
let railSignature = "";
let modalWasConnected = null;

/* ---------- Estado de cada conta ---------- */

/** "on" = conectada e bot ligado · "paused" = conectada, bot desligado · "qr" = esperando QR Code · "offline" */
function accountState(a) {
  if (!a.connected) return a.needsQr ? "qr" : "offline";
  return a.active ? "on" : "paused";
}

const STATE_LABEL = {
  on: "Conectada · bot ligado",
  paused: "Conectada · bot desligado",
  qr: "Aguardando a leitura do QR Code",
  offline: "Desconectada",
};

export function activeAccount() {
  return state.accounts.find((a) => a.id === state.activeAccountId) ?? null;
}

function saveActive(id) {
  try {
    localStorage.setItem(ACCOUNT_KEY, id);
  } catch {
    // localStorage indisponível
  }
}

function loadSavedActive() {
  try {
    return localStorage.getItem(ACCOUNT_KEY);
  } catch {
    return null;
  }
}

function updateTitle() {
  const account = activeAccount();
  document.title = account ? `${account.name} · Brinzy` : "Brinzy · Painel de Controle";
}

/* ---------- Barra de contas ---------- */

export function renderAccountRail() {
  // Só redesenha quando algo visível mudou (evita piscar as fotos a cada leitura)
  const signature = JSON.stringify([
    state.activeAccountId,
    state.accounts.map((a) => [a.id, a.name, a.phone, accountState(a), a.guardPending]),
  ]);
  if (signature === railSignature) return;
  railSignature = signature;

  listEl.innerHTML = state.accounts
    .map((a) => {
      const st = accountState(a);
      const active = a.id === state.activeAccountId;
      const picture = a.connected ? `${accountUrl("/avatar", a.id)}?v=${encodeURIComponent(a.phone || "")}` : null;
      const label = `${a.name} — ${STATE_LABEL[st]}${a.guardPending ? ` — ${a.guardPending} conversa(s) esperando resposta` : ""}`;
      const badge = a.guardPending > 0 ? `<span class="account-badge" aria-hidden="true">${a.guardPending}</span>` : "";
      return `
      <li class="account-item ${active ? "is-active" : ""}" data-state="${st}">
        <button type="button" class="account-btn" data-id="${escapeHtml(a.id)}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}" ${active ? 'aria-current="true"' : ""}>
          ${avatarHtml(a.name, { pictureUrl: picture, size: "rail" })}
          <span class="account-dot" aria-hidden="true"></span>
          ${badge}
        </button>
      </li>`;
    })
    .join("");
}

/** Lê as contas e escolhe a ativa (a última usada, se ainda existir). Chamado uma vez ao abrir o painel. */
export async function loadAccounts() {
  const { accounts } = await api("/accounts");
  state.accounts = accounts;
  const saved = loadSavedActive();
  state.activeAccountId = (accounts.find((a) => a.id === saved) ?? accounts[0])?.id ?? null;
  renderAccountRail();
  updateTitle();
}

export async function refreshAccounts() {
  try {
    const { accounts } = await api("/accounts");
    state.accounts = accounts;

    // A conta da tela sumiu (removida em outra aba) ou ainda não havia nenhuma: vai pra primeira
    if (accounts.length > 0 && !accounts.some((a) => a.id === state.activeAccountId)) {
      state.activeAccountId = null;
      await selectAccount(accounts[0].id);
    }

    renderAccountRail();
    updateTitle();
    if (isModalOpen(modal)) renderAccountModal();
  } catch (err) {
    console.error("refreshAccounts falhou:", err);
  }
}

export async function selectAccount(id) {
  if (!id || id === state.activeAccountId) return;

  state.activeAccountId = id;
  saveActive(id);
  resetAccountState();
  if (isModalOpen(modal)) closeModal(modal);

  renderAccountRail();
  updateTitle();

  layoutEl.classList.add("is-switching");
  try {
    await onSwitch();
  } finally {
    layoutEl.classList.remove("is-switching");
  }
}

/* ---------- Adicionar / gerenciar ---------- */

function nextAccountName() {
  const names = new Set(state.accounts.map((a) => a.name.toLowerCase()));
  let n = state.accounts.length + 1;
  while (names.has(`whatsapp ${n}`)) n++;
  return `WhatsApp ${n}`;
}

async function addAccount() {
  const name = await promptDialog({
    title: "Adicionar WhatsApp",
    message: "Cada WhatsApp tem suas próprias regras, campanhas, grupos, métricas e configurações.",
    label: "Nome da conta",
    value: nextAccountName(),
    confirmText: "Adicionar",
  });
  if (!name) return;

  try {
    const { account } = await api("/accounts", { method: "POST", body: { name } });
    await refreshAccounts();
    await selectAccount(account.id);
    openAccountModal();
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível adicionar a conta" });
  }
}

/** Atualiza a imagem do QR Code (ele troca a cada ~20 s). Só troca a imagem quando a nova já carregou. */
function refreshQr() {
  const id = state.activeAccountId;
  const probe = new Image();
  probe.onload = () => {
    if (id !== state.activeAccountId) return;
    qrImg.src = probe.src;
    qrFrame.classList.add("is-ready");
  };
  probe.src = `${accountUrl("/qr", id)}?t=${Date.now()}`;
}

function renderAccountModal() {
  const account = activeAccount();
  if (!account) return;

  const st = accountState(account);
  modalSub.textContent = account.phone ? `Número conectado: +${account.phone}` : "Conexão, nome e QR Code desta conta.";

  connEl.dataset.state = st === "qr" ? "qr" : account.connected ? "connected" : "disconnected";
  connTitleEl.textContent = STATE_LABEL[st];
  connSubEl.textContent = account.connected
    ? "Pronta para responder e enviar mensagens."
    : st === "qr"
      ? "Leia o código abaixo com o celular."
      : "O bot tenta reconectar sozinho.";

  qrBox.classList.toggle("hidden", !account.needsQr);
  if (account.needsQr) {
    refreshQr();
  } else {
    qrFrame.classList.remove("is-ready");
    qrImg.removeAttribute("src");
  }

  if (modalWasConnected === false && account.connected) {
    notify.success(`${account.name} está conectado e pronto para uso.`, { title: "WhatsApp conectado" });
  }
  modalWasConnected = account.connected;

  const isDefault = account.id === DEFAULT_ACCOUNT_ID;
  removeBtn.classList.toggle("hidden", isDefault);
  actionsHint.textContent = isDefault
    ? "Esta é a conta original: ela não pode ser removida, mas você pode trocar o número dela desconectando."
    : "Desconectar mantém as regras, campanhas e métricas. Remover apaga tudo desta conta, inclusive a sessão do WhatsApp.";
}

export function openAccountModal() {
  const account = activeAccount();
  if (!account) return;

  nameInput.value = account.name;
  nameInput.classList.remove("is-invalid");
  modalWasConnected = null;
  qrFrame.classList.remove("is-ready");
  qrImg.removeAttribute("src");
  renderAccountModal();
  openModal(modal);
}

async function renameAccount() {
  const account = activeAccount();
  if (!account) return;

  const name = nameInput.value.trim();
  if (!name) return flagInvalid(nameInput, "Informe um nome para a conta.");
  if (name === account.name) return;

  setBusy(renameBtn, true, "Salvando…");
  try {
    await api(`/accounts/${encodeURIComponent(account.id)}`, { method: "PUT", body: { name } });
    await refreshAccounts();
    notify.success(`A conta agora se chama “${name}”.`, { title: "Conta renomeada" });
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível renomear" });
  } finally {
    setBusy(renameBtn, false);
  }
}

async function logoutAccount() {
  const account = activeAccount();
  if (!account) return;

  const confirmed = await confirmDialog({
    title: `Desconectar “${account.name}”?`,
    message: "O aparelho é desvinculado do WhatsApp e será preciso ler um novo QR Code (dá para conectar outro número). As regras, campanhas e métricas desta conta continuam guardadas.",
    confirmText: "Desconectar",
    tone: "danger",
  });
  if (!confirmed) return;

  setBusy(logoutBtn, true, "Desconectando…");
  try {
    await api(`/accounts/${encodeURIComponent(account.id)}/logout`, { method: "POST" });
    notify.info("Leia o novo QR Code para conectar um número.", { title: "Conta desconectada" });
    await refreshAccounts();
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível desconectar" });
  } finally {
    setBusy(logoutBtn, false);
  }
}

async function removeAccount() {
  const account = activeAccount();
  if (!account || account.id === DEFAULT_ACCOUNT_ID) return;

  const confirmed = await confirmDialog({
    title: `Remover “${account.name}”?`,
    message: "Isso desvincula o aparelho e apaga as regras, campanhas, métricas e configurações desta conta. Essa ação não pode ser desfeita.",
    confirmText: "Remover conta",
    tone: "danger",
  });
  if (!confirmed) return;

  setBusy(removeBtn, true, "Removendo…");
  try {
    await api(`/accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" });
    closeModal(modal);
    notify.success(`“${account.name}” foi removida.`, { title: "Conta removida" });
    await refreshAccounts();
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível remover a conta" });
  } finally {
    setBusy(removeBtn, false);
  }
}

/** `switchHandler` recarrega a tela toda para a conta recém-selecionada. */
export function initAccounts(switchHandler) {
  onSwitch = switchHandler;

  listEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".account-btn");
    if (btn) selectAccount(btn.dataset.id);
  });
  addBtn.addEventListener("click", addAccount);
  manageBtn.addEventListener("click", openAccountModal);

  renameBtn.addEventListener("click", renameAccount);
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      renameAccount();
    }
  });
  logoutBtn.addEventListener("click", logoutAccount);
  removeBtn.addEventListener("click", removeAccount);
  bindModal(modal, () => closeModal(modal));
}
