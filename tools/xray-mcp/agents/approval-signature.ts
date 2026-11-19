import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';

export interface ApprovalRecordSigner {
  sign(payload: string): string;
  verify(payload: string, signature: string): boolean;
}

/** Ed25519 signatures make stored approval records tamper-evident. Keep private keys outside the workspace. */
export class Ed25519ApprovalRecordSigner implements ApprovalRecordSigner {
  private readonly privateKey: KeyObject | undefined;
  private readonly publicKey: KeyObject;

  constructor(publicKeyPem: string, privateKeyPem?: string) {
    this.publicKey = createPublicKey(publicKeyPem);
    this.privateKey = privateKeyPem ? createPrivateKey(privateKeyPem) : undefined;
    if (this.privateKey && this.privateKey.asymmetricKeyType !== 'ed25519') {
      throw new TypeError('Approval signing key must use Ed25519.');
    }
    if (this.publicKey.asymmetricKeyType !== 'ed25519') {
      throw new TypeError('Approval verification key must use Ed25519.');
    }
  }

  sign(payload: string): string {
    if (!this.privateKey) throw new Error('Approval signing is unavailable in this process.');
    return cryptoSign(null, Buffer.from(payload, 'utf8'), this.privateKey).toString('base64url');
  }

  verify(payload: string, signature: string): boolean {
    try {
      return cryptoVerify(
        null,
        Buffer.from(payload, 'utf8'),
        this.publicKey,
        Buffer.from(signature, 'base64url'),
      );
    } catch {
      return false;
    }
  }
}

