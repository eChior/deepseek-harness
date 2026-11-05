/**
 * The model-facing `read_image_text` tool reads the text out of one picture
 * with this machine's local recognizer and returns that text.
 *
 * It exists because a picture the user attaches keeps its pixels in the session
 * while the model may accept text only: the reader runs here, the text is
 * redacted on the way out, and nothing is sent anywhere to produce it. The tool
 * is registered only while a redaction provider with a local reader is mounted,
 * so a deployment without one never advertises a reader it cannot run.
 *
 * Two sources satisfy it. A path reads that file; omitting the path reads the
 * newest picture the conversation itself carries, which is what a person means
 * when they say "read this screenshot" and what keeps the model from hunting
 * through the disk for a file it was never given.
 * @module @deepseek-ai/dsh-tool-fs/src/read-image-text
 */

import { Buffer } from 'node:buffer'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { imageMediaTypeForPath, sniffImageMediaType } from './read-image.ts'
import { resolveRegularReadTarget } from './read-target.ts'

/**
 * What this tool needs from the mounted redaction provider.
 *
 * Declared here rather than imported so the filesystem tools stay independent of
 * whichever plugin reads images: this package asks for one method by shape.
 */
interface LocalTextReader {
  /**
   * Read one encoded image and return the redacted text it held.
   * @param data The image as canonical base64.
   * @param mediaType Its declared media type.
   * @returns The text, or undefined when this machine cannot read the image.
   */
  recognizeImage(data: string, mediaType: string): Promise<string | undefined>
}

/** Byte cap used when no attachment service supplies its own image limit. */
const DEFAULT_READ_LIMIT = 20 * 1024 * 1024

/**
 * Side length handed to the attachment service when a conversation picture is
 * read. The recognizer scales whatever it receives, so the request asks for a
 * version no larger than a full-screen photograph rather than the original.
 */
const REQUEST_SIDE = 2048

/** The structured outcome declared by the `read_image_text` output schema. */
export interface ImageTextValue {
  /** The backend-resolved path that was read, or the conversation attachment it came from. */
  path: string
  /** The text the image held, already redacted; empty when it held none. */
  text: string
}

/**
 * The newest picture inside one conversation's events, scanning backwards.
 * @param events - the session events in log order.
 * @returns the newest image attachment, or undefined when the conversation holds none.
 */
export function pickConversationImage(
  events: readonly { type: string; data: unknown }[],
): ImageAttachmentRef | undefined {
  for (const event of events.toReversed()) {
    if (event.type !== 'user/message') continue
    const message = event.data as { content?: readonly { type: string; attachment?: ImageAttachmentRef }[] }
    for (const part of message.content?.toReversed() ?? []) {
      if (part.type === 'image' && part.attachment !== undefined) return part.attachment
    }
  }
  return undefined
}

/**
 * Find the newest picture the conversation carries.
 * @param ctx - the registration scope, read for the session store.
 * @param sessionId - the calling agent's session identity.
 * @returns the newest image attachment, or undefined when the conversation holds none.
 */
function newestConversationImage(ctx: Context, sessionId: string | undefined): ImageAttachmentRef | undefined {
  if (sessionId === undefined) return undefined
  const sessions = ctx.get('sessions')
  if (sessions === undefined) return undefined
  const session = sessions.get(sessionId as Parameters<typeof sessions.get>[0])
  if (session === undefined) return undefined
  // oxlint-disable-next-line typescript/no-deprecated -- Session history read; the async projection is not available to a tool body.
  return pickConversationImage(session.snapshotEvents())
}

/**
 * Register the `read_image_text` tool into the given context.
 * The composing plugin owns the redaction gate: `src/index.ts` calls this
 * inside `ctx.inject(['redaction'], …)` so the tool exists only while a local
 * reader is mounted. Execution still re-checks `ctx.get('redaction')` for
 * direct callers.
 * @param ctx - the registration scope; execution uses its `fs`, `attachments`,
 *   and `sessions` services plus the optional `redaction` service.
 */
export function applyReadImageTextTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'read_image_text',
    description: 'Read the text out of a picture with the local recognizer. '
      + 'Omit the path to read the newest picture in this conversation — that is the usual case. '
      + 'The image is read on this machine and never leaves it; the returned text is already redacted. '
      + 'Use this instead of read_image when the model accepts text only.',
    parameters: {
      file_path: {
        type: 'string',
        description: 'Path to an image file, resolved by the filesystem backend. '
          + 'Leave it out to read the newest picture attached to this conversation.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `<path>${value.path}</path>\n<type>image-text</type>\n<content>\n${value.text}\n</content>`,
      }],
      presentationMeta: (_args, value) => ({ path: value.path }),
    },
    // Recognition is a pure local read; two calls for one picture cannot conflict.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const reader = ctx.get('redaction') as LocalTextReader | undefined
      const attachments = ctx.get('attachments')
      const optionalPath = typeof args.file_path === 'string' ? args.file_path.trim() : ''

      if (optionalPath.length > 0) {
        if (reader === undefined) {
          throw new Error(`cannot read "${optionalPath}": no local image reader is mounted`)
        }
        const { target, info } = await resolveRegularReadTarget(ctx, exec, optionalPath)
        const limit = attachments === undefined
          ? DEFAULT_READ_LIMIT
          : Math.min(attachments.imageLimits.maxImageBytes, DEFAULT_READ_LIMIT)
        const data = await ctx.fs.readBytes(target, exec.signal, limit)
        const mediaType: ImageMediaType | undefined = imageMediaTypeForPath(target.displayPath)
          ?? sniffImageMediaType(data)
        if (mediaType === undefined) {
          throw new Error(`cannot read "${target.displayPath}": the file is not a supported PNG/JPEG/WebP/GIF image`)
        }
        const text = await reader.recognizeImage(Buffer.from(data).toString('base64'), mediaType)
        if (text === undefined) {
          throw new Error(`cannot read "${target.displayPath}": this machine has no reader for ${mediaType} images, or the reader failed; the file was left untouched`)
        }
        ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
        return { path: target.displayPath, text }
      }

      if (reader === undefined) throw new Error('cannot read the conversation picture: no local image reader is mounted')
      if (attachments === undefined) throw new Error('cannot read the conversation picture: no attachment service is mounted')
      const ref = newestConversationImage(ctx, exec.agent?.id)
      if (ref === undefined) {
        throw new Error('this conversation has no picture to read; pass file_path to read one from disk')
      }
      const request = await attachments.readImageRequest(
        ref,
        { width: REQUEST_SIDE, height: REQUEST_SIDE, maxBytes: Math.min(attachments.imageLimits.maxImageBytes, DEFAULT_READ_LIMIT) },
        exec.signal,
      )
      const text = await reader.recognizeImage(Buffer.from(request.data).toString('base64'), request.mediaType)
      if (text === undefined) {
        throw new Error(`cannot read the conversation picture: this machine has no reader for ${request.mediaType} images, or the reader failed`)
      }
      return { path: `attachment:${String(ref.attachmentId)}`, text }
    },
    presentCall(args): GenericCallView {
      const path = typeof args.file_path === 'string' ? args.file_path.trim() : ''
      if (path.length === 0) {
        return {
          card: 'generic',
          title: 'Read the text in the conversation picture',
          kind: 'read',
          locations: [],
        }
      }
      return {
        card: 'generic',
        title: `Read text from ${path}`,
        kind: 'read',
        locations: [{ path }],
      }
    },
  }))
}
