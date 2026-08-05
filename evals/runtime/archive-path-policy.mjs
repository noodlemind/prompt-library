const SENSITIVE_ARCHIVE_COMPONENT =
  /^(?:\.env(?:\.[^/]*)?|credentials?(?:\.(?:json|ya?ml|txt))?|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:pem|p12|pfx|key))$/i;

export function isSensitiveArchivePath(value) {
  return typeof value === 'string' &&
    value.split('/').some((component) => SENSITIVE_ARCHIVE_COMPONENT.test(component));
}
