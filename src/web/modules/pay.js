import { api } from "./api.js";
import { escapeHtml, formatBRL, formatCpf, formatCurrency, formatDateTime, formatPhone, firstName, relativeTime, renderTemplate, whatsappHtml } from "./utils.js";
import { icon, notify, confirmDialog, bindModal, openModal, closeModal, isModalOpen, flagInvalid, setBusy, emptyState } from "./ui.js";

const FAB_POSITION_KEY = "brinzy-pay-fab";
const OTHER_NUMBER = "__other__";
const RANDOM_CLIENT = "__random__";
const DRAG_THRESHOLD_PX = 5;
const MAX_CONTACTS = 30;

const fab = document.getElementById("pay-fab");
const fabBadge = document.getElementById("pay-fab-badge");

const modal = document.getElementById("pay-modal");
const subEl = document.getElementById("pay-modal-sub");
const balanceEl = document.getElementById("pay-balance");
const blockedEl = document.getElementById("pay-blocked");
const userNameEl = document.getElementById("pay-user-name");
const userMetaEl = document.getElementById("pay-user-meta");
const refreshBtn = document.getElementById("pay-refresh");
const accountErrorEl = document.getElementById("pay-account-error");
const accountErrorTextEl = document.getElementById("pay-account-error-text");
const pendingCountEl = document.getElementById("pay-pending-count");
const submitBtn = document.getElementById("pay-submit");
const copyBtn = document.getElementById("pay-copy");
const openSettingsBtn = document.getElementById("pay-open-settings");

const contactSelect = document.getElementById("pay-contact");
const contactHint = document.getElementById("pay-contact-hint");
const phoneWrap = document.getElementById("pay-phone-wrap");
const phoneInput = document.getElementById("pay-phone");
const amountInput = document.getElementById("pay-amount");
const descriptionInput = document.getElementById("pay-description");
const payerNameInput = document.getElementById("pay-payer-name");
const randomNameBtn = document.getElementById("pay-random-name");
const payerDocumentInput = document.getElementById("pay-payer-document");
const documentHint = document.getElementById("pay-document-hint");
const saveDocumentWrap = document.getElementById("pay-save-document-wrap");
const saveDocumentInput = document.getElementById("pay-save-document");
const previewTitle = document.getElementById("pay-preview-title");
const previewCharge = document.getElementById("pay-preview-charge");
const previewCode = document.getElementById("pay-preview-code");
const previewQr = document.getElementById("pay-preview-qr");

const withdrawAmountInput = document.getElementById("withdraw-amount");
const withdrawBalanceHint = document.getElementById("withdraw-balance-hint");
const withdrawKeyTypeSelect = document.getElementById("withdraw-key-type");
const withdrawKeyInput = document.getElementById("withdraw-key");
const withdrawDescriptionInput = document.getElementById("withdraw-description");

const historyEl = document.getElementById("pay-history");
const statementEl = document.getElementById("pay-statement");
const statementPrevBtn = document.getElementById("pay-statement-prev");
const statementNextBtn = document.getElementById("pay-statement-next");
const statementPageEl = document.getElementById("pay-statement-page");

const PANELS = ["charge", "withdraw", "history", "statement"];
const KEY_PLACEHOLDERS = {
  CPF: "000.000.000-00",
  CNPJ: "00.000.000/0000-00",
  EMAIL: "nome@email.com",
  TELEFONE: "(11) 99999-9999",
  CHAVE_ALEATORIA: "123e4567-e89b-12d3-a456-426614174000",
};
const KEY_TYPE_LABELS = { CPF: "CPF", CNPJ: "CNPJ", EMAIL: "e-mail", TELEFONE: "telefone", CHAVE_ALEATORIA: "chave aleatória" };
const STATUS_BADGES = {
  pending: ["badge-warning", "Aguardando"],
  paid: ["badge-success", "Pago"],
  failed: ["badge-danger", "Falhou"],
  canceled: ["badge-danger", "Cancelada"],
  expired: ["badge-muted", "Sem confirmação"],
};

let config = null; // /mistic/config
let conversations = []; // /conversations
let charges = []; // /mistic/charges
let info = null; // /mistic/account
let knownStatuses = null; // id → status, pra avisar quando um pagamento cai
let tab = "charge";
let statementPage = 1;
let statementTotalPages = 1;
let statementLoaded = false;
// O botão solto na tela (fora do navegador) está rodando? Se sim, ele cuida do botão e o da página fica escondido
let overlayRunning = false;
// Você escolheu o cliente à mão? Senão o formulário acompanha a conversa mais recente
let contactTouched = false;
// "Cliente aleatório" escolhido: o nome e a descrição preenchidos por nós (não por você) saem de novo ao trocar de cliente
let randomActive = false;
let autoName = null;
let autoDescription = null;
// Janela de pagamento aberta pelo botão solto na tela: só o modal, e fechá-lo fecha a janela
let standalone = false;
// O que já está desenhado: a tela só é refeita quando muda (senão o dropdown aberto fecharia e cliques se perderiam)
let contactsHtml = "";
let historyHtml = "";
// Saldo da conta MisticPay: relido sozinho enquanto o modal está aberto (e logo depois de um pagamento ou saque concluído)
const INFO_REFRESH_MS = 10_000;
const INFO_AFTER_PAYMENT_MS = 8_000; // a MisticPay pode levar alguns segundos para refletir o pagamento no saldo
let infoAt = 0;
let infoLoading = false;

