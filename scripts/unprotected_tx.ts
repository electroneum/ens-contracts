// Helpers for dealing with pre-signed, pre-EIP-155 deployment transactions
// (Nick's method). go-ethereum-based nodes without --rpc.allow-unprotected-txs
// (e.g. Electroneum's etn-sc) reject them at the RPC level.

/// Errors surface differently per provider: hardhat throws ProviderError
/// instances, rocketh's JSONRPCHTTPProvider throws the raw JSON-RPC error
/// object ({code, message}), possibly with nested cause/data. Collect all
/// message text before matching.
export const describeError = (e: unknown, depth = 0): string => {
  if (e == null || depth > 4) return ''
  const parts: string[] = []
  if (typeof e === 'string') parts.push(e)
  else if (typeof e === 'object') {
    const anyErr = e as Record<string, unknown>
    if (typeof anyErr.message === 'string') parts.push(anyErr.message)
    if (typeof anyErr.details === 'string') parts.push(anyErr.details)
    parts.push(describeError(anyErr.cause, depth + 1))
    parts.push(describeError(anyErr.data, depth + 1))
    parts.push(describeError(anyErr.error, depth + 1))
  }
  return parts.filter(Boolean).join(' | ')
}

export const isUnprotectedTxRejection = (e: unknown) =>
  /replay.protected|eip.?155/i.test(describeError(e))
