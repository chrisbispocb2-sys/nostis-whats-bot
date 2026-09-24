import { JsonFileStore } from "./base-store";
import { randomUUID } from "crypto";
import { extractPhoneKey, normalizeJid, phoneFromJid, phoneKeysMatch, type PhoneKey } from "../utils/jid";
import { CONFIG } from "../config";

export type LeadStatus = "pending" | "closed" | "not_closed";

export interface CallLead {
  id: string;
  ruleId: string;
  groupJid: string;
  groupName: string;
  callerJid: string;
  callerName: string | null;
  triggeredAt: number;
  privateContactAt: number | null;
  value: number | null;
  status: LeadStatus;
  updatedAt: number;
  /** Preenchidos sozinhos quando o pagamento da MisticPay dessa corrida é confirmado (ausentes em registros antigos). */
  chargeId?: string | null;
  paidAt?: number | null;
  paidAmount?: number | null;
}

export interface RecordTriggerInput {
  ruleId: string;
  groupJid: string;
  groupName: string;
  callerJid: string;
  callerName: string | null;
}

export interface LeadUpdateInput {
  value?: number | null;
  status?: LeadStatus;
}

const STATUSES: readonly LeadStatus[] = ["pending", "closed", "not_closed"];

/** Só liga um pagamento a um gatilho que aconteceu até este tempo antes dele. */
const PAYMENT_MATCH_WINDOW_MS = 48 * 60 * 60 * 1000;

export interface PaymentInput {
  chargeId: string;
  /** JIDs da pessoa (telefone e/ou LID): qualquer um que bata com o do gatilho liga o pagamento a ele. */
  jids: string[];
  phone: string | null;
  amountCents: number;
  paidAt: number;
  /** Só gatilhos anteriores à criação da cobrança contam (um gatilho novo é outra corrida). */
  chargeCreatedAt: number;
}

export class CallLeadStore extends JsonFileStore<CallLead[]> {
  constructor(file: string) {
    super(file, []);
  }

  list(): CallLead[] {
    return this.data;
  }

  get(id: string): CallLead | undefined {
    return this.data.find((l) => l.id === id);
  }

  /** Chamado quando uma regra com rastreamento ativo dispara num grupo. */
  recordTrigger(input: RecordTriggerInput): CallLead {
    const now = Date.now();
    const lead: CallLead = {
      id: randomUUID(),
      ruleId: input.ruleId,
      groupJid: input.groupJid,
      groupName: input.groupName,
      callerJid: normalizeJid(input.callerJid),
      callerName: input.callerName,
      triggeredAt: now,
      privateContactAt: null,
      value: null,
      status: "pending",
      updatedAt: now,
      chargeId: null,
      paidAt: null,
      paidAmount: null,
    };

    this.data.unshift(lead);
    if (this.data.length > CONFIG.maxLeads) {
      this.data.splice(CONFIG.maxLeads);
    }

    this.save();
    return lead;
  }

  /**
   * Chamado quando chega uma mensagem privada. Correlaciona com o gatilho mais
   * recente ainda não vinculado da mesma pessoa, dentro da janela de tempo.
   * Não faz nada (silenciosamente) se não houver gatilho pendente pra esse JID.
   */
  markPrivateContact(callerJid: string): CallLead | undefined {
    const normalized = normalizeJid(callerJid);
    const now = Date.now();

    const lead = this.data.find(
      (l) =>
        l.callerJid === normalized &&
        l.privateContactAt === null &&
        now - l.triggeredAt <= CONFIG.correlationWindowMs
    );
    if (!lead) return undefined;

    lead.privateContactAt = now;
    lead.updatedAt = now;
    this.save();
    return lead;
  }

  /**
   * Chamado quando um pagamento da MisticPay é confirmado: acha a corrida (gatilho) mais recente dessa
   * pessoa ainda sem pagamento, marca como "Fechou" e preenche o valor recebido. Se você já tinha fechado
   * a corrida e digitado um valor, o seu valor fica (só entram os dados do pagamento).
   * Não faz nada se a pessoa não tem gatilho nas últimas 48 horas (por exemplo, chamou direto no privado).
   */
  applyPayment(input: PaymentInput): CallLead | undefined {
    if (this.data.some((l) => l.chargeId === input.chargeId)) return undefined; // já ligado antes

    const jids = new Set(input.jids.map(normalizeJid));
    const phoneKeys: PhoneKey[] = [];
    if (input.phone) phoneKeys.push(extractPhoneKey(input.phone));
    for (const jid of jids) if (jid.endsWith("@s.whatsapp.net")) phoneKeys.push(extractPhoneKey(phoneFromJid(jid)));

    const samePerson = (l: CallLead): boolean => {
      const jid = normalizeJid(l.callerJid);
      if (jids.has(jid)) return true;
      if (!jid.endsWith("@s.whatsapp.net")) return false; // LID só casa por igualdade (não dá pra comparar telefone)
      const key = extractPhoneKey(phoneFromJid(jid));
      return phoneKeys.some((k) => phoneKeysMatch(k, key));
    };

    // A lista é da mais recente para a mais antiga
    const candidates = this.data.filter(
      (l) =>
        !l.chargeId &&
        l.triggeredAt <= input.chargeCreatedAt &&
        input.paidAt - l.triggeredAt <= PAYMENT_MATCH_WINDOW_MS &&
        samePerson(l)
    );
    const lead = candidates.find((l) => l.privateContactAt !== null) ?? candidates[0];
    if (!lead) return undefined;

    const paidAmount = input.amountCents / 100;
    const typedByHand = lead.status === "closed" && lead.value !== null && lead.value > 0;
    if (!typedByHand) lead.value = paidAmount;
    lead.status = "closed";
    lead.chargeId = input.chargeId;
    lead.paidAt = input.paidAt;
    lead.paidAmount = paidAmount;
    // Quem pagou por uma cobrança sua é claramente alguém que falou no privado
    lead.privateContactAt ??= input.chargeCreatedAt;
    lead.updatedAt = Date.now();

    this.save();
    return lead;
  }

  update(id: string, input: LeadUpdateInput): CallLead | undefined {
    const lead = this.get(id);
    if (!lead) return undefined;

    if (input.value !== undefined) {
      lead.value = input.value === null ? null : Math.max(0, input.value);
    }
    if (input.status !== undefined) {
      if (!STATUSES.includes(input.status)) {
        throw new Error(`Status inválido: "${input.status}".`);
      }
      lead.status = input.status;
    }
    lead.updatedAt = Date.now();

    this.save();
    return lead;
  }

  delete(id: string): boolean {
    const before = this.data.length;
    this.data = this.data.filter((l) => l.id !== id);
    if (this.data.length === before) return false;
    this.save();
    return true;
  }
}