/* ---------- Dados ---------- */

/** Esquece tudo da conta anterior (chamado ao trocar de conta). */
export function resetPay() {
  config = null;
  conversations = [];
  charges = [];
  info = null;
  infoAt = 0;
  infoLoading = false;
  knownStatuses = null;
  statementLoaded = false;
  randomActive = false;
  autoName = null;
  autoDescription = null;
  if (isModalOpen(modal)) closeModal(modal);
  paintFab();
}

function displayName(c) {
  return c.name || formatPhone(c.phone) || "cliente";
}

function activeConversations() {
  return conversations.filter((c) => c.active);
}

/** Avisa quando um pagamento (ou saque) muda de estado desde a última leitura. */
function detectChanges(list) {
  if (knownStatuses) {
    for (const c of list) {
      const before = knownStatuses.get(c.id);
      if (before !== "pending" || c.status === "pending") continue;
      const value = formatBRL(c.amountCents / 100);
      if (c.kind === "charge" && c.status === "paid") {
        notify.success(`${c.name || c.payerName || "O cliente"} pagou ${value}.`, { title: "Pagamento recebido", duration: 9000 });
        balanceChanged();
        // As métricas (corrida fechada e valor) já foram preenchidas no servidor: pede pra tela relê-las agora
        document.dispatchEvent(new CustomEvent("mistic-payment-confirmed", { detail: { chargeId: c.id } }));
      } else if (c.kind === "withdraw" && c.status === "paid") {
        notify.success(`O saque de ${value} foi concluído.`, { title: "Saque concluído", duration: 7000 });
        balanceChanged();
      } else if (c.status === "failed" || c.status === "canceled") {
        notify.warning(`${c.kind === "withdraw" ? "O saque" : "A cobrança"} de ${value} não foi concluído (${STATUS_BADGES[c.status][1].toLowerCase()}).`, {
          title: c.kind === "withdraw" ? "Saque não concluído" : "Cobrança não concluída",
        });
      }
    }
  }
  knownStatuses = new Map(list.map((c) => [c.id, c.status]));
}

/** O saldo mudou (pagamento ou saque): relê agora e de novo daqui a pouco, quando a MisticPay já refletiu. */
function balanceChanged() {
  infoAt = 0;
  setTimeout(() => (infoAt = 0), INFO_AFTER_PAYMENT_MS);
}

/** Lê configuração, conversas e cobranças (chamado a cada poucos segundos). */
export async function refreshPay() {
  try {
    const [cfg, convs, overlay] = await Promise.all([api("/mistic/config"), api("/conversations"), api("/overlay/status")]);
    config = cfg;
    conversations = convs.conversations;
    overlayRunning = overlay.running;

    if (cfg.configured) {
      const { charges: list } = await api("/mistic/charges");
      detectChanges(list);
      charges = list;
    } else {
      charges = [];
      knownStatuses = null;
    }

    paintFab();
    if (isModalOpen(modal)) {
      renderContacts();
      renderHistory();
      updatePreview();
      updateDocumentHint();
      if (Date.now() - infoAt >= INFO_REFRESH_MS) void loadAccountInfo({ silent: true });
    }
  } catch (err) {
    console.error("refreshPay falhou:", err);
  }
}

/* ---------- Botão flutuante ---------- */

function pendingCharges() {
  return charges.filter((c) => c.status === "pending");
}

function paintFab() {
  const active = activeConversations();
  // O botão da página só aparece se você preferiu ele, ou se o botão solto na tela não pôde iniciar
  const wantedHere = config?.floatWhere === "panel" || !overlayRunning;
  const visible = !!config?.configured && wantedHere && (config.floatMode === "always" || active.length > 0);
  fab.classList.toggle("hidden", !visible);
  if (!visible) return;

  const current = active[0];
  // Só o ícone do bot: o cliente aparece só na dica ao passar o mouse
  fab.title = current ? `Cobrar ${displayName(current)} (${formatPhone(current.phone) || "número oculto"}) pela MisticPay` : "Abrir a MisticPay";
  fab.setAttribute("aria-label", fab.title);

  const pending = pendingCharges().length;
  fabBadge.textContent = String(pending);
  fabBadge.classList.toggle("hidden", pending === 0);
  clampFab();
}

