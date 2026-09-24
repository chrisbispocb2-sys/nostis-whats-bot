export function digitsOnly(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

function checkDigit(digits: number[], weights: number[]): number {
  const sum = digits.reduce((acc, d, i) => acc + d * weights[i]!, 0);
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

/** CPF com 11 dígitos e dígitos verificadores corretos (sem aceitar 111.111.111-11 etc.). */
export function isValidCpf(value: unknown): boolean {
  const cpf = digitsOnly(value);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;

  const nums = cpf.split("").map(Number);
  const d1 = checkDigit(nums.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = checkDigit(nums.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d1 === nums[9] && d2 === nums[10];
}

/** CNPJ com 14 dígitos e dígitos verificadores corretos. */
export function isValidCnpj(value: unknown): boolean {
  const cnpj = digitsOnly(value);
  if (cnpj.length !== 14 || /^(\d)\1{13}$/.test(cnpj)) return false;

  const nums = cnpj.split("").map(Number);
  const d1 = checkDigit(nums.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = checkDigit(nums.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d1 === nums[12] && d2 === nums[13];
}

/** Esconde o começo de um documento/chave, deixando só o final ("•••••••8909"). */
export function maskTail(value: string, keep = 4): string {
  if (value.length <= keep) return value;
  return "•".repeat(value.length - keep) + value.slice(-keep);
}

/** Esconde a chave PIX pra guardar no histórico: e-mail vira "a•••@dominio", o resto mostra só o final. */
export function maskPixKey(type: string, key: string): string {
  if (type === "EMAIL") {
    const [user = "", domain = ""] = key.split("@");
    return `${user.slice(0, 1)}•••@${domain}`;
  }
  return maskTail(key, 4);
}
