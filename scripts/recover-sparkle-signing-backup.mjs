import { constants, createHash, createPrivateKey, createPublicKey, privateDecrypt, sign, verify } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, lstat, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
export const recoveryContext = 'Guzi Assistant Sparkle backup recovery v1'
export const recoveryRepository = 'Drangon-Li/Guzi-Assistant'
export const recoveryRef = 'refs/heads/codex/recover-sparkle-signing-backup-v1'
const privatePrefix = Buffer.from('302e020100300506032b657004220420', 'hex')
const publicPrefix = Buffer.from('302a300506032b6570032100', 'hex')
const requestFields = ['schemaVersion', 'requestId', 'repository', 'ref', 'sparklePublicKey', 'recipientPublicKeyPem', 'recipientPublicKeySha256']
const payloadFields = ['schemaVersion', 'requestId', 'repository', 'ref', 'sourceCommit', 'runId', 'runAttempt', 'sparklePublicKey', 'recipientPublicKeySha256', 'ciphertextBase64']
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
function requireValue(condition, message) { if (!condition) throw new Error(message) }
function exactFields(value, fields, name) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field)), `Invalid ${name} fields`)
}
export function canonicalBase64(value, length, name) {
  requireValue(typeof value === 'string' && Buffer.from(value, 'base64').length === length && Buffer.from(value, 'base64').toString('base64') === value, `Invalid ${name}`)
  return Buffer.from(value, 'base64')
}
export function seedPrivateKey(seed) {
  requireValue(Buffer.isBuffer(seed) && seed.length === 32, 'Invalid Ed25519 seed')
  return createPrivateKey({ key: Buffer.concat([privatePrefix, seed]), type: 'pkcs8', format: 'der' })
}
export function seedPublicKey(seed) {
  return createPublicKey(seedPrivateKey(seed)).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64')
}
export function validateRecovery({ request, envelope, recipientKeyPem, expectedCommit, expectedRun, expectedPublicKey }) {
  exactFields(request, requestFields, 'request')
  requireValue(request.schemaVersion === 1, 'Invalid request schema version')
  requireValue(typeof request.requestId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.requestId), 'Invalid request ID')
  requireValue(request.repository === recoveryRepository && request.ref === recoveryRef, 'Unexpected request repository or ref')
  canonicalBase64(request.sparklePublicKey, 32, 'request Sparkle public key')
  requireValue(request.sparklePublicKey === expectedPublicKey, 'Request Sparkle public key does not match trusted public key')
  requireValue(typeof request.recipientPublicKeySha256 === 'string' && /^[a-f0-9]{64}$/.test(request.recipientPublicKeySha256), 'Invalid recipient fingerprint')
  let recipientPublic, recipientPrivate
  try {
    requireValue(typeof request.recipientPublicKeyPem === 'string' && request.recipientPublicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----\n'), 'Invalid recipient public PEM')
    recipientPublic = createPublicKey(request.recipientPublicKeyPem)
    recipientPrivate = createPrivateKey(recipientKeyPem)
  } catch { throw new Error('Invalid recipient key material') }
  for (const key of [recipientPublic, recipientPrivate]) requireValue(key.asymmetricKeyType === 'rsa' && key.asymmetricKeyDetails.modulusLength === 4096, 'Recipient key must be RSA 4096')
  const publicDer = recipientPublic.export({ type: 'spki', format: 'der' })
  requireValue(hash(publicDer) === request.recipientPublicKeySha256 && hash(createPublicKey(recipientPrivate).export({ type: 'spki', format: 'der' })) === request.recipientPublicKeySha256, 'Recipient key fingerprint mismatch')
  requireValue(typeof expectedCommit === 'string' && /^[a-f0-9]{40}$/.test(expectedCommit), 'Expected commit must be a full SHA')
  requireValue(typeof expectedRun === 'string' && /^\d+$/.test(expectedRun), 'Expected run must be a numeric ID')
  exactFields(envelope, ['payload', 'signatureBase64'], 'envelope')
  const payload = envelope.payload
  exactFields(payload, payloadFields, 'payload')
  for (const field of ['schemaVersion', 'requestId', 'repository', 'ref', 'sparklePublicKey', 'recipientPublicKeySha256']) requireValue(payload[field] === request[field], `Envelope ${field} mismatch`)
  requireValue(payload.sourceCommit === expectedCommit && payload.runId === expectedRun, 'Envelope commit or run mismatch')
  requireValue(typeof payload.runAttempt === 'string' && /^\d+$/.test(payload.runAttempt), 'Invalid run attempt')
  const ciphertext = canonicalBase64(payload.ciphertextBase64, 512, 'ciphertext')
  const signature = canonicalBase64(envelope.signatureBase64, 64, 'envelope signature')
  const trustedKey = createPublicKey({ key: Buffer.concat([publicPrefix, canonicalBase64(request.sparklePublicKey, 32, 'trusted public key')]), type: 'spki', format: 'der' })
  requireValue(verify(null, Buffer.from(`${recoveryContext}\n${JSON.stringify(payload)}`), trustedKey, signature), 'Envelope signature verification failed')
  let seed
  try { seed = privateDecrypt({ key: recipientPrivate, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256', oaepLabel: Buffer.from(recoveryContext) }, ciphertext) }
  catch { throw new Error('Recovery ciphertext decryption failed') }
  requireValue(seed.length === 32 && seedPublicKey(seed) === request.sparklePublicKey, 'Recovered seed does not match trusted public key')
  return seed
}

async function readSensitive(path, name) {
  let handle
  try {
    const before = await lstat(path)
    requireValue(before.isFile() && !before.isSymbolicLink() && (before.mode & 0o777) === 0o600, `${name} must be a regular non-symlink file with mode 0600`)
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const info = await handle.stat()
    requireValue(info.isFile() && (info.mode & 0o777) === 0o600 && info.dev === before.dev && info.ino === before.ino, `${name} changed during validation`)
    return await handle.readFile()
  } catch (error) {
    if (error.message.startsWith(name)) throw error
    throw new Error(`Cannot safely read ${name}`)
  } finally { await handle?.close() }
}
function run(file, args, { input = Buffer.alloc(0), passphrase, signal } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(file, args, { env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' }, signal, stdio: ['pipe', 'pipe', 'pipe', ...(passphrase ? ['pipe'] : [])] })
    let output = [], size = 0, failed = false
    const fail = () => { failed = true; child.kill('SIGTERM') }
    const timer = setTimeout(fail, 30_000)
    child.on('error', () => { failed = true })
    child.stdout.on('data', (bytes) => { size += bytes.length; if (size > 1024 * 1024) fail(); else output.push(bytes) })
    child.stderr.resume()
    child.stdin.on('error', () => {})
    child.stdin.end(input)
    if (passphrase) { child.stdio[3].on('error', () => {}); child.stdio[3].end(passphrase) }
    child.on('close', (code) => { clearTimeout(timer); code === 0 && !failed ? accept(Buffer.concat(output)) : reject(new Error(`Recovery subprocess failed: ${basename(file)} (${code ?? 'signal'})`)) })
  })
}
async function checkOfficialSigner(signer, temporary, seedText, publicKey, signal) {
  try { await access(signer, fsConstants.X_OK) } catch { return false }
  const message = Buffer.from(`${recoveryContext}\nOfficial Sparkle signing verification\n`)
  const challenge = join(temporary, 'challenge.bin')
  await writeFile(challenge, message, { mode: 0o600, flag: 'wx' })
  const signature = (await run(signer, ['--ed-key-file', '-', '-p', challenge], { input: seedText, signal })).toString('utf8').trim()
  const signatureBytes = canonicalBase64(signature, 64, 'official Sparkle signature')
  const key = createPublicKey({ key: Buffer.concat([publicPrefix, Buffer.from(publicKey, 'base64')]), type: 'spki', format: 'der' })
  requireValue(verify(null, message, key, signatureBytes), 'Official Sparkle signature did not verify')
  await run(signer, ['--verify', '--ed-key-file', '-', challenge, signature], { input: seedText, signal })
  await writeFile(challenge, Buffer.concat([message, Buffer.from('changed')]))
  let rejected = false
  try { await run(signer, ['--verify', '--ed-key-file', '-', challenge, signature], { input: seedText, signal }) } catch { rejected = true }
  requireValue(rejected, 'Official Sparkle accepted a modified message')
  return true
}
export async function recoverBackup(options) {
  const [request, envelope, recipientKeyPem, passphraseBytes] = await Promise.all([
    readFile(options.request, 'utf8').then((text) => JSON.parse(text)),
    readFile(options.envelope, 'utf8').then((text) => JSON.parse(text)),
    readSensitive(options.recipientKey, 'Recipient private key'),
    readSensitive(options.passphraseFile, 'Passphrase file')
  ])
  const seed = validateRecovery({ request, envelope, recipientKeyPem, expectedCommit: options.expectedCommit, expectedRun: options.expectedRun, expectedPublicKey: options.expectedPublicKey })
  const passphrase = passphraseBytes.toString('utf8').replace(/\r?\n$/, '')
  requireValue(passphrase.length >= 1 && !/[\r\n\0]/.test(passphrase), 'Passphrase file must contain one nonempty line')
  try { await lstat(options.output); throw new Error('Output already exists') } catch (error) { if (error.code !== 'ENOENT') throw error }
  const temporary = await mkdtemp(join(tmpdir(), 'guzi-sparkle-recovery-'))
  const seedText = Buffer.from(`${seed.toString('base64')}\n`)
  const passphraseInput = Buffer.from(`${passphrase}\n`)
  const gpgArgs = ['--no-options', '--homedir', temporary, '--batch', '--no-tty', '--pinentry-mode', 'loopback', '--no-symkey-cache', '--passphrase-fd', '3']
  try {
    options.signal?.throwIfAborted()
    const armor = await run('gpg', [...gpgArgs, '--cipher-algo', 'AES256', '--s2k-mode', '3', '--s2k-digest-algo', 'SHA256', '--armor', '--output', '-', '--symmetric'], { input: seedText, passphrase: passphraseInput, signal: options.signal })
    const recovered = await run('gpg', [...gpgArgs, '--output', '-', '--decrypt'], { input: armor, passphrase: passphraseInput, signal: options.signal })
    requireValue(recovered.equals(seedText) && seedPublicKey(canonicalBase64(recovered.toString('utf8').trim(), 32, 'backup seed')) === request.sparklePublicKey, 'Encrypted backup round trip failed')
    const message = Buffer.from(`${recoveryContext}\nLocal recovery verification\n`)
    const key = seedPrivateKey(seed), pub = createPublicKey(key), signature = sign(null, message, key)
    requireValue(verify(null, message, pub, signature) && !verify(null, Buffer.concat([message, Buffer.from('changed')]), pub, signature), 'Ed25519 recovery verification failed')
    const officialSignerVerified = await checkOfficialSigner(options.signer ?? join(root, 'build/sparkle/bin/sign_update'), temporary, seedText, request.sparklePublicKey, options.signal)
    options.signal?.throwIfAborted()
    await writeFile(options.output, armor, { flag: 'wx', mode: 0o600 })
    return { requestId: request.requestId, sourceCommit: envelope.payload.sourceCommit, runId: envelope.payload.runId, sparklePublicKey: request.sparklePublicKey, recipientPublicKeySha256: request.recipientPublicKeySha256, backupSha256: hash(armor), officialSignerVerified }
  } finally {
    seed.fill(0); seedText.fill(0); passphraseInput.fill(0); passphraseBytes.fill(0); recipientKeyPem.fill(0)
    try { await run('gpgconf', ['--homedir', temporary, '--kill', 'gpg-agent']) } catch { /* GPG may not have started its agent. */ }
    await rm(temporary, { recursive: true, force: true })
  }
}

async function main() {
  const flags = ['request', 'envelope', 'recipient-key', 'passphrase-file', 'output', 'expected-commit', 'expected-run']
  const args = process.argv.slice(2), parsed = {}
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index].replace(/^--/, '')
    requireValue(args[index] === `--${name}` && flags.includes(name) && !Object.hasOwn(parsed, name) && args[index + 1] && !args[index + 1].startsWith('--'), 'Invalid recovery arguments')
    parsed[name] = args[index + 1]
  }
  requireValue(flags.every((name) => parsed[name]), `Required flags: ${flags.map((name) => `--${name}`).join(' ')}`)
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, interrupt)
  try {
    const result = await recoverBackup({ request: resolve(parsed.request), envelope: resolve(parsed.envelope), recipientKey: resolve(parsed['recipient-key']), passphraseFile: resolve(parsed['passphrase-file']), output: resolve(parsed.output), expectedCommit: parsed['expected-commit'], expectedRun: parsed['expected-run'], expectedPublicKey: (await readFile(join(root, 'scripts/sparkle-public-key.txt'), 'utf8')).trim(), signal: controller.signal })
    console.log(JSON.stringify({ verified: true, ...result }, null, 2))
  } finally { for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(signal, interrupt) }
}
if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error('Sparkle backup recovery failed; no verified backup was produced. Check inputs, permissions, metadata, and GPG availability.'); process.exitCode = 1 })
