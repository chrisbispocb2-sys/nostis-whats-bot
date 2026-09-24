import { state } from "./state.js";
import { api } from "./api.js";
import { escapeHtml, phoneFromJid, avatarHtml, formatCpf, formatCurrency } from "./utils.js";
import { refreshBans, unbanJid } from "./metrics.js";
import { icon, notify, bindModal, openModal, closeModal, flagInvalid, setBusy, emptyState } from "./ui.js";

const settingsBtn = document.getElementById("settings-btn");
const settingsModal = document.getElementById("settings-modal");
const settingsIgnoreAdmInput = document.getElementById("settings-ignore-adm");
const settingsNoReplyNumbersInput = document.getElementById("settings-no-reply-numbers");
const settingsAutoShutdownInput = document.getElementById("settings-auto-shutdown");
const settingsAutoShutdownWrap = document.getElementById("settings-auto-shutdown-wrap");
const settingsAutoShutdownMinutesInput = document.getElementById("settings-auto-shutdown-minutes");
const settingsBansListEl = document.getElementById("settings-bans-list");
const settingsSaveBtn = document.getElementById("settings-save");

const generalSection = document.getElementById("settings-general");
const misticSection = document.getElementById("settings-mistic");

const mistic = {
  enabled: document.getElementById("mistic-enabled"),
  clientId: document.getElementById("mistic-client-id"),
  clientSecret: document.getElementById("mistic-client-secret"),
  secretHint: document.getElementById("mistic-secret-hint"),
  authHeader: document.getElementById("mistic-auth-header"),
  authHint: document.getElementById("mistic-auth-hint"),
  testBtn: document.getElementById("mistic-test-btn"),
  testResult: document.getElementById("mistic-test-result"),
  defaultDocument: document.getElementById("mistic-default-document"),
  floatWhere: document.getElementById("mistic-float-where"),
  floatMode: document.getElementById("mistic-float-mode"),
  activeWindow: document.getElementById("mistic-active-window"),
  sendQr: document.getElementById("mistic-send-qr"),
  sendThanks: document.getElementById("mistic-send-thanks"),
  chargeMessage: document.getElementById("mistic-charge-message"),
  qrCaption: document.getElementById("mistic-qr-caption"),
  thanksMessage: document.getElementById("mistic-thanks-message"),
  copyMessage: document.getElementById("mistic-copy-message"),
  defaultDescription: document.getElementById("mistic-default-description"),
};

// Configuração da MisticPay lida do servidor (null = ainda não carregou, então não é enviada ao salvar)
let misticConfig = null;
let clearSecret = false;
let clearAuthHeader = false;

export function renderSettingsBansList() {
  if (state.allBans.length === 0) {
    settingsBansListEl.innerHTML = emptyState({
      iconName: "ban",
      title: "Nenhum número banido",
      text: "Quando você banir alguém pelas métricas, a pessoa aparece aqui.",
    });
    return;
  }

  settingsBansListEl.innerHTML = state.allBans
    .map((b) => {
      const name = b.name || phoneFromJid(b.jid);
      return `
      <li class="stack-item">
        <div class="stack-main">
          ${avatarHtml(name, { size: "sm" })}
          <div class="stack-text" style="gap:0">
            <strong>${escapeHtml(name)}</strong>
            <span class="sub">${escapeHtml(phoneFromJid(b.jid))}</span>
          </div>
        </div>
        <button type="button" class="btn btn-secondary btn-sm unban-btn" data-jid="${escapeHtml(b.jid)}">${icon("check")} Desbanir</button>
      </li>`;
    })
    .join("");

  settingsBansListEl.querySelectorAll(".unban-btn").forEach((btn) => {
    btn.addEventListener("click", () => unbanJid(btn.dataset.jid));
  });
}

function applyAutoShutdownVisibility() {
  settingsAutoShutdownWrap.classList.toggle("hidden", !settingsAutoShutdownInput.checked);
}

/* ---------- MisticPay ---------- */

function setSettingsTab(tab) {
  document.querySelectorAll('input[name="settings-tab"]').forEach((r) => (r.checked = r.value === tab));
  generalSection.classList.toggle("hidden", tab !== "general");
  misticSection.classList.toggle("hidden", tab !== "mistic");
}

