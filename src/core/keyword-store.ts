import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { randomUUID } from "crypto";
import type { ProfileStore } from "./profile-store";

export interface KeywordRule {
  id: string;
  keywords: string[];
  responses: string[];
  cooldownMinutes: number;
  /** true = responde citando (reply) a mensagem que gerou o gatilho; false = manda solto no grupo */
  replyToTrigger: boolean;
  /** Emoji de reação enviado na mensagem-gatilho (além da resposta em texto), ou null pra não reagir */
  reactionEmoji: string | null;
  /** Registra métricas (grupo, pessoa, horário) toda vez que essa regra dispara */
  trackMetrics: boolean;
  /**
   * Em vez de mandar a resposta como texto, manda um botão de URL que leva
   * direto pro privado do bot. Experimental: usa um recurso não-oficial da
   * lib pra renderizar o botão (finge ser conta Business), então ignora
   * `replyToTrigger` (não dá pra citar a mensagem-gatilho nesse modo).
   */
  useUrlButton: boolean;
  /** Texto do botão quando useUrlButton está ativo. */
  buttonText: string | null;
  /**
   * Mensagem pré-pronta que já aparece digitada na conversa privada quando a
   * pessoa clica no botão (vai no `?text=` do link wa.me). Ela ainda precisa
   * apertar enviar. Só vale quando useUrlButton está ativo.
   */
  buttonMessage: string | null;
  /**
   * Quando quem disparou a regra no grupo escreve no privado, o bot puxa a
   * conversa e pergunta os endereços (só o que ainda falta, se o cliente já
   * mandou algum).
   */
  greetingEnabled: boolean;
  /** Saudação enviada quando o cliente ainda não mandou nenhum endereço. Vazio = usa a padrão. */
  greetingMessages: string[];
  /** Enviada quando o cliente mandou só um endereço. Vazio = usa a padrão. */
  greetingPartialMessages: string[];
  /** Enviada quando o cliente já mandou origem e destino (ou áudio/foto). Vazio = usa a padrão. */
  greetingCompleteMessages: string[];
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface KeywordRuleInput {
  keywords: string[];
  responses: string[];
  cooldownMinutes?: number;
  replyToTrigger?: boolean;
  reactionEmoji?: string | null;
  trackMetrics?: boolean;
  useUrlButton?: boolean;
  buttonText?: string | null;
  buttonMessage?: string | null;
  greetingEnabled?: boolean;
  greetingMessages?: string[];
  greetingPartialMessages?: string[];
  greetingCompleteMessages?: string[];
  enabled?: boolean;
}

export const DEFAULT_BUTTON_TEXT = "📲 Chama no PV";

export const DEFAULT_GREETING_MESSAGE =
  "Olá! 👋 Já vou te atender. Me envie o endereço de *origem* (onde te busco) e o de *destino* (para onde vai), por favor. 📍";
export const DEFAULT_GREETING_PARTIAL_MESSAGE =
  "Recebi um endereço! 📍 Me envie também o que falta: de onde te busco e para onde você vai.";
export const DEFAULT_GREETING_COMPLETE_MESSAGE =
  "Recebi! 🚗 Já vou verificar tudo e te respondo rapidinho.";

/** Conjunto fixo de reações disponíveis na dashboard. */
export const ALLOWED_REACTIONS = ["❤️", "👍", "🙏", "🚀", "🔥"] as const;

function normalizeReaction(emoji: string | null | undefined): string | null {
  if (!emoji) return null;
  if (!(ALLOWED_REACTIONS as readonly string[]).includes(emoji)) {
    throw new Error(`Reação inválida: "${emoji}". Use uma das opções disponíveis.`);
  }
  return emoji;
}

// Regra padrão preservada da configuração original, usada apenas quando um
// perfil ainda não tem nenhum arquivo de regras salvo. É uma função (não uma
// constante) porque cada perfil novo em branco precisa de um ID e
// timestamps próprios, não de uma instância compartilhada entre perfis.
function createDefaultRules(): KeywordRule[] {
  const now = Date.now();
  return [
    {
      id: randomUUID(),
      keywords: ["uber on"],
      responses: ["On, chama pv", "pv", "Chama pv"],
      cooldownMinutes: 0,
      replyToTrigger: true,
      reactionEmoji: null,
      trackMetrics: false,
      useUrlButton: false,
      buttonText: null,
      buttonMessage: null,
      greetingEnabled: false,
      greetingMessages: [],
      greetingPartialMessages: [],
      greetingCompleteMessages: [],
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

function normalizeList(items: string[]): string[] {
  return items.map((item) => item.trim()).filter(Boolean);
}

export class KeywordStore {
  private rules: KeywordRule[] = [];
  private lastTriggered = new Map<string, number>();

  constructor(private readonly profiles: ProfileStore) {
    this.load();
  }

  private rulesFile(): string {
    return join(this.profiles.activeDir(), "keyword-rules.json");
  }

  private load(): void {
    const file = this.rulesFile();
    if (!existsSync(file)) {
      this.rules = createDefaultRules();
      this.save();
      return;
    }
    try {
      const raw = readFileSync(file, "utf-8");
      const parsed = JSON.parse(raw) as KeywordRule[];
      // Migra regras salvas antes dos campos replyToTrigger/reactionEmoji/trackMetrics
      // existirem, preservando o comportamento anterior (sempre citava, nunca reagia
      // ou rastreava métricas).
      this.rules = parsed.map((rule) => ({
        ...rule,
        replyToTrigger: rule.replyToTrigger ?? true,
        reactionEmoji: rule.reactionEmoji ?? null,
        trackMetrics: rule.trackMetrics ?? false,
        useUrlButton: rule.useUrlButton ?? false,
        buttonText: rule.buttonText ?? null,
        buttonMessage: rule.buttonMessage ?? null,
        greetingEnabled: rule.greetingEnabled ?? false,
        greetingMessages: rule.greetingMessages ?? [],
        greetingPartialMessages: rule.greetingPartialMessages ?? [],
        greetingCompleteMessages: rule.greetingCompleteMessages ?? [],
      }));
    } catch (err) {
      console.error("Falha ao carregar keyword-rules.json:", err);
      this.rules = [];
    }
  }

  private save(): void {
    try {
      const file = this.rulesFile();
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(this.rules, null, 2), "utf-8");
    } catch (err) {
      console.error("Falha ao salvar keyword-rules.json:", err);
    }
  }

  /** Recarrega as regras do perfil atualmente ativo (chamado ao trocar/importar perfil). */
  reload(): void {
    this.lastTriggered.clear();
    this.load();
  }

  list(): KeywordRule[] {
    return this.rules;
  }

  get(id: string): KeywordRule | undefined {
    return this.rules.find((rule) => rule.id === id);
  }

  create(input: KeywordRuleInput): KeywordRule {
    const now = Date.now();
    const rule: KeywordRule = {
      id: randomUUID(),
      keywords: normalizeList(input.keywords),
      responses: normalizeList(input.responses),
      cooldownMinutes: Math.max(0, input.cooldownMinutes ?? 0),
      replyToTrigger: input.replyToTrigger ?? true,
      reactionEmoji: normalizeReaction(input.reactionEmoji),
      trackMetrics: input.trackMetrics ?? false,
      useUrlButton: input.useUrlButton ?? false,
      buttonText: input.buttonText?.trim() || null,
      buttonMessage: input.buttonMessage?.trim() || null,
      greetingEnabled: input.greetingEnabled ?? false,
      greetingMessages: normalizeList(input.greetingMessages ?? []),
      greetingPartialMessages: normalizeList(input.greetingPartialMessages ?? []),
      greetingCompleteMessages: normalizeList(input.greetingCompleteMessages ?? []),
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
    this.rules.push(rule);
    this.save();
    return rule;
  }

  update(id: string, input: Partial<KeywordRuleInput>): KeywordRule | undefined {
    const rule = this.get(id);
    if (!rule) return undefined;

    if (input.keywords) rule.keywords = normalizeList(input.keywords);
    if (input.responses) rule.responses = normalizeList(input.responses);
    if (input.cooldownMinutes !== undefined) {
      rule.cooldownMinutes = Math.max(0, input.cooldownMinutes);
    }
    if (input.replyToTrigger !== undefined) rule.replyToTrigger = input.replyToTrigger;
    if (input.reactionEmoji !== undefined) rule.reactionEmoji = normalizeReaction(input.reactionEmoji);
    if (input.trackMetrics !== undefined) rule.trackMetrics = input.trackMetrics;
    if (input.useUrlButton !== undefined) rule.useUrlButton = input.useUrlButton;
    if (input.buttonText !== undefined) rule.buttonText = input.buttonText?.trim() || null;
    if (input.buttonMessage !== undefined) rule.buttonMessage = input.buttonMessage?.trim() || null;
    if (input.greetingEnabled !== undefined) rule.greetingEnabled = input.greetingEnabled;
    if (input.greetingMessages) rule.greetingMessages = normalizeList(input.greetingMessages);
    if (input.greetingPartialMessages) {
      rule.greetingPartialMessages = normalizeList(input.greetingPartialMessages);
    }
    if (input.greetingCompleteMessages) {
      rule.greetingCompleteMessages = normalizeList(input.greetingCompleteMessages);
    }
    if (input.enabled !== undefined) rule.enabled = input.enabled;
    rule.updatedAt = Date.now();

    this.save();
    return rule;
  }

  delete(id: string): boolean {
    const before = this.rules.length;
    this.rules = this.rules.filter((rule) => rule.id !== id);
    if (this.rules.length === before) return false;
    this.save();
    return true;
  }

  /**
   * Retorna a primeira regra ativa cuja mensagem seja EXATAMENTE igual (sem
   * diferenciar maiúsculas/minúsculas) a uma das palavras-chave cadastradas.
   * Não é correspondência parcial: a mensagem não pode ter nada a mais nem a menos.
   */
  findMatch(message: string): KeywordRule | undefined {
    const normalized = message.trim().toLowerCase();
    return this.rules.find(
      (rule) =>
        rule.enabled &&
        rule.keywords.length > 0 &&
        rule.keywords.some((keyword) => normalized === keyword.trim().toLowerCase())
    );
  }

  /** Cooldown é isolado por regra + grupo, então um grupo não bloqueia o outro. */
  isOnCooldown(ruleId: string, jid: string): boolean {
    const rule = this.get(ruleId);
    if (!rule || rule.cooldownMinutes <= 0) return false;

    const last = this.lastTriggered.get(`${ruleId}:${jid}`);
    if (!last) return false;

    return Date.now() - last < rule.cooldownMinutes * 60_000;
  }

  markTriggered(ruleId: string, jid: string): void {
    this.lastTriggered.set(`${ruleId}:${jid}`, Date.now());
  }
}
