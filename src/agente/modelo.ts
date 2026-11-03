import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages";

/** O agente fala com o modelo só por esta interface; nos testes entra um modelo roteirizado. */
export interface ClienteModelo {
  criar(params: MessageCreateParamsNonStreaming): Promise<BetaMessage>;
}

/** Cliente oficial. Tempo curto por chamada: é uma conversa de WhatsApp, e a falha cai na resposta alternativa. */
export function criarClienteAnthropic(apiKey: string): ClienteModelo {
  const client = new Anthropic({ apiKey, timeout: 25_000, maxRetries: 1 });
  return { criar: (params) => client.beta.messages.create(params) };
}

/** Modelos com retentativa do servidor em outro modelo quando há recusa por segurança. */
export const aceitaFallbackDoServidor = (modelo: string) =>
  ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1"].includes(modelo);
