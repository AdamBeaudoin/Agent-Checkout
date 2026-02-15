# Tempo Agent Invoice Guard

A hackathon MVP for **standardized merchant invoices** + **safe delegated agent payments** on Tempo.

## What this demonstrates

- Merchant issues a signed `InvoiceV1` payload with deterministic fields + memo.
- User delegates spending to an agent access key (Tempo account access key flow).
- Agent enforces delegation policy (`maxAmount`, `allowedRecipients`, `allowedTokens`, expiry) before paying.
- Merchant confirms settlement by matching on-chain `TransferWithMemo` event fields:
  - `token`
  - `to`
  - `amount`
  - `memo`
  - optional `payer`
- Merchant + guardian state survive process restarts (`./data/*.json` by default).
- Optional settlement confirmation auth via `x-merchant-confirm-token`.
- Per-IP rate limits on invoice creation, settlement confirmation, and delegation policy writes.

## Components

- `merchant/server.ts`
  - Listings + invoice issuance + strict settlement verification.
- `guardian/server.ts`
  - Delegation-policy service with persisted JSON state.
- `agent.ts`
  - Delegated payment client enforcing invoice signature + policy checks.
- `shared/invoice.ts`
  - `InvoiceV1` type, canonical message, signing, signature verification.

## Merchant Standard (MVP)

This project now exposes a merchant-facing standard surface:

- Discovery:
  - `GET /.well-known/tempo-agent-payments.json`
  - `GET /api/capabilities`
- Schema:
  - `GET /api/schemas/invoice-v1`
- Invoice lifecycle:
  - `POST /api/invoices` (supports `Idempotency-Key` header)
  - `GET /api/invoices/:invoiceId`
  - `POST /api/confirm` (alias: `POST /api/settlements/confirm`, optional `x-merchant-confirm-token`)

`POST /api/invoices` generic request:

```json
{
  "amount": "150000000",
  "description": "Airbnb rental for 3 nights in Mexico City",
  "recipient": "0x...",
  "token": "0x20c0000000000000000000000000000000000001",
  "payer": "0x...",
  "purpose": "lodging_booking",
  "merchantReference": "ORDER-1234",
  "lineItems": [
    {
      "title": "Mexico City stay",
      "category": "lodging",
      "quantity": 3,
      "unitAmount": "50000000",
      "totalAmount": "150000000"
    }
  ],
  "metadata": {
    "city": "Mexico City",
    "nights": 3
  }
}
```

`listingId` is still supported as an optional compatibility shortcut for catalog-style merchants.

## Tiny Merchant SDK

Reusable wrapper lives at `/sdk/merchant.ts` (`/sdk/index.ts` re-exports).

Example usage:

```ts
import { privateKeyToAccount } from 'viem/accounts'
import { TempoMerchantSdk } from './sdk/merchant.js'

const sdk = new TempoMerchantSdk({
  baseUrl: 'https://merchant.example.com',
  chainId: 42431,
  defaultRecipient: '0x...',
  defaultToken: '0x20c0000000000000000000000000000000000001',
  explorerUrl: 'https://explore.moderato.tempo.xyz',
  merchantAddress: '0x...',
  merchantName: 'Example Merchant',
  signer: privateKeyToAccount('0x...'),
})

const invoice = await sdk.createInvoice({
  amount: '150000000',
  description: '3-night Mexico City stay',
  purpose: 'lodging_booking',
  lineItems: [{ title: 'Stay', quantity: 3, unitAmount: '50000000', totalAmount: '150000000' }],
})

const capabilities = sdk.buildCapabilities()
```

## Idempotency

For merchant safety, `POST /api/invoices` supports `Idempotency-Key`. Reusing a key with
the same payload replays the same invoice; reusing it with a different payload returns `409`.

## Run

```bash
npm install
npm run setup
npm test
npm run merchant
```

In a second terminal:

```bash
npm run guardian
```

In a third terminal:

```bash
npm run agent
```

Open the demo UI at:
- `https://agent-checkout.vercel.app/`


The demo UI now includes a chat-first journey:
1. User asks for a stay in Berlin natural language.
2. Agent suggests flat listings and asks for confirmation.
3. Agent requests spend approval from a mock Privy wallet panel.
4. Checkout completes through demo settlement (`POST /api/demo/confirm`).

By default, agent execution is fail-closed if guardian policy is unavailable.
Only set `ALLOW_LOCAL_POLICY_FALLBACK=true` for local development/testing.

`setup.ts` now writes:
- `DELEGATION_ADMIN_TOKEN` for guardian policy writes
- `MERCHANT_CONFIRM_TOKEN` for settlement confirmation auth (agent sends this automatically)

`npm test` runs:
- Unit tests for invoice/signature/SDK/rate-limiter logic
- An HTTP integration test that boots merchant + guardian on random local ports and verifies core API flows + restart persistence

## Optional: set delegation policy explicitly

If you skip this and `ALLOW_LOCAL_POLICY_FALLBACK=false`, agent execution will fail closed.

```bash
EXPIRES_AT=$(($(date +%s) + 2592000)) # now + 30 days

curl -X POST http://localhost:3001/api/delegations \
  -H 'content-type: application/json' \
  -H "x-admin-token: $DELEGATION_ADMIN_TOKEN" \
  -d "{
    \"owner\": \"<AGENT_ADDRESS_FROM_ENV>\",
    \"maxAmount\": \"80000000\",
    \"allowedRecipients\": [\"<MERCHANT_ADDRESS_FROM_ENV>\"],
    \"allowedTokens\": [\"0x20c0000000000000000000000000000000000001\"],
    \"expiresAt\": $EXPIRES_AT
  }"
```

## `InvoiceV1` shape

```json
{
  "version": "tempo.invoice.v1",
  "invoiceId": "INV-...",
  "issuedAt": 1738944000,
  "dueAt": 1738944600,
  "chainId": 1767,
  "merchant": "0x...",
  "recipient": "0x...",
  "payer": "0x...",
  "token": "0x20c0000000000000000000000000000000000001",
  "amount": "50000000",
  "memo": "0x...",
  "description": "Cozy Loft in Kreuzberg (3 nights)",
  "purpose": "lodging_booking",
  "merchantReference": "ORDER-1234",
  "lineItems": [
    {
      "title": "Mexico City stay",
      "category": "lodging",
      "quantity": 3,
      "unitAmount": "50000000",
      "totalAmount": "150000000"
    }
  ],
  "metadata": {
    "listingId": "cozy-loft"
  },
  "merchantSig": "0x..."
}
```
