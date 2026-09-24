import { describe, expect, test } from "bun:test";
import { analyzeAddresses, type AddressLevel } from "./address";

function level(texts: string[], extra: { locations?: number; hasOpaqueMedia?: boolean } = {}): AddressLevel {
  return analyzeAddresses({ texts, ...extra }).level;
}

describe("cliente ainda não mandou endereço", () => {
  test.each([
    "Oi",
    "Oi! Vim pelo grupo e quero ser atendido",
    "Bom dia, você está on?",
    "Preciso de uma corrida",
    "quanto custa?",
    "qual rua?",
    "Oi, boa noite! Preciso ir ao centro amanhã cedo, tem carro?",
    "",
  ])("%p → none", (text) => {
    expect(level([text])).toBe("none");
  });
});

describe("cliente mandou um endereço só", () => {
  test.each([
    "Rua das Flores, 123",
    "Estou na Av. Brasil 500",
    "Quero ir pro shopping",
    "Bairro Santa Luzia",
    "CEP 12345-678",
    "Av Brasil esquina com Rua Sete",
  ])("%p → partial", (text) => {
    expect(level([text])).toBe("partial");
  });

  test("localização do WhatsApp conta como um endereço", () => {
    expect(level(["Oi"], { locations: 1 })).toBe("partial");
  });

  test("o mesmo endereço repetido não conta duas vezes", () => {
    expect(level(["Rua das Flores, 123", "rua das flores, 123"])).toBe("partial");
  });
});

describe("cliente já mandou origem e destino", () => {
  test.each([
    "Rua das Flores, 123 para Av. Brasil, 500",
    "Rua das Flores, 123 pra Av. Brasil, 500",
    "Rua A, 10 -> Rua B, 20",
    "Rua A, 10 e rua B, 20",
    "Origem: Rua A 10\nDestino: Shopping Center",
    "Origem: casa da minha mãe Destino: rodoviária",
    "Da rodoviária pro hospital",
    "Saindo da Praça Central até o aeroporto",
    "Rua A, 10\nRua B, 20",
  ])("%p → complete", (text) => {
    expect(level([text])).toBe("complete");
  });

  test("endereços em mensagens separadas somam", () => {
    expect(level(["Rua das Flores, 123", "Av. Brasil, 500"])).toBe("complete");
  });

  test("uma localização + um endereço em texto", () => {
    expect(level(["Vou pro shopping"], { locations: 1 })).toBe("complete");
  });

  test("áudio ou foto: o bot não consegue ler, então não pergunta de novo", () => {
    expect(level(["Oi"], { hasOpaqueMedia: true })).toBe("complete");
  });

  test("acentos e maiúsculas não atrapalham", () => {
    expect(level(["RUA DAS FLORES, 123 PARA AVENIDA BRASIL, 500"])).toBe("complete");
    expect(level(["Da Praça Sete até a Rodoviária"])).toBe("complete");
  });
});
