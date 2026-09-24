/**
 * Remove o sufixo de dispositivo (ex: ":12") que o WhatsApp às vezes anexa à
 * parte do usuário do JID, preservando o domínio (@s.whatsapp.net / @lid / etc).
 * Ex: "5511999990000:12@s.whatsapp.net" -> "5511999990000@s.whatsapp.net"
 */
export function normalizeJid(jid: string): string {
  const [userPart, domain] = jid.split("@");
  const cleanUser = userPart!.split(":")[0];
  return domain ? `${cleanUser}@${domain}` : cleanUser!;
}

/** Extrai só a parte numérica (sem domínio/sufixo de dispositivo) de um JID. */
export function phoneFromJid(jid: string): string {
  return normalizeJid(jid).split("@")[0]!;
}

/** Conversa com uma pessoa (não é grupo, status, lista de transmissão nem canal). */
export function isPersonalChat(jid: string): boolean {
  return jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid");
}

export interface PhoneKey {
  /** Os 8 últimos dígitos do número: o "miolo" local, sem DDI/DDD nem o 9 extra. */
  last8: string;
  /** DDD, se der pra identificar a partir do que foi informado; null se o número veio sem DDD. */
  ddd: string | null;
}

/**
 * Extrai uma chave de comparação tolerante a formato pra números de
 * telefone. Números brasileiros podem chegar/ser digitados de formas bem
 * diferentes — com ou sem "+55", com ou sem o "9" extra do celular, com ou
 * sem DDD — então em vez de comparar dígito a dígito, sempre usa os últimos
 * 8 dígitos (o núcleo do número, que não muda) e só considera o DDD quando
 * ele realmente dá pra ser identificado.
 */
export function extractPhoneKey(raw: string): PhoneKey {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 8) return { last8: digits, ddd: null };

  const last8 = digits.slice(-8);
  const rest = digits.slice(0, -8);
  const withoutCountryCode = rest.startsWith("55") ? rest.slice(2) : rest;
  const ddd = withoutCountryCode.length >= 2 ? withoutCountryCode.slice(0, 2) : null;

  return { last8, ddd };
}

/**
 * Compara duas chaves de telefone: sempre exige os últimos 8 dígitos iguais;
 * só exige o DDD bater quando os dois números informaram um DDD (permite
 * casar um número digitado sem DDD, como só o número local).
 */
export function phoneKeysMatch(a: PhoneKey, b: PhoneKey): boolean {
  if (!a.last8 || a.last8 !== b.last8) return false;
  if (a.ddd && b.ddd) return a.ddd === b.ddd;
  return true;
}
