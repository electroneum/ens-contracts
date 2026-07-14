// Names reserved for Electroneum at launch — single source of truth, used by
// the deploy step (deploy/ethregistrar/06_register_reserved_names.ts) and the
// verification script (scripts/verify-deployment.ts).
//
// 'resolver' backs the legacy resolver.eth discovery convention:
// 00_deploy_public_resolver points resolver.etn at the PublicResolver once
// the owner account owns the name.
export const RESERVED_NAMES = [
  'wallet',
  'pay',
  'team',
  'admin',
  'support',
  'official',
  'electroneum',
  'etn',
  'planetzephyros',
  'resolver',
]

export const RESERVATION_DURATION = 100n * 365n * 24n * 60n * 60n // 100 years
