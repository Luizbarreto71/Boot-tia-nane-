/**
 * Comandos globais, avaliados sobre o texto normalizado (ver lib/texto.normalizar).
 * Descadastro só é reconhecido por comando exato ou frase clara sobre receber mensagens —
 * "não consigo parar de comer doce" ou "cancelar o agendamento" não são descadastro.
 */
export type Comando =
  | { tipo: "descadastro" }
  | { tipo: "humano" }
  | { tipo: "menu" }
  | { tipo: "voltar" }
  | { tipo: "cancelar_solicitacao" }
  | { tipo: "cancelar_fluxo" };

const DESCADASTRO_EXATO = new Set([
  "sair",
  "parar",
  "pare",
  "stop",
  "descadastrar",
  "descadastro",
  "cancelar inscricao",
  "cancelar mensagens",
]);
const DESCADASTRO_FRASES = [
  /\b(parar|pare|parem) de (me )?(receber|mandar|enviar)\b/,
  /\bnao (quero|desejo) (mais )?receber\b/,
  /\b(me )?(descadastr\w*|remov\w* (meu numero|da lista)|tir\w* (meu numero|da lista)|sair da lista)\b/,
  /\bnao (me )?(mand\w*|envi\w*) mais\b/,
];

const MENU = new Set(["menu", "inicio", "menu principal", "voltar ao menu", "voltar ao inicio", "comecar de novo"]);
const VOLTAR = new Set(["voltar", "volta", "anterior", "voltar etapa"]);
const HUMANO_EXATO = new Set(["humano", "janiere", "atendente", "atendimento humano", "falar com humano"]);
const HUMANO_FRASE = /\bfalar (diretamente )?com (a |uma |um )?(janiere|humano|atendente|pessoa|alguem)\b/;

const CANCELAR_SOLICITACAO =
  /\b(cancel\w*|desmarc\w*)\b.*\b(agendamento|consulta|horario|atendimento|solicitacao|pedido|sessao|aula|treino)\b/;
const CANCELAR_SOLO = new Set(["cancelar", "cancela", "cancelo", "desistir", "desisto"]);

export function detectarComando(n: string): Comando | null {
  if (!n) return null;
  if (DESCADASTRO_EXATO.has(n) || DESCADASTRO_FRASES.some((r) => r.test(n))) return { tipo: "descadastro" };
  if (CANCELAR_SOLICITACAO.test(n) || /^desmarc\w*$/.test(n)) return { tipo: "cancelar_solicitacao" };
  if (HUMANO_EXATO.has(n) || HUMANO_FRASE.test(n)) return { tipo: "humano" };
  if (MENU.has(n)) return { tipo: "menu" };
  if (VOLTAR.has(n)) return { tipo: "voltar" };
  if (CANCELAR_SOLO.has(n)) return { tipo: "cancelar_fluxo" };
  return null;
}
