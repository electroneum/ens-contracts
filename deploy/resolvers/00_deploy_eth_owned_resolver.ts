import { artifacts, deployScript } from '@rocketh'
import { getAddress, namehash } from 'viem'

export default deployScript(
  async ({ deploy, get, read, execute: write, namedAccounts }) => {
    const { deployer, owner } = namedAccounts

    // Deploy OwnedResolver
    const ethOwnedResolver = await deploy('OwnedResolver', {
      account: deployer,
      artifact: artifacts.OwnedResolver,
      args: [],
    })

    if (ethOwnedResolver.newlyDeployed && owner !== deployer) {
      console.log(`  - Transferring ownership of OwnedResolver to ${owner}`)
      await write(ethOwnedResolver, {
        functionName: 'transferOwnership',
        args: [owner],
        account: deployer,
      })
    }

    const registry = get<(typeof artifacts.ENSRegistry)['abi']>('ENSRegistry')
    const registrarSecurityController = get<
      (typeof artifacts.RegistrarSecurityController)['abi']
    >('RegistrarSecurityController')

    const currentResolver = await read(registry, {
      functionName: 'resolver',
      args: [namehash('etn')],
    })

    if (getAddress(currentResolver) === getAddress(ethOwnedResolver.address)) {
      console.log(`  - Resolver for .etn already set`)
      return
    }

    // The registrar owns the .etn node but is itself owned by the
    // RegistrarSecurityController (see 00_setup_base_registrar), so the
    // resolver must be set through the security controller's pass-through.
    console.log(`  - Setting resolver for .etn to ${ethOwnedResolver.address}`)
    await write(registrarSecurityController, {
      functionName: 'setRegistrarResolver',
      args: [ethOwnedResolver.address],
      account: owner,
    })
  },
  {
    id: 'EthOwnedResolver v1.0.0',
    tags: ['category:resolvers', 'OwnedResolver', 'EthOwnedResolver'],
    dependencies: [
      'ENSRegistry',
      'BaseRegistrarImplementation',
      'RegistrarSecurityController',
    ],
  },
)
