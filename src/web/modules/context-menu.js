import { icon } from "./ui.js";
import { escapeHtml } from "./utils.js";

/**
 * Menu de botão direito PRÓPRIO do painel, no lugar do menu padrão do navegador (que entregaria que
 * isto é uma tela web, com "Voltar"/"Recarregar"/"Inspecionar" do Chrome). Outros módulos registram
 * o que sabem oferecer pra um alvo (`registerContextMenuProvider`) — o primeiro que devolver uma
 * lista de itens vence; sem nenhum, cai no genérico (campo de texto) ou no mínimo (recarregar).
 */

const menuEl = document.getElementById("app-context-menu");
const providers = [];
let currentItems = [];

function closeMenu() {
  menuEl.classList.add("hidden");
  currentItems = [];
}

function openMenuAt(x, y, items) {
  if (!items.length) return;
  currentItems = items;
  menuEl.innerHTML = items
    .map((it, i) =>
      it.separator
        ? `<div class="chat-dropdown-sep" role="separator"></div>`
        : `<button type="button" data-index="${i}" class="${it.danger ? "is-danger" : ""}" ${it.disabled ? "disabled" : ""}>${it.icon ? icon(it.icon) : ""}<span>${escapeHtml(it.label)}</span></button>`
    )
    .join("");
  menuEl.classList.remove("hidden");

  // Mede DEPOIS de preencher (precisa do tamanho real) e encaixa na tela sem sair pelas bordas
  const rect = menuEl.getBoundingClientRect();
  const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4));
  menuEl.style.left = `${left}px`;
  menuEl.style.top = `${top}px`;
}

/** Cortar/copiar/colar/selecionar tudo — pra qualquer campo de texto do painel, sem precisar de nada especial. */
function textFieldItems(field) {
  const hasSelection = field.selectionStart !== field.selectionEnd;
  const isLocked = field.readOnly || field.disabled;

  const replaceSelection = async (text) => {
    const { selectionStart: start, selectionEnd: end } = field;
    field.focus();
    field.setRangeText(text, start, end, "end");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  };

  return [
    {
      label: "Cortar",
      icon: "scissors",
      disabled: isLocked || !hasSelection,
      run: async () => {
        await navigator.clipboard.writeText(field.value.slice(field.selectionStart, field.selectionEnd));
        await replaceSelection("");
      },
    },
    {
      label: "Copiar",
      icon: "copy",
      disabled: !hasSelection,
      run: () => navigator.clipboard.writeText(field.value.slice(field.selectionStart, field.selectionEnd)),
    },
    {
      label: "Colar",
      icon: "clipboard",
      disabled: isLocked,
      run: async () => {
        const text = await navigator.clipboard.readText().catch(() => null);
        if (text != null) await replaceSelection(text);
      },
    },
    { label: "Selecionar tudo", icon: "check", disabled: field.value === "", run: () => field.select() },
  ];
}

/** Visualizador de foto em tela cheia (mensagens, avatares...) — sempre a mesma imagem exibida ali. */
function lightboxItems(target) {
  const img = target.closest("#chat-lightbox-img");
  if (!img || !img.src) return null;
  return [
    {
      label: "Copiar imagem",
      icon: "copy",
      run: async () => {
        const res = await fetch(img.src);
        const blob = await res.blob();
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      },
    },
    {
      label: "Baixar imagem",
      icon: "download",
      run: () => {
        const a = document.createElement("a");
        a.href = img.src;
        a.download = "imagem";
        document.body.appendChild(a);
        a.click();
        a.remove();
      },
    },
  ];
}

function isTextField(el) {
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName !== "INPUT") return false;
  return ["text", "search", "tel", "email", "number", "url", "password", ""].includes(el.type);
}

function onContextMenu(e) {
  e.preventDefault();

  for (const provide of providers) {
    const items = provide(e.target, e);
    if (items) return openMenuAt(e.clientX, e.clientY, items);
  }

  const lightbox = lightboxItems(e.target);
  if (lightbox) return openMenuAt(e.clientX, e.clientY, lightbox);

  if (isTextField(e.target)) return openMenuAt(e.clientX, e.clientY, textFieldItems(e.target));

  openMenuAt(e.clientX, e.clientY, [{ label: "Recarregar", icon: "refresh", run: () => location.reload() }]);
}

/**
 * Registra uma função que, dado o elemento clicado, devolve uma lista de itens pra esse alvo (ou
 * null/undefined se não for da conta dela). Chamada na ordem de registro; a primeira que responder
 * vence — então registre do mais específico pro mais genérico.
 */
export function registerContextMenuProvider(provide) {
  providers.push(provide);
}

export function initContextMenu() {
  document.addEventListener("contextmenu", onContextMenu);
  menuEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-index]");
    if (btn) {
      const item = currentItems[Number(btn.dataset.index)];
      if (item && !item.disabled) item.run();
    }
    closeMenu();
  });
  document.addEventListener("click", (e) => {
    if (!menuEl.classList.contains("hidden") && !menuEl.contains(e.target)) closeMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
  });
}
