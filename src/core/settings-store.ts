import { JsonFileStore } from "./base-store";
import { extractPhoneKey, phoneKeysMatch } from "../utils/jid";

export interface Settings {
  /** Ignora por completo mensagens de quem tem "ADM" no nome do WhatsApp. */
  ignoreAdminNames: boolean;
  /** Números (só dígitos) que disparam a regra normalmente, mas não recebem a resposta de texto. */
  noReplyNumbers: string[];
  /** Em grupo, ignora por completo (nem responde) quem manda mensagem com DDD nessa lista — só vale ligado. */
  ignoreGroupDddsEnabled: boolean;
  /** DDDs (2 dígitos cada) ignorados em grupo. */
  ignoredGroupDdds: string[];
  /**
   * Segurança: desliga o bot sozinho quando chega uma mensagem no privado e
   * ninguém responde dentro de `autoShutdownMinutes` (sinal de que não tem
   * ninguém atendendo, então o bot não deve continuar chamando gente).
   */
  autoShutdownEnabled: boolean;
  autoShutdownMinutes: number;
  /**
   * Recado automático: com o bot desligado (à mão ou pela segurança), quem chamar no privado recebe
   * esta mensagem uma vez — para não ficar sem nenhuma resposta enquanto ninguém está atendendo.
   */
  awayMessageEnabled: boolean;
  awayMessage: string;
  /** Acompanhar corridas da Uber pelo link compartilhado, avisando o cliente sozinho (2 min, chegou, embarcou). */
  rideAssistantEnabled: boolean;
  /** Com o assistente ligado, cobrar automaticamente via MisticPay (desligado = só acompanha e avisa, sem cobrar). */
  rideAutoChargeEnabled: boolean;
  /** Mensagem mandada junto com a cobrança automática (a sua, ou a padrão). Aceita {valor}. */
  rideChargeMessage: string;
  /** Em que momento da corrida a cobrança automática sai. */
  rideChargeTrigger: RideChargeTrigger;
  /** Texto mandado junto com os endereços de partida e destino, pro cliente conferir (o seu, ou o padrão). */
  rideRouteMessage: string;
  /** Avisos mandados ao cliente em cada marco da corrida (os seus, ou os padrão quando vazios). */
  rideNear2MinMessage: string;
  rideNear1MinMessage: string;
  rideArrivedMessage: string;
  rideStartedMessage: string;
  rideDriverChangedMessage: string;
  /** Acrescenta carro, placa e motorista (quando a Uber informa) aos avisos de chegada e de troca de motorista. */
  rideVehicleDetailsEnabled: boolean;
  /** Toca um bip no painel quando chega mensagem nova (de quem não é você/o bot). */
  notificationSoundEnabled: boolean;
}

export type RideChargeTrigger = "on_link" | "near_2min" | "near_1min" | "on_arrival";
const RIDE_CHARGE_TRIGGERS: RideChargeTrigger[] = ["on_link", "near_2min", "near_1min", "on_arrival"];

/** Os avisos de corrida editáveis: campo de `Settings` → texto padrão. */
export const DEFAULT_RIDE_MESSAGES = {
  // Vai logo abaixo dos endereços de partida e destino lidos do link (ver `Account.sendRideRoute`)
  rideRouteMessage: "Confere pra mim se os endereços estão certinhos e me dá um *ok*? 👍\nVocê pode acompanhar a corrida em tempo real pelo link que te mandei.",
  rideNear2MinMessage: "🚗 Seu motorista está chegando, mais ou menos 2 minutinhos!",
  rideNear1MinMessage: "🚗 Seu motorista está quase chegando, menos de 1 minutinho!",
  rideArrivedMessage: "✅ Seu motorista chegou no local combinado!",
  rideStartedMessage: "🚕 Corrida iniciada!",
  rideDriverChangedMessage: "🔄 Houve uma troca de motorista na sua corrida. Te aviso de novo quando o novo estiver chegando!",
} as const;
export type RideMessageKey = keyof typeof DEFAULT_RIDE_MESSAGES;
const RIDE_MESSAGE_KEYS = Object.keys(DEFAULT_RIDE_MESSAGES) as RideMessageKey[];
const MAX_RIDE_MESSAGE_LENGTH = 300;

