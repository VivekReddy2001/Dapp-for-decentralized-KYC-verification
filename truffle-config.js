/**
 * Truffle configuration.
 *
 * The `development` network matches the Ganache instance started by
 * `npm run chain` (127.0.0.1:8545, network id 5777).
 *
 * The compiler version is pinned on purpose. `contracts/kyc.sol` uses
 * `array.length++` to grow storage arrays, which Solidity removed in 0.6.0,
 * so the contract only compiles on the 0.5.x line. Without this pin, a
 * current Truffle picks a modern solc and the build fails before it starts.
 */
module.exports = {
  networks: {
    development: {
      host: '127.0.0.1',
      port: 8545,
      network_id: '*', // any network id — Ganache defaults to 5777
    },
  },

  compilers: {
    solc: {
      // 0.5.0 is the version build/contracts/kyc.json records for the original
      // 2022 build of this exact source, so it is known to compile it. Any 0.5.x
      // release works; 0.6 and later do not.
      version: '0.5.0',
      settings: {
        optimizer: { enabled: false, runs: 200 },
      },
    },
  },

  mocha: {
    timeout: 100000,
  },
};
