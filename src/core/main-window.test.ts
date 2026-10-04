import { describe, expect, test } from "bun:test";
import { buildMainWindowCommand, mainWindowProfileDir, mainWindowUrl } from "./main-window";

describe("janela principal do painel (app disfarçado, estilo client)", () => {
  test("mainWindowUrl: endereço simples, sem parâmetro nenhum", () => {
    expect(mainWindowUrl(3000)).toBe("http://127.0.0.1:3000/");
  });

  test("mainWindowProfileDir: fica dentro da pasta temporária, num nome próprio", () => {
    expect(mainWindowProfileDir("C:\\tmp")).toBe("C:\\tmp\\main-window-profile");
  });

  test("buildMainWindowCommand: abre em modo app (sem barra de endereço), perfil isolado, tamanho padrão", () => {
    const url = mainWindowUrl(3000);
    const cmd = buildMainWindowCommand("chrome.exe", url, "C:\\tmp\\main-window-profile");

    expect(cmd[0]).toBe("chrome.exe");
    expect(cmd).toContain(`--app=${url}`);
    expect(cmd).toContain("--user-data-dir=C:\\tmp\\main-window-profile");
    expect(cmd).toContain("--window-size=1440,900");
    expect(cmd).toContain("--no-first-run");
    // perfil só pra esta janela: nada de sincronização/extensões/atualizações em segundo plano
    expect(cmd).toContain("--disable-sync");
    expect(cmd).toContain("--disable-extensions");
    expect(cmd).toContain("--disable-background-networking");
  });
});
