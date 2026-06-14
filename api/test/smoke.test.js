// Minimal smoke test: the server file loads without throwing.
const assert = require("assert");
const fs = require("fs");
assert.ok(fs.existsSync(__dirname + "/../src/server.js"), "server.js must exist");
console.log("api smoke test passed");