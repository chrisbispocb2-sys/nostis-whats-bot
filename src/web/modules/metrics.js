import { state } from "./state.js";
import { api } from "./api.js";
import { escapeHtml, formatDateTime, formatCurrency, phoneFromJid, callerBadgeHtml, avatarHtml } from "./utils.js";
import { renderSettingsBansList } from "./settings.js";
import { icon, notify, confirmDialog, isModalOpen, setTabCount } from "./ui.js";

const metricsSearchEl = document.getElementById("metrics-search");
const metricsTbodyEl = document.getElementById("metrics-tbody");
const metricsPaginationEl = document.getElementById("metrics-pagination");
const settingsModal = document.getElementById("settings-modal");

const statTotalEl = document.getElementById("stat-total");
const statPrivateEl = document.getElementById("stat-private");
const statPrivateLabelEl = document.getElementById("stat-private-label");
const statClosedEl = document.getElementById("stat-closed");
const statRevenueEl = document.getElementById("stat-revenue");
const statReceivedCardEl = document.getElementById("stat-received-card");
const statReceivedEl = document.getElementById("stat-received");
const statReceivedLabelEl = document.getElementById("stat-received-label");
const statReceivedSubEl = document.getElementById("stat-received-sub");

// Bloqueados e contagem de chamadas mudam pouco: relidos no máximo neste intervalo (as corridas, a cada ciclo)
const AUX_REFRESH_MS = 15_000;

let payments = null; // /leads → quanto entrou pela MisticPay hoje e no mês
let paidLeadIds = null; // corridas já pagas na última leitura (null = ainda não leu: a primeira carga não avisa nada)
let drawnRows = new Map(); // id da corrida → HTML da linha desenhada (só refaz a linha que mudou)
let lastAuxAt = 0;

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/** Atualiza um número do resumo com uma contagem animada (só quando o valor muda). */
function setStat(el, value, format = (n) => String(Math.round(n))) {
  const from = Number(el.dataset.value ?? 0);
  if (from === value && el.dataset.value !== undefined) return;
  el.dataset.value = String(value);

  if (reduceMotion.matches || from === value) {
    el.textContent = format(value);
    return;
  }

  const start = performance.now();
  const duration = 520;
  const step = () => {
    // Usa sempre o mesmo relógio do início (performance.now): o horário que o navegador entrega ao quadro
    // pode ser um pouco anterior (ou defasado) e fazia o número passar por valores negativos ou travar no começo
    const t = Math.max(0, Math.min(1, (performance.now() - start) / duration));
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = format(from + (value - from) * eased);
    if (t < 1 && Number(el.dataset.value) === value) requestAnimationFrame(step);
    else el.textContent = format(Number(el.dataset.value));
  };
  requestAnimationFrame(step);
}

export function renderMetricsSummary(leads) {
  const total = leads.length;
  const calledPrivately = leads.filter((l) => l.privateContactAt).length;
  const closed = leads.filter((l) => l.status === "closed");
  const conversionPct = total > 0 ? Math.round((calledPrivately / total) * 100) : 0;
  const revenue = closed.reduce((sum, l) => sum + (l.value || 0), 0);

  setStat(statTotalEl, total);
  setStat(statPrivateEl, calledPrivately);
  statPrivateLabelEl.textContent = `Chamaram no privado · ${conversionPct}%`;
  setStat(statClosedEl, closed.length);
  setStat(statRevenueEl, revenue, formatCurrency);
  renderPayments();
}

/** Cartão "Recebido hoje": dinheiro que entrou pela MisticPay, com ou sem corrida nas métricas. */
function renderPayments() {
  const show = !!payments && (payments.enabled || payments.monthCount > 0);
  statReceivedCardEl.classList.toggle("hidden", !show);
  if (!show) return;

  setStat(statReceivedEl, payments.todayCents / 100, formatCurrency);
  const n = payments.todayCount;
  statReceivedLabelEl.textContent = "Recebido hoje";
  statReceivedSubEl.textContent = `${n} pagamento${n === 1 ? "" : "s"} · mês ${formatCurrency(payments.monthCents / 100)}`;
}

function emptyRow(title, text) {
  return `
    <tr><td colspan="7">
      <div class="empty-state">
        <span class="empty-icon">${icon("chart")}</span>
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(text)}</p>
      </div>
    </td></tr>`;
}

