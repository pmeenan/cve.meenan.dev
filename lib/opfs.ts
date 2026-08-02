/**
 * OPFS helpers that are easier to get wrong than they look, extracted from the
 * Worker so they can be tested without a browser.
 */

/**
 * Write every byte of `bytes` at `at`, or throw.
 *
 * `FileSystemSyncAccessHandle.write()` returns how many bytes it actually
 * wrote, and the File System Standard requires callers to handle a short write
 * rather than assume the count matches the buffer
 * (https://fs.spec.whatwg.org/#api-filesystemsyncaccesshandle-write, read
 * 2026-08-01). Discarding it corrupts the database silently: a partially
 * written 32 MiB chunk still leaves a plausible-looking file, and the damage
 * surfaces much later as a malformed page in the middle of some query.
 *
 * A write that reports no progress is treated as a failure rather than retried
 * forever — an infinite loop here would present as the import hanging, which
 * D-052 asks us to make distinguishable from slowness.
 */
export function writeFully(
  handle: { write(buffer: ArrayBufferView, options?: { at?: number }): number },
  bytes: Uint8Array,
  at: number
): void {
  let done = 0
  while (done < bytes.length) {
    const wrote = handle.write(bytes.subarray(done), { at: at + done })
    if (!(wrote > 0)) {
      throw new Error(
        `OPFS write stalled at offset ${at + done} with ${bytes.length - done} bytes left`
      )
    }
    done += wrote
  }
}

/**
 * True for "it was not there" — the one deletion failure that means success.
 *
 * Everything else (notably `NoModificationAllowedError`, which is what a file
 * another tab holds open raises) must propagate: reporting a clear that did not
 * happen is the single failure the "Clear local copy" action must not have.
 */
export function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'NotFoundError'
  )
}
