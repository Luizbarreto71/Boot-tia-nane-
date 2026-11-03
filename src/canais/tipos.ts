import type { CanalId } from "../dominio/elegibilidade.js";
import type { OpcaoResposta } from "../conversa/motor.js";

/** Mensagem pronta para sair. O adaptador decide o formato (lista interativa, botões ou texto numerado). */
export interface EnvioSaida {
  envioId: string;
  canal: CanalId;
  destinatario: string;
  texto: string;
  opcoes: OpcaoResposta[];
  simulada: boolean;
  /** Quem redigiu: motor de menus, IA ou uma pessoa da equipe (informativo; o canal não usa). */
  origem: "motor" | "ia" | "operador";
}

export interface AdaptadorCanal {
  readonly canal: CanalId;
  enviar(envio: EnvioSaida): Promise<{ idProvedor: string }>;
}

/** Resultado desconhecido (ex.: timeout depois de enviar a requisição): não repetir automaticamente. */
export class ErroEnvioIncerto extends Error {
  override name = "ErroEnvioIncerto";
}

/** Recusa definitiva do provedor (ex.: 4xx de validação): não adianta repetir. */
export class ErroEnvioDefinitivo extends Error {
  override name = "ErroEnvioDefinitivo";
}

/** Texto numerado: formato alternativo às listas interativas e o que fica gravado para a caixa de entrada. */
export function textoComOpcoes(texto: string, opcoes: OpcaoResposta[]): string {
  if (!opcoes.length) return texto;
  return `${texto}\n\n${opcoes.map((o) => `${o.numero}. ${o.rotulo}`).join("\n")}`;
}
