import { state } from "./state.js";
import { api } from "./api.js";
import { escapeHtml, formatDateTime, relativeTime } from "./utils.js";
import { icon, notify, confirmDialog, promptDialog, setBusy, emptyState } from "./ui.js";

// O ícone é desenhado aqui (não pelo sprite de ícones do painel): as telas de login/convite
// substituem a página toda, inclusive o sprite (mesma razão do ícone de cadeado em main.js).
const USER_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="36" height="36" aria-hidden="true">' +
  '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>';

const ROLE_LABELS = { admin: "Administrador", operator: "Operador" };

/** Mesmas chaves de `FEATURE_KEYS` em src/core/user-store.ts — mantenha os dois em sincronia. */
const FEATURE_LABELS = {
  groupBot: "Bot de grupo",
  campaigns: "Propaganda",
  metrics: "Métricas",
  chat: "WhatsApp integrado",
  misticPay: "MisticPay",
  rideAssistant: "Assistente de corrida",
  multiAccount: "Vários WhatsApp",
};
const FEATURE_ORDER = Object.keys(FEATURE_LABELS);

/* ---------- Tela de login / primeira conta / convite ---------- */

function authScreenMarkup(mode) {
  const titles = {
    login: ["Entrar no painel", "Use a conta que você já tem para continuar."],
    bootstrap: ["Criar a primeira conta", "Ainda não existe nenhuma conta neste painel. Esta primeira conta vira administradora e pode convidar as próximas pessoas."],
    register: ["Você foi convidado(a)", "Escolha um usuário e uma senha para criar sua conta."],
  };
  const [title, subtitle] = titles[mode];
  const confirmField =
    mode === "login"
      ? ""
      : `<div class="field">
           <label for="auth-confirm">Confirmar senha</label>
           <input id="auth-confirm" class="input" type="password" autocomplete="new-password" required>
         </div>`;
  const submitLabel = { login: "Entrar", bootstrap: "Criar conta", register: "Criar minha conta" }[mode];

  return `
    <div class="lock-screen">
      <div class="lock-card auth-card">
        <span class="lock-icon auth-icon">${USER_ICON_SVG}</span>
        <h1>${title}</h1>
        <p>${subtitle}</p>
        <form id="auth-form" class="auth-form">
          <div class="field">
            <label for="auth-username">Usuário</label>
            <input id="auth-username" class="input" type="text" autocomplete="username" autocapitalize="off" spellcheck="false" required>
          </div>
          <div class="field">
            <label for="auth-password">Senha</label>
            <input id="auth-password" class="input" type="password" autocomplete="${mode === "login" ? "current-password" : "new-password"}" required>
          </div>
          ${confirmField}
          <p id="auth-error" class="hint auth-error hidden"></p>
          <button id="auth-submit" class="btn btn-primary" type="submit">${submitLabel}</button>
        </form>
      </div>
    </div>`;
}

function showAuthError(message) {
  const el = document.getElementById("auth-error");
  el.textContent = message;
  el.classList.toggle("hidden", !message);
}

/**
 * Mostra a tela certa (login, criar primeira conta, ou registro por convite) e devolve uma Promise
 * que só resolve quando a pessoa conseguir entrar (sucesso = `location.reload()`, então na prática
 * esta função nunca "termina" num caminho de erro — é só para o `boot()` não seguir em frente).
 */
function renderGate(mode, inviteToken) {
  document.title = mode === "login" ? "Entrar" : mode === "bootstrap" ? "Criar conta" : "Convite";
  document.body.innerHTML = authScreenMarkup(mode);

  const form = document.getElementById("auth-form");
  const usernameInput = document.getElementById("auth-username");
  const passwordInput = document.getElementById("auth-password");
  const confirmInput = document.getElementById("auth-confirm");
  const submitBtn = document.getElementById("auth-submit");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    showAuthError("");

    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    if (mode !== "login" && password !== confirmInput.value) {
      return showAuthError("As senhas não são iguais.");
    }

    setBusy(submitBtn, true, mode === "login" ? "Entrando…" : "Criando…");
    try {
      if (mode === "login") await api("/auth/login", { method: "POST", body: { username, password } });
      else if (mode === "bootstrap") await api("/auth/bootstrap", { method: "POST", body: { username, password } });
      else await api("/auth/register", { method: "POST", body: { inviteToken, username, password } });
      location.reload();
    } catch (err) {
      showAuthError(err.message);
      setBusy(submitBtn, false);
    }
  });

  usernameInput.focus();
}

