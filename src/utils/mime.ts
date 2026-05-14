/**
 * Best-effort MIME-type sniff from a file's extension. Used by the
 * v0.4-M31 asset-upload verbs (`item upload` / `update upload`) to
 * populate the `Blob`'s `Content-Type` slot before the multipart
 * dispatch — Monday's multipart parser surfaces this as the asset's
 * `Content-Type` header on the binary part.
 *
 * **Lifted at v0.4-M31 IMPL** from byte-identical inline copies in
 * `src/commands/item/upload.ts` + `src/commands/update/upload.ts`
 * (2-consumer trigger fired at IMPL — duplication caught at the
 * coverage check + a future asset-upload-shaped surface — webhook
 * delivery, OAuth refresh, etc. — would be the 3rd). Mirrors the
 * R-NEW-29 (`executeItemMutation`) / R-NEW-30
 * (`resolveActiveDevProfile`) lift-at-N-consumer cadence.
 *
 * **Scope: deliberately narrow.** The CLI is not a MIME-detection
 * library; the table covers the common image / document / archive /
 * media types an agent's likely upload picks up by extension. Unknown
 * extensions fall back to `application/octet-stream`, which Monday
 * accepts and treats as binary. Future extensions land additively
 * by extending the switch.
 */
export const sniffContentType = (filename: string): string => {
  const lastDot = filename.lastIndexOf('.');
  const ext = lastDot >= 0 ? filename.slice(lastDot + 1).toLowerCase() : '';
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'svg':
      return 'image/svg+xml';
    case 'pdf':
      return 'application/pdf';
    case 'json':
      return 'application/json';
    case 'txt':
    case 'log':
    case 'md':
      return 'text/plain';
    case 'csv':
      return 'text/csv';
    case 'html':
      return 'text/html';
    case 'zip':
      return 'application/zip';
    case 'gz':
      return 'application/gzip';
    case 'mp4':
      return 'video/mp4';
    case 'mov':
      return 'video/quicktime';
    case 'mp3':
      return 'audio/mpeg';
    default:
      return 'application/octet-stream';
  }
};
