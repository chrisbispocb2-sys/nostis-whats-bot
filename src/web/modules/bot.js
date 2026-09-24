import { state } from "./state.js";
import { api } from "./api.js";
import { icon, notify } from "./ui.js";

const statusEl = document.getElementById("status");
const statusTextEl = document.getElementById("status-text");
const toggleBtn = document.getElementById("toggle-bot");
const waStatusEl = document.getElementById("wa-status");
const waTitleEl = document.getElementById("wa-status-title");
const waSubEl = document.getElementById("wa-status-sub");
const offlineBanner = document.getElementById("offline-banner");
const guardBtn = document.getElementById("guard-btn");
const guardLabelEl = document.getElementById("guard-label");

// Só avisa do desligamento por segurança se ele foi recente (o painel pode ter ficado fechado)
const SHUTDOWN_NOTICE_WINDOW_MS = 15 * 60_000;

let botActive = null; // último estado conhecido do bot (da conta ativa)
let waConnected = null; // último estado conhecido do WhatsApp (da conta ativa)
let guard = null; // situação da segurança da conta ativa
let offline = false;
let requestInFlight = false;
let guardInFlight = false;
const shutdownNoticed = new Map(); // conta → horário do último desligamento por segurança já avisado

function activeAccount() {
  return state.accounts.find((a) => a.id === state.activeAccountId) ?? null;
}

function paintBot(active) {
  statusEl.dataset.state = active ? "on" : "off";
  statusTextEl.textContent = active ? "Ativo" : "Desligado";

  toggleBtn.dataset.mode = active ? "on" : "off";
  toggleBtn.innerHTML = active
    ? `${icon("pause")} <span>Desligar bot</span>`
    : `${icon("power")} <span>Ligar bot</span>`;
  toggleBtn.disabled = requestInFlight;
}

function paintWhatsApp(connected, needsQr) {
  const account = activeAccount();
  waTitleEl.textContent = account ? account.name : "WhatsApp";

  if (needsQr) {
    waStatusEl.dataset.state = "qr";
    waSubEl.textContent = "Leia o QR Code para conectar — clique em ⋯";
  } else if (connected) {
    waStatusEl.dataset.state = "connected";
    waSubEl.textContent = account?.phone ? `Conectado · +${account.phone}` : "Pronto para responder e enviar";
  } else {
    waStatusEl.dataset.state = "disconnected";
    waSubEl.textContent = "Desconectado — aguardando conexão";
  }
}

function paintOffline() {
  statusEl.dataset.state = "offline";
  statusTextEl.textContent = "Sem conexão";
  toggleBtn.disabled = true;
  waStatusEl.dataset.state = "disconnected";
  waTitleEl.textContent = "Painel sem conexão";
  waSubEl.textContent = "Não foi possível falar com o bot";
  guard = null;
  paintGuard();
}

/* ---------- Segurança: desliga o bot se ninguém responder no privado ---------- */

function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function paintGuard() {
  if (!guard) {
    guardBtn.disabled = true;
    guardBtn.dataset.state = "off";
    guardBtn.setAttribute("aria-pressed", "false");
    guardLabelEl.textContent = "Segurança";
    guardBtn.title = "Carregando…";
    return;
  }

  guardBtn.disabled = guardInFlight;
  guardBtn.setAttribute("aria-pressed", String(guard.enabled));

  if (!guard.enabled) {
    guardBtn.dataset.state = "off";
    guardLabelEl.textContent = "Segurança";
    guardBtn.title = `Segurança desligada. Clique para ligar: o bot desliga sozinho se chegar uma mensagem no privado e ninguém responder em ${guard.minutes} min.`;
    return;
  }

  if (guard.deadlineAt) {
    const remaining = guard.deadlineAt - Date.now();
    guardBtn.dataset.state = remaining <= 60_000 ? "urgent" : "armed";
    guardLabelEl.textContent = `Desliga em ${formatCountdown(remaining)}`;
    const waiting = guard.pending === 1 ? "1 conversa esperando" : `${guard.pending} conversas esperando`;
    guardBtn.title = `${waiting} resposta. Responda no privado para cancelar o desligamento. Clique para desligar a segurança.`;
    return;
  }

  guardBtn.dataset.state = "on";
  guardLabelEl.textContent = `Segurança · ${guard.minutes} min`;
  guardBtn.title = `Segurança ligada: se chegar uma mensagem no privado e ninguém responder em ${guard.minutes} min, o bot desliga sozinho. Clique para desligar a segurança.`;
}

