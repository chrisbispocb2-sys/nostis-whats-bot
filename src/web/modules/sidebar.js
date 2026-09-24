const SIDEBAR_WIDTH_KEY = "brinzy-sidebar-width";
const DEFAULT_SIDEBAR_WIDTH = 340;
const MIN_SIDEBAR_WIDTH = 260;
const MAX_SIDEBAR_WIDTH = 640;
const KEY_STEP = 20;

const layout = document.querySelector(".layout");
const accountRail = document.getElementById("account-rail");
const panelResizer = document.getElementById("panel-resizer");
const sidebarOpenBtn = document.getElementById("sidebar-open");
const sidebarCloseBtn = document.getElementById("sidebar-close");
const sidebarScrim = document.getElementById("sidebar-scrim");

let currentWidth = DEFAULT_SIDEBAR_WIDTH;

export function applySidebarWidth(width) {
  currentWidth = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
  document.documentElement.style.setProperty("--sidebar-width", `${currentWidth}px`);
  panelResizer.setAttribute("aria-valuenow", String(currentWidth));
  return currentWidth;
}

function saveWidth() {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(currentWidth));
  } catch {
    // localStorage indisponível (navegação anônima)
  }
}

function setDrawer(open) {
  layout.classList.toggle("sidebar-open", open);
}

export function initSidebarResizer() {
  panelResizer.setAttribute("aria-valuemin", String(MIN_SIDEBAR_WIDTH));
  panelResizer.setAttribute("aria-valuemax", String(MAX_SIDEBAR_WIDTH));

  try {
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    applySidebarWidth(saved || DEFAULT_SIDEBAR_WIDTH);
  } catch {
    applySidebarWidth(DEFAULT_SIDEBAR_WIDTH);
  }

  // Arrastar com mouse ou toque (pointer events + captura evitam "perder" o cursor)
  panelResizer.addEventListener("pointerdown", (e) => {
    panelResizer.setPointerCapture(e.pointerId);
    panelResizer.classList.add("dragging");
    document.body.style.userSelect = "none";
    e.preventDefault();
  });

  panelResizer.addEventListener("pointermove", (e) => {
    if (!panelResizer.hasPointerCapture(e.pointerId)) return;
    // A barra de contas fica à esquerda da lista de grupos: a largura da lista começa depois dela
    applySidebarWidth(e.clientX - accountRail.offsetWidth);
  });

  const stopDragging = (e) => {
    if (!panelResizer.classList.contains("dragging")) return;
    panelResizer.classList.remove("dragging");
    document.body.style.userSelect = "";
    if (panelResizer.hasPointerCapture(e.pointerId)) panelResizer.releasePointerCapture(e.pointerId);
    saveWidth();
  };
  panelResizer.addEventListener("pointerup", stopDragging);
  panelResizer.addEventListener("pointercancel", stopDragging);

  // Duplo clique restaura a largura padrão; setas ajustam pelo teclado
  panelResizer.addEventListener("dblclick", () => {
    applySidebarWidth(DEFAULT_SIDEBAR_WIDTH);
    saveWidth();
  });
  panelResizer.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    applySidebarWidth(currentWidth + (e.key === "ArrowRight" ? KEY_STEP : -KEY_STEP));
    saveWidth();
  });

  // Gaveta de grupos em telas estreitas
  sidebarOpenBtn.addEventListener("click", () => setDrawer(true));
  sidebarCloseBtn.addEventListener("click", () => setDrawer(false));
  sidebarScrim.addEventListener("click", () => setDrawer(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && layout.classList.contains("sidebar-open")) setDrawer(false);
  });
}
