export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Não foi possível carregar a imagem."));
    img.src = dataUrl;
  });
}

export async function convertImageToStickerWebp(file) {
  const dataUrl = await fileToDataUrl(file);
  const img = await loadImage(dataUrl);

  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const scale = Math.min(size / img.width, size / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.9));
  if (!blob) {
    throw new Error("Este navegador não conseguiu gerar webp. Tente pelo Chrome ou Edge.");
  }
  const b64DataUrl = await fileToDataUrl(blob);
  return { type: "sticker", dataBase64: b64DataUrl.split(",")[1], mimeType: "image/webp" };
}

export async function readImageAsMedia(file) {
  const dataUrl = await fileToDataUrl(file);
  return { type: "image", dataBase64: dataUrl.split(",")[1], mimeType: file.type || "image/jpeg" };
}

export function formatDateTime(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export function formatCurrency(value) {
  return BRL.format(value || 0);
}

export function phoneFromJid(jid) {
  return (jid || "").split("@")[0];
}

/** "5511977770000" → "+55 (11) 97777-0000". Números que não são do Brasil ficam só com o "+". */
export function formatPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return "";
  const br = digits.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return br ? `+55 (${br[1]}) ${br[2]}-${br[3]}` : `+${digits}`;
}

/** "52998224725" → "529.982.247-25" (se não tiver 11 dígitos, devolve como veio). */
export function formatCpf(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 11 ? digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4") : String(value || "");
}

/** Texto de mensagem do WhatsApp em HTML seguro: escapa tudo e mostra *negrito* como o app mostra. */
export function whatsappHtml(text) {
  return escapeHtml(text).replace(/\*([^*\n]+)\*/g, "<strong>$1</strong>");
}

/** Valor em reais como o WhatsApp vai mostrar ("R$ 25,50", com espaço comum). */
export function formatBRL(value) {
  return formatCurrency(value).replace(/ /g, " ");
}

/** Primeiro nome de "Maria Silva" (ou "" se não houver). */
export function firstName(name) {
  return String(name || "").trim().split(/\s+/)[0] || "";
}

/** "agora", "há 5 min", "há 3 h" ou a data. */
export function relativeTime(ts) {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 45) return "agora";
  if (seconds < 3600) return `há ${Math.max(1, Math.round(seconds / 60))} min`;
  if (seconds < 86400) return `há ${Math.round(seconds / 3600)} h`;
  return formatDateTime(ts);
}

/** Troca os {marcadores} de uma mensagem (igual ao que o servidor faz ao enviar). */
export function renderTemplate(template, values) {
  return String(template || "")
    .replace(/\{(\w+)\}/g, (match, key) => values[key.toLowerCase()] ?? match)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Cor do avatar estável por nome (6 gradientes roxos/rosados definidos no CSS). */
function avatarHue(text) {
  let hash = 0;
  for (const ch of String(text)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return hash % 6;
}

export function initialOf(text) {
  const first = [...String(text || "").trim()][0];
  return (first ?? "?").toUpperCase();
}

/** Avatar circular: foto real do grupo (se houver) ou inicial sobre gradiente. */
export function avatarHtml(name, { pictureUrl = null, size = "" } = {}) {
  const cls = `avatar${size ? ` avatar-${size}` : ""}`;
  const initial = `<span class="${cls}" data-h="${avatarHue(name)}">${escapeHtml(initialOf(name))}</span>`;
  if (!pictureUrl) return initial;
  // Se a foto falhar ao carregar, volta para a inicial.
  return `<img class="${cls}" data-h="${avatarHue(name)}" src="${pictureUrl}" alt="" loading="lazy" onerror="this.outerHTML=this.dataset.fallback" data-fallback="${escapeHtml(initial)}">`;
}

export function callerBadgeHtml(count) {
  if (count <= 0) return "";
  const tier = count >= 4 ? "hot" : count >= 2 ? "warm" : "cold";
  const iconName = tier === "hot" ? "flame" : "repeat";
  const title = `Já chamou ${count}x (conta de novo só depois de 2h da última chamada)`;
  return `<span class="badge caller-badge caller-badge-${tier}" title="${title}"><svg class="icon" aria-hidden="true"><use href="#i-${iconName}"/></svg>${count}x</span>`;
}