function fabSize() {
  const rect = fab.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

function placeFab(x, y) {
  const { width, height } = fabSize();
  const left = Math.min(Math.max(8, x), Math.max(8, window.innerWidth - width - 8));
  const top = Math.min(Math.max(8, y), Math.max(8, window.innerHeight - height - 8));
  fab.style.left = `${left}px`;
  fab.style.top = `${top}px`;
  fab.style.right = "auto";
  fab.style.bottom = "auto";
  return { x: left, y: top };
}

/** Mantém o botão dentro da tela quando a janela muda de tamanho. */
function clampFab() {
  if (fab.classList.contains("hidden") || !fab.style.left) return;
  placeFab(parseFloat(fab.style.left), parseFloat(fab.style.top));
}

function saveFabPosition() {
  try {
    localStorage.setItem(FAB_POSITION_KEY, JSON.stringify({ x: parseFloat(fab.style.left), y: parseFloat(fab.style.top) }));
  } catch {
    // localStorage indisponível
  }
}

function restoreFabPosition() {
  try {
    const saved = JSON.parse(localStorage.getItem(FAB_POSITION_KEY) || "null");
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      fab.style.left = `${saved.x}px`;
      fab.style.top = `${saved.y}px`;
      fab.style.right = "auto";
      fab.style.bottom = "auto";
    }
  } catch {
    // posição salva inválida: fica no canto padrão
  }
}

function initFabDrag() {
  restoreFabPosition();

  let drag = null;
  let justDragged = false;

  fab.addEventListener("pointerdown", (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    const rect = fab.getBoundingClientRect();
    drag = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, originX: rect.left, originY: rect.top, moved: false };
    try {
      fab.setPointerCapture(e.pointerId);
    } catch {
      // sem captura o arrasto ainda funciona enquanto o cursor estiver sobre o botão
    }
  });

  fab.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    fab.classList.add("is-dragging");
    placeFab(drag.originX + dx, drag.originY + dy);
  });

  const stop = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    try {
      if (fab.hasPointerCapture(e.pointerId)) fab.releasePointerCapture(e.pointerId);
    } catch {
      // já tinha sido liberado
    }
    fab.classList.remove("is-dragging");
    if (drag.moved) {
      saveFabPosition();
      justDragged = true; // o "click" que vem logo depois de soltar não abre o modal
      setTimeout(() => (justDragged = false), 0);
    }
    drag = null;
  };
  fab.addEventListener("pointerup", stop);
  fab.addEventListener("pointercancel", stop);

  fab.addEventListener("click", (e) => {
    if (justDragged) return e.preventDefault();
    openPayModal();
  });

  window.addEventListener("resize", clampFab);
}

/* ---------- Conta MisticPay (saldo) ---------- */

function paintInfo() {
  if (!info) {
    balanceEl.textContent = "—";
    blockedEl.textContent = "—";
    userNameEl.textContent = "Conta MisticPay";
    userMetaEl.textContent = "";
    withdrawBalanceHint.textContent = "";
    return;
  }

  balanceEl.textContent = formatCurrency(info.availableBalance);
  blockedEl.textContent = formatCurrency(info.blockedBalance);
  userNameEl.textContent = info.name || "Conta MisticPay";
  const flags = [info.accountVerified ? "conta verificada" : "conta NÃO verificada", info.documentVerified ? "documento verificado" : "documento NÃO verificado"];
  userMetaEl.textContent = [info.email, info.document, ...flags].filter(Boolean).join(" · ");
  withdrawBalanceHint.textContent = `Disponível para saque: ${formatCurrency(info.availableBalance)}`;

  if (info.withdrawBlocked) showAccountError("Os saques estão bloqueados nesta conta MisticPay. Fale com o suporte deles.");
}

function showAccountError(message) {
  accountErrorTextEl.textContent = message;
  accountErrorEl.classList.toggle("hidden", !message);
}

/**
 * Lê o saldo e os dados da conta MisticPay. `silent` (leitura automática): sem girar o botão e, se falhar,
 * mantém o último valor em vez de apagá-lo (só avisa o erro se ainda não havia nada para mostrar).
 */
async function loadAccountInfo({ silent = false } = {}) {
  if (infoLoading && silent) return; // uma leitura já está a caminho; o botão "atualizar" sempre lê de novo
  infoLoading = true;
  if (!silent) {
    setBusy(refreshBtn, true);
    showAccountError("");
  }
  try {
    ({ info } = await api("/mistic/account"));
    infoAt = Date.now();
    if (silent) showAccountError("");
  } catch (err) {
    infoAt = Date.now(); // não insiste a cada 3 segundos se a MisticPay estiver com problema
    if (!silent) info = null;
    if (!silent || !info) showAccountError(err.message);
  } finally {
    infoLoading = false;
    if (!silent) setBusy(refreshBtn, false);
    paintInfo();
  }
}

/* ---------- Cobrar ---------- */

function selectedConversation() {
  return conversations.find((c) => c.chatJid === contactSelect.value) ?? null;
}

function contactLabel(c) {
  const phone = formatPhone(c.phone) || "número oculto pelo WhatsApp";
  return `${displayName(c)} · ${phone}${c.active ? " · em conversa" : ""}`;
}

