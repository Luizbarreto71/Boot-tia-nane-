import type {
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Cliente } from "../db/pool.js";
import { aceitaFallbackDoServidor, type ClienteModelo } from "./modelo.js";
import { definirFerramentas, executarFerramenta, type AlvoFerramenta } from "./ferramentas.js";
import { montarSystem, VERSAO_PROMPT, type ContextoTurno } from "./prompt.js";

/**
 * Um turno do agente: loop manual de ferramentas (as ferramentas rodam dentro da transação da
 * conversa, que o núcleo protege com savepoint). Qualquer desvio — erro de API, recusa, limite de
 * chamadas, tempo — vira ErroAgente, e o núcleo responde com o motor de menus.
 */

export interface ConfigAgente {
  cliente: ClienteModelo;
  modelo: string;
  esforco: "low" | "medium" | "high";
}

export class ErroAgente extends Error {
  override name = "ErroAgente";
  constructor(
    readonly motivo: string,
    detalhe?: string,
  ) {
    super(detalhe ? `${motivo}: ${detalhe}` : motivo);
  }
}

export interface ResultadoAgente {
  texto: string;
  chamadas: number;
  ferramentas: string[];
  uso: { entrada: number; saida: number; cacheLido: number };
  latenciaMs: number;
  versaoPrompt: string;
}

const MAX_CHAMADAS = 4;
const MAX_FERRAMENTAS = 4;
const PRAZO_TURNO_MS = 45_000;
const LIMITE_HISTORICO = 24;

export async function executarTurnoAgente(
  cfg: ConfigAgente,
  alvo: AlvoFerramenta,
  entrada: { historico: BetaMessageParam[]; turno: ContextoTurno },
): Promise<ResultadoAgente> {
  const inicio = Date.now();
  const system = montarSystem(alvo.perfil, alvo.negocio, entrada.turno);
  const tools = definirFerramentas(alvo.perfil, alvo.negocio);
  const messages: BetaMessageParam[] = [...entrada.historico];
  if (messages.at(-1)?.role !== "user") throw new ErroAgente("historico_invalido");

  const ferramentas: string[] = [];
  const uso = { entrada: 0, saida: 0, cacheLido: 0 };

  for (let chamada = 1; chamada <= MAX_CHAMADAS; chamada++) {
    if (Date.now() - inicio > PRAZO_TURNO_MS) throw new ErroAgente("prazo_esgotado");
    const params: MessageCreateParamsNonStreaming = {
      model: cfg.modelo,
      max_tokens: 16000,
      system,
      tools,
      messages,
      output_config: { effort: cfg.esforco },
      ...(aceitaFallbackDoServidor(cfg.modelo)
        ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
        : {}),
    };

    let resposta;
    try {
      resposta = await cfg.cliente.criar(params);
    } catch (e) {
      throw new ErroAgente("api", e instanceof Error ? `${e.name} ${e.message}`.slice(0, 300) : "erro desconhecido");
    }
    uso.entrada += resposta.usage.input_tokens;
    uso.saida += resposta.usage.output_tokens;
    uso.cacheLido += resposta.usage.cache_read_input_tokens ?? 0;

    if (resposta.stop_reason === "end_turn") {
      const texto = resposta.content
        .flatMap((b) => (b.type === "text" ? [b.text] : []))
        .join("\n")
        .trim();
      if (!texto) throw new ErroAgente("resposta_vazia");
      return { texto, chamadas: chamada, ferramentas, uso, latenciaMs: Date.now() - inicio, versaoPrompt: VERSAO_PROMPT };
    }
    if (resposta.stop_reason !== "tool_use") throw new ErroAgente(`parada_${resposta.stop_reason ?? "desconhecida"}`);

    const usos = resposta.content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
    if (!usos.length) throw new ErroAgente("tool_use_sem_bloco");
    if (ferramentas.length + usos.length > MAX_FERRAMENTAS) throw new ErroAgente("limite_ferramentas");

    // A resposta volta inteira (inclusive blocos de raciocínio), sem edição.
    messages.push({ role: "assistant", content: resposta.content });
    const resultados: BetaToolResultBlockParam[] = [];
    for (const u of usos) {
      ferramentas.push(u.name);
      const r = await executarFerramenta(u.name, u.input, alvo);
      resultados.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(r.conteudo), is_error: r.erro });
    }
    // Todos os resultados de uma rodada vão numa única mensagem.
    messages.push({ role: "user", content: resultados });
  }
  throw new ErroAgente("limite_chamadas");
}

/**
 * Histórico desta conversa (e só desta) para o modelo. Saídas bloqueadas ou que falharam não
 * entram: a pessoa nunca as recebeu.
 */
export async function carregarHistorico(c: Cliente, conversaId: string): Promise<BetaMessageParam[]> {
  const { rows } = await c.query<{ direcao: "entrada" | "saida"; autor: string; corpo: string }>(
    `select m.direcao, m.autor, m.corpo
     from mensagens m left join envios e on e.mensagem_id = m.id
     where m.conversa_id = $1 and (m.direcao = 'entrada' or e.status in ('pendente', 'enviando', 'enviado', 'incerto'))
     order by m.ordem desc
     limit $2`,
    [conversaId, LIMITE_HISTORICO],
  );
  const mensagens: { role: "user" | "assistant"; content: string }[] = [];
  for (const r of rows.reverse()) {
    const role = r.direcao === "entrada" ? "user" : "assistant";
    const texto = r.autor === "operador" ? `[Mensagem escrita por uma pessoa da equipe da Janiere]\n${r.corpo}` : r.corpo;
    const ultima = mensagens.at(-1);
    if (ultima && ultima.role === role) ultima.content = `${ultima.content}\n\n${texto}`;
    else mensagens.push({ role, content: texto });
  }
  while (mensagens[0]?.role === "assistant") mensagens.shift();
  return mensagens;
}
