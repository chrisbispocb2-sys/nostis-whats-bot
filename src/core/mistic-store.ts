import { JsonFileStore } from "./base-store";
import { digitsOnly, isValidCpf } from "../utils/documents";

export type FloatMode = "conversation" | "always";

/** Onde o botão flutuante aparece: solto na tela do computador (fora do navegador) ou dentro da página do painel. */
export type FloatWhere = "desktop" | "panel";

/** Configuração da MisticPay de uma conta de WhatsApp. */
export interface MisticConfig {
  /** Liga a integração (o botão flutuante só aparece com isto ligado e as credenciais preenchidas). */
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  /**
   * Opcional: valor completo do header `Authorization` (ex.: "Basic abc123…").
   * Vazio = o sistema monta sozinho a partir do Client ID e do Client Secret.
   */
  authHeader: string;
  /** CPF usado como pagador quando o formulário não informa um. A MisticPay exige CPF em toda cobrança. */
  defaultPayerDocument: string;
  /** "conversation" = o botão só aparece durante uma conversa no privado; "always" = sempre. */
  floatMode: FloatMode;
  /** "desktop" = botão solto na tela, perto da conversa (só no Windows); "panel" = dentro da página do painel. */
  floatWhere: FloatWhere;
  /** Por quantos minutos uma conversa no privado conta como "em andamento". */
  activeWindowMinutes: number;
  sendQr: boolean;
  sendThanks: boolean;
  chargeMessage: string;
  qrCaption: string;
  thanksMessage: string;
  /** Texto de "Copiar cobrança" (para colar num WhatsApp que o bot não controla). Aceita {pix}. */
  copyMessage: string;
  /** Descrição usada quando se cobra um "cliente aleatório" sem escrever uma. */
  defaultDescription: string;
}

/** O que o painel pode mandar. `null` apaga um segredo; texto vazio/ausente mantém o que já estava. */
export interface MisticConfigInput {
  enabled?: boolean;
  clientId?: string;
  clientSecret?: string | null;
  authHeader?: string | null;
  defaultPayerDocument?: string;
  floatMode?: FloatMode;
  floatWhere?: FloatWhere;
  activeWindowMinutes?: number;
  sendQr?: boolean;
  sendThanks?: boolean;
  chargeMessage?: string;
  qrCaption?: string;
  thanksMessage?: string;
  copyMessage?: string;
  defaultDescription?: string;
}

export const DEFAULT_CHARGE_MESSAGE =
  "💳 *Cobrança de {valor}*\n{descricao}\n\nPague com o PIX *copia e cola* (o código vai na próxima mensagem) ou pelo QR Code. Assim que o pagamento for identificado eu te aviso! ✅";
export const DEFAULT_QR_CAPTION = "QR Code para pagar {valor}";
export const DEFAULT_THANKS_MESSAGE = "✅ Pagamento de {valor} recebido! Muito obrigado, {nome}! 🙏";
export const DEFAULT_COPY_MESSAGE = "💳 *Cobrança de {valor}*\n{descricao}\n\nPague com o PIX *copia e cola*:\n\n{pix}";
export const DEFAULT_DESCRIPTION = "Corrida";
const MAX_DESCRIPTION_LENGTH = 120;

export const DEFAULT_ACTIVE_WINDOW_MINUTES = 30;
const MAX_ACTIVE_WINDOW_MINUTES = 720;

const DEFAULT_CONFIG: MisticConfig = {
  enabled: false,
  clientId: "",
  clientSecret: "",
  authHeader: "",
  defaultPayerDocument: "",
  floatMode: "conversation",
  floatWhere: "desktop",
  activeWindowMinutes: DEFAULT_ACTIVE_WINDOW_MINUTES,
  sendQr: true,
  sendThanks: true,
  chargeMessage: "",
  qrCaption: "",
  thanksMessage: "",
  copyMessage: "",
  defaultDescription: DEFAULT_DESCRIPTION,
};

function normalizeWindow(value: unknown): number {
  const minutes = Math.floor(Number(value));
  if (!Number.isFinite(minutes) || minutes < 1) return DEFAULT_ACTIVE_WINDOW_MINUTES;
  return Math.min(minutes, MAX_ACTIVE_WINDOW_MINUTES);
}

/** Erro de validação da configuração (vira uma resposta 400 no painel). */
export class MisticConfigError extends Error {}

export class MisticStore extends JsonFileStore<MisticConfig> {
  /** Sobe a cada mudança nas credenciais: o consultor de pagamentos usa pra tentar de novo depois de um erro de login. */
  private _credentialsVersion = 0;

