import { describe, expect, it } from "vitest";
import { estadoInicial } from "../../src/conversa/estado.js";
import { destinoDaEntrada, type Entrada } from "../../src/conversa/motor.js";
import { PERFIS } from "../../src/dominio/elegibilidade.js";
import { QUARTA_MEIO_DIA, novaConversa } from "../apoio/conversa.js";
import { negocioDemo } from "../apoio/negocio.js";

const negocio = negocioDemo();
const ctx = (jaRecebeuBoasVindas = true) => ({
  perfil: PERFIS.whatsapp,
  negocio,
  contato: { nome: null, jaRecebeuBoasVindas },
  agora: QUARTA_MEIO_DIA,
});
const t = (texto: string): Entrada => ({ tipo: "texto", texto });

describe("quem responde: motor ou IA", () => {
  it("comandos, saudações, agradecimentos, ações, mídia e assuntos bloqueados ficam com o código", () => {
    for (const e of [t("MENU"), t("HUMANO"), t("SAIR"), t("oi"), t("bom dia"), t("obrigada"), t("quero ser distribuidora"), t("tem shake?")]) {
      expect(destinoDaEntrada(estadoInicial(), e, ctx()), JSON.stringify(e)).toBe("motor");
    }
    expect(destinoDaEntrada(estadoInicial(), { tipo: "acao", id: "p1:1" }, ctx())).toBe("motor");
    expect(destinoDaEntrada(estadoInicial(), { tipo: "midia", descricao: "audio" }, ctx())).toBe("motor");
  });

  it("número da pergunta pendente é do motor; sem pergunta pendente, vai para a IA", () => {
    const c = novaConversa();
    c.enviar("oi");
    expect(destinoDaEntrada(c.estado, t("2"), ctx())).toBe("motor");
    expect(destinoDaEntrada(c.estado, t("nutricionista on-line"), ctx())).toBe("motor");
    expect(destinoDaEntrada(estadoInicial(), t("2"), ctx())).toBe("agente");
  });

  it("perguntas e texto livre vão para a IA, inclusive no primeiro contato", () => {
    expect(destinoDaEntrada(estadoInicial(), t("Quanto custa a consulta?"), ctx(false))).toBe("agente");
    expect(destinoDaEntrada(estadoInicial(), t("vocês atendem aos sábados?"), ctx())).toBe("agente");
  });

  it("na coleta de nome, um nome válido fica com o motor; uma pergunta vai para a IA", () => {
    const c = novaConversa();
    for (const m of ["oi", "1", "sim"]) c.enviar(m);
    expect(c.estado.etapa).toBe("coleta_nome");
    expect(destinoDaEntrada(c.estado, t("Maria Clara"), ctx())).toBe("motor");
    expect(destinoDaEntrada(c.estado, t("antes, quanto tempo dura a consulta?"), ctx())).toBe("agente");
  });
});