/**
 * Confere se há sessão. Sem ela, mostra a tela certa e NUNCA resolve (a navegação só continua
 * depois de um `location.reload()` bem-sucedido). Chamado no `boot()`, antes do painel propriamente dito.
 */
export async function guardAuth() {
  let status;
  try {
    status = await api("/auth/status");
  } catch {
    return { blocked: false }; // painel ainda subindo: segue e deixa o polling normal lidar com isso
  }

  if (status.authenticated) {
    state.currentUser = status.user;
    warnAboutLicense(status.license);
    return { blocked: false };
  }

  const inviteToken = new URLSearchParams(location.search).get("invite");
  if (status.bootstrapNeeded) renderGate("bootstrap");
  else if (inviteToken) renderGate("register", inviteToken);
  else renderGate("login");

  return { blocked: true };
}

/* ---------- Licença (só com servidor de licenças): avisa quando o programa está sem falar com ele ---------- */

let lastLicenseState = "ok";

/** Avisa uma vez a cada mudança: sem falar com o servidor (ainda funcionando) ou já bloqueado por isso. */
function warnAboutLicense(license) {
  const licenseState = license?.state ?? "ok";
  if (licenseState === lastLicenseState) return;
  lastLicenseState = licenseState;
  if (licenseState === "offline") {
    notify.warning(`Sem conexão com o servidor de licenças. O programa continua funcionando até ${formatDateTime(license.validUntil)}; depois disso é preciso estar online.`, {
      title: "Licença sem renovar",
      duration: 15000,
    });
  } else if (licenseState === "blocked") {
    notify.error("O programa ficou tempo demais sem conseguir falar com o servidor de licenças. Confira sua internet: as funcionalidades voltam assim que a licença for renovada.", {
      title: "Licença bloqueada",
      duration: 30000,
    });
  }
}

/**
 * De tempos em tempos confere a sessão: se a licença deste computador foi cortada (conta desativada,
 * acesso liberado pra outro computador), volta pra tela de login em vez de deixar o painel aberto
 * dando erro; se o prazo ou as funcionalidades mudaram no servidor, recarrega pra valer.
 */
async function watchSession() {
  let status;
  try {
    status = await api("/auth/status");
  } catch {
    return; // painel fora do ar agora: o aviso de "sem conexão com o bot" já cobre isso
  }
  if (!status.authenticated) return location.reload();
  warnAboutLicense(status.license);

  const before = state.currentUser;
  const after = status.user;
  const accessChanged = !before || before.role !== after.role || before.expiresAt !== after.expiresAt || JSON.stringify(before.features) !== JSON.stringify(after.features);
  if (accessChanged && before?.role !== "admin") location.reload();
}

/* ---------- Funcionalidades por plano: a pessoa vê que existe, mas não consegue usar ---------- */

/** Espelha `hasFeatureAccess` de src/core/user-store.ts — mantenha as duas em sincronia. */
export function hasFeature(key) {
  const u = state.currentUser;
  // Sem usuário resolvido (login não configurado, ou a checagem inicial falhou), não tranca: quem
  // decide de verdade é o servidor (feature-guard), isto aqui é só uma conveniência visual.
  if (!u) return true;
  if (u.role === "admin") return true;
  if (u.expiresAt !== null && u.expiresAt <= Date.now()) return false;
  return !!u.features?.[key];
}

/** Cobre o conteúdo de `el` com um aviso de bloqueio, sem apagar o HTML de baixo (a aba continua existindo). */
function lockFeaturePanel(el, feature) {
  if (!el || hasFeature(feature)) return;
  el.style.position = el.style.position || "relative";
  const overlay = document.createElement("div");
  overlay.className = "feature-lock";
  overlay.innerHTML = `${icon("shield")}<strong>Funcionalidade não liberada</strong><p>“${FEATURE_LABELS[feature]}” não está disponível para sua conta. Fale com o administrador.</p>`;
  el.appendChild(overlay);
}

/** Avisa e impede a ação de um botão isolado (sem painel de conteúdo pra cobrir). */
function lockFeatureButton(el, feature, message) {
  if (!el || hasFeature(feature)) return;
  el.addEventListener(
    "click",
    (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      notify.warning(message, { title: "Funcionalidade bloqueada" });
    },
    true // fase de captura: roda antes do listener de verdade do botão
  );
}

