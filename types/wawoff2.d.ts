/**
 * wawoff2 ships no types. Only `decompress` is used — scripts/fonts-from-woff2.ts
 * unwraps the brand webfonts into the .ttf that LibreOffice can read.
 */
declare module "wawoff2" {
  export function decompress(input: Uint8Array): Promise<Uint8Array>;
  export function compress(input: Uint8Array): Promise<Uint8Array>;
}
