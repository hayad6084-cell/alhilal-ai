import { handler } from '../server.mjs';

export default async function vercelHandler(req, res) {
  // vercel.json rewrites every route here and carries the original pathname in __path.
  try {
    const incoming = new URL(req.url || '/', 'http://localhost');
    const originalPath = incoming.searchParams.get('__path');
    if (originalPath) {
      incoming.searchParams.delete('__path');
      req.url = originalPath + (incoming.search ? incoming.search : '');
    }
  } catch { /* server handler returns a regular error for malformed paths */ }
  return handler(req, res);
}
