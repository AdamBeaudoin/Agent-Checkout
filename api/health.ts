import type { VercelRequest, VercelResponse } from '@vercel/node'

function setCors(res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Idempotency-Key, x-merchant-confirm-token, x-demo-mode',
  )
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
}

export default function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res)
  if (req.method === 'OPTIONS') return res.status(204).send('')
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' })

  // Used by the demo UI as both "merchant" and "guardian" status checks in production.
  return res.status(200).json({ ok: true, policyCount: 1, mode: 'vercel-functions' })
}

