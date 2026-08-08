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

// Foundation-registered names added after launch (see
// deploy/ethregistrar/08_register_validator_name.ts): infrastructure
// namespace roots and brand/partner reservations. Kept separate from
// RESERVED_NAMES so the launch migration's behaviour is unchanged.
// `validators` hosts validator identities as subnames (v1.validators.etn, …)
// under the management wallet. To add names: append here, bump the migration
// id in 08, seed the labels into the explorer's ens_names table BEFORE
// running (BENS.md troubleshooting), then run --tags InfrastructureNames.
export const INFRASTRUCTURE_NAMES = [
  'validators',
  'electrofox',
  'naturecredits',
  'bluecarbon',
  'oneocean',
  '1ocean',
  'oneoceanfoundation',
  '1oceanfoundation',
]
