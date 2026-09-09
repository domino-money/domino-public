const fs = require('node:fs');
const solc = require('solc');
if (process.argv.includes('--version')) {
  process.stdout.write(`solc, the solidity compiler commandline interface\nVersion: ${solc.version()}\n`);
} else {
  process.stdout.write(solc.compile(fs.readFileSync(0, 'utf8')));
}
