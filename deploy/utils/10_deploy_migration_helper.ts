import { artifacts, deployScript } from '@rocketh'
import { getAddress, type Address } from 'viem'

export default deployScript(
  async ({ deploy, get, read, execute: write, namedAccounts }) => {
    const { deployer, owner } = namedAccounts

    const registrar = get<
      (typeof artifacts.BaseRegistrarImplementation)['abi']
    >('BaseRegistrarImplementation')
    const wrapper = get<(typeof artifacts.NameWrapper)['abi']>('NameWrapper')

    const migrationHelper = await deploy('MigrationHelper', {
      account: deployer,
      artifact: artifacts.MigrationHelper,
      args: [registrar.address, wrapper.address],
    })

    // Transfer ownership to owner (skip if a previous run already did)
    const currentOwner = await read(migrationHelper, {
      functionName: 'owner',
      args: [],
    }).then((v) => getAddress(v as Address))
    if (owner && owner !== deployer && currentOwner !== getAddress(owner)) {
      console.log(`  - Transferring ownership to ${owner}`)
      await write(migrationHelper, {
        account: deployer,
        functionName: 'transferOwnership',
        args: [owner],
      })
    }

    return true
  },
  {
    id: 'MigrationHelper v1.0.0',
    tags: ['category:utils', 'MigrationHelper'],
    dependencies: ['BaseRegistrarImplementation', 'NameWrapper'],
  },
)