export interface SettingsInput {
  ignoreAdminNames?: boolean;
  noReplyNumbers?: string[];
  ignoreGroupDddsEnabled?: boolean;
  ignoredGroupDdds?: string[];
  autoShutdownEnabled?: boolean;
  autoShutdownMinutes?: number;
  awayMessageEnabled?: boolean;
  awayMessage?: string;
  rideAssistantEnabled?: boolean;
  rideAutoChargeEnabled?: boolean;
  rideChargeMessage?: string;
  rideChargeTrigger?: RideChargeTrigger;
  rideRouteMessage?: string;
  rideNear2MinMessage?: string;
  rideNear1MinMessage?: string;
  rideArrivedMessage?: string;
  rideStartedMessage?: string;
  rideDriverChangedMessage?: string;
  rideVehicleDetailsEnabled?: boolean;
  notificationSoundEnabled?: boolean;
}

export const DEFAULT_AUTO_SHUTDOWN_MINUTES = 5;
const MAX_AUTO_SHUTDOWN_MINUTES = 720;
export const DEFAULT_AWAY_MESSAGE =
  "Oi! No momento não há ninguém para atender por aqui, mas assim que possível a gente te responde. Obrigado pela paciência! 🙏";
const MAX_AWAY_MESSAGE_LENGTH = 500;
export const DEFAULT_RIDE_CHARGE_MESSAGE =
  "Estou enviando o pagamento agora, caso haja algum problema de internet — é melhor fazer o pagamento antes. " +
  "O sistema da Uber é automatizado: se o pagamento não for identificado em até 5 minutos depois da corrida começar, " +
  "ela é cancelada e o valor total é cobrado de você, no carro.";
const MAX_RIDE_CHARGE_MESSAGE_LENGTH = 500;

const DEFAULT_SETTINGS: Settings = {
  ignoreAdminNames: false,
  noReplyNumbers: [],
  ignoreGroupDddsEnabled: false,
  ignoredGroupDdds: [],
  autoShutdownEnabled: false,
  autoShutdownMinutes: DEFAULT_AUTO_SHUTDOWN_MINUTES,
  awayMessageEnabled: false,
  awayMessage: "",
  rideAssistantEnabled: true,
  rideAutoChargeEnabled: true,
  rideChargeMessage: "",
  rideChargeTrigger: "near_2min",
  rideRouteMessage: "",
  rideNear2MinMessage: "",
  rideNear1MinMessage: "",
  rideArrivedMessage: "",
  rideStartedMessage: "",
  rideDriverChangedMessage: "",
  rideVehicleDetailsEnabled: true,
  notificationSoundEnabled: true,
};

function normalizeNumbers(list: string[]): string[] {
  return [...new Set(list.map((n) => n.replace(/\D/g, "")).filter(Boolean))];
}

/** DDD são sempre 2 dígitos — qualquer outra coisa digitada (vazio, com DDI, etc.) é descartada. */
function normalizeDdds(list: string[]): string[] {
  return [...new Set(list.map((d) => d.replace(/\D/g, "")).filter((d) => d.length === 2))];
}

function normalizeMinutes(value: unknown): number {
  const minutes = Math.floor(Number(value));
  if (!Number.isFinite(minutes) || minutes < 1) return DEFAULT_AUTO_SHUTDOWN_MINUTES;
  return Math.min(minutes, MAX_AUTO_SHUTDOWN_MINUTES);
}

export class SettingsStore extends JsonFileStore<Settings> {
  constructor(file: string) {
    super(file, { ...DEFAULT_SETTINGS });
    // Arquivos salvos antes de existirem os campos novos não os têm
    this.data.ignoreAdminNames ??= false;
    this.data.noReplyNumbers = normalizeNumbers(this.data.noReplyNumbers ?? []);
    this.data.ignoreGroupDddsEnabled ??= false;
    this.data.ignoredGroupDdds = normalizeDdds(this.data.ignoredGroupDdds ?? []);
    this.data.autoShutdownEnabled ??= false;
    this.data.autoShutdownMinutes = normalizeMinutes(this.data.autoShutdownMinutes);
    this.data.awayMessageEnabled ??= false;
    this.data.awayMessage = String(this.data.awayMessage ?? "").slice(0, MAX_AWAY_MESSAGE_LENGTH);
    this.data.rideAssistantEnabled ??= true;
    this.data.rideAutoChargeEnabled ??= true;
    this.data.rideChargeMessage = String(this.data.rideChargeMessage ?? "").slice(0, MAX_RIDE_CHARGE_MESSAGE_LENGTH);
    if (!RIDE_CHARGE_TRIGGERS.includes(this.data.rideChargeTrigger)) this.data.rideChargeTrigger = "near_2min";
    for (const key of RIDE_MESSAGE_KEYS) this.data[key] = String(this.data[key] ?? "").slice(0, MAX_RIDE_MESSAGE_LENGTH);
    this.data.rideVehicleDetailsEnabled ??= true;
    this.data.notificationSoundEnabled ??= true;
  }

