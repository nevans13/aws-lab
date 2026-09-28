const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

exports.handler = async () => ({
  statusCode: 200,
  headers: { "Content-Type": "text/html" },
  body: html
});