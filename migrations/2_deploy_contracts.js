var KYC = artifacts.require("./kyc.sol");

module.exports = function(deployer) {
  deployer.deploy(KYC);
};