function rowHtml(l, bannedSet, callerCountByJid) {
  const isBanned = bannedSet.has(l.callerJid);
  const callCount = callerCountByJid.get(l.callerJid) || 0;
  const name = l.callerName || phoneFromJid(l.callerJid);
  const person = `
    <div class="person">
      ${avatarHtml(name, { size: "sm" })}
      <div>
        <div class="person-name">${escapeHtml(name)}</div>
        <div class="person-sub"><span>${escapeHtml(phoneFromJid(l.callerJid))}</span>${isBanned ? '<span class="badge badge-danger">Banido</span>' : ""}${callerBadgeHtml(callCount)}</div>
      </div>
    </div>`;
  const privateContact = l.privateContactAt
    ? `<span class="when">${icon("check")} ${formatDateTime(l.privateContactAt)}</span>`
    : `<span class="chip-muted">${icon("clock")} Ainda não</span>`;
  const banBtn = isBanned
    ? `<button type="button" class="icon-btn icon-btn-sm is-banned unban-lead" data-jid="${escapeHtml(l.callerJid)}" title="Pessoa banida — clique para desbanir" aria-label="Desbanir esta pessoa">${icon("ban")}</button>`
    : `<button type="button" class="icon-btn icon-btn-sm ghost danger ban-lead" data-id="${l.id}" title="Banir esta pessoa" aria-label="Banir esta pessoa">${icon("ban")}</button>`;
  // Preenchido sozinho quando o pagamento da MisticPay dessa corrida foi confirmado
  const paidBadge = l.chargeId
    ? `<span class="badge badge-success lead-paid" title="Pagamento confirmado pela MisticPay${l.paidAt ? ` em ${formatDateTime(l.paidAt)}` : ""}">${icon("check")} Pago · MisticPay</span>`
    : "";

  return `
  <tr data-id="${l.id}">
    <td class="wrap">${escapeHtml(l.groupName)}</td>
    <td>${person}</td>
    <td>${formatDateTime(l.triggeredAt)}</td>
    <td>${privateContact}</td>
    <td>
      <div class="lead-value-cell">
        <span class="money"><span>R$</span><input type="number" class="input lead-value" min="0" step="0.01" value="${l.value ?? ""}" placeholder="0,00" aria-label="Valor da corrida"></span>
        ${paidBadge}
      </div>
    </td>
    <td>
      <select class="select lead-status" data-status="${l.status}" aria-label="Status">
        <option value="pending" ${l.status === "pending" ? "selected" : ""}>Pendente</option>
        <option value="closed" ${l.status === "closed" ? "selected" : ""}>Fechou</option>
        <option value="not_closed" ${l.status === "not_closed" ? "selected" : ""}>Não fechou</option>
      </select>
    </td>
    <td>
      <div class="row-actions">
        ${banBtn}
        <button type="button" class="icon-btn icon-btn-sm ghost danger delete-lead" data-id="${l.id}" title="Excluir registro" aria-label="Excluir registro">${icon("trash")}</button>
      </div>
    </td>
  </tr>`;
}

function rowElement(id) {
  return metricsTbodyEl.querySelector(`tr[data-id="${CSS.escape(id)}"]`);
}

function flashRow(row) {
  if (!row) return;
  row.classList.remove("row-flash");
  void row.offsetWidth;
  row.classList.add("row-flash");
}

/**
 * Desenha as linhas da página. Se são as mesmas corridas na mesma ordem, só refaz as linhas cujo
 * conteúdo mudou (e nunca a que você está editando): assim a tabela pode atualizar sozinha a cada
 * poucos segundos sem piscar, sem fechar o seletor aberto e sem perder o que você está digitando.
 */
function syncRows(pageItems, bannedSet, callerCountByJid) {
  const html = new Map(pageItems.map((l) => [l.id, rowHtml(l, bannedSet, callerCountByJid)]));
  const layout = pageItems.map((l) => l.id).join("|");

  if (metricsTbodyEl.dataset.layout !== layout || !metricsTbodyEl.querySelector("tr[data-id]")) {
    metricsTbodyEl.innerHTML = pageItems.map((l) => html.get(l.id)).join("");
    metricsTbodyEl.dataset.layout = layout;
    drawnRows = html;
    return;
  }

  for (const l of pageItems) {
    const next = html.get(l.id);
    if (drawnRows.get(l.id) === next) continue;
    const row = rowElement(l.id);
    if (!row || row.contains(document.activeElement)) continue; // em edição: fica para o próximo ciclo

    const holder = document.createElement("template");
    holder.innerHTML = next.trim();
    row.replaceWith(holder.content.firstElementChild);
    drawnRows.set(l.id, next);
  }
}

