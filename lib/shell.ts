/**
 * Registering the offline app shell, and reporting what it is doing (D-048).
 *
 * Separate from the component that calls it because a broken service worker is
 * *invisible by design*: it fails by serving something slightly old, or by not
 * being there at all, and there is no telemetry to notice either (D-009). So the
 * only way anyone finds out is the diagnostics panel, and the state it shows has
 * to be the browser's own rather than "we called register and it did not throw".
 */

/** What the diagnostics panel says about the shell. */
export interface ShellState {
  /** False when the browser has no service workers at all, or the page is insecure. */
  supported: boolean
  /** A registration exists for this scope. */
  registered: boolean
  /** This page's requests are going through a worker. False on the very first load. */
  controlling: boolean
  /** The cache version the active worker reports, once it answers. */
  version: string | null
  /** A registration that failed, named — the one case silence would hide. */
  error: string | null
}

export const NO_SHELL: ShellState = {
  supported: false,
  registered: false,
  controlling: false,
  version: null,
  error: null,
}

/** Where the generated worker lands, and the scope it claims. */
export const SHELL_URL = '/sw.js'

/**
 * Register the shell and report what happened.
 *
 * Deliberately best-effort in one direction only: a registration that fails
 * leaves the app fully working (it is an *offline* shell, not a dependency) and
 * the failure is reported rather than swallowed. A registration that succeeds
 * changes nothing about this page load either — the worker takes over on the
 * next one, which is what stops a mid-session deploy from swapping code under a
 * running import.
 */
export async function registerShell(
  container: ServiceWorkerContainer | undefined
): Promise<ShellState> {
  if (!container) return { ...NO_SHELL }
  try {
    const registration = await container.register(SHELL_URL, { scope: '/' })
    return {
      supported: true,
      registered: Boolean(registration),
      controlling: Boolean(container.controller),
      version: null,
      error: null,
    }
  } catch (error) {
    return {
      supported: true,
      registered: false,
      controlling: Boolean(container.controller),
      version: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Ask the active worker which cache it is serving from.
 *
 * A round trip rather than a constant, because the interesting case is exactly
 * the one a constant cannot see: the page is new and the worker controlling it
 * is the *previous* deploy's, which is legal (it takes over on the next load)
 * and is also what a stale-shell bug looks like.
 */
export async function shellVersion(
  container: ServiceWorkerContainer | undefined,
  timeoutMs = 2_000
): Promise<string | null> {
  const active = container?.controller
  if (!container || !active) return null
  return new Promise<string | null>((resolve) => {
    const done = (value: string | null) => {
      container.removeEventListener('message', onMessage)
      clearTimeout(timer)
      resolve(value)
    }
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; version?: unknown } | null
      if (data && data.type === 'sw-version')
        done(typeof data.version === 'string' ? data.version : null)
    }
    // Bounded, because an unanswered message would leave the panel waiting
    // forever on the one worker state most worth reporting: a wedged one.
    const timer = setTimeout(() => done(null), timeoutMs)
    container.addEventListener('message', onMessage)
    try {
      active.postMessage('version')
    } catch {
      done(null)
    }
  })
}