function paintSecretHints() {
  const hint = (has, cleared, what) => {
    if (cleared) return `${what} será removido ao salvar. <button type="button" class="btn btn-ghost btn-sm" data-mistic-undo="${what}">Desfazer</button>`;
    if (has) return `Já salvo neste computador — deixe vazio para manter. <button type="button" class="btn btn-ghost btn-sm" data-mistic-clear="${what}">Remover</button>`;
    return "";
  };
  mistic.secretHint.innerHTML = hint(misticConfig?.hasSecret, clearSecret, "secret");
  mistic.authHint.innerHTML = hint(misticConfig?.hasAuthHeader, clearAuthHeader, "header");
}

async function loadMisticConfig() {
  misticConfig = null;
  clearSecret = false;
  clearAuthHeader = false;
  mistic.testResult.textContent = "";
  mistic.testResult.className = "hint";

  const cfg = await api("/mistic/config");
  misticConfig = cfg;
  mistic.enabled.checked = cfg.enabled;
  mistic.clientId.value = cfg.clientId;
  mistic.clientSecret.value = "";
  mistic.clientSecret.placeholder = cfg.hasSecret ? "•••••••• (salvo)" : "cs_…";
  mistic.authHeader.value = "";
  mistic.authHeader.placeholder = cfg.hasAuthHeader ? "•••••••• (salvo)" : "Basic …";
  mistic.defaultDocument.value = formatCpf(cfg.defaultPayerDocument);
  mistic.floatWhere.value = cfg.floatWhere;
  mistic.floatMode.value = cfg.floatMode;
  mistic.activeWindow.value = cfg.activeWindowMinutes;
  mistic.sendQr.checked = cfg.sendQr;
  mistic.sendThanks.checked = cfg.sendThanks;
  // Mostra a mensagem em uso (a própria ou a padrão) pra você editar a partir dela
  mistic.chargeMessage.value = cfg.chargeMessage || cfg.defaults.chargeMessage;
  mistic.qrCaption.value = cfg.qrCaption || cfg.defaults.qrCaption;
  mistic.thanksMessage.value = cfg.thanksMessage || cfg.defaults.thanksMessage;
  mistic.copyMessage.value = cfg.copyMessage || cfg.defaults.copyMessage;
  mistic.defaultDescription.value = cfg.defaultDescription;
  paintSecretHints();
}

/** Monta o que vai pro servidor. Segredo vazio = mantém o salvo; "Remover" manda null. */
function collectMisticPayload() {
  const payload = {
    enabled: mistic.enabled.checked,
    clientId: mistic.clientId.value.trim(),
    defaultPayerDocument: mistic.defaultDocument.value.trim(),
    floatWhere: mistic.floatWhere.value,
    floatMode: mistic.floatMode.value,
    activeWindowMinutes: Math.floor(Number(mistic.activeWindow.value)) || 30,
    sendQr: mistic.sendQr.checked,
    sendThanks: mistic.sendThanks.checked,
    chargeMessage: mistic.chargeMessage.value.trim(),
    qrCaption: mistic.qrCaption.value.trim(),
    thanksMessage: mistic.thanksMessage.value.trim(),
    copyMessage: mistic.copyMessage.value.trim(),
    defaultDescription: mistic.defaultDescription.value.trim(),
  };

  const secret = mistic.clientSecret.value.trim();
  if (secret) payload.clientSecret = secret;
  else if (clearSecret) payload.clientSecret = null;

  const header = mistic.authHeader.value.trim();
  if (header) payload.authHeader = header;
  else if (clearAuthHeader) payload.authHeader = null;

  return payload;
}

/** Tem credenciais (digitadas agora ou já salvas e não removidas)? */
function willHaveCredentials() {
  const secret = mistic.clientSecret.value.trim() || (misticConfig?.hasSecret && !clearSecret);
  const header = mistic.authHeader.value.trim() || (misticConfig?.hasAuthHeader && !clearAuthHeader);
  return !!header || (!!mistic.clientId.value.trim() && !!secret);
}

async function testMistic() {
  setBusy(mistic.testBtn, true, "Testando…");
  mistic.testResult.className = "hint";
  mistic.testResult.textContent = "";
  try {
    const { info } = await api("/mistic/test", {
      method: "POST",
      body: {
        clientId: mistic.clientId.value.trim() || undefined,
        clientSecret: mistic.clientSecret.value.trim() || undefined,
        authHeader: mistic.authHeader.value.trim() || undefined,
      },
    });
    mistic.testResult.className = "hint is-ok";
    mistic.testResult.textContent = `Conectado: ${info.name || "conta MisticPay"} · saldo ${formatCurrency(info.availableBalance)}${info.accountVerified ? "" : " · conta NÃO verificada"}`;
  } catch (err) {
    mistic.testResult.className = "hint is-error";
    mistic.testResult.textContent = err.message;
  } finally {
    setBusy(mistic.testBtn, false);
  }
}

