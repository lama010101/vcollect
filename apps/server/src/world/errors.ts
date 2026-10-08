// =============================================================================
// World Cam errors — carry an HTTP status + machine code so the global
// Fastify error handler returns { statusCode, error: code, message }.
// =============================================================================

export class WorldError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WorldError";
  }
}