function renderContacts() {
  const previous = contactSelect.value;
  const list = conversations.slice(0, MAX_CONTACTS);
  const options = list.map((c) => `<option value="${escapeHtml(c.chatJid)}">${escapeHtml(contactLabel(c))}</option>`);
  options.push(`<option value="${OTHER_NUMBER}">Outro número…</option>`);
  options.push(`<option value="${RANDOM_CLIENT}">🎲 Cliente aleatório (sem WhatsApp)</option>`);
  const html = options.join("");
  const preferred = (activeConversations()[0] ?? list[0])?.chatJid ?? OTHER_NUMBER;
  const has = (value) => [...contactSelect.options].some((o) => o.value === value);

  if (html !== contactsHtml) {
    contactsHtml = html;
    contactSelect.innerHTML = html;
    contactSelect.value = previous && has(previous) ? previous : preferred;
  }

  // Sem ter escolhido à mão, acompanha a conversa mais recente (a janela pode ficar aberta enquanto você troca de conversa)
  if (!contactTouched && has(preferred) && contactSelect.value !== preferred) contactSelect.value = preferred;

  applyContactChoice();
  void syncRandomMode(); // o valor pode ter mudado sem você mexer (ex.: voltou a acompanhar a conversa mais recente)
}

function isRandomClient() {
  return contactSelect.value === RANDOM_CLIENT;
}

function applyContactChoice() {
  const other = contactSelect.value === OTHER_NUMBER;
  const random = isRandomClient();
  phoneWrap.classList.toggle("hidden", !other);
  randomNameBtn.classList.toggle("hidden", !random);

  const c = selectedConversation();
  if (random) {
    contactHint.textContent = "Sem número: a cobrança é criada com um nome sorteado e você copia o texto para colar no WhatsApp onde atende.";
  } else if (c) {
    contactHint.textContent = `${c.lastFrom === "client" ? "O cliente escreveu" : "Você escreveu"} ${relativeTime(c.lastActivityAt)}.`;
    if (!payerNameInput.dataset.touched) payerNameInput.placeholder = c.name ? `Usa "${c.name}"` : "Nome do pagador";
  } else {
    contactHint.textContent = conversations.length ? "Digite o número de quem vai pagar." : "Nenhuma conversa recente — informe o número do cliente.";
  }
  paintSubmit();
}

/** Sorteia (no servidor) um nome de pessoa para o pagador. */
async function rollRandomName() {
  randomNameBtn.disabled = true;
  try {
    const { name } = await api("/mistic/random-name");
    if (!isRandomClient()) return; // você já trocou de cliente enquanto sorteava
    payerNameInput.value = name;
    autoName = name;
    updatePreview();
  } catch {
    // sem o nome aqui, o servidor sorteia um na hora de cobrar
  } finally {
    randomNameBtn.disabled = false;
  }
}

/** Entrou ou saiu de "Cliente aleatório": preenche (ou desfaz) o nome sorteado e a descrição padrão. */
async function syncRandomMode() {
  const random = isRandomClient();
  if (random === randomActive) return;
  randomActive = random;

  if (random) {
    if (!descriptionInput.value.trim() && config?.defaultDescription) {
      descriptionInput.value = config.defaultDescription;
      autoDescription = descriptionInput.value;
    }
    if (!payerNameInput.value.trim()) await rollRandomName();
  } else {
    // só desfaz o que nós preenchemos; o que você escreveu fica
    if (autoName !== null && payerNameInput.value === autoName) payerNameInput.value = "";
    if (autoDescription !== null && descriptionInput.value === autoDescription) descriptionInput.value = "";
    autoName = null;
    autoDescription = null;
  }
  updatePreview();
}

function updateDocumentHint() {
  const saved = config?.defaultPayerDocument ?? "";
  const typed = payerDocumentInput.value.replace(/\D/g, "");
  // Só oferece "usar em todas" quando o CPF digitado é novo (diferente do que já está salvo)
  saveDocumentWrap.classList.toggle("hidden", !typed || typed === saved);
  documentHint.textContent = saved
    ? `Em branco: usa o CPF padrão salvo (${formatCpf(saved).replace(/^\d{3}\.\d{3}/, "•••.•••")}).`
    : "A MisticPay exige um CPF em toda cobrança. Informe um agora e marque a caixa: fica salvo e você não digita mais.";
}

/** Mostra como as mensagens vão chegar ao cliente (ou, em "Cliente aleatório", o texto que vai ser copiado). */
function updatePreview() {
  if (!config) return;
  const random = isRandomClient();
  const c = selectedConversation();
  const amount = Number(amountInput.value);
  const values = {
    valor: formatBRL(amount > 0 ? amount : 0),
    nome: firstName(c?.name) || firstName(payerNameInput.value) || "cliente",
    descricao: descriptionInput.value.trim(),
    numero: c?.phone ?? "",
  };

  if (random) {
    const pix = "00020126…";
    const text = renderTemplate(config.copyMessage || config.defaults.copyMessage, { ...values, pix });
    previewTitle.textContent = "Texto que será copiado";
    previewCharge.innerHTML = whatsappHtml(text.includes(pix) ? text : `${text}\n\n${pix}`);
  } else {
    const messages = {
      chargeMessage: config.chargeMessage || config.defaults.chargeMessage,
      qrCaption: config.qrCaption || config.defaults.qrCaption,
    };
    previewTitle.textContent = "O cliente vai receber";
    previewCharge.innerHTML = whatsappHtml(renderTemplate(messages.chargeMessage, values));
    previewQr.innerHTML = whatsappHtml(renderTemplate(messages.qrCaption, values));
    previewQr.classList.toggle("is-off", !config.sendQr);
  }
  previewCode.classList.toggle("hidden", random);
  previewQr.classList.toggle("hidden", random);
}

