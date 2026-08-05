import { artifacts, deployScript } from '@rocketh'

// Replaces the StaticMetadataService deployed in 00 (which pointed at the
// upstream ENS appspot URL) with one pointing at our own ens-metadata-service,
// and repoints NameWrapper at it. The URL embeds the NameWrapper address
// (ens-metadata-service route format: /{network}/{contract}/{tokenId}), which
// is unknowable in 00 since it runs before 01 deploys the NameWrapper.
export default deployScript(
  async ({ deploy, get, read, execute: write, namedAccounts, network }) => {
    const { deployer, owner } = namedAccounts

    const nameWrapper =
      get<(typeof artifacts.NameWrapper)['abi']>('NameWrapper')

    const metadataHost =
      process.env.METADATA_HOST || 'ens-metadata.electroneum.com'
    let metadataUrl = `https://${metadataHost}/${network.name}/${nameWrapper.address}/0x{id}`
    if (network.name === 'localhost' || network.name === 'hardhat') {
      metadataUrl = `http://localhost:8080/${network.name}/${nameWrapper.address}/0x{id}`
    }

    const metadata = await deploy('StaticMetadataService', {
      account: deployer,
      artifact: artifacts.StaticMetadataService,
      args: [metadataUrl],
    })

    // rocketh redeploys when constructor args change; guard against a stale
    // record slipping through, which would silently keep the wrong URL live
    const servedUrl = await read(metadata, {
      functionName: 'uri',
      args: [0n],
    })
    if (servedUrl !== metadataUrl) {
      throw new Error(
        `StaticMetadataService at ${metadata.address} serves "${servedUrl}" ` +
          `but "${metadataUrl}" was expected — deployment record is stale`,
      )
    }

    const currentService = (await read(nameWrapper, {
      functionName: 'metadataService',
    })) as string
    if (currentService.toLowerCase() === metadata.address.toLowerCase()) {
      console.log(`  - NameWrapper already points at ${metadata.address}`)
      return true
    }

    const nameWrapperOwner = (await read(nameWrapper, {
      functionName: 'owner',
    })) as string
    if (nameWrapperOwner.toLowerCase() !== owner.toLowerCase()) {
      throw new Error(
        `NameWrapper owner is ${nameWrapperOwner}; the configured 'owner' ` +
          `account is ${owner} — cannot call setMetadataService`,
      )
    }

    console.log(
      `  - Pointing NameWrapper.metadataService at ${metadata.address} (${metadataUrl})`,
    )
    await write(nameWrapper, {
      functionName: 'setMetadataService',
      args: [metadata.address],
      account: owner,
    })

    return true
  },
  {
    id: 'UpdateMetadataService v1.0.0',
    tags: ['category:wrapper', 'UpdateMetadataService'],
    dependencies: ['NameWrapper'],
  },
)
