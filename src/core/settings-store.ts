import { JsonFileStore } from "./base-store";
import { extractPhoneKey, phoneKeysMatch } from "../utils/jid";

export interface Settings {
  /** Ignora por completo mensagens de quem tem "ADM" no nome do WhatsApp. */
  ignoreAdminNames: boolean;
  /** Números (só dígitos) que disparam a regra normalmente, mas não recebem a resposta de texto. */
  noReplyNumbers: string[];
  /**
   * Segurança: desliga o bot sozinho quando chega uma mensagem no privado e
   * ninguém responde dentro de `autoShutdownMinutes` (sinal de que não tem
   * ninguém atendendo, então o bot não deve continuar chamando gente).
   */
  autoShutdownEnabled: boolean;
  autoShutdownMinutes: number;
}

export interface SettingsInput {
  ignoreAdminNames?: boolean;
  noReplyNumbers?: string[];
  autoShutdownEnabled?: boolean;
  autoShutdownMinutes?: number;
}

export const DEFAULT_AUTO_SHUTDOWN_MINUTES = 5;
const MAX_AUTO_SHUTDOWN_MINUTES = 720;

const DEFAULT_SETTINGS: Settings = {
  ignoreAdminNames: false,
  noReplyNumbers: [],
  autoShutdownEnabled: false,
  autoShutdownMinutes: DEFAULT_AUTO_SHUTDOWN_MINUTES,
};

function normalizeNumbers(list: string[]): string[] {
  return [...new Set(list.map((n) => n.replace(/\D/g, "")).filter(Boolean))];
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
    this.data.autoShutdownEnabled ??= false;
    this.data.autoShutdownMinutes = normalizeMinutes(this.data.autoShutdownMinutes);
  }

  get(): Settings {
    return this.data;
  }

  update(input: SettingsInput): Settings {
    if (input.ignoreAdminNames !== undefined) this.data.ignoreAdminNames = input.ignoreAdminNames;
    if (input.noReplyNumbers !== undefined) this.data.noReplyNumbers = normalizeNumbers(input.noReplyNumbers);
    if (input.autoShutdownEnabled !== undefined) this.data.autoShutdownEnabled = !!input.autoShutdownEnabled;
    if (input.autoShutdownMinutes !== undefined) {
      this.data.autoShutdownMinutes = normalizeMinutes(input.autoShutdownMinutes);
    }
    this.save();
    return this.data;
  }

  isNoReplyNumber(phoneDigits: string): boolean {
    const incoming = extractPhoneKey(phoneDigits);
    return this.data.noReplyNumbers.some((stored) =>
      phoneKeysMatch(extractPhoneKey(stored), incoming)
    );
  }
}
