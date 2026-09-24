import { state } from "./state.js";
import { api, accountUrl } from "./api.js";
import { escapeHtml, avatarHtml } from "./utils.js";
import { icon, notify, confirmDialog, emptyState } from "./ui.js";

const listEl = document.getElementById("groups-list");
const searchEl = document.getElementById("search");
const countEl = document.getElementById("groups-count");
const totalEl = document.getElementById("groups-total");
const meterEl = document.getElementById("groups-meter");
const refreshGroupsBtn = document.getElementById("refresh-groups-btn");
const selectAllGroupsBtn = document.getElementById("select-all-groups-btn");
const deselectAllGroupsBtn = document.getElementById("deselect-all-groups-btn");

const campaignGroupSearch = document.getElementById("campaign-group-search");
const campaignGroupsListEl = document.getElementById("campaign-groups-list");
const campaignGroupsCountEl = document.getElementById("campaign-groups-count");
const campaignSelectVisibleBtn = document.getElementById("campaign-select-visible");
const campaignClearGroupsBtn = document.getElementById("campaign-clear-groups");

function matchesFilter(group, filter) {
  const f = filter.trim().toLowerCase();
  return group.name.toLowerCase().includes(f) || group.jid.toLowerCase().includes(f);
}

function groupAvatar(g) {
  return avatarHtml(g.name, { pictureUrl: g.hasPicture ? accountUrl(`/groups/picture/${encodeURIComponent(g.jid)}`) : null });
}

export function updateCount() {
  const enabled = state.enabledSet.size;
  const total = state.allGroups.length;
  countEl.textContent =
    total === 0 ? "Nenhum grupo carregado" : `${enabled} de ${total} grupo(s) ativo(s)`;
  totalEl.textContent = String(total);
  meterEl.style.width = total === 0 ? "0%" : `${Math.round((enabled / total) * 100)}%`;
  selectAllGroupsBtn.disabled = total === 0 || enabled === total;
  deselectAllGroupsBtn.disabled = enabled === 0;
}

function emptyGroups(filter) {
  if (state.allGroups.length === 0) {
    return emptyState({
      iconName: "users",
      title: "Nenhum grupo carregado",
      text: "Conecte o bot ao WhatsApp e clique em atualizar para listar seus grupos.",
    });
  }
  return emptyState({ iconName: "search", title: "Nada encontrado", text: `Nenhum grupo corresponde a “${filter.trim()}”.` });
}

async function toggleGroup(jid, enabled, li, cb) {
  li.classList.toggle("is-on", enabled);
  try {
    await api("/groups/toggle", { method: "POST", body: { jid, enabled } });
    if (enabled) state.enabledSet.add(jid);
    else state.enabledSet.delete(jid);
    updateCount();
  } catch (err) {
    // desfaz a mudança visual se o servidor recusou
    cb.checked = !enabled;
    li.classList.toggle("is-on", !enabled);
    notify.error(err.message);
  }
}

export function renderGroups(filter = "") {
  const visible = state.allGroups.filter((g) => matchesFilter(g, filter));

  if (visible.length === 0) {
    listEl.innerHTML = emptyGroups(filter);
    return;
  }

  listEl.innerHTML = visible
    .map((g) => {
      const on = state.enabledSet.has(g.jid);
      const delay = state.groupDelays.get(g.jid) || 0;
      return `
      <li class="group-item ${on ? "is-on" : ""}" data-jid="${escapeHtml(g.jid)}">
        <input type="checkbox" data-jid="${escapeHtml(g.jid)}" ${on ? "checked" : ""} aria-label="Ativar ${escapeHtml(g.name)}">
        ${groupAvatar(g)}
        <div class="group-info">
          <span class="group-name" title="${escapeHtml(g.name)}">${escapeHtml(g.name)}</span>
          <label class="delay" title="Delay antes de responder nesse grupo (ms) — útil para grupos que não deixam o bot responder na hora">
            ${icon("clock")}
            <input type="number" class="group-delay-input" data-jid="${escapeHtml(g.jid)}" min="0" step="500" value="${delay}" aria-label="Delay em milissegundos">
            <span>ms</span>
          </label>
        </div>
      </li>`;
    })
    .join("");

  listEl.querySelectorAll(".group-item").forEach((li) => {
    const cb = li.querySelector('input[type="checkbox"]');

    cb.addEventListener("change", () => toggleGroup(li.dataset.jid, cb.checked, li, cb));

    // Clicar em qualquer parte da linha (menos no delay) marca/desmarca o grupo.
    li.addEventListener("click", (e) => {
      if (e.target === cb || e.target.closest(".delay")) return;
      cb.click();
    });
  });

  listEl.querySelectorAll(".group-delay-input").forEach((input) => {
    input.addEventListener("change", async (e) => {
      const jid = e.target.dataset.jid;
      const delayMs = Math.max(0, Number(e.target.value) || 0);
      e.target.value = delayMs;
      state.groupDelays.set(jid, delayMs);
      try {
        await api("/groups/delay", { method: "POST", body: { jid, delayMs } });
      } catch (err) {
        console.error("Falha ao salvar delay do grupo:", err);
        notify.error(err.message, { title: "Não foi possível salvar o delay" });
      }
    });
  });
}

