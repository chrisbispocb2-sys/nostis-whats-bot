import { existsSync } from "fs";
import { join } from "path";

/** Tamanho da janelinha de pagamento (bom pra caber ao lado de uma conversa do WhatsApp). */
export const PAY_WINDOW_SIZE = { width: 500, height: 780 };

export interface PayWindowRect {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

/** Endereço do painel em "modo pagamento": só o modal da MisticPay, ocupando a janela. */
export function payWindowUrl(port: number, accountId: string): string {
  return `http://127.0.0.1:${port}/?pay=1&account=${encodeURIComponent(accountId)}`;
}

/** Navegador baseado em Chromium instalado (Chrome, Edge ou Brave), que sabe abrir uma janela "de aplicativo" sem barra de endereço. */
export function findBrowser(
  exists: (path: string) => boolean = existsSync,
  env: Record<string, string | undefined> = process.env
): string | null {
  const programFiles = env["ProgramFiles"] ?? "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const localAppData = env["LOCALAPPDATA"] ?? "";
  const candidates = [
    join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(programFiles, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    join(programFilesX86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    join(localAppData, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
  ];
  return candidates.find((path) => exists(path)) ?? null;
}

/**
 * Comando que abre a janela de pagamento. Usa um perfil próprio do navegador
 * (independente das suas abas e logins), o que também faz a janela nascer
 * exatamente no tamanho e no lugar pedidos.
 */
export function buildPayWindowCommand(browser: string, url: string, profileDir: string, rect: PayWindowRect = {}): string[] {
  const width = Math.round(rect.width ?? PAY_WINDOW_SIZE.width);
  const height = Math.round(rect.height ?? PAY_WINDOW_SIZE.height);
  const command = [
    browser,
    `--user-data-dir=${profileDir}`,
    `--app=${url}`,
    `--window-size=${width},${height}`,
    "--no-first-run",
    "--no-default-browser-check",
    // Perfil novo e só pra esta janela: sem sincronização, extensões, apps padrão nem atualizações em segundo plano
    "--disable-sync",
    "--disable-extensions",
    "--disable-default-apps",
    "--disable-component-update",
    "--disable-background-networking",
    "--no-service-autorun",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
  ];
  if (rect.x !== undefined && rect.y !== undefined) command.push(`--window-position=${Math.round(rect.x)},${Math.round(rect.y)}`);
  return command;
}

/** Sem Chrome/Edge: abre numa aba comum do navegador padrão. */
export function buildFallbackCommand(url: string): string[] {
  return ["cmd", "/c", "start", "", url];
}

export function payWindowProfileDir(tempDir: string): string {
  return join(tempDir, "pay-window-profile");
}
