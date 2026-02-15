declare module '@vercel/node' {
  // Local type shim to allow `tsc --noEmit` without installing `@vercel/node`.
  // Vercel provides the real types/runtime in production.
  export type VercelRequest = any
  export type VercelResponse = any
}

