// Intentionally avoid importing `@vercel/node` at runtime. Some deployments end up
// trying to resolve it as a module, which can cause 500s.
export default function handler(_req: any, res: any) {
  res.status(200).json({
    ok: true,
    ts: Date.now(),
    commit:
      process.env.VERCEL_GIT_COMMIT_SHA ??
      process.env.VERCEL_GIT_COMMIT_REF ??
      process.env.VERCEL_GIT_PROVIDER ??
      null,
    node: process.version,
  })
}