export async function refreshGroups() {
  if (listEl.contains(document.activeElement)) return;
  try {
    const { groups, enabled, delays } = await api("/groups");
    state.allGroups = groups;
    state.enabledSet = new Set(enabled);
    state.groupDelays = new Map(Object.entries(delays || {}));
    renderGroups(searchEl.value);
    updateCount();
  } catch (err) {
    console.error("refreshGroups falhou:", err);
    if (state.allGroups.length === 0) renderGroups(searchEl.value);
  }
}

/* ---------- Seletor de grupos dentro do modal de campanha ---------- */

function updateCampaignCount() {
  campaignGroupsCountEl.textContent = `${state.campaignSelectedGroups.size} selecionado(s)`;
}

export function renderCampaignGroupPicker(filter = "") {
  const visible = state.allGroups.filter((g) => matchesFilter(g, filter));

  if (visible.length === 0) {
    campaignGroupsListEl.innerHTML = emptyGroups(filter);
    updateCampaignCount();
    return;
  }

  campaignGroupsListEl.innerHTML = visible
    .map((g) => {
      const on = state.campaignSelectedGroups.has(g.jid);
      return `
      <li class="group-item ${on ? "is-on" : ""}" data-jid="${escapeHtml(g.jid)}">
        <input type="checkbox" data-jid="${escapeHtml(g.jid)}" ${on ? "checked" : ""} aria-label="Selecionar ${escapeHtml(g.name)}">
        ${groupAvatar(g)}
        <div class="group-info">
          <span class="group-name" title="${escapeHtml(g.name)}">${escapeHtml(g.name)}</span>
        </div>
      </li>`;
    })
    .join("");

  campaignGroupsListEl.querySelectorAll(".group-item").forEach((li) => {
    const cb = li.querySelector('input[type="checkbox"]');
    cb.addEventListener("change", () => {
      if (cb.checked) state.campaignSelectedGroups.add(li.dataset.jid);
      else state.campaignSelectedGroups.delete(li.dataset.jid);
      li.classList.toggle("is-on", cb.checked);
      updateCampaignCount();
    });
    li.addEventListener("click", (e) => {
      if (e.target !== cb) cb.click();
    });
  });

  updateCampaignCount();
}

/* ---------- Ações em massa ---------- */

async function runBulk({ btn, url, confirmOptions, successMessage }) {
  if (!(await confirmDialog(confirmOptions))) return;

  btn.disabled = true;
  try {
    const data = await api(url, { method: "POST" });
    state.allGroups = data.groups;
    state.enabledSet = new Set(data.enabled);
    renderGroups(searchEl.value);
    notify.success(successMessage(data));
  } catch (err) {
    console.error(`${url} falhou:`, err);
    notify.error(err.message);
  } finally {
    updateCount();
  }
}

export function initGroups() {
  searchEl.addEventListener("input", () => renderGroups(searchEl.value));

  refreshGroupsBtn.addEventListener("click", async () => {
    refreshGroupsBtn.disabled = true;
    refreshGroupsBtn.classList.add("is-spinning");
    try {
      const data = await api("/groups/refresh", { method: "POST" });
      state.allGroups = data.groups;
      state.enabledSet = new Set(data.enabled);
      renderGroups(searchEl.value);
      updateCount();
      notify.success(`${data.groups.length} grupo(s) carregado(s).`, { title: "Lista atualizada" });
    } catch (err) {
      console.error("refresh de grupos falhou:", err);
      notify.error(err.message, { title: "Não foi possível atualizar" });
    } finally {
      refreshGroupsBtn.disabled = false;
      refreshGroupsBtn.classList.remove("is-spinning");
    }
  });

  selectAllGroupsBtn.addEventListener("click", () =>
    runBulk({
      btn: selectAllGroupsBtn,
      url: "/groups/select-all",
      confirmOptions: {
        title: "Ativar todos os grupos?",
        message: `O bot vai responder em todos os ${state.allGroups.length} grupos carregados.`,
        confirmText: "Ativar todos",
      },
      successMessage: (d) => `${d.enabled.length} grupo(s) ativo(s).`,
    })
  );

  deselectAllGroupsBtn.addEventListener("click", () =>
    runBulk({
      btn: deselectAllGroupsBtn,
      url: "/groups/deselect-all",
      confirmOptions: {
        title: "Desativar todos os grupos?",
        message: `Isso remove a seleção dos ${state.enabledSet.size} grupos habilitados. O bot deixa de responder neles.`,
        confirmText: "Desativar todos",
        tone: "danger",
      },
      successMessage: () => "Todos os grupos foram desativados.",
    })
  );

  campaignGroupSearch.addEventListener("input", () => renderCampaignGroupPicker(campaignGroupSearch.value));

  campaignSelectVisibleBtn.addEventListener("click", () => {
    state.allGroups
      .filter((g) => matchesFilter(g, campaignGroupSearch.value))
      .forEach((g) => state.campaignSelectedGroups.add(g.jid));
    renderCampaignGroupPicker(campaignGroupSearch.value);
  });

  campaignClearGroupsBtn.addEventListener("click", () => {
    state.campaignSelectedGroups.clear();
    renderCampaignGroupPicker(campaignGroupSearch.value);
  });
}
