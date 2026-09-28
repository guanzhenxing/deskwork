import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'

/**
 * Deterministic loopback mock for the pinned DeepSeek Messages adapter.
 *
 * The upstream adapter (rc.2) only speaks SSE at `<baseURL>/v1/messages` with
 * Anthropic-style events; a valid turn needs message_start, at least one
 * non-empty text delta, a stop reason, usage, and a terminating message_stop.
 * An empty content body is refused by the adapter (EMPTY_RESPONSE).
 */
export function createMockLlm() {
  const requests = []
  let replyIndex = 0
  const server = createServer((request, response) => {
    if (process.env.MOCK_LLM_TRACE !== undefined) {
      console.error(`[mock-llm] ${request.method} ${request.url}`)
    }
    if (request.method !== 'POST' || !request.url.endsWith('/v1/messages')) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'unexpected path' }))
      return
    }
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      replyIndex += 1
      const reply = `mock-llm-reply-${replyIndex}`
      requests.push({
        url: request.url,
        authorization: request.headers.authorization ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
      })
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      })
      const frame = (type, data) => {
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
      }
      frame('message_start', { message: { usage: { input_tokens: 12 } } })
      frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: reply } })
      frame('content_block_stop', { index: 0 })
      frame('message_delta', {
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 5 },
      })
      frame('message_stop', {})
      response.end()
    })
  })

  const started = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('mock LLM could not bind a loopback port'))
        return
      }
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })

  return {
    requests,
    started,
    async stop() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      })
    },
  }
}
