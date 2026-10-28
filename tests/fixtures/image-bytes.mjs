import { createCipheriv } from 'node:crypto';
// A valid 2x2 red PNG, fully decodable by the native DSH attachment store.
export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQImWP4z8DwnwGM/zMwAAAf7gP9qS/A4gAAAABJRU5ErkJggg==', 'base64');
export const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const cipher = createCipheriv('aes-128-ecb', key, null);
export const encrypted = Buffer.concat([cipher.update(png), cipher.final()]);
