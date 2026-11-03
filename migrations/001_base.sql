-- Bot Tia Nane — esquema base (etapa 2)
-- Todos os horários em timestamptz (UTC). O fuso de negócio (America/Sao_Paulo) é aplicado no código.
-- Separação deliberada: etapa comercial (contatos.etapa_comercial), controle bot/humano
-- (conversas.controle) e preferência de marketing (consentimentos) ficam em colunas/tabelas distintas.

create table operadores (
  id            uuid primary key default gen_random_uuid(),
  chave         text not null unique,
  nome          text not null,
  papel         text not null check (papel in ('admin', 'atendente')),
  ativo         boolean not null default true,
  demonstrativo boolean not null default false,
  criado_em     timestamptz not null default now()
);

create table contatos (
  id              uuid primary key default gen_random_uuid(),
  canal           text not null,
  id_externo      text not null,
  nome_perfil     text,
  nome            text,
  etapa_comercial text not null default 'novo'
                  check (etapa_comercial in ('novo', 'interessado', 'solicitacao_registrada', 'cliente_verificado')),
  simulado        boolean not null default false,
  criado_em       timestamptz not null default now(),
  atualizado_em   timestamptz not null default now(),
  unique (canal, id_externo)
);

-- Uma conversa (thread) por contato. A linha é travada (FOR UPDATE) a cada mensagem,
-- o que serializa o processamento por conversa.
create table conversas (
  id                         uuid primary key default gen_random_uuid(),
  contato_id                 uuid not null unique references contatos (id) on delete cascade,
  canal                      text not null,
  estado                     jsonb not null,
  controle                   text not null default 'bot' check (controle in ('bot', 'humano')),
  boas_vindas_em             timestamptz,
  ultima_mensagem_contato_em timestamptz,
  versao                     integer not null default 0,
  criado_em                  timestamptz not null default now(),
  atualizado_em              timestamptz not null default now()
);

create table mensagens (
  id          uuid primary key default gen_random_uuid(),
  ordem       bigint generated always as identity,
  conversa_id uuid not null references conversas (id) on delete cascade,
  canal       text not null,
  direcao     text not null check (direcao in ('entrada', 'saida')),
  autor       text not null check (autor in ('contato', 'bot', 'operador')),
  operador_id uuid references operadores (id),
  id_provedor text,
  tipo        text not null check (tipo in ('texto', 'acao', 'opcoes')),
  corpo       text not null,
  dados       jsonb not null default '{}',
  modulo      text,
  simulada    boolean not null default false,
  criada_em   timestamptz not null default now()
);
-- Deduplicação de eventos recebidos pelo identificador do provedor.
create unique index mensagens_entrada_dedup on mensagens (canal, id_provedor) where direcao = 'entrada';
create index mensagens_conversa_idx on mensagens (conversa_id, ordem);

-- Outbox: toda saída passa por aqui; a política de envio é reavaliada no despacho.
create table envios (
  id                   uuid primary key default gen_random_uuid(),
  ordem                bigint generated always as identity,
  mensagem_id          uuid not null unique references mensagens (id) on delete cascade,
  conversa_id          uuid not null references conversas (id) on delete cascade,
  canal                text not null,
  status               text not null default 'pendente'
                       check (status in ('pendente', 'enviando', 'enviado', 'falhou', 'incerto', 'bloqueado')),
  tentativas           integer not null default 0,
  max_tentativas       integer not null default 3,
  proxima_tentativa_em timestamptz not null default now(),
  ultimo_erro          text,
  id_provedor          text,
  enviado_em           timestamptz,
  criado_em            timestamptz not null default now(),
  atualizado_em        timestamptz not null default now()
);
create index envios_pendentes_idx on envios (proxima_tentativa_em) where status = 'pendente';

-- Interesses, solicitações de agendamento e pedidos de cancelamento (não são conversões verificadas).
create table solicitacoes (
  id           uuid primary key default gen_random_uuid(),
  contato_id   uuid not null references contatos (id) on delete cascade,
  conversa_id  uuid not null references conversas (id) on delete cascade,
  modulo       text not null,
  tipo         text not null check (tipo in ('interesse', 'agendamento', 'cancelamento')),
  dados        jsonb not null default '{}',
  status       text not null default 'aberta' check (status in ('aberta', 'em_contato', 'concluida', 'cancelada')),
  criada_em    timestamptz not null default now(),
  atualizada_em timestamptz not null default now()
);
create unique index solicitacoes_interesse_unico on solicitacoes (contato_id, modulo) where tipo = 'interesse';

-- Atendimento humano (handoff).
create table atendimentos (
  id             uuid primary key default gen_random_uuid(),
  conversa_id    uuid not null references conversas (id) on delete cascade,
  status         text not null check (status in ('solicitado', 'em_atendimento', 'devolvido')),
  origem         text not null check (origem in ('contato', 'comando', 'fallback', 'operador')),
  motivo         text not null,
  resumo         text not null,
  responsavel_id uuid references operadores (id),
  solicitado_em  timestamptz not null default now(),
  assumido_em    timestamptz,
  devolvido_em   timestamptz,
  devolvido_por  uuid references operadores (id),
  resultado      text
);
create unique index atendimentos_um_aberto on atendimentos (conversa_id) where status in ('solicitado', 'em_atendimento');

-- Histórico de consentimento (somente inserções). O estado vigente é o registro mais recente por finalidade.
create table consentimentos (
  id            uuid primary key default gen_random_uuid(),
  contato_id    uuid not null references contatos (id) on delete cascade,
  finalidade    text not null check (finalidade in ('acompanhamento', 'marketing')),
  status        text not null check (status in ('concedido', 'revogado')),
  origem        text not null,
  evidencia     text,
  registrado_em timestamptz not null default now()
);
create index consentimentos_vigente_idx on consentimentos (contato_id, finalidade, registrado_em desc);

-- Tarefas agendadas persistentes (acompanhamentos — etapa 4). Já existem para que descadastro
-- e atendimento humano cancelem pendências desde o início.
create table tarefas (
  id                  uuid primary key default gen_random_uuid(),
  contato_id          uuid not null references contatos (id) on delete cascade,
  conversa_id         uuid references conversas (id) on delete cascade,
  tipo                text not null,
  finalidade          text not null,
  executar_em         timestamptz not null,
  status              text not null default 'pendente' check (status in ('pendente', 'executada', 'cancelada', 'falhou')),
  motivo_cancelamento text,
  dados               jsonb not null default '{}',
  criada_em           timestamptz not null default now(),
  atualizada_em       timestamptz not null default now()
);
create index tarefas_pendentes_idx on tarefas (executar_em) where status = 'pendente';

-- Avisos para a equipe dentro do sistema (a caixa de entrada da etapa 3 lê daqui).
create table notificacoes_equipe (
  id             uuid primary key default gen_random_uuid(),
  tipo           text not null,
  conversa_id    uuid references conversas (id) on delete cascade,
  atendimento_id uuid references atendimentos (id) on delete cascade,
  dados          jsonb not null default '{}',
  criada_em      timestamptz not null default now(),
  lida_em        timestamptz
);

create table auditoria (
  id          bigint generated always as identity primary key,
  ator_tipo   text not null check (ator_tipo in ('contato', 'bot', 'operador', 'sistema')),
  ator_id     text,
  acao        text not null,
  entidade    text,
  entidade_id text,
  detalhes    jsonb not null default '{}',
  criado_em   timestamptz not null default now()
);
create index auditoria_entidade_idx on auditoria (entidade, entidade_id);
