import { describe, expect, test } from "bun:test";
import { linkifyHtml } from "./utils.js";

const link = (href, label = href) => `<a class="chat-link" href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;

describe("linkifyHtml", () => {
  test("link completo no meio da frase vira clicável; o resto do texto fica igual", () => {
    expect(linkifyHtml("Chamei, olha o motorista: https://trip.uber.com/QUAF2AH agora")).toBe(
      `Chamei, olha o motorista: ${link("https://trip.uber.com/QUAF2AH")} agora`
    );
  });

  test("'www.' e domínio solto ganham https:// no endereço, mas o texto mostrado é o que a pessoa escreveu", () => {
    expect(linkifyHtml("entra em www.exemplo.com.br")).toBe(`entra em ${link("https://www.exemplo.com.br", "www.exemplo.com.br")}`);
    expect(linkifyHtml("trip.uber.com/ABC123")).toBe(link("https://trip.uber.com/ABC123", "trip.uber.com/ABC123"));
  });

  test("pontuação no fim da frase não entra no link", () => {
    expect(linkifyHtml("veja em https://exemplo.com/pagina.")).toBe(`veja em ${link("https://exemplo.com/pagina")}.`);
    expect(linkifyHtml("(https://exemplo.com)")).toBe(`(${link("https://exemplo.com")})`);
    expect(linkifyHtml("já viu https://exemplo.com?")).toBe(`já viu ${link("https://exemplo.com")}?`);
  });

  test("vários links e quebras de linha na mesma mensagem", () => {
    expect(linkifyHtml("https://a.com\nhttps://b.com/x?y=1&z=2")).toBe(`${link("https://a.com")}\n${link("https://b.com/x?y=1&amp;z=2")}`);
  });

  test("o que não é link fica como texto: e-mail, valor em reais, horário, frase sem espaço depois do ponto", () => {
    for (const text of ["fulano@gmail.com", "25,00 chama ?", "entrar no salão às 18:00", "R$ 1.250,00", "ok.obrigado", "(11)92187-5114 Eduardo"]) {
      expect(linkifyHtml(text)).toBe(text);
    }
  });

  test("HTML e tentativa de script no texto são escapados (nunca viram tag nem javascript:)", () => {
    expect(linkifyHtml('<img src=x onerror=alert(1)> javascript:alert(1)')).toBe("&lt;img src=x onerror=alert(1)&gt; javascript:alert(1)");
    expect(linkifyHtml('https://exemplo.com/"onmouseover="x')).toBe(`${link("https://exemplo.com/")}&quot;onmouseover=&quot;x`);
  });

  test("texto vazio ou ausente não quebra", () => {
    expect(linkifyHtml("")).toBe("");
    expect(linkifyHtml(null)).toBe("");
  });
});
