const assert = require("assert");
const fs = require("fs");
assert.ok(fs.existsSync(__dirname + "/../src/worker.js"), "worker.js must exist");
console.log("worker smoke test passed");