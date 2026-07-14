import { artifacts, deployScript } from '@rocketh'
import { getAddress, zeroAddress, zeroHash, type Address } from 'viem'

export default deployScript(
  async ({
    get,
    deploy,
    namedAccounts: { deployer, owner },
    execute: write,
    read,
    network,
    createLegacyRegistryNames,
  }) => {
    if (network.tags.legacy) {
      console.log('Deploying Legacy ENS Registry...')
      const legacyRegistry = await deploy('LegacyENSRegistry', {
        account: deployer,
        artifact: artifacts.ENSRegistry,
      })

      if (createLegacyRegistryNames) {
        console.log('  - createLegacyRegistryNames hook exists, running setup')
        console.log('  - Setting owner of root node to owner')
        await write(legacyRegistry, {
          functionName: 'setOwner',
          args: [zeroHash, owner],
          account: deployer,
        })

        console.log(`  - Running createLegacyRegistryNames hook`)
        await createLegacyRegistryNames()

        console.log('  - Unsetting owner of root node')
        await write(legacyRegistry, {
          functionName: 'setOwner',
          args: [zeroHash, zeroAddress],
          account: deployer,
        })
      }

      console.log('Deploying ENS Registry with Fallback...')
      await deploy('ENSRegistry', {
        account: deployer,
        artifact: artifacts.ENSRegistryWithFallback,
        args: [legacyRegistry.address],
      })
    } else {
      console.log('Deploying standard ENS Registry...')
      await deploy('ENSRegistry', {
        account: deployer,
        artifact: artifacts.ENSRegistry,
      })
    }

    if (!network.tags.use_root) {
      const registry = get<(typeof artifacts.ENSRegistry)['abi']>('ENSRegistry')
      const rootOwner = await read(registry, {
        functionName: 'owner',
        args: [zeroHash],
      }).then((v) => getAddress(v as Address))
      if (rootOwner === getAddress(deployer)) {
        console.log('  - Setting final owner of root node on registry')
        await write(registry, {
          functionName: 'setOwner',
          args: [zeroHash, owner],
          account: deployer,
        })
      } else if (rootOwner !== getAddress(owner)) {
        console.warn(
          `  - WARN: Registry is owned by ${rootOwner}; cannot transfer to owner`,
        )
      }
    }
  },
  {
    id: 'ENSRegistry v1.0.0',
    tags: ['category:registry', 'ENSRegistry'],
  },
)
