import { artifacts, deployScript } from '@rocketh'
import { getAddress, labelhash, namehash, type Address } from 'viem'

export default deployScript(
  async ({ deploy, get, read, execute: write, namedAccounts, network }) => {
    const { deployer, owner } = namedAccounts

    const defaultReverseRegistrar = get<
      (typeof artifacts.DefaultReverseRegistrar)['abi']
    >('DefaultReverseRegistrar')
    const registry = get<(typeof artifacts.ENSRegistry)['abi']>('ENSRegistry')
    const root = get<(typeof artifacts.Root)['abi']>('Root')

    const defaultReverseResolver = await deploy('DefaultReverseResolver', {
      account: deployer,
      artifact: artifacts.DefaultReverseResolver,
      args: [defaultReverseRegistrar.address],
    })

    if (network.name === 'mainnet' && !network.tags.tenderly) return

    // Normalize before comparing: on-chain reads come back checksummed while
    // configured accounts may be lowercase; a raw === mismatch silently
    // skipped this whole setup.
    const currentRootOwner = await read(root, {
      functionName: 'owner',
      args: [],
    }).then((v) => getAddress(v as Address))
    const currentReverseOwner = await read(registry, {
      functionName: 'owner',
      args: [namehash('reverse')],
    }).then((v) => getAddress(v as Address))
    if (
      currentRootOwner === getAddress(owner) &&
      currentReverseOwner !== getAddress(owner)
    ) {
      console.log(`  - Setting owner of .reverse to owner on root`)
      await write(root, {
        functionName: 'setSubnodeOwner',
        args: [labelhash('reverse'), owner],
        account: owner,
      })
    } else if (currentRootOwner !== getAddress(owner)) {
      console.warn(
        `  - WARN: Root owner account not available, skipping .reverse setup on registry`,
      )
      return
    }

    const currentResolver = await read(registry, {
      functionName: 'resolver',
      args: [namehash('reverse')],
    }).then((v) => getAddress(v as Address))
    if (currentResolver === getAddress(defaultReverseResolver.address)) {
      console.log(`  - Resolver of .reverse already set`)
      return
    }

    console.log(
      `  - Setting resolver of .reverse to DefaultReverseResolver on registry`,
    )
    await write(registry, {
      functionName: 'setResolver',
      args: [namehash('reverse'), defaultReverseResolver.address],
      account: owner,
    })
  },
  {
    id: 'DefaultReverseResolver v1.0.0',
    tags: ['category:reverseresolver', 'DefaultReverseResolver'],
    dependencies: ['ENSRegistry', 'Root', 'DefaultReverseRegistrar'],
  },
)
