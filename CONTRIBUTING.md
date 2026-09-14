# Contributing

This is a personal project, but issues and pull requests are welcome — especially ones that work
through the items in [`SECURITY.md`](SECURITY.md).

## Running it locally

```bash
npm install
npm run chain      # terminal 1 — Ganache on :8545
npm run deploy     # terminal 2 — compile, migrate, sync the address
npm run serve      # terminal 2 — static pages on :8080
```

Open <http://localhost:8080/index.html> (bank) and <http://localhost:8080/indexCustomer.html>
(customer). The [walkthrough in the README](README.md#walkthrough) drives the whole flow in seven
steps.

**If the pages load but every value is blank**, the front end is pointing at a contract that no longer
exists. Restart Ganache and run `npm run deploy` again — each migration deploys to a new address, and
`npm run sync` is what writes it into `src/js/contractDetails.js`.

## Things worth knowing before you change anything

- **The compiler version is pinned, and it has to be.** `contracts/kyc.sol` grows storage arrays with
  `array.length++`, which Solidity removed in 0.6. `truffle-config.js` pins 0.5.0 — the version the
  original build artefact records. If you upgrade the compiler you are also rewriting the contract,
  which is fine, but do it deliberately.
- **`src/js/contractDetails.js` is generated.** Everything above the "IDs of all elements" comment is
  overwritten by `npm run sync`; the `allIds` array below it is hand-maintained and preserved. Add a
  form field there, not above.
- **A record is a delimited string, and position is the schema.** `allIds` maps index → DOM element
  id. Inserting a field in the middle silently misreads every record already on chain.
- **The contract signals failure by returning a number, not by reverting.** The front end calls a
  function first to read the code, then sends the transaction. Keep that pattern if you add a
  function — or, better, move to `require` with reason strings and update both sides.
- **The front end has no build step.** Plain HTML, Bootstrap 3 and jQuery. Keep it that way unless you
  are replacing the whole client.

## Good first contributions

In rough order of value, all of them described in [`SECURITY.md`](SECURITY.md):

1. Move the consent check inside `viewCustomer` (finding 3) — the single most valuable change here.
2. Add `revokeBank` so consent can be withdrawn (finding 11).
3. Replace the broken array-shift loops with swap-and-pop (finding 8).
4. Emit events for registration, record changes and consent (finding 13).
5. Add a Truffle test suite covering the consent rules and the rating maths — there are no tests today.

## Pull requests

- Say what changed and why, and mention the finding number if it closes one.
- Keep contract changes and front-end changes in separate commits where you can.
- If you change the contract, run `npm run deploy` and confirm the seven-step walkthrough still works
  end to end.