/**
 * `mode`: "send" = cria e manda ao cliente pelo WhatsApp do bot · "copy" = cria e só copia o texto para
 * você colar onde atende. "Cliente aleatório" (sem número) é sempre "copy".
 */
async function submitCharge(mode = "send") {
  const choice = contactSelect.value;
  const random = choice === RANDOM_CLIENT;
  const copyOnly = random || mode === "copy";
  const button = copyOnly ? copyBtn : submitBtn;
  const amount = Number(amountInput.value);
  const body = {
    amount,
    description: descriptionInput.value.trim(),
    payerName: payerNameInput.value.trim() || undefined,
    payerDocument: payerDocumentInput.value.trim() || undefined,
  };

  if (random) {
    body.random = true;
  } else if (choice === OTHER_NUMBER) {
    const phone = phoneInput.value.trim();
    if (!phone) return flagInvalid(phoneInput, "Informe o número do cliente.");
    body.phone = phone;
  } else if (choice) {
    body.chatJid = choice;
  } else {
    return notify.warning("Escolha o cliente ou informe o número dele.", { title: "Sem cliente" });
  }
  if (copyOnly) body.send = false;
  if (!(amount > 0)) return flagInvalid(amountInput, "Informe o valor da cobrança.");
  if (!body.payerDocument && !config?.defaultPayerDocument) {
    return flagInvalid(payerDocumentInput, "A MisticPay exige um CPF em toda cobrança. Informe um (marque “usar em todas” para não digitar de novo).");
  }
  const saveAsDefault = !!body.payerDocument && saveDocumentInput.checked;

  const who = random ? body.payerName || "cliente aleatório" : selectedConversation() ? displayName(selectedConversation()) : formatPhone(body.phone) || body.phone;
  setBusy(button, true, copyOnly ? "Criando…" : "Enviando…");
  try {
    const { charge, text } = await api("/mistic/charges", { method: "POST", body });
    // O CPF já passou na validação e a cobrança saiu: guarda como padrão para as próximas
    if (saveAsDefault) {
      await api("/mistic/config", { method: "PUT", body: { defaultPayerDocument: body.payerDocument } }).catch((err) =>
        notify.warning(`A cobrança saiu, mas não consegui salvar o CPF como padrão: ${err.message}`, { title: "CPF não salvo" })
      );
    }

    if (copyOnly) {
      if (text && (await copyToClipboard(text))) {
        notify.success(`Cobrança de ${formatBRL(amount)} (${who}) criada e copiada: é só colar no WhatsApp onde você atende. Aviso aqui quando o pagamento cair.`, {
          title: "Cobrança copiada",
          duration: 8000,
        });
      } else {
        notify.warning(`A cobrança de ${formatBRL(amount)} foi criada, mas o navegador não deixou copiar sozinho. Use “Copiar cobrança” na lista de Cobranças.`, {
          title: "Cobrança criada",
          duration: 12000,
        });
      }
    } else if (charge.sendError) {
      notify.warning(`A cobrança de ${formatBRL(amount)} foi criada, mas não chegou ao cliente: ${charge.sendError} Use “Reenviar” em Cobranças.`, {
        title: "Cobrança criada, envio falhou",
        duration: 12000,
      });
    } else {
      notify.success(`${formatBRL(amount)} enviado para ${who}: mensagem, PIX copia e cola${config.sendQr ? " e QR Code" : ""}. Aviso quando o pagamento cair.`, {
        title: "Cobrança enviada",
        duration: 7000,
      });
    }

    amountInput.value = "";
    payerDocumentInput.value = "";
    if (random) {
      // Segue em "Cliente aleatório" para a próxima: outro nome e a descrição padrão de novo
      payerNameInput.value = "";
      autoName = null;
      descriptionInput.value = config.defaultDescription || "";
      autoDescription = descriptionInput.value || null;
      void rollRandomName();
    } else {
      descriptionInput.value = "";
      contactTouched = false;
    }
    updatePreview();
    await refreshPay();
    updateDocumentHint();
    setTab("history");
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível cobrar" });
  } finally {
    setBusy(button, false);
    paintSubmit();
  }
}

/* ---------- Sacar ---------- */