/** Chamado uma vez, dentro de `startPanel()`, depois que `state.currentUser` já está preenchido. */
export function applyFeatureLocks() {
  lockFeaturePanel(document.getElementById("rules-panel"), "groupBot");
  lockFeaturePanel(document.getElementById("campaigns-panel"), "campaigns");
  lockFeaturePanel(document.getElementById("metrics-panel"), "metrics");
  lockFeaturePanel(document.getElementById("chat-panel"), "chat");
  lockFeaturePanel(document.getElementById("settings-mistic"), "misticPay");
  lockFeaturePanel(document.getElementById("settings-panel-ride-assistant"), "rideAssistant");

  lockFeatureButton(document.getElementById("pay-fab"), "misticPay", "MisticPay não está liberado para sua conta. Fale com o administrador.");
  lockFeatureButton(document.getElementById("add-account-btn"), "multiAccount", "Conectar outro WhatsApp não está liberado para sua conta. Fale com o administrador.");
}

/* ---------- Painel: logout, resgate de chave e administração ---------- */

const logoutBtn = document.getElementById("logout-btn");
const redeemKeyBtn = document.getElementById("redeem-key-btn");

const tabAccessBtn = document.getElementById("tab-access");
const invitesListEl = document.getElementById("access-invites-list");
const usersListEl = document.getElementById("access-users-list");
const keysListEl = document.getElementById("access-keys-list");
const newInviteRoleSelect = document.getElementById("new-invite-role");
const createInviteBtn = document.getElementById("create-invite-btn");
const newKeyDaysInput = document.getElementById("new-key-days");
const createKeyBtn = document.getElementById("create-key-btn");

async function logout() {
  const confirmed = await confirmDialog({ title: "Sair do painel?", message: "Você vai precisar entrar de novo com seu usuário e senha." });
  if (!confirmed) return;
  try {
    await api("/auth/logout", { method: "POST" });
  } finally {
    location.reload();
  }
}

async function redeemKey() {
  const code = await promptDialog({ title: "Resgatar chave", label: "Código da chave", placeholder: "A1B2-C3D4-E5F6-..." });
  if (!code) return;
  try {
    const { user } = await api("/auth/keys/redeem", { method: "POST", body: { code: code.trim() } });
    state.currentUser = user;
    notify.success(`Seu acesso agora vale até ${formatDateTime(user.expiresAt)}.`, { title: "Chave resgatada", duration: 7000 });
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível resgatar" });
  }
}

/* ---------- Convites ---------- */

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
    notify.success("Link do convite copiado — envie para a pessoa.", { title: "Copiado", duration: 3000 });
  } else {
    notify.warning(inviteUrl(token), { title: "Copie o link manualmente", duration: 15000 });
  }
}

function renderInvites(invites) {
  if (invites.length === 0) {
    invitesListEl.innerHTML = emptyState({ iconName: "link", title: "Nenhum convite criado ainda" });
    return;
  }
  invitesListEl.innerHTML = invites
    .map((i) => {
      const statusBadge = i.revoked ? ["badge-danger", "Revogado"] : i.usedAt ? ["badge-muted", "Usado"] : i.expiresAt < Date.now() ? ["badge-muted", "Expirado"] : ["badge-success", "Ativo"];
      const pending = !i.revoked && !i.usedAt && i.expiresAt >= Date.now();
      return `
      <li class="stack-item" data-id="${i.id}">
        <div class="stack-main">
          <div class="stack-text" style="gap:3px">
            <strong>${ROLE_LABELS[i.role]} <span class="badge ${statusBadge[0]}">${statusBadge[1]}</span></strong>
            <span class="charge-meta">Criado ${relativeTime(i.createdAt)} · expira ${formatDateTime(i.expiresAt)}</span>
          </div>
        </div>
        <div class="card-actions">
          ${pending ? `<button type="button" class="btn btn-ghost btn-sm" data-act="copy" data-id="${i.id}">${icon("copy")} Copiar link</button>` : ""}
          ${pending ? `<button type="button" class="icon-btn icon-btn-sm danger" data-act="revoke" data-id="${i.id}" title="Revogar convite" aria-label="Revogar convite">${icon("x")}</button>` : ""}
        </div>
      </li>`;
    })
    .join("");
}

