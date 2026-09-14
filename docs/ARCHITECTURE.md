# Architecture

High-level design (HLD) and low-level design (LLD) for the decentralised KYC platform.

The [README](../README.md) explains what the project does and how to run it. This document
explains **how it is built and why**, and is honest about the parts that would be built
differently today — those are collected in [`SECURITY.md`](../SECURITY.md) and section
[3.2](#32-what-a-rewrite-would-change). Every diagram is Mermaid, so it renders on GitHub.

---

## Table of contents

**Part 1 — High-level design**

1. [The problem this solves](#11-the-problem-this-solves)
2. [System context](#12-system-context)
3. [Container view](#13-container-view)
4. [On-chain data model](#14-on-chain-data-model)
5. [Runtime and deployment](#15-runtime-and-deployment)
6. [Design decisions](#16-design-decisions)
7. [Trust model](#17-trust-model)

**Part 2 — Low-level design**

8. [Page map and navigation](#21-page-map-and-navigation)
9. [Sequence — a bank joins the network](#22-sequence--a-bank-joins-the-network)
10. [Sequence — creating a KYC record](#23-sequence--creating-a-kyc-record)
11. [Sequence — consent, the core of the design](#24-sequence--consent-the-core-of-the-design)
12. [State machine — an access request](#25-state-machine--an-access-request)
13. [How a record is encoded](#26-how-a-record-is-encoded)
14. [The rating algorithm](#27-the-rating-algorithm)
15. [Storage layout and cost](#28-storage-layout-and-cost)
16. [Return codes](#29-return-codes)

**Part 3 — Cross-cutting**

17. [The local environment](#31-the-local-environment)
18. [What a rewrite would change](#32-what-a-rewrite-would-change)
19. [Roadmap](#33-roadmap)

---

# Part 1 — High-level design

## 1.1 The problem this solves

KYC — Know Your Customer — is the identity check a regulated business runs before it takes you on
as a customer. Today every institution runs it separately: you hand the same passport, the same
proof of address and the same income statement to each bank in turn, each one stores its own copy,
and none of them can tell that the other four already verified you.

That is expensive for the institutions and miserable for the customer, and it creates a second
problem in any open marketplace: **one person can present as many people**. This project began as
the identity layer for a peer-to-peer lending platform, where a single anonymous actor creating
twenty borrower accounts would have broken the credit model entirely. Verifying identity once, on a
shared ledger that every participant can read, is what closes that hole.

The design here is **semi-decentralised on purpose**:

| Concern | Where it lives | Why |
|---|---|---|
| Who has been verified, by whom, and when | On-chain | It must be shared, tamper-evident and independently auditable |
| Which bank may read which customer's file | On-chain | Consent is the whole point — it has to be enforced, not promised |
| Reputation of banks and customers | On-chain | Derived from verifiable events, and readable by every participant |
| The KYC document contents | Off-chain in the roadmap, on-chain in this build | Personal data on a public ledger is permanent and world-readable — see [SECURITY.md](../SECURITY.md) |

## 1.2 System context

```mermaid
flowchart TB
    Customer["Customer<br/><i>owns the record, grants and denies access</i>"]
    Bank["Bank or financial institution<br/><i>verifies identity, reads with consent</i>"]

    subgraph System["Decentralised KYC platform"]
        Portal["Two browser portals<br/>bank · customer"]
        Contract["kyc.sol<br/><i>the only source of truth</i>"]
    end

    Chain[("Ethereum network<br/><i>Ganache locally</i>")]
    Wallet["Ethereum accounts<br/><i>Ganache keys, MetaMask in the roadmap</i>"]

    Customer -->|"registers a password, allows or denies banks"| Portal
    Bank -->|"registers, creates and reads records"| Portal
    Portal -->|"web3 JSON-RPC"| Contract
    Contract --> Chain
    Bank -.->|"signs transactions"| Wallet
    Wallet -.-> Chain
```

**What is trusted.** The chain is the authority: no server, no database, and no administrator sits
between the two portals. Both portals are static files; deleting them changes nothing about the
data. Anyone can write their own client against the same contract address.

**What is not.** Anything the browser holds — the pages, `localStorage`, the account it uses — is
under the user's control and cannot be trusted by the contract. Section [1.7](#17-trust-model)
covers where this build takes that seriously and where it does not.

## 1.3 Container view

```mermaid
flowchart LR
    subgraph Browser["Browser — static pages, no build step"]
        direction TB
        BankUI["Bank portal<br/>index.html → bankHomePage.html<br/>addForm · viewForm · modifyForm"]
        CustUI["Customer portal<br/>indexCustomer.html → customerHomePage.html"]
        Details["contractDetails.js<br/><i>ABI · bytecode · address · form field ids</i>"]
        Web3["web3.js 0.20<br/><i>synchronous JSON-RPC</i>"]
        Store["localStorage<br/><i>which account, which record</i>"]
    end

    subgraph Node["Ethereum node — Ganache on :8545"]
        RPC["JSON-RPC<br/>eth_call · eth_sendTransaction"]
        EVM["EVM"]
        Storage[("Contract storage<br/>allOrgs · allCustomers · allRequests")]
    end

    Tools["Truffle<br/><i>compile · migrate</i>"]

    BankUI --> Web3
    CustUI --> Web3
    BankUI -.-> Store
    CustUI -.-> Store
    Details --> Web3
    Web3 -->|HTTP| RPC --> EVM --> Storage
    Tools -->|"deploys kyc.sol"| EVM
    Tools -.->|"build artefact feeds<br/>npm run sync"| Details
```

There is no server tier at all. `scripts/serve.js` exists only because browsers refuse to make
XHR calls from a `file://` origin — it serves static files and nothing else. Every read and every
write in the diagram above ends at the contract.

## 1.4 On-chain data model

Three dynamic arrays in contract storage. No mappings — which matters, and section
[2.8](#28-storage-layout-and-cost) explains why.

```mermaid
classDiagram
    class Customer {
        +string uname «primary key, unique»
        +string dataHash «the delimited KYC record»
        +uint rating «100 at creation, capped at 500»
        +uint upvotes
        +address bank «the institution that last wrote it»
        +string password «"null" until the customer claims it»
    }
    class Organisation {
        +string name
        +address ethAddress «the institution's identity»
        +uint rating «200 at creation, capped at 500»
        +uint KYC_count
        +string regNumber
    }
    class Request {
        +string uname «the customer being asked»
        +address bankAddress «the institution asking»
        +bool isAllowed «false until the customer says yes»
    }
    class kyc {
        -Customer[] allCustomers
        -Organisation[] allOrgs
        -Request[] allRequests
    }
    kyc "1" *-- "*" Customer
    kyc "1" *-- "*" Organisation
    kyc "1" *-- "*" Request
    Customer --> Organisation : "verified by (address)"
    Request --> Customer : "asks about (uname)"
    Request --> Organisation : "asked by (address)"
```

Two things worth noticing. **Customers are keyed by a username string, not by an Ethereum address** —
a customer does not need a wallet to have a KYC record, which is deliberate, since the bank creates
the record before the customer ever logs in. And **`Request` is a join row**: one per
(customer, bank) pair, carrying the consent flag.

## 1.5 Runtime and deployment

Everything runs on one machine. There is no hosted deployment, and for a project that writes
personal data to a ledger, that is the right default.

```mermaid
flowchart LR
    Dev["Developer"]
    subgraph Local["localhost"]
        G["Ganache :8545<br/><i>npm run chain</i><br/>10 funded accounts, deterministic"]
        T["Truffle<br/><i>npm run deploy</i>"]
        S["Static server :8080<br/><i>npm run serve</i>"]
    end
    B["Browser"]
    A["src/js/contractDetails.js"]

    Dev --> T
    T -->|"1 compile with solc 0.5.0"| T
    T -->|"2 migrate → new contract address"| G
    T -->|"3 npm run sync writes the address"| A
    Dev --> S
    B -->|"loads pages"| S
    B -->|"reads the address + ABI"| A
    B -->|"JSON-RPC"| G
```

Step 3 is the one that used to bite. Every `truffle migrate` deploys a **new** contract at a **new**
address, and the front end reads a hard-coded address. Before `scripts/sync-contract.js` existed,
that address had to be pasted in by hand, and forgetting meant the pages loaded perfectly but every
call came back empty. `npm run deploy` now does the migrate and the sync together.

## 1.6 Design decisions

| # | Decision | Alternatives | Why it was made — and how it holds up |
|---|---|---|---|
| 1 | **Store consent on-chain** rather than in an institution's access-control list | A permissioned database at each bank | The strongest idea in the project. A customer can prove who was allowed to see their file, and no bank can quietly grant itself access. This is what makes it a DApp rather than a website with a blockchain bolted on. |
| 2 | **Key customers by username**, not by wallet address | One record per Ethereum address | Lets a bank create a record for someone who has no wallet yet, which is how onboarding actually works. The cost is that usernames are a global namespace with no ownership proof until the customer claims one. |
| 3 | **Dynamic arrays**, not mappings | `mapping(string => Customer)` | Arrays can be enumerated, which the request queue needs. But every lookup is a linear scan with a string comparison, so gas grows with the size of the network — see [2.8](#28-storage-layout-and-cost). A mapping plus an index array would give both. |
| 4 | **Return codes instead of `revert`** | `require` with a reason string | Lets the front end call a function first, read the code, and only then send a transaction, which avoids paying for a doomed write. It also means a failed call looks identical to a successful one on chain, and nothing is logged. Events would fix that. |
| 5 | **Ganache and a local chain**, not a public testnet | Sepolia via Infura | Free, instant, and resettable. It also keeps a build that writes plaintext personal data off a public network, which is the responsible choice for this code. |
| 6 | **Plain HTML, jQuery and web3 0.20** | React plus ethers.js | Nothing to build, nothing to install, and the whole client is readable in an afternoon. web3 0.20's synchronous calls are what make the page scripts so short — and are also deprecated, because they block the UI thread. |
| 7 | **A rating for banks as well as customers** | Rate customers only | A bank that adds records that later turn out fraudulent loses rating, so reputation cuts both ways. Nice idea, undercut by the fact that any registered bank can call the rating functions on anyone. |

## 1.7 Trust model

Who is allowed to do what, as the contract actually enforces it:

| Action | Enforced by | Holds up? |
|---|---|---|
| Register the first bank | Nothing — the network starts empty and the first caller wins | Intended: someone has to bootstrap |
| Register a further bank | `isPartOfOrg(msg.sender)` — an existing member must send the transaction | Yes |
| Create, modify or delete a customer record | `isPartOfOrg(msg.sender)` | Yes for *whether you are a bank*; no for *which* bank — any member can overwrite any record |
| Read a customer record | `isPartOfOrg(msg.sender)` | **Only in the UI.** `viewCustomer` gates on membership, not on consent; the consent check `ifAllowed` is called by the page, not by the contract |
| Grant or revoke consent | Nothing | **No check at all** — `allowBank` accepts a username from any caller |
| Change a rating | Nothing on `updateRatingCustomer` | Any address can move any customer's rating |

The last three rows are the honest answer to "is this production-ready", and they are written up with
fixes in [`SECURITY.md`](../SECURITY.md). They are also exactly the kind of finding that makes this
project worth reading: the *architecture* is sound, the *enforcement* is in the wrong layer.

---

# Part 2 — Low-level design

## 2.1 Page map and navigation

Seven static pages, no router and no framework. State moves between pages through `localStorage`.

```mermaid
flowchart TB
    subgraph BankSide["Bank portal"]
        I["index.html<br/><i>register · sign in</i>"]
        BH["resources/bankHomePage.html<br/><i>dashboard and actions</i>"]
        AF["resources/form/addForm.html<br/><i>create a record</i>"]
        VF["resources/form/viewForm.html<br/><i>read a record</i>"]
        MF["resources/form/modifyForm.html<br/><i>update or delete</i>"]
    end
    subgraph CustSide["Customer portal"]
        IC["indexCustomer.html<br/><i>claim account · sign in</i>"]
        CH["customerHomePage.html<br/><i>own record · consent queue</i>"]
    end

    I -->|"sets bank_eth_account"| BH
    BH --> AF
    BH -->|"sets user_name_v"| VF
    BH -->|"sets user_name_m"| MF
    AF --> BH
    VF --> BH
    MF --> BH
    IC -->|"sets username_c, password_c"| CH

    LS[("localStorage<br/>bank_eth_account · username_c<br/>password_c · user_name_v · user_name_m")]
    BH -.-> LS
    CH -.-> LS
```

`localStorage` is doing the job a session would do on a server — and it is doing it in the clear, in
a place the user can edit. Setting `bank_eth_account` by hand in the console is enough to reach the
bank dashboard, because the dashboard never re-checks. The contract still refuses writes from an
address that is not a registered bank, so this is a UI bypass rather than a data breach — but it
should be a signed challenge, not a string in web storage.

## 2.2 Sequence — a bank joins the network

```mermaid
sequenceDiagram
    autonumber
    actor B as Bank staff
    participant P as index.html
    participant W as web3 0.20
    participant C as kyc.sol
    participant S as Contract storage

    B->>P: Register — name, Ethereum address, registration number
    P->>P: confirm "I accept that the details provided are correct"
    P->>W: addBank(name, address, regNumber)
    W->>C: eth_sendTransaction from accounts[0]
    alt allOrgs is empty
        Note over C: first bank bootstraps the network
        C->>S: push Organisation(name, eth, rating 200, count 0, regNumber)
        C-->>W: 0
    else caller is already a member
        C->>S: push Organisation(...)
        C-->>W: 0
    else caller is a stranger
        C-->>W: 7 — access denied
        Note over P,W: the page does not read this return value,<br/>so it reports success either way
    end

    B->>P: Sign in — name plus the same address
    P->>W: checkBank(name, address) as a call
    W->>C: eth_call
    C-->>P: "0" on match, "null" otherwise
    P->>P: localStorage.bank_eth_account = address
    P-->>B: redirect to the dashboard
```

Two things this diagram makes plain. The field labelled **"password" is an Ethereum address** — the
contract's parameter is `address password`, and sign-in succeeds for anyone who can type the bank's
public address, which is on the ledger by definition. And the page ignores `addBank`'s return code,
so a rejected registration still shows "successfully added to the network".

## 2.3 Sequence — creating a KYC record

```mermaid
sequenceDiagram
    autonumber
    actor B as Bank
    participant F as addForm.js
    participant C as kyc.sol
    participant S as Contract storage

    B->>F: fills 13 fields and submits
    F->>F: getInfo() joins the fields with "!@#"
    F->>C: addCustomer(username, record) as a CALL
    Note over F,C: dry run first — read the return code<br/>without paying for a write
    alt returns 7
        C-->>F: not a registered bank
        F-->>B: "Access denied!"
    else returns 2
        C-->>F: username already taken
        F-->>B: "Customer already in database!"
    else returns 0
        F->>C: addCustomer(...) as a TRANSACTION
        C->>S: push Customer(uname, record, rating 100, upvotes 0, bank msg.sender, password "null")
        C->>C: updateRating(msg.sender, true)
        C->>S: bank KYC_count + 1, rating + 100/KYC_count
        C-->>F: mined
        F-->>B: "Customer profile successfully created!"
    end
```

The call-then-transact pattern in steps 3 and 8 is the workaround for return codes: the call is free
and tells you what would happen, the transaction then does it. It costs a round trip and it is racy —
nothing stops the state changing between the two — but on a single-user local chain it works, and it
is a reasonable answer to a contract that signals failure by returning a number.

## 2.4 Sequence — consent, the core of the design

This is the flow the whole project exists for.

```mermaid
sequenceDiagram
    autonumber
    actor B as Bank
    participant BH as bankHomePage.js
    participant C as kyc.sol
    actor Cu as Customer
    participant CH as customerHomePage.js

    B->>BH: View KYC for "anita.rao"
    BH->>C: viewCustomer(uname) — does the record exist?
    C-->>BH: the record, or "Customer not found in database!"
    BH->>C: ifAllowed(uname, bankAddress)
    C-->>BH: false
    BH-->>B: "Access denied! Take permission from the customer to proceed"
    B->>BH: confirms
    BH->>C: addRequest(uname, bankAddress) — transaction
    C->>C: skip if this pair already exists
    C->>C: push Request(uname, bank, isAllowed false)

    Note over Cu,CH: later, on the customer's own device

    Cu->>CH: opens "View Requests"
    loop until the contract reverts past the end of the array
        CH->>C: getBankRequests(uname, i)
        C-->>CH: the requesting bank's address, or a sentinel
        CH->>C: getBankName(address)
        C-->>CH: "Meridian Bank"
        CH->>CH: document.write an Allow / Deny row
    end
    Cu->>CH: clicks Allow
    CH->>C: allowBank(uname, bankAddress, true) — transaction
    C->>C: isAllowed = true

    B->>BH: View KYC again
    BH->>C: ifAllowed(uname, bankAddress)
    C-->>BH: true
    BH-->>B: opens viewForm.html with the full record
```

**The loop in steps 12 to 17 has no termination condition.** `getBankRequests` indexes
`allRequests[ind]` directly, so once `i` runs past the end the EVM raises an invalid-opcode
exception; web3's synchronous call turns that into a JavaScript throw, which unwinds the loop. The
list renders correctly and the browser console shows an uncaught exception every time. It works by
accident, and a `getRequestCount()` view would make it work on purpose.

**And the consent check lives in the wrong place.** `ifAllowed` is consulted by `bankHomePage.js`
before it navigates. `viewCustomer` itself only checks membership. A bank that calls the contract
directly — with `curl`, or Remix, or thirty lines of ethers — reads any record it likes without ever
asking. Moving the `ifAllowed` check inside `viewCustomer` is a four-line change and is the single
most important fix in [`SECURITY.md`](../SECURITY.md).

## 2.5 State machine — an access request

```mermaid
stateDiagram-v2
    [*] --> None : no row in allRequests
    None --> Pending : addRequest(uname, bank)
    Pending --> Pending : addRequest again — deduplicated, no second row
    Pending --> Granted : allowBank(uname, bank, true)
    Pending --> Removed : allowBank(uname, bank, false)
    Granted --> Granted : allowBank(uname, bank, true) again
    Removed --> [*]

    note right of Granted
        ifAllowed() now returns true.
        There is no path back —
        consent cannot be withdrawn.
    end note
    note right of Removed
        The deny branch shifts the array
        with a loop that copies the same
        element repeatedly, so it can
        corrupt neighbouring rows.
    end note
```

Two gaps fall straight out of drawing it: **consent is permanent once given** — there is no
`revokeBank` — and the deny path's array-shift loop is wrong (`allRequests[i] = allRequests[i+1]`
inside a loop over `j`, which never advances `i`). Both are listed with fixes in `SECURITY.md`.

## 2.6 How a record is encoded

The contract stores one `string dataHash` per customer. The field name is aspirational — it is not a
hash, it is the record itself, concatenated by the browser.

```mermaid
flowchart LR
    subgraph Form["addForm.html — 13 inputs"]
        F1["username"]
        F2["first · middle · last name"]
        F3["occupation · income · DOB"]
        F4["gender"]
        F5["address · phones · email · country"]
    end
    J["getInfo()<br/><i>join with the literal ! @ #</i>"]
    Blob["anita.rao!@#Anita!@#S!@#Rao!@#Software Engineer!@#…"]
    Chain[("dataHash in contract storage")]
    Split["fillForm()<br/><i>walk the string, split on ! @ #</i>"]
    Labels["allIds[] in contractDetails.js<br/><i>maps position → DOM element id</i>"]

    F1 --> J
    F2 --> J
    F3 --> J
    F4 --> J
    F5 --> J
    J --> Blob --> Chain --> Split --> Labels
```

The consequences are worth stating plainly, because they are a good illustration of why encoding
choices matter:

- **A field containing `!@#` corrupts every field after it.** There is no escaping.
- **Position is the schema.** `allIds` in `contractDetails.js` is the only thing that says index 6 is
  the date of birth. Insert a field in the form and every existing record is misread.
- **Gender is special-cased.** `fillForm()` hard-codes "when `j` reaches 7, write to `gender_m` and
  skip ahead by two", because the form uses two radio ids for one stored value.
- **Everything is public.** `dataHash` is a plain string in contract storage. Anyone with the
  contract address can read every customer's name, date of birth, address, phone numbers, email and
  income band without any permission at all. The roadmap's answer — encrypt, store on IPFS, keep only
  the content hash on chain — is the right one, and the RSA library is already sitting unused in
  `src/RSA_JS/` waiting for it.

## 2.7 The rating algorithm

Both ratings use the same shape: a running score with diminishing returns, held to two decimal
places by storing it multiplied by 100.

```
bank      starts at 200 (2.00 stars)
          +100 / KYC_count on each record added
          −100 / (KYC_count + 1) when one of its records is deleted
          capped at 500

customer  starts at 100 (1.00 stars)
          upvote   → upvotes + 1, rating += 100 / upvotes
          downvote → upvotes − 1, rating −= 100 / (upvotes + 1)
          capped at 500
```

The first record a bank verifies is worth a full star, the second half a star, the tenth a tenth —
so a bank cannot inflate its score cheaply. Three caveats, all of them real:

- `if (rating < 0)` can never be true: `rating` is a `uint`, and in Solidity 0.5 subtracting past
  zero wraps to a colossal number instead of going negative. The guard reads as defensive and does
  nothing.
- `updateRatingCustomer(uname, false)` decrements `upvotes` first. At zero upvotes that also wraps.
- Neither rating function checks the caller, so any address can rate anyone.

## 2.8 Storage layout and cost

Every lookup is a linear scan, and every comparison compares strings byte by byte in the EVM:

```mermaid
flowchart LR
    Call["viewCustomer('anita.rao')"] --> L{"for i in 0..allCustomers.length"}
    L -->|"stringsEqual(allCustomers[i].uname, target)"| Cmp["compare byte by byte<br/><i>one SLOAD per 32 bytes</i>"]
    Cmp -->|"no"| L
    Cmp -->|"yes"| Hit["return dataHash"]
    L -->|"exhausted"| Miss["return 'Customer not found in database!'"]
```

| Operation | Complexity | Consequence |
|---|---|---|
| `viewCustomer`, `modifyCustomer`, `removeCustomer` | O(n) customers × O(len) per comparison | Cost grows with the size of the whole network, not with your record |
| `isPartOfOrg` — runs on nearly every write | O(m) banks | Paid on top of the operation itself |
| `ifAllowed` | O(r) requests, and requests are never pruned | Grows for ever |
| `addCustomer` | O(n) to check for duplicates, then a push | The duplicate check dominates |

On a local chain with three customers this is invisible. On a real network it is the difference
between a working system and one nobody can afford to call. `mapping(string => uint) indexOfCustomer`
alongside the array would make every one of these O(1) while keeping enumeration — it is the first
change a rewrite should make.

Two further notes on the storage functions. `removeCustomer` and `removeBank` both shift with
`allCustomers[i-1] = allCustomers[i]`, which underflows when `i` is 0 and copies in the wrong
direction; deleting a record is not safe. And every function — getters included — is declared
`payable` and non-`view`, which is why the front end has to say `.call()` explicitly everywhere.
Marking the getters `view` would make them free by default and let other contracts read them.

## 2.9 Return codes

The contract signals outcomes by returning a `uint`. Collected in one place, since it is scattered
across the source:

| Code | Meaning | Returned by |
|---|---|---|
| `0` | Success | `addBank`, `removeBank`, `addCustomer`, `removeCustomer`, `modifyCustomer`, `updateRating`, `updateRatingCustomer` |
| `1` | Not found — or, in `addCustomer`, an array-length overflow that cannot occur | `removeBank`, `removeCustomer`, `modifyCustomer`, `updateRating`, `updateRatingCustomer` |
| `2` | Username already in use | `addCustomer` |
| `7` | Caller is not a registered bank | `addBank`, `removeBank`, `addCustomer`, `removeCustomer`, `modifyCustomer` |

String-returning functions use sentinels instead: `"Access denied!"`, `"Customer not found in
database!"`, `"null"`, `"0"` for a successful bank sign-in, and the address
`0x14E041521a40e32ED88b22C0F32469F5406d757A` as a "no such address" marker. Sentinel values that
look like real values are a recurring source of bugs here — the front end compares against these
strings literally, so changing a message breaks the logic.

---

# Part 3 — Cross-cutting

## 3.1 The local environment

Four commands, in this order:

```mermaid
flowchart LR
    A["npm install"] --> B["npm run chain<br/><i>terminal 1 — Ganache on :8545</i>"]
    B --> C["npm run deploy<br/><i>terminal 2 — compile, migrate, sync the address</i>"]
    C --> D["npm run serve<br/><i>terminal 2 — static files on :8080</i>"]
    D --> E["open localhost:8080"]
```

`npm run chain` starts Ganache with `--wallet.deterministic`, so the ten accounts are the same on
every machine and on every restart. That matters more than it sounds: the "password" a bank signs in
with is an Ethereum address, so a stable set of accounts is what makes the walkthrough in the README
reproducible.

Restarting Ganache wipes the chain. Re-run `npm run deploy` afterwards — the contract address
changes, and `npm run sync` is what writes the new one into `src/js/contractDetails.js`.

## 3.2 What a rewrite would change

Keeping the same idea and the same three entities, built today:

| Area | This build | A 2026 build |
|---|---|---|
| Personal data | The full record as a plain string on chain | Encrypt client-side, pin the ciphertext to IPFS, store only the CID on chain |
| Consent enforcement | Checked by the page before navigating | Checked inside `viewCustomer`, so the contract is the gate |
| Identity | Username string plus a plaintext password in storage | The customer's own address; sign a nonce to authenticate, no passwords anywhere |
| Lookups | Linear scans over arrays | `mapping` for lookup, array for enumeration |
| Failure signalling | Magic return codes | `require` with reason strings, plus events for every state change |
| Access control | `isPartOfOrg` repeated inline | OpenZeppelin `AccessControl` with explicit roles |
| Record schema | `!@#`-delimited string | A struct, or JSON pinned off-chain |
| Toolchain | Truffle 5 and web3 0.20 | Hardhat or Foundry, ethers v6, MetaMask via EIP-1193 |
| Tests | None | Property tests around consent and ratings, plus a fuzz run on the rating maths |
| Compiler | 0.5.0, pinned because the code needs it | 0.8.x, where the arithmetic overflows in [2.7](#27-the-rating-algorithm) revert instead of wrapping |

## 3.3 Roadmap

In the order that would add the most value:

1. **Move the consent check into the contract.** One function, four lines, and the security model
   becomes real rather than cosmetic.
2. **Take personal data off the chain.** Encrypt in the browser with the RSA code already sitting in
   `src/RSA_JS/`, pin to IPFS, keep the CID on chain. This was the original plan — the notes the
   project started from say exactly this — and it is the difference between a demo and something
   defensible.
3. **Replace the password with a wallet signature.** MetaMask was always meant to be the customer's
   key; using it removes the plaintext password entirely.
4. **Add `revokeBank`.** Consent that cannot be withdrawn is not really consent.
5. **Emit events** for registration, record changes and consent, so there is an auditable history
   rather than just current state.
6. **Then the lending platform this was built for:** a borrower pool where requests carry amount,
   interest and supporting documents, lenders browse and offer, and the agreement is recorded on
   chain — with the credit score derived from repayment history and this KYC layer keeping one
   person to one identity.
