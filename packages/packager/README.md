# @capsium/packager

Node-side `.cap` tooling for the Capsium runtime: read, write, sign,
encrypt, verify and extract packages, and resolve composite-package
dependencies from a store directory.

> **Status: 0.2.0 — private/unpublished** (workspace-only package).

All classes are small and dependency-injected (file system, archive,
hash/signature providers have defaults backed by `node:fs` and
`node:crypto`).

## Reading and writing

```ts
import { PackageReader, PackageWriter, IntegrityVerifier } from '@capsium/packager';

const writer = new PackageWriter();
await writer.writeCap('path/to/package-dir', 'out.cap'); // generates manifest/routes/security

const reader = new PackageReader();
const model = await reader.readCap('out.cap'); // validates; verifies signatures when declared

const report = await new IntegrityVerifier().verifyCap('out.cap'); // typed issue list
```

`PackageReader` gates on two §6 features while reading:

- **Signatures (§6a):** when `security.json` declares `digitalSignatures`,
  the signature is verified against the embedded public key and the
  package is rejected with `SignatureMismatchError` on mismatch
  (`signaturePublicKeyPem` overrides the embedded key;
  `skipSignatureVerification` opts out).
- **Encryption (§6b):** an encrypted package (layout below) is decrypted
  transparently when `decryptionKeyPem` is given; without a key it is
  rejected with `EncryptedPackageError`.

## Digital signatures (§6a)

```ts
import { PackageSigner } from '@capsium/packager';

const signer = new PackageSigner();
await signer.sign('path/to/package-dir', privateKeyPem, publicKeyPem);
// embeds signature.pub.pem, regenerates security.json (+ digitalSignatures),
// writes signature.sig (raw RSA-SHA256, >= 2048-bit keys enforced)
await signer.verifyDirectory('path/to/package-dir'); // throws typed errors
```

The signed payload is the concatenation, in sorted package-relative path
order, of the bytes of every checksum-covered file — identical to the Ruby
gem's construction, verifiable with
`openssl dgst -sha256 -verify signature.pub.pem -signature signature.sig payload.bin`.
X.509 certificate PEMs are accepted in place of the public key.

## Encryption (§6b)

```ts
import { PackageCipher } from '@capsium/packager';

const cipher = new PackageCipher();
await cipher.encrypt('package.cap', recipientPublicKeyPem, 'package.encrypted.cap');
await cipher.decrypt('package.encrypted.cap', recipientPrivateKeyPem, 'package.cap');
```

Encrypted `.cap` layout: `metadata.json` (cleartext), `signature.json`
(cleartext envelope), `package.enc` (AES-256-GCM ciphertext of the inner
zip). The 32-byte DEK is wrapped with the recipient's RSA public key
(RSA-OAEP-SHA256, MGF1-SHA256); GCM IV is 12 bytes, auth tag 16 bytes.
OpenPGP is out of scope. Wrong keys and tampered ciphertext fail with
typed `DecryptionError`s.

## Composite packages (§4a)

```ts
import { StoreDirectory } from '@capsium/packager';

const store = new StoreDirectory(process.env.CAPSIUM_STORE ?? '.capsium-store');
const deps = await store.loadDependencies(model.metadata.dependencies ?? {});
// Map<guid, CapsiumPackage> — newest satisfying version per dependency
```

A store directory holds `<name>-<version>.cap` files plus an optional
`index.json` (guid → file). Unsatisfiable dependencies throw
`DependencyResolutionError`.