async function createInvite() {
  setBusy(createInviteBtn, true, "Criando…");
  try {
    const { invite } = await api("/auth/invites", { method: "POST", body: { role: newInviteRoleSelect.value } });
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

  if (btn.dataset.act === "revoke") {
    const confirmed = await confirmDialog({ title: "Revogar este convite?", message: "Quem ainda não usou o link não vai mais conseguir criar conta com ele.", confirmText: "Revogar", tone: "danger" });
    if (!confirmed) return;
    try {
      await api(`/auth/invites/${encodeURIComponent(id)}/revoke`, { method: "POST" });
      await refreshInvites();
    } catch (err) {
      notify.error(err.message, { title: "Não foi possível revogar" });
    }
  }
}

async function refreshInvites() {
  try {
    const { invites } = await api("/auth/invites");
    renderInvites(invites);
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível carregar os convites" });
  }
}

/* ---------- Usuários: prazo + funcionalidades ---------- */

// Guardado pra `renderKeys` saber quantos administradores existem (só mostra quem criou a chave
// quando há mais de um — com um só, é sempre óbvio e a informação não ajuda em nada).
let latestUsers = [];

function dateInputValue(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Em quais computadores a conta já entrou e em quantos pode entrar. Só aparece com servidor de
 * licenças (no modo local as contas não saem deste computador, então o campo nem vem).
 */
function devicesRowHtml(u) {
  if (!Array.isArray(u.devices)) return "";
  const names = u.devices.map((d) => d.name || "computador sem nome").join(", ");
  const used = u.devices.length ? `${u.devices.length} em uso (${escapeHtml(names)})` : "nenhum em uso ainda";
  return `<div class="access-expiry-row">
    <label class="hint" for="devices-${u.id}">Computadores:</label>
    <input id="devices-${u.id}" class="input" type="number" min="1" max="50" step="1" data-max-devices data-id="${u.id}" value="${u.maxDevices ?? 1}" style="max-width:80px" title="Em quantos computadores esta conta pode entrar">
    <span class="hint">${used}</span>
    ${u.devices.length ? `<button type="button" class="btn btn-ghost btn-sm" data-act="reset-devices" data-id="${u.id}">Liberar computadores</button>` : ""}
  </div>`;
}

function renderUsers(users) {
  usersListEl.innerHTML = users
    .map((u) => {
      const isSelf = u.id === state.currentUser?.id;
      const expired = u.expiresAt !== null && u.expiresAt <= Date.now();
      const accessControls =
        u.role === "admin"
          ? `<span class="hint">Administrador: acesso total, sem prazo nem restrições.</span>`
          : `<div class="access-expiry-row">
               <label class="hint" for="expiry-${u.id}">Acesso até:</label>
               <input id="expiry-${u.id}" class="input" type="date" data-expiry data-id="${u.id}" value="${dateInputValue(u.expiresAt)}" style="max-width:160px">
               ${u.expiresAt ? `<button type="button" class="btn btn-ghost btn-sm" data-act="clear-expiry" data-id="${u.id}">Sem vencimento</button>` : ""}
             </div>
             <div class="access-features-grid">
               ${FEATURE_ORDER.map(
                 (key) =>
                   `<label class="feature-chip"><input type="checkbox" data-feature="${key}" data-id="${u.id}" ${u.features?.[key] ? "checked" : ""}> ${FEATURE_LABELS[key]}</label>`
               ).join("")}
             </div>
             ${devicesRowHtml(u)}`;

      return `
      <li class="stack-item ${u.disabled ? "is-muted" : ""}" data-id="${u.id}">
        <div class="stack-main">
          <div class="stack-text" style="gap:3px; flex:1">
            <strong>
              ${escapeHtml(u.username)} <span class="badge">${ROLE_LABELS[u.role]}</span>
              ${!u.disabled && u.online ? '<span class="badge badge-success">Online</span>' : ""}
              ${u.disabled ? '<span class="badge badge-danger">Desativado</span>' : ""}
              ${!u.disabled && expired ? '<span class="badge badge-muted">Vencido</span>' : ""}
            </strong>
            <span class="charge-meta">Criado ${relativeTime(u.createdAt)}${isSelf ? " · você" : ""}</span>
            ${accessControls}
          </div>
        </div>
        <div class="card-actions">
          ${
            isSelf
              ? ""
              : `<button type="button" class="btn ${u.disabled ? "btn-secondary" : "btn-ghost"} btn-sm" data-act="${u.disabled ? "enable" : "disable"}" data-id="${u.id}">
                   ${u.disabled ? "Reativar" : "Desativar"}
                 </button>`
          }
        </div>
      </li>`;
    })
    .join("");
}

async function saveUserAccess(id, patch, { refresh = true } = {}) {
  try {
    await api(`/auth/users/${encodeURIComponent(id)}/access`, { method: "POST", body: patch });
    if (refresh) await refreshUsers();
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível salvar" });
    await refreshUsers(); // desfaz visualmente o que não foi salvo
  }
}

function onUsersChange(e) {
  const featureInput = e.target.closest("input[data-feature]");
  if (featureInput) {
    saveUserAccess(featureInput.dataset.id, { features: { [featureInput.dataset.feature]: featureInput.checked } }, { refresh: false });
    return;
  }

  const devicesInput = e.target.closest("input[data-max-devices]");
  if (devicesInput) {
    const maxDevices = Math.floor(Number(devicesInput.value));
    if (maxDevices >= 1) saveUserAccess(devicesInput.dataset.id, { maxDevices });
    return;
  }

  const dateInput = e.target.closest("input[data-expiry]");
  if (dateInput && dateInput.value) {
    const expiresAt = new Date(`${dateInput.value}T23:59:59`).getTime();
    saveUserAccess(dateInput.dataset.id, { expiresAt });
  }
}

async function onUsersClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const id = btn.dataset.id;

  if (btn.dataset.act === "clear-expiry") {
    return saveUserAccess(id, { expiresAt: null });
  }

  if (btn.dataset.act === "reset-devices") {
    const confirmed = await confirmDialog({
      title: "Liberar os computadores desta conta?",
      message: "A pessoa é desconectada de onde está usando agora e pode entrar de novo em outro computador (o próximo em que ela entrar ocupa a vaga).",
      confirmText: "Liberar",
    });
    if (!confirmed) return;
    try {
      await api(`/auth/users/${encodeURIComponent(id)}/reset-devices`, { method: "POST" });
      await refreshUsers();
    } catch (err) {
      notify.error(err.message, { title: "Não foi possível liberar" });
    }
    return;
  }

  const disable = btn.dataset.act === "disable";
  if (disable || btn.dataset.act === "enable") {
    if (disable) {
      const confirmed = await confirmDialog({
        title: "Desativar este usuário?",
        message: "A pessoa é desconectada na hora e não consegue mais entrar, até ser reativada.",
        confirmText: "Desativar",
        tone: "danger",
      });
      if (!confirmed) return;
    }
    try {
      await api(`/auth/users/${encodeURIComponent(id)}/${disable ? "disable" : "enable"}`, { method: "POST" });
      await refreshUsers();
    } catch (err) {
      notify.error(err.message, { title: "Não foi possível concluir" });
    }
  }
}

async function refreshUsers() {
  try {
    const { users } = await api("/auth/users");
    latestUsers = users;
    renderUsers(users);
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível carregar os usuários" });
  }
}

/** Chamado no polling em segundo plano (main.js): só gasta a requisição quando quem está logado é admin. */
export function refreshUsersIfAdmin() {
  if (state.currentUser?.role === "admin") refreshUsers();
}

/* ---------- Chaves de renovação ---------- */

const KEY_STATUS = {
  revoked: ["badge-danger", "Revogada"],
  used: ["badge-muted", "Usada"],
  expired: ["badge-muted", "Expirada"],
  active: ["badge-success", "Ativa"],
};

function keyStatus(k) {
  if (k.revoked) return KEY_STATUS.revoked;
  if (k.usedAt) return KEY_STATUS.used;
  if (k.expiresAt < Date.now()) return KEY_STATUS.expired;
  return KEY_STATUS.active;
}

function renderKeys(keys) {
  if (keys.length === 0) {
    keysListEl.innerHTML = emptyState({ iconName: "link", title: "Nenhuma chave gerada ainda" });
    return;
  }
  // Com um único administrador, "quem criou" é sempre a mesma pessoa — só vale mostrar com 2+.
  const showCreator = latestUsers.filter((u) => u.role === "admin").length > 1;
  keysListEl.innerHTML = keys
    .map((k) => {
      const [badgeClass, badgeText] = keyStatus(k);
      const pending = !k.revoked && !k.usedAt && k.expiresAt >= Date.now();
      const creator = showCreator && k.createdByUsername ? ` · criada por ${escapeHtml(k.createdByUsername)}` : "";
      return `
      <li class="stack-item" data-id="${k.id}">
        <div class="stack-main">
          <div class="stack-text" style="gap:3px">
            <strong class="mono">${k.id} <span class="badge ${badgeClass}">${badgeText}</span></strong>
            <span class="charge-meta">${k.durationDays} dias de acesso · criada ${relativeTime(k.createdAt)}${creator}</span>
          </div>
        </div>
        <div class="card-actions">
          ${pending ? `<button type="button" class="btn btn-ghost btn-sm" data-act="copy" data-id="${k.id}">${icon("copy")} Copiar código</button>` : ""}
          ${pending ? `<button type="button" class="icon-btn icon-btn-sm danger" data-act="revoke" data-id="${k.id}" title="Revogar chave" aria-label="Revogar chave">${icon("x")}</button>` : ""}
        </div>
      </li>`;
    })
    .join("");
}

async function createKey() {
  const days = Number(newKeyDaysInput.value);
  if (!(days > 0)) return notify.warning("Informe quantos dias a chave vai conceder.", { title: "Valor inválido" });

  setBusy(createKeyBtn, true, "Gerando…");
  try {
    const { key } = await api("/auth/keys", { method: "POST", body: { durationDays: days } });
    await refreshKeys();
    if (await copyToClipboard(key.id)) notify.success("Código copiado — entregue para a pessoa resgatar.", { title: "Chave gerada", duration: 5000 });
    else notify.success(key.id, { title: "Chave gerada (copie manualmente)", duration: 15000 });
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível gerar a chave" });
  } finally {
    setBusy(createKeyBtn, false);
  }
}

async function onKeysClick(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const id = btn.dataset.id;

  if (btn.dataset.act === "copy") {
    if (await copyToClipboard(id)) notify.success("Código copiado.", { title: "Copiado", duration: 2500 });
    else notify.warning(id, { title: "Copie o código manualmente", duration: 10000 });
    return;
  }

  if (btn.dataset.act === "revoke") {
    const confirmed = await confirmDialog({ title: "Revogar esta chave?", message: "Quem ainda não resgatou não vai mais conseguir usá-la.", confirmText: "Revogar", tone: "danger" });
    if (!confirmed) return;
    try {
      await api(`/auth/keys/${encodeURIComponent(id)}/revoke`, { method: "POST" });
      await refreshKeys();
    } catch (err) {
      notify.error(err.message, { title: "Não foi possível revogar" });
    }
  }
}

async function refreshKeys() {
  try {
    const { keys } = await api("/auth/keys");
    renderKeys(keys);
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível carregar as chaves" });
  }
}

/* ---------- Inicialização ---------- */

function initAccessTabs() {
  const sections = { users: "access-section-users", invites: "access-section-invites", keys: "access-section-keys" };
  document.querySelectorAll('input[name="access-tab"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      for (const [value, id] of Object.entries(sections)) {
        document.getElementById(id).classList.toggle("hidden", value !== radio.value);
      }
    });
  });
}

/** Chamado dentro de `startPanel()`, só quando a sessão já está autenticada. */
export function initAccessControl() {
  logoutBtn?.addEventListener("click", logout);
  setInterval(watchSession, 60_000);

  const isOperator = state.currentUser?.role === "operator";
  redeemKeyBtn?.classList.toggle("hidden", !isOperator);
  redeemKeyBtn?.addEventListener("click", redeemKey);

  const isAdmin = state.currentUser?.role === "admin";
  tabAccessBtn?.classList.toggle("hidden", !isAdmin);
  if (!isAdmin) return;

  initAccessTabs();
  createInviteBtn.addEventListener("click", createInvite);
  invitesListEl.addEventListener("click", onInvitesClick);
  usersListEl.addEventListener("click", onUsersClick);
  usersListEl.addEventListener("change", onUsersChange);
  createKeyBtn.addEventListener("click", createKey);
  keysListEl.addEventListener("click", onKeysClick);

  refreshInvites();
  // Usuários primeiro: `renderKeys` precisa saber quantos administradores existem pra decidir se
  // mostra quem criou cada chave.
  refreshUsers().then(refreshKeys);
}
