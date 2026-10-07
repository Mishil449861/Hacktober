import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary'
import type { CloudinaryAsset } from '../src/shared/schema.ts'

const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env

export const cloudinaryEnabled = process.env.CLOUDINARY_DISABLED !== 'true' &&
  Boolean(CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET)
export const cloudName = CLOUDINARY_CLOUD_NAME

if (cloudinaryEnabled) {
  // Server-side signed uploads only; the secret never reaches the browser.
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
    secure: true,
  })
}

/** `displayName` is what the Media Library shows, so the photo is recognizable there (not a random id). */
export function uploadImage(buffer: Buffer, folder: string, displayName?: string): Promise<CloudinaryAsset> {
  const name = displayName?.replace(/\.[a-z0-9]+$/i, '').replace(/[^\w .()·-]+/g, ' ').trim().slice(0, 120)
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: 'image', ...(name ? { display_name: `OrgMap ${name}` } : {}) },
      (err, res?: UploadApiResponse) => {
        if (err || !res) return reject(err ?? new Error('Cloudinary upload failed'))
        resolve({
          publicId: res.public_id,
          assetId: res.asset_id,
          secureUrl: res.secure_url,
          width: res.width,
          height: res.height,
          format: res.format,
          createdAt: res.created_at,
        })
      },
    )
    stream.end(buffer)
  })
}

export const deleteImage = (publicId: string) => cloudinary.uploader.destroy(publicId).catch(() => undefined)

export const previewUrl = (publicId: string) =>
  cloudinary.url(publicId, { transformation: [{ width: 1200, crop: 'limit' }, { quality: 'auto', fetch_format: 'auto' }] })

export const thumbUrl = (publicId: string) =>
  cloudinary.url(publicId, { transformation: [{ width: 160, height: 120, crop: 'fill', gravity: 'auto' }, { quality: 'auto', fetch_format: 'auto' }] })

/**
 * Analysis derivative: capped at 1600px (keeps whiteboard text legible while bounding
 * model tokens), auto-improved contrast, light sharpening, high JPEG quality.
 * The original upload is never modified.
 */
export const analysisUrl = (publicId: string) =>
  cloudinary.url(publicId, {
    transformation: [
      { width: 1600, height: 1600, crop: 'limit' },
      { effect: 'improve' },
      { effect: 'sharpen:60' },
      { quality: 90, fetch_format: 'jpg' },
    ],
  })