  get(): Settings {
    return this.data;
  }

  /** Mensagem em uso (a sua ou a padrão), pra quem for enviar o recado automático. */
  awayMessageText(): string {
    return this.data.awayMessage.trim() || DEFAULT_AWAY_MESSAGE;
  }

  /** Mensagem em uso (a sua ou a padrão) junto com a cobrança automática da corrida. */
  rideChargeMessageText(): string {
    return this.data.rideChargeMessage.trim() || DEFAULT_RIDE_CHARGE_MESSAGE;
  }

  /** Aviso de corrida em uso (o seu ou o padrão) pra um marco. */
  rideMessageText(key: RideMessageKey): string {
    return this.data[key].trim() || DEFAULT_RIDE_MESSAGES[key];
  }

  update(input: SettingsInput): Settings {
    if (input.ignoreAdminNames !== undefined) this.data.ignoreAdminNames = input.ignoreAdminNames;
    if (input.noReplyNumbers !== undefined) this.data.noReplyNumbers = normalizeNumbers(input.noReplyNumbers);
    if (input.ignoreGroupDddsEnabled !== undefined) this.data.ignoreGroupDddsEnabled = !!input.ignoreGroupDddsEnabled;
    if (input.ignoredGroupDdds !== undefined) this.data.ignoredGroupDdds = normalizeDdds(input.ignoredGroupDdds);
    if (input.autoShutdownEnabled !== undefined) this.data.autoShutdownEnabled = !!input.autoShutdownEnabled;
    if (input.autoShutdownMinutes !== undefined) {
      this.data.autoShutdownMinutes = normalizeMinutes(input.autoShutdownMinutes);
    }
    if (input.awayMessageEnabled !== undefined) this.data.awayMessageEnabled = !!input.awayMessageEnabled;
    if (input.awayMessage !== undefined) this.data.awayMessage = String(input.awayMessage).trim().slice(0, MAX_AWAY_MESSAGE_LENGTH);
    if (input.rideAssistantEnabled !== undefined) this.data.rideAssistantEnabled = !!input.rideAssistantEnabled;
    if (input.rideAutoChargeEnabled !== undefined) this.data.rideAutoChargeEnabled = !!input.rideAutoChargeEnabled;
    if (input.rideChargeMessage !== undefined) this.data.rideChargeMessage = String(input.rideChargeMessage).trim().slice(0, MAX_RIDE_CHARGE_MESSAGE_LENGTH);
    if (input.rideChargeTrigger !== undefined && RIDE_CHARGE_TRIGGERS.includes(input.rideChargeTrigger)) {
      this.data.rideChargeTrigger = input.rideChargeTrigger;
    }
    for (const key of RIDE_MESSAGE_KEYS) {
      const value = input[key];
      if (value === undefined) continue;
      const text = String(value).trim().slice(0, MAX_RIDE_MESSAGE_LENGTH);
      this.data[key] = text === DEFAULT_RIDE_MESSAGES[key] ? "" : text; // igual ao padrão = "usar o padrão"
    }
    if (input.rideVehicleDetailsEnabled !== undefined) this.data.rideVehicleDetailsEnabled = !!input.rideVehicleDetailsEnabled;
    if (input.notificationSoundEnabled !== undefined) this.data.notificationSoundEnabled = !!input.notificationSoundEnabled;
    this.save();
    return this.data;
  }

  isNoReplyNumber(phoneDigits: string): boolean {
    const incoming = extractPhoneKey(phoneDigits);
    return this.data.noReplyNumbers.some((stored) =>
      phoneKeysMatch(extractPhoneKey(stored), incoming)
    );
  }

  /** Esse telefone tem um DDD que está na lista de ignorados em grupo (e a opção está ligada)? */
  isIgnoredGroupDdd(phoneDigits: string): boolean {
    if (!this.data.ignoreGroupDddsEnabled) return false;
    const ddd = extractPhoneKey(phoneDigits).ddd;
    return !!ddd && this.data.ignoredGroupDdds.includes(ddd);
  }
}
