import { generateKeyPair } from "../src/license-token";

// Gera o par de chaves que assina as licenças. Rode UMA vez: trocar a chave depois invalida a
// licença de todo mundo (todos precisam entrar de novo) e exige gerar um exe novo com a pública nova.
const { privateKey, publicKey } = generateKeyPair();

console.log("Chave PRIVADA — vai só no .env do servidor (nunca no exe, nunca pra ninguém):\n");
console.log(`LICENSE_PRIVATE_KEY=${privateKey}\n`);
console.log("Chave PÚBLICA — cole em app/src/config/license.ts, no campo publicKey:\n");
console.log(`${publicKey}\n`);
