import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'test/**/*.test.ts',
      'test/reverseResolver/Test*.ts',
      'test/reverseRegistrar/Test*.ts',
      ...(process.env.TEST_REMOTE ? ['test/**/*.remote.ts'] : []),
    ],
    exclude: [
      'test/**/*.behaviour.ts',
      'test/dnssec-oracle/TestDNSSEC.test.ts',
      'test/ethregistrar/TestBaseRegistrar.test.ts',
      'test/ethregistrar/TestBulkRenewal.test.ts',
      'test/ethregistrar/TestEthRegistrarController.test.ts',
      'test/ethregistrar/TestStaticBulkRenewal.test.ts',
      'test/registry/TestENS.test.ts',
      'test/registry/TestFIFSRegistrar.test.ts',
      'test/registry/TestTestRegistrar.test.ts',
      'test/resolvers/TestPublicResolver.test.ts',
      'test/reverseRegistrar/TestReverseRegistrar.test.ts',
      'test/root/TestRoot.test.ts',
    ],
    reporters: ['verbose'],
    environment: 'node',
    globals: true,
    setupFiles: ['./test/setup.ts'],
  },
  esbuild: {
    target: 'node22',
    format: 'esm',
  },
})
