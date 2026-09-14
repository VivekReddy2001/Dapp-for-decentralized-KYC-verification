# Security

## Status of this project

This is a **university project and a learning artefact**, published so the design and its flaws can
be read. It is not production software and must not be deployed to a public network or used with
anyone's real identity documents. It runs against a local Ganache chain on purpose.

Everything below was found by reading the contract and the client carefully and by running the whole
flow end to end. Rather than quietly patching the interesting parts away, the findings are written up
here with the fix each one needs — the analysis is the most useful thing in the repository.

## Reporting

If you find something not listed here, please open a
[security advisory](https://github.com/VivekReddy2001/Dapp-for-decentralized-KYC-verification/security/advisories/new)
rather than a public issue.

---

## The short version

| # | Finding | Severity | Where |
|---|---|---|---|
| 1 | Personal data is stored in the clear on a public ledger | **Critical** | `kyc.sol` · `addCustomer` |
| 2 | Customer passwords are stored in the clear on chain | **Critical** | `kyc.sol` · `setPassword` |
| 3 | Consent is enforced by the web page, not the contract | **Critical** | `kyc.sol` · `viewCustomer` |
| 4 | Anyone can grant a bank access to anyone's record | **High** | `kyc.sol` · `allowBank` |
| 5 | Any registered bank can overwrite or delete any record | **High** | `kyc.sol` · `modifyCustomer`, `removeCustomer` |
| 6 | Anyone can change any rating | **High** | `kyc.sol` · `updateRatingCustomer`, `updateRating` |
| 7 | A bank's "password" is its public Ethereum address | **Medium** | `kyc.sol` · `checkBank` |
| 8 | Array removal loops are incorrect | **Medium** | `kyc.sol` · three functions |
| 9 | Unsigned arithmetic wraps instead of reverting | **Medium** | `kyc.sol` · rating maths |
| 10 | Session state is a plain value in `localStorage` | **Medium** | `index.js`, `bankHomePage.js` |
| 11 | Consent cannot be withdrawn | **Medium** | `kyc.sol` · no `revokeBank` |
| 12 | The record encoding has no escaping | **Low** | `addForm.js` · `getInfo` |
| 13 | No events, so there is no auditable history | **Low** | `kyc.sol` |
| 14 | The UI reports success regardless of the return code | **Low** | `index.js` · `onSignUp` |

---

## 1. Personal data in the clear, on a public ledger — Critical

`addCustomer` stores the whole KYC record — name, date of birth, residential address, two phone
numbers, email, occupation and income band — as a plain string in contract storage. Contract storage
is world-readable: anyone with the contract address can read every record, and no permission check
applies to reading storage directly. On a public chain it would also be **permanent**; there is no
delete, no correction and no right to be forgotten.

**Fix.** Encrypt in the browser, store the ciphertext off chain, keep only the content hash on chain:

```solidity
struct Customer {
    string uname;
    bytes32 dataCID;   // IPFS content identifier of the encrypted record
    // ...
}
```

The field is already called `dataHash`, which suggests this was the intention, and an RSA
implementation is already vendored in `src/RSA_JS/` but never called. This is roadmap item 2.

## 2. Passwords in the clear, on chain — Critical

`setPassword` writes the customer's password into contract storage as a string, and `checkCustomer`
compares it there. Both are readable by anyone.

**Fix.** Delete the concept. A customer authenticates by signing a nonce with the wallet that owns
their record:

```solidity
mapping(string => address) public owner;   // uname → the customer's address
// ...
require(msg.sender == owner[uname], "not your record");
```

No password exists, so none can leak.

## 3. Consent is enforced in the wrong layer — Critical

This is the finding that matters most, because consent is the entire point of the project.

`bankHomePage.js` calls `ifAllowed(...)` and only navigates to the record page if it returns true.
The **contract** never checks. `viewCustomer` gates on `isPartOfOrg(msg.sender)` alone, so any
registered bank that calls the contract directly — Remix, `curl`, thirty lines of ethers — reads
every record without asking anyone.

**Fix**, four lines:

```solidity
function viewCustomer(string memory Uname) public view returns (string memory) {
    require(isPartOfOrg(), "not a member");
    require(ifAllowed(Uname, msg.sender), "no consent");   // <-- the missing line
    // ...
}
```

## 4. `allowBank` has no access control — High

The customer is identified by a username passed in as an argument, and nothing ties that username to
`msg.sender`. Any address can call `allowBank("anita.rao", attackerBank, true)` and grant itself
access. The customer portal is the only thing standing in the way, and it is a static file.

**Fix.** Bind records to an address as in finding 2, then `require(msg.sender == owner[Uname])`.

## 5. Any bank can overwrite any record — High

`modifyCustomer` and `removeCustomer` check only that the caller is *a* registered bank, not that it
is *the* bank that created the record — and `modifyCustomer` reassigns `bank = msg.sender`, so
overwriting someone else's record also takes it over.

**Fix.** `require(allCustomers[i].bank == msg.sender || ifAllowed(Uname, msg.sender))`.

## 6. Anyone can change any rating — High

`updateRatingCustomer` and `updateRating` are both `public` with no caller check, so reputation can
be set arbitrarily by anyone. Since the ratings are what a lending platform would price risk on, this
would be the first thing attacked.

**Fix.** Restrict to registered banks, one vote per bank per customer, and derive bank ratings only
from state transitions the contract itself performs.

## 7. A bank's "password" is public information — Medium

`checkBank(string Uname, address password)` matches a registered bank's name against its Ethereum
address. That address is on the ledger, so the "password" is public by construction. Anyone can sign
in to the bank dashboard as any bank.

Writes are still protected — the contract checks `msg.sender`, which requires the private key — so
this is a UI-level impersonation. It is still the wrong shape.

**Fix.** Authenticate with a signed challenge through MetaMask; drop `checkBank` entirely.

## 8. Array removal is broken — Medium

Three places shift elements incorrectly:

```solidity
// removeBank / removeCustomer — wrong direction, and underflows when i == 0
for (uint j = i + 1; j < allOrgs.length; ++j) { allOrgs[i-1] = allOrgs[i]; }

// allowBank deny branch — i never advances, so the same pair is copied repeatedly
for (uint j = i; j < allRequests.length - 2; ++j) { allRequests[i] = allRequests[i+1]; }
```

**Fix.** The idiomatic swap-and-pop:

```solidity
allCustomers[i] = allCustomers[allCustomers.length - 1];
allCustomers.pop();
```

## 9. Arithmetic wraps instead of reverting — Medium

Compiled with solc 0.5, where unsigned subtraction below zero wraps to `2²⁵⁶ − 1` rather than
reverting. `updateRatingCustomer(uname, false)` decrements `upvotes` before using it, so a downvote
at zero upvotes wraps both the counter and the rating. The `if (rating < 0)` guards can never fire,
because `rating` is a `uint`.

**Fix.** Compile with 0.8.x, where overflow reverts by default — or use SafeMath while staying on
0.5.x.

## 10. Session state lives in `localStorage` — Medium

`bank_eth_account`, `username_c` and `password_c` are plain values in web storage, written at sign-in
and trusted by every later page without re-checking. Setting `bank_eth_account` in the browser console
is enough to reach the bank dashboard. The customer's password is kept there too, in the clear.

**Fix.** Derive the account from the connected wallet on every page; never store a password anywhere.

## 11. Consent cannot be withdrawn — Medium

Once `isAllowed` is true there is no path back: the deny branch only removes rows that are still
pending. A customer who grants access grants it for ever.

**Fix.** Add `revokeBank(string uname)` that flips the flag back, restricted to the record's owner.

## 12. The record encoding has no escaping — Low

Fields are joined with the literal `!@#`. A customer whose address contains that sequence shifts
every field after it, and the front end has no way to detect it.

**Fix.** Encode as JSON, or store a struct.

## 13. No events — Low

The contract emits nothing. Registrations, record changes and consent decisions leave no log, so
there is no way to reconstruct history, and clients must poll.

**Fix.** `event ConsentGranted(string indexed uname, address indexed bank, uint256 at);` and
equivalents for the other state changes.

## 14. The UI reports success regardless of outcome — Low

`onSignUp` sends the `addBank` transaction and immediately alerts "has been successfully added to the
network", without reading the return code. A rejected registration looks identical to an accepted one.

**Fix.** Do the dry-run call first and branch on the code, exactly as `addForm.js` already does for
`addCustomer`.

---

## Fixed while documenting the project

Small, non-behavioural corrections made as part of publishing this repository — each one is described
in the README:

- **The bank's "View KYC" page rendered almost nothing.** Twelve of its fifteen field rows were
  commented out in `viewForm.html` while `viewForm.js` still wrote to them, so rendering aborted at
  the first missing element and the page showed only the username. Uncommenting the rows restored it.
- **A third-party image was loaded over plain HTTP.** The star-rating CSS pulled a sprite from
  `http://www.ulmanen.fi/stuff/stars.png` — an external dependency on someone else's server, over an
  unencrypted connection, on every page load. It is now a local asset.
- **43 MB of `node_modules` was committed** inside `src/`, including transitive dependencies with
  their own known advisories. Removed and ignored.

## Dependencies

`npm audit` reports advisories in the development toolchain (Truffle 5 and Ganache 7, both of which
have reached end of life). They affect the local build and test chain, not any deployed artefact,
because nothing here is deployed. Moving to Hardhat or Foundry is the fix, and is on the roadmap.
