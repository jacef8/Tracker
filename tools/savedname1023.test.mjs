// 1023: in My Saved, the pin's name is the first (headline) line and its type comes after it.
import fs from 'fs';
const dir = process.argv[2] || 'public';
const s = fs.readFileSync(dir + '/index.html', 'utf8');
const a = s.indexOf(`'<div class="sv-label">'`), b = s.indexOf(`'<div class="sv-cat" style`);
if (a < 0 || b < 0 || a > b) { console.error('FAIL: name must come before type in My Saved cards'); process.exit(1); }
console.log('ok — My Saved cards lead with the pin name');
