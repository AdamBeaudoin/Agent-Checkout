import { isAddress, parseEventLogs } from 'viem'
import type { Log } from 'viem'
import type { LocalAccount } from 'viem/accounts'
import { Abis } from 'viem/tempo'
import {
  INVOICE_VERSION,
  INVOICE_V1_JSON_SCHEMA,
  assertInvoiceV1,
  createInvoiceMemo,
  signInvoice,
  type InvoiceLineItemV1,
  type InvoiceMetadata,
  type InvoiceV1,
  type InvoiceV1Unsigned,
} from '../shared/invoice.js'

export const MERCHANT_STANDARD_VERSION = 'tempo.agent-payments.v1' as const

export type MerchantSdkConfig = {
  baseUrl: string
  chainId: number
  defaultRecipient: `0x${string}`
  defaultToken: `0x${string}`
  explorerUrl: string
  merchantAddress: `0x${string}`
  merchantName: string
  signer: LocalAccount
}

export type MerchantInvoiceInput = {
  amount: string
  description: string
  dueAt?: number
  dueInSeconds?: number
  invoiceId?: string
  issuedAt?: number
  merchantReference?: string
  metadata?: InvoiceMetadata
  payer?: `0x${string}`
  purpose?: string
  recipient?: `0x${string}`
  token?: `0x${string}`
  lineItems?: InvoiceLineItemV1[]
}

function createInvoiceId() {
  const rand = Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, '0')
  return `INV-${Date.now()}-${rand}`
}

function assertAmountString(value: string, fieldName: string) {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`Invalid ${fieldName}; must be a numeric string`)
  }
}

function assertAddress(value: string, fieldName: string) {
  if (!isAddress(value)) {
    throw new Error(`Invalid ${fieldName} address`)
  }
}

export class TempoMerchantSdk {
  private readonly config: MerchantSdkConfig

  constructor(config: MerchantSdkConfig) {
    this.config = config
    assertAddress(config.merchantAddress, 'merchantAddress')
    assertAddress(config.defaultRecipient, 'defaultRecipient')
    assertAddress(config.defaultToken, 'defaultToken')
  }

  async createInvoice(input: MerchantInvoiceInput): Promise<InvoiceV1> {
    assertAmountString(input.amount, 'amount')

    if (!input.description?.trim()) {
      throw new Error('description is required')
    }

    const recipient = input.recipient ?? this.config.defaultRecipient
    const token = input.token ?? this.config.defaultToken
    assertAddress(recipient, 'recipient')
    assertAddress(token, 'token')

    if (input.payer) assertAddress(input.payer, 'payer')

    const now = Math.floor(Date.now() / 1000)
    const issuedAt = input.issuedAt ?? now
    const dueAt = input.dueAt ?? issuedAt + (input.dueInSeconds ?? 10 * 60)

    if (!Number.isInteger(issuedAt) || issuedAt <= 0) {
      throw new Error('issuedAt must be a positive integer')
    }

    if (!Number.isInteger(dueAt) || dueAt <= issuedAt) {
      throw new Error('dueAt must be a future unix timestamp after issuedAt')
    }

    const invoiceId = input.invoiceId ?? createInvoiceId()

    const unsignedInvoice: InvoiceV1Unsigned = {
      version: INVOICE_VERSION,
      invoiceId,
      issuedAt,
      dueAt,
      chainId: this.config.chainId,
      merchant: this.config.merchantAddress,
      recipient,
      ...(input.payer ? { payer: input.payer } : {}),
      token,
      amount: input.amount,
      memo: createInvoiceMemo(invoiceId),
      description: input.description,
      ...(input.merchantReference ? { merchantReference: input.merchantReference } : {}),
      ...(input.purpose ? { purpose: input.purpose } : {}),
      ...(input.lineItems ? { lineItems: input.lineItems } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    }

    const signed = await signInvoice(this.config.signer, unsignedInvoice)
    assertInvoiceV1(signed)
    return signed
  }

  buildCapabilities(paths?: {
    confirmSettlementPath?: string
    createInvoicePath?: string
    getInvoicePath?: string
    listOfferingsPath?: string
    schemaPath?: string
  }) {
    const schemaPath = paths?.schemaPath ?? '/api/schemas/invoice-v1'
    const createInvoicePath = paths?.createInvoicePath ?? '/api/invoices'
    const getInvoicePath = paths?.getInvoicePath ?? '/api/invoices/{invoiceId}'
    const confirmSettlementPath = paths?.confirmSettlementPath ?? '/api/confirm'
    const listOfferingsPath = paths?.listOfferingsPath ?? '/api/listings'

    return {
      standard: MERCHANT_STANDARD_VERSION,
      merchant: {
        address: this.config.merchantAddress,
        name: this.config.merchantName,
      },
      invoice: {
        version: INVOICE_VERSION,
        mode: 'generic',
        schema: `${this.config.baseUrl}${schemaPath}`,
        signature: 'eip191.personal_sign',
        requiredFields: INVOICE_V1_JSON_SCHEMA.required,
        createRequest: {
          required: ['amount', 'description'],
          optional: [
            'recipient',
            'token',
            'payer',
            'dueAt',
            'dueInSeconds',
            'merchantReference',
            'purpose',
            'lineItems',
            'metadata',
            'listingId',
          ],
        },
      },
      network: {
        chainId: this.config.chainId,
        settlementToken: this.config.defaultToken,
      },
      settlement: {
        event: 'TransferWithMemo',
        requiredMatches: ['token', 'to', 'amount', 'memo', 'payer?'],
        explorer: this.config.explorerUrl,
      },
      endpoints: {
        createInvoice: `${this.config.baseUrl}${createInvoicePath}`,
        getInvoice: `${this.config.baseUrl}${getInvoicePath}`,
        confirmSettlement: `${this.config.baseUrl}${confirmSettlementPath}`,
        listOfferings: `${this.config.baseUrl}${listOfferingsPath}`,
      },
      idempotency: {
        createInvoiceHeader: 'Idempotency-Key',
      },
    }
  }

  matchSettlement(invoice: InvoiceV1, logs: readonly Log[]) {
    const transferLogs = parseEventLogs({
      abi: Abis.tip20,
      logs: [...logs],
      eventName: 'TransferWithMemo',
    })

    const expectedAmount = BigInt(invoice.amount)

    return transferLogs.find((eventLog) => {
      return (
        eventLog.address.toLowerCase() === invoice.token.toLowerCase() &&
        eventLog.args.to.toLowerCase() === invoice.recipient.toLowerCase() &&
        eventLog.args.amount === expectedAmount &&
        eventLog.args.memo.toLowerCase() === invoice.memo.toLowerCase() &&
        (!invoice.payer || eventLog.args.from.toLowerCase() === invoice.payer.toLowerCase())
      )
    })
  }
}