async function submitWithdraw() {
  const amount = Number(withdrawAmountInput.value);
  const pixKeyType = withdrawKeyTypeSelect.value;
  const pixKey = withdrawKeyInput.value.trim();
  const description = withdrawDescriptionInput.value.trim();

  if (!(amount > 0)) return flagInvalid(withdrawAmountInput, "Informe o valor do saque.");
  if (!pixKey) return flagInvalid(withdrawKeyInput, "Informe a chave PIX que vai receber.");

  const confirmed = await confirmDialog({
    title: `Sacar ${formatBRL(amount)}?`,
    message: `Chave PIX (${KEY_TYPE_LABELS[pixKeyType]}): ${pixKey}\nO valor sai do seu saldo na MisticPay e não pode ser desfeito.`,
    confirmText: "Confirmar saque",
    tone: "danger",
  });
  if (!confirmed) return;

  setBusy(submitBtn, true, "Sacando…");
  try {
    await api("/mistic/withdraw", { method: "POST", body: { amount, pixKeyType, pixKey, description } });
    notify.success(`O saque de ${formatBRL(amount)} entrou na fila da MisticPay. Aviso quando for concluído.`, { title: "Saque pedido", duration: 7000 });
    withdrawAmountInput.value = "";
    withdrawKeyInput.value = "";
    withdrawDescriptionInput.value = "";
    await Promise.all([refreshPay(), loadAccountInfo()]);
    setTab("history");
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível sacar" });
  } finally {
    setBusy(submitBtn, false);
    paintSubmit();
  }
}

/* ---------- Cobranças e saques ---------- */

function renderHistory() {
  const pending = pendingCharges().length;
  pendingCountEl.textContent = pending ? `(${pending})` : "";

  const html = historyMarkup();
  if (html === historyHtml) return;
  historyHtml = html;
  historyEl.innerHTML = html;
}

function historyMarkup() {
  if (charges.length === 0) {
    return emptyState({
      iconName: "inbox",
      title: "Nenhuma cobrança ainda",
      text: "As cobranças e saques feitos por aqui aparecem nesta lista, com o estado de cada um.",
    });
  }

  return charges
    .map((c) => {
      const [badgeClass, badgeText] = STATUS_BADGES[c.status] ?? STATUS_BADGES.pending;
      const isWithdraw = c.kind === "withdraw";
      const who = isWithdraw ? `chave ${escapeHtml(KEY_TYPE_LABELS[c.pixKeyType] ?? "PIX")} ${escapeHtml(c.pixKeyMasked ?? "")}` : escapeHtml(c.name || c.payerName || formatPhone(c.phone) || "cliente");
      const iconClass = c.status === "paid" ? "is-paid" : c.status === "failed" || c.status === "canceled" ? "is-bad" : "";
      const when = c.paidAt ? `pago ${relativeTime(c.paidAt)}` : `criada ${relativeTime(c.createdAt)}`;
      const noWhatsapp = !isWithdraw && !c.chatJid;
      const meta = [c.description ? escapeHtml(c.description) : "", noWhatsapp ? "só copiar (sem WhatsApp)" : "", when].filter(Boolean).join(" · ");

      const actions = [];
      if (c.status === "pending") {
        actions.push(`<button type="button" class="btn btn-secondary btn-sm" data-act="check" data-id="${c.id}">${icon("refresh")} Verificar</button>`);
        if (!isWithdraw) {
          if (!noWhatsapp) {
            actions.push(`<button type="button" class="btn btn-ghost btn-sm" data-act="resend" data-id="${c.id}">${icon("send")} Reenviar ao cliente</button>`);
          }
          actions.push(`<button type="button" class="btn btn-ghost btn-sm" data-act="copytext" data-id="${c.id}">${icon("copy")} Copiar cobrança</button>`);
          actions.push(`<button type="button" class="btn btn-ghost btn-sm" data-act="copy" data-id="${c.id}">${icon("copy")} Copiar PIX</button>`);
        }
      }
      // Saques não se apagam daqui: o registro deles é o comprovante do que saiu da conta
      if (!isWithdraw) {
        actions.push(`<button type="button" class="btn btn-ghost btn-sm charge-delete" data-act="delete" data-id="${c.id}">${icon("trash")} Excluir</button>`);
      }

      return `
      <li class="stack-item charge-item" data-id="${c.id}">
        <div class="stack-main">
          <span class="charge-icon ${iconClass}">${icon(isWithdraw ? "upload" : "send")}</span>
          <div class="stack-text" style="gap:3px">
            <div class="charge-title">
              <span class="amount">${formatBRL(c.amountCents / 100)}</span>
              <span>${isWithdraw ? "Saque" : "Cobrança"} · ${who}</span>
              <span class="badge ${badgeClass}">${badgeText}</span>
            </div>
            <div class="charge-meta">${meta}</div>
            ${c.sendError ? `<div class="charge-error">Não chegou ao cliente: ${escapeHtml(c.sendError)}</div>` : ""}
            ${actions.length ? `<div class="charge-actions">${actions.join("")}</div>` : ""}
          </div>
        </div>
      </li>`;
    })
    .join("");
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

async function onHistoryClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const charge = charges.find((c) => c.id === btn.dataset.id);
  if (!charge) return;

  if (btn.dataset.act === "copy") {
    const ok = charge.copyPaste && (await copyToClipboard(charge.copyPaste));
    if (ok) notify.success("O PIX copia e cola foi copiado.", { title: "Copiado", duration: 2000 });
    else notify.error("Não foi possível copiar. Selecione e copie à mão.");
    return;
  }

  if (btn.dataset.act === "copytext") {
    setBusy(btn, true);
    try {
      const { text } = await api(`/mistic/charges/${encodeURIComponent(charge.id)}/text`);
      if (await copyToClipboard(text)) notify.success("A cobrança (mensagem e PIX copia e cola) foi copiada. É só colar no WhatsApp.", { title: "Copiado", duration: 3500 });
      else notify.error("Não foi possível copiar. Selecione e copie à mão.");
    } catch (err) {
      notify.error(err.message, { title: "Não foi possível copiar" });
    } finally {
      setBusy(btn, false);
    }
    return;
  }

  if (btn.dataset.act === "delete") {
    await deleteCharge(charge, btn);
    return;
  }

  setBusy(btn, true);
  try {
    const path = `/mistic/charges/${encodeURIComponent(charge.id)}/${btn.dataset.act}`;
    const { charge: updated } = await api(path, { method: "POST" });
    if (btn.dataset.act === "resend") {
      if (updated.sendError) notify.warning(updated.sendError, { title: "Não foi possível reenviar" });
      else notify.success("Mensagem, PIX copia e cola e QR Code enviados de novo.", { title: "Reenviado", duration: 3000 });
    } else if (updated.status === "pending") {
      notify.info("Ainda não foi pago. Eu aviso quando cair.", { title: "Aguardando pagamento", duration: 3000 });
    }
    await refreshPay();
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível concluir" });
  } finally {
    setBusy(btn, false);
  }
}

