import { type artifacts, deployScript } from '@rocketh'
import { getAddress, labelhash, namehash, type Address } from 'viem'

export default deployScript(
  async ({
    get,
    read,
    execute: write,
    namedAccounts: { deployer, owner },
    network,
  }) => {
    if (!network.tags.use_root) return

    const registry = get<(typeof artifacts.ENSRegistry)['abi']>('ENSRegistry')
    const root = get<(typeof artifacts.Root)['abi']>('Root')
    const registrar = get<
      (typeof artifacts.BaseRegistrarImplementation)['abi']
    >('BaseRegistrarImplementation')
    const registrarSecurityController = get<
      (typeof artifacts.RegistrarSecurityController)['abi']
    >('RegistrarSecurityController')

    // 1. Transfer ownership of registrar to RegistrarSecurityController
    //    (skip if a previous run already did — the deployer would no longer
    //    be authorised and the tx would revert)
    const registrarOwner = await read(registrar, {
      functionName: 'owner',
      args: [],
    }).then((v) => getAddress(v as Address))

    if (registrarOwner !== getAddress(registrarSecurityController.address)) {
      console.log(
        `  - Transferring ownership of registrar to RegistrarSecurityController`,
      )
      await write(registrar, {
        functionName: 'transferOwnership',
        args: [registrarSecurityController.address],
        account: deployer,
      })
    } else {
      console.log(`  - Registrar already owned by RegistrarSecurityController`)
    }

    // 2. Set owner of etn node to registrar on root
    const etnNodeOwner = await read(registry, {
      functionName: 'owner',
      args: [namehash('etn')],
    }).then((v) => getAddress(v as Address))

    if (etnNodeOwner !== getAddress(registrar.address)) {
      console.log(`  - Setting owner of etn node to registrar on root`)
      await write(root, {
        functionName: 'setSubnodeOwner',
        args: [labelhash('etn'), registrar.address],
        account: owner,
      })
    } else {
      console.log(`  - etn node already owned by registrar`)
    }
  },
  {
    id: 'BaseRegistrarImplementation:setup v1.0.0',
    tags: [
      'category:ethregistrar',
      'BaseRegistrarImplementation',
      'BaseRegistrarImplementation:setup',
    ],
    // Runs after the root is setup
    dependencies: [
      'ENSRegistry',
      'Root',
      'BaseRegistrarImplementation:contract',
      'RegistrarSecurityController:contract',
    ],
  },
)
