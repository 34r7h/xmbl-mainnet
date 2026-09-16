import { ComputeRuntime } from '@xmbl/storage-compute';
import { VerkleStateTree } from '@xmbl/state-machine';
import { ContractHost } from './packages/contracts/src/xcl/index.js';
import { compile } from './packages/lng/src/compile-wasm.js';
import { MAYOWasm } from '@xmbl/identity';
import { utxoKey } from './packages/contracts/src/xcl/index.js';

const MSG = Uint8Array.from([7, 7, 7, 7, 8, 8]);
const hex = '0x' + [...MSG].map((b) => b.toString(16).padStart(2, '0')).join('');
const SRC = `~contract \`Vault {
  ~on \`claim() {
    !\`xmbl.mayo.verify('${hex}') ? { ~e 'signature' }
    \`amt \`xmbl.utxo.spend(\`xmbl.utxo.input_id(0))
    \`xmbl.utxo.create('BENEF01', \`amt)
    return \`amt
  }
}`;
console.log(SRC);
const bytes = compile(SRC, { crypto: true, utxo: true });
console.log('compiled', bytes.length, 'bytes; imports:', WebAssembly.Module.imports(new WebAssembly.Module(bytes)).map(i => i.name).join(','));

const mayo = await MAYOWasm.load();
const kp = await mayo.keygen();
const good = await mayo.sign(MSG, kp.privateKey);
const bad = await mayo.sign(Uint8Array.from([9, 9, 9]), kp.privateKey);

const attempt = async (signature) => {
  const state = new VerkleStateTree();
  await state.insert(utxoKey('U1'), { from: 'genesis', to: 'alice', amount: '100' });
  const host = new ContractHost({ runtime: new ComputeRuntime({ maxTime: 10000 }), state });
  const { id } = host.deploy(bytes, [], { cryptoHost: true, utxoHost: true });
  try {
    const r = await host.call(id, 'claim', [], { inputs: ['U1'], crypto: { mayo: { signature, publicKey: kp.publicKey } } });
    return { ok: true, utxo: r.utxo };
  } catch (e) { return { ok: false, error: e.message }; }
};
console.log('VALID   signature →', JSON.stringify(await attempt(good)));
console.log('FORGED  signature →', JSON.stringify(await attempt(bad)));
