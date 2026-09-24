import { describe, expect, test } from "bun:test";
import { centsToReais, formatBRL, parseAmountToCents, renderTemplate } from "./money";
import { isValidCnpj, isValidCpf, maskPixKey, maskTail } from "./documents";

describe("valores em reais", () => {
  test.each([
    [25, 2500],
    [25.5, 2550],
    [0.01, 1],
    [4.55, 455],
    [19.9, 1990],
    [1234.56, 123456],
    ["25", 2500],
    ["25,50", 2550],
    ["25.50", 2550],
    ["R$ 25,50", 2550],
    ["1.234,56", 123456],
    [" 10 ", 1000],
  ])("%p → %p centavos", (input, cents) => {
    expect(parseAmountToCents(input)).toBe(cents);
  });

  test.each([0, -5, NaN, Infinity, 10.005, "abc", "", "1,2,3", null, undefined, {}, 1_000_000.01, "0,00"])(
    "%p é inválido",
    (input) => {
      expect(parseAmountToCents(input)).toBeNull();
    }
  );

  test("não erra por causa de float (0.1 + 0.2, 1.15...)", () => {
    expect(parseAmountToCents(0.1 + 0.2)).toBe(30); // 0.30000000000000004 é R$ 0,30
    expect(parseAmountToCents(1.15)).toBe(115);
    expect(parseAmountToCents(8.2)).toBe(820);
  });

  test("formata em reais", () => {
    expect(formatBRL(2550)).toBe("R$ 25,50");
    expect(formatBRL(5)).toBe("R$ 0,05");
    expect(formatBRL(123456789)).toBe("R$ 1.234.567,89");
    expect(formatBRL(100000)).toBe("R$ 1.000,00");
    expect(formatBRL(0)).toBe("R$ 0,00");
  });

  test("centavos → reais para a API", () => {
    expect(centsToReais(455)).toBe(4.55);
    expect(centsToReais(2550)).toBe(25.5);
    expect(centsToReais(1)).toBe(0.01);
  });
});

describe("mensagens com marcadores", () => {
  test("troca os marcadores (sem diferenciar maiúsculas)", () => {
    expect(renderTemplate("Oi {nome}, são {VALOR}!", { nome: "Maria", valor: "R$ 10,00" })).toBe("Oi Maria, são R$ 10,00!");
  });

  test("marcador desconhecido fica como está", () => {
    expect(renderTemplate("Oi {nome} {xpto}", { nome: "Maria" })).toBe("Oi Maria {xpto}");
  });

  test("marcador vazio não deixa linhas em branco sobrando", () => {
    const out = renderTemplate("Cobrança {valor}\n{descricao}\n\nPague agora", { valor: "R$ 5,00", descricao: "" });
    expect(out).toBe("Cobrança R$ 5,00\n\nPague agora");
  });

  test("mantém as quebras de linha e o *negrito* do WhatsApp", () => {
    expect(renderTemplate("*{valor}*\nok", { valor: "R$ 1,00" })).toBe("*R$ 1,00*\nok");
  });
});

describe("documentos", () => {
  test("CPF", () => {
    expect(isValidCpf("529.982.247-25")).toBe(true);
    expect(isValidCpf("52998224725")).toBe(true);
    expect(isValidCpf("12345678909")).toBe(true);
    expect(isValidCpf("52998224726")).toBe(false);
    expect(isValidCpf("11111111111")).toBe(false);
    expect(isValidCpf("123")).toBe(false);
    expect(isValidCpf("")).toBe(false);
    expect(isValidCpf(null)).toBe(false);
  });

  test("CNPJ", () => {
    expect(isValidCnpj("11.222.333/0001-81")).toBe(true);
    expect(isValidCnpj("11222333000180")).toBe(false);
    expect(isValidCnpj("00000000000000")).toBe(false);
  });

  test("máscaras", () => {
    expect(maskTail("12345678909")).toBe("•••••••8909");
    expect(maskTail("123")).toBe("123");
    expect(maskPixKey("EMAIL", "maria@email.com")).toBe("m•••@email.com");
    expect(maskPixKey("CPF", "12345678909")).toBe("•••••••8909");
  });
});
