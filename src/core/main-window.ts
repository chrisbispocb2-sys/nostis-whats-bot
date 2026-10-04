import { join } from "path";

/** Tamanho da janela principal do painel ao abrir (a pessoa pode redimensionar depois à vontade). */
export const MAIN_WINDOW_SIZE = { width: 1440, height: 900 };

/** Endereço do painel inteiro (sem nenhum parâmetro especial, ao contrário da janela de pagamento). */
export function mainWindowUrl(port: number): string {
  return `http://127.0.0.1:${port}/`;
}

export function mainWindowProfileDir(tempDir: string): string {
  return join(tempDir, "main-window-profile");
}

/**
 * Comando que abre o painel como se fosse um aplicativo de verdade: sem barra de endereço, sem
 * abas — perfil próprio, independente das suas abas e logins do navegador do dia a dia (mesma
 * ideia da janela de pagamento da MisticPay, só que maior e sem posição fixa).
 */
export function buildMainWindowCommand(browser: string, url: string, profileDir: string): string[] {
  return [
    browser,
    `--user-data-dir=${profileDir}`,
    `--app=${url}`,
    `--window-size=${MAIN_WINDOW_SIZE.width},${MAIN_WINDOW_SIZE.height}`,
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
}
