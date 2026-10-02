const fs = require('node:fs');
const solc = require('solc');
// The Emscripten module solc wraps (Node's cache hands back the same instance).
const soljson = require('solc/soljson.js');

// solc.compile() passes the input to solidity_compile through cwrap's 'string'
// argument, which reserves 4 bytes per character on the 5 MiB wasm stack and
// leaves the compiler the rest: from about 1.3M characters the stack overruns
// into static memory and solc crashes or reads a corrupted input. Copy the
// input into the heap and call the same export instead. There is no import
// callback: Forge sends every source in the standard JSON. Like solc-js, read
// the output, then release it with solidity_reset.
function compile(input) {
  const size = soljson.lengthBytesUTF8(input) + 1;
  const pointer = soljson._malloc(size);
  if (!pointer) throw new Error(`solc input allocation of ${size} bytes failed`);
  try {
    soljson.stringToUTF8(input, pointer, size);
    return soljson.UTF8ToString(soljson._solidity_compile(pointer, 0, 0));
  } finally {
    soljson._solidity_reset();
    soljson._free(pointer);
  }
}

if (process.argv.includes('--version')) {
  process.stdout.write(`solc, the solidity compiler commandline interface\nVersion: ${solc.version()}\n`);
} else {
  process.stdout.write(compile(fs.readFileSync(0, 'utf8')));
}
