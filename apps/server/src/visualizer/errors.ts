// =============================================================================
// Visualizer errors — carry an HTTP status + machine code so the global
// Fastify error handler returns { statusCode, error: code, message }.
// =============================================================================

export class VisualizerError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "VisualizerError";
  }
}
