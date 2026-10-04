import { randomUUID } from "crypto";
import { JsonFileStore } from "./base-store";

export type QuickReplyChipType = "fixed" | "random";

export interface QuickReplyChip {
  id: string;
  label: string;
  /** "fixed" usa `value` direto; "random" sorteia uma das variantes a cada clique. */
  type: QuickReplyChipType;
  value: string;
  /** Destaque visual (chip com cor diferente), só estética. */
  highlight: boolean;
}

export interface QuickReplySettings {
  /** Liga a barra de chips acima da caixa de texto + o botão "responder com variante" nas mensagens. */
  enabled: boolean;
  /** Desligado: o chip só preenche a caixa de texto, pra revisar antes de enviar. */
  chipsSendOnClick: boolean;
  /** O botão de citar mensagem (ícone de dado) preenche uma variante; ligado, ele já envia também. */
  replyVariantAlsoSends: boolean;
  /** Frases usadas pelo sorteio (chips do tipo "random" e o botão de responder com variante). */
  variants: string[];
  chips: QuickReplyChip[];
}

export interface QuickReplyChipInput {
  id?: string;
  label: string;
  type: QuickReplyChipType;
  value?: string;
  highlight?: boolean;
}

export interface QuickReplySettingsInput {
  enabled?: boolean;
  chipsSendOnClick?: boolean;
  replyVariantAlsoSends?: boolean;
  variants?: string[];
  chips?: QuickReplyChipInput[];
}

const MAX_VARIANTS = 200;
const MAX_VARIANT_LENGTH = 300;
const MAX_CHIPS = 50;
const MAX_CHIP_LABEL_LENGTH = 40;
const MAX_CHIP_VALUE_LENGTH = 1000;

const DEFAULT_SETTINGS: QuickReplySettings = {
  enabled: false,
  chipsSendOnClick: false,
  replyVariantAlsoSends: false,
  variants: [],
  chips: [],
};

function normalizeVariants(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((v) => String(v ?? "").trim().slice(0, MAX_VARIANT_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_VARIANTS);
}

function normalizeChips(list: unknown): QuickReplyChip[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((raw): QuickReplyChip | null => {
      const input = raw as QuickReplyChipInput;
      const label = String(input?.label ?? "").trim().slice(0, MAX_CHIP_LABEL_LENGTH);
      if (!label) return null;
      const type: QuickReplyChipType = input?.type === "random" ? "random" : "fixed";
      const value = type === "fixed" ? String(input?.value ?? "").trim().slice(0, MAX_CHIP_VALUE_LENGTH) : "";
      return {
        id: input?.id && String(input.id).trim() ? String(input.id).trim() : randomUUID(),
        label,
        type,
        value,
        highlight: !!input?.highlight,
      };
    })
    .filter((c): c is QuickReplyChip => c !== null)
    .slice(0, MAX_CHIPS);
}

/** Respostas rápidas do chat (painel): chips de texto pronto + variantes sorteadas, por conta. */
export class QuickReplyStore extends JsonFileStore<QuickReplySettings> {
  constructor(file: string) {
    super(file, { ...DEFAULT_SETTINGS, variants: [], chips: [] });
    this.data.enabled = !!this.data.enabled;
    this.data.chipsSendOnClick = !!this.data.chipsSendOnClick;
    this.data.replyVariantAlsoSends = !!this.data.replyVariantAlsoSends;
    this.data.variants = normalizeVariants(this.data.variants);
    this.data.chips = normalizeChips(this.data.chips);
  }

  get(): QuickReplySettings {
    return this.data;
  }

  update(input: QuickReplySettingsInput): QuickReplySettings {
    if (input.enabled !== undefined) this.data.enabled = !!input.enabled;
    if (input.chipsSendOnClick !== undefined) this.data.chipsSendOnClick = !!input.chipsSendOnClick;
    if (input.replyVariantAlsoSends !== undefined) this.data.replyVariantAlsoSends = !!input.replyVariantAlsoSends;
    if (input.variants !== undefined) this.data.variants = normalizeVariants(input.variants);
    if (input.chips !== undefined) this.data.chips = normalizeChips(input.chips);
    this.save();
    return this.data;
  }
}
