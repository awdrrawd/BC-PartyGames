import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const sourceFiles = [
  "src/core.js",
  "src/transport.js",
  "src/controller.js",
  "src/ui.js",
  "Translation/PartyGames-i18n.js",
  "src/app.js",
];
const metadata = fs.readFileSync(path.join(root, "userscript.meta.js"), "utf8").trim();
const source = sourceFiles.map(file => {
  const code = fs.readFileSync(path.join(root, file), "utf8").trim();
  return `\n\n// ---- ${file} ----\n${code}`;
}).join("");
const bundle = `${metadata}\n\n${source}\n`;

new vm.Script(bundle, { filename: "BC-PartyGames.user.js" });

if (!process.argv.includes("--check")) {
  const output = path.join(root, "dist", "BC-PartyGames.user.js");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, bundle, "utf8");
  console.log(`Built ${path.relative(root, output)}`);
} else {
  console.log("Bundle syntax OK");
}
