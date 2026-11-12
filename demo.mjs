import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.SG_OKX_PORT || 18789);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid SG_OKX_PORT');
const token = (await readFile(join(root, 'auth-token'), 'utf8')).trim();
try {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method:'POST', headers:{authorization:`Bearer ${token}`, 'content-type':'application/json', accept:'application/json, text/event-stream'},
    body:JSON.stringify({jsonrpc:'2.0', id:1, method:'tools/call', params:{name:'demo_preflight', arguments:{}}}),
    signal:AbortSignal.timeout(5000)
  });
  if (!response.ok) throw Error(`HTTP ${response.status}`);
  const body = await response.text();
  if (!body.includes('simulation')) throw Error('Unexpected demo response');
  console.log(body);
} catch { console.error('Offline demo failed. Check that this preview server is running on the configured local port.'); process.exitCode = 1; }
