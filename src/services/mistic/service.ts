import { randomUUID } from "crypto";
import QRCode from "qrcode";
import type { MisticConfig, MisticStore } from "../../core/mistic-store";
import { newRecord, type ChargeKind, type ChargeRecord, type ChargeStore } from "../../core/charge-store";
import { digitsOnly, isValidCnpj, isValidCpf, maskPixKey, maskTail } from "../../utils/documents";
import { isPersonalChat, normalizeJid, phoneFromJid } from "../../utils/jid";
import { centsToReais, formatBRL, parseAmountToCents, renderTemplate } from "../../utils/money";
import { randomPersonName } from "../../utils/random-name";
import { sleep } from "../../utils/sleep";
import { logger } from "../../utils/logger";
import {
  MisticClient,
  MisticError,
  PIX_KEY_TYPES,
  type MisticCredentials,
  type MisticUserInfo,
  type PixKeyType,
  type Statement,
} from "./client";
import { sharedCheckLimiter, type RateLimiter } from "./rate-limiter";

/** Como o serviço manda mensagens ao cliente (quem implementa cuida de registrar o ID como "enviada pelo bot"). */
export interface MisticSender {
  sendText(chatJid: string, text: string): Promise<void>;
  sendImage(chatJid: string, image: Buffer, caption: string): Promise<void>;
}

export interface MisticContacts {
  /** Nome e telefone de uma conversa já conhecida. */
  find(jid: string): { name: string | null; phone: string | null } | undefined;
  /** Confere no WhatsApp se o número existe e devolve o JID certo pra enviar. */
  lookupPhone(phone: string): Promise<{ chatJid: string; phone: string } | null>;
  /** Outros JIDs conhecidos da mesma pessoa (telefone e/ou LID). */
  aliases?(jid: string): string[];
}

