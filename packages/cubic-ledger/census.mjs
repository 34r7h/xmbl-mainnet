import { Level } from 'level';
import fs from 'fs';
const db = new Level(process.argv[2], { valueEncoding: 'utf8' });
await db.open();
const canon = new Set(JSON.parse(fs.readFileSync(process.argv[3],'utf8')).anchors.map(a=>`${a.event}:${a.hash}`));
const LOCAL = ['from','sig','validationTimestamp','id','agent','agent_xmbl_address'];
let rows=0,anchors=0,val=0,inCanon=0,notCanon=0,xid=0,localFields=0,epochTs=0,realTs=0,absentTs=0;
const keys=new Map(); const pre=new Map();
for await (const [k,v] of db.iterator({})) {
  pre.set(k.split(':')[0],(pre.get(k.split(':')[0])||0)+1);
  if (!k.startsWith('block:')) continue;
  rows++; let o; try{o=JSON.parse(v);}catch{continue;}
  const tx=o.tx||{};
  if (tx.type==='anchor') {
    anchors++;
    const kk=`${tx.event}:${tx.hash}`; keys.set(kk,(keys.get(kk)||0)+1);
    if (canon.has(kk)) inCanon++; else notCanon++;
    if (tx.xid) xid++;
    if (LOCAL.some(f=>f in tx)) localFields++;
  } else val++;
  const t=o.timestamp;
  if (t===undefined) absentTs++;
  else if (t&&typeof t==='object') (t.__bigint__==='0'?epochTs++:realTs++);
  else epochTs++;
}
const dupKeys=[...keys.values()].filter(n=>n>1).length;
const redundant=[...keys.values()].reduce((s,n)=>s+(n>1?n-1:0),0);
console.log(JSON.stringify({keyspace:Object.fromEntries(pre),rows,anchors,valueTxs:val,
  anchorsInCanonical:inCanon, anchorsNOTInCanonical:notCanon, distinctAnchorKeys:keys.size,
  duplicatedKeys:dupKeys, redundantRows:redundant, anchorsWithXid:xid, untypedAnchors:anchors-xid,
  anchorsWithNodeLocalFieldsInId:localFields,
  ts_epoch0_or_bad:epochTs, ts_real:realTs, ts_absent:absentTs},null,1));
await db.close();
