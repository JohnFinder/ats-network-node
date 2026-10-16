import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function compile() {
  const sources = Object.fromEntries(fs.readdirSync(path.join(root, 'src')).filter(name => name.endsWith('.sol')).map(name =>
    [name, { content: fs.readFileSync(path.join(root, 'src', name), 'utf8') }]));
  const input = {
    language: 'Solidity', sources,
    settings: {
      optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'shanghai',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } }
    }
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: name => {
    if (!name.startsWith('@openzeppelin/contracts/') || name.includes('..')) return { error: 'Import not permitted' };
    try { return { contents: fs.readFileSync(path.join(root, 'node_modules', name), 'utf8') }; }
    catch { return { error: `Missing pinned dependency ${name}; run npm ci` }; }
  } }));
  for (const issue of output.errors ?? []) {
    if (issue.severity === 'error') throw new Error(issue.formattedMessage);
    console.error(issue.formattedMessage);
  }
  fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  const artifacts = {};
  for (const name of Object.keys(sources).map(name => name.slice(0, -4))) {
    const contract = output.contracts[`${name}.sol`][name];
    if (contract.evm.deployedBytecode.object.length / 2 > 24576) throw new Error(`${name} exceeds EIP-170 runtime limit`);
    artifacts[name] = {
      contractName: name, compiler: solc.version(), evmVersion: 'shanghai',
      abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}`,
      deployedBytecode: `0x${contract.evm.deployedBytecode.object}`
    };
    fs.writeFileSync(path.join(root, 'artifacts', `${name}.json`), `${JSON.stringify(artifacts[name], null, 2)}\n`);
  }
  return artifacts;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const artifacts = compile();
  console.log(JSON.stringify(Object.fromEntries(Object.entries(artifacts).map(([name, value]) =>
    [name, { runtimeBytes: (value.deployedBytecode.length - 2) / 2 }]))));
}
