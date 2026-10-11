import fs from 'node:fs';
import { chamar } from './ponte.mjs';
const [tool, ...rest] = process.argv.slice(2);
try {
  const args = rest[0] === '--arquivo' ? JSON.parse(fs.readFileSync(rest[1], 'utf8'))
    : tool === 'cerebro_buscar' ? { consulta: rest.join(' ') }
    : tool === 'cerebro_rotear' ? { tarefa: rest.join(' ') } : JSON.parse(rest.join(' ') || '{}');
  console.log(JSON.stringify(await chamar(tool, args), null, 2));
} catch (e) { console.error(e.message); process.exitCode = 1; }
