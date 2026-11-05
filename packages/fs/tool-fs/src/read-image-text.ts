/**
 * The model-facing `read_image_text` tool reads the text out of one image file
 * with this machine's local recognizer and returns that text.
 *
 * It exists because a picture the user attaches keeps its pixels in the session
 * while the model may accept text only: the reader runs here, the text is
 * redacted on the way out, and nothing is sent anywhere to produce it. The tool
 * is registered only while a redaction provider with a local reader is mounted,
 * so a deployment without one never advertises a reader it cannot run.
 * @module @deepseek-ai/dsh-tool-fs/src/read-image-text
 */

import { Buffer } from 'node:buffer'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
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

/** The structured outcome declared by the `read_image_text` output schema. */
export interface ImageTextValue {
  /** The backend-resolved path that was read. */
  path: string
  /** The text the image held, already redacted; empty when it held none. */
  text: string
}

/**
 * Register the `read_image_text` tool into the given context.
 * The composing plugin owns the redaction gate: `src/index.ts` calls this
 * inside `ctx.inject(['redaction'], …)` so the tool exists only while a local
 * reader is mounted. Execution still re-checks `ctx.get('redaction')` for
 * direct callers.
 * @param ctx - the registration scope; execution uses its `fs` service plus the
 *   optional `redaction` service.
 */
export function applyReadImageTextTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'read_image_text',
    description: 'Read the text out of a PNG/JPEG/WebP/GIF file with the local recognizer. '
      + 'The image is read on this machine and never leaves it; the returned text is already redacted. '
      + 'Use this instead of read_image when the model accepts text only.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to the image file, resolved by the filesystem backend.' },
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
    // Recognition is a pure local read; two calls for one file cannot conflict.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
      const reader = ctx.get('redaction') as LocalTextReader | undefined
      if (reader === undefined) {
        throw new Error(`cannot read "${args.file_path}": no local image reader is mounted`)
      }
      const { target, info } = await resolveRegularReadTarget(ctx, exec, args.file_path)
      const attachments = ctx.get('attachments')
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
    },
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: `Read text from ${args.file_path}`,
        kind: 'read',
        locations: [{ path: args.file_path }],
      }
    },
  }))
}
