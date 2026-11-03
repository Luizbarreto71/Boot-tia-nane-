/** Minúsculas, sem acentos, sem pontuação, espaços simples. "INÍCIO!" → "inicio". */
export function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s:]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatarReais(centavos: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(centavos / 100);
}

export function capitalizarNome(nome: string): string {
  if (nome !== nome.toLowerCase()) return nome;
  return nome.replace(/(^|[\s'-])(\p{L})/gu, (_, sep: string, letra: string) => sep + letra.toUpperCase());
}

export function juntarLista(itens: string[]): string {
  if (itens.length <= 1) return itens.join("");
  return `${itens.slice(0, -1).join(", ")} ou ${itens.at(-1)}`;
}
