'use strict';
// Local replay only: reads saved public snapshots. Does not call fetch/RPC or use a wallet.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const requireWeb = createRequire(path.resolve(process.env.SEJIRE_PROJECT_ROOT || path.resolve(__dirname, '../../../..'), 'apps/web/package.json'));
const { PublicKey } = requireWeb('@solana/web3.js');
const read = (name) => fs.readFileSync(path.join(__dirname, name));
const parse = (name) => JSON.parse(read(name).toString('utf8'));
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest();
const discriminator = (name) => sha256('account:' + name).subarray(0, 8);
const bytes = (value) => {
  assert.equal(value.data[1], 'base64');
  const result = Buffer.from(value.data[0], 'base64');
  assert.equal(result.length, value.space);
  return result;
};
const derive = (program, seeds) => {
  const [address, bump] = PublicKey.findProgramAddressSync(seeds, new PublicKey(program));
  return { address: address.toBase58(), bump };
};
(async () => {
  const assetResponse = parse('ant-asset.rpc.raw.json');
  const registryResponse = parse('arns-record.rpc.raw.json');
  const cutoverSnapshot = parse('ant-record-controllers.rpc.parsed-snapshot.json');
  const assetValue = assetResponse.result.value;
  const registryValue = registryResponse.result.value;
  const asset = bytes(assetValue);
  const registry = bytes(registryValue);
  const rootRecord = bytes(cutoverSnapshot.accounts[1]);
  const controllers = bytes(cutoverSnapshot.accounts[2]);
  const programs = {
    core: 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d',
    arns: '2yCUx5edFvUrkibYaUa2ZXWyx9kuJkS8CwyzsgHPWdZZ',
    ant: '2MWexMHfMhGJwMHv9Qm9YAVCqjUFUJwDJAysW4oCUGk5',
    escrow: '5HZhe9UqKL5zAsdz81nuuaxV41h8bFhudzxxBigAQndM'
  };
  const mint = new PublicKey('997oV9UJDwKzmfCs2wFVLd4mML4hmJ6K3z71UMxUb2H8');
  const ownerBytes = asset.subarray(1, 33);
  const owner = new PublicKey(ownerBytes).toBase58();
  const oldTarget = 'UVtbBWxU9HK5gD21Pq0qc3I4adRREFbOQpU4F0NXik8';
  assert.equal(assetValue.owner, programs.core);
  assert.equal(registryValue.owner, programs.arns);
  assert.equal(cutoverSnapshot.accounts[1].owner, programs.ant);
  assert.equal(cutoverSnapshot.accounts[2].owner, programs.ant);
  assert.equal(owner, 'F8XB2iSMf8mB6fPhtwGRDjuT8wTypfARN5pscu3fjqKN');
  assert.ok(registry.subarray(0, 8).equals(discriminator('ArnsRecord')));
  assert.ok(registry.subarray(8, 40).equals(sha256('sejire')));
  assert.ok(registry.subarray(40, 72).equals(ownerBytes));
  assert.ok(registry.subarray(72, 104).equals(mint.toBuffer()));
  assert.ok(rootRecord.subarray(0, 8).equals(discriminator('AntRecord')));
  assert.ok(rootRecord.subarray(8, 40).equals(mint.toBuffer()));
  assert.ok(rootRecord.includes(Buffer.from(oldTarget)));
  assert.ok(controllers.subarray(0, 8).equals(discriminator('AntControllers')));
  assert.ok(controllers.subarray(8, 40).equals(mint.toBuffer()));
  const derived = {
    registry: derive(programs.arns, [Buffer.from('arns_record'), sha256('sejire')]),
    baseRecord: derive(programs.ant, [Buffer.from('ant_record'), mint.toBuffer(), sha256('@')]),
    controllers: derive(programs.ant, [Buffer.from('ant_controllers'), mint.toBuffer()]),
    standardEscrow: derive(programs.escrow, [Buffer.from('escrow_ant'), mint.toBuffer()])
  };
  const arnsProgram = new PublicKey(programs.arns);
  const idlBase = PublicKey.findProgramAddressSync([], arnsProgram)[0];
  const idlAddress = await PublicKey.createWithSeed(idlBase, 'anchor:idl', arnsProgram);
  assert.equal(derived.registry.address, 'AzMhXzwRKBAeC5jBJnkwzbXefDaLuK3gddU9Ga9vY8Ze');
  assert.equal(derived.baseRecord.address, cutoverSnapshot.addresses[1]);
  assert.equal(derived.controllers.address, cutoverSnapshot.addresses[2]);
  assert.equal(idlAddress.toBase58(), cutoverSnapshot.addresses[0]);
  assert.equal(cutoverSnapshot.accounts[0], null);
  const files = ['ant-asset.rpc.raw.json', 'arns-record.rpc.raw.json', 'ant-record-controllers.rpc.parsed-snapshot.json', 'rpc-captures.json', 'sources.json', 'verify-saved-evidence.cjs'];
  const fileIntegrity = Object.fromEntries(files.map((name) => {
    const content = read(name);
    return [name, { bytes: content.length, sha256: sha256(content).toString('hex') }];
  }));
  console.log(JSON.stringify({
    result: 'PASS',
    scope: 'Local decoding and byte/PDA comparisons of previously captured public snapshots only. No RPC request or independent ledger proof.',
    runtime: process.version,
    web3Version: requireWeb('@solana/web3.js/package.json').version,
    replayedFinalizedSlots: [assetResponse.result.context.slot, registryResponse.result.context.slot, cutoverSnapshot.context.slot],
    typed: {
      nftOwner: {
        value: owner,
        source: 'Metaplex Core documented key:u8 then owner:32 bytes; source core-owner-layout in sources.json',
        offset: 1,
        length: 32,
        onCurve: PublicKey.isOnCurve(ownerBytes)
      },
      rpcProgramOwners: {
        antAsset: assetValue.owner,
        registry: registryValue.owner,
        baseRecord: cutoverSnapshot.accounts[1].owner,
        controllers: cutoverSnapshot.accounts[2].owner
      }
    },
    derivedPdas: { ...derived, anchorIdl: { address: idlAddress.toBase58(), accountObserved: null } },
    byteMatches: {
      registry: {
        discriminator: registry.subarray(0, 8).toString('hex'),
        nameHashOffset: 8,
        nameHashAlgorithm: 'sha256(utf8 sejire)',
        nftOwnerBytesOffset: 40,
        antMintBytesOffset: 72,
        unparsedTailFrom104Hex: registry.subarray(104).toString('hex')
      },
      baseRecord: {
        discriminator: rootRecord.subarray(0, 8).toString('hex'),
        mintBytesOffset: 8,
        targetUtf8: oldTarget,
        targetByteOffset: rootRecord.indexOf(Buffer.from(oldTarget)),
        ownerBytesOffset: rootRecord.indexOf(ownerBytes),
        caveat: 'Target/mint/owner are byte matches, not a full typed AntRecord decode'
      },
      controllers: {
        discriminator: controllers.subarray(0, 8).toString('hex'),
        mintBytesOffset: 8,
        nftOwnerBytesOffset: controllers.indexOf(ownerBytes),
        caveat: 'No typed ACL/controller-list or effective permission claim'
      },
      nftText: Object.fromEntries(['sejire', 'ArNS Name', 'Type', 'permabuy', 'Undername Limit', '10', 'ANT Program', programs.ant].map((text) => [text, asset.indexOf(Buffer.from(text))]))
    },
    accountByteIntegrity: Object.fromEntries([['antAsset', asset], ['registry', registry], ['baseRecord', rootRecord], ['controllers', controllers]].map(([name, value]) => [name, { bytes: value.length, sha256: sha256(value).toString('hex') }])),
    fileIntegrity,
    unresolved: ['typed registry purchase-type enum', 'typed registry expiry/endTimestamp', 'typed controllers and effective ACL', 'user wallet ownership/private-key access', 'actual wallet acceptance/signature/update'],
    caveats: ['NFT permabuy text is an attribute, not independently typed registry proof', 'Third saved RPC result is a parsed stdout snapshot; rentEpoch precision was lost before capture and is ignored', 'RPC finalized commitment is the endpoint report, not a locally verified Solana ledger proof']
  }, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; });
