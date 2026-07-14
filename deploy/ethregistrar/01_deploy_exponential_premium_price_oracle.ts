import { artifacts, deployScript } from '@rocketh'
import type { Address } from 'viem'

export default deployScript(
  async ({ deploy, execute: write, namedAccounts, network }) => {
    const { deployer, owner } = namedAccounts

    let oracleAddress: Address = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419'
    if (network.tags?.owned_oracle) {
      // Electroneum has no on-chain ETN/USD feed, so deploy the
      // owner-updated oracle. 8 decimals: 86000 == $0.00086 per ETN.
      // Override with ETN_USD_ORACLE_VALUE and keep the value current
      // via OwnedUsdOracle.set() after deployment.
      const initialValue = BigInt(process.env.ETN_USD_ORACLE_VALUE ?? '86000')
      console.log(`  - Deploying OwnedUsdOracle with value ${initialValue}`)
      const ownedUsdOracle = await deploy('OwnedUsdOracle', {
        account: deployer,
        artifact: artifacts.OwnedUsdOracle,
        args: [initialValue],
      })
      oracleAddress = ownedUsdOracle.address

      if (ownedUsdOracle.newlyDeployed && owner !== deployer) {
        console.log(`  - Transferring ownership of OwnedUsdOracle to ${owner}`)
        await write(ownedUsdOracle, {
          functionName: 'transferOwnership',
          args: [owner],
          account: deployer,
        })
      }
    } else if (network.name !== 'mainnet') {
      const dummyOracle = await deploy('DummyOracle', {
        account: deployer,
        artifact: artifacts.DummyOracle,
        args: [160000000000n],
      })
      oracleAddress = dummyOracle.address
    }

    await deploy('ExponentialPremiumPriceOracle', {
      account: deployer,
      artifact: artifacts.ExponentialPremiumPriceOracle,
      args: [
        oracleAddress,
        [0n, 0n, 20294266869609n, 5073566717402n, 158548959919n],
        100000000000000000000000000n,
        21n,
      ],
    })
  },
  {
    id: 'ExponentialPremiumPriceOracle v1.0.0',
    tags: [
      'category:ethregistrar',
      'ExponentialPremiumPriceOracle',
      'DummyOracle',
      'OwnedUsdOracle',
    ],
    dependencies: [],
  },
)
