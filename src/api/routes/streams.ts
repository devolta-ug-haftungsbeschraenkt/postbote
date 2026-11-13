import type { FastifyInstance } from 'fastify'
import { authenticate } from '../auth.js'
import { ErrorCodes } from '../errors.js'

/**
 * Phase 2 (M8): Message-Streams (Analyse 2.7 / §3).
 * `outbound` ist der eingebaute Default-Stream und immer gültig; eigene
 * Streams müssen existieren und dürfen nicht archiviert sein, sonst liefert
 * POST /email ErrorCode 1235.
 */
export function registerStreamRoutes(app: FastifyInstance): void {
  const representation = (s: {
    id: string
    name: string
    description: string
    messageStreamType: string
    archived: boolean
    createdAt: string
  }) => ({
    ID: s.id,
    Name: s.name,
    Description: s.description,
    MessageStreamType: s.messageStreamType,
    Archived: s.archived,
    CreatedAt: s.createdAt,
  })

  app.get('/message-streams', async (request, reply) => {
    const auth = await authenticate(request, reply, app.postbote.store)
    if (!auth.token && !auth.sandbox) return reply
    const streams = await app.postbote.store.listStreams(auth.token?.serverId ?? '')
    return reply.send({ TotalCount: streams.length, MessageStreams: streams.map(representation) })
  })

  app.get('/message-streams/:id', async (request, reply) => {
    const auth = await authenticate(request, reply, app.postbote.store)
    if (!auth.token && !auth.sandbox) return reply
    const { id } = request.params as { id: string }
    const stream = await app.postbote.store.getStream(auth.token?.serverId ?? '', id)
    if (!stream)
      return reply
        .status(404)
        .send({ ErrorCode: ErrorCodes.StreamNotFound, Message: 'Stream not found.' })
    return reply.send(representation(stream))
  })

  app.post('/message-streams', async (request, reply) => {
    const auth = await authenticate(request, reply, app.postbote.store)
    if (!auth.token && !auth.sandbox) return reply
    const body = request.body as Record<string, unknown>
    const id = typeof body.ID === 'string' ? body.ID.trim() : ''
    const name = typeof body.Name === 'string' ? body.Name.trim() : ''
    if (!id || !name) {
      return reply.status(422).send({
        ErrorCode: ErrorCodes.SendValidation,
        Message: "Invalid request field(s): 'ID' and 'Name' are required.",
      })
    }
    if (id === 'outbound') {
      return reply.status(422).send({
        ErrorCode: ErrorCodes.SendValidation,
        Message: 'The default stream cannot be created.',
      })
    }
    if (auth.sandbox) {
      return reply.send(
        representation({
          id,
          name,
          description: '',
          messageStreamType: 'outbound',
          archived: false,
          createdAt: new Date().toISOString(),
        }),
      )
    }
    const stream = await app.postbote.store.upsertStream(auth.token?.serverId ?? '', {
      id,
      name,
      ...(typeof body.Description === 'string' && { description: body.Description }),
      ...(typeof body.MessageStreamType === 'string' && {
        messageStreamType: body.MessageStreamType,
      }),
    })
    return reply.send(representation(stream))
  })

  app.put('/message-streams/:id', async (request, reply) => {
    const auth = await authenticate(request, reply, app.postbote.store)
    if (!auth.token && !auth.sandbox) return reply
    const { id } = request.params as { id: string }
    const existing = await app.postbote.store.getStream(auth.token?.serverId ?? '', id)
    if (!existing)
      return reply
        .status(404)
        .send({ ErrorCode: ErrorCodes.StreamNotFound, Message: 'Stream not found.' })
    if (auth.sandbox) return reply.send(representation(existing))
    const body = request.body as Record<string, unknown>
    const stream = await app.postbote.store.upsertStream(auth.token?.serverId ?? '', {
      id,
      name: typeof body.Name === 'string' ? body.Name : existing.name,
      description: typeof body.Description === 'string' ? body.Description : existing.description,
      messageStreamType: existing.messageStreamType,
      archived: existing.archived,
    })
    return reply.send(representation(stream))
  })

  app.post('/message-streams/:id/archive', async (request, reply) => {
    const auth = await authenticate(request, reply, app.postbote.store)
    if (!auth.token && !auth.sandbox) return reply
    const { id } = request.params as { id: string }
    if (id === 'outbound') {
      return reply.status(422).send({
        ErrorCode: ErrorCodes.SendValidation,
        Message: 'The default stream cannot be archived.',
      })
    }
    const stream = auth.sandbox
      ? await app.postbote.store.getStream('', id)
      : await app.postbote.store.setStreamArchived(auth.token?.serverId ?? '', id, true)
    if (!stream)
      return reply
        .status(404)
        .send({ ErrorCode: ErrorCodes.StreamNotFound, Message: 'Stream not found.' })
    return reply.send(representation({ ...stream, archived: true }))
  })

  app.post('/message-streams/:id/unarchive', async (request, reply) => {
    const auth = await authenticate(request, reply, app.postbote.store)
    if (!auth.token && !auth.sandbox) return reply
    const { id } = request.params as { id: string }
    const stream = auth.sandbox
      ? await app.postbote.store.getStream('', id)
      : await app.postbote.store.setStreamArchived(auth.token?.serverId ?? '', id, false)
    if (!stream)
      return reply
        .status(404)
        .send({ ErrorCode: ErrorCodes.StreamNotFound, Message: 'Stream not found.' })
    return reply.send(representation({ ...stream, archived: false }))
  })
}
