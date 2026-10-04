import { refreshStatus, initBotControls, resetBotStatus } from "./modules/bot.js";
import { initAccounts, loadAccounts, refreshAccounts } from "./modules/accounts.js";
import { initPay, openPayModal, refreshPay, resetPay } from "./modules/pay.js";
import { state } from "./modules/state.js";
import { refreshGroups, initGroups } from "./modules/groups.js";
import { refreshRules, initRules } from "./modules/rules.js";
import { refreshCampaigns, initCampaigns } from "./modules/campaigns.js";
import { initStickers } from "./modules/stickers.js";
import { refreshLeads, initMetrics, resetMetrics } from "./modules/metrics.js";
import { refreshProfiles, initProfiles } from "./modules/profiles.js";
import { initSettings } from "./modules/settings.js";
import { initSidebarResizer } from "./modules/sidebar.js";
import { refreshChat, initChat, resetChat } from "./modules/chat.js";
import { initContextMenu } from "./modules/context-menu.js";
import { guardAuth, initAccessControl, applyFeatureLocks, refreshUsersIfAdmin } from "./modules/auth.js";
import { setPayToken } from "./modules/api.js";

/* ---------- Abas (Regras / Propaganda / Métricas) ---------- */

const TAB_KEY = "brinzy-active-tab";
const tabsEl = document.querySelector(".tabs");
const tabIndicator = document.querySelector(".tab-indicator");
const tabBtns = [...document.querySelectorAll(".tab-btn")];
const tabPanels = document.querySelectorAll(".tab-panel");

function moveTabIndicator() {
  const active = tabBtns.find((b) => b.classList.contains("active"));
  if (!active) return;
  tabIndicator.style.width = `${active.offsetWidth}px`;
  tabIndicator.style.transform = `translateX(${active.offsetLeft}px)`;
}

function selectTab(btn, { focus = false } = {}) {
  tabBtns.forEach((b) => {
    const isActive = b === btn;
    b.classList.toggle("active", isActive);
    b.setAttribute("aria-selected", String(isActive));
    b.tabIndex = isActive ? 0 : -1;
  });
  tabPanels.forEach((p) => p.classList.toggle("hidden", p.id !== btn.dataset.tab));
  moveTabIndicator();
  btn.scrollIntoView({ block: "nearest", inline: "nearest" });
  if (focus) btn.focus();
  try {
    localStorage.setItem(TAB_KEY, btn.dataset.tab);
  } catch {
    // localStorage indisponível
  }
}

tabBtns.forEach((btn) => {
  btn.addEventListener("click", () => selectTab(btn));
});

// A aba de Administração começa escondida (só admin) e só é revelada depois do login — ignora
// abas escondidas na navegação e na restauração, senão a pessoa pode cair numa aba invisível.
function visibleTabs() {
  return tabBtns.filter((b) => !b.classList.contains("hidden"));
}

// Setas esquerda/direita, Home e End navegam entre as abas (padrão WAI-ARIA)
tabsEl.addEventListener("keydown", (e) => {
  const visible = visibleTabs();
  const idx = visible.indexOf(document.activeElement);
  if (idx === -1) return;
  let next = null;
  if (e.key === "ArrowRight") next = visible[(idx + 1) % visible.length];
  else if (e.key === "ArrowLeft") next = visible[(idx - 1 + visible.length) % visible.length];
  else if (e.key === "Home") next = visible[0];
  else if (e.key === "End") next = visible[visible.length - 1];
  if (!next) return;
  e.preventDefault();
  selectTab(next, { focus: true });
});

let savedTab = null;
try {
  savedTab = localStorage.getItem(TAB_KEY);
} catch {
  // localStorage indisponível
}
selectTab(visibleTabs().find((b) => b.dataset.tab === savedTab) ?? visibleTabs()[0]);
window.addEventListener("resize", moveTabIndicator);
if (document.fonts?.ready) document.fonts.ready.then(moveTabIndicator);
// Os contadores das abas mudam de largura depois do carregamento inicial
new ResizeObserver(moveTabIndicator).observe(tabsEl);

/* ---------- Conta de WhatsApp ativa ---------- */

/** Recarrega tudo da conta ativa: ao abrir o painel e sempre que o usuário troca de conta. */
function refreshAll() {
  resetBotStatus();
  resetPay();
  resetMetrics();
  resetChat();
  return Promise.all([
    refreshStatus(),
    refreshGroups(),
    refreshRules(),
    refreshCampaigns(),
    refreshLeads(),
    refreshProfiles(),
    refreshPay(),
    refreshChat(),
  ]);
}

/* ---------- Painel completo ou janela de pagamento ---------- */

// A janela de pagamento (aberta pelo botão solto na tela) é este mesmo painel em "modo pagamento":
// só o modal da MisticPay, ocupando a janela toda.
const params = new URLSearchParams(location.search);

function startPayWindow() {
  document.body.classList.add("pay-only");
  // O botão solto na tela encontra a janela por este título
  document.title = "Brinzy MisticPay - Cobrar";
  state.activeAccountId = params.get("account");
  // Perfil de navegador isolado (sem o cookie de sessão do painel principal): o pay-token do
  // servidor autoriza só esta conta, por um tempo curto — ver AuthService.issuePayToken.
  setPayToken(params.get("token"));

  initPay({ standalone: true });
  refreshPay().then(openPayModal);
  setInterval(refreshPay, 3000);
}

function startPanel() {
  /* ---------- Módulos ---------- */

  initAccounts(refreshAll);
  initBotControls();
  initGroups();
  initRules();
  initCampaigns();
  initStickers();
  initMetrics();
  initProfiles();
  initSettings();
  initPay();
  initChat();
  initSidebarResizer();
  initAccessControl();
  applyFeatureLocks();

  /* ---------- Carga inicial ---------- */

  (async function start() {
    try {
      await loadAccounts();
    } catch (err) {
      // Sem resposta do programa: o aviso de "sem conexão" aparece sozinho e a
      // leitura periódica das contas retoma daqui quando ele voltar.
      console.error("loadAccounts falhou:", err);
    }
    refreshAll();
  })();

  /* ---------- Polling em segundo plano (pausa com a aba escondida) ---------- */

  function every(ms, fn) {
    setInterval(() => {
      if (!document.hidden) fn();
    }, ms);
  }

  every(2000, refreshStatus);
  every(3000, refreshAccounts);
  every(3000, refreshPay);
  // Conversas: tem seu próprio ciclo (mais rápido sem WebSocket, mais espaçado quando ele está ligado)
  every(10000, refreshGroups);
  every(5000, refreshLeads); // as métricas acompanham os pagamentos sozinhas
  every(20000, refreshUsersIfAdmin); // "quem está online" no painel de administração

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      refreshStatus();
      refreshAccounts();
      refreshPay();
      refreshChat();
      refreshGroups();
      refreshLeads();
      refreshUsersIfAdmin();
    }
  });
}

(async function boot() {
  // A janela de pagamento se autentica pelo pay-token (perfil de navegador isolado, sem cookie de
  // sessão) — não passa pela tela de login, que exigiria logar de novo toda vez que ela abre.
  if (params.get("pay") === "1") {
    startPayWindow();
    return;
  }

  const { blocked } = await guardAuth();
  if (blocked) return;

  initContextMenu();
  startPanel();
})();