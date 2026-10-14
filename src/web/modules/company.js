import { state } from "./state.js";
import { api } from "./api.js";
import { escapeHtml, formatDateTime, relativeTime } from "./utils.js";
import { icon, notify, confirmDialog, promptDialog, setBusy, emptyState } from "./ui.js";

/**
 * Painel "Minha equipe" (só para quem é líder). O líder convida funcionários, define a taxa dele e
 * quantos WhatsApp cada funcionário pode usar, e libera/bloqueia saque. Tudo é repassado pro servidor
 * de licenças (rotas /auth/leader/*), que guarda e aplica os limites — o dinheiro em si entra nas
 * próximas fases.
 */

const createInviteBtn = document.getElementById("create-employee-invite-btn");
const employeesListEl = document.getElementById("company-employees-list");
const invitesListEl = document.getElementById("company-invites-list");
const tabCompanyBtn = document.getElementById("tab-company");

// Aba "Dinheiro" (MisticPay da empresa + resumo + saque da parte do líder)
const money = {
  status: document.getElementById("company-mistic-status"),
  clientId: document.getElementById("company-mistic-client-id"),
  clientSecret: document.getElementById("company-mistic-client-secret"),
  saveBtn: document.getElementById("company-mistic-save-btn"),
  clearBtn: document.getElementById("company-mistic-clear-btn"),
  summary: document.getElementById("company-money-summary"),
  feeBalance: document.getElementById("company-fee-balance"),
  withdrawAmount: document.getElementById("company-withdraw-amount"),
  withdrawKeyType: document.getElementById("company-withdraw-keytype"),
  withdrawKey: document.getElementById("company-withdraw-key"),
  withdrawPassword: document.getElementById("company-withdraw-password"),
  withdrawPasswordHint: document.getElementById("company-withdraw-password-hint"),
  withdrawBtn: document.getElementById("company-withdraw-btn"),
  withdrawPasswordBtn: document.getElementById("company-withdraw-password-btn"),
};

