const {createServer} = require('node:http');
const {randomBytes, timingSafeEqual} = require('node:crypto');
const {once} = require('node:events');

const versions = ['2025-11-25', '2025-06-18', '2025-03-26'];
const host = '127.0.0.1';
const endpoint = '/mcp';
const integers = maximum => ({
  offset: {type: 'integer', minimum: 0},
  limit: {type: 'integer', minimum: 1, maximum}
});
const generationId = {type: 'string', minLength: 1, maxLength: 64};
const tool = (name, description, properties = {}, required = []) => ({
  name, description, inputSchema: {type: 'object', properties, required, additionalProperties: false},
  annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false}
});
const tools = [
  tool('merge_plan_list_generations', 'List saved generations of all merge candidates for the shared project.', integers(100)),
  tool('merge_plan_get_generation', 'Read a generation and list its archived paths and file sizes.',
    {generationId, ...integers(200)}, ['generationId']),
  tool('merge_plan_read_file', 'Read bytes of an archived path from a saved generation. Use nextOffset for subsequent chunks.',
    {generationId, path: {type: 'string', minLength: 1, maxLength: 4096}, ...integers(32768)}, ['generationId', 'path']),
  tool('merge_plan_current_playtest', 'Identify the loaded generation being playtested, or return null when no player is open.')
];
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const serialize = (res, status, body) => {
  res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
  res.end(body === undefined ? undefined : JSON.stringify(body));
};
const rpc = (id, result) => ({jsonrpc: '2.0', id, result});
const error = (id, code, message) => ({jsonrpc: '2.0', id, error: {code, message}});

function validArguments ({properties, required}, args) {
  if (!record(args) || required.some(key => !Object.hasOwn(args, key))) return false;
  return Object.entries(args).every(([key, value]) => {
    if (!Object.hasOwn(properties, key)) return false;
    const rule = properties[key];
    return rule.type === 'integer'
      ? Number.isSafeInteger(value) && value >= rule.minimum && value <= (rule.maximum ?? Number.MAX_SAFE_INTEGER)
      : typeof value === 'string' && value.length >= rule.minLength && value.length <= rule.maxLength;
  });
}

async function dispatch (message, read) {
  if (!record(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
      (Object.hasOwn(message, 'id') && typeof message.id !== 'string' && !Number.isSafeInteger(message.id))) {
    return error(null, -32600, 'Invalid Request');
  }
  const {id, method, params} = message;
  if (id === undefined) return undefined;
  if (method === 'initialize') {
    const requested = params?.protocolVersion;
    return rpc(id, {protocolVersion: versions.includes(requested) ? requested : versions[0],
      capabilities: {tools: {}}, serverInfo: {name: 'turbowarp-plus-merge-plans', version: '1.0.0'}});
  }
  if (method === 'ping') return rpc(id, {});
  if (method === 'tools/list') return rpc(id, {tools});
  if (method !== 'tools/call') return error(id, -32601, 'Method not found');
  const selected = tools.find(item => item.name === params?.name);
  const args = params?.arguments ?? {};
  if (!selected || !validArguments(selected.inputSchema, args)) return error(id, -32602, 'Invalid tool or arguments');
  try {
    const value = await read(selected.name, args);
    const text = JSON.stringify(value);
    if (!text || Buffer.byteLength(text) > 2 * 1024 * 1024) {
      throw new Error('Response is too large. Request a smaller page.');
    }
    return rpc(id, {content: [{type: 'text', text}], structuredContent: value});
  } catch (failure) {
    return rpc(id, {isError: true, content: [{type: 'text', text: failure.message}]});
  }
}

/** One explicit share in one window. No project path is ever used for filesystem access. */
async function openMergePlanMcp (read) {
  const token = randomBytes(32).toString('base64url');
  const credential = Buffer.from(`Bearer ${token}`);
  const server = createServer({requestTimeout: 10000, headersTimeout: 5000}, async (req, res) => {
    const {authorization, origin, host: authority, 'content-type': contentType, 'mcp-protocol-version': protocolVersion} = req.headers;
    if (origin !== undefined || authority !== `${host}:${server.address()?.port}`) return serialize(res, 403);
    if (req.url !== endpoint) return serialize(res, 404);
    const supplied = Buffer.from(authorization ?? '');
    if (supplied.length !== credential.length || !timingSafeEqual(supplied, credential)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return serialize(res, 401);
    }
    if (protocolVersion !== undefined && !versions.includes(protocolVersion)) return serialize(res, 400);
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return serialize(res, 405);
    }
    if (!/^application\/json(?:\s*;|$)/iu.test(contentType ?? '')) return serialize(res, 415);
    let body;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 16 * 1024) {
          res.setHeader('Connection', 'close');
          return serialize(res, 413);
        }
        chunks.push(chunk);
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return serialize(res, 400, error(null, -32700, 'Parse error'));
    }
    const result = await dispatch(body, read);
    if (!res.destroyed) serialize(res, result === undefined ? 202 : 200, result);
  });
  const listening = once(server, 'listening');
  server.listen(0, host);
  await listening;
  const url = `http://${host}:${server.address().port}${endpoint}`;
  return {url, token, close () {
    server.close();
    server.closeAllConnections();
  }};
}

module.exports = {openMergePlanMcp};