/** Tira a cobrança do histórico (só deste painel: a MisticPay não permite cancelar um PIX). */
async function deleteCharge(charge, btn) {
  const value = formatBRL(charge.amountCents / 100);
  const who = charge.name || charge.payerName || formatPhone(charge.phone) || "cliente";
  const message =
    charge.status === "pending"
      ? `A cobrança de ${value} (${who}) sai do histórico e o sistema para de acompanhá-la. A MisticPay não permite cancelar um PIX: se o cliente ainda pagar, o dinheiro cai na sua conta, mas você não será avisado. Só exclua se isso já está resolvido com o cliente.`
      : `A cobrança de ${value} (${who}) sai desta lista. Ela continua no extrato da MisticPay.`;

  const confirmed = await confirmDialog({ title: "Excluir cobrança?", message, confirmText: "Excluir", tone: "danger" });
  if (!confirmed) return;

  setBusy(btn, true);
  try {
    await api(`/mistic/charges/${encodeURIComponent(charge.id)}`, { method: "DELETE" });
    notify.success(`A cobrança de ${value} foi excluída da lista.`, { title: "Excluída", duration: 3000 });
    await refreshPay();
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível excluir" });
  } finally {
    setBusy(btn, false);
  }
}

/* ---------- Extrato ---------- */

async function loadStatement(page = 1) {
  statementEl.innerHTML = `<li class="empty-state"><span class="spinner"></span></li>`;
  try {
    const data = await api(`/mistic/statement?page=${page}`);
    statementPage = data.page;
    statementTotalPages = Math.max(1, data.totalPages);
    statementLoaded = true;

    statementEl.innerHTML = data.items.length
      ? data.items
          .map((t) => {
            const out = t.type === "RETIRADA";
            const stateBadge =
              t.state === "COMPLETO" ? ["badge-success", "Concluída"] : t.state === "PENDENTE" ? ["badge-warning", "Pendente"] : ["badge-danger", t.state === "CANCELADO" ? "Cancelada" : "Falhou"];
            return `
            <li class="stack-item">
              <div class="stack-main">
                <div class="stack-text" style="gap:2px">
                  <strong>${escapeHtml(t.description || (out ? "Saque" : "Recebimento"))} <span class="badge ${stateBadge[0]}">${stateBadge[1]}</span></strong>
                  <span class="charge-meta">${formatDateTime(Date.parse(t.createdAt))} · ${out ? "Saída" : "Entrada"} ${escapeHtml(t.method)}${t.clientName ? ` · ${escapeHtml(t.clientName)}` : ""}${t.fee ? ` · taxa ${formatCurrency(t.fee)}` : ""}</span>
                </div>
              </div>
              <span class="statement-value ${out ? "is-out" : ""}">${out ? "−" : ""}${formatCurrency(t.value)}</span>
            </li>`;
          })
          .join("")
      : emptyState({ iconName: "inbox", title: "Sem movimentações", text: "Quando houver transações na sua conta MisticPay, elas aparecem aqui." });
  } catch (err) {
    statementLoaded = false;
    statementEl.innerHTML = emptyState({ iconName: "wifi-off", title: "Não foi possível carregar o extrato", text: err.message });
  }
  statementPageEl.textContent = `Página ${statementPage} de ${statementTotalPages}`;
  statementPrevBtn.disabled = statementPage <= 1;
  statementNextBtn.disabled = statementPage >= statementTotalPages;
}

