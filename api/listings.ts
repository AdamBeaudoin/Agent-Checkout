import type { VercelRequest, VercelResponse } from '@vercel/node'

function setCors(res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Idempotency-Key, x-merchant-confirm-token, x-demo-mode',
  )
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
}

const LISTINGS = [
  {
    id: 'cozy-loft',
    title: 'Cozy Loft in Kreuzberg',
    priceUSDC: '285000000',
    currency: 'EUR',
    weekendPriceEUR: 285,
    neighborhood: 'Kreuzberg',
    imageUrl:
      'https://images.unsplash.com/photo-1505692952047-1a78307da8f2?auto=format&fit=crop&w=1400&q=80',
    rating: 4.92,
    reviews: 373,
    guestFavorite: true,
    nights: 3,
    description: 'Sunny loft near Gorlitzer Park with fast check-in',
  },
  {
    id: 'modern-apt',
    title: 'Modern Apartment in Mitte',
    priceUSDC: '420000000',
    currency: 'EUR',
    weekendPriceEUR: 420,
    neighborhood: 'Mitte',
    imageUrl:
      'https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?auto=format&fit=crop&w=1400&q=80',
    rating: 4.88,
    reviews: 346,
    guestFavorite: true,
    nights: 2,
    description: 'Central location, rooftop terrace, walk to Museum Island',
  },
  {
    id: 'garden-studio',
    title: 'Garden Studio in Neukolln',
    priceUSDC: '250000000',
    currency: 'EUR',
    weekendPriceEUR: 250,
    neighborhood: 'Neukolln',
    imageUrl:
      'https://images.unsplash.com/photo-1484154218962-a197022b5858?auto=format&fit=crop&w=1400&q=80',
    rating: 4.97,
    reviews: 255,
    guestFavorite: true,
    nights: 1,
    description: 'Quiet studio with private garden and late self check-in',
  },
] as const

export default function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res)
  if (req.method === 'OPTIONS') return res.status(204).send('')
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' })
  return res.status(200).json(LISTINGS)
}

