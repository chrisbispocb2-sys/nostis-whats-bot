import type { MisticConfig } from "./mistic-store";
import type { Conversation } from "./conversation-tracker";
import type { ChargeRecord } from "./charge-store";

/** O que o botão solto na tela precisa saber pra se mostrar. */
export interface OverlayState {
  visible: boolean;
  /** Texto do botão ("Cobrar Maria" ou "MisticPay"). */
  label: string;
  tooltip: string;
  /** Conta de WhatsApp cuja conversa/cobrança o botão representa (é ela que abre ao clicar). */
  accountId: string | null;
  accountName: string | null;
  /** Cobranças aguardando pagamento dessa conta. */
  pending: number;
}

/** O pedaço de uma conta que interessa aqui (facilita testar sem montar uma conta inteira). */
export interface OverlayAccount {
  id: string;
  name: string;
  misticSettings: { get(): MisticConfig; isConfigured(): boolean };
  conversations: { list(): Conversation[] };
  charges: { list(): ChargeRecord[] };
}

const HIDDEN: OverlayState = { visible: false, label: "", tooltip: "", accountId: null, accountName: null, pending: 0 };

function firstName(name: string | null): string {
  return (name ?? "").trim().split(/\s+/)[0] ?? "";
}

/** "5511977770000" → "+55 (11) 97777-0000". */
function formatPhone(phone: string | null): string {
  if (!phone) return "";
  const br = phone.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return br ? `+55 (${br[1]}) ${br[2]}-${br[3]}` : `+${phone}`;
}

/**
 * Decide se o botão solto na tela aparece e o que ele mostra. Vale a conta
 * (com MisticPay pronta e o botão configurado pra "tela") que tem a conversa
 * ativa mais recente; com o modo "sempre visível" o botão fica na tela mesmo
 * sem conversa.
 */
export function computeOverlayState(accounts: OverlayAccount[], now = Date.now()): OverlayState {
  let best: { account: OverlayAccount; conversation: Conversation | null; freshness: number } | null = null;

  for (const account of accounts) {
    const config = account.misticSettings.get();
    if (!account.misticSettings.isConfigured() || config.floatWhere !== "desktop") continue;

    const windowMs = config.activeWindowMinutes * 60_000;
    const active = account.conversations
      .list()
      .filter((c) => now - c.lastActivityAt <= windowMs)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);

    if (config.floatMode !== "always" && active.length === 0) continue;

    const conversation = active[0] ?? null;
    const freshness = conversation?.lastActivityAt ?? 0;
    if (!best || freshness > best.freshness) best = { account, conversation, freshness };
  }

  if (!best) return HIDDEN;

  const { account, conversation } = best;
  const pending = account.charges.list().filter((c) => c.kind === "charge" && c.status === "pending").length;
  const who = conversation ? firstName(conversation.name) || formatPhone(conversation.phone) || "cliente" : "";
  const fullWho = conversation ? [conversation.name, formatPhone(conversation.phone)].filter(Boolean).join(" · ") || "cliente" : "";
  const suffix = accounts.length > 1 ? ` (${account.name})` : "";

  return {
    visible: true,
    label: conversation ? `Cobrar ${who}` : "MisticPay",
    tooltip: (conversation ? `Cobrar ${fullWho} pela MisticPay` : "Abrir a MisticPay") + suffix + (pending ? ` — ${pending} cobrança(s) aguardando pagamento` : ""),
    accountId: account.id,
    accountName: account.name,
    pending,
  };
}
