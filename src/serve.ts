import * as http from 'http';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { SqliteSemanticModelStorage } from './storage/sqlite/sqlite-model-storage.js';
import { DB_FILENAME } from './storage/sqlite/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Resolves the model payload the visualizer consumes at /api/model.
 *
 * Prefers the SQLite index and reconstructs the model from it; falls back to a
 * legacy `semantic-model.json` so projects indexed before the SQLite migration
 * still visualize. Either way the served JSON matches `visualizer/src/types.ts`,
 * so the frontend needs no changes.
 */
async function loadModelContent(targetPath: string): Promise<{ content: string; source: string }> {
  const isFile = await fs.stat(targetPath).then(s => s.isFile()).catch(() => false);

  // Explicit path to a legacy JSON export.
  if (isFile && targetPath.endsWith('.json')) {
    const content = await fs.readFile(targetPath, 'utf-8');
    try {
      JSON.parse(content);
    } catch {
      throw new Error(`Invalid JSON format in "${targetPath}"`);
    }
    return { content, source: targetPath };
  }

  // Preferred: the SQLite index, at the target or one level up.
  const dbRoots = [targetPath, path.join(targetPath, '..')];
  for (const root of dbRoots) {
    const dbPath = path.join(root, '.masai', DB_FILENAME);
    const exists = await fs.stat(dbPath).then(s => s.isFile()).catch(() => false);
    if (!exists) continue;

    const storage = new SqliteSemanticModelStorage();
    const model = await storage.load(root);
    return { content: JSON.stringify(model), source: dbPath };
  }

  // Fallback: a JSON model written before the SQLite migration.
  const jsonCandidates = [
    path.join(targetPath, 'semantic-model.json'),
    path.join(targetPath, '.masai', 'semantic-model.json'),
    path.join(targetPath, '..', '.masai', 'semantic-model.json')
  ];
  for (const candidate of jsonCandidates) {
    const exists = await fs.stat(candidate).then(s => s.isFile()).catch(() => false);
    if (!exists) continue;

    const content = await fs.readFile(candidate, 'utf-8');
    try {
      JSON.parse(content);
    } catch {
      throw new Error(`Invalid JSON format in "${candidate}"`);
    }
    return { content, source: candidate };
  }

  throw new Error(
    `Could not locate a semantic model at or near "${targetPath}". ` +
    `Expected .masai/${DB_FILENAME} (run the indexer first) or a legacy semantic-model.json.`
  );
}

export async function startServer(targetPath: string) {
  // 1. Load the model (SQLite preferred, legacy JSON as fallback)
  const { content: modelContent, source } = await loadModelContent(targetPath);
  console.log(`Loading semantic model from: ${source}`);

  // 2. Locate visualizer assets
  // Dev path: workspace-root/visualizer/dist
  let distDir = path.resolve(__dirname, '..', 'visualizer', 'dist');
  
  // Verify if the visualizer build directory exists
  let distExists = await fs.stat(distDir).then(s => s.isDirectory()).catch(() => false);
  if (!distExists) {
    // Fallback path
    distDir = path.resolve(__dirname, 'visualizer', 'dist');
    distExists = await fs.stat(distDir).then(s => s.isDirectory()).catch(() => false);
    if (!distExists) {
      console.warn(`⚠️ Warning: Visualizer build folder not found at "${distDir}". Run 'npm run build' inside visualizer folder.`);
    }
  }

  // 3. Start server with port search
  let port = 3000;
  const maxPortAttempts = 10;
  
  function tryListen(p: number): Promise<http.Server> {
    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        // Enable CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
          res.writeHead(200);
          res.end();
          return;
        }

        const url = new URL(req.url || '', `http://${req.headers.host}`);

        // API Endpoint
        if (url.pathname === '/api/model') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(modelContent);
          return;
        }

        // Static files serving
        let pathname = url.pathname === '/' ? '/index.html' : url.pathname;
        let filePath = path.join(distDir, pathname);

        // Normalize and verify path traversal vulnerability
        filePath = path.normalize(filePath);
        if (!filePath.startsWith(distDir)) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }

        try {
          const fileStat = await fs.stat(filePath);
          if (fileStat.isDirectory()) {
            filePath = path.join(filePath, 'index.html');
          }

          const ext = path.extname(filePath);
          const mimeTypes: Record<string, string> = {
            '.html': 'text/html',
            '.js': 'application/javascript',
            '.css': 'text/css',
            '.json': 'application/json',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.svg': 'image/svg+xml',
            '.ico': 'image/x-icon',
          };

          const contentType = mimeTypes[ext] || 'application/octet-stream';
          const content = await fs.readFile(filePath);
          res.writeHead(200, { 'Content-Type': contentType });
          res.end(content);
        } catch {
          // SPA Fallback: serve index.html for any route
          try {
            const fallbackContent = await fs.readFile(path.join(distDir, 'index.html'));
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(fallbackContent);
          } catch {
            res.writeHead(404);
            res.end('Not Found (Visualizer static files not built)');
          }
        }
      });

      server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          reject(err);
        } else {
          server.close();
          reject(err);
        }
      });

      server.listen(p, () => {
        resolve(server);
      });
    });
  }

  let server: http.Server | null = null;
  for (let i = 0; i < maxPortAttempts; i++) {
    try {
      server = await tryListen(port + i);
      port = port + i;
      break;
    } catch (err: any) {
      if (err.code !== 'EADDRINUSE') {
        throw err;
      }
      console.log(`Port ${port + i} in use, trying next...`);
    }
  }

  if (!server) {
    throw new Error(`Could not find an open port after ${maxPortAttempts} attempts.`);
  }

  console.log(`\n==================================================`);
  console.log(` MASAI KG Visualizer running at: http://localhost:${port}`);
  console.log(`==================================================\n`);

  // Open default browser on Windows
  const url = `http://localhost:${port}`;
  const startCmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  exec(`${startCmd} ${url}`, (err) => {
    if (err) {
      console.error(`Could not automatically open browser: ${err.message}`);
    }
  });
}
