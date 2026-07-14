import { artifacts, deployScript } from '@rocketh'
import { getAddress, labelhash, type Address } from 'viem'
import {
  RESERVATION_DURATION,
  RESERVED_NAMES,
} from '../../scripts/reserved_names.js'

// Names reserved for Electroneum at launch (see scripts/reserved_names.ts
// for the list). They are registered directly on the base registrar
// (controller-only, no payment — registration fees only exist in the public
// ETHRegistrarController) to the owner account, as ordinary registrar NFTs:
// renewable, transferable and reclaimable like any other .etn name.

export default deployScript(
  async ({
    get,
    read,
    execute: write,
    namedAccounts: { deployer, owner },
    network,
  }) => {
    if (!network.tags.use_root) return

    const registrar = get<
      (typeof artifacts.BaseRegistrarImplementation)['abi']
    >('BaseRegistrarImplementation')
    const registrarSecurityController = get<
      (typeof artifacts.RegistrarSecurityController)['abi']
    >('RegistrarSecurityController')

    const pending: string[] = []
    for (const label of RESERVED_NAMES) {
      const labelId = BigInt(labelhash(label))
      const available = await read(registrar, {
        functionName: 'available',
        args: [labelId],
      })
      if (!available) {
        const currentOwner = await read(registrar, {
          functionName: 'ownerOf',
          args: [labelId],
        }).then((v) => getAddress(v as Address))
        console.log(
          `  - ${label}.etn already registered (owner ${currentOwner})`,
        )
        continue
      }
      pending.push(label)
    }
    if (!pending.length) return true

    // Temporarily authorise the owner account as a registrar controller so
    // it can register directly on the base registrar.
    const ownerIsController = await read(registrar, {
      functionName: 'controllers',
      args: [owner],
    })
    if (!ownerIsController) {
      console.log(`  - Authorising ${owner} as temporary registrar controller`)
      await write(registrarSecurityController, {
        functionName: 'addRegistrarController',
        args: [owner],
        account: owner,
      })
    }

    for (const label of pending) {
      console.log(
        `  - Registering reserved name ${label}.etn to ${owner} for ${RESERVATION_DURATION / (365n * 24n * 60n * 60n)
        } years`,
      )
      await write(registrar, {
        functionName: 'register',
        args: [BigInt(labelhash(label)), owner, RESERVATION_DURATION],
        account: owner,
      })
    }

    if (!ownerIsController) {
      console.log(`  - Revoking temporary registrar controller authorisation`)
      await write(registrarSecurityController, {
        functionName: 'removeRegistrarController',
        args: [owner],
        account: owner,
      })
    }

    return true
  },
  {
    id: 'ReservedNames v1.0.0',
    tags: ['category:ethregistrar', 'ReservedNames'],
    dependencies: [
      'BaseRegistrarImplementation',
      'RegistrarSecurityController',
    ],
  },
)
