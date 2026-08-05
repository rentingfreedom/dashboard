console.log("start", Date.now());
const { createRequire } = await import("module");
const require = createRequire(import.meta.url);
console.log("before require googleapis", Date.now());
const { google } = require("googleapis");
console.log("after require googleapis", Date.now());
const { GoogleAuth } = require("google-auth-library");
console.log("after require google-auth-library", Date.now());
