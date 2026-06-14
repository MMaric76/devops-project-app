const assert = require("assert");
const fs = require("fs");
assert.ok(fs.existsSync(__dirname + "/../src/server.js"), "server.js must exist");
console.log("frontend smoke test passed");