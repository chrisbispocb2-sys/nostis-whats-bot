import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CallLeadStore, type PaymentInput } from "./lead-store";
import { summarizePayments, newRecord, type ChargeRecord } from "./charge-store";

const HOUR = 3_600_000;
const PHONE_JID = "5511977770000@s.whatsapp.net";
const LID_JID = "98765432100@lid";

let dir: string;
let store: CallLeadStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brinzy-leads-"));
  store = new CallLeadStore(join(dir, "leads.json"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Um gatilho no grupo, `agoMs` atrás (a lista guarda o mais recente primeiro, então o teste ajusta o horário na mão). */
function trigger(callerJid: string, agoMs: number, extra: { privateContact?: boolean; name?: string } = {}) {
  const lead = store.recordTrigger({ ruleId: "r1", groupJid: "g@g.us", groupName: "Grupo Centro", callerJid, callerName: extra.name ?? "Maria" });
  lead.triggeredAt = Date.now() - agoMs;
  lead.privateContactAt = extra.privateContact ? lead.triggeredAt + 60_000 : null;
  return lead;
}

function payment(patch: Partial<PaymentInput> = {}): PaymentInput {
  const now = Date.now();
  return {
    chargeId: "charge-1",
    jids: [PHONE_JID],
    phone: "5511977770000",
    amountCents: 3290,
    paidAt: now,
    chargeCreatedAt: now - 10 * 60_000,
    ...patch,
  };
}

describe("pagamento confirmado → corrida nas métricas", () => {
  test("fecha a corrida da pessoa e preenche o valor recebido", () => {
    const lead = trigger(PHONE_JID, HOUR, { privateContact: true });

    const applied = store.applyPayment(payment());

    expect(applied?.id).toBe(lead.id);
    expect(store.get(lead.id)).toMatchObject({ status: "closed", value: 32.9, paidAmount: 32.9, chargeId: "charge-1" });
    expect(store.get(lead.id)!.paidAt).toBeGreaterThan(0);
  });

  test("fica salvo no disco", () => {
    const lead = trigger(PHONE_JID, HOUR);
    store.applyPayment(payment());
    expect(new CallLeadStore(join(dir, "leads.json")).get(lead.id)).toMatchObject({ status: "closed", value: 32.9, chargeId: "charge-1" });
  });

  test("escolhe a corrida mais recente da pessoa e não mexe nas outras", () => {
    const old = trigger(PHONE_JID, 5 * HOUR);
    const recent = trigger(PHONE_JID, HOUR);
    const other = trigger("5511911112222@s.whatsapp.net", 30 * 60_000);

    store.applyPayment(payment());

    expect(store.get(recent.id)!.status).toBe("closed");
    expect(store.get(old.id)!.status).toBe("pending");
    expect(store.get(other.id)!.status).toBe("pending");
  });

  test("dá preferência à corrida em que a pessoa já chamou no privado", () => {
    const withoutPrivate = trigger(PHONE_JID, 30 * 60_000);
    const withPrivate = trigger(PHONE_JID, 3 * HOUR, { privateContact: true });

    store.applyPayment(payment());

    expect(store.get(withPrivate.id)!.status).toBe("closed");
    expect(store.get(withoutPrivate.id)!.status).toBe("pending");
  });

  test("uma corrida só recebe um pagamento; o segundo vai para a próxima ou para ninguém", () => {
    const a = trigger(PHONE_JID, 2 * HOUR);
    const b = trigger(PHONE_JID, HOUR);

    store.applyPayment(payment({ chargeId: "c1", amountCents: 1000 }));
    store.applyPayment(payment({ chargeId: "c2", amountCents: 2000 }));
    expect(store.applyPayment(payment({ chargeId: "c3", amountCents: 3000 }))).toBeUndefined();

    expect(store.get(b.id)).toMatchObject({ chargeId: "c1", value: 10 });
    expect(store.get(a.id)).toMatchObject({ chargeId: "c2", value: 20 });
  });

  test("o mesmo pagamento não é aplicado duas vezes", () => {
    trigger(PHONE_JID, 2 * HOUR);
    trigger(PHONE_JID, HOUR);
    store.applyPayment(payment({ chargeId: "c1" }));
    expect(store.applyPayment(payment({ chargeId: "c1" }))).toBeUndefined();
    expect(store.list().filter((l) => l.chargeId === "c1").length).toBe(1);
  });

  test("um valor digitado à mão numa corrida já fechada é mantido (só entram os dados do pagamento)", () => {
    const lead = trigger(PHONE_JID, HOUR);
    store.update(lead.id, { status: "closed", value: 40 });

    store.applyPayment(payment({ amountCents: 3290 }));

    expect(store.get(lead.id)).toMatchObject({ status: "closed", value: 40, paidAmount: 32.9, chargeId: "charge-1" });
  });

  test("corrida marcada como 'Não fechou' vira 'Fechou' quando o pagamento cai", () => {
    const lead = trigger(PHONE_JID, HOUR);
    store.update(lead.id, { status: "not_closed" });
    store.applyPayment(payment());
    expect(store.get(lead.id)).toMatchObject({ status: "closed", value: 32.9 });
  });

  test("quem pagou falou no privado: preenche o contato que faltava", () => {
    const lead = trigger(PHONE_JID, HOUR);
    const input = payment();
    store.applyPayment(input);
    expect(store.get(lead.id)!.privateContactAt).toBe(input.chargeCreatedAt);
  });

  test("gatilho depois da criação da cobrança é outra corrida: não conta", () => {
    const now = Date.now();
    trigger(PHONE_JID, 5 * 60_000); // 5 min atrás
    // a cobrança foi criada 20 min atrás, antes desse gatilho
    expect(store.applyPayment(payment({ chargeCreatedAt: now - 20 * 60_000 }))).toBeUndefined();
  });

  test("gatilho com mais de 48 horas não conta (provavelmente é outra história)", () => {
    trigger(PHONE_JID, 49 * HOUR);
    expect(store.applyPayment(payment({ chargeCreatedAt: Date.now() - 49 * HOUR + 60_000 }))).toBeUndefined();
    trigger(PHONE_JID, 47 * HOUR);
    expect(store.applyPayment(payment({ chargeId: "c2", chargeCreatedAt: Date.now() - HOUR }))).toBeDefined();
  });

  test("quem nunca chamou por gatilho (chegou direto no privado) não muda nenhuma métrica", () => {
    const stranger = trigger("5511900000000@s.whatsapp.net", HOUR);
    expect(store.applyPayment(payment())).toBeUndefined();
    expect(store.get(stranger.id)!.status).toBe("pending");
  });

  test("acha a pessoa pelo LID quando o gatilho foi registrado assim", () => {
    const lead = trigger(LID_JID, HOUR);
    store.applyPayment(payment({ jids: [PHONE_JID, LID_JID] }));
    expect(store.get(lead.id)!.status).toBe("closed");
  });

  test("LID sem correspondência não casa por telefone (não dá para comparar)", () => {
    trigger(LID_JID, HOUR);
    expect(store.applyPayment(payment({ jids: [PHONE_JID] }))).toBeUndefined();
  });

  test("acha por telefone mesmo com o 9 extra do celular a mais ou a menos", () => {
    const lead = trigger("551177770000@s.whatsapp.net", HOUR); // sem o 9
    store.applyPayment(payment({ jids: [PHONE_JID], phone: "5511977770000" }));
    expect(store.get(lead.id)!.status).toBe("closed");
  });

  test("DDD diferente não casa, mesmo com o mesmo final de número", () => {
    trigger("5521977770000@s.whatsapp.net", HOUR);
    expect(store.applyPayment(payment())).toBeUndefined();
  });

  test("registros antigos (sem os campos de pagamento) funcionam", () => {
    const lead = trigger(PHONE_JID, HOUR);
    delete (lead as any).chargeId;
    delete (lead as any).paidAt;
    delete (lead as any).paidAmount;
    expect(store.applyPayment(payment())?.id).toBe(lead.id);
  });
});

describe("resumo do recebido", () => {
  const paid = (amountCents: number, paidAt: number, kind: "charge" | "withdraw" = "charge", status: ChargeRecord["status"] = "paid"): ChargeRecord => {
    const r = newRecord({ id: String(Math.random()), kind, amountCents, description: "" });
    r.status = status;
    r.paidAt = paidAt;
    return r;
  };

  test("soma o que entrou hoje e no mês, só de cobranças pagas", () => {
    const now = new Date(2026, 8, 24, 15, 0, 0).getTime(); // 24/09/2026 15:00
    const records = [
      paid(1000, new Date(2026, 8, 24, 9, 0).getTime()), // hoje
      paid(2000, new Date(2026, 8, 24, 0, 1).getTime()), // hoje (logo depois da meia-noite)
      paid(4000, new Date(2026, 8, 23, 23, 59).getTime()), // ontem, mesmo mês
      paid(8000, new Date(2026, 8, 1, 0, 0).getTime()), // 1º do mês
      paid(16000, new Date(2026, 7, 31, 23, 59).getTime()), // mês passado
      paid(32000, now, "withdraw"), // saque não conta
      paid(64000, now, "charge", "pending"), // pendente não conta
      { ...paid(128000, now), paidAt: null }, // sem data de pagamento não conta
    ];

    expect(summarizePayments(records, now)).toEqual({ todayCents: 3000, todayCount: 2, monthCents: 15000, monthCount: 4 });
  });

  test("sem nada pago, tudo zero", () => {
    expect(summarizePayments([], Date.now())).toEqual({ todayCents: 0, todayCount: 0, monthCents: 0, monthCount: 0 });
  });
});
