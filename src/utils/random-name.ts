const FIRST_NAMES = [
  "Ana", "Beatriz", "Bruna", "Camila", "Carla", "Carolina", "Daniela", "Eduarda", "Fernanda", "Gabriela",
  "Helena", "Isabela", "Juliana", "Larissa", "Letícia", "Luana", "Mariana", "Natália", "Patrícia", "Rafaela",
  "Renata", "Sabrina", "Tatiana", "Vanessa", "Vitória",
  "Alexandre", "André", "Bruno", "Carlos", "Daniel", "Diego", "Eduardo", "Felipe", "Fernando", "Gabriel",
  "Gustavo", "Henrique", "João", "Leonardo", "Lucas", "Marcelo", "Mateus", "Pedro", "Rafael", "Ricardo",
  "Rodrigo", "Thiago", "Vinícius", "Vitor", "Wesley",
];

const LAST_NAMES = [
  "Almeida", "Alves", "Araújo", "Barbosa", "Barros", "Batista", "Borges", "Campos", "Cardoso", "Carvalho",
  "Castro", "Coelho", "Costa", "Dias", "Duarte", "Fernandes", "Ferreira", "Freitas", "Gomes", "Lima",
  "Lopes", "Machado", "Marques", "Martins", "Melo", "Mendes", "Monteiro", "Moraes", "Moreira", "Nascimento",
  "Nunes", "Oliveira", "Pereira", "Pinto", "Ramos", "Ribeiro", "Rocha", "Santos", "Silva", "Soares",
  "Souza", "Teixeira", "Vieira",
];

/** Nome e sobrenome de brasileiro sorteados (para cobrar alguém que não está no WhatsApp do bot). */
export function randomPersonName(random: () => number = Math.random): string {
  const pick = (list: readonly string[]) => list[Math.min(list.length - 1, Math.floor(random() * list.length))]!;
  return `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
}
