import fs from "node:fs";
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const webKeys = new Set(data.web.map(r => r.k));
const guiKeys = new Set(data.gui.map(r => r.k));
const out = [];
for (const r of data.web) {
  const g = data.gui.find(x => x.k === r.k);
  const sameZh = g && g.zh === r.zh;
  const sameEn = g && g.en === r.en;
  out.push(r.k + " | zh:" + (g ? (sameZh ? "same" : "DIFF") : "gui-missing") + " | en:" + (g ? (sameEn ? "same" : "DIFF") : "gui-missing"));
}
console.log(out.join("\n"));