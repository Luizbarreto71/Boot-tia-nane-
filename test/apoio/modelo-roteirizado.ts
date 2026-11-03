import type { BetaMessage, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { ConfigAgente } from "../../src/agente/agente.js";
import type { ClienteModelo } from "../../src/agente/modelo.js";

export type Passo =
  | { texto?: string; ferramentas?: { nome: string; entrada: unknown }[]; parada?: BetaMessage["stop_reason"] }
  | Error;

/** Modelo falso: devolve as respostas do roteiro, em ordem, e guarda o que recebeu em cada chamada. */
export class ModeloRoteirizado implements ClienteModelo {
  readonly chamadas: MessageCreateParamsNonStreaming[] = [];

  constructor(private readonly roteiro: Passo[]) {}

  async criar(params: MessageCreateParamsNonStreaming): Promise<BetaMessage> {
    this.chamadas.push(structuredClone(params));
    const passo = this.roteiro.shift();
    if (!passo) throw new Error("roteiro do modelo esgotado");
    if (passo instanceof Error) throw passo;
    const content: unknown[] = [];
    if (passo.texto) content.push({ type: "text", text: passo.texto, citations: null });
    for (const [i, f] of (passo.ferramentas ?? []).entries()) {
      content.push({ type: "tool_use", id: `toolu_${this.chamadas.length}_${i}`, name: f.nome, input: f.entrada });
    }
    return {
      id: `msg_teste_${this.chamadas.length}`,
      type: "message",
      role: "assistant",
      model: params.model,
      content,
      stop_reason: passo.parada ?? (passo.ferramentas?.length ? "tool_use" : "end_turn"),
      stop_sequence: null,
      usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    } as unknown as BetaMessage;
  }
}

export const configAgente = (modelo: ClienteModelo): ConfigAgente => ({ cliente: modelo, modelo: "claude-opus-5-5", esforco: "low" });
