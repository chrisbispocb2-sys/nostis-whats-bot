import { state } from "./state.js";
import { api } from "./api.js";
import { escapeHtml } from "./utils.js";
import {
  icon,
  notify,
  confirmDialog,
  bindModal,
  openModal,
  closeModal,
  flagInvalid,
  setBusy,
  bindLineCounter,
  setTabCount,
  emptyState,
} from "./ui.js";

const rulesListEl = document.getElementById("rules-list");
const newRuleBtn = document.getElementById("new-rule-btn");
const ruleModal = document.getElementById("rule-modal");
const ruleModalTitle = document.getElementById("rule-modal-title");
const keywordsInput = document.getElementById("rule-keywords");
const responsesInput = document.getElementById("rule-responses");
const cooldownInput = document.getElementById("rule-cooldown");
const trackMetricsInput = document.getElementById("rule-track-metrics");
const enabledInput = document.getElementById("rule-enabled");
const ruleReplyModeWrap = document.getElementById("rule-reply-mode-wrap");
const useUrlButtonInput = document.getElementById("rule-use-url-button");
const buttonTextWrap = document.getElementById("rule-button-text-wrap");
const buttonTextInput = document.getElementById("rule-button-text");
const buttonMessageInput = document.getElementById("rule-button-message");
const greetingEnabledInput = document.getElementById("rule-greeting-enabled");
const greetingWrap = document.getElementById("rule-greeting-wrap");
const greetingMessagesInput = document.getElementById("rule-greeting-messages");
const greetingPartialInput = document.getElementById("rule-greeting-partial");
const greetingCompleteInput = document.getElementById("rule-greeting-complete");
const ruleSaveBtn = document.getElementById("rule-save");

const updateKeywordsCount = bindLineCounter(keywordsInput, document.getElementById("rule-keywords-count"), "gatilho", "gatilhos");
const updateResponsesCount = bindLineCounter(responsesInput, document.getElementById("rule-responses-count"), "resposta", "respostas");

function keywordChips(keywords) {
  const shown = keywords.slice(0, 3).map((k) => `<span class="kw-chip" title="${escapeHtml(k)}">${escapeHtml(k)}</span>`);
  if (keywords.length > 3) {
    const rest = keywords.slice(3).map(escapeHtml).join(", ");
    shown.push(`<span class="kw-chip kw-more" title="${rest}">+${keywords.length - 3}</span>`);
  }
  return shown.join("");
}

