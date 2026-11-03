-- Agente de IA e WhatsApp Cloud API (etapa 3)

-- O agente pode abrir atendimento humano por ferramenta.
alter table atendimentos drop constraint atendimentos_origem_check;
alter table atendimentos add constraint atendimentos_origem_check
  check (origem in ('contato', 'comando', 'fallback', 'operador', 'agente'));

-- Mensagens de mídia (áudio, imagem…) são registradas, mas ainda não interpretadas.
alter table mensagens drop constraint mensagens_tipo_check;
alter table mensagens add constraint mensagens_tipo_check check (tipo in ('texto', 'acao', 'opcoes', 'midia'));

-- Webhook: o evento bruto é gravado antes do 200 e processado fora da requisição.
create table eventos_recebidos (
  id                   uuid primary key default gen_random_uuid(),
  provedor             text not null,
  corpo                jsonb not null,
  status               text not null default 'pendente'
                       check (status in ('pendente', 'processando', 'processado', 'erro')),
  tentativas           integer not null default 0,
  ultimo_erro          text,
  recebido_em          timestamptz not null default now(),
  proxima_tentativa_em timestamptz not null default now(),
  atualizado_em        timestamptz not null default now(),
  processado_em        timestamptz
);
create index eventos_pendentes_idx on eventos_recebidos (proxima_tentativa_em) where status = 'pendente';

-- Status de entrega informado pelo provedor (sent, delivered, read, failed). Não aciona o bot.
alter table envios add column status_provedor text, add column status_provedor_em timestamptz;
create index envios_id_provedor_idx on envios (id_provedor) where id_provedor is not null;
