/* eslint-disable @typescript-eslint/no-require-imports -- loaded with `tsx --require`, so it has to be CommonJS. */
// Local scripts (the worker) run outside Next, where `server-only` always throws. They are server code, so let it resolve to nothing.
const Module = require("module");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only") return require.resolve("./empty.cjs");
  return resolve.call(this, request, ...rest);
};