function noticeAutoShutdown(accountId, lastShutdown) {
  if (!lastShutdown || shutdownNoticed.get(accountId) === lastShutdown.at) return;
  shutdownNoticed.set(accountId, lastShutdown.at);
  if (Date.now() - lastShutdown.at > SHUTDOWN_NOTICE_WINDOW_MS) return;

  const account = state.accounts.find((a) => a.id === accountId);
  const waited = guard ? ` em ${guard.minutes} min` : " a tempo";
  notify.warning(`Chegou uma mensagem no privado e ninguém respondeu${waited}. Ligue o bot de novo quando puder atender.`, {
    title: account ? `${account.name}: bot desligado por segurança` : "Bot desligado por segurança",
    duration: 15000,
  });
}

/** Ao trocar de conta: esquece o que sabia da anterior e mostra "carregando" até chegar o da nova. */
export function resetBotStatus() {
  botActive = null;
  waConnected = null;
  guard = null;

  statusEl.dataset.state = "checking";
  statusTextEl.textContent = "Carregando…";
  toggleBtn.disabled = true;
  waStatusEl.dataset.state = "checking";
  const account = activeAccount();
  waTitleEl.textContent = account ? account.name : "Verificando conexão…";
  waSubEl.textContent = "Aguarde um instante";
  paintGuard();
}

export async function refreshStatus() {
  const accountId = state.activeAccountId;
  try {
    const { active, whatsappConnected, needsQr, guard: guardStatus } = await api("/status");

    if (offline) {
      offline = false;
      offlineBanner.classList.add("hidden");
      notify.success("Conexão com o bot restabelecida.");
    }

    // Só avisa quando o estado *muda* durante o uso (não na primeira leitura).
    if (waConnected !== null && waConnected !== whatsappConnected) {
      const name = activeAccount()?.name;
      if (whatsappConnected) notify.success("O bot está online e pronto para uso.", { title: name ? `${name} conectado` : "WhatsApp conectado" });
      else notify.warning("O bot perdeu a conexão. Ele tenta reconectar sozinho; se pedir, leia o QR Code de novo.", { title: name ? `${name} desconectado` : "WhatsApp desconectado" });
    }

    botActive = active;
    waConnected = whatsappConnected;
    guard = guardStatus;
    paintBot(active);
    paintWhatsApp(whatsappConnected, needsQr);
    paintGuard();
    noticeAutoShutdown(accountId, guardStatus.lastShutdown);
  } catch (err) {
    console.error("refreshStatus falhou:", err);
    if (!offline) {
      offline = true;
      offlineBanner.classList.remove("hidden");
    }
    paintOffline();
  }
}

export function initBotControls() {
  toggleBtn.addEventListener("click", async () => {
    if (botActive === null || requestInFlight) return;
    const turningOn = !botActive;

    requestInFlight = true;
    toggleBtn.disabled = true;
    try {
      await api(turningOn ? "/on" : "/off", { method: "POST" });
      botActive = turningOn;

      if (turningOn && waConnected === false) {
        notify.warning("O bot foi ligado, mas o WhatsApp está desconectado — ele só responde depois de conectar.", { title: "Bot ligado" });
      } else if (turningOn) {
        notify.success("Agora ele responde nos grupos selecionados.", { title: "Bot ligado" });
      } else {
        notify.info("O bot parou de responder até você ligar de novo.", { title: "Bot desligado" });
      }
    } catch (err) {
      notify.error(err.message);
    } finally {
      requestInFlight = false;
      refreshStatus();
    }
  });

  guardBtn.addEventListener("click", async () => {
    if (!guard || guardInFlight) return;
    const enabled = !guard.enabled;

    guardInFlight = true;
    paintGuard();
    try {
      await api("/settings", { method: "PUT", body: { autoShutdownEnabled: enabled } });
      guard = { ...guard, enabled, pending: enabled ? guard.pending : 0, deadlineAt: enabled ? guard.deadlineAt : null };

      if (enabled) {
        notify.success(`Se chegar uma mensagem no privado e ninguém responder em ${guard.minutes} min, o bot desliga sozinho.`, { title: "Segurança ligada" });
      } else {
        notify.info("O bot não desliga mais sozinho quando ninguém responde no privado.", { title: "Segurança desligada" });
      }
    } catch (err) {
      notify.error(err.message, { title: "Não foi possível alterar a segurança" });
    } finally {
      guardInFlight = false;
      paintGuard();
      refreshStatus();
    }
  });

  // A contagem regressiva anda sozinha entre uma leitura de status e outra
  setInterval(() => {
    if (guard?.enabled && guard.deadlineAt) paintGuard();
  }, 1000);
}
