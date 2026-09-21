---
title: PRD — Adapter waconector no clinicCRM
parent: ./README.md
version: 1.0
date: 2026-09-21
owner: Flavio Santiago
status: em execução
---

# PRD — Adapter waconector no clinicCRM

## 1. Contexto e decisão

O clinicCRM usa **WAHA** como engine de WhatsApp. O usuário opera **EvoAPI** na VPS e quer
multi-provider (EvoAPI hoje, Z-API/Whapi amanhã) sem reescrever o core.

**Decisão:** adicionar um 4º adapter de canal — `waconector` — ao lado dos 3 existentes
(`waha`, `meta_cloud`, `zernio`). O WAHA fica intacto (zero regressão). O waconector entra
como biblioteca que abstrai múltiplas APIs não-oficiais por baixo de um contrato único.

### Por que não substituir o WAHA

- O upstream (DeskcommCRM) move ~1.000 commits em duas semanas. Mudar `lib/waha/*` cria
  merge eterno. Adicionar um adapter novo usa o ponto de extensão que o codebase já prevê.
- O WAHA funciona. Arriscar regressão no piloto por trocar o que está testado não paga.

### Por que `waconector` e não `evolution` como nome de provider

Todos os backends não-oficiais (EvoAPI, Z-API, Whapi, WAHA) compartilham as mesmas
capabilities — sem janela de 24h, sem template, com risco de banimento. Um provider
`waconector` cobre todos; o backend específico é config (env var), não migração de banco.
Trocar de EvoAPI para Z-API vira mudança de env, não novo provider.

## 2. Arquitetura

```
clinicCRM (multi-tenant)
    │
    ├─ lib/channels/adapters/waha.ts         (intacto)
    ├─ lib/channels/adapters/meta-cloud.ts    (intacto)
    ├─ lib/channels/adapters/zernio.ts        (intacto)
    └─ lib/channels/adapters/waconector.ts    ← NOVO
            │ implementa ChannelAdapter
            │ usa waconector como biblioteca
            ▼
        waconector (fork git dependency)
            │ createConnector(createEvolutionAdapter({...}))
            ▼
        EvoAPI (VPS) — ou Z-API, Whapi... (1 linha)
```

### Capabilities do `waconector`

Idênticas ao `waha` — ambos são APIs não-oficiais:

| Capability | Valor | Justificativa |
|---|---|---|
| `freeformOutsideWindow` | `true` | sem WABA, sem janela de 24h |
| `requiresTemplates` | `false` | sem aprovação de template |
| `canManageTemplates` | `false` | não há templates para gerir |
| `banRisk` | `true` | API não-oficial = risco de banimento |
| `minIntervalMs` | `null` | sem intervalo imposto pela plataforma |
| `voiceNote` | `"server-convert"` | EvoAPI converte áudio (como WAHA) |
| `groups` | `"full"` | EvoAPI suporta grupos |
| `costPerMessage` | `false` | sem custo por mensagem |

## 3. Os 8 passos

### Passo 1 — Fork do waconector + dependência

- Fork `alltomatos/waconector` → `FlavioSantTI/waconector` no GitHub
- Trocar remote do clone local (`C:\opensquad\waconector`) para o fork
- Adicionar no `package.json` do clinicCRM:
  ```
  "waconector": "git+https://github.com/FlavioSantTI/waconector.git#v1.3.0"
  ```
- `pnpm install`

**Por que fork e não direto no alltomatos:** trava a versão (update quebrando o piloto
é o pior cenário), e se o projeto morrer você tem o código (MIT).

**Por que não `file:`:** Docker build quebra — `file:../waconector` aponta fora do
contexto de build do clinicCRM.

### Passo 2 — Estender `ChannelProvider`

Arquivo: `lib/channels/types.ts`

```typescript
export type ChannelProvider = "waha" | "meta_cloud" | "zernio" | "waconector";
```

Uma linha. O type system propaga o erro para cada lugar que precisa atualizar.

### Passo 3 — Capabilities + constante

Arquivo: `lib/channels/capabilities.ts`

- Adicionar entrada `waconector` em `CHANNEL_CAPABILITIES` (mesma forma do `waha`)
- Adicionar `CHANNEL_PROVIDER_WACONECTOR: ChannelProvider = "waconector"`

### Passo 4 — Criar o adapter (o coração)

Arquivo: `lib/channels/adapters/waconector.ts` (~200 linhas)

