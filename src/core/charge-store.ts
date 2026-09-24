import { JsonFileStore } from "./base-store";

export type ChargeKind = "charge" | "withdraw";

/**
 * pending = esperando (pagamento ou saque em andamento) · paid = pago/concluído ·
 * failed = a MisticPay recusou · canceled = cancelada · expired = ninguém pagou
 * (ou não deu pra confirmar) dentro do prazo em que o sistema acompanha.
 */
export type ChargeStatus = "pending" | "paid" | "failed" | "canceled" | "expired";

/** Uma cobrança a cliente, ou um saque, feitos pelo painel. */
export interface ChargeRecord {
  id: string;
  kind: ChargeKind;
  status: ChargeStatus;
  amountCents: number;
  description: string;
  createdAt: number;
  updatedAt: number;
  paidAt: number | null;
  /** ID da transação na MisticPay (é ele que vai na consulta de status). */
  misticId: string | null;
  lastCheckAt: number | null;

  // Só nas cobranças
  chatJid: string | null;
  phone: string | null;
  name: string | null;
  /** Todos os JIDs conhecidos do cliente (telefone e/ou LID): é com eles que o pagamento acha a corrida dele nas métricas. */
  contactJids: string[];
  /** PIX copia e cola. */
  copyPaste: string | null;
  payerName: string | null;
  payerDocumentMasked: string | null;
  /** Quais mensagens já chegaram ao cliente. */
  sent: { charge: boolean; code: boolean; qr: boolean };
  sendError: string | null;
  thanksSent: boolean;
  thanksAttempts: number;

  // Só nos saques
  pixKeyType: string | null;
  pixKeyMasked: string | null;
}

const MAX_RECORDS = 500;

export interface PaymentSummary {
  todayCents: number;
  todayCount: number;
  monthCents: number;
  monthCount: number;
}

/** Quanto entrou (cobranças pagas) hoje e neste mês, no fuso do computador. Saques não contam. */
export function summarizePayments(records: readonly ChargeRecord[], now = Date.now()): PaymentSummary {
  const d = new Date(now);
  const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const startOfMonth = new Date(d.getFullYear(), d.getMonth(), 1).getTime();

  const summary: PaymentSummary = { todayCents: 0, todayCount: 0, monthCents: 0, monthCount: 0 };
  for (const r of records) {
    if (r.kind !== "charge" || r.status !== "paid" || r.paidAt === null) continue;
    if (r.paidAt >= startOfMonth && r.paidAt <= now) {
      summary.monthCents += r.amountCents;
      summary.monthCount++;
    }
    if (r.paidAt >= startOfDay && r.paidAt <= now) {
      summary.todayCents += r.amountCents;
      summary.todayCount++;
    }
  }
  return summary;
}

export function newRecord(partial: Pick<ChargeRecord, "id" | "kind" | "amountCents" | "description">): ChargeRecord {
  const now = Date.now();
  return {
    status: "pending",
    createdAt: now,
    updatedAt: now,
    paidAt: null,
    misticId: null,
    lastCheckAt: null,
    chatJid: null,
    phone: null,
    name: null,
    contactJids: [],
    copyPaste: null,
    payerName: null,
    payerDocumentMasked: null,
    sent: { charge: false, code: false, qr: false },
    sendError: null,
    thanksSent: false,
    thanksAttempts: 0,
    pixKeyType: null,
    pixKeyMasked: null,
    ...partial,
  };
}

export class ChargeStore extends JsonFileStore<ChargeRecord[]> {
  constructor(file: string) {
    super(file, []);
  }

  /** Mais recentes primeiro. */
  list(): ChargeRecord[] {
    return [...this.data].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): ChargeRecord | undefined {
    return this.data.find((r) => r.id === id);
  }

  add(record: ChargeRecord): ChargeRecord {
    this.data.push(record);
    if (this.data.length > MAX_RECORDS) {
      // Descarta os mais antigos que já terminaram; o que ainda está pendente nunca é descartado
      const closed = this.data.filter((r) => r.status !== "pending").sort((a, b) => a.createdAt - b.createdAt);
      const drop = new Set(closed.slice(0, this.data.length - MAX_RECORDS).map((r) => r.id));
      this.data = this.data.filter((r) => !drop.has(r.id));
    }
    this.save();
    return record;
  }

  /** Tira do histórico (devolve false se não existia). */
  remove(id: string): boolean {
    const before = this.data.length;
    this.data = this.data.filter((r) => r.id !== id);
    if (this.data.length === before) return false;
    this.save();
    return true;
  }

  update(id: string, patch: Partial<ChargeRecord>): ChargeRecord | undefined {
    const record = this.get(id);
    if (!record) return undefined;
    Object.assign(record, patch, { updatedAt: Date.now() });
    this.save();
    return record;
  }
}
