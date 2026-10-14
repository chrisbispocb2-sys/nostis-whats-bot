import { escapeHtml } from "./utils.js";

/* ---------- Ícones ---------- */

export function icon(name, extraClass = "") {
  return `<svg class="icon ${extraClass}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

/* ---------- Toasts ---------- */

const TOAST_ICONS = { success: "check-circle", error: "x-circle", warning: "alert", info: "info" };
const TOAST_MS = { success: 3200, info: 3600, warning: 6000, error: 7000 };
const MAX_TOASTS = 4;

/**
 * Mostra um aviso no canto da tela. O tempo de vida é controlado pela própria
 * animação da barra de progresso (animationend), que pausa ao passar o mouse.
 */
export function toast(message, { type = "info", title = "", duration } = {}) {
  const region = document.getElementById("toast-region");
  if (!region) return;

  const key = `${type}|${title}|${message}`;
  const existing = [...region.children].find((el) => el.dataset.key === key && !el.classList.contains("leaving"));
  if (existing) {
    // Mesma mensagem repetida: reinicia a barra de tempo em vez de empilhar.
    const timer = existing.querySelector(".toast-timer");
    timer.style.animation = "none";
    void timer.offsetWidth;
    timer.style.animation = "";
    return;
  }

  const ms = duration ?? TOAST_MS[type] ?? TOAST_MS.info;
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.dataset.key = key;
  el.setAttribute("role", type === "error" || type === "warning" ? "alert" : "status");
  el.innerHTML = `
    <span class="toast-icon">${icon(TOAST_ICONS[type] || "info")}</span>
    <div class="toast-body">
      ${title ? `<strong>${escapeHtml(title)}</strong>` : ""}
      <span>${escapeHtml(message)}</span>
    </div>
    <button type="button" class="toast-close" aria-label="Fechar aviso">${icon("x")}</button>
    <span class="toast-timer" style="--ms:${ms}ms"></span>`;

  const dismiss = () => {
    if (el.classList.contains("leaving")) return;
    el.classList.add("leaving");
    const remove = () => el.remove();
    el.addEventListener("animationend", remove, { once: true });
    setTimeout(remove, 320);
  };

  el.querySelector(".toast-close").addEventListener("click", dismiss);
  el.querySelector(".toast-timer").addEventListener("animationend", dismiss);
  region.appendChild(el);

  const live = [...region.children].filter((c) => !c.classList.contains("leaving"));
  if (live.length > MAX_TOASTS) live[0].querySelector(".toast-close").click();
}

export const notify = {
  success: (message, opts) => toast(message, { ...opts, type: "success" }),
  error: (message, opts) => toast(message, { ...opts, type: "error" }),
  warning: (message, opts) => toast(message, { ...opts, type: "warning" }),
  info: (message, opts) => toast(message, { ...opts, type: "info" }),
};

/* ---------- Modais ---------- */

const modalStack = [];
const dismissHandlers = new WeakMap();
const previousFocus = new WeakMap();

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled):not([type="hidden"]):not(.sr-only), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/**
 * Liga o comportamento padrão de um modal: clicar no fundo, Esc e os botões
 * [data-close] chamam `onDismiss`. O clique no fundo só vale se o mouse também
 * foi pressionado ali (evita fechar ao soltar uma seleção de texto fora do card).
 */
export function bindModal(el, onDismiss) {
  dismissHandlers.set(el, onDismiss);

  let downOnBackdrop = false;
  el.addEventListener("mousedown", (e) => {
    downOnBackdrop = e.target === el;
  });
  el.addEventListener("click", (e) => {
    if (e.target === el && downOnBackdrop) onDismiss();
  });
  el.querySelectorAll("[data-close]").forEach((btn) => btn.addEventListener("click", onDismiss));
}

export function openModal(el) {
  if (modalStack.includes(el)) return;
  previousFocus.set(el, document.activeElement);
  el.classList.remove("hidden", "closing");
  el.style.zIndex = String(100 + modalStack.length * 10);
  modalStack.push(el);

  requestAnimationFrame(() => {
    const target =
      el.querySelector("[data-autofocus]") ||
      focusables(el).find((f) => !f.classList.contains("modal-close")) ||
      focusables(el)[0];
    target?.focus();
  });
}

export function closeModal(el, { remove = false } = {}) {
  const idx = modalStack.indexOf(el);
  if (idx === -1) return;
  modalStack.splice(idx, 1);

  el.classList.add("closing");
  const onEnd = (e) => {
    if (e.target === el) finish();
  };
  const finish = () => {
    el.removeEventListener("animationend", onEnd);
    if (!el.classList.contains("closing")) return; // reaberto no meio da animação
    el.classList.add("hidden");
    el.classList.remove("closing");
    if (remove) el.remove();
  };
  el.addEventListener("animationend", onEnd);
  setTimeout(finish, 240);

  const prev = previousFocus.get(el);
  if (prev && document.contains(prev) && typeof prev.focus === "function") prev.focus();
}

export function isModalOpen(el) {
  return modalStack.includes(el);
}

document.addEventListener("keydown", (e) => {
  const top = modalStack[modalStack.length - 1];
  if (!top) return;

  if (e.key === "Escape") {
    e.preventDefault();
    dismissHandlers.get(top)?.();
    return;
  }

  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    const submit = top.querySelector("[data-submit]:not(:disabled)");
    if (submit) {
      e.preventDefault();
      submit.click();
    }
    return;
  }

  if (e.key === "Tab") {
    const items = focusables(top);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (!top.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
});

/* ---------- Diálogos (substituem confirm() / prompt()) ---------- */

let dialogSeq = 0;

function buildDialog({ title, body, footer, tone, iconName }) {
  const id = `dialog-${++dialogSeq}`;
  const el = document.createElement("div");
  el.className = "modal hidden";
  el.setAttribute("role", "alertdialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", `${id}-title`);
  el.innerHTML = `
    <div class="modal-card modal-sm">
      <div class="dialog-body">
        <span class="dialog-icon tone-${tone}">${icon(iconName)}</span>
        <div style="flex:1;min-width:0">
          <h2 id="${id}-title">${escapeHtml(title)}</h2>
          ${body}
        </div>
      </div>
      <footer class="modal-foot">${footer}</footer>
    </div>`;
  document.body.appendChild(el);
  return el;
}

/** Pergunta sim/não. Resolve `true` se o usuário confirmar. */
export function confirmDialog({
  title,
  message = "",
  confirmText = "Confirmar",
  cancelText = "Cancelar",
  tone = "primary",
} = {}) {
  return new Promise((resolve) => {
    const danger = tone === "danger";
    const el = buildDialog({
      title,
      tone,
      iconName: danger ? "alert" : "info",
      body: message ? `<p>${escapeHtml(message)}</p>` : "",
      footer: `
        <button type="button" class="btn btn-ghost" data-act="cancel">${escapeHtml(cancelText)}</button>
        <button type="button" class="btn ${danger ? "btn-danger" : "btn-primary"}" data-act="ok">${escapeHtml(confirmText)}</button>`,
    });

    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      closeModal(el, { remove: true });
      resolve(value);
    };

    bindModal(el, () => finish(false));
    el.querySelector('[data-act="ok"]').addEventListener("click", () => finish(true));
    el.querySelector('[data-act="cancel"]').addEventListener("click", () => finish(false));
    // Em ações destrutivas o foco começa em "Cancelar" — Enter sem querer não apaga nada.
    el.querySelector(danger ? '[data-act="cancel"]' : '[data-act="ok"]').setAttribute("data-autofocus", "");
    openModal(el);
  });
}

/** Pede um texto ao usuário. Resolve a string digitada ou `null` se cancelar. */
export function promptDialog({
  title,
  message = "",
  label = "",
  value = "",
  placeholder = "",
  confirmText = "Salvar",
} = {}) {
  return new Promise((resolve) => {
    const el = buildDialog({
      title,
      tone: "primary",
      iconName: "pencil",
      body: `
        ${message ? `<p>${escapeHtml(message)}</p>` : ""}
        <div class="field">
          ${label ? `<label>${escapeHtml(label)}</label>` : ""}
          <input type="text" class="input" data-autofocus autocomplete="off" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(value)}">
        </div>`,
      footer: `
        <button type="button" class="btn btn-ghost" data-act="cancel">Cancelar</button>
        <button type="button" class="btn btn-primary" data-act="ok">${escapeHtml(confirmText)}</button>`,
    });
    const input = el.querySelector("input");

    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      closeModal(el, { remove: true });
      resolve(result);
    };
    const submit = () => {
      const text = input.value.trim();
      if (!text) return flagInvalid(input);
      finish(text);
    };

    bindModal(el, () => finish(null));
    el.querySelector('[data-act="ok"]').addEventListener("click", submit);
    el.querySelector('[data-act="cancel"]').addEventListener("click", () => finish(null));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });
    openModal(el);
    requestAnimationFrame(() => input.select());
  });
}

/* ---------- Menu suspenso genérico (dropdown) ---------- */

let openMenuEl = null;
let closeOpenMenu = null;

/**
 * Abre um menu suspenso ancorado num botão. `items`: { label, icon, danger, disabled, run }.
 * Autossuficiente (cria e remove o próprio elemento) — serve pra qualquer lugar do painel, sem
 * depender do dropdown interno do chat.
 */
export function openMenu(anchor, items) {
  closeOpenMenu?.();

  const el = document.createElement("div");
  el.className = "chat-dropdown";
  el.setAttribute("role", "menu");
  el.innerHTML = items
    .map(
      (it, i) =>
        `<button type="button" role="menuitem" data-i="${i}" class="${it.danger ? "is-danger" : ""}" ${it.disabled ? "disabled" : ""}>${it.icon ? icon(it.icon) : ""}<span>${escapeHtml(it.label)}</span></button>`
    )
    .join("");
  document.body.appendChild(el);
  openMenuEl = el;

  const rect = anchor.getBoundingClientRect();
  const menuRect = el.getBoundingClientRect();
  const top = Math.min(rect.bottom + 4, window.innerHeight - menuRect.height - 8);
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - menuRect.width - 8));
  el.style.top = `${Math.max(8, top)}px`;
  el.style.left = `${left}px`;

  const close = () => {
    document.removeEventListener("click", onDocClick, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", close);
    window.removeEventListener("scroll", close, true);
    el.remove();
    if (openMenuEl === el) openMenuEl = null;
    if (closeOpenMenu === close) closeOpenMenu = null;
  };
  closeOpenMenu = close;

  const onDocClick = (e) => {
    if (el.contains(e.target)) return;
    if (anchor.contains(e.target)) return; // o próprio botão que abriu também dispara no document
    close();
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };

  el.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-i]");
    if (!btn || btn.disabled) return;
    const item = items[Number(btn.dataset.i)];
    close();
    item?.run?.();
  });

  // Num quadro depois (senão o clique que abriu fecha na hora, por bubbling)
  requestAnimationFrame(() => {
    document.addEventListener("click", onDocClick, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
  });
}

/* ---------- Helpers de formulário / botões ---------- */

/** Marca um campo como inválido (borda vermelha + shake), foca nele e limpa ao digitar. */
export function flagInvalid(el, message) {
  el.classList.add("is-invalid");
  el.focus();
  el.addEventListener("input", () => el.classList.remove("is-invalid"), { once: true });
  if (message) toast(message, { type: "warning" });
}

/** Coloca um botão em estado de carregamento (spinner + desabilitado) e devolve uma função para reverter. */
export function setBusy(btn, busy, label) {
  if (busy) {
    if (btn.dataset.idleHtml === undefined) btn.dataset.idleHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>${label ? `<span>${escapeHtml(label)}</span>` : ""}`;
  } else {
    btn.disabled = false;
    if (btn.dataset.idleHtml !== undefined) {
      btn.innerHTML = btn.dataset.idleHtml;
      delete btn.dataset.idleHtml;
    }
  }
}

/** Contador de linhas não vazias de um textarea, atualizado enquanto digita. */
export function bindLineCounter(textarea, counterEl, singular, plural) {
  const update = () => {
    const n = textarea.value.split("\n").filter((l) => l.trim()).length;
    counterEl.textContent = `${n} ${n === 1 ? singular : plural}`;
  };
  textarea.addEventListener("input", update);
  return update;
}

export function setTabCount(id, count) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(count);
}

/** Bloco padrão de "lista vazia". `cta` = { id, label, iconName } (opcional). */
export function emptyState({ iconName = "inbox", title, text = "", cta = null }) {
  return `
    <li class="empty-state">
      <span class="empty-icon">${icon(iconName)}</span>
      <h3>${escapeHtml(title)}</h3>
      ${text ? `<p>${escapeHtml(text)}</p>` : ""}
      ${cta ? `<button type="button" class="btn btn-primary btn-sm" data-empty-cta="${cta.id}">${icon(cta.iconName || "plus")} ${escapeHtml(cta.label)}</button>` : ""}
    </li>`;
}
