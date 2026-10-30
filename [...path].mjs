import handler from '../server-core.mjs';

export default async function api(req, res) {
  return handler(req, res);
}
