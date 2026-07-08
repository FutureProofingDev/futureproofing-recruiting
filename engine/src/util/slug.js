export function slugify(text) {
  return String(text || 'stage')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'stage';
}