  constructor(file: string) {
    super(file, { ...DEFAULT_CONFIG });
    // Arquivo salvo por uma versão mais antiga (ou editado à mão) pode não ter todos os campos
    this.data = { ...DEFAULT_CONFIG, ...this.data };
    this.data.floatMode = this.data.floatMode === "always" ? "always" : "conversation";
    this.data.floatWhere = this.data.floatWhere === "panel" ? "panel" : "desktop";
    this.data.activeWindowMinutes = normalizeWindow(this.data.activeWindowMinutes);
    this.data.defaultPayerDocument = digitsOnly(this.data.defaultPayerDocument);
  }

  get credentialsVersion(): number {
    return this._credentialsVersion;
  }

  get(): MisticConfig {
    return this.data;
  }

  /** Tem o suficiente pra falar com a MisticPay? */
  hasCredentials(): boolean {
    const { clientId, clientSecret, authHeader } = this.data;
    return !!authHeader.trim() || (!!clientId.trim() && !!clientSecret.trim());
  }

  /** Integração pronta pra uso: ligada e com credenciais. */
  isConfigured(): boolean {
    return this.data.enabled && this.hasCredentials();
  }

  update(input: MisticConfigInput): MisticConfig {
    const next = { ...this.data };

    if (input.enabled !== undefined) next.enabled = !!input.enabled;
    if (input.clientId !== undefined) next.clientId = String(input.clientId).trim();

    // Segredos: texto vazio/ausente mantém o valor atual; null apaga
    if (input.clientSecret === null) next.clientSecret = "";
    else if (typeof input.clientSecret === "string" && input.clientSecret.trim()) next.clientSecret = input.clientSecret.trim();
    if (input.authHeader === null) next.authHeader = "";
    else if (typeof input.authHeader === "string" && input.authHeader.trim()) next.authHeader = input.authHeader.trim();

    if (input.defaultPayerDocument !== undefined) {
      const doc = digitsOnly(input.defaultPayerDocument);
      if (doc && !isValidCpf(doc)) throw new MisticConfigError("O CPF padrão do pagador não é válido.");
      next.defaultPayerDocument = doc;
    }
    if (input.floatMode !== undefined) {
      if (input.floatMode !== "conversation" && input.floatMode !== "always") {
        throw new MisticConfigError('O modo do botão flutuante deve ser "conversation" ou "always".');
      }
      next.floatMode = input.floatMode;
    }
    if (input.floatWhere !== undefined) {
      if (input.floatWhere !== "desktop" && input.floatWhere !== "panel") {
        throw new MisticConfigError('O lugar do botão flutuante deve ser "desktop" ou "panel".');
      }
      next.floatWhere = input.floatWhere;
    }
    if (input.activeWindowMinutes !== undefined) next.activeWindowMinutes = normalizeWindow(input.activeWindowMinutes);
    if (input.sendQr !== undefined) next.sendQr = !!input.sendQr;
    if (input.sendThanks !== undefined) next.sendThanks = !!input.sendThanks;
    if (input.chargeMessage !== undefined) next.chargeMessage = String(input.chargeMessage).trim();
    if (input.qrCaption !== undefined) next.qrCaption = String(input.qrCaption).trim();
    if (input.thanksMessage !== undefined) next.thanksMessage = String(input.thanksMessage).trim();
    if (input.copyMessage !== undefined) next.copyMessage = String(input.copyMessage).trim();
    // Pode ficar vazia (cliente aleatório sem descrição); só não passa do limite da MisticPay
    if (input.defaultDescription !== undefined) next.defaultDescription = String(input.defaultDescription).trim().slice(0, MAX_DESCRIPTION_LENGTH);

    if (
      next.clientId !== this.data.clientId ||
      next.clientSecret !== this.data.clientSecret ||
      next.authHeader !== this.data.authHeader
    ) {
      this._credentialsVersion++;
    }

    this.data = next;
    this.save();
    return this.data;
  }

  /** Mensagens com o padrão no lugar das que estão vazias. */
  messages(): { chargeMessage: string; qrCaption: string; thanksMessage: string; copyMessage: string } {
    return {
      chargeMessage: this.data.chargeMessage || DEFAULT_CHARGE_MESSAGE,
      qrCaption: this.data.qrCaption || DEFAULT_QR_CAPTION,
      thanksMessage: this.data.thanksMessage || DEFAULT_THANKS_MESSAGE,
      copyMessage: this.data.copyMessage || DEFAULT_COPY_MESSAGE,
    };
  }

  /** O que pode ir pro painel: o Client Secret e o header nunca saem daqui, só se existem. */
  publicView() {
    const { clientSecret, authHeader, ...rest } = this.data;
    return {
      ...rest,
      hasSecret: !!clientSecret,
      hasAuthHeader: !!authHeader,
      configured: this.isConfigured(),
      defaults: {
        chargeMessage: DEFAULT_CHARGE_MESSAGE,
        qrCaption: DEFAULT_QR_CAPTION,
        thanksMessage: DEFAULT_THANKS_MESSAGE,
        copyMessage: DEFAULT_COPY_MESSAGE,
        defaultDescription: DEFAULT_DESCRIPTION,
      },
    };
  }
}
