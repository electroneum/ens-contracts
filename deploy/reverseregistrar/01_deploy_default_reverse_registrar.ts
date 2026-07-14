import { artifacts, deployScript } from '@rocketh'
import { getAddress, type Address } from 'viem'

export default deployScript(
  async ({ deploy, read, execute: write, namedAccounts }) => {
    const { deployer, owner } = namedAccounts

    const defaultReverseRegistrar = await deploy('DefaultReverseRegistrar', {
      account: deployer,
      artifact: artifacts.DefaultReverseRegistrar,
    })

    // Transfer ownership to owner (skip if a previous run already did)
    const currentOwner = await read(defaultReverseRegistrar, {
      functionName: 'owner',
      args: [],
    }).then((v) => getAddress(v as Address))
    if (owner !== deployer && currentOwner !== getAddress(owner)) {
      console.log(
        `  - Transferring ownership of DefaultReverseRegistrar to ${owner}`,
      )
      await write(defaultReverseRegistrar, {
        functionName: 'transferOwnership',
        args: [owner],
        account: deployer,
      })
    }
  },
  {
    id: 'DefaultReverseRegistrar v1.0.0',
    tags: ['category:reverseregistrar', 'DefaultReverseRegistrar'],
    dependencies: [],
  },
)
