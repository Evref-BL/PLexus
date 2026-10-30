/**
 * Whether a process is still running.
 *
 * Three copies of this existed — the runtime observation, the launch poll, and
 * the gateway needed a fourth — because the gateway may not import out of its
 * own directory. So the one copy lives here, inside that boundary, and the
 * rest import in. It reaches nothing itself, which is what makes that legal.
 */
export function isPidAlive(pid: number): boolean {
  try {
    globalThis.process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means a process exists that this one may not signal, which still
    // answers the question being asked.
    return errorCode(error) !== "ESRCH";
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}
