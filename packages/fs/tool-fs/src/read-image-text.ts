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

  /**
   * Read one encoded image and return its text with where each line sat.
   *
   * Optional: an older redaction provider answers text only, and a reader that
   * reports no geometry (Windows OCR, Tesseract) may return empty `lines`. The
   * tool falls back to `recognizeImage` when this method is absent.
   * @param data The image as canonical base64.
   * @param mediaType Its declared media type.
   * @param options - `characters: true` also asks for one box per character.
   * @returns The redacted layout, or undefined when this machine cannot read the image.
   */
  recognizeImageLayout?(
    data: string,
    mediaType: string,
    options?: { readonly characters?: boolean },
  ): Promise<ImageTextLayout | undefined>
}

/** One corner tuple of a detected line or character, in input-image pixels. */
export interface ImageTextBox {
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
  readonly x3: number
  readonly y3: number
  readonly x4: number
  readonly y4: number
}

/** One character the reader placed inside a line. */
export interface ImageTextCharacter {
  /** The character's text, already redacted. */
  readonly text: string
  /** The reader's confidence in that character. */
  readonly score: number
  /** Four corners, in input-image pixels. */
  readonly box: ImageTextBox
}

/** One line the reader placed inside the picture. */
export interface ImageTextLine {
  /** The line's text, already redacted. */
  readonly text: string
  /** Four corners, clockwise from the line's top-left, in input-image pixels. */
  readonly box: ImageTextBox
  /** Detector confidence for the box, 0..1. */
  readonly detectionScore: number
  /** Recognizer score for the line, raw and not normalized to 0..1. */
  readonly recognitionScore: number
  /** Character boxes; empty unless the caller asked for them. */
  characters: ImageTextCharacter[]
}

/** One picture's text together with the geometry the reader measured. */
export interface ImageTextLayout {
  /** The whole picture's text, already redacted. */
  readonly text: string
  /** Pixel size of the image the boxes are relative to, when the reader reports it. */
  readonly image?: { readonly width: number; readonly height: number }
  /** The lines the picture held, in reading order. */
  readonly lines: readonly ImageTextLine[]
  /** The device that read it, when the reader reports one. */
  readonly backend?: string
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
  /** Pixel size of the image, when the reader reported it. */
  image?: { readonly width: number; readonly height: number }
  /** One entry per detected line with its box, when the reader reported geometry. */
  lines?: ImageTextLine[]
  /** The device that read it, when the reader reported one. */
  backend?: string
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

/** What one reader call produced: plain text, or text with its geometry. */
type ReadOutcome =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'layout'; readonly layout: ImageTextLayout }

/**
 * Ask the mounted reader for one picture, preferring the geometry-aware method.
 * @param reader - the mounted redaction provider.
 * @param data - the image as canonical base64.
 * @param mediaType - its declared media type.
 * @param characters - whether to ask for per-character boxes too.
 * @returns the outcome, or undefined when the reader could not read the picture.
 */
async function readPicture(
  reader: LocalTextReader,
  data: string,
  mediaType: string,
  characters: boolean,
): Promise<ReadOutcome | undefined> {
  if (reader.recognizeImageLayout !== undefined) {
    const layout = await reader.recognizeImageLayout(data, mediaType, characters ? { characters: true } : {})
    return layout === undefined ? undefined : { kind: 'layout', layout }
  }
  const text = await reader.recognizeImage(data, mediaType)
  return text === undefined ? undefined : { kind: 'text', text }
}

/** Turn one reader outcome into the tool's declared value. */
function pictureValue(path: string, outcome: ReadOutcome): ImageTextValue {
  if (outcome.kind === 'text') return { path, text: outcome.text }
  const { layout } = outcome
  return {
    path,
    text: layout.text,
    ...(layout.image === undefined ? {} : { image: { width: layout.image.width, height: layout.image.height } }),
    ...(layout.backend === undefined ? {} : { backend: layout.backend }),
    ...(layout.lines.length === 0
      ? {}
      : {
        lines: layout.lines.map(line => ({
          text: line.text,
          box: line.box,
          detectionScore: line.detectionScore,
          recognitionScore: line.recognitionScore,
          characters: line.characters.map(character => ({
            text: character.text,
            score: character.score,
            box: character.box,
          })),
        })),
      }),
  }
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
      with_characters: {
        type: 'boolean',
        description: 'Also report a box for every character, not just every line. '
          + 'Costs more output; leave it out unless character placement matters.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          text: { type: 'string', required: true },
          image: {
            type: 'object',
            additionalProperties: false,
            properties: {
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
            },
          },
          backend: { type: 'string' },
          lines: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                text: { type: 'string', required: true },
                box: {
                  type: 'object',
                  additionalProperties: false,
                  required: true,
                  properties: {
                    x1: { type: 'number', required: true },
                    y1: { type: 'number', required: true },
                    x2: { type: 'number', required: true },
                    y2: { type: 'number', required: true },
                    x3: { type: 'number', required: true },
                    y3: { type: 'number', required: true },
                    x4: { type: 'number', required: true },
                    y4: { type: 'number', required: true },
                  },
                },
                detectionScore: { type: 'number', required: true },
                recognitionScore: { type: 'number', required: true },
                characters: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      text: { type: 'string', required: true },
                      score: { type: 'number', required: true },
                      box: {
                        type: 'object',
                        additionalProperties: false,
                        required: true,
                        properties: {
                          x1: { type: 'number', required: true },
                          y1: { type: 'number', required: true },
                          x2: { type: 'number', required: true },
                          y2: { type: 'number', required: true },
                          x3: { type: 'number', required: true },
                          y3: { type: 'number', required: true },
                          x4: { type: 'number', required: true },
                          y4: { type: 'number', required: true },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const image = value.image === undefined
          ? ''
          : `\n<image width="${String(value.image.width)}" height="${String(value.image.height)}" />`
        const lines = value.lines === undefined || value.lines.length === 0
          ? ''
          : '\n<lines>\n' + value.lines.map(line =>
            `<line x1="${String(line.box.x1)}" y1="${String(line.box.y1)}" `
              + `x2="${String(line.box.x2)}" y2="${String(line.box.y2)}">${line.text}</line>`,
          ).join('\n') + '\n</lines>'
        return [{
          type: 'text',
          text: `<path>${value.path}</path>\n<type>image-text</type>${image}\n<content>\n${value.text}\n</content>${lines}`,
        }]
      },
      presentationMeta: (_args, value) => ({ path: value.path }),
    },
    // Recognition is a pure local read; two calls for one picture cannot conflict.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const reader = ctx.get('redaction') as LocalTextReader | undefined
      const attachments = ctx.get('attachments')
      const optionalPath = typeof args.file_path === 'string' ? args.file_path.trim() : ''
      const withCharacters = args.with_characters === true

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
        const outcome = await readPicture(reader, Buffer.from(data).toString('base64'), mediaType, withCharacters)
        if (outcome === undefined) {
          throw new Error(`cannot read "${target.displayPath}": this machine has no reader for ${mediaType} images, or the reader failed; the file was left untouched`)
        }
        ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
        return pictureValue(target.displayPath, outcome)
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
      const outcome = await readPicture(reader, Buffer.from(request.data).toString('base64'), request.mediaType, withCharacters)
      if (outcome === undefined) {
        throw new Error(`cannot read the conversation picture: this machine has no reader for ${request.mediaType} images, or the reader failed`)
      }
      return pictureValue(`attachment:${String(ref.attachmentId)}`, outcome)
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