/** Centavos inteiros → "R$ 12,34". */
function formatCents(cents) {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/** "12,50" ou "12.50" → número em reais (> 0), ou null se inválido. */
function parseAmount(value) {
  const s = String(value ?? "").trim();
  const n = s.includes(",") ? Number(s.replace(/\./g, "").replace(",", ".")) : Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/* ---------- Convites de funcionário (área de transferência) ---------- */

function inviteUrl(token) {
  return `${location.origin}/?invite=${encodeURIComponent(token)}`;
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function copyInviteLink(token) {
  if (await copyToClipboard(inviteUrl(token))) {
    notify.success("Link do convite copiado — envie para o funcionário.", { title: "Copiado", duration: 3000 });
  } else {
    notify.warning(inviteUrl(token), { title: "Copie o link manualmente", duration: 15000 });
  }
}

/* ---------- Funcionários ---------- */

function employeeControls(u) {
  const c = u.company || { feePercent: 0, maxWhatsapps: 1, withdrawBlocked: false };
  const used = Array.isArray(u.claimedWhatsapps) ? u.claimedWhatsapps.length : 0;
  return `
    <div class="access-expiry-row">
      <label class="hint" for="fee-${u.id}">Sua taxa:</label>
      <input id="fee-${u.id}" class="input" type="number" min="0" max="100" step="0.5" data-fee data-id="${u.id}" value="${c.feePercent}" style="max-width:90px"
        title="Porcentagem que fica para você, sobre o líquido de cada pagamento do funcionário">
      <span class="hint">% sobre o líquido de cada pagamento dele</span>
    </div>
    <div class="access-expiry-row">
      <label class="hint" for="maxwa-${u.id}">WhatsApp liberados:</label>
      <input id="maxwa-${u.id}" class="input" type="number" min="1" max="50" step="1" data-maxwa data-id="${u.id}" value="${c.maxWhatsapps}" style="max-width:80px"
        title="Quantos números de WhatsApp este funcionário pode conectar">
      <span class="hint">${used} em uso</span>
      ${used ? `<button type="button" class="btn btn-ghost btn-sm" data-act="reset-whatsapps" data-id="${u.id}">Liberar vagas</button>` : ""}
    </div>
    <div class="access-expiry-row">
      <label class="feature-chip"><input type="checkbox" data-withdraw data-id="${u.id}" ${c.withdrawBlocked ? "checked" : ""}> Saque bloqueado</label>
      <span class="hint">impede o funcionário de sacar (ele vê "o líder bloqueou temporariamente")</span>
    </div>`;
}

function renderEmployees(employees) {
  if (employees.length === 0) {
    employeesListEl.innerHTML = emptyState({ iconName: "users", title: "Nenhum funcionário ainda", text: "Crie um convite para o primeiro funcionário da sua equipe." });
    return;
  }
  employeesListEl.innerHTML = employees
    .map((u) => {
      const expired = u.expiresAt !== null && u.expiresAt <= Date.now();
      return `
      <li class="stack-item ${u.disabled ? "is-muted" : ""}" data-id="${u.id}">
        <div class="stack-main">
          <div class="stack-text" style="gap:3px; flex:1">
            <strong>
              ${escapeHtml(u.username)}
              ${!u.disabled && u.online ? '<span class="badge badge-success">Online</span>' : ""}
              ${u.disabled ? '<span class="badge badge-danger">Desativado</span>' : ""}
              ${!u.disabled && expired ? '<span class="badge badge-muted">Vencido</span>' : ""}
            </strong>
            <span class="charge-meta">Criado ${relativeTime(u.createdAt)}</span>
            ${employeeControls(u)}
          </div>
        </div>
        <div class="card-actions">
          <button type="button" class="btn ${u.disabled ? "btn-secondary" : "btn-ghost"} btn-sm" data-act="${u.disabled ? "enable" : "disable"}" data-id="${u.id}">
            ${u.disabled ? "Reativar" : "Desativar"}
          </button>
        </div>
      </li>`;
    })
    .join("");
}

async function saveEmployeeConfig(id, patch) {
  try {
    await api(`/auth/leader/employees/${encodeURIComponent(id)}/config`, { method: "POST", body: patch });
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível salvar" });
    await refreshEmployees(); // desfaz visualmente o que não foi salvo
  }
}

function onEmployeesChange(e) {
  const fee = e.target.closest("input[data-fee]");
  if (fee) {
    const feePercent = Number(String(fee.value).replace(",", "."));
    if (Number.isFinite(feePercent)) saveEmployeeConfig(fee.dataset.id, { feePercent });
    return;
  }
  const maxwa = e.target.closest("input[data-maxwa]");
  if (maxwa) {
    const maxWhatsapps = Math.floor(Number(maxwa.value));
    if (maxWhatsapps >= 1) saveEmployeeConfig(maxwa.dataset.id, { maxWhatsapps });
    return;
  }
  const withdraw = e.target.closest("input[data-withdraw]");
  if (withdraw) {
    saveEmployeeConfig(withdraw.dataset.id, { withdrawBlocked: withdraw.checked });
  }
}

async function onEmployeesClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const id = btn.dataset.id;

  if (btn.dataset.act === "reset-whatsapps") {
    const confirmed = await confirmDialog({
      title: "Liberar as vagas de WhatsApp?",
      message: "O funcionário vai poder conectar outros números (as vagas atuais ficam livres).",
      confirmText: "Liberar",
    });
    if (!confirmed) return;
    try {
      await api(`/auth/leader/employees/${encodeURIComponent(id)}/reset-whatsapps`, { method: "POST" });
      await refreshEmployees();
    } catch (err) {
      notify.error(err.message, { title: "Não foi possível liberar" });
    }
    return;
  }

  const disable = btn.dataset.act === "disable";
  if (disable || btn.dataset.act === "enable") {
    if (disable) {
      const confirmed = await confirmDialog({
        title: "Desativar este funcionário?",
        message: "Ele é desconectado na hora e não consegue mais entrar, até ser reativado.",
        confirmText: "Desativar",
        tone: "danger",
      });
      if (!confirmed) return;
    }
    try {
      await api(`/auth/leader/employees/${encodeURIComponent(id)}/${disable ? "disable" : "enable"}`, { method: "POST" });
      await refreshEmployees();
    } catch (err) {
      notify.error(err.message, { title: "Não foi possível concluir" });
    }
  }
}

async function refreshEmployees() {
  try {
    const { employees } = await api("/auth/leader/employees");
    renderEmployees(employees);
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível carregar os funcionários" });
  }
}

/* ---------- Convites ---------- */

function renderInvites(invites) {
  if (invites.length === 0) {
    invitesListEl.innerHTML = emptyState({ iconName: "link", title: "Nenhum convite criado ainda" });
    return;
  }
  invitesListEl.innerHTML = invites
    .map((i) => {
      const statusBadge = i.revoked
        ? ["badge-danger", "Revogado"]
        : i.usedAt
          ? ["badge-muted", "Usado"]
          : i.expiresAt < Date.now()
            ? ["badge-muted", "Expirado"]
            : ["badge-success", "Ativo"];
      const pending = !i.revoked && !i.usedAt && i.expiresAt >= Date.now();
      return `
      <li class="stack-item" data-id="${i.id}">
        <div class="stack-main">
          <div class="stack-text" style="gap:3px">
            <strong>Funcionário <span class="badge ${statusBadge[0]}">${statusBadge[1]}</span></strong>
            <span class="charge-meta">Criado ${relativeTime(i.createdAt)} · expira ${formatDateTime(i.expiresAt)}</span>
          </div>
        </div>
        <div class="card-actions">
          ${pending ? `<button type="button" class="btn btn-ghost btn-sm" data-act="copy" data-id="${i.id}">${icon("copy")} Copiar link</button>` : ""}
          ${pending ? `<button type="button" class="btn btn-ghost btn-sm" data-act="copy-code" data-id="${i.id}">${icon("copy")} Copiar código</button>` : ""}
          ${pending ? `<button type="button" class="icon-btn icon-btn-sm danger" data-act="revoke" data-id="${i.id}" title="Revogar convite" aria-label="Revogar convite">${icon("x")}</button>` : ""}
        </div>
      </li>`;
    })
    .join("");
}

async function createEmployeeInvite() {
  setBusy(createInviteBtn, true, "Criando…");
  try {
    const { invite } = await api("/auth/leader/invites", { method: "POST" });
    await refreshInvites();
    await copyInviteLink(invite.id);
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível criar o convite" });
  } finally {
    setBusy(createInviteBtn, false);
  }
}

async function onInvitesClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const id = btn.dataset.id;

  if (btn.dataset.act === "copy") return copyInviteLink(id);

  if (btn.dataset.act === "copy-code") {
    if (await copyToClipboard(id)) notify.success("Código do convite copiado — o funcionário cola na tela de criar conta.", { title: "Copiado", duration: 3000 });
    else notify.warning(id, { title: "Copie o código manualmente", duration: 15000 });
    return;
  }

  if (btn.dataset.act === "revoke") {
    const confirmed = await confirmDialog({ title: "Revogar este convite?", message: "Quem ainda não usou o link não vai mais conseguir criar conta com ele.", confirmText: "Revogar", tone: "danger" });
    if (!confirmed) return;
    try {
      await api(`/auth/leader/invites/${encodeURIComponent(id)}/revoke`, { method: "POST" });
      await refreshInvites();
    } catch (err) {
      notify.error(err.message, { title: "Não foi possível revogar" });
    }
  }
}

async function refreshInvites() {
  try {
    const { invites } = await api("/auth/leader/invites");
    renderInvites(invites);
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível carregar os convites" });
  }
}

/* ---------- Dinheiro: MisticPay da empresa, resumo e saque da parte do líder ---------- */

let latestSummary = null;

function renderMoney(summary) {
  latestSummary = summary;
  money.status.textContent = summary.configured ? "MisticPay configurada." : "MisticPay ainda não configurada — preencha abaixo para a equipe poder cobrar.";
  money.feeBalance.textContent = `Disponível para saque (sua parte): ${formatCents(summary.leaderFeeBalanceCents)}`;
  money.withdrawPasswordHint.textContent = summary.hasWithdrawPassword
    ? ""
    : "Crie uma senha de saque antes de sacar (botão abaixo).";

  const rows = summary.employees
    .map(
      (e) => `
      <li class="stack-item">
        <div class="stack-main">
          <div class="stack-text" style="gap:2px">
            <strong>${escapeHtml(e.username)}</strong>
            <span class="charge-meta">saldo ${formatCents(e.balanceCents)} · sua taxa ${e.feePercent}%${e.withdrawBlocked ? " · saque bloqueado" : ""}</span>
          </div>
        </div>
      </li>`
    )
    .join("");
  money.summary.innerHTML = `
    <div class="charge-meta" style="margin-bottom:8px">Bruto total da empresa: <strong>${formatCents(summary.grossTotalCents)}</strong> · sua parte: <strong>${formatCents(summary.leaderFeeBalanceCents)}</strong></div>
    <ul class="stack-list">${rows || emptyState({ iconName: "users", title: "Sem funcionários" })}</ul>`;
}

async function loadMoney() {
  try {
    renderMoney(await api("/auth/leader/money/summary"));
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível carregar o resumo" });
  }
}

async function saveMisticCredentials() {
  const clientId = money.clientId.value.trim();
  const clientSecret = money.clientSecret.value.trim();
  if (!clientId || !clientSecret) return notify.warning("Preencha o Client ID e o Client Secret.", { title: "Faltam dados" });
  setBusy(money.saveBtn, true, "Testando…");
  try {
    const res = await api("/auth/leader/mistic", { method: "POST", body: { clientId, clientSecret } });
    money.clientSecret.value = "";
    notify.success(res.account?.name ? `Conectado à MisticPay de ${res.account.name}.` : "MisticPay configurada.", { title: "Pronto" });
    await loadMoney();
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível configurar" });
  } finally {
    setBusy(money.saveBtn, false);
  }
}

async function clearMisticCredentials() {
  const confirmed = await confirmDialog({
    title: "Remover a MisticPay da empresa?",
    message: "A equipe deixa de cobrar e sacar até você configurar de novo. O histórico e os saldos continuam guardados.",
    confirmText: "Remover",
    tone: "danger",
  });
  if (!confirmed) return;
  try {
    await api("/auth/leader/mistic/clear", { method: "POST" });
    await loadMoney();
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível remover" });
  }
}

async function setLeaderWithdrawPassword() {
  const password = await promptDialog({ title: "Senha de saque", label: latestSummary?.hasWithdrawPassword ? "Nova senha de saque" : "Crie uma senha de saque" });
  if (!password) return;
  let currentPassword;
  if (latestSummary?.hasWithdrawPassword) {
    currentPassword = await promptDialog({ title: "Senha de saque", label: "Senha de saque atual" });
    if (!currentPassword) return;
  }
  try {
    await api("/auth/leader/mistic/withdraw-password", { method: "POST", body: { password, currentPassword } });
    notify.success("Senha de saque salva.", { title: "Pronto" });
    await loadMoney();
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível salvar a senha" });
  }
}

async function withdrawFee() {
  const amount = parseAmount(money.withdrawAmount.value);
  if (amount === null) return notify.warning("Informe um valor de saque válido.", { title: "Valor inválido" });
  const pixKey = money.withdrawKey.value.trim();
  if (!pixKey) return notify.warning("Informe a chave PIX.", { title: "Faltam dados" });
  const withdrawPassword = money.withdrawPassword.value;
  if (!withdrawPassword) return notify.warning("Informe sua senha de saque.", { title: "Faltam dados" });

  setBusy(money.withdrawBtn, true, "Sacando…");
  try {
    await api("/auth/leader/mistic/withdraw", { method: "POST", body: { amount, pixKey, pixKeyType: money.withdrawKeyType.value, withdrawPassword } });
    money.withdrawAmount.value = "";
    money.withdrawKey.value = "";
    money.withdrawPassword.value = "";
    notify.success("Saque solicitado.", { title: "Pronto" });
    await loadMoney();
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível sacar" });
  } finally {
    setBusy(money.withdrawBtn, false);
  }
}

/* ---------- Inicialização ---------- */

function initCompanyTabs() {
  const sections = { employees: "company-section-employees", money: "company-section-money", invites: "company-section-invites" };
  document.querySelectorAll('input[name="company-tab"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      for (const [value, id] of Object.entries(sections)) {
        document.getElementById(id).classList.toggle("hidden", value !== radio.value);
      }
      if (radio.value === "money") loadMoney();
    });
  });
}

/** Chamado dentro de `startPanel()`: só liga o painel quando quem está logado é líder. */
export function initCompanyPanel() {
  const isLeader = state.currentUser?.role === "leader";
  tabCompanyBtn?.classList.toggle("hidden", !isLeader);
  if (!isLeader) return;

  initCompanyTabs();
  createInviteBtn.addEventListener("click", createEmployeeInvite);
  employeesListEl.addEventListener("click", onEmployeesClick);
  employeesListEl.addEventListener("change", onEmployeesChange);
  invitesListEl.addEventListener("click", onInvitesClick);

  money.saveBtn.addEventListener("click", saveMisticCredentials);
  money.clearBtn.addEventListener("click", clearMisticCredentials);
  money.withdrawBtn.addEventListener("click", withdrawFee);
  money.withdrawPasswordBtn.addEventListener("click", setLeaderWithdrawPassword);

  refreshEmployees();
  refreshInvites();
}

/** Chamado no polling em segundo plano (main.js): só gasta a requisição quando quem está logado é líder. */
export function refreshEmployeesIfLeader() {
  if (state.currentUser?.role === "leader") refreshEmployees();
}
