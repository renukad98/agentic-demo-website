import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalizeJson } from './approval-canonicalization.js';
import { Ed25519ApprovalRecordSigner, type ApprovalRecordSigner } from './approval-signature.js';
import { parseStoryPlan } from './contracts/xray-story-publication.js';
import { localDemoGrantClaimsSchema, localDemoScopeForPlan, localDemoScopeGrantSchema } from './local-demo-scope-grant.js';

export function signLocalDemoScopeChallenge(
  challenge: { scope: Parameters<typeof localDemoScopeForPlan>[0]; plan: unknown },
  signer: Pick<ApprovalRecordSigner, 'sign'>,
  ttlSeconds: number,
  now = Date.now(),
) {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 600) {
    throw new Error('Scope grant lifetime must be between 1 and 600 seconds.');
  }
  const { tenant, xrayOrigin, sessionNonce } = challenge.scope;
  const scope = localDemoScopeForPlan({ tenant, xrayOrigin, sessionNonce }, parseStoryPlan(challenge.plan));
  if (canonicalizeJson(scope) !== canonicalizeJson(challenge.scope)) {
    throw new Error('Scope challenge does not match the reviewed plan.');
  }
  const claims = localDemoGrantClaimsSchema.parse({
    ...scope, grantId: randomUUID(), issuedAt: now, expiresAt: now + ttlSeconds * 1000,
  });
  return localDemoScopeGrantSchema.parse({ claims, signature: signer.sign(canonicalizeJson(claims)) });
}

async function main() {
  const [confirm, challengePath, publicKeyPath, privateKeyPath, ttl, ...extra] = process.argv.slice(2);
  if (confirm !== '--sign-reviewed-scope' || !challengePath || !publicKeyPath || !privateKeyPath || !ttl ||
      extra.length || !isAbsolute(privateKeyPath)) throw new Error('Invalid signing arguments.');
  const key = await realpath(privateKeyPath);
  const workspace = await realpath(fileURLToPath(new URL('../../../', import.meta.url)));
  const within = relative(workspace, key);
  if (!(within === '..' || within.startsWith('..' + sep) || isAbsolute(within))) {
    throw new Error('The private signing key must be outside the workspace.');
  }
  const [source, publicKey, privateKey] = await Promise.all([
    readFile(challengePath, 'utf8'), readFile(publicKeyPath, 'utf8'), readFile(key, 'utf8'),
  ]);
  const signer = new Ed25519ApprovalRecordSigner(publicKey, privateKey);
  const grant = signLocalDemoScopeChallenge(JSON.parse(source), signer, Number(ttl));
  if (!signer.verify(canonicalizeJson(grant.claims), grant.signature)) throw new Error('Signing key pair mismatch.');
  process.stdout.write(JSON.stringify(grant) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write('Scope grant signing failed. Supply a reviewed challenge and an external Ed25519 key pair.\n');
    process.exitCode = 1;
  });
}
