-- 0231 — vocabulário do quarto canal (waconector) em channel_sessions.
--
-- O waconector é um adapter multi-provider de APIs não-oficiais (EvoAPI, Z-API,
-- Whapi, ...). O backend específico é config via env var, não um provider
-- distinto — todos compartilham as mesmas capabilities (sem janela de 24h, sem
-- template, com risco de banimento). O `waconector_instance_name` é o nome da
-- instância no provider (ex.: nome da instância no EvoAPI); no piloto de
-- instância única via env, é informativo — o adapter resolve a instância pelo
-- `apiKey`, não pelo nome.
--
-- Segue o padrão da migration 0131 (zernio): coluna nasce nullable, os dois
-- CHECKs são RECRIADOS (drop + add) em vez de criados com `exception when
-- duplicate_object`, porque um clone que já tem a versão de três providers
-- ficaria com a constraint antiga e recusaria a sessão nova em silêncio.
--
-- Nenhum dado a deduplicar antes das constraints: toda linha pré-existente tem
-- provider 'waha', 'meta_cloud' ou 'zernio' e já satisfaz o ramo correspondente.

alter table public.channel_sessions
  add column if not exists waconector_instance_name text;

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_check
  check (provider = any (array['waha'::text, 'meta_cloud'::text, 'zernio'::text, 'waconector'::text]));

alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_ref_check;

alter table public.channel_sessions
  add constraint channel_sessions_provider_ref_check check (
    (provider = 'waha'        and waha_session_name        is not null) or
    (provider = 'meta_cloud'  and meta_phone_number_id    is not null) or
    (provider = 'zernio'      and zernio_account_id       is not null) or
    (provider = 'waconector'  and waconector_instance_name is not null)
  );

comment on column public.channel_sessions.waconector_instance_name is
  'Nome da instância no provider não-oficial (ex.: nome da instância no EvoAPI). No piloto de instância única via env, é informativo — o adapter do waconector resolve a instância pelo apiKey. Espelhado em lib/channels/session-ref.ts.';