function clearRows() {
  delete metricsTbodyEl.dataset.layout;
  drawnRows = new Map();
}

/** Corridas que acabaram de ser pagas (pela MisticPay) desde a última leitura: pisca a linha e avisa. */
function announceNewPayments() {
  const paidNow = new Set(state.allLeads.filter((l) => l.chargeId).map((l) => l.id));
  if (paidLeadIds) {
    for (const l of state.allLeads) {
      if (!l.chargeId || paidLeadIds.has(l.id)) continue;
      const who = l.callerName || phoneFromJid(l.callerJid);
      notify.success(`${who}: corrida fechada por ${formatCurrency(l.paidAmount ?? l.value ?? 0)}. Valor e status já foram preenchidos.`, {
        title: "Métricas atualizadas",
        duration: 6000,
      });
      flashRow(rowElement(l.id));
    }
  }
  paidLeadIds = paidNow;
}

export function renderMetricsTable(filter = "") {
  const f = filter.trim().toLowerCase();
  const visible = state.allLeads.filter(
    (l) =>
      l.groupName.toLowerCase().includes(f) ||
      (l.callerName || "").toLowerCase().includes(f) ||
      phoneFromJid(l.callerJid).includes(f)
  );

  renderMetricsSummary(state.allLeads);
  setTabCount("metrics-count", state.allLeads.length);

  if (visible.length === 0) {
    clearRows();
    metricsTbodyEl.innerHTML =
      state.allLeads.length === 0
        ? emptyRow("Nenhum gatilho rastreado ainda", "Ative “Rastrear métricas” em uma regra para começar a acompanhar quem chama.")
        : emptyRow("Nada encontrado", "Nenhum registro corresponde ao filtro digitado.");
    renderMetricsPagination(0);
    return;
  }

  const totalPages = Math.max(1, Math.ceil(visible.length / state.metricsPageSize));
  if (state.metricsPage > totalPages) state.metricsPage = totalPages;
  if (state.metricsPage < 1) state.metricsPage = 1;
  const pageItems = visible.slice(
    (state.metricsPage - 1) * state.metricsPageSize,
    state.metricsPage * state.metricsPageSize
  );

  const bannedSet = new Set(state.allBans.map((b) => b.jid));
  const callerCountByJid = new Map(state.allCallers.map((c) => [c.jid, c.count]));
  syncRows(pageItems, bannedSet, callerCountByJid);
  renderMetricsPagination(visible.length);
}
export function renderMetricsPagination(totalItems) {
  if (totalItems === 0) {
    metricsPaginationEl.innerHTML = "";
    return;
  }

  const totalPages = Math.max(1, Math.ceil(totalItems / state.metricsPageSize));

  metricsPaginationEl.innerHTML = `
    <button id="metrics-prev-page" type="button" class="btn btn-sm" ${state.metricsPage <= 1 ? "disabled" : ""}>${icon("chevron-left")} Anterior</button>
    <span class="page-info">Página ${state.metricsPage} de ${totalPages} · ${totalItems} registro${totalItems === 1 ? "" : "s"}</span>
    <button id="metrics-next-page" type="button" class="btn btn-sm" ${state.metricsPage >= totalPages ? "disabled" : ""}>Próxima ${icon("chevron-right")}</button>
  `;

  document.getElementById("metrics-prev-page").addEventListener("click", () => {
    if (state.metricsPage <= 1) return;
    state.metricsPage -= 1;
    renderMetricsTable(metricsSearchEl.value);
  });
  document.getElementById("metrics-next-page").addEventListener("click", () => {
    if (state.metricsPage >= totalPages) return;
    state.metricsPage += 1;
    renderMetricsTable(metricsSearchEl.value);
  });
}

export async function banLead(id) {
  const lead = state.allLeads.find((l) => l.id === id);
  if (!lead) return;
  const label = lead.callerName || phoneFromJid(lead.callerJid);

  const confirmed = await confirmDialog({
    title: `Banir ${label}?`,
    message: "O bot vai ignorar essa pessoa nos grupos e avisar se ela chamar no privado.",
    confirmText: "Banir",
    tone: "danger",
  });
  if (!confirmed) return;

  try {
    await api(`/leads/${encodeURIComponent(id)}/ban`, { method: "POST" });
    await refreshBans();
    renderMetricsTable(metricsSearchEl.value);
    notify.success(`${label} não será mais respondido pelo bot.`, { title: "Pessoa banida" });
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível banir" });
  }
}

