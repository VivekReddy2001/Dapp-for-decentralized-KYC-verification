# `kyc.sol` — contract reference

Every public function of the contract, what it does, who may call it and what it returns.
Source: [`contracts/kyc.sol`](../contracts/kyc.sol). Compiled with **solc 0.5.0** — the version recorded in the original build artefact. Any 0.5.x release compiles it; 0.6 and later do not.

The contract is a single contract with no inheritance, no libraries, no events and no modifiers.
State lives in three dynamic arrays:

```solidity
Customer[]     allCustomers;   // one per verified individual
Organisation[] allOrgs;        // one per registered bank
Request[]      allRequests;    // one per (customer, bank) access request
```

> **Everything below is `payable` and non-`view`** — including the getters. That is unusual and has
> two consequences: a caller has to say `.call()` explicitly to read without sending a transaction,
> and no other contract can read this one for free. Section
> [2.8 of the architecture doc](ARCHITECTURE.md#28-storage-layout-and-cost) explains why that matters.

---

## Conventions

| Return | Meaning |
|---|---|
| `0` | Success |
| `1` | Not found |
| `2` | Username already in use |
| `7` | Caller is not a registered bank |
| `"null"` | No match, for the string getters |
| `"0"` | Successful bank sign-in |
| `0x14E0…757A` | Sentinel "no such address" |

`n` = number of customers, `m` = number of banks, `r` = number of requests.

---

## Bank registration

### `addBank(string uname, address eth, string regNum) → uint`

Adds an institution to the network with `rating = 200` (2.00 stars) and `KYC_count = 0`.

- **Access:** succeeds if `allOrgs` is empty — the network bootstraps with whoever registers first —
  or if `msg.sender` is already a registered bank. Otherwise returns `7` and writes nothing.
- **Cost:** O(m) for the membership check, plus one storage push.
- **Note:** the same name and the same address can be registered more than once; there is no
  uniqueness check on either.

### `removeBank(address eth) → uint`

Removes an institution. Returns `7` if the caller is not a member, `1` if the address is not
registered, `0` on success.

> ⚠️ **The shift loop is wrong.** It copies `allOrgs[i-1] = allOrgs[i]`, which underflows when the
> match is at index 0 and copies in the wrong direction for every other index. Do not rely on this
> function.

### `isPartOfOrg() → bool`

True if `msg.sender` is a registered bank. Called internally by every write.

### `checkBank(string Uname, address password) → string`

Bank sign-in. Returns `"0"` when a registered bank has both that name and that address, `"null"`
otherwise.

> ⚠️ The parameter named `password` is an **Ethereum address**, and it is public information. Anyone
> who knows a bank's name and its address can sign in as that bank in the UI. The contract still
> checks `msg.sender` on writes, so this grants UI access, not write access.

---

## Customer records

### `addCustomer(string Uname, string DataHash) → uint`

Creates a record with `rating = 100`, `upvotes = 0`, `bank = msg.sender` and `password = "null"`,
then raises the calling bank's rating.

- **Access:** registered banks only — returns `7` otherwise.
- **Returns:** `2` if the username is taken, `0` on success. (`1` is documented as an overflow guard
  and is unreachable.)
- **Cost:** O(n) duplicate scan, then a push.
- `DataHash` is not a hash — it is the whole record, `!@#`-delimited. See
  [2.6](ARCHITECTURE.md#26-how-a-record-is-encoded).

### `modifyCustomer(string Uname, string DataHash) → uint`

Replaces the record and **reassigns ownership to the caller** (`bank = msg.sender`). Returns `7` for
non-banks, `1` if the username is unknown, `0` on success.

> ⚠️ Any registered bank can overwrite any customer's record, including one another bank created, and
> takes ownership of it by doing so. There is no check that the caller is the record's bank, and no
> consent check at all.

### `removeCustomer(string Uname) → uint`

Deletes a record and lowers the rating of the bank that created it. Returns `7`, `1` or `0`.

> ⚠️ Same broken shift loop as `removeBank`.

### `viewCustomer(string Uname) → string`

Returns the stored record.

- **Access:** returns `"Access denied!"` for non-banks, `"Customer not found in database!"` for an
  unknown username.
- ⚠️ **This function does not check consent.** `ifAllowed` is consulted by the web page before it
  navigates, not by the contract. Any registered bank calling the contract directly reads any record.
  This is the most important fix in [`SECURITY.md`](../SECURITY.md).

---

## Consent

### `addRequest(string Uname, address bankAddress)`

Queues an access request. Deduplicated: if a row already exists for that (customer, bank) pair the
call returns without writing.

- **Access:** none. Any address can queue a request naming any bank.
- **Cost:** O(r).

### `allowBank(string Uname, address bankAddress, bool ifallowed)`

The customer's answer. `true` sets `isAllowed`; `false` removes the row.

- **Access:** ⚠️ **none.** The customer is identified by a username passed in as an argument, so any
  address can grant a bank access to any customer's record. The customer portal is the only thing
  enforcing who may call this.
- ⚠️ The deny branch's shift loop assigns `allRequests[i] = allRequests[i+1]` inside a loop over `j`,
  so `i` never advances — it can corrupt neighbouring rows.

### `ifAllowed(string Uname, address bankAddress) → bool`

True if an allowed request exists for that pair. O(r).

### `getBankRequests(string Uname, uint ind) → address`

Returns the requesting bank's address at index `ind` if that row belongs to `Uname` and is still
pending; the sentinel address otherwise.

> ⚠️ Indexes `allRequests[ind]` directly, so calling past the end throws an invalid-opcode
> exception. The customer page relies on that exception to end its loop — see
> [2.4](ARCHITECTURE.md#24-sequence--consent-the-core-of-the-design). A `getRequestCount()` view
> would replace the whole pattern.

---

## Customer accounts

### `setPassword(string Uname, string password) → bool`

Lets a customer claim the record a bank created for them. Succeeds only while the stored password is
still the literal `"null"`, so it works exactly once per record.

> ⚠️ The password is stored **in plaintext in contract storage**, which is world-readable. Anyone can
> read every customer's password straight off the chain. Nothing about this is fixable by changing
> the client — it has to leave the contract.

### `checkCustomer(string Uname, string password) → bool`

Customer sign-in: a plaintext string comparison, on chain.

---

## Reputation

### `updateRating(address bankAddress, bool ifAdded) → uint`

Moves a bank's rating: `+100/KYC_count` when a record is added, `−100/(KYC_count+1)` when one is
deleted. Capped at 500.

### `updateRatingCustomer(string Uname, bool ifIncrease) → uint`

Moves a customer's rating by the same diminishing-returns formula against `upvotes`.

> ⚠️ Neither function checks the caller — any address can rate anyone. And in Solidity 0.5 the
> subtraction wraps rather than reverting, so a downvote at zero upvotes produces a colossal number.
> The `if (rating < 0)` guards can never fire, because `rating` is unsigned.

---

## Getters

| Function | Returns | Notes |
|---|---|---|
| `getBankName(address) → string` | Bank name | `"null"` if unknown |
| `getBankEth(string uname) → address` | Bank address by name | Sentinel if unknown |
| `getBankReg(address) → string` | Registration number | `"null"` if unknown |
| `getBankKYC(address) → uint` | Records verified | `0` if unknown |
| `getBankRating(address) → uint` | Rating ×100 | `0` if unknown |
| `getCustomerRating(string) → uint` | Rating ×100 | `0` if unknown |
| `getCustomerBankName(string) → string` | Name of the customer's bank | ⚠️ no `return` on the miss path, so an unknown username yields an empty string |
| `getCustomerBankRating(string) → uint` | Rating of the customer's bank | ⚠️ same missing `return` |

---

## Internal

### `stringsEqual(string storage a, string memory b) → bool`

Byte-by-byte string comparison — Solidity has no `==` for strings. Used by every username lookup,
which is why lookups are O(n × length). `keccak256(abi.encodePacked(a)) == keccak256(...)` would be
cheaper, and a `mapping` would remove the need entirely.

---

## Calling the contract without the UI

Useful for testing the findings above. With the chain running and the contract deployed:

```bash
# the deployed address (written by `npm run sync`)
grep contractAddress src/js/contractDetails.js

# read a record as an arbitrary account — demonstrates the missing consent check
node -e '
const addr = "0xYourContractAddress";
const data = "0x" + /* viewCustomer selector */ "107925bb" + /* abi-encoded string */ "";
fetch("http://127.0.0.1:8545", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call",
    params: [{ to: addr, data }, "latest"] }),
}).then(r => r.json()).then(console.log);
'
```

The ABI in `src/js/contractDetails.js` carries the selector for every function in its `signature`
field, so no extra tooling is needed to build a call by hand.