/** Linhas não vazias de um textarea (uma variação de mensagem por linha). */
function linesOf(textarea) {
  return textarea.value
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function replyModeMeta(rule) {
  if (rule.useUrlButton) return { iconName: "smartphone", label: "Botão pro privado" };
  if (rule.replyToTrigger) return { iconName: "reply", label: "Responde a mensagem" };
  return { iconName: "message", label: "Mensagem solta" };
}

export function renderRules() {
  setTabCount("rules-count", state.allRules.length);

  if (state.allRules.length === 0) {
    rulesListEl.innerHTML = emptyState({
      iconName: "message",
      title: "Nenhuma regra cadastrada",
      text: "Crie uma regra para o bot responder automaticamente quando alguém enviar uma mensagem-gatilho.",
      cta: { id: "new-rule", label: "Criar primeira regra" },
    });
    rulesListEl.querySelector("[data-empty-cta]")?.addEventListener("click", () => openRuleModal(null));
    return;
  }

  rulesListEl.innerHTML = state.allRules
    .map((r, i) => {
      const reply = replyModeMeta(r);
      const preview = r.responses[0] ?? "";
      const extra = r.responses.length > 1 ? `<span class="muted">+${r.responses.length - 1} variação(ões)</span>` : "";

      return `
      <li class="card rule-item ${r.enabled ? "" : "is-disabled"}" data-id="${r.id}" style="--i:${Math.min(i, 8)}">
        <div class="card-head">
          <div class="card-title">${keywordChips(r.keywords)}</div>
          <label class="switch" title="${r.enabled ? "Desativar regra" : "Ativar regra"}">
            <input type="checkbox" class="rule-toggle" data-id="${r.id}" ${r.enabled ? "checked" : ""} aria-label="Regra ativa">
            <span class="switch-track"></span>
            <span class="switch-label">${r.enabled ? "Ativa" : "Inativa"}</span>
          </label>
        </div>

        <div class="card-preview">${escapeHtml(preview)}${extra}</div>

        <div class="meta">
          <span class="meta-item">${icon("clock")} ${r.cooldownMinutes > 0 ? `${r.cooldownMinutes} min de cooldown` : "Sem cooldown"}</span>
          <span class="meta-item">${icon(reply.iconName)} ${reply.label}</span>
          ${r.reactionEmoji ? `<span class="meta-item">Reage ${r.reactionEmoji}</span>` : ""}
          ${r.trackMetrics ? `<span class="meta-item">${icon("chart")} Rastreando</span>` : ""}
        </div>

        <div class="card-toggle-row">
          <span class="card-toggle-text">
            <strong>${icon("message")} Saudação no privado</strong>
            <small>Pergunta os endereços a quem chama</small>
          </span>
          <label class="switch" title="${r.greetingEnabled ? "Desligar saudação no privado" : "Ligar saudação no privado"}">
            <input type="checkbox" class="rule-greeting-toggle" data-id="${r.id}" ${r.greetingEnabled ? "checked" : ""} aria-label="Saudação automática no privado">
            <span class="switch-track"></span>
            <span class="switch-label">${r.greetingEnabled ? "Ligada" : "Desligada"}</span>
          </label>
        </div>

        <div class="card-foot">
          <button type="button" class="btn btn-secondary btn-sm edit-rule" data-id="${r.id}">${icon("pencil")} Editar</button>
          <div class="card-actions end">
            <button type="button" class="icon-btn icon-btn-sm danger delete-rule" data-id="${r.id}" title="Excluir regra" aria-label="Excluir regra">${icon("trash")}</button>
          </div>
        </div>
      </li>`;
    })
    .join("");

  rulesListEl.querySelectorAll(".edit-rule").forEach((btn) => {
    btn.addEventListener("click", () => openRuleModal(btn.dataset.id));
  });
  rulesListEl.querySelectorAll(".delete-rule").forEach((btn) => {
    btn.addEventListener("click", () => deleteRule(btn.dataset.id));
  });
  rulesListEl.querySelectorAll(".rule-toggle").forEach((input) => {
    input.addEventListener("change", () => toggleRule(input.dataset.id, input));
  });
  rulesListEl.querySelectorAll(".rule-greeting-toggle").forEach((input) => {
    input.addEventListener("change", () => toggleGreeting(input.dataset.id, input));
  });
}

export async function refreshRules() {
  try {
    const { rules } = await api("/rules");
    state.allRules = rules;
    renderRules();
  } catch (err) {
    console.error("refreshRules falhou:", err);
    if (state.allRules.length === 0) {
      rulesListEl.innerHTML = emptyState({ iconName: "wifi-off", title: "Não foi possível carregar as regras", text: err.message });
    }
  }
}

/** Liga/desliga uma regra direto pelo card (atualização otimista com rollback). */
async function toggleRule(id, input) {
  const rule = state.allRules.find((r) => r.id === id);
  if (!rule) return;

  const enabled = input.checked;
  const card = input.closest(".card");
  card.classList.toggle("is-disabled", !enabled);
  card.querySelector(".switch-label").textContent = enabled ? "Ativa" : "Inativa";

  try {
    await api(`/rules/${encodeURIComponent(id)}`, { method: "PUT", body: { enabled } });
    rule.enabled = enabled;
    notify.success(enabled ? "O bot volta a responder a essa regra." : "A regra ficou salva, mas o bot não vai mais usá-la.", {
      title: enabled ? "Regra ativada" : "Regra desativada",
      duration: 2400,
    });
  } catch (err) {
    input.checked = !enabled;
    card.classList.toggle("is-disabled", enabled);
    card.querySelector(".switch-label").textContent = enabled ? "Inativa" : "Ativa";
    notify.error(err.message, { title: "Não foi possível alterar a regra" });
  }
}

/** Liga/desliga a saudação no privado direto pelo card (atualização otimista com rollback). */
async function toggleGreeting(id, input) {
  const rule = state.allRules.find((r) => r.id === id);
  if (!rule) return;

  const greetingEnabled = input.checked;
  const label = input.closest(".switch");
  const setLabel = (on) => {
    label.querySelector(".switch-label").textContent = on ? "Ligada" : "Desligada";
    label.title = on ? "Desligar saudação no privado" : "Ligar saudação no privado";
  };
  setLabel(greetingEnabled);

  try {
    await api(`/rules/${encodeURIComponent(id)}`, { method: "PUT", body: { greetingEnabled } });
    rule.greetingEnabled = greetingEnabled;
    notify.success(
      greetingEnabled
        ? "Quem chamar no grupo por essa regra recebe a saudação quando escrever no seu privado."
        : "O bot não puxa mais a conversa no privado nessa regra.",
      { title: greetingEnabled ? "Saudação ligada" : "Saudação desligada", duration: 2400 }
    );
  } catch (err) {
    input.checked = !greetingEnabled;
    setLabel(!greetingEnabled);
    notify.error(err.message, { title: "Não foi possível alterar a saudação" });
  }
}

export function openRuleModal(id) {
  state.editingRuleId = id ?? null;
  const rule = id ? state.allRules.find((r) => r.id === id) : null;

  ruleModalTitle.textContent = rule ? "Editar regra" : "Nova regra";
  ruleSaveBtn.textContent = rule ? "Salvar alterações" : "Salvar regra";
  keywordsInput.value = rule ? rule.keywords.join("\n") : "";
  responsesInput.value = rule ? rule.responses.join("\n") : "";
  cooldownInput.value = rule ? rule.cooldownMinutes : 0;
  trackMetricsInput.checked = rule ? rule.trackMetrics : false;
  enabledInput.checked = rule ? rule.enabled : true;
  [keywordsInput, responsesInput].forEach((el) => el.classList.remove("is-invalid"));

  const replyToTrigger = rule ? rule.replyToTrigger : true;
  document.querySelectorAll('input[name="rule-reply-mode"]').forEach((r) => {
    r.checked = r.value === (replyToTrigger ? "quote" : "plain");
  });

  const reactionEmoji = rule ? rule.reactionEmoji || "" : "";
  document.querySelectorAll('input[name="rule-reaction"]').forEach((r) => {
    r.checked = r.value === reactionEmoji;
  });

  useUrlButtonInput.checked = rule ? !!rule.useUrlButton : false;
  buttonTextInput.value = rule && rule.buttonText ? rule.buttonText : "";
  buttonMessageInput.value = rule && rule.buttonMessage ? rule.buttonMessage : "";
  applyUrlButtonVisibility();

  greetingEnabledInput.checked = rule ? !!rule.greetingEnabled : false;
  greetingMessagesInput.value = rule ? (rule.greetingMessages ?? []).join("\n") : "";
  greetingPartialInput.value = rule ? (rule.greetingPartialMessages ?? []).join("\n") : "";
  greetingCompleteInput.value = rule ? (rule.greetingCompleteMessages ?? []).join("\n") : "";
  applyGreetingVisibility();
  updateKeywordsCount();
  updateResponsesCount();

  openModal(ruleModal);
}

export function applyUrlButtonVisibility() {
  const usingButton = useUrlButtonInput.checked;
  buttonTextWrap.classList.toggle("hidden", !usingButton);
  ruleReplyModeWrap.classList.toggle("hidden", usingButton);
}

export function applyGreetingVisibility() {
  greetingWrap.classList.toggle("hidden", !greetingEnabledInput.checked);
}

export function closeRuleModal() {
  closeModal(ruleModal);
  state.editingRuleId = null;
}

export async function saveRule() {
  const keywords = keywordsInput.value
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const responses = responsesInput.value
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const cooldownMinutes = Math.max(0, Number(cooldownInput.value) || 0);
  const enabled = enabledInput.checked;
  const trackMetrics = trackMetricsInput.checked;
  const replyToTrigger = document.querySelector('input[name="rule-reply-mode"]:checked').value === "quote";
  const reactionEmoji = document.querySelector('input[name="rule-reaction"]:checked').value || null;
  const useUrlButton = useUrlButtonInput.checked;
  const buttonText = buttonTextInput.value.trim() || null;
  const buttonMessage = buttonMessageInput.value.trim() || null;
  const greetingEnabled = greetingEnabledInput.checked;
  const greetingMessages = linesOf(greetingMessagesInput);
  const greetingPartialMessages = linesOf(greetingPartialInput);
  const greetingCompleteMessages = linesOf(greetingCompleteInput);

  if (keywords.length === 0) return flagInvalid(keywordsInput, "Informe ao menos uma mensagem-gatilho.");
  if (responses.length === 0) return flagInvalid(responsesInput, "Informe ao menos uma resposta.");

  const payload = {
    keywords,
    responses,
    cooldownMinutes,
    replyToTrigger,
    reactionEmoji,
    trackMetrics,
    useUrlButton,
    buttonText,
    buttonMessage,
    greetingEnabled,
    greetingMessages,
    greetingPartialMessages,
    greetingCompleteMessages,
    enabled,
  };
  const editing = !!state.editingRuleId;

  setBusy(ruleSaveBtn, true, "Salvando…");
  try {
    await api(editing ? `/rules/${encodeURIComponent(state.editingRuleId)}` : "/rules", {
      method: editing ? "PUT" : "POST",
      body: payload,
    });

    closeRuleModal();
    await refreshRules();
    notify.success(editing ? "Alterações salvas." : "A nova regra já está valendo.", { title: editing ? "Regra atualizada" : "Regra criada" });
  } catch (err) {
    console.error("saveRule falhou:", err);
    notify.error(err.message, { title: "Não foi possível salvar a regra" });
  } finally {
    setBusy(ruleSaveBtn, false);
  }
}

export async function deleteRule(id) {
  const rule = state.allRules.find((r) => r.id === id);
  const confirmed = await confirmDialog({
    title: "Excluir esta regra?",
    message: rule ? `Gatilhos: ${rule.keywords.slice(0, 3).join(", ")}${rule.keywords.length > 3 ? "…" : ""}\nEssa ação não pode ser desfeita.` : "Essa ação não pode ser desfeita.",
    confirmText: "Excluir regra",
    tone: "danger",
  });
  if (!confirmed) return;

  try {
    await api(`/rules/${encodeURIComponent(id)}`, { method: "DELETE" });
    notify.success("A regra foi removida.", { title: "Regra excluída" });
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível excluir" });
  }
  refreshRules();
}

export function initRules() {
  useUrlButtonInput.addEventListener("change", applyUrlButtonVisibility);
  greetingEnabledInput.addEventListener("change", applyGreetingVisibility);
  newRuleBtn.addEventListener("click", () => openRuleModal(null));
  ruleSaveBtn.addEventListener("click", saveRule);
  bindModal(ruleModal, closeRuleModal);
}