/* ---------- Abas e modal ---------- */

function paintSubmit() {
  const isCharge = tab === "charge";
  const isWithdraw = tab === "withdraw";
  // Sem número (cliente aleatório) não há para quem enviar: copiar vira a ação principal
  const random = isCharge && isRandomClient();
  submitBtn.classList.toggle("hidden", !isWithdraw && !(isCharge && !random));
  copyBtn.classList.toggle("hidden", !isCharge);
  copyBtn.classList.toggle("btn-primary", random);
  copyBtn.classList.toggle("btn-secondary", !random);
  // O botão tem o HTML recriado ao entrar/sair do estado "carregando": procura o texto na hora
  const label = submitBtn.querySelector("span:not(.spinner)");
  if (label) label.textContent = isWithdraw ? "Sacar" : "Enviar cobrança";
}

function setTab(next) {
  tab = next;
  document.querySelectorAll('input[name="pay-tab"]').forEach((r) => (r.checked = r.value === next));
  for (const name of PANELS) document.getElementById(`pay-panel-${name}`).classList.toggle("hidden", name !== next);
  paintSubmit();

  if (next === "history") renderHistory();
  if (next === "statement" && !statementLoaded) loadStatement(1);
}

function onSubmit() {
  if (submitBtn.disabled || copyBtn.disabled) return;
  if (tab === "charge") submitCharge(isRandomClient() ? "copy" : "send"); // Ctrl+Enter: sem número só dá pra copiar
  else if (tab === "withdraw") submitWithdraw();
}

function onCopy() {
  if (submitBtn.disabled || copyBtn.disabled || tab !== "charge") return;
  submitCharge("copy");
}

export function openPayModal() {
  if (!config?.configured) {
    notify.warning("Ligue a integração e preencha o Client ID e o Client Secret em Configurações › MisticPay.", { title: "MisticPay não configurada" });
    return;
  }

  amountInput.value = "";
  descriptionInput.value = "";
  payerNameInput.value = "";
  delete payerNameInput.dataset.touched;
  payerDocumentInput.value = "";
  saveDocumentInput.checked = true;
  phoneInput.value = "";
  statementLoaded = false;
  contactTouched = false;
  randomActive = false;
  autoName = null;
  autoDescription = null;

  subEl.textContent = "Cobre clientes, acompanhe pagamentos e faça saques.";
  contactsHtml = ""; // ao abrir, escolhe de novo o cliente da conversa mais recente
  renderContacts();
  updateDocumentHint();
  updatePreview();
  paintInfo();
  setTab("charge");
  openModal(modal);
  loadAccountInfo();
}

/** `standalone`: é a janela de pagamento aberta pelo botão solto na tela (fechar o modal fecha a janela). */
export function initPay({ standalone: isStandalone = false } = {}) {
  standalone = isStandalone;
  initFabDrag();
  bindModal(modal, () => (standalone ? window.close() : closeModal(modal)));

  contactSelect.addEventListener("change", () => {
    contactTouched = true;
    applyContactChoice();
    void syncRandomMode();
    updatePreview();
    if (contactSelect.value === OTHER_NUMBER) phoneInput.focus();
  });
  randomNameBtn.addEventListener("click", rollRandomName);
  for (const input of [amountInput, descriptionInput, payerNameInput]) input.addEventListener("input", updatePreview);
  payerNameInput.addEventListener("input", () => (payerNameInput.dataset.touched = "1"));
  payerDocumentInput.addEventListener("input", () => {
    const digits = payerDocumentInput.value.replace(/\D/g, "").slice(0, 11);
    if (payerDocumentInput.value !== digits) payerDocumentInput.value = formatCpf(digits);
    updateDocumentHint();
  });

  document.querySelectorAll('input[name="pay-tab"]').forEach((radio) => {
    radio.addEventListener("change", () => radio.checked && setTab(radio.value));
  });
  withdrawKeyTypeSelect.addEventListener("change", () => {
    withdrawKeyInput.placeholder = KEY_PLACEHOLDERS[withdrawKeyTypeSelect.value];
  });

  refreshBtn.addEventListener("click", loadAccountInfo);
  historyEl.addEventListener("click", onHistoryClick);
  statementPrevBtn.addEventListener("click", () => loadStatement(statementPage - 1));
  statementNextBtn.addEventListener("click", () => loadStatement(statementPage + 1));
  submitBtn.addEventListener("click", onSubmit);
  copyBtn.addEventListener("click", onCopy);
  // A janela de pagamento não tem as configurações (elas ficam no painel)
  openSettingsBtn.classList.toggle("hidden", standalone);
  openSettingsBtn.addEventListener("click", () => {
    closeModal(modal);
    document.dispatchEvent(new CustomEvent("open-settings", { detail: { tab: "mistic" } }));
  });

  // As configurações mudaram (credenciais, mensagens, modo do botão): relê tudo
  document.addEventListener("mistic-config-changed", () => {
    info = null;
    refreshPay();
  });
}
