import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BetaTextBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { servicoApresentavel, type ConfigNegocio } from "../config/negocio.js";
import { foraDoExpediente } from "../conversa/textos.js";
import { avaliarModulo, modulosVisiveis, type PerfilCanal } from "../dominio/elegibilidade.js";
import { DEFINICOES, MODULOS, SERVICOS_PROFISSIONAIS } from "../dominio/modulos.js";
import { formatarReais } from "../lib/texto.js";

/**
 * Monta o system prompt em três blocos, do mais estável ao mais volátil (o cache é por prefixo):
 *   1. instruções versionadas (prompts/assistente-v1.md)
 *   2. dados aprovados do negócio e restrições do canal — ponto de cache
 *   3. contexto do turno (hora, primeiro contato, nome informado) — fora do cache
 */

export const VERSAO_PROMPT = "assistente-v1";
const ARQUIVO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), `../../prompts/${VERSAO_PROMPT}.md`);
const DEMO = "[dado demonstrativo]";
const DIAS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

let instrucoesEmCache: string | null = null;
function instrucoes(): string {
  instrucoesEmCache ??= readFileSync(ARQUIVO, "utf8");
  return instrucoesEmCache;
}

export interface ContextoTurno {
  agora: Date;
  primeiroContato: boolean;
  nomeInformado: string | null;
  solicitacoesAbertas: string[];
}

export function montarSystem(perfil: PerfilCanal, negocio: ConfigNegocio, turno: ContextoTurno): BetaTextBlockParam[] {
  const canal = perfil.id === "whatsapp" ? "WhatsApp" : "chat";
  const fixo = instrucoes()
    .replaceAll("{{PROFISSIONAL}}", negocio.profissional.nome)
    .replaceAll("{{APRESENTACAO}}", negocio.profissional.apresentacao)
    .replaceAll("{{CANAL}}", canal);
  return [
    { type: "text", text: fixo },
    { type: "text", text: dadosAprovados(perfil, negocio), cache_control: { type: "ephemeral" } },
    { type: "text", text: contextoDoTurno(negocio, turno) },
  ];
}

export function dadosAprovados(perfil: PerfilCanal, negocio: ConfigNegocio): string {
  const marca = (t: string) => (negocio.demonstrativo ? `${DEMO} ${t}` : t);
  const visiveis = modulosVisiveis(perfil, negocio);
  const bloqueados = MODULOS.filter((m) => !avaliarModulo(perfil, negocio, m).permitido);
  const linhas: string[] = ["# Dados aprovados", ""];

  linhas.push(`Disponível neste canal: ${visiveis.map((m) => DEFINICOES[m].titulo).join("; ")}.`);
  if (bloqueados.length) {
    linhas.push(`Não atendido neste canal (não trate, nem por outra palavra): ${bloqueados.map((m) => DEFINICOES[m].titulo).join("; ")}.`);
  }

  for (const id of SERVICOS_PROFISSIONAIS) {
    if (!visiveis.includes(id)) continue;
    const s = negocio.servicos[id];
    const ok = servicoApresentavel(negocio, s);
    linhas.push("", `## ${s.titulo}`);
    linhas.push(`- Formato: ${ok && s.formato ? marca(s.formato) : "não informado — a Janiere explica diretamente"}`);
    linhas.push(
      `- Valor: ${
        ok && s.preco
          ? marca(`${formatarReais(s.preco.valorCentavos)}${s.preco.observacao ? ` (${s.preco.observacao})` : ""}`)
          : "não informado — a Janiere informa diretamente"
      }`,
    );
    linhas.push("- Agenda: não integrada; o horário é combinado pela Janiere depois da solicitação.");
  }

  const h = negocio.atendimentoHumano;
  linhas.push("", "## Atendimento humano");
  linhas.push(
    `- Expediente: ${
      h.expediente
        ? marca(`${h.expediente.diasSemana.map((d) => DIAS[d]).join(", ")}, das ${h.expediente.inicio} às ${h.expediente.fim}`)
        : "não informado (não informe expediente)"
    }`,
  );
  linhas.push(`- Prazo de retorno: ${h.prazoRetorno ? marca(h.prazoRetorno) : "não informado (não prometa prazo)"}`);

  linhas.push("", "## Para registrar uma solicitação");
  linhas.push(`- Preferência de contato: ${negocio.preferenciasContato.map((o) => `${o.valor} (${o.rotulo})`).join(", ")}`);
  linhas.push(`- Período (opcional): ${negocio.periodos.map((o) => `${o.valor} (${o.rotulo})`).join(", ")}`);

  const faq = negocio.conhecimento.filter((k) => negocio.demonstrativo || k.revisao);
  if (faq.length) {
    linhas.push("", "## Perguntas frequentes aprovadas");
    for (const k of faq) linhas.push(`- ${k.pergunta} → ${marca(k.resposta)}`);
  }
  return linhas.join("\n");
}

function contextoDoTurno(negocio: ConfigNegocio, t: ContextoTurno): string {
  const quando = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(t.agora);
  const linhas = [
    "# Contexto desta mensagem",
    `- Agora em São Paulo: ${quando}${
      negocio.atendimentoHumano.expediente ? (foraDoExpediente(negocio, t.agora) ? " (fora do expediente)" : " (dentro do expediente)") : ""
    }`,
    `- Primeiro contato desta pessoa: ${t.primeiroContato ? "sim" : "não"}`,
    // Dado fornecido pelo contato: é conteúdo, não instrução.
    `- Nome informado pela pessoa: ${t.nomeInformado ? JSON.stringify(t.nomeInformado) : "ainda não informado"}`,
    `- Solicitações abertas desta pessoa: ${t.solicitacoesAbertas.length ? t.solicitacoesAbertas.join("; ") : "nenhuma"}`,
  ];
  return linhas.join("\n");
}