export async function unbanJid(jid) {
  const confirmed = await confirmDialog({
    title: "Remover o banimento?",
    message: "O bot volta a responder esse número normalmente.",
    confirmText: "Desbanir",
  });
  if (!confirmed) return;

  try {
    await api(`/bans/${encodeURIComponent(jid)}`, { method: "DELETE" });
    await refreshBans();
    renderMetricsTable(metricsSearchEl.value);
    if (isModalOpen(settingsModal)) renderSettingsBansList();
    notify.success("O número foi desbanido.", { title: "Banimento removido" });
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível desbanir" });
  }
}

export async function refreshBans() {
  try {
    const { bans } = await api("/bans");
    state.allBans = bans;
  } catch (err) {
    console.error("refreshBans falhou:", err);
  }
}

export async function refreshCallers() {
  try {
    const { callers } = await api("/callers");
    state.allCallers = callers;
  } catch (err) {
    console.error("refreshCallers falhou:", err);
  }
}

export async function updateLead(id, patch, row) {
  try {
    const data = await api(`/leads/${encodeURIComponent(id)}`, { method: "PUT", body: patch });

    const lead = state.allLeads.find((l) => l.id === id);
    if (lead) Object.assign(lead, data.lead);
    renderMetricsSummary(state.allLeads);

    flashRow(row);
    notify.success("Registro atualizado.", { duration: 1800 });
  } catch (err) {
    console.error("updateLead falhou:", err);
    notify.error(err.message, { title: "Não foi possível salvar" });
    refreshLeads();
  }
}

export async function deleteLead(id) {
  const confirmed = await confirmDialog({
    title: "Excluir este registro?",
    message: "O registro de métricas será removido. Essa ação não pode ser desfeita.",
    confirmText: "Excluir registro",
    tone: "danger",
  });
  if (!confirmed) return;

  try {
    await api(`/leads/${encodeURIComponent(id)}`, { method: "DELETE" });
    state.allLeads = state.allLeads.filter((l) => l.id !== id);
    renderMetricsTable(metricsSearchEl.value);
    notify.success("O registro foi removido.", { title: "Registro excluído" });
  } catch (err) {
    notify.error(err.message, { title: "Não foi possível excluir" });
  }
}

export async function refreshLeads() {
  try {
    const data = await api("/leads");
    state.allLeads = data.leads;
    payments = data.payments ?? null;

    // Bloqueados e contagem de chamadas: só de tempos em tempos (as corridas, sempre)
    if (Date.now() - lastAuxAt >= AUX_REFRESH_MS) {
      lastAuxAt = Date.now();
      await Promise.all([refreshBans(), refreshCallers()]);
    }
    renderMetricsTable(metricsSearchEl.value);
    announceNewPayments();
  } catch (err) {
    console.error("refreshLeads falhou:", err);
    if (state.allLeads.length === 0) metricsTbodyEl.innerHTML = emptyRow("Não foi possível carregar as métricas", err.message);
  }
}

/** Esquece tudo da conta anterior (chamado ao trocar de conta). */
export function resetMetrics() {
  payments = null;
  paidLeadIds = null;
  lastAuxAt = 0;
  clearRows();
  renderPayments();
}

export function initMetrics() {
  metricsSearchEl.addEventListener("input", () => {
    state.metricsPage = 1;
    renderMetricsTable(metricsSearchEl.value);
  });

  // Um único par de ouvintes na tabela (as linhas são refeitas individualmente, então nada é ligado linha a linha)
  metricsTbodyEl.addEventListener("change", (e) => {
    const row = e.target.closest("tr[data-id]");
    if (!row) return;
    if (e.target.matches(".lead-value")) {
      const value = e.target.value === "" ? null : Math.max(0, Number(e.target.value) || 0);
      updateLead(row.dataset.id, { value }, row);
    } else if (e.target.matches(".lead-status")) {
      e.target.dataset.status = e.target.value;
      updateLead(row.dataset.id, { status: e.target.value }, row);
    }
  });

  metricsTbodyEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    if (btn.matches(".delete-lead")) deleteLead(btn.dataset.id);
    else if (btn.matches(".ban-lead")) banLead(btn.dataset.id);
    else if (btn.matches(".unban-lead")) unbanJid(btn.dataset.jid);
  });

  // Um pagamento acabou de cair: relê as corridas já (o preenchimento automático acontece no mesmo instante no servidor)
  document.addEventListener("mistic-payment-confirmed", () => refreshLeads());
}