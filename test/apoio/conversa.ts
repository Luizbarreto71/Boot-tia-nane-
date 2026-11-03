import type { ConfigNegocio } from "../../src/config/negocio.js";
import { estadoInicial, type EstadoConversa } from "../../src/conversa/estado.js";
import { processar, type Entrada, type Resultado } from "../../src/conversa/motor.js";
import { PERFIS, type PerfilCanal } from "../../src/dominio/elegibilidade.js";
import { negocioDemo } from "./negocio.js";

/** Quarta-feira, 12h em São Paulo: dentro do expediente demonstrativo. */
export const QUARTA_MEIO_DIA = new Date("2026-10-28T15:00:00Z");

/** Conversa em memória sobre o motor puro, aplicando os efeitos que alimentam o contexto. */
export function novaConversa(opcoes: { perfil?: PerfilCanal; negocio?: ConfigNegocio; agora?: Date } = {}) {
  let estado: EstadoConversa = estadoInicial();
  let jaRecebeuBoasVindas = false;
  let nome: string | null = null;
  const negocio = opcoes.negocio ?? negocioDemo();
  const historico: Resultado[] = [];

  function enviar(entrada: string | Entrada): Resultado {
    const e: Entrada = typeof entrada === "string" ? { tipo: "texto", texto: entrada } : entrada;
    const r = processar(estado, e, {
      perfil: opcoes.perfil ?? PERFIS.whatsapp,
      negocio,
      contato: { nome, jaRecebeuBoasVindas },
      agora: opcoes.agora ?? QUARTA_MEIO_DIA,
    });
    estado = r.estado;
    for (const ef of r.efeitos) {
      if (ef.tipo === "boas_vindas") jaRecebeuBoasVindas = true;
      if (ef.tipo === "registrar_nome") nome = ef.nome;
    }
    historico.push(r);
    return r;
  }

  return {
    enviar,
    acao: (id: string) => enviar({ tipo: "acao", id }),
    get estado() {
      return estado;
    },
    historico,
  };
}

export const texto = (r: Resultado) =>
  r.respostas.map((x) => [x.texto, ...x.opcoes.map((o) => `${o.numero}. ${o.rotulo}`)].join("\n")).join("\n---\n");

export const rotulos = (r: Resultado) => r.respostas.flatMap((x) => x.opcoes.map((o) => o.rotulo));
