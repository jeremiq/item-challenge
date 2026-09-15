/**
 * Raised when a write loses a race with a concurrent write to the same item.
 *
 * Version snapshots are written with `attribute_not_exists`, so two updates
 * that both read version N and both try to write version N+1 can't both
 * succeed — the loser fails its condition and surfaces here. That makes the
 * storage layer safe by construction, but the distinction only reaches the
 * client if callers map this to 409 rather than letting it fall into a
 * generic 500.
 */
export class ConflictError extends Error {
  constructor(message = 'Item was modified concurrently') {
    super(message);
    this.name = 'ConflictError';
  }
}
