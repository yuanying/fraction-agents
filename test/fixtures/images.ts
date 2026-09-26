// Small files of each kind for the artifact tests: the signatures are real, the rest is filler.
export const IMAGES: Record<string, () => Buffer> = {
  png: () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png body")]),
  jpeg: () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg body")]),
  webp: () => Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x10, 0, 0, 0]), Buffer.from("WEBPVP8 body")]),
  /** One byte over 10 MiB. */
  big: () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(10 * 1024 * 1024 - 7)]),
  text: () => Buffer.from("just some text, not a picture"),
};
