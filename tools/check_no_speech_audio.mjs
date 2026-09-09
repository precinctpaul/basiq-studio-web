import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const HUB = "C:\\Volumes\\md-pac\\media\\Archive\\Basiq-Studio-Hub";
const SCRATCH = "C:\\Users\\plcon\\AppData\\Local\\Temp\\claude\\C--dev-basiq-studio-web\\da613f49-68dd-48f7-9c45-4b0b2d2c7cbc\\scratchpad";
const names = fs.readFileSync(path.join(SCRATCH, "no-speech-failures.txt"), "utf8").split(/\r?\n/).filter(Boolean);

function probe(file) {
  try {
    const out = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${file}"`, { encoding: "utf8" });
    return parseFloat(out.trim());
  } catch { return null; }
}
function volume(file, seconds) {
  try {
    const out = execSync(`ffmpeg -i "${file}" -t ${seconds} -vn -af volumedetect -f null - 2>&1`, { encoding: "utf8" });
    const mean = out.match(/mean_volume:\s*(-?\d+\.?\d*)/);
    const max = out.match(/max_volume:\s*(-?\d+\.?\d*)/);
    return { mean: mean ? parseFloat(mean[1]) : null, max: max ? parseFloat(max[1]) : null };
  } catch { return { mean: null, max: null }; }
}

const results = [];
let done = 0;
for (const name of names) {
  const file = path.join(HUB, name);
  done++;
  if (!fs.existsSync(file)) { results.push({ name, status: "missing-file" }); continue; }
  const dur = probe(file);
  const window = dur && dur < 60 ? dur : 60;
  const vol = volume(file, window);
  const isSilent = vol.mean !== null && vol.mean <= -60;
  results.push({ name, duration: dur, mean_volume: vol.mean, max_volume: vol.max, classification: isSilent ? "silent" : "has-real-audio" });
  if (done % 10 === 0) console.log(`${done}/${names.length} checked...`);
}

const silent = results.filter(r => r.classification === "silent");
const real = results.filter(r => r.classification === "has-real-audio");
const missing = results.filter(r => r.status === "missing-file");
console.log(`\nTotal: ${results.length}`);
console.log(`Silent (nothing to transcribe): ${silent.length}`);
console.log(`Has real audio (genuine bug): ${real.length}`);
console.log(`Missing file: ${missing.length}`);

fs.writeFileSync(path.join(SCRATCH, "no-speech-catalog.json"), JSON.stringify(results, null, 2));
console.log("\nFull catalog written to no-speech-catalog.json");
