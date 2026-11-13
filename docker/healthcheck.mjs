/**
 * Role-aware container healthcheck. api/all expose GET /health; worker and smtp
 * roles have no HTTP listener, so process liveness is the container runtime's job.
 */
const role = process.env.POSTBOTE_ROLE ?? 'all'
if (role === 'worker' || role === 'smtp') process.exit(0)

const port = process.env.POSTBOTE_PORT ?? '3000'
try {
  const response = await fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(2000),
  })
  process.exit(response.ok ? 0 : 1)
} catch {
  process.exit(1)
}