/* ---------- Abrir / salvar ---------- */

export async function openSettingsModal({ tab = "general" } = {}) {
  try {
    const settings = await api("/settings");
    settingsIgnoreAdmInput.checked = settings.ignoreAdminNames;
    settingsNoReplyNumbersInput.value = settings.noReplyNumbers.join("\n");
    settingsAutoShutdownInput.checked = !!settings.autoShutdownEnabled;
    settingsAutoShutdownMinutesInput.value = settings.autoShutdownMinutes ?? 5;
    settingsAutoShutdownMinutesInput.classList.remove("is-invalid");
    applyAutoShutdownVisibility();
  } catch (err) {
    console.error("openSettingsModal falhou:", err);
    notify.error(err.message, { title: "Não foi possível carregar as configurações" });
    return;
  }

  try {
    await loadMisticConfig();
  } catch (err) {
    console.error("loadMisticConfig falhou:", err);
    notify.warning(err.message, { title: "Não foi possível carregar a MisticPay" });
  }

  await refreshBans();
  renderSettingsBansList();
  setSettingsTab(tab);
  openModal(settingsModal);
}

export async function saveSettings() {
  const ignoreAdminNames = settingsIgnoreAdmInput.checked;
  const noReplyNumbers = settingsNoReplyNumbersInput.value
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const autoShutdownEnabled = settingsAutoShutdownInput.checked;
  const autoShutdownMinutes = Math.floor(Number(settingsAutoShutdownMinutesInput.value));

  if (autoShutdownEnabled && !(autoShutdownMinutes >= 1)) {
    setSettingsTab("general");
    return flagInvalid(settingsAutoShutdownMinutesInput, "Informe o prazo em minutos (pelo menos 1).");
  }
  if (misticConfig && mistic.enabled.checked && !willHaveCredentials()) {
    setSettingsTab("mistic");
    return flagInvalid(mistic.clientId, "Preencha o Client ID e o Client Secret (ou desligue a integração).");
  }

  setBusy(settingsSaveBtn, true, "Salvando…");
  try {
    await api("/settings", {
      method: "PUT",
      body: {
        ignoreAdminNames,
        noReplyNumbers,
        autoShutdownEnabled,
        ...(autoShutdownMinutes >= 1 ? { autoShutdownMinutes } : {}),
      },
    });
    // Só envia a MisticPay se ela foi carregada (senão um erro de leitura apagaria a configuração)
    if (misticConfig) {
      await api("/mistic/config", { method: "PUT", body: collectMisticPayload() });
      document.dispatchEvent(new CustomEvent("mistic-config-changed"));
    }
    closeModal(settingsModal);
    notify.success("As novas configurações já estão valendo.", { title: "Configurações salvas" });
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível salvar" });
  } finally {
    setBusy(settingsSaveBtn, false);
  }
}

export function initSettings() {
  settingsBtn.addEventListener("click", () => openSettingsModal());
  settingsSaveBtn.addEventListener("click", saveSettings);
  settingsAutoShutdownInput.addEventListener("change", applyAutoShutdownVisibility);
  bindModal(settingsModal, () => closeModal(settingsModal));

  document.querySelectorAll('input[name="settings-tab"]').forEach((radio) => {
    radio.addEventListener("change", () => radio.checked && setSettingsTab(radio.value));
  });

  mistic.testBtn.addEventListener("click", testMistic);

  // "Remover" / "Desfazer" dos segredos salvos
  misticSection.addEventListener("click", (e) => {
    const clear = e.target.closest("[data-mistic-clear]");
    const undo = e.target.closest("[data-mistic-undo]");
    const which = (clear ?? undo)?.dataset[clear ? "misticClear" : "misticUndo"];
    if (!which) return;
    const value = !!clear;
    if (which === "secret") clearSecret = value;
    else clearAuthHeader = value;
    paintSecretHints();
  });

  // "Restaurar padrão" das mensagens
  misticSection.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-mistic-reset]");
    if (!btn || !misticConfig) return;
    const field = { chargeMessage: mistic.chargeMessage, qrCaption: mistic.qrCaption, thanksMessage: mistic.thanksMessage, copyMessage: mistic.copyMessage }[btn.dataset.misticReset];
    field.value = misticConfig.defaults[btn.dataset.misticReset];
  });

  // O modal da MisticPay pede pra abrir as configurações já na aba dela
  document.addEventListener("open-settings", (e) => openSettingsModal({ tab: e.detail?.tab ?? "general" }));
}
