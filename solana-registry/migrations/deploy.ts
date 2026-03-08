// Migrations are an early feature. Currently, they're nothing more than this
// temporary script that executes the deploy command with the Anchor CLI.
const anchor = require("@coral-xyz/anchor");

module.exports = async function (provider: any) {
  anchor.setProvider(provider);
};
