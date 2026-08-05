import { artifacts, deployScript } from '@rocketh'

export default deployScript(
  async ({ deploy, namedAccounts, network }) => {
    const { deployer } = namedAccounts

    // Placeholder URL only: 02_update_metadata_service redeploys this contract
    // with the full /{network}/{contract}/{tokenId} URL once the NameWrapper
    // address is known, and repoints the NameWrapper at it.
    let metadataHost =
      process.env.METADATA_HOST || 'ens-metadata.electroneum.com'

    if (network.name === 'localhost') {
      metadataHost = 'localhost:8080'
    }

    const metadataUrl = `https://${metadataHost}/name/0x{id}`

    await deploy('StaticMetadataService', {
      account: deployer,
      artifact: artifacts.StaticMetadataService,
      args: [metadataUrl],
    })

    return true
  },
  {
    id: 'StaticMetadataService v1.0.0',
    tags: ['category:wrapper', 'StaticMetadataService'],
    // technically not a dep, but we want to make sure it's deployed first for the consistent address
    dependencies: ['BaseRegistrarImplementation'],
  },
)