export interface MisticTiming {
  /** De quanto em quanto tempo o serviço olha se há algo a consultar. */
  tickMs: number;
  /** Máximo de consultas à MisticPay por olhada. */
  maxChecksPerTick: number;
  /** Pausa entre uma mensagem e outra ao cliente (mantém a ordem e não parece robô). */
  messageGapMs: number;
  /** Espera entre tentativas de mandar o agradecimento (quando o WhatsApp estava fora do ar). */
  thanksRetryGapMs: number;
  /**
   * De quanto em quanto tempo consultar uma cobrança/saque dessa idade.
   * null = passou do prazo em que o sistema acompanha: deixa de consultar.
   */
  intervalFor(ageMs: number, kind: ChargeKind): number | null;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const DEFAULT_TIMING: MisticTiming = {
  tickMs: 5_000,
  maxChecksPerTick: 3,
  messageGapMs: 800,
  thanksRetryGapMs: 15_000,
  intervalFor(ageMs, kind) {
    if (kind === "charge") {
      if (ageMs < 15 * MINUTE) return 10_000;
      if (ageMs < 2 * HOUR) return 30_000;
      if (ageMs < 24 * HOUR) return 2 * MINUTE;
      return null;
    }
    if (ageMs < 30 * MINUTE) return 15_000;
    if (ageMs < 6 * HOUR) return MINUTE;
    if (ageMs < 72 * HOUR) return 5 * MINUTE;
    return null;
  },
};

export interface MisticDeps {
  store: MisticStore;
  charges: ChargeStore;
  sender: MisticSender;
  contacts: MisticContacts;
  /** Aviso no computador (notificação do Windows). */
  notify(title: string, body: string): void;
  accountName(): string;
  /** Um pagamento de cobrança foi confirmado (as métricas se preenchem sozinhas a partir daqui). */
  onPaid?(record: ChargeRecord): void;
  /** Você fez algo na conversa (criou uma cobrança): conta como "tem alguém atendendo". */
  onOperatorAction(chatJid: string): void;
  fetch?: typeof fetch;
  baseUrl?: string;
  limiter?: RateLimiter;
  timing?: MisticTiming;
}

export interface CreateChargeInput {
  /** Conversa já conhecida (de preferência). */
  chatJid?: string;
  /** Ou o número do cliente (com DDD). */
  phone?: string;
  amount: unknown;
  description?: string;
  payerName?: string;
  /** CPF do pagador; vazio = usa o CPF padrão salvo nas configurações (a MisticPay exige um dos dois). */
  payerDocument?: string;
  /** false = cria a cobrança mas NÃO manda nada no WhatsApp (você copia o texto e cola onde atende). */
  send?: boolean;
  /**
   * Cliente aleatório: sem conversa nem número. Sorteia um nome (se não vier um), usa a descrição
   * padrão (se não vier uma) e nunca envia nada — só dá pra copiar a cobrança.
   */
  random?: boolean;
}

export interface WithdrawRequest {
  amount: unknown;
  pixKeyType: string;
  pixKey: string;
  description?: string;
}

const MAX_THANKS_ATTEMPTS = 8;
const DUPLICATE_WITHDRAW_WINDOW_MS = 30_000;

function validation(message: string): MisticError {
  return new MisticError(message, "validation");
}

/**
 * Número digitado → só dígitos com DDI. Com "+" na frente já vem com o DDI; sem ele,
 * 10 ou 11 dígitos são tratados como brasileiros (DDD + número).
 */
export function normalizePhone(value: unknown): string | null {
  const digits = digitsOnly(value);
  if (String(value ?? "").trim().startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? digits : null;
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  if (digits.length >= 12 && digits.length <= 15) return digits;
  return null;
}

/** Confere e padroniza uma chave PIX conforme o tipo. Devolve null se não bate com o tipo. */
export function normalizePixKey(type: PixKeyType, raw: string): string | null {
  const value = raw.trim();
  switch (type) {
    case "CPF": {
      const d = digitsOnly(value);
      return isValidCpf(d) ? d : null;
    }
    case "CNPJ": {
      const d = digitsOnly(value);
      return isValidCnpj(d) ? d : null;
    }
    case "EMAIL":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value.toLowerCase() : null;
    case "TELEFONE": {
      const d = digitsOnly(value);
      return d.length >= 10 && d.length <= 13 ? d : null;
    }
    case "CHAVE_ALEATORIA":
      return /^[0-9a-fA-F-]{32,36}$/.test(value) ? value.toLowerCase() : null;
  }
}

/**
 * Integração com a MisticPay de uma conta de WhatsApp: cria cobranças, manda
 * o PIX ao cliente, acompanha o pagamento, agradece e faz saques.
 */
export class MisticService {
  private readonly client: MisticClient;
  private readonly limiter: RateLimiter;
  private readonly timing: MisticTiming;
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  /** Versão das credenciais em que a MisticPay recusou o login (só tenta de novo se mudarem). */
  private authFailedVersion: number | null = null;
  private backoffUntil = 0;
  private readonly inflightWithdraws = new Set<string>();

  constructor(private readonly deps: MisticDeps) {
    this.client = new MisticClient(() => deps.store.get(), deps.fetch, deps.baseUrl);
    this.limiter = deps.limiter ?? sharedCheckLimiter;
    this.timing = deps.timing ?? DEFAULT_TIMING;
  }

  /** Começa a acompanhar pagamentos pendentes (inclusive os de antes de o programa ser reiniciado). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.timing.tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  list(): ChargeRecord[] {
    return this.deps.charges.list();
  }

  /* ---------- Conta ---------- */

  private assertCredentials(): void {
    if (!this.deps.store.hasCredentials()) {
      throw new MisticError("Preencha o Client ID e o Client Secret da MisticPay nas configurações.", "not_configured");
    }
  }

  private assertConfigured(): void {
    this.assertCredentials();
    if (!this.deps.store.get().enabled) {
      throw new MisticError("A integração com a MisticPay está desligada. Ligue-a nas configurações.", "not_configured");
    }
  }

  async accountInfo(): Promise<MisticUserInfo> {
    this.assertCredentials();
    return this.client.getUserInfo();
  }

  /** Testa credenciais (as informadas agora, completando com as salvas) sem salvar nada. */
  async testConnection(override: Partial<MisticCredentials> = {}): Promise<MisticUserInfo> {
    const saved = this.deps.store.get();
    const credentials: MisticCredentials = {
      clientId: override.clientId?.trim() || saved.clientId,
      clientSecret: override.clientSecret?.trim() || saved.clientSecret,
      authHeader: override.authHeader?.trim() || saved.authHeader,
    };
    return new MisticClient(() => credentials, this.deps.fetch, this.deps.baseUrl).getUserInfo();
  }

  async statement(page: number, status?: string): Promise<Statement> {
    this.assertCredentials();
    return this.client.listTransactions(page, status);
  }

  /* ---------- Cobrança ---------- */

  /** Telefone e JIDs conhecidos de quem vai pagar (sem repetição): servem para achar a corrida dele nas métricas. */
  private jidsOf(chatJid: string, phone: string | null): string[] {
    const all = [chatJid, ...(this.deps.contacts.aliases?.(chatJid) ?? []), ...(phone ? [`${phone}@s.whatsapp.net`] : [])];
    return [...new Set(all.map(normalizeJid))];
  }

  private async resolveTarget(
    input: CreateChargeInput
  ): Promise<{ chatJid: string | null; phone: string | null; name: string | null; jids: string[] }> {
    if (input.random) return { chatJid: null, phone: null, name: input.payerName?.trim() || randomPersonName(), jids: [] };

    if (input.chatJid) {
      if (!isPersonalChat(input.chatJid)) throw validation("Escolha uma conversa privada com o cliente.");
      const known = this.deps.contacts.find(input.chatJid);
      const phone = known?.phone ?? (input.chatJid.endsWith("@s.whatsapp.net") ? phoneFromJid(input.chatJid) : null);
      return { chatJid: input.chatJid, phone, name: known?.name ?? null, jids: this.jidsOf(input.chatJid, phone) };
    }

    if (input.phone) {
      const phone = normalizePhone(input.phone);
      if (!phone) throw validation("Informe o número do cliente com DDD (ex.: 11 99999-9999).");
      const found = await this.deps.contacts.lookupPhone(phone).catch(() => null);
      if (!found) throw validation("Esse número não foi encontrado no WhatsApp. Confira o DDD e o número.");
      return {
        chatJid: found.chatJid,
        phone: found.phone,
        name: this.deps.contacts.find(found.chatJid)?.name ?? null,
        jids: this.jidsOf(found.chatJid, found.phone),
      };
    }

    throw validation("Escolha a conversa do cliente ou informe o número dele.");
  }

  /** Cria a cobrança na MisticPay e manda o PIX ao cliente. */
  async createCharge(input: CreateChargeInput): Promise<ChargeRecord> {
    this.assertConfigured();

    const cents = parseAmountToCents(input.amount);
    if (cents === null) throw validation("Informe um valor válido (de R$ 0,01 até R$ 1.000.000,00, com no máximo 2 casas decimais).");

    const target = await this.resolveTarget(input);

    // A MisticPay exige um CPF do pagador em toda cobrança (o PIX em si não pede, o gateway sim): o do formulário ou o padrão salvo
    const typed = digitsOnly(input.payerDocument);
    const document = typed || this.deps.store.get().defaultPayerDocument;
    if (!document) {
      throw validation("A MisticPay exige um CPF do pagador em toda cobrança. Informe um CPF e marque “usar em todas as cobranças” para não precisar digitar de novo.");
    }
    if (!isValidCpf(document)) throw validation("O CPF informado não é válido. Confira os números.");

    const random = input.random === true;
    // Sem número não há para quem mandar: cliente aleatório é sempre "só copiar"
    const send = !random && input.send !== false;
    const description = ((input.description ?? "").trim() || (random ? this.deps.store.get().defaultDescription : "")).slice(0, 120);
    const payerName = (input.payerName?.trim() || target.name || "Cliente").slice(0, 80);
    const record = newRecord({ id: randomUUID(), kind: "charge", amountCents: cents, description });

    const result = await this.client.createDeposit({
      amount: centsToReais(cents),
      payerName,
      payerDocument: document,
      transactionId: `brinzy-${record.id}`,
      description: description || "Cobrança",
    });
    if (!result.copyPaste) throw new MisticError("A MisticPay não devolveu o PIX copia e cola desta cobrança.", "api");

    Object.assign(record, {
      chatJid: target.chatJid,
      phone: target.phone,
      name: target.name,
      contactJids: target.jids,
      misticId: result.transactionId,
      copyPaste: result.copyPaste,
      payerName,
      payerDocumentMasked: maskTail(document),
    });
    this.deps.charges.add(record);
    logger.info({ account: this.deps.accountName(), chargeId: record.id, cents }, "Cobrança MisticPay criada");

    // A cobrança já existe na MisticPay; se o envio falhar, o erro fica registrado e dá pra reenviar
    if (target.chatJid) this.deps.onOperatorAction(target.chatJid);
    if (send) await this.deliver(record.id);
    return this.deps.charges.get(record.id)!;
  }

  private valuesFor(record: ChargeRecord): Record<string, string> {
    const firstName = (record.name ?? record.payerName ?? "").trim().split(/\s+/)[0] ?? "";
    return {
      valor: formatBRL(record.amountCents),
      nome: firstName || "cliente",
      descricao: record.description,
      numero: record.phone ?? "",
      pix: record.copyPaste ?? "",
    };
  }

  /**
   * Texto pronto para colar no WhatsApp (o modelo "Copiar cobrança" das configurações, com o PIX copia e cola).
   * Se o modelo não tiver o marcador {pix}, o código vai no final: copiar sem o PIX não serviria.
   */
  chargeText(id: string): string {
    const record = this.deps.charges.get(id);
    if (!record || record.kind !== "charge" || !record.copyPaste) throw validation("Cobrança não encontrada.");
    const text = renderTemplate(this.deps.store.messages().copyMessage, this.valuesFor(record));
    return text.includes(record.copyPaste) ? text : `${text}\n\n${record.copyPaste}`;
  }

  /**
   * Tira uma cobrança do histórico e para de acompanhá-la. A MisticPay não tem como cancelar um PIX:
   * se o cliente ainda pagar, o dinheiro cai na conta, mas este sistema não vai mais avisar nem agradecer.
   */
  deleteCharge(id: string): void {
    const record = this.deps.charges.get(id);
    if (!record || record.kind !== "charge") throw validation("Cobrança não encontrada.");
    this.deps.charges.remove(id);
    logger.info({ account: this.deps.accountName(), chargeId: id, status: record.status }, "Cobrança MisticPay excluída do histórico");
  }

  /** Manda ao cliente: a mensagem da cobrança, o PIX copia e cola (sozinho, fácil de copiar) e o QR Code. */
  private async deliver(id: string): Promise<void> {
    const record = this.deps.charges.get(id);
    if (!record?.chatJid || !record.copyPaste) return;

    const config = this.deps.store.get();
    const messages = this.deps.store.messages();
    const values = this.valuesFor(record);
    const gap = this.timing.messageGapMs;

    // Se a cobrança for excluída no meio do envio, o resto das mensagens não vai
    const markSent = (key: keyof ChargeRecord["sent"]): boolean => {
      const current = this.deps.charges.get(id);
      if (!current) return false;
      this.deps.charges.update(id, { sent: { ...current.sent, [key]: true } });
      return true;
    };

    try {
      await this.deps.sender.sendText(record.chatJid, renderTemplate(messages.chargeMessage, values));
      if (!markSent("charge")) return;

      await sleep(gap);
      if (!this.deps.charges.get(id)) return;
      await this.deps.sender.sendText(record.chatJid, record.copyPaste);
      if (!markSent("code")) return;

      if (config.sendQr) {
        const png = await QRCode.toBuffer(record.copyPaste, { width: 512, margin: 2 });
        await sleep(gap);
        if (!this.deps.charges.get(id)) return;
        await this.deps.sender.sendImage(record.chatJid, png, renderTemplate(messages.qrCaption, values));
        if (!markSent("qr")) return;
      }
      this.deps.charges.update(id, { sendError: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, account: this.deps.accountName(), chargeId: id }, "Falha ao enviar a cobrança ao cliente");
      this.deps.charges.update(id, { sendError: message });
    }
  }

  /** Manda de novo o PIX de uma cobrança que ainda está pendente. */
  async resend(id: string): Promise<ChargeRecord> {
    const record = this.deps.charges.get(id);
    if (!record || record.kind !== "charge") throw validation("Cobrança não encontrada.");
    if (record.status !== "pending") throw validation("Só dá pra reenviar uma cobrança que ainda está aguardando pagamento.");
    if (!record.chatJid) throw validation("Esta cobrança não tem um WhatsApp de destino. Use “Copiar cobrança” e cole onde você atende.");
    await this.deliver(id);
    return this.deps.charges.get(id)!;
  }

  /* ---------- Acompanhamento do pagamento ---------- */

  /** Consulta agora (botão "Verificar" do painel), sem esperar o próximo ciclo. */
  async checkNow(id: string): Promise<ChargeRecord> {
    const record = this.deps.charges.get(id);
    if (!record) throw validation("Registro não encontrado.");
    if (record.status === "pending") {
      this.assertCredentials();
      if (!this.limiter.tryAcquire()) {
        throw new MisticError("Muitas consultas à MisticPay em pouco tempo. Aguarde alguns segundos.", "rate_limit");
      }
      await this.checkRecord(record);
    }
    return this.deps.charges.get(id)!;
  }

  private async checkRecord(record: ChargeRecord): Promise<void> {
    this.deps.charges.update(record.id, { lastCheckAt: Date.now() });

    // A documentação não deixa claro qual ID a consulta espera; tenta o da MisticPay e, se ela não achar, o nosso
    const ids = [record.misticId, `brinzy-${record.id}`].filter((v): v is string => !!v);
    let result;
    for (const [index, transactionId] of ids.entries()) {
      try {
        result = await this.client.checkTransaction(transactionId);
        break;
      } catch (err) {
        const notFound = err instanceof MisticError && err.code === "api" && err.status === 404;
        if (!notFound || index === ids.length - 1) throw err;
      }
    }
    if (!result) return;

    if (result.state === "COMPLETO") await this.markPaid(record.id);
    else if (result.state === "FALHA") this.deps.charges.update(record.id, { status: "failed" });
    else if (result.state === "CANCELADO") this.deps.charges.update(record.id, { status: "canceled" });
  }

  private async markPaid(id: string): Promise<void> {
    const record = this.deps.charges.update(id, { status: "paid", paidAt: Date.now() });
    if (!record) return;

    const account = this.deps.accountName();
    if (record.kind === "charge") {
      logger.info({ account, chargeId: id }, "Pagamento MisticPay identificado");
      this.deps.notify(`${account}: pagamento recebido`, `${formatBRL(record.amountCents)} de ${record.name ?? record.payerName ?? "cliente"}.`);
      try {
        this.deps.onPaid?.(record);
      } catch (err) {
        logger.error({ err, account, chargeId: id }, "Falha ao registrar o pagamento nas métricas");
      }
      await this.sendThanks(id);
    } else {
      this.deps.notify(`${account}: saque concluído`, `${formatBRL(record.amountCents)} para a chave ${record.pixKeyMasked ?? ""}.`);
    }
  }

  /** Agradece ao cliente depois do pagamento. Se o WhatsApp estiver fora do ar, tenta de novo mais tarde. */
  private async sendThanks(id: string): Promise<void> {
    const record = this.deps.charges.get(id);
    if (!record || record.kind !== "charge" || record.status !== "paid" || record.thanksSent || !record.chatJid) return;

    if (!this.deps.store.get().sendThanks) {
      this.deps.charges.update(id, { thanksSent: true });
      return;
    }
    if (record.thanksAttempts >= MAX_THANKS_ATTEMPTS) return;

    // Registra a tentativa antes de enviar: uma queda no meio não gera uma sequência infinita de mensagens
    this.deps.charges.update(id, { thanksAttempts: record.thanksAttempts + 1 });
    try {
      const text = renderTemplate(this.deps.store.messages().thanksMessage, this.valuesFor(record));
      await this.deps.sender.sendText(record.chatJid, text);
      this.deps.charges.update(id, { thanksSent: true });
    } catch (err) {
      logger.warn({ err, account: this.deps.accountName(), chargeId: id }, "Não foi possível enviar o agradecimento (vai tentar de novo)");
    }
  }

  /** Um ciclo do acompanhamento: agradecimentos atrasados e consultas de pagamentos/saques pendentes. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      const records = this.deps.charges.list();

      for (const r of records) {
        if (r.kind === "charge" && r.status === "paid" && !r.thanksSent && now - r.updatedAt >= this.timing.thanksRetryGapMs) {
          await this.sendThanks(r.id);
        }
      }

      if (!this.deps.store.hasCredentials()) return;
      if (this.authFailedVersion === this.deps.store.credentialsVersion) return;
      if (now < this.backoffUntil) return;

      const due: ChargeRecord[] = [];
      for (const r of records) {
        if (r.status !== "pending") continue;
        const interval = this.timing.intervalFor(now - r.createdAt, r.kind);
        if (interval === null) {
          this.deps.charges.update(r.id, { status: "expired" });
          continue;
        }
        if (now - (r.lastCheckAt ?? r.createdAt) >= interval) due.push(r);
      }
      due.sort((a, b) => (a.lastCheckAt ?? 0) - (b.lastCheckAt ?? 0));

      for (const record of due.slice(0, this.timing.maxChecksPerTick)) {
        if (!this.limiter.tryAcquire()) break;
        try {
          await this.checkRecord(record);
        } catch (err) {
          if (!(err instanceof MisticError)) throw err;
          if (err.code === "auth") {
            this.authFailedVersion = this.deps.store.credentialsVersion;
            this.deps.notify(
              `${this.deps.accountName()}: MisticPay recusou o login`,
              "Não dá pra confirmar pagamentos enquanto as credenciais estiverem erradas. Confira nas configurações da MisticPay."
            );
            break;
          }
          if (err.code === "rate_limit") {
            this.backoffUntil = Date.now() + 60_000;
            break;
          }
          if (err.code === "network") break; // sem internet: tenta no próximo ciclo
          logger.warn({ err, account: this.deps.accountName(), id: record.id }, "Consulta de pagamento não deu certo");
        }
      }
    } catch (err) {
      logger.error({ err, account: this.deps.accountName() }, "Erro inesperado ao acompanhar pagamentos");
    } finally {
      this.ticking = false;
    }
  }

  /* ---------- Saque ---------- */

  async withdraw(input: WithdrawRequest): Promise<ChargeRecord> {
    this.assertConfigured();

    const cents = parseAmountToCents(input.amount);
    if (cents === null) throw validation("Informe um valor de saque válido (com no máximo 2 casas decimais).");

    const type = String(input.pixKeyType ?? "").toUpperCase() as PixKeyType;
    if (!PIX_KEY_TYPES.includes(type)) throw validation("Escolha o tipo da chave PIX.");
    const key = normalizePixKey(type, String(input.pixKey ?? ""));
    if (!key) throw validation("A chave PIX informada não é válida para o tipo escolhido.");

    // Trava contra clique duplo / pedido repetido: um saque idêntico não sai duas vezes seguidas
    const fingerprint = `${type}:${key}:${cents}`;
    const maskedKey = maskPixKey(type, key);
    const recentDuplicate = this.deps.charges
      .list()
      .some(
        (r) =>
          r.kind === "withdraw" &&
          r.amountCents === cents &&
          r.pixKeyType === type &&
          r.pixKeyMasked === maskedKey &&
          Date.now() - r.createdAt < DUPLICATE_WITHDRAW_WINDOW_MS
      );
    if (this.inflightWithdraws.has(fingerprint) || recentDuplicate) {
      throw validation("Um saque idêntico acabou de ser pedido. Aguarde alguns segundos antes de repetir.");
    }

    this.inflightWithdraws.add(fingerprint);
    try {
      const description = (input.description ?? "").trim().slice(0, 120);
      const result = await this.client.withdraw({
        amount: centsToReais(cents),
        pixKey: key,
        pixKeyType: type,
        description: description || "Saque",
      });

      const record = newRecord({ id: randomUUID(), kind: "withdraw", amountCents: cents, description });
      Object.assign(record, { misticId: result.transactionId, pixKeyType: type, pixKeyMasked: maskedKey });
      this.deps.charges.add(record);
      logger.info({ account: this.deps.accountName(), withdrawId: record.id, cents }, "Saque MisticPay pedido");
      return record;
    } finally {
      this.inflightWithdraws.delete(fingerprint);
    }
  }

  /** Só pra os testes e o painel saberem a configuração corrente. */
  get config(): MisticConfig {
    return this.deps.store.get();
  }
}
