// Temporary stand-in for `creed-kg serve`'s /api/model, without auto-opening a browser.
import * as http from 'http';
import { SqliteSemanticModelStorage } from '../src/storage/sqlite/sqlite-model-storage.js';

const storage = new SqliteSemanticModelStorage();
const model = await storage.load(process.argv[2] ?? process.cwd());
const payload = JSON.stringify(model);
console.log(`symbols=${model.symbols.length}`);

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url?.startsWith('/api/model')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(payload);
    return;
  }
  res.writeHead(404);
  res.end('not found');
}).listen(3000, () => console.log('model api on :3000'));
