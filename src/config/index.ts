export * from "./paths";

export const CONFIG = {
  defaultPort: 3000,
  defaultButtonText: "📲 Chama no PV",
  allowedReactions: ["❤️", "👍", "🙏", "🚀", "🔥"] as const,
  maxLeads: 500,
  correlationWindowMs: 24 * 60 * 60 * 1000, // 24 horas
  callGapMs: 2 * 60 * 60 * 1000, // 2 horas
  greetingCooldownMs: 2 * 60 * 60 * 1000, // 2 horas: não saúda a mesma pessoa de novo no meio de uma conversa
  maxStickers: 200,
  banWarningMessage: "🚫 Você foi banido(a) pelo bot e não pode mais chamar por aqui.",
} as const;
