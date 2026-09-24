/** Menor e maior valor aceitos numa cobrança/saque (o teto só existe pra pegar erro de digitação). */
export const MIN_AMOUNT_CENTS = 1;
export const MAX_AMOUNT_CENTS = 100_000_000; // R$ 1.000.000,00

/**
 * Converte um valor em reais (número ou texto como "25,50") pra centavos
 * inteiros. Devolve null se for inválido (zero, negativo, mais de 2 casas
 * decimais, fora dos limites...). Trabalhar em centavos evita erros de float.
 */
export function parseAmountToCents(value: unknown): number | null {
  let reais: number;

  if (typeof value === "number") {
    reais = value;
  } else if (typeof value === "string") {
    let text = value.replace(/R\$|\s/gi, "");
    if (text.includes(",")) text = text.replace(/\./g, "").replace(",", ".");
    if (!/^\d+(\.\d+)?$/.test(text)) return null;
    reais = Number(text);
  } else {
    return null;
  }

  if (!Number.isFinite(reais)) return null;
  const cents = Math.round(reais * 100);
  if (Math.abs(reais * 100 - cents) > 1e-6) return null;
  if (cents < MIN_AMOUNT_CENTS || cents > MAX_AMOUNT_CENTS) return null;
  return cents;
}

/** 2550 → "R$ 25,50" (com ponto nos milhares). */
export function formatBRL(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const reais = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const centavos = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}R$ ${reais},${centavos}`;
}

/** Centavos → valor em reais com 2 casas, como a API da MisticPay espera. */
export function centsToReais(cents: number): number {
  return Number((cents / 100).toFixed(2));
}

/**
 * Troca os {marcadores} de uma mensagem pelos valores. Marcador desconhecido
 * fica como está. Linhas em branco repetidas (de marcadores vazios) são
 * reduzidas a uma só.
 */
export function renderTemplate(template: string, values: Record<string, string>): string {
  return template
    .replace(/\{(\w+)\}/g, (match, key: string) => values[key.toLowerCase()] ?? match)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
