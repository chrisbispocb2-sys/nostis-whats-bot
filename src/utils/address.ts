export type AddressLevel = "none" | "partial" | "complete";

export interface AddressAnalysis {
  level: AddressLevel;
  /** Quantos endereços (texto + localizações) foram reconhecidos. */
  count: number;
}

export interface AddressInput {
  /** Textos que o cliente mandou (uma mensagem por item). */
  texts: string[];
  /** Quantas localizações (pin do WhatsApp) ele mandou. */
  locations?: number;
  /** Áudio, foto, etc.: pode ter os endereços, mas o bot não consegue ler. */
  hasOpaqueMedia?: boolean;
}

const STREET_RE = new RegExp(
  "\\b(?:(?:rua|avenida|av|travessa|alameda|praca|rodovia|estrada|beco|viela|largo)\\b\\.?|(?:r|tv|al|rod|estr)\\.)\\s*[a-z0-9]",
  "g"
);
const AREA_RE =
  /\b(?:bairro|quadra|conjunto|condominio|residencial|loteamento|jardim|parque|setor|vila|lote|qd|cj|jd|pq)\b\.?\s*[a-z0-9]/;
const CEP_RE = /\b\d{5}-?\d{3}\b/;
const LABEL_RE =
  /\b(?:origem|destino|partida|chegada|embarque|desembarque|retirada|endereco|local)\s*[:\-]\s*\S{2,}/g;
const CORNER_RE = /\b(?:esquina|cruzamento)\b/;

// Pontos de referência que as pessoas citam no lugar de um endereço completo.
const PLACE_WORDS = new Set([
  "shopping", "hospital", "rodoviaria", "aeroporto", "terminal", "mercado", "supermercado",
  "escola", "colegio", "faculdade", "universidade", "upa", "posto", "igreja", "hotel", "clinica",
  "prefeitura", "forum", "delegacia", "estacao", "metro", "praia", "academia", "centro",
  "maternidade", "cemiterio", "estadio", "ginasio", "fabrica",
]);
// Passou disso já é conversa, não um endereço solto ("preciso ir ao centro amanhã cedo, tem carro?").
const MAX_PLACE_WORDS = 6;

// "Rua A para Rua B", "de A até B", "A -> B", "A x B" e quebras de linha separam endereços.
const SEGMENT_SPLIT_RE = /\s+(?:para|pra|pro|ate|x)\s+|\s*(?:->|=>|→|>|;)\s*/;

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function countMatches(re: RegExp, text: string): number {
  return text.match(re)?.length ?? 0;
}

function isPlace(segment: string): boolean {
  const words = segment.split(/\s+/).map((w) => w.replace(/[^a-z0-9]/g, "")).filter(Boolean);
  return words.length <= MAX_PLACE_WORDS && words.some((w) => PLACE_WORDS.has(w));
}

/** Quantos endereços um trecho (já sem separadores) representa: 0, 1 ou 2. */
function segmentCount(segment: string): number {
  const streets = countMatches(STREET_RE, segment);
  if (streets > 0) return CORNER_RE.test(segment) ? 1 : Math.min(streets, 2);
  if (CEP_RE.test(segment) || AREA_RE.test(segment) || isPlace(segment)) return 1;
  return 0;
}

/**
 * Descobre, de forma heurística, quantos endereços o cliente já mandou, pra o
 * bot saber se ainda precisa perguntar. É propositalmente conservadora: na
 * dúvida devolve menos endereços, porque perguntar de novo incomoda menos do
 * que o bot fingir que recebeu um endereço que nunca veio.
 */
export function analyzeAddresses(input: AddressInput): AddressAnalysis {
  const seen = new Set<string>();
  let count = input.locations ?? 0;

  for (const text of input.texts) {
    for (const rawLine of normalize(text).split("\n")) {
      const line = rawLine.replace(/\s+/g, " ").trim();
      if (!line) continue;

      // "Origem: ... / Destino: ..." — cada rótulo com conteúdo é um endereço
      const labels = countMatches(LABEL_RE, line);
      if (labels > 0) {
        if (!seen.has(line)) {
          seen.add(line);
          count += labels;
        }
        continue;
      }

      for (const segment of line.split(SEGMENT_SPLIT_RE)) {
        const trimmed = segment.trim();
        // O mesmo endereço repetido (ou reenviado) não conta duas vezes
        if (!trimmed || seen.has(trimmed)) continue;
        const found = segmentCount(trimmed);
        if (found > 0) {
          seen.add(trimmed);
          count += found;
        }
      }
    }
  }

  if (input.hasOpaqueMedia || count >= 2) return { level: "complete", count };
  return { level: count === 1 ? "partial" : "none", count };
}
