/* global artifacts, contract, web3, assert */
//
// Two kinds of tests live here:
//
//   1. "intended behaviour": what the contract is supposed to do, so a
//      change that breaks a working flow is caught;
//   2. "SECURITY.md findings, reproduced": each finding in SECURITY.md
//      demonstrated on a real chain. These assert the *current, flawed*
//      behaviour on purpose. When a finding is fixed, its test should fail;
//      rewrite it to assert the fix.
//
// Most functions are declared `payable returns (...)` rather than `view`,
// so `fn.call(...)` reads the return code without a transaction and
// `fn(...)` sends the transaction that changes state.

const KYC = artifacts.require('kyc');

const NOT_A_BANK = '7';

async function reverts(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail('expected the transaction to revert');
}

contract('kyc', (accounts) => {
  const [bank1, bank2, outsider, customerWallet] = accounts;
  let kyc;

  beforeEach(async () => {
    kyc = await KYC.new();
    await kyc.addBank('First Bank', bank1, 'REG-001', { from: bank1 });
  });

  describe('intended behaviour', () => {
    it('lets the first bank bootstrap the network, then only members add banks', async () => {
      assert.isTrue(await kyc.isPartOfOrg.call({ from: bank1 }));

      assert.equal((await kyc.addBank.call('Second Bank', bank2, 'REG-002', { from: outsider })).toString(), NOT_A_BANK);
      await kyc.addBank('Second Bank', bank2, 'REG-002', { from: outsider });
      assert.isFalse(await kyc.isPartOfOrg.call({ from: bank2 }));

      assert.equal((await kyc.addBank.call('Second Bank', bank2, 'REG-002', { from: bank1 })).toString(), '0');
      await kyc.addBank('Second Bank', bank2, 'REG-002', { from: bank1 });
      assert.isTrue(await kyc.isPartOfOrg.call({ from: bank2 }));
      assert.equal(await kyc.getBankName.call(bank2), 'Second Bank');
      assert.equal(await kyc.getBankReg.call(bank2), 'REG-002');
      assert.equal(await kyc.getBankEth.call('Second Bank'), bank2);
    });

    it('lets member banks add, view and update customers; others are refused', async () => {
      assert.equal((await kyc.addCustomer.call('alice', 'record-v1', { from: outsider })).toString(), NOT_A_BANK);

      assert.equal((await kyc.addCustomer.call('alice', 'record-v1', { from: bank1 })).toString(), '0');
      await kyc.addCustomer('alice', 'record-v1', { from: bank1 });
      assert.equal((await kyc.addCustomer.call('alice', 'other', { from: bank1 })).toString(), '2', 'duplicate');

      assert.equal(await kyc.viewCustomer.call('alice', { from: bank1 }), 'record-v1');
      assert.equal(await kyc.viewCustomer.call('alice', { from: outsider }), 'Access denied!');
      assert.equal(await kyc.viewCustomer.call('bob', { from: bank1 }), 'Customer not found in database!');

      await kyc.modifyCustomer('alice', 'record-v2', { from: bank1 });
      assert.equal(await kyc.viewCustomer.call('alice', { from: bank1 }), 'record-v2');
      assert.equal((await kyc.modifyCustomer.call('bob', 'x', { from: bank1 })).toString(), '1', 'unknown customer');
      assert.equal(await kyc.getCustomerBankName.call('alice'), 'First Bank');
    });

    it('rewards a bank for each verified customer', async () => {
      assert.equal((await kyc.getBankRating.call(bank1)).toString(), '200');
      await kyc.addCustomer('alice', 'record', { from: bank1 });
      assert.equal((await kyc.getBankKYC.call(bank1)).toString(), '1');
      assert.equal((await kyc.getBankRating.call(bank1)).toString(), '300', '200 + 100/1');
      await kyc.addCustomer('bob', 'record', { from: bank1 });
      assert.equal((await kyc.getBankRating.call(bank1)).toString(), '350', '300 + 100/2');
      assert.equal((await kyc.getCustomerRating.call('alice')).toString(), '100');
    });

    it('records a bank access request once, and the grant', async () => {
      await kyc.addCustomer('alice', 'record', { from: bank1 });
      await kyc.addRequest('alice', bank2, { from: bank2 });
      await kyc.addRequest('alice', bank2, { from: bank2 }); // idempotent
      assert.equal(await kyc.getBankRequests.call('alice', 0), bank2);
      await reverts(kyc.getBankRequests.call('alice', 1)); // only one request was stored

      assert.isFalse(await kyc.ifAllowed.call('alice', bank2));
      await kyc.allowBank('alice', bank2, true, { from: customerWallet });
      assert.isTrue(await kyc.ifAllowed.call('alice', bank2));
    });

    it('signs banks in by name and address, customers by a one-time-set password', async () => {
      assert.equal(await kyc.checkBank.call('First Bank', bank1), '0');
      assert.equal(await kyc.checkBank.call('First Bank', bank2), 'null');

      await kyc.addCustomer('alice', 'record', { from: bank1 });
      assert.isTrue(await kyc.setPassword.call('alice', 's3cret', { from: customerWallet }));
      await kyc.setPassword('alice', 's3cret', { from: customerWallet });
      assert.isFalse(await kyc.setPassword.call('alice', 'again', { from: customerWallet }), 'only once');
      assert.isTrue(await kyc.checkCustomer.call('alice', 's3cret'));
      assert.isFalse(await kyc.checkCustomer.call('alice', 'wrong'));
    });
  });

  describe('SECURITY.md findings, reproduced', () => {
    // Storage layout: slot 0 is the allCustomers array. Element i starts at
    // keccak256(0) + 6*i; the Customer struct occupies six slots
    // (uname, dataHash, rating, upvotes, bank, password). Strings shorter
    // than 32 bytes are stored inline: data left-aligned, length*2 in the
    // last byte.
    const customerSlot = (index, field) => {
      const base = BigInt(web3.utils.soliditySha3({ t: 'uint256', v: 0 }));
      return '0x' + (base + BigInt(6 * index + field)).toString(16);
    };
    const readShortString = async (address, slot) => {
      const word = await web3.eth.getStorageAt(address, slot);
      const hex = word.replace(/^0x/, '').padStart(64, '0');
      const len = parseInt(hex.slice(62, 64), 16) / 2;
      return Buffer.from(hex.slice(0, len * 2), 'hex').toString('utf8');
    };

    it('#1 personal data is readable by anyone, despite "Access denied!"', async () => {
      await kyc.addCustomer('alice', 'Alice|1990-01-01|Pune', { from: bank1 });
      assert.equal(await kyc.viewCustomer.call('alice', { from: outsider }), 'Access denied!');
      // ...but the outsider just reads the storage slot instead:
      assert.equal(await readShortString(kyc.address, customerSlot(0, 1)), 'Alice|1990-01-01|Pune');
    });

    it('#2 customer passwords are readable from storage, and anyone can set the first one', async () => {
      await kyc.addCustomer('alice', 'record', { from: bank1 });
      await kyc.setPassword('alice', 'hunter2', { from: customerWallet });
      assert.equal(await readShortString(kyc.address, customerSlot(0, 5)), 'hunter2');

      // A fresh customer whose password is still unset can be claimed by a stranger first.
      await kyc.addCustomer('bob', 'record', { from: bank1 });
      await kyc.setPassword('bob', 'stolen', { from: outsider });
      assert.isTrue(await kyc.checkCustomer.call('bob', 'stolen'));
    });

    it('#3 consent is not enforced: a bank with no grant can still read the record', async () => {
      await kyc.addBank('Second Bank', bank2, 'REG-002', { from: bank1 });
      await kyc.addCustomer('alice', 'record', { from: bank1 });
      assert.isFalse(await kyc.ifAllowed.call('alice', bank2));
      assert.equal(await kyc.viewCustomer.call('alice', { from: bank2 }), 'record');
    });

    it('#4 anyone can grant a bank access to anyone\'s record', async () => {
      await kyc.addCustomer('alice', 'record', { from: bank1 });
      await kyc.addRequest('alice', bank2, { from: bank2 });
      await kyc.allowBank('alice', bank2, true, { from: outsider });
      assert.isTrue(await kyc.ifAllowed.call('alice', bank2));
    });

    it('#5 any member bank can overwrite another bank\'s customer', async () => {
      await kyc.addBank('Second Bank', bank2, 'REG-002', { from: bank1 });
      await kyc.addCustomer('alice', 'genuine', { from: bank1 });
      await kyc.modifyCustomer('alice', 'tampered', { from: bank2 });
      assert.equal(await kyc.viewCustomer.call('alice', { from: bank1 }), 'tampered');
      assert.equal(await kyc.getCustomerBankName.call('alice'), 'Second Bank');
    });

    it('#6 anyone can change any rating', async () => {
      const before = (await kyc.getBankRating.call(bank1)).toNumber();
      await kyc.updateRating(bank1, true, { from: outsider });
      assert.isAbove((await kyc.getBankRating.call(bank1)).toNumber(), before);

      await kyc.addCustomer('alice', 'record', { from: bank1 });
      await kyc.updateRatingCustomer('alice', true, { from: outsider });
      assert.isAbove((await kyc.getCustomerRating.call('alice')).toNumber(), 100);
    });

    it('#7 a bank\'s "password" is its public address', async () => {
      // Anyone who knows the bank's name and on-chain address (both public) passes the check.
      assert.equal(await kyc.checkBank.call('First Bank', bank1, { from: outsider }), '0');
    });

    it('#8a removing the first of several banks underflows i - 1 and reverts', async () => {
      await kyc.addBank('Second Bank', bank2, 'REG-002', { from: bank1 });
      await reverts(kyc.removeBank(bank1, { from: bank1 }));
      assert.isTrue(await kyc.isPartOfOrg.call({ from: bank1 }), 'still a member');
    });

    it('#8b removing a middle customer deletes the wrong records', async () => {
      for (const name of ['alice', 'bob', 'carol']) {
        await kyc.addCustomer(name, `${name}-record`, { from: bank1 });
      }
      assert.equal((await kyc.removeCustomer.call('bob', { from: bank1 })).toString(), '0', 'reports success');
      await kyc.removeCustomer('bob', { from: bank1 });
      // The loop copies bob over alice, then the pop drops carol:
      // the customer that was "removed" survives and two others are gone.
      assert.equal(await kyc.viewCustomer.call('bob', { from: bank1 }), 'bob-record');
      assert.equal(await kyc.viewCustomer.call('alice', { from: bank1 }), 'Customer not found in database!');
      assert.equal(await kyc.viewCustomer.call('carol', { from: bank1 }), 'Customer not found in database!');
    });

    it('#8c refusing the only pending request computes length - 2 and runs out of gas', async () => {
      await kyc.addCustomer('alice', 'record', { from: bank1 });
      await kyc.addRequest('alice', bank2, { from: bank2 });
      await reverts(kyc.allowBank('alice', bank2, false, { from: customerWallet, gas: 3000000 }));
    });

    it('#9a a bank rating wraps around below zero', async () => {
      // With no verified customers each downvote subtracts 100 / (0 + 1):
      // 200 -> 100 -> 0 -> 2^256 - 100. The `rating < 0` guard can never fire.
      for (let i = 0; i < 3; i++) await kyc.updateRating(bank1, false, { from: outsider });
      const rating = BigInt((await kyc.getBankRating.call(bank1)).toString());
      assert.equal(rating, 2n ** 256n - 100n);
    });

    it('#9b a customer downvote at zero upvotes divides by zero and reverts', async () => {
      // upvotes-- wraps to 2^256 - 1, so the divisor upvotes + 1 wraps to 0.
      await kyc.addCustomer('alice', 'record', { from: bank1 });
      await reverts(kyc.updateRatingCustomer('alice', false, { from: bank1 }));
    });

    it('#11 consent cannot be withdrawn once granted', async () => {
      await kyc.addCustomer('alice', 'record', { from: bank1 });
      await kyc.addRequest('alice', bank2, { from: bank2 });
      await kyc.allowBank('alice', bank2, true, { from: customerWallet });
      await reverts(kyc.allowBank('alice', bank2, false, { from: customerWallet, gas: 3000000 }));
      assert.isTrue(await kyc.ifAllowed.call('alice', bank2));
    });

    it('#13 state changes emit no events, so there is no audit trail', async () => {
      const receipt = await kyc.addCustomer('alice', 'record', { from: bank1 });
      assert.lengthOf(receipt.receipt.rawLogs, 0);
    });
  });
});
