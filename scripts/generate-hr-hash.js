#!/usr/bin/env node
// scripts/generate-hr-hash.js
// Run:  node scripts/generate-hr-hash.js
// Then copy the output into HR_PASSWORD_HASH in your .env

const bcrypt   = require('bcryptjs');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('Enter HR password to hash: ', async (password) => {
  if (!password || password.length < 8) {
    console.error('❌  Password must be at least 8 characters.');
    process.exit(1);
  }
  const hash = bcrypt.hashSync(password, 12);
  console.log('\n✅  Add this to your .env:\n');
  console.log(`HR_PASSWORD_HASH=${hash}`);
  console.log('\n⚠️  Never commit this .env file to git.\n');
  rl.close();
});