Implementa `ChannelAdapter` usando waconector internamente:

| `ChannelAdapter` | waconector |
|---|---|
| `resolveRecipient(input)` | delega ao `normalizeChatId` (embutido no connector) |
| `isConfigured()` | checa env vars `WACONECTOR_*` |
| `send(envelope)` | `wa.messages.sendText` / `sendMedia` / `sendContactCard` |
| `signalTyping(...)` | `wa.presence.setTyping({ state: 'composing' })` |
| `checkHealth(...)` | `wa.instance.status()` |
| `fetchProfilePictureUrl(...)` | `wa.contacts.getProfilePicture(chatId)` |
| `fetchInboundMedia(...)` | `wa.messages.download({ messageId })` |
| `echoExternalIds(...)` | waconector normaliza IDs — provavelmente simétrico |
| `codes` | `waconector_not_configured`, `waconector_error`, `waconector_unknown` |

**Configuração via env vars:**
- `WACONECTOR_BASE_URL` — URL do EvoAPI (ex.: `http://evolution_api:8080`)
- `WACONECTOR_API_KEY` — token da instância
- `WACONECTOR_BACKEND` — `evolution` (default), `zapi`, `whapi`, `waha`...

**Inbound (webhook):** o adapter expõe `parseWebhook` que usa
`wa.webhooks.parse({ body })` → `CanonicalEvent[]`, convertido ao formato interno
do clinicCRM pelo roteador de webhook.

### Passo 5 — Registrar no mapa de adapters

Arquivo: `lib/channels/index.ts`

```typescript
import { waconectorAdapter } from "./adapters/waconector";

const ADAPTERS: Record<ChannelProvider, ChannelAdapter | null> = {
  waha: wahaAdapter,
  meta_cloud: metaCloudAdapter,
  zernio: zernioAdapter,
  waconector: waconectorAdapter,
};
```

### Passo 6 — Roteamento de webhook por provider

Arquivo: `app/api/v1/webhooks/channel/[token]/route.ts`

O webhook precisa saber qual adapter chamar para fazer parse do payload.
Hoje provavelmente assume WAHA. Precisa ler o `provider` da `channel_session`
e dispatchar para o adapter correto.

### Passo 7 — Migration

Arquivo: `supabase/migrations/0NNN_permitir_provider_waconector.sql`

A coluna `channel_sessions.provider` é `text not null default 'waha'`.
Se houver CHECK constraint listando os valores válidos, adicionar `'waconector'`.
Se for só `text`, nenhuma migration necessária (o type system já garante).

### Passo 8 — Testes

Arquivo: `tests/unit/channel-adapter-waconector.test.ts` (~150 linhas)

Seguir o padrão de `channel-adapter-waha.test.ts`:
- `resolveRecipient` devolve chatId correto
- `isConfigured` false sem env, true com env
- `send` delega para waconector mockado
- `signalTyping` é noop sem env
- `checkHealth` cobre os 3 desfechos (ok, 404, erro)
- `fetchInboundMedia` delega para `messages.download`

## 4. Riscos e mitigações

| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| waconector é jovem (8 stars, 2 meses) | alta | médio | fork trava a versão; se morrer, você tem o código |
| Merge com upstream ao atualizar `lib/channels/` | média | médio | adapter é arquivo novo — conflito só no `index.ts`/`types.ts` (2 linhas) |
| EvoAPI diverge do adapter `evolution` do waconector | baixa | alto | pinar versão do waconector; atualizar deliberadamente |
| `WACONECTOR_BACKEND` não cobre um provider futuro | baixa | baixo | waconector já tem 9 adapters; adicionar é 1 import |

## 5. Fora de escopo

- Migrar sessões existentes de WAHA para waconector (deixa WAHA funcionando)
- Substituir o adapter WAHA por waconector/waha (refactor futuro, não agora)
- Templates no waconector (APIs não-oficiais não têm template)
- Multi-instância: uma instância EvoAPI por clínica (config, não código)

## 6. Critério de aceite

- [ ] `pnpm typecheck` passa
- [ ] `pnpm lint` passa
- [ ] `pnpm lint:channels` passa (o lint que proíbe nome de provider fora de `lib/channels/`)
- [ ] `pnpm test:unit` não regrediu (mesma contagem de antes)
- [ ] Novos testes do adapter waconector passam
- [ ] Uma sessão `waconector` pode ser criada e envia uma mensagem via EvoAPI
