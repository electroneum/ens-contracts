import { artifacts, deployScript } from '@rocketh'
import {
  getAddress,
  isAddress,
  labelhash,
  namehash,
  zeroAddress,
  type Address,
} from 'viem'
import {
  INFRASTRUCTURE_NAMES,
  RESERVATION_DURATION,
} from '../../scripts/reserved_names.js'

// Registers the infrastructure namespace roots (see scripts/reserved_names.ts)
// fee-free for 100 years and points them at the PublicResolver. Registration
// goes directly through the base registrar (controller-only, no payment —
// fees only exist in the public ETHRegistrarController), using the same
// temporary controller grant as 06_register_reserved_names.
//
// If INFRASTRUCTURE_NAMES_OWNER is set (an address), each name is then handed
// over to it — both the registrar NFT (registrant) and the registry node
// (manager) — so a dedicated management wallet can run the namespace without
// involving the ENS owner key. The handover needs no action from the target
// wallet. Order matters: the resolver is set while the owner account still
// holds the registry node, then ownership moves.
//
// Validator identities are then created as subnames by the management wallet
// (eg. validator1.validator.etn) — free registry writes, impersonation-proof
// by construction, and renewed with the single parent name. Subname creation,
// wrapping, and reverse-record signatures are interactive/dapp operations,
// deliberately not part of this migration.
//
// NOTE (explorer): registrar-level registration emits no plaintext label, so
// each label must be seeded into the explorer's ens_names table (BENS.md
// §2.6) or it renders as [0x…].etn. This script prints the INSERT statement.

export default deployScript(
  async ({
    get,
    read,
    execute: write,
    namedAccounts: { owner },
    network,
  }) => {
    if (!network.tags.use_root) return

    const targetOwnerRaw = process.env.INFRASTRUCTURE_NAMES_OWNER
    if (targetOwnerRaw && !isAddress(targetOwnerRaw)) {
      throw new Error(
        `INFRASTRUCTURE_NAMES_OWNER is not a valid address: ${targetOwnerRaw}`,
      )
    }
    const targetOwner = targetOwnerRaw
      ? getAddress(targetOwnerRaw)
      : getAddress(owner)
    const ownerAddr = getAddress(owner)

    const registrar = get<
      (typeof artifacts.BaseRegistrarImplementation)['abi']
    >('BaseRegistrarImplementation')
    const registrarSecurityController = get<
      (typeof artifacts.RegistrarSecurityController)['abi']
    >('RegistrarSecurityController')
    const registry = get<(typeof artifacts.ENSRegistry)['abi']>('ENSRegistry')
    const publicResolver =
      get<(typeof artifacts.PublicResolver)['abi']>('PublicResolver')

    let grantedController = false
    const ensureController = async (): Promise<void> => {
      if (grantedController) return
      const isController = await read(registrar, {
        functionName: 'controllers',
        args: [owner],
      })
      if (!isController) {
        console.log(
          `  - Authorising ${owner} as temporary registrar controller`,
        )
        await write(registrarSecurityController, {
          functionName: 'addRegistrarController',
          args: [owner],
          account: owner,
        })
        grantedController = true
      }
    }

    for (const label of INFRASTRUCTURE_NAMES) {
      const labelId = BigInt(labelhash(label))
      const node = namehash(`${label}.etn`)

      // 1. Register (to the owner account first, so the resolver can be set)
      const available = await read(registrar, {
        functionName: 'available',
        args: [labelId],
      })
      if (available) {
        await ensureController()
        console.log(
          `  - Registering ${label}.etn to ${ownerAddr} for ${
            RESERVATION_DURATION / (365n * 24n * 60n * 60n)
          } years`,
        )
        await write(registrar, {
          functionName: 'register',
          args: [labelId, owner, RESERVATION_DURATION],
          account: owner,
        })
      }

      const registrant = await read(registrar, {
        functionName: 'ownerOf',
        args: [labelId],
      }).then((v) => getAddress(v as Address))
      if (registrant !== ownerAddr && registrant !== targetOwner) {
        console.warn(
          `  - WARN: ${label}.etn is registered to ${registrant} (neither the owner account nor the target); skipping`,
        )
        continue
      }

      // 2. Resolver — only possible while the owner account still holds the
      // registry node; after handover the management wallet controls it
      const registryOwner = await read(registry, {
        functionName: 'owner',
        args: [node],
      }).then((v) => getAddress(v as Address))
      if (registryOwner === ownerAddr) {
        const currentResolver = (await read(registry, {
          functionName: 'resolver',
          args: [node],
        })) as Address
        if (currentResolver === zeroAddress) {
          console.log(`  - Setting PublicResolver for ${label}.etn`)
          await write(registry, {
            functionName: 'setResolver',
            args: [node, publicResolver.address],
            account: owner,
          })
        }
      }

      // 3. Handover to the management wallet (registrant + registry node)
      if (targetOwner !== ownerAddr) {
        if (registrant === ownerAddr) {
          console.log(
            `  - Transferring ${label}.etn registrant to ${targetOwner}`,
          )
          await write(registrar, {
            functionName: 'safeTransferFrom',
            args: [owner, targetOwner, labelId],
            account: owner,
          })
        }
        if (registryOwner === ownerAddr) {
          console.log(
            `  - Transferring ${label}.etn registry node to ${targetOwner}`,
          )
          await write(registry, {
            functionName: 'setOwner',
            args: [node, targetOwner],
            account: owner,
          })
        }
      }
    }

    if (grantedController) {
      console.log(`  - Revoking temporary registrar controller authorisation`)
      await write(registrarSecurityController, {
        functionName: 'removeRegistrarController',
        args: [owner],
        account: owner,
      })
    }

    console.log(
      '  - Reminder: seed the explorer ens_names table (BENS.md §2.6):',
    )
    for (const label of INFRASTRUCTURE_NAMES) {
      console.log(
        `      INSERT INTO public.ens_names (hash, name) VALUES ('${labelhash(
          label,
        )}', '${label}') ON CONFLICT DO NOTHING;`,
      )
    }

    return true
  },
  {
    id: 'InfrastructureNames v1.1.0',
    tags: ['category:ethregistrar', 'InfrastructureNames'],
    dependencies: [
      'BaseRegistrarImplementation',
      'RegistrarSecurityController',
      'ENSRegistry',
      'PublicResolver',
    ],
  },
)
