type RateLimitResult = {
  allowed: boolean
  retryAfterSeconds: number
}

type InMemoryRateLimiterOptions = {
  maxRequests: number
  windowMs: number
}

type WindowState = {
  count: number
  resetAt: number
}

export class InMemoryRateLimiter {
  private readonly maxRequests: number
  private readonly windowMs: number
  private readonly windows = new Map<string, WindowState>()

  constructor(options: InMemoryRateLimiterOptions) {
    this.maxRequests = options.maxRequests
    this.windowMs = options.windowMs
  }

  check(key: string, now = Date.now()): RateLimitResult {
    const existing = this.windows.get(key)

    if (!existing || now >= existing.resetAt) {
      this.windows.set(key, {
        count: 1,
        resetAt: now + this.windowMs,
      })
      return { allowed: true, retryAfterSeconds: 0 }
    }

    if (existing.count >= this.maxRequests) {
      const retryAfterMs = Math.max(existing.resetAt - now, 0)
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
      }
    }

    existing.count += 1
    return { allowed: true, retryAfterSeconds: 0 }
  }
}

export function getClientIp(req: { header: (name: string) => string | undefined }): string {
  const forwardedFor = req.header('x-forwarded-for')
  if (forwardedFor) {
    return forwardedFor.split(',')[0]?.trim() ?? 'unknown'
  }

  return req.header('cf-connecting-ip') ?? req.header('x-real-ip') ?? 'unknown'
}
