/**
 * Server-only voiceprint encryption helpers.
 *
 * Embeddings are encrypted with AES-256-GCM before they touch the database,
 * using a key derived from VOICEPRINT_ENCRYPTION_KEY. Raw audio is never
 * stored anywhere.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function getKey(): Promise<CryptoKey> {
  const secret = process.env["VOICEPRINT_ENCRYPTION_KEY"];
  if (!secret) throw new Error("Missing VOICEPRINT_ENCRYPTION_KEY");
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function encryptEmbedding(vector: number[]): Promise<string> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(JSON.stringify(vector)),
  );
  return `v1.${toBase64(iv)}.${toBase64(new Uint8Array(cipher))}`;
}

export async function decryptEmbedding(payload: string): Promise<number[]> {
  const [version, ivPart, cipherPart] = payload.split(".");
  if (version !== "v1" || !ivPart || !cipherPart) throw new Error("Unsupported voiceprint format");
  const key = await getKey();
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(ivPart) },
    key,
    fromBase64(cipherPart),
  );
  return JSON.parse(decoder.decode(plain)) as number[];
}

export async function hashPin(pin: string, userId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`${userId}:${pin}:${process.env["VOICEPRINT_ENCRYPTION_KEY"] ?? ""}`),
  );
  return toBase64(new Uint8Array(digest));
}
