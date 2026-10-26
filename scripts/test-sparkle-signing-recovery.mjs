import assert from 'node:assert/strict'
import { constants, createHash, createPublicKey, generateKeyPairSync, publicEncrypt, randomUUID, sign } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { recoverBackup, recoveryContext, recoveryRef, recoveryRepository, seedPrivateKey, seedPublicKey, validateRecovery } from './recover-sparkle-signing-backup.mjs'

const directory = await mkdtemp(join(tmpdir(), 'guzi-recovery-test-'))
const captured = []
let passed = 0
const key = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32)
const otherSeed = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32)
const recipient = generateKeyPairSync('rsa', { modulusLength: 4096 })
const wrongRecipient = generateKeyPairSync('rsa', { modulusLength: 4096 })
const pem = recipient.privateKey.export({ type: 'pkcs8', format: 'pem' })
const passphrase = `Fake-test-only-${randomUUID()}`
const expectedCommit = 'a'.repeat(40), expectedRun = '12345'
const request = { schemaVersion: 1, requestId: randomUUID(), repository: recoveryRepository, ref: recoveryRef, sparklePublicKey: seedPublicKey(key), recipientPublicKeyPem: recipient.publicKey.export({ type: 'spki', format: 'pem' }), recipientPublicKeySha256: createHash('sha256').update(recipient.publicKey.export({ type: 'spki', format: 'der' })).digest('hex') }
function envelopeFor(seed = key) {
  const payload = { schemaVersion: 1, requestId: request.requestId, repository: request.repository, ref: request.ref, sourceCommit: expectedCommit, runId: expectedRun, runAttempt: '1', sparklePublicKey: request.sparklePublicKey, recipientPublicKeySha256: request.recipientPublicKeySha256, ciphertextBase64: publicEncrypt({ key: recipient.publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256', oaepLabel: Buffer.from(recoveryContext) }, seed).toString('base64') }
  return { payload, signatureBase64: sign(null, Buffer.from(`${recoveryContext}\n${JSON.stringify(payload)}`), seedPrivateKey(key)).toString('base64') }
}
function resign(envelope) {
  envelope.signatureBase64 = sign(null, Buffer.from(`${recoveryContext}\n${JSON.stringify(envelope.payload)}`), seedPrivateKey(key)).toString('base64')
  return envelope
}
const envelope = envelopeFor()
const input = { request, envelope, recipientKeyPem: pem, expectedCommit, expectedRun, expectedPublicKey: request.sparklePublicKey }
const options = { request: join(directory, 'request.json'), envelope: join(directory, 'envelope.json'), recipientKey: join(directory, 'recipient.pem'), passphraseFile: join(directory, 'passphrase.txt'), output: join(directory, 'backup.asc'), expectedCommit, expectedRun, expectedPublicKey: request.sparklePublicKey }
function pass(name) { passed++; console.log(`PASS ${name}`) }
function rejects(name, changed, pattern) { assert.throws(() => validateRecovery({ ...input, ...changed }), pattern); pass(name) }
async function run(file, args, { input, password } = {}) {
  return await new Promise((accept, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe', ...(password ? ['pipe'] : [])] })
    const stdout = [], stderr = []
    child.on('error', reject)
    child.stdout.on('data', (bytes) => stdout.push(bytes))
    child.stderr.on('data', (bytes) => stderr.push(bytes))
    child.stdin.on('error', () => {})
    child.stdin.end(input)
    if (password) { child.stdio[3].on('error', () => {}); child.stdio[3].end(`${password}\n`) }
    child.on('close', (code) => {
      const result = { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }
      captured.push(result.stderr.toString('utf8'))
      accept(result)
    })
  })
}
try {
  await Promise.all([
    writeFile(options.request, JSON.stringify(request)), writeFile(options.envelope, JSON.stringify(envelope)),
    writeFile(options.recipientKey, pem, { mode: 0o600 }), writeFile(options.passphraseFile, `${passphrase}\n`, { mode: 0o600 })
  ])
  assert.deepEqual(validateRecovery(input), key); pass('RSA 4096 OAEP and Ed25519 authenticated envelope')
  rejects('wrong recipient', { recipientKeyPem: wrongRecipient.privateKey.export({ type: 'pkcs8', format: 'pem' }) }, /fingerprint/)
  rejects('wrong recovered seed', { envelope: envelopeFor(otherSeed) }, /seed/)
  rejects('wrong trusted public key', { expectedPublicKey: seedPublicKey(otherSeed) }, /trusted public key/)
  for (const [field, value] of [['schemaVersion', 2], ['requestId', randomUUID()], ['repository', 'wrong/repository'], ['ref', 'refs/heads/main'], ['sparklePublicKey', seedPublicKey(otherSeed)], ['recipientPublicKeySha256', '0'.repeat(64)], ['sourceCommit', 'b'.repeat(40)], ['runId', '54321'], ['runAttempt', 1]]) {
    const changed = structuredClone(envelope); changed.payload[field] = value
    rejects(`mismatched ${field}`, { envelope: resign(changed) }, /mismatch|run attempt/)
  }
  const signatureChange = structuredClone(envelope)
  const signatureBytes = Buffer.from(signatureChange.signatureBase64, 'base64'); signatureBytes[0] ^= 1
  signatureChange.signatureBase64 = signatureBytes.toString('base64')
  rejects('invalid signature', { envelope: signatureChange }, /signature verification/)
  const ciphertextChange = structuredClone(envelope)
  const ciphertextBytes = Buffer.from(ciphertextChange.payload.ciphertextBase64, 'base64'); ciphertextBytes[0] ^= 1
  ciphertextChange.payload.ciphertextBase64 = ciphertextBytes.toString('base64')
  rejects('authenticated invalid ciphertext', { envelope: resign(ciphertextChange) }, /ciphertext decryption/)
  const noncanonical = structuredClone(envelope); noncanonical.payload.ciphertextBase64 += '\n'
  rejects('noncanonical Base64', { envelope: resign(noncanonical) }, /Invalid ciphertext/)
  rejects('extra request field', { request: { ...request, unknown: true } }, /request fields/)
  rejects('wrong request repository', { request: { ...request, repository: 'wrong/repository' } }, /repository or ref/)
  rejects('invalid recipient size', { request: { ...request, recipientPublicKeyPem: generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }) } }, /RSA 4096/)

  const result = await recoverBackup(options)
  assert.equal(result.backupSha256, createHash('sha256').update(await readFile(options.output)).digest('hex'))
  assert.equal(result.sparklePublicKey, request.sparklePublicKey)
  assert.equal((await lstat(options.output)).mode & 0o777, 0o600)
  pass(`fake seed GPG backup round trip; official signer verified: ${result.officialSignerVerified}`)
  const before = await readFile(options.output)
  await assert.rejects(recoverBackup(options), /Output already exists/)
  assert.deepEqual(await readFile(options.output), before); pass('existing backup never overwritten')
  const decryptHome = join(directory, 'gpg'); await mkdir(decryptHome, { mode: 0o700 })
  const gpgArgs = ['--no-options', '--homedir', decryptHome, '--batch', '--no-tty', '--pinentry-mode', 'loopback', '--no-symkey-cache', '--passphrase-fd', '3', '--output', '-', '--decrypt']
  const decrypted = await run('gpg', gpgArgs, { input: before, password: passphrase })
  assert.equal(decrypted.code, 0); assert.equal(decrypted.stdout.toString('utf8'), `${key.toString('base64')}\n`)
  const wrongPassword = await run('gpg', gpgArgs, { input: before, password: `${passphrase}-wrong` })
  assert.notEqual(wrongPassword.code, 0); assert.equal(wrongPassword.stdout.length, 0); pass('independent GPG decryption and wrong password rejection')

  for (const field of ['recipientKey', 'passphraseFile']) {
    const original = options[field]
    await chmod(original, 0o644)
    await assert.rejects(recoverBackup({ ...options, output: join(directory, `${field}-permissions.asc`) }), /0600/)
    await chmod(original, 0o600)
    const link = `${original}.link`; await symlink(original, link)
    await assert.rejects(recoverBackup({ ...options, [field]: link, output: join(directory, `${field}-symlink.asc`) }), /non-symlink/)
  }
  pass('private key and passphrase permissions and symlinks rejected')

  // A separate repository root lets the production CLI trust only this fake public key.
  const fakeRoot = join(directory, 'fake-root'), fakeScripts = join(fakeRoot, 'scripts')
  await mkdir(fakeScripts, { recursive: true })
  const cli = join(fakeScripts, 'recover-sparkle-signing-backup.mjs')
  await copyFile(fileURLToPath(new URL('./recover-sparkle-signing-backup.mjs', import.meta.url)), cli)
  await writeFile(join(fakeScripts, 'sparkle-public-key.txt'), `${request.sparklePublicKey}\n`)
  const cliArgs = ['--request', options.request, '--envelope', options.envelope, '--recipient-key', options.recipientKey, '--passphrase-file', options.passphraseFile, '--output', join(directory, 'cli.asc'), '--expected-commit', expectedCommit, '--expected-run', expectedRun]
  const cliResult = await run(process.execPath, [cli, ...cliArgs])
  captured.push(cliResult.stdout.toString('utf8'))
  assert.equal(cliResult.code, 0); assert.equal(JSON.parse(cliResult.stdout.toString('utf8')).verified, true)
  const wrongRunArgs = [...cliArgs]; wrongRunArgs[wrongRunArgs.indexOf('--expected-run') + 1] = '99999'
  const failedCli = await run(process.execPath, [cli, ...wrongRunArgs]); captured.push(failedCli.stdout.toString('utf8'))
  assert.equal(failedCli.code, 1); pass('production CLI with isolated fake trust root')
  const logs = captured.join('\n')
  for (const secret of [key.toString('base64'), otherSeed.toString('base64'), pem, passphrase]) assert(!logs.includes(secret), 'Captured output exposed fake secret material')
  pass('captured CLI and subprocess logs contain no private seed, private PEM, or passphrase')
  console.log(`Sparkle signing recovery: ${passed}/${passed} passed (fake keys only)`)
} finally {
  await run('gpgconf', ['--homedir', join(directory, 'gpg'), '--kill', 'gpg-agent']).catch(() => {})
  await rm(directory, { recursive: true, force: true })
}